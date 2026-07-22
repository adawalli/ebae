import { eq } from "drizzle-orm";
import pkg from "../../../package.json";
import { db } from "@/lib/db";
import { currencyFor, invalidateToken, tokenExpiresAt, type EbayCreds } from "@/lib/ebay";
import { searches, users } from "@/lib/schema";
import type { PushSub, SearchStats, SnoozeConfig, StatusInfo } from "@/lib/types";
import { userCtx } from "./boot";
import { MAX_BACKOFF_MS, QUOTA_SKIP_MS, kick, pollMode, schedule } from "./loop";
import { MARKET_SAMPLES_PER_DAY } from "./market";
import { callsPerDayFor, callsPerDayForEntry, checksDue24h, projectedCalls } from "./projection";
import {
  GOV_MAX_FACTOR,
  QUOTA_CEILING,
  governedDelayMs,
  governorDecision,
  governorFor,
  surplusToday,
  usedToday,
} from "./quota";
import { SNOOZE_DEFAULT, counterDayFrac, hhmm, snoozeMinutes, snoozeWindow, snoozing } from "./snooze";
import { resetTracked, soldStats } from "./track";
import { type Entry, type SnoozeState, bumpAlerts, plog, rowToSearch, state } from "./state";

export const DEFAULT_INTERVAL = Number(process.env.POLL_INTERVAL_DEFAULT ?? 5);

// ---------- read/write API used by the route handlers (write-through: DB and cache in the same call) ----------
// Every entry point takes the caller's user id and answers only for that user's rows. A search
// owned by someone else is treated as nonexistent (null/false -> the route 404s), so probing
// ids can't reveal which ones exist.

// Pollable minutes in the user's day: the whole day minus their snooze window.
function activeMinFor(userId: number): number {
  return 1440 - snoozeMinutes(state().users.get(userId)?.snooze ?? SNOOZE_DEFAULT);
}

// The governor is a per-user budget control, so all of one user's searches stretch by the same
// amount. Every caller reads it through here so the rows, the status tile and the poller's own
// reschedule can't disagree about the current factor.
function factorFor(userId: number): number {
  const u = state().users.get(userId);
  if (!u) return 1;
  const active = [...state().entries.values()].filter((e) => e.s.userId === userId && e.s.enabled);
  return governorDecision(
    usedToday(u.calls),
    QUOTA_CEILING,
    counterDayFrac(u.snooze),
    projectedCalls(active, activeMinFor(userId)),
    u.governorEngaged,
  ).factor;
}

export function listSearches(userId: number): SearchStats[] {
  const now = Date.now();
  const cutoff = now - 24 * 3600_000;
  const st = state();
  const factor = factorFor(userId);
  const activeMin = activeMinFor(userId);
  return [...st.entries.values()]
    .filter((e) => e.s.userId === userId)
    .sort((a, b) => b.s.createdAt.localeCompare(a.s.createdAt) || b.s.id - a.s.id)
    .map((e) => {
      e.hitTimes = e.hitTimes.filter((t) => t > cutoff);
      const sold = e.s.trackSold ? soldStats(e.soldPrices, now) : { typical: null, count: 0 };
      return {
        ...e.s,
        seenCount: e.seen.size,
        hits24: e.hitTimes.length,
        lastHitAt: e.lastHitAt ? new Date(e.lastHitAt).toISOString() : null,
        lastPolledAt: e.lastPolledAt ? new Date(e.lastPolledAt).toISOString() : null,
        effectiveIntervalMin: Math.round(e.s.intervalMin * factor * 10) / 10,
        callsPerDay: callsPerDayForEntry(e, activeMin),
        soldMedian: sold.typical,
        soldSampleCount: sold.count,
        checksDue24h: checksDue24h(e),
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
  trackSold: boolean;
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
      trackSold: input.trackSold,
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
    tracked: new Map(),
    soldPrices: [],
    trackDirty: new Set(),
    bonus: { date: "", done: new Map() },
    trackEpoch: 0,
    trackLock: Promise.resolve(),
  };
  state().entries.set(e.s.id, e);
  schedule(e, 0); // seed immediately
  plog.info({ searchId: e.s.id, q: e.s.q, userId }, "search created");
  return {
    ...e.s,
    seenCount: 0,
    hits24: 0,
    lastHitAt: null,
    lastPolledAt: null,
    effectiveIntervalMin: Math.round(e.s.intervalMin * factorFor(userId) * 10) / 10,
    callsPerDay: callsPerDayFor(e.s, activeMinFor(userId)),
    soldMedian: null, // brand new: nothing tracked, nothing realized
    soldSampleCount: 0,
    checksDue24h: 0,
  };
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
  // Not a match field and not part of the baseline sample: toggling it keeps both the seen
  // set and the market median. Turning it off leaves the tracked rows to age out on their own.
  if (patch.trackSold !== undefined) row.trackSold = patch.trackSold;
  if (patch.intervalMin !== undefined) row.intervalMin = patch.intervalMin;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  // Editing what a search matches (query/category/price/buying-option/condition) invalidates
  // the seeded baseline: the new criteria surface listings never in `seen`, which a
  // seeded search would alert on all at once. Re-seed so that backlog stays silent -
  // the same guarantee the first poll gives a brand-new search (DESIGN.md §3).
  const criteriaChanged = matchCriteriaChanged(cur, row);
  if (criteriaChanged) row.seeded = false;
  const invalidated = baselineInvalidated(cur, row);
  // Clear the market baseline when the criteria or the exclude terms change (see
  // baselineInvalidated) so the next poll re-samples instead of comparing against a stale
  // market. An excludeTerms-only edit resets the baseline without re-seeding - the seen set
  // stays complete, matching the DESIGN.md §3 guarantee.
  if (invalidated) {
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
      // Whatever invalidates the market baseline invalidates the realized prices too, and more
      // urgently: the sold median outranks every other basis, so a stale one would keep
      // captioning the edited search's alerts with the old search's going rate long after the
      // baseline it beat was cleared. Drops the outstanding follows with it - they are listings
      // this search no longer matches, still costing checks.
      if (invalidated) await resetTracked(db(), e);
    } else {
      // dropped from the cache by a concurrent reload: DB was updated, return stub stats
      const s = rowToSearch(updated, userId);
      return {
        ...s,
        seenCount: 0,
        hits24: 0,
        lastHitAt: null,
        lastPolledAt: null,
        effectiveIntervalMin: Math.round(s.intervalMin * factorFor(userId) * 10) / 10,
        callsPerDay: callsPerDayFor(s, activeMinFor(userId)),
        soldMedian: null, // no entry to read follows from; the next list call has the real figure
        soldSampleCount: 0,
        checksDue24h: 0,
      };
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
  // The alerts rows outlive their search (alerts.searchId is ON DELETE set null, so the history
  // survives with searchId null rather than vanishing), which means this changed the /api/alerts
  // payload without writing to that table. Another tab still filtered on this search would
  // otherwise 304 forever on alerts the DB no longer reports under it.
  bumpAlerts(userId);
  plog.info({ searchId: id }, "search deleted");
  return true;
}

// Defaults, not an error, for a user the cache hasn't loaded yet: they match the users-table
// defaults, so a first-login read is honest rather than empty.
export function getSnooze(userId: number): SnoozeConfig {
  const sn = state().users.get(userId)?.snooze ?? SNOOZE_DEFAULT;
  return { enabled: sn.enabled, start: hhmm(sn.start), end: hhmm(sn.end), tz: sn.tz };
}

// Persist + write-through one user's snooze config. Passive edits replace the old timers at the
// new governed cadence; they must not create a burst of eBay calls merely to apply a setting.
// Ending a snooze that is active right now is the one exception: it resumes promptly.
export async function setSnooze(userId: number, sn: SnoozeState): Promise<SnoozeConfig> {
  await db()
    .update(users)
    .set({ snoozeEnabled: sn.enabled, snoozeStart: sn.start, snoozeEnd: sn.end, snoozeTz: sn.tz })
    .where(eq(users.id, userId));
  const u = await userCtx(userId);
  if (u) {
    const old = u.snooze;
    const now = new Date();
    u.snooze = sn;
    const active = [...state().entries.values()].filter((e) => e.s.userId === userId && e.s.enabled);
    const factor = governorFor(u, projectedCalls(active, activeMinFor(userId)), now);
    for (const e of active) {
      schedule(e, snoozing(old, now) && !snoozing(sn, now) ? 0 : governedDelayMs(e.s.intervalMin, factor));
    }
  }
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

// Replace, not append-if-absent like addUserChannel: the route upserts p256dh/auth, and a
// device that re-subscribes keeps its endpoint while rotating its keys. Skipping the
// already-present endpoint would leave the cache encrypting against the old key until the
// next reload - which the push service answers with a 400, and 400 isn't reaped, so the
// subscription would be a permanent zero-delivery zombie.
export async function addUserPush(userId: number, sub: PushSub): Promise<void> {
  const u = await userCtx(userId);
  if (u) u.push = [...u.push.filter((p) => p.endpoint !== sub.endpoint), sub];
}

export async function removeUserPush(userId: number, endpoint: string): Promise<void> {
  const u = await userCtx(userId);
  if (u) u.push = u.push.filter((p) => p.endpoint !== endpoint);
}

// endpoint is globally unique, so exactly one user can hold it: a device moving between
// accounts (a shared browser, a re-login) has to leave the old one's cache or that user's
// alerts keep pushing to it. A sweep rather than a caller-supplied prior owner, because
// reading the owner before the upsert races with a concurrent subscribe for the same
// endpoint and would evict from the wrong user. Cheap: cached users, no query.
export function evictPushElsewhere(keepUserId: number, endpoint: string): void {
  for (const [id, u] of state().users) {
    if (id !== keepUserId) u.push = u.push.filter((p) => p.endpoint !== endpoint);
  }
}

export { callsPerDayFor, projectedCalls } from "./projection";

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
    quota: (() => {
      const used = u ? usedToday(u.calls, today) : 0;
      const enabled = [...st.entries.values()].filter((e) => e.s.userId === userId && e.s.enabled);
      const projected = projectedCalls(enabled, activeMinFor(userId));
      const frac = counterDayFrac(sn);
      const factor = factorFor(userId);
      const configuredRemaining = Math.ceil(projected * (1 - frac));
      const remaining = Math.max(QUOTA_CEILING - used, 0);
      const configuredForecast = used + configuredRemaining;
      // "expected" is what an evenly-paced day would have spent by now. Compared against
      // `used - surplus` it answers the question the raw counter can't: is this spend on track,
      // or early? Judging `used` whole would flag a user whose only overspend was quota that
      // was going to expire tonight regardless.
      return {
        used,
        // Clamped so the subset relation the type promises holds at the boundary: both UI
        // surfaces derive configured = used - surplus, and neither should have to guard it.
        surplus: u ? Math.min(used, surplusToday(u.calls, today)) : 0,
        ceiling: QUOTA_CEILING,
        projected,
        expected: Math.round(projected * frac),
        governor: { active: factor > 1, factor },
        remaining,
        configuredRemaining,
        configuredForecast,
        overage: Math.max(configuredForecast - QUOTA_CEILING, 0),
        // Shipped rather than recomputed in the browser: it comes off a server-only env var the
        // client can't read, and the new-search preview has no saved row to take a figure from.
        marketSamplesPerDay: MARKET_SAMPLES_PER_DAY,
      };
    })(),
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
// path can pick (a governed search interval, QUOTA_SKIP_MS, or the backoff cap), plus a grace
// margin for tick duration. Beyond this the heartbeat is genuinely stale. The QUOTA_SKIP_MS
// floor is what stops an all-short-interval fleet reading unhealthy during a quota pause.
// Pure + exported for tests.
export function healthWindowMs(intervalsMin: number[]): number {
  return Math.max(QUOTA_SKIP_MS, MAX_BACKOFF_MS, ...intervalsMin.map((m) => m * 60_000 * GOV_MAX_FACTOR)) + 5 * 60_000;
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
