/**
 * Working-hours arithmetic for an account, in the account's own timezone.
 *
 * Extracted from lib/linkedin/runner.ts verbatim so that work which does NOT
 * belong to a run — Radar profile reads (lib/radar/profile-reads.ts) — honours
 * exactly the same `active_hours_*`, `timezone` and `working_days` the campaign
 * runner honours, instead of growing a second, drifting copy of the rules.
 */

export interface ScheduleConfig {
  active_hours_start: number;
  active_hours_end: number;
  timezone: string;
  working_days: string;
}

export function getLocalParts(tz: string, date = new Date()): { hour: number; minute: number; isoWeekday: number } {
  const safeZone = (() => { try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; } catch { return "UTC"; } })();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone,
    hour: "numeric", minute: "numeric", weekday: "short", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { hour, minute, isoWeekday: weekdayMap[get("weekday")] ?? 1 };
}

export function isWithinSchedule(account: ScheduleConfig): boolean {
  const { hour, minute, isoWeekday } = getLocalParts(account.timezone || "UTC");
  const allowedDays = (account.working_days || "1,2,3,4,5").split(",").map(Number);
  if (!allowedDays.includes(isoWeekday)) return false;
  const frac = hour + minute / 60;
  return frac >= (account.active_hours_start ?? 9) && frac < (account.active_hours_end ?? 18);
}

export function randomSlotInActiveWindow(account: ScheduleConfig, targetDate?: Date): string {
  const start = account.active_hours_start ?? 9;
  const end = account.active_hours_end ?? 18;
  const base = targetDate ? new Date(targetDate) : new Date();
  const startMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), start, 0, 0).getTime();
  const endMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), end,   0, 0).getTime();
  return new Date(startMs + Math.random() * (endMs - startMs)).toISOString();
}

export function rescheduleToTomorrow(account: ScheduleConfig): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return randomSlotInActiveWindow(account, tomorrow);
}

export function nextScheduledSlot(account: ScheduleConfig): string {
  const tz = account.timezone || "UTC";
  const allowedDays = (account.working_days || "1,2,3,4,5").split(",").map(Number);
  const end = account.active_hours_end ?? 18;
  const { hour: nowHour, minute: nowMin, isoWeekday: nowDay } = getLocalParts(tz);
  const nowFrac = nowHour + nowMin / 60;
  if (allowedDays.includes(nowDay) && nowFrac < end - 0.25) {
    const remaining = (end - nowFrac) * 3600_000;
    return new Date(Date.now() + Math.random() * remaining).toISOString();
  }
  return nextWorkingDaySlot(account);
}

/**
 * The active window of the next working DAY, skipping today entirely. Used when
 * today's budget is spent, where `nextScheduledSlot` would still offer a slot
 * later today.
 */
export function nextWorkingDaySlot(account: ScheduleConfig): string {
  const tz = account.timezone || "UTC";
  const allowedDays = (account.working_days || "1,2,3,4,5").split(",").map(Number);
  const candidate = new Date();
  for (let i = 1; i <= 14; i++) {
    candidate.setDate(candidate.getDate() + 1);
    const { isoWeekday } = getLocalParts(tz, candidate);
    if (allowedDays.includes(isoWeekday)) return randomSlotInActiveWindow(account, candidate);
  }
  return new Date(Date.now() + 86_400_000).toISOString();
}

/**
 * UTC instant at which the account's local calendar day started. Profile-read
 * daily caps are counted from here, so "today" means the operator's today.
 */
export function startOfLocalDay(account: Pick<ScheduleConfig, "timezone">, now = new Date()): Date {
  const { hour, minute } = getLocalParts(account.timezone || "UTC", now);
  const seconds = new Intl.DateTimeFormat("en-US", {
    timeZone: (() => { try { Intl.DateTimeFormat(undefined, { timeZone: account.timezone || "UTC" }); return account.timezone || "UTC"; } catch { return "UTC"; } })(),
    second: "numeric", hour12: false,
  }).formatToParts(now).find(p => p.type === "second")?.value ?? "0";
  const elapsedMs = ((hour * 60 + minute) * 60 + parseInt(seconds, 10)) * 1000;
  return new Date(now.getTime() - elapsedMs);
}
