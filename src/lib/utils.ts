import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { splitExcludeTerms } from "./exclude-terms";
import type { Search } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Keep these keys in sync with MARKETPLACE_CURRENCY in ebay.ts — same marketplace
// set. An entry added there but not here silently falls back to ebay.com below.
const EBAY_DOMAIN: Record<string, string> = {
  EBAY_US: "ebay.com",
  EBAY_CA: "ebay.ca",
  EBAY_GB: "ebay.co.uk",
  EBAY_AU: "ebay.com.au",
  EBAY_DE: "ebay.de",
  EBAY_FR: "ebay.fr",
  EBAY_IT: "ebay.it",
  EBAY_ES: "ebay.es",
};

// Live eBay web search mirroring a saved search's filters, newest first — the
// same slice the poller watches, so you can eyeball what a query matches.
// _sop=10 = "Time: newly listed"; LH_BIN=1 = Buy It Now only (dropped when
// auctions are allowed). Kept client-safe (no env/token code) so page.tsx can
// import it. ponytail: US web params; other marketplaces map by domain only.
export function ebayWebUrl(
  s: Pick<Search, "q" | "categoryId" | "priceFloor" | "priceCap" | "includeAuctions" | "excludeTerms">,
  marketplace = "EBAY_US",
): string {
  const domain = EBAY_DOMAIN[marketplace] ?? "ebay.com";
  const p = new URLSearchParams({ _nkw: s.q, _sacat: s.categoryId ?? "0", _sop: "10" });
  const exclusions = splitExcludeTerms(s.excludeTerms).filter((term) => !term.includes('"'));
  if (exclusions.length) p.set("_nkw", `${s.q} ${exclusions.map((term) => `-"${term}"`).join(" ")}`);
  if (!s.includeAuctions) p.set("LH_BIN", "1");
  if (s.priceFloor != null) p.set("_udlo", String(s.priceFloor));
  if (s.priceCap != null) p.set("_udhi", String(s.priceCap));
  return `https://www.${domain}/sch/i.html?${p}`;
}
