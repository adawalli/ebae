import { buyingOptionLabel, money } from "./format";
import { log } from "./log";
import type { Item, PriceContext, Search } from "./types";

const dlog = log.child({ component: "discord" });

// "Is this a deal?" at a glance. basis "sold" = median of what this search's tracked listings
// actually realized (labeled "Sold", the strongest answer there is); basis "market" = a
// dedicated unfiltered market sample (labeled "Market", trusted on its own); basis "recent" =
// median of this search's prior in-band alerts (labeled "Typical"). Both counted bases are
// gated on >=3 so a single data point can't masquerade as a going rate; the market sample
// carries its own sample size and is exempt. Needs a price and a positive baseline, else null
// and the field is omitted. Pure + exported.
const DEAL_LABELS = { sold: "Sold", market: "Market", recent: "Typical" } as const;

export function dealField(item: Item, ctx?: PriceContext): { name: string; value: string; inline: boolean } | null {
  // typical <= 0 (e.g. a $0 starting-bid auction dominating the sample) would make the
  // percentage divide by zero -> "Infinity% over"; treat it as no usable baseline.
  if (!ctx || ctx.typical == null || ctx.typical <= 0 || item.price == null) return null;
  if (ctx.basis !== "market" && ctx.count < 3) return null; // a counted median needs a real sample
  const pct = Math.round(((item.price - ctx.typical) / ctx.typical) * 100);
  const rel = pct <= -1 ? `▼ ${-pct}% under` : pct >= 1 ? `▲ ${pct}% over` : "≈ typical";
  return { name: DEAL_LABELS[ctx.basis], value: `${money(ctx.typical, item.currency)} · ${rel}`, inline: true };
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
          { name: "Type", value: buyingOptionLabel(item.buyingOption), inline: true },
          { name: "Condition", value: item.condition ?? "—", inline: true },
          ...(deal ? [deal] : []),
        ],
        footer: { text: `ebae · matched "${search.q}"` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// A rate-limited webhook must not stall the poll loop, so a 429's wait is honored but capped.
const DISCORD_MAX_RETRY_MS = 10_000;

// Discord reports a 429 wait as retry_after (fractional seconds) in the JSON body, with a
// Retry-After header (integer seconds) as the backup. Returns the wait in ms, capped, or 0 when
// neither is usable - notify() then keeps its own default backoff. Pure + exported for tests.
export function discordRetryMs(res: Response, body: string): number {
  let secs = NaN;
  try {
    secs = (JSON.parse(body) as { retry_after?: number }).retry_after ?? NaN;
  } catch {
    // non-JSON body (a gateway/proxy 429 page): fall back to the header
  }
  if (!Number.isFinite(secs)) secs = Number(res.headers.get("retry-after"));
  if (!Number.isFinite(secs) || secs < 0) return 0;
  return Math.min(secs * 1000, DISCORD_MAX_RETRY_MS);
}

// Sends to every webhook; retries each a few times. Never throws - a dead webhook must not
// stall the poll loop (DESIGN.md failure behavior). Returns `error` (the last failure, for the
// UI log) and `anyDelivered` (at least one webhook accepted it). The caller treats anyDelivered
// as "delivered": an alert is redelivered only while NO channel has it, so a retry can't
// re-post to a channel that already received it.
export async function notify(
  item: Item,
  search: Search,
  webhookUrls: string[],
  ctx?: PriceContext,
): Promise<{ error: string | null; anyDelivered: boolean }> {
  const body = JSON.stringify(embed(item, search, ctx));
  let lastError: string | null = null;
  let anyDelivered = false;
  // index-based: logs identify a webhook by position, never its URL (secret token)
  for (let i = 0; i < webhookUrls.length; i++) {
    const url = webhookUrls[i];
    let err: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      dlog.debug({ webhook: i, attempt }, "attempt");
      let waitMs = attempt * 2000; // default backoff; a 429 overrides it with the server's own hint
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        const text = await res.text();
        if (res.ok) {
          err = null;
          anyDelivered = true;
          dlog.debug({ webhook: i, attempt }, "delivered");
          break;
        }
        err = `Discord webhook ${res.status}`;
        if (res.status === 429) waitMs = discordRetryMs(res, text) || waitMs;
      } catch (e) {
        // e.name only: fetch error messages can echo the webhook URL (its secret token)
        err = `Discord webhook send failed (${e instanceof Error ? e.name : "error"})`;
      }
      if (err && attempt < 3) {
        dlog.warn({ webhook: i, attempt, err }, "webhook retry");
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    // terminal failure is not logged here: notify() returns it and the poller
    // logs it once at error level (recordError(..., "error")).
    if (err) lastError = err;
  }
  return { error: lastError, anyDelivered };
}
