import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { db } from "@/lib/db";
import { conditionExcluded, mockMarket, sampleMarket } from "@/lib/ebay";
import { splitExcludeTerms } from "@/lib/exclude-terms";
import { alerts, searches } from "@/lib/schema";
import { QUOTA_CEILING, flushCalls } from "./quota";
import { type Entry, type UserCtx, message, plog, recordError } from "./state";

const MARKET_SAMPLE_HOURS = Number(process.env.MARKET_SAMPLE_HOURS ?? 24);

// Baselines a band-limited search takes per day. Exported on its own so the new-search preview
// can price a search that doesn't exist yet (see status()), where the gate below has nothing to
// read. At the default 24h gap this is 1.
export const MARKET_SAMPLES_PER_DAY = Math.max(1, Math.round(24 / MARKET_SAMPLE_HOURS));

// Calls a day one search spends on market baselines. Zero unless it has both a floor and a
// cap - the same gate maybeSampleMarket applies below, kept next to it so the quota projection
// and the poller can't disagree about which searches cost extra.
export function marketSamplesPerDay(s: { priceFloor: number | null; priceCap: number | null }): number {
  return s.priceFloor == null || s.priceCap == null ? 0 : MARKET_SAMPLES_PER_DAY;
}

// A listing's title matches one of the search's exclude terms (comma/newline
// separated, case-insensitive substring). No terms -> never excluded. The Browse
// API has no negative-keyword support, so this suppression is client-side. Pure +
// exported for tests.
export function excludeMatch(title: string, excludeTerms: string | null): boolean {
  if (!excludeTerms) return false;
  const t = title.toLowerCase();
  return splitExcludeTerms(excludeTerms).some((term) => t.includes(term.toLowerCase()));
}

// Median of a numeric list (mean of the two middles on an even count); null on
// empty. Powers the "typical price" deal-context in alert embeds. Pure + exported.
export function median(nums: number[]): number | null {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

// Median + sample size of a search's recent priced alerts (the in-band "recent" basis).
// Runs on the connection the poll writes already opened (alerting ticks only), so it
// never breaks the DB-free steady state. The basis label is decided at the call site,
// which prefers the search's market baseline when one is set (see pollOnce).
export async function priceContext(
  database: ReturnType<typeof db>,
  searchId: number,
): Promise<{ typical: number | null; count: number }> {
  const rows = await database
    .select({ price: alerts.price })
    .from(alerts)
    .where(and(eq(alerts.searchId, searchId), isNotNull(alerts.price)))
    .orderBy(desc(alerts.createdAt))
    .limit(20);
  const prices = rows.map((r) => r.price).filter((p): p is number => p != null);
  return { typical: median(prices), count: prices.length };
}

// Best-effort daily market baseline: a cap-removed (floor-kept) sample of the same item
// criteria, so a band-limited search can compare an alert against the true market median
// instead of only its own in-band alerts. Self-throttled to once/MARKET_SAMPLE_HOURS per
// search, quota-guarded, and fully isolated (own try/catch) so a failure here never backs
// off the main poll.
export async function maybeSampleMarket(e: Entry, u: UserCtx, database: ReturnType<typeof db>) {
  const s = e.s;
  // Only searches with BOTH a floor and a cap get a baseline. The floor filters accessory
  // noise out of the sample (see marketSampleSearch); the cap is the ceiling the sample exists
  // to see past. Floor-less searches would sample junk; cap-less searches already see the full
  // upper market via their in-band alerts, so a sample would just burn quota.
  if (s.priceFloor == null || s.priceCap == null) return;
  if (s.marketSampledAt && Date.now() - Date.parse(s.marketSampledAt) < MARKET_SAMPLE_HOURS * 3600_000) return;
  if (u.calls.used >= QUOTA_CEILING) return; // don't spend the last of the owner's budget on a baseline
  try {
    u.calls.used++;
    // Same mode gate as the poll that called us: pollOnce already returned for a user with
    // nothing to poll with, so this is live-or-mock.
    const items = u.ebay ? await sampleMarket(u.ebay, s) : mockMarket(s);
    const prices = items
      .filter((i) => !excludeMatch(i.title, s.excludeTerms) && !conditionExcluded(i, s.conditions))
      .map((i) => i.price)
      .filter((p): p is number => p != null);
    const m = median(prices);
    const sampledAt = new Date();
    await database.update(searches).set({ marketMedian: m, marketSampledAt: sampledAt }).where(eq(searches.id, s.id));
    s.marketMedian = m;
    s.marketSampledAt = sampledAt.toISOString();
    await flushCalls(database, u.id, u.calls); // piggyback the +1 eBay call we just spent
    plog.info({ searchId: s.id, q: s.q, sample: prices.length, marketMedian: m }, "market sampled");
  } catch (err) {
    recordError(u.id, s.q, `market sample: ${message(err)}`); // warn only; the main poll keeps its cadence
  }
}
