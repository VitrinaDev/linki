import { createHmac } from "node:crypto";
import { z } from "zod";

export const DEFAULT_RADAR_LIST_ID = "radar_vitrina_active_campaign";
export const DEFAULT_RADAR_WORKFLOW_ID = "radar_vitrina_active_campaign_workflow";
export const RADAR_STATUSES = ["QUEUED", "CONNECTED", "REPLIED", "PAUSED"] as const;
export type RadarStatus = typeof RADAR_STATUSES[number];

const LINKEDIN_PROFILE_URL = /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i;

/**
 * The stored/compared form of a LinkedIn profile URL: no query, no fragment, no
 * trailing slash. Radar matches the callback's `linkedin_url` against the
 * Persona it asked for, so both sides must canonicalise identically.
 */
export function canonicalLinkedInUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export const radarContactSchema = z.object({
  firstName: z.string().trim().min(1).max(200),
  lastName: z.string().trim().max(200),
  companyName: z.string().trim().min(1).max(300),
  linkedinUrl: z.string().url().refine(
    (value) => LINKEDIN_PROFILE_URL.test(value),
    "linkedinUrl must be a LinkedIn profile URL",
  ),
  listId: z.string().trim().min(1).max(200),
  status: z.literal("QUEUED"),
  customAttributes: z.object({
    radar_lead_id: z.string().uuid(),
    icebreaker_context: z.string().trim().min(1).max(10_000),
  }).strict(),
}).strict();

export type RadarContactInput = z.infer<typeof radarContactSchema>;

export const radarPauseSchema = z.object({ status: z.literal("PAUSED") }).strict();

const validTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

// Ceilings for the profile-read knobs. They are LOW on purpose: a read is a
// logged-in page view on a real account, and the only safe volume is a small one.
export const MAX_DAILY_PROFILE_READS = 25;
export const MIN_READ_GAP_MINUTES = 3;
export const MAX_READ_GAP_MINUTES = 30;

export const DISABLED_READ_POLICY = {
  enabled: false,
  dailyProfileReadLimit: 0,
  minGapMinutes: MIN_READ_GAP_MINUTES,
} as const;

export const radarProvisionSchema = z.object({
  schemaVersion: z.literal(1),
  outboundEnabled: z.boolean(),
  listId: z.literal(DEFAULT_RADAR_LIST_ID),
  workflowId: z.literal(DEFAULT_RADAR_WORKFLOW_ID),
  campaignName: z.string().trim().min(1).max(200),
  messageTemplate: z.string().trim().min(1).max(3_000).refine(
    (value) => value.includes("{{icebreaker_context}}"),
    "messageTemplate must include {{icebreaker_context}}",
  ),
  messageDelaySeconds: z.number().int().min(30 * 60).max(7 * 24 * 60 * 60),
  accountPolicy: z.object({
    dailyConnectionLimit: z.number().int().min(0).max(15),
    dailyMessageLimit: z.number().int().min(0).max(20),
    dailyInmailLimit: z.literal(0),
    activeHoursStart: z.number().int().min(0).max(22),
    activeHoursEnd: z.number().int().min(1).max(23),
    timezone: z.string().trim().min(1).max(100).refine(validTimeZone, "invalid timezone"),
    workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  }).strict().refine(
    (policy) => policy.activeHoursEnd > policy.activeHoursStart,
    "activeHoursEnd must be after activeHoursStart",
  ),
  // Profile reads are a SEPARATE switch from outbound sending: reading a public
  // profile is not outreach, so Radar can turn reads on while `outboundEnabled`
  // stays false. The manifest is `.strict()`, so the key has to be declared here
  // for a Radar that sends it to be accepted at all. It carries a
  // reads-disabled default instead of being `.optional()` so that a Radar that
  // does NOT yet send it still provisions successfully — and provisions with
  // reads off. Absence therefore means "no reads", never "keep what was there".
  readPolicy: z.object({
    enabled: z.boolean(),
    dailyProfileReadLimit: z.number().int().min(0).max(MAX_DAILY_PROFILE_READS),
    minGapMinutes: z.number().int().min(MIN_READ_GAP_MINUTES).max(MAX_READ_GAP_MINUTES),
  }).strict().default(DISABLED_READ_POLICY),
}).strict();

export type RadarProvisionInput = z.infer<typeof radarProvisionSchema>;
export type RadarReadPolicy = RadarProvisionInput["readPolicy"];

export const radarControlSchema = z.object({
  enabled: z.boolean(),
  dailyConnectionLimit: z.number().int().min(0).max(15),
  dailyMessageLimit: z.number().int().min(0).max(20),
  retryFailed: z.boolean().optional().default(false),
  // Clears a durable pause (see RUNTIME_PAUSE_REASONS) in this same request.
  // While a pause is recorded NOTHING can be enabled — not sending, not reads,
  // not resuming a parked run — so acknowledging it is the explicit human step
  // that says "I looked at the incident". Acknowledge and enable may travel
  // together: the pause is cleared first, then `enabled` is applied.
  acknowledgePause: z.boolean().optional().default(false),
}).strict();

export type RadarControlInput = z.infer<typeof radarControlSchema>;

/**
 * Why the runtime is parked. Only these two: they are the incidents where
 * LinkedIn itself told us to stop, and a human has to look before anything
 * resumes. A network timeout is not one of them.
 */
export const RUNTIME_PAUSE_REASONS = ["challenge", "rate_limited"] as const;
export type RuntimePauseReason = typeof RUNTIME_PAUSE_REASONS[number];

export interface RuntimePause {
  reason: RuntimePauseReason;
  /** ISO-8601 UTC. */
  at: string;
}

export const radarAccountSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
}).strict();

export type RadarAccountInput = z.infer<typeof radarAccountSchema>;

// ─── profile reads ────────────────────────────────────────────────────────────

export const radarProfileReadSchema = z.object({
  linkedinUrl: z.string().url().refine(
    (value) => LINKEDIN_PROFILE_URL.test(value),
    "linkedinUrl must be a LinkedIn profile URL",
  ),
  radar_persona_id: z.string().uuid(),
}).strict();

export type RadarProfileReadInput = z.infer<typeof radarProfileReadSchema>;

/** Why a read stopped. `partial` means the page loaded but yielded nothing at all. */
export const PROFILE_READ_ERROR_CODES = ["challenge", "rate_limited", "not_found", "network", "partial"] as const;
export type ProfileReadErrorCode = typeof PROFILE_READ_ERROR_CODES[number];

export interface ProfileReadPosition {
  title: string | null;
  company: string | null;
  company_url: string | null;
  start: string | null;   // "YYYY-MM" or "YYYY"
  end: string | null;     // null while current
  current: boolean;
}

export interface ProfileReadResult {
  headline: string | null;
  location: string | null;
  partial: boolean;
  positions: ProfileReadPosition[];
}

/**
 * The ONLY keys that may leave this runtime for a read. Everything else the
 * page happens to expose — summary, skills, languages, educations, posts,
 * connection counts, degree, premium badges, any photo URL — is dropped here,
 * and a test asserts these exact key sets. Radar is the system of record for
 * personal data; Linki must not widen what it ships without that test failing.
 */
export const PROFILE_READ_PAYLOAD_KEYS = [
  "linkedin_url", "headline", "location", "partial", "positions", "read_at",
] as const;
export const PROFILE_READ_POSITION_KEYS = [
  "title", "company", "company_url", "start", "end", "current",
] as const;

export interface SanitizedProfileRead {
  linkedin_url: string;
  headline: string | null;
  location: string | null;
  partial: boolean;
  positions: ProfileReadPosition[];
  read_at: string;
}

function trimmedOrNull(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Rebuilds the payload key by key from an allowlist — never spreads the input. */
export function sanitizeProfileRead(
  linkedinUrl: string,
  readAt: string,
  result: ProfileReadResult,
): SanitizedProfileRead {
  const positions = (Array.isArray(result.positions) ? result.positions : [])
    .slice(0, 10)
    .map((position) => ({
      title: trimmedOrNull(position?.title, 300),
      company: trimmedOrNull(position?.company, 300),
      company_url: trimmedOrNull(position?.company_url, 500),
      start: trimmedOrNull(position?.start, 7),
      end: trimmedOrNull(position?.end, 7),
      current: position?.current === true,
    }));
  return {
    linkedin_url: canonicalLinkedInUrl(linkedinUrl),
    headline: trimmedOrNull(result.headline, 500),
    location: trimmedOrNull(result.location, 300),
    partial: result.partial === true || positions.length === 0,
    positions,
    read_at: new Date(readAt).toISOString(),
  };
}

// ─── callbacks ────────────────────────────────────────────────────────────────

export type RadarContactEventType = "connection.accepted" | "message.replied";
export type RadarProfileReadEventType = "profile.read" | "profile.read.failed";
export type RadarCallbackEventType = RadarContactEventType | RadarProfileReadEventType;

export const REDACTED_CALLBACK_EVENT_TYPES: readonly RadarCallbackEventType[] =
  ["profile.read", "profile.read.failed"];

export interface RadarCallbackPayload {
  eventId: string;
  eventType: RadarContactEventType;
  source: "linki";
  occurredAt: string;
  data: {
    contact: {
      status: "connected" | "replied";
      customAttributes: { radar_lead_id: string };
    };
  };
}

export interface RadarProfileReadJob {
  id: string;
  radar_persona_id: string;
  runtime_key: string | null;
}

export interface RadarProfileReadCallbackPayload {
  eventId: string;
  eventType: RadarProfileReadEventType;
  source: "linki";
  occurredAt: string;
  data: {
    job: RadarProfileReadJob & { error_code?: ProfileReadErrorCode };
    profile?: SanitizedProfileRead;
  };
}

export function buildRadarCallback(
  eventId: string,
  eventType: RadarContactEventType,
  occurredAt: string,
  radarLeadId: string,
): RadarCallbackPayload {
  return {
    eventId,
    eventType,
    source: "linki",
    occurredAt: new Date(occurredAt).toISOString(),
    data: {
      contact: {
        status: eventType === "connection.accepted" ? "connected" : "replied",
        customAttributes: { radar_lead_id: radarLeadId },
      },
    },
  };
}

/** Same envelope, same HMAC, same outbox as the contact events. */
export function buildRadarProfileReadCallback(
  eventId: string,
  occurredAt: string,
  job: RadarProfileReadJob,
  outcome: { profile: SanitizedProfileRead } | { errorCode: ProfileReadErrorCode },
): RadarProfileReadCallbackPayload {
  const base = {
    eventId,
    source: "linki" as const,
    occurredAt: new Date(occurredAt).toISOString(),
  };
  if ("profile" in outcome) {
    return {
      ...base,
      eventType: "profile.read",
      data: {
        job: { id: job.id, radar_persona_id: job.radar_persona_id, runtime_key: job.runtime_key },
        profile: outcome.profile,
      },
    };
  }
  return {
    ...base,
    eventType: "profile.read.failed",
    data: {
      job: {
        id: job.id,
        radar_persona_id: job.radar_persona_id,
        runtime_key: job.runtime_key,
        error_code: outcome.errorCode,
      },
    },
  };
}

export function callbackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function retryDelaySeconds(attempts: number): number {
  const base = Math.min(24 * 60 * 60, 60 * 2 ** Math.max(0, attempts - 1));
  return base + Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.2)));
}
