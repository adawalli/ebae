import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusInfo } from "@/lib/types";
import { channelDisplay, StatusView } from "./status-view";

const disabledStatus = {
  ready: true,
  bootError: null,
  poller: { enabled: false, running: false, bootedAt: "2026-08-25T12:00:00.000Z", timers: 0 },
  ebay: {
    mode: "mock",
    clientId: null,
    env: "production",
    marketplace: "EBAY_US",
    currency: "USD",
    tokenExpiresAt: null,
  },
  quota: {
    used: 0,
    surplus: 0,
    ceiling: 5000,
    projected: 0,
    expected: 0,
    governor: { active: false, factor: 1 },
    remaining: 5000,
    configuredRemaining: 0,
    configuredForecast: 0,
    overage: 0,
    marketSamplesPerDay: 1,
  },
  snooze: { active: false, window: null, dailyMinutes: 0 },
  errors: [],
  user: { email: "local@localhost" },
  version: "dev",
} satisfies StatusInfo & { poller: StatusInfo["poller"] & { enabled: boolean } };

test("a Discord webhook displays its friendly name when set", () => {
  expect(channelDisplay({ kind: "discord", name: "Rare finds", webhookUrl: "…-token" })).toBe("Rare finds · …-token");
  expect(channelDisplay({ kind: "discord", name: null, webhookUrl: "…-token" })).toBe("discord · …-token");
});

test("the webhook form uses an aligned responsive field grid", () => {
  const html = renderToStaticMarkup(
    <StatusView
      status={null}
      running={false}
      snoozed={false}
      mock={false}
      ceiling={5000}
      snooze={null}
      setSnoozeState={() => {}}
      snoozeSaving={false}
      snoozeError={null}
      saveSnooze={() => {}}
      refresh={() => {}}
    />,
  );

  expect(html).toContain("grid gap-3 md:grid-cols-[200px_minmax(0,1fr)]");
  expect(html).not.toContain("flex flex-wrap items-end gap-3");
  expect(html).toContain("Webhook URL");
});

test("an intentionally disabled development poller is not shown as broken", () => {
  const html = renderToStaticMarkup(
    <StatusView
      status={disabledStatus}
      running={false}
      snoozed={false}
      mock
      ceiling={5000}
      snooze={null}
      setSnoozeState={() => {}}
      snoozeSaving={false}
      snoozeError={null}
      saveSnooze={() => {}}
      refresh={() => {}}
    />,
  );

  expect(html).toContain("Disabled");
  expect(html).toContain("development mode");
  expect(html).not.toContain("not started");
});

test("a guarded development identity is not shown as missing credentials", () => {
  const guardedStatus = {
    ...disabledStatus,
    poller: { ...disabledStatus.poller, enabled: true, running: true },
    ebay: { ...disabledStatus.ebay, mode: "guarded", clientId: "saved-client-id" },
  } satisfies StatusInfo;
  const html = renderToStaticMarkup(
    <StatusView
      status={guardedStatus}
      running
      snoozed={false}
      mock={false}
      ceiling={5000}
      snooze={null}
      setSnoozeState={() => {}}
      snoozeSaving={false}
      snoozeError={null}
      saveSnooze={() => {}}
      refresh={() => {}}
    />,
  );

  expect(html).toContain("Guarded");
  expect(html).toContain("real identities are not polled in development");
  expect(html).not.toContain("No keys");
});
