import type { Page } from "playwright";
import { getDb } from "@/lib/db";
import { getSessionPage, markNeedsReauth, saveSessionState } from "./session";

const DEFAULT_INTERVAL_MINUTES = 15;
const CONVERSATION_COUNT = 100;
const DECORATION = "com.linkedin.voyager.dash.deco.messaging.FullConversation-17";

interface MiniProfile {
  entityUrn?: string;
  publicIdentifier?: string;
}

interface MessageEvent {
  createdAt?: number;
  from?: { "com.linkedin.voyager.messaging.MessagingMember"?: { miniProfile?: MiniProfile } };
  eventContent?: {
    "com.linkedin.voyager.messaging.event.MessageEvent"?: {
      body?: string;
      attributedBody?: { text?: string };
    };
  };
}

interface Conversation {
  events?: MessageEvent[];
}

interface ConversationsResponse {
  elements?: Conversation[];
  included?: Array<Conversation & { $type?: string }>;
}

interface RadarTarget {
  id: string;
  linkedin_url: string;
  messaging_urn: string | null;
  message_sent_at: string;
}

function intervalMs(): number {
  const raw = Number(process.env.RADAR_REPLY_SYNC_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES);
  const minutes = Number.isFinite(raw) ? Math.max(5, raw) : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60_000;
}

export function shouldSyncRadarInbox(accountId: string): boolean {
  if (!process.env.RADAR_WORKFLOW_ID || process.env.RADAR_LINKEDIN_ACCOUNT_ID !== accountId) return false;
  const row = getDb().prepare("SELECT radar_inbox_synced_at FROM accounts WHERE id = ?").get(accountId) as
    | { radar_inbox_synced_at: string | null }
    | undefined;
  return !row?.radar_inbox_synced_at || Date.now() - parseTime(row.radar_inbox_synced_at) >= intervalMs();
}

function parseTime(value: string): number {
  return new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value.replace(" ", "T")}Z`).getTime();
}

function vanity(url: string): string | null {
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}

function messageText(event: MessageEvent): string {
  const content = event.eventContent?.["com.linkedin.voyager.messaging.event.MessageEvent"];
  return (content?.attributedBody?.text ?? content?.body ?? "").trim();
}

function sender(event: MessageEvent): MiniProfile | undefined {
  return event.from?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile;
}

export function findRadarReplies(
  conversations: Conversation[],
  targets: RadarTarget[],
): Array<{ targetId: string; occurredAt: string; messagingUrn: string | null }> {
  const byVanity = new Map<string, RadarTarget>();
  const byUrn = new Map<string, RadarTarget>();
  for (const target of targets) {
    const key = vanity(target.linkedin_url);
    if (key) byVanity.set(key, target);
    if (target.messaging_urn) byUrn.set(target.messaging_urn, target);
  }

  const latest = new Map<string, { occurredAt: string; messagingUrn: string | null }>();
  for (const conversation of conversations) {
    for (const event of conversation.events ?? []) {
      if (!event.createdAt || !messageText(event)) continue;
      const profile = sender(event);
      const target = (profile?.entityUrn ? byUrn.get(profile.entityUrn) : undefined)
        ?? (profile?.publicIdentifier ? byVanity.get(profile.publicIdentifier.toLowerCase()) : undefined);
      if (!target) continue;
      const sentAt = parseTime(target.message_sent_at);
      if (event.createdAt <= sentAt) continue;
      const occurredAt = new Date(event.createdAt).toISOString();
      const prior = latest.get(target.id);
      if (!prior || occurredAt > prior.occurredAt) {
        latest.set(target.id, { occurredAt, messagingUrn: profile?.entityUrn ?? target.messaging_urn });
      }
    }
  }
  return [...latest].map(([targetId, value]) => ({ targetId, ...value }));
}

async function fetchConversations(page: Page): Promise<Conversation[] | null> {
  const response = await page.evaluate(async ({ count, decoration }) => {
    const cookies = document.cookie.split("; ").reduce((result: Record<string, string>, item) => {
      const splitAt = item.indexOf("=");
      if (splitAt > 0) result[item.slice(0, splitAt)] = item.slice(splitAt + 1);
      return result;
    }, {});
    const csrf = (cookies.JSESSIONID ?? "").replace(/"/g, "");
    const url = `/voyager/api/voyagerMessagingDashMessengerConversations?decorationId=${encodeURIComponent(decoration)}&count=${count}`;
    const result = await fetch(url, {
      credentials: "include",
      headers: { "csrf-token": csrf, "x-restli-protocol-version": "2.0.0" },
    });
    if (!result.ok) return null;
    return result.json();
  }, { count: CONVERSATION_COUNT, decoration: DECORATION }) as ConversationsResponse | null;
  if (!response) return null;
  if (Array.isArray(response.elements)) return response.elements;
  return (response.included ?? []).filter((item) => item.$type?.includes("Conversation"));
}

export async function syncRadarInbox(accountId: string): Promise<number> {
  const db = getDb();
  const targets = db.prepare(`
    SELECT DISTINCT t.id, t.linkedin_url, t.messaging_urn, t.message_sent_at
    FROM targets t
    JOIN run_profiles rp ON rp.target_id = t.id
    JOIN runs r ON r.id = rp.run_id
    WHERE r.account_id = ? AND t.radar_lead_id IS NOT NULL
      AND t.message_sent_at IS NOT NULL AND t.last_replied_at IS NULL
  `).all(accountId) as RadarTarget[];
  if (targets.length === 0) {
    db.prepare("UPDATE accounts SET radar_inbox_synced_at = datetime('now') WHERE id = ?").run(accountId);
    return 0;
  }

  const page = await getSessionPage(accountId);
  let validSession = true;
  try {
    await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 35_000 });
    await page.waitForTimeout(2500 + Math.random() * 1500);
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) {
      validSession = false;
      return 0;
    }
    const conversations = await fetchConversations(page);
    if (!conversations) throw new Error("LinkedIn inbox API returned no usable response");
    const replies = findRadarReplies(conversations, targets);
    db.transaction(() => {
      const update = db.prepare(`
        UPDATE targets SET last_replied_at = ?, messaging_urn = COALESCE(messaging_urn, ?), radar_status = 'REPLIED'
        WHERE id = ? AND last_replied_at IS NULL
      `);
      const pauseTracks = db.prepare(`
        UPDATE run_profile_tracks
        SET state = 'skipped', next_step_at = NULL, error_message = 'Lead replied on LinkedIn'
        WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)
          AND state NOT IN ('completed', 'failed', 'skipped')
      `);
      for (const reply of replies) {
        update.run(reply.occurredAt, reply.messagingUrn, reply.targetId);
        pauseTracks.run(reply.targetId);
      }
    })();
    return replies.length;
  } finally {
    try { await page.close(); } catch { /* ignore */ }
    if (validSession) {
      try { await saveSessionState(accountId); } catch { /* ignore */ }
    } else {
      try { await markNeedsReauth(accountId); } catch { /* ignore */ }
    }
    db.prepare("UPDATE accounts SET radar_inbox_synced_at = datetime('now') WHERE id = ?").run(accountId);
  }
}
