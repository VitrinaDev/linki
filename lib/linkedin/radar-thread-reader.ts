import type { Page } from "playwright";

export type NativeMessage = { id: string; threadId: string; direction: "entrante" | "saliente"; occurredAt: string; text: string; type: "texto" };
export type NativePage = { messages: NativeMessage[]; next: number | null };
const urn = /^urn:li:(?:fs_conversation|fsd_conversation):[A-Za-z0-9_-]+$/;
export function nativeThreadId(value: string): string {
  if (!urn.test(value)) throw new Error("Native conversation identity unavailable");
  return value;
}
export function threadFromUrl(value: string): string | null {
  const u = new URL(value);
  if (u.hostname !== "www.linkedin.com") return null;
  const match = u.pathname.match(/^\/messaging\/thread\/([A-Za-z0-9_-]+)\/?$/);
  return match ? `urn:li:fs_conversation:${match[1]}` : null;
}
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
/** Voyager's legacy exact-conversation event page, as used by the existing
 * inbox reader. No included-neighbour fallback and no fabricated message ids. */
export function parseThreadPage(raw: unknown, threadId: string, selfUrn: string, counterpart: string, start: number, count: number): NativePage {
  nativeThreadId(threadId);
  const body = object(raw), paging = object(body?.paging);
  if (!body || !Array.isArray(body.elements) || !paging || paging.start !== start || typeof paging.total !== "number" || !Number.isInteger(paging.total) || paging.total < 0 || typeof paging.count !== "number" || !Number.isInteger(paging.count) || paging.count < 0) throw new Error("Exact-thread pagination incomplete");
  const vanity = decodeURIComponent(new URL(counterpart).pathname.split("/").filter(Boolean).at(-1) ?? "").toLowerCase();
  const messages: NativeMessage[] = [];
  for (const value of body.elements) {
    const event = object(value), from = object(event?.from), member = object(from?.["com.linkedin.voyager.messaging.MessagingMember"]), profile = object(member?.miniProfile);
    const content = object(object(event?.eventContent)?.["com.linkedin.voyager.messaging.event.MessageEvent"]);
    if (!content) throw new Error("Native event content unsupported; exact thread remains partial");
    const id = event?.entityUrn, parent = event?.conversationUrn ?? (typeof id === "string" ? id.match(/^urn:li:fs_event:\(([^,]+),/)?.[1] : null);
    const expectedShort = threadId.split(":").at(-1);
    if (typeof id !== "string" || !/^urn:li:(?:fs_event|fsd_message):/.test(id) || (parent !== threadId && parent !== expectedShort) || typeof event?.createdAt !== "number" || !Number.isFinite(event.createdAt)) throw new Error("Native message identity incomplete");
    const attributed = object(content.attributedBody), text = attributed?.text ?? content.body;
    if (typeof text !== "string" || text.length > 1000000) throw new Error("Native message content unavailable");
    const isSelf = profile?.entityUrn === selfUrn;
    const isCounterpart = typeof profile?.publicIdentifier === "string" && profile.publicIdentifier.toLowerCase() === vanity;
    if (!isSelf && !isCounterpart) throw new Error("Native message sender ambiguous");
    // Attachment-only bodies require the media descriptor contract; never call them complete.
    if (Array.isArray(content.attachments) && content.attachments.length) throw new Error("Native attachment descriptors require recovery");
    messages.push({ id, threadId, direction: isSelf ? "saliente" : "entrante", occurredAt: new Date(event.createdAt).toISOString(), text, type: "texto" });
  }
  const scanned = body.elements.length;
  if (start + scanned < paging.total && (!scanned || scanned > count)) throw new Error("Exact-thread pagination did not advance");
  return { messages, next: start + scanned < paging.total ? start + scanned : null };
}
/** Concrete provider read. It fetches ONLY the selected conversation and the
 * account's own identity; a changed native shape fails closed and stays partial. */
export async function readThreadPage(page: Page, threadId: string, counterpart: string, start = 0, count = 100): Promise<NativePage> {
  nativeThreadId(threadId);
  const native = threadId.split(":").at(-1)!;
  const raw = await page.evaluate(async ({ native, start, count }) => {
    const csrf = (document.cookie.split("; ").find(c => c.startsWith("JSESSIONID="))?.slice(11) ?? "").replace(/"/g, "");
    const headers = { "csrf-token": csrf, "x-restli-protocol-version": "2.0.0" };
    const me = await fetch("/voyager/api/me", { credentials: "include", headers });
    const response = await fetch(`/voyager/api/messaging/conversations/${encodeURIComponent(native)}/events?count=${count}&start=${start}`, { credentials: "include", headers });
    if (!me.ok || !response.ok) return { status: !response.ok ? response.status : me.status };
    return { me: await me.json(), body: await response.json() };
  }, { native, start, count }) as { status?: number; me?: { miniProfile?: { entityUrn?: string } }; body?: unknown };
  if (raw.status) throw Object.assign(new Error("Native thread read unavailable"), { status: raw.status });
  const self = raw.me?.miniProfile?.entityUrn;
  if (!self) throw new Error("Native account identity unavailable");
  return parseThreadPage(raw.body, threadId, self, counterpart, start, count);
}
export async function readWholeThread(page: Page, threadId: string, counterpart: string, { maxPages = 100, onPage }: { maxPages?: number; onPage?: (messages: NativeMessage[]) => void } = {}) {
  const messages: NativeMessage[] = []; let start = 0;
  for (let pages = 0; pages < maxPages; pages++) {
    const result = await readThreadPage(page, threadId, counterpart, start);
    onPage?.(result.messages);
    messages.push(...result.messages);
    if (result.next === null) return messages;
    if (result.next <= start) throw new Error("Exact-thread pagination loop");
    start = result.next;
  }
  throw new Error("Exact-thread recovery remains partial at page cap");
}
