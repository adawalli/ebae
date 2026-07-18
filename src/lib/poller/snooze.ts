import type { SnoozeState } from "./state";

export const SNOOZE_DEFAULT: SnoozeState = { enabled: false, start: 60, end: 420, tz: null };

// Minutes-from-midnight window membership, handling windows that cross midnight
// (start > end, e.g. 22:00-06:00). Start inclusive, end exclusive. Pure + exported.
export function inWindow(start: number, end: number, minutes: number): boolean {
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// Current wall-clock minutes-from-midnight in an IANA zone (null = server timezone).
function localMinutes(tz: string | null, now: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz ?? undefined,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const h = Number(p.find((x) => x.type === "hour")?.value) % 24; // ICU can emit "24" at midnight
  return h * 60 + Number(p.find((x) => x.type === "minute")?.value);
}

export function snoozing(sn: SnoozeState, now = new Date()): boolean {
  return sn.enabled && inWindow(sn.start, sn.end, localMinutes(sn.tz, now));
}

export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function snoozeWindow(sn: SnoozeState): string | null {
  return sn.enabled ? `${hhmm(sn.start)}–${hhmm(sn.end)}${sn.tz ? ` ${sn.tz}` : ""}` : null;
}

// Minutes silenced per day (0 when disabled). start !== end is enforced at
// validation, so an enabled window is always 1..1439. Feeds the UI projection.
export function snoozeMinutes(sn: SnoozeState): number {
  return sn.enabled ? (sn.end - sn.start + 1440) % 1440 : 0;
}

// Minutes of [0, nowMin) that fall inside the snooze window. Two cases because a window with
// start > end is really two spans: [start, 1440) and [0, end).
function snoozedBefore(sn: SnoozeState, nowMin: number): number {
  if (!sn.enabled) return 0;
  if (sn.start < sn.end) return Math.max(0, Math.min(nowMin, sn.end) - sn.start);
  return Math.min(nowMin, sn.end) + Math.max(0, nowMin - sn.start);
}

// How much of today's POLLABLE time is already gone, in [0, 1]. Not wall-clock elapsed:
// a user snoozing 22:00-06:00 has 960 pollable minutes, so at noon they are 37.5% through
// their polling day, not 50% through the clock. The governor divides by this to get budget
// pace, and measuring it against the clock instead would read a snoozing user as behind pace
// every morning and never throttle them. Pure + exported for tests.
export function activeFracElapsed(sn: SnoozeState, nowMin: number): number {
  const total = 1440 - snoozeMinutes(sn);
  if (total <= 0) return 1; // snoozed around the clock: nothing polls, so pace is moot
  const elapsed = nowMin - snoozedBefore(sn, nowMin);
  return Math.min(1, Math.max(0, elapsed / total));
}

// Same, read off the clock in the user's own zone. Separate from the pure function so callers
// don't need localMinutes, and so the pace tests can pin a minute without faking time.
export function activeFracNow(sn: SnoozeState, now = new Date()): number {
  return activeFracElapsed(sn, localMinutes(sn.tz, now));
}
