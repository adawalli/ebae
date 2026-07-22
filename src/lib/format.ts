import { SOLD_MIN_COUNT, type SearchStats } from "@/lib/types";

export const fmt = (n: number) => n.toLocaleString("en-US");
// Projected polls/day. Snooze silences a daily window, so poll over active
// minutes (1440 minus the snoozed span), not the whole day.
export const callsFor = (interval: number, activeMin = 1440) => Math.round(activeMin / interval);

// Surplus worth showing. Below half a percent of the ceiling the bar segment is sub-pixel, so
// its swatch and legend entry buy nothing and split `spent` into two numbers the reader has to
// add back. Both surfaces gate on this so their `configured` totals agree.
export const shownSurplus = (surplus: number, ceiling: number) => (surplus / ceiling >= 0.005 ? surplus : 0);

export function money(n: number | null, currency = "USD") {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

export function priceSummary(
  s: Pick<SearchStats, "marketMedian" | "soldMedian" | "soldSampleCount" | "trackSold">,
  currency?: string,
) {
  if (s.trackSold && s.soldMedian != null) return ` · sold ~${money(s.soldMedian, currency)}`;
  const market = s.marketMedian != null ? ` · market ~${money(s.marketMedian, currency)}` : "";
  const progress = s.trackSold && s.soldSampleCount > 0 ? ` · sold ${s.soldSampleCount}/${SOLD_MIN_COUNT}` : "";
  return `${market}${progress}`;
}

export function soldProgressTooltip(s: Pick<SearchStats, "soldMedian" | "soldSampleCount" | "trackSold">) {
  if (!s.trackSold || s.soldMedian != null || s.soldSampleCount === 0) return null;
  return `${s.soldSampleCount} of ${SOLD_MIN_COUNT} recent eligible sales collected. ${SOLD_MIN_COUNT} are needed before ebae uses a sold-price median.`;
}

export function ago(iso: string, compact = false) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return compact ? `${m}m ago` : `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return compact ? `${h}h ago` : `${h} hr ago`;
  const d = Math.floor(h / 24);
  return compact ? `${d}d ago` : `${d} day${d > 1 ? "s" : ""} ago`;
}

export function duration(fromIso: string) {
  const s = Math.max(0, (Date.now() - new Date(fromIso).getTime()) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

export function until(iso: string) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return "now";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
}
