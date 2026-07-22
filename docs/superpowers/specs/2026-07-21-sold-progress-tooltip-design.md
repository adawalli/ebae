# Sold Progress Tooltip Design

## Goal

Explain the incomplete `sold N/3` status in a saved-search subtitle without changing the status text or sold-price calculation.

## UI

When a search is tracking sold prices, has at least one eligible sale, and has not yet reached a sold median, keep the existing `sold N/3` label and place a small help icon beside the subtitle. Hovering, focusing, or tapping that icon opens the existing Radix tooltip:

> 1 of 3 recent eligible sales collected. Three are needed before ebae uses a sold-price median.

The icon has an explicit accessible name. It is absent when sold tracking is disabled, no eligible sale exists, or the sold median is available.

## Implementation

`src/components/searches-view.tsx` will use the existing `Tooltip`, `TooltipTrigger`, and `TooltipContent` components. The status line becomes a flex row so its text can still truncate while the help control remains visible. A small pure helper in `src/lib/format.ts` will supply the tooltip copy only for the same incomplete-progress state that renders `sold N/3`.

## Verification

Add focused Bun tests for the helper's eligible and ineligible states. Verify the rendered control manually in the browser for hover, keyboard focus, and the completed-sample state. Run the relevant tests, lint, and production build.

## Scope

No data model, API, configuration, or product-documentation change.
