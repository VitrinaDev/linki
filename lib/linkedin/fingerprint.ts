export function browserContextOptions(storageState: object | undefined, accountTimeZone: string | null | undefined) {
  return {
    // Let Playwright report the actual bundled Chromium version. A hard-coded
    // user-agent drifts away from the executable and is a stronger signal than
    // the real Linux browser identity.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: storageState as any,
    viewport: { width: 1920, height: 1080 },
    locale: process.env.LINKI_BROWSER_LOCALE?.trim() || "es-CL",
    timezoneId: process.env.LINKI_BROWSER_TIMEZONE?.trim() || accountTimeZone || "America/Santiago",
    permissions: ["clipboard-read", "clipboard-write"] as ("clipboard-read" | "clipboard-write")[],
  };
}
