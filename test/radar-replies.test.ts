import assert from "node:assert/strict";
import test from "node:test";
import { findRadarReplies } from "../lib/linkedin/sync-radar-replies";

const target = {
  id: "target-1",
  linkedin_url: "https://www.linkedin.com/in/ana-perez",
  messaging_urn: null,
  message_sent_at: "2026-09-10T14:00:00Z",
};

function message(publicIdentifier: string, createdAt: string, body = "Hola") {
  return {
    createdAt: new Date(createdAt).getTime(),
    from: {
      "com.linkedin.voyager.messaging.MessagingMember": {
        miniProfile: {
          entityUrn: `urn:li:fsd_profile:${publicIdentifier}`,
          publicIdentifier,
        },
      },
    },
    eventContent: {
      "com.linkedin.voyager.messaging.event.MessageEvent": { body },
    },
  };
}

test("only treats a newer message from the exact Radar contact as a reply", () => {
  const replies = findRadarReplies([
    {
      events: [
        message("ana-perez", "2026-09-10T13:59:00Z"),
        message("founder-one", "2026-09-10T14:01:00Z"),
        message("ana-perez", "2026-09-10T14:02:00Z", "Gracias, conversemos"),
      ],
    },
  ], [target]);

  assert.deepEqual(replies, [{
    targetId: "target-1",
    occurredAt: "2026-09-10T14:02:00.000Z",
    messagingUrn: "urn:li:fsd_profile:ana-perez",
  }]);
});

test("ignores system/empty events and lookalike profile names", () => {
  const replies = findRadarReplies([{ events: [
    message("ana-perez-2", "2026-09-10T14:03:00Z"),
    message("ana-perez", "2026-09-10T14:04:00Z", ""),
  ] }], [target]);
  assert.deepEqual(replies, []);
});
