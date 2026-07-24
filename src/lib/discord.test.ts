import { expect, test } from "bun:test";
import { mkItem } from "@/__tests__/helpers/fixtures";
import { discordRetryMs, notify } from "./discord";
import type { Item, Search } from "./types";

const item: Item = mkItem({ condition: "New", conditionId: "1000" });

const search = { id: 1, q: "Sonos Era 300" } as Search;

// Swap fetch for a scripted handler and count the calls. Restores on the returned cleanup.
function stubFetch(handler: (url: string, call: number) => Response | Promise<Response>): {
  restore: () => void;
  calls: () => number;
} {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input), n++)) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = real;
    },
    calls: () => n,
  };
}

// notify()'s retry sleeps between attempts; run the callback synchronously so a failure-path
// test doesn't spend real seconds waiting.
function fastTimers(): () => void {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  return () => {
    globalThis.setTimeout = real;
  };
}

// The 429 wait parser. Discord puts the wait in the JSON body (fractional seconds); the
// Retry-After header (integer seconds) is the backup. Neither usable -> 0, so notify() keeps
// its own default backoff.
test("discordRetryMs: body retry_after wins, header is the fallback, capped at 10s", () => {
  const withHeader = (h: Record<string, string>) => new Response("", { headers: h });
  expect(discordRetryMs(withHeader({}), JSON.stringify({ retry_after: 0.75 }))).toBe(750);
  // no body value -> read the header
  expect(discordRetryMs(withHeader({ "retry-after": "3" }), "{}")).toBe(3000);
  // non-JSON body -> header fallback
  expect(discordRetryMs(withHeader({ "retry-after": "2" }), "<html>rate limited</html>")).toBe(2000);
  // a rate-limited webhook must never stall the poll indefinitely
  expect(discordRetryMs(withHeader({}), JSON.stringify({ retry_after: 999 }))).toBe(10_000);
  // nothing usable
  expect(discordRetryMs(withHeader({}), "garbage")).toBe(0);
  expect(discordRetryMs(withHeader({ "retry-after": "-5" }), "{}")).toBe(0);
});

test("notify: delivers to every webhook and reports success", async () => {
  const s = stubFetch(() => new Response("", { status: 204 }));
  try {
    const r = await notify(item, search, ["https://discord.com/api/webhooks/a", "https://discord.com/api/webhooks/b"]);
    expect(r).toEqual({ error: null, anyDelivered: true });
    expect(s.calls()).toBe(2); // one POST each, no retries
  } finally {
    s.restore();
  }
});

test("notify: retries a failing webhook up to 3 times, then reports the last error", async () => {
  const s = stubFetch(() => new Response("boom", { status: 500 }));
  const timers = fastTimers();
  try {
    const r = await notify(item, search, ["https://discord.com/api/webhooks/a"]);
    expect(r.anyDelivered).toBe(false);
    expect(r.error).toBe("Discord webhook 500");
    expect(s.calls()).toBe(3); // 3 attempts for the one webhook
  } finally {
    timers();
    s.restore();
  }
});

test("notify: a 429 then success reads the retry hint without crashing and delivers", async () => {
  const s = stubFetch((_url, call) =>
    call === 0
      ? new Response(JSON.stringify({ retry_after: 0.1 }), { status: 429 })
      : new Response("", { status: 204 }),
  );
  const timers = fastTimers();
  try {
    const r = await notify(item, search, ["https://discord.com/api/webhooks/a"]);
    expect(r).toEqual({ error: null, anyDelivered: true });
    expect(s.calls()).toBe(2); // 429, then the retry succeeds
  } finally {
    timers();
    s.restore();
  }
});

// A thrown fetch error can echo the webhook URL (its secret token); notify must never surface it.
test("notify: a transport error is reported by name only, never leaking the URL", async () => {
  const s = stubFetch(() => {
    throw new Error("connect ECONNREFUSED https://discord.com/api/webhooks/SECRET/TOKEN");
  });
  const timers = fastTimers();
  try {
    const r = await notify(item, search, ["https://discord.com/api/webhooks/SECRET/TOKEN"]);
    expect(r.anyDelivered).toBe(false);
    expect(r.error).not.toContain("SECRET");
    expect(r.error).not.toContain("TOKEN");
  } finally {
    timers();
    s.restore();
  }
});
