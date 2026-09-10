import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before } from "node:test";

const temp = mkdtempSync(path.join(tmpdir(), "linki-radar-provision-test-"));
process.env.LINKI_DB_PATH = path.join(temp, "linki.db");
process.env.LINKI_DISABLE_RUNNER = "true";
process.env.LINKI_DISABLE_UPDATE_CHECK = "true";
delete process.env.RADAR_LINKEDIN_ACCOUNT_ID;
delete process.env.RADAR_WORKFLOW_ID;

type Db = ReturnType<typeof import("../lib/db")["getDb"]>;
let db: Db;
let provisionRadarCampaign: typeof import("../lib/radar/provisioning")["provisionRadarCampaign"];
let getRadarConfig: typeof import("../lib/radar/config")["getRadarConfig"];
let getRadarRuntimeStatus: typeof import("../lib/radar/runtime")["getRadarRuntimeStatus"];
let upsertRadarAccount: typeof import("../lib/radar/runtime")["upsertRadarAccount"];

const manifest = {
  schemaVersion: 1 as const,
  listId: "radar_vitrina_active_campaign" as const,
  workflowId: "radar_vitrina_active_campaign_workflow" as const,
  campaignName: "Radar · Vitrina active",
  messageTemplate: "Hola {{first_name}}, {{icebreaker_context}}\n\n¿Te puedo contar una idea breve?",
  messageDelaySeconds: 3_600,
  accountPolicy: {
    dailyConnectionLimit: 1,
    dailyMessageLimit: 1,
    dailyInmailLimit: 0 as const,
    activeHoursStart: 9,
    activeHoursEnd: 18,
    timezone: "America/Santiago",
    workingDays: [1, 2, 3, 4, 5],
  },
};

before(async () => {
  const dbModule = await import("../lib/db");
  const provisioningModule = await import("../lib/radar/provisioning");
  const configModule = await import("../lib/radar/config");
  const runtimeModule = await import("../lib/radar/runtime");
  db = dbModule.getDb();
  provisionRadarCampaign = provisioningModule.provisionRadarCampaign;
  getRadarConfig = configModule.getRadarConfig;
  getRadarRuntimeStatus = runtimeModule.getRadarRuntimeStatus;
  upsertRadarAccount = runtimeModule.upsertRadarAccount;
});

test("provisions the managed list, workflow, binding, and conservative account policy", () => {
  db.prepare(`
    INSERT INTO accounts (id, name, email, is_authenticated)
    VALUES ('founder-1', 'Founder One', 'founder@example.com', 1)
  `).run();

  const first = provisionRadarCampaign(manifest);
  const second = provisionRadarCampaign(manifest);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(getRadarConfig(), {
    listId: manifest.listId,
    workflowId: manifest.workflowId,
    accountId: "founder-1",
  });

  const list = db.prepare("SELECT name, purpose FROM lists WHERE id = ?").get(manifest.listId);
  assert.deepEqual(list, { name: manifest.campaignName, purpose: "linkedin" });
  const steps = db.prepare(`
    SELECT step_order, step_type, delay_seconds, message_body
      FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order
  `).all(manifest.workflowId);
  assert.deepEqual(steps, [
    { step_order: 1, step_type: "connect", delay_seconds: 0, message_body: null },
    { step_order: 2, step_type: "message", delay_seconds: 3_600, message_body: manifest.messageTemplate },
  ]);
  const account = db.prepare(`
    SELECT daily_connection_limit, daily_message_limit, daily_inmail_limit,
           active_hours_start, active_hours_end, timezone, working_days
      FROM accounts WHERE id = 'founder-1'
  `).get();
  assert.deepEqual(account, {
    daily_connection_limit: 1,
    daily_message_limit: 1,
    daily_inmail_limit: 0,
    active_hours_start: 9,
    active_hours_end: 18,
    timezone: "America/Santiago",
    working_days: "1,2,3,4,5",
  });
});

test("reports a secret-free runtime status and preserves authentication on metadata updates", () => {
  const before = getRadarRuntimeStatus();
  assert.equal(before.proxyConfigured, false);
  assert.equal(before.accountCount, 1);
  assert.equal(before.campaign?.workflow_id, manifest.workflowId);
  assert.deepEqual(before.queue, { contacts: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 });
  assert.equal("cookies_json" in before.account!, false);

  upsertRadarAccount({ name: "Founder renamed", email: "founder@example.com" });
  const sameAccount = db.prepare("SELECT name, is_authenticated FROM accounts WHERE id = 'founder-1'").get();
  assert.deepEqual(sameAccount, { name: "Founder renamed", is_authenticated: 1 });

  upsertRadarAccount({ name: "Founder renamed", email: "new@example.com" });
  const changedEmail = db.prepare("SELECT email, is_authenticated, cookies_json FROM accounts WHERE id = 'founder-1'").get();
  assert.deepEqual(changedEmail, { email: "new@example.com", is_authenticated: 0, cookies_json: null });
  db.prepare("UPDATE accounts SET email = 'founder@example.com', is_authenticated = 1 WHERE id = 'founder-1'").run();
});

test("refuses ambiguous multi-account runtimes", () => {
  db.prepare(`
    INSERT INTO accounts (id, name, email, is_authenticated)
    VALUES ('founder-2', 'Founder Two', 'founder2@example.com', 1)
  `).run();
  assert.throws(
    () => provisionRadarCampaign(manifest),
    /exactly one authenticated LinkedIn account/,
  );
  db.prepare("DELETE FROM accounts WHERE id = 'founder-2'").run();
});
