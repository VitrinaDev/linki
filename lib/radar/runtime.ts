import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { RadarAccountInput } from "./contracts";
import { RadarProvisionError } from "./provisioning";

const ACCOUNT_COLUMNS = `id, name, email, is_authenticated, daily_connection_limit,
  daily_message_limit, daily_inmail_limit, active_hours_start, active_hours_end,
  timezone, working_days, created_at, accepted_sync_at, radar_inbox_synced_at`;

export function upsertRadarAccount(input: RadarAccountInput) {
  const db = getDb();
  return db.transaction(() => {
    const accounts = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at`).all() as Array<{
      id: string;
      email: string;
    }>;
    if (accounts.length > 1) {
      throw new RadarProvisionError(409, "Linki runtime must contain at most one LinkedIn account");
    }
    if (accounts.length === 0) {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO accounts (
          id, name, email, daily_connection_limit, daily_message_limit,
          daily_inmail_limit, active_hours_start, active_hours_end, timezone, working_days
        ) VALUES (?, ?, ?, 1, 1, 0, 9, 18, 'America/Santiago', '1,2,3,4,5')
      `).run(id, input.name, input.email.toLowerCase());
      return db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id);
    }

    const current = accounts[0];
    const emailChanged = current.email.toLowerCase() !== input.email.toLowerCase();
    db.prepare(`
      UPDATE accounts SET
        name = ?, email = ?,
        cookies_json = CASE WHEN ? THEN NULL ELSE cookies_json END,
        is_authenticated = CASE WHEN ? THEN 0 ELSE is_authenticated END
      WHERE id = ?
    `).run(input.name, input.email.toLowerCase(), emailChanged ? 1 : 0, emailChanged ? 1 : 0, current.id);
    return db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(current.id);
  })();
}

export function getRadarRuntimeStatus() {
  const db = getDb();
  const accounts = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at`).all() as Array<Record<string, unknown>>;
  const managed = db.prepare(`
    SELECT rc.list_id, rc.workflow_id, rc.account_id, rc.outbound_enabled, rc.updated_at,
           l.name AS list_name, w.name AS workflow_name
      FROM radar_runtime_config rc
      JOIN lists l ON l.id = rc.list_id
      JOIN workflows w ON w.id = rc.workflow_id
     WHERE rc.id = 1
  `).get() as Record<string, unknown> | undefined;

  let queue = { contacts: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 };
  if (managed) {
    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT rp.target_id) AS contacts,
        COUNT(*) FILTER (WHERE rt.state = 'pending') AS pending,
        COUNT(*) FILTER (WHERE rt.state = 'in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE rt.state = 'completed') AS completed,
        COUNT(*) FILTER (WHERE rt.state = 'failed') AS failed
      FROM runs r
      LEFT JOIN run_profiles rp ON rp.run_id = r.id
      LEFT JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id AND rt.track = 'linkedin'
      WHERE r.workflow_id = ? AND r.list_id = ?
    `).get(managed.workflow_id, managed.list_id) as Record<string, number>;
    queue = {
      contacts: Number(row.contacts ?? 0),
      pending: Number(row.pending ?? 0),
      inProgress: Number(row.in_progress ?? 0),
      completed: Number(row.completed ?? 0),
      failed: Number(row.failed ?? 0),
    };
  }

  return {
    schemaVersion: 1,
    healthy: accounts.length <= 1,
    account: accounts[0] ?? null,
    accountCount: accounts.length,
    campaign: managed ?? null,
    queue,
    proxyConfigured: process.env.LINKI_REQUIRE_PROXY === "true"
      && Boolean(process.env.LINKI_PROXY_SERVER?.trim()),
    callbackConfigured: Boolean(
      process.env.RADAR_CALLBACK_URL?.trim() && process.env.RADAR_CALLBACK_SECRET?.trim(),
    ),
  };
}
