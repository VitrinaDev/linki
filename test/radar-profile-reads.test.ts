import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before, beforeEach } from "node:test";

const temp = mkdtempSync(path.join(tmpdir(), "linki-radar-reads-test-"));
process.env.LINKI_DB_PATH = path.join(temp, "linki.db");
process.env.LINKI_DISABLE_RUNNER = "true";
process.env.LINKI_DISABLE_UPDATE_CHECK = "true";
process.env.RADAR_RUNTIME_KEY = "jose";
delete process.env.RADAR_LINKEDIN_ACCOUNT_ID;
delete process.env.RADAR_WORKFLOW_ID;

type Db = ReturnType<typeof import("../lib/db")["getDb"]>;
type ContractsModule = typeof import("../lib/radar/contracts");
type ProfileReadsModule = typeof import("../lib/radar/profile-reads");

let db: Db;
let contracts: ContractsModule;
let reads: ProfileReadsModule;
let ProfileReadError: typeof import("../lib/linkedin/profile-read")["ProfileReadError"];
let provisionRadarCampaign: typeof import("../lib/radar/provisioning")["provisionRadarCampaign"];
let processRadarCallbacks: typeof import("../lib/radar/callbacks")["processRadarCallbacks"];
let getRadarRuntimeStatus: typeof import("../lib/radar/runtime")["getRadarRuntimeStatus"];

const PERSONA = "0d5b1de2-4f37-4c5c-9a05-8cf1df15b0b6";
const OTHER_PERSONA = "2b9a24f0-7b90-4f6b-9a6a-5f4f2c5d2b21";
const PROFILE_URL = "https://www.linkedin.com/in/ana-perez";

const manifest = {
  schemaVersion: 1 as const,
  outboundEnabled: false,
  listId: "radar_vitrina_active_campaign" as const,
  workflowId: "radar_vitrina_active_campaign_workflow" as const,
  campaignName: "Radar · Vitrina active",
  messageTemplate: "Hola {{first_name}}, {{icebreaker_context}}",
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
  readPolicy: { enabled: false, dailyProfileReadLimit: 0, minGapMinutes: 3 },
};

const readResult = {
  headline: "Gerente de Operaciones en Vitrina",
  location: "Santiago, Chile",
  partial: false,
  positions: [{
    title: "Gerente de Operaciones",
    company: "Vitrina",
    company_url: "https://www.linkedin.com/company/vitrina",
    start: "2021-03",
    end: null,
    current: true,
  }],
};

/** Working hours the tests never fall outside of, whatever the clock says. */
function openTheWorkingDay() {
  db.prepare(`
    UPDATE accounts
       SET active_hours_start = 0, active_hours_end = 24,
           timezone = 'UTC', working_days = '1,2,3,4,5,6,7'
     WHERE id = 'founder-1'
  `).run();
}

function setRuntimeReads(enabled: boolean, dailyLimit: number, gapMinutes = 3) {
  db.prepare(`
    UPDATE radar_runtime_config
       SET reads_enabled = ?, daily_profile_read_limit = ?, min_read_gap_minutes = ?
     WHERE id = 1
  `).run(enabled ? 1 : 0, dailyLimit, gapMinutes);
}

function readyRuntimeEnv() {
  process.env.LINKI_REQUIRE_PROXY = "true";
  process.env.LINKI_PROXY_SERVER = "http://proxy.example:1234";
  process.env.RADAR_CALLBACK_URL = "https://radar.example/callback";
  process.env.RADAR_CALLBACK_SECRET = "callback-secret";
}

function clearRuntimeEnv() {
  delete process.env.LINKI_REQUIRE_PROXY;
  delete process.env.LINKI_PROXY_SERVER;
  delete process.env.RADAR_CALLBACK_URL;
  delete process.env.RADAR_CALLBACK_SECRET;
}

before(async () => {
  db = (await import("../lib/db")).getDb();
  contracts = await import("../lib/radar/contracts");
  reads = await import("../lib/radar/profile-reads");
  ProfileReadError = (await import("../lib/linkedin/profile-read")).ProfileReadError;
  provisionRadarCampaign = (await import("../lib/radar/provisioning")).provisionRadarCampaign;
  processRadarCallbacks = (await import("../lib/radar/callbacks")).processRadarCallbacks;
  getRadarRuntimeStatus = (await import("../lib/radar/runtime")).getRadarRuntimeStatus;

  db.prepare(`
    INSERT INTO accounts (id, name, email, is_authenticated)
    VALUES ('founder-1', 'Founder One', 'founder@example.com', 1)
  `).run();
  provisionRadarCampaign(manifest);
  openTheWorkingDay();
});

beforeEach(() => {
  db.prepare("DELETE FROM radar_profile_reads").run();
  db.prepare("DELETE FROM radar_callback_outbox").run();
  openTheWorkingDay();
});

test("accepts only Radar's exact read request, on a /in/ profile URL", () => {
  const request = { linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA };
  assert.deepEqual(contracts.radarProfileReadSchema.parse(request), request);
  assert.equal(
    contracts.radarProfileReadSchema.safeParse({ ...request, linkedinUrl: "https://example.com/ana" }).success,
    false,
  );
  assert.equal(
    contracts.radarProfileReadSchema.safeParse({
      ...request,
      linkedinUrl: "https://www.linkedin.com/company/vitrina",
    }).success,
    false,
  );
  assert.equal(contracts.radarProfileReadSchema.safeParse({ ...request, radar_lead_id: PERSONA }).success, false);
  assert.equal(contracts.radarProfileReadSchema.safeParse({ linkedinUrl: PROFILE_URL }).success, false);
});

test("a Radar that sends no readPolicy still provisions, with reads off", () => {
  const withoutReadPolicy: Record<string, unknown> = { ...manifest };
  delete withoutReadPolicy.readPolicy;
  const parsed = contracts.radarProvisionSchema.parse(withoutReadPolicy);
  assert.deepEqual(parsed.readPolicy, { enabled: false, dailyProfileReadLimit: 0, minGapMinutes: 3 });

  const result = provisionRadarCampaign(parsed);
  assert.equal(result.readsEnabled, false);
  assert.equal(result.dailyProfileReadLimit, 0);
  assert.deepEqual(
    db.prepare("SELECT reads_enabled, daily_profile_read_limit FROM radar_runtime_config WHERE id = 1").get(),
    { reads_enabled: 0, daily_profile_read_limit: 0 },
  );
  openTheWorkingDay();
});

test("the read budget is not part of the managed workflow and cannot be enabled unready", () => {
  clearRuntimeEnv();
  assert.throws(
    () => provisionRadarCampaign({ ...manifest, readPolicy: { enabled: true, dailyProfileReadLimit: 5, minGapMinutes: 3 } }),
    /required proxy, and callbacks/,
  );

  const before = db.prepare("SELECT workflow_sha256 FROM radar_runtime_config WHERE id = 1").get() as { workflow_sha256: string };
  // A contact in flight must not block a change of read budget.
  db.prepare("INSERT INTO targets (id, linkedin_url) VALUES ('target-1', 'https://www.linkedin.com/in/target-1')").run();
  db.prepare(`
    INSERT INTO runs (id, workflow_id, list_id, account_id, status)
    VALUES ('run-1', ?, ?, 'founder-1', 'running')
  `).run(manifest.workflowId, manifest.listId);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES ('profile-1', 'run-1', 'target-1')").run();
  db.prepare(`
    INSERT INTO run_profile_tracks (id, run_profile_id, track, state)
    VALUES ('track-1', 'profile-1', 'linkedin', 'pending')
  `).run();

  readyRuntimeEnv();
  const result = provisionRadarCampaign({
    ...manifest,
    readPolicy: { enabled: true, dailyProfileReadLimit: 20, minGapMinutes: 5 },
  });
  assert.equal(result.readsEnabled, true);
  assert.equal(result.dailyProfileReadLimit, 20);
  assert.equal(result.outboundEnabled, false);
  const after = db.prepare(`
    SELECT workflow_sha256, reads_enabled, daily_profile_read_limit, min_read_gap_minutes, outbound_enabled
      FROM radar_runtime_config WHERE id = 1
  `).get() as Record<string, unknown>;
  assert.equal(after.workflow_sha256, before.workflow_sha256);
  assert.equal(after.reads_enabled, 1);
  assert.equal(after.daily_profile_read_limit, 20);
  assert.equal(after.min_read_gap_minutes, 5);
  assert.equal(after.outbound_enabled, 0, "reads must not switch sending on");

  db.prepare("DELETE FROM run_profile_tracks").run();
  db.prepare("DELETE FROM run_profiles").run();
  db.prepare("DELETE FROM runs").run();
  db.prepare("DELETE FROM targets").run();
  clearRuntimeEnv();
  openTheWorkingDay();
});

test("a disabled runtime answers 423 and queues nothing", () => {
  setRuntimeReads(false, 20);
  assert.deepEqual(reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA }), {
    outcome: "disabled",
  });
  setRuntimeReads(true, 0);
  assert.deepEqual(reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA }), {
    outcome: "disabled",
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM radar_profile_reads").get() as { n: number }).n, 0);
});

test("queues one job per Persona and repeats the open job id instead of a second visit", () => {
  setRuntimeReads(true, 20);
  const first = reads.requestProfileRead({ linkedinUrl: `${PROFILE_URL}/?trk=nav`, radar_persona_id: PERSONA });
  assert.equal(first.outcome, "queued");
  assert.ok(first.outcome === "queued" && first.jobId);

  const second = reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  assert.deepEqual(second, { outcome: "duplicate", jobId: first.outcome === "queued" ? first.jobId : "" });

  const row = db.prepare("SELECT linkedin_url, state, attempts FROM radar_profile_reads").get();
  assert.deepEqual(row, { linkedin_url: PROFILE_URL, state: "queued", attempts: 0 });
});

test("spaces reads by the minimum gap and answers 429 once the day's budget is spent", () => {
  setRuntimeReads(true, 2, 10);
  const completed = (id: string, minutesAgo: number) => db.prepare(`
    INSERT INTO radar_profile_reads (id, radar_persona_id, linkedin_url, state, attempts, completed_at, read_at)
    VALUES (?, ?, ?, 'done', 1, datetime('now', ?), datetime('now', ?))
  `).run(id, `${id}-persona`, PROFILE_URL, `-${minutesAgo} minutes`, `-${minutesAgo} minutes`);

  completed("job-a", 1);
  const spaced = reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  assert.equal(spaced.outcome, "queued");
  const scheduledInMinutes = spaced.outcome === "queued"
    ? (Date.parse(spaced.scheduledAt) - Date.now()) / 60_000
    : 0;
  assert.ok(scheduledInMinutes >= 8.9, `scheduled too early: ${scheduledInMinutes} min`);
  assert.ok(scheduledInMinutes <= 25, `scheduled too late: ${scheduledInMinutes} min`);

  completed("job-b", 2);
  const capped = reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: OTHER_PERSONA });
  assert.equal(capped.outcome, "capped");
  // The next chance is the next working day, not later today.
  assert.ok(capped.outcome === "capped" && capped.retryAfter >= 60, "retryAfter must be a real wait");
  assert.deepEqual(
    db.prepare("SELECT COUNT(*) AS n FROM radar_profile_reads WHERE radar_persona_id = ?").get(OTHER_PERSONA),
    { n: 0 },
    "a capped request must not leave a job behind",
  );
});

test("the callback payload is exactly the allowlist, nothing else", () => {
  // Everything a live page could also expose must be dropped on the floor.
  const noisy = {
    ...readResult,
    summary: "…", skills: ["x"], languages: ["es"], educations: [{}], recent_posts: [{}],
    num_connections: 500, num_shared_connections: 3, degree: 2, is_premium: true,
    photo: "https://media.licdn.com/x.jpg",
  };
  const sanitized = contracts.sanitizeProfileRead(`${PROFILE_URL}/`, "2026-09-18T14:22:10Z", noisy);
  assert.deepEqual(Object.keys(sanitized), [...contracts.PROFILE_READ_PAYLOAD_KEYS]);
  assert.deepEqual(Object.keys(sanitized.positions[0]), [...contracts.PROFILE_READ_POSITION_KEYS]);
  assert.equal(sanitized.linkedin_url, PROFILE_URL);
  assert.equal(sanitized.read_at, "2026-09-18T14:22:10.000Z");
  assert.equal(sanitized.partial, false);

  const empty = contracts.sanitizeProfileRead(PROFILE_URL, "2026-09-18T14:22:10Z", {
    headline: "Solo titular", location: null, partial: false, positions: [],
  });
  assert.equal(empty.partial, true, "no position read is always partial");
  assert.deepEqual(empty.positions, []);

  const callback = contracts.buildRadarProfileReadCallback(
    "linki_test", "2026-09-18T14:22:10Z",
    { id: "job-1", radar_persona_id: PERSONA, runtime_key: "jose" },
    { profile: sanitized },
  );
  assert.deepEqual(Object.keys(callback), ["eventId", "source", "occurredAt", "eventType", "data"]);
  assert.deepEqual(Object.keys(callback.data.job), ["id", "radar_persona_id", "runtime_key"]);
  assert.equal(callback.eventType, "profile.read");
  assert.equal(callback.source, "linki");
});

test("executes one read, ships the signed callback, redacts it, and creates no contact", async () => {
  setRuntimeReads(true, 20);
  const queued = reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  assert.equal(queued.outcome, "queued");

  const seen: Array<{ accountId: string; url: string }> = [];
  const tick = await reads.processProfileReads(db, async (accountId, url) => {
    seen.push({ accountId, url });
    return readResult;
  });
  assert.equal(tick, "done");
  assert.deepEqual(seen, [{ accountId: "founder-1", url: PROFILE_URL }]);

  const job = db.prepare("SELECT state, attempts, error_code, read_at FROM radar_profile_reads").get() as Record<string, unknown>;
  assert.equal(job.state, "done");
  assert.equal(job.attempts, 1);
  assert.equal(job.error_code, null);
  assert.ok(job.read_at);

  // A read is not outreach: no contact, no run, no track was created.
  for (const table of ["targets", "runs", "run_profiles", "run_profile_tracks"]) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    assert.equal(n, 0, `${table} must stay empty`);
  }

  const outbox = db.prepare("SELECT event_type, target_id, payload_json FROM radar_callback_outbox").get() as {
    event_type: string; target_id: string | null; payload_json: string;
  };
  assert.equal(outbox.event_type, "profile.read");
  assert.equal(outbox.target_id, null);
  const payload = JSON.parse(outbox.payload_json);
  assert.deepEqual(Object.keys(payload.data.profile), [...contracts.PROFILE_READ_PAYLOAD_KEYS]);
  assert.equal(payload.data.job.runtime_key, "jose");
  assert.equal(payload.data.job.radar_persona_id, PERSONA);

  let delivered: { body: string; timestamp: string; signature: string } | null = null;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      delivered = {
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
    delete process.env.RADAR_CALLBACK_URL;
    delete process.env.RADAR_CALLBACK_SECRET;
  }
  const sent = delivered as unknown as { body: string; timestamp: string; signature: string };
  assert.ok(sent, "the callback must be delivered");
  assert.equal(
    sent.signature,
    contracts.callbackSignature("test-callback-secret", sent.timestamp, sent.body),
  );
  assert.deepEqual(
    db.prepare("SELECT status, payload_json FROM radar_callback_outbox").get(),
    { status: "sent", payload_json: null },
  );

  const status = getRadarRuntimeStatus();
  assert.equal(status.reads.enabled, true);
  assert.equal(status.reads.dailyLimit, 20);
  assert.equal(status.reads.usedToday, 1);
  assert.ok(status.reads.lastReadAt);
});

test("an empty position list is a partial read, not a failure", async () => {
  setRuntimeReads(true, 20);
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  const tick = await reads.processProfileReads(db, async () => ({
    headline: "Solo titular", location: null, partial: true, positions: [],
  }));
  assert.equal(tick, "done");
  const payload = JSON.parse(
    (db.prepare("SELECT payload_json FROM radar_callback_outbox").get() as { payload_json: string }).payload_json,
  );
  assert.equal(payload.eventType, "profile.read");
  assert.equal(payload.data.profile.partial, true);
  assert.deepEqual(payload.data.profile.positions, []);
});

test("a challenge pauses reads AND sending, fails the job and never retries it", async () => {
  setRuntimeReads(true, 20);
  db.prepare(`
    UPDATE accounts SET daily_connection_limit = 3, daily_message_limit = 3, is_authenticated = 1
     WHERE id = 'founder-1'
  `).run();
  db.prepare("UPDATE radar_runtime_config SET outbound_enabled = 1 WHERE id = 1").run();
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });

  const tick = await reads.processProfileReads(db, async () => {
    throw new ProfileReadError("challenge", "checkpoint");
  });
  assert.equal(tick, "failed");

  assert.deepEqual(
    db.prepare("SELECT reads_enabled, outbound_enabled FROM radar_runtime_config WHERE id = 1").get(),
    { reads_enabled: 0, outbound_enabled: 0 },
  );
  assert.deepEqual(
    db.prepare(`
      SELECT daily_connection_limit, daily_message_limit, is_authenticated FROM accounts WHERE id = 'founder-1'
    `).get(),
    { daily_connection_limit: 0, daily_message_limit: 0, is_authenticated: 0 },
  );
  const job = db.prepare("SELECT state, attempts, error_code FROM radar_profile_reads").get();
  assert.deepEqual(job, { state: "failed", attempts: 1, error_code: "challenge" });

  const failure = JSON.parse(
    (db.prepare("SELECT payload_json FROM radar_callback_outbox").get() as { payload_json: string }).payload_json,
  );
  assert.equal(failure.eventType, "profile.read.failed");
  assert.deepEqual(Object.keys(failure.data), ["job"]);
  assert.equal(failure.data.job.error_code, "challenge");

  // Nothing is retried, and the paused runtime performs no further read.
  setRuntimeReads(true, 20);
  db.prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = 'founder-1'").run();
  let called = 0;
  assert.equal(await reads.processProfileReads(db, async () => { called += 1; return readResult; }), "idle");
  assert.equal(called, 0);
  db.prepare("UPDATE radar_runtime_config SET outbound_enabled = 0 WHERE id = 1").run();
});

test("a rate limit pauses the runtime but leaves the session authenticated", async () => {
  setRuntimeReads(true, 20);
  db.prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = 'founder-1'").run();
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  const tick = await reads.processProfileReads(db, async () => {
    throw new ProfileReadError("rate_limited", "HTTP 429");
  });
  assert.equal(tick, "failed");
  assert.deepEqual(
    db.prepare("SELECT reads_enabled, outbound_enabled FROM radar_runtime_config WHERE id = 1").get(),
    { reads_enabled: 0, outbound_enabled: 0 },
  );
  assert.deepEqual(
    db.prepare("SELECT is_authenticated FROM accounts WHERE id = 'founder-1'").get(),
    { is_authenticated: 1 },
  );
  assert.deepEqual(
    db.prepare("SELECT state, attempts, error_code FROM radar_profile_reads").get(),
    { state: "failed", attempts: 1, error_code: "rate_limited" },
  );
});

test("only a network failure is retried, once, at least thirty minutes later", async () => {
  setRuntimeReads(true, 20);
  db.prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = 'founder-1'").run();
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });

  const failNetwork = async () => { throw new ProfileReadError("network", "Timeout 30000ms exceeded"); };
  assert.equal(await reads.processProfileReads(db, failNetwork), "retry");

  const retried = db.prepare(`
    SELECT state, attempts, error_code,
           CAST((julianday(scheduled_at) - julianday('now')) * 24 * 60 AS INTEGER) AS in_minutes
      FROM radar_profile_reads
  `).get() as { state: string; attempts: number; error_code: string; in_minutes: number };
  assert.equal(retried.state, "queued");
  assert.equal(retried.attempts, 1);
  assert.equal(retried.error_code, "network");
  assert.ok(retried.in_minutes >= 29, `retry scheduled in ${retried.in_minutes} min`);
  // The runtime is NOT paused by a network failure.
  assert.deepEqual(
    db.prepare("SELECT reads_enabled FROM radar_runtime_config WHERE id = 1").get(),
    { reads_enabled: 1 },
  );
  assert.deepEqual(
    db.prepare("SELECT COUNT(*) AS n FROM radar_callback_outbox").get(),
    { n: 0 },
    "a retryable failure tells Radar nothing yet",
  );

  // Second attempt: due now, and terminal.
  db.prepare("UPDATE radar_profile_reads SET scheduled_at = datetime('now'), completed_at = NULL").run();
  assert.equal(await reads.processProfileReads(db, failNetwork), "failed");
  assert.deepEqual(
    db.prepare("SELECT state, attempts, error_code FROM radar_profile_reads").get(),
    { state: "failed", attempts: 2, error_code: "network" },
  );
  const failure = JSON.parse(
    (db.prepare("SELECT payload_json FROM radar_callback_outbox").get() as { payload_json: string }).payload_json,
  );
  assert.equal(failure.eventType, "profile.read.failed");
  assert.equal(failure.data.job.error_code, "network");
});

test("reads wait for the account's working hours", async () => {
  setRuntimeReads(true, 20);
  db.prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = 'founder-1'").run();
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  // Leave exactly one working day configured, and make it a day that is not today.
  const todayIso = ((new Date().getUTCDay() + 6) % 7) + 1;
  db.prepare(`
    UPDATE accounts SET working_days = ?, active_hours_start = 0, active_hours_end = 24
     WHERE id = 'founder-1'
  `).run(String((todayIso % 7) + 1));
  let called = 0;
  assert.equal(await reads.processProfileReads(db, async () => { called += 1; return readResult; }), "idle");
  assert.equal(called, 0);
  assert.deepEqual(
    db.prepare("SELECT state, attempts FROM radar_profile_reads").get(),
    { state: "queued", attempts: 0 },
  );
  openTheWorkingDay();
});
