import type { Item, Search } from "./types";

function money(n: number | null, currency: string) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

// DESIGN.md §5: thumbnail, linked title, price/type/condition fields, matched-search footer
function embed(item: Item, search: Search) {
  const ship =
    item.shippingCost == null
      ? ""
      : item.shippingCost === 0
        ? " · free shipping"
        : ` + ${money(item.shippingCost, item.currency)} ship`;
  return {
    embeds: [
      {
        title: item.title.slice(0, 256),
        url: item.itemUrl,
        color: 0x21a2c4,
        thumbnail: item.imageUrl ? { url: item.imageUrl } : undefined,
        fields: [
          { name: "Price", value: money(item.price, item.currency) + ship, inline: true },
          { name: "Type", value: item.buyingOption === "FIXED_PRICE" ? "Buy It Now" : "Auction", inline: true },
          { name: "Condition", value: item.condition ?? "—", inline: true },
        ],
        footer: { text: `ebae · matched "${search.q}"` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// Sends to every webhook; retries each a few times. Never throws - a dead
// webhook must not stall the poll loop (DESIGN.md failure behavior).
export async function notify(item: Item, search: Search, webhookUrls: string[]): Promise<string | null> {
  const body = JSON.stringify(embed(item, search));
  let lastError: string | null = null;
  for (const url of webhookUrls) {
    let err: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (res.ok) {
          err = null;
          break;
        }
        err = `Discord webhook ${res.status}`;
      } catch (e) {
        // e.name only: fetch error messages can echo the webhook URL (its secret token)
        err = `Discord webhook send failed (${e instanceof Error ? e.name : "error"})`;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
    if (err) lastError = err;
  }
  return lastError;
}
