/**
 * Minimal, read-only profile reader for Radar profile reads.
 *
 * Scope is deliberately tiny: headline, location and the position list. It is
 * NOT lib/linkedin/profile-scrape.ts — that one needs a Sales Navigator lead
 * URL (`scrapeProfile` throws without `sales_nav_url`) and returns summary,
 * skills, languages, educations and posts, none of which may leave this
 * runtime. Nothing read here is stored locally; the caller ships an allowlisted
 * payload through the Radar callback outbox and keeps only the job row.
 *
 * Sales Navigator is NOT assumed. The account may not have a seat, so the
 * primary path is the plain `/in/` profile:
 *
 *   1. `/in/<slug>/` top card → headline + location (structural locators, with
 *      a line-based fallback; never a hashed class name).
 *   2. Voyager, called from inside the page with the session's own JSESSIONID
 *      csrf token — the same technique `scrapePosts` uses. Two candidate
 *      endpoints are tried, because LinkedIn rotates them; a 404 or a shape we
 *      cannot parse is free, a THROTTLE is not (see below).
 *   3. DOM fallback on `/in/<slug>/details/experience/`, walked structurally
 *      (main → ul → li → the aria-hidden text spans), never by class name.
 *   4. Only if the session actually carries a Sales Navigator seat cookie AND
 *      the steps above produced no position at all, one opportunistic Sales Nav
 *      profile load, intercepting `salesApiProfiles` exactly like
 *      profile-scrape.ts does.
 *
 * DETECTION IS UNIFORM. Every LinkedIn answer this file looks at — a
 * navigation, the in-page Voyager fetch, the Sales Navigator load — goes
 * through the same `classifyPage()`. A checkpoint, a login redirect, an HTTP
 * 401/403/429/999 or restriction copy is an incident wherever it appears, and
 * it fails closed. "Try the next URL" and "the account has no seat" are only
 * allowed to explain an answer that carries NO such signal: a 404, an unparsable
 * shape, a normal page. The earlier version swallowed a throttle on the Voyager
 * path and a checkpoint on the Sales Navigator path as if they were shape
 * problems, which is how a restricted account keeps browsing.
 *
 * THE CAP COUNTS NAVIGATIONS. Each `page.goto` asks the caller's `navigate()`
 * gate first; the gate both spends one unit of the runtime's daily budget and
 * refuses when there is none left. A refusal mid-chain stops the chain and the
 * read delivers whatever it already has, `partial: true` — it never exceeds the
 * budget to finish a fallback.
 *
 * When no position can be obtained the result is `positions: []` with
 * `partial: true` — nothing is ever inferred or filled in. When the page loads
 * but yields nothing at all (no headline, no location, no position) the read
 * fails with `partial`, so Radar hears about it instead of storing an empty
 * observation.
 */
import type { Locator, Page } from "playwright";
import { getSessionPage } from "@/lib/linkedin/session";
import type { ProfileReadErrorCode, ProfileReadPosition, ProfileReadResult } from "@/lib/radar/contracts";

export class ProfileReadError extends Error {
  constructor(public readonly code: ProfileReadErrorCode, message: string) {
    super(message);
    this.name = "ProfileReadError";
  }
}

/**
 * Spends one unit of the runtime's daily navigation budget and says whether it
 * was there to spend. `false` means "stop the chain": deliver what you have,
 * never open another page. A `true` answer has ALREADY consumed the unit, so
 * the count is right even if the navigation then fails.
 */
export type NavigationGate = () => boolean;

export type ProfileReader = (
  accountId: string,
  linkedinUrl: string,
  navigate: NavigationGate,
) => Promise<ProfileReadResult>;

const NAV_TIMEOUT_MS = 30_000;
const SALES_NAV_BUDGET_MS = 12_000;
/** Enough to cover an interstitial; a full profile's text is far longer. */
const MAX_MATCH_CHARS = 8_000;

// ─── detection ────────────────────────────────────────────────────────────────

/**
 * What LinkedIn just told us.
 *  - `challenge`     the session may no longer act (checkpoint, login, identity).
 *  - `rate_limited`  LinkedIn is throttling or restricting this account.
 *  - `limit_notice`  an informational quota message (weekly invitations). NOT an
 *                    incident: it does not pause anything, it is only logged.
 *  - `not_found`     this particular page is not there.
 */
export type PageSignal = "ok" | "challenge" | "rate_limited" | "limit_notice" | "not_found";

// A checkpoint, an auth wall or a bounce to the login page all mean the same
// thing: this session may no longer act. Matched on the URL, which LinkedIn
// does not localise. The two explicit checkpoint paths are the ones a live
// account actually lands on.
const CHALLENGE_URL =
  /\/checkpoint\/challenge|\/checkpoint\/lg\/login-submit|\/checkpoint\/|\/authwall|\/uas\/login|linkedin\.com\/login/i;

/**
 * Case- and accent-insensitive matching. LinkedIn serves the same interstitial
 * in the viewer's locale, with typographic apostrophes, so "Hemos restringido
 * tu cuenta", "HEMOS RESTRINGIDO TU CUENTA" and "we’ve restricted your account"
 * all have to hit. Patterns below are therefore written unaccented and lowercase.
 */
export function normalizeForMatch(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function anyOf(patterns: string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

/** "You have to prove who you are" — the session is unusable until a human acts. */
const CHALLENGE_TEXT = anyOf([
  "verify your identity",
  "verifica tu identidad",
  "verificar tu identidad",
  "security verification",
  "verificacion de seguridad",
  "confirm your identity",
  "confirma tu identidad",
  "quick security check",
  "let's do a quick security check",
]);

/**
 * "You are doing too much" — LinkedIn is throttling or has restricted the
 * account. Every one of these pauses the runtime.
 */
const RESTRICTION_TEXT = anyOf([
  "too many requests",
  "demasiadas solicitudes",
  "unusual activity",
  "actividad inusual",
  "suspicious activity",
  "actividad sospechosa",
  "commercial use limit",
  "limite de uso comercial",
  "we ?'?ve restricted your account",
  "restricted your account",
  "hemos restringido tu cuenta",
  "tu cuenta ha sido restringida",
  "has sido restringid[oa]",
  "temporarily restricted",
  "restringid[oa] temporalmente",
  "intenta de nuevo mas tarde",
]);

/**
 * Informational quota copy. A weekly invitation limit says nothing about
 * reading a profile and must NOT pause the runtime — but it is a real signal
 * about the account's headroom, so it is logged every time it is seen.
 */
const LIMIT_NOTICE_TEXT = anyOf([
  "you ?'?ve reached the weekly invitation limit",
  "weekly invitation limit",
  "has alcanzado el limite semanal de invitaciones",
  "limite semanal de invitaciones",
]);

const NOT_FOUND_TEXT = anyOf([
  "page doesn ?'?t exist",
  "this page is not available",
  "profile is not available",
  "esta pagina no existe",
  "perfil no esta disponible",
]);

function signalFromStatus(status: number | null | undefined): PageSignal | null {
  if (status === null || status === undefined) return null;
  // 999 is LinkedIn's own "request denied"; 403 is what the Voyager endpoints
  // answer once the account is restricted. Both are throttles, never shapes.
  if (status === 429 || status === 999 || status === 403) return "rate_limited";
  if (status === 401) return "challenge";
  if (status === 404 || status === 410) return "not_found";
  return null;
}

export interface PageEvidence {
  url: string;
  status?: number | null;
  body?: string | null;
}

/** The single classifier every LinkedIn answer in this file goes through. */
export function classifyPage(evidence: PageEvidence): PageSignal {
  if (CHALLENGE_URL.test(evidence.url)) return "challenge";
  const byStatus = signalFromStatus(evidence.status);
  if (byStatus) return byStatus;
  const text = normalizeForMatch((evidence.body ?? "").slice(0, MAX_MATCH_CHARS));
  if (CHALLENGE_TEXT.test(text)) return "challenge";
  // Checked before the quota notice on purpose: an interstitial carrying both
  // is a restriction, and the fail-closed reading wins.
  if (RESTRICTION_TEXT.test(text)) return "rate_limited";
  if (LIMIT_NOTICE_TEXT.test(text)) return "limit_notice";
  if (NOT_FOUND_TEXT.test(text)) return "not_found";
  return "ok";
}

const SIGNAL_MESSAGE: Record<Exclude<PageSignal, "ok" | "limit_notice">, string> = {
  challenge: "LinkedIn asked for a checkpoint, a login or an identity verification",
  rate_limited: "LinkedIn answered with a throttle or an account restriction",
  not_found: "LinkedIn says that page does not exist",
};

function raise(signal: Exclude<PageSignal, "ok" | "limit_notice">, where: string): never {
  throw new ProfileReadError(signal, `${SIGNAL_MESSAGE[signal]} (${where})`);
}

function noteLimitNotice(where: string): void {
  console.warn(`[radar] LinkedIn showed an invitation-limit notice (${where}); logged, not a pause`);
}

async function signalOf(page: Page, status: number | null, sample?: string): Promise<PageSignal> {
  const body = sample ?? await page.locator("body").innerText().catch(() => "");
  return classifyPage({ url: page.url(), status, body });
}

/** Primary navigation: anything but a clean page stops the read. */
async function assertUsable(page: Page, status: number | null, where: string): Promise<void> {
  const signal = await signalOf(page, status);
  if (signal === "limit_notice") return noteLimitNotice(where);
  if (signal !== "ok") raise(signal, where);
}

/**
 * Fallback navigation (the experience page, the Sales Navigator lead page).
 * An incident is still an incident and fails the whole read — that is the fix:
 * a checkpoint on the Sales Nav page used to be swallowed as "no seat". What a
 * fallback IS allowed to do is give up quietly on a page that simply is not
 * there or is a quota notice, because the profile page already succeeded and
 * the read can honestly return `partial`.
 */
async function fallbackUsable(page: Page, status: number | null, where: string): Promise<boolean> {
  const signal = await signalOf(page, status);
  if (signal === "challenge" || signal === "rate_limited") raise(signal, where);
  if (signal === "limit_notice") noteLimitNotice(where);
  return signal === "ok";
}

// ─── parsing helpers ──────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7,
  aug: 8, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, dic: 12,
};
const PRESENT = /^(present|actualidad|actual|hoy|current)$/i;

function publicIdOf(linkedinUrl: string): string | null {
  const match = linkedinUrl.match(/\/in\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

/** "Mar 2021" / "2021" / "mar. 2021" → "2021-03" / "2021". */
function monthYear(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  const year = text.match(/(19|20)\d{2}/)?.[0];
  if (!year) return null;
  const monthWord = text.toLowerCase().replace(/[.,]/g, " ").split(/\s+/).find((w) => w in MONTHS);
  return monthWord ? `${year}-${String(MONTHS[monthWord]).padStart(2, "0")}` : year;
}

function isCurrentEnd(raw: string | null | undefined): boolean {
  return !!raw && PRESENT.test(raw.trim());
}

async function firstText(locator: Locator): Promise<string | null> {
  if ((await locator.count().catch(() => 0)) === 0) return null;
  const text = await locator.first().innerText().catch(() => "");
  const trimmed = text.split("\n")[0]?.trim() ?? "";
  return trimmed || null;
}

/**
 * Top card = the `main` section that owns the page's own <h1>. Same structural
 * identification visit.ts uses, and for the same reason: a page-wide search
 * also matches sidebar modules about OTHER people.
 */
async function readTopCard(page: Page): Promise<{ headline: string | null; location: string | null }> {
  const topCard = page.locator("main section").filter({ has: page.locator("h1") }).first();
  if ((await topCard.count().catch(() => 0)) === 0) return { headline: null, location: null };

  // `text-body-medium` / `text-body-small` are LinkedIn's stable semantic
  // utility classes, not the hashed per-build ones.
  let headline = await firstText(topCard.locator("div.text-body-medium"));
  let location = await firstText(topCard.locator("span.text-body-small:not(:has(a))"));

  if (!headline || !location) {
    const name = (await topCard.locator("h1").first().innerText().catch(() => ""))?.trim();
    const lines = (await topCard.innerText().catch(() => ""))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && line !== name && !/^(1st|2nd|3rd|1°|2°|3°)$/i.test(line));
    const social = /follower|connection|seguidor|contacto|contact info|informaci[oó]n de contacto|mutual/i;
    const meaningful = lines.filter((line) => !social.test(line));
    headline = headline ?? meaningful[0] ?? null;
    location = location ?? meaningful[1] ?? null;
  }
  return { headline, location };
}

interface VoyagerPosition {
  title?: unknown;
  companyName?: unknown;
  companyUrn?: unknown;
  company?: { miniCompany?: { universalName?: unknown } };
  timePeriod?: { startDate?: { year?: number; month?: number }; endDate?: { year?: number; month?: number } };
  dateRange?: { start?: { year?: number; month?: number }; end?: { year?: number; month?: number } };
}

function formatYearMonth(value: { year?: number; month?: number } | undefined | null): string | null {
  if (!value?.year) return null;
  return value.month ? `${value.year}-${String(value.month).padStart(2, "0")}` : String(value.year);
}

function positionsFromVoyager(raw: string): ProfileReadPosition[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const root = parsed as { elements?: unknown[]; included?: unknown[] };
  const candidates = [...(root.elements ?? []), ...(root.included ?? [])] as Array<Record<string, unknown>>;
  const positions: ProfileReadPosition[] = [];
  for (const candidate of candidates) {
    const type = String(candidate["$type"] ?? "");
    const looksLikePosition = /Position/i.test(type) || ("companyName" in candidate && "title" in candidate);
    if (!looksLikePosition) continue;
    const entry = candidate as VoyagerPosition;
    const title = typeof entry.title === "string" ? entry.title : null;
    const company = typeof entry.companyName === "string" ? entry.companyName : null;
    if (!title && !company) continue;
    const start = formatYearMonth(entry.timePeriod?.startDate ?? entry.dateRange?.start);
    const end = formatYearMonth(entry.timePeriod?.endDate ?? entry.dateRange?.end);
    const universalName = entry.company?.miniCompany?.universalName;
    positions.push({
      title,
      company,
      company_url: typeof universalName === "string" ? `https://www.linkedin.com/company/${universalName}` : null,
      start,
      end,
      current: !end,
    });
  }
  return positions;
}

interface InPageFetch {
  status: number;
  url: string;
  body: string;
}

/**
 * Voyager, fetched from inside the authenticated page with the session's own
 * csrf token. This costs no navigation, so it is not gated.
 *
 * The response goes through the SAME classifier as a navigation: a 403/429/999,
 * a 401, a redirect to the login page or restriction copy in the body is a
 * throttle or a checkpoint and stops the read. Only a shape problem — a 404, a
 * body we cannot parse — earns "try the next endpoint".
 */
async function positionsFromVoyagerApi(page: Page, publicId: string): Promise<ProfileReadPosition[]> {
  let cookies: Array<{ name: string; value: string }>;
  try {
    cookies = await page.context().cookies();
  } catch {
    return [];
  }
  const csrf = (cookies.find((c) => c.name === "JSESSIONID")?.value || "").replace(/"/g, "");
  if (!csrf) return [];

  const urls = [
    `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(publicId)}/positions`,
    `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}`,
  ];
  for (const url of urls) {
    let answer: InPageFetch | null;
    try {
      answer = await page.evaluate(
        async ({ url, csrf }: { url: string; csrf: string }) => {
          try {
            const response = await fetch(url, {
              headers: {
                accept: "application/vnd.linkedin.normalized+json+2.1",
                "csrf-token": csrf,
                "x-restli-protocol-version": "2.0.0",
              },
              credentials: "include",
            });
            const body = await response.text().catch(() => "");
            return { status: response.status, url: response.url || url, body: body.slice(0, 20_000) };
          } catch {
            // A transport failure inside the page says nothing about LinkedIn's
            // opinion of us: status 0 is classified as a shape problem below.
            return { status: 0, url, body: "" };
          }
        },
        { url, csrf },
      ) as InPageFetch | null;
    } catch {
      // page.evaluate itself failed (navigation, closed context) — not a signal.
      return [];
    }
    if (!answer) continue;

    const signal = classifyPage({ url: answer.url, status: answer.status || null, body: answer.body });
    if (signal === "challenge" || signal === "rate_limited") raise(signal, "voyager");
    if (signal === "limit_notice") noteLimitNotice("voyager");
    if (answer.status !== 200) continue;

    const positions = positionsFromVoyager(answer.body);
    if (positions.length > 0) return positions;
  }
  return [];
}

/**
 * DOM fallback on the experience details page. Structural only: the list items
 * under `main`, and inside each the `span[aria-hidden="true"]` texts LinkedIn
 * renders for sighted users (the sibling visually-hidden spans repeat them, so
 * consecutive duplicates are collapsed). No class name is matched.
 *
 * Line order on that page has been stable for years: title, company (sometimes
 * "Company · Full-time"), the date range, then the location. Anything that does
 * not match stays null rather than being guessed.
 */
async function positionsFromExperienceDom(
  page: Page,
  publicId: string,
  navigate: NavigationGate,
): Promise<ProfileReadPosition[]> {
  if (!navigate()) return [];
  const navigated = await page.goto(
    `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/details/experience/`,
    { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS },
  ).then((response) => ({ response }), () => null);
  // A failed navigation leaves the browser on the profile page, whose own lists
  // would otherwise be scraped as if they were positions. Give up instead.
  if (!navigated) return [];
  await page.waitForTimeout(2_000 + Math.random() * 1_500);
  if (!await fallbackUsable(page, navigated.response?.status() ?? null, "details/experience")) return [];
  if (!/\/details\/experience/.test(page.url())) return [];

  const items = page.locator("main ul > li");
  const count = Math.min(await items.count().catch(() => 0), 15);
  const positions: ProfileReadPosition[] = [];
  for (let index = 0; index < count; index++) {
    const item = items.nth(index);
    const spans = await item.locator('span[aria-hidden="true"]').allInnerTexts().catch(() => [] as string[]);
    const lines: string[] = [];
    for (const span of spans) {
      const text = span.trim();
      if (!text || text === lines[lines.length - 1]) continue;
      lines.push(text);
    }
    if (lines.length === 0) continue;

    const dateLine = lines.find((line) => /(19|20)\d{2}/.test(line) && /[-–—]/.test(line));
    if (!dateLine) continue;
    const [rawStart, rawEnd] = dateLine.split("·")[0].split(/[-–—]/).map((part) => part.trim());
    const companyLine = lines[1]?.split("·")[0]?.trim() ?? null;
    const companyHref = await item.locator('a[href*="/company/"]').first().getAttribute("href").catch(() => null);
    const companySlug = companyHref?.match(/\/company\/([^/?#]+)/)?.[1] ?? null;

    positions.push({
      title: lines[0] ?? null,
      company: companyLine || null,
      company_url: companySlug ? `https://www.linkedin.com/company/${companySlug}` : null,
      start: monthYear(rawStart),
      end: isCurrentEnd(rawEnd) ? null : monthYear(rawEnd),
      current: isCurrentEnd(rawEnd),
    });
  }
  return positions;
}

interface SalesFlatProfile {
  entityUrn?: string;
  firstName?: string;
  positions?: Array<{
    title?: string; companyName?: string; current?: boolean;
    startedOn?: { year?: number; month?: number };
    endedOn?: { year?: number; month?: number };
  }>;
}

/**
 * Opportunistic only. `li_ep_auth_context` is the Sales Navigator seat cookie
 * (see lib/linkedin/session.ts) — without it the account has no seat and this
 * is skipped entirely. Nothing is configured and no seat is ever requested.
 *
 * "No seat" and "the lead URL shape changed" remain silent fallthroughs, but
 * ONLY when the page that came back carries no incident signal. A checkpoint or
 * a restriction here is the same incident as anywhere else and fails closed.
 */
async function positionsFromSalesNav(
  page: Page,
  memberId: string,
  navigate: NavigationGate,
): Promise<ProfileReadPosition[]> {
  if (!navigate()) return [];
  const responses: SalesFlatProfile[] = [];
  const collect = async (resp: { url(): string; status(): number; json(): Promise<unknown> }) => {
    if (!resp.url().includes("salesApiProfiles") || resp.status() !== 200) return;
    try {
      const body = await resp.json() as Record<string, unknown>;
      if ("entityUrn" in body) responses.push(body as SalesFlatProfile);
    } catch { /* ignore */ }
  };
  page.on("response", collect);
  let status: number | null = null;
  try {
    const response = await page.goto(`https://www.linkedin.com/sales/lead/${encodeURIComponent(memberId)},NAME_SEARCH`, {
      waitUntil: "domcontentloaded",
      timeout: SALES_NAV_BUDGET_MS,
    }).catch(() => null);
    status = response?.status() ?? null;
    await page.waitForTimeout(SALES_NAV_BUDGET_MS / 2).catch(() => {});
  } finally {
    page.off("response", collect);
  }

  // Classified like any other navigation. Throws on a checkpoint or a throttle.
  if (!await fallbackUsable(page, status, "sales navigator")) return [];

  const core = responses.find((entry) => entry.positions?.length);
  return (core?.positions ?? []).map((position) => ({
    title: position.title ?? null,
    company: position.companyName ?? null,
    company_url: null,
    start: formatYearMonth(position.startedOn),
    end: position.current ? null : formatYearMonth(position.endedOn),
    current: position.current === true,
  }));
}

/**
 * The reader proper, on a page the caller owns. Exported so the fallback chain
 * can be driven with scripted LinkedIn answers in tests; production goes through
 * `readProfileMinimal`, which takes the page from the shared session queue.
 */
export async function readProfileFromPage(
  page: Page,
  linkedinUrl: string,
  navigate: NavigationGate,
): Promise<ProfileReadResult> {
  const publicId = publicIdOf(linkedinUrl);
  if (!publicId) throw new ProfileReadError("not_found", "URL is not a LinkedIn /in/ profile");

  try {
    if (!navigate()) {
      // Unreachable through processProfileReads, which checks the budget before
      // claiming a job; kept explicit so a future caller cannot overspend.
      throw new ProfileReadError("partial", "The daily navigation budget was spent before the profile could be opened");
    }
    const response = await page.goto(`https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    }).catch((error: unknown) => {
      throw new ProfileReadError("network", error instanceof Error ? error.message : "navigation failed");
    });
    await page.waitForTimeout(3_000 + Math.random() * 2_000);
    await assertUsable(page, response?.status() ?? null, "profile");

    const { headline, location } = await readTopCard(page);
    const memberId = await page.evaluate(
      () => (document.body.innerHTML.match(/urn:li:fsd_profile:(AC[\w-]+)/) ?? [])[1] ?? null,
    ).catch(() => null);

    let positions = await positionsFromVoyagerApi(page, publicId);
    if (positions.length === 0) {
      positions = await positionsFromExperienceDom(page, publicId, navigate);
    }
    if (positions.length === 0 && memberId) {
      const cookies = await page.context().cookies().catch(() => []);
      const hasSalesSeat = cookies.some((cookie) => cookie.name === "li_ep_auth_context");
      if (hasSalesSeat) positions = await positionsFromSalesNav(page, memberId, navigate);
    }

    if (!headline && !location && positions.length === 0) {
      throw new ProfileReadError("partial", "The profile page yielded no readable field");
    }
    return { headline, location, positions, partial: positions.length === 0 };
  } catch (error) {
    if (error instanceof ProfileReadError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProfileReadError(/timeout|net::|ECONN|socket/i.test(message) ? "network" : "partial", message);
  }
}

export const readProfileMinimal: ProfileReader = async (accountId, linkedinUrl, navigate) => {
  const page = await getSessionPage(accountId);
  try {
    return await readProfileFromPage(page, linkedinUrl, navigate);
  } finally {
    await page.close().catch(() => {});
  }
};
