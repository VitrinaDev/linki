import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
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
let processRadarCallbacks: typeof import("../lib/radar/callbacks")["processRadarCallbacks"];
let callbackSignature: typeof import("../lib/radar/contracts")["callbackSignature"];
let shouldSyncAccepted: typeof import("../lib/linkedin/sync-accepted")["shouldSyncAccepted"];
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
  const acceptedModule = await import("../lib/linkedin/sync-accepted");
  const contractsModule = await import("../lib/radar/contracts");
  db = dbModule.getDb();
  enrollRadarContact = enrollmentModule.enrollRadarContact;
  pauseRadarContact = enrollmentModule.pauseRadarContact;
  harvestRadarCallbacks = callbacksModule.harvestRadarCallbacks;
  processRadarCallbacks = callbacksModule.processRadarCallbacks;
  shouldSyncAccepted = acceptedModule.shouldSyncAccepted;
  callbackSignature = contractsModule.callbackSignature;

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
  assert.throws(() => db.prepare("UPDATE targets SET radar_status = 'INVALID' WHERE id = ?").run(first.id));
});

test("polls Radar connection acceptances on the five-minute near-real-time interval", () => {
  process.env.RADAR_WORKFLOW_ID = config.workflowId;
  process.env.RADAR_LINKEDIN_ACCOUNT_ID = config.accountId;
  process.env.RADAR_ACCEPTED_SYNC_INTERVAL_MINUTES = "5";
  db.prepare("UPDATE accounts SET accepted_sync_at = datetime('now') WHERE id = ?").run(config.accountId);
  assert.equal(shouldSyncAccepted(config.accountId), false);
  db.prepare("UPDATE accounts SET accepted_sync_at = datetime('now', '-6 minutes') WHERE id = ?").run(config.accountId);
  assert.equal(shouldSyncAccepted(config.accountId), true);
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

test("delivers the durable callback with Radar's exact HMAC headers", async () => {
  let received: { body: string; timestamp: string; signature: string } | null = null;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = {
        body,
        timestamp: String(request.headers["x-omnichannel-timestamp"]),
        signature: String(request.headers["x-omnichannel-signature"]),
      };
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.RADAR_CALLBACK_URL = `http://127.0.0.1:${address.port}/callback`;
  process.env.RADAR_CALLBACK_SECRET = "test-callback-secret";
  try {
    await processRadarCallbacks(db);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.ok(received);
  const delivery = received as { body: string; timestamp: string; signature: string };
  assert.equal(delivery.signature, callbackSignature(process.env.RADAR_CALLBACK_SECRET, delivery.timestamp, delivery.body));
  const row = db.prepare("SELECT status, attempts FROM radar_callback_outbox").get() as { status: string; attempts: number };
  assert.deepEqual(row, { status: "sent", attempts: 1 });
});
