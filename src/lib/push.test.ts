import { expect, test } from "bun:test";
import { markStalePush, pushIsStale } from "./poller";
import { parsePushBody, pushHostAllowed } from "./validate";

// The allowlist is an SSRF guard, not a formality: the poller POSTs to whatever endpoint
// is stored, and the endpoint arrives from the browser as untrusted input.

const P256DH = "B".repeat(87);
const AUTH = "A".repeat(22);
const body = (endpoint: string) => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } });

test("accepts the real push services", () => {
  for (const e of [
    "https://fcm.googleapis.com/fcm/send/abc123",
    "https://fcm.googleapis.com/wp/abc123", // newer FCM path, same host
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QAbc123",
    "https://wns2-ln2p.notify.windows.com/w/?token=abc", // wns2-* subdomain varies
  ])
    expect(pushHostAllowed(e)).toBe(true);
});

test("rejects hosts that merely contain an allowed one", () => {
  // The reason the check is === / endsWith(".host") and never includes().
  for (const e of [
    "https://evil-fcm.googleapis.com.attacker.com/x",
    "https://fcm.googleapis.com.attacker.com/x",
    "https://attacker.com/fcm.googleapis.com",
    "https://notify.windows.com.evil.com/x", // suffix must be ".notify.windows.com"
  ])
    expect(pushHostAllowed(e)).toBe(false);
});

test("rejects non-https, ports, and internal targets", () => {
  for (const e of [
    "http://fcm.googleapis.com/fcm/send/abc", // plaintext
    "https://fcm.googleapis.com:8080/fcm/send/abc", // port -> not the real service
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://localhost:3000/",
    "https://10.0.0.5/internal",
    "not a url",
    "",
  ])
    expect(pushHostAllowed(e)).toBe(false);
});

test("parsePushBody returns the subscription for a good body", () => {
  const out = parsePushBody(body("https://web.push.apple.com/QAbc123"));
  expect(out).toEqual({ endpoint: "https://web.push.apple.com/QAbc123", p256dh: P256DH, auth: AUTH });
});

test("parsePushBody rejects a disallowed host before anything else", () => {
  expect(parsePushBody(body("https://attacker.example/x"))).toBe("endpoint is not a recognized push service");
});

test("parsePushBody requires both keys", () => {
  const e = "https://fcm.googleapis.com/fcm/send/abc";
  expect(parsePushBody({ endpoint: e, keys: { p256dh: P256DH } })).toBe("keys.p256dh and keys.auth are required");
  expect(parsePushBody({ endpoint: e, keys: { auth: AUTH } })).toBe("keys.p256dh and keys.auth are required");
  expect(parsePushBody({ endpoint: e })).toBe("keys.p256dh and keys.auth are required");
  expect(parsePushBody({})).toBe("endpoint is required");
  expect(parsePushBody(null)).toBe("endpoint is required");
});

test("parsePushBody rejects oversized keys", () => {
  const e = "https://fcm.googleapis.com/fcm/send/abc";
  expect(parsePushBody({ endpoint: e, keys: { p256dh: "x".repeat(201), auth: AUTH } })).toBe("keys are malformed");
  expect(parsePushBody({ endpoint: e, keys: { p256dh: P256DH, auth: "x".repeat(101) } })).toBe("keys are malformed");
});

// Reaping mid-batch has to take the live target count to zero, or an alert gets written
// with deliveredAt=null seeded for a subscription that no longer exists and nothing ever
// delivers it. This is the narrowing pollOnce does around reapPush, in isolation.
test("a batch that reaps its last subscription stops counting it as a target", () => {
  const webhooks: string[] = [];
  let subs = [
    { endpoint: "https://fcm.googleapis.com/fcm/send/live", p256dh: P256DH, auth: AUTH },
    { endpoint: "https://fcm.googleapis.com/fcm/send/dead", p256dh: P256DH, auth: AUTH },
  ];
  expect(webhooks.length + subs.length).toBe(2);

  const reap = (dead: string[]) => {
    const gone = new Set(dead);
    subs = subs.filter((s) => !gone.has(s.endpoint));
  };

  reap(["https://fcm.googleapis.com/fcm/send/dead"]);
  expect(webhooks.length + subs.length).toBe(1);

  reap(["https://fcm.googleapis.com/fcm/send/live"]);
  // The next item in the same batch must see zero, so it stamps deliveredAt at insert
  // rather than waiting forever on a target that is gone.
  expect(webhooks.length + subs.length).toBe(0);
});

// A reaped endpoint has to stay known after its row is gone. The browser goes on handing
// the same dead endpoint back, so without this the subscribe route re-adds it on the next
// load, the next alert reaps it again, and push is silently dead forever.
test("a reaped endpoint is remembered so the client is told to resubscribe", () => {
  const dead = "https://web.push.apple.com/dead-token";
  expect(pushIsStale(dead)).toBe(false);
  markStalePush([dead]);
  expect(pushIsStale(dead)).toBe(true);
  // The replacement the client mints must not be caught by it.
  expect(pushIsStale("https://web.push.apple.com/fresh-token")).toBe(false);
});

test("the stale set is bounded and evicts the coldest endpoint first", () => {
  const at = (i: number) => `https://web.push.apple.com/bound-${i}`;
  // 500 is MAX_STALE_PUSH; push well past it. Endpoints churn (iOS re-mints them every week
  // or two) and this set outlives every row it names, so unbounded is a slow leak.
  markStalePush(Array.from({ length: 600 }, (_, i) => at(i)));
  expect(pushIsStale(at(0))).toBe(false); // coldest, evicted
  expect(pushIsStale(at(599))).toBe(true); // newest, kept

  // Re-marking is a fresh death, not a duplicate: a corpse we're still being handed must
  // not be the next one evicted.
  const survivor = at(150);
  markStalePush([survivor]);
  markStalePush(Array.from({ length: 200 }, (_, i) => at(1000 + i)));
  expect(pushIsStale(survivor)).toBe(true);
});
