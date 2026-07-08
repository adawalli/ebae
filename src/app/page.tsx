"use client";

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Check, ExternalLink, Inbox, Moon, Pencil, Plus, Search, Sun, Trash2 } from "lucide-react";
import type { Alert, SearchStats, SnoozeConfig, StatusInfo } from "@/lib/types";
import { ebayWebUrl } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemContent } from "@/components/ui/item";
import { NativeSelect } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

const MONO = "var(--font-mono), ui-monospace, monospace";
const fmt = (n: number) => n.toLocaleString("en-US");
// Projected polls/day. Snooze silences a daily window, so poll over active
// minutes (1440 minus the snoozed span), not the whole day.
const callsFor = (interval: number, activeMin = 1440) => Math.round(activeMin / interval);

function money(n: number | null, currency = "USD") {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

function ago(iso: string, compact = false) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return compact ? `${m}m ago` : `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return compact ? `${h}h ago` : `${h} hr ago`;
  const d = Math.floor(h / 24);
  return compact ? `${d}d ago` : `${d} day${d > 1 ? "s" : ""} ago`;
}

function duration(fromIso: string) {
  const s = Math.max(0, (Date.now() - new Date(fromIso).getTime()) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function until(iso: string) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return "now";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
}

const emptyForm = { q: "", priceFloor: "", priceCap: "", categoryId: "", bin: true, auctions: false, interval: 2 };

type NavItem = { key: "searches" | "alerts" | "status"; label: string; badge: number | null };

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // one-shot post-hydration flag so the icon reflects the resolved theme without a mismatch
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  const isDark = resolvedTheme === "dark";
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full justify-start gap-2"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {mounted ? isDark ? <Sun className="size-4" /> : <Moon className="size-4" /> : <span className="size-4" />}
      {mounted ? (isDark ? "Light mode" : "Dark mode") : "Theme"}
    </Button>
  );
}

function AppSidebar({
  view,
  setView,
  navItems,
  running,
  status,
}: {
  view: "searches" | "alerts" | "status";
  setView: (v: "searches" | "alerts" | "status") => void;
  navItems: NavItem[];
  running: boolean;
  status: StatusInfo | null;
}) {
  const { setOpenMobile, isMobile } = useSidebar();
  const pick = (k: NavItem["key"]) => {
    setView(k);
    if (isMobile) setOpenMobile(false);
  };
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-1 py-1.5">
          <div
            className="flex size-7 items-center justify-center rounded-lg bg-primary text-[15px] font-semibold text-white"
            style={{ fontFamily: MONO }}
          >
            e
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-[17px] font-bold tracking-tight">ebae</span>
            <span className="mt-1 text-[11px] text-muted-foreground">eBay, before anyone else</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="font-mono tracking-[0.14em] uppercase">Monitor</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((n) => (
                <SidebarMenuItem key={n.key}>
                  <SidebarMenuButton isActive={view === n.key} onClick={() => pick(n.key)}>
                    <span>{n.label}</span>
                  </SidebarMenuButton>
                  {n.badge != null && <SidebarMenuBadge>{n.badge}</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-3">
        <ThemeToggle />
        <div className="flex items-center gap-2 px-1 font-mono text-[10.5px] text-muted-foreground">
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{
              background: running ? "var(--eb-green)" : "var(--eb-amber)",
              animation: running ? "ebPulse 2.4s ease-in-out infinite" : undefined,
            }}
          />
          {running && status?.poller.bootedAt
            ? `poller up ${duration(status.poller.bootedAt)} · v${status.version}`
            : `poller down${status ? ` · v${status.version}` : ""}`}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export default function Home() {
  const [view, setView] = useState<"searches" | "alerts" | "status">("searches");
  const [searches, setSearches] = useState<SearchStats[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsBadge, setAlertsBadge] = useState(0);
  const [alertFilter, setAlertFilter] = useState<"all" | number>("all");
  const [status, setStatus] = useState<StatusInfo | null>(null);
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

  const navItems = [
    { key: "searches" as const, label: "Searches", badge: null },
    { key: "alerts" as const, label: "Alerts", badge: alertsBadge || null },
    { key: "status" as const, label: "Status", badge: status?.errors.length || null },
  ];

  function searchSub(s: SearchStats) {
    if (!s.enabled) return "paused";
    if (!s.seeded) return "seeding baseline — first matches silenced";
    const hit = s.lastHitAt ? `last hit ${ago(s.lastHitAt, true)}` : "no hits yet";
    return `${hit} · seen ${fmt(s.seenCount)}`;
  }

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
        <div className="flex min-h-0 flex-1 flex-col">
          {/* ---------- SEARCHES VIEW ---------- */}
          {view === "searches" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex flex-col items-stretch justify-between gap-3.5 border-b p-4 md:flex-row md:items-center md:gap-0 md:px-[30px] md:py-6">
                <div>
                  <h2 className="text-[21px] font-bold tracking-[-0.01em]">Saved searches</h2>
                  <div className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground">
                    <span
                      className="size-1.5 rounded-full"
                      style={{
                        background: running ? "var(--eb-green)" : "var(--eb-amber)",
                        animation: running ? "ebPulse 2.4s ease-in-out infinite" : undefined,
                      }}
                    />
                    {searches.length} searches · {active.length} active ·{" "}
                    {running ? (mock ? "polling (mock mode)" : "polling live") : "poller down"}
                  </div>
                </div>
                <Button onClick={openCreate} className="justify-center md:justify-start">
                  <Plus /> New search
                </Button>
              </div>

              {/* quota strip */}
              <Card className="mx-4 mt-4 mb-1.5 md:mx-[30px] md:mt-5">
                <CardContent>
                  <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-1.5">
                    <span className="text-[13px] text-muted-foreground">
                      Projected API usage <span className="text-[var(--eb-faint)]">· enforced global budget</span>
                    </span>
                    <span className="font-mono text-[13px] text-foreground">
                      <b className="text-[var(--eb-accent-text)]">{fmt(projected)}</b> / {fmt(ceiling)} calls·day{" "}
                      <span className="text-[var(--eb-faint)]">· {quotaPct}%</span>
                    </span>
                  </div>
                  <Progress value={quotaPct} className="h-2" />
                </CardContent>
              </Card>

              {/* table */}
              <div className="flex-1 overflow-visible px-4 pt-3.5 pb-5 md:overflow-y-auto md:px-[30px] md:pb-[26px]">
                <div className="hidden px-3.5 pb-2.5 font-mono text-[10.5px] tracking-[.1em] text-[var(--eb-faint)] uppercase md:grid md:grid-cols-[18px_minmax(0,1fr)_150px_62px_76px_40px_132px] md:items-center md:gap-2">
                  <span />
                  <span>Search</span>
                  <span>Filters</span>
                  <span className="text-right">Every</span>
                  <span className="text-right">Calls·day</span>
                  <span className="text-right">24h</span>
                  <span />
                </div>
                <div className="flex flex-col gap-2">
                  {searches.length === 0 && (
                    <Empty className="border">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Search />
                        </EmptyMedia>
                        <EmptyTitle>No saved searches yet</EmptyTitle>
                        <EmptyDescription>Create one and ebae starts watching within seconds.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                  {searches.map((s) => {
                    const seeding = s.enabled && !s.seeded;
                    return (
                      <Card key={s.id} className="gap-0 py-0" style={{ opacity: s.enabled ? 1 : 0.62 }}>
                        <CardContent className="flex flex-col gap-2.5 p-3.5 md:grid md:grid-cols-[18px_minmax(0,1fr)_150px_62px_76px_40px_132px] md:items-center md:gap-2">
                          <div className="flex min-w-0 items-center gap-2.5 md:contents">
                            <span
                              className="size-2 shrink-0 md:justify-self-start"
                              style={{
                                borderRadius: s.enabled ? "50%" : 2,
                                background: s.enabled ? "var(--eb-green)" : "var(--eb-faint)",
                                boxShadow: s.enabled
                                  ? "0 0 0 3px color-mix(in oklab, var(--eb-green) 18%, transparent)"
                                  : "none",
                                animation:
                                  s.enabled && s.intervalMin <= 2 ? "ebPulse 2.4s ease-in-out infinite" : undefined,
                              }}
                            />
                            <div className="min-w-0">
                              <a
                                href={ebayWebUrl(s, status?.ebay.marketplace)}
                                target="_blank"
                                rel="noreferrer"
                                title="View live matches on eBay"
                                className="hv-link group flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-foreground no-underline md:text-[14.5px]"
                              >
                                <span className="truncate">{s.q}</span>
                                <ExternalLink className="size-3.5 shrink-0 text-[var(--eb-faint)] transition-colors group-hover:text-[var(--eb-accent-text)]" />
                              </a>
                              <div className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--eb-faint)]">
                                {searchSub(s)}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 empty:hidden md:empty:flex">
                            {s.binOnly && (
                              <Badge className="border-transparent bg-[var(--eb-accent-soft)] font-mono text-[var(--eb-accent-text)]">
                                BIN
                              </Badge>
                            )}
                            {s.priceFloor != null && (
                              <Badge variant="secondary" className="font-mono">
                                ≥ {money(s.priceFloor).replace(/\.00$/, "")}
                              </Badge>
                            )}
                            {s.priceCap != null && (
                              <Badge variant="secondary" className="font-mono">
                                ≤ {money(s.priceCap).replace(/\.00$/, "")}
                              </Badge>
                            )}
                            {s.includeAuctions && (
                              <Badge variant="secondary" className="font-mono">
                                Auctions ok
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs md:contents">
                            <span
                              className="md:text-right md:text-[13px]"
                              style={{
                                color: s.enabled
                                  ? s.intervalMin <= 1
                                    ? "var(--eb-amber)"
                                    : "var(--eb-text)"
                                  : "var(--eb-faint)",
                              }}
                            >
                              <span className="md:hidden">every </span>
                              {s.intervalMin}
                              <span className="md:hidden">m</span>
                              <span className="hidden md:inline"> min</span>
                            </span>
                            <span className="text-muted-foreground md:text-right md:text-[13px]">
                              {s.enabled ? (
                                <>
                                  {fmt(callsFor(s.intervalMin, activeMin))}
                                  <span className="md:hidden"> calls·day</span>
                                </>
                              ) : (
                                <>
                                  <span className="md:hidden">paused</span>
                                  <span className="hidden md:inline">—</span>
                                </>
                              )}
                            </span>
                            <span className="md:text-right md:text-[13px]">
                              {seeding ? (
                                <Badge className="border-transparent bg-[color-mix(in_oklab,var(--eb-amber)_18%,transparent)] font-mono text-[var(--eb-amber)]">
                                  seed
                                </Badge>
                              ) : (
                                <>
                                  <span
                                    style={{
                                      color: s.hits24 > 0 ? "var(--eb-accent-text)" : "var(--eb-faint)",
                                      fontWeight: s.hits24 > 0 ? 600 : 400,
                                    }}
                                  >
                                    {s.hits24}
                                  </span>
                                  <span className="text-muted-foreground md:hidden"> in 24h</span>
                                </>
                              )}
                            </span>
                          </div>
                          <div className="flex gap-1.5 md:justify-self-end">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => openEdit(s)}
                              title="Edit search"
                              aria-label="Edit search"
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="flex-1 md:flex-none"
                              onClick={() => togglePause(s)}
                            >
                              {s.enabled ? "Pause" : "Resume"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => removeSearch(s)}
                              title="Delete search"
                              aria-label="Delete search"
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ---------- ALERTS VIEW ---------- */}
          {view === "alerts" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 md:gap-2.5 md:px-[30px] md:py-6">
                <div>
                  <h2 className="text-[21px] font-bold tracking-[-0.01em]">Alert history</h2>
                  <div className="mt-1 text-[13px] text-muted-foreground">
                    {visibleAlerts.length} item{visibleAlerts.length === 1 ? "" : "s"} matched · newest first
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  {visibleAlerts.length > 0 && (
                    <Button variant="outline" size="sm" onClick={clearAlerts}>
                      {alertFilter === "all" ? "Clear all" : "Clear"}
                    </Button>
                  )}
                  <NativeSelect
                    aria-label="Filter alerts by search"
                    className="font-mono"
                    value={String(alertFilter)}
                    onChange={(e) => setAlertFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
                  >
                    <option value="all">All searches</option>
                    {searches.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.q}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div className="flex-1 overflow-visible p-4 pb-5 md:overflow-y-auto md:px-[30px] md:pt-[18px] md:pb-7">
                {visibleAlerts.length === 0 ? (
                  <Empty className="border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Inbox />
                      </EmptyMedia>
                      <EmptyTitle>No alerts yet</EmptyTitle>
                      <EmptyDescription>New listings show up here the moment the poller finds them.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {visibleAlerts.map((a, i) => {
                      const day = dayLabel(a.createdAt);
                      const header = i === 0 || dayLabel(visibleAlerts[i - 1].createdAt) !== day;
                      return (
                        <div key={a.id}>
                          {header && (
                            <div className="px-0.5 pt-2 pb-3 font-mono text-[10.5px] tracking-[.12em] uppercase text-[var(--eb-faint)]">
                              {day}
                            </div>
                          )}
                          <Card className="px-[13px] py-3 md:px-4 md:py-[14px]">
                            <div className="flex gap-3 md:gap-[15px]">
                              {a.imageUrl && !failedImg.has(a.id) ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={a.imageUrl}
                                  alt=""
                                  loading="lazy"
                                  // match how Discord fetches (no referer) — eBay's CDN can
                                  // 403 a hotlink referer; on any load failure fall back to
                                  // the placeholder below instead of the broken-image glyph
                                  referrerPolicy="no-referrer"
                                  onError={() => setFailedImg((prev) => new Set(prev).add(a.id))}
                                  className="size-14 flex-none rounded-[10px] border object-cover md:size-[66px]"
                                />
                              ) : (
                                <div
                                  className="flex size-14 flex-none items-center justify-center rounded-[10px] border md:size-[66px]"
                                  style={{
                                    background:
                                      "repeating-linear-gradient(45deg,var(--eb-chip-bg) 0 5px,transparent 5px 10px),var(--eb-panel2)",
                                  }}
                                >
                                  <span className="font-mono text-[8px] text-[var(--eb-faint)]">photo</span>
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-3">
                                  <a
                                    className="hv-link text-[14.5px] leading-[1.35] font-semibold text-foreground no-underline"
                                    href={a.itemUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {a.title}
                                  </a>
                                  <span className="mt-0.5 flex-none font-mono text-[11.5px] whitespace-nowrap text-[var(--eb-faint)]">
                                    {ago(a.createdAt)}
                                  </span>
                                </div>
                                <div className="mt-[9px] flex flex-wrap items-center gap-[9px]">
                                  <span className="font-mono text-[15px] font-semibold text-foreground">
                                    {money(a.price, a.currency)}
                                  </span>
                                  <span className="text-xs text-[var(--eb-faint)]">
                                    {a.shippingCost == null
                                      ? ""
                                      : a.shippingCost === 0
                                        ? "Free ship"
                                        : `+ ${money(a.shippingCost, a.currency)} ship`}
                                  </span>
                                  <Badge
                                    className={
                                      a.buyingOption === "FIXED_PRICE"
                                        ? "border-transparent bg-[var(--eb-accent-soft)] font-mono text-[var(--eb-accent-text)]"
                                        : "border-transparent bg-[color-mix(in_oklab,var(--eb-amber)_18%,transparent)] font-mono text-[var(--eb-amber)]"
                                    }
                                  >
                                    {a.buyingOption === "FIXED_PRICE" ? "Buy It Now" : "Auction"}
                                  </Badge>
                                  {a.condition && (
                                    <Badge variant="secondary" className="font-mono">
                                      {a.condition}
                                    </Badge>
                                  )}
                                </div>
                                <div className="mt-[11px] flex items-center gap-[7px] border-t pt-[11px] text-xs text-muted-foreground">
                                  <span className="size-1.5 rounded-full bg-[var(--eb-accent)]" />
                                  matched <b className="font-semibold text-foreground">{a.searchQ}</b>
                                </div>
                              </div>
                            </div>
                          </Card>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ---------- STATUS VIEW ---------- */}
          {view === "status" && (
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
                            Pause eBay polling during these hours to save quota while you sleep. Items listed in the
                            window still alert on the first poll after it ends.
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
                          <span className="pb-3 font-mono text-xs text-[var(--eb-faint)]">
                            {snooze.tz ?? "server time"}
                          </span>
                        </div>
                      )}

                      <div className="flex items-center gap-3">
                        <Button onClick={() => saveSnooze(snooze)} disabled={snoozeSaving}>
                          {snoozeSaving ? "Saving…" : "Save"}
                        </Button>
                        {snoozeError && (
                          <span className="font-mono text-[12.5px] text-[var(--eb-amber)]">{snoozeError}</span>
                        )}
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
                          {err.searchQ && (
                            <span className="whitespace-nowrap text-[var(--eb-accent-text)]">{err.searchQ}</span>
                          )}
                          <ItemContent className="text-muted-foreground [overflow-wrap:anywhere]">
                            {err.message}
                          </ItemContent>
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
          )}
        </div>
      </SidebarInset>

      {/* ================= NEW SEARCH MODAL ================= */}
      {showForm && (
        <Dialog open={showForm} onOpenChange={setShowForm}>
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle>{editId == null ? "New saved search" : "Edit search"}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="search-terms">Search terms</FieldLabel>
                <Input
                  id="search-terms"
                  value={form.q}
                  onChange={(e) => setForm({ ...form, q: e.target.value })}
                  placeholder="e.g. Leica M6 body"
                  autoFocus
                />
              </Field>
              <div className="flex flex-col gap-3.5 md:flex-row">
                <Field className="md:flex-1">
                  <FieldLabel htmlFor="category-id">Category ID</FieldLabel>
                  <Input
                    id="category-id"
                    value={form.categoryId}
                    onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                    placeholder="all categories"
                  />
                </Field>
                <div className="flex gap-3.5">
                  <Field className="flex-1 md:w-[116px] md:flex-none">
                    <FieldLabel htmlFor="min-price">Min price</FieldLabel>
                    <InputGroup>
                      <InputGroupAddon className="font-mono">$</InputGroupAddon>
                      <InputGroupInput
                        id="min-price"
                        value={form.priceFloor}
                        onChange={(e) => setForm({ ...form, priceFloor: e.target.value })}
                        placeholder="any"
                        inputMode="decimal"
                        className="font-mono"
                      />
                    </InputGroup>
                  </Field>
                  <Field className="flex-1 md:w-[116px] md:flex-none">
                    <FieldLabel htmlFor="max-price">Max price</FieldLabel>
                    <InputGroup>
                      <InputGroupAddon className="font-mono">$</InputGroupAddon>
                      <InputGroupInput
                        id="max-price"
                        value={form.priceCap}
                        onChange={(e) => setForm({ ...form, priceCap: e.target.value })}
                        placeholder="2500"
                        inputMode="decimal"
                        className="font-mono"
                      />
                    </InputGroup>
                  </Field>
                </div>
              </div>

              <Field>
                <FieldLabel>Poll interval</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={String(form.interval)}
                  onValueChange={(v) => {
                    if (v) setForm({ ...form, interval: Number(v) });
                  }}
                  className="w-full"
                >
                  {[1, 2, 5, 10, 15].map((v) => (
                    <ToggleGroupItem
                      key={v}
                      value={String(v)}
                      className="flex-1 font-mono data-[state=on]:border-[var(--eb-accent)] data-[state=on]:bg-[var(--eb-accent-soft)] data-[state=on]:text-[var(--eb-accent-text)]"
                    >
                      {v}m
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>

              <div className="flex flex-col gap-2.5 md:flex-row">
                {(
                  [
                    ["Buy It Now only", "bin"],
                    ["Include auctions", "auctions"],
                  ] as const
                ).map(([text, key]) => {
                  const on = form[key];
                  // BIN-only and include-auctions are the same axis: keep them
                  // mutually exclusive so the saved search can't claim both
                  const other = key === "bin" ? "auctions" : "bin";
                  return (
                    <Field
                      key={key}
                      orientation="horizontal"
                      className="flex-1 rounded-lg border bg-[var(--eb-input-bg)] px-3.5 py-3"
                    >
                      <FieldLabel htmlFor={`toggle-${key}`} className="text-[13.5px] font-medium">
                        {text}
                      </FieldLabel>
                      <Switch
                        id={`toggle-${key}`}
                        checked={on}
                        onCheckedChange={() => setForm({ ...form, [key]: !on, [other]: on })}
                      />
                    </Field>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 rounded-lg bg-[var(--eb-accent-soft)] px-3.5 py-3 text-[12.5px] text-[var(--eb-accent-text)]">
                <span className="font-mono font-semibold">≈ {fmt(callsFor(form.interval, activeMin))} calls·day</span>
                <span className="text-muted-foreground">
                  · first poll seeds silently — no alert spam from existing listings
                </span>
              </div>
              {formError && (
                <div className="rounded-lg bg-[color-mix(in_oklab,var(--eb-amber)_14%,transparent)] px-3.5 py-2.5 font-mono text-[12.5px] text-[var(--eb-amber)]">
                  {formError}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button onClick={submitSearch} disabled={saving}>
                {saving
                  ? editId == null
                    ? "Creating…"
                    : "Saving…"
                  : editId == null
                    ? "Create search"
                    : "Save changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SidebarProvider>
  );
}
