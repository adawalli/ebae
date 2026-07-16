import { expect, test } from "bun:test";
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
