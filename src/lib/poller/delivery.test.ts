import { expect, test } from "bun:test";
import { BOOT_REDELIVER_DEADLINE_MS } from "./delivery";

// deploy/k8s.yaml's liveness probe, not the /api/health freshness window: the boot redelivery
// sweep runs after st.ready = true but before the first schedule() (see boot.ts), so it's the
// probe - not healthWindowMs - that determines how long the sweep can safely run before kubelet
// restarts the pod. initialDelaySeconds(30) + failureThreshold(10) x periodSeconds(30) = 330s.
const K8S_LIVENESS_GRACE_MS = (30 + 10 * 30) * 1000;

test("BOOT_REDELIVER_DEADLINE_MS fits inside the k8s liveness probe grace with margin", () => {
  expect(BOOT_REDELIVER_DEADLINE_MS).toBeLessThan(K8S_LIVENESS_GRACE_MS);
  // Comfortable margin, not just "under": a future edit to either number should have to think
  // about this relationship, not just avoid a hair's-breadth failure.
  expect(K8S_LIVENESS_GRACE_MS - BOOT_REDELIVER_DEADLINE_MS).toBeGreaterThanOrEqual(60_000);
});
