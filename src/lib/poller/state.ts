import type { EbayCreds } from "@/lib/ebay";
import { log, redact } from "@/lib/log";
import type { searches } from "@/lib/schema";
import type { PollError, PriceKind, PushSub, Search } from "@/lib/types";

export const plog = log.child({ component: "poller" });

// Overnight snooze (UI-configured, stored on the user's row, cached in UserCtx.snooze):
// skip that user's eBay polls during a local-time window so we don't burn their quota while
// nobody's watching. Items listed during the window still alert on the first poll after it
// ends, via the same newly-listed dedupe (subject to page-1/200-item coverage; a long snooze
// can push very old listings off page 1). start/end = minutes from midnight in `tz`.
export type SnoozeState = { enabled: boolean; start: number; end: number; tz: string | null };

// One listing a track_sold search is following, mirroring its tracked_items row. Only
// unresolved listings live in memory: resolving one drops it from the map and (when it sold)
// appends to the entry's soldPrices, so the map holds exactly the outstanding work. Times are
// epoch ms rather than Date, matching how the rest of the poller does arithmetic.
export type TrackedItem = {
  itemId: string;
  priceKind: PriceKind;
  lastPrice: number | null;
  currency: string;
  itemEndDate: number | null; // auctions only
  firstSeenAt: number; // anchors the fixed-price decay schedule
  nextCheckAt: number;
  // Scheduled checks spent on this listing, which is what caps the auction retry and the
  // failure loop. Surplus-funded checks (runBonusChecks) deliberately don't count: they are
  // extra looks, and letting them run this up would retire a listing whose real schedule is
  // barely started the first time a check errors.
  checksUsed: number;
};

export type Entry = {
  s: Search;
  seen: Set<string>;
  hitTimes: number[]; // alert timestamps within the last 24h
  lastHitAt: number | null;
  lastPolledAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  backoffMs: number; // 0 = healthy
  running: boolean; // a tick is in flight; blocks overlapping ticks
  // Sold-price tracking. All three are rebuilt from tracked_items at reload.
  tracked: Map<string, TrackedItem>; // outstanding follows, keyed by item id
  // Realized prices this search has learned, newest appended. Held in memory so alert-time deal
  // context and the searches list stay DB-free, the same bargain the seen set makes.
  soldPrices: { price: number; atMs: number }[];
  // Follows whose in-memory state has drifted from their row (a refreshed price, a deferred
  // check). Written out on a tick that opens a connection anyway, so a quiet poll stays quiet.
  trackDirty: Set<string>;
  // Listings this search has already spent surplus quota on today, and the local day that set
  // belongs to. One extra look per listing per day: without it every tick would re-check the
  // same furthest-out follow instead of working across the backlog. In memory only - a restart
  // costs at most one duplicate check per listing, which is a call, not a wrong answer.
  bonus: { date: string; done: Map<string, number> }; // itemId -> last checked at, spaced by BONUS_MIN_GAP_MS
  // Bumped every time resetTracked wipes the three containers above. A tick reads it once at the
  // start and re-checks before each write, because it holds references into the containers the
  // reset replaced: without this, an edit landing while a tick awaits eBay would be undone by
  // that tick writing its now-orphaned results into the fresh generation.
  trackEpoch: number;
  // Serializes the tracking writes against each other and against resetTracked. The epoch alone
  // can't do it: every write checks it and then awaits a statement, so a reset landing inside
  // that await passes a check that was true and lands a write that no longer is - the DELETE runs
  // between the check and the INSERT it was supposed to prevent. Holding this for check-and-write
  // together is what makes the check mean anything.
  trackLock: Promise<unknown>;
};

// Everything a poll needs about the owner of the search it's about to run: their keys, where
// their alerts go, what they've spent, when they're asleep. Rebuilt from the DB by reload();
// `calls` is the one field the poll loop mutates (see mergeCalls).
export type UserCtx = {
  id: number;
  email: string;
  ebay: EbayCreds | null; // null = mock (single mode) or paused (multi-user); see pollMode
  // Kept beside `ebay` rather than read off it, because they outlive the keys: removing creds
  // deliberately leaves both columns behind as the defaults if keys return, and single mode
  // has them from .env even in mock, where there are no creds to read them from at all.
  env: EbayCreds["env"];
  marketplace: string;
  channels: string[];
  // A sibling of `channels` rather than a widening of it: every consumer of that list
  // assumes a URL string, and a push target is three values. Two lists, two senders.
  push: PushSub[];
  // `used` is every eBay call billed today; `surplus` is the subset of it spent on bonus sold
  // checks (runBonusChecks), so used - surplus is what the saved configuration actually asked
  // for. Kept as a subset rather than a sibling total because `used` is the number the ceiling,
  // the governor and the hard cliff all judge - the split is only ever for attribution.
  calls: { date: string; used: number; surplus: number };
  // Whether the budget governor is currently stretching this user's intervals. Derived from
  // `calls` and the clock, held only to detect the engage/release edge for logging - never
  // read as the factor itself, which is always recomputed.
  governorEngaged: boolean;
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
  // Endpoints a push service has told us are gone. reapPush deletes the row, but the
  // browser keeps handing the same dead endpoint back - iOS expires them with no event and
  // Safari has no pushsubscriptionchange - so a client re-asserting on load would reinsert
  // it and have it reaped again, forever, while the UI claimed push was on. Remembering the
  // death lets /api/push answer 409 and send the client to mint a fresh subscription.
  // In-memory on purpose: a restart costs one more reap cycle before the client is told.
  stalePush: Set<string>;
  // Per-user counter behind the /api/alerts ETag. The UI polls that route every 10s and it is
  // the only one of the three that reads the DB, so without this a single open tab queries
  // Postgres 360 times an hour and Neon's autosuspend timer never expires - the DB stays
  // billed awake for as long as anyone has the app open. Keyed by user id and held outside
  // `users` because reload() replaces those UserCtx objects wholesale.
  alertsRev: Map<number, number>;
};

// globalThis so instrumentation and route-handler bundles share one instance
const g = globalThis as typeof globalThis & { __ebaeState?: State };
export function state(): State {
  return (g.__ebaeState ??= {
    ready: false,
    bootError: null,
    bootedAt: null,
    entries: new Map(),
    users: new Map(),
    errors: [],
    lastScheduledAt: null,
    stalePush: new Set(),
    alertsRev: new Map(),
  });
}

// Bounded because stalePush outlives every row it names and endpoints churn: iOS re-mints
// them every week or two, so an unbounded set is a slow leak in a process that runs for
// months.
const MAX_STALE_PUSH = 500;

// Records endpoints the push service rejected for good, so the subscribe route can tell a
// client its browser is handing back a corpse. Insertion-ordered, so the oldest deaths fall
// off first - which costs at most one extra reap cycle for a device nobody has opened in
// months.
export function markStalePush(endpoints: readonly string[]): void {
  const stale = state().stalePush;
  for (const e of endpoints) {
    // Re-add moves it to the back: a corpse we're still being handed is not the coldest one.
    stale.delete(e);
    stale.add(e);
  }
  for (const e of stale) {
    if (stale.size <= MAX_STALE_PUSH) break;
    stale.delete(e);
  }
}

export function pushIsStale(endpoint: string): boolean {
  return state().stalePush.has(endpoint);
}

// Invalidates one user's /api/alerts ETag. Every path that changes what that route returns for
// them has to call this, or their open tabs 304 on a payload the DB no longer agrees with:
// an alert insert (pollOnce), a clear (DELETE /api/alerts), and a search delete - which never
// writes to alerts but nulls their searchId through the FK. A deliveredAt stamp is not in the
// payload, so redeliverPending deliberately does not bump.
export function bumpAlerts(userId: number): void {
  const rev = state().alertsRev;
  rev.set(userId, (rev.get(userId) ?? 0) + 1);
}

// The /api/alerts validator, or null when this process can't stand behind one.
//
// userId is IN the tag, not just the Map key. Two users would otherwise mint the same string
// (every rev starts at 0, so right after a deploy everyone's tag is identical), and an ETag is
// a promise about a body, not about a user. A browser cache holding the previous user's
// response for this URL revalidates on its own after a re-login, and an equal tag would answer
// 304 - serving them the last user's alerts. The server never confuses whose rows are whose;
// the collision alone is the leak.
//
// Two fences, both required:
//   bootedAt - the counter is in memory, so a tag from a previous process must never match one
//              from this process, or a client sits on data the restart changed under it.
//   ready    - until the boot chain (migrate, claimLegacyRows, reload) has actually finished,
//              the answers are provisional: claimLegacyRows adopts pre-multi-user rows into a
//              user's history without touching any rev, so a tag minted before it lands would
//              be reissued verbatim afterwards and freeze that history at empty. A failed boot
//              retries in the background while Next already serves, so this window is real.
export function alertsTag(userId: number): string | null {
  const st = state();
  if (!st.ready || !st.bootedAt) return null;
  return `${st.bootedAt}-${userId}-${st.alertsRev.get(userId) ?? 0}`;
}

// redact() because these strings are user-visible, not just logged: this feeds both
// recordError (the Status page's error list) and bootError (served by /api/status). A
// failing drizzle query puts its bound params in the error message, so an insert of a
// webhook URL or a VAPID key would otherwise surface the secret in the UI.
export function message(e: unknown) {
  return redact(e instanceof Error ? e.message : String(e));
}

// Single chokepoint for poll-loop failures: keeps the Status-page ring buffer
// and stdout in sync. level defaults to warn (transient/self-healing); pass
// "error" for terminal failures (e.g. a webhook dead after all retries). userId scopes
// the entry to one owner's Status page; null = a failure with no owner (boot, refresh),
// which everyone sees.
export function recordError(
  userId: number | null,
  searchQ: string | null,
  msg: string,
  level: "warn" | "error" = "warn",
) {
  const st = state();
  st.errors.push({ time: new Date().toISOString(), searchQ, message: msg, userId });
  if (st.errors.length > 100) st.errors.shift();
  plog[level]({ userId, searchQ }, msg);
}

// userId is a parameter because the column is nullable in the DB (claim.ts backfills it) while
// Search.userId is not: the caller proves the owner, then builds the search.
export function rowToSearch(r: typeof searches.$inferSelect, userId: number): Search {
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
    trackSold: r.trackSold,
    intervalMin: r.intervalMin,
    enabled: r.enabled,
    seeded: r.seeded,
    createdAt: r.createdAt.toISOString(),
  };
}
