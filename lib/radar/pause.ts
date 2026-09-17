/**
 * The durable runtime pause.
 *
 * When LinkedIn answers a checkpoint or a throttle, the profile-read loop turns
 * `reads_enabled` and `outbound_enabled` off. Those two flags are not enough on
 * their own: Radar re-provisions the runtime on every campaign change, and a
 * manifest carrying `outboundEnabled: true` would quietly switch sending back on
 * minutes after the incident, with nobody having looked at it.
 *
 * So the incident itself is recorded — `paused_reason` + `paused_at` — and while
 * it is recorded NOTHING can be enabled: not sending, not reads, not resuming a
 * parked run. Clearing it is an explicit human act through
 * `PUT /api/radar/control {"acknowledgePause": true}`.
 *
 * The columns live on `radar_runtime_config`, so the pause survives a process
 * restart and a container redeploy, which is the whole point.
 */
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import type { RuntimePause, RuntimePauseReason } from "./contracts";

/** SQLite stores `datetime('now')` as `YYYY-MM-DD HH:MM:SS` in UTC. */
export function sqliteUtcToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const hasZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(value);
  const parsed = Date.parse(hasZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

interface PauseRow {
  paused_reason: string | null;
  paused_at: string | null;
}

function pauseRow(db: Database.Database): PauseRow | undefined {
  try {
    return db.prepare(
      "SELECT paused_reason, paused_at FROM radar_runtime_config WHERE id = 1",
    ).get() as PauseRow | undefined;
  } catch {
    // Database provisioned before the pause columns existed.
    return undefined;
  }
}

export function readRuntimePause(db: Database.Database = getDb()): RuntimePause | null {
  const row = pauseRow(db);
  if (!row?.paused_reason) return null;
  return {
    reason: row.paused_reason as RuntimePauseReason,
    at: sqliteUtcToIso(row.paused_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Record the incident. The LATEST one wins: reads and sending are already off
 * while a pause stands, so a second incident can only come from a human having
 * re-enabled something, and then the newer reason is the one they must read.
 */
export function recordRuntimePause(db: Database.Database, reason: RuntimePauseReason): void {
  db.prepare(`
    UPDATE radar_runtime_config
       SET paused_reason = ?, paused_at = datetime('now'), updated_at = datetime('now')
     WHERE id = 1
  `).run(reason);
}

/** Clears the pause and returns the incident that was cleared, if any. */
export function clearRuntimePause(db: Database.Database): RuntimePause | null {
  const pause = readRuntimePause(db);
  if (!pause) return null;
  db.prepare(`
    UPDATE radar_runtime_config
       SET paused_reason = NULL, paused_at = NULL, updated_at = datetime('now')
     WHERE id = 1
  `).run();
  return pause;
}
