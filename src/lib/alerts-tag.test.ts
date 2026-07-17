import { expect, test } from "bun:test";
import { alertsTag, bumpAlerts } from "./poller";

// The tag is what keeps a serverless Postgres asleep while the app sits open: the UI polls
// /api/alerts every 10s, and that is the only polled route that reads the DB. If the tag ever
// changed when the list didn't, the poll would query on every tick and the compute would never
// suspend. If it failed to change when the list did, a tab would show stale alerts forever.

type St = { ready: boolean; bootedAt: number | null; alertsRev: Map<number, number> };
const st = (): St => {
  alertsTag(0); // the state is lazy; force it to exist before reaching for it
  return (globalThis as unknown as { __ebaeState: St }).__ebaeState;
};

// A booted process is the normal case; the fences get their own tests below.
const booted = (): St => {
  const s = st();
  s.ready = true;
  s.bootedAt = 1_700_000_000_000;
  return s;
};

// Each test owns its own user ids, so a bump in one can't move a tag in another.
test("no tag until the poller is ready", () => {
  const s = booted();
  s.ready = false;
  // Null, not a tag: until migrate/claim/reload have landed, the route's answers are
  // provisional. claimLegacyRows adopts a user's pre-multi-user alerts without touching any
  // rev, so a tag minted before it would be reissued verbatim after and freeze that history
  // at empty. Serving from the DB for those few seconds is the cheap side of the trade.
  expect(alertsTag(101)).toBeNull();
  s.ready = true;
  expect(alertsTag(101)).not.toBeNull();
});

test("an unchanged list keeps one stable tag", () => {
  booted();
  const first = alertsTag(102);
  expect(first).not.toBeNull();
  expect(alertsTag(102)).toBe(first!); // every 10s poll in a quiet hour: same tag -> 304 -> no query
});

test("a bump changes the tag, and only for that user", () => {
  booted();
  const before = alertsTag(103);
  const neighbour = alertsTag(104);

  bumpAlerts(103);

  expect(alertsTag(103)).not.toBe(before!);
  // Revisions are per-user: one person's alert must not force everyone else's tabs to refetch.
  expect(alertsTag(104)).toBe(neighbour!);
});

// The tag is a promise about a body, so two people's bodies must never carry the same promise.
// Every rev starts at 0, so without the user id in the string every user's tag is identical for
// the whole window after a deploy. A shared browser is then one re-login away from a cross-user
// leak: the private cache still holds the previous user's response for this URL, revalidates it
// on its own, is told 304, and renders their alerts to whoever is logged in now.
test("two users never mint the same tag, even at the same revision", () => {
  booted();
  expect(alertsTag(105)).not.toBe(alertsTag(106)); // both at rev 0, the post-deploy case

  bumpAlerts(105);
  bumpAlerts(106);
  expect(alertsTag(105)).not.toBe(alertsTag(106)); // and still distinct once both have moved
});

test("a restart invalidates a tag the counter alone would reissue", () => {
  const s = booted();
  s.alertsRev.delete(107);
  const before = alertsTag(107); // rev 0

  // The counter lives in memory, so a restart resets it to 0 - the same rev the old tag was
  // minted at. Without bootedAt in the tag, a client would present a stale validator, get a
  // 304, and sit on data this process never actually vouched for.
  s.bootedAt = 1_700_000_999_999;
  expect(alertsTag(107)).not.toBe(before!);
});
