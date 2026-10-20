import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  activeWindowStartMs,
  randomSlotInActiveWindow,
  rescheduleToTomorrow,
} from "../lib/linkedin/schedule";

// The runtimes run in UTC containers; the account works in Santiago (UTC-3 in October).
process.env.TZ = "UTC";
const santiago = {
  active_hours_start: 9,
  active_hours_end: 18,
  timezone: "America/Santiago",
  working_days: "1,2,3,4,5",
};
const within = (slot: string, from: string, to: string) => {
  const ms = Date.parse(slot);
  assert.ok(ms >= Date.parse(from) && ms <= Date.parse(to), `${slot} outside ${from}..${to}`);
};

test("the active window is the account's local hours, not the server's", () => {
  // 2026-10-20T15:00Z is Tuesday 12:00 in Santiago: its window is 12:00Z..21:00Z.
  for (let i = 0; i < 50; i++) {
    within(randomSlotInActiveWindow(santiago, new Date("2026-10-20T15:00:00Z")),
      "2026-10-20T12:00:00Z", "2026-10-20T21:00:00Z");
  }
  assert.equal(activeWindowStartMs(santiago, new Date("2026-10-20T15:00:00Z")), Date.parse("2026-10-20T12:00:00Z"));
});

test("a late-evening hand-off is scheduled for the next local working day, not the one after", () => {
  // Monday 22:55 in Santiago is already Tuesday in UTC: "tomorrow" is Tuesday local.
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T01:55:00Z") });
  try {
    for (let i = 0; i < 50; i++) {
      within(rescheduleToTomorrow(santiago), "2026-10-20T12:00:00Z", "2026-10-20T21:00:00Z");
    }
  } finally {
    mock.timers.reset();
  }
});

test("a Friday-evening hand-off waits for Monday's window instead of a weekend slot", () => {
  // Friday 2026-10-23 20:00 in Santiago.
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T23:00:00Z") });
  try {
    for (let i = 0; i < 50; i++) {
      within(rescheduleToTomorrow(santiago), "2026-10-26T12:00:00Z", "2026-10-26T21:00:00Z");
    }
  } finally {
    mock.timers.reset();
  }
});
