/**
 * The profile top card against real HTML, in a real browser.
 *
 * LinkedIn serves two profile layouts side by side: the legacy one (name in
 * the page's only <h1>) and the SDUI one seen on 2026-10-15 (name in an <h2>,
 * an outer "Primary content" section that also wraps Highlights, the sidebar
 * inside `main`). Everything that decides "already connected", "which
 * messaging URN" or "which Connect link" must read the visited person's own
 * card in BOTH, and never a Message / Connect link that belongs to someone
 * else on the same page (Jul 2026 incident).
 *
 * Fixtures live in test/fixtures/linkedin/. Nothing here touches the network:
 * every linkedin.com request is answered from a fixture by `page.route`.
 *
 * Needs a Chromium. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH when Playwright's
 * own download is not installed (the runtime image sets it to
 * /usr/bin/chromium); without any browser the suite is skipped, loudly.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { AlreadyConnectedError, sendConnectionRequest } from "../lib/linkedin/connect";
import { topCardLines } from "../lib/linkedin/profile-read";
import { locateTopCard, profileNameFromTitle } from "../lib/linkedin/top-card";
import { visitProfile } from "../lib/linkedin/visit";

const FIXTURES = path.join(__dirname, "fixtures", "linkedin");
const PROFILE_URL = "https://www.linkedin.com/in/ana-perez/";
const ANA_URN = "urn:li:fsd_profile:ACoAAAnaPerez01";

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

let browser: Browser | null = null;
let launchError: string | null = null;

before(async () => {
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  } catch (error) {
    launchError = String(error).split("\n")[0];
    console.warn(`[linkedin-top-card] no Chromium available, skipping: ${launchError}`);
  }
});

after(async () => { await browser?.close(); });

interface Served { page: Page; navigations: string[] }

/** A page where the profile URL answers `html` and every other linkedin.com URL a blank page. */
async function serve(html: string): Promise<Served> {
  const page = await browser!.newPage();
  const navigations: string[] = [];
  await page.route("https://www.linkedin.com/**", async (route) => {
    const url = route.request().url();
    if (route.request().isNavigationRequest()) navigations.push(url);
    const body = url.startsWith(PROFILE_URL) ? html : "<!doctype html><html><head><title>LinkedIn</title></head><body></body></html>";
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  // The flows pause between steps like a person; the fixtures are already there.
  page.waitForTimeout = (async () => {}) as Page["waitForTimeout"];
  return { page, navigations };
}

function browserTest(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!browser) { t.skip(`no Chromium: ${launchError}`); return; }
    await fn();
  });
}

// ─── pure parsing ─────────────────────────────────────────────────────────────

test("the name comes from the document title, with or without a notification badge", () => {
  assert.equal(profileNameFromTitle("Ana Pérez | LinkedIn"), "Ana Pérez");
  assert.equal(profileNameFromTitle("(12) José Ignacio Feliú Fernández | LinkedIn"), "José Ignacio Feliú Fernández");
  assert.equal(profileNameFromTitle("LinkedIn"), null);
  assert.equal(profileNameFromTitle(""), null);
});

test("the SDUI top card text yields headline and the location next to Contact info", () => {
  const text = [
    "Ana Pérez", "· 1er", "• 2º", "Gerente de Operaciones en Vitrina", "Pontificia Universidad Católica de Chile",
    "Santiago, Región Metropolitana de Santiago, Chile", "·", "Información de contacto",
    "292 contactos", "Javier, y 121 contactos más en común", "Enviar mensaje", "Más",
  ].join("\n");
  assert.deepEqual(topCardLines(text, "Ana Pérez"), {
    headline: "Gerente de Operaciones en Vitrina",
    location: "Santiago, Región Metropolitana de Santiago, Chile",
  });
});

// ─── the card itself ──────────────────────────────────────────────────────────

browserTest("legacy layout: the card is the section around the <h1>", async () => {
  const { page } = await serve(fixture("legacy-first-degree.html"));
  await page.goto(PROFILE_URL);
  const card = await locateTopCard(page);
  assert.ok(card);
  assert.equal((await card.heading.innerText()).trim(), "Ana Pérez");
  assert.equal(await card.card.locator('a[href*="/messaging/compose"]').count(), 1);
  await page.close();
});

browserTest("SDUI layout: the card is the INNER section around the <h2>, not «Primary content»", async () => {
  const { page } = await serve(fixture("sdui-first-degree-es.html"));
  await page.goto(PROFILE_URL);
  const card = await locateTopCard(page);
  assert.ok(card);
  assert.equal((await card.heading.innerText()).trim(), "Ana Pérez");
  assert.equal(await card.card.getAttribute("aria-label"), null, "must not be the outer Primary content section");
  const text = await card.card.innerText();
  assert.doesNotMatch(text, /Destacados|Javier Mutual/);
  assert.deepEqual(topCardLines(text, "Ana Pérez"), {
    headline: "Gerente de Operaciones en Vitrina",
    location: "Santiago, Región Metropolitana de Santiago, Chile",
  });
  await page.close();
});

browserTest("SDUI layout found by the Topcard container when the title carries no name", async () => {
  const html = fixture("sdui-not-connected-en.html").replace("<title>Ana Pérez | LinkedIn</title>", "<title>LinkedIn</title>");
  const { page } = await serve(html);
  await page.goto(PROFILE_URL);
  const card = await locateTopCard(page);
  assert.ok(card);
  assert.equal((await card.heading.innerText()).trim(), "Ana Pérez");
  await page.close();
});

// ─── visit: degree and messaging URN ──────────────────────────────────────────

browserTest("visit, legacy 1st-degree: the target's URN, not the sidebar's", async () => {
  const { page } = await serve(fixture("legacy-first-degree.html"));
  assert.deepEqual(await visitProfile(page, PROFILE_URL), { isFirstDegree: true, messagingUrn: ANA_URN });
  await page.close();
});

browserTest("visit, legacy 2nd-degree: a connected sidebar person does not make the target 1st", async () => {
  const { page } = await serve(fixture("legacy-not-connected.html"));
  assert.deepEqual(await visitProfile(page, PROFILE_URL), { isFirstDegree: false, messagingUrn: null });
  await page.close();
});

browserTest("visit, SDUI 1st-degree (Spanish UI): the target's URN, not the mutual's or the header's", async () => {
  const { page } = await serve(fixture("sdui-first-degree-es.html"));
  assert.deepEqual(await visitProfile(page, PROFILE_URL), { isFirstDegree: true, messagingUrn: ANA_URN });
  await page.close();
});

browserTest("visit, SDUI 2nd-degree: Highlights' Message link is someone else's", async () => {
  const { page } = await serve(fixture("sdui-not-connected-en.html"));
  assert.deepEqual(await visitProfile(page, PROFILE_URL), { isFirstDegree: false, messagingUrn: null });
  await page.close();
});

browserTest("visit, SDUI: a card link whose URN is not the Topcard's profile is not trusted", async () => {
  const html = fixture("sdui-first-degree-es.html").replace(/refACoAAAnaPerez01Topcard/g, "refACoAAOtherPerson7Topcard");
  const { page } = await serve(html);
  const result = await visitProfile(page, PROFILE_URL);
  assert.equal(result.messagingUrn, null);
  await page.close();
});

browserTest("visit, no name heading: no card, nothing borrowed from the rest of the page", async () => {
  const { page } = await serve(fixture("sdui-no-name.html"));
  assert.deepEqual(await visitProfile(page, PROFILE_URL), { isFirstDegree: false, messagingUrn: null });
  await page.close();
});

// ─── connect: already connected, and whose Connect link ───────────────────────

browserTest("connect, legacy and SDUI 1st-degree: already connected, nothing clicked", async () => {
  for (const name of ["legacy-first-degree.html", "sdui-first-degree-es.html"]) {
    const { page, navigations } = await serve(fixture(name));
    await assert.rejects(sendConnectionRequest(page, PROFILE_URL), AlreadyConnectedError, name);
    assert.deepEqual(navigations, [PROFILE_URL], name);
    await page.close();
  }
});

browserTest("connect, SDUI 2nd-degree: follows the target's own invite, never the sidebar's", async () => {
  const { page, navigations } = await serve(fixture("sdui-not-connected-en.html"));
  await sendConnectionRequest(page, PROFILE_URL);
  assert.deepEqual(navigations, [PROFILE_URL, "https://www.linkedin.com/preload/custom-invite/?vanityName=ana-perez"]);
  await page.close();
});

browserTest("connect, legacy 2nd-degree: follows the target's own invite", async () => {
  const { page, navigations } = await serve(fixture("legacy-not-connected.html"));
  await sendConnectionRequest(page, PROFILE_URL);
  assert.deepEqual(navigations, [PROFILE_URL, "https://www.linkedin.com/preload/custom-invite/?vanityName=ana-perez"]);
  await page.close();
});

browserTest("connect, no name heading: refuses instead of using a page-wide Connect", async () => {
  const { page, navigations } = await serve(fixture("sdui-no-name.html"));
  await assert.rejects(sendConnectionRequest(page, PROFILE_URL), /top card not found/);
  assert.deepEqual(navigations, [PROFILE_URL]);
  await page.close();
});
