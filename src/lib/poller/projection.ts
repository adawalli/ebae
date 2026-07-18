import { callsFor } from "@/lib/format";
import { marketSamplesPerDay } from "./market";
import type { Search } from "@/lib/types";

export function callsPerDayFor(s: Pick<Search, "intervalMin" | "priceFloor" | "priceCap">, activeMin: number): number {
  return callsFor(s.intervalMin, activeMin) + marketSamplesPerDay(s);
}

export function projectedCalls(rows: Search[], activeMin: number): number {
  return rows.reduce((n, s) => n + callsPerDayFor(s, activeMin), 0);
}
