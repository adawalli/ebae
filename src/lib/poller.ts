import { eq, gt, lt, max, sql } from "drizzle-orm";
import pkg from "../../package.json";
import { db, migrateToLatest } from "./db";
import { alerts, apiUsage, channels, searches, seenItems } from "./schema";
import { MARKETPLACE, MOCK, searchNewlyListed, tokenExpiresAt } from "./ebay";
import { notify } from "./discord";
import { log } from "./log";
import type { PollError, Search, SearchStats, StatusInfo } from "./types";

const plog = log.child({ component: "poller" });

const QUOTA_CEILING = Number(process.env.EBAY_DAILY_QUOTA ?? 5000);
export const DEFAULT_INTERVAL = Number(process.env.POLL_INTERVAL_DEFAULT ?? 5);
const REFRESH_HOURS = Number(process.env.CACHE_REFRESH_HOURS ?? 12);
const MAX_BACKOFF_MS = 30 * 60_000;

type Entry = {
  s: Search;
  seen: Set<string>;
  hitTimes: number[]; // alert timestamps within the last 24h
  lastHitAt: number | null;
  lastPolledAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  backoffMs: number; // 0 = healthy
  running: boolean; // a tick is in flight; blocks overlapping ticks
};

type State = {
  ready: boolean;
  bootError: string | null;
  bootedAt: number | null;
  entries: Map<number, Entry>;
  channels: string[];
  calls: { date: string; used: number };
  errors: PollError[];
};

// globalThis so instrumentation and route-handler bundles share one instance
const g = globalThis as typeof globalThis & { __ebaeState?: State };
function state(): State {
  return (g.__ebaeState ??= {
    ready: false,
    bootError: null,
    bootedAt: null,
    entries: new Map(),
    channels: [],
    calls: { date: new Date().toDateString(), used: 0 },
    errors: [],
  });
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// Single chokepoint for poll-loop failures: keeps the Status-page ring buffer
// and stdout in sync. level defaults to warn (transient/self-healing); pass
// "error" for terminal failures (e.g. a webhook dead after all retries).
function recordError(searchQ: string | null, msg: string, level: "warn" | "error" = "warn") {
  const st = state();
  st.errors.push({ time: new Date().toISOString(), searchQ, message: msg });
  if (st.errors.length > 100) st.errors.shift();
  plog[level]({ searchQ }, msg);
}

function rowToSearch(r: typeof searches.$inferSelect): Search {
  return {
    id: r.id,
    q: r.q,
    categoryId: r.categoryId,
    priceFloor: r.priceFloor, // numeric mode:"number" -> already number | null
    priceCap: r.priceCap,
    binOnly: r.binOnly,
    includeAuctions: r.includeAuctions,
    intervalMin: r.intervalMin,
    enabled: r.enabled,
    seeded: r.seeded,
    createdAt: r.createdAt.toISOString(),
  };
}

const BOOT_RETRY_MS = 15_000;

// Called once per server boot from instrumentation.ts
export async function boot() {
  const st = state();
  if (st.bootedAt) return;
  st.bootedAt = Date.now();
  // A clean restart (docker/k8s SIGTERM, Ctrl-C SIGINT) is the one case where we
  // can persist the exact count even after a run of empty polls: flush on the way
  // out. Best-effort - a SIGKILL or crash still falls back to the last poll write.
  // Requires NEXT_MANUAL_SIG_HANDLE=true (set in package.json + Dockerfile): without
  // it Next installs its own handler that process.exit()s and cuts our async flush
  // off mid-write, which we confirmed empirically.
  process.once("SIGTERM", shutdownFlush);
  process.once("SIGINT", shutdownFlush);
  await tryBoot();
}

let shuttingDown = false;
async function shutdownFlush(signal: NodeJS.Signals) {
  if (shuttingDown) return; // a second signal must not race a second flush/exit
  shuttingDown = true;
  const st = state();
  try {
    if (st.ready && st.calls.used > 0) {
      // Cap the wait so a suspended/hung Neon can't hold the process past the
      // container's shutdown grace period; the count is best-effort anyway.
      await Promise.race([flushCalls(db(), st.calls), new Promise((r) => setTimeout(r, 3000))]);
      // console.error (sync) not plog: a buffered pino write can be dropped by process.exit.
      console.error(`[poller] flushed call count on ${signal}: used=${st.calls.used} day="${st.calls.date}"`);
    }
  } catch (err) {
    console.error(`[poller] shutdown flush failed on ${signal}:`, err);
  } finally {
    // We own shutdown (NEXT_MANUAL_SIG_HANDLE), and the poll timers keep the event
    // loop alive, so nothing exits unless we say so.
    process.exit(0);
  }
}

// migrate/reload can throw if Postgres isn't up yet (compose start order,
// Neon cold-wake). Retry until it succeeds instead of leaving the poller dead
// for the life of the process.
async function tryBoot() {
  const st = state();
  try {
    await migrateToLatest();
    await reload();
    st.ready = true;
    st.bootError = null;
    plog.info(
      { searches: st.entries.size, channels: st.channels.length, mode: MOCK ? "mock" : "live" },
      "poller ready",
    );
    // jitter the first ticks so N searches don't hit eBay in the same second
    for (const e of st.entries.values()) schedule(e, 1000 + Math.random() * 5000);
    setInterval(
      () =>
        reload()
          .then(() => plog.info({ searches: st.entries.size, channels: st.channels.length }, "cache refreshed"))
          .catch((err) => recordError(null, `cache refresh: ${message(err)}`)),
      REFRESH_HOURS * 3600_000,
    );
  } catch (err) {
    st.bootError = message(err);
    recordError(null, `boot failed, retrying: ${st.bootError}`);
    setTimeout(() => void tryBoot(), BOOT_RETRY_MS);
  }
}

// Full DB → cache load. Runs at boot and every CACHE_REFRESH_HOURS; between
// those, the poller works purely from memory so serverless Postgres can sleep.
async function reload() {
  const database = db();
  const today = new Date().toDateString();
  // ponytail: fixed 90d retention, revisit if listings outlive it
  await database.delete(seenItems).where(lt(seenItems.seenAt, sql`now() - interval '90 days'`));
  const [searchRows, seenRows, hitRows, lastHitRows, channelRows] = await Promise.all([
    database.select().from(searches),
    database.select({ searchId: seenItems.searchId, itemId: seenItems.itemId }).from(seenItems),
    database
      .select({ searchId: alerts.searchId, createdAt: alerts.createdAt })
      .from(alerts)
      .where(gt(alerts.createdAt, sql`now() - interval '24 hours'`)),
    database
      .select({ searchId: alerts.searchId, last: max(alerts.createdAt) })
      .from(alerts)
      .groupBy(alerts.searchId),
    database.select({ webhookUrl: channels.webhookUrl }).from(channels).where(eq(channels.enabled, true)),
  ]);

  const st = state();
  const fresh = new Set<number>();
  for (const row of searchRows) {
    const s = rowToSearch(row);
    fresh.add(s.id);
    const existing = st.entries.get(s.id);
    if (existing) {
      // seeded only ever goes false->true; a stale DB snapshot must not revert a
      // concurrent tick that just finished seeding, or its search re-seeds and
      // swallows the next batch of real listings without alerting.
      if (existing.s.seeded) s.seeded = true;
      existing.s = s;
    } else {
      const entry: Entry = {
        s,
        seen: new Set(),
        hitTimes: [],
        lastHitAt: null,
        lastPolledAt: null,
        timer: null,
        backoffMs: 0,
        running: false,
      };
      st.entries.set(s.id, entry);
      // rows inserted into the DB directly start polling on the next refresh
      // (no-op during boot: ready is still false, boot() schedules everything)
      schedule(entry, 1000 + Math.random() * 5000);
    }
  }
  // Save in-memory hit data before rebuild: a concurrent tick may have newer
  // data than the snapshot just queried.
  const savedHitTimes = new Map<number, number[]>();
  const savedLastHitAt = new Map<number, number | null>();
  for (const [id, e] of st.entries) {
    savedHitTimes.set(id, e.hitTimes.slice());
    savedLastHitAt.set(id, e.lastHitAt);
  }

  for (const [id, e] of st.entries) {
    if (!fresh.has(id)) {
      if (e.timer) clearTimeout(e.timer);
      st.entries.delete(id);
      continue;
    }
    e.hitTimes = [];
    e.seen = new Set(); // rebuild from DB so the 90-day prune also reclaims memory
  }
  for (const r of seenRows) st.entries.get(r.searchId)?.seen.add(r.itemId);
  for (const r of hitRows) {
    if (r.searchId != null) st.entries.get(r.searchId)?.hitTimes.push(r.createdAt.getTime());
  }
  for (const r of lastHitRows) {
    const e = r.searchId != null ? st.entries.get(r.searchId) : undefined;
    if (e && r.last) e.lastHitAt = r.last.getTime();
  }
  // Merge any in-memory hits newer than the DB snapshot (concurrent tick data)
  const cutoff = Date.now() - 24 * 3600_000;
  for (const [id, e] of st.entries) {
    const dbMax = e.hitTimes.length ? Math.max(...e.hitTimes) : 0;
    for (const t of savedHitTimes.get(id) ?? []) {
      if (t > dbMax && t > cutoff) e.hitTimes.push(t);
    }
    const memLast = savedLastHitAt.get(id);
    if (memLast != null && (e.lastHitAt == null || memLast > e.lastHitAt)) e.lastHitAt = memLast;
  }
  st.channels = channelRows.map((r) => r.webhookUrl);
  if (process.env.DISCORD_WEBHOOK_URL) st.channels.push(process.env.DISCORD_WEBHOOK_URL);

  // Reconcile the daily quota counter. Flush our in-memory value and read back
  // what greatest() resolved to — one round-trip that handles both directions:
  // dying-process race (DB has more than we just read) and concurrent polls
  // (we have more than DB). Guard midnight twice: a poll tick can reset st.calls
  // during the await, and if that happens we must not stamp it backward.
  if (new Date().toDateString() === today) {
    const inMem = st.calls.date === today ? st.calls.used : 0;
    const reconciled = await flushCalls(database, { date: today, used: inMem });
    if (new Date().toDateString() === today) {
      st.calls = mergeCalls(st.calls, today, reconciled);
    }
  }
}

// Merge a persisted daily count with the in-memory one. Memory is authoritative
// mid-run (it holds increments not yet flushed), so on a live refresh keep the
// larger; a fresh boot has memory 0 and adopts the DB value; a day rollover
// discards a stale prior-day DB count. Pure + exported so it's unit-testable.
export function mergeCalls(cur: State["calls"], today: string, dbUsed: number): State["calls"] {
  if (cur.date === today) return { date: today, used: Math.max(cur.used, dbUsed) };
  return { date: today, used: dbUsed };
}

// Persists the daily eBay call count. Returns the greatest()-reconciled value from
// the DB so callers can sync in-memory state without a separate SELECT.
async function flushCalls(database: ReturnType<typeof db>, calls: State["calls"]): Promise<number> {
  const [row] = await database
    .insert(apiUsage)
    .values({ day: calls.date, used: calls.used })
    .onConflictDoUpdate({ target: apiUsage.day, set: { used: sql`greatest(${apiUsage.used}, ${calls.used})` } })
    .returning({ used: apiUsage.used });
  return row?.used ?? calls.used;
}

function schedule(e: Entry, delayMs: number) {
  if (state().entries.get(e.s.id) !== e) return; // entry deleted/replaced while a tick was in flight
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (!e.s.enabled || !state().ready) return;
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
  } finally {
    e.running = false;
  }
}

async function pollOnce(e: Entry) {
  const st = state();
  const today = new Date().toDateString();
  if (st.calls.date !== today) st.calls = { date: today, used: 0 };
  if (st.calls.used >= QUOTA_CEILING) {
    recordError(e.s.q, "daily API budget exhausted - poll skipped");
    schedule(e, 15 * 60_000);
    return;
  }

  plog.debug({ searchId: e.s.id, q: e.s.q }, "polling");
  try {
    st.calls.used++;
    const items = await searchNewlyListed(e.s);
    e.lastPolledAt = Date.now();
    plog.info({ q: e.s.q, count: items.length, quotaUsed: st.calls.used }, "eBay poll");
    const database = db();
    const fresh = items.filter((i) => !e.seen.has(i.itemId));
    plog.debug({ searchId: e.s.id, fresh: fresh.length, of: items.length }, "dedup");
    let wrote = false; // did this tick open a connection? gates the piggyback flush below

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
      for (const item of [...fresh].reverse()) {
        if (e.seen.has(item.itemId)) continue; // reload() may have merged it in mid-loop
        // Transaction: if alerts insert fails, seen_items also rolls back so the
        // item is retried next poll instead of being permanently dropped.
        await database.transaction(async (tx) => {
          await tx.insert(seenItems).values({ searchId: e.s.id, itemId: item.itemId }).onConflictDoNothing();
          await tx.insert(alerts).values({
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
          });
        });
        wrote = true;
        e.seen.add(item.itemId);
        const now = Date.now();
        e.hitTimes.push(now);
        e.lastHitAt = now;
        plog.info({ searchId: e.s.id, itemId: item.itemId, price: item.price }, "alert sent");
        if (st.channels.length) {
          const err = await notify(item, e.s, st.channels);
          if (err) recordError(e.s.q, err, "error");
        }
      }
    }

    // Piggyback the daily-call-count persist on the connection these writes already
    // opened. Empty polls (seeded, nothing new) skip it and stay DB-free, so a
    // reboot loses at most the calls counted since the last write - by design.
    if (wrote) await flushCalls(database, st.calls);
    e.backoffMs = 0;
    schedule(e, e.s.intervalMin * 60_000);
  } catch (err) {
    plog.error({ err, searchId: e.s.id, q: e.s.q }, "poll failed"); // stack goes to stdout; recordError keeps only the message for the UI
    recordError(e.s.q, message(err));
    e.backoffMs = Math.min(e.backoffMs ? e.backoffMs * 2 : e.s.intervalMin * 60_000, MAX_BACKOFF_MS);
    schedule(e, e.backoffMs);
  }
}

// ---------- read/write API used by the route handlers (write-through: DB and cache in the same call) ----------

export function listSearches(): SearchStats[] {
  const cutoff = Date.now() - 24 * 3600_000;
  return [...state().entries.values()]
    .sort((a, b) => b.s.createdAt.localeCompare(a.s.createdAt) || b.s.id - a.s.id)
    .map((e) => {
      e.hitTimes = e.hitTimes.filter((t) => t > cutoff);
      return {
        ...e.s,
        seenCount: e.seen.size,
        hits24: e.hitTimes.length,
        lastHitAt: e.lastHitAt ? new Date(e.lastHitAt).toISOString() : null,
        lastPolledAt: e.lastPolledAt ? new Date(e.lastPolledAt).toISOString() : null,
      };
    });
}

export type SearchInput = {
  q: string;
  categoryId: string | null;
  priceFloor: number | null;
  priceCap: number | null;
  binOnly: boolean;
  includeAuctions: boolean;
  intervalMin: number;
};

export async function createSearch(input: SearchInput): Promise<SearchStats> {
  const [row] = await db()
    .insert(searches)
    .values({
      q: input.q,
      categoryId: input.categoryId,
      priceFloor: input.priceFloor,
      priceCap: input.priceCap,
      binOnly: input.binOnly,
      includeAuctions: input.includeAuctions,
      intervalMin: input.intervalMin,
    })
    .returning();
  const e: Entry = {
    s: rowToSearch(row),
    seen: new Set(),
    hitTimes: [],
    lastHitAt: null,
    lastPolledAt: null,
    timer: null,
    backoffMs: 0,
    running: false,
  };
  state().entries.set(e.s.id, e);
  schedule(e, 0); // seed immediately
  plog.info({ searchId: e.s.id, q: e.s.q }, "search created");
  return { ...e.s, seenCount: 0, hits24: 0, lastHitAt: null, lastPolledAt: null };
}

// Fields that decide what a search matches. Changing any of them makes the seeded
// baseline stale (the new criteria surface listings never in `seen`), so an edit
// touching them must re-seed. Pure + exported so the decision is unit-testable.
// undefined in the patch = field untouched.
const MATCH_FIELDS = ["q", "categoryId", "priceFloor", "priceCap", "binOnly", "includeAuctions"] as const;

export function matchCriteriaChanged(
  cur: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): boolean {
  return MATCH_FIELDS.some((k) => patch[k] !== undefined && patch[k] !== cur?.[k]);
}

export async function updateSearch(
  id: number,
  patch: Partial<SearchInput> & { enabled?: boolean },
): Promise<SearchStats | null> {
  const cur = state().entries.get(id)?.s;
  const row: Partial<typeof searches.$inferInsert> = {};
  if (patch.q !== undefined) row.q = patch.q;
  if (patch.categoryId !== undefined) row.categoryId = patch.categoryId;
  if (patch.priceFloor !== undefined) row.priceFloor = patch.priceFloor;
  if (patch.priceCap !== undefined) row.priceCap = patch.priceCap;
  if (patch.binOnly !== undefined) row.binOnly = patch.binOnly;
  if (patch.includeAuctions !== undefined) row.includeAuctions = patch.includeAuctions;
  if (patch.intervalMin !== undefined) row.intervalMin = patch.intervalMin;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  // Editing what a search matches (query/category/price/buying-option) invalidates
  // the seeded baseline: the new criteria surface listings never in `seen`, which a
  // seeded search would alert on all at once. Re-seed so that backlog stays silent -
  // the same guarantee the first poll gives a brand-new search (DESIGN.md §3).
  const criteriaChanged = matchCriteriaChanged(cur, row);
  if (criteriaChanged) row.seeded = false;
  if (Object.keys(row).length) {
    const [updated] = await db().update(searches).set(row).where(eq(searches.id, id)).returning();
    if (!updated) return null; // deleted concurrently
    const e = state().entries.get(id);
    if (e) {
      const s = rowToSearch(updated);
      // seeded only goes false→true on its own (a concurrent tick); preserve that,
      // unless this edit intentionally reset it to re-seed the new criteria.
      if (e.s.seeded && !criteriaChanged) s.seeded = true;
      e.s = s;
    } else {
      // not in cache yet (boot window): DB was updated, return stub stats
      return { ...rowToSearch(updated), seenCount: 0, hits24: 0, lastHitAt: null, lastPolledAt: null };
    }
  }
  const e = state().entries.get(id);
  if (!e) return null;
  e.backoffMs = 0;
  if (e.s.enabled) schedule(e, 1000);
  else if (e.timer) {
    clearTimeout(e.timer);
    e.timer = null;
  }
  plog.info({ searchId: id, enabled: e.s.enabled }, "search updated");
  return listSearches().find((s) => s.id === id) ?? null;
}

export async function deleteSearch(id: number): Promise<boolean> {
  const [row] = await db().delete(searches).where(eq(searches.id, id)).returning({ id: searches.id });
  if (!row) return false;
  const e = state().entries.get(id);
  if (e?.timer) clearTimeout(e.timer);
  state().entries.delete(id);
  plog.info({ searchId: id }, "search deleted");
  return true;
}

export function status(): StatusInfo {
  const st = state();
  const today = new Date().toDateString();
  return {
    ready: st.ready,
    bootError: st.bootError,
    poller: {
      running: st.ready,
      bootedAt: st.bootedAt ? new Date(st.bootedAt).toISOString() : null,
      timers: [...st.entries.values()].filter((e) => e.s.enabled).length,
    },
    ebay: {
      mode: MOCK ? "mock" : "live",
      marketplace: MARKETPLACE,
      tokenExpiresAt: tokenExpiresAt(),
    },
    quota: { used: st.calls.date === today ? st.calls.used : 0, ceiling: QUOTA_CEILING },
    errors: [...st.errors].reverse().slice(0, 20),
    version: pkg.version,
  };
}
