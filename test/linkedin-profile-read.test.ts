/**
 * The profile reader against scripted LinkedIn answers.
 *
 * Two things are being pinned here, and both are safety properties rather than
 * parsing niceties:
 *
 *  1. DETECTION IS UNIFORM. A throttle on the Voyager fetch and a checkpoint on
 *     the Sales Navigator page are the same incident as one on the profile page:
 *     they fail closed and park the runtime. Only an answer with NO incident
 *     signal — a 404, a shape we cannot parse — is allowed to be read as "try
 *     the next thing" and end as a partial read.
 *  2. THE CAP COUNTS NAVIGATIONS. Three page views cost three units of the daily
 *     budget, and the fallback chain stops rather than overshoot it.
 *
 * The page is a fake: no browser, no network, no session. Everything LinkedIn
 * would answer is injected, so each branch can be exercised deterministically.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before, beforeEach } from "node:test";
import type { Page } from "playwright";

const temp = mkdtempSync(path.join(tmpdir(), "linki-profile-read-test-"));
process.env.LINKI_DB_PATH = path.join(temp, "linki.db");
process.env.LINKI_DISABLE_RUNNER = "true";
process.env.LINKI_DISABLE_UPDATE_CHECK = "true";
process.env.RADAR_RUNTIME_KEY = "jose";
delete process.env.RADAR_LINKEDIN_ACCOUNT_ID;

type Db = ReturnType<typeof import("../lib/db")["getDb"]>;
type ProfileReadModule = typeof import("../lib/linkedin/profile-read");
type ProfileReadsModule = typeof import("../lib/radar/profile-reads");

let db: Db;
let reader: ProfileReadModule;
let reads: ProfileReadsModule;

const PERSONA = "0d5b1de2-4f37-4c5c-9a05-8cf1df15b0b6";
const PROFILE_URL = "https://www.linkedin.com/in/ana-perez";

// ─── the fake page ────────────────────────────────────────────────────────────

interface FakeNode {
  text: string;
  attrs?: Record<string, string>;
  children?: Record<string, FakeNode[]>;
}

interface FakePageSpec {
  /** Where the navigation actually landed (defaults to the requested URL). */
  url?: string;
  status?: number | null;
  /** The navigation itself blows up (a timeout, a reset connection). */
  fail?: boolean;
  body?: string;
  name?: string;
  headline?: string;
  location?: string;
  experience?: Array<{ lines: string[]; companyHref?: string }>;
  memberId?: string | null;
  /** `salesApiProfiles` bodies emitted while this page loads. */
  salesResponses?: Array<Record<string, unknown>>;
}

interface VoyagerAnswer {
  status: number;
  url?: string;
  body?: string;
}

interface Script {
  cookies: Array<{ name: string; value: string }>;
  pages: Array<{ match: RegExp; page: FakePageSpec }>;
  /** Answer for every Voyager endpoint the reader tries. */
  voyager?: VoyagerAnswer;
}

class FakeLocator {
  constructor(private readonly nodes: FakeNode[]) {}
  async count(): Promise<number> { return this.nodes.length; }
  first(): FakeLocator { return new FakeLocator(this.nodes.slice(0, 1)); }
  nth(index: number): FakeLocator { return new FakeLocator(this.nodes.slice(index, index + 1)); }
  /** Only used as `.filter({ has: h1 })`; the fake's top card always owns one. */
  filter(): FakeLocator { return this; }
  async innerText(): Promise<string> {
    if (this.nodes.length === 0) throw new Error("locator resolved to no element");
    return this.nodes[0].text;
  }
  async allInnerTexts(): Promise<string[]> { return this.nodes.map((node) => node.text); }
  async getAttribute(name: string): Promise<string | null> { return this.nodes[0]?.attrs?.[name] ?? null; }
  locator(selector: string): FakeLocator {
    return new FakeLocator(this.nodes.flatMap((node) => node.children?.[selector] ?? []));
  }
}

class FakePage {
  readonly navigations: string[] = [];
  private current: FakePageSpec = {};
  private currentUrl = "about:blank";
  private handlers: Array<(response: unknown) => unknown> = [];

  constructor(private readonly script: Script) {}

  url(): string { return this.currentUrl; }

  private resolve(url: string): FakePageSpec {
    return this.script.pages.find((entry) => entry.match.test(url))?.page
      ?? { status: 404, body: "This page doesn't exist" };
  }

  async goto(url: string): Promise<{ status(): number } | null> {
    this.navigations.push(url);
    const spec = this.resolve(url);
    if (spec.fail) throw new Error("net::ERR_TIMED_OUT");
    this.current = spec;
    this.currentUrl = spec.url ?? url;
    for (const body of spec.salesResponses ?? []) {
      const response = {
        url: () => "https://www.linkedin.com/sales-api/salesApiProfiles/x",
        status: () => 200,
        json: async () => body,
      };
      for (const handler of [...this.handlers]) await handler(response);
    }
    return spec.status === null ? null : { status: () => spec.status ?? 200 };
  }

  async waitForTimeout(): Promise<void> {}

  on(event: string, handler: (response: unknown) => unknown): void {
    if (event === "response") this.handlers.push(handler);
  }

  off(event: string, handler: (response: unknown) => unknown): void {
    if (event === "response") this.handlers = this.handlers.filter((entry) => entry !== handler);
  }

  context(): { cookies(): Promise<Array<{ name: string; value: string }>> } {
    return { cookies: async () => this.script.cookies };
  }

  /**
   * Two call shapes exist in the reader: the Voyager fetch (an argument with a
   * csrf token) and the member-id regex over the document (no argument).
   */
  async evaluate(_fn: unknown, arg?: unknown): Promise<unknown> {
    if (arg && typeof arg === "object" && "csrf" in (arg as Record<string, unknown>)) {
      const requested = String((arg as { url: string }).url);
      const answer = this.script.voyager ?? { status: 404 };
      return { status: answer.status, url: answer.url ?? requested, body: answer.body ?? "" };
    }
    return this.current.memberId ?? null;
  }

  locator(selector: string): FakeLocator {
    if (selector === "body") return new FakeLocator([{ text: this.current.body ?? "" }]);
    if (selector === "main section") {
      const { name, headline, location } = this.current;
      if (!name && !headline && !location) return new FakeLocator([]);
      const children: Record<string, FakeNode[]> = {};
      if (name) children["h1"] = [{ text: name }];
      if (headline) children["div.text-body-medium"] = [{ text: headline }];
      if (location) children['span.text-body-small:not(:has(a))'] = [{ text: location }];
      return new FakeLocator([{
        text: [name, headline, location].filter(Boolean).join("\n"),
        children,
      }]);
    }
    if (selector === "main ul > li") {
      return new FakeLocator((this.current.experience ?? []).map((item) => ({
        text: item.lines.join("\n"),
        children: {
          'span[aria-hidden="true"]': item.lines.map((line) => ({ text: line })),
          'a[href*="/company/"]': item.companyHref ? [{ text: "", attrs: { href: item.companyHref } }] : [],
        },
      })));
    }
    return new FakeLocator([]);
  }

  async close(): Promise<void> {}
}

// ─── scripts ──────────────────────────────────────────────────────────────────

const PROFILE_BODY = [
  "Ana Pérez",
  "Gerente de Operaciones en Vitrina",
  "Santiago, Chile · Información de contacto",
  "1.204 seguidores · 500+ contactos",
  "Actividad reciente: compartió una publicación sobre logística",
  "Activity: 12 posts this year",
].join("\n");

function profilePage(extra: Partial<FakePageSpec> = {}): FakePageSpec {
  return {
    status: 200,
    name: "Ana Pérez",
    headline: "Gerente de Operaciones en Vitrina",
    location: "Santiago, Chile",
    body: PROFILE_BODY,
    memberId: "ACoAAB1234567",
    ...extra,
  };
}

const EXPERIENCE_URL = /\/details\/experience/;
const SALES_URL = /\/sales\/lead\//;
const IN_URL = /linkedin\.com\/in\//;

const SEATED_COOKIES = [
  { name: "JSESSIONID", value: '"ajax:1234567890"' },
  { name: "li_ep_auth_context", value: "seat" },
];

/** Profile loads, Voyager and the experience page yield nothing → Sales Nav runs. */
function chainTo(salesPage: FakePageSpec, voyager: VoyagerAnswer = { status: 404 }): Script {
  return {
    cookies: SEATED_COOKIES,
    voyager,
    pages: [
      { match: EXPERIENCE_URL, page: { status: 200, body: "Experiencia", experience: [] } },
      { match: SALES_URL, page: salesPage },
      { match: IN_URL, page: profilePage() },
    ],
  };
}

function runOn(page: FakePage) {
  return reads.processProfileReads(
    db,
    (_accountId, url, navigate) => reader.readProfileFromPage(page as unknown as Page, url, navigate),
  );
}

function jobRow() {
  return db.prepare(
    "SELECT state, error_code, navigations FROM radar_profile_reads",
  ).get() as { state: string; error_code: string | null; navigations: number };
}

function pauseRow() {
  return db.prepare(
    "SELECT paused_reason FROM radar_runtime_config WHERE id = 1",
  ).get() as { paused_reason: string | null };
}

function setRuntimeReads(dailyLimit: number) {
  db.prepare(`
    UPDATE radar_runtime_config
       SET reads_enabled = 1, daily_profile_read_limit = ?, min_read_gap_minutes = 3,
           paused_reason = NULL, paused_at = NULL
     WHERE id = 1
  `).run(dailyLimit);
  db.prepare(`
    UPDATE accounts
       SET is_authenticated = 1, active_hours_start = 0, active_hours_end = 24,
           timezone = 'UTC', working_days = '1,2,3,4,5,6,7'
     WHERE id = 'founder-1'
  `).run();
}

before(async () => {
  db = (await import("../lib/db")).getDb();
  reader = await import("../lib/linkedin/profile-read");
  reads = await import("../lib/radar/profile-reads");
  const { provisionRadarCampaign } = await import("../lib/radar/provisioning");

  db.prepare(`
    INSERT INTO accounts (id, name, email, is_authenticated)
    VALUES ('founder-1', 'Founder One', 'founder@example.com', 1)
  `).run();
  provisionRadarCampaign({
    schemaVersion: 1,
    outboundEnabled: false,
    listId: "radar_vitrina_active_campaign",
    workflowId: "radar_vitrina_active_campaign_workflow",
    campaignName: "Radar · Vitrina active",
    messageTemplate: "Hola, {{icebreaker_context}}",
    messageDelaySeconds: 3_600,
    accountPolicy: {
      dailyConnectionLimit: 1,
      dailyMessageLimit: 1,
      dailyInmailLimit: 0,
      activeHoursStart: 9,
      activeHoursEnd: 18,
      timezone: "America/Santiago",
      workingDays: [1, 2, 3, 4, 5],
    },
    readPolicy: { enabled: false, dailyProfileReadLimit: 0, minGapMinutes: 3 },
  });
});

beforeEach(() => {
  db.prepare("DELETE FROM radar_profile_reads").run();
  db.prepare("DELETE FROM radar_callback_outbox").run();
  setRuntimeReads(20);
});

// ─── the matcher ──────────────────────────────────────────────────────────────

test("the restriction matcher reads LinkedIn's real copy, whatever its case or accents", () => {
  const throttles = [
    "Commercial use limit",
    "Has alcanzado el LÍMITE DE USO COMERCIAL de LinkedIn",
    "We noticed some suspicious activity on your account",
    "Detectamos actividad sospechosa en tu cuenta",
    "We’ve restricted your account",
    "Hemos restringido tu cuenta temporalmente",
    "Too many requests",
    "Demasiadas solicitudes",
    "Unusual activity detected",
    "Actividad inusual detectada",
  ];
  for (const body of throttles) {
    assert.equal(
      reader.classifyPage({ url: PROFILE_URL, status: 200, body }),
      "rate_limited",
      `must be a throttle: ${body}`,
    );
  }

  const challenges = [
    "Let's do a quick security check",
    "Please verify your identity to continue",
    "Verifica tu identidad para continuar",
    "Security verification",
    "VERIFICACIÓN DE SEGURIDAD",
  ];
  for (const body of challenges) {
    assert.equal(
      reader.classifyPage({ url: PROFILE_URL, status: 200, body }),
      "challenge",
      `must be a challenge: ${body}`,
    );
  }

  // Informational quota copy: real, logged, and NOT a reason to park anything.
  assert.equal(
    reader.classifyPage({
      url: PROFILE_URL,
      status: 200,
      body: "You've reached the weekly invitation limit",
    }),
    "limit_notice",
  );
  assert.equal(
    reader.classifyPage({
      url: PROFILE_URL,
      status: 200,
      body: "Has alcanzado el límite semanal de invitaciones",
    }),
    "limit_notice",
  );

  // Checkpoint URLs, whatever the body says.
  for (const url of [
    "https://www.linkedin.com/checkpoint/challenge/AgHx",
    "https://www.linkedin.com/checkpoint/lg/login-submit",
  ]) {
    assert.equal(reader.classifyPage({ url, status: 200, body: PROFILE_BODY }), "challenge");
  }

  // Statuses, uniformly.
  assert.equal(reader.classifyPage({ url: PROFILE_URL, status: 429 }), "rate_limited");
  assert.equal(reader.classifyPage({ url: PROFILE_URL, status: 999 }), "rate_limited");
  assert.equal(reader.classifyPage({ url: PROFILE_URL, status: 403 }), "rate_limited");
  assert.equal(reader.classifyPage({ url: PROFILE_URL, status: 401 }), "challenge");
  assert.equal(reader.classifyPage({ url: PROFILE_URL, status: 404 }), "not_found");

  // And the false positive that matters: a profile that simply talks about activity.
  assert.equal(reader.classifyPage({ url: PROFILE_URL, status: 200, body: PROFILE_BODY }), "ok");
  assert.equal(
    reader.classifyPage({
      url: PROFILE_URL,
      status: 200,
      body: "Activity · Ana shared a post about restricted airspace and her weekly routine",
    }),
    "ok",
  );
});

// ─── uniform detection, end to end ────────────────────────────────────────────

test("a Voyager throttle is a throttle, not «try the next endpoint»", async () => {
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  const page = new FakePage({
    cookies: SEATED_COOKIES,
    voyager: { status: 429, body: '{"status":429,"message":"Too many requests"}' },
    pages: [{ match: IN_URL, page: profilePage() }],
  });

  assert.equal(await runOn(page), "failed");
  assert.deepEqual(jobRow(), { state: "failed", error_code: "rate_limited", navigations: 1 });
  assert.equal(pauseRow().paused_reason, "rate_limited");
  // It stopped at the profile page: no experience page, no Sales Navigator.
  assert.equal(page.navigations.length, 1);
  assert.deepEqual(
    db.prepare("SELECT reads_enabled, outbound_enabled FROM radar_runtime_config WHERE id = 1").get(),
    { reads_enabled: 0, outbound_enabled: 0 },
  );
});

test("a Voyager fetch bounced to the login page is a challenge, not an empty answer", async () => {
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  const page = new FakePage({
    cookies: SEATED_COOKIES,
    // fetch follows the redirect, so the answer carries the login URL.
    voyager: { status: 200, url: "https://www.linkedin.com/uas/login?session_redirect=%2Fvoyager", body: "" },
    pages: [{ match: IN_URL, page: profilePage() }],
  });

  assert.equal(await runOn(page), "failed");
  assert.deepEqual(jobRow(), { state: "failed", error_code: "challenge", navigations: 1 });
  assert.equal(pauseRow().paused_reason, "challenge");
});

test("a checkpoint on the Sales Navigator page fails closed instead of passing for «no seat»", async () => {
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  const page = new FakePage(chainTo({
    status: 200,
    url: "https://www.linkedin.com/checkpoint/challenge/AgHxyz",
    body: "Let's do a quick security check",
  }));

  assert.equal(await runOn(page), "failed");
  assert.deepEqual(jobRow(), { state: "failed", error_code: "challenge", navigations: 3 });
  assert.equal(pauseRow().paused_reason, "challenge");
  // A challenge also means the session itself is unusable.
  assert.deepEqual(
    db.prepare("SELECT is_authenticated FROM accounts WHERE id = 'founder-1'").get(),
    { is_authenticated: 0 },
  );
});

test("a Sales Navigator page that simply is not there stays a partial read", async () => {
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  const page = new FakePage(chainTo({ status: 404, body: "This page doesn't exist" }));

  assert.equal(await runOn(page), "done");
  assert.deepEqual(jobRow(), { state: "done", error_code: null, navigations: 3 });
  assert.equal(pauseRow().paused_reason, null, "a missing lead page is not an incident");
  assert.deepEqual(
    db.prepare("SELECT reads_enabled, outbound_enabled FROM radar_runtime_config WHERE id = 1").get(),
    { reads_enabled: 1, outbound_enabled: 0 },
  );
  const payload = JSON.parse(
    (db.prepare("SELECT payload_json FROM radar_callback_outbox").get() as { payload_json: string }).payload_json,
  );
  assert.equal(payload.eventType, "profile.read");
  assert.equal(payload.data.profile.partial, true);
  assert.deepEqual(payload.data.profile.positions, []);
  assert.equal(payload.data.profile.headline, "Gerente de Operaciones en Vitrina");
});

test("an invitation-limit notice is logged, not an incident", async () => {
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  const page = new FakePage({
    cookies: SEATED_COOKIES,
    voyager: {
      status: 200,
      body: JSON.stringify({
        elements: [{
          $type: "com.linkedin.voyager.identity.profile.Position",
          title: "Gerente de Operaciones",
          companyName: "Vitrina",
          timePeriod: { startDate: { year: 2021, month: 3 } },
        }],
      }),
    },
    pages: [{
      match: IN_URL,
      page: profilePage({ body: `${PROFILE_BODY}\nYou've reached the weekly invitation limit` }),
    }],
  });

  assert.equal(await runOn(page), "done");
  assert.deepEqual(jobRow(), { state: "done", error_code: null, navigations: 1 });
  assert.equal(pauseRow().paused_reason, null);
});

// ─── the cap counts navigations ───────────────────────────────────────────────

test("a read that needs all three navigations spends three units of the cap", async () => {
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  const page = new FakePage(chainTo({
    status: 200,
    body: "Ana Pérez · Vitrina",
    salesResponses: [{
      entityUrn: "urn:li:fs_salesProfile:(ACoAAB1234567,NAME_SEARCH)",
      positions: [{
        title: "Gerente de Operaciones",
        companyName: "Vitrina",
        current: true,
        startedOn: { year: 2021, month: 3 },
      }],
    }],
  }));

  assert.equal(await runOn(page), "done");
  assert.equal(page.navigations.length, 3);
  assert.deepEqual(jobRow(), { state: "done", error_code: null, navigations: 3 });

  const { getRadarRuntimeStatus } = await import("../lib/radar/runtime");
  assert.equal(getRadarRuntimeStatus().reads.usedToday, 3, "the status reports navigations");

  const payload = JSON.parse(
    (db.prepare("SELECT payload_json FROM radar_callback_outbox").get() as { payload_json: string }).payload_json,
  );
  assert.equal(payload.data.profile.partial, false);
  assert.deepEqual(payload.data.profile.positions, [{
    title: "Gerente de Operaciones",
    company: "Vitrina",
    company_url: null,
    start: "2021-03",
    end: null,
    current: true,
  }]);
});

test("a cap of two stops the chain before the third navigation and delivers a partial read", async () => {
  setRuntimeReads(2);
  reads.requestProfileRead({ linkedinUrl: PROFILE_URL, radar_persona_id: PERSONA });
  const page = new FakePage(chainTo({
    status: 200,
    body: "Ana Pérez · Vitrina",
    salesResponses: [{
      entityUrn: "urn:li:fs_salesProfile:(ACoAAB1234567,NAME_SEARCH)",
      positions: [{ title: "Gerente de Operaciones", companyName: "Vitrina", current: true }],
    }],
  }));

  assert.equal(await runOn(page), "done");
  assert.equal(page.navigations.length, 2, "the Sales Navigator page must never be opened");
  assert.ok(!page.navigations.some((url) => SALES_URL.test(url)));
  assert.deepEqual(jobRow(), { state: "done", error_code: null, navigations: 2 });

  const payload = JSON.parse(
    (db.prepare("SELECT payload_json FROM radar_callback_outbox").get() as { payload_json: string }).payload_json,
  );
  assert.equal(payload.data.profile.partial, true, "what was obtained is delivered, and said to be partial");
  assert.deepEqual(payload.data.profile.positions, []);
  assert.equal(payload.data.profile.headline, "Gerente de Operaciones en Vitrina");
  assert.equal(pauseRow().paused_reason, null, "running out of budget is not an incident");
});
