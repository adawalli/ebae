import { expect, test } from "bun:test";
import { splitExcludeTerms } from "./exclude-terms";

test("splitExcludeTerms trims comma and newline phrases", () => {
  expect(splitExcludeTerms(" 16gb, 256gb\nfor parts , \n ")).toEqual(["16gb", "256gb", "for parts"]);
});
