import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { DELETE as alertsDELETE, GET as alertsGET } from "@/app/api/alerts/route";
import { DELETE as channelDELETE, PATCH as channelPATCH } from "@/app/api/channels/[id]/route";
import { GET as channelsGET, POST as channelsPOST } from "@/app/api/channels/route";
import { DELETE as credsDELETE } from "@/app/api/ebay-credentials/route";
import { DELETE as pushDELETE, POST as pushPOST } from "@/app/api/push/route";
import { DELETE as searchDELETE, PATCH as searchPATCH } from "@/app/api/searches/[id]/route";
import { GET as searchesGET, POST as searchesPOST } from "@/app/api/searches/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/settings/route";
import { GET as statusGET } from "@/app/api/status/route";
import { encryptSecret } from "@/lib/crypto";
import { alerts as alertsTable, channels, pushSubs, searches, users } from "@/lib/schema";
import { freshTestDb } from "./helpers/db";

// Cross-tenant isolation. Ownership is enforced by a WHERE clause on every route (or, for
// searches, by the cached entry's userId) and by nothing else - no middleware, no row-level
// security - so this is the whole defense, driven end to end: seed everything as A, then run B at
// every route that reads or writes.
//
// The assertions are on DB state, not only status. A 404 and a 200 no-op are both fine answers to
// B; silently mutating A's row is not, and only a re-query tells those apart. Each test also runs
// A against the same route, or a bug that refused everyone would read as a pass.

const HEADER = "x-forwarded-email";
const A = "alice@example.com";
const B = "bob@example.com";
const A_WEBHOOK = "https://discord.com/api/webhooks/1/alice-token";
const A_ENDPOINT = "https://fcm.googleapis.com/fcm/send/alice-device";

function as(email: string, url: string, init?: { method?: string; body?: unknown }): Request {
  return new Request(url, {
    method: init?.method,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { [HEADER]: email },
  });
}

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

const ids = (rows: unknown) => (rows as { id: number }[]).map((r) => r.id);

let database: Awaited<ReturnType<typeof freshTestDb>>;
let a: { userId: number; searchId: number; channelId: number; alertId: number; secretEnc: string };
let bId: number;

beforeEach(async () => {
  database = await freshTestDb();
  // proxy is the cheaper of the two multi-user modes to drive: one header, no JWKS. The ownership
  // clauses under test are mode-independent - they only ever see the resolved user id.
  process.env.AUTH_MODE = "proxy";
  process.env.AUTH_TRUSTED_HEADER = HEADER;
  // Real ciphertext rather than a placeholder, so the cache reload the routes trigger decrypts it
  // instead of logging a warning that has nothing to do with what's under test.
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

  const { search } = await json(
    await searchesPOST(as(A, "http://localhost/api/searches", { method: "POST", body: { q: "leica m6" } })),
  );
  const { channel } = await json(
    await channelsPOST(as(A, "http://localhost/api/channels", { method: "POST", body: { webhookUrl: A_WEBHOOK } })),
  );
  const subscribed = await pushPOST(
    as(A, "http://localhost/api/push", {
      method: "POST",
      body: { endpoint: A_ENDPOINT, keys: { p256dh: "alice-p256dh", auth: "alice-auth" } },
    }),
  );
  expect(subscribed.status).toBe(201);
  await settingsPUT(
    as(A, "http://localhost/api/settings", {
      method: "PUT",
      body: { enabled: true, start: "01:30", end: "06:45", tz: "UTC" },
    }),
  );

  const { id: searchId, userId } = search as { id: number; userId: number };
  // No route mints an alert (the poller does) and none stores eBay keys without a live token
  // request, so those two go straight into the rows the routes read back.
  const [alert] = await database
    .insert(alertsTable)
    .values({
      userId,
      searchId,
      searchQ: "leica m6",
      itemId: "v1|111|0",
      title: "M6 body",
      itemUrl: "https://ebay.test/111",
    })
    .returning({ id: alertsTable.id });
  const secretEnc = encryptSecret("alice-client-secret", String(userId));
  await database
    .update(users)
    .set({ ebayClientId: "alice-client-id", ebayClientSecretEnc: secretEnc, ebayVerifiedAt: new Date() })
    .where(eq(users.id, userId));

  a = { userId, searchId, channelId: (channel as { id: number }).id, alertId: alert.id, secretEnc };
  await searchesGET(as(B, "http://localhost/api/searches")); // provisions B
  const [rowB] = await database.select({ id: users.id }).from(users).where(eq(users.email, B));
  bId = rowB.id;
  expect(bId).not.toBe(a.userId);
});

afterAll(() => {
  // freshTestDb clears AUTH_MODE, but not these two, and bun runs every test file in one process.
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUSTED_HEADER;
  delete process.env.ENCRYPTION_KEY;
});

test("B's search list and status carry nothing of A's", async () => {
  const listed = await json(await searchesGET(as(B, "http://localhost/api/searches")));
  expect(listed.searches).toEqual([]);

  const status = await json(await statusGET(as(B, "http://localhost/api/status")));
  // timers counts the caller's own enabled searches, so A's would surface here as a count leak.
  expect(status.poller).toMatchObject({ timers: 0 });
  expect(status.user).not.toMatchObject({ email: A });
  expect(status.ebay).toMatchObject({ clientId: null });

  const mine = await json(await searchesGET(as(A, "http://localhost/api/searches")));
  expect(ids(mine.searches)).toEqual([a.searchId]);
});

test("B cannot PATCH or DELETE A's search", async () => {
  const url = `http://localhost/api/searches/${a.searchId}`;
  const body = { intervalMin: 60, enabled: false };
  const patched = await searchPATCH(as(B, url, { method: "PATCH", body }), params(a.searchId));
  expect(patched.status).toBe(404);
  const removed = await searchDELETE(as(B, url, { method: "DELETE" }), params(a.searchId));
  expect(removed.status).toBe(404);

  const [row] = await database.select().from(searches).where(eq(searches.id, a.searchId));
  expect(row).toMatchObject({ userId: a.userId, q: "leica m6", intervalMin: 5, enabled: true });

  // The cache entry has to survive too, or the search stops polling for A whether or not its row
  // is intact. A's own list is served entirely from that cache.
  const mine = await json(await searchesGET(as(A, "http://localhost/api/searches")));
  expect(ids(mine.searches)).toEqual([a.searchId]);
  const owner = await searchPATCH(as(A, url, { method: "PATCH", body: { intervalMin: 60 } }), params(a.searchId));
  expect(owner.status).toBe(200);
});

test("B cannot route a search to A's Discord webhook", async () => {
  const res = await searchesPOST(
    as(B, "http://localhost/api/searches", {
      method: "POST",
      body: { q: "stolen route", channelId: a.channelId },
    }),
  );
  expect(res.status).toBe(400);
  expect(await database.select().from(searches).where(eq(searches.userId, bId))).toEqual([]);
});

test("B's alert reads and clears never touch A's history", async () => {
  const listed = await json(await alertsGET(as(B, "http://localhost/api/alerts")));
  expect(listed.alerts).toEqual([]);
  // searchId only narrows within the owner clause, so pointing it at A's search reads as an empty
  // history rather than theirs.
  const scoped = await json(await alertsGET(as(B, `http://localhost/api/alerts?searchId=${a.searchId}`)));
  expect(scoped.alerts).toEqual([]);

  // A bare DELETE means "clear all of mine". Without the owner clause it truncates the table.
  const all = await alertsDELETE(as(B, "http://localhost/api/alerts", { method: "DELETE" }));
  expect(all.status).toBe(200);
  const one = `http://localhost/api/alerts?searchId=${a.searchId}`;
  expect((await alertsDELETE(as(B, one, { method: "DELETE" }))).status).toBe(200);
  expect(ids(await database.select().from(alertsTable))).toEqual([a.alertId]);

  const mine = await json(await alertsGET(as(A, "http://localhost/api/alerts")));
  expect(ids(mine.alerts)).toEqual([a.alertId]);
});

test("B cannot read, rename, or delete A's channel", async () => {
  const listed = await json(await channelsGET(as(B, "http://localhost/api/channels")));
  expect(listed.channels).toEqual([]);

  const url = `http://localhost/api/channels/${a.channelId}`;
  const renamed = await channelPATCH(as(B, url, { method: "PATCH", body: { name: "Stolen" } }), params(a.channelId));
  expect(renamed.status).toBe(404);
  const res = await channelDELETE(as(B, url, { method: "DELETE" }), params(a.channelId));
  expect(res.status).toBe(404);
  expect((await database.select().from(channels)).map((r) => ({ id: r.id, userId: r.userId, name: r.name }))).toEqual([
    { id: a.channelId, userId: a.userId, name: null },
  ]);

  const mine = await json(await channelsGET(as(A, "http://localhost/api/channels")));
  // Masked to its tail, so even the owner's own read never hands the webhook token back to a page.
  expect(mine.channels).toEqual([{ id: a.channelId, kind: "discord", name: null, webhookUrl: "…-token" }]);
});

test("B cannot delete A's push subscription", async () => {
  // 200 rather than 404: the delete is a no-op, which tells B nothing about whether the endpoint
  // exists at all. What matters is that the row is still A's.
  const url = "http://localhost/api/push";
  const res = await pushDELETE(as(B, url, { method: "DELETE", body: { endpoint: A_ENDPOINT } }));
  expect(res.status).toBe(200);
  expect((await database.select().from(pushSubs)).map((r) => ({ endpoint: r.endpoint, userId: r.userId }))).toEqual([
    { endpoint: A_ENDPOINT, userId: a.userId },
  ]);
});

test("B's settings read and write never reach A's snooze", async () => {
  const mine = await json(await settingsGET(as(B, "http://localhost/api/settings")));
  // The users-table defaults, not A's window: a new user's first read must not inherit anyone's.
  expect(mine.snooze).toEqual({ enabled: false, start: "01:00", end: "07:00", tz: null });

  const body = { enabled: true, start: "22:00", end: "23:00" };
  const put = await settingsPUT(as(B, "http://localhost/api/settings", { method: "PUT", body }));
  expect(put.status).toBe(200);
  const [rowA] = await database.select().from(users).where(eq(users.id, a.userId));
  expect(rowA).toMatchObject({ snoozeEnabled: true, snoozeStart: 90, snoozeEnd: 405, snoozeTz: "UTC" });
  const [rowB] = await database.select().from(users).where(eq(users.id, bId));
  expect(rowB).toMatchObject({ snoozeEnabled: true, snoozeStart: 1320, snoozeEnd: 1380, snoozeTz: null });
});

test("B cannot clear A's eBay credentials", async () => {
  const url = "http://localhost/api/ebay-credentials";
  expect((await credsDELETE(as(B, url, { method: "DELETE" }))).status).toBe(200);
  const [rowA] = await database.select().from(users).where(eq(users.id, a.userId));
  expect(rowA).toMatchObject({ ebayClientId: "alice-client-id", ebayClientSecretEnc: a.secretEnc });
  expect(rowA.ebayVerifiedAt).not.toBeNull();

  // The owner's own removal still works, so the assertion above isn't passing on a dead handler.
  expect((await credsDELETE(as(A, url, { method: "DELETE" }))).status).toBe(200);
  const [cleared] = await database.select().from(users).where(eq(users.id, a.userId));
  expect(cleared).toMatchObject({ ebayClientId: null, ebayClientSecretEnc: null, ebayVerifiedAt: null });
});
