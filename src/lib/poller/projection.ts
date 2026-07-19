import { callsFor } from "@/lib/format";
import { marketSamplesPerDay } from "./market";
import type { Entry } from "./state";
import type { Search } from "@/lib/types";

// Sold-price checks a search will spend in the next 24h. Exact rather than modelled: every
// followed listing already carries the moment it comes due, so this is a count, not a rate.
// Zero for a search that isn't tracking, matching the gate runDueChecks applies - otherwise a
// toggled-off search would keep projecting checks its polls will never run.
export function checksDue24h(e: Entry): number {
  const horizon = Date.now() + 86400_000;
  if (!e.s.trackSold) return 0;
  let n = 0;
  for (const t of e.tracked.values()) {
    if (t.nextCheckAt <= horizon) n++;
  }
  return n;
}

// What a saved search costs a day from its configuration alone. Kept separate from the entry
// version below because the new-search preview has to price a search that doesn't exist yet,
// and so has no entry to read follows from (see status()).
export function callsPerDayFor(s: Pick<Search, "intervalMin" | "priceFloor" | "priceCap">, activeMin: number): number {
  return callsFor(s.intervalMin, activeMin) + marketSamplesPerDay(s);
}

// What one live search costs a day, everything included. The governor stretches intervals
// against this number, so a call class missing here is one nothing budgets for.
export function callsPerDayForEntry(e: Entry, activeMin: number): number {
  return callsPerDayFor(e.s, activeMin) + checksDue24h(e);
}

export function projectedCalls(entries: Entry[], activeMin: number): number {
  return entries.reduce((n, e) => n + callsPerDayForEntry(e, activeMin), 0);
}
