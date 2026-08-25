import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

test("development commands force NODE_ENV=development", () => {
  expect(pkg.scripts.dev).toStartWith("NODE_ENV=development ");
  expect(pkg.scripts["dev:poller"]).toStartWith("NODE_ENV=development ");
});
