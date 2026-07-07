import { expect, test } from "bun:test";
import { matchCriteriaChanged, mergeCalls } from "./poller";

// The re-seed guard in updateSearch: editing what a search matches must reset the
// seeded baseline, but touching only interval/enabled (or a no-op edit) must not.
const cur = {
  q: "Leica M6",
  categoryId: null,
  priceFloor: null,
  priceCap: 2500,
  binOnly: true,
  includeAuctions: false,
};

test("changing a match field re-seeds", () => {
  expect(matchCriteriaChanged(cur, { q: "Leica M3" })).toBe(true);
  expect(matchCriteriaChanged(cur, { priceCap: 3000 })).toBe(true);
  expect(matchCriteriaChanged(cur, { priceFloor: 100 })).toBe(true); // null -> value
  expect(matchCriteriaChanged(cur, { categoryId: "625" })).toBe(true);
  expect(matchCriteriaChanged(cur, { includeAuctions: true })).toBe(true);
});

test("no-op or non-match edits do not re-seed", () => {
  expect(matchCriteriaChanged(cur, { q: "Leica M6", priceCap: 2500 })).toBe(false); // same values
  expect(matchCriteriaChanged(cur, { intervalMin: 10, enabled: false })).toBe(false); // not match fields
  expect(matchCriteriaChanged(cur, {})).toBe(false);
});

test("undefined current (boot window) treats any provided field as changed", () => {
  expect(matchCriteriaChanged(undefined, { q: "anything" })).toBe(true);
});

// mergeCalls restores the persisted daily API count on reload without letting a
// stale DB snapshot clobber the live in-memory counter.
const TODAY = "Mon Jul 06 2026";
test("fresh boot adopts the persisted count", () => {
  expect(mergeCalls({ date: TODAY, used: 0 }, TODAY, 4000)).toEqual({ date: TODAY, used: 4000 });
});
test("live refresh keeps the larger in-memory count (un-flushed increments)", () => {
  expect(mergeCalls({ date: TODAY, used: 4500 }, TODAY, 4000)).toEqual({ date: TODAY, used: 4500 });
});
test("day rollover discards the stale prior-day count", () => {
  expect(mergeCalls({ date: "Sun Jul 05 2026", used: 4999 }, TODAY, 0)).toEqual({ date: TODAY, used: 0 });
});
