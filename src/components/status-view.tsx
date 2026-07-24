"use client";

import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { MARKETPLACE_CURRENCY, type Channel, type SnoozeConfig, type StatusInfo } from "@/lib/types";
import { ago, duration, fmt, shownSurplus, until } from "@/lib/format";
import { submitJson } from "@/lib/http";
import { currentSubscription, disablePush, enablePush, pushSupported } from "@/lib/push-client";
import { LS_DISABLED, LS_LAST_SEEN, WHATSNEW_EVENT, parseSemver, read, store } from "@/lib/whatsnew";
import { StatusDot } from "@/components/status-dot";
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
  const surplus = shownSurplus(status?.quota.surplus ?? 0, ceiling);
  const configured = (status?.quota.used ?? 0) - surplus; // what the saved searches themselves spent
  const expected = status?.quota.expected ?? 0;
  const overage = status?.quota.overage ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-4 md:px-[30px] md:py-6">
        <h2 className="text-[21px] font-bold tracking-[-0.01em]">Status &amp; Settings</h2>
        <div className="mt-1 text-[13px] text-muted-foreground">Poller health, eBay keys and notifications</div>
      </div>
      <div className="flex-1 overflow-y-visible p-4 md:overflow-y-auto md:px-[30px] md:py-6">
        <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-3.5">
          <Card>
            <CardContent className="flex flex-col">
              <div className="mb-2.5 text-[12.5px] text-muted-foreground">Poller</div>
              <div className="flex items-center gap-[9px]">
                <StatusDot active={running && !snoozed} size="md" />
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
              {/* Against "expected" rather than only the ceiling: 90% spent is fine at 23:00 and
                  alarming at 09:00, and the raw percentage can't tell those apart. Surplus checks
                  are subtracted first - they spend quota that expires tonight either way, so
                  billing them to the pace would flag a configuration that is behaving. */}
              <div className="mt-2 font-mono text-xs text-[var(--eb-faint)]">
                {fmt(configured)} configured · {fmt(expected)} expected by now ·{" "}
                {configured <= expected ? (
                  <span className="text-[var(--eb-green)]">on pace</span>
                ) : (
                  // Amber only when the day is actually forecast to overrun. A gap on its own
                  // means little: `expected` projects the configuration as it stands now, while
                  // `configured` is everything already billed, so the two drift apart for reasons
                  // that are not overspending - polls bill up front, a sold check that has been
                  // spent leaves the projection but never the counter, and pausing a search
                  // rebases the projection under a day of history. Colouring every such gap would
                  // alarm users whose budget lands fine, which is the same flapping the governor
                  // holds GOV_MIN_SPEND and a release buffer to avoid.
                  <span className={overage > 0 ? "text-[var(--eb-amber)]" : undefined}>
                    {fmt(configured - expected)} ahead of pace
                  </span>
                )}
              </div>
              {surplus > 0 && (
                <div className="mt-1.5 font-mono text-xs text-[var(--eb-faint)]">
                  +{fmt(surplus)} surplus sold checks · quota that would expire tonight
                </div>
              )}
              {status?.quota.governor.active && (
                <div className="mt-1.5 text-xs text-[var(--eb-amber)]">
                  Governor active ·{" "}
                  {status.quota.overage
                    ? `${fmt(status.quota.overage)} calls over today’s budget`
                    : "holding a 5% release buffer"}{" "}
                  · polling at {status.quota.governor.factor.toFixed(1)}× your intervals
                </div>
              )}
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

        {status && <ReleaseNotesCard version={status.version} />}

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

function ReleaseNotesCard({ version }: { version: string }) {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    // localStorage is client-only, so seed after mount instead of during render. The
    // event covers the release-notes dialog closing over this card with "don't show" ticked.
    const sync = () => setEnabled(read(LS_DISABLED) !== "1");
    sync();
    window.addEventListener(WHATSNEW_EVENT, sync);
    return () => window.removeEventListener(WHATSNEW_EVENT, sync);
  }, []);

  function toggle(next: boolean) {
    setEnabled(next);
    // Both readers test for "1", so clearing the flag is just another guarded write.
    if (next) {
      store(LS_DISABLED, "0");
      return;
    }
    store(LS_DISABLED, "1");
    // Don't bank a backlog while they're off - turning them back on shouldn't replay old releases.
    if (parseSemver(version)) store(LS_LAST_SEEN, version);
  }

  return (
    <Card className="mb-5">
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Release notes</div>
            <div className="mt-[3px] max-w-[440px] text-[12.5px] text-muted-foreground">
              Show what changed the first time you open ebae after an upgrade. Notes are read from the GitHub releases
              feed in your browser.
            </div>
          </div>
          <Switch aria-label="Release notes" checked={enabled} onCheckedChange={toggle} />
        </div>
      </CardContent>
    </Card>
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
    // The server validates the keys against eBay before storing them, so a 400 here is
    // eBay's own rejection - submitJson surfaces it verbatim rather than "invalid".
    const r = await submitJson("/api/ebay-credentials", {
      method: "PUT",
      body: { clientId, clientSecret, env, marketplace },
    });
    if (!r.ok) setError(r.error);
    else {
      setClientSecret("");
      refresh();
    }
    setSaving(false);
  }

  async function remove() {
    if (!confirm("Remove your eBay keys? Your searches stop polling until you add new ones.")) return;
    setSaving(true);
    setError(null);
    const r = await submitJson("/api/ebay-credentials", { method: "DELETE" });
    if (!r.ok) setError(r.error);
    else {
      setClientSecret("");
      refresh();
    }
    setSaving(false);
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

// This device's push state. Rendered only where push can actually work: an insecure
// origin or a browser without PushManager gets nothing rather than a button that can't
// succeed. On iOS that also means it appears only once the app is on the Home Screen,
// since Safari tabs don't expose PushManager at all.
function PushSection() {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Both flags are set from the async continuation so the toggle appears once, already
    // showing its real state, instead of rendering as off and then correcting itself.
    if (!pushSupported()) return;
    currentSubscription()
      .then((s) => {
        setSupported(true);
        setOn(!!s);
      })
      .catch(() => setSupported(true));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (next) {
        const err = await enablePush();
        if (err) setError(err);
        else setOn(true);
      } else {
        await disablePush();
        setOn(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-t pt-4">
      <div>
        <div className="text-[13px] font-medium">Push to this device</div>
        <div className="mt-[3px] max-w-[440px] text-[12.5px] text-muted-foreground">
          Alerts as system notifications, no Discord needed. Per device - turn it on wherever you want them.
        </div>
        {error && (
          <span className="mt-1 block font-mono text-[12.5px] text-[var(--eb-amber)] [overflow-wrap:anywhere]">
            {error}
          </span>
        )}
      </div>
      <Switch checked={on} disabled={busy} onCheckedChange={toggle} aria-label="Push to this device" />
    </div>
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
    const r = await submitJson<{ channel: Channel }>("/api/channels", { method: "POST", body: { webhookUrl } });
    if (!r.ok) setError(r.error);
    else {
      setChannels((c) => [...c, r.data.channel]);
      setWebhookUrl("");
    }
    setBusy(false);
  }

  async function remove(c: Channel) {
    setError(null);
    const r = await submitJson(`/api/channels/${c.id}`, { method: "DELETE" });
    if (r.ok) setChannels((list) => list.filter((x) => x.id !== c.id));
    else setError(r.error);
  }

  return (
    <Card className="mb-5">
      <CardContent className="flex flex-col gap-4">
        <div>
          <div className="text-sm font-semibold">Notifications</div>
          <div className="mt-[3px] max-w-[440px] text-[12.5px] text-muted-foreground">
            Where your alerts go. A saved webhook only ever reads back as its tail - it&apos;s a credential, so the full
            URL never leaves the server again.
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

        <PushSection />
      </CardContent>
    </Card>
  );
}
