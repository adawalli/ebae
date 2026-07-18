import { and, inArray, isNull, lt, sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { notify } from "@/lib/discord";
import { notifyPush } from "@/lib/push";
import { alerts, pushSubs } from "@/lib/schema";
import type { Item, PriceContext } from "@/lib/types";
import { type UserCtx, markStalePush, plog, recordError, state } from "./state";

// An alert that couldn't be delivered is retried at the next boot, but deals are time-sensitive:
// past this age, retire it unsent rather than spam stale listings when the process comes back.
const REDELIVER_MAX_AGE_MS = 60 * 60_000;

// Redeliver alerts committed but never confirmed delivered - a crash between the alerts insert
// and the notify, or a webhook outage that spanned the last shutdown. Called once at boot, before
// any tick fires, so it never races the main-path delivery loop (disjoint row sets, no shared
// mutable flag). A row counts as delivered once ANY channel accepts it (notify.anyDelivered), so a
// retry never re-posts to a channel that already has it. Rows older than REDELIVER_MAX_AGE_MS are
// retired unsent (a deal that stale isn't worth sending); anything still null is retried next boot.
// Stand-ins for a sender with nothing to send, so the two delivery paths can always be
// awaited as a pair without branching the result handling.
export const NOTHING_SENT = { error: null, anyDelivered: false } as const;
export const NOTHING_PUSHED = { error: null, anyDelivered: false, dead: [] as string[] } as const;

// Drop subscriptions the push service says are gone for good (404/410 only - see push.ts).
// Reassigns u.push rather than mutating it, matching reload's swap discipline; callers
// holding a pinned copy of the list have to narrow it themselves. Never throws: losing a
// reap is a retry next tick, not a lost alert.
export async function reapPush(database: ReturnType<typeof db>, u: UserCtx, dead: string[]) {
  const gone = new Set(dead);
  u.push = u.push.filter((p) => !gone.has(p.endpoint));
  // Before the delete, and kept even if it fails: this is what stops the client re-adding
  // the row on its next load, and it has to outlive the row either way.
  markStalePush(dead);
  try {
    await database.delete(pushSubs).where(inArray(pushSubs.endpoint, dead));
    plog.info({ userId: u.id, count: dead.length }, "reaped expired push subscriptions");
  } catch (err) {
    plog.warn({ err, userId: u.id }, "push reap failed");
  }
}

export async function redeliverPending(database: ReturnType<typeof db>) {
  const st = state();
  const now = new Date(); // one stamp for the whole sweep, so the DB shows they came from one boot
  await database
    .update(alerts)
    .set({ deliveredAt: now })
    .where(
      and(
        isNull(alerts.deliveredAt),
        lt(alerts.createdAt, sql`now() - (${REDELIVER_MAX_AGE_MS / 60_000} * interval '1 minute')`),
      ),
    );

  const rows = await database
    .select({
      id: alerts.id,
      searchId: alerts.searchId,
      itemId: alerts.itemId,
      title: alerts.title,
      price: alerts.price,
      currency: alerts.currency,
      shippingCost: alerts.shippingCost,
      buyingOption: alerts.buyingOption,
      condition: alerts.condition,
      imageUrl: alerts.imageUrl,
      itemUrl: alerts.itemUrl,
    })
    .from(alerts)
    .where(isNull(alerts.deliveredAt));

  if (!rows.length) return;

  // Confirm every retired/delivered row in one UPDATE after the loop instead of one round-trip
  // per row (a boot backlog shouldn't fan out N queries against a serverless DB). A crash mid-loop
  // just re-posts the confirmed-but-unflushed rows next boot, which is the same at-least-once
  // window the main path already accepts.
  const done: number[] = [];
  for (const row of rows) {
    const s = row.searchId != null ? st.entries.get(row.searchId)?.s : undefined;
    if (!s) {
      // search deleted (search_id null) or gone from cache: no criteria to attach, retire it.
      done.push(row.id);
      continue;
    }
    // The alert belongs to the search's owner, so it goes to their channels and nobody else's.
    // Nothing to deliver to (no channels, or the owner is gone): retire the row so it doesn't
    // linger across boots.
    // Age-independent, unlike the UPDATE above: a row with nowhere to go is retired at any age,
    // because there is no future boot at which it could be delivered.
    const u = st.users.get(s.userId);
    if (!u || (!u.channels.length && !u.push.length)) {
      done.push(row.id);
      continue;
    }
    const item: Item = {
      itemId: row.itemId,
      title: row.title,
      price: row.price,
      currency: row.currency,
      shippingCost: row.shippingCost,
      buyingOption: row.buyingOption as Item["buyingOption"],
      condition: row.condition,
      // Not persisted (no column), so suppression can't be re-evaluated here - this row already
      // passed it under the settings in force when it was written. A pending for-parts alert
      // therefore still sends if the search switched to NOT_PARTS before this boot; that needs a
      // condition_id column to fix, which isn't worth a migration for a <1h redelivery window.
      conditionId: null,
      imageUrl: row.imageUrl,
      itemUrl: row.itemUrl,
    };
    // Only the market baseline is reconstructable here (the recent-alert median needs the
    // pre-batch snapshot, long gone); without one the embed just omits the deal line.
    const market = s.marketMedian;
    const ctx: PriceContext | undefined =
      market != null && market > 0 ? { typical: market, count: 0, basis: "market" } : undefined;
    const [d, p] = await Promise.all([
      u.channels.length ? notify(item, s, u.channels, ctx) : NOTHING_SENT,
      u.push.length ? notifyPush(item, s, u.push) : NOTHING_PUSHED,
    ]);
    // Log any failure even on partial success (matches the main-path notify, which records the
    // error independently of anyDelivered); confirm the row if a target took it, else leave it
    // null to retry next boot.
    if (d.error) recordError(u.id, s.q, `redeliver: ${d.error}`, "error");
    if (p.error) recordError(u.id, s.q, `redeliver: ${p.error}`, "error");
    if (p.dead.length) await reapPush(database, u, p.dead);
    if (d.anyDelivered || p.anyDelivered) done.push(row.id);
  }
  if (done.length) await database.update(alerts).set({ deliveredAt: now }).where(inArray(alerts.id, done));
}
