import { expect, test } from "bun:test";
import { ESLint } from "eslint";

test("Next lint config preserves legacy React and accessibility rules", async () => {
  const [result] = await new ESLint().lintText(
    'import React from "react"; export default React.memo(() => <img src="/test.png" />);',
    { filePath: "src/app/lint-regression.tsx" },
  );
  const rules = result.messages.map((message) => message.ruleId);
  expect(rules).toContain("react/display-name");
  expect(rules).toContain("jsx-a11y/alt-text");
});
