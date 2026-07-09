import { log } from "./log";
import type { Item, PriceContext, Search } from "./types";

const dlog = log.child({ component: "discord" });

function money(n: number | null, currency: string) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

// "Is this a deal?" at a glance: compares the listing to the median of recent alerts
// for the same search. Needs a real sample (>=3 priced alerts) and a price to compare,
// else null and the field is omitted. Pure + exported for tests.
export function dealField(item: Item, ctx?: PriceContext): { name: string; value: string; inline: boolean } | null {
  // typical <= 0 (e.g. a $0 starting-bid auction dominating the sample) would make the
  // percentage divide by zero -> "Infinity% over"; treat it as no usable baseline.
  if (!ctx || ctx.typical == null || ctx.typical <= 0 || ctx.count < 3 || item.price == null) return null;
  const pct = Math.round(((item.price - ctx.typical) / ctx.typical) * 100);
  const rel = pct <= -1 ? `▼ ${-pct}% under` : pct >= 1 ? `▲ ${pct}% over` : "≈ typical";
  return { name: "Typical", value: `${money(ctx.typical, item.currency)} · ${rel}`, inline: true };
}

// DESIGN.md §5: thumbnail, linked title, price/type/condition fields, matched-search footer
function embed(item: Item, search: Search, ctx?: PriceContext) {
  const ship =
    item.shippingCost == null
      ? ""
      : item.shippingCost === 0
        ? " · free shipping"
        : ` + ${money(item.shippingCost, item.currency)} ship`;
  const deal = dealField(item, ctx);
  return {
    embeds: [
      {
        title: (item.title ?? "Untitled listing").slice(0, 256),
        url: item.itemUrl,
        color: 0x21a2c4,
        thumbnail: item.imageUrl ? { url: item.imageUrl } : undefined,
        fields: [
          { name: "Price", value: money(item.price, item.currency) + ship, inline: true },
          { name: "Type", value: item.buyingOption === "FIXED_PRICE" ? "Buy It Now" : "Auction", inline: true },
          { name: "Condition", value: item.condition ?? "—", inline: true },
          ...(deal ? [deal] : []),
        ],
        footer: { text: `ebae · matched "${search.q}"` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// Sends to every webhook; retries each a few times. Never throws - a dead
// webhook must not stall the poll loop (DESIGN.md failure behavior).
export async function notify(
  item: Item,
  search: Search,
  webhookUrls: string[],
  ctx?: PriceContext,
): Promise<string | null> {
  const body = JSON.stringify(embed(item, search, ctx));
  let lastError: string | null = null;
  // index-based: logs identify a webhook by position, never its URL (secret token)
  for (let i = 0; i < webhookUrls.length; i++) {
    const url = webhookUrls[i];
    let err: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      dlog.debug({ webhook: i, attempt }, "attempt");
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (res.ok) {
          err = null;
          dlog.debug({ webhook: i, attempt }, "delivered");
          break;
        }
        err = `Discord webhook ${res.status}`;
      } catch (e) {
        // e.name only: fetch error messages can echo the webhook URL (its secret token)
        err = `Discord webhook send failed (${e instanceof Error ? e.name : "error"})`;
      }
      if (err && attempt < 3) {
        dlog.warn({ webhook: i, attempt, err }, "webhook retry");
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    // terminal failure is not logged here: notify() returns it and the poller
    // logs it once at error level (recordError(..., "error")).
    if (err) lastError = err;
  }
  return lastError;
}
