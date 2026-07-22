import { expect, test } from "bun:test";
import { priceSummary, soldProgressTooltip } from "./format";

test("priceSummary: shows market price and incomplete sold samples", () => {
  expect(priceSummary({ marketMedian: 484.43, soldMedian: null, soldSampleCount: 1, trackSold: true })).toBe(
    " · market ~$484.43 · sold 1/3",
  );
});

test("priceSummary: replaces market price with a usable sold median", () => {
  expect(priceSummary({ marketMedian: 484.43, soldMedian: 359.95, soldSampleCount: 3, trackSold: true })).toBe(
    " · sold ~$359.95",
  );
});

test("priceSummary: hides sold details when tracking is disabled", () => {
  expect(priceSummary({ marketMedian: 484.43, soldMedian: 359.95, soldSampleCount: 3, trackSold: false })).toBe(
    " · market ~$484.43",
  );
});

test("priceSummary: omits empty sold progress", () => {
  expect(priceSummary({ marketMedian: 484.43, soldMedian: null, soldSampleCount: 0, trackSold: true })).toBe(
    " · market ~$484.43",
  );
});

test("soldProgressTooltip: explains an incomplete sold-price sample", () => {
  expect(soldProgressTooltip({ soldMedian: null, soldSampleCount: 1, trackSold: true })).toBe(
    "1 of 3 recent eligible sales collected. Three are needed before ebae uses a sold-price median.",
  );
});

test("soldProgressTooltip: hides help outside incomplete sold progress", () => {
  expect(soldProgressTooltip({ soldMedian: null, soldSampleCount: 0, trackSold: true })).toBeNull();
  expect(soldProgressTooltip({ soldMedian: 359.95, soldSampleCount: 3, trackSold: true })).toBeNull();
  expect(soldProgressTooltip({ soldMedian: null, soldSampleCount: 1, trackSold: false })).toBeNull();
});
