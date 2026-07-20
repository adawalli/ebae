import { sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { apiUsage } from "@/lib/schema";
import { activeFracNow } from "./snooze";
import { type UserCtx, plog } from "./state";

// A per-user ceiling, not a per-deployment one: each user brings their own eBay app, so each
// gets their own 5000/day to spend.
export const QUOTA_CEILING = Number(process.env.EBAY_DAILY_QUOTA ?? 5000);

// ---------- budget governor ----------
// Stretches poll intervals when the current saved configuration needs more calls than are left
// today. Slow-down only: every factor below is >= 1, so a search can never poll faster than the
// interval its owner set. The hard cliff in pollOnce stays as the backstop.

export const GOV_MAX_FACTOR = 4; // never slower than 4x the user's interval
export const GOV_MIN_SPEND = 0.05; // inert until 5% of the ceiling is spent
export const GOV_RELEASE_HEADROOM = 0.05;

// Divide the work still scheduled at the saved intervals by the budget left today. Above 1,
// slow by exactly the shortfall. The current projection matters: interval, pause, and snooze
// edits replace the old plan immediately instead of being judged by historical call rate.
function requiredGovernorFactor(used: number, ceiling: number, activeFrac: number, projected: number): number {
  if (ceiling <= 0 || activeFrac <= 0) return 1;
  // Just after the local midnight reset activeFrac is near zero, so a handful of calls project
  // out to an enormous full-day rate and would slam every search to the cap for no reason.
  // Stay inert until enough of the budget is gone for the projection to mean anything.
  if (used < GOV_MIN_SPEND * ceiling) return 1;
  const budgetLeft = ceiling - used;
  if (budgetLeft <= 0) return GOV_MAX_FACTOR; // spent: the hard cliff is already the operative limit
  const naturalSpendLeft = projected * (1 - activeFrac);
  return naturalSpendLeft / budgetLeft;
}

// Omitted projection preserves the historical-rate calculation for existing pure callers. The
// governor itself always passes the saved searches' current daily projection.
export function governorFactor(
  used: number,
  ceiling: number,
  activeFrac: number,
  projected = used / activeFrac,
): number {
  const factor = Math.min(Math.max(requiredGovernorFactor(used, ceiling, activeFrac, projected), 1), GOV_MAX_FACTOR);
  // Quantized because the division leaves an exactly-on-budget user at 1.0000000000000009,
  // and anything above 1 reads as engaged - lighting the badge for the one user the guarantee
  // above promises never to touch. Three decimals is far finer than any delay this feeds.
  return Math.round(factor * 1000) / 1000;
}

// ---------- surplus budget ----------
// The mirror image of the governor: it slows a user who needs more calls than they have left,
// this hands calls to a user who has more than their configuration will ever use. Unspent quota
// expires at local midnight, so the alternative to spending it is throwing it away.

export const BONUS_HEADROOM = 0.05; // fraction of the ceiling the surplus never touches

// Calls that can be spent on extra work right now without ever costing the saved configuration
// a poll. Two bounds, both necessary:
//
//   reserve - what the current configuration still needs for the rest of the day (the same
//             expression the governor projects against). Staying above it is what guarantees
//             requiredGovernorFactor stays below 1 after the surplus is spent, so a user can
//             never be throttled for having accepted bonus work.
//   pace    - surplus is released in proportion to the pollable day already elapsed, so it
//             trickles out all day instead of being dumped the moment it's identified. Near
//             midnight activeFrac is ~0, which also makes this the min-spend guard the governor
//             needs GOV_MIN_SPEND for.
//
// The headroom absorbs the overshoot from concurrent ticks: several of one user's searches can
// each read the same budget before any of them bills, and each spends at most MAX_CHECKS_PER_TICK.
export function bonusBudget(used: number, ceiling: number, activeFrac: number, projected: number): number {
  if (ceiling <= 0 || activeFrac <= 0) return 0;
  const headroom = Math.ceil(BONUS_HEADROOM * ceiling);
  const reserve = Math.ceil(projected * (1 - activeFrac));
  const hard = ceiling - used - reserve - headroom;
  const pace = Math.floor(activeFrac * (ceiling - headroom)) - used;
  return Math.max(0, Math.min(hard, pace));
}

// The fraction of the day the surplus is allowed to pace against. Two clocks meet here:
// activeFrac is measured in the user's own zone (their snooze window is theirs), but the counter
// the surplus spends from rolls on the server's calendar day. A user whose zone runs ahead of
// the server's would look most of the way through their day at the instant their budget resets,
// and the pace bound would hand over the whole surplus in the first hour of a day it then has to
// last. Take whichever day is less far along - that only ever spends less.
export function surplusFrac(activeFrac: number, now: Date): number {
  return Math.min(activeFrac, (now.getHours() * 60 + now.getMinutes()) / 1440);
}

export function governorDecision(
  used: number,
  ceiling: number,
  activeFrac: number,
  projected: number,
  engaged: boolean,
): { active: boolean; factor: number } {
  if (ceiling <= 0 || activeFrac <= 0 || used < GOV_MIN_SPEND * ceiling) return { active: false, factor: 1 };
  const required = requiredGovernorFactor(used, ceiling, activeFrac, projected);
  if (engaged && required <= 1 - GOV_RELEASE_HEADROOM) return { active: false, factor: 1 };
  if (!engaged && required <= 1) return { active: false, factor: 1 };
  return {
    active: true,
    factor: Math.round(Math.min(Math.max(required, 1 + GOV_RELEASE_HEADROOM), GOV_MAX_FACTOR) * 1000) / 1000,
  };
}

// factor >= 1 always, so this is never below the user's configured interval.
export function governedDelayMs(intervalMin: number, factor: number): number {
  return Math.round(intervalMin * 60_000 * factor);
}

// Today's spend, or 0 when the counter still holds a previous day's. The poll loop rolls the
// counter over itself before spending, so its own reads are always current - but every other
// reader (the status tile, the per-row factor) can land in the window between local midnight
// and that user's next poll, where the field still holds yesterday's total. Reading it raw
// there measures a full day of spend against a day that is minutes old, and the governor
// projects that to the cap. Read the counter through here, never off the field.
export function usedToday(calls: UserCtx["calls"], today = new Date().toDateString()): number {
  return calls.date === today ? calls.used : 0;
}

// The bonus-check share of usedToday, read through the same stale-date guard and for the same
// reason: the pair is only meaningful together, and a reader that trusted one field past
// midnight but not the other would report a surplus larger than the spend it came out of.
export function surplusToday(calls: UserCtx["calls"], today = new Date().toDateString()): number {
  return calls.date === today ? calls.surplus : 0;
}

// One user's factor right now, off their in-memory counter and their own local clock. No DB
// read and no persistence - it's derived state, recomputed per reschedule, so the steady-state
// no-op poll stays DB-free (DESIGN.md §4). Logs each engage/release flip so a self-hoster can
// tell why their polling slowed down; plog.info rather than recordError because the governor
// doing its job is not a fault to surface in the UI error list.
export function governorFor(u: UserCtx, projected: number, now = new Date()): number {
  const used = usedToday(u.calls, now.toDateString());
  const { factor, active: engaged } = governorDecision(
    used,
    QUOTA_CEILING,
    activeFracNow(u.snooze, now),
    projected,
    u.governorEngaged,
  );
  if (engaged !== u.governorEngaged) {
    u.governorEngaged = engaged;
    plog.info(
      { userId: u.id, factor, used, ceiling: QUOTA_CEILING },
      engaged ? "quota governor engaged" : "quota governor released",
    );
  }
  return factor;
}

// Merge a persisted daily count with the in-memory one. Memory is authoritative
// mid-run (it holds increments not yet flushed), so on a live refresh keep the
// larger; a fresh boot has memory 0 and adopts the DB value; a day rollover
// discards a stale prior-day DB count. Pure + exported so it's unit-testable.
// Per field rather than whole-record: a flush can land between the two increments of a bonus
// check, so the larger `used` and the larger `surplus` need not have come from the same side.
// Taking each independently is safe because both only ever climb within a day.
export function mergeCalls(
  cur: UserCtx["calls"],
  today: string,
  dbCalls: { used: number; surplus: number },
): UserCtx["calls"] {
  if (cur.date === today) {
    return { date: today, used: Math.max(cur.used, dbCalls.used), surplus: Math.max(cur.surplus, dbCalls.surplus) };
  }
  return { date: today, ...dbCalls };
}

// Persists one user's daily eBay call counts. Returns the greatest()-reconciled values from
// the DB so callers can sync in-memory state without a separate SELECT. One statement for both
// columns, so attributing the surplus costs no extra round-trip anywhere it is written.
export async function flushCalls(
  database: ReturnType<typeof db>,
  userId: number,
  calls: UserCtx["calls"],
): Promise<{ used: number; surplus: number }> {
  const [row] = await database
    .insert(apiUsage)
    .values({ userId, day: calls.date, used: calls.used, surplus: calls.surplus })
    .onConflictDoUpdate({
      target: [apiUsage.userId, apiUsage.day],
      set: {
        used: sql`greatest(${apiUsage.used}, ${calls.used})`,
        surplus: sql`greatest(${apiUsage.surplus}, ${calls.surplus})`,
      },
    })
    .returning({ used: apiUsage.used, surplus: apiUsage.surplus });
  return row ?? { used: calls.used, surplus: calls.surplus };
}
