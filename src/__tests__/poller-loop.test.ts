import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { freshTestDb } from "./helpers/db";
import { SINGLE_USER_EMAIL } from "@/lib/authmode";
import { db } from "@/lib/db";
import { alerts, searches, seenItems, users } from "@/lib/schema";
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
