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
