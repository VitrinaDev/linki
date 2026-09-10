import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import type { RadarContactInput } from "./contracts";
import type { RadarConfig } from "./config";

export class RadarEnrollmentError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface RadarEnrollmentResult {
  id: string;
  status: "QUEUED";
  alreadyExists: boolean;
}

function canonicalLinkedInUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function enrollRadarContact(
  input: RadarContactInput,
  config: RadarConfig,
): RadarEnrollmentResult {
  const db = getDb();
  const linkedinUrl = canonicalLinkedInUrl(input.linkedinUrl);
  const radarLeadId = input.customAttributes.radar_lead_id;

  const result = db.transaction((): RadarEnrollmentResult => {
    const runtimeControl = db.prepare(
      "SELECT outbound_enabled FROM radar_runtime_config WHERE id = 1",
    ).get() as { outbound_enabled: number } | undefined;
    if (runtimeControl && runtimeControl.outbound_enabled !== 1) {
      throw new RadarEnrollmentError(423, "Radar LinkedIn runtime is paused");
    }
    const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(config.accountId) as
      | { id: string }
      | undefined;
    if (!account) throw new RadarEnrollmentError(503, "Configured Radar LinkedIn account does not exist");

    const workflow = db.prepare("SELECT id FROM workflows WHERE id = ? AND is_archived = 0").get(config.workflowId) as
      | { id: string }
      | undefined;
    if (!workflow) throw new RadarEnrollmentError(503, "Configured Radar workflow does not exist or is archived");

    const linkedInTrack = db.prepare(
      "SELECT 1 FROM workflow_steps WHERE workflow_id = ? AND track = 'linkedin' AND enabled = 1 LIMIT 1",
    ).get(config.workflowId);
    if (!linkedInTrack) throw new RadarEnrollmentError(503, "Configured Radar workflow has no enabled LinkedIn steps");

    // Defence in depth: Radar also rate-limits dispatch, while Linki owns the
    // authoritative per-account send counter. Never let a Radar runtime exceed 15.
    db.prepare(
      "UPDATE accounts SET daily_connection_limit = MIN(COALESCE(daily_connection_limit, 15), 15) WHERE id = ?",
    ).run(config.accountId);

    const existingByRadarId = db.prepare(
      "SELECT id, linkedin_url FROM targets WHERE radar_lead_id = ?",
    ).get(radarLeadId) as { id: string; linkedin_url: string } | undefined;
    if (existingByRadarId) {
      if (canonicalLinkedInUrl(existingByRadarId.linkedin_url) !== linkedinUrl) {
        throw new RadarEnrollmentError(422, "radar_lead_id is already mapped to another LinkedIn profile");
      }
      return { id: existingByRadarId.id, status: "QUEUED", alreadyExists: true };
    }

    const target = db.prepare("SELECT id, radar_lead_id FROM targets WHERE linkedin_url = ?").get(linkedinUrl) as
      | { id: string; radar_lead_id: string | null }
      | undefined;
    if (target?.radar_lead_id && target.radar_lead_id !== radarLeadId) {
      throw new RadarEnrollmentError(422, "LinkedIn profile is already mapped to another Radar lead");
    }

    const targetId = target?.id ?? randomUUID();
    const fullName = `${input.firstName} ${input.lastName}`.trim();
    if (target) {
      db.prepare(`
        UPDATE targets
        SET radar_lead_id = ?, icebreaker_context = ?, radar_status = 'QUEUED',
            first_name = ?, last_name = ?, full_name = ?, company = ?
        WHERE id = ?
      `).run(
        radarLeadId,
        input.customAttributes.icebreaker_context,
        input.firstName,
        input.lastName || null,
        fullName,
        input.companyName,
        targetId,
      );
    } else {
      db.prepare(`
        INSERT INTO targets (
          id, linkedin_url, first_name, last_name, full_name, company,
          radar_lead_id, icebreaker_context, radar_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED')
      `).run(
        targetId,
        linkedinUrl,
        input.firstName,
        input.lastName || null,
        fullName,
        input.companyName,
        radarLeadId,
        input.customAttributes.icebreaker_context,
      );
    }

    db.prepare(`
      INSERT INTO lists (id, name, description, purpose)
      VALUES (?, ?, 'Managed by Radar omnichannel orchestration', 'linkedin')
      ON CONFLICT(id) DO UPDATE SET purpose = 'linkedin'
    `).run(config.listId, config.listId);
    db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)").run(config.listId, targetId);

    const conflictingRun = db.prepare(`
      SELECT id FROM runs
      WHERE workflow_id = ? AND status IN ('running', 'paused')
        AND (list_id != ? OR account_id != ?)
      LIMIT 1
    `).get(config.workflowId, config.listId, config.accountId) as { id: string } | undefined;
    if (conflictingRun) {
      throw new RadarEnrollmentError(503, "Configured workflow is active outside the Radar integration run");
    }

    let run = db.prepare(`
      SELECT id FROM runs
      WHERE workflow_id = ? AND list_id = ? AND account_id = ?
        AND status IN ('running', 'paused')
      ORDER BY created_at DESC LIMIT 1
    `).get(config.workflowId, config.listId, config.accountId) as { id: string } | undefined;
    if (!run) {
      run = { id: randomUUID() };
      db.prepare(`
        INSERT INTO runs (id, workflow_id, list_id, account_id, status, started_at)
        VALUES (?, ?, ?, ?, 'running', datetime('now'))
      `).run(run.id, config.workflowId, config.listId, config.accountId);
    } else {
      db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?")
        .run(run.id);
    }

    const activeElsewhere = db.prepare(`
      SELECT r.id FROM run_profiles rp
      JOIN runs r ON r.id = rp.run_id
      WHERE rp.target_id = ? AND r.id != ? AND r.status IN ('running', 'paused')
        AND EXISTS (
          SELECT 1 FROM run_profile_tracks rt
          WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped')
        )
      LIMIT 1
    `).get(targetId, run.id) as { id: string } | undefined;
    if (activeElsewhere) throw new RadarEnrollmentError(422, "Contact is already active in another Linki workflow");

    let profile = db.prepare("SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?")
      .get(run.id, targetId) as { id: string } | undefined;
    if (!profile) {
      profile = { id: randomUUID() };
      db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)")
        .run(profile.id, run.id, targetId);
    }
    db.prepare(`
      INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step)
      VALUES (?, ?, 'linkedin', 'pending', 0)
      ON CONFLICT(run_profile_id, track) DO UPDATE SET
        state = CASE WHEN run_profile_tracks.state = 'skipped' THEN 'pending' ELSE run_profile_tracks.state END,
        error_message = NULL
    `).run(randomUUID(), profile.id);

    return { id: targetId, status: "QUEUED", alreadyExists: false };
  })();

  if (process.env.LINKI_DISABLE_RUNNER !== "true") ensureGlobalRunnerStarted();
  return result;
}

export function pauseRadarContact(radarLeadId: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const target = db.prepare("SELECT id FROM targets WHERE radar_lead_id = ?").get(radarLeadId) as
      | { id: string }
      | undefined;
    if (!target) return false;
    db.prepare("UPDATE targets SET radar_status = 'PAUSED' WHERE id = ?").run(target.id);
    db.prepare(`
      UPDATE run_profile_tracks
      SET state = 'skipped', next_step_at = NULL, error_message = 'Paused by Radar omnichannel state'
      WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)
        AND state NOT IN ('completed', 'failed', 'skipped')
    `).run(target.id);
    return true;
  })();
}
