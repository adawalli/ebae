import { expect, test } from "bun:test";
import { channelDisplay } from "./status-view";

test("a Discord webhook displays its friendly name when set", () => {
  expect(channelDisplay({ kind: "discord", name: "Rare finds", webhookUrl: "…-token" })).toBe("Rare finds · …-token");
  expect(channelDisplay({ kind: "discord", name: null, webhookUrl: "…-token" })).toBe("discord · …-token");
});
