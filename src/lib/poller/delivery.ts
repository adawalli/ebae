import { and, asc, inArray, isNull, lte, lt, max, sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { notify } from "@/lib/discord";
import { notifyPush } from "@/lib/push";
import { alerts, pushSubs } from "@/lib/schema";
import type { Item, PriceContext } from "@/lib/types";
import {
  NOTIFY_DEADLINE_MS,
  type UserCtx,
  discordWebhooks,
  markStalePush,
  message,
  plog,
  recordError,
  state,
} from "./state";

// An alert that couldn't be delivered is retried at the next boot, but deals are time-sensitive:
// past this age, retire it unsent rather than spam stale listings when the process comes back.
const REDELIVER_MAX_AGE_MS = 60 * 60_000;

// A page is bounded by both rows and elapsed time. The cursor moves past failed sends so one
// dead destination cannot starve later alerts; failed rows remain pending for the next boot.
const REDELIVER_FETCH_LIMIT = 1000;
const REDELIVER_PAGE_DELAY_MS = 15_000;

type RedeliveryCursor = { createdAt: string; id: number };
type RedeliveryProgress = { cursor: RedeliveryCursor | null; complete: boolean };

// Capture before the poll timers start. Later pages stay below this ID, so a live alert that is
// still being delivered can never enter the recovery sweep.
export async function capturePendingAlertCutoff(database: ReturnType<typeof db>): Promise<number> {
  if (process.env.NODE_ENV === "development") return 0;
  const [row] = await database.select({ id: max(alerts.id) }).from(alerts);
  return row?.id ?? 0;
}

// Schedule each page only after the previous one finishes. This keeps pages from overlapping and
// stops after the boot-time backlog has had one attempt.
export function startRedeliveryDrain(database: ReturnType<typeof db>, cutoffId: number) {
  if (cutoffId <= 0) return;
  let cursor: RedeliveryCursor | null = null;
  const run = async () => {
    try {
      const progress = await redeliverPending(database, cutoffId, cursor);
      cursor = progress.cursor;
      if (progress.complete) return;
    } catch (err) {
      recordError(null, null, `redeliver on boot: ${message(err)}`);
      // Keep the previous cursor until the page and its delivery flush succeed.
    }
    const timer = setTimeout(run, REDELIVER_PAGE_DELAY_MS);
    timer.unref?.();
  };
  const timer = setTimeout(run, REDELIVER_PAGE_DELAY_MS);
  timer.unref?.();
}

export const NOTHING_SENT = { error: null, anyDelivered: false } as const;
export const NOTHING_PUSHED = { error: null, anyDelivered: false, dead: [] as readonly string[] } as const;

// Drop subscriptions the push service says are gone for good (404/410 only - see push.ts).
// Reassigns u.push rather than mutating it, matching reload's swap discipline; callers
// holding a pinned copy of the list have to narrow it themselves. Never throws: losing a
// reap is a retry next tick, not a lost alert.
export async function reapPush(database: ReturnType<typeof db>, u: UserCtx, dead: readonly string[]) {
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

export async function redeliverPending(
  database: ReturnType<typeof db>,
  cutoffId: number,
  cursor: RedeliveryCursor | null = null,
): Promise<RedeliveryProgress> {
  if (process.env.NODE_ENV === "development" || cutoffId <= 0) return { cursor: null, complete: true };
  const st = state();
  const sweepStart = Date.now();
  const now = new Date(); // one stamp for this page's delivered rows

  // Retire alerts that aged out while earlier pages were running, fenced to the startup backlog.
  await database
    .update(alerts)
    .set({ deliveredAt: now })
    .where(
      and(
        isNull(alerts.deliveredAt),
        lte(alerts.id, cutoffId),
        lt(alerts.createdAt, sql`now() - (${REDELIVER_MAX_AGE_MS / 60_000} * interval '1 minute')`),
      ),
    );

  // Select timestamp text to keep PostgreSQL's microseconds in the keyset cursor.
  const afterCursor = cursor
    ? sql`(${alerts.createdAt}, ${alerts.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id})`
    : undefined;
  const rows = await database
    .select({
      id: alerts.id,
      createdAt: sql<string>`${alerts.createdAt}::text`.as("createdAt"),
      searchId: alerts.searchId,
      searchQ: alerts.searchQ,
      searchName: alerts.searchName,
      itemId: alerts.itemId,
      title: alerts.title,
      price: alerts.price,
      currency: alerts.currency,
      shippingCost: alerts.shippingCost,
      buyingOption: alerts.buyingOption,
      condition: alerts.condition,
      imageUrl: alerts.imageUrl,
      itemUrl: alerts.itemUrl,
      kind: alerts.kind,
      previousPrice: alerts.previousPrice,
    })
    .from(alerts)
    .where(and(isNull(alerts.deliveredAt), lte(alerts.id, cutoffId), afterCursor))
    .orderBy(asc(alerts.createdAt), asc(alerts.id))
    .limit(REDELIVER_FETCH_LIMIT);

  if (!rows.length) return { cursor: null, complete: true };

  // Confirm every retired/delivered row in one UPDATE after the loop instead of one round-trip
  // per row (a boot backlog shouldn't fan out N queries against a serverless DB). A crash mid-loop
  // just re-posts the confirmed-but-unflushed rows next boot, which is the same at-least-once
  // window the main path already accepts.
  const done: number[] = [];
  let nextCursor = cursor;
  let processed = 0;
  for (const row of rows) {
    // Always attempt the first row so a slow SELECT still makes progress; after that the page
    // stops at the same deadline used for fresh notifications, with one row's fan-out as residual.
    if (processed && Date.now() - sweepStart >= NOTIFY_DEADLINE_MS) break;
    processed++;
    nextCursor = { createdAt: row.createdAt, id: row.id };
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
    const webhooks = u ? discordWebhooks(s, u) : [];
    if (!u || (!webhooks.length && !u.push.length)) {
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
      // Same story: poll-time only. Tracking was already decided when this alert was written.
      itemEndDate: null,
      bestOffer: false,
    };
    // Only the market baseline is reconstructable here (the recent-alert median needs the
    // pre-batch snapshot, long gone); without one the embed just omits the deal line.
    const market = s.marketMedian;
    const ctx: PriceContext | undefined =
      market != null && market > 0 ? { typical: market, count: 0, basis: "market" } : undefined;
    const alertSearch = { ...s, q: row.searchQ, name: row.searchName };
    const [d, p] = await Promise.all([
      webhooks.length
        ? notify(item, alertSearch, webhooks, ctx, { kind: row.kind, previousPrice: row.previousPrice })
        : NOTHING_SENT,
      u.push.length
        ? notifyPush(item, alertSearch, u.push, { kind: row.kind, previousPrice: row.previousPrice })
        : NOTHING_PUSHED,
    ]);
    // Log any failure even on partial success (matches the main-path notify, which records the
    // error independently of anyDelivered); confirm the row if a target took it, else leave it
    // null to retry next boot.
    if (d.error) recordError(u.id, alertSearch, `redeliver: ${d.error}`, "error");
    if (p.error) recordError(u.id, alertSearch, `redeliver: ${p.error}`, "error");
    if (p.dead.length) await reapPush(database, u, p.dead);
    if (d.anyDelivered || p.anyDelivered) done.push(row.id);
  }
  if (done.length) await database.update(alerts).set({ deliveredAt: now }).where(inArray(alerts.id, done));
  const complete = processed === rows.length && rows.length < REDELIVER_FETCH_LIMIT;
  return { cursor: complete ? null : nextCursor, complete };
}
