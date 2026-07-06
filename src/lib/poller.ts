import pkg from "../../package.json";
import { initSchema, sql } from "./db";
import { MARKETPLACE, MOCK, searchNewlyListed, tokenExpiresAt } from "./ebay";
import { notify } from "./discord";
import type { PollError, Search, SearchStats, StatusInfo } from "./types";

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

function recordError(searchQ: string | null, msg: string) {
  const st = state();
  st.errors.push({ time: new Date().toISOString(), searchQ, message: msg });
  if (st.errors.length > 100) st.errors.shift();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToSearch(r: any): Search {
  return {
    id: r.id,
    q: r.q,
    categoryId: r.category_id,
    priceCap: r.price_cap == null ? null : Number(r.price_cap),
    binOnly: r.bin_only,
    includeAuctions: r.include_auctions,
    intervalMin: r.interval_min,
    enabled: r.enabled,
    seeded: r.seeded,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const BOOT_RETRY_MS = 15_000;

// Called once per server boot from instrumentation.ts
export async function boot() {
  const st = state();
  if (st.bootedAt) return;
  st.bootedAt = Date.now();
  await tryBoot();
}

// initSchema/reload can throw if Postgres isn't up yet (compose start order,
// Neon cold-wake). Retry until it succeeds instead of leaving the poller dead
// for the life of the process.
async function tryBoot() {
  const st = state();
  try {
    await initSchema();
    await reload();
    st.ready = true;
    st.bootError = null;
    // jitter the first ticks so N searches don't hit eBay in the same second
    for (const e of st.entries.values()) schedule(e, 1000 + Math.random() * 5000);
    setInterval(
      () => reload().catch((err) => recordError(null, `cache refresh: ${message(err)}`)),
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
  const db = sql();
  await db`DELETE FROM seen_items WHERE seen_at < now() - interval '90 days'`; // ponytail: fixed 90d retention, revisit if listings outlive it
  const [searchRows, seenRows, hitRows, lastHitRows, channelRows] = await Promise.all([
    db`SELECT * FROM searches`,
    db`SELECT search_id, item_id FROM seen_items`,
    db`SELECT search_id, created_at FROM alerts WHERE created_at > now() - interval '24 hours'`,
    db`SELECT search_id, max(created_at) AS last FROM alerts GROUP BY search_id`,
    db`SELECT webhook_url FROM channels WHERE enabled`,
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
  for (const [id, e] of st.entries) {
    if (!fresh.has(id)) {
      if (e.timer) clearTimeout(e.timer);
      st.entries.delete(id);
      continue;
    }
    // merge rather than replace: an in-flight tick may have seen items newer
    // than this DB snapshot, and dropping them would re-alert
    e.hitTimes = [];
  }
  for (const r of seenRows) st.entries.get(r.search_id)?.seen.add(r.item_id);
  for (const r of hitRows) st.entries.get(r.search_id)?.hitTimes.push(new Date(r.created_at).getTime());
  for (const r of lastHitRows) {
    const e = r.search_id != null ? st.entries.get(r.search_id) : undefined;
    if (e) e.lastHitAt = new Date(r.last).getTime();
  }
  st.channels = channelRows.map((r) => r.webhook_url as string);
  if (process.env.DISCORD_WEBHOOK_URL) st.channels.push(process.env.DISCORD_WEBHOOK_URL);
}

function schedule(e: Entry, delayMs: number) {
  if (state().entries.get(e.s.id) !== e) return; // entry deleted/replaced while a tick was in flight
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (!e.s.enabled || !state().ready) return;
  e.timer = setTimeout(() => void tick(e), delayMs);
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

  try {
    st.calls.used++;
    const items = await searchNewlyListed(e.s);
    e.lastPolledAt = Date.now();
    const db = sql();
    const fresh = items.filter((i) => !e.seen.has(i.itemId));

    if (!e.s.seeded) {
      // first poll seeds the seen set silently - no alert spam (DESIGN.md §3)
      if (fresh.length) {
        const rows = fresh.map((i) => ({ search_id: e.s.id, item_id: i.itemId }));
        await db`INSERT INTO seen_items ${db(rows)} ON CONFLICT DO NOTHING`;
        for (const i of fresh) e.seen.add(i.itemId);
      }
      await db`UPDATE searches SET seeded = true WHERE id = ${e.s.id}`;
      e.s.seeded = true;
    } else {
      for (const item of [...fresh].reverse()) {
        // oldest first, seen row before alert row and before the in-memory add:
        // a crash or DB error mid-loop means a missed alert at worst, never a
        // re-alert, and never a phantom in-memory "seen" with no persisted row.
        if (e.seen.has(item.itemId)) continue; // reload() may have merged it in mid-loop
        await db`INSERT INTO seen_items (search_id, item_id) VALUES (${e.s.id}, ${item.itemId}) ON CONFLICT DO NOTHING`;
        e.seen.add(item.itemId);
        await db`INSERT INTO alerts ${db({
          search_id: e.s.id,
          search_q: e.s.q,
          item_id: item.itemId,
          title: item.title,
          price: item.price,
          currency: item.currency,
          shipping_cost: item.shippingCost,
          buying_option: item.buyingOption,
          condition: item.condition,
          image_url: item.imageUrl,
          item_url: item.itemUrl,
        })}`;
        const now = Date.now();
        e.hitTimes.push(now);
        e.lastHitAt = now;
        if (st.channels.length) {
          const err = await notify(item, e.s, st.channels);
          if (err) recordError(e.s.q, err);
        }
      }
    }

    e.backoffMs = 0;
    schedule(e, e.s.intervalMin * 60_000);
  } catch (err) {
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
  priceCap: number | null;
  binOnly: boolean;
  includeAuctions: boolean;
  intervalMin: number;
};

export async function createSearch(input: SearchInput): Promise<SearchStats> {
  const db = sql();
  const [row] = await db`INSERT INTO searches ${db({
    q: input.q,
    category_id: input.categoryId,
    price_cap: input.priceCap,
    bin_only: input.binOnly,
    include_auctions: input.includeAuctions,
    interval_min: input.intervalMin,
  })} RETURNING *`;
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
  return { ...e.s, seenCount: 0, hits24: 0, lastHitAt: null, lastPolledAt: null };
}

export async function updateSearch(
  id: number,
  patch: Partial<SearchInput> & { enabled?: boolean },
): Promise<SearchStats | null> {
  const e = state().entries.get(id);
  if (!e) return null;
  const row: Record<string, unknown> = {};
  if (patch.q !== undefined) row.q = patch.q;
  if (patch.categoryId !== undefined) row.category_id = patch.categoryId;
  if (patch.priceCap !== undefined) row.price_cap = patch.priceCap;
  if (patch.binOnly !== undefined) row.bin_only = patch.binOnly;
  if (patch.includeAuctions !== undefined) row.include_auctions = patch.includeAuctions;
  if (patch.intervalMin !== undefined) row.interval_min = patch.intervalMin;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (Object.keys(row).length) {
    const db = sql();
    const [updated] = await db`UPDATE searches SET ${db(row)} WHERE id = ${id} RETURNING *`;
    if (!updated) return null; // deleted concurrently: 404, not a rowToSearch(undefined) crash
    e.s = rowToSearch(updated);
  }
  e.backoffMs = 0;
  if (e.s.enabled) schedule(e, 1000);
  else if (e.timer) {
    clearTimeout(e.timer);
    e.timer = null;
  }
  return listSearches().find((s) => s.id === id) ?? null;
}

export async function deleteSearch(id: number): Promise<boolean> {
  const e = state().entries.get(id);
  if (!e) return false;
  await sql()`DELETE FROM searches WHERE id = ${id}`;
  if (e.timer) clearTimeout(e.timer);
  state().entries.delete(id);
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
