import { describe, expect, test } from "bun:test";
import { parseReleaseBody, parseSemver, selectReleases, semverGt, store, type GhRelease } from "./whatsnew";

// Bodies copied verbatim from the live GitHub releases feed.
const V31 =
  "\n## Highlights\n\n**Release highlights restored** — Highlights from annotated tags now render correctly in GitHub release notes.\n\n## Changelog\n### Fixes\n* ac9f7b5 fix: include release highlights\n\n## Container image\n\n```\ndocker pull adawalli/ebae:0.1.31\n```\n\n";
const V28 = "\n\n## Changelog\n\n## Container image\n\n```\ndocker pull adawalli/ebae:0.1.28\n```\n\n";
const V27 =
  "## Changelog\n### Features\n* 862bd2c feat: track what listings actually sold for\n### Fixes\n* b77799e fix: address PR #35 review feedback\n* a6a91ed fix: serialize tracking writes against resetTracked\n\n## Container image\n\n```\ndocker pull adawalli/ebae:0.1.27\n```\n\n";
const V26 =
  "## Changelog\n### Fixes\n* ab22243 fix: replace the stock Next.js favicon with the ebae mark\n\n## Container image\n\n```\ndocker pull adawalli/ebae:0.1.26\n```\n\n";
const V24 =
  "## Changelog\n### Features\n* b389338 feat: add a daily budget governor and pace-aware quota dashboard\n### Fixes\n* 39702f3 fix: address PR #32 health feedback\n* 3cf83c3 fix: address PR #32 review feedback\n* 3d05fa5 fix: address review findings on the poller split\n* 66bb771 fix: use the defined amber token for governor styling\n### Maintenance\n* 606096a refactor: split poller.ts into modules\n* 8c23ab2 test: assert the health window outlasts every reschedule delay\n* 8e7f356 test: cover the governor's wiring, not just its arithmetic\n\n## Container image\n\n```\ndocker pull adawalli/ebae:0.1.24\n```\n\n";

function rel(tag: string, body = ""): GhRelease {
  return { tag_name: tag, published_at: "2026-07-19T00:00:00Z", body, html_url: `https://x/${tag}` };
}

describe("store", () => {
  test("swallows a full or blocked localStorage", () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        setItem() {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        },
      },
      configurable: true,
    });
    try {
      expect(() => store("k", "v")).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }
  });
});

describe("parseSemver", () => {
  test("accepts a plain release version", () => {
    expect(parseSemver("0.1.26")).toEqual([0, 1, 26]);
  });

  test("rejects anything that is not a stable x.y.z", () => {
    // "dev" is the Docker default, so an unversioned image must never pop the modal.
    for (const v of ["dev", "v0.1.26", "0.1.26-rc.1", "0.1", "0.1.26.1", "", " 0.1.26"]) {
      expect(parseSemver(v)).toBeNull();
    }
  });
});

describe("semverGt", () => {
  test("compares numerically, not lexically", () => {
    expect(semverGt("0.1.10", "0.1.9")).toBe(true);
    expect(semverGt("0.2.0", "0.1.99")).toBe(true);
    expect(semverGt("1.0.0", "0.99.99")).toBe(true);
    expect(semverGt("0.1.9", "0.1.10")).toBe(false);
  });

  test("equal versions are not greater", () => {
    expect(semverGt("0.1.26", "0.1.26")).toBe(false);
  });

  test("invalid input is never greater", () => {
    expect(semverGt("dev", "0.1.26")).toBe(false);
    expect(semverGt("0.1.26", "dev")).toBe(false);
  });
});

describe("selectReleases", () => {
  const feed = [rel("v0.1.26"), rel("v0.1.25"), rel("v0.1.24"), rel("v0.1.23"), rel("v0.1.22"), rel("v0.1.21")];

  test("takes (lastSeen, current], newest first", () => {
    expect(selectReleases(feed, "0.1.22", "0.1.26").map((r) => r.tag_name)).toEqual([
      "v0.1.26",
      "v0.1.25",
      "v0.1.24",
      "v0.1.23",
    ]);
  });

  test("drops releases newer than the running build", () => {
    expect(selectReleases(feed, "0.1.23", "0.1.25").map((r) => r.tag_name)).toEqual(["v0.1.25", "v0.1.24"]);
  });

  test("drops tags that are not stable versions", () => {
    const odd = [rel("v0.1.26"), rel("nightly"), rel("v0.1.26-rc.1"), rel("v0.1.25")];
    expect(selectReleases(odd, "0.1.24", "0.1.26").map((r) => r.tag_name)).toEqual(["v0.1.26", "v0.1.25"]);
  });

  test("is empty when nothing shipped since lastSeen", () => {
    expect(selectReleases(feed, "0.1.26", "0.1.26")).toEqual([]);
  });

  test("sorts by version even when the feed is out of order", () => {
    const shuffled = [rel("v0.1.24"), rel("v0.1.26"), rel("v0.1.25")];
    expect(selectReleases(shuffled, "0.1.23", "0.1.26").map((r) => r.tag_name)).toEqual([
      "v0.1.26",
      "v0.1.25",
      "v0.1.24",
    ]);
  });
});

describe("parseReleaseBody", () => {
  test("reads a curated Highlights block", () => {
    const { highlights } = parseReleaseBody(V31);
    expect(highlights).toEqual([
      {
        title: "Release highlights restored",
        body: "Highlights from annotated tags now render correctly in GitHub release notes.",
        meta: null,
      },
    ]);
  });

  test("falls back to feat entries when there are no highlights", () => {
    const { highlights } = parseReleaseBody(V27);
    expect(highlights).toEqual([{ title: "Track what listings actually sold for", body: "", meta: "feat · 862bd2c" }]);
  });

  test("has no highlights when a release is fixes only", () => {
    expect(parseReleaseBody(V26).highlights).toEqual([]);
  });

  test("keeps changelog groups and their order", () => {
    const { groups } = parseReleaseBody(V24);
    expect(groups.map((g) => [g.title, g.entries.length])).toEqual([
      ["Features", 1],
      ["Fixes", 4],
      ["Maintenance", 3],
    ]);
    expect(groups[1].entries[0]).toEqual({
      hash: "39702f3",
      text: "fix: address PR #32 health feedback",
    });
  });

  test("an empty changelog yields no groups", () => {
    expect(parseReleaseBody(V28)).toEqual({ highlights: [], groups: [] });
  });

  test("the container image fence is never read as changelog", () => {
    for (const body of [V31, V27, V26, V24]) {
      const { groups } = parseReleaseBody(body);
      expect(groups.flatMap((g) => g.entries).some((e) => e.text.includes("docker pull"))).toBe(false);
    }
  });

  test("keeps a highlight body that wraps onto later lines", () => {
    const body =
      "## Highlights\n\n**Daily budget governor** — Polling stretches when spend runs ahead of the day,\nso your quota lasts to midnight.\n\n**Second one** — Short.\n";
    expect(parseReleaseBody(body).highlights).toEqual([
      {
        title: "Daily budget governor",
        body: "Polling stretches when spend runs ahead of the day, so your quota lasts to midnight.",
        meta: null,
      },
      { title: "Second one", body: "Short.", meta: null },
    ]);
  });

  test("promotes breaking-change feats", () => {
    const body =
      "## Changelog\n### Features\n* aaaaaaa feat!: drop the legacy poller\n* bbbbbbb feat(api)!: rename the status field\n";
    expect(parseReleaseBody(body).highlights).toEqual([
      { title: "Drop the legacy poller", body: "", meta: "feat · aaaaaaa" },
      { title: "Rename the status field", body: "", meta: "feat · bbbbbbb" },
    ]);
  });

  test("accepts an en dash or a hyphen as the separator", () => {
    const { highlights } = parseReleaseBody("## Highlights\n\n**En** – One.\n\n**Plain** - Two.\n");
    expect(highlights).toEqual([
      { title: "En", body: "One.", meta: null },
      { title: "Plain", body: "Two.", meta: null },
    ]);
  });

  test("ignores highlight lines that are not title — sentence", () => {
    const { highlights } = parseReleaseBody("## Highlights\n\nJust a loose sentence.\n**No dash here**\n");
    expect(highlights).toEqual([]);
  });

  test("survives an empty body", () => {
    expect(parseReleaseBody("")).toEqual({ highlights: [], groups: [] });
  });
});
