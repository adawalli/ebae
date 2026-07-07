import { expect, test } from "bun:test";
import { inWindow, matchCriteriaChanged, mergeCalls } from "./poller";
import { hhmmToMin, parseSnoozeBody } from "./validate";

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

// Snooze window membership. Guards the quota saver: an off-by-one boundary or a
// broken midnight-crossing check silently changes when the eBay API gets hit.
test("inWindow: start inclusive, end exclusive", () => {
  expect(inWindow(60, 420, 60)).toBe(true); // 01:00 - in
  expect(inWindow(60, 420, 419)).toBe(true); // 06:59 - in
  expect(inWindow(60, 420, 420)).toBe(false); // 07:00 - out
  expect(inWindow(60, 420, 59)).toBe(false); // 00:59 - out
});
test("inWindow: window crossing midnight", () => {
  expect(inWindow(1320, 360, 1350)).toBe(true); // 22:00-06:00 @ 22:30
  expect(inWindow(1320, 360, 30)).toBe(true); // @ 00:30
  expect(inWindow(1320, 360, 359)).toBe(true); // @ 05:59
  expect(inWindow(1320, 360, 360)).toBe(false); // @ 06:00
  expect(inWindow(1320, 360, 720)).toBe(false); // @ 12:00
});

// Snooze settings validation (the API trust boundary): HH:MM parsing, tz check,
// and the empty-window guard that would otherwise mean "snooze all day".
test("hhmmToMin parses valid times and rejects junk", () => {
  expect(hhmmToMin("01:00")).toBe(60);
  expect(hhmmToMin("22:30")).toBe(1350);
  expect(hhmmToMin("00:00")).toBe(0);
  expect(hhmmToMin("24:00")).toBeNull();
  expect(hhmmToMin("7:5")).toBeNull();
  expect(hhmmToMin(90)).toBeNull();
});
test("parseSnoozeBody: valid config returns minutes", () => {
  expect(parseSnoozeBody({ enabled: true, start: "01:00", end: "07:00", tz: "America/New_York" })).toEqual({
    enabled: true,
    start: 60,
    end: 420,
    tz: "America/New_York",
  });
  // blank/absent tz -> null (server timezone)
  expect(parseSnoozeBody({ enabled: false, start: "22:00", end: "06:00", tz: "" })).toEqual({
    enabled: false,
    start: 1320,
    end: 360,
    tz: null,
  });
});
test("parseSnoozeBody: rejects bad times, equal window, bad tz", () => {
  expect(typeof parseSnoozeBody({ start: "nope", end: "07:00" })).toBe("string");
  expect(typeof parseSnoozeBody({ start: "07:00", end: "07:00" })).toBe("string"); // empty window
  expect(typeof parseSnoozeBody({ start: "01:00", end: "07:00", tz: "Mars/Phobos" })).toBe("string");
});
