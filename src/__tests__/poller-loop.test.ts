import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { freshTestDb } from "./helpers/db";
import { stubEbayLive } from "./helpers/ebay-stub";
import { mkItem } from "./helpers/fixtures";
import { SINGLE_USER_EMAIL } from "@/lib/authmode";
import { db } from "@/lib/db";
import { alerts, apiUsage, channels, searches, seenItems, trackedItems, users } from "@/lib/schema";
import { userCtx } from "@/lib/poller/boot"; // not on the barrel: the reload seam is internal
import { schedule } from "@/lib/poller/loop"; // ditto: scheduler state is internal
import { priceContext } from "@/lib/poller/market"; // same: it is the poller's DB fallback
import { flushCalls } from "@/lib/poller/quota"; // ditto: persistence is the poller's own business
import { BONUS_MIN_GAP_MS, runDueChecks } from "@/lib/poller/track"; // ditto: the check schedule is internal
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
import type { Item } from "@/lib/types";

// state() is module-private, so tests reach the same singleton the poller does.
type Cached = { ready: boolean; entries: Map<number, Entry>; users: Map<number, UserCtx> };
const g = globalThis as typeof globalThis & {
  __ebaeState: Cached;
  __ebaeMock: { pools: Map<number, Item[]> };
  __ebaeDb: unknown;
};

const MOCK_POOL_SIZE = 8; // mockSearch seeds this many on a search's first poll

const input = (over: Partial<SearchInput> = {}): SearchInput => ({
  q: "leica m6",
  name: null,
  categoryId: null,
  priceFloor: null,
  priceCap: null,
  binOnly: true,
  includeAuctions: false,
  conditions: null,
  excludeTerms: null,
  trackSold: false,
  intervalMin: 5,
  channelId: null,
  ...over,
});

const webhook = () => ({
  id: 1,
  name: null,
  webhookUrl: "https://discord.com/api/webhooks/1/test",
});

const injected = (over: Partial<Item> = {}): Item =>
  mkItem({
    itemId: "v1|injected-1|0",
    title: "leica m6 - injected listing",
    price: 1234.56,
    itemUrl: "https://www.ebay.com/itm/injected-1",
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

test("renaming a search keeps its current poll schedule", async () => {
  const e = await seededEntry();
  g.__ebaeState.ready = true;
  e.backoffMs = 30_000;
  schedule(e, 60_000);
  const timer = e.timer;

  const updated = await updateSearch(userId, e.s.id, { name: "Leica Plan B" });

  expect(updated?.name).toBe("Leica Plan B");
  expect(e.backoffMs).toBe(30_000);
  expect(e.timer).toBe(timer);
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
  expect(status(userId).errors.some((x) => x.message.includes("daily API budget exhausted"))).toBe(true);
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

test("a failed live poll keeps its captured identity through a concurrent rename", async () => {
  const s = await createSearch(userId, input({ q: "original query", name: "Original name" }));
  const e = g.__ebaeState.entries.get(s.id)!;
  const u = g.__ebaeState.users.get(userId)!;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    if (String(request).includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
    await updateSearch(userId, e.s.id, { q: "renamed query", name: "Renamed name" });
    return Response.json({ errors: [{ errorId: 2001 }] }, { status: 500 });
  }) as typeof fetch;

  try {
    await pollOnce(e);
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(status(userId).errors).toMatchObject([{ searchQ: "original query", searchName: "Original name" }]);
});

test("a truncated Browse episode warns once and rearms after a complete result", async () => {
  const s = await createSearch(userId, input());
  const e = g.__ebaeState.entries.get(s.id)!;
  const u = g.__ebaeState.users.get(userId)!;
  u.ebay = {
    userId,
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    env: "production",
    marketplace: "EBAY_US",
  };
  const realFetch = globalThis.fetch;
  let total = 201;
  globalThis.fetch = (async (request: RequestInfo | URL) =>
    String(request).includes("/oauth2/token")
      ? Response.json({ access_token: "t", expires_in: 7200 })
      : Response.json({ total, itemSummaries: [] })) as typeof fetch;
  const warnings = () => status(userId).errors.filter((x) => x.message.includes("more than 200 matches")).length;

  try {
    await pollOnce(e);
    expect(warnings()).toBe(1);
    await pollOnce(e);
    expect(warnings()).toBe(1);
    total = 200;
    await pollOnce(e);
    expect(warnings()).toBe(1);
    total = 201;
    await pollOnce(e);
    expect(warnings()).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
    u.ebay = null;
  }
});

test("an over-age alert is retired without a delivery attempt", async () => {
  const s = await createSearch(userId, input());
  g.__ebaeState.users.get(userId)!.channels = [webhook()];
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
  g.__ebaeState.users.get(userId)!.channels = [webhook()];
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

test("redelivery follows the search's current Discord destination", async () => {
  const s = await createSearch(userId, input());
  const saved = await database
    .insert(channels)
    .values([
      { userId, kind: "discord", webhookUrl: "https://discord.com/api/webhooks/1/one" },
      { userId, kind: "discord", webhookUrl: "https://discord.com/api/webhooks/2/two" },
    ])
    .returning({ id: channels.id, webhookUrl: channels.webhookUrl });
  g.__ebaeState.users.get(userId)!.channels = saved.map((channel) => ({ ...channel, name: null }));
  await updateSearch(userId, s.id, { channelId: saved[1].id });
  await database.insert(alerts).values({
    userId,
    searchId: s.id,
    searchQ: s.q,
    itemId: "routed",
    title: "leica m6",
    itemUrl: "https://www.ebay.com/itm/routed",
  });
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((request: RequestInfo | URL) => {
    calls.push(String(request));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  try {
    await redeliverPending(db());
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(calls).toEqual([saved[1].webhookUrl]);
});

test("a redelivery failure retains the alert's saved-search identity", async () => {
  const s = await createSearch(userId, input({ q: "current query", name: "Current name" }));
  g.__ebaeState.users.get(userId)!.channels = [webhook()];
  await database.insert(alerts).values({
    userId,
    searchId: s.id,
    searchQ: "original query",
    searchName: "Original name",
    itemId: "pending",
    title: "Leica M6",
    itemUrl: "https://www.ebay.com/itm/pending",
  });

  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  let payload: { embeds: Array<Record<string, unknown>> } | undefined;
  globalThis.fetch = ((_request: RequestInfo | URL, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    return Promise.resolve(new Response("nope", { status: 500 }));
  }) as typeof fetch;
  globalThis.setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    await redeliverPending(db());
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }

  expect(status(userId).errors).toMatchObject([
    { searchQ: "original query", searchName: "Original name", message: "redeliver: Discord webhook 500" },
  ]);
  expect(payload?.embeds[0]).toMatchObject({ footer: { text: 'ebae · matched "Original name"' } });
});

test("redelivery preserves the price-drop message", async () => {
  const s = await createSearch(userId, input());
  g.__ebaeState.users.get(userId)!.channels = [webhook()];
  await database.insert(alerts).values({
    userId,
    searchId: s.id,
    searchQ: s.q,
    itemId: "drop",
    title: "Sonos Era 300",
    price: 179.95,
    shippingCost: 0,
    kind: "price_drop",
    previousPrice: 200,
    itemUrl: "https://www.ebay.com/itm/drop",
  });
  const realFetch = globalThis.fetch;
  let payload: unknown;
  globalThis.fetch = ((_request: RequestInfo | URL, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  try {
    await redeliverPending(db());
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(payload).toMatchObject({
    embeds: [
      {
        color: 0x23a55a,
        description: "$179.95 · free shipping\n▼ $20.05 · 10% price drop",
        footer: { text: 'ebae · price drop · matched "leica m6"' },
      },
    ],
  });
});

test("a live alert targets only the search's selected Discord webhook", async () => {
  const e = await seededEntry();
  const saved = await database
    .insert(channels)
    .values([
      { userId, kind: "discord", webhookUrl: "https://discord.com/api/webhooks/1/one" },
      { userId, kind: "discord", webhookUrl: "https://discord.com/api/webhooks/2/two" },
    ])
    .returning({ id: channels.id, webhookUrl: channels.webhookUrl });
  const u = g.__ebaeState.users.get(userId)!;
  u.channels = saved.map((channel) => ({ ...channel, name: null }));
  await updateSearch(userId, e.s.id, { channelId: saved[1].id });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(injected());
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((request: RequestInfo | URL) => {
    calls.push(String(request));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  try {
    await pollOnce(e);
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(calls).toEqual([saved[1].webhookUrl]);
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

test("a re-sighted fixed-price listing records a price drop without another eBay check", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e); // original listing alert and its tracking row
  const u = g.__ebaeState.users.get(userId)!;
  const beforeCalls = u.calls.used;

  item.price = 900;
  await pollOnce(e);

  const rows = await database.select().from(alerts);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ itemId: item.itemId, price: 900, kind: "price_drop", previousPrice: 1000 });
  expect(u.calls.used - beforeCalls).toBe(1); // only the ordinary search poll
  expect(e.hitTimes).toHaveLength(1); // a price drop is not a newly-listed hit
  expect(status(userId).errors).toEqual([]); // recording the event must not abort the tick
});

test("a re-sighted listing that becomes excluded does not record a price drop", async () => {
  const e = await seededEntry({ trackSold: true, excludeTerms: "broken" });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);

  item.title = "leica m6 - broken shutter";
  item.price = 900;
  await pollOnce(e);

  expect(await database.select().from(alerts)).toHaveLength(1);
});

test("a re-sight price-drop write failure does not abort fresh listings", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  const fresh = injected({ itemId: "v1|after-drop-write-failure|0" });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);

  item.price = 900;
  g.__ebaeMock.pools.set(e.s.id, [item, fresh]);
  const realDatabase = g.__ebaeDb as { transaction: (...args: never[]) => Promise<unknown> };
  let transactionCalls = 0;
  g.__ebaeDb = new Proxy(realDatabase, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      return (...args: never[]) => {
        if (transactionCalls++ === 0) throw new Error("price-drop write unavailable");
        return target.transaction(...args);
      };
    },
  });

  try {
    await pollOnce(e);
    expect((await database.select().from(alerts)).some((a) => a.itemId === fresh.itemId)).toBe(true);
  } finally {
    g.__ebaeDb = realDatabase;
  }
});

test("a re-sighted price rise is persisted for a later price-drop alert", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, [item]); // no auction-backlog read may incidentally flush the row

  item.price = 1200;
  await pollOnce(e);

  const [row] = await database
    .select({ lastPrice: trackedItems.lastPrice })
    .from(trackedItems)
    .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, item.itemId)));
  expect(row.lastPrice).toBe(1200);
});

test("a re-sighted price drop keeps the listing Typical context", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  await database.insert(alerts).values([
    {
      userId,
      searchId: e.s.id,
      searchQ: e.s.q,
      itemId: "typical-1",
      title: "typical 1",
      price: 1100,
      itemUrl: "https://www.ebay.com/itm/typical-1",
    },
    {
      userId,
      searchId: e.s.id,
      searchQ: e.s.q,
      itemId: "typical-2",
      title: "typical 2",
      price: 1200,
      itemUrl: "https://www.ebay.com/itm/typical-2",
    },
  ]);
  const u = g.__ebaeState.users.get(userId)!;
  u.channels = [webhook()];
  let payload: { embeds: { fields: { name: string; value: string; inline: boolean }[] }[] } | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_request: RequestInfo | URL, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  try {
    item.price = 900;
    await pollOnce(e);
    expect(payload?.embeds[0].fields).toContainEqual({
      name: "Typical",
      value: "$1,100.00 · ▼ 18% under",
      inline: true,
    });
  } finally {
    globalThis.fetch = realFetch;
    u.channels = [];
  }
});

test("a listing that becomes an auction does not emit a live-bid price drop", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  const t = e.tracked.get(item.itemId)!;

  item.buyingOption = "AUCTION";
  item.itemEndDate = new Date(Date.now() + 30 * 60_000).toISOString();
  item.price = 900;
  await pollOnce(e);

  expect(await database.select().from(alerts)).toHaveLength(1);
  expect(t.lastPrice).toBe(1000);
});

test("a scheduled check records a lower in-stock price from its existing response", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []); // only the already-scheduled check can observe the change
  const u = g.__ebaeState.users.get(userId)!;
  const t = e.tracked.get(item.itemId)!;
  t.nextCheckAt = Date.now() - 1;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "900", currency: "USD" },
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );
  const beforeCalls = u.calls.used;

  try {
    await pollOnce(e);

    const rows = await database.select().from(alerts);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ itemId: item.itemId, price: 900, kind: "price_drop", previousPrice: 1000 });
    expect(t.lastPrice).toBe(900);
    expect(ebay.calls).toBe(1);
    expect(u.calls.used - beforeCalls).toBe(2); // one search and its one already-due item check
  } finally {
    ebay.restore();
    u.ebay = null;
  }
});

test("a scheduled check does not alert outside the saved price band", async () => {
  const e = await seededEntry({ trackSold: true, priceFloor: 500 });
  const item = injected({ price: 600 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "400", currency: "USD" },
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    await pollOnce(e);
    expect(await database.select().from(alerts)).toHaveLength(1);
  } finally {
    ebay.restore();
    u.ebay = null;
  }
});

test("a scheduled check does not alert a listing excluded on its last re-sighting", async () => {
  const e = await seededEntry({ trackSold: true, excludeTerms: "broken" });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);

  item.title = "leica m6 - broken shutter";
  await pollOnce(e); // refresh the tracked snapshot with the exclusion
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "900", currency: "USD" },
      buyingOptions: ["FIXED_PRICE"],
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    await pollOnce(e);
    expect(await database.select().from(alerts)).toHaveLength(1);
  } finally {
    ebay.restore();
    u.ebay = null;
  }
});

test("a price-drop delivery failure does not stop the remaining due checks", async () => {
  const e = await seededEntry({ trackSold: true });
  const first = injected({ itemId: "v1|delivery-first|0", price: 1000 });
  const second = injected({ itemId: "v1|delivery-second|0", price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(first, second);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  for (const t of e.tracked.values()) t.nextCheckAt = Date.now() - 1;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "900", currency: "USD" },
      buyingOptions: ["FIXED_PRICE"],
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    await runDueChecks(e, u, database, e.trackEpoch, async () => {
      throw new Error("delivery unavailable");
    });

    expect(ebay.calls).toBe(2);
    expect(e.tracked.get(second.itemId)?.lastPrice).toBe(900);
  } finally {
    ebay.restore();
    u.ebay = null;
  }
});

test("a scheduled check ignores a former fixed-price listing that is now an auction", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  const t = e.tracked.get(item.itemId)!;
  t.nextCheckAt = Date.now() - 1;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "900", currency: "USD" },
      buyingOptions: ["AUCTION"],
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    await pollOnce(e);

    expect(await database.select().from(alerts)).toHaveLength(1);
    expect(t.lastPrice).toBe(1000);
  } finally {
    ebay.restore();
    u.ebay = null;
  }
});

test("a scheduled check ignores a re-sighted auction when its compact response omits buying options", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);

  item.buyingOption = "AUCTION";
  item.itemEndDate = new Date(Date.now() + 30 * 60_000).toISOString();
  item.price = 900;
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  const t = e.tracked.get(item.itemId)!;
  t.nextCheckAt = Date.now() - 1;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "800", currency: "USD" },
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    await pollOnce(e);

    expect(await database.select().from(alerts)).toHaveLength(1);
    expect(t.lastPrice).toBe(1000);
  } finally {
    ebay.restore();
    u.ebay = null;
  }
});

test("a legacy tracked row without a price baseline recovers on its first fixed-price re-sighting", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  const t = e.tracked.get(item.itemId)!;
  t.lastPrice = null;
  t.notifiedPrice = null;
  await database
    .update(trackedItems)
    .set({ lastPrice: null, notifiedPrice: null })
    .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, item.itemId)));

  await pollOnce(e);

  expect(await database.select().from(alerts)).toHaveLength(1);
  expect(t.notifiedPrice).toBe(1000);
  const [row] = await database
    .select({ notifiedPrice: trackedItems.notifiedPrice })
    .from(trackedItems)
    .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, item.itemId)));
  expect(row.notifiedPrice).toBe(1000);

  item.price = 900;
  await pollOnce(e);

  expect((await database.select().from(alerts))[1]).toMatchObject({
    kind: "price_drop",
    previousPrice: 1000,
    price: 900,
  });
});

test("a scheduled fixed-price check recovers a missing price baseline without alerting", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const t = e.tracked.get(item.itemId)!;
  t.lastPrice = null;
  t.notifiedPrice = null;
  t.nextCheckAt = Date.now() - 1;
  await database
    .update(trackedItems)
    .set({ lastPrice: null, notifiedPrice: null, nextCheckAt: new Date(t.nextCheckAt) })
    .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, item.itemId)));
  const u = g.__ebaeState.users.get(userId)!;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "1000", currency: "USD" },
      buyingOptions: ["FIXED_PRICE"],
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    await pollOnce(e);
    expect(await database.select().from(alerts)).toHaveLength(1);
    expect(t.notifiedPrice).toBe(1000);
    const [row] = await database
      .select({ notifiedPrice: trackedItems.notifiedPrice })
      .from(trackedItems)
      .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, item.itemId)));
    expect(row.notifiedPrice).toBe(1000);
  } finally {
    ebay.restore();
    u.ebay = null;
  }
});

test("a scheduled check catches a pre-rollout lower price even when lastPrice already has it", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  const t = e.tracked.get(item.itemId)!;
  t.lastPrice = 900; // an older re-sighting, before price-drop alerts existed
  t.notifiedPrice = 1000; // migration's baseline from the original listing alert
  t.nextCheckAt = Date.now() - 1;
  await database
    .update(trackedItems)
    .set({ lastPrice: 900, notifiedPrice: 1000 })
    .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, item.itemId)));
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "900", currency: "USD" },
      buyingOptions: ["FIXED_PRICE"],
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    await pollOnce(e);

    expect(await database.select().from(alerts)).toHaveLength(2);
  } finally {
    ebay.restore();
    u.ebay = null;
  }
});

test("a re-sighting persists a recovered snapshot for later checks", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected({ price: 1000 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  const t = e.tracked.get(item.itemId)!;
  t.snapshot = null;
  g.__ebaeMock.pools.set(e.s.id, [item]); // no auction-backlog read to open a connection for us
  await database
    .update(trackedItems)
    .set({ snapshot: null })
    .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, item.itemId)));
  const [before] = await database
    .select({ snapshot: trackedItems.snapshot })
    .from(trackedItems)
    .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, item.itemId)));
  expect(before.snapshot).toBeNull();

  await pollOnce(e);

  const [row] = await database
    .select({ snapshot: trackedItems.snapshot })
    .from(trackedItems)
    .where(and(eq(trackedItems.searchId, e.s.id), eq(trackedItems.itemId, item.itemId)));
  expect(row.snapshot).toMatchObject({ itemId: item.itemId, price: item.price });
});

test("price-drop history does not change the recent listing-price baseline", async () => {
  const e = await seededEntry();
  await database.insert(alerts).values([
    {
      userId,
      searchId: e.s.id,
      searchQ: e.s.q,
      itemId: "v1|original|0",
      title: "original listing",
      price: 1000,
      itemUrl: "https://www.ebay.com/itm/original",
    },
    {
      userId,
      searchId: e.s.id,
      searchQ: e.s.q,
      itemId: "v1|drop|0",
      title: "price drop",
      price: 100,
      kind: "price_drop",
      previousPrice: 1000,
      itemUrl: "https://www.ebay.com/itm/drop",
    },
  ]);

  expect(await priceContext(database, e.s.id)).toEqual({ typical: 1000, count: 1 });
});

test("alert history keeps one listing and each distinct lower price", async () => {
  const e = await seededEntry();
  const base = {
    userId,
    searchId: e.s.id,
    searchQ: e.s.q,
    itemId: "v1|drop-index|0",
    title: "listing",
    itemUrl: "https://www.ebay.com/itm/drop-index",
  };
  const insert = (values: typeof alerts.$inferInsert) =>
    database.insert(alerts).values(values).onConflictDoNothing().returning({ id: alerts.id });

  expect(await insert({ ...base, price: 1000 })).toHaveLength(1);
  expect(await insert({ ...base, price: 1000 })).toHaveLength(0);
  expect(await insert({ ...base, price: 900, kind: "price_drop", previousPrice: 1000 })).toHaveLength(1);
  expect(await insert({ ...base, price: 800, kind: "price_drop", previousPrice: 900 })).toHaveLength(1);
  expect(await insert({ ...base, price: 900, kind: "price_drop", previousPrice: 1000 })).toHaveLength(0);
});

test("a reload does not count price drops as newly-listed hits", async () => {
  const e = await seededEntry();
  const listingAt = new Date(Date.now() - 10_000);
  const dropAt = new Date(Date.now());
  await database.insert(alerts).values([
    {
      userId,
      searchId: e.s.id,
      searchQ: e.s.q,
      itemId: "v1|original|0",
      title: "original listing",
      price: 1000,
      itemUrl: "https://www.ebay.com/itm/original",
      createdAt: listingAt,
    },
    {
      userId,
      searchId: e.s.id,
      searchQ: e.s.q,
      itemId: "v1|drop|0",
      title: "price drop",
      price: 900,
      kind: "price_drop",
      previousPrice: 1000,
      itemUrl: "https://www.ebay.com/itm/drop",
      createdAt: dropAt,
    },
  ]);

  g.__ebaeState.users.delete(userId);
  await userCtx(userId);

  const reloaded = g.__ebaeState.entries.get(e.s.id)!;
  expect(reloaded.hitTimes).toHaveLength(1);
  expect(reloaded.lastHitAt).toBe(listingAt.getTime());
});

// ---------- auctions as a sold-price signal on BIN-only searches ----------

const auctionItem = (over: Partial<Item> = {}): Item =>
  injected({
    itemId: "v1|auction-1|0",
    buyingOption: "AUCTION",
    itemEndDate: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...over,
  });

test("a price-drop row cannot seed the auction-tracking backlog", async () => {
  const e = await seededEntry({ trackSold: true });
  const auction = auctionItem({ itemId: "v1|drop-backlog|0" });
  e.seen.add(auction.itemId); // it is historical, not a newly-listed auction
  await database.insert(alerts).values({
    userId,
    searchId: e.s.id,
    searchQ: e.s.q,
    itemId: auction.itemId,
    title: auction.title,
    price: 900,
    kind: "price_drop",
    previousPrice: 1000,
    itemUrl: auction.itemUrl,
  });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);

  await pollOnce(e);

  expect(e.tracked.has(auction.itemId)).toBe(false);
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

// Backlog drain (the real prod gap): item 327262359421 was alerted as a $700 BIN before sold
// tracking existed, so it's in the seen set and has an alert row but was never followed. It then
// ran as an auction and closed at $705. `fresh` filters a seen item out of both follow paths, so
// the alert-gated backlog scan is what re-follows it for that winning bid.
const alertRow = (searchId: number, itemId: string) =>
  database.insert(alerts).values({
    userId,
    searchId,
    searchQ: "leica m6",
    itemId,
    title: "leica m6",
    buyingOption: "FIXED_PRICE",
    itemUrl: `https://www.ebay.com/itm/${itemId}`,
  });

test("an already-alerted item now running as an auction is followed on re-sight", async () => {
  const e = await seededEntry({ trackSold: true });
  const auction = auctionItem({ itemId: "v1|auction-seen|0" });
  // Alerted earlier as a BIN, before the feature shipped: seen + an alert row, but never followed.
  await database.insert(seenItems).values({ searchId: e.s.id, itemId: auction.itemId }).onConflictDoNothing();
  await alertRow(e.s.id, auction.itemId);
  e.seen.add(auction.itemId);
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);

  await pollOnce(e);

  expect(await database.select().from(alerts)).toHaveLength(1); // no NEW alert, just the seed one
  const rows = (await trackedRows()).filter((r) => r.itemId === auction.itemId);
  expect(rows).toHaveLength(1);
  expect(rows[0].priceKind).toBe("bid");
  expect(e.tracked.get(auction.itemId)).toBeDefined();
});

// A silently-seeded auction is never alerted, so the alert gate keeps it out - re-following the
// seed backlog would spend a check on every pre-existing listing, which "seeding follows nothing"
// exists to prevent.
test("a seen-but-never-alerted auction is not followed on re-sight", async () => {
  const e = await seededEntry({ trackSold: true });
  const auction = auctionItem({ itemId: "v1|auction-seed|0" });
  await database.insert(seenItems).values({ searchId: e.s.id, itemId: auction.itemId }).onConflictDoNothing();
  e.seen.add(auction.itemId); // seen, but no alert row
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);

  await pollOnce(e);

  expect((await trackedRows()).filter((r) => r.itemId === auction.itemId)).toHaveLength(0);
});

// The backlog scan runs the same exclusion checks as the fresh paths: even an alerted item whose
// title now reads "for parts" as an auction can't feed the median.
test("an alerted but now-excluded auction is not followed on re-sight", async () => {
  const e = await seededEntry({ trackSold: true, excludeTerms: "broken, for parts" });
  const auction = auctionItem({ itemId: "v1|auction-seen-x|0", title: "leica m6 - broken, for parts" });
  await database.insert(seenItems).values({ searchId: e.s.id, itemId: auction.itemId }).onConflictDoNothing();
  await alertRow(e.s.id, auction.itemId);
  e.seen.add(auction.itemId);
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);

  await pollOnce(e);

  expect((await trackedRows()).filter((r) => r.itemId === auction.itemId)).toHaveLength(0);
});

// Once followed, a re-sighted auction is in e.tracked, so the backlog scan skips it (gated on
// !e.tracked.has) and the free-refresh path handles it - one row, no memory churn.
test("a followed auction re-sighted is not followed a second time", async () => {
  const e = await seededEntry({ trackSold: true });
  const auction = auctionItem({ itemId: "v1|auction-dup|0" });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);
  await pollOnce(e); // first sight: followed as a fresh auction
  await pollOnce(e); // second sight: still in the pool

  expect((await trackedRows()).filter((r) => r.itemId === auction.itemId)).toHaveLength(1);
  expect(e.tracked.size).toBe(1);
});

// A resolved backlog auction that turns up again live must not be re-followed: its row is done,
// and re-adding it to memory would let a later check re-resolve it and double-count the close
// price. The DB insert conflict-no-ops; the returning() guard in insertTracked keeps memory in step.
test("a resolved auction is not re-followed if it reappears", async () => {
  const e = await seededEntry({ trackSold: true });
  const auction = auctionItem({ itemId: "v1|auction-resolved|0", price: 300 });
  // Backlog item: seen + alerted, so the scan follows it on the first poll.
  await database.insert(seenItems).values({ searchId: e.s.id, itemId: auction.itemId }).onConflictDoNothing();
  await alertRow(e.s.id, auction.itemId);
  e.seen.add(auction.itemId);
  g.__ebaeMock.pools.get(e.s.id)!.unshift(auction);
  await pollOnce(e); // backlog scan follows it
  expect(e.tracked.has(auction.itemId)).toBe(true);
  // Resolve it: drop from the pool and backdate the check so the next poll settles it as sold.
  g.__ebaeMock.pools.set(e.s.id, []);
  e.tracked.get(auction.itemId)!.nextCheckAt = Date.now() - 1000;
  await pollOnce(e);

  expect(e.soldPrices).toHaveLength(1);
  expect(e.tracked.has(auction.itemId)).toBe(false);

  // It reappears live in the results (still seen + alerted from before).
  g.__ebaeMock.pools.set(e.s.id, [auctionItem({ itemId: auction.itemId, price: 300 })]);
  await pollOnce(e);

  const [row] = (await trackedRows()).filter((r) => r.itemId === auction.itemId);
  expect(row.state).toBe("sold"); // still resolved, not reset to active
  expect(e.tracked.has(auction.itemId)).toBe(false); // not re-added to memory
  expect(e.soldPrices).toHaveLength(1); // and not double-counted
});

// Regression: when the drain is the only DB write in a tick, it must still open `wrote` so the
// piggyback flush rides its connection - otherwise a price the free-refresh loop harvested onto a
// followed fixed-price listing that same tick is stranded in memory until some later writing tick.
// The drain is the only DB write here, so it is what makes the free refresh durable.
test("the backlog drain flushes prices harvested the same tick", async () => {
  const e = await seededEntry({ trackSold: true });
  const followed = injected({ itemId: "v1|fixed-harvest|0", price: 300 });
  g.__ebaeMock.pools.get(e.s.id)!.unshift(followed);
  await pollOnce(e); // follow it as a fresh fixed-price listing, DB lastPrice = 300
  expect(e.tracked.get(followed.itemId)!.lastPrice).toBe(300);

  // A backlog auction (seen + alerted, never followed) is the only new write path this tick.
  const backlog = auctionItem({ itemId: "v1|auction-harvest-drain|0" });
  await database.insert(seenItems).values({ searchId: e.s.id, itemId: backlog.itemId }).onConflictDoNothing();
  await alertRow(e.s.id, backlog.itemId);
  e.seen.add(backlog.itemId);
  // Re-sight the followed listing at a higher price so harvest dirties it without a drop event.
  g.__ebaeMock.pools.set(e.s.id, [injected({ itemId: followed.itemId, price: 325 }), backlog]);

  await pollOnce(e);

  const [row] = (await trackedRows()).filter((r) => r.itemId === followed.itemId);
  expect(row.lastPrice).toBe(325); // harvested price reached the DB, not just memory
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
  expect(reloaded.tracked.get(item.itemId)?.notifiedPrice).toBe(item.price);
  expect(reloaded.tracked.get(item.itemId)?.snapshot).toMatchObject({ itemId: item.itemId, price: item.price });
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
  // The poll itself must succeed - only the item check fails, which is the whole point: a poll
  // failure has its own backoff, while a check failure had no path out at all.
  const ebay = stubEbayLive(() => Response.json({ errors: [{ errorId: 2001 }] }, { status: 500 })); // not a "gone" code: throws

  try {
    e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1000;
    const before = u.calls.used;
    await pollOnce(e);

    expect(ebay.calls).toBe(1);
    const t = e.tracked.get(item.itemId)!;
    expect(t.nextCheckAt).toBeGreaterThan(Date.now()); // rescheduled, not left permanently due
    expect(t.checksUsed).toBe(1); // the call it spent was accounted for
    expect(u.calls.used - before).toBe(2); // one poll + one check, both billed

    await pollOnce(e);
    // Nothing is due any more, so the second tick spends nothing on checks. Before the fix this
    // was another billed call, every tick, forever.
    expect(ebay.calls).toBe(1);
  } finally {
    ebay.restore();
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
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "1234.56", currency: "USD" },
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    setSystemTime(atLocal(12));
    await pollOnce(e);

    expect(ebay.calls).toBe(1);
    expect(t.checksUsed).toBe(0); // the four the schedule owes it are all still there
    expect(t.nextCheckAt).toBe(boundary); // and it is still due when it was always due

    await pollOnce(e);
    // Spaced by BONUS_MIN_GAP_MS: without that, every tick of a five-minute search would re-check
    // the same listing until the surplus ran out.
    expect(ebay.calls).toBe(1);

    // Once the gap has passed the listing is eligible again, and still on the same schedule -
    // that is what makes a second look free to take.
    setSystemTime(new Date(atLocal(12).getTime() + BONUS_MIN_GAP_MS));
    await pollOnce(e);
    expect(ebay.calls).toBe(2);
    expect(t.checksUsed).toBe(0);
    expect(t.nextCheckAt).toBe(boundary);
  } finally {
    ebay.restore();
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
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "1234.56", currency: "USD" },
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    setSystemTime(atLocal(23));
    await pollOnce(e);
    expect(ebay.calls).toBe(1); // stamped just before the day turns

    // Two minutes past midnight: a new date, and usedToday resets on the same roll, so the pace
    // term opens a small budget immediately - the bonus pass really does run here.
    setSystemTime(new Date(2026, 6, 20, 0, 2, 0));
    await pollOnce(e);
    expect(ebay.calls).toBe(1); // the gap survived the roll

    // And it still releases on the gap, measured from the check itself rather than from midnight.
    setSystemTime(atLocal(23).getTime() + BONUS_MIN_GAP_MS);
    await pollOnce(e);
    expect(ebay.calls).toBe(2);
  } finally {
    ebay.restore();
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
  const ebay = stubEbayLive(() => Response.json({ errors: [{ errorId: 2001 }] }, { status: 500 })); // not a "gone" code: throws

  try {
    setSystemTime(atLocal(12));
    const before = u.calls.used;
    await pollOnce(e);

    expect(u.calls.used - before).toBe(2); // the call was spent, so it is billed
    expect(t.checksUsed).toBe(0);
    expect(t.nextCheckAt).toBe(boundary);
    expect((await trackedRows())[0].state).toBe("active");
  } finally {
    ebay.restore();
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
  const ebay = stubEbayLive(() =>
    Response.json({
      price: { value: "1234.56", currency: "USD" },
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK", estimatedSoldQuantity: 0 }],
    }),
  );

  try {
    setSystemTime(atLocal(12)); // surplus available, so the bonus pass really does run
    const t = e.tracked.get(item.itemId)!;
    t.nextCheckAt = Date.now() - 1000; // due: the scheduled path takes it first
    const before = u.calls.used;
    await pollOnce(e);

    expect(ebay.calls).toBe(1); // the due check, and nothing else
    expect(u.calls.used - before).toBe(2); // one poll, one check
    expect(t.nextCheckAt).toBeGreaterThan(Date.now()); // deferred to its next step, as usual
  } finally {
    ebay.restore();
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
  u.channels = [webhook()];
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

function renameAfterAlertInsert(e: Entry, name: string): () => void {
  const real = g.__ebaeDb as Record<
    string,
    (fn: (tx: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>
  >;
  const searchId = e.s.id;
  g.__ebaeDb = new Proxy(real, {
    get(t, p, r) {
      if (p !== "transaction") return Reflect.get(t as object, p, r);
      return async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        let insertedAlert = false;
        const result = await t.transaction(async (tx) =>
          fn(
            new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                if (txProp !== "insert") return Reflect.get(txTarget, txProp, txReceiver);
                return (table: unknown) => {
                  if (table === alerts) insertedAlert = true;
                  return (txTarget.insert as (table: unknown) => unknown)(table);
                };
              },
            }),
          ),
        );
        if (insertedAlert) await updateSearch(userId, searchId, { name });
        return result;
      };
    },
  });
  return () => {
    g.__ebaeDb = real;
  };
}

test("a live alert keeps its captured identity through a concurrent rename", async () => {
  const e = await seededEntry({ q: "original query", name: "Original name" });
  const u = g.__ebaeState.users.get(userId)!;
  const item = injected();
  u.channels = [webhook()];
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);

  const restoreDb = renameAfterAlertInsert(e, "Renamed");
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  let payload: { embeds: Array<Record<string, unknown>> } | undefined;
  globalThis.fetch = ((_request: RequestInfo | URL, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    return Promise.resolve(new Response("nope", { status: 500 }));
  }) as typeof fetch;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms === 2000 || ms === 4000) {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout;

  try {
    await pollOnce(e);
  } finally {
    restoreDb();
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    u.channels = [];
  }

  const [alert] = await database.select({ searchQ: alerts.searchQ, searchName: alerts.searchName }).from(alerts);
  expect(alert).toEqual({ searchQ: "original query", searchName: "Original name" });
  expect(e.s.name).toBe("Renamed");
  expect(payload?.embeds[0]).toMatchObject({ footer: { text: 'ebae · matched "Original name"' } });
  expect(status(userId).errors).toMatchObject([
    { searchQ: "original query", searchName: "Original name", message: "Discord webhook 500" },
  ]);
});

test("an edit landing mid-check can't book a sale against the cleared criteria", async () => {
  const e = await seededEntry({ trackSold: true });
  const item = injected();
  g.__ebaeMock.pools.get(e.s.id)!.unshift(item);
  await pollOnce(e);
  g.__ebaeMock.pools.set(e.s.id, []);
  const u = g.__ebaeState.users.get(userId)!;
  u.ebay = { userId, clientId: "x", clientSecret: "y", env: "production", marketplace: "EBAY_US" };
  const ebay = stubEbayLive(async () => {
    // The edit lands while the check is in flight, so the sale it reports describes the old
    // criteria - the exact thing the edit cleared the median to get rid of.
    await updateSearch(userId, e.s.id, { q: "something else entirely" });
    return Response.json({
      price: { value: "450.00", currency: "USD" },
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "OUT_OF_STOCK", estimatedSoldQuantity: 1 }],
    });
  });

  try {
    e.tracked.get(item.itemId)!.nextCheckAt = Date.now() - 1000;
    await pollOnce(e);
    expect(e.soldPrices).toHaveLength(0); // the sold median outranks every other basis
    expect(e.tracked.size).toBe(0);
    expect(await trackedRows()).toHaveLength(0);
  } finally {
    ebay.restore();
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
            // Return the real builder (not an async wrapper): it is awaitable AND exposes
            // .returning(), which insertTracked now chains after .onConflictDoNothing(). Wrapping
            // it in an async fn hands back a bare Promise, so the .returning() call threw before
            // the statement ran and this test passed for the wrong reason. `once()` still fires at
            // call time via the comma, so the concurrent edit lands mid-statement as intended.
            return {
              onConflictDoNothing: (...a: unknown[]) => (once(), w.onConflictDoNothing(...a)),
              onConflictDoUpdate: (...a: unknown[]) => (once(), w.onConflictDoUpdate(...a)),
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
