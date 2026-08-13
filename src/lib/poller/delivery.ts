import { and, asc, inArray, isNull, lt, sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { notify } from "@/lib/discord";
import { notifyPush } from "@/lib/push";
import { alerts, pushSubs } from "@/lib/schema";
import type { Item, PriceContext } from "@/lib/types";
import { type UserCtx, markStalePush, plog, recordError, state } from "./state";

// An alert that couldn't be delivered is retried at the next boot, but deals are time-sensitive:
// past this age, retire it unsent rather than spam stale listings when the process comes back.
const REDELIVER_MAX_AGE_MS = 60 * 60_000;

// A memory bound only, not a time bound: keeps one boot from loading an unbounded backlog into
// memory in a single query. Deliberately generous - the wall-clock budget (bootRedeliverBudgetMs,
// checked in the loop below) is what actually keeps this sweep from wedging the boot heartbeat,
// regardless of how many rows this returns.
const REDELIVER_FETCH_LIMIT = 1000;

// This sweep runs at boot, after `st.ready = true` but before the first schedule() (see
// boot.ts) - deliberately, so a tick can't insert a fresh deliveredAt=null row the sweep's
// SELECT then double-notifies. That ordering means /api/health reads 503 ("heartbeat stale",
// lastScheduledAt null) for the sweep's whole duration, which puts it under the k8s liveness
// probe grace (deploy/k8s.yaml), NOT the steadier /api/health freshness window loop.ts's
// NOTIFY_DEADLINE_MS is calibrated against. Probe grace: failures land at t=30, 60, 90...
// (initialDelaySeconds, then every periodSeconds), so the 10th (failureThreshold) lands at
// 30 + 9x30 = 300s before kubelet restarts the pod - far tighter than the 35min health floor.
// (docker-compose.yml's healthcheck is looser and, without an orchestrator watching container
// health, doesn't restart the container at all under plain docker/compose, so it isn't the
// binding constraint here.)
//
// 300s isn't all ours: migrations, the snapshot cache reload, and Next.js startup all burn probe
// budget before this function ever runs, and one in-flight row's own fan-out (see
// ONE_ROW_WORST_CASE_MS) is unbudgeted by the deadline (checked before a row, never mid-row - see
// the residual below). A flat 3min deadline ignored both and could leave as little as ~55s for
// everything before the sweep, which is not real margin. bootRedeliverBudgetMs derives the
// budget from the REMAINING probe window instead: min(this ceiling, grace - elapsed - one row's
// worst case), floored at zero so a slow boot skips the sweep entirely rather than overrunning
// it - safe, since skipped rows just stay deliveredAt=null and retry oldest-first next boot,
// which is already the contract. 60s keeps the common-case (near-zero elapsed) budget well clear
// of BOTH the probe grace and the steady-state NOTIFY_DEADLINE_MS.
export const BOOT_REDELIVER_DEADLINE_MS = 60_000;
const PROBE_GRACE_MS = 300_000;
const ONE_ROW_WORST_CASE_MS = 65_000; // same 65s derivation as NOTIFY_DEADLINE_MS (see state.ts)

// Pure so it's unit-testable without a real boot: elapsedMs is process.uptime()*1000 at the
// caller. Exported for tests only - redeliverPending is the one real caller.
export function bootRedeliverBudgetMs(elapsedMs: number): number {
  return Math.max(0, Math.min(BOOT_REDELIVER_DEADLINE_MS, PROBE_GRACE_MS - elapsedMs - ONE_ROW_WORST_CASE_MS));
}

// ponytail: two residuals stack here. (1) Same as NOTIFY_DEADLINE_MS - one row's fan-out is
// unbudgeted, so a search with enough dead targets can still push the sweep past whatever budget
// bootRedeliverBudgetMs computed. (2) process.uptime() approximates elapsed-since-container-start
// closely enough for this purpose, but isn't exact (e.g. a paused/throttled process). Upgrade
// paths, both bigger changes than this fix justifies today: concurrent per-row fan-out (or a
// configured-target-count limit) for (1); keeping the boot phase reporting healthy in
// /api/health instead of budgeting around its 503 window for (2) and the root problem generally
// - cleaner, but it changes health semantics and risks masking a genuinely wedged boot, so it
// needs its own design and tests rather than riding along with this fix.

// Redeliver alerts committed but never confirmed delivered - a crash between the alerts insert
// and the notify, or a webhook outage that spanned the last shutdown. Called once at boot, before
// any tick fires, so it never races the main-path delivery loop (disjoint row sets, no shared
// mutable flag). A row counts as delivered once ANY channel accepts it (notify.anyDelivered), so a
// retry never re-posts to a channel that already has it. Rows older than REDELIVER_MAX_AGE_MS are
// retired unsent (a deal that stale isn't worth sending); anything still null is retried next boot.
// Stand-ins for a sender with nothing to send, so the two delivery paths can always be
// awaited as a pair without branching the result handling.
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

  const budgetMs = bootRedeliverBudgetMs(process.uptime() * 1000);
  // Startup alone already ate the probe grace: skip the sweep entirely rather than risk
  // overrunning it. Rows stay deliveredAt=null and are retried, oldest-first, next boot - the
  // same contract a partial sweep already relies on.
  if (budgetMs <= 0) return;

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
    .where(isNull(alerts.deliveredAt))
    // Oldest-first: with a wall-clock deadline the cut point varies per sweep, so deterministic
    // ordering is what stops a row being skipped sweep after sweep - once earlier rows are
    // delivered or retired, this one is guaranteed to reach the front and get a turn.
    .orderBy(asc(alerts.createdAt), asc(alerts.id))
    .limit(REDELIVER_FETCH_LIMIT);

  if (!rows.length) return;

  // Confirm every retired/delivered row in one UPDATE after the loop instead of one round-trip
  // per row (a boot backlog shouldn't fan out N queries against a serverless DB). A crash mid-loop
  // just re-posts the confirmed-but-unflushed rows next boot, which is the same at-least-once
  // window the main path already accepts.
  const done: number[] = [];
  const deadline = Date.now() + budgetMs;
  for (const row of rows) {
    // Checked before touching the row, so anything past the deadline is left completely
    // untouched - deliveredAt stays null, so it's retried (oldest-first, see above) next boot.
    if (Date.now() >= deadline) break;
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
      // Same story: poll-time only. Tracking was already decided when this alert was written.
      itemEndDate: null,
      bestOffer: false,
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
