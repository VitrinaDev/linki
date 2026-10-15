import type { Locator, Page } from "playwright";

/**
 * Locates the visited person's own top card on a `/in/<slug>/` profile page.
 *
 * Everything that decides "is this person a 1st-degree connection", "what is
 * their messaging URN" or "where is their Connect button" MUST be scoped to
 * this card: the rest of the page renders Message / Connect links and degree
 * badges for OTHER people (People also viewed, People you may know, mutual
 * connections in Highlights). A page-wide match once stored a stranger's
 * messaging URN and messaged the wrong person (Jul 2026 incident).
 *
 * LinkedIn ships more than one profile layout at a time:
 *
 *  - legacy (Ember): the name is the page's only `<h1>`, inside the top-card
 *    `<section>`;
 *  - SDUI (seen Oct 2026): the name is an `<h2>`; `main` opens with an outer
 *    "Primary content" `<section>` that wraps the top card AND later cards
 *    (Highlights carries mutual connections' Message links), and the top card
 *    is the inner `<section>` under a `[componentkey$="Topcard"]` container.
 *
 * So the card is never "the first section that has a heading". It is the
 * NEAREST `<section>` ancestor of the person's name heading, and the name
 * heading is found, in order of confidence, by:
 *
 *  1. an `<h1>`/`<h2>` in `main` whose whole text is the name LinkedIn puts in
 *     the document title ("Ana Pérez | LinkedIn"), independent of tag level;
 *  2. the first `<h1>` in `main` (legacy layout, unusual title);
 *  3. the first `<h1>`/`<h2>` inside the SDUI `Topcard` container.
 *
 * Nothing found means `null`, and every caller fails closed on it.
 */

export const NAME_HEADING = "h1, h2";

export interface TopCard {
  /** The nearest `<section>` around the person's name heading. */
  card: Locator;
  /** The name heading itself. */
  heading: Locator;
}

/** "(3) Ana Pérez | LinkedIn" → "Ana Pérez". `null` when the title carries no name. */
export function profileNameFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const withoutBadge = title.replace(/^\s*\(\d+\+?\)\s*/, "").trim();
  const match = withoutBadge.match(/^(.*?)\s*\|\s*LinkedIn\s*$/i);
  const name = (match ? match[1] : "").replace(/\s+/g, " ").trim();
  if (!name || /^linkedin$/i.test(name)) return null;
  return name;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function locateTopCard(page: Page): Promise<TopCard | null> {
  // The SDUI layout renders the card client-side; give it a bounded moment.
  try {
    await page.locator("main").locator(NAME_HEADING).first().waitFor({ state: "attached", timeout: 8000 });
  } catch { /* absent heading is handled below, fail closed */ }

  const name = profileNameFromTitle(await page.title().catch(() => ""));
  const main = page.locator("main");

  const headings: Locator[] = [];
  if (name) {
    headings.push(main.locator(NAME_HEADING).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) }));
  }
  headings.push(main.locator("h1"));
  headings.push(main.locator('[componentkey$="Topcard"]').locator(NAME_HEADING));

  for (const candidate of headings) {
    if ((await candidate.count().catch(() => 0)) === 0) continue;
    const heading = candidate.first();
    const card = heading.locator("xpath=ancestor::section[1]");
    if ((await card.count().catch(() => 0)) > 0) return { card, heading };
  }
  return null;
}

/**
 * The SDUI layout names the profile in the top-card container's componentkey
 * (`com.linkedin.sdui.profile.card.ref<ACoAA…>Topcard`). When present, it is an
 * independent check that a messaging URN read from the card belongs to the
 * visited person. `null` when the layout does not carry it (legacy).
 */
export async function topCardProfileId(topCard: TopCard): Promise<string | null> {
  const container = topCard.card.locator('xpath=ancestor::*[contains(@componentkey, "Topcard")][1]');
  if ((await container.count().catch(() => 0)) === 0) return null;
  const key = await container.first().getAttribute("componentkey").catch(() => null);
  return key?.match(/ref(ACo[A-Za-z0-9_-]+)Topcard$/)?.[1] ?? null;
}

/** Degree badge as rendered in the top card ("1st", "· 1st", "1er", "1º"). */
export const FIRST_DEGREE = /(^|[\s·•])(1st|1er|1º|1°)(?=$|[\s·•])/m;
export const PENDING = /\b(Pending|Pendiente)\b/;
