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

// Pollable minutes in the user's day: 1440 minus their snooze window. null falls back to
// SNOOZE_DEFAULT so a user with no snooze still yields a full day - loop.ts previously inlined
// `1440 - snoozeMinutes(u.snooze)` and dropped that fallback, so the two could disagree.
export function activeMin(sn: SnoozeState | null): number {
  return 1440 - snoozeMinutes(sn ?? SNOOZE_DEFAULT);
}

// Minutes of [0, nowMin) that fall inside the snooze window. Two cases because a window with
// start > end is really two spans: [start, 1440) and [0, end).
function snoozedBefore(sn: SnoozeState, nowMin: number): number {
  if (!sn.enabled) return 0;
  if (sn.start < sn.end) return Math.max(0, Math.min(nowMin, sn.end) - sn.start);
  return Math.min(nowMin, sn.end) + Math.max(0, nowMin - sn.start);
}

// How much of the user's own POLLABLE day is already gone, in [0, 1]. Not wall-clock elapsed:
// a user snoozing 22:00-06:00 has 960 pollable minutes, so at noon they are 37.5% through
// their polling day, not 50% through the clock - measuring against the clock instead would read
// a snoozing user as behind pace every morning and never throttle them. Nothing paces off this
// directly (the counter's day is the one that matters, below); it stays as the reference the
// counter-day form reduces to when the two zones agree.
export function activeFracElapsed(sn: SnoozeState, nowMin: number): number {
  const total = 1440 - snoozeMinutes(sn);
  if (total <= 0) return 1; // snoozed around the clock: nothing polls, so pace is moot
  const elapsed = nowMin - snoozedBefore(sn, nowMin);
  return Math.min(1, Math.max(0, elapsed / total));
}

// How much of the POLLABLE time in the *counter's* day is gone. Same quantity as
// activeFracElapsed, measured from a different origin: the daily call counter rolls on the
// server's calendar day (loop.ts), while the snooze window is in the user's own zone. When those
// zones differ, activeFracElapsed starts the clock at the user's midnight and gives no credit for
// spend the counter has already banked - a user 4h behind the server reads 663/1080 of the way
// through their day while the counter holds 903/1080 worth of calls. Everything that judges the
// counter against a fraction has to use this one, or it compares two different 24h windows.
//
// A day holds the same pollable total wherever it starts, so only the origin moves: serverMin is
// how long ago the counter rolled, which puts that rollover at local minute nowMin - serverMin.
// Pure + exported for tests; identical to activeFracElapsed when the zones agree.
export function counterDayFracAt(sn: SnoozeState, nowMin: number, serverMin: number): number {
  const total = 1440 - snoozeMinutes(sn);
  if (total <= 0) return 1; // snoozed around the clock: nothing polls, so pace is moot
  const active = (m: number) => m - snoozedBefore(sn, m);
  const rolledAt = (nowMin - serverMin + 1440) % 1440;
  const elapsed = (active(nowMin) - active(rolledAt) + total) % total;
  return Math.min(1, Math.max(0, elapsed / total));
}

export function counterDayFrac(sn: SnoozeState, now = new Date()): number {
  return counterDayFracAt(sn, localMinutes(sn.tz, now), now.getHours() * 60 + now.getMinutes());
}
