import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, max, sql } from "drizzle-orm";
import pkg from "../../package.json";
import { db, migrateToLatest } from "./db";
import { alerts, apiUsage, channels, searches, seenItems, users } from "./schema";
import { SINGLE_USER_EMAIL, assertAuthEnv, authMode } from "./authmode";
import { claimLegacyRows } from "./claim";
import { decryptSecret } from "./crypto";
import {
  conditionExcluded,
  currencyFor,
  invalidateToken,
  mockMarket,
  mockSearch,
  sampleMarket,
  searchNewlyListed,
  tokenExpiresAt,
  type EbayCreds,
} from "./ebay";
import { splitExcludeTerms } from "./exclude-terms";
import { notify } from "./discord";
import { log } from "./log";
import type { Item, PollError, PriceContext, Search, SearchStats, SnoozeConfig, StatusInfo } from "./types";

const plog = log.child({ component: "poller" });

// A per-user ceiling, not a per-deployment one: each user brings their own eBay app, so each
// gets their own 5000/day to spend.
const QUOTA_CEILING = Number(process.env.EBAY_DAILY_QUOTA ?? 5000);
export const DEFAULT_INTERVAL = Number(process.env.POLL_INTERVAL_DEFAULT ?? 5);
const REFRESH_HOURS = Number(process.env.CACHE_REFRESH_HOURS ?? 12);
const MARKET_SAMPLE_HOURS = Number(process.env.MARKET_SAMPLE_HOURS ?? 24);
const SEEN_RETENTION_DAYS = Number(process.env.SEEN_RETENTION_DAYS ?? 90);
const MAX_BACKOFF_MS = 30 * 60_000;
// An alert that couldn't be delivered is retried at the next boot, but deals are time-sensitive:
// past this age, retire it unsent rather than spam stale listings when the process comes back.
const REDELIVER_MAX_AGE_MS = 60 * 60_000;

// Overnight snooze (UI-configured, stored on the user's row, cached in UserCtx.snooze):
// skip that user's eBay polls during a local-time window so we don't burn their quota while
// nobody's watching. Items listed during the window still alert on the first poll after it
// ends, via the same newly-listed dedupe (subject to page-1/200-item coverage; a long snooze
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

function snoozing(sn: SnoozeState, now = new Date()): boolean {
  return sn.enabled && inWindow(sn.start, sn.end, localMinutes(sn.tz, now));
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function snoozeWindow(sn: SnoozeState): string | null {
  return sn.enabled ? `${hhmm(sn.start)}–${hhmm(sn.end)}${sn.tz ? ` ${sn.tz}` : ""}` : null;
}

// Minutes silenced per day (0 when disabled). start !== end is enforced at
// validation, so an enabled window is always 1..1439. Feeds the UI projection.
export function snoozeMinutes(sn: SnoozeState): number {
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

// Everything a poll needs about the owner of the search it's about to run: their keys, where
// their alerts go, what they've spent, when they're asleep. Rebuilt from the DB by reload();
// `calls` is the one field the poll loop mutates (see mergeCalls).
type UserCtx = {
  id: number;
  email: string;
  ebay: EbayCreds | null; // null = mock (single mode) or paused (multi-user); see pollMode
  // Kept beside `ebay` rather than read off it, because they outlive the keys: removing creds
  // deliberately leaves both columns behind as the defaults if keys return, and single mode
  // has them from .env even in mock, where there are no creds to read them from at all.
  env: EbayCreds["env"];
  marketplace: string;
  channels: string[];
  calls: { date: string; used: number };
  snooze: SnoozeState;
};

type State = {
  ready: boolean;
  bootError: string | null;
  bootedAt: number | null;
  // Keyed by search id, not per user: ids are serial, so they're unique across owners and the
  // scheduler stays one flat set of timers.
  entries: Map<number, Entry>;
  users: Map<number, UserCtx>;
  errors: PollError[];
  lastScheduledAt: number | null; // heartbeat: last time a live poll timer was set, powers /api/health
};

// globalThis so instrumentation and route-handler bundles share one instance
const g = globalThis as typeof globalThis & { __ebaeState?: State };
function state(): State {
  return (g.__ebaeState ??= {
    ready: false,
    bootError: null,
    bootedAt: null,
    entries: new Map(),
    users: new Map(),
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
  return splitExcludeTerms(excludeTerms).some((term) => t.includes(term.toLowerCase()));
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
// "error" for terminal failures (e.g. a webhook dead after all retries). userId scopes
// the entry to one owner's Status page; null = a failure with no owner (boot, refresh),
// which everyone sees.
function recordError(userId: number | null, searchQ: string | null, msg: string, level: "warn" | "error" = "warn") {
  const st = state();
  st.errors.push({ time: new Date().toISOString(), searchQ, message: msg, userId });
  if (st.errors.length > 100) st.errors.shift();
  plog[level]({ userId, searchQ }, msg);
}

// userId is a parameter because the column is nullable in the DB (claim.ts backfills it) while
// Search.userId is not: the caller proves the owner, then builds the search.
function rowToSearch(r: typeof searches.$inferSelect, userId: number): Search {
  return {
    id: r.id,
    userId,
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
    const pending = [...st.users.values()].filter((u) => u.calls.used > 0);
    if (st.ready && pending.length) {
      // Cap the wait so a suspended/hung Neon can't hold the process past the
      // container's shutdown grace period; the count is best-effort anyway. One flush per
      // user: their counters are separate rows.
      await Promise.race([
        Promise.all(pending.map((u) => flushCalls(db(), u.id, u.calls))),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      // console.error (sync) not plog: a buffered pino write can be dropped by process.exit.
      console.error(`[poller] flushed call counts on ${signal}: users=${pending.length}`);
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
    // Fail closed before anything can serve: a multi-user mode missing its config would 401
    // every request, or worse, trust an unverifiable header. Surfaces through the same
    // bootError path as a DB outage - the retry loop just keeps re-throwing until it's fixed.
    assertAuthEnv();
    await migrateToLatest();
    // Adopt pre-multi-user rows before the first reload, which skips null-owner searches.
    await claimLegacyRows(db());
    await reload();
    // Config audit, once per boot (a retry only reaches here on success): single mode's lack
    // of auth has to be loud, and the multi-user modes must not look like they still honour
    // the global eBay/webhook vars.
    if (authMode() === "single") {
      plog.warn("single-user mode, no authentication - do not expose publicly without your own auth");
    } else if (process.env.EBAY_CLIENT_ID || process.env.DISCORD_WEBHOOK_URL) {
      plog.warn(
        "EBAY_CLIENT_ID and DISCORD_WEBHOOK_URL are ignored in multi-user mode - creds and channels are per-user",
      );
    }
    st.ready = true;
    st.bootError = null;
    plog.info({ searches: st.entries.size, users: st.users.size }, "poller ready");
    // Flush any alert left undelivered by a crash between its insert and its notify, or by a
    // webhook outage that spanned the restart. Must finish BEFORE the first tick is scheduled:
    // a tick firing mid-sweep could insert a fresh deliveredAt=null row that the sweep's SELECT
    // then picks up and double-notifies. Awaiting it here keeps the sweep and live polling on
    // disjoint rows. Common case is one UPDATE + an empty SELECT (fast). Best-effort: on failure
    // the rows stay null and the next boot retries them.
    try {
      await redeliverPending(db());
    } catch (err) {
      recordError(null, null, `redeliver on boot: ${message(err)}`);
    }
    // jitter the first ticks so N searches don't hit eBay in the same second
    for (const e of st.entries.values()) schedule(e, 1000 + Math.random() * 5000);
    setInterval(
      () =>
        reload()
          .then(() => plog.info({ searches: st.entries.size, users: st.users.size }, "cache refreshed"))
          .catch((err) => recordError(null, null, `cache refresh: ${message(err)}`)),
      REFRESH_HOURS * 3600_000,
    );
  } catch (err) {
    st.bootError = message(err);
    recordError(null, null, `boot failed, retrying: ${st.bootError}`);
    setTimeout(() => void tryBoot(), BOOT_RETRY_MS);
  }
}

// Decrypt one user's saved eBay secret. A failure here (wrong or rotated ENCRYPTION_KEY, a
// hand-edited row) must never kill boot: record it against that user and leave them
// credential-less, so their searches idle and everyone else keeps polling.
function credsFor(row: typeof users.$inferSelect): EbayCreds | null {
  if (!row.ebayClientId || !row.ebayClientSecretEnc) return null;
  try {
    return {
      userId: row.id,
      clientId: row.ebayClientId,
      clientSecret: decryptSecret(row.ebayClientSecretEnc, String(row.id)),
      env: envOf(row.ebayEnv),
      marketplace: row.ebayMarketplace,
    };
  } catch (err) {
    recordError(row.id, null, `eBay credentials could not be decrypted: ${message(err)}`);
    return null;
  }
}

// Both the column and the env var are free text; only an explicit "sandbox" is sandbox.
function envOf(raw: string | null | undefined): EbayCreds["env"] {
  return raw === "sandbox" ? "sandbox" : "production";
}

// Single mode's eBay preferences, straight off .env. Read apart from the keys because they
// apply with or without them: EBAY_MARKETPLACE still decides the currency and links the UI
// renders in mock mode, as it did before multi-user, when it was a module global.
function envPrefs(): Pick<EbayCreds, "env" | "marketplace"> {
  return { env: envOf(process.env.EBAY_ENV), marketplace: process.env.EBAY_MARKETPLACE ?? "EBAY_US" };
}

// Single mode's implicit user runs on .env alone: no creds stored, no ENCRYPTION_KEY needed.
// EBAY_CLIENT_ID alone decides live vs mock, exactly as it did before multi-user - a
// half-configured pair must fail loudly at the token request, not silently serve mock listings.
function envCreds(userId: number): EbayCreds | null {
  const clientId = process.env.EBAY_CLIENT_ID;
  if (!clientId) return null;
  return { userId, clientId, clientSecret: process.env.EBAY_CLIENT_SECRET ?? "", ...envPrefs() };
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
  const [searchRows, seenRows, hitRows, lastHitRows, channelRows, userRows] = await Promise.all([
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
    database
      .select({ userId: channels.userId, webhookUrl: channels.webhookUrl })
      .from(channels)
      .where(eq(channels.enabled, true)),
    database.select().from(users),
  ]);

  const st = state();
  const webhooksByUser = new Map<number, string[]>();
  for (const r of channelRows) {
    if (r.userId == null) continue; // unclaimed, same as a null-owner search below
    const list = webhooksByUser.get(r.userId);
    if (list) list.push(r.webhookUrl);
    else webhooksByUser.set(r.userId, [r.webhookUrl]);
  }
  // Swap the map (and each user's channel list) rather than mutate: a tick mid-flight keeps
  // polling against the context it captured instead of seeing half of a reload. `calls` is
  // carried by reference so an increment landing during the swap isn't lost.
  const nextUsers = new Map<number, UserCtx>();
  for (const row of userRows) {
    nextUsers.set(row.id, {
      id: row.id,
      email: row.email,
      ebay: credsFor(row),
      env: envOf(row.ebayEnv),
      marketplace: row.ebayMarketplace,
      channels: webhooksByUser.get(row.id) ?? [],
      calls: st.users.get(row.id)?.calls ?? { date: today, used: 0 },
      snooze: { enabled: row.snoozeEnabled, start: row.snoozeStart, end: row.snoozeEnd, tz: row.snoozeTz },
    });
  }
  // The env vars are single mode's whole eBay/Discord config, and an existing deployment must
  // upgrade to multi-user code without touching them. DB creds still win (the UI can save some
  // even here); no creds at all leaves ebay null, which pollMode reads as mock - today's
  // behaviour. Multi-user modes ignore both vars (warned about at boot): one global webhook
  // would fan every user's alerts into one channel.
  if (authMode() === "single") {
    const u = [...nextUsers.values()].find((x) => x.email === SINGLE_USER_EMAIL);
    if (u) {
      // Nothing saved through the UI leaves .env as the whole eBay config, keys and
      // preferences alike - the state an upgrading deployment arrives in.
      if (!u.ebay) {
        u.ebay = envCreds(u.id);
        Object.assign(u, envPrefs());
      }
      if (process.env.DISCORD_WEBHOOK_URL) u.channels.push(process.env.DISCORD_WEBHOOK_URL);
    }
  }
  st.users = nextUsers;

  const fresh = new Set<number>();
  for (const row of searchRows) {
    // No owner means no keys to poll with, no channel to notify and no quota to bill: leave
    // the row inert until the boot claim adopts it, rather than guess at one.
    if (row.userId == null) continue;
    const s = rowToSearch(row, row.userId);
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
  // Reconcile each user's daily quota counter. Flush our in-memory value and read back
  // what greatest() resolved to — one round-trip that handles both directions:
  // dying-process race (DB has more than we just read) and concurrent polls
  // (we have more than DB). Guard midnight twice: a poll tick can reset a counter
  // during the await, and if that happens we must not stamp it backward.
  if (new Date().toDateString() === today) {
    for (const u of st.users.values()) {
      const inMem = u.calls.date === today ? u.calls.used : 0;
      const reconciled = await flushCalls(database, u.id, { date: today, used: inMem });
      if (new Date().toDateString() === today) {
        u.calls = mergeCalls(u.calls, today, reconciled);
      }
    }
  }
}

// Merge a persisted daily count with the in-memory one. Memory is authoritative
// mid-run (it holds increments not yet flushed), so on a live refresh keep the
// larger; a fresh boot has memory 0 and adopts the DB value; a day rollover
// discards a stale prior-day DB count. Pure + exported so it's unit-testable.
export function mergeCalls(cur: UserCtx["calls"], today: string, dbUsed: number): UserCtx["calls"] {
  if (cur.date === today) return { date: today, used: Math.max(cur.used, dbUsed) };
  return { date: today, used: dbUsed };
}

// Persists one user's daily eBay call count. Returns the greatest()-reconciled value from
// the DB so callers can sync in-memory state without a separate SELECT.
async function flushCalls(database: ReturnType<typeof db>, userId: number, calls: UserCtx["calls"]): Promise<number> {
  const [row] = await database
    .insert(apiUsage)
    .values({ userId, day: calls.date, used: calls.used })
    .onConflictDoUpdate({
      target: [apiUsage.userId, apiUsage.day],
      set: { used: sql`greatest(${apiUsage.used}, ${calls.used})` },
    })
    .returning({ used: apiUsage.used });
  return row?.used ?? calls.used;
}

function schedule(e: Entry, delayMs: number) {
  if (state().entries.get(e.s.id) !== e) return; // entry deleted/replaced while a tick was in flight
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (!e.s.enabled || !state().ready) return;
  // Heartbeat: stamp only once a live timer is actually set. A disabled or deleted entry's
  // final schedule() must not bump it, or that stale bump would mask a wedged enabled search.
  // Snooze/quota/backoff paths keep the entry enabled+ready, so intentional idle still stamps.
  state().lastScheduledAt = Date.now();
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
    recordError(e.s.userId, e.s.q, `tick: ${message(err)}`);
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
async function maybeSampleMarket(e: Entry, u: UserCtx, database: ReturnType<typeof db>) {
  const s = e.s;
  // Only searches with BOTH a floor and a cap get a baseline. The floor filters accessory
  // noise out of the sample (see marketSampleSearch); the cap is the ceiling the sample exists
  // to see past. Floor-less searches would sample junk; cap-less searches already see the full
  // upper market via their in-band alerts, so a sample would just burn quota.
  if (s.priceFloor == null || s.priceCap == null) return;
  if (s.marketSampledAt && Date.now() - Date.parse(s.marketSampledAt) < MARKET_SAMPLE_HOURS * 3600_000) return;
  if (u.calls.used >= QUOTA_CEILING) return; // don't spend the last of the owner's budget on a baseline
  try {
    u.calls.used++;
    // Same mode gate as the poll that called us: pollOnce already returned for a user with
    // nothing to poll with, so this is live-or-mock.
    const items = u.ebay ? await sampleMarket(u.ebay, s) : mockMarket(s);
    const prices = items
      .filter((i) => !excludeMatch(i.title, s.excludeTerms) && !conditionExcluded(i, s.conditions))
      .map((i) => i.price)
      .filter((p): p is number => p != null);
    const m = median(prices);
    const sampledAt = new Date();
    await database.update(searches).set({ marketMedian: m, marketSampledAt: sampledAt }).where(eq(searches.id, s.id));
    s.marketMedian = m;
    s.marketSampledAt = sampledAt.toISOString();
    await flushCalls(database, u.id, u.calls); // piggyback the +1 eBay call we just spent
    plog.info({ searchId: s.id, q: s.q, sample: prices.length, marketMedian: m }, "market sampled");
  } catch (err) {
    recordError(u.id, s.q, `market sample: ${message(err)}`); // warn only; the main poll keeps its cadence
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
  const now = new Date(); // one stamp for the whole sweep, so the DB shows they came from one boot
  await database
    .update(alerts)
    .set({ deliveredAt: now })
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

  // Confirm every retired/delivered row in one UPDATE after the loop instead of one round-trip
  // per row (a boot backlog shouldn't fan out N queries against a serverless DB). A crash mid-loop
  // just re-posts the confirmed-but-unflushed rows next boot, which is the same at-least-once
  // window the main path already accepts.
  const done: number[] = [];
  for (const row of rows) {
    const s = row.searchId != null ? st.entries.get(row.searchId)?.s : undefined;
    if (!s) {
      // search deleted (search_id null) or gone from cache: no criteria to attach, retire it.
      done.push(row.id);
      continue;
    }
    // The alert belongs to the search's owner, so it goes to their channels and nobody else's.
    // Nothing to deliver to (no channels, or the owner is gone): retire the row so it doesn't
    // linger across boots.
    const u = st.users.get(s.userId);
    if (!u?.channels.length) {
      done.push(row.id);
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
      // Not persisted (no column), so suppression can't be re-evaluated here - this row already
      // passed it under the settings in force when it was written. A pending for-parts alert
      // therefore still sends if the search switched to NOT_PARTS before this boot; that needs a
      // condition_id column to fix, which isn't worth a migration for a <1h redelivery window.
      conditionId: null,
      imageUrl: row.imageUrl,
      itemUrl: row.itemUrl,
    };
    // Only the market baseline is reconstructable here (the recent-alert median needs the
    // pre-batch snapshot, long gone); without one the embed just omits the deal line.
    const market = s.marketMedian;
    const ctx: PriceContext | undefined =
      market != null && market > 0 ? { typical: market, count: 0, basis: "market" } : undefined;
    const { error, anyDelivered } = await notify(item, s, u.channels, ctx);
    // Log any failure even on partial success (matches the main-path notify, which records the
    // error independently of anyDelivered); confirm the row if a channel took it, else leave it
    // null to retry next boot.
    if (error) recordError(u.id, s.q, `redeliver: ${error}`, "error");
    if (anyDelivered) done.push(row.id);
  }
  if (done.length) await database.update(alerts).set({ deliveredAt: now }).where(inArray(alerts.id, done));
}

// What a user's next poll will actually do. Live needs their own keys; mock is single mode's
// credential-less path (the zero-config quick start), which multi-user modes deliberately don't
// have - fake listings in a shared deployment would look real to the friend seeing them. Shared
// with status() so the UI's "polling paused" banner can't disagree with the poll loop.
function pollMode(u: UserCtx): "live" | "mock" | "no-creds" {
  if (u.ebay) return "live";
  return authMode() === "single" ? "mock" : "no-creds";
}

async function pollOnce(e: Entry) {
  const st = state();
  const u = st.users.get(e.s.userId);
  if (!u) {
    // Owner isn't cached (a row created since the last reload). Nothing to bill or notify
    // against, so idle at the normal cadence rather than let the timer die - a dead timer
    // reads as a wedge to the heartbeat.
    recordError(e.s.userId, e.s.q, "search owner is not loaded - poll skipped");
    schedule(e, e.s.intervalMin * 60_000);
    return;
  }
  // Overnight snooze: don't touch the eBay API during the owner's window. Re-tick at the
  // search's normal interval; the first tick after the window ends polls and picks
  // up anything listed meanwhile (still-available items alert then, not never).
  if (snoozing(u.snooze)) {
    plog.debug({ searchId: e.s.id, q: e.s.q }, "snoozed - poll skipped");
    schedule(e, e.s.intervalMin * 60_000);
    return;
  }
  const today = new Date().toDateString();
  if (u.calls.date !== today) u.calls = { date: today, used: 0 };
  if (u.calls.used >= QUOTA_CEILING) {
    recordError(u.id, e.s.q, "daily API budget exhausted - poll skipped");
    schedule(e, 15 * 60_000);
    return;
  }
  // No keys and no mock to fall back on: there is nothing to poll with. Stay idle - no eBay
  // call, no quota spent, no error every tick - until the user saves creds, which re-kicks
  // this search (setUserCreds). The UI shows the paused banner off the same mode.
  if (pollMode(u) === "no-creds") {
    plog.debug({ searchId: e.s.id, q: e.s.q, userId: u.id }, "no credentials - polling paused");
    schedule(e, e.s.intervalMin * 60_000);
    return;
  }

  plog.debug({ searchId: e.s.id, q: e.s.q }, "polling");
  try {
    u.calls.used++;
    const items = u.ebay ? await searchNewlyListed(u.ebay, e.s) : mockSearch(e.s);
    e.lastPolledAt = Date.now();
    plog.info({ q: e.s.q, count: items.length, quotaUsed: u.calls.used }, "eBay poll");
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
      // Pin the owner's channel list for this batch: reload() swaps the UserCtx and its
      // channel list (never mutates), so a capture keeps the insert's deliveredAt seed and the
      // notify target consistent even if a reload lands mid-tick.
      const webhooks = u.channels; // local copy; named to not shadow the `channels` schema table
      for (const item of [...fresh].reverse()) {
        if (e.seen.has(item.itemId)) continue; // reload() may have merged it in mid-loop
        // Suppressed (exclude-terms hit, or the NOT_PARTS preset's for-parts tier): mark seen
        // (so later widening the search won't re-alert this old listing) but send no alert.
        // Seen set stays the full dedupe set.
        if (excludeMatch(item.title, e.s.excludeTerms) || conditionExcluded(item, e.s.conditions)) {
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
              userId: e.s.userId,
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
              deliveredAt: webhooks.length ? null : new Date(),
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
        if (webhooks.length) {
          const { error, anyDelivered } = await notify(item, e.s, webhooks, ctx);
          // "Delivered" = reached at least one channel. On total failure the row stays
          // deliveredAt=null and boot redelivery retries it (never re-posting to a channel that
          // already has it, since anyDelivered would have marked it delivered here).
          if (error) recordError(u.id, e.s.q, error, "error");
          if (anyDelivered) {
            await database.update(alerts).set({ deliveredAt: new Date() }).where(eq(alerts.id, alertId));
          }
        }
      }
    }

    // Piggyback the daily-call-count persist on the connection these writes already
    // opened. Empty polls (seeded, nothing new) skip it and stay DB-free, so a
    // reboot loses at most the calls counted since the last write - by design.
    if (wrote) await flushCalls(database, u.id, u.calls);
    // Refresh the market baseline at most once/day per band-limited search. Self-throttled
    // and isolated: it opens a connection only when actually due, so steady-state empty
    // polls stay DB-free, and its own try/catch keeps a sample failure off the main poll.
    await maybeSampleMarket(e, u, database);
    e.backoffMs = 0;
    schedule(e, e.s.intervalMin * 60_000);
  } catch (err) {
    plog.error({ err, searchId: e.s.id, q: e.s.q }, "poll failed"); // stack goes to stdout; recordError keeps only the message for the UI
    recordError(u.id, e.s.q, message(err));
    e.backoffMs = Math.min(e.backoffMs ? e.backoffMs * 2 : e.s.intervalMin * 60_000, MAX_BACKOFF_MS);
    schedule(e, e.backoffMs);
  }
}

// ---------- read/write API used by the route handlers (write-through: DB and cache in the same call) ----------
// Every entry point takes the caller's user id and answers only for that user's rows. A search
// owned by someone else is treated as nonexistent (null/false -> the route 404s), so probing
// ids can't reveal which ones exist.

// auth.ts provisions a users row on first login, but the cache only rebuilds every
// CACHE_REFRESH_HOURS - far too late for a new user's first save to take effect. Pull the whole
// cache forward instead of a bespoke one-user load: it happens once per new user.
async function userCtx(userId: number): Promise<UserCtx | undefined> {
  if (!state().users.has(userId)) await reload();
  return state().users.get(userId);
}

export function listSearches(userId: number): SearchStats[] {
  const cutoff = Date.now() - 24 * 3600_000;
  return [...state().entries.values()]
    .filter((e) => e.s.userId === userId)
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

export async function createSearch(userId: number, input: SearchInput): Promise<SearchStats> {
  await userCtx(userId); // without a cached owner the search would idle until the next reload
  const [row] = await db()
    .insert(searches)
    .values({
      userId,
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
    s: rowToSearch(row, userId),
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
  plog.info({ searchId: e.s.id, q: e.s.q, userId }, "search created");
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
  userId: number,
  id: number,
  patch: Partial<SearchInput> & { enabled?: boolean },
): Promise<SearchStats | null> {
  const cur = state().entries.get(id)?.s;
  // Ownership first, off the cache: someone else's search must be indistinguishable from one
  // that never existed, so both leave here as null and the route 404s.
  if (cur?.userId !== userId) return null;
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
      const s = rowToSearch(updated, userId);
      // seeded only goes false→true on its own (a concurrent tick); preserve that,
      // unless this edit intentionally reset it to re-seed the new criteria.
      if (e.s.seeded && !criteriaChanged) s.seeded = true;
      e.s = s;
    } else {
      // dropped from the cache by a concurrent reload: DB was updated, return stub stats
      return { ...rowToSearch(updated, userId), seenCount: 0, hits24: 0, lastHitAt: null, lastPolledAt: null };
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
  return listSearches(userId).find((s) => s.id === id) ?? null;
}

export async function deleteSearch(userId: number, id: number): Promise<boolean> {
  if (state().entries.get(id)?.s.userId !== userId) return false; // wrong owner reads as gone (see updateSearch)
  const [row] = await db().delete(searches).where(eq(searches.id, id)).returning({ id: searches.id });
  if (!row) return false;
  const e = state().entries.get(id);
  if (e?.timer) clearTimeout(e.timer);
  state().entries.delete(id);
  plog.info({ searchId: id }, "search deleted");
  return true;
}

// Defaults, not an error, for a user the cache hasn't loaded yet: they match the users-table
// defaults, so a first-login read is honest rather than empty.
export function getSnooze(userId: number): SnoozeConfig {
  const sn = state().users.get(userId)?.snooze ?? SNOOZE_DEFAULT;
  return { enabled: sn.enabled, start: hhmm(sn.start), end: hhmm(sn.end), tz: sn.tz };
}

// Persist + write-through one user's snooze config, then re-kick their enabled searches so the
// change lands now, not at each timer's next tick (disable → poll promptly again).
export async function setSnooze(userId: number, sn: SnoozeState): Promise<SnoozeConfig> {
  await db()
    .update(users)
    .set({ snoozeEnabled: sn.enabled, snoozeStart: sn.start, snoozeEnd: sn.end, snoozeTz: sn.tz })
    .where(eq(users.id, userId));
  const u = await userCtx(userId);
  if (u) u.snooze = sn;
  kick(userId);
  plog.info({ userId, enabled: sn.enabled, start: sn.start, end: sn.end, tz: sn.tz }, "snooze updated");
  return getSnooze(userId);
}

// Write-through for the credentials route, which owns the DB side (validate → encrypt → save).
// Without this a save would sit inert until the next reload; the token cache must go with it,
// or a token minted from the old keys outlives them.
export async function setUserCreds(userId: number, creds: EbayCreds | null): Promise<void> {
  const u = await userCtx(userId);
  if (u) {
    u.ebay = creds;
    // Only a save moves the preferences; a removal keeps the last ones, matching the columns
    // the route leaves behind, so re-adding keys starts from the marketplace they picked.
    if (creds) {
      u.env = creds.env;
      u.marketplace = creds.marketplace;
    }
  }
  invalidateToken(userId);
  kick(userId);
  plog.info({ userId, creds: creds ? "saved" : "removed" }, "eBay credentials updated");
}

// Write-throughs for the channels routes, which own the DB side. Reassign rather than mutate the
// list, matching reload's swap discipline: a tick mid-flight keeps notifying the set it captured.
// An incremental edit is also what keeps single mode's DISCORD_WEBHOOK_URL alive - it exists only
// in this list, so rebuilding channels from the DB here would drop it until the next reload.
export async function addUserChannel(userId: number, webhookUrl: string): Promise<void> {
  const u = await userCtx(userId);
  // Skip one already there: a first-login user isn't cached yet, so userCtx reloads and picks
  // the row the route just inserted straight out of the DB. Appending blind would post every
  // alert to it twice until the next refresh.
  if (u && !u.channels.includes(webhookUrl)) u.channels = [...u.channels, webhookUrl];
}

export async function removeUserChannel(userId: number, webhookUrl: string): Promise<void> {
  const u = await userCtx(userId);
  if (u) u.channels = u.channels.filter((c) => c !== webhookUrl);
}

// Re-kick one user's searches after a change that decides whether/how they poll. Jittered so a
// user with many searches doesn't hit eBay in one burst.
function kick(userId: number) {
  for (const e of state().entries.values()) {
    if (e.s.userId === userId && e.s.enabled) schedule(e, 1000 + Math.random() * 3000);
  }
}

// One user's view of the poller: their quota, their snooze, their errors (plus the ownerless
// ones, which are everyone's), their eBay mode. ready/bootError/bootedAt/version are process
// facts and stay global. Nothing here is derived from the client secret.
export function status(userId: number): StatusInfo {
  const st = state();
  const u = st.users.get(userId);
  const today = new Date().toDateString();
  const sn = u?.snooze ?? SNOOZE_DEFAULT;
  // clientId/env/marketplace ride on status because the credentials route has no GET (the
  // secret never leaves the server). env/marketplace come off the user rather than their keys:
  // they outlive a Remove, and in mock mode there are no keys to read them from.
  const marketplace = u?.marketplace ?? "EBAY_US";
  return {
    ready: st.ready,
    bootError: st.bootError,
    poller: {
      running: st.ready,
      bootedAt: st.bootedAt ? new Date(st.bootedAt).toISOString() : null,
      timers: [...st.entries.values()].filter((e) => e.s.enabled && e.s.userId === userId).length,
    },
    ebay: {
      mode: u ? pollMode(u) : "no-creds",
      clientId: u?.ebay?.clientId ?? null,
      env: u?.env ?? "production",
      marketplace,
      currency: currencyFor(marketplace),
      tokenExpiresAt: tokenExpiresAt(userId),
    },
    quota: { used: u?.calls.date === today ? u.calls.used : 0, ceiling: QUOTA_CEILING },
    snooze: { active: snoozing(sn), window: snoozeWindow(sn), dailyMinutes: snoozeMinutes(sn) },
    errors: [...st.errors]
      .filter((e) => e.userId === userId || e.userId == null)
      .reverse()
      .slice(0, 20),
    user: { email: u?.email ?? "" },
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
