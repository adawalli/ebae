# Sold Price Progress Design

## Goal

Make active sold-price tracking visible before three recent realized prices can form a median.

## Approach

Expose each search's count of eligible realized prices from the existing 30-day sold-price window. Keep the current three-sale gate for using a sold median in alerts and list copy.

The saved-search subtitle reads:

- `market ~$484.43 · sold 1/3` while collection is incomplete.
- `sold ~$359.95` once at least three eligible sales exist.

Disabled tracking shows neither sold progress nor a sold median. The market price remains the fallback until the threshold is met.

## Data Flow

`soldContext` remains the source of truth for the 30-day window and minimum sample size. A companion count is returned by `GET /api/searches` as `soldSampleCount`; `SearchesView` uses it only for the incomplete state.

## Testing

Cover zero, partial, and sufficient sample counts at the poller/API boundary, plus subtitle copy for the incomplete and complete states.
