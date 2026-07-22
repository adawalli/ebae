# Sold Progress Tooltip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain an incomplete `sold N/3` sample count with an accessible tooltip in each saved-search subtitle.

**Architecture:** Keep the existing `priceSummary()` label unchanged. Add one pure formatting helper that returns tooltip copy for exactly the incomplete-progress state, then render that copy through the existing Radix tooltip components beside the truncatable subtitle.

**Tech Stack:** TypeScript, React 19, Next.js 16, Radix UI, Bun test.

## Global Constraints

- Retain `sold N/3` as the visible subtitle text.
- Tooltip copy is exactly: `N of 3 recent eligible sales collected. Three are needed before ebae uses a sold-price median.`
- Render the help control only while sold tracking is enabled, a sample exists, and no sold median is available.
- The trigger must be keyboard-focusable and have `aria-label="Explain sold price progress"`.
- Do not change the sold-price calculation, API response, schema, configuration, or README.
- Do not stage unrelated `.codex/`, `.superpowers/`, or existing untracked plan files.

---

### Task 1: Add the sold-progress help affordance

**Files:**

- Create: `docs/superpowers/plans/2026-07-21-sold-progress-tooltip.md`
- Modify: `src/lib/format.ts`
- Modify: `src/lib/format.test.ts`
- Modify: `src/components/searches-view.tsx`

**Interfaces:**

- Produces: `soldProgressTooltip(s): string | null` from `src/lib/format.ts`.
- Consumes: `SearchStats.trackSold`, `SearchStats.soldMedian`, and `SearchStats.soldSampleCount`.
- Produces: a focusable help button and Radix tooltip in the saved-search subtitle only when the helper returns copy.

- [ ] **Step 1: Write the failing helper tests**

Add to `src/lib/format.test.ts`:

```ts
import { priceSummary, soldProgressTooltip } from "./format";

test("soldProgressTooltip: explains an incomplete sold-price sample", () => {
  expect(soldProgressTooltip({ soldMedian: null, soldSampleCount: 1, trackSold: true })).toBe(
    "1 of 3 recent eligible sales collected. Three are needed before ebae uses a sold-price median.",
  );
});

test("soldProgressTooltip: hides help outside incomplete sold progress", () => {
  expect(soldProgressTooltip({ soldMedian: null, soldSampleCount: 0, trackSold: true })).toBeNull();
  expect(soldProgressTooltip({ soldMedian: 359.95, soldSampleCount: 3, trackSold: true })).toBeNull();
  expect(soldProgressTooltip({ soldMedian: null, soldSampleCount: 1, trackSold: false })).toBeNull();
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test src/lib/format.test.ts`

Expected: FAIL because `soldProgressTooltip` is not exported.

- [ ] **Step 3: Implement the smallest shared tooltip helper**

Add to `src/lib/format.ts` after `priceSummary()`:

```ts
export function soldProgressTooltip(s: Pick<SearchStats, "soldMedian" | "soldSampleCount" | "trackSold">) {
  if (!s.trackSold || s.soldMedian != null || s.soldSampleCount === 0) return null;
  return `${s.soldSampleCount} of ${SOLD_MIN_COUNT} recent eligible sales collected. ${SOLD_MIN_COUNT} are needed before ebae uses a sold-price median.`;
}
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `bun test src/lib/format.test.ts`

Expected: PASS with all format tests green.

- [ ] **Step 5: Render the accessible tooltip in the search subtitle**

In `src/components/searches-view.tsx`:

```ts
import { CircleHelp, ExternalLink, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { ago, fmt, money, priceSummary, shownSurplus, soldProgressTooltip } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
```

Keep `const [openSoldProgressTooltip, setOpenSoldProgressTooltip] = useState<number | null>(null);` in the component. Derive `const progressHelp = s.enabled && s.seeded ? soldProgressTooltip(s) : null;` beside each search row's `seeding` and `exclusions` values. Replace the subtitle wrapper with:

```tsx
<div className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[11.5px] text-[var(--eb-faint)]">
  <span className="truncate">{searchSub(s)}</span>
  {progressHelp && (
    <TooltipProvider>
      <Tooltip
        open={openSoldProgressTooltip === s.id}
        onOpenChange={(open) => setOpenSoldProgressTooltip(open ? s.id : null)}
      >
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Explain sold price progress"
            onPointerDown={(event) => {
              if (event.pointerType !== "touch") return;
              event.preventDefault();
              setOpenSoldProgressTooltip((openId) => (openId === s.id ? null : s.id));
            }}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-[var(--eb-faint)] transition-colors hover:text-[var(--eb-accent-text)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <CircleHelp aria-hidden="true" className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {progressHelp}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )}
</div>
```

The `span` continues to truncate long status text; the help control remains visible and has an independent keyboard target. Touch toggles the controlled row after preventing Radix's touch close path; hover and keyboard focus use Radix's existing `onOpenChange` behavior.

- [ ] **Step 6: Run focused automated verification**

Run: `bun test src/lib/format.test.ts && bun run lint && bun run build`

Expected: all commands exit `0`.

- [ ] **Step 7: Verify the user-facing behavior in a browser**

Run `bun run dev`, open the saved-searches view in mock mode, then confirm:

1. An incomplete `sold 1/3` row shows the help icon.
2. Hovering and tabbing to it reveal the approved copy.
3. A touch tap opens and closes the approved copy.
4. A completed sold median, disabled row, seeding row, and zero-sample row do not show the icon.

- [ ] **Step 8: Commit the scoped implementation**

```bash
git add docs/superpowers/plans/2026-07-21-sold-progress-tooltip.md src/lib/format.ts src/lib/format.test.ts src/components/searches-view.tsx
git commit -m "feat: explain sold price progress"
```
