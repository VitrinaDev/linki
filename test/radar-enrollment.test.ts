import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before } from "node:test";

const temp = mkdtempSync(path.join(tmpdir(), "linki-radar-test-"));
process.env.LINKI_DB_PATH = path.join(temp, "linki.db");
process.env.LINKI_DISABLE_RUNNER = "true";
process.env.LINKI_DISABLE_UPDATE_CHECK = "true";

type Db = ReturnType<typeof import("../lib/db")["getDb"]>;
type EnrollmentModule = typeof import("../lib/radar/enrollment");
let db: Db;
let enrollRadarContact: EnrollmentModule["enrollRadarContact"];
let pauseRadarContact: EnrollmentModule["pauseRadarContact"];
let harvestRadarCallbacks: typeof import("../lib/radar/callbacks")["harvestRadarCallbacks"];
const config = {
  listId: "radar_vitrina_active_campaign",
  workflowId: "radar-workflow",
  accountId: "founder-1",
};
const input = {
  firstName: "Ana",
  lastName: "Pérez",
  companyName: "Vitrina",
  linkedinUrl: "https://www.linkedin.com/in/ana-perez/",
  listId: config.listId,
  status: "QUEUED" as const,
  customAttributes: {
    radar_lead_id: "7b299221-19ca-4b73-8400-d87716862a33",
    icebreaker_context: "Vi que Vitrina está creciendo en Chile.",
  },
};

before(async () => {
  const dbModule = await import("../lib/db");
  const enrollmentModule = await import("../lib/radar/enrollment");
  const callbacksModule = await import("../lib/radar/callbacks");
  db = dbModule.getDb();
  enrollRadarContact = enrollmentModule.enrollRadarContact;
  pauseRadarContact = enrollmentModule.pauseRadarContact;
  harvestRadarCallbacks = callbacksModule.harvestRadarCallbacks;

  db.prepare(`
    INSERT INTO accounts (id, name, email, daily_connection_limit)
    VALUES (?, 'Founder One', 'founder@example.com', 20)
  `).run(config.accountId);
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, 'Radar LinkedIn')").run(config.workflowId);
  db.prepare(`
    INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, message_body, enabled, track)
    VALUES ('step-1', ?, 1, 'message', '{{icebreaker_context}}', 1, 'linkedin')
  `).run(config.workflowId);
});

test("enrolls idempotently in the configured Radar run and clamps the account limit", () => {
  const first = enrollRadarContact(input, config);
  assert.equal(first.alreadyExists, false);
  assert.equal(first.status, "QUEUED");

  const second = enrollRadarContact(input, config);
  assert.equal(second.alreadyExists, true);
  assert.equal(second.id, first.id);

  const target = db.prepare(`
    SELECT radar_lead_id, icebreaker_context, linkedin_url FROM targets WHERE id = ?
  `).get(first.id) as Record<string, string>;
  assert.equal(target.radar_lead_id, input.customAttributes.radar_lead_id);
  assert.equal(target.icebreaker_context, input.customAttributes.icebreaker_context);
  assert.equal(target.linkedin_url, "https://www.linkedin.com/in/ana-perez");

  const account = db.prepare("SELECT daily_connection_limit FROM accounts WHERE id = ?").get(config.accountId) as { daily_connection_limit: number };
  assert.equal(account.daily_connection_limit, 15);
  const track = db.prepare("SELECT state FROM run_profile_tracks").get() as { state: string };
  assert.equal(track.state, "pending");
});

test("durably queues callbacks and pauses all active tracks", () => {
  const target = db.prepare("SELECT id FROM targets WHERE radar_lead_id = ?").get(input.customAttributes.radar_lead_id) as { id: string };
  db.prepare("UPDATE targets SET connected_at = '2026-09-10 14:00:00' WHERE id = ?").run(target.id);
  assert.equal(harvestRadarCallbacks(db), 1);
  assert.equal(harvestRadarCallbacks(db), 0);

  const callback = db.prepare("SELECT event_type, status FROM radar_callback_outbox").get() as { event_type: string; status: string };
  assert.deepEqual(callback, { event_type: "connection.accepted", status: "pending" });

  assert.equal(pauseRadarContact(input.customAttributes.radar_lead_id), true);
  const paused = db.prepare("SELECT radar_status FROM targets WHERE id = ?").get(target.id) as { radar_status: string };
  const track = db.prepare("SELECT state FROM run_profile_tracks").get() as { state: string };
  assert.equal(paused.radar_status, "PAUSED");
  assert.equal(track.state, "skipped");
});
