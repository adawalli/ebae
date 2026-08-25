import { expect, test } from "bun:test";
import { discordOptions } from "./search-form-dialog";

test("the search editor offers all webhooks and each named destination", () => {
  expect(discordOptions([{ id: 7, name: "Rare finds", webhookUrl: "…-token" }])).toEqual([
    { value: "", label: "All Discord webhooks" },
    { value: "7", label: "Rare finds · …-token" },
  ]);
});
