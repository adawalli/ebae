"use client";

import { useCallback, useEffect, useState } from "react";
import type { Alert, SearchStats, SnoozeConfig, StatusInfo } from "@/lib/types";
import { callsFor } from "@/lib/format";
import { refreshPush } from "@/lib/push-client";
import { AppSidebar } from "@/components/app-sidebar";
import { SearchesView } from "@/components/searches-view";
import { AlertsView } from "@/components/alerts-view";
import { StatusView } from "@/components/status-view";
import { SearchFormDialog, emptyForm } from "@/components/search-form-dialog";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export default function Home() {
  const [view, setView] = useState<"searches" | "alerts" | "status">("searches");
  const [searches, setSearches] = useState<SearchStats[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsBadge, setAlertsBadge] = useState(0);
  const [alertFilter, setAlertFilter] = useState<"all" | number>("all");
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [expired, setExpired] = useState(false);
  const [snooze, setSnoozeState] = useState<SnoozeConfig | null>(null);
  const [snoozeSaving, setSnoozeSaving] = useState(false);
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [failedImg, setFailedImg] = useState<Set<number>>(new Set());
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // filter alerts server-side: a global top-N fetch can push a low-volume
    // search's alerts out of the window, hiding them from its filtered view
    const alertsUrl = alertFilter === "all" ? "/api/alerts" : `/api/alerts?searchId=${alertFilter}`;
    try {
      const [sRes, aRes, stRes] = await Promise.all([fetch("/api/searches"), fetch(alertsUrl), fetch("/api/status")]);
      // In cloudflare mode the Access cookie normally expires at the edge and the redirect
      // never reaches us, so this is the fallback for the modes where it doesn't.
      setExpired([sRes, aRes, stRes].some((r) => r.status === 401));
      if (sRes.ok) setSearches((await sRes.json()).searches);
      if (aRes.ok) {
        const list = (await aRes.json()).alerts;
        setAlerts(list);
        if (alertFilter === "all") setAlertsBadge(list.length);
      }
      if (stRes.ok) setStatus(await stRes.json());
    } catch {
      // transient fetch failure (dev reload etc.) - keep showing last data
    }
  }, [alertFilter]);

  useEffect(() => {
    // initial fetch + poll; setState only fires after the network round-trip
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
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
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = await res.json();
      if (!res.ok) {
        setSnoozeError(data.error ?? `request failed (${res.status})`);
        return;
      }
      setSnoozeState({ ...data.snooze, tz: data.snooze.tz ?? next.tz });
      refresh(); // reflect the new snooze state in the status tiles
    } catch (e) {
      setSnoozeError(e instanceof Error ? e.message : String(e));
    } finally {
      setSnoozeSaving(false);
    }
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
    try {
      const res = await fetch(editId == null ? "/api/searches" : `/api/searches/${editId}`, {
        method: editId == null ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: form.q,
          priceFloor: form.priceFloor || null,
          priceCap: form.priceCap || null,
          categoryId: form.categoryId || null,
          conditions: form.condition || null,
          excludeTerms: form.exclude || null,
          binOnly: form.bin,
          includeAuctions: form.auctions,
          intervalMin: form.interval,
        }),
      });
      if (!res.ok) {
        setFormError((await res.json()).error ?? `request failed (${res.status})`);
        return;
      }
      setShowForm(false);
      setEditId(null);
      setForm(emptyForm);
      refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // alerts is already filtered server-side (see refresh); the sidebar badge shows the loaded count
  const visibleAlerts = alerts;
  const active = searches.filter((s) => s.enabled);
  const activeMin = 1440 - (status?.snooze.dailyMinutes ?? 0);
  const projected = active.reduce((n, s) => n + callsFor(s.intervalMin, activeMin), 0);
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
          <span
            className="size-1.5 rounded-full"
            style={{
              background: running ? "var(--eb-green)" : "var(--eb-amber)",
              animation: running ? "ebPulse 2.4s ease-in-out infinite" : undefined,
            }}
            title={running ? "poller running" : "poller down"}
          />
        </header>
        {expired && (
          <div className="border-b bg-[color-mix(in_oklab,var(--eb-amber)_14%,transparent)] px-4 py-2 text-[12.5px] text-[var(--eb-amber)] md:px-[30px]">
            session expired — reload
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
              activeMin={activeMin}
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
        />
      )}
    </SidebarProvider>
  );
}
