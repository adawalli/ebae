"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { Alert, SearchStats, StatusInfo } from "@/lib/types";

const MONO = "var(--font-mono), ui-monospace, monospace";
const HUE = 232; // "Cyan" accent from the design

function tokens(theme: "dark" | "light"): Record<string, string> {
  if (theme === "light") {
    return {
      "--bg": "oklch(0.955 0.006 265)",
      "--panel": "oklch(0.995 0.003 265)",
      "--panel2": "oklch(0.975 0.005 265)",
      "--sidebar": "oklch(0.982 0.004 265)",
      "--border": "oklch(0.9 0.008 265)",
      "--border-strong": "oklch(0.85 0.012 265)",
      "--text": "oklch(0.24 0.02 265)",
      "--muted": "oklch(0.46 0.02 265)",
      "--faint": "oklch(0.6 0.015 265)",
      "--accent": `oklch(0.52 0.2 ${HUE})`,
      "--accent-soft": `oklch(0.52 0.2 ${HUE} / 0.12)`,
      "--accent-text": `oklch(0.46 0.19 ${HUE})`,
      "--chip-bg": "oklch(0.93 0.008 265)",
      "--chip-text": "oklch(0.42 0.02 265)",
      "--green": "oklch(0.58 0.15 150)",
      "--amber": "oklch(0.6 0.14 60)",
      "--input-bg": "oklch(0.98 0.004 265)",
      "--row-hover": "oklch(0.965 0.006 265)",
    };
  }
  return {
    "--bg": "oklch(0.17 0.015 265)",
    "--panel": "oklch(0.2 0.018 265)",
    "--panel2": "oklch(0.185 0.012 265)",
    "--sidebar": "oklch(0.2 0.018 265)",
    "--border": "oklch(0.28 0.02 265)",
    "--border-strong": "oklch(0.33 0.02 265)",
    "--text": "oklch(0.94 0.008 265)",
    "--muted": "oklch(0.66 0.02 265)",
    "--faint": "oklch(0.54 0.02 265)",
    "--accent": `oklch(0.55 0.19 ${HUE})`,
    "--accent-soft": `oklch(0.6 0.19 ${HUE} / 0.16)`,
    "--accent-text": `oklch(0.8 0.12 ${HUE})`,
    "--chip-bg": "oklch(0.28 0.02 265)",
    "--chip-text": "oklch(0.72 0.02 265)",
    "--green": "oklch(0.7 0.17 150)",
    "--amber": "oklch(0.82 0.13 65)",
    "--input-bg": "oklch(0.16 0.012 265)",
    "--row-hover": "oklch(0.225 0.02 265)",
  };
}

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

const emptyForm = { q: "", priceCap: "", categoryId: "", bin: true, auctions: false, interval: 2 };

export default function Home() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [view, setView] = useState<"searches" | "alerts" | "status">("searches");
  const [searches, setSearches] = useState<SearchStats[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertFilter, setAlertFilter] = useState<"all" | number>("all");
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    // one-time sync from localStorage after hydration (SSR always renders dark)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (localStorage.getItem("ebae-theme") === "light") setTheme("light");
  }, []);
  const pickTheme = (t: "dark" | "light") => {
    setTheme(t);
    localStorage.setItem("ebae-theme", t);
  };

  const refresh = useCallback(async () => {
    // filter alerts server-side: a global top-N fetch can push a low-volume
    // search's alerts out of the window, hiding them from its filtered view
    const alertsUrl = alertFilter === "all" ? "/api/alerts" : `/api/alerts?searchId=${alertFilter}`;
    try {
      const [sRes, aRes, stRes] = await Promise.all([fetch("/api/searches"), fetch(alertsUrl), fetch("/api/status")]);
      if (sRes.ok) setSearches((await sRes.json()).searches);
      if (aRes.ok) setAlerts((await aRes.json()).alerts);
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

  async function createSearch() {
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: form.q,
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
  const mock = status?.ebay.mode === "mock";

  const navItems = [
    { key: "searches" as const, label: "Searches", badge: null },
    { key: "alerts" as const, label: "Alerts", badge: alerts.length || null },
    { key: "status" as const, label: "Status", badge: status?.errors.length || null },
  ];

  const chip: CSSProperties = {
    fontSize: 10.5,
    fontFamily: MONO,
    padding: "2px 7px",
    borderRadius: 5,
  };
  const statCard: CSSProperties = {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "18px 20px",
  };
  const emptyCard: CSSProperties = {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "40px 20px",
    textAlign: "center",
    color: "var(--muted)",
    fontSize: 13.5,
  };
  const inputBox: CSSProperties = {
    width: "100%",
    background: "var(--input-bg)",
    border: "1px solid var(--border-strong)",
    borderRadius: 9,
    padding: "11px 13px",
    fontFamily: "inherit",
    fontSize: 14,
    color: "var(--text)",
    outline: "none",
  };
  const fieldLabel: CSSProperties = {
    display: "block",
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--muted)",
    marginBottom: 7,
  };

  function searchSub(s: SearchStats) {
    if (!s.enabled) return "paused";
    if (!s.seeded) return "seeding baseline — first matches silenced";
    const hit = s.lastHitAt ? `last hit ${ago(s.lastHitAt, true)}` : "no hits yet";
    return `${hit} · seen ${fmt(s.seenCount)}`;
  }

  return (
    <div
      style={{
        ...(tokens(theme) as CSSProperties),
        height: "100vh",
        display: "flex",
        overflow: "hidden",
        background: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
      }}
    >
      {/* ================= SIDEBAR ================= */}
      <div
        style={{
          width: 224,
          flex: "0 0 224px",
          background: "var(--sidebar)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          padding: "22px 16px 18px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 6px 4px" }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: "var(--accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: MONO,
              fontWeight: 600,
              fontSize: 16,
              color: "white",
            }}
          >
            e
          </div>
          <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: "-0.01em" }}>ebae</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--faint)", padding: "2px 6px 22px", letterSpacing: ".01em" }}>
          eBay, before anyone else
        </div>

        <div
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: "var(--faint)",
            padding: "0 8px 9px",
          }}
        >
          Monitor
        </div>
        {navItems.map((n) => {
          const isActive = view === n.key;
          return (
            <div
              key={n.key}
              className="hv-nav"
              onClick={() => setView(n.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "9px 10px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 14,
                marginBottom: 2,
                fontWeight: isActive ? 600 : 500,
                background: isActive ? "var(--accent-soft)" : "transparent",
                color: isActive ? "var(--accent-text)" : "var(--muted)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: isActive ? "var(--accent)" : "transparent",
                  border: isActive ? "none" : "1.5px solid var(--faint)",
                }}
              />
              {n.label}
              {n.badge != null && (
                <span
                  style={{
                    marginLeft: "auto",
                    fontFamily: MONO,
                    fontSize: 11,
                    background: "var(--accent-soft)",
                    color: "var(--accent-text)",
                    padding: "1px 8px",
                    borderRadius: 20,
                  }}
                >
                  {n.badge}
                </span>
              )}
            </div>
          );
        })}

        <div style={{ marginTop: "auto" }}>
          <div
            style={{
              display: "flex",
              background: "var(--panel2)",
              border: "1px solid var(--border)",
              borderRadius: 9,
              padding: 4,
              marginBottom: 12,
            }}
          >
            {(["dark", "light"] as const).map((t) => (
              <div
                key={t}
                onClick={() => pickTheme(t)}
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontSize: 12.5,
                  fontWeight: 600,
                  padding: 6,
                  borderRadius: 6,
                  cursor: "pointer",
                  background: theme === t ? "var(--accent)" : "transparent",
                  color: theme === t ? "white" : "var(--muted)",
                }}
              >
                {t === "dark" ? "Dark" : "Light"}
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontFamily: MONO,
              fontSize: 10.5,
              color: "var(--faint)",
              padding: "0 6px",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: running ? "var(--green)" : "var(--amber)",
                animation: running ? "ebPulse 2.4s ease-in-out infinite" : "none",
                flex: "0 0 auto",
              }}
            />
            {running && status?.poller.bootedAt
              ? `poller up ${duration(status.poller.bootedAt)} · v${status.version}`
              : `poller down${status ? ` · v${status.version}` : ""}`}
          </div>
        </div>
      </div>

      {/* ================= MAIN ================= */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* ---------- SEARCHES VIEW ---------- */}
        {view === "searches" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "24px 30px",
                borderBottom: "1px solid var(--border)",
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
                    color: "var(--muted)",
                    marginTop: 4,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: running ? "var(--green)" : "var(--amber)",
                      animation: running ? "ebPulse 2.4s ease-in-out infinite" : "none",
                    }}
                  />
                  {searches.length} searches · {active.length} active ·{" "}
                  {running ? (mock ? "polling (mock mode)" : "polling live") : "poller down"}
                </div>
              </div>
              <button
                className="hv-accent"
                onClick={() => setShowForm(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  background: "var(--accent)",
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
                margin: "20px 30px 6px",
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "15px 20px",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}
              >
                <span style={{ fontSize: 13, color: "var(--muted)" }}>
                  Projected API usage <span style={{ color: "var(--faint)" }}>· enforced global budget</span>
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13, color: "var(--text)" }}>
                  <b style={{ color: "var(--accent-text)" }}>{fmt(projected)}</b> / {fmt(ceiling)} calls·day{" "}
                  <span style={{ color: "var(--faint)" }}>· {quotaPct}%</span>
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 5, background: "var(--chip-bg)", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${quotaPct}%`,
                    height: "100%",
                    borderRadius: 5,
                    background: "linear-gradient(90deg,var(--accent),var(--accent-text))",
                  }}
                />
              </div>
            </div>

            {/* table */}
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 30px 26px" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "18px minmax(0,1fr) 150px 62px 76px 40px 100px",
                  gap: 8,
                  alignItems: "center",
                  padding: "0 14px 10px",
                  fontFamily: MONO,
                  fontSize: 10.5,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  color: "var(--faint)",
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
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {searches.length === 0 && (
                  <div style={emptyCard}>
                    No saved searches yet — create one and ebae starts watching within seconds.
                  </div>
                )}
                {searches.map((s) => {
                  const seeding = s.enabled && !s.seeded;
                  return (
                    <div
                      key={s.id}
                      className="hv-row"
                      style={{
                        display: "grid",
                        gridTemplateColumns: "18px minmax(0,1fr) 150px 62px 76px 40px 100px",
                        gap: 8,
                        alignItems: "center",
                        background: "var(--panel)",
                        border: "1px solid var(--border)",
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
                          background: s.enabled ? "var(--green)" : "var(--faint)",
                          boxShadow: s.enabled
                            ? "0 0 0 3px color-mix(in oklab, var(--green) 18%, transparent)"
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
                            color: "var(--faint)",
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
                          <span style={{ ...chip, background: "var(--accent-soft)", color: "var(--accent-text)" }}>
                            BIN
                          </span>
                        )}
                        {s.priceCap != null && (
                          <span style={{ ...chip, background: "var(--chip-bg)", color: "var(--chip-text)" }}>
                            ≤ {money(s.priceCap).replace(/\.00$/, "")}
                          </span>
                        )}
                        {s.includeAuctions && (
                          <span style={{ ...chip, background: "var(--chip-bg)", color: "var(--chip-text)" }}>
                            Auctions ok
                          </span>
                        )}
                      </div>
                      <span
                        style={{
                          textAlign: "right",
                          fontFamily: MONO,
                          fontSize: 13,
                          color: s.enabled ? (s.intervalMin <= 1 ? "var(--amber)" : "var(--text)") : "var(--faint)",
                        }}
                      >
                        {s.intervalMin} min
                      </span>
                      <span style={{ textAlign: "right", fontFamily: MONO, fontSize: 13, color: "var(--muted)" }}>
                        {s.enabled ? fmt(callsFor(s.intervalMin)) : "—"}
                      </span>
                      <span style={{ textAlign: "right", fontFamily: MONO, fontSize: 13 }}>
                        {seeding ? (
                          <span
                            style={{
                              fontSize: 9,
                              background: "color-mix(in oklab, var(--amber) 18%, transparent)",
                              color: "var(--amber)",
                              padding: "2px 6px",
                              borderRadius: 5,
                            }}
                          >
                            seed
                          </span>
                        ) : (
                          <span
                            style={{
                              color: s.hits24 > 0 ? "var(--accent-text)" : "var(--faint)",
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
                          onClick={() => togglePause(s)}
                          style={{
                            background: "transparent",
                            border: "1px solid var(--border-strong)",
                            color: "var(--muted)",
                            borderRadius: 7,
                            padding: "5px 9px",
                            fontFamily: "inherit",
                            fontSize: 11.5,
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          {s.enabled ? "Pause" : "Resume"}
                        </button>
                        <button
                          className="hv-ghost"
                          onClick={() => removeSearch(s)}
                          title="Delete search"
                          style={{
                            background: "transparent",
                            border: "1px solid var(--border-strong)",
                            color: "var(--faint)",
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
                padding: "24px 30px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" }}>Alert history</h2>
                <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
                  {visibleAlerts.length} item{visibleAlerts.length === 1 ? "" : "s"} matched · newest first
                </div>
              </div>
              <select
                value={String(alertFilter)}
                onChange={(e) => setAlertFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  color: "var(--faint)",
                  border: "1px solid var(--border)",
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
            <div style={{ flex: 1, overflowY: "auto", padding: "18px 30px 28px" }}>
              {visibleAlerts.length === 0 && (
                <div style={emptyCard}>No alerts yet — new listings show up here the moment the poller finds them.</div>
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
                            color: "var(--faint)",
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
                          gap: 15,
                          background: "var(--panel)",
                          border: "1px solid var(--border)",
                          borderRadius: 12,
                          padding: "14px 16px",
                        }}
                      >
                        {a.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={a.imageUrl}
                            alt=""
                            style={{
                              width: 66,
                              height: 66,
                              flex: "0 0 auto",
                              borderRadius: 10,
                              border: "1px solid var(--border)",
                              objectFit: "cover",
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: 66,
                              height: 66,
                              flex: "0 0 auto",
                              borderRadius: 10,
                              border: "1px solid var(--border)",
                              background:
                                "repeating-linear-gradient(45deg,var(--chip-bg) 0 5px,transparent 5px 10px),var(--panel2)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <span style={{ fontFamily: MONO, fontSize: 8, color: "var(--faint)" }}>photo</span>
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
                                color: "var(--text)",
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
                                color: "var(--faint)",
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
                            <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
                              {money(a.price, a.currency)}
                            </span>
                            <span style={{ fontSize: 12, color: "var(--faint)" }}>
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
                                    ? "var(--accent-soft)"
                                    : "color-mix(in oklab, var(--amber) 18%, transparent)",
                                color: a.buyingOption === "FIXED_PRICE" ? "var(--accent-text)" : "var(--amber)",
                              }}
                            >
                              {a.buyingOption === "FIXED_PRICE" ? "Buy It Now" : "Auction"}
                            </span>
                            {a.condition && (
                              <span
                                style={{
                                  ...chip,
                                  padding: "2px 8px",
                                  background: "var(--chip-bg)",
                                  color: "var(--chip-text)",
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
                              borderTop: "1px solid var(--border)",
                              fontSize: 12,
                              color: "var(--muted)",
                            }}
                          >
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />
                            matched <b style={{ color: "var(--text)", fontWeight: 600 }}>{a.searchQ}</b>
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
            <div style={{ padding: "24px 30px", borderBottom: "1px solid var(--border)" }}>
              <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" }}>Status</h2>
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>Poller, quota and eBay API health</div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "24px 30px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }}>
                <div style={statCard}>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 10 }}>Poller</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        background: running ? "var(--green)" : "var(--amber)",
                        animation: running ? "ebPulse 2.4s ease-in-out infinite" : "none",
                      }}
                    />
                    <span style={{ fontSize: 19, fontWeight: 700 }}>{running ? "Running" : "Stopped"}</span>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--faint)", marginTop: 8 }}>
                    {running && status?.poller.bootedAt
                      ? `uptime ${duration(status.poller.bootedAt)} · ${status.poller.timers} timer${status.poller.timers === 1 ? "" : "s"}`
                      : (status?.bootError ?? "not started")}
                  </div>
                </div>
                <div style={statCard}>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 10 }}>eBay Browse token</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        background: mock ? "var(--amber)" : "var(--green)",
                      }}
                    />
                    <span style={{ fontSize: 19, fontWeight: 700 }}>
                      {mock ? "Mock mode" : status?.ebay.tokenExpiresAt ? "Valid" : "Not fetched"}
                    </span>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--faint)", marginTop: 8 }}>
                    {mock
                      ? `set EBAY_CLIENT_ID to go live · ${status?.ebay.marketplace ?? "EBAY_US"}`
                      : status?.ebay.tokenExpiresAt
                        ? `refreshes in ${until(status.ebay.tokenExpiresAt)} · ${status.ebay.marketplace}`
                        : `fetched on first poll · ${status?.ebay.marketplace ?? "EBAY_US"}`}
                  </div>
                </div>
                <div style={statCard}>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 10 }}>Quota today</div>
                  <div style={{ fontSize: 19, fontWeight: 700, fontFamily: MONO }}>
                    {fmt(status?.quota.used ?? 0)}{" "}
                    <span style={{ color: "var(--faint)", fontWeight: 400, fontSize: 14 }}>/ {fmt(ceiling)}</span>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--faint)", marginTop: 8 }}>
                    {Math.round(((status?.quota.used ?? 0) / ceiling) * 100)}% of daily budget
                  </div>
                </div>
              </div>

              {status?.errors.length ? (
                <div
                  style={{
                    background: "var(--panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: "13px 18px",
                      borderBottom: "1px solid var(--border)",
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--muted)",
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
                        borderBottom: i < status.errors.length - 1 ? "1px solid var(--border)" : "none",
                        fontFamily: MONO,
                        fontSize: 12,
                        alignItems: "baseline",
                      }}
                    >
                      <span style={{ color: "var(--faint)", whiteSpace: "nowrap" }}>{ago(err.time, true)}</span>
                      {err.searchQ && (
                        <span style={{ color: "var(--accent-text)", whiteSpace: "nowrap" }}>{err.searchQ}</span>
                      )}
                      <span style={{ color: "var(--muted)", overflowWrap: "anywhere" }}>{err.message}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    background: "var(--panel)",
                    border: "1px solid var(--border)",
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
                      border: "1px solid var(--border)",
                      background: "var(--panel2)",
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
                        border: "2px solid var(--green)",
                        borderRightColor: "transparent",
                        transform: "rotate(45deg)",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>No API errors in the last 24h</div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 5, maxWidth: 360, lineHeight: 1.5 }}>
                    All searches are polling on schedule. Failed calls back off exponentially and surface here.
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

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
              maxWidth: "calc(100vw - 40px)",
              background: "var(--panel)",
              border: "1px solid var(--border-strong)",
              borderRadius: 16,
              boxShadow: "0 40px 90px -30px oklch(0.1 0.05 265 / .7)",
              overflow: "hidden",
              animation: "ebModalIn .18s cubic-bezier(.2,.7,.3,1)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "20px 24px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>New saved search</h3>
              <div
                className="hv-dim"
                onClick={() => setShowForm(false)}
                style={{ cursor: "pointer", color: "var(--faint)", fontSize: 18, lineHeight: 1, padding: 4 }}
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
              <div style={{ display: "flex", gap: 14 }}>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabel}>Category ID</label>
                  <input
                    className="eb-input"
                    value={form.categoryId}
                    onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                    placeholder="all categories"
                    style={inputBox}
                  />
                </div>
                <div style={{ width: 150 }}>
                  <label style={fieldLabel}>Max price</label>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      background: "var(--input-bg)",
                      border: "1px solid var(--border-strong)",
                      borderRadius: 9,
                      padding: "0 13px",
                    }}
                  >
                    <span style={{ color: "var(--faint)", fontFamily: MONO, fontSize: 14 }}>$</span>
                    <input
                      value={form.priceCap}
                      onChange={(e) => setForm({ ...form, priceCap: e.target.value })}
                      placeholder="2500"
                      inputMode="decimal"
                      style={{
                        width: "100%",
                        background: "transparent",
                        border: "none",
                        padding: "11px 8px",
                        fontFamily: MONO,
                        fontSize: 14,
                        color: "var(--text)",
                        outline: "none",
                      }}
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
                          border: `1px solid ${on ? "var(--accent)" : "var(--border-strong)"}`,
                          background: on ? "var(--accent-soft)" : "var(--input-bg)",
                          color: on ? "var(--accent-text)" : "var(--muted)",
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
                        background: "var(--input-bg)",
                        border: "1px solid var(--border-strong)",
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
                          background: on ? "var(--accent)" : "var(--border-strong)",
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
                  background: "var(--accent-soft)",
                  borderRadius: 9,
                  padding: "11px 14px",
                  fontSize: 12.5,
                  color: "var(--accent-text)",
                }}
              >
                <span style={{ fontFamily: MONO, fontWeight: 600 }}>≈ {fmt(callsFor(form.interval))} calls·day</span>
                <span style={{ color: "var(--muted)" }}>
                  · first poll seeds silently — no alert spam from existing listings
                </span>
              </div>
              {formError && (
                <div
                  style={{
                    background: "color-mix(in oklab, var(--amber) 14%, transparent)",
                    borderRadius: 9,
                    padding: "10px 14px",
                    fontSize: 12.5,
                    color: "var(--amber)",
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
                borderTop: "1px solid var(--border)",
                background: "var(--panel2)",
              }}
            >
              <button
                className="hv-nav"
                onClick={() => setShowForm(false)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border-strong)",
                  color: "var(--text)",
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
                onClick={createSearch}
                disabled={saving}
                style={{
                  background: "var(--accent)",
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
                {saving ? "Creating…" : "Create search"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
