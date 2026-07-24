"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Alert, SearchStats, SnoozeConfig, StatusInfo } from "@/lib/types";
import { submitJson } from "@/lib/http";
import { refreshPush } from "@/lib/push-client";
import { AppSidebar } from "@/components/app-sidebar";
import { SearchesView } from "@/components/searches-view";
import { AlertsView } from "@/components/alerts-view";
import { StatusView } from "@/components/status-view";
import { SearchFormDialog, emptyForm } from "@/components/search-form-dialog";
import { StatusDot } from "@/components/status-dot";
import { WhatsNewDialog } from "@/components/whatsnew-dialog";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export default function Home() {
  const [view, setView] = useState<"searches" | "alerts" | "status">("searches");
  const [searches, setSearches] = useState<SearchStats[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsBadge, setAlertsBadge] = useState(0);
  const [alertFilter, setAlertFilter] = useState<"all" | number>("all");
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [expired, setExpired] = useState(false);
  // True once a background refresh fails to reach the server, so the data on screen is last-known
  // rather than current. Cleared the moment a round-trip completes. Distinct from `expired`, which
  // is a reachable-but-401 auth signal.
  const [stale, setStale] = useState(false);
  const [snooze, setSnoozeState] = useState<SnoozeConfig | null>(null);
  const [snoozeSaving, setSnoozeSaving] = useState(false);
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [failedImg, setFailedImg] = useState<Set<number>>(new Set());
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // The ETag of the alerts response currently on screen, with the URL it came from.
  // /api/alerts is the only polled route that reads the DB, so a 304 here is what lets the
  // database sleep while the app sits open. One tag, not a per-URL map, because there is one
  // `alerts` state: a tag may only be presented for the URL that filled that state. A map
  // would answer "all" with the tag from a filtered view, take the 304, and leave the filtered
  // alerts on screen under the All tab.
  const alertEtag = useRef<{ url: string; tag: string } | null>(null);

  const refresh = useCallback(async () => {
    // filter alerts server-side: a global top-N fetch can push a low-volume
    // search's alerts out of the window, hiding them from its filtered view
    const alertsUrl = alertFilter === "all" ? "/api/alerts" : `/api/alerts?searchId=${alertFilter}`;
    const held = alertEtag.current;
    const known = held?.url === alertsUrl ? held.tag : undefined;
    let reached = false; // did this round-trip reach the server at all?
    try {
      const [sRes, aRes, stRes] = await Promise.all([
        fetch("/api/searches"),
        fetch(alertsUrl, { headers: known ? { "If-None-Match": known } : undefined }),
        fetch("/api/status"),
      ]);
      reached = true;
      // In cloudflare mode the Access cookie normally expires at the edge and the redirect
      // never reaches us, so this is the fallback for the modes where it doesn't.
      setExpired([sRes, aRes, stRes].some((r) => r.status === 401));
      if (sRes.ok) setSearches((await sRes.json()).searches);
      // 304 means the list is unchanged, so it falls through here and keeps the state and the
      // tag we already hold - the same shape as any other non-ok response.
      if (aRes.ok) {
        // Null while the poller is still booting, which drops the tag: nothing to validate
        // against, so the next poll asks in full rather than presenting a validator for
        // older state.
        const tag = aRes.headers.get("ETag");
        const list = (await aRes.json()).alerts;
        // Committed here, with the body, and never up beside the header read: the tag has to
        // describe the list actually on screen. Two refreshes overlap whenever the filter
        // changes mid-poll, and headers and bodies can resolve in opposite orders, so an
        // earlier assignment could leave this ref naming one URL while `alerts` holds the
        // other's rows - then the next tick validates that tag, gets a 304, and the wrong
        // list stays up until something bumps the revision.
        alertEtag.current = tag ? { url: alertsUrl, tag } : null;
        setAlerts(list);
        if (alertFilter === "all") setAlertsBadge(list.length);
      }
      if (stRes.ok) setStatus(await stRes.json());
    } catch {
      // couldn't reach the server (offline, dev reload, pod restart): keep showing the last data,
      // and `reached` stays false so the banner below flags it as stale.
    }
    // One derived write, after the round-trip: stale iff the server was unreachable this round.
    // The next successful refresh clears it. Kept as a single computed value (not a happy-path
    // setStale(false)) so it reads as syncing external state, not an unconditional reset.
    setStale(!reached);
  }, [alertFilter]);

  useEffect(() => {
    // initial fetch + poll; setState only fires after the network round-trip
    void refresh();
    // A hidden tab polls nothing. Browsers only throttle a background timer to ~1/minute,
    // which is still frequent enough to hold a serverless Postgres awake forever, so a tab
    // left open on another desktop would quietly bill the DB around the clock.
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    // Coming back has to be instant rather than up to 10s stale, and this fires on tab focus,
    // window switch, and phone unlock alike.
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    // Re-assert this device's push subscription on every app load. It lives here rather
    // than in the Notifications card because that card only mounts on the Status tab,
    // and someone who just checks their alerts would never run it - meanwhile iOS expires
    // endpoints after a week or two, silently, with no event to listen for.
    void refreshPush();
  }, []);

  useEffect(() => {
    // snooze config: load once, not in the 10s loop (the form binds to this state,
    // so re-fetching would clobber in-progress edits). Default tz to the browser's.
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const tz = d.snooze.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        setSnoozeState({ ...d.snooze, tz });
      })
      .catch(() => {});
  }, []);

  async function saveSnooze(next: SnoozeConfig) {
    setSnoozeSaving(true);
    setSnoozeError(null);
    const r = await submitJson<{ snooze: SnoozeConfig }>("/api/settings", { method: "PUT", body: next });
    if (!r.ok) setSnoozeError(r.error);
    else {
      setSnoozeState({ ...r.data.snooze, tz: r.data.snooze.tz ?? next.tz });
      refresh(); // reflect the new snooze state in the status tiles
    }
    setSnoozeSaving(false);
  }

  async function togglePause(s: SearchStats) {
    await fetch(`/api/searches/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    refresh();
  }

  async function removeSearch(s: SearchStats) {
    if (!confirm(`Delete saved search "${s.q}"?`)) return;
    await fetch(`/api/searches/${s.id}`, { method: "DELETE" });
    if (alertFilter === s.id) setAlertFilter("all"); // its option is gone; don't strand the filter
    refresh();
  }

  async function clearAlerts() {
    const scope =
      alertFilter === "all"
        ? "all alerts"
        : `alerts for "${searches.find((s) => s.id === alertFilter)?.q ?? "this search"}"`;
    // clears the display log only — won't re-alert on those listings (seen_items is kept)
    if (!confirm(`Clear ${scope}? This only clears the history shown here.`)) return;
    const url = alertFilter === "all" ? "/api/alerts" : `/api/alerts?searchId=${alertFilter}`;
    await fetch(url, { method: "DELETE" });
    refresh();
  }

  function openCreate() {
    setEditId(null);
    setForm(emptyForm);
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(s: SearchStats) {
    setEditId(s.id);
    setForm({
      q: s.q,
      priceFloor: s.priceFloor == null ? "" : String(s.priceFloor),
      priceCap: s.priceCap == null ? "" : String(s.priceCap),
      categoryId: s.categoryId ?? "",
      condition: s.conditions ?? "",
      exclude: s.excludeTerms ?? "",
      bin: s.binOnly,
      auctions: s.includeAuctions,
      trackSold: s.trackSold,
      interval: s.intervalMin,
    });
    setFormError(null);
    setShowForm(true);
  }

  // POST for new searches, PATCH for edits — same body either way (validate.ts
  // accepts a full object on PATCH; changing match criteria re-seeds server-side)
  async function submitSearch() {
    setSaving(true);
    setFormError(null);
    const r = await submitJson(editId == null ? "/api/searches" : `/api/searches/${editId}`, {
      method: editId == null ? "POST" : "PATCH",
      body: {
        q: form.q,
        priceFloor: form.priceFloor || null,
        priceCap: form.priceCap || null,
        categoryId: form.categoryId || null,
        conditions: form.condition || null,
        excludeTerms: form.exclude || null,
        binOnly: form.bin,
        includeAuctions: form.auctions,
        trackSold: form.trackSold,
        intervalMin: form.interval,
      },
    });
    if (!r.ok) setFormError(r.error);
    else {
      setShowForm(false);
      setEditId(null);
      setForm(emptyForm);
      refresh();
    }
    setSaving(false);
  }

  // alerts is already filtered server-side (see refresh); the sidebar badge shows the loaded count
  const visibleAlerts = alerts;
  const active = searches.filter((s) => s.enabled);
  const activeMin = 1440 - (status?.snooze.dailyMinutes ?? 0);
  // Server-side (see projectedCalls): the browser's own sum of intervals didn't know about
  // per-search market samples, so it read low against the counter the poller actually enforces.
  // Falls back to summing the rows' own server-computed figures rather than to zero, so a failed
  // status poll degrades to the same number by a different route instead of painting an empty
  // quota bar for a fleet that may be sitting at the ceiling.
  const projected = status?.quota.projected ?? active.reduce((n, s) => n + s.callsPerDay, 0);
  const ceiling = status?.quota.ceiling ?? 5000;
  const quotaPct = Math.min(100, Math.round((projected / ceiling) * 100));
  const running = status?.poller.running ?? false;
  const snoozed = status?.snooze.active ?? false;
  const mock = status?.ebay.mode === "mock";
  const noCreds = status?.ebay.mode === "no-creds";

  const navItems = [
    { key: "searches" as const, label: "Searches", badge: null },
    { key: "alerts" as const, label: "Alerts", badge: alertsBadge || null },
    { key: "status" as const, label: "Status & Settings", badge: status?.errors.length || null },
  ];

  return (
    <SidebarProvider className="md:h-svh">
      <AppSidebar view={view} setView={setView} navItems={navItems} running={running} status={status} />
      <SidebarInset className="min-h-0">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger className="-ml-1" />
          <span className="text-[15px] font-bold tracking-tight">ebae</span>
          <StatusDot active={running} title={running ? "poller running" : "poller down"} />
        </header>
        {expired && (
          <div className="border-b bg-[color-mix(in_oklab,var(--eb-amber)_14%,transparent)] px-4 py-2 text-[12.5px] text-[var(--eb-amber)] md:px-[30px]">
            session expired — reload
          </div>
        )}
        {stale && !expired && (
          <div className="border-b bg-[color-mix(in_oklab,var(--eb-amber)_14%,transparent)] px-4 py-2 text-[12.5px] text-[var(--eb-amber)] md:px-[30px]">
            connection lost — showing the last update, retrying…
          </div>
        )}
        {noCreds && view !== "status" && (
          <button
            onClick={() => setView("status")}
            className="border-b bg-[color-mix(in_oklab,var(--eb-amber)_14%,transparent)] px-4 py-2 text-left text-[12.5px] text-[var(--eb-amber)] hover:underline md:px-[30px]"
          >
            polling paused — add your eBay keys
          </button>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {view === "searches" && (
            <SearchesView
              searches={searches}
              active={active}
              projected={projected}
              ceiling={ceiling}
              quotaPct={quotaPct}
              running={running}
              mock={mock}
              noCreds={noCreds}
              status={status}
              openCreate={openCreate}
              openEdit={openEdit}
              togglePause={togglePause}
              removeSearch={removeSearch}
            />
          )}
          {view === "alerts" && (
            <AlertsView
              visibleAlerts={visibleAlerts}
              searches={searches}
              alertFilter={alertFilter}
              setAlertFilter={setAlertFilter}
              failedImg={failedImg}
              setFailedImg={setFailedImg}
              clearAlerts={clearAlerts}
            />
          )}
          {view === "status" && (
            <StatusView
              status={status}
              running={running}
              snoozed={snoozed}
              mock={mock}
              ceiling={ceiling}
              snooze={snooze}
              setSnoozeState={setSnoozeState}
              snoozeSaving={snoozeSaving}
              snoozeError={snoozeError}
              saveSnooze={saveSnooze}
              refresh={refresh}
            />
          )}
        </div>
      </SidebarInset>

      {showForm && (
        <SearchFormDialog
          showForm={showForm}
          setShowForm={setShowForm}
          form={form}
          setForm={setForm}
          editId={editId}
          saving={saving}
          formError={formError}
          submitSearch={submitSearch}
          activeMin={activeMin}
          marketSamples={status?.quota.marketSamplesPerDay ?? 1}
          pendingChecks={editId == null ? 0 : (searches.find((s) => s.id === editId)?.checksDue24h ?? 0)}
        />
      )}

      {status && <WhatsNewDialog version={status.version} />}
    </SidebarProvider>
  );
}
