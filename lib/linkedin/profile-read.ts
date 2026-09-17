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
 *      endpoints are tried and parsed defensively: LinkedIn rotates these and a
 *      failure here is free, because of (3).
 *   3. DOM fallback on `/in/<slug>/details/experience/`, walked structurally
 *      (main → ul → li → the aria-hidden text spans), never by class name.
 *   4. Only if the session actually carries a Sales Navigator seat cookie AND
 *      the steps above produced no position at all, one opportunistic Sales Nav
 *      profile load, intercepting `salesApiProfiles` exactly like
 *      profile-scrape.ts does. Best effort: any failure is swallowed.
 *
 * When no position can be obtained the result is `positions: []` with
 * `partial: true` — nothing is ever inferred or filled in. When the page loads
 * but yields nothing at all (no headline, no location, no position) the read
 * fails with `partial`, so Radar hears about it instead of storing an empty
 * observation.
 *
 * Fail closed: a challenge, checkpoint, login redirect, HTTP 429/999 or an
 * account-restriction page raises ProfileReadError with `challenge` or
 * `rate_limited`, and the caller pauses BOTH reads and outbound sending.
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

export type ProfileReader = (accountId: string, linkedinUrl: string) => Promise<ProfileReadResult>;

const NAV_TIMEOUT_MS = 30_000;
const SALES_NAV_BUDGET_MS = 12_000;

// A checkpoint, an auth wall or a bounce to the login page all mean the same
// thing: this session may no longer act. Matched on the URL, which LinkedIn
// does not localise.
const CHALLENGE_URL = /\/checkpoint\/|\/authwall|\/uas\/login|linkedin\.com\/login/i;
// LinkedIn's throttling copy, EN + ES. Deliberately narrow: these phrases only
// appear on an interstitial, never inside a normal profile.
const RESTRICTION_TEXT = /too many requests|unusual activity|temporarily restricted|restricted your account|we.{0,3}ve restricted|has sido restringid|actividad inusual|demasiadas solicitudes|intenta de nuevo m[aá]s tarde/i;
const NOT_FOUND_TEXT = /page doesn.{0,3}t exist|this page is not available|profile is not available|esta p[aá]gina no existe|perfil no est[aá] disponible/i;

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

async function assertUsable(page: Page, status: number | null): Promise<void> {
  if (status === 429 || status === 999) {
    throw new ProfileReadError("rate_limited", `LinkedIn answered HTTP ${status}`);
  }
  if (status === 404 || status === 410) {
    throw new ProfileReadError("not_found", `LinkedIn answered HTTP ${status}`);
  }
  if (CHALLENGE_URL.test(page.url())) {
    throw new ProfileReadError("challenge", "LinkedIn redirected to a checkpoint, auth wall or login page");
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const head = bodyText.slice(0, 4_000);
  if (RESTRICTION_TEXT.test(head)) {
    throw new ProfileReadError("rate_limited", "LinkedIn showed a restriction or rate-limit interstitial");
  }
  if (NOT_FOUND_TEXT.test(head)) {
    throw new ProfileReadError("not_found", "LinkedIn showed a profile-unavailable page");
  }
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

/**
 * Voyager, fetched from inside the authenticated page with the session's own
 * csrf token. Endpoints rotate, so two candidates are tried and anything that
 * is not a 200 is simply skipped — the DOM fallback is the guarantee.
 */
async function positionsFromVoyagerApi(page: Page, publicId: string): Promise<ProfileReadPosition[]> {
  try {
    const cookies = await page.context().cookies();
    const csrf = (cookies.find((c) => c.name === "JSESSIONID")?.value || "").replace(/"/g, "");
    if (!csrf) return [];
    const urls = [
      `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(publicId)}/positions`,
      `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}`,
    ];
    for (const url of urls) {
      const raw = await page.evaluate(
        async ({ url, csrf }: { url: string; csrf: string }) => {
          const response = await fetch(url, {
            headers: {
              accept: "application/vnd.linkedin.normalized+json+2.1",
              "csrf-token": csrf,
              "x-restli-protocol-version": "2.0.0",
            },
            credentials: "include",
          });
          return response.status === 200 ? response.text() : "";
        },
        { url, csrf },
      );
      if (!raw) continue;
      const positions = positionsFromVoyager(raw);
      if (positions.length > 0) return positions;
    }
  } catch { /* fall through to the DOM */ }
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
async function positionsFromExperienceDom(page: Page, publicId: string): Promise<ProfileReadPosition[]> {
  const navigated = await page.goto(
    `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/details/experience/`,
    { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS },
  ).then((response) => ({ response }), () => null);
  // A failed navigation leaves the browser on the profile page, whose own lists
  // would otherwise be scraped as if they were positions. Give up instead.
  if (!navigated) return [];
  await page.waitForTimeout(2_000 + Math.random() * 1_500);
  await assertUsable(page, navigated.response?.status() ?? null);
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
 */
async function positionsFromSalesNav(page: Page, memberId: string): Promise<ProfileReadPosition[]> {
  const responses: SalesFlatProfile[] = [];
  const collect = async (resp: { url(): string; status(): number; json(): Promise<unknown> }) => {
    if (!resp.url().includes("salesApiProfiles") || resp.status() !== 200) return;
    try {
      const body = await resp.json() as Record<string, unknown>;
      if ("entityUrn" in body) responses.push(body as SalesFlatProfile);
    } catch { /* ignore */ }
  };
  page.on("response", collect);
  try {
    await page.goto(`https://www.linkedin.com/sales/lead/${encodeURIComponent(memberId)},NAME_SEARCH`, {
      waitUntil: "domcontentloaded",
      timeout: SALES_NAV_BUDGET_MS,
    });
    await page.waitForTimeout(SALES_NAV_BUDGET_MS / 2);
  } catch {
    // No seat, a changed URL shape or a slow load — the read keeps whatever it
    // already has and stays `partial`.
  } finally {
    page.off("response", collect);
  }
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

export async function readProfileMinimal(accountId: string, linkedinUrl: string): Promise<ProfileReadResult> {
  const publicId = publicIdOf(linkedinUrl);
  if (!publicId) throw new ProfileReadError("not_found", "URL is not a LinkedIn /in/ profile");

  const page = await getSessionPage(accountId);
  try {
    const response = await page.goto(`https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    }).catch((error: unknown) => {
      throw new ProfileReadError("network", error instanceof Error ? error.message : "navigation failed");
    });
    await page.waitForTimeout(3_000 + Math.random() * 2_000);
    await assertUsable(page, response?.status() ?? null);

    const { headline, location } = await readTopCard(page);
    const memberId = await page.evaluate(
      () => (document.body.innerHTML.match(/urn:li:fsd_profile:(AC[\w-]+)/) ?? [])[1] ?? null,
    ).catch(() => null);

    let positions = await positionsFromVoyagerApi(page, publicId);
    if (positions.length === 0) {
      positions = await positionsFromExperienceDom(page, publicId);
    }
    if (positions.length === 0 && memberId) {
      const cookies = await page.context().cookies().catch(() => []);
      const hasSalesSeat = cookies.some((cookie) => cookie.name === "li_ep_auth_context");
      if (hasSalesSeat) positions = await positionsFromSalesNav(page, memberId);
    }

    if (!headline && !location && positions.length === 0) {
      throw new ProfileReadError("partial", "The profile page yielded no readable field");
    }
    return { headline, location, positions, partial: positions.length === 0 };
  } catch (error) {
    if (error instanceof ProfileReadError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProfileReadError(/timeout|net::|ECONN|socket/i.test(message) ? "network" : "partial", message);
  } finally {
    await page.close().catch(() => {});
  }
}
