"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import {
  LS_CACHE,
  LS_DISABLED,
  LS_LAST_SEEN,
  RELEASES_PAGE,
  RELEASES_URL,
  WHATSNEW_EVENT,
  parseReleaseBody,
  parseSemver,
  read,
  selectReleases,
  semverGt,
  store,
  type GhRelease,
} from "@/lib/whatsnew";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const CACHE_TTL = 6 * 60 * 60 * 1000;

/** The feed is public and immutable per tag, so a few hours of staleness costs nothing and keeps us clear of GitHub's unauthenticated rate limit. */
async function loadReleases(): Promise<GhRelease[] | null> {
  try {
    const raw = localStorage.getItem(LS_CACHE);
    if (raw) {
      const cached = JSON.parse(raw) as { at: number; releases: GhRelease[] };
      if (Date.now() - cached.at < CACHE_TTL) return cached.releases;
    }
  } catch {
    // corrupt cache entry - fall through and refetch
  }
  try {
    const res = await fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const feed = (await res.json()) as GhRelease[];
    // Keep only what we render: the raw feed is ~10x larger and would dominate localStorage.
    const releases = feed.map((r) => ({
      tag_name: r.tag_name,
      published_at: r.published_at,
      body: r.body,
      html_url: r.html_url,
    }));
    store(LS_CACHE, JSON.stringify({ at: Date.now(), releases }));
    return releases;
  } catch {
    // offline, blocked or rate-limited: no notes this load, and lastSeen stays put
    return null;
  }
}

export function WhatsNewDialog({ version }: { version: string }) {
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState("");
  const [releases, setReleases] = useState<GhRelease[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [dontShow, setDontShow] = useState(false);

  useEffect(() => {
    if (!parseSemver(version)) return; // dev builds and prereleases never pop
    if (read(LS_DISABLED) === "1") return;

    const seen = read(LS_LAST_SEEN) ?? "";
    if (!parseSemver(seen)) {
      // First run on this browser: record where they came in, show nothing.
      store(LS_LAST_SEEN, version);
      return;
    }
    if (!semverGt(version, seen)) return;

    let cancelled = false;
    loadReleases().then((feed) => {
      if (cancelled || !feed) return;
      const picked = selectReleases(feed, seen, version);
      const worthShowing = picked.some((r) => {
        const { highlights, groups } = parseReleaseBody(r.body);
        return highlights.length > 0 || groups.length > 0;
      });
      if (!worthShowing) {
        // Only bank the version once the feed proves it exists. A cache taken minutes
        // before the upgrade, or a tag GitHub hasn't published yet, would otherwise
        // retire this release's notes without ever showing them.
        if (feed.some((r) => r.tag_name.replace(/^v/, "") === version)) store(LS_LAST_SEEN, version);
        return;
      }
      setSince(seen);
      setReleases(picked);
      setOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);

  // Every exit counts as read - the X, Escape, click-outside and "Got it" all land here.
  function dismiss() {
    store(LS_LAST_SEEN, version);
    if (dontShow) {
      store(LS_DISABLED, "1");
      // Status & Settings may be on screen behind this dialog, showing the old value.
      window.dispatchEvent(new Event(WHATSNEW_EVENT));
    }
    setOpen(false);
  }

  // Unmount rather than render a closed Dialog: Radix's exit animation never completes
  // here, which leaves the dismissed dialog on screen for good.
  if (!open) return null;

  const parsed = releases.map((r) => ({
    ver: r.tag_name.replace(/^v/, ""),
    date: new Date(r.published_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    ...parseReleaseBody(r.body),
  }));
  const cards = parsed.flatMap((r) => r.highlights.map((h) => ({ ...h, ver: r.ver })));
  // Only claim a provenance when the whole window agrees on one.
  const auto = cards.length > 0 && cards.every((c) => c.meta);
  const curated = cards.length > 0 && cards.every((c) => !c.meta);
  const entries = parsed.flatMap((r) => r.groups);
  const fixes = entries.filter((g) => g.title === "Fixes").reduce((n, g) => n + g.entries.length, 0);
  const maint = entries
    .filter((g) => g.title !== "Fixes" && g.title !== "Features")
    .reduce((n, g) => n + g.entries.length, 0);

  const newest = parsed[0].ver;
  const oldest = parsed[parsed.length - 1].ver;
  const range =
    `${parsed.length} release${parsed.length === 1 ? "" : "s"} since v${since} · v${oldest}` +
    (parsed.length === 1 ? "" : ` → v${newest}`);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[544px]">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-[22px] pb-5">
          <DialogHeader className="gap-0">
            <span className="font-mono text-[11px] font-semibold tracking-[0.16em] text-[var(--eb-accent-text)] uppercase">
              What&apos;s new
            </span>
            <DialogTitle className="mt-3 text-[22px] font-bold tracking-[-0.02em]">What&apos;s new in ebae</DialogTitle>
            <DialogDescription className="mt-[5px] font-mono text-xs text-[var(--eb-faint)]">{range}</DialogDescription>
          </DialogHeader>

          {cards.length > 0 && (
            <>
              {(auto || curated) && (
                <div className="mt-[18px] flex items-center gap-2">
                  <span
                    className="size-[7px] flex-shrink-0 rounded-[2px]"
                    style={{ background: auto ? "var(--eb-green)" : "var(--eb-accent)" }}
                  />
                  <span className="font-mono text-[11px] text-[var(--eb-faint)]">
                    {auto ? "Auto-generated from feat: commits" : "Written by the maintainer for this release"}
                  </span>
                </div>
              )}

              <div className="mt-3 flex flex-col gap-3.5">
                {cards.map((c, i) => (
                  <div key={`${c.ver}-${i}`} className="flex items-start gap-3.5">
                    <div className="w-[54px] flex-shrink-0 rounded-lg bg-[var(--eb-accent-soft)] py-1.5 text-center font-mono text-[11px] font-semibold text-[var(--eb-accent-text)]">
                      {c.ver}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14.5px] font-semibold text-pretty">{c.title}</span>
                        {i === 0 && (
                          <span className="rounded-[5px] bg-[var(--eb-accent)] px-1.5 py-[2px] font-mono text-[9.5px] font-semibold tracking-[0.1em] text-white">
                            NEW
                          </span>
                        )}
                      </div>
                      {c.body && (
                        <div className="mt-[3px] text-[12.5px] leading-[1.55] text-muted-foreground text-pretty">
                          {c.body}
                        </div>
                      )}
                      {c.meta && <div className="mt-1 font-mono text-[10.5px] text-[var(--eb-faint)]">{c.meta}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {fixes + maint > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              className="mt-[18px] flex w-full cursor-pointer items-center justify-between gap-2 rounded-[9px] border bg-[var(--eb-panel2)] px-3 py-2.5 text-left hover:bg-[var(--eb-chip-bg)]"
            >
              <span className="text-[12.5px] text-muted-foreground">
                Also shipped: {fixes} fix{fixes === 1 ? "" : "es"} · {maint} maintenance
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--eb-accent-text)]">
                {expanded ? "Hide changelog" : "Full changelog"}
                <ChevronDown className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </span>
            </button>
          )}

          {expanded && (
            <div className="mt-3 flex flex-col gap-4">
              {parsed
                .filter((r) => r.groups.length > 0)
                .map((r) => (
                  <div key={r.ver}>
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[13px] font-semibold text-[var(--eb-accent-text)]">v{r.ver}</span>
                      <span className="font-mono text-[10.5px] text-[var(--eb-faint)]">{r.date}</span>
                    </div>
                    <div className="mt-2 flex flex-col gap-2.5">
                      {r.groups.map((g) => (
                        <div key={g.title}>
                          <div className="mb-1 font-mono text-[10px] tracking-[0.1em] text-[var(--eb-faint)] uppercase">
                            {g.title}
                          </div>
                          <div className="flex flex-col gap-1">
                            {g.entries.map((e) => (
                              <div key={e.hash} className="flex items-baseline gap-2">
                                <span className="flex-shrink-0 font-mono text-[10.5px] text-[var(--eb-accent-text)]">
                                  {e.hash}
                                </span>
                                <span className="text-xs leading-[1.5] text-muted-foreground text-pretty">
                                  {e.text}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>

        <DialogFooter className="m-0 flex-shrink-0 flex-row items-center justify-between gap-3 bg-[var(--eb-panel2)] px-6 py-3.5 sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2.5 text-[12.5px] text-muted-foreground">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              className="size-[15px] cursor-pointer accent-[var(--eb-accent)]"
            />
            Don&apos;t show release notes
          </label>
          <div className="flex items-center gap-2.5">
            <a
              href={RELEASES_PAGE}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--eb-faint)] hover:text-[var(--eb-accent-text)]"
            >
              GitHub
              <ExternalLink className="size-3 shrink-0" />
            </a>
            <Button onClick={dismiss}>Got it</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
