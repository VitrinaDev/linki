import { createHmac } from "node:crypto";
import { z } from "zod";

export const DEFAULT_RADAR_LIST_ID = "radar_vitrina_active_campaign";
export const RADAR_STATUSES = ["QUEUED", "CONNECTED", "REPLIED", "PAUSED"] as const;
export type RadarStatus = typeof RADAR_STATUSES[number];

export const radarContactSchema = z.object({
  firstName: z.string().trim().min(1).max(200),
  lastName: z.string().trim().max(200),
  companyName: z.string().trim().min(1).max(300),
  linkedinUrl: z.string().url().refine(
    (value) => /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i.test(value),
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

export type RadarCallbackEventType = "connection.accepted" | "message.replied";

export interface RadarCallbackPayload {
  eventId: string;
  eventType: RadarCallbackEventType;
  source: "linki";
  occurredAt: string;
  data: {
    contact: {
      status: "connected" | "replied";
      customAttributes: { radar_lead_id: string };
    };
  };
}

export function buildRadarCallback(
  eventId: string,
  eventType: RadarCallbackEventType,
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

export function callbackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function retryDelaySeconds(attempts: number): number {
  const base = Math.min(24 * 60 * 60, 60 * 2 ** Math.max(0, attempts - 1));
  return base + Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.2)));
}
