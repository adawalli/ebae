"use client";

import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { MARKETPLACE_CURRENCY, type Channel, type SnoozeConfig, type StatusInfo } from "@/lib/types";
import { ago, duration, fmt, until } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent } from "@/components/ui/item";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
  refresh,
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
  refresh: () => void;
}) {
  const noCreds = status?.ebay.mode === "no-creds";
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
                  style={{ background: mock || noCreds ? "var(--eb-amber)" : "var(--eb-green)" }}
                />
                <span className="text-[19px] font-bold">
                  {noCreds ? "No keys" : mock ? "Mock mode" : status?.ebay.tokenExpiresAt ? "Valid" : "Not fetched"}
                </span>
              </div>
              <div className="mt-2 font-mono text-xs text-[var(--eb-faint)]">
                {noCreds
                  ? `polling paused · ${status?.ebay.marketplace ?? "EBAY_US"}`
                  : mock
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

        {status && (
          // Remounted when the saved creds change (a save or a remove), which re-seeds the
          // inputs from the server. A plain effect would instead clobber whatever the user is
          // typing every 10s, since status refreshes on that loop.
          <EbayCredsCard
            key={`${status.ebay.clientId}|${status.ebay.env}|${status.ebay.marketplace}`}
            status={status}
            refresh={refresh}
          />
        )}

        <NotificationsCard />

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

function EbayCredsCard({ status, refresh }: { status: StatusInfo; refresh: () => void }) {
  const [clientId, setClientId] = useState(status.ebay.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [env, setEnv] = useState(status.ebay.env);
  const [marketplace, setMarketplace] = useState(status.ebay.marketplace);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasCreds = status.ebay.mode !== "no-creds";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ebay-credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, env, marketplace }),
      });
      const data = await res.json();
      // The server validates the keys against eBay before storing them, so a 400 here is
      // eBay's own rejection - show it verbatim rather than "invalid".
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      setClientSecret("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm("Remove your eBay keys? Your searches stop polling until you add new ones.")) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ebay-credentials", { method: "DELETE" });
      if (!res.ok) {
        setError((await res.json()).error ?? `request failed (${res.status})`);
        return;
      }
      setClientSecret("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-5">
      <CardContent className="flex flex-col gap-4">
        <div>
          <div className="text-sm font-semibold">eBay credentials</div>
          <div className="mt-[3px] max-w-[440px] text-[12.5px] text-muted-foreground">
            Your own eBay developer keys, used only for your searches. They&apos;re checked against eBay before being
            saved, and each app gets its own daily call budget.
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-[280px]">
            <FieldLabel htmlFor="ebay-client-id">Client ID</FieldLabel>
            <Input
              id="ebay-client-id"
              value={clientId}
              autoComplete="off"
              onChange={(e) => setClientId(e.target.value)}
            />
          </Field>
          <Field className="w-[280px]">
            <FieldLabel htmlFor="ebay-client-secret">Client secret</FieldLabel>
            <Input
              id="ebay-client-secret"
              type="password"
              value={clientSecret}
              autoComplete="off"
              // Write-only: no API returns the secret, so an existing one can only be shown as
              // dots in the placeholder. Typing here replaces it; leaving it blank still sends
              // an empty secret, which the API rejects.
              placeholder={hasCreds ? "••••••••" : ""}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </Field>
          <Field className="w-[150px]">
            <FieldLabel htmlFor="ebay-env">Environment</FieldLabel>
            <NativeSelect id="ebay-env" className="w-full" value={env} onChange={(e) => setEnv(e.target.value)}>
              <NativeSelectOption value="production">production</NativeSelectOption>
              <NativeSelectOption value="sandbox">sandbox</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field className="w-[190px]">
            <FieldLabel htmlFor="ebay-marketplace">Marketplace</FieldLabel>
            <NativeSelect
              id="ebay-marketplace"
              className="w-full"
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value)}
            >
              {Object.entries(MARKETPLACE_CURRENCY).map(([m, ccy]) => (
                <NativeSelectOption key={m} value={m}>
                  {m} ({ccy})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {hasCreds && (
            <Button variant="outline" onClick={remove} disabled={saving}>
              Remove
            </Button>
          )}
          {error && (
            <span className="font-mono text-[12.5px] text-[var(--eb-amber)] [overflow-wrap:anywhere]">{error}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NotificationsCard() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/channels");
      if (res.ok) setChannels((await res.json()).channels);
    } catch {
      // transient fetch failure - keep showing last data, same as the status loop
    }
  }, []);

  useEffect(() => {
    // load once, not in the 10s loop: channels only change from this card
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      setChannels((c) => [...c, data.channel]);
      setWebhookUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Channel) {
    const res = await fetch(`/api/channels/${c.id}`, { method: "DELETE" });
    if (res.ok) setChannels((list) => list.filter((x) => x.id !== c.id));
  }

  return (
    <Card className="mb-5">
      <CardContent className="flex flex-col gap-4">
        <div>
          <div className="text-sm font-semibold">Notifications</div>
          <div className="mt-[3px] max-w-[440px] text-[12.5px] text-muted-foreground">
            Discord webhooks your alerts are posted to. A saved webhook only ever reads back as its tail - it&apos;s a
            credential, so the full URL never leaves the server again.
          </div>
        </div>

        {channels.length > 0 && (
          <div className="flex flex-col gap-2">
            {channels.map((c) => (
              <Item key={c.id} variant="muted" size="sm" className="items-center gap-3">
                <ItemContent className="font-mono text-xs text-muted-foreground">
                  {c.kind} · {c.webhookUrl}
                </ItemContent>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(c)}
                  title="Delete webhook"
                  aria-label="Delete webhook"
                >
                  <Trash2 />
                </Button>
              </Item>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Field className="min-w-[280px] flex-1">
            <FieldLabel htmlFor="webhook-url">Add a webhook</FieldLabel>
            <Input
              id="webhook-url"
              value={webhookUrl}
              placeholder="https://discord.com/api/webhooks/…"
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
            <FieldDescription>Discord → Channel settings → Integrations → Webhooks.</FieldDescription>
          </Field>
          <Button onClick={add} disabled={busy || !webhookUrl} className="mb-6">
            {busy ? "Adding…" : "Add"}
          </Button>
        </div>
        {error && (
          <span className="font-mono text-[12.5px] text-[var(--eb-amber)] [overflow-wrap:anywhere]">{error}</span>
        )}
      </CardContent>
    </Card>
  );
}
