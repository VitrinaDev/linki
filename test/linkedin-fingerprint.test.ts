import assert from "node:assert/strict";
import test from "node:test";
import { browserContextOptions } from "../lib/linkedin/fingerprint";

test("uses the account timezone and lets Chromium advertise its real version", () => {
  delete process.env.LINKI_BROWSER_TIMEZONE;
  delete process.env.LINKI_BROWSER_LOCALE;
  const options = browserContextOptions(undefined, "America/Santiago");
  assert.equal(options.timezoneId, "America/Santiago");
  assert.equal(options.locale, "es-CL");
  assert.equal("userAgent" in options, false);
});

test("allows an explicit runtime timezone override", () => {
  process.env.LINKI_BROWSER_TIMEZONE = "America/Punta_Arenas";
  const options = browserContextOptions(undefined, "America/Santiago");
  assert.equal(options.timezoneId, "America/Punta_Arenas");
  delete process.env.LINKI_BROWSER_TIMEZONE;
});
