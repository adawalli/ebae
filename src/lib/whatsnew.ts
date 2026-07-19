// Release-notes modal state and parsing. The notes come straight from the GitHub
// releases feed, so everything here is client-side: no server route, no DB.

export const LS_LAST_SEEN = "ebae:whatsnew:lastSeen";
export const LS_DISABLED = "ebae:whatsnew:disabled";
export const LS_CACHE = "ebae:whatsnew:cache";

export const RELEASES_URL = "https://api.github.com/repos/adawalli/ebae/releases?per_page=20";
export const RELEASES_PAGE = "https://github.com/adawalli/ebae/releases";

export type GhRelease = { tag_name: string; published_at: string; body: string | null; html_url: string };
export type HighlightCard = { title: string; body: string; meta: string | null };
export type ChangelogEntry = { hash: string; text: string };
export type ChangelogGroup = { title: string; entries: ChangelogEntry[] };

/** Fires when the modal changes the settings, so the Status & Settings switch can follow without a remount. */
export const WHATSNEW_EVENT = "ebae:whatsnew";

/**
 * localStorage throws outright when site data is blocked (Safari private mode, Chrome's
 * "block third-party cookies" on some origins) and on a full quota. Release notes are
 * never worth taking the page down, so both directions degrade to "no notes this load".
 */
export function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // out of quota or blocked - nothing to recover
  }
}

export function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Strict x.y.z only. Rejects "dev" (the Docker default) and prereleases, so unreleased builds never pop the modal. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function semverGt(a: string, b: string): boolean {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

/** Releases the user hasn't seen yet and this build actually contains: (lastSeen, current], newest first. */
export function selectReleases(releases: GhRelease[], lastSeen: string, current: string): GhRelease[] {
  return releases
    .filter((r) => {
      const v = r.tag_name.replace(/^v/, "");
      return parseSemver(v) !== null && semverGt(v, lastSeen) && !semverGt(v, current);
    })
    .sort((a, b) => (semverGt(a.tag_name.replace(/^v/, ""), b.tag_name.replace(/^v/, "")) ? -1 : 1));
}

// Em dash, en dash or hyphen: the separator is hand-typed into an annotated tag.
const HIGHLIGHT = /^\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/;
const ENTRY = /^\* ([0-9a-f]{7,40}) (.+)$/;

/**
 * goreleaser writes `## Highlights` (from the annotated tag body) then `## Changelog`
 * with `### Group` sections of `* <hash> <type>: <message>`. Anything else in the body -
 * the `## Container image` fence - is skipped by only reading those two sections.
 */
export function parseReleaseBody(body: string | null): { highlights: HighlightCard[]; groups: ChangelogGroup[] } {
  const highlights: HighlightCard[] = [];
  const groups: ChangelogGroup[] = [];
  let section = "";
  let group: ChangelogGroup | null = null;
  let card: HighlightCard | null = null;

  for (const line of (body ?? "").split("\n")) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      group = null;
      card = null;
      continue;
    }
    if (section === "Highlights") {
      const m = HIGHLIGHT.exec(line.trim());
      if (m) {
        card = { title: m[1].trim(), body: m[2].trim(), meta: null };
        highlights.push(card);
      } else if (card && line.trim()) {
        // A tag body wraps its prose, so keep reading until the blank line that ends the entry.
        card.body += ` ${line.trim()}`;
      } else {
        card = null;
      }
      continue;
    }
    if (section !== "Changelog") continue;
    if (line.startsWith("### ")) {
      group = { title: line.slice(4).trim(), entries: [] };
      groups.push(group);
      continue;
    }
    const m = ENTRY.exec(line.trim());
    if (m && group) group.entries.push({ hash: m[1], text: m[2].trim() });
  }

  // No curated highlights: promote the features, which is the best guess at what a
  // user would call news. A fixes-only release then simply has no cards.
  if (highlights.length === 0) {
    for (const entry of groups.flatMap((g) => g.entries)) {
      // The `!` is Conventional Commits' breaking-change marker - the most newsworthy
      // commit of all, so it must not be the one entry that fails to become a card.
      const m = /^feat(?:\([^)]*\))?!?: (.+)$/.exec(entry.text);
      if (m) {
        highlights.push({
          title: m[1].charAt(0).toUpperCase() + m[1].slice(1),
          body: "",
          meta: `feat · ${entry.hash}`,
        });
      }
    }
  }

  return { highlights, groups: groups.filter((g) => g.entries.length > 0) };
}
