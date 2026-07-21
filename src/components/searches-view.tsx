"use client";

import { ExternalLink, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { CONDITION_BADGE, type ConditionKey, type SearchStats, type StatusInfo } from "@/lib/types";
import { splitExcludeTerms } from "@/lib/exclude-terms";
import { ebayWebUrl } from "@/lib/utils";
import { ago, fmt, money, priceSummary, shownSurplus } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

const interval = (minutes: number) => (Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1));

export function SearchesView({
  searches,
  active,
  projected,
  ceiling,
  quotaPct,
  running,
  mock,
  noCreds,
  status,
  openCreate,
  openEdit,
  togglePause,
  removeSearch,
}: {
  searches: SearchStats[];
  active: SearchStats[];
  projected: number;
  ceiling: number;
  quotaPct: number;
  running: boolean;
  mock: boolean;
  noCreds: boolean;
  status: StatusInfo | null;
  openCreate: () => void;
  openEdit: (s: SearchStats) => void;
  togglePause: (s: SearchStats) => void;
  removeSearch: (s: SearchStats) => void;
}) {
  const quota = status?.quota;
  const forecast = quota?.configuredForecast ?? projected;
  const forecastPct = Math.min(100, Math.round((forecast / ceiling) * 100));
  const spentPct = quota ? Math.min(100, (quota.used / ceiling) * 100) : 0;
  // The spent bar splits in two: what the configuration asked for, then the surplus sold checks
  // riding on quota that expires tonight. Same total width as before, so `requested` still starts
  // at spentPct - a day with no surplus draws exactly the two-segment bar it always did.
  const surplus = shownSurplus(quota?.surplus ?? 0, ceiling);
  const configuredPct = quota ? Math.min(100, ((quota.used - surplus) / ceiling) * 100) : 0;
  const surplusPct = Math.min(100 - configuredPct, (surplus / ceiling) * 100);
  const requestedPct = quota ? Math.min(100 - spentPct, (quota.configuredRemaining / ceiling) * 100) : 0;
  const overagePct = quota ? Math.min(20, (quota.overage / ceiling) * 100) : 0;

  function searchSub(s: SearchStats) {
    if (!s.enabled) return "paused";
    if (!s.seeded) return "seeding baseline — first matches silenced";
    const hit = s.lastHitAt ? `last hit ${ago(s.lastHitAt, true)}` : "no hits yet";
    const baseline = priceSummary(s, status?.ebay.currency);
    return `${hit} · seen ${fmt(s.seenCount)}${baseline}`;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col items-stretch justify-between gap-3.5 border-b p-4 md:flex-row md:items-center md:gap-0 md:px-[30px] md:py-6">
        <div>
          <h2 className="text-[21px] font-bold tracking-[-0.01em]">Saved searches</h2>
          <div className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground">
            <span
              className="size-1.5 rounded-full"
              style={{
                background: running && !noCreds ? "var(--eb-green)" : "var(--eb-amber)",
                animation: running && !noCreds ? "ebPulse 2.4s ease-in-out infinite" : undefined,
              }}
            />
            {searches.length} searches · {active.length} active ·{" "}
            {!running
              ? "poller down"
              : noCreds
                ? "paused — no eBay keys"
                : mock
                  ? "polling (mock mode)"
                  : "polling live"}
          </div>
        </div>
        <Button onClick={openCreate} className="justify-center md:justify-start">
          <Plus /> New search
        </Button>
      </div>

      {/* quota strip */}
      <Card className="mx-4 mt-4 mb-1.5 overflow-visible md:mx-[30px] md:mt-5">
        <CardContent>
          <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-1.5">
            <span className="text-[13px] text-muted-foreground">
              {quota ? "Today at your intervals" : "Configured API usage"}{" "}
              <span className="text-[var(--eb-faint)]">· enforced global budget</span>
            </span>
            <span className="font-mono text-[13px] text-foreground">
              <b className={quota?.overage ? "text-[var(--eb-amber)]" : "text-[var(--eb-accent-text)]"}>
                {fmt(forecast)}
              </b>{" "}
              / {fmt(ceiling)} calls <span className="text-[var(--eb-faint)]">· {forecastPct}%</span>
            </span>
          </div>
          {quota ? (
            <>
              <div className="relative h-2 overflow-visible rounded-full bg-[var(--eb-faint)]/15">
                <span
                  className="absolute inset-y-0 left-0 rounded-l-full bg-[var(--eb-accent)]"
                  style={{ width: `${configuredPct}%` }}
                />
                {surplus > 0 && (
                  <span
                    className="absolute inset-y-0 bg-[var(--eb-accent)]/40"
                    style={{ left: `${configuredPct}%`, width: `${surplusPct}%` }}
                  />
                )}
                <span
                  className="absolute inset-y-0 bg-[var(--eb-accent-text)]/75"
                  style={{ left: `${spentPct}%`, width: `${requestedPct}%` }}
                />
                {quota.overage > 0 && (
                  <span
                    className="absolute inset-y-0 rounded-r-full bg-[var(--eb-amber)]"
                    style={{ left: "100%", width: `${overagePct}%` }}
                  />
                )}
              </div>
              {/* Swatches appear only alongside a surplus segment: with two colours the labels
                  are unambiguous on their own, and a normal day keeps the legend it always had. */}
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--eb-faint)]">
                <span className={surplus > 0 ? "flex items-center gap-1.5" : undefined}>
                  {surplus > 0 && <span className="size-2 rounded-[2px] bg-[var(--eb-accent)]" />}
                  {fmt(quota.used - surplus)} spent
                </span>
                {surplus > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-[2px] bg-[var(--eb-accent)]/40" />
                    {fmt(surplus)} surplus
                  </span>
                )}
                <span className={surplus > 0 ? "flex items-center gap-1.5" : undefined}>
                  {surplus > 0 && <span className="size-2 rounded-[2px] bg-[var(--eb-accent-text)]/75" />}
                  {fmt(quota.configuredRemaining)} requested
                </span>
                {quota.overage > 0 ? (
                  <span className="text-[var(--eb-amber)]">{fmt(quota.overage)} to slow down</span>
                ) : (
                  // `quota.remaining` is ceiling - used, which already contains `requested` - so
                  // the legend read as a partition of the ceiling but summed past it. Report the
                  // headroom neither spent nor claimed, which is the bar's own grey tail.
                  <span>{fmt(quota.remaining - quota.configuredRemaining)} spare</span>
                )}
              </div>
              {quota.governor.active && (
                <div className="mt-1 font-mono text-[11px] text-[var(--eb-amber)]">
                  Governor active · polling at {quota.governor.factor.toFixed(1)}× your intervals to finish inside
                  today&apos;s budget
                </div>
              )}
            </>
          ) : (
            <div className="h-2 overflow-hidden rounded-full bg-[var(--eb-faint)]/15">
              <span className="block h-full rounded-full bg-[var(--eb-accent)]" style={{ width: `${quotaPct}%` }} />
            </div>
          )}
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
            const exclusions = splitExcludeTerms(s.excludeTerms);
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
                        animation: s.enabled && s.intervalMin <= 2 ? "ebPulse 2.4s ease-in-out infinite" : undefined,
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
                    {s.conditions && (
                      <Badge variant="secondary" className="font-mono">
                        {CONDITION_BADGE[s.conditions as ConditionKey] ?? s.conditions}
                      </Badge>
                    )}
                    {exclusions.length > 0 && (
                      <Badge variant="secondary" className="font-mono" title={`Excludes: ${exclusions.join(", ")}`}>
                        −{exclusions.length} excluded
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
                      {interval(s.intervalMin)}
                      <span className="md:hidden">m</span>
                      <span className="hidden md:inline"> min</span>
                      {/* Only when the governor has actually stretched this search: showing the
                          configured interval alone would be a lie about when it next polls. */}
                      {s.enabled && s.effectiveIntervalMin > s.intervalMin && (
                        <span
                          className="ml-1 text-[var(--eb-amber)]"
                          title="Slowed to keep today's polling inside your daily eBay budget. Your configured interval is unchanged."
                        >
                          → {interval(s.effectiveIntervalMin)}
                          <span className="md:hidden">m</span>
                          <span className="hidden md:inline"> min</span>
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground md:text-right md:text-[13px]">
                      {s.enabled ? (
                        <>
                          {fmt(s.callsPerDay)}
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
                    <Button variant="outline" size="sm" className="flex-1 md:flex-none" onClick={() => togglePause(s)}>
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
  );
}
