import { expect, test } from "bun:test";
import { BOOT_REDELIVER_DEADLINE_MS, bootRedeliverBudgetMs, bootRedeliverLoopBudgetMs } from "./delivery";

// deploy/k8s.yaml's liveness probe, not the /api/health freshness window: the boot redelivery
// sweep runs after st.ready = true but before the first schedule() (see boot.ts), so it's the
// probe - not healthWindowMs - that determines how long the sweep can safely run before kubelet
// restarts the pod. Failures land at t=initialDelaySeconds(30), then every periodSeconds(30); the
// 10th (failureThreshold) lands at 30 + 9x30 = 300s. (Not 30 + 10x30 - that counts eleven probes.)
const K8S_LIVENESS_GRACE_MS = 300_000;
const ONE_ROW_WORST_CASE_MS = 65_000; // 3 Discord attempts x 15s timeout + 2 x 10s backoff

test("bootRedeliverBudgetMs leaves room for startup AND one row's worst-case fan-out, not just the deadline", () => {
  // Near-zero elapsed (the common case): capped at the ceiling, and that ceiling plus one row's
  // fan-out still leaves real margin under the probe grace - the assertion a flat deadline missed.
  const zeroElapsed = bootRedeliverBudgetMs(0);
  expect(zeroElapsed).toBe(BOOT_REDELIVER_DEADLINE_MS);
  expect(K8S_LIVENESS_GRACE_MS - zeroElapsed - ONE_ROW_WORST_CASE_MS).toBeGreaterThanOrEqual(60_000);

  // The budget shrinks as more of the probe grace is already spent on startup.
  const midElapsed = bootRedeliverBudgetMs(200_000);
  expect(midElapsed).toBeLessThan(BOOT_REDELIVER_DEADLINE_MS);
  expect(midElapsed).toBe(K8S_LIVENESS_GRACE_MS - 200_000 - ONE_ROW_WORST_CASE_MS);

  // A slow boot (startup alone already ate the grace minus one row's fan-out): floored at zero,
  // never negative - a negative deadline would make `Date.now() >= deadline` true immediately,
  // which happens to also skip everything, but the floor makes that explicit rather than
  // incidental.
  expect(bootRedeliverBudgetMs(260_000)).toBe(0);
  expect(bootRedeliverBudgetMs(1_000_000)).toBe(0);
});

// The loop's own deadline (sweepStart + this) is anchored BEFORE the pending-row SELECT in
// redeliverPending, so the query's own duration erodes it rather than being free - see the
// comment on bootRedeliverLoopBudgetMs in delivery.ts. That anchoring behavior itself needs a
// real clock and a slow query to exercise end-to-end, which isn't worth a clock-injection harness
// for; what's pure and worth pinning here is the arithmetic budgetMs feeds into: the loop always
// gets strictly less than the overall budget, by exactly the flush reservation, and never negative.
test("bootRedeliverLoopBudgetMs reserves a fixed slice for the flush and never goes negative", () => {
  const zeroElapsed = bootRedeliverLoopBudgetMs(0);
  expect(zeroElapsed).toBeLessThan(bootRedeliverBudgetMs(0));
  expect(bootRedeliverBudgetMs(0) - zeroElapsed).toBeGreaterThan(0); // the reservation itself

  // Once the overall budget floors at zero, the loop budget floors at zero too - not negative.
  expect(bootRedeliverBudgetMs(1_000_000)).toBe(0);
  expect(bootRedeliverLoopBudgetMs(1_000_000)).toBe(0);

  // A budget smaller than the reservation itself must still floor at zero, not go negative.
  // At 232s elapsed, bootRedeliverBudgetMs = 300s - 232s - 65s(one row) = 3s - less than the 5s
  // flush reservation.
  const almostGone = bootRedeliverBudgetMs(232_000);
  expect(almostGone).toBeGreaterThan(0);
  expect(almostGone).toBeLessThan(5_000);
  expect(bootRedeliverLoopBudgetMs(232_000)).toBe(0);
});
