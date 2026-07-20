import { and, eq, sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { type CheckResult, checkItem, mockCheckItem } from "@/lib/ebay";
import { trackedItems } from "@/lib/schema";
import type { Item, PriceKind } from "@/lib/types";
import { median } from "./market";
import { QUOTA_CEILING, bonusBudget, flushCalls, usedToday } from "./quota";
import { counterDayFrac } from "./snooze";
import { type Entry, type TrackedItem, type UserCtx, message, plog, recordError } from "./state";

// Sold-price tracking: what a followed listing actually went for, inferred by re-fetching it
// after it ends. eBay's sold-search APIs are enterprise-only, so this is the available path -
// and it only works because ended listings stay readable for days (see checkItem).
//
// This file is the pure half: when to look, and what one look means. The scheduling and the
// writes live in the poller (runDueChecks below), but every decision it makes is here so the
// rules can be tested without a database or a network.

const DAY_MS = 86400_000;

// Days after first sighting that a fixed-price listing is checked, if it hasn't been re-sighted
// in the meantime. Front-loaded because most deals move early, and capped at four checks for a
// listing's entire life. Anchored to first sighting rather than to the previous check, so a
// re-sighting can skip a step instead of pushing the whole schedule back.
export const BIN_CHECK_DAYS = [3, 7, 14, 30];

// How long after an auction ends to look. Long enough for eBay to settle the final bid (a snipe
// lands in the closing seconds and is only visible afterwards), short enough to be well inside
// the window where an ended listing is still readable.
const AUCTION_GRACE_MS = 5 * 60_000;

// One retry for an auction check that found nothing, in case it arrived after eBay dropped the
// listing but while a transient error was in play. Also how long a check that failed outright
// (rate limit, outage) waits before being tried again.
const AUCTION_RETRY_MS = 3600_000;

// Hard ceiling on eBay calls one listing may ever consume. The schedules above already bound the
// normal paths (one check for an auction, four for a fixed-price listing); this bounds the
// failure path, where a listing whose checks keep erroring would otherwise retry hourly until
// the retention prune reaped it - thousands of calls for one listing we are never going to
// learn anything about.
const MAX_CHECK_ATTEMPTS = 6;

// The sold median only speaks for prices recent enough to still describe the market, and only
// once enough of them agree. Below the minimum the deal context falls back to asking prices.
const SOLD_WINDOW_DAYS = 30;
const SOLD_MIN_COUNT = 3;

// The next scheduled check for a fixed-price listing after `afterMs`, or null when the schedule
// is spent. Derived from the schedule rather than counted, so a step skipped by a re-sighting
// is simply never visited.
function nextBinCheck(firstSeenAt: number, afterMs: number): number | null {
  for (const d of BIN_CHECK_DAYS) {
    const at = firstSeenAt + d * DAY_MS;
    if (at > afterMs) return at;
  }
  return null;
}

// Starts following a freshly surfaced listing, or declines to. An auction with no end date is
// declined: the single check it would get has no right moment to happen, and an untimed one is
// a wasted call.
export function newTracked(item: Item, now: number): TrackedItem | null {
  const auction = item.buyingOption === "AUCTION";
  const end = item.itemEndDate ? Date.parse(item.itemEndDate) : NaN;
  if (auction && !Number.isFinite(end)) return null;
  return {
    itemId: item.itemId,
    // A winning bid is the realized price even on an auction that also took Best Offers, so the
    // bid kind wins; only a pure Best Offer listing is a mere ceiling.
    priceKind: auction ? "bid" : item.bestOffer ? "offer_cap" : "fixed",
    lastPrice: item.price,
    currency: item.currency,
    itemEndDate: auction ? end : null,
    firstSeenAt: now,
    nextCheckAt: auction ? end + AUCTION_GRACE_MS : now + BIN_CHECK_DAYS[0] * DAY_MS,
    checksUsed: 0,
  };
}

// Folds a re-sighting into a followed listing. Seeing it in poll results proves it is still for
// sale, which is the same thing a check would have found out - so this refreshes the price and
// skips any step that has come due, for free. Returns whether anything changed, so an unchanged
// re-sighting doesn't dirty the row and force a write.
//
// The schedule running out is deliberately not handled here: leaving the check due lets the one
// remaining call make the positive observation ("still listed after 30 days") that resolves it.
export function harvest(t: TrackedItem, item: Item, now: number): boolean {
  let dirty = false;
  if (item.price != null && item.price !== t.lastPrice) {
    t.lastPrice = item.price;
    dirty = true;
  }
  if (t.priceKind !== "bid" && t.nextCheckAt <= now) {
    const next = nextBinCheck(t.firstSeenAt, now);
    if (next != null && next !== t.nextCheckAt) {
      t.nextCheckAt = next;
      dirty = true;
    }
  }
  return dirty;
}

// Either the listing's final outcome, or when to look again.
export type CheckOutcome =
  | { kind: "resolved"; state: "sold" | "unsold" | "unknown"; soldPrice: number | null }
  | { kind: "defer"; nextCheckAt: number };

const resolved = (state: "sold" | "unsold" | "unknown", soldPrice: number | null = null): CheckOutcome => ({
  kind: "resolved",
  state,
  soldPrice,
});

// Reads one check. `t.checksUsed` counts the checks that came before this one.
//
// The core rule is uniform across both listing types, which live probing confirmed: a listing
// that sold reads OUT_OF_STOCK with a sold quantity, and the price it reports is the realized
// one - for an ended auction, `price` mirrors the frozen final bid.
export function inferOutcome(t: TrackedItem, res: CheckResult, now: number): CheckOutcome {
  if (!res.ok) {
    // The listing is gone from the API. It may well have sold, but eBay no longer says at what
    // price, and inventing one would poison the median this feeds. One retry for an auction,
    // whose readable window is the shortest and where a late check is the likely cause.
    if (t.priceKind === "bid" && t.checksUsed === 0) return { kind: "defer", nextCheckAt: now + AUCTION_RETRY_MS };
    return resolved("unknown");
  }
  if (res.availability === "OUT_OF_STOCK") {
    return res.soldQuantity > 0 ? resolved("sold", res.price) : resolved("unsold"); // no sales = seller ended it
  }
  // Still in stock. For an auction that means it ran to the end and nobody bid - a no-bid
  // auction stays IN_STOCK once it closes, and bidCount is null there, so this is the signal.
  if (t.priceKind === "bid") return resolved("unsold");
  // A fixed-price listing is simply still for sale: try again at the next step, and once the
  // schedule is spent take "still listed" as the answer.
  const next = nextBinCheck(t.firstSeenAt, now);
  return next == null ? resolved("unsold") : { kind: "defer", nextCheckAt: next };
}

// How many follows one tick may check. A search that has been away (a restart, a snooze, a
// quota pause) can come back with a large backlog; draining it a few at a time keeps a burst of
// checks from crowding out the polls that actually find deals.
export const MAX_CHECKS_PER_TICK = 3;

// How long one listing must go unlooked-at before surplus may buy it another check. A bonus
// check costs the listing nothing - it never advances BIN_CHECK_DAYS or checksUsed - so the only
// thing a shorter gap buys is a narrower window in which the listing can sell and stop being
// readable before anyone looks. A gap rather than a per-day count because it also spaces the
// checks out: a count alone would let a five-minute search spend the whole day's allowance in
// one tick, including on the listing the scheduled pass just checked.
export const BONUS_MIN_GAP_MS = 4 * 3600_000;

// The entry's ledger of when each listing was last looked at, rolled when the local day turns
// to keep it from growing without bound. Both check paths stamp it, so a listing the scheduled
// pass just checked is not re-asked, in the same tick, the question that call just answered.
function bonusDone(e: Entry, today = new Date().toDateString()): Map<string, number> {
  if (e.bonus.date !== today) e.bonus = { date: today, done: new Map() };
  return e.bonus.done;
}

// Which follows surplus quota may buy an unscheduled check on, best candidates first.
//
// Not due: a check that has come due belongs to runDueChecks, which will spend it anyway.
// Not an auction: before its end an auction reads IN_STOCK, which inferOutcome resolves as
// "nobody bid" - a correct reading only after the hammer falls, so an early one books a lie.
// Not looked at inside BONUS_MIN_GAP_MS: that gap is what keeps the surplus from pouring into
// one listing instead of spreading across the backlog.
//
// Sorted least-recently-looked-at first, then by how far out the next scheduled check is,
// furthest first. A listing gets a second look only once every other listing has had one (never
// checked sorts as 0, so it leads), and among equals the one with the longest unwatched stretch
// goes first, because that is where a sale is likeliest to happen and stop being readable. That
// realized price is the whole point.
export function bonusEligible(
  tracked: Iterable<TrackedItem>,
  done: ReadonlyMap<string, number>,
  now: number,
): TrackedItem[] {
  const seenAt = (t: TrackedItem) => done.get(t.itemId) ?? 0;
  return [...tracked]
    .filter((t) => t.priceKind === "fixed" && t.nextCheckAt > now && seenAt(t) <= now - BONUS_MIN_GAP_MS)
    .sort((a, b) => seenAt(a) - seenAt(b) || b.nextCheckAt - a.nextCheckAt);
}

// A followed listing as its row. Shared by the initial insert and the flush below, so the two
// can't disagree about what a row looks like.
function toRow(searchId: number, t: TrackedItem): typeof trackedItems.$inferInsert {
  return {
    searchId,
    itemId: t.itemId,
    priceKind: t.priceKind,
    lastPrice: t.lastPrice,
    currency: t.currency,
    itemEndDate: t.itemEndDate == null ? null : new Date(t.itemEndDate),
    firstSeenAt: new Date(t.firstSeenAt),
    nextCheckAt: new Date(t.nextCheckAt),
    checksUsed: t.checksUsed,
  };
}

// Starts following the listings a tick just alerted on. Called from the tick that wrote those
// alerts, so it rides a connection that is already open.
export async function insertTracked(
  database: ReturnType<typeof db>,
  e: Entry,
  fresh: readonly TrackedItem[],
  epoch: number,
): Promise<void> {
  if (!fresh.length) return;
  await serialize(e, async () => {
    if (stale(e, epoch)) return;
    await database
      .insert(trackedItems)
      .values(fresh.map((t) => toRow(e.s.id, t)))
      .onConflictDoNothing();
    // A reset requested while that statement ran bumped the epoch immediately but is queued
    // behind this lock, so its DELETE will clear the rows we just wrote. Skipping the map keeps
    // memory agreeing with the disk that is about to be emptied.
    if (stale(e, epoch)) return;
    for (const t of fresh) e.tracked.set(t.itemId, t);
  });
}

// Persists follows whose in-memory state has drifted. One statement for the batch: a busy poll
// can dirty a lot of rows at once, and a round-trip each would be the slowest thing in the tick.
// The rows all exist already, so every conflict is the update this is really doing.
export async function flushTracked(database: ReturnType<typeof db>, e: Entry): Promise<void> {
  if (!e.trackDirty.size) return;
  // The whole read-then-upsert runs under the lock: this statement is an INSERT with a conflict
  // clause, so a reset landing between picking the rows and writing them re-creates every row it
  // had just deleted - and those survive the reload that would otherwise clean up.
  await serialize(e, async () => {
    if (!e.trackDirty.size) return;
    const ids = [...e.trackDirty];
    const rows = ids.map((id) => e.tracked.get(id)).filter((t): t is TrackedItem => t != null);
    if (!rows.length) {
      e.trackDirty.clear(); // every dirty row resolved out from under us; nothing to write
      return;
    }
    await database
      .insert(trackedItems)
      .values(rows.map((t) => toRow(e.s.id, t)))
      .onConflictDoUpdate({
        target: [trackedItems.searchId, trackedItems.itemId],
        set: {
          lastPrice: sql`excluded.last_price`,
          nextCheckAt: sql`excluded.next_check_at`,
          checksUsed: sql`excluded.checks_used`,
        },
      });
    // No post-await staleness check here, unlike insertTracked and resolve: a reset replaced
    // trackDirty outright, so deleting the old generation's ids from the fresh set is a no-op,
    // and the rows this upsert re-created are taken by the DELETE queued behind our lock.
    // Cleared only once the write has landed. Clearing first would mean a failed flush silently
    // forgot the deferral it was persisting, and the next reload would hand back the older
    // schedule - spending the check this poll had already established wasn't needed.
    for (const id of ids) e.trackDirty.delete(id);
  });
}

// Writes a follow's final outcome and retires it from memory. Resolution is written immediately
// rather than buffered like a deferral: it is the one piece of state we can't cheaply rebuild,
// and it's what the sold median is made of.
async function resolve(
  database: ReturnType<typeof db>,
  e: Entry,
  t: TrackedItem,
  out: Extract<CheckOutcome, { kind: "resolved" }>,
  epoch: number,
): Promise<void> {
  await serialize(e, async () => {
    // The sale is the dangerous half: soldPrices feeds the median, which outranks every other
    // basis, so a reset landing between the update and the push seeds the fresh median with the
    // price of a listing the search no longer matches.
    if (stale(e, epoch)) return;
    await database
      .update(trackedItems)
      .set({
        state: out.state,
        soldPrice: out.soldPrice,
        resolvedAt: new Date(),
        checksUsed: t.checksUsed,
        lastPrice: t.lastPrice,
        nextCheckAt: null, // nothing left to schedule; also what keeps it out of the projection
      })
      .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, t.itemId)));
    // Requested mid-statement: the queued DELETE takes the row, and the containers below are the
    // fresh ones, so pushing this sale would seed the new median with the old criteria's price -
    // the exact thing the edit cleared it to prevent.
    if (stale(e, epoch)) return;
    e.tracked.delete(t.itemId);
    e.trackDirty.delete(t.itemId);
    // Best Offer listings are followed but never counted: eBay keeps showing the asking price
    // after the sale, so this figure is a ceiling and would bias the median upward.
    if (out.state === "sold" && out.soldPrice != null && t.priceKind !== "offer_cap") {
      e.soldPrices.push({ price: out.soldPrice, atMs: Date.now() });
    }
    plog.info({ searchId: e.s.id, itemId: t.itemId, state: out.state, soldPrice: out.soldPrice }, "item resolved");
  });
}

// Drops everything a search has learned about realized prices, in memory and on disk. Called
// when an edit changes what the search matches: those sales describe the old criteria, and the
// sold median outranks every other basis, so keeping them would caption the new search's alerts
// with the old search's going rate.
export async function resetTracked(database: ReturnType<typeof db>, e: Entry): Promise<void> {
  // Bump before taking the lock so a tick already queued behind it sees the new epoch and bails
  // rather than writing, and take the lock so a write already in progress finishes before the
  // DELETE runs - otherwise its INSERT lands after the delete and the row outlives the edit.
  e.trackEpoch++;
  e.tracked = new Map();
  e.soldPrices = [];
  e.trackDirty = new Set();
  await serialize(e, () => database.delete(trackedItems).where(eq(trackedItems.searchId, e.s.id)));
}

// A tick that started before a resetTracked is holding references into containers that no longer
// belong to the entry, so anything it learned describes criteria the search has dropped. Writing
// it would put back what the reset removed - a resurrected row, or worse a sale in the median,
// which outranks every other basis. Checked after each await rather than once at the top: the
// window that matters is the one the network call opens.
function stale(e: Entry, epoch: number): boolean {
  return e.trackEpoch !== epoch;
}

// Runs fn with the entry's tracking state to itself. Every writer below checks `stale` and then
// awaits a statement, and a reset landing inside that await makes the check a lie: it deletes
// between the check and the write, so the write puts the row back. Chaining through this makes
// check-and-write atomic with respect to resetTracked, which takes the same lock.
//
// A plain promise chain rather than a real mutex because that's all the shape needs: one entry,
// no re-entrancy, and each critical section is a couple of statements. Failures are swallowed
// into the chain (not the caller) so one rejected write can't wedge every later one.
function serialize<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
  const run = e.trackLock.then(fn, fn);
  e.trackLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

// The tick's side-task: spend up to MAX_CHECKS_PER_TICK calls finding out how followed listings
// ended. Modelled on maybeSampleMarket - quota-guarded, billed through the same counter, and
// wrapped in its own try/catch so a failure here never backs off the poll that called it.
export async function runDueChecks(
  e: Entry,
  u: UserCtx,
  database: ReturnType<typeof db>,
  epoch: number,
): Promise<void> {
  if (!e.s.trackSold || !e.tracked.size || stale(e, epoch)) return;
  const due = [...e.tracked.values()].filter((t) => t.nextCheckAt <= Date.now()).slice(0, MAX_CHECKS_PER_TICK);
  if (!due.length) return;
  try {
    for (const t of due) {
      // Checks are the first thing to give up when the budget runs low: they're a nicety, and
      // the owner's remaining calls belong to the polls that find deals in the first place.
      if (u.calls.used >= QUOTA_CEILING) break;
      u.calls.used++;
      // Stamped so the gap applies. Without this the surplus pass below would pick up whatever
      // this check defers - a fresh future nextCheckAt makes it a prime candidate - and spend a
      // second call re-asking the question this one just answered.
      bonusDone(e).set(t.itemId, Date.now());
      let res: CheckResult;
      try {
        // Same mode gate as the poll that called us: live keys, or single mode's mock.
        res = u.ebay ? await checkItem(u.ebay, t.itemId) : mockCheckItem(t.lastPrice);
      } catch (err) {
        // checkItem only answers for a listing eBay says is gone; anything else (a 429, a 5xx,
        // an expired token, an HTML gateway page) throws. The call was spent and told us
        // nothing, so the row MUST move off `now`: left due it would be re-picked every single
        // tick, spending a call each time, aborting the rest of this loop, and never resolving.
        // Unless a reset landed while this was in flight, in which case t is orphaned and
        // rescheduling it would put back a follow the edit dropped. Break rather than return so
        // the call this did spend is still billed by the flush below.
        if (stale(e, epoch)) break;
        t.checksUsed++;
        if (t.checksUsed >= MAX_CHECK_ATTEMPTS) {
          await resolve(database, e, t, { kind: "resolved", state: "unknown", soldPrice: null }, epoch);
        } else {
          t.nextCheckAt = Date.now() + AUCTION_RETRY_MS;
          e.trackDirty.add(t.itemId);
        }
        // Stop after one failure rather than working down the list: a failing check is almost
        // always rate limiting or auth, which the next two calls would hit as well. The rows we
        // skip keep their schedules and come back on the next tick.
        recordError(u.id, e.s.q, `sold check: ${message(err)}`);
        break;
      }
      // Same window on the way out: this answer describes a listing the search may no longer
      // match, and booking its sale would seed the fresh median with the old criteria's prices.
      if (stale(e, epoch)) break;
      const out = inferOutcome(t, res, Date.now());
      t.checksUsed++;
      if (out.kind === "defer") {
        t.nextCheckAt = out.nextCheckAt;
        e.trackDirty.add(t.itemId);
        continue;
      }
      await resolve(database, e, t, out, epoch);
    }
    await flushTracked(database, e);
    await flushCalls(database, u.id, u.calls); // piggyback the calls this side-task just spent
  } catch (err) {
    recordError(u.id, e.s.q, `sold check: ${message(err)}`); // warn only; the poll keeps its cadence
  }
}

// The other side of the same tick: spend quota that would otherwise expire at local midnight on
// checks the schedule hasn't asked for yet. A fixed-price listing gets four checks in its life,
// so it can sell inside a gap and stop being readable before the next one - the realized price
// is simply lost. Surplus buys those checks early.
//
// Everything that makes this safe lives in the two pure functions above: bonusBudget hands out
// only what the saved configuration will never need (so this can't slow a single poll, and
// can't engage the governor), and bonusEligible refuses the listings where an early answer would
// be a wrong one. `projected` is the caller's daily projection, the same figure the governor is
// about to be judged against.
export async function runBonusChecks(
  e: Entry,
  u: UserCtx,
  database: ReturnType<typeof db>,
  epoch: number,
  projected: number,
): Promise<void> {
  if (!e.s.trackSold || !e.tracked.size || stale(e, epoch)) return;
  const now = new Date();
  const today = now.toDateString();
  const done = bonusDone(e, today);
  const frac = counterDayFrac(u.snooze, now); // paced by the day the counter rolls on
  const spare = bonusBudget(usedToday(u.calls, today), QUOTA_CEILING, frac, projected);
  if (spare <= 0) return;
  const picks = bonusEligible(e.tracked.values(), done, now.getTime()).slice(0, Math.min(spare, MAX_CHECKS_PER_TICK));
  if (!picks.length) return;
  try {
    for (const t of picks) {
      u.calls.used++;
      // The one path that bills the surplus. Both counters move together, so `used` stays the
      // full billing total and the difference is what the configuration itself spent.
      u.calls.surplus++;
      // Stamped before the call, not after: an item whose check throws has still cost a call, and
      // retrying it on the next tick would spend the day's surplus on one broken listing.
      done.set(t.itemId, now.getTime());
      let res: CheckResult;
      try {
        res = u.ebay ? await checkItem(u.ebay, t.itemId) : mockCheckItem(t.lastPrice);
      } catch (err) {
        // Nothing is mutated on the way out, unlike the due loop: this listing's schedule was
        // never the reason we called, so there is nothing to move, and counting the attempt
        // would spend a real check the schedule still owes it. Break for the same reason the
        // due loop does - a failing check is nearly always rate limiting or auth.
        recordError(u.id, e.s.q, `surplus sold check: ${message(err)}`);
        break;
      }
      if (stale(e, epoch)) break; // an edit landed mid-call; this answer describes dropped criteria
      const out = inferOutcome(t, res, Date.now());
      if (out.kind === "defer") {
        // Normally the same boundary it already had, so this writes nothing. It differs only
        // when the row was sitting on a failure retry, and taking the schedule's own answer
        // back is the right move there.
        if (out.nextCheckAt !== t.nextCheckAt) {
          t.nextCheckAt = out.nextCheckAt;
          e.trackDirty.add(t.itemId);
        }
        continue;
      }
      await resolve(database, e, t, out, epoch);
    }
    await flushTracked(database, e);
    await flushCalls(database, u.id, u.calls);
  } catch (err) {
    recordError(u.id, e.s.q, `surplus sold check: ${message(err)}`); // warn only, like the due loop
  }
}

// Rebuilds one search's follows from its rows (reload). Split by state: what is still
// outstanding goes back on the schedule, what sold becomes deal context.
export function hydrateTracked(rows: readonly (typeof trackedItems.$inferSelect)[]): {
  tracked: Map<string, TrackedItem>;
  soldPrices: { price: number; atMs: number }[];
} {
  const tracked = new Map<string, TrackedItem>();
  const soldPrices: { price: number; atMs: number }[] = [];
  for (const r of rows) {
    if (r.state === "active") {
      if (!r.nextCheckAt) continue; // no schedule left to resume; the prune will take it
      tracked.set(r.itemId, {
        itemId: r.itemId,
        priceKind: r.priceKind as PriceKind,
        lastPrice: r.lastPrice,
        currency: r.currency,
        itemEndDate: r.itemEndDate?.getTime() ?? null,
        firstSeenAt: r.firstSeenAt.getTime(),
        nextCheckAt: r.nextCheckAt.getTime(),
        checksUsed: r.checksUsed,
      });
    } else if (r.state === "sold" && r.soldPrice != null && r.priceKind !== "offer_cap") {
      soldPrices.push({ price: r.soldPrice, atMs: (r.resolvedAt ?? r.firstSeenAt).getTime() });
    }
  }
  return { tracked, soldPrices };
}

// The realized-price context for a search's alerts, or null when there isn't enough of one to
// stand behind. Prices older than the window are dropped rather than aged down: what a thing
// sold for last quarter is not what it is worth now.
export function soldContext(
  sold: readonly { price: number; atMs: number }[],
  now: number,
): { typical: number | null; count: number } | null {
  const cutoff = now - SOLD_WINDOW_DAYS * DAY_MS;
  const prices = sold.filter((s) => s.atMs >= cutoff).map((s) => s.price);
  if (prices.length < SOLD_MIN_COUNT) return null;
  return { typical: median(prices), count: prices.length };
}
