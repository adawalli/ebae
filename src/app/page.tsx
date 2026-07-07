"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import type { Alert, SearchStats, SnoozeConfig, StatusInfo } from "@/lib/types";
import { Button } from "@/components/ui/button";
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
const callsFor = (interval: number) => Math.round(1440 / interval);

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

// inline styles can't hold @media, so responsiveness is driven off matchMedia.
// SSR + first paint assume desktop, then correct on mount (same as theme sync).
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const sync = () => setMatches(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

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
  const isMobile = useMediaQuery("(max-width: 767px)");

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
  const projected = active.reduce((n, s) => n + callsFor(s.intervalMin), 0);
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

  const chip: CSSProperties = {
    fontSize: 10.5,
    fontFamily: MONO,
    padding: "2px 7px",
    borderRadius: 5,
  };
  const statCard: CSSProperties = {
    background: "var(--eb-panel)",
    border: "1px solid var(--eb-border)",
    borderRadius: 12,
    padding: "18px 20px",
  };
  const emptyCard: CSSProperties = {
    background: "var(--eb-panel)",
    border: "1px solid var(--eb-border)",
    borderRadius: 12,
    padding: "40px 20px",
    textAlign: "center",
    color: "var(--eb-muted)",
    fontSize: 13.5,
  };
  const inputBox: CSSProperties = {
    width: "100%",
    background: "var(--eb-input-bg)",
    border: "1px solid var(--eb-border-strong)",
    borderRadius: 9,
    padding: "11px 13px",
    fontFamily: "inherit",
    fontSize: 14,
    color: "var(--eb-text)",
    outline: "none",
  };
  const fieldLabel: CSSProperties = {
    display: "block",
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--eb-muted)",
    marginBottom: 7,
  };
  const dollarWrap: CSSProperties = {
    display: "flex",
    alignItems: "center",
    background: "var(--eb-input-bg)",
    border: "1px solid var(--eb-border-strong)",
    borderRadius: 9,
    padding: "0 13px",
  };
  const dollarInput: CSSProperties = {
    width: "100%",
    background: "transparent",
    border: "none",
    padding: "11px 8px",
    fontFamily: MONO,
    fontSize: 14,
    color: "var(--eb-text)",
    outline: "none",
  };
  // header row and data rows must share the same track sizes
  const gridCols = "18px minmax(0,1fr) 150px 62px 76px 40px 132px";
  const ghostBtn: CSSProperties = {
    background: "transparent",
    border: "1px solid var(--eb-border-strong)",
    color: "var(--eb-muted)",
    borderRadius: 7,
    padding: "5px 9px",
    fontFamily: "inherit",
    fontSize: 11.5,
    fontWeight: 500,
    cursor: "pointer",
  };

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
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: isMobile ? "stretch" : "center",
                  flexDirection: isMobile ? "column" : "row",
                  justifyContent: "space-between",
                  gap: isMobile ? 14 : 0,
                  padding: isMobile ? "16px" : "24px 30px",
                  borderBottom: "1px solid var(--eb-border)",
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" }}>Saved searches</h2>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                      color: "var(--eb-muted)",
                      marginTop: 4,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: running ? "var(--eb-green)" : "var(--eb-amber)",
                        animation: running ? "ebPulse 2.4s ease-in-out infinite" : "none",
                      }}
                    />
                    {searches.length} searches · {active.length} active ·{" "}
                    {running ? (mock ? "polling (mock mode)" : "polling live") : "poller down"}
                  </div>
                </div>
                <button
                  className="hv-accent"
                  onClick={openCreate}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: isMobile ? "center" : "flex-start",
                    gap: 7,
                    background: "var(--eb-accent)",
                    color: "white",
                    border: "none",
                    borderRadius: 9,
                    padding: "10px 17px",
                    fontFamily: "inherit",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontSize: 17, lineHeight: 0, marginTop: -1 }}>+</span> New search
                </button>
              </div>

              {/* quota strip */}
              <div
                style={{
                  margin: isMobile ? "16px 16px 6px" : "20px 30px 6px",
                  background: "var(--eb-panel)",
                  border: "1px solid var(--eb-border)",
                  borderRadius: 12,
                  padding: "15px 20px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 6,
                    marginBottom: 10,
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--eb-muted)" }}>
                    Projected API usage <span style={{ color: "var(--eb-faint)" }}>· enforced global budget</span>
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: "var(--eb-text)" }}>
                    <b style={{ color: "var(--eb-accent-text)" }}>{fmt(projected)}</b> / {fmt(ceiling)} calls·day{" "}
                    <span style={{ color: "var(--eb-faint)" }}>· {quotaPct}%</span>
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 5, background: "var(--eb-chip-bg)", overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${quotaPct}%`,
                      height: "100%",
                      borderRadius: 5,
                      background: "linear-gradient(90deg,var(--eb-accent),var(--eb-accent-text))",
                    }}
                  />
                </div>
              </div>

              {/* table */}
              <div
                style={{
                  flex: 1,
                  overflowY: isMobile ? "visible" : "auto",
                  padding: isMobile ? "14px 16px 20px" : "14px 30px 26px",
                }}
              >
                {!isMobile && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: gridCols,
                      gap: 8,
                      alignItems: "center",
                      padding: "0 14px 10px",
                      fontFamily: MONO,
                      fontSize: 10.5,
                      letterSpacing: ".1em",
                      textTransform: "uppercase",
                      color: "var(--eb-faint)",
                    }}
                  >
                    <span />
                    <span>Search</span>
                    <span>Filters</span>
                    <span style={{ textAlign: "right" }}>Every</span>
                    <span style={{ textAlign: "right" }}>Calls·day</span>
                    <span style={{ textAlign: "right" }}>24h</span>
                    <span />
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {searches.length === 0 && (
                    <div style={emptyCard}>
                      No saved searches yet — create one and ebae starts watching within seconds.
                    </div>
                  )}
                  {searches.map((s) => {
                    const seeding = s.enabled && !s.seeded;
                    const hasChips = s.binOnly || s.priceFloor != null || s.priceCap != null || s.includeAuctions;
                    if (isMobile) {
                      return (
                        <div
                          key={s.id}
                          className="hv-card"
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                            background: "var(--eb-panel)",
                            border: "1px solid var(--eb-border)",
                            borderRadius: 12,
                            padding: "14px 15px",
                            opacity: s.enabled ? 1 : 0.62,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                            <span
                              style={{
                                width: 8,
                                height: 8,
                                flex: "0 0 auto",
                                borderRadius: s.enabled ? "50%" : 2,
                                background: s.enabled ? "var(--eb-green)" : "var(--eb-faint)",
                                boxShadow: s.enabled
                                  ? "0 0 0 3px color-mix(in oklab, var(--eb-green) 18%, transparent)"
                                  : "none",
                                animation:
                                  s.enabled && s.intervalMin <= 2 ? "ebPulse 2.4s ease-in-out infinite" : "none",
                              }}
                            />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div
                                style={{
                                  fontWeight: 600,
                                  fontSize: 15,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {s.q}
                              </div>
                              <div
                                style={{
                                  fontSize: 11.5,
                                  color: "var(--eb-faint)",
                                  fontFamily: MONO,
                                  marginTop: 2,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {searchSub(s)}
                              </div>
                            </div>
                          </div>
                          {hasChips && (
                            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                              {s.binOnly && (
                                <span
                                  style={{
                                    ...chip,
                                    background: "var(--eb-accent-soft)",
                                    color: "var(--eb-accent-text)",
                                  }}
                                >
                                  BIN
                                </span>
                              )}
                              {s.priceFloor != null && (
                                <span
                                  style={{ ...chip, background: "var(--eb-chip-bg)", color: "var(--eb-chip-text)" }}
                                >
                                  ≥ {money(s.priceFloor).replace(/\.00$/, "")}
                                </span>
                              )}
                              {s.priceCap != null && (
                                <span
                                  style={{ ...chip, background: "var(--eb-chip-bg)", color: "var(--eb-chip-text)" }}
                                >
                                  ≤ {money(s.priceCap).replace(/\.00$/, "")}
                                </span>
                              )}
                              {s.includeAuctions && (
                                <span
                                  style={{ ...chip, background: "var(--eb-chip-bg)", color: "var(--eb-chip-text)" }}
                                >
                                  Auctions ok
                                </span>
                              )}
                            </div>
                          )}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              flexWrap: "wrap",
                              fontFamily: MONO,
                              fontSize: 12,
                              color: "var(--eb-muted)",
                            }}
                          >
                            <span
                              style={{
                                color: s.enabled
                                  ? s.intervalMin <= 1
                                    ? "var(--eb-amber)"
                                    : "var(--eb-text)"
                                  : "var(--eb-faint)",
                              }}
                            >
                              every {s.intervalMin}m
                            </span>
                            <span style={{ color: "var(--eb-faint)" }}>·</span>
                            <span>{s.enabled ? `${fmt(callsFor(s.intervalMin))} calls·day` : "paused"}</span>
                            <span style={{ color: "var(--eb-faint)" }}>·</span>
                            <span style={{ color: s.hits24 > 0 ? "var(--eb-accent-text)" : "var(--eb-muted)" }}>
                              {seeding ? "seeding" : `${s.hits24} in 24h`}
                            </span>
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                            <button
                              className="hv-ghost"
                              onClick={() => openEdit(s)}
                              style={{
                                ...ghostBtn,
                                flex: "0 0 auto",
                                padding: "9px 13px",
                                fontSize: 13,
                                color: "var(--eb-faint)",
                              }}
                            >
                              ✎ Edit
                            </button>
                            <button
                              className="hv-ghost"
                              onClick={() => togglePause(s)}
                              style={{ ...ghostBtn, flex: 1, padding: "9px 13px", fontSize: 13 }}
                            >
                              {s.enabled ? "Pause" : "Resume"}
                            </button>
                            <button
                              className="hv-ghost"
                              onClick={() => removeSearch(s)}
                              style={{
                                ...ghostBtn,
                                flex: "0 0 auto",
                                padding: "9px 13px",
                                fontSize: 13,
                                color: "var(--eb-faint)",
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={s.id}
                        className="hv-row"
                        style={{
                          display: "grid",
                          gridTemplateColumns: gridCols,
                          gap: 8,
                          alignItems: "center",
                          background: "var(--eb-panel)",
                          border: "1px solid var(--eb-border)",
                          borderRadius: 10,
                          padding: "13px 14px",
                          opacity: s.enabled ? 1 : 0.62,
                        }}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            justifySelf: "start",
                            borderRadius: s.enabled ? "50%" : 2,
                            background: s.enabled ? "var(--eb-green)" : "var(--eb-faint)",
                            boxShadow: s.enabled
                              ? "0 0 0 3px color-mix(in oklab, var(--eb-green) 18%, transparent)"
                              : "none",
                            animation: s.enabled && s.intervalMin <= 2 ? "ebPulse 2.4s ease-in-out infinite" : "none",
                          }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 600,
                              fontSize: 14.5,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {s.q}
                          </div>
                          <div
                            style={{
                              fontSize: 11.5,
                              color: "var(--eb-faint)",
                              fontFamily: MONO,
                              marginTop: 2,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {searchSub(s)}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          {s.binOnly && (
                            <span
                              style={{ ...chip, background: "var(--eb-accent-soft)", color: "var(--eb-accent-text)" }}
                            >
                              BIN
                            </span>
                          )}
                          {s.priceFloor != null && (
                            <span style={{ ...chip, background: "var(--eb-chip-bg)", color: "var(--eb-chip-text)" }}>
                              ≥ {money(s.priceFloor).replace(/\.00$/, "")}
                            </span>
                          )}
                          {s.priceCap != null && (
                            <span style={{ ...chip, background: "var(--eb-chip-bg)", color: "var(--eb-chip-text)" }}>
                              ≤ {money(s.priceCap).replace(/\.00$/, "")}
                            </span>
                          )}
                          {s.includeAuctions && (
                            <span style={{ ...chip, background: "var(--eb-chip-bg)", color: "var(--eb-chip-text)" }}>
                              Auctions ok
                            </span>
                          )}
                        </div>
                        <span
                          style={{
                            textAlign: "right",
                            fontFamily: MONO,
                            fontSize: 13,
                            color: s.enabled
                              ? s.intervalMin <= 1
                                ? "var(--eb-amber)"
                                : "var(--eb-text)"
                              : "var(--eb-faint)",
                          }}
                        >
                          {s.intervalMin} min
                        </span>
                        <span style={{ textAlign: "right", fontFamily: MONO, fontSize: 13, color: "var(--eb-muted)" }}>
                          {s.enabled ? fmt(callsFor(s.intervalMin)) : "—"}
                        </span>
                        <span style={{ textAlign: "right", fontFamily: MONO, fontSize: 13 }}>
                          {seeding ? (
                            <span
                              style={{
                                fontSize: 9,
                                background: "color-mix(in oklab, var(--eb-amber) 18%, transparent)",
                                color: "var(--eb-amber)",
                                padding: "2px 6px",
                                borderRadius: 5,
                              }}
                            >
                              seed
                            </span>
                          ) : (
                            <span
                              style={{
                                color: s.hits24 > 0 ? "var(--eb-accent-text)" : "var(--eb-faint)",
                                fontWeight: s.hits24 > 0 ? 600 : 400,
                              }}
                            >
                              {s.hits24}
                            </span>
                          )}
                        </span>
                        <span style={{ display: "flex", gap: 5, justifySelf: "end" }}>
                          <button
                            className="hv-ghost"
                            onClick={() => openEdit(s)}
                            title="Edit search"
                            style={{ ...ghostBtn, color: "var(--eb-faint)", padding: "5px 8px" }}
                          >
                            ✎
                          </button>
                          <button className="hv-ghost" onClick={() => togglePause(s)} style={ghostBtn}>
                            {s.enabled ? "Pause" : "Resume"}
                          </button>
                          <button
                            className="hv-ghost"
                            onClick={() => removeSearch(s)}
                            title="Delete search"
                            style={{
                              background: "transparent",
                              border: "1px solid var(--eb-border-strong)",
                              color: "var(--eb-faint)",
                              borderRadius: 7,
                              padding: "5px 8px",
                              fontFamily: "inherit",
                              fontSize: 11.5,
                              cursor: "pointer",
                            }}
                          >
                            ✕
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ---------- ALERTS VIEW ---------- */}
          {view === "alerts" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: isMobile ? 12 : 10,
                  padding: isMobile ? "16px" : "24px 30px",
                  borderBottom: "1px solid var(--eb-border)",
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" }}>Alert history</h2>
                  <div style={{ fontSize: 13, color: "var(--eb-muted)", marginTop: 4 }}>
                    {visibleAlerts.length} item{visibleAlerts.length === 1 ? "" : "s"} matched · newest first
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {visibleAlerts.length > 0 && (
                    <button
                      className="hv-ghost"
                      onClick={clearAlerts}
                      style={{
                        background: "transparent",
                        border: "1px solid var(--eb-border-strong)",
                        color: "var(--eb-muted)",
                        borderRadius: 8,
                        padding: "8px 13px",
                        fontFamily: "inherit",
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {alertFilter === "all" ? "Clear all" : "Clear"}
                    </button>
                  )}
                  <select
                    value={String(alertFilter)}
                    onChange={(e) => setAlertFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
                    style={{
                      fontFamily: MONO,
                      fontSize: 12,
                      color: "var(--eb-faint)",
                      border: "1px solid var(--eb-border)",
                      borderRadius: 8,
                      padding: "8px 12px",
                      background: "transparent",
                      cursor: "pointer",
                    }}
                  >
                    <option value="all">All searches</option>
                    {searches.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.q}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div
                style={{
                  flex: 1,
                  overflowY: isMobile ? "visible" : "auto",
                  padding: isMobile ? "16px 16px 20px" : "18px 30px 28px",
                }}
              >
                {visibleAlerts.length === 0 && (
                  <div style={emptyCard}>
                    No alerts yet — new listings show up here the moment the poller finds them.
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {visibleAlerts.map((a, i) => {
                    const day = dayLabel(a.createdAt);
                    const header = i === 0 || dayLabel(visibleAlerts[i - 1].createdAt) !== day;
                    return (
                      <div key={a.id}>
                        {header && (
                          <div
                            style={{
                              fontFamily: MONO,
                              fontSize: 10.5,
                              letterSpacing: ".12em",
                              textTransform: "uppercase",
                              color: "var(--eb-faint)",
                              padding: "8px 2px 12px",
                            }}
                          >
                            {day}
                          </div>
                        )}
                        <div
                          className="hv-card"
                          style={{
                            display: "flex",
                            gap: isMobile ? 12 : 15,
                            background: "var(--eb-panel)",
                            border: "1px solid var(--eb-border)",
                            borderRadius: 12,
                            padding: isMobile ? "12px 13px" : "14px 16px",
                          }}
                        >
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
                              style={{
                                width: isMobile ? 56 : 66,
                                height: isMobile ? 56 : 66,
                                flex: "0 0 auto",
                                borderRadius: 10,
                                border: "1px solid var(--eb-border)",
                                objectFit: "cover",
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                width: isMobile ? 56 : 66,
                                height: isMobile ? 56 : 66,
                                flex: "0 0 auto",
                                borderRadius: 10,
                                border: "1px solid var(--eb-border)",
                                background:
                                  "repeating-linear-gradient(45deg,var(--eb-chip-bg) 0 5px,transparent 5px 10px),var(--eb-panel2)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <span style={{ fontFamily: MONO, fontSize: 8, color: "var(--eb-faint)" }}>photo</span>
                            </div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                justifyContent: "space-between",
                                gap: 12,
                              }}
                            >
                              <a
                                className="hv-link"
                                href={a.itemUrl}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  fontWeight: 600,
                                  fontSize: 14.5,
                                  color: "var(--eb-text)",
                                  textDecoration: "none",
                                  lineHeight: 1.35,
                                }}
                              >
                                {a.title}
                              </a>
                              <span
                                style={{
                                  flex: "0 0 auto",
                                  fontFamily: MONO,
                                  fontSize: 11.5,
                                  color: "var(--eb-faint)",
                                  whiteSpace: "nowrap",
                                  marginTop: 2,
                                }}
                              >
                                {ago(a.createdAt)}
                              </span>
                            </div>
                            <div
                              style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 9, flexWrap: "wrap" }}
                            >
                              <span
                                style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color: "var(--eb-text)" }}
                              >
                                {money(a.price, a.currency)}
                              </span>
                              <span style={{ fontSize: 12, color: "var(--eb-faint)" }}>
                                {a.shippingCost == null
                                  ? ""
                                  : a.shippingCost === 0
                                    ? "Free ship"
                                    : `+ ${money(a.shippingCost, a.currency)} ship`}
                              </span>
                              <span
                                style={{
                                  ...chip,
                                  padding: "2px 8px",
                                  fontWeight: 500,
                                  background:
                                    a.buyingOption === "FIXED_PRICE"
                                      ? "var(--eb-accent-soft)"
                                      : "color-mix(in oklab, var(--eb-amber) 18%, transparent)",
                                  color: a.buyingOption === "FIXED_PRICE" ? "var(--eb-accent-text)" : "var(--eb-amber)",
                                }}
                              >
                                {a.buyingOption === "FIXED_PRICE" ? "Buy It Now" : "Auction"}
                              </span>
                              {a.condition && (
                                <span
                                  style={{
                                    ...chip,
                                    padding: "2px 8px",
                                    background: "var(--eb-chip-bg)",
                                    color: "var(--eb-chip-text)",
                                  }}
                                >
                                  {a.condition}
                                </span>
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 7,
                                marginTop: 11,
                                paddingTop: 11,
                                borderTop: "1px solid var(--eb-border)",
                                fontSize: 12,
                                color: "var(--eb-muted)",
                              }}
                            >
                              <span
                                style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--eb-accent)" }}
                              />
                              matched <b style={{ color: "var(--eb-text)", fontWeight: 600 }}>{a.searchQ}</b>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ---------- STATUS VIEW ---------- */}
          {view === "status" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ padding: isMobile ? "16px" : "24px 30px", borderBottom: "1px solid var(--eb-border)" }}>
                <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" }}>Status</h2>
                <div style={{ fontSize: 13, color: "var(--eb-muted)", marginTop: 4 }}>
                  Poller, quota and eBay API health
                </div>
              </div>
              <div
                style={{
                  flex: 1,
                  overflowY: isMobile ? "visible" : "auto",
                  padding: isMobile ? "16px" : "24px 30px",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isMobile ? "1fr" : "repeat(3,1fr)",
                    gap: isMobile ? 12 : 14,
                    marginBottom: 20,
                  }}
                >
                  <div style={statCard}>
                    <div style={{ fontSize: 12.5, color: "var(--eb-muted)", marginBottom: 10 }}>Poller</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: "50%",
                          background: running ? (snoozed ? "var(--eb-amber)" : "var(--eb-green)") : "var(--eb-amber)",
                          animation: running && !snoozed ? "ebPulse 2.4s ease-in-out infinite" : "none",
                        }}
                      />
                      <span style={{ fontSize: 19, fontWeight: 700 }}>
                        {running ? (snoozed ? "Snoozing" : "Running") : "Stopped"}
                      </span>
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--eb-faint)", marginTop: 8 }}>
                      {running && status?.poller.bootedAt
                        ? `uptime ${duration(status.poller.bootedAt)} · ${status.poller.timers} timer${status.poller.timers === 1 ? "" : "s"}${status.snooze.window ? ` · ${snoozed ? "snoozing" : "snooze"} ${status.snooze.window}` : ""}`
                        : (status?.bootError ?? "not started")}
                    </div>
                  </div>
                  <div style={statCard}>
                    <div style={{ fontSize: 12.5, color: "var(--eb-muted)", marginBottom: 10 }}>eBay Browse token</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: "50%",
                          background: mock ? "var(--eb-amber)" : "var(--eb-green)",
                        }}
                      />
                      <span style={{ fontSize: 19, fontWeight: 700 }}>
                        {mock ? "Mock mode" : status?.ebay.tokenExpiresAt ? "Valid" : "Not fetched"}
                      </span>
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--eb-faint)", marginTop: 8 }}>
                      {mock
                        ? `set EBAY_CLIENT_ID to go live · ${status?.ebay.marketplace ?? "EBAY_US"}`
                        : status?.ebay.tokenExpiresAt
                          ? `refreshes in ${until(status.ebay.tokenExpiresAt)} · ${status.ebay.marketplace}`
                          : `fetched on first poll · ${status?.ebay.marketplace ?? "EBAY_US"}`}
                    </div>
                  </div>
                  <div style={statCard}>
                    <div style={{ fontSize: 12.5, color: "var(--eb-muted)", marginBottom: 10 }}>Quota today</div>
                    <div style={{ fontSize: 19, fontWeight: 700, fontFamily: MONO }}>
                      {fmt(status?.quota.used ?? 0)}{" "}
                      <span style={{ color: "var(--eb-faint)", fontWeight: 400, fontSize: 14 }}>/ {fmt(ceiling)}</span>
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--eb-faint)", marginTop: 8 }}>
                      {Math.round(((status?.quota.used ?? 0) / ceiling) * 100)}% of daily budget
                    </div>
                  </div>
                </div>

                {snooze && (
                  <div
                    style={{
                      background: "var(--eb-panel)",
                      border: "1px solid var(--eb-border)",
                      borderRadius: 12,
                      padding: isMobile ? "16px" : "18px 20px",
                      marginBottom: 20,
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}
                    >
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>Overnight snooze</div>
                        <div style={{ fontSize: 12.5, color: "var(--eb-muted)", marginTop: 3, maxWidth: 440 }}>
                          Pause eBay polling during these hours to save quota while you sleep. Items listed in the
                          window still alert on the first poll after it ends.
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={snooze.enabled}
                        aria-label="Overnight snooze"
                        onClick={() => setSnoozeState({ ...snooze, enabled: !snooze.enabled })}
                        style={{
                          width: 38,
                          height: 22,
                          borderRadius: 20,
                          border: "none",
                          padding: 0,
                          background: snooze.enabled ? "var(--eb-accent)" : "var(--eb-border-strong)",
                          position: "relative",
                          flex: "0 0 auto",
                          cursor: "pointer",
                          transition: "background .15s",
                        }}
                      >
                        <span
                          style={{
                            position: "absolute",
                            top: 2,
                            left: snooze.enabled ? 18 : 2,
                            width: 18,
                            height: 18,
                            borderRadius: "50%",
                            background: "white",
                            transition: "left .15s",
                          }}
                        />
                      </button>
                    </div>

                    {snooze.enabled && (
                      <div
                        style={{ display: "flex", alignItems: "flex-end", gap: 12, marginTop: 16, flexWrap: "wrap" }}
                      >
                        <label
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                            fontSize: 12,
                            color: "var(--eb-muted)",
                          }}
                        >
                          From
                          <input
                            type="time"
                            value={snooze.start}
                            onChange={(e) => setSnoozeState({ ...snooze, start: e.target.value })}
                            style={{ ...inputBox, width: 130 }}
                          />
                        </label>
                        <label
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                            fontSize: 12,
                            color: "var(--eb-muted)",
                          }}
                        >
                          To
                          <input
                            type="time"
                            value={snooze.end}
                            onChange={(e) => setSnoozeState({ ...snooze, end: e.target.value })}
                            style={{ ...inputBox, width: 130 }}
                          />
                        </label>
                        <span style={{ fontSize: 12, color: "var(--eb-faint)", fontFamily: MONO, paddingBottom: 12 }}>
                          {snooze.tz ?? "server time"}
                        </span>
                      </div>
                    )}

                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
                      <button
                        className="hv-accent"
                        onClick={() => saveSnooze(snooze)}
                        disabled={snoozeSaving}
                        style={{
                          background: "var(--eb-accent)",
                          color: "white",
                          border: "none",
                          borderRadius: 9,
                          padding: "9px 18px",
                          fontFamily: "inherit",
                          fontSize: 13.5,
                          fontWeight: 600,
                          cursor: snoozeSaving ? "default" : "pointer",
                          opacity: snoozeSaving ? 0.7 : 1,
                        }}
                      >
                        {snoozeSaving ? "Saving…" : "Save"}
                      </button>
                      {snoozeError && (
                        <span style={{ fontSize: 12.5, color: "var(--eb-amber)", fontFamily: MONO }}>
                          {snoozeError}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {status?.errors.length ? (
                  <div
                    style={{
                      background: "var(--eb-panel)",
                      border: "1px solid var(--eb-border)",
                      borderRadius: 12,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        padding: "13px 18px",
                        borderBottom: "1px solid var(--eb-border)",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--eb-muted)",
                      }}
                    >
                      Recent errors
                    </div>
                    {status.errors.map((err, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          gap: 12,
                          padding: "10px 18px",
                          borderBottom: i < status.errors.length - 1 ? "1px solid var(--eb-border)" : "none",
                          fontFamily: MONO,
                          fontSize: 12,
                          alignItems: "baseline",
                        }}
                      >
                        <span style={{ color: "var(--eb-faint)", whiteSpace: "nowrap" }}>{ago(err.time, true)}</span>
                        {err.searchQ && (
                          <span style={{ color: "var(--eb-accent-text)", whiteSpace: "nowrap" }}>{err.searchQ}</span>
                        )}
                        <span style={{ color: "var(--eb-muted)", overflowWrap: "anywhere" }}>{err.message}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    style={{
                      background: "var(--eb-panel)",
                      border: "1px solid var(--eb-border)",
                      borderRadius: 12,
                      padding: "44px 20px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        width: 46,
                        height: 46,
                        borderRadius: 12,
                        border: "1px solid var(--eb-border)",
                        background: "var(--eb-panel2)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        marginBottom: 14,
                      }}
                    >
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          border: "2px solid var(--eb-green)",
                          borderRightColor: "transparent",
                          transform: "rotate(45deg)",
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>No API errors in the last 24h</div>
                    <div
                      style={{ fontSize: 13, color: "var(--eb-muted)", marginTop: 5, maxWidth: 360, lineHeight: 1.5 }}
                    >
                      All searches are polling on schedule. Failed calls back off exponentially and surface here.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </SidebarInset>

      {/* ================= NEW SEARCH MODAL ================= */}
      {showForm && (
        <div
          onClick={() => setShowForm(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "oklch(0.1 0.02 265 / .55)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            animation: "ebFade .14s ease",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 520,
              maxWidth: "calc(100vw - 32px)",
              maxHeight: isMobile ? "calc(100dvh - 24px)" : undefined,
              background: "var(--eb-panel)",
              border: "1px solid var(--eb-border-strong)",
              borderRadius: 16,
              boxShadow: "0 40px 90px -30px oklch(0.1 0.05 265 / .7)",
              overflow: isMobile ? "auto" : "hidden",
              animation: "ebModalIn .18s cubic-bezier(.2,.7,.3,1)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "20px 24px",
                borderBottom: "1px solid var(--eb-border)",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
                {editId == null ? "New saved search" : "Edit search"}
              </h3>
              <div
                className="hv-dim"
                onClick={() => setShowForm(false)}
                style={{ cursor: "pointer", color: "var(--eb-faint)", fontSize: 18, lineHeight: 1, padding: 4 }}
              >
                ✕
              </div>
            </div>
            <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 18 }}>
              <div>
                <label style={fieldLabel}>Search terms</label>
                <input
                  className="eb-input"
                  value={form.q}
                  onChange={(e) => setForm({ ...form, q: e.target.value })}
                  placeholder="e.g. Leica M6 body"
                  autoFocus
                  style={inputBox}
                />
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: isMobile ? "wrap" : "nowrap" }}>
                <div style={{ flex: isMobile ? "1 1 100%" : 1 }}>
                  <label style={fieldLabel}>Category ID</label>
                  <input
                    className="eb-input"
                    value={form.categoryId}
                    onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                    placeholder="all categories"
                    style={inputBox}
                  />
                </div>
                <div style={{ width: isMobile ? "auto" : 116, flex: isMobile ? 1 : "0 0 auto" }}>
                  <label style={fieldLabel}>Min price</label>
                  <div style={dollarWrap}>
                    <span style={{ color: "var(--eb-faint)", fontFamily: MONO, fontSize: 14 }}>$</span>
                    <input
                      value={form.priceFloor}
                      onChange={(e) => setForm({ ...form, priceFloor: e.target.value })}
                      placeholder="any"
                      inputMode="decimal"
                      style={dollarInput}
                    />
                  </div>
                </div>
                <div style={{ width: isMobile ? "auto" : 116, flex: isMobile ? 1 : "0 0 auto" }}>
                  <label style={fieldLabel}>Max price</label>
                  <div style={dollarWrap}>
                    <span style={{ color: "var(--eb-faint)", fontFamily: MONO, fontSize: 14 }}>$</span>
                    <input
                      value={form.priceCap}
                      onChange={(e) => setForm({ ...form, priceCap: e.target.value })}
                      placeholder="2500"
                      inputMode="decimal"
                      style={dollarInput}
                    />
                  </div>
                </div>
              </div>

              <div>
                <label style={{ ...fieldLabel, marginBottom: 8 }}>Poll interval</label>
                <div style={{ display: "flex", gap: 7 }}>
                  {[1, 2, 5, 10, 15].map((v) => {
                    const on = form.interval === v;
                    return (
                      <div
                        key={v}
                        onClick={() => setForm({ ...form, interval: v })}
                        style={{
                          flex: 1,
                          textAlign: "center",
                          padding: "9px 0",
                          borderRadius: 8,
                          border: `1px solid ${on ? "var(--eb-accent)" : "var(--eb-border-strong)"}`,
                          background: on ? "var(--eb-accent-soft)" : "var(--eb-input-bg)",
                          color: on ? "var(--eb-accent-text)" : "var(--eb-muted)",
                          fontFamily: MONO,
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {v}m
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
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
                    <div
                      key={key}
                      onClick={() => setForm({ ...form, [key]: !on, [other]: on })}
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        background: "var(--eb-input-bg)",
                        border: "1px solid var(--eb-border-strong)",
                        borderRadius: 9,
                        padding: "11px 13px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ fontSize: 13.5, fontWeight: 500 }}>{text}</span>
                      <span
                        style={{
                          width: 38,
                          height: 22,
                          borderRadius: 20,
                          background: on ? "var(--eb-accent)" : "var(--eb-border-strong)",
                          position: "relative",
                          transition: "background .15s",
                          flex: "0 0 auto",
                        }}
                      >
                        <span
                          style={{
                            position: "absolute",
                            top: 2,
                            left: on ? 18 : 2,
                            width: 18,
                            height: 18,
                            borderRadius: "50%",
                            background: "white",
                            transition: "left .15s",
                          }}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  background: "var(--eb-accent-soft)",
                  borderRadius: 9,
                  padding: "11px 14px",
                  fontSize: 12.5,
                  color: "var(--eb-accent-text)",
                }}
              >
                <span style={{ fontFamily: MONO, fontWeight: 600 }}>≈ {fmt(callsFor(form.interval))} calls·day</span>
                <span style={{ color: "var(--eb-muted)" }}>
                  · first poll seeds silently — no alert spam from existing listings
                </span>
              </div>
              {formError && (
                <div
                  style={{
                    background: "color-mix(in oklab, var(--eb-amber) 14%, transparent)",
                    borderRadius: 9,
                    padding: "10px 14px",
                    fontSize: 12.5,
                    color: "var(--eb-amber)",
                    fontFamily: MONO,
                  }}
                >
                  {formError}
                </div>
              )}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
                padding: "16px 24px",
                borderTop: "1px solid var(--eb-border)",
                background: "var(--eb-panel2)",
              }}
            >
              <button
                className="hv-nav"
                onClick={() => setShowForm(false)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--eb-border-strong)",
                  color: "var(--eb-text)",
                  borderRadius: 9,
                  padding: "10px 16px",
                  fontFamily: "inherit",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                className="hv-accent"
                onClick={submitSearch}
                disabled={saving}
                style={{
                  background: "var(--eb-accent)",
                  color: "white",
                  border: "none",
                  borderRadius: 9,
                  padding: "10px 18px",
                  fontFamily: "inherit",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving
                  ? editId == null
                    ? "Creating…"
                    : "Saving…"
                  : editId == null
                    ? "Create search"
                    : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </SidebarProvider>
  );
}
