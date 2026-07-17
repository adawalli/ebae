import { expect, test } from "bun:test";
import { GET } from "./route";

// Drives the redirect guard through the real handler (toEbay is private). Location is the only
// thing that matters: a valid listing passes through, anything else lands on "/".
async function locationFor(u: string | null) {
  const url = u === null ? "https://app.test/go" : `https://app.test/go?u=${encodeURIComponent(u)}`;
  return (await GET(new Request(url))).headers.get("location");
}

test("passes through every supported marketplace domain", async () => {
  const hosts = ["ebay.com", "ebay.ca", "ebay.co.uk", "ebay.com.au", "ebay.de", "ebay.fr", "ebay.it", "ebay.es"];
  for (const host of [...hosts, "www.ebay.com"]) {
    const listing = `https://${host}/itm/123`;
    expect(await locationFor(listing)).toBe(listing);
  }
});

test("rejects lookalike and out-of-scope hosts", async () => {
  for (const bad of [
    "https://evilebay.com/itm/1", // suffix-spoof: not a subdomain of ebay.com
    "https://ebay.com.attacker.com/itm/1", // subdomain-spoof
    "https://attacker.com/itm/1",
  ]) {
    expect(await locationFor(bad)).toBe("https://app.test/");
  }
});

test("rejects non-https schemes and missing/garbage input", async () => {
  expect(await locationFor("http://www.ebay.com/itm/1")).toBe("https://app.test/");
  expect(await locationFor("javascript:alert(1)")).toBe("https://app.test/");
  expect(await locationFor(null)).toBe("https://app.test/");
  expect(await locationFor("not a url")).toBe("https://app.test/");
});
