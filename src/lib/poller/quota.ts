import { sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { apiUsage } from "@/lib/schema";
import { activeFracNow } from "./snooze";
import { type UserCtx, plog } from "./state";

// A per-user ceiling, not a per-deployment one: each user brings their own eBay app, so each
// gets their own 5000/day to spend.
export const QUOTA_CEILING = Number(process.env.EBAY_DAILY_QUOTA ?? 5000);

// ---------- budget governor ----------
// Stretches poll intervals when a user's spend is on track to exhaust the daily budget before
// the day is over, so the ceiling is approached gradually instead of hit at noon and leaving
// the rest of the day dark. Slow-down only: every factor below is >= 1, so a search can never
// poll faster than the interval its owner set. The hard cliff in pollOnce stays as the backstop.

export const GOV_MAX_FACTOR = 4; // never slower than 4x the user's interval
export const GOV_MIN_SPEND = 0.05; // inert until 5% of the ceiling is spent

// The exact correction needed to land on the ceiling at the end of the day, rather than a
// threshold and a ramp: divide the spend the rest of the day would naturally cost at the
// current rate by the budget actually left for it. That ratio is 1 precisely when the user is
// on track, which is what makes the central guarantee true - a configuration that lands on the
// ceiling at 23:59 is using its budget perfectly and is never slowed by so much as a second.
// Above 1 it slows by exactly the shortfall, and being recomputed every poll it self-corrects
// as the day goes on, so there is no need to brake early "just in case" and waste budget the
// user is entitled to spend. Pure + exported for tests.
export function governorFactor(used: number, ceiling: number, activeFrac: number): number {
  if (ceiling <= 0 || activeFrac <= 0) return 1;
  // Just after the local midnight reset activeFrac is near zero, so a handful of calls project
  // out to an enormous full-day rate and would slam every search to the cap for no reason.
  // Stay inert until enough of the budget is gone for the projection to mean anything.
  if (used < GOV_MIN_SPEND * ceiling) return 1;
  const budgetLeft = ceiling - used;
  if (budgetLeft <= 0) return GOV_MAX_FACTOR; // spent: the hard cliff is already the operative limit
  const naturalSpendLeft = (used / activeFrac) * (1 - activeFrac);
  const factor = Math.min(Math.max(naturalSpendLeft / budgetLeft, 1), GOV_MAX_FACTOR);
  // Quantized because the division leaves an exactly-on-budget user at 1.0000000000000009,
  // and anything above 1 reads as engaged - lighting the badge for the one user the guarantee
  // above promises never to touch. Three decimals is far finer than any delay this feeds.
  return Math.round(factor * 1000) / 1000;
}

// factor >= 1 always, so this is never below the user's configured interval.
export function governedDelayMs(intervalMin: number, factor: number): number {
  return Math.round(intervalMin * 60_000 * factor);
}

// One user's factor right now, off their in-memory counter and their own local clock. No DB
// read and no persistence - it's derived state, recomputed per reschedule, so the steady-state
// no-op poll stays DB-free (DESIGN.md §4). Logs each engage/release flip so a self-hoster can
// tell why their polling slowed down; plog.info rather than recordError because the governor
// doing its job is not a fault to surface in the UI error list.
export function governorFor(u: UserCtx, now = new Date()): number {
  const factor = governorFactor(u.calls.used, QUOTA_CEILING, activeFracNow(u.snooze, now));
  const engaged = factor > 1;
  if (engaged !== u.governorEngaged) {
    u.governorEngaged = engaged;
    plog.info(
      { userId: u.id, factor, used: u.calls.used, ceiling: QUOTA_CEILING },
      engaged ? "quota governor engaged" : "quota governor released",
    );
  }
  return factor;
}

// Merge a persisted daily count with the in-memory one. Memory is authoritative
// mid-run (it holds increments not yet flushed), so on a live refresh keep the
// larger; a fresh boot has memory 0 and adopts the DB value; a day rollover
// discards a stale prior-day DB count. Pure + exported so it's unit-testable.
export function mergeCalls(cur: UserCtx["calls"], today: string, dbUsed: number): UserCtx["calls"] {
  if (cur.date === today) return { date: today, used: Math.max(cur.used, dbUsed) };
  return { date: today, used: dbUsed };
}

// Persists one user's daily eBay call count. Returns the greatest()-reconciled value from
// the DB so callers can sync in-memory state without a separate SELECT.
export async function flushCalls(
  database: ReturnType<typeof db>,
  userId: number,
  calls: UserCtx["calls"],
): Promise<number> {
  const [row] = await database
    .insert(apiUsage)
    .values({ userId, day: calls.date, used: calls.used })
    .onConflictDoUpdate({
      target: [apiUsage.userId, apiUsage.day],
      set: { used: sql`greatest(${apiUsage.used}, ${calls.used})` },
    })
    .returning({ used: apiUsage.used });
  return row?.used ?? calls.used;
}
