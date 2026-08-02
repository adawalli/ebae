import { expect, test } from "bun:test";
import { redact } from "./log";

// redact() is the last-ditch scrub on text that reaches three user-visible places, not just
// stdout: the pino err serializer, recordError's Status-page ring buffer, and routeError's 500
// body. One case per secret class it knows about, plus an ordinary line that must survive
// untouched - a regex that eats normal log text is its own outage.

test("scrubs the credentials out of a Postgres connection string", () => {
  const out = redact("connect failed: postgresql://neon:hunter2@db.neon.tech/main?sslmode=require");
  expect(out).not.toContain("hunter2");
  // Only the userinfo goes: the host is what makes the message diagnosable at all.
  expect(out).toBe("connect failed: [redacted]db.neon.tech/main?sslmode=require");
  expect(redact("postgres://u:p@localhost:5432/ebae")).toBe("[redacted]localhost:5432/ebae");
});

test("scrubs a Discord webhook URL, which is the token", () => {
  expect(redact("POST https://discord.com/api/webhooks/123456/abcTOKEN failed with 404")).toBe(
    "POST [redacted] failed with 404",
  );
  // discordapp.com is the legacy host and still delivers, so it leaks exactly the same secret.
  expect(redact("https://discordapp.com/api/webhooks/9/tok")).toBe("[redacted]");
});

test("scrubs Bearer and Basic authorization values", () => {
  // The eBay token request sends Basic; a drizzle/fetch error can carry the header verbatim.
  expect(redact('{"authorization":"Bearer eyJhbGciOiJSUzI1NiJ9.abc-def_123"}')).toBe('{"authorization":"[redacted]"}');
  expect(redact("Basic dXNlcjpwYXNzd29yZA==")).toBe("[redacted]");
});

test("scrubs a push endpoint from every allowlisted host", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/cLpEDrq5:APA91b",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA",
    "https://web.push.apple.com/AAAA-BBBB",
    // WNS rotates its subdomain, which is why that one host is matched as a suffix. Both depths
    // are here because validate.ts admits either (endsWith), so redaction has to cover both or a
    // subscribable, bearer-equivalent endpoint reaches the Status page ring buffer intact.
    "https://wns2-par02p.notify.windows.com/w/?token=AQ",
    "https://sub.wns2-par02p.notify.windows.com/w/?token=AQ",
  ]) {
    expect(redact(`push failed for ${endpoint}`)).toBe("push failed for [redacted]");
  }
});

test("a path segment cannot forge an allowlisted push host", () => {
  // The host arms span dots but never `/`, so an attacker-controlled path can't impersonate WNS.
  const notAnEndpoint = "https://evil.com/x.notify.windows.com/y";
  expect(redact(notAnEndpoint)).toBe(notAnEndpoint);
});

test("scrubs a secret buried mid-string, and every occurrence of it", () => {
  expect(
    redact("two channels down: https://discord.com/api/webhooks/1/aaa and https://discord.com/api/webhooks/2/bbb, up"),
  ).toBe("two channels down: [redacted] and [redacted] up");
});

test("ordinary log text passes through unchanged", () => {
  const line = "poll failed for search 12: eBay returned 429 (rate limited), backing off 30s";
  expect(redact(line)).toBe(line);
  expect(redact("visit https://www.ebay.com/itm/123456 for the listing")).toBe(
    "visit https://www.ebay.com/itm/123456 for the listing",
  );
});

// A non-standard error reaches the err serializer with an undefined message or stack, and the
// serializer redacts both unconditionally.
test("a nullish input reads as an empty string rather than throwing", () => {
  expect(redact(undefined as unknown as string)).toBe("");
});
