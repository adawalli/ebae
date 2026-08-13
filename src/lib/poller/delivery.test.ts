import { expect, test } from "bun:test";
import { BOOT_REDELIVER_DEADLINE_MS, bootRedeliverBudgetMs } from "./delivery";

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
