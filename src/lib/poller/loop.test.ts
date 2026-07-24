import { expect, test } from "bun:test";
import { RateLimitError } from "@/lib/ebay";
import { MAX_BACKOFF_MS, retryDelayMs } from "./loop";

const MIN = 60_000;

// A rate-limit error carries eBay's own wait hint. The loop honors it instead of blind backoff,
// but never polls faster than the user's interval and never parks past the backoff cap (which is
// what keeps the /api/health heartbeat window fresh).
test("retryDelayMs: a rate-limit hint is honored, floored at the interval, capped at MAX_BACKOFF_MS", () => {
  // hint between interval and cap: used as-is, and backoff is reset (not compounded)
  expect(retryDelayMs(new RateLimitError(10 * MIN), 5, 0)).toEqual({ delayMs: 10 * MIN, backoffMs: 0 });
  // a hint under the user's interval is floored to the interval
  expect(retryDelayMs(new RateLimitError(30_000), 5, 0)).toEqual({ delayMs: 5 * MIN, backoffMs: 0 });
  // an absurd hint (or a daily-quota reset hours out) is capped so the heartbeat stays fresh
  expect(retryDelayMs(new RateLimitError(6 * 3600_000), 5, 0)).toEqual({ delayMs: MAX_BACKOFF_MS, backoffMs: 0 });
  // honoring the hint clears any prior backoff
  expect(retryDelayMs(new RateLimitError(10 * MIN), 5, MAX_BACKOFF_MS)).toEqual({ delayMs: 10 * MIN, backoffMs: 0 });
});

// validate.ts allows intervalMin up to 60, i.e. an interval longer than MAX_BACKOFF_MS. A flat
// 30min cap would drop such a search BELOW its own configured cadence on a 429, breaking the
// "never faster than the interval" guarantee - the ceiling has to rise to the interval. The health
// window is >= intervalMs*GOV_MAX_FACTOR, so honoring the full interval still reads healthy.
test("retryDelayMs: an interval longer than MAX_BACKOFF_MS is honored, not clamped down to 30min", () => {
  // interval 45min, eBay asks for 45min: honored in full, not collapsed to 30min
  expect(retryDelayMs(new RateLimitError(45 * MIN), 45, 0)).toEqual({ delayMs: 45 * MIN, backoffMs: 0 });
  // a shorter hint is still floored to the 45min interval
  expect(retryDelayMs(new RateLimitError(30_000), 45, 0)).toEqual({ delayMs: 45 * MIN, backoffMs: 0 });
  // a longer hint is capped at the interval (the ceiling for intervals past MAX_BACKOFF_MS)
  expect(retryDelayMs(new RateLimitError(2 * 3600_000), 45, 0)).toEqual({ delayMs: 45 * MIN, backoffMs: 0 });
});

// Any other error uses exponential backoff: one interval on the first failure, doubling each
// time, capped. Unchanged from the pre-rate-limit behavior.
test("retryDelayMs: a generic error backs off exponentially from the interval, capped", () => {
  const first = retryDelayMs(new Error("500"), 5, 0);
  expect(first).toEqual({ delayMs: 5 * MIN, backoffMs: 5 * MIN }); // first failure = one interval
  const second = retryDelayMs(new Error("500"), 5, first.backoffMs);
  expect(second).toEqual({ delayMs: 10 * MIN, backoffMs: 10 * MIN }); // doubles
  const capped = retryDelayMs(new Error("500"), 5, MAX_BACKOFF_MS);
  expect(capped).toEqual({ delayMs: MAX_BACKOFF_MS, backoffMs: MAX_BACKOFF_MS }); // never past the cap
});
