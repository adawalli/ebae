"use client";

import type { Dispatch, SetStateAction } from "react";
import { Check } from "lucide-react";
import type { SnoozeConfig, StatusInfo } from "@/lib/types";
import { ago, duration, fmt, until } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";

export function StatusView({
  status,
  running,
  snoozed,
  mock,
  ceiling,
  snooze,
  setSnoozeState,
  snoozeSaving,
  snoozeError,
  saveSnooze,
}: {
  status: StatusInfo | null;
  running: boolean;
  snoozed: boolean;
  mock: boolean;
  ceiling: number;
  snooze: SnoozeConfig | null;
  setSnoozeState: Dispatch<SetStateAction<SnoozeConfig | null>>;
  snoozeSaving: boolean;
  snoozeError: string | null;
  saveSnooze: (next: SnoozeConfig) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-4 md:px-[30px] md:py-6">
        <h2 className="text-[21px] font-bold tracking-[-0.01em]">Status</h2>
        <div className="mt-1 text-[13px] text-muted-foreground">Poller, quota and eBay API health</div>
      </div>
      <div className="flex-1 overflow-y-visible p-4 md:overflow-y-auto md:px-[30px] md:py-6">
        <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-3.5">
          <Card>
            <CardContent className="flex flex-col">
              <div className="mb-2.5 text-[12.5px] text-muted-foreground">Poller</div>
              <div className="flex items-center gap-[9px]">
                <span
                  className="size-[9px] rounded-full"
                  style={{
                    background: running ? (snoozed ? "var(--eb-amber)" : "var(--eb-green)") : "var(--eb-amber)",
                    animation: running && !snoozed ? "ebPulse 2.4s ease-in-out infinite" : undefined,
                  }}
                />
                <span className="text-[19px] font-bold">
                  {running ? (snoozed ? "Snoozing" : "Running") : "Stopped"}
                </span>
              </div>
              <div className="mt-2 font-mono text-xs text-[var(--eb-faint)]">
                {running && status?.poller.bootedAt
                  ? `uptime ${duration(status.poller.bootedAt)} · ${status.poller.timers} timer${status.poller.timers === 1 ? "" : "s"}${status.snooze.window ? ` · ${snoozed ? "snoozing" : "snooze"} ${status.snooze.window}` : ""}`
                  : (status?.bootError ?? "not started")}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col">
              <div className="mb-2.5 text-[12.5px] text-muted-foreground">eBay Browse token</div>
              <div className="flex items-center gap-[9px]">
                <span
                  className="size-[9px] rounded-full"
                  style={{ background: mock ? "var(--eb-amber)" : "var(--eb-green)" }}
                />
                <span className="text-[19px] font-bold">
                  {mock ? "Mock mode" : status?.ebay.tokenExpiresAt ? "Valid" : "Not fetched"}
                </span>
              </div>
              <div className="mt-2 font-mono text-xs text-[var(--eb-faint)]">
                {mock
                  ? `set EBAY_CLIENT_ID to go live · ${status?.ebay.marketplace ?? "EBAY_US"}`
                  : status?.ebay.tokenExpiresAt
                    ? `refreshes in ${until(status.ebay.tokenExpiresAt)} · ${status.ebay.marketplace}`
                    : `fetched on first poll · ${status?.ebay.marketplace ?? "EBAY_US"}`}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col">
              <div className="mb-2.5 text-[12.5px] text-muted-foreground">Quota today</div>
              <div className="font-mono text-[19px] font-bold">
                {fmt(status?.quota.used ?? 0)}{" "}
                <span className="text-[14px] font-normal text-[var(--eb-faint)]">/ {fmt(ceiling)}</span>
              </div>
              <div className="mt-2 font-mono text-xs text-[var(--eb-faint)]">
                {Math.round(((status?.quota.used ?? 0) / ceiling) * 100)}% of daily budget
              </div>
            </CardContent>
          </Card>
        </div>

        {snooze && (
          <Card className="mb-5">
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Overnight snooze</div>
                  <div className="mt-[3px] max-w-[440px] text-[12.5px] text-muted-foreground">
                    Pause eBay polling during these hours to save quota while you sleep. Items listed in the window
                    still alert on the first poll after it ends.
                  </div>
                </div>
                <Switch
                  aria-label="Overnight snooze"
                  checked={snooze.enabled}
                  onCheckedChange={(checked) => setSnoozeState({ ...snooze, enabled: checked })}
                />
              </div>

              {snooze.enabled && (
                <div className="flex flex-wrap items-end gap-3">
                  <Field className="w-[130px]">
                    <FieldLabel htmlFor="snooze-from">From</FieldLabel>
                    <Input
                      id="snooze-from"
                      type="time"
                      value={snooze.start}
                      onChange={(e) => setSnoozeState({ ...snooze, start: e.target.value })}
                    />
                  </Field>
                  <Field className="w-[130px]">
                    <FieldLabel htmlFor="snooze-to">To</FieldLabel>
                    <Input
                      id="snooze-to"
                      type="time"
                      value={snooze.end}
                      onChange={(e) => setSnoozeState({ ...snooze, end: e.target.value })}
                    />
                  </Field>
                  <span className="pb-3 font-mono text-xs text-[var(--eb-faint)]">{snooze.tz ?? "server time"}</span>
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button onClick={() => saveSnooze(snooze)} disabled={snoozeSaving}>
                  {snoozeSaving ? "Saving…" : "Save"}
                </Button>
                {snoozeError && <span className="font-mono text-[12.5px] text-[var(--eb-amber)]">{snoozeError}</span>}
              </div>
            </CardContent>
          </Card>
        )}

        {status?.errors.length ? (
          <Card className="gap-0 py-0">
            <CardHeader className="border-b py-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground">Recent errors</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 py-3">
              {status.errors.map((err, i) => (
                <Item key={i} variant="muted" size="sm" className="items-baseline gap-3 font-mono text-xs">
                  <span className="whitespace-nowrap text-[var(--eb-faint)]">{ago(err.time, true)}</span>
                  {err.searchQ && <span className="whitespace-nowrap text-[var(--eb-accent-text)]">{err.searchQ}</span>}
                  <ItemContent className="text-muted-foreground [overflow-wrap:anywhere]">{err.message}</ItemContent>
                </Item>
              ))}
            </CardContent>
          </Card>
        ) : (
          <Empty className="rounded-xl bg-card ring-1 ring-foreground/10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Check className="text-[var(--eb-green)]" />
              </EmptyMedia>
              <EmptyTitle>No API errors in the last 24h</EmptyTitle>
              <EmptyDescription>
                All searches are polling on schedule. Failed calls back off exponentially and surface here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}
