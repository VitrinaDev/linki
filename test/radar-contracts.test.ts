import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRadarCallback,
  callbackSignature,
  radarContactSchema,
  retryDelaySeconds,
} from "../lib/radar/contracts";

const contact = {
  firstName: "Ana",
  lastName: "Pérez",
  companyName: "Vitrina",
  linkedinUrl: "https://www.linkedin.com/in/ana-perez",
  listId: "radar_vitrina_active_campaign",
  status: "QUEUED",
  customAttributes: {
    radar_lead_id: "7b299221-19ca-4b73-8400-d87716862a33",
    icebreaker_context: "Vi que Vitrina está creciendo en Chile.",
  },
} as const;

test("accepts Radar's exact contact contract", () => {
  assert.deepEqual(radarContactSchema.parse(contact), contact);
  assert.equal(radarContactSchema.safeParse({ ...contact, unexpected: true }).success, false);
  assert.equal(radarContactSchema.safeParse({ ...contact, linkedinUrl: "https://example.com/ana" }).success, false);
});

test("builds the canonical Linki callback envelope", () => {
  assert.deepEqual(
    buildRadarCallback("evt_1", "message.replied", "2026-09-10T14:00:00Z", contact.customAttributes.radar_lead_id),
    {
      eventId: "evt_1",
      eventType: "message.replied",
      source: "linki",
      occurredAt: "2026-09-10T14:00:00.000Z",
      data: {
        contact: {
          status: "replied",
          customAttributes: { radar_lead_id: contact.customAttributes.radar_lead_id },
        },
      },
    },
  );
});

test("signs timestamp dot raw body exactly as Radar verifies it", () => {
  assert.equal(
    callbackSignature("secret", "1789048800", '{"eventId":"evt_1"}'),
    "sha256=26d4871b9f705a5138403887182e2d13ef0af99ac88c8e3c478472fdcaeeb522",
  );
});

test("callback retry delay grows exponentially and caps at one day plus jitter", () => {
  assert.ok(retryDelaySeconds(1) >= 60 && retryDelaySeconds(1) < 72);
  assert.ok(retryDelaySeconds(30) >= 86_400 && retryDelaySeconds(30) < 103_680);
});
