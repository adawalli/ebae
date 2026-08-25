import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchesView } from "./searches-view";
import type { SearchStats } from "@/lib/types";

const search = {
  id: 1,
  userId: 1,
  q: "Mac Studio M2 Max 64gb",
  name: "Mac Studio Plan B",
  categoryId: null,
  priceFloor: null,
  priceCap: null,
  binOnly: true,
  includeAuctions: false,
  conditions: null,
  excludeTerms: null,
  marketMedian: null,
  marketSampledAt: null,
  trackSold: true,
  intervalMin: 5,
  enabled: true,
  seeded: true,
  createdAt: "2026-08-24T12:00:00.000Z",
  seenCount: 0,
  hits24: 0,
  lastHitAt: null,
  lastPolledAt: null,
  effectiveIntervalMin: 5,
  callsPerDay: 288,
  soldMedian: null,
  soldSampleCount: 0,
  checksDue24h: 0,
} as SearchStats;

test("saved-search rows show a custom name above the raw query", () => {
  const html = renderToStaticMarkup(
    <SearchesView
      searches={[search]}
      active={[search]}
      projected={288}
      ceiling={5000}
      quotaPct={6}
      running
      mock
      noCreds={false}
      status={null}
      openCreate={() => {}}
      openEdit={() => {}}
      togglePause={() => {}}
      removeSearch={() => {}}
    />,
  );

  expect(html).toContain("Mac Studio Plan B");
  expect(html).toContain("Mac Studio M2 Max 64gb");
  expect(html.indexOf("Mac Studio Plan B")).toBeLessThan(html.indexOf("Mac Studio M2 Max 64gb"));
});
