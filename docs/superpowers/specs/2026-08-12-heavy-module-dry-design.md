# DRY & Dead-Code Cleanup for the Heaviest Modules

## Goal

Reduce duplication and remove dead weight in the four heaviest non-UI modules —
`src/lib/poller/track.ts`, `loop.ts`, `boot.ts`, and `api.ts` — without changing
behavior. `src/components/ui/sidebar.tsx` is shadcn/ui boilerplate and is left
alone.

## Non-Goals

- No behavior changes. Every observable path (poll cadence, alert delivery, quota
  accounting, cache reload) stays identical.
- No new abstractions beyond what removes real duplication. No plugin frameworks,
  no strategy objects — the existing code explicitly avoids those (see DESIGN.md §5
  on the `Notifier` interface), and this cleanup keeps that stance.
- No test rewriting beyond adjusting import sites if a helper moves.

## Changes

### 1. `track.ts` — unify the two sold-check loops

`runDueChecks` and `runBonusChecks` share ~50 of ~75 lines: guard, iterate
candidates, bill a call, `checkItem`/`mockCheckItem`, `inferOutcome`, resolve or
defer, flush, and a try/catch that records the error and keeps the poll's cadence.

Extract one private core:

```ts
async function runCheckBatch(
  e: Entry,
  u: UserCtx,
  database,
  epoch,
  pick: () => TrackedItem[], // due filter vs bonusEligible slice
  bill: (t: TrackedItem) => void, // due: used++ only; bonus: used++/surplus++
  stamp: (t: TrackedItem) => void, // due: bonusDone().set; bonus: done.set (same shape)
  label: string, // "sold check" vs "surplus sold check"
  deferMutates: boolean, // due advances schedule+dirty; bonus only on diff
): Promise<void>;
```

`runDueChecks`/`runBonusChecks` become thin wrappers that supply the
candidate-selection and billing differences. The two genuine behavioral
differences are preserved exactly:

- The due loop breaks on `stale` _after_ a thrown check and still resolves at
  `MAX_CHECK_ATTEMPTS`; the bonus loop never mutates on a thrown check and never
  counts the attempt.
- The due loop always writes a deferral (`nextCheckAt` + dirty); the bonus loop
  only writes when `out.nextCheckAt !== t.nextCheckAt`.

These stay as the `deferMutates` flag and the distinct `bill`/`stamp` closures,
not as hidden conditionals inside the core.

### 2. `loop.ts` — extract helpers from `pollOnce`

`pollOnce` is ~275 lines. Pull out three private helpers, each with the inputs it
needs passed in (no shared mutable locals beyond `e`/`u`/`database`):

- `buildPriceContext(database, e, fresh) -> PriceContext` — the sold/market/recent
  fallback chain currently inline. Returns the context object; the `basis` field
  is set by the caller's branch.
- `processFreshItem(database, e, u, ctx, item, follow) -> { wrote: boolean }` —
  the per-item body of the alert loop: seen check, suppression, tracking-only
  auction, the seen+alert transaction, notify (Discord + push), deliveredAt stamp.
  The push-reaping `subs` alias stays in the caller because it narrows across
  items; the helper takes the current `subs` and returns the (possibly filtered)
  `subs` for the next iteration.
- `notifyItem(database, item, e, s, webhooks, subs, ctx, alertId) -> { subs }` —
  the `notify`/`notifyPush` fan-out and reaping, returning the updated `subs`.

`pollOnce` keeps the top-level orchestration: snooze/quota/no-creds gates, the
seeded vs. seeded-else branch, harvest, backlog drain, and the final
sample/due/bonus/schedule sequence.

### 3. `boot.ts` — decompose `reload()`

`reload()` is ~220 lines. Extract private helpers, each taking the snapshot data
it needs:

- `loadSnapshot(database, today)` — the eight-way `Promise.all` select, returns
  the raw rows.
- `buildUserMap(st, rows, webhooksByUser, pushByUser, today)` — the
  `nextUsers` construction (creds, channels, push, calls, governor, snooze) plus
  single-mode env-var adoption.
- `groupBySearch(seenRows, trackedRows)` — builds `seenBySearch` and
  `trackedBySearch` (also reused to dedupe the grouping loops).
- `rebuildEntries(st, fresh, seenBySearch, trackedBySearch, epochs, savedHitTimes,
savedLastHitAt)` — the per-entry swap/seed/track-rebuild loop.
- `mergeHitTimes(st, hitRows, lastHitRows, savedHitTimes, savedLastHitAt, cutoff)`
  — the post-rebuild hit-time merge.
- `reconcileCounters(database, st, today)` — the per-user `flushCalls`/`mergeCalls`
  loop with the double midnight guard.

`reload()` becomes: flush dirty → prune → `loadSnapshot` → build helper maps →
`buildUserMap` → swap → `rebuildEntries` → `mergeHitTimes` →
`reconcileCounters`.

### 4. `api.ts` — extract `quotaInfo`

The 35-line IIFE inside `status()` becomes:

```ts
function quotaInfo(u: UserCtx | undefined, userId: number, today: string): StatusInfo["quota"];
```

It already depends only on `u`, `userId`, `today`, and the existing helpers
(`usedToday`, `enabledSearchesFor`, `projectedCalls`, `counterDayFrac`,
`factorFor`, `surplusToday`, `MARKET_SAMPLES_PER_DAY`). `status()` calls it;
no other call site changes (the per-row figures in `listSearches` use
`callsPerDayForEntry`, not this object, so there's no second duplication to
collapse here — noted and left).

### 5. Light dead-code sweep

Run `tsc --noEmit` (already clean) and grep for exports referenced only inside
their own module. Candidates to verify and, if truly unused outside tests,
de-export:

- `recentSoldPrices` (track.ts) — private already; confirm.
- Any imports left unused after the extractions.

No export is removed if a test imports it. The sweep is verification-driven, not
speculative deletion.

## Verification

- `bun run lint`
- `bun run build`
- `bun test` — the poller/track/loop tests are the regression net; they must
  pass unchanged in behavior. `poller-loop.test.ts` exercises the sold-check
  paths and is the key signal that the merged core preserved both branches.
- Manual diff review confirming no control-flow reordering in the merged
  check loop (the `stale` break placement and the `flushTracked`/`flushCalls`
  ordering are load-bearing, per the existing comments).

## Risk

Low. Pure extraction + one loop merge, no new logic. The highest-risk piece is
the `runCheckBatch` merge because the two loops differ in three subtle ways; the
spec keeps those as explicit parameters rather than burying them in conditionals,
and the existing `poller-loop.test.ts` covers both paths.
