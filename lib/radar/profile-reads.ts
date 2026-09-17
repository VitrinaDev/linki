/**
 * Radar profile reads: the durable job, its pacing, and its fail-closed rules.
 *
 * A read is NOT outreach and must never behave like it. It therefore:
 *  - has its own switch (`radar_runtime_config.reads_enabled`) and its own
 *    budget (`daily_profile_read_limit`, `min_read_gap_minutes`), independent
 *    of `outbound_enabled` and of the connection/message limits;
 *  - never passes through lib/radar/enrollment.ts, so it never meets the 423
 *    outbound gate and never creates a `target`, a `run` or a
 *    `run_profile_track`;
 *  - runs inside the existing session and the app-wide page queue in
 *    lib/linkedin/session.ts — one read per loop turn, never a batch, never a
 *    second browser;
 *  - respects the account's `active_hours_*`, `timezone` and `working_days`,
 *    through the same helpers the campaign runner uses.
 *
 * Local footprint: the `radar_profile_reads` row and nothing else. The
 * sanitised result is written only to `radar_callback_outbox.payload_json`, and
 * that column is nulled the moment the callback is delivered.
 *
 * Fail closed: a challenge, checkpoint, login redirect, HTTP 429 or a
 * restriction page pauses reads AND outbound sending for the whole runtime,
 * fails the job with its error code and never retries it. Only a network
 * timeout is retried, once, at least 30 minutes later (two attempts maximum).
 * No proxy is rotated and no volume is moved to another account.
 */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import {
  isWithinSchedule,
  nextScheduledSlot,
  nextWorkingDaySlot,
  startOfLocalDay,
  type ScheduleConfig,
} from "@/lib/linkedin/schedule";
import { markNeedsReauth } from "@/lib/linkedin/session";
import { ProfileReadError, readProfileMinimal, type ProfileReader } from "@/lib/linkedin/profile-read";
import {
  buildRadarProfileReadCallback,
  canonicalLinkedInUrl,
  sanitizeProfileRead,
  type ProfileReadErrorCode,
  type RadarProfileReadInput,
} from "./contracts";

/** Two attempts maximum, and only a network failure ever earns the second. */
const MAX_ATTEMPTS = 2;
const NETWORK_RETRY_MINUTES = 30;
/** A lease older than this belongs to a process that died mid-read. */
const STALE_LEASE_MINUTES = 15;

interface RuntimeRow {
  account_id: string;
  reads_enabled: number;
  daily_profile_read_limit: number;
  min_read_gap_minutes: number;
  outbound_enabled: number;
}

interface AccountRow extends ScheduleConfig {
  id: string;
  is_authenticated: number;
}

interface JobRow {
  id: string;
  radar_persona_id: string;
  linkedin_url: string;
  attempts: number;
}

export type ProfileReadRequestResult =
  | { outcome: "queued"; jobId: string; status: "QUEUED"; scheduledAt: string }
  | { outcome: "duplicate"; jobId: string }
  | { outcome: "disabled" }
  | { outcome: "capped"; retryAfter: number };

export type ProfileReadTick = "idle" | "done" | "failed" | "retry";

/** SQLite's own `datetime('now')` shape, so string comparisons stay valid. */
function sqliteUtc(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function parseSqliteUtc(value: string | null): number | null {
  if (!value) return null;
  const hasZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(value);
  const parsed = Date.parse(hasZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Spacing multiplier in [1, 2.5]. Derived from the previous read's timestamp
 * rather than drawn fresh: the loop re-evaluates the gap every 30 seconds, so a
 * new random draw each turn would collapse to the minimum as soon as a low one
 * came up. Seeded this way the gap is stable within itself and unpredictable
 * between reads.
 */
function gapMultiplier(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  return 1 + (digest.readUInt32BE(0) / 0xffffffff) * 1.5;
}

function runtimeRow(db: Database.Database): RuntimeRow | undefined {
  try {
    return db.prepare(`
      SELECT account_id, reads_enabled, daily_profile_read_limit, min_read_gap_minutes, outbound_enabled
        FROM radar_runtime_config WHERE id = 1
    `).get() as RuntimeRow | undefined;
  } catch {
    // Database provisioned before profile reads existed.
    return undefined;
  }
}

function accountRow(db: Database.Database, accountId: string): AccountRow | undefined {
  return db.prepare(`
    SELECT id, is_authenticated, active_hours_start, active_hours_end, timezone, working_days
      FROM accounts WHERE id = ?
  `).get(accountId) as AccountRow | undefined;
}

interface DailyUsage {
  used: number;
  lastCompletedAt: string | null;
  lastReadAt: string | null;
}

/**
 * The budget counts finished ATTEMPTS, not successes: `completed_at` is stamped
 * whenever an attempt has actually loaded a page, including a failure that will
 * be retried. A page view spends the account's safety margin either way.
 */
function dailyUsage(db: Database.Database, account: AccountRow, now = new Date()): DailyUsage {
  const dayStart = sqliteUtc(startOfLocalDay(account, now));
  const row = db.prepare(`
    SELECT COUNT(*) AS used, MAX(completed_at) AS last_completed_at
      FROM radar_profile_reads
     WHERE completed_at IS NOT NULL AND completed_at >= ?
  `).get(dayStart) as { used: number; last_completed_at: string | null };
  const overall = db.prepare(`
    SELECT MAX(completed_at) AS last_completed_at, MAX(read_at) AS last_read_at FROM radar_profile_reads
  `).get() as { last_completed_at: string | null; last_read_at: string | null };
  return {
    used: Number(row.used ?? 0),
    lastCompletedAt: overall.last_completed_at,
    lastReadAt: overall.last_read_at,
  };
}

/** Earliest instant the next read may happen, honouring the minimum gap. */
function earliestNextRead(usage: DailyUsage, gapMinutes: number): number {
  const last = parseSqliteUtc(usage.lastCompletedAt);
  if (last === null) return Date.now();
  return last + gapMinutes * 60_000 * gapMultiplier(usage.lastCompletedAt!);
}

// ─── public status ────────────────────────────────────────────────────────────

export interface ProfileReadStatus {
  enabled: boolean;
  dailyLimit: number;
  usedToday: number;
  lastReadAt: string | null;
}

export function getProfileReadStatus(db: Database.Database = getDb()): ProfileReadStatus {
  const runtime = runtimeRow(db);
  if (!runtime) return { enabled: false, dailyLimit: 0, usedToday: 0, lastReadAt: null };
  const account = accountRow(db, runtime.account_id);
  const usage = account
    ? dailyUsage(db, account)
    : { used: 0, lastCompletedAt: null, lastReadAt: null };
  return {
    enabled: runtime.reads_enabled === 1 && runtime.daily_profile_read_limit > 0,
    dailyLimit: runtime.daily_profile_read_limit,
    usedToday: usage.used,
    lastReadAt: usage.lastReadAt ? new Date(parseSqliteUtc(usage.lastReadAt)!).toISOString() : null,
  };
}

// ─── enqueue ──────────────────────────────────────────────────────────────────

export function requestProfileRead(
  input: RadarProfileReadInput,
  db: Database.Database = getDb(),
): ProfileReadRequestResult {
  const runtime = runtimeRow(db);
  if (!runtime || runtime.reads_enabled !== 1 || runtime.daily_profile_read_limit <= 0) {
    return { outcome: "disabled" };
  }
  const account = accountRow(db, runtime.account_id);
  if (!account || account.is_authenticated !== 1) return { outcome: "disabled" };

  const linkedinUrl = canonicalLinkedInUrl(input.linkedinUrl);

  return db.transaction((): ProfileReadRequestResult => {
    const open = db.prepare(`
      SELECT id FROM radar_profile_reads
       WHERE radar_persona_id = ? AND state IN ('queued', 'running')
    `).get(input.radar_persona_id) as { id: string } | undefined;
    if (open) return { outcome: "duplicate", jobId: open.id };

    const usage = dailyUsage(db, account);
    if (usage.used >= runtime.daily_profile_read_limit) {
      const nextDay = Date.parse(nextWorkingDaySlot(account));
      return { outcome: "capped", retryAfter: Math.max(60, Math.ceil((nextDay - Date.now()) / 1000)) };
    }

    const earliest = earliestNextRead(usage, runtime.min_read_gap_minutes);
    const scheduledMs = isWithinSchedule(account)
      ? Math.max(Date.now(), earliest)
      : Math.max(earliest, Date.parse(nextScheduledSlot(account)));
    const scheduledAt = new Date(scheduledMs);

    const jobId = randomUUID();
    db.prepare(`
      INSERT INTO radar_profile_reads (id, radar_persona_id, linkedin_url, state, scheduled_at)
      VALUES (?, ?, ?, 'queued', ?)
    `).run(jobId, input.radar_persona_id, linkedinUrl, sqliteUtc(scheduledAt));
    return { outcome: "queued", jobId, status: "QUEUED", scheduledAt: scheduledAt.toISOString() };
  })();
}

// ─── execution ────────────────────────────────────────────────────────────────

function runtimeKey(): string | null {
  return process.env.RADAR_RUNTIME_KEY?.trim() || null;
}

function eventIdFor(jobId: string, eventType: string): string {
  return `linki_${createHash("sha256").update(`${jobId}:${eventType}`).digest("hex").slice(0, 32)}`;
}

/**
 * Same outbox, same envelope, same HMAC and same retries as the contact
 * callbacks. `target_id` is null on purpose: a read has no Linki target.
 */
function enqueueCallback(
  db: Database.Database,
  job: JobRow,
  occurredAt: string,
  outcome: Parameters<typeof buildRadarProfileReadCallback>[3],
): void {
  const eventType = "profile" in outcome ? "profile.read" : "profile.read.failed";
  const eventId = eventIdFor(job.id, eventType);
  const payload = buildRadarProfileReadCallback(
    eventId,
    occurredAt,
    { id: job.id, radar_persona_id: job.radar_persona_id, runtime_key: runtimeKey() },
    outcome,
  );
  db.prepare(`
    INSERT OR IGNORE INTO radar_callback_outbox
      (event_id, target_id, event_type, occurred_at, payload_json)
    VALUES (?, NULL, ?, ?, ?)
  `).run(eventId, eventType, payload.occurredAt, JSON.stringify(payload));
}

/**
 * Pause the WHOLE runtime, reads and sending alike. Mirrors what Radar's own
 * `PUT /api/radar/control` does when it disables the runtime: zero the account's
 * send limits and park the managed runs, so nothing leaves while a human looks
 * at the challenge. Nothing is rotated and no credential is touched.
 */
function pauseRuntimeClosed(db: Database.Database, accountId: string, reason: string): void {
  db.transaction(() => {
    db.prepare(`
      UPDATE radar_runtime_config
         SET reads_enabled = 0, outbound_enabled = 0, updated_at = datetime('now')
       WHERE id = 1
    `).run();
    db.prepare(`
      UPDATE accounts SET daily_connection_limit = 0, daily_message_limit = 0, daily_inmail_limit = 0
       WHERE id = ?
    `).run(accountId);
    db.prepare("UPDATE runs SET status = 'paused' WHERE account_id = ? AND status = 'running'").run(accountId);
  })();
  console.warn(`[radar] Profile reads and outbound sending paused on this runtime: ${reason}`);
}

function recoverStaleLeases(db: Database.Database): void {
  db.prepare(`
    UPDATE radar_profile_reads
       SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
           error_code = CASE WHEN attempts >= ? THEN 'network' ELSE error_code END,
           completed_at = CASE WHEN attempts >= ? THEN datetime('now') ELSE completed_at END,
           locked_at = NULL,
           scheduled_at = CASE WHEN attempts >= ? THEN scheduled_at ELSE datetime('now', '+${NETWORK_RETRY_MINUTES} minutes') END
     WHERE state = 'running' AND locked_at < datetime('now', '-${STALE_LEASE_MINUTES} minutes')
  `).run(MAX_ATTEMPTS, MAX_ATTEMPTS, MAX_ATTEMPTS, MAX_ATTEMPTS);
}

function claimDueJob(db: Database.Database): JobRow | undefined {
  return db.transaction((): JobRow | undefined => {
    const job = db.prepare(`
      SELECT id, radar_persona_id, linkedin_url, attempts
        FROM radar_profile_reads
       WHERE state = 'queued' AND datetime(scheduled_at) <= datetime('now')
       ORDER BY scheduled_at ASC, created_at ASC
       LIMIT 1
    `).get() as JobRow | undefined;
    if (!job) return undefined;
    const claimed = db.prepare(`
      UPDATE radar_profile_reads
         SET state = 'running', attempts = attempts + 1, locked_at = datetime('now')
       WHERE id = ? AND state = 'queued'
    `).run(job.id);
    return claimed.changes === 1 ? { ...job, attempts: job.attempts + 1 } : undefined;
  })();
}

/**
 * One read per turn. Called from the runner's global loop BEFORE `tick()`, and
 * independent of it: reads work even when every campaign run is paused.
 */
export async function processProfileReads(
  db: Database.Database,
  read: ProfileReader = readProfileMinimal,
): Promise<ProfileReadTick> {
  recoverStaleLeases(db);

  const runtime = runtimeRow(db);
  if (!runtime || runtime.reads_enabled !== 1 || runtime.daily_profile_read_limit <= 0) return "idle";
  const account = accountRow(db, runtime.account_id);
  if (!account || account.is_authenticated !== 1) return "idle";
  if (!isWithinSchedule(account)) return "idle";

  const usage = dailyUsage(db, account);
  if (usage.used >= runtime.daily_profile_read_limit) return "idle";
  if (Date.now() < earliestNextRead(usage, runtime.min_read_gap_minutes)) return "idle";

  const job = claimDueJob(db);
  if (!job) return "idle";

  try {
    const result = await read(account.id, job.linkedin_url);
    const readAt = new Date();
    db.prepare(`
      UPDATE radar_profile_reads
         SET state = 'done', completed_at = ?, read_at = ?, locked_at = NULL, error_code = NULL
       WHERE id = ?
    `).run(sqliteUtc(readAt), sqliteUtc(readAt), job.id);
    enqueueCallback(db, job, readAt.toISOString(), {
      profile: sanitizeProfileRead(job.linkedin_url, readAt.toISOString(), result),
    });
    return "done";
  } catch (error) {
    const code: ProfileReadErrorCode = error instanceof ProfileReadError ? error.code : "network";
    const finishedAt = new Date();

    if (code === "challenge" || code === "rate_limited") {
      pauseRuntimeClosed(db, account.id, code);
      // Only a challenge means the SESSION is unusable; a rate limit does not.
      if (code === "challenge") await markNeedsReauth(account.id).catch(() => {});
    }

    const retryable = code === "network" && job.attempts < MAX_ATTEMPTS;
    if (retryable) {
      db.prepare(`
        UPDATE radar_profile_reads
           SET state = 'queued', locked_at = NULL, completed_at = ?, error_code = ?,
               scheduled_at = datetime('now', '+${NETWORK_RETRY_MINUTES} minutes')
         WHERE id = ?
      `).run(sqliteUtc(finishedAt), code, job.id);
      return "retry";
    }

    db.prepare(`
      UPDATE radar_profile_reads
         SET state = 'failed', locked_at = NULL, completed_at = ?, error_code = ?
       WHERE id = ?
    `).run(sqliteUtc(finishedAt), code, job.id);
    enqueueCallback(db, job, finishedAt.toISOString(), { errorCode: code });
    return "failed";
  }
}
