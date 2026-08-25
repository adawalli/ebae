import { and, eq, gt, lt, max, sql } from "drizzle-orm";
import { SINGLE_USER_EMAIL, assertAuthEnv, authMode } from "@/lib/authmode";
import { claimLegacyRows } from "@/lib/claim";
import { decryptSecret } from "@/lib/crypto";
import { db, migrateToLatest } from "@/lib/db";
import type { EbayCreds } from "@/lib/ebay";
import { alerts, channels, pushSubs, searches, seenItems, trackedItems, users } from "@/lib/schema";
import type { PushSub } from "@/lib/types";
import { redeliverPending } from "./delivery";
import { schedule } from "./loop";
import { flushCalls, mergeCalls } from "./quota";
import { flushTracked, hydrateTracked } from "./track";
import { type DiscordTarget, type UserCtx, message, newEntry, plog, recordError, rowToSearch, state } from "./state";

const REFRESH_HOURS = Number(process.env.CACHE_REFRESH_HOURS ?? 12);
const SEEN_RETENTION_DAYS = Number(process.env.SEEN_RETENTION_DAYS ?? 90);
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
// The eight-way snapshot plus the two retention prunes, in one batch. Pruning happens here (not
// in a separate step) so the rows the rebuild reads are already pruned, and the deletes share
// the round-trip with the selects.
type Snapshot = {
  searchRows: (typeof searches.$inferSelect)[];
  seenRows: { searchId: number; itemId: string }[];
  trackedRows: (typeof trackedItems.$inferSelect)[];
  hitRows: { searchId: number | null; createdAt: Date }[];
  lastHitRows: { searchId: number | null; last: Date | null }[];
  channelRows: { id: number; userId: number | null; name: string | null; webhookUrl: string }[];
  pushRows: { userId: number; endpoint: string; p256dh: string; auth: string }[];
  userRows: (typeof users.$inferSelect)[];
};

async function loadSnapshot(database: ReturnType<typeof db>): Promise<Snapshot> {
  // prune the dedupe set so it can't grow unbounded (SEEN_RETENTION_DAYS, default 90)
  await database
    .delete(seenItems)
    .where(lt(seenItems.seenAt, sql`now() - (${SEEN_RETENTION_DAYS} * interval '1 day')`));
  // Same retention for the follows, measured from whenever the row last mattered: when it
  // resolved, or when it was first seen if it never did.
  await database
    .delete(trackedItems)
    .where(
      lt(
        sql`coalesce(${trackedItems.resolvedAt}, ${trackedItems.firstSeenAt})`,
        sql`now() - (${SEEN_RETENTION_DAYS} * interval '1 day')`,
      ),
    );
  const [searchRows, seenRows, trackedRows, hitRows, lastHitRows, channelRows, pushRows, userRows] = await Promise.all([
    database.select().from(searches),
    database.select({ searchId: seenItems.searchId, itemId: seenItems.itemId }).from(seenItems),
    database.select().from(trackedItems),
    database
      .select({ searchId: alerts.searchId, createdAt: alerts.createdAt })
      .from(alerts)
      .where(and(gt(alerts.createdAt, sql`now() - interval '24 hours'`), eq(alerts.kind, "listing"))),
    database
      .select({ searchId: alerts.searchId, last: max(alerts.createdAt) })
      .from(alerts)
      .where(eq(alerts.kind, "listing"))
      .groupBy(alerts.searchId),
    database
      .select({ id: channels.id, userId: channels.userId, name: channels.name, webhookUrl: channels.webhookUrl })
      .from(channels)
      .where(eq(channels.enabled, true)),
    database
      .select({ userId: pushSubs.userId, endpoint: pushSubs.endpoint, p256dh: pushSubs.p256dh, auth: pushSubs.auth })
      .from(pushSubs),
    database.select().from(users),
  ]);
  return { searchRows, seenRows, trackedRows, hitRows, lastHitRows, channelRows, pushRows, userRows };
}

// Group the channel and push rows by user, so each UserCtx gets its targets in one shot.
function channelsByUser(rows: Snapshot["channelRows"]): Map<number, DiscordTarget[]> {
  const map = new Map<number, DiscordTarget[]>();
  for (const r of rows) {
    if (r.userId == null) continue; // unclaimed, same as a null-owner search below
    const target = { id: r.id, name: r.name, webhookUrl: r.webhookUrl };
    const list = map.get(r.userId);
    if (list) list.push(target);
    else map.set(r.userId, [target]);
  }
  return map;
}

function pushByUserMap(rows: Snapshot["pushRows"]): Map<number, PushSub[]> {
  const map = new Map<number, PushSub[]>();
  for (const r of rows) {
    const sub = { endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth };
    const list = map.get(r.userId);
    if (list) list.push(sub);
    else map.set(r.userId, [sub]);
  }
  return map;
}

// Swap the map (and each user's channel list) rather than mutate: a tick mid-flight keeps
// polling against the context it captured instead of seeing half of a reload. `calls` is
// carried by reference so an increment landing during the swap isn't lost.
function buildUserMap(
  st: ReturnType<typeof state>,
  userRows: Snapshot["userRows"],
  webhooksByUser: Map<number, DiscordTarget[]>,
  pushByUser: Map<number, PushSub[]>,
  today: string,
): Map<number, UserCtx> {
  const nextUsers = new Map<number, UserCtx>();
  for (const row of userRows) {
    nextUsers.set(row.id, {
      id: row.id,
      email: row.email,
      ebay: credsFor(row),
      env: envOf(row.ebayEnv),
      marketplace: row.ebayMarketplace,
      channels: webhooksByUser.get(row.id) ?? [],
      push: pushByUser.get(row.id) ?? [],
      calls: st.users.get(row.id)?.calls ?? { date: today, used: 0, surplus: 0 },
      // Carried across the reload alongside `calls` for the same reason: it's the memory of
      // the last logged edge, so dropping it would re-log "engaged" on every reload.
      governorEngaged: st.users.get(row.id)?.governorEngaged ?? false,
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
      if (process.env.DISCORD_WEBHOOK_URL)
        u.channels.push({ id: null, name: null, webhookUrl: process.env.DISCORD_WEBHOOK_URL });
    }
  }
  return nextUsers;
}

// Group the DB snapshot by search so each entry's seen set is swapped atomically.
function groupBySearch(
  seenRows: Snapshot["seenRows"],
  trackedRows: Snapshot["trackedRows"],
): {
  seenBySearch: Map<number, Set<string>>;
  trackedBySearch: Map<number, Snapshot["trackedRows"]>;
} {
  const seenBySearch = new Map<number, Set<string>>();
  for (const r of seenRows) {
    let set = seenBySearch.get(r.searchId);
    if (!set) seenBySearch.set(r.searchId, (set = new Set()));
    set.add(r.itemId);
  }
  const trackedBySearch = new Map<number, Snapshot["trackedRows"]>();
  for (const r of trackedRows) {
    const list = trackedBySearch.get(r.searchId);
    if (list) list.push(r);
    else trackedBySearch.set(r.searchId, [r]);
  }
  return { seenBySearch, trackedBySearch };
}

// Rebuild the entry map from the snapshot: update existing entries in place (preserving seeded
// and hit data a concurrent tick may have advanced), schedule brand-new rows, drop deleted ones,
// and swap each entry's seen/tracked containers from the DB - but never mid-tick. Returns the set
// of search ids that survived, for the hit-time merge to filter against.
function rebuildEntries(
  st: ReturnType<typeof state>,
  searchRows: Snapshot["searchRows"],
  seenBySearch: Map<number, Set<string>>,
  trackedBySearch: Map<number, Snapshot["trackedRows"]>,
  epochs: Map<number, number>,
): Set<number> {
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
      const entry = newEntry(s);
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
    e.hitTimes = [];
    // Rebuild the dedupe set from DB so the retention prune also reclaims memory - but
    // never mid-tick. A running tick adds items to e.seen after the snapshot above was
    // queried; overwriting would drop those adds and re-alert them next tick. Skip it;
    // the next reload reclaims that entry's memory once the tick has finished.
    if (!e.running) {
      e.seen = seenBySearch.get(id) ?? new Set();
      // Same rule, same reason: a tick mid-flight may have resolved a follow or started a new
      // one since the snapshot, and both would be lost by overwriting. Plus the epoch, which
      // catches the edit `running` can't see - an entry whose generation moved keeps what the
      // reset left it, and the next reload reclaims its memory.
      if (e.trackEpoch === (epochs.get(id) ?? e.trackEpoch)) {
        const t = hydrateTracked(trackedBySearch.get(id) ?? []);
        e.tracked = t.tracked;
        e.soldPrices = t.soldPrices;
        e.trackDirty = new Set(); // flushed above, and the maps just came from the DB
      }
    }
  }
  return fresh;
}

// Merge the DB snapshot's hit times, then fold in any in-memory hits newer than both the snapshot
// and the 24h cutoff (concurrent tick data the snapshot missed).
function mergeHitTimes(
  st: ReturnType<typeof state>,
  hitRows: Snapshot["hitRows"],
  lastHitRows: Snapshot["lastHitRows"],
  savedHitTimes: Map<number, number[]>,
  savedLastHitAt: Map<number, number | null>,
) {
  for (const r of hitRows) {
    if (r.searchId != null) st.entries.get(r.searchId)?.hitTimes.push(r.createdAt.getTime());
  }
  for (const r of lastHitRows) {
    const e = r.searchId != null ? st.entries.get(r.searchId) : undefined;
    if (e && r.last) e.lastHitAt = r.last.getTime();
  }
  const cutoff = Date.now() - 24 * 3600_000;
  for (const [id, e] of st.entries) {
    const dbMax = e.hitTimes.length ? Math.max(...e.hitTimes) : 0;
    for (const t of savedHitTimes.get(id) ?? []) {
      if (t > dbMax && t > cutoff) e.hitTimes.push(t);
    }
    const memLast = savedLastHitAt.get(id);
    if (memLast != null && (e.lastHitAt == null || memLast > e.lastHitAt)) e.lastHitAt = memLast;
  }
}

// Reconcile each user's daily quota counter. Flush our in-memory value and read back what
// greatest() resolved to: one round-trip that handles both directions, dying-process race (DB
// has more than we just read) and concurrent polls (we have more than DB). Guard midnight twice:
// a poll tick can reset a counter during the await, and if that happens we must not stamp it
// backward.
async function reconcileCounters(database: ReturnType<typeof db>, st: ReturnType<typeof state>, today: string) {
  if (new Date().toDateString() !== today) return;
  for (const u of st.users.values()) {
    const fresh = u.calls.date === today;
    const reconciled = await flushCalls(database, u.id, {
      date: today,
      used: fresh ? u.calls.used : 0,
      surplus: fresh ? u.calls.surplus : 0,
    });
    if (new Date().toDateString() === today) {
      u.calls = mergeCalls(u.calls, today, reconciled);
    }
  }
}

// Full DB → cache load. Runs at boot and every CACHE_REFRESH_HOURS; between those, the poller
// works purely from memory so serverless Postgres can sleep.
async function reload() {
  const database = db();
  const today = new Date().toDateString();
  // Each entry's tracking generation, before this function awaits anything. An edit landing while
  // the queries below run bumps it and deletes that search's follows; the rebuild further down
  // works from a snapshot that predates the DELETE, and `running` doesn't cover it because an
  // edit arrives on an API route rather than in a tick. Without this the rebuild puts back the
  // follows and - worse - the realized prices the edit dropped, and the sold median outranks
  // every other basis, so the new criteria's alerts would carry the old search's going rate.
  const epochs = new Map<number, number>();
  for (const [id, e] of state().entries) epochs.set(id, e.trackEpoch);
  // Write out any follow whose in-memory state hasn't reached its row yet. Must happen before
  // the snapshot below, or the rebuild would hand back the schedule those changes moved - and a
  // deferred check would be spent after all.
  for (const e of state().entries.values()) {
    if (e.trackDirty.size) await flushTracked(database, e);
  }
  const snap = await loadSnapshot(database);

  const st = state();
  const webhooksByUser = channelsByUser(snap.channelRows);
  const pushByUser = pushByUserMap(snap.pushRows);
  st.users = buildUserMap(st, snap.userRows, webhooksByUser, pushByUser, today);

  // Save in-memory hit data before rebuild: a concurrent tick may have newer data than the
  // snapshot just queried.
  const savedHitTimes = new Map<number, number[]>();
  const savedLastHitAt = new Map<number, number | null>();
  for (const [id, e] of st.entries) {
    savedHitTimes.set(id, e.hitTimes.slice());
    savedLastHitAt.set(id, e.lastHitAt);
  }

  const { seenBySearch, trackedBySearch } = groupBySearch(snap.seenRows, snap.trackedRows);
  rebuildEntries(st, snap.searchRows, seenBySearch, trackedBySearch, epochs);
  mergeHitTimes(st, snap.hitRows, snap.lastHitRows, savedHitTimes, savedLastHitAt);
  await reconcileCounters(database, st, today);
}

// auth.ts provisions a users row on first login, but the cache only rebuilds every
// CACHE_REFRESH_HOURS - far too late for a new user's first save to take effect. Pull the whole
// cache forward instead of a bespoke one-user load: it happens once per new user.
// A first-login page load fires several of these at once; share one reload between them so
// the miss costs a single query batch, not one per request.
let reloading: Promise<void> | null = null;
export async function userCtx(userId: number): Promise<UserCtx | undefined> {
  if (!state().users.has(userId)) {
    reloading ??= reload().finally(() => {
      reloading = null;
    });
    await reloading;
  }
  return state().users.get(userId);
}
