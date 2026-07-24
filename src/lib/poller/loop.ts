import { and, eq, inArray, notExists } from "drizzle-orm";
import { authMode } from "@/lib/authmode";
import { db } from "@/lib/db";
import { notify } from "@/lib/discord";
import { RateLimitError, mockSearch, searchNewlyListed } from "@/lib/ebay";
import { notifyPush } from "@/lib/push";
import { alerts, searches, seenItems, trackedItems } from "@/lib/schema";
import type { Item, PriceContext } from "@/lib/types";
import { NOTHING_PUSHED, NOTHING_SENT, reapPush } from "./delivery";
import { maybeSampleMarket, priceContext, suppressed } from "./market";
import { projectedCalls } from "./projection";
import { QUOTA_CEILING, flushCalls, governedDelayMs, governorFor } from "./quota";
import { activeMin, snoozing } from "./snooze";
import {
  type Entry,
  type TrackedItem,
  type UserCtx,
  bumpAlerts,
  enabledSearchesFor,
  message,
  plog,
  recordError,
  state,
} from "./state";
import { flushTracked, harvest, insertTracked, newTracked, runBonusChecks, runDueChecks, soldContext } from "./track";

export const MAX_BACKOFF_MS = 30 * 60_000;
// How long a quota-exhausted search idles before re-checking. healthWindowMs treats this as
// the floor of the freshness window, so raising it here widens that window too.
export const QUOTA_SKIP_MS = 15 * 60_000;

// The reschedule delay after a failed poll. A RateLimitError carries eBay's own wait hint: honor
// it, but never poll faster than the user's interval and never park so long the /api/health
// heartbeat goes stale. The freshness window is at least intervalMs*GOV_MAX_FACTOR (see
// healthWindowMs), so the ceiling is max(MAX_BACKOFF_MS, intervalMs) - a flat MAX_BACKOFF_MS would
// drop a >30min interval below its own configured cadence, and it isn't needed there anyway (the
// window is already hours wide for large intervals). Any other error uses exponential backoff,
// doubling from one interval up to MAX_BACKOFF_MS. Pure + exported so the branch is unit-testable.
export function retryDelayMs(
  err: unknown,
  intervalMin: number,
  prevBackoffMs: number,
): { delayMs: number; backoffMs: number } {
  const intervalMs = intervalMin * 60_000;
  if (err instanceof RateLimitError) {
    const ceiling = Math.max(MAX_BACKOFF_MS, intervalMs);
    return { delayMs: Math.min(Math.max(err.retryAfterMs, intervalMs), ceiling), backoffMs: 0 };
  }
  const backoffMs = Math.min(prevBackoffMs ? prevBackoffMs * 2 : intervalMs, MAX_BACKOFF_MS);
  return { delayMs: backoffMs, backoffMs };
}

export function schedule(e: Entry, delayMs: number) {
  if (state().entries.get(e.s.id) !== e) return; // entry deleted/replaced while a tick was in flight
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (!e.s.enabled || !state().ready) return;
  // Heartbeat: stamp only once a live timer is actually set. A disabled or deleted entry's
  // final schedule() must not bump it, or that stale bump would mask a wedged enabled search.
  // Snooze/quota/backoff paths keep the entry enabled+ready, so intentional idle still stamps.
  state().lastScheduledAt = Date.now();
  e.timer = setTimeout(() => void tick(e), delayMs);
  plog.debug({ searchId: e.s.id, q: e.s.q, delayMs }, "scheduled");
}

async function tick(e: Entry) {
  if (e.running) {
    schedule(e, 5000);
    return;
  }
  e.running = true;
  try {
    await pollOnce(e);
  } catch (err) {
    // pollOnce catches its own poll failures; reaching here means a throw before its try
    // (e.g. an invalid snooze tz in Intl). Reschedule so one entry can't silently kill its
    // timer - which the heartbeat would otherwise read as a wedge and 503.
    recordError(e.s.userId, e.s.q, `tick: ${message(err)}`);
    schedule(e, MAX_BACKOFF_MS);
  } finally {
    e.running = false;
  }
}

// What a user's next poll will actually do. Live needs their own keys; mock is single mode's
// credential-less path (the zero-config quick start), which multi-user modes deliberately don't
// have - fake listings in a shared deployment would look real to the friend seeing them. Shared
// with status() so the UI's "polling paused" banner can't disagree with the poll loop.
export function pollMode(u: UserCtx): "live" | "mock" | "no-creds" {
  if (u.ebay) return "live";
  return authMode() === "single" ? "mock" : "no-creds";
}

// Mark an item seen without alerting - one insert site shared by the two seen-but-not-alerted
// paths (suppressed listings and tracking-only auctions), so a seen_items schema change lands
// once. Caller sets `wrote` (a poll-local flag) since only it knows the batch's connection state.
async function markSeen(database: ReturnType<typeof db>, e: Entry, itemId: string) {
  await database.insert(seenItems).values({ searchId: e.s.id, itemId }).onConflictDoNothing();
  e.seen.add(itemId);
}

// Queue a listing to be followed for its realized price, or decline it. The single newTracked
// callsite owns the timestamp, so the tracking-only and alert paths can't drift on how a follow
// starts. A null return (an auction with no end date, which there's no way to time) is dropped.
function startFollowing(item: Item, follow: TrackedItem[]) {
  const t = newTracked(item, Date.now());
  if (t) follow.push(t);
}

export async function pollOnce(e: Entry) {
  const st = state();
  // Which generation of the tracking state this tick belongs to. An edit that invalidates the
  // baseline can land in any of the awaits below and wipe all of it; the writes at the end check
  // this before putting back what that edit removed.
  const epoch = e.trackEpoch;
  const u = st.users.get(e.s.userId);
  if (!u) {
    // Owner isn't cached (a row created since the last reload). Nothing to bill or notify
    // against, so idle at the normal cadence rather than let the timer die - a dead timer
    // reads as a wedge to the heartbeat.
    recordError(e.s.userId, e.s.q, "search owner is not loaded - poll skipped");
    schedule(e, e.s.intervalMin * 60_000);
    return;
  }
  // Overnight snooze: don't touch the eBay API during the owner's window. Re-tick at the
  // search's normal interval; the first tick after the window ends polls and picks
  // up anything listed meanwhile (still-available items alert then, not never).
  if (snoozing(u.snooze)) {
    plog.debug({ searchId: e.s.id, q: e.s.q }, "snoozed - poll skipped");
    schedule(e, e.s.intervalMin * 60_000);
    return;
  }
  const today = new Date().toDateString();
  if (u.calls.date !== today) u.calls = { date: today, used: 0, surplus: 0 };
  if (u.calls.used >= QUOTA_CEILING) {
    recordError(u.id, e.s.q, "daily API budget exhausted - poll skipped");
    schedule(e, QUOTA_SKIP_MS);
    return;
  }
  // No keys and no mock to fall back on: there is nothing to poll with. Stay idle - no eBay
  // call, no quota spent, no error every tick - until the user saves creds, which re-kicks
  // this search (setUserCreds). The UI shows the paused banner off the same mode.
  if (pollMode(u) === "no-creds") {
    plog.debug({ searchId: e.s.id, q: e.s.q, userId: u.id }, "no credentials - polling paused");
    schedule(e, e.s.intervalMin * 60_000);
    return;
  }

  plog.debug({ searchId: e.s.id, q: e.s.q }, "polling");
  try {
    u.calls.used++;
    const items = u.ebay ? await searchNewlyListed(u.ebay, e.s) : mockSearch(e.s);
    e.lastPolledAt = Date.now();
    plog.info({ q: e.s.q, count: items.length, quotaUsed: u.calls.used }, "eBay poll");
    const database = db();
    const fresh = items.filter((i) => !e.seen.has(i.itemId));
    plog.debug({ searchId: e.s.id, fresh: fresh.length, of: items.length }, "dedup");
    let wrote = false; // did this tick open a connection? gates the piggyback flush below

    // Every listing we're following that turns up again in these results is a free check: it's
    // demonstrably still for sale, so its price refreshes and any check that came due is skipped
    // rather than spent. Runs against the full result set, not `fresh` - a followed listing is
    // by definition already in the seen set.
    if (e.tracked.size) {
      const at = Date.now();
      for (const item of items) {
        const t = e.tracked.get(item.itemId);
        if (t && harvest(t, item, at)) e.trackDirty.add(item.itemId);
      }
    }

    if (!e.s.seeded) {
      // first poll seeds the seen set silently - no alert spam (DESIGN.md §3)
      if (fresh.length) {
        const rows = fresh.map((i) => ({ searchId: e.s.id, itemId: i.itemId }));
        await database.insert(seenItems).values(rows).onConflictDoNothing();
        for (const i of fresh) e.seen.add(i.itemId);
      }
      await database.update(searches).set({ seeded: true }).where(eq(searches.id, e.s.id));
      wrote = true;
      e.s.seeded = true;
      plog.info({ searchId: e.s.id, q: e.s.q, count: fresh.length }, "seeded");
    } else {
      // Deal-context baseline. Prefer the daily market sample (reflects the whole market,
      // even for a band-limited search); only when there's no baseline fall back to the
      // median of this search's recent priced alerts, computed from before this batch lands
      // (so the new items don't skew their own "typical"). The recent-alert read is skipped
      // whenever a market baseline exists (dealField's market branch ignores its count) and
      // whenever the poll is empty, so steady-state polls stay DB-free.
      // Realized prices beat asking prices when there are enough of them: "sold ~$X" is what
      // the thing is actually worth, where a market median is only what sellers are asking.
      const sold = e.s.trackSold ? soldContext(e.soldPrices, Date.now()) : null;
      const market = e.s.marketMedian;
      const ctx: PriceContext = sold
        ? { ...sold, basis: "sold" }
        : market != null && market > 0
          ? { typical: market, count: 0, basis: "market" }
          : { ...(fresh.length ? await priceContext(database, e.s.id) : { typical: null, count: 0 }), basis: "recent" };
      // Listings this tick alerted on, to start following once the loop is done. Suppressed
      // items are deliberately not here: an excluded listing ("for parts", "broken") is exactly
      // the junk whose realized price must not describe what the user is hunting - the market
      // baseline filters it out for the same reason.
      const follow: TrackedItem[] = [];
      // Backlog drain: a listing already alerted on (as a BIN, or before sold tracking widened this
      // poll to auctions) now running as an auction. It's in the seen set, so `fresh` skips it, but
      // its winning bid is what the sold median wants. Gated on an alert row with no tracked row
      // yet: the silent seed backlog and suppressed listings are never alerted (so "seeding follows
      // nothing" holds), and a follow that's already active or resolved has a row (so this drains
      // once, not every poll). The datable filter mirrors newTracked - an auction with no finite
      // end is never followed. Opening the drain's connection sets `wrote` so the piggyback flush
      // below persists any prices the free-refresh loop dirtied this tick.
      if (e.s.trackSold) {
        const candidates = items.filter(
          (i) =>
            i.buyingOption === "AUCTION" &&
            Number.isFinite(Date.parse(i.itemEndDate ?? "")) &&
            e.seen.has(i.itemId) &&
            !e.tracked.has(i.itemId) &&
            !suppressed(i, e.s),
        );
        if (candidates.length) {
          wrote = true;
          const rows = await database
            .select({ itemId: alerts.itemId })
            .from(alerts)
            .where(
              and(
                eq(alerts.searchId, e.s.id),
                inArray(
                  alerts.itemId,
                  candidates.map((i) => i.itemId),
                ),
                notExists(
                  database
                    .select({ n: trackedItems.itemId })
                    .from(trackedItems)
                    .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, alerts.itemId))),
                ),
              ),
            );
          const followable = new Set(rows.map((r) => r.itemId));
          for (const item of candidates) if (followable.has(item.itemId)) startFollowing(item, follow);
        }
      }
      // Pin the owner's channel list for this batch: reload() swaps the UserCtx and its
      // channel list (never mutates), so a capture keeps the insert's deliveredAt seed and the
      // notify target consistent even if a reload lands mid-tick.
      const webhooks = u.channels; // local copy; named to not shadow the `channels` schema table
      // Pinned for the same reason as `webhooks`, but narrowed as endpoints die: reapPush
      // reassigns u.push rather than mutating it, so this alias would otherwise keep handing
      // a reaped endpoint to every later item in the batch.
      let subs = u.push;
      for (const item of [...fresh].reverse()) {
        // Recomputed per item, not once per batch: reaping the last subscription has to be
        // able to take this to zero, or the rows below would seed deliveredAt=null for a
        // target that no longer exists and never be delivered by anyone.
        const targets = webhooks.length + subs.length;
        if (e.seen.has(item.itemId)) continue; // reload() may have merged it in mid-loop
        // Suppressed (exclude-terms hit, or the NOT_PARTS preset's for-parts tier): mark seen
        // (so later widening the search won't re-alert this old listing) but send no alert.
        // Seen set stays the full dedupe set.
        if (suppressed(item, e.s)) {
          await markSeen(database, e, item.itemId);
          wrote = true;
          plog.debug({ searchId: e.s.id, itemId: item.itemId, q: e.s.q }, "excluded - suppressed");
          continue;
        }
        // Tracking-only auction: sold tracking widens a BIN-only poll to auctions (browseFilters)
        // purely to record their winning bid. Follow it for that bid, but never alert, notify, or
        // count it as a hit. The trackSold gate is load-bearing, not just the query invariant:
        // without it a BIN item eBay's best-effort filter let through and normalize() classified
        // AUCTION (no FIXED_PRICE buyingOption) would be silenced instead of alerted. Placed after
        // the suppression block so an excluded auction ("for parts") still can't feed the median.
        if (item.buyingOption === "AUCTION" && !e.s.includeAuctions && e.s.trackSold) {
          await markSeen(database, e, item.itemId);
          wrote = true;
          startFollowing(item, follow);
          continue;
        }
        // Transaction: if alerts insert fails, seen_items also rolls back so the
        // item is retried next poll instead of being permanently dropped. The alerts
        // insert is conflict-guarded (see alerts_search_item_idx): a reload race that
        // re-processes an item hits the unique index and inserts nothing, so alertId
        // comes back null and we skip the notify. deliveredAt is stamped now only when
        // there's nothing to deliver to; otherwise it stays null until notify succeeds.
        let alertId: number | null = null;
        await database.transaction(async (tx) => {
          await tx.insert(seenItems).values({ searchId: e.s.id, itemId: item.itemId }).onConflictDoNothing();
          const [inserted] = await tx
            .insert(alerts)
            .values({
              userId: e.s.userId,
              searchId: e.s.id,
              searchQ: e.s.q,
              itemId: item.itemId,
              title: item.title,
              price: item.price,
              currency: item.currency,
              shippingCost: item.shippingCost,
              buyingOption: item.buyingOption,
              condition: item.condition,
              imageUrl: item.imageUrl,
              itemUrl: item.itemUrl,
              deliveredAt: targets ? null : new Date(),
            })
            .onConflictDoNothing({ target: [alerts.searchId, alerts.itemId] })
            .returning({ id: alerts.id });
          alertId = inserted?.id ?? null;
        });
        wrote = true;
        e.seen.add(item.itemId);
        if (alertId == null) continue; // duplicate: the row already existed, don't re-notify
        if (e.s.trackSold) startFollowing(item, follow);
        bumpAlerts(e.s.userId); // the owner's alert list changed; their tabs must refetch
        const now = Date.now();
        e.hitTimes.push(now);
        e.lastHitAt = now;
        plog.info({ searchId: e.s.id, itemId: item.itemId, price: item.price }, "alert sent");
        if (targets) {
          const [d, p] = await Promise.all([
            webhooks.length ? notify(item, e.s, webhooks, ctx) : NOTHING_SENT,
            subs.length ? notifyPush(item, e.s, subs) : NOTHING_PUSHED,
          ]);
          // Recorded separately, never `d.error ?? p.error`: this list is the only place a
          // self-hoster sees an outage, so collapsing the two would hide a dead webhook
          // behind a push failure (and vice versa).
          if (d.error) recordError(u.id, e.s.q, d.error, "error");
          if (p.error) recordError(u.id, e.s.q, p.error, "error");
          if (p.dead.length) {
            await reapPush(database, u, p.dead);
            const gone = new Set(p.dead);
            subs = subs.filter((s) => !gone.has(s.endpoint)); // keep the pinned copy in step
          }
          // "Delivered" = reached at least one target. On total failure the row stays
          // deliveredAt=null and boot redelivery retries it (never re-posting to a target that
          // already has it, since anyDelivered would have marked it delivered here).
          if (d.anyDelivered || p.anyDelivered) {
            await database.update(alerts).set({ deliveredAt: new Date() }).where(eq(alerts.id, alertId));
          }
        }
      }
      // One insert for the batch, on the connection the alerts above already opened.
      await insertTracked(database, e, follow, epoch);
    }

    // Piggyback the daily-call-count persist on the connection these writes already
    // opened. Empty polls (seeded, nothing new) skip it and stay DB-free, so a
    // reboot loses at most the calls counted since the last write - by design.
    if (wrote) {
      await flushCalls(database, u.id, u.calls);
      await flushTracked(database, e); // same bargain: refreshed prices and deferrals ride along
    }
    // Refresh the market baseline at most once/day per band-limited search. Self-throttled
    // and isolated: it opens a connection only when actually due, so steady-state empty
    // polls stay DB-free, and its own try/catch keeps a sample failure off the main poll.
    await maybeSampleMarket(e, u, database);
    // Check in on followed listings that have come due. Same shape as the sample above:
    // self-limiting, quota-guarded, isolated, and a no-op for a search that isn't tracking.
    await runDueChecks(e, u, database, epoch);
    const active = enabledSearchesFor(u.id);
    const projected = projectedCalls(active, activeMin(u.snooze));
    // Last, so the budget it reads has this tick's poll, sample and due checks already in it.
    // Deliberately absent from `projected`: these calls are the surplus that projection leaves
    // over, and budgeting for them would engage the governor against the very thing it makes
    // affordable. Resolving a listing early only ever shrinks the projection (checksDue24h).
    await runBonusChecks(e, u, database, epoch, projected);
    e.backoffMs = 0;
    // Governed only here, on the path that actually spent a call. The snooze, no-creds and
    // owner-not-cached reschedules above cost no quota, so stretching them would delay noticing
    // that the window ended or the keys arrived while saving nothing. The quota-exhausted retry
    // and the error backoff are already their own (longer) delays.
    schedule(e, governedDelayMs(e.s.intervalMin, governorFor(u, projected)));
  } catch (err) {
    plog.error({ err, searchId: e.s.id, q: e.s.q }, "poll failed"); // stack goes to stdout; recordError keeps only the message for the UI
    recordError(u.id, e.s.q, message(err));
    const { delayMs, backoffMs } = retryDelayMs(err, e.s.intervalMin, e.backoffMs);
    e.backoffMs = backoffMs;
    schedule(e, delayMs);
  }
}

// Re-kick one user's searches after a change that decides whether/how they poll. Jittered so a
// user with many searches doesn't hit eBay in one burst.
export function kick(userId: number) {
  for (const e of enabledSearchesFor(userId)) schedule(e, 1000 + Math.random() * 3000);
}
