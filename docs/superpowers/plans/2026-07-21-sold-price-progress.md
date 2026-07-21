# Sold Price Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show active sold-price sample collection in every saved-search subtitle before the existing median threshold is met.

**Architecture:** Keep the 30-day sample calculation in `poller/track.ts`, return its count in `SearchStats`, and render it through a small pure formatting helper. The existing three-sale median gate remains unchanged.

**Tech Stack:** TypeScript, Next.js, Bun test.

## Global Constraints

- Eligible sales remain limited to the existing 30-day window.
- The sold median remains unavailable until at least three eligible sales exist.
- Display `market ~$… · sold N/3` while collection is incomplete; show only `sold ~$…` once the median is available.
- Do not stage unrelated `.codex/`, `.superpowers/`, or pre-existing plan files.

---

### Task 1: Surface sold-price sample progress

**Files:**

- Modify: `src/lib/types.ts`, `src/lib/poller/track.ts`, `src/lib/poller/api.ts`, `src/lib/format.ts`, `src/components/searches-view.tsx`
- Modify: `src/lib/poller/track.test.ts`, `src/__tests__/api-routes.test.ts`
- Create: `src/lib/format.test.ts`

**Interfaces:**

- Produces: `SearchStats.soldSampleCount: number`.
- Produces: `soldSampleCount(sold, now): number`, using the same eligibility window as `soldContext`.
- Produces: `priceSummary(input, currency): string` for saved-search baseline copy.

- [x] **Step 1: Write failing tests**

```ts
expect(soldSampleCount([{ price: 100, atMs: now - DAY }], now)).toBe(1);
expect(soldSampleCount([{ price: 100, atMs: now - 31 * DAY }], now)).toBe(0);
expect(priceSummary({ marketMedian: 484.43, soldMedian: null, soldSampleCount: 1, trackSold: true })).toBe(
  " · market ~$484.43 · sold 1/3",
);
expect(priceSummary({ marketMedian: 484.43, soldMedian: 359.95, soldSampleCount: 3, trackSold: false })).toBe(
  " · market ~$484.43",
);
```

Add an API-route assertion after injecting an entry's recent sold prices: `soldSampleCount` is returned and `soldMedian` stays `null` below three samples.

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/poller/track.test.ts src/lib/format.test.ts src/__tests__/api-routes.test.ts`

Expected: failures for missing `soldSampleCount`, `priceSummary`, and API field.

- [x] **Step 3: Implement the smallest shared contract**

```ts
export const SOLD_MIN_SAMPLE_COUNT = 3;

export function soldSampleCount(sold: readonly { price: number; atMs: number }[], now: number) {
  return recentSoldPrices(sold, now).length;
}
```

Add `soldSampleCount` to every `SearchStats` construction. Have `priceSummary` append ` · sold N/3` only when tracking is on and no sold median is available. Replace the local subtitle baseline formatting with that helper.

- [x] **Step 4: Run focused tests, lint, and build**

Run: `bun test src/lib/poller/track.test.ts src/lib/format.test.ts src/__tests__/api-routes.test.ts && bun run lint && bun run build`

Expected: all commands exit `0`.

- [x] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-07-21-sold-price-progress.md src/lib/types.ts src/lib/poller/track.ts src/lib/poller/api.ts src/lib/format.ts src/components/searches-view.tsx src/lib/poller/track.test.ts src/lib/format.test.ts src/__tests__/api-routes.test.ts
git commit -m "feat: show sold price progress"
```
