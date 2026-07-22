import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { eq } from "drizzle-orm";
import { freshTestDb } from "./helpers/db";
import { SINGLE_USER_EMAIL } from "@/lib/authmode";
import { db } from "@/lib/db";
import { alerts, apiUsage, searches, seenItems, trackedItems, users } from "@/lib/schema";
import { userCtx } from "@/lib/poller/boot"; // not on the barrel: the reload seam is internal
import { flushCalls } from "@/lib/poller/quota"; // ditto: persistence is the poller's own business
import { BONUS_MIN_GAP_MS } from "@/lib/poller/track"; // ditto: the check schedule is internal
import {
  GOV_MAX_FACTOR,
  createSearch,
  listSearches,
  pollOnce,
  redeliverPending,
  setSnooze,
  status,
  updateSearch,
  type Entry,
  type SearchInput,
  type UserCtx,
} from "@/lib/poller";
import type { Item, PollError } from "@/lib/types";

// state() is module-private, so tests reach the same singleton the poller does.
type Cached = { ready: boolean; entries: Map<number, Entry>; users: Map<number, UserCtx>; errors: PollError[] };
const g = globalThis as typeof globalThis & {
  __ebaeState: Cached;
  __ebaeMock: { pools: Map<number, Item[]> };
  __ebaeDb: unknown;
};

const MOCK_POOL_SIZE = 8; // mockSearch seeds this many on a search's first poll

const input = (over: Partial<SearchInput> = {}): SearchInput => ({
  q: "leica m6",
  categoryId: null,
  priceFloor: null,
  priceCap: null,
  binOnly: true,
  includeAuctions: false,
  conditions: null,
  excludeTerms: null,
  trackSold: false,
  intervalMin: 5,
  ...over,
});

const injected = (over: Partial<Item> = {}): Item => ({
  itemId: "v1|injected-1|0",
  title: "leica m6 - injected listing",
  price: 1234.56,
  currency: "USD",
  shippingCost: 0,
  buyingOption: "FIXED_PRICE",
  condition: "Used",
  conditionId: "3000",
  imageUrl: null,
  itemUrl: "https://www.ebay.com/itm/injected-1",
  itemEndDate: null,
  bestOffer: false,
  ...over,
});

let database: Awaited<ReturnType<typeof freshTestDb>>;
let userId: number;
let realRandom: () => number;

// A wall-clock hour today, in the server's own zone - which is the zone an unset snooze reads.
const atLocal = (hour: number) => new Date(2026, 6, 19, hour, 0, 0);

beforeEach(async () => {
  // Pinned at local midnight, where no pollable time has elapsed yet and so no quota is surplus.
  // Without this every test below would spend a bonus check whenever the suite happened to run
  // after ~01:00, and mock mode sells whatever it is asked about.
  setSystemTime(atLocal(0));
  database = await freshTestDb();
  [{ id: userId }] = await database.insert(users).values({ email: SINGLE_USER_EMAIL }).returning({ id: users.id });
  // 0.5 fails mockSearch's `< 0.4` roll, so the pool only ever grows when a test injects.
  realRandom = Math.random;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
  setSystemTime();
});

async function seededEntry(over: Partial<SearchInput> = {}): Promise<Entry> {
  const s = await createSearch(userId, input(over));
  const e = g.__ebaeState.entries.get(s.id)!;
  await pollOnce(e);
  return e;
}

test("the first poll seeds the dedupe set without alerting", async () => {
  const s = await createSearch(userId, input());
  const e = g.__ebaeState.entries.get(s.id)!;
  await pollOnce(e);

  expect(e.s.seeded).toBe(true);
  const [row] = await database.select({ seeded: searches.seeded }).from(searches).where(eq(searches.id, s.id));
  expect(row.seeded).toBe(true);
  expect(await database.select().from(seenItems)).toHaveLength(MOCK_POOL_SIZE);
  expect(await database.select().from(alerts)).toHaveLength(0);
});

test("a new listing after seeding writes exactly one alert", async () => {
  const e = await seededEntry();
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);

  await pollOnce(e);

  const rows = await database.select().from(alerts);
  expect(rows).toHaveLength(1);
  expect(rows[0].itemId).toBe(item.itemId);
  expect(rows[0].title).toBe(item.title);
  expect(rows[0].price).toBe(item.price);
  // No channels and no push subscriptions, so the insert stamps delivery itself.
  expect(rows[0].deliveredAt).not.toBeNull();
  expect(await database.select().from(seenItems)).toHaveLength(MOCK_POOL_SIZE + 1);
});

test("turning on sold tracking persists without re-seeding", async () => {
  const e = await seededEntry();

  const updated = await updateSearch(userId, e.s.id, { trackSold: true });

  expect(updated?.trackSold).toBe(true);
  expect(updated?.seeded).toBe(true); // not a match field: the seen set survives
  expect(e.s.trackSold).toBe(true); // write-through, so the next tick sees it without a reload
  await pollOnce(e);
  expect(await database.select().from(trackedItems)).toHaveLength(0); // historical seed rows stay untracked
  const [row] = await database
    .select({ trackSold: searches.trackSold, seeded: searches.seeded })
    .from(searches)
    .where(eq(searches.id, e.s.id));
  expect(row).toEqual({ trackSold: true, seeded: true });
});

test("an exclude-terms hit is marked seen but never alerts", async () => {
  const e = await seededEntry({ excludeTerms: "broken, for parts" });
  const item = injected({ title: "leica m6 - broken shutter" });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);

  await pollOnce(e);

  expect(await database.select().from(alerts)).toHaveLength(0);
  const seen = await database.select().from(seenItems).where(eq(seenItems.itemId, item.itemId));
  expect(seen).toHaveLength(1);
});

test("an exhausted daily budget spends nothing and records the reason", async () => {
  const s = await createSearch(userId, input());
  const e = g.__ebaeState.entries.get(s.id)!;
  const u = g.__ebaeState.users.get(userId)!;
  const ceiling = status(userId).quota.ceiling;
  u.calls = { date: new Date().toDateString(), used: ceiling - 1, surplus: 0 };

  await pollOnce(e);

  expect(u.calls.used).toBe(ceiling);
  expect(e.s.seeded).toBe(true);

  await pollOnce(e);

  expect(u.calls.used).toBe(ceiling);
  expect(g.__ebaeState.errors.some((x) => x.message.includes("daily API budget exhausted"))).toBe(true);
});

test("a failing poll backs off by doubling, capped at 30 minutes", async () => {
  const s = await createSearch(userId, input());
  const e = g.__ebaeState.entries.get(s.id)!;
  const u = g.__ebaeState.users.get(userId)!;
  // Creds alone pick the live branch, which is what puts a fetch in the path to fail.
  u.ebay = {
    userId,
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    env: "production",
    marketplace: "EBAY_US",
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network unreachable");
  }) as typeof fetch;

  try {
    await pollOnce(e);
    expect(e.backoffMs).toBe(5 * 60_000);
    await pollOnce(e);
    expect(e.backoffMs).toBe(10 * 60_000);
    for (let i = 0; i < 4; i++) await pollOnce(e);
    expect(e.backoffMs).toBe(30 * 60_000);
  } finally {
    globalThis.fetch = realFetch;
  }

  u.ebay = null; // back to the mock branch, which can't fail
  await pollOnce(e);
  expect(e.backoffMs).toBe(0);
});

test("an over-age alert is retired without a delivery attempt", async () => {
  const s = await createSearch(userId, input());
  g.__ebaeState.users.get(userId)!.channels = ["https://discord.com/api/webhooks/1/test"];
  await database.insert(alerts).values({
    userId,
    searchId: s.id,
    searchQ: s.q,
    title: "leica m6",
    itemId: "stale",
    itemUrl: "https://www.ebay.com/itm/x",
    createdAt: new Date(Date.now() - 90 * 60_000),
  });

  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;

  try {
    await redeliverPending(db());
  } finally {
    globalThis.fetch = realFetch;
  }

  // The owner has a channel, so a surviving row would have been sent: zero calls is the proof
  // the age sweep retired it before the select.
  expect(calls).toBe(0);
  const [row] = await database.select({ deliveredAt: alerts.deliveredAt }).from(alerts);
  expect(row.deliveredAt).not.toBeNull();
});

test("an alert under the age cutoff is delivered, not retired", async () => {
  const alreadyDelivered = new Date("2026-01-01T00:00:00.000Z");
  const s = await createSearch(userId, input());
  g.__ebaeState.users.get(userId)!.channels = ["https://discord.com/api/webhooks/1/test"];
  const base = { userId, searchId: s.id, searchQ: s.q, title: "leica m6", itemUrl: "https://www.ebay.com/itm/x" };
  const [fresh] = await database
    .insert(alerts)
    .values({ ...base, itemId: "fresh" })
    .returning({ id: alerts.id });
  const [done] = await database
    .insert(alerts)
    .values({ ...base, itemId: "done", deliveredAt: alreadyDelivered })
    .returning({ id: alerts.id });

  const realFetch = globalThis.fetch;
  let calls = 0;
  // Succeeds first try on purpose: a failing send would add notify's 2s and 4s retry sleeps.
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;

  try {
    await redeliverPending(db());
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(calls).toBeGreaterThan(0);
  const byId = new Map(
    (await database.select({ id: alerts.id, deliveredAt: alerts.deliveredAt }).from(alerts)).map((r) => [r.id, r]),
  );
  expect(byId.get(fresh.id)!.deliveredAt).not.toBeNull();
  expect(byId.get(done.id)!.deliveredAt!.toISOString()).toBe(alreadyDelivered.toISOString());
});

// ---------- budget governor ----------
// The pure factor math is covered in poller.test.ts. What matters here is the wiring: that a
// poll which spent a call actually reschedules at the governed delay, and that the same factor
// reaches the UI. A correct formula nothing calls would pass every unit test and change nothing.

// schedule() hands its delay to setTimeout, so capture that rather than introspecting a Timer.
// The stub also keeps the callback from ever firing, which is what stops these tests leaking a
// live poll timer into the ones that follow.
function captureDelays() {
  const real = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    delays.push(ms);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  return { delays, restore: () => (globalThis.setTimeout = real) };
}

// Drive one poll with the state a test has set up and report the delay it rescheduled at.
async function delayAfterPoll(e: Entry): Promise<number> {
  g.__ebaeState.ready = true; // schedule() no-ops until the poller is ready
  const cap = captureDelays();
  try {
    await pollOnce(e);
    // schedule() is the last thing pollOnce does, after every await it makes.
    return cap.delays.at(-1)!;
  } finally {
    cap.restore();
    g.__ebaeState.ready = false;
  }
}

test("a poll within budget reschedules at exactly the configured interval", async () => {
  const e = await seededEntry({ intervalMin: 5 });
  setSystemTime(atLocal(12)); // midday, or the governor is inert before it ever looks at spend
  const u = g.__ebaeState.users.get(userId)!;
  // A tenth of the budget spent by midday - past the inert floor, nowhere near the day's pace.
  u.calls = { date: new Date().toDateString(), used: Math.floor(status(userId).quota.ceiling * 0.1), surplus: 0 };

  expect(await delayAfterPoll(e)).toBe(5 * 60_000);
  expect(u.governorEngaged).toBe(false);
});

test("a poll running ahead of budget reschedules slower, and says so", async () => {
  const e = await seededEntry({ intervalMin: 5 });
  const u = g.__ebaeState.users.get(userId)!;
  const ceiling = status(userId).quota.ceiling;
  // Midday: the governor is deliberately inert at the midnight the suite otherwise pins, since
  // no pollable time has elapsed for a projection to mean anything.
  setSystemTime(atLocal(12));
  // Effectively the whole budget gone, so the remaining budget cannot cover the remaining hours
  // and the governor is pinned at its cap.
  u.calls = { date: new Date().toDateString(), used: ceiling - 1, surplus: 0 };

  const delay = await delayAfterPoll(e);

  expect(delay).toBe(5 * 60_000 * GOV_MAX_FACTOR);
  expect(u.governorEngaged).toBe(true);
  // ...and the same stretch is what the searches list reports, so the row can't claim a
  // cadence the poller isn't using.
  expect(listSearches(userId)[0].effectiveIntervalMin).toBe(5 * GOV_MAX_FACTOR);
  expect(status(userId).quota.governor).toEqual({ active: true, factor: GOV_MAX_FACTOR });
});

test("a counter left over from yesterday engages nothing", async () => {
  await seededEntry({ intervalMin: 5 });
  const u = g.__ebaeState.users.get(userId)!;
  const ceiling = status(userId).quota.ceiling;
  setSystemTime(atLocal(12)); // midday, so reading the counter raw really would pin every path
  // Local midnight has passed but this user hasn't polled since, so their counter still holds
  // yesterday's total. Read raw, that spend measured against a minutes-old day projects way
  // past the ceiling and pins every read path to the cap - for a user who has spent nothing.
  u.calls = { date: new Date(Date.now() - 86_400_000).toDateString(), used: ceiling - 1, surplus: 0 };

  expect(status(userId).quota.used).toBe(0);
  expect(status(userId).quota.governor).toEqual({ active: false, factor: 1 });
  expect(listSearches(userId)[0].effectiveIntervalMin).toBe(5);
});

test("status projects the day's calls including each market sample", async () => {
  await createSearch(userId, input({ q: "plain", intervalMin: 10 })); // 144 polls/day
  await createSearch(userId, input({ q: "banded", intervalMin: 10, priceFloor: 100, priceCap: 500 })); // + 1 sample

  const { quota } = status(userId);
  expect(quota.projected).toBe(144 + 144 + 1);
  // Every row's own figure, summed, is the number shown against the ceiling - the browser used
  // to compute this itself and omit the market samples entirely.
  expect(listSearches(userId).reduce((n, s) => n + s.callsPerDay, 0)).toBe(quota.projected);
});

// The governor stretches intervals against the projection, so a check it can't see is a call
// it never budgeted for. Every followed listing carries the exact moment it comes due, which
// makes this an exact count rather than an estimate.
test("status projects the checks that come due in the next day", async () => {
  const e = await seededEntry({ intervalMin: 10, trackSold: true }); // 144 polls/day
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  expect(status(userId).quota.projected).toBe(144); // due in 3 days: not today's problem

  e.tracked.get(item.itemId)!.nextCheckAt = Date.now() + 3600_000;

  const { quota } = status(userId);
  expect(quota.projected).toBe(144 + 1);
  expect(listSearches(userId).reduce((n, s) => n + s.callsPerDay, 0)).toBe(quota.projected);

  // and it stops being projected the moment the search stops tracking
  await updateSearch(userId, e.s.id, { trackSold: false });
  expect(status(userId).quota.projected).toBe(144);
});

test("status exposes the configured work still remaining today", async () => {
  await createSearch(userId, input({ intervalMin: 10 }));
  const u = g.__ebaeState.users.get(userId)!;
  u.calls = { date: new Date().toDateString(), used: 700, surplus: 0 };

  const quota = status(userId).quota;

  expect(quota.remaining).toBe(quota.ceiling - quota.used);
  expect(quota.configuredForecast).toBe(quota.used + quota.configuredRemaining);
  expect(quota.overage).toBe(Math.max(quota.configuredForecast - quota.ceiling, 0));
});

test("a paused search costs nothing and drops out of the projection", async () => {
  const s = await createSearch(userId, input({ intervalMin: 10 }));
  expect(status(userId).quota.projected).toBe(144);

  await updateSearch(userId, s.id, { enabled: false });

  expect(status(userId).quota.projected).toBe(0);
});

test("saving an inactive snooze does not re-kick every search", async () => {
  await seededEntry();
  await seededEntry({ q: "second" });
  g.__ebaeState.ready = true;
  const real = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    delays.push(ms);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  try {
    const now = new Date();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    await setSnooze(userId, { enabled: true, start: (minute + 60) % 1440, end: (minute + 120) % 1440, tz: "UTC" });
    expect(delays).toHaveLength(2);
    expect(delays.every((ms) => ms >= 5 * 60_000)).toBe(true);
  } finally {
    globalThis.setTimeout = real;
    g.__ebaeState.ready = false;
  }
});

// ---------- sold-price tracking ----------

const trackedRows = () => database.select().from(trackedItems);

// The seed pass is silent by design, and following its backlog would spend a check on every
// listing that already existed when the search was created.
test("seeding a tracking search follows nothing", async () => {
  const s = await createSearch(userId, input({ trackSold: true }));
  await pollOnce(g.__ebaeState.entries.get(s.id)!);

  expect(await trackedRows()).toHaveLength(0);
});

test("an alerted listing is followed from the tick that alerted it", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);

  await pollOnce(e);

  const rows = await trackedRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].itemId).toBe(item.itemId);
  expect(rows[0].priceKind).toBe("fixed");
  expect(rows[0].lastPrice).toBe(item.price);
  expect(rows[0].state).toBe("active");
  // first decay step, three days out
  const days = (rows[0].nextCheckAt!.getTime() - Date.now()) / 86400_000;
  expect(days).toBeGreaterThan(2.9);
  expect(days).toBeLessThan(3.1);
  expect(e.tracked.get(item.itemId)).toBeDefined(); // and in memory, so no reload is needed first
});

// A listing the user excluded is exactly the junk ("for parts", "broken") whose realized price
// must not describe the thing they're hunting - the market baseline filters it for the same
// reason.
test("a suppressed listing is never followed", async () => {
  const e = await seededEntry({ trackSold: true, excludeTerms: "broken, for parts" });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(injected({ title: "leica m6 - broken shutter" }));

  await pollOnce(e);

  expect(await trackedRows()).toHaveLength(0);
});

test("a search without the toggle follows nothing", async () => {
  const e = await seededEntry();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(injected());

  await pollOnce(e);

  expect(await trackedRows()).toHaveLength(0);
});

// ---------- auctions as a sold-price signal on BIN-only searches ----------

const auctionItem = (over: Partial<Item> = {}): Item =>
  injected({
    itemId: "v1|auction-1|0",
    buyingOption: "AUCTION",
    itemEndDate: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...over,
  });

// A BIN-only search that tracks sold prices widens its query to auctions (see browseFilters),
// but an auction is never a Buy-It-Now result the user asked to be alerted on: it's followed
// only for the winning bid that will feed the sold median.
test("an auction on a BIN-only tracking search is followed but never alerted", async () => {
  const e = await seededEntry({ trackSold: true });
  const auction = auctionItem();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);

  await pollOnce(e);

  expect(await database.select().from(alerts)).toHaveLength(0); // never alerted
  expect(await database.select().from(seenItems).where(eq(seenItems.itemId, auction.itemId))).toHaveLength(1);
  const rows = (await trackedRows()).filter((r) => r.itemId === auction.itemId);
  expect(rows).toHaveLength(1);
  expect(rows[0].priceKind).toBe("bid"); // followed as an auction, checked at end + grace
  expect(e.hitTimes).toHaveLength(0); // not counted as a hit
});

// The winning bid lands in the same soldPrices pool the BIN solds use - one blended median, no
// source tag - which is the whole point: an auction's close price is a realized value too.
test("a sold auction's winning bid joins the blended sold pool", async () => {
  const e = await seededEntry({ trackSold: true });
  const auction = auctionItem({ itemId: "v1|auction-2|0", price: 300 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);
  await pollOnce(e);
  // drop it from the pool so the resolve check isn't deferred by a re-sighting
  g.__ebaeMock.pools.set(e.s.id, []);
  e.tracked.get(auction.itemId)!.nextCheckAt = Date.now() - 1000; // as if the auction had ended

  await pollOnce(e);

  const [row] = (await trackedRows()).filter((r) => r.itemId === auction.itemId);
  expect(row.state).toBe("sold");
  expect(row.priceKind).toBe("bid");
  expect(row.soldPrice).toBe(Math.round(auction.price! * 90) / 100); // mock sells at 90%
  expect(e.soldPrices).toEqual([{ price: Math.round(auction.price! * 90) / 100, atMs: expect.any(Number) }]);
});

// The suppression block runs before the auction branch, so an excluded auction ("for parts")
// is dropped the same way an excluded BIN listing is - its close price must not feed the median.
test("an excluded auction is suppressed, not followed", async () => {
  const e = await seededEntry({ trackSold: true, excludeTerms: "broken, for parts" });
  const auction = auctionItem({ itemId: "v1|auction-3|0", title: "leica m6 - broken, for parts" });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);

  await pollOnce(e);

  expect(await database.select().from(alerts)).toHaveLength(0);
  expect((await trackedRows()).filter((r) => r.itemId === auction.itemId)).toHaveLength(0);
  expect(await database.select().from(seenItems).where(eq(seenItems.itemId, auction.itemId))).toHaveLength(1);
});

// The tracking-only intercept is gated on trackSold, so a plain BIN-only search (no sold tracking)
// still ALERTS on an item eBay mislabels as an auction - normalize() calls any item without a
// FIXED_PRICE buyingOption an AUCTION, and silencing those would drop real alerts.
test("without sold tracking, an auction-typed item still alerts", async () => {
  const e = await seededEntry(); // trackSold defaults false
  const auction = auctionItem({ itemId: "v1|auction-6|0" });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);

  await pollOnce(e);

  const rows = await database.select().from(alerts);
  expect(rows).toHaveLength(1);
  expect(rows[0].itemId).toBe(auction.itemId);
  expect(rows[0].buyingOption).toBe("AUCTION");
  expect((await trackedRows()).filter((r) => r.itemId === auction.itemId)).toHaveLength(0); // not followed
});

// An auction with no end date can't be timed, so newTracked declines it (returns null). The loop
// must still mark it seen and never alert or crash - the null just means nothing is followed.
test("a dateless auction is marked seen but followed by nothing", async () => {
  const e = await seededEntry({ trackSold: true });
  const auction = auctionItem({ itemId: "v1|auction-5|0", itemEndDate: null });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);

  await pollOnce(e);

  expect(await database.select().from(alerts)).toHaveLength(0);
  expect((await trackedRows()).filter((r) => r.itemId === auction.itemId)).toHaveLength(0);
  expect(await database.select().from(seenItems).where(eq(seenItems.itemId, auction.itemId))).toHaveLength(1);
});

// Regression: when the user has opted auctions in, an auction still alerts and follows exactly
// as before - the tracking-only branch is gated on !includeAuctions.
test("with auctions included, an auction still alerts and is followed", async () => {
  const e = await seededEntry({ trackSold: true, includeAuctions: true });
  const auction = auctionItem({ itemId: "v1|auction-4|0" });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);

  await pollOnce(e);

  const rows = await database.select().from(alerts);
  expect(rows).toHaveLength(1);
  expect(rows[0].itemId).toBe(auction.itemId);
  expect(rows[0].buyingOption).toBe("AUCTION");
  const tracked = (await trackedRows()).filter((r) => r.itemId === auction.itemId);
  expect(tracked).toHaveLength(1);
  expect(tracked[0].priceKind).toBe("bid");
  expect(e.hitTimes).toHaveLength(1); // counted as a hit, unlike the BIN-only path
});

// The whole point of the schedule: a due check resolves the listing, spends exactly one call,
// and the realized price becomes the search's deal context.
test("a due check resolves the listing as sold and bills one call", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  // drop it back out of the pool so the next poll doesn't re-sight it and defer the check
  g.__ebaeMock.pools.set(e.s.id, []);
  const t = e.tracked.get(item.itemId)!;
  t.nextCheckAt = Date.now() - 1000; // as if the three days had passed
  const u = g.__ebaeState.users.get(userId)!;
  const before = u.calls.used;

  await pollOnce(e);

  expect(u.calls.used).toBe(before + 2); // one for the poll, one for the check
  const [row] = await trackedRows();
  expect(row.state).toBe("sold");
  expect(row.soldPrice).toBe(Math.round(item.price! * 90) / 100); // mock sells at 90%
  expect(row.resolvedAt).not.toBeNull();
  expect(e.tracked.size).toBe(0); // resolved rows leave the outstanding-work map
  expect(e.soldPrices).toHaveLength(1);
});

// Re-sighting is free evidence the listing is still for sale, so the check that came due is
// skipped rather than spent.
test("a re-sighting defers the due check instead of spending a call", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  const t = e.tracked.get(item.itemId)!;
  t.nextCheckAt = Date.now() - 1000;
  const u = g.__ebaeState.users.get(userId)!;
  const before = u.calls.used;

  await pollOnce(e); // the item is still in the mock pool, so this poll re-sights it

  expect(u.calls.used).toBe(before + 1); // the poll only - no check
  expect(e.tracked.get(item.itemId)!.nextCheckAt).toBeGreaterThan(Date.now());
  expect((await trackedRows())[0].state).toBe("active");
});

// Checks are the first thing to give up when the owner's budget is gone: they are a nicety,
// and spending the last calls on them would starve the polls that actually find deals.
test("an exhausted budget skips checks", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1000;
  const u = g.__ebaeState.users.get(userId)!;
  u.calls = { date: new Date().toDateString(), used: status(userId).quota.ceiling, surplus: 0 };

  await pollOnce(e);

  expect((await trackedRows())[0].state).toBe("active");
});

// Everything above lives in memory between reloads; a restart has to find it all again.
test("a reload rehydrates outstanding follows and realized prices", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const sold = injected({ itemId: "v1|sold-1|0" });
  await database.insert(trackedItems).values({
    searchId: e.s.id,
    itemId: sold.itemId,
    priceKind: "fixed",
    lastPrice: 500,
    state: "sold",
    soldPrice: 450,
    resolvedAt: new Date(),
  });

  g.__ebaeState.users.delete(userId); // forces the next userCtx to rebuild the whole cache
  await userCtx(userId);

  const reloaded = g.__ebaeState.entries.get(e.s.id)!;
  expect(reloaded.tracked.get(item.itemId)?.lastPrice).toBe(item.price);
  expect(reloaded.soldPrices).toEqual([{ price: 450, atMs: expect.any(Number) }]);
});

// A check that throws (rate limit, 5xx, an HTML gateway page) is the dangerous failure: eBay
// only returns a not-ok result for a listing it says is gone. If the row's schedule doesn't move,
// it stays due forever - one billed call every tick, and the rest of the check loop skipped.
test("a failing check moves the schedule instead of re-spending a call every tick", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  // Creds alone pick the live branch, which is what puts a throwing fetch in the check path.
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const realFetch = globalThis.fetch;
  let itemCalls = 0;
  // The poll itself must succeed - only the item check fails, which is the whole point: a poll
  // failure has its own backoff, while a check failure had no path out at all.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
    if (url.includes("/buy/browse/v1/item/")) {
      itemCalls++;
      return Response.json({ errors: [{ errorId: 2001 }] }, { status: 500 }); // not a "gone" code: throws
    }
    return Response.json({ itemSummaries: [] });
  }) as typeof fetch;

  try {
    e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1000;
    const before = u.calls.used;
    await pollOnce(e);

    expect(itemCalls).toBe(1);
    const t = e.tracked.get(item.itemId)!;
    expect(t.nextCheckAt).toBeGreaterThan(Date.now()); // rescheduled, not left permanently due
    expect(t.checksUsed).toBe(1); // the call it spent was accounted for
    expect(u.calls.used - before).toBe(2); // one poll + one check, both billed

    await pollOnce(e);
    // Nothing is due any more, so the second tick spends nothing on checks. Before the fix this
    // was another billed call, every tick, forever.
    expect(itemCalls).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
    u.ebay = null;
  }
});

// ---------- surplus-funded checks ----------

// A fixed-price listing gets four scheduled checks in its whole life, so it can sell in a gap
// and be unreadable by the time the next one lands - the price is gone. Quota that would expire
// at midnight instead buys the check early.
test("surplus quota pulls a sold check forward", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []); // no re-sighting, so nothing but a check can resolve it
  const u = g.__ebaeState.users.get(userId)!;
  const t = e.tracked.get(item.itemId)!;
  expect(t.nextCheckAt).toBeGreaterThan(Date.now()); // days from due: the schedule wants nothing yet

  setSystemTime(atLocal(12)); // half the pollable day gone, a 5-minute search barely dented it
  const before = u.calls.used;
  await pollOnce(e);

  expect(u.calls.used).toBe(before + 2); // the poll, plus a check nothing had scheduled
  // Only the check is surplus-funded. `used` stays the billing total (both calls hit eBay);
  // `surplus` is the slice the tile subtracts before judging the configuration's pace.
  expect(u.calls.surplus).toBe(1);
  const [row] = await trackedRows();
  expect(row.state).toBe("sold");
  expect(row.soldPrice).toBe(Math.round(item.price! * 90) / 100); // mock sells at 90%
  expect(e.tracked.size).toBe(0);
  expect(e.soldPrices).toHaveLength(1); // the realized price the gap would have swallowed
});

// The surplus is only what the saved configuration will never need. A user already spending at
// or ahead of pace has none, and their polls must not be competing with a nicety.
test("no surplus buys no early check", async () => {
  const e = await seededEntry({ trackSold: true });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(injected());
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;

  setSystemTime(atLocal(12));
  u.calls = { date: new Date().toDateString(), used: 4000, surplus: 0 }; // way past half the budget at midday
  await pollOnce(e);

  expect(u.calls.used).toBe(4001); // the poll only
  expect(u.calls.surplus).toBe(0); // a configured poll is never attributed to the surplus
  expect((await trackedRows())[0].state).toBe("active");
});

// The two counters persist through the same upsert, and each column takes its own greatest().
// A late flush carrying a stale snapshot (the shutdown path racing a piggyback) must not walk
// either one backwards.
test("flushCalls persists surplus beside used and never regresses either", async () => {
  const today = new Date().toDateString();
  expect(await flushCalls(database, userId, { date: today, used: 10, surplus: 3 })).toEqual({ used: 10, surplus: 3 });
  expect(await flushCalls(database, userId, { date: today, used: 7, surplus: 1 })).toEqual({ used: 10, surplus: 3 });
  const [row] = await database.select().from(apiUsage).where(eq(apiUsage.userId, userId));
  expect({ used: row.used, surplus: row.surplus }).toEqual({ used: 10, surplus: 3 });
});

// An early look that finds the listing still for sale has to leave the schedule exactly as it
// was. Spending a scheduled check here would mean the surplus quietly shortens the listing's
// real coverage - paying for extra looks by taking later ones away.
test("an early check that finds the listing still listed costs it nothing", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  const t = e.tracked.get(item.itemId)!;
  const boundary = t.nextCheckAt;
  // Creds alone pick the live branch, which is what lets the stub decide what the check finds.
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const realFetch = globalThis.fetch;
  let itemCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
    if (url.includes("/buy/browse/v1/item/")) {
      itemCalls++;
      return Response.json({
        price: { value: "1234.56", currency: "USD" },
        estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
      });
    }
    return Response.json({ itemSummaries: [] });
  }) as typeof fetch;

  try {
    setSystemTime(atLocal(12));
    await pollOnce(e);

    expect(itemCalls).toBe(1);
    expect(t.checksUsed).toBe(0); // the four the schedule owes it are all still there
    expect(t.nextCheckAt).toBe(boundary); // and it is still due when it was always due

    await pollOnce(e);
    // Spaced by BONUS_MIN_GAP_MS: without that, every tick of a five-minute search would re-check
    // the same listing until the surplus ran out.
    expect(itemCalls).toBe(1);

    // Once the gap has passed the listing is eligible again, and still on the same schedule -
    // that is what makes a second look free to take.
    setSystemTime(new Date(atLocal(12).getTime() + BONUS_MIN_GAP_MS));
    await pollOnce(e);
    expect(itemCalls).toBe(2);
    expect(t.checksUsed).toBe(0);
    expect(t.nextCheckAt).toBe(boundary);
  } finally {
    globalThis.fetch = realFetch;
    u.ebay = null;
  }
});

// The stamp ledger is rolled at the local day turn to bound its size, and that roll must not
// take the gap with it. A listing checked just before midnight is one the counter's fresh day
// makes affordable again within minutes, so a cleared map would re-ask, two minutes later, the
// question a call moments earlier had already answered.
test("the day roll does not hand a listing checked before midnight a free early look", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const realFetch = globalThis.fetch;
  let itemCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
    if (url.includes("/buy/browse/v1/item/")) {
      itemCalls++;
      return Response.json({
        price: { value: "1234.56", currency: "USD" },
        estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
      });
    }
    return Response.json({ itemSummaries: [] });
  }) as typeof fetch;

  try {
    setSystemTime(atLocal(23));
    await pollOnce(e);
    expect(itemCalls).toBe(1); // stamped just before the day turns

    // Two minutes past midnight: a new date, and usedToday resets on the same roll, so the pace
    // term opens a small budget immediately - the bonus pass really does run here.
    setSystemTime(new Date(2026, 6, 20, 0, 2, 0));
    await pollOnce(e);
    expect(itemCalls).toBe(1); // the gap survived the roll

    // And it still releases on the gap, measured from the check itself rather than from midnight.
    setSystemTime(atLocal(23).getTime() + BONUS_MIN_GAP_MS);
    await pollOnce(e);
    expect(itemCalls).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
    u.ebay = null;
  }
});

// The due loop answers a failed check by moving the schedule and counting an attempt, because a
// row left due would be re-picked every tick forever. A surplus check has no such problem - it
// was never due - so it must not touch either, or a rate-limited afternoon would walk listings
// toward "unknown" on checks the schedule never asked for.
test("a failing early check leaves the listing's schedule alone", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  const t = e.tracked.get(item.itemId)!;
  const boundary = t.nextCheckAt;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
    if (url.includes("/buy/browse/v1/item/")) {
      return Response.json({ errors: [{ errorId: 2001 }] }, { status: 500 }); // not a "gone" code: throws
    }
    return Response.json({ itemSummaries: [] });
  }) as typeof fetch;

  try {
    setSystemTime(atLocal(12));
    const before = u.calls.used;
    await pollOnce(e);

    expect(u.calls.used - before).toBe(2); // the call was spent, so it is billed
    expect(t.checksUsed).toBe(0);
    expect(t.nextCheckAt).toBe(boundary);
    expect((await trackedRows())[0].state).toBe("active");
  } finally {
    globalThis.fetch = realFetch;
    u.ebay = null;
  }
});

// The two check paths run back to back in one tick, and a scheduled check that finds the listing
// still for sale pushes it to the next decay step - which is exactly the profile the surplus pass
// hunts for. Without a shared ledger it would re-ask, in the same tick, the question the call a
// moment earlier had just answered.
test("a listing the schedule just checked is not checked again by the surplus pass", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const realFetch = globalThis.fetch;
  let itemCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
    if (url.includes("/buy/browse/v1/item/")) {
      itemCalls++;
      return Response.json({
        price: { value: "1234.56", currency: "USD" },
        estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
      });
    }
    return Response.json({ itemSummaries: [] });
  }) as typeof fetch;

  try {
    setSystemTime(atLocal(12)); // surplus available, so the bonus pass really does run
    const t = e.tracked.get(item.itemId)!;
    t.nextCheckAt = Date.now() - 1000; // due: the scheduled path takes it first
    const before = u.calls.used;
    await pollOnce(e);

    expect(itemCalls).toBe(1); // the due check, and nothing else
    expect(u.calls.used - before).toBe(2); // one poll, one check
    expect(t.nextCheckAt).toBeGreaterThan(Date.now()); // deferred to its next step, as usual
  } finally {
    globalThis.fetch = realFetch;
    u.ebay = null;
  }
});

// The sold median outranks every other basis, so a stale one is worse than a stale market
// baseline - which this same edit already clears.
test("editing what a search matches drops the realized prices with the baseline", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1000;
  await pollOnce(e); // resolves it: one realized price on the books
  expect(e.soldPrices).toHaveLength(1);
  expect(await trackedRows()).toHaveLength(1);

  await updateSearch(userId, e.s.id, { q: "something else entirely" });

  expect(e.soldPrices).toHaveLength(0); // those sales describe the old search
  expect(e.tracked.size).toBe(0); // and the outstanding follows would cost checks for it too
  expect(await trackedRows()).toHaveLength(0);
});

// The clear above is only half the guarantee. A tick that started before the edit is still
// holding references into the containers resetTracked replaced, and it resumes after the delete
// has already run - so its own writes land in the fresh generation and put back exactly what the
// edit removed. Both halves of that window are pinned below.
test("an edit landing mid-delivery can't insert follows the edit just cleared", async () => {
  const e = await seededEntry({ trackSold: true });
  const u = g.__ebaeState.users.get(userId)!;
  u.channels = ["https://discord.com/api/webhooks/1/test"];
  g.__ebaeMock.pools.get(e.s.id)!.unshift(injected());
  const realFetch = globalThis.fetch;
  // Delivery is the seam: the follow has been collected by now, but the batch insert that
  // persists it is still ahead of us.
  globalThis.fetch = (async () => {
    await updateSearch(userId, e.s.id, { q: "something else entirely" });
    return new Response("", { status: 204 });
  }) as typeof fetch;

  try {
    await pollOnce(e);
    expect(e.tracked.size).toBe(0);
    expect(await trackedRows()).toHaveLength(0); // and these rows would have survived a reload
  } finally {
    globalThis.fetch = realFetch;
    u.channels = [];
  }
});

test("an edit landing mid-check can't book a sale against the cleared criteria", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
    if (url.includes("/buy/browse/v1/item/")) {
      // The edit lands while the check is in flight, so the sale it reports describes the old
      // criteria - the exact thing the edit cleared the median to get rid of.
      await updateSearch(userId, e.s.id, { q: "something else entirely" });
      return Response.json({
        price: { value: "450.00", currency: "USD" },
        estimatedAvailabilities: [{ estimatedAvailabilityStatus: "OUT_OF_STOCK", estimatedSoldQuantity: 1 }],
      });
    }
    return Response.json({ itemSummaries: [] });
  }) as typeof fetch;

  try {
    e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1000;
    await pollOnce(e);
    expect(e.soldPrices).toHaveLength(0); // the sold median outranks every other basis
    expect(e.tracked.size).toBe(0);
    expect(await trackedRows()).toHaveLength(0);
  } finally {
    globalThis.fetch = realFetch;
    u.ebay = null;
  }
});

// The two tests above close the window around the eBay call. This one closes the narrower window
// inside the database call: every tracking write checks the epoch and THEN awaits a statement, so
// an edit arriving during that statement passes a check that was true and lands a write that no
// longer is. Fires the edit from inside the statement without awaiting it - an edit arrives on an
// API route, concurrently, never nested in the tick's own write.
function resetDuring(kind: "update" | "insert", fire: () => Promise<unknown>): () => Promise<unknown> {
  const real = g.__ebaeDb as Record<string, (t: unknown) => unknown>;
  let started: Promise<unknown> = Promise.resolve();
  let fired = false;
  const once = () => {
    if (fired) return;
    fired = true;
    started = fire();
  };
  g.__ebaeDb = new Proxy(real, {
    get(t, p, r) {
      if (p !== kind) return Reflect.get(t as object, p, r);
      return (tbl: unknown) => {
        const b = (t as never)[kind](tbl);
        if (tbl !== trackedItems) return b;
        if (kind === "update") {
          return {
            set: (v: unknown) => {
              const w = b.set(v);
              return {
                where: async (c: unknown) => (once(), w.where(c)),
              };
            },
          };
        }
        return {
          values: (v: unknown) => {
            const w = b.values(v);
            return {
              onConflictDoNothing: async (...a: unknown[]) => (once(), w.onConflictDoNothing(...a)),
              onConflictDoUpdate: async (...a: unknown[]) => (once(), w.onConflictDoUpdate(...a)),
            };
          },
        };
      };
    },
  });
  return async () => {
    g.__ebaeDb = real;
    await started;
  };
}

test("an edit during the follow insert doesn't leave the follow behind", async () => {
  const e = await seededEntry({ trackSold: true });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(injected());
  const settle = resetDuring("insert", () => updateSearch(userId, e.s.id, { q: "something else entirely" }));

  await pollOnce(e);
  await settle();

  expect(e.tracked.size).toBe(0);
  expect(await trackedRows()).toHaveLength(0);
});

// The last window, and the widest: reload() reads every follow in one snapshot and then hands
// the rebuilt maps to each entry. An edit is an API route, not a tick, so `running` is false the
// whole time - and the snapshot it rebuilds from was taken before the edit's DELETE ran. Fires
// the edit from inside the follow query, after the rows are in hand, which is exactly the
// interleaving that puts them back.
function resetDuringTrackedSelect(fire: () => Promise<unknown>): () => void {
  const real = g.__ebaeDb as Record<string, () => unknown>;
  let fired = false;
  g.__ebaeDb = new Proxy(real, {
    get(t, p, r) {
      if (p !== "select") return Reflect.get(t as object, p, r);
      return (...args: unknown[]) => {
        const b = (t as never).select(...args);
        return new Proxy(b as object, {
          get(bt, bp, br) {
            if (bp !== "from") return Reflect.get(bt, bp, br);
            return (tbl: unknown) => {
              const q = (bt as never).from(tbl);
              // Only the follow query, and only once: every other select still returns a builder
              // the caller goes on to chain .where/.groupBy onto.
              if (tbl !== trackedItems || fired) return q;
              fired = true;
              return (async () => {
                const rows = await q;
                await fire();
                return rows;
              })();
            };
          },
        });
      };
    },
  });
  return () => {
    g.__ebaeDb = real;
  };
}

test("an edit during a cache refresh can't restore the follows it just dropped", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  // A realized price on the books alongside the outstanding follow: the sold median outranks
  // every other basis, so it is the half that must not come back.
  await database.insert(trackedItems).values({
    searchId: e.s.id,
    itemId: "v1|sold-1|0",
    priceKind: "fixed",
    lastPrice: 500,
    state: "sold",
    soldPrice: 450,
    resolvedAt: new Date(),
  });
  const restore = resetDuringTrackedSelect(() => updateSearch(userId, e.s.id, { q: "something else entirely" }));

  try {
    g.__ebaeState.users.delete(userId); // forces userCtx to run a full reload
    await userCtx(userId);
  } finally {
    restore();
  }

  const reloaded = g.__ebaeState.entries.get(e.s.id)!;
  expect(reloaded.soldPrices).toHaveLength(0); // that sale describes criteria the search dropped
  expect(reloaded.tracked.size).toBe(0);
  expect(await trackedRows()).toHaveLength(0);
});

test("an edit during the deferral flush doesn't resurrect the row", async () => {
  const e = await seededEntry({ trackSold: true, excludeTerms: "broken" });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  expect(e.tracked.size).toBe(1);
  // Re-sighted at a new price (so harvest dirties it), alongside an excluded listing that opens
  // the connection without adding a follow - which is what makes the flush the tick's first write.
  g.__ebaeMock.pools.get(e.s.id)!.find((i) => i.itemId === item.itemId)!.price = 999;
  g.__ebaeMock.pools.get(e.s.id)!.unshift(injected({ itemId: "v1|junk|0", title: "leica m6 broken" }));
  const settle = resetDuring("insert", () => updateSearch(userId, e.s.id, { q: "something else entirely" }));

  await pollOnce(e);
  await settle();

  expect(await trackedRows()).toHaveLength(0);
});

test("an edit during the resolution write doesn't book the sale", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1000;
  const settle = resetDuring("update", () => updateSearch(userId, e.s.id, { q: "something else entirely" }));

  await pollOnce(e);
  await settle();

  expect(e.soldPrices).toHaveLength(0);
  expect(await trackedRows()).toHaveLength(0);
});

// The counterpart: an edit that doesn't change what the search matches must keep everything.
test("a non-criteria edit keeps the realized prices", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1000;
  await pollOnce(e);
  expect(e.soldPrices).toHaveLength(1);

  await updateSearch(userId, e.s.id, { intervalMin: 15 });

  expect(e.soldPrices).toHaveLength(1);
  expect(await trackedRows()).toHaveLength(1);
});
