import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { freshTestDb } from "./helpers/db";
import { SINGLE_USER_EMAIL } from "@/lib/authmode";
import { db } from "@/lib/db";
import { alerts, searches, seenItems, trackedItems, users } from "@/lib/schema";
import { userCtx } from "@/lib/poller/boot"; // not on the barrel: the reload seam is internal
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

beforeEach(async () => {
  database = await freshTestDb();
  [{ id: userId }] = await database.insert(users).values({ email: SINGLE_USER_EMAIL }).returning({ id: users.id });
  // 0.5 fails mockSearch's `< 0.4` roll, so the pool only ever grows when a test injects.
  realRandom = Math.random;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
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
  u.calls = { date: new Date().toDateString(), used: ceiling - 1 };

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
  const u = g.__ebaeState.users.get(userId)!;
  // A tenth of the budget spent - nowhere near the day's pace, whatever time the suite runs at.
  u.calls = { date: new Date().toDateString(), used: Math.floor(status(userId).quota.ceiling * 0.1) };

  expect(await delayAfterPoll(e)).toBe(5 * 60_000);
  expect(u.governorEngaged).toBe(false);
});

test("a poll running ahead of budget reschedules slower, and says so", async () => {
  const e = await seededEntry({ intervalMin: 5 });
  const u = g.__ebaeState.users.get(userId)!;
  const ceiling = status(userId).quota.ceiling;
  // Effectively the whole budget gone. However far into the day the suite runs, the remaining
  // budget cannot cover the remaining hours, so the governor is pinned at its cap.
  u.calls = { date: new Date().toDateString(), used: ceiling - 1 };

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
  // Local midnight has passed but this user hasn't polled since, so their counter still holds
  // yesterday's total. Read raw, that spend measured against a minutes-old day projects way
  // past the ceiling and pins every read path to the cap - for a user who has spent nothing.
  u.calls = { date: new Date(Date.now() - 86_400_000).toDateString(), used: ceiling - 1 };

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
  u.calls = { date: new Date().toDateString(), used: 700 };

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
  u.calls = { date: new Date().toDateString(), used: status(userId).quota.ceiling };

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
