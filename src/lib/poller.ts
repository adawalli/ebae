import { and, desc, eq, gt, isNotNull, isNull, lt, max, sql } from "drizzle-orm";
import pkg from "../../package.json";
import { db, migrateToLatest } from "./db";
import { alerts, apiUsage, channels, searches, seenItems, settings } from "./schema";
import { CURRENCY, MARKETPLACE, MOCK, sampleMarket, searchNewlyListed, tokenExpiresAt } from "./ebay";
import { notify } from "./discord";
import { log } from "./log";
import type { Item, PollError, PriceContext, Search, SearchStats, SnoozeConfig, StatusInfo } from "./types";

const plog = log.child({ component: "poller" });

const QUOTA_CEILING = Number(process.env.EBAY_DAILY_QUOTA ?? 5000);
export const DEFAULT_INTERVAL = Number(process.env.POLL_INTERVAL_DEFAULT ?? 5);
const REFRESH_HOURS = Number(process.env.CACHE_REFRESH_HOURS ?? 12);
const MARKET_SAMPLE_HOURS = Number(process.env.MARKET_SAMPLE_HOURS ?? 24);
const SEEN_RETENTION_DAYS = Number(process.env.SEEN_RETENTION_DAYS ?? 90);
const MAX_BACKOFF_MS = 30 * 60_000;
// An alert that couldn't be delivered is retried at the next boot, but deals are time-sensitive:
// past this age, retire it unsent rather than spam stale listings when the process comes back.
const REDELIVER_MAX_AGE_MS = 60 * 60_000;

// Overnight snooze (UI-configured, stored in `settings`, cached in state().snooze):
// skip all eBay polls during a local-time window so we don't burn quota while nobody's
// watching. Items listed during the window still alert on the first poll after it ends,
// via the same newly-listed dedupe (subject to page-1/200-item coverage; a long snooze
// can push very old listings off page 1). start/end = minutes from midnight in `tz`.
type SnoozeState = { enabled: boolean; start: number; end: number; tz: string | null };
const SNOOZE_DEFAULT: SnoozeState = { enabled: false, start: 60, end: 420, tz: null };

// Minutes-from-midnight window membership, handling windows that cross midnight
// (start > end, e.g. 22:00-06:00). Start inclusive, end exclusive. Pure + exported.
export function inWindow(start: number, end: number, minutes: number): boolean {
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// Current wall-clock minutes-from-midnight in an IANA zone (null = server timezone).
function localMinutes(tz: string | null, now: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz ?? undefined,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const h = Number(p.find((x) => x.type === "hour")?.value) % 24; // ICU can emit "24" at midnight
  return h * 60 + Number(p.find((x) => x.type === "minute")?.value);
}

function snoozing(now = new Date()): boolean {
  const sn = state().snooze;
  return sn.enabled && inWindow(sn.start, sn.end, localMinutes(sn.tz, now));
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function snoozeWindow(): string | null {
  const sn = state().snooze;
  return sn.enabled ? `${hhmm(sn.start)}–${hhmm(sn.end)}${sn.tz ? ` ${sn.tz}` : ""}` : null;
}

// Minutes silenced per day (0 when disabled). start !== end is enforced at
// validation, so an enabled window is always 1..1439. Feeds the UI projection.
export function snoozeMinutes(): number {
  const sn = state().snooze;
  return sn.enabled ? (sn.end - sn.start + 1440) % 1440 : 0;
}

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
  snooze: SnoozeState;
  errors: PollError[];
  lastScheduledAt: number | null; // heartbeat: last time schedule() ran, powers /api/health
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
    snooze: { ...SNOOZE_DEFAULT },
    errors: [],
    lastScheduledAt: null,
  });
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// A listing's title matches one of the search's exclude terms (comma/newline
// separated, case-insensitive substring). No terms -> never excluded. The Browse
// API has no negative-keyword support, so this suppression is client-side. Pure +
// exported for tests.
export function excludeMatch(title: string, excludeTerms: string | null): boolean {
  if (!excludeTerms) return false;
  const t = title.toLowerCase();
  return excludeTerms
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((term) => t.includes(term));
}

// Median of a numeric list (mean of the two middles on an even count); null on
// empty. Powers the "typical price" deal-context in alert embeds. Pure + exported.
export function median(nums: number[]): number | null {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
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
    conditions: r.conditions,
    excludeTerms: r.excludeTerms,
    marketMedian: r.marketMedian,
    marketSampledAt: r.marketSampledAt ? r.marketSampledAt.toISOString() : null,
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
    // Flush any alert left undelivered by a crash between its insert and its notify, or by a
    // webhook outage that spanned the restart. Runs before any tick and on a row set disjoint
    // from live polling, so it can't race the main-path delivery loop. Best-effort: on failure
    // the rows stay null and the next boot retries them.
    try {
      await redeliverPending(db());
    } catch (err) {
      recordError(null, `redeliver on boot: ${message(err)}`);
    }
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
  // prune the dedupe set so it can't grow unbounded (SEEN_RETENTION_DAYS, default 90)
  await database
    .delete(seenItems)
    .where(lt(seenItems.seenAt, sql`now() - (${SEEN_RETENTION_DAYS} * interval '1 day')`));
  const [searchRows, seenRows, hitRows, lastHitRows, channelRows, settingsRows] = await Promise.all([
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
    database.select().from(settings).where(eq(settings.id, 1)),
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

  // Group the DB snapshot by search so each entry's seen set is swapped atomically.
  const seenBySearch = new Map<number, Set<string>>();
  for (const r of seenRows) {
    let set = seenBySearch.get(r.searchId);
    if (!set) seenBySearch.set(r.searchId, (set = new Set()));
    set.add(r.itemId);
  }

  for (const [id, e] of st.entries) {
    if (!fresh.has(id)) {
      if (e.timer) clearTimeout(e.timer);
      st.entries.delete(id);
      continue;
    }
    e.hitTimes = [];
    // Rebuild the dedupe set from DB so the retention prune also reclaims memory - but
    // never mid-tick. A running tick adds items to e.seen after the snapshot above was
    // queried; overwriting would drop those adds and re-alert them next tick. Skip it;
    // the next reload reclaims that entry's memory once the tick has finished.
    if (!e.running) e.seen = seenBySearch.get(id) ?? new Set();
  }
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
  const snRow = settingsRows[0];
  st.snooze = snRow
    ? { enabled: snRow.snoozeEnabled, start: snRow.snoozeStart, end: snRow.snoozeEnd, tz: snRow.snoozeTz }
    : { ...SNOOZE_DEFAULT };

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
  state().lastScheduledAt = Date.now(); // heartbeat: every loop path (tick, snooze, quota, backoff) reaches here
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
  } catch (err) {
    // pollOnce catches its own poll failures; reaching here means a throw before its try
    // (e.g. an invalid snooze tz in Intl). Reschedule so one entry can't silently kill its
    // timer - which the heartbeat would otherwise read as a wedge and 503.
    recordError(e.s.q, `tick: ${message(err)}`);
    schedule(e, MAX_BACKOFF_MS);
  } finally {
    e.running = false;
  }
}

// Median + sample size of a search's recent priced alerts (the in-band "recent" basis).
// Runs on the connection the poll writes already opened (alerting ticks only), so it
// never breaks the DB-free steady state. The basis label is decided at the call site,
// which prefers the search's market baseline when one is set (see pollOnce).
async function priceContext(
  database: ReturnType<typeof db>,
  searchId: number,
): Promise<{ typical: number | null; count: number }> {
  const rows = await database
    .select({ price: alerts.price })
    .from(alerts)
    .where(and(eq(alerts.searchId, searchId), isNotNull(alerts.price)))
    .orderBy(desc(alerts.createdAt))
    .limit(20);
  const prices = rows.map((r) => r.price).filter((p): p is number => p != null);
  return { typical: median(prices), count: prices.length };
}

// Best-effort daily market baseline: a cap-removed (floor-kept) sample of the same item
// criteria, so a band-limited search can compare an alert against the true market median
// instead of only its own in-band alerts. Self-throttled to once/MARKET_SAMPLE_HOURS per
// search, quota-guarded, and fully isolated (own try/catch) so a failure here never backs
// off the main poll.
async function maybeSampleMarket(e: Entry, database: ReturnType<typeof db>) {
  const s = e.s;
  // Only searches with BOTH a floor and a cap get a baseline. The floor filters accessory
  // noise out of the sample (see marketSampleSearch); the cap is the ceiling the sample exists
  // to see past. Floor-less searches would sample junk; cap-less searches already see the full
  // upper market via their in-band alerts, so a sample would just burn quota.
  if (s.priceFloor == null || s.priceCap == null) return;
  if (s.marketSampledAt && Date.now() - Date.parse(s.marketSampledAt) < MARKET_SAMPLE_HOURS * 3600_000) return;
  const st = state();
  if (st.calls.used >= QUOTA_CEILING) return; // don't spend the last of the budget on a baseline
  try {
    st.calls.used++;
    const items = await sampleMarket(s);
    const prices = items
      .filter((i) => !excludeMatch(i.title, s.excludeTerms))
      .map((i) => i.price)
      .filter((p): p is number => p != null);
    const m = median(prices);
    const sampledAt = new Date();
    await database.update(searches).set({ marketMedian: m, marketSampledAt: sampledAt }).where(eq(searches.id, s.id));
    s.marketMedian = m;
    s.marketSampledAt = sampledAt.toISOString();
    await flushCalls(database, st.calls); // piggyback the +1 eBay call we just spent
    plog.info({ searchId: s.id, q: s.q, sample: prices.length, marketMedian: m }, "market sampled");
  } catch (err) {
    recordError(s.q, `market sample: ${message(err)}`); // warn only; the main poll keeps its cadence
  }
}

// Redeliver alerts committed but never confirmed delivered - a crash between the alerts insert
// and the notify, or a webhook outage that spanned the last shutdown. Called once at boot, before
// any tick fires, so it never races the main-path delivery loop (disjoint row sets, no shared
// mutable flag). A row counts as delivered once ANY channel accepts it (notify.anyDelivered), so a
// retry never re-posts to a channel that already has it. Rows older than REDELIVER_MAX_AGE_MS are
// retired unsent (a deal that stale isn't worth sending); anything still null is retried next boot.
async function redeliverPending(database: ReturnType<typeof db>) {
  const st = state();
  await database
    .update(alerts)
    .set({ deliveredAt: new Date() })
    .where(
      and(
        isNull(alerts.deliveredAt),
        lt(alerts.createdAt, sql`now() - (${REDELIVER_MAX_AGE_MS / 60_000} * interval '1 minute')`),
      ),
    );

  const rows = await database
    .select({
      id: alerts.id,
      searchId: alerts.searchId,
      itemId: alerts.itemId,
      title: alerts.title,
      price: alerts.price,
      currency: alerts.currency,
      shippingCost: alerts.shippingCost,
      buyingOption: alerts.buyingOption,
      condition: alerts.condition,
      imageUrl: alerts.imageUrl,
      itemUrl: alerts.itemUrl,
    })
    .from(alerts)
    .where(isNull(alerts.deliveredAt));

  if (!rows.length) return;
  // Nothing to deliver to: retire the queue so it doesn't linger across boots.
  if (!st.channels.length) {
    await database.update(alerts).set({ deliveredAt: new Date() }).where(isNull(alerts.deliveredAt));
    return;
  }

  for (const row of rows) {
    const s = row.searchId != null ? st.entries.get(row.searchId)?.s : undefined;
    if (!s) {
      // search deleted (search_id null) or gone from cache: no criteria to attach, retire it.
      await database.update(alerts).set({ deliveredAt: new Date() }).where(eq(alerts.id, row.id));
      continue;
    }
    const item: Item = {
      itemId: row.itemId,
      title: row.title,
      price: row.price,
      currency: row.currency,
      shippingCost: row.shippingCost,
      buyingOption: row.buyingOption as Item["buyingOption"],
      condition: row.condition,
      imageUrl: row.imageUrl,
      itemUrl: row.itemUrl,
    };
    // Only the market baseline is reconstructable here (the recent-alert median needs the
    // pre-batch snapshot, long gone); without one the embed just omits the deal line.
    const market = s.marketMedian;
    const ctx: PriceContext | undefined =
      market != null && market > 0 ? { typical: market, count: 0, basis: "market" } : undefined;
    const { error, anyDelivered } = await notify(item, s, st.channels, ctx);
    if (anyDelivered) await database.update(alerts).set({ deliveredAt: new Date() }).where(eq(alerts.id, row.id));
    else recordError(s.q, `redeliver: ${error ?? "no channel reachable"}`, "error"); // left null, retried next boot
  }
}

async function pollOnce(e: Entry) {
  // Overnight snooze: don't touch the eBay API during the window. Re-tick at the
  // search's normal interval; the first tick after the window ends polls and picks
  // up anything listed meanwhile (still-available items alert then, not never).
  if (snoozing()) {
    plog.debug({ searchId: e.s.id, q: e.s.q }, "snoozed - poll skipped");
    schedule(e, e.s.intervalMin * 60_000);
    return;
  }
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
      // Deal-context baseline. Prefer the daily market sample (reflects the whole market,
      // even for a band-limited search); only when there's no baseline fall back to the
      // median of this search's recent priced alerts, computed from before this batch lands
      // (so the new items don't skew their own "typical"). The recent-alert read is skipped
      // whenever a market baseline exists (dealField's market branch ignores its count) and
      // whenever the poll is empty, so steady-state polls stay DB-free.
      const market = e.s.marketMedian;
      const ctx: PriceContext =
        market != null && market > 0
          ? { typical: market, count: 0, basis: "market" }
          : { ...(fresh.length ? await priceContext(database, e.s.id) : { typical: null, count: 0 }), basis: "recent" };
      // Pin the channel list for this batch: reload() swaps st.channels (never mutates), so a
      // capture keeps the insert's deliveredAt seed and the notify target consistent even if a
      // reload lands mid-tick.
      const channels = st.channels;
      for (const item of [...fresh].reverse()) {
        if (e.seen.has(item.itemId)) continue; // reload() may have merged it in mid-loop
        // Exclude-terms hit: mark seen (so a later exclusion removal won't re-alert this
        // old listing) but send no alert. Seen set stays the full dedupe set.
        if (excludeMatch(item.title, e.s.excludeTerms)) {
          await database.insert(seenItems).values({ searchId: e.s.id, itemId: item.itemId }).onConflictDoNothing();
          wrote = true;
          e.seen.add(item.itemId);
          plog.debug({ searchId: e.s.id, itemId: item.itemId, q: e.s.q }, "excluded - suppressed");
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
              deliveredAt: channels.length ? null : new Date(),
            })
            .onConflictDoNothing({ target: [alerts.searchId, alerts.itemId] })
            .returning({ id: alerts.id });
          alertId = inserted?.id ?? null;
        });
        wrote = true;
        e.seen.add(item.itemId);
        if (alertId == null) continue; // duplicate: the row already existed, don't re-notify
        const now = Date.now();
        e.hitTimes.push(now);
        e.lastHitAt = now;
        plog.info({ searchId: e.s.id, itemId: item.itemId, price: item.price }, "alert sent");
        if (channels.length) {
          const { error, anyDelivered } = await notify(item, e.s, channels, ctx);
          // "Delivered" = reached at least one channel. On total failure the row stays
          // deliveredAt=null and boot redelivery retries it (never re-posting to a channel that
          // already has it, since anyDelivered would have marked it delivered here).
          if (error) recordError(e.s.q, error, "error");
          if (anyDelivered) {
            await database.update(alerts).set({ deliveredAt: new Date() }).where(eq(alerts.id, alertId));
          }
        }
      }
    }

    // Piggyback the daily-call-count persist on the connection these writes already
    // opened. Empty polls (seeded, nothing new) skip it and stay DB-free, so a
    // reboot loses at most the calls counted since the last write - by design.
    if (wrote) await flushCalls(database, st.calls);
    // Refresh the market baseline at most once/day per band-limited search. Self-throttled
    // and isolated: it opens a connection only when actually due, so steady-state empty
    // polls stay DB-free, and its own try/catch keeps a sample failure off the main poll.
    await maybeSampleMarket(e, database);
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
  conditions: string | null;
  excludeTerms: string | null;
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
      conditions: input.conditions,
      excludeTerms: input.excludeTerms,
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
// excludeTerms is intentionally absent: it's a client-side suppression, not a Browse
// query field, and suppressed items are already in `seen`, so it never re-seeds.
const MATCH_FIELDS = ["q", "categoryId", "priceFloor", "priceCap", "binOnly", "includeAuctions", "conditions"] as const;

export function matchCriteriaChanged(
  cur: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): boolean {
  return MATCH_FIELDS.some((k) => patch[k] !== undefined && patch[k] !== cur?.[k]);
}

// The market baseline is sampled against the match criteria AND filtered through excludeMatch,
// so it's stale whenever either changes. A match-field change also re-seeds; an excludeTerms
// change resets the baseline only (excludeTerms stays out of MATCH_FIELDS so the seen set is
// preserved). Pure + exported so the reset decision is unit-testable, like matchCriteriaChanged.
export function baselineInvalidated(cur: Record<string, unknown> | undefined, patch: Record<string, unknown>): boolean {
  if (matchCriteriaChanged(cur, patch)) return true;
  return patch.excludeTerms !== undefined && patch.excludeTerms !== cur?.excludeTerms;
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
  if (patch.conditions !== undefined) row.conditions = patch.conditions;
  if (patch.excludeTerms !== undefined) row.excludeTerms = patch.excludeTerms;
  if (patch.intervalMin !== undefined) row.intervalMin = patch.intervalMin;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  // Editing what a search matches (query/category/price/buying-option/condition) invalidates
  // the seeded baseline: the new criteria surface listings never in `seen`, which a
  // seeded search would alert on all at once. Re-seed so that backlog stays silent -
  // the same guarantee the first poll gives a brand-new search (DESIGN.md §3).
  const criteriaChanged = matchCriteriaChanged(cur, row);
  if (criteriaChanged) row.seeded = false;
  // Clear the market baseline when the criteria or the exclude terms change (see
  // baselineInvalidated) so the next poll re-samples instead of comparing against a stale
  // market. An excludeTerms-only edit resets the baseline without re-seeding — the seen set
  // stays complete, matching the DESIGN.md §3 guarantee.
  if (baselineInvalidated(cur, row)) {
    row.marketMedian = null;
    row.marketSampledAt = null;
  }
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

export function getSnooze(): SnoozeConfig {
  const sn = state().snooze;
  return { enabled: sn.enabled, start: hhmm(sn.start), end: hhmm(sn.end), tz: sn.tz };
}

// Persist + write-through the snooze config, then re-kick enabled searches so the
// change lands now, not at each timer's next tick (disable → poll promptly again).
export async function setSnooze(sn: SnoozeState): Promise<SnoozeConfig> {
  const values = {
    snoozeEnabled: sn.enabled,
    snoozeStart: sn.start,
    snoozeEnd: sn.end,
    snoozeTz: sn.tz,
  };
  await db()
    .insert(settings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: settings.id, set: values });
  state().snooze = sn;
  for (const e of state().entries.values()) if (e.s.enabled) schedule(e, 1000 + Math.random() * 3000);
  plog.info({ enabled: sn.enabled, start: sn.start, end: sn.end, tz: sn.tz }, "snooze updated");
  return getSnooze();
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
      currency: CURRENCY,
      tokenExpiresAt: tokenExpiresAt(),
    },
    quota: { used: st.calls.date === today ? st.calls.used : 0, ceiling: QUOTA_CEILING },
    snooze: { active: snoozing(), window: snoozeWindow(), dailyMinutes: snoozeMinutes() },
    errors: [...st.errors].reverse().slice(0, 20),
    version: process.env.APP_VERSION || pkg.version,
  };
}

// Longest legitimate gap between two schedule() calls: the largest reschedule delay any
// path can pick (a search's interval, the 15-min quota-skip, or the 30-min backoff cap),
// plus a grace margin for tick duration. Beyond this the heartbeat is genuinely stale.
// Pure + exported for tests. 15 = quota-skip floor so a all-short-interval fleet still
// tolerates a quota pause.
export function healthWindowMs(intervalsMin: number[]): number {
  return Math.max(Math.max(15, ...intervalsMin) * 60_000, MAX_BACKOFF_MS) + 5 * 60_000;
}

// Liveness for /api/health. Not-ready => unhealthy (still booting / DB down). No enabled
// searches => healthy (nothing is scheduled to run, which is not a fault). Otherwise healthy
// iff schedule() ran within the freshness window; snooze and quota-exhausted paths both call
// schedule(), so intentional idle still reads healthy.
export function health(): { ok: boolean; reason: string | null } {
  const st = state();
  if (!st.ready) return { ok: false, reason: st.bootError ?? "booting" };
  const enabled = [...st.entries.values()].filter((e) => e.s.enabled);
  if (!enabled.length) return { ok: true, reason: null };
  const window = healthWindowMs(enabled.map((e) => e.s.intervalMin));
  const fresh = st.lastScheduledAt != null && Date.now() - st.lastScheduledAt < window;
  return fresh ? { ok: true, reason: null } : { ok: false, reason: "heartbeat stale" };
}
