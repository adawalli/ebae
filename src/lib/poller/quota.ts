import { sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { apiUsage } from "@/lib/schema";
import type { UserCtx } from "./state";

// A per-user ceiling, not a per-deployment one: each user brings their own eBay app, so each
// gets their own 5000/day to spend.
export const QUOTA_CEILING = Number(process.env.EBAY_DAILY_QUOTA ?? 5000);

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
