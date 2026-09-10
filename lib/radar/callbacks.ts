import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { buildRadarCallback, callbackSignature, retryDelaySeconds, type RadarCallbackEventType } from "./contracts";

interface RadarEventSource {
  target_id: string;
  radar_lead_id: string;
  connected_at: string | null;
  last_replied_at: string | null;
}

interface OutboxRow {
  event_id: string;
  payload_json: string;
  attempts: number;
}

let warnedMissingConfig = false;

function iso(value: string): string {
  const hasZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(value);
  return new Date(hasZone ? value : `${value.replace(" ", "T")}Z`).toISOString();
}

function eventId(targetId: string, eventType: RadarCallbackEventType, occurredAt: string): string {
  const digest = createHash("sha256").update(`${targetId}:${eventType}:${occurredAt}`).digest("hex").slice(0, 32);
  return `linki_${digest}`;
}

export function harvestRadarCallbacks(db: Database.Database): number {
  const sources = db.prepare(`
    SELECT id AS target_id, radar_lead_id, connected_at, last_replied_at
    FROM targets
    WHERE radar_lead_id IS NOT NULL
      AND (connected_at IS NOT NULL OR last_replied_at IS NOT NULL)
  `).all() as RadarEventSource[];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO radar_callback_outbox
      (event_id, target_id, event_type, occurred_at, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  let inserted = 0;

  db.transaction(() => {
    for (const source of sources) {
      const candidates: Array<[RadarCallbackEventType, string | null]> = [
        ["connection.accepted", source.connected_at],
        ["message.replied", source.last_replied_at],
      ];
      for (const [eventType, rawOccurredAt] of candidates) {
        if (!rawOccurredAt) continue;
        const occurredAt = iso(rawOccurredAt);
        const id = eventId(source.target_id, eventType, occurredAt);
        const payload = buildRadarCallback(id, eventType, occurredAt, source.radar_lead_id);
        inserted += insert.run(id, source.target_id, eventType, occurredAt, JSON.stringify(payload)).changes;
      }
      db.prepare("UPDATE targets SET radar_status = ? WHERE id = ?").run(
        source.last_replied_at ? "REPLIED" : "CONNECTED",
        source.target_id,
      );
    }
  })();
  return inserted;
}

function claimDueRows(db: Database.Database): OutboxRow[] {
  return db.transaction(() => {
    // Recover work leased by a process that died mid-request.
    db.prepare(`
      UPDATE radar_callback_outbox
      SET status = 'pending', locked_at = NULL
      WHERE status = 'sending' AND locked_at < datetime('now', '-5 minutes')
    `).run();
    const rows = db.prepare(`
      SELECT event_id, payload_json, attempts
      FROM radar_callback_outbox
      WHERE status = 'pending' AND datetime(next_attempt_at) <= datetime('now')
      ORDER BY created_at ASC LIMIT 20
    `).all() as OutboxRow[];
    const claim = db.prepare(`
      UPDATE radar_callback_outbox SET status = 'sending', locked_at = datetime('now')
      WHERE event_id = ? AND status = 'pending'
    `);
    return rows.filter((row) => claim.run(row.event_id).changes === 1);
  })();
}

export async function processRadarCallbacks(db: Database.Database): Promise<void> {
  harvestRadarCallbacks(db);

  const callbackUrl = process.env.RADAR_CALLBACK_URL?.trim();
  const secret = process.env.RADAR_CALLBACK_SECRET?.trim();
  if (!callbackUrl || !secret) {
    if (!warnedMissingConfig && process.env.RADAR_WORKFLOW_ID) {
      warnedMissingConfig = true;
      console.warn("[radar] Callbacks disabled: RADAR_CALLBACK_URL and RADAR_CALLBACK_SECRET are required");
    }
    return;
  }

  for (const row of claimDueRows(db)) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = callbackSignature(secret, timestamp, row.payload_json);
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omnichannel-timestamp": timestamp,
          "x-omnichannel-signature": signature,
          "x-linki-event-id": row.event_id,
        },
        body: row.payload_json,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Radar callback returned HTTP ${response.status}`);
      db.prepare(`
        UPDATE radar_callback_outbox
        SET status = 'sent', attempts = attempts + 1, sent_at = datetime('now'),
            locked_at = NULL, last_error = NULL
        WHERE event_id = ?
      `).run(row.event_id);
    } catch (error) {
      const attempts = row.attempts + 1;
      const nextAttemptAt = new Date(Date.now() + retryDelaySeconds(attempts) * 1000).toISOString();
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      db.prepare(`
        UPDATE radar_callback_outbox
        SET status = 'pending', attempts = ?, next_attempt_at = ?, locked_at = NULL, last_error = ?
        WHERE event_id = ?
      `).run(attempts, nextAttemptAt, message, row.event_id);
      console.warn(`[radar] Callback ${row.event_id} failed (attempt ${attempts}): ${message}`);
    }
  }
}
