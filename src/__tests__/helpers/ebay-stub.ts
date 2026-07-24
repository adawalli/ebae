// Installs a global fetch answering the eBay live branch: the OAuth token and an empty search
// (itemSummaries: []) are handled here, the getItem call is delegated to `onItem` and counted.
// Returns restore() to put the real fetch back, and a live `calls` count of getItem hits. Every
// poller test that drives a live `u.ebay` was re-open-coding this token+empty+item dance.
export function stubEbayLive(onItem: (url: string) => Response | Promise<Response>): {
  restore(): void;
  readonly calls: number;
} {
  const realFetch = globalThis.fetch;
  const counter = { n: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
    if (url.includes("/buy/browse/v1/item/")) {
      counter.n++;
      return onItem(url);
    }
    return Response.json({ itemSummaries: [] });
  }) as typeof fetch;
  return {
    restore() {
      globalThis.fetch = realFetch;
    },
    get calls() {
      return counter.n;
    },
  };
}
