"use client";

import type { Dispatch, SetStateAction } from "react";
import { Inbox } from "lucide-react";
import type { Alert, SearchStats } from "@/lib/types";
import { ago, dayLabel, money } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { NativeSelect } from "@/components/ui/native-select";

export function AlertsView({
  visibleAlerts,
  searches,
  alertFilter,
  setAlertFilter,
  failedImg,
  setFailedImg,
  clearAlerts,
}: {
  visibleAlerts: Alert[];
  searches: SearchStats[];
  alertFilter: "all" | number;
  setAlertFilter: (f: "all" | number) => void;
  failedImg: Set<number>;
  setFailedImg: Dispatch<SetStateAction<Set<number>>>;
  clearAlerts: () => void;
}) {
  return (
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
  );
}
