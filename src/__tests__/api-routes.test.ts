import { beforeEach, expect, test } from "bun:test";
import { DELETE as alertsDELETE, GET as alertsGET } from "@/app/api/alerts/route";
import { DELETE as searchDELETE, PATCH as searchPATCH } from "@/app/api/searches/[id]/route";
import { GET as searchesGET, POST as searchesPOST } from "@/app/api/searches/route";
import { GET as statusGET } from "@/app/api/status/route";
import { type Entry, type UserCtx } from "@/lib/poller";
import { alerts as alertsTable, searches } from "@/lib/schema";
import { freshTestDb } from "./helpers/db";
import { pollerState } from "./helpers/poller-state";

// A narrowed view of the poller's private State: only the fields these tests reach for.
type St = {
  ready: boolean;
  bootedAt: number | null;
  entries: Map<number, Entry>;
  users: Map<number, UserCtx>;
};
const st = (): St => pollerState<St>();

let database: Awaited<ReturnType<typeof freshTestDb>>;
beforeEach(async () => {
  database = await freshTestDb();
});

const create = (body: unknown) =>
  searchesPOST(new Request("http://localhost/api/searches", { method: "POST", body: JSON.stringify(body) }));

const patch = (id: number, body: unknown) =>
  searchPATCH(new Request(`http://localhost/api/searches/${id}`, { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: String(id) }),
  });

const remove = (id: number) =>
  searchDELETE(new Request(`http://localhost/api/searches/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: String(id) }),
  });

test("a created search enables sold tracking in the API and DB", async () => {
  const res = await create({ q: "leica m6", intervalMin: 10 });
  expect(res.status).toBe(201);
  const { search } = await res.json();
  expect(search).toMatchObject({ q: "leica m6", trackSold: true });

  const rows = await database.select().from(searches);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: search.id, q: "leica m6", intervalMin: 10, trackSold: true, enabled: true });

  const [direct] = await database
    .insert(searches)
    .values({ userId: rows[0].userId, q: "canon ae-1" })
    .returning({ trackSold: searches.trackSold });
  expect(direct.trackSold).toBe(true);
  // The row alone is not enough: without a cache entry the search never polls.
  expect(st().entries.has(search.id)).toBe(true);

  const listed = await (await searchesGET(new Request("http://localhost/api/searches"))).json();
  expect(listed.searches.map((s: { id: number }) => s.id)).toEqual([search.id]);
});

test("GET surfaces incomplete sold-price progress", async () => {
  const { search } = await (await create({ q: "leica m6" })).json();
  st().entries.get(search.id)!.soldPrices.push({ price: 900, atMs: Date.now() });

  const listed = await (await searchesGET(new Request("http://localhost/api/searches"))).json();
  expect(listed.searches[0]).toMatchObject({ soldMedian: null, soldSampleCount: 1 });
});

test("PATCH changes the interval and toggles enabled", async () => {
  const { search } = await (await create({ q: "nikon f3" })).json();

  const bumped = await patch(search.id, { intervalMin: 30 });
  expect(bumped.status).toBe(200);
  expect((await bumped.json()).search.intervalMin).toBe(30);

  const off = await patch(search.id, { enabled: false });
  expect((await off.json()).search.enabled).toBe(false);

  const [row] = await database.select().from(searches);
  expect(row).toMatchObject({ intervalMin: 30, enabled: false });
});

test("DELETE removes the row and the cache entry", async () => {
  const { search } = await (await create({ q: "rolleiflex" })).json();

  const res = await remove(search.id);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  expect(await database.select().from(searches)).toHaveLength(0);
  expect(st().entries.has(search.id)).toBe(false);
  expect(await remove(search.id)).toMatchObject({ status: 404 });
});

test("an out-of-range intervalMin is rejected and writes nothing", async () => {
  const res = await create({ q: "hasselblad", intervalMin: 90 });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "intervalMin must be 1-60" });
  expect(await database.select().from(searches)).toHaveLength(0);
});

test("the alerts ETag answers 304 until something invalidates it", async () => {
  // Created before ready flips: schedule() no-ops while the poller is down, so no tick can
  // insert an alert and bump the revision the exact-tag assertions below pin.
  const { search } = await (await create({ q: "leica m6" })).json();
  await database.insert(alertsTable).values([
    {
      userId: search.userId,
      searchId: search.id,
      searchQ: search.q,
      itemId: "v1|111|0",
      title: "M6 body",
      itemUrl: "https://ebay.test/111",
    },
    {
      userId: search.userId,
      searchId: search.id,
      searchQ: search.q,
      itemId: "v1|222|0",
      title: "M6 kit",
      itemUrl: "https://ebay.test/222",
    },
  ]);

  const s = st();
  s.ready = true;
  const bootedAt = Date.now();
  s.bootedAt = bootedAt;

  const first = await alertsGET(new Request("http://localhost/api/alerts"));
  expect(first.status).toBe(200);
  // Both rows default to the same statement timestamp, so the desc(createdAt) order is a tie.
  expect((await first.json()).alerts.map((a: { itemId: string }) => a.itemId).sort()).toEqual(["v1|111|0", "v1|222|0"]);
  // userId is in the tag, not just the Map key: without it a re-login would 304 onto the
  // previous user's alert list.
  const etag = first.headers.get("etag");
  expect(etag).toBe(`"${bootedAt}-${search.userId}-0"`);

  const revalidated = await alertsGET(
    new Request("http://localhost/api/alerts", { headers: { "if-none-match": etag! } }),
  );
  expect(revalidated.status).toBe(304);

  // The clear bumps the user's revision, so the tag a tab is holding must stop matching.
  const cleared = await alertsDELETE(new Request("http://localhost/api/alerts", { method: "DELETE" }));
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toEqual({ ok: true });
  expect(await database.select().from(alertsTable)).toHaveLength(0);

  const afterClear = await alertsGET(
    new Request("http://localhost/api/alerts", { headers: { "if-none-match": etag! } }),
  );
  expect(afterClear.status).toBe(200);
  expect(afterClear.headers.get("etag")).toBe(`"${bootedAt}-${search.userId}-1"`);
  expect(await afterClear.json()).toEqual({ alerts: [] });
});

test("status reports quota, mock mode and the snooze window", async () => {
  // caches the user ctx, without which ebay.mode reads no-creds
  const { search } = await (await create({ q: "contax t2" })).json();
  const u = st().users.get(search.userId)!;

  u.calls = { date: new Date().toDateString(), used: 7, surplus: 2 };
  // Anchored to the current minute rather than a fixed 00:00-23:59: the end is exclusive, so a
  // fixed full-day window reports inactive for the single minute of 23:59.
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = (nowMin + 1410) % 1440; // 30 min behind
  const end = (nowMin + 31) % 1440; // 31 min ahead, so `now` is inside the window either way
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  u.snooze = { enabled: true, start, end, tz: "UTC" };

  const body = await (await statusGET(new Request("http://localhost/api/status"))).json();
  expect(body.quota.used).toBe(7); // the combined total: what eBay actually billed
  expect(body.quota.surplus).toBe(2); // the slice of it the configuration never asked for
  expect(body.quota.ceiling).toBe(Number(process.env.EBAY_DAILY_QUOTA ?? 5000));
  expect(body.ebay.mode).toBe("mock");
  expect(body.snooze).toEqual({ active: true, window: `${hhmm(start)}–${hhmm(end)} UTC`, dailyMinutes: 61 });

  // surplus is a subset of used, so the payload never reports more of it than was billed - the
  // UI derives configured = used - surplus and would otherwise render a negative figure.
  u.calls = { date: new Date().toDateString(), used: 3, surplus: 9 };
  const clamped = await (await statusGET(new Request("http://localhost/api/status"))).json();
  expect(clamped.quota.surplus).toBe(3);

  // Yesterday's spend is not this day's: the counter is only trusted while its date is today.
  u.calls.date = "Mon Jan 01 2024";
  const rolled = await (await statusGET(new Request("http://localhost/api/status"))).json();
  expect(rolled.quota.used).toBe(0);
  expect(rolled.quota.surplus).toBe(0);
});
