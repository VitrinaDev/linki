import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import type { RadarControlInput, RadarProvisionInput } from "./contracts";

export class RadarProvisionError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface RadarProvisionResult {
  accountId: string;
  listId: string;
  workflowId: string;
  created: boolean;
  outboundEnabled: boolean;
}

export interface RadarControlResult {
  enabled: boolean;
  dailyConnectionLimit: number;
  dailyMessageLimit: number;
  pausedRuns: number;
  resumedRuns: number;
  retriedTracks: number;
}

function managedWorkflowHash(input: RadarProvisionInput): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: input.schemaVersion,
    listId: input.listId,
    workflowId: input.workflowId,
    campaignName: input.campaignName,
    messageTemplate: input.messageTemplate,
    messageDelaySeconds: input.messageDelaySeconds,
  })).digest("hex");
}

function resolveSingleAuthenticatedAccount(): string {
  const db = getDb();
  const configuredId = process.env.RADAR_LINKEDIN_ACCOUNT_ID?.trim();
  if (configuredId) {
    const configured = db.prepare(
      "SELECT id FROM accounts WHERE id = ? AND is_authenticated = 1",
    ).get(configuredId) as { id: string } | undefined;
    if (!configured) {
      throw new RadarProvisionError(409, "Configured Radar LinkedIn account is missing or unauthenticated");
    }
    return configured.id;
  }

  const accounts = db.prepare(
    "SELECT id FROM accounts WHERE is_authenticated = 1 ORDER BY created_at",
  ).all() as Array<{ id: string }>;
  if (accounts.length === 0) {
    throw new RadarProvisionError(409, "Linki runtime has no authenticated LinkedIn account");
  }
  if (accounts.length !== 1) {
    throw new RadarProvisionError(409, "Linki runtime must contain exactly one authenticated LinkedIn account");
  }
  return accounts[0].id;
}

export function provisionRadarCampaign(input: RadarProvisionInput): RadarProvisionResult {
  const db = getDb();
  const accountId = resolveSingleAuthenticatedAccount();
  const workflowHash = managedWorkflowHash(input);

  return db.transaction(() => {
    const previous = db.prepare(
      "SELECT workflow_sha256 FROM radar_runtime_config WHERE id = 1",
    ).get() as { workflow_sha256: string } | undefined;
    const workflowChanged = previous?.workflow_sha256 !== workflowHash;

    if (previous && workflowChanged) {
      const active = db.prepare(`
        SELECT 1
          FROM runs r
          JOIN run_profiles rp ON rp.run_id = r.id
          JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id
         WHERE r.workflow_id = ?
           AND r.status IN ('running', 'paused')
           AND rt.state NOT IN ('completed', 'failed', 'skipped')
         LIMIT 1
      `).get(input.workflowId);
      if (active) {
        throw new RadarProvisionError(409, "Cannot change the managed workflow while contacts are active");
      }
    }

    db.prepare(`
      INSERT INTO lists (id, name, description, purpose)
      VALUES (?, ?, 'Managed automatically by Radar omnichannel orchestration', 'linkedin')
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        purpose = 'linkedin'
    `).run(input.listId, input.campaignName);

    db.prepare(`
      INSERT INTO workflows (id, name, description, prompt, is_archived)
      VALUES (?, ?, 'Managed automatically by Radar; do not edit in Linki', NULL, 0)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        is_archived = 0
    `).run(input.workflowId, input.campaignName);

    if (workflowChanged) {
      db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(input.workflowId);
      db.prepare(`
        INSERT INTO workflow_steps (
          id, workflow_id, step_order, track, step_type, delay_seconds,
          connect_note, message_body, enabled, message_position
        ) VALUES (?, ?, 1, 'linkedin', 'connect', 0, NULL, NULL, 1, 1)
      `).run(`${input.workflowId}:connect`, input.workflowId);
      db.prepare(`
        INSERT INTO workflow_steps (
          id, workflow_id, step_order, track, step_type, delay_seconds,
          connect_note, message_body, enabled, message_position
        ) VALUES (?, ?, 2, 'linkedin', 'message', ?, NULL, ?, 1, 1)
      `).run(
        `${input.workflowId}:message`,
        input.workflowId,
        input.messageDelaySeconds,
        input.messageTemplate,
      );
    }

    const policy = input.accountPolicy;
    const effectiveConnectionLimit = input.outboundEnabled ? policy.dailyConnectionLimit : 0;
    const effectiveMessageLimit = input.outboundEnabled ? policy.dailyMessageLimit : 0;
    db.prepare(`
      UPDATE accounts SET
        daily_connection_limit = ?,
        daily_message_limit = ?,
        daily_inmail_limit = ?,
        active_hours_start = ?,
        active_hours_end = ?,
        timezone = ?,
        working_days = ?
      WHERE id = ?
    `).run(
      effectiveConnectionLimit,
      effectiveMessageLimit,
      policy.dailyInmailLimit,
      policy.activeHoursStart,
      policy.activeHoursEnd,
      policy.timezone,
      [...new Set(policy.workingDays)].sort((a, b) => a - b).join(","),
      accountId,
    );

    db.prepare(`
      INSERT INTO radar_runtime_config (id, list_id, workflow_id, account_id, workflow_sha256, outbound_enabled, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        list_id = excluded.list_id,
        workflow_id = excluded.workflow_id,
        account_id = excluded.account_id,
        workflow_sha256 = excluded.workflow_sha256,
        outbound_enabled = excluded.outbound_enabled,
        updated_at = excluded.updated_at
    `).run(input.listId, input.workflowId, accountId, workflowHash, input.outboundEnabled ? 1 : 0);

    db.prepare(`
      UPDATE runs SET status = ?
      WHERE workflow_id = ? AND list_id = ? AND account_id = ?
        AND status = ?
    `).run(
      input.outboundEnabled ? "running" : "paused",
      input.workflowId,
      input.listId,
      accountId,
      input.outboundEnabled ? "paused" : "running",
    );

    return {
      accountId,
      listId: input.listId,
      workflowId: input.workflowId,
      created: !previous,
      outboundEnabled: input.outboundEnabled,
    };
  })();
}

export function controlRadarRuntime(input: RadarControlInput): RadarControlResult {
  const db = getDb();
  return db.transaction(() => {
    const managed = db.prepare(`
      SELECT list_id, workflow_id, account_id
      FROM radar_runtime_config WHERE id = 1
    `).get() as { list_id: string; workflow_id: string; account_id: string } | undefined;
    if (!managed) throw new RadarProvisionError(409, "Radar campaign has not been provisioned");

    const connectionLimit = input.enabled ? input.dailyConnectionLimit : 0;
    const messageLimit = input.enabled ? input.dailyMessageLimit : 0;
    db.prepare(`
      UPDATE accounts
      SET daily_connection_limit = ?, daily_message_limit = ?, daily_inmail_limit = 0
      WHERE id = ?
    `).run(connectionLimit, messageLimit, managed.account_id);
    db.prepare(`
      UPDATE radar_runtime_config
      SET outbound_enabled = ?, updated_at = datetime('now') WHERE id = 1
    `).run(input.enabled ? 1 : 0);

    const runChange = db.prepare(`
      UPDATE runs SET status = ?
      WHERE workflow_id = ? AND list_id = ? AND account_id = ? AND status = ?
    `).run(
      input.enabled ? "running" : "paused",
      managed.workflow_id,
      managed.list_id,
      managed.account_id,
      input.enabled ? "paused" : "running",
    );

    let retriedTracks = 0;
    if (input.enabled && input.retryFailed) {
      const retried = db.prepare(`
        UPDATE run_profile_tracks
        SET state = 'pending', next_step_at = NULL, error_message = NULL
        WHERE track = 'linkedin' AND state = 'failed'
          AND run_profile_id IN (
            SELECT rp.id FROM run_profiles rp
            JOIN runs r ON r.id = rp.run_id
            WHERE r.workflow_id = ? AND r.list_id = ? AND r.account_id = ?
          )
      `).run(managed.workflow_id, managed.list_id, managed.account_id);
      retriedTracks = Number(retried.changes);
      if (retriedTracks > 0) {
        db.prepare(`
          UPDATE runs SET status = 'running', completed_at = NULL,
            started_at = COALESCE(started_at, datetime('now'))
          WHERE workflow_id = ? AND list_id = ? AND account_id = ?
            AND EXISTS (
              SELECT 1 FROM run_profiles rp
              JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id
              WHERE rp.run_id = runs.id AND rt.track = 'linkedin' AND rt.state = 'pending'
            )
        `).run(managed.workflow_id, managed.list_id, managed.account_id);
      }
    }

    return {
      enabled: input.enabled,
      dailyConnectionLimit: input.dailyConnectionLimit,
      dailyMessageLimit: input.dailyMessageLimit,
      pausedRuns: input.enabled ? 0 : Number(runChange.changes),
      resumedRuns: input.enabled ? Number(runChange.changes) : 0,
      retriedTracks,
    };
  })();
}
