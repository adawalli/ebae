# ebae - Design & Roadmap

Self-hosted eBay alerting. Poll your saved searches every few minutes, get a Discord ping the moment a matching item lists - fast enough to catch Buy It Now drops before they're gone.

## 1. Problem & Goal

eBay's native saved-search alerts are slow - often hours behind. For sought-after items with Buy It Now, the item is gone long before the email arrives. Whoever sees the listing first wins.

**Goal:** notify within 1-5 minutes of an item being listed. Self-hosted, open source, one container, egress-only (nothing on your network needs to be reachable from the internet).

## 2. Non-Goals

- **No sniping or auto-buying.** Alerting only; the human clicks Buy.
- **No scraping.** Official eBay developer API only - keeps the project ToS-clean and stable.
- **No SaaS / consumer scale.** A handful of people sharing one deployment is in (see §4); signup flows, billing, roles and horizontal scale are not. Identity comes from an auth proxy in front of the app - ebae never handles passwords. Multi-user does **not** relax the single-replica constraint: poll timers and the seen cache are in process memory, so it stays one instance.
- **No auction bid tracking.** New-listing detection is the product; price-drop and ending-soon alerts are future maybes.

## 3. eBay API Approach

**API:** Buy Browse API, `GET /buy/browse/v1/item_summary/search`.

- `q` = the user's search terms (plus optional `category_ids`, `filter` for price range etc.)
- `filter=buyingOptions:{FIXED_PRICE}` when the search is BIN-only (per-search toggle; auctions can be included)
- `sort=newlyListed` - newest first, so page 1 is all we ever need
- Dedupe on `itemId`: anything not in the seen set is a new listing → alert.

**Auth:** OAuth2 client-credentials flow (application token, no user consent needed for Browse). Token fetched and refreshed outbound - fits the egress-only constraint. Requires a (free) eBay developer account; README will walk through app registration.

**Quota math:** default Browse quota is 5,000 calls/day per app.

- One search at a 2-minute interval = 720 calls/day.
- 3 searches at 2 min ≈ 2,160/day - comfortable.
- 6 searches at 2 min ≈ 4,320/day - near the ceiling.

The scaling lever is a **per-search poll interval**: hot searches at 1-2 min, casual ones at 10-15 min. The UI shows projected daily call usage as searches are added, and the poller enforces the budget so a misconfiguration can't blow the quota. Each user brings their own eBay app, so the budget is counted and enforced per user.

Projected usage is computed server-side from the cached entries (`projectedCalls`), over the day's _pollable_ minutes - 1440 minus the snooze window - and includes each band-limited search's daily market sample plus every sold-price check falling due in the next 24h. The per-row figures and the total come from one function so they always agree with each other and with the counter the poller bills against.

**Sold prices without Marketplace Insights.** eBay's sold-search APIs are Limited Release/enterprise-only, so a realized price is inferred instead: `GET /buy/browse/v1/item/{itemId}?fieldgroups=COMPACT` on a listing already seen. Ended listings stay readable for days, and one rule reads both listing types (verified by live probing): `OUT_OF_STOCK` with `estimatedSoldQuantity > 0` means **sold at `price`** - for an ended auction that mirrors the frozen final bid - while `IN_STOCK` past an auction's end means nobody bid. `bidCount` and `reservePriceMet` are unusable (null even where they should be set). Bulk `getItems` is partner-only, so a check is one call.

Timing is what keeps that affordable, and it comes free: search summaries already carry `itemEndDate`, so an **auction costs exactly one check** (end + 5 min, late enough to catch a snipe). A **fixed-price listing decays** over 3/7/14/30 days, at most four checks ever, and any poll that re-sights it skips the next check outright. Enabled by default per search (`searches.track_sold`) with a per-search opt-out, capped at 3 checks per tick, and dropped first when the budget runs low.

**Budget governor.** Spending the daily budget by noon used to mean polling stopped dead until midnight. The governor stretches poll intervals as spend runs ahead of the day, so the budget lasts instead of running out:

- **Signal:** the exact correction needed to fit the _current saved configuration's remaining work_ inside the budget actually left. It does not extrapolate an earlier, faster configuration: pausing a search or lengthening snooze immediately lowers the demand it protects. A configuration that now fits the remaining budget is never slowed.
- **Bounds:** slow-down only (the factor is >= 1 by construction, so no search ever polls faster than the interval its owner configured), capped at `GOV_MAX_FACTOR` = 4x, and inert until `GOV_MIN_SPEND` = 5% of the ceiling is spent. An engaged governor releases only after `GOV_RELEASE_HEADROOM` = 5% of remaining-budget slack, preventing interval flapping around the boundary.
- **Cost:** none. Recomputed per reschedule from the in-memory counter and the user's own clock; nothing persisted, no new table, no extra query, so the steady-state DB-free poll stays DB-free (§4).
- **Day boundary:** the counter is not cleared at midnight - the owner's next poll rolls it over. Every other reader takes it through `usedToday`, which treats a stale date as no spend, so the status tile and the per-row factor can't read yesterday's total as a minutes-old day's.
- **Backstop:** the hard cliff is unchanged. At the ceiling, polls are still skipped and retried at `QUOTA_SKIP_MS`.
- **Transparency:** the Saved searches bar shows today's configured forecast as spent calls, remaining requested work, and any overflow; each stretched search shows its effective interval (including a decimal when needed), and every engage/release is logged.

`healthWindowMs` derives from the reschedule delay constants rather than restating them, so stretching a delay can't leave the liveness window too tight and start 503ing healthy pods.

**First poll of a new search** seeds the seen set without alerting (otherwise you'd get spammed with every existing listing).

## 4. Architecture

One Bun + Next.js app, one container image.

```
┌─────────────────── container ───────────────────┐
│  Next.js (Bun runtime)                           │
│  ├─ UI: searches CRUD, alert history, status     │
│  ├─ API routes: mutations write DB + cache       │
│  └─ Poller (in-process, started with server)     │
│      ├─ per-search timers (1-5 min)              │
│      ├─ eBay Browse client + token refresh       │
│      └─ notifier → Discord webhook (egress)      │
│  In-memory cache: searches + seen itemIds        │
└───────────────┬──────────────────────────────────┘
                │ (only on: mutation, new item, 8-12h refresh)
           Postgres (Neon or local)
```

**Poller.** In-process alongside the Next.js server (custom Bun entrypoint that boots both). No queue, no cron container, no separate worker - a `setInterval` per search is enough at this scale. Deliberate: split into a worker only if the single process ever becomes a real problem.

**Database.** Any Postgres connection string (`DATABASE_URL`). Designed so a serverless Postgres like Neon stays asleep almost all the time:

- Poller runs entirely from an **in-memory cache** of searches, seen item IDs, and any outstanding sold-price follows.
- Cache is loaded at boot, refreshed from DB every 8-12 h (configurable), and **written through immediately** on any UI mutation (create/edit/pause a search updates DB and cache in the same request - no manual refresh needed).
- DB is only touched when: config changes, a new item is found (insert seen_item + alert_log row), or the periodic refresh fires.
- **The open UI must not defeat any of the above.** It polls every 10s, so a single tab is enough to hold the compute awake around the clock if any of those requests reads the DB. Two rules keep it honest: a hidden tab polls nothing (`document.hidden`), and of the three polled routes only `/api/alerts` touches the DB - it answers `304` off an in-memory per-user revision (`alertsTag`) whenever that user's list hasn't changed. `/api/searches` and `/api/status` serve from the poller's cache.
- A steady state with no new items and no config changes = zero DB queries between refreshes, whether or not the app is open.

**Data model** (small, boring):

| table        | purpose                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `users`      | one row per person: email (identity anchor), `sub` from the IdP, their eBay keys (secret AES-GCM encrypted), snooze window |
| `searches`   | query terms, filters (BIN-only, price cap, category), poll interval, enabled flag, `user_id`                               |
| `seen_items` | `(search_id, item_id)` - the dedupe set; prunable after N days. Scoped via the search FK, no `user_id` of its own          |
| `channels`   | notification targets (MVP: Discord webhook URL, one or more), `user_id`                                                    |
| `alerts`     | log of sent notifications (item snapshot: title, price, image, url) - powers the UI history view, `user_id`                |
| `api_usage`  | daily eBay call counter, PK `(user_id, day)` - the quota is per user, since each user brings their own eBay app            |

`user_id` is a cascading FK, nullable in the DB only because rows predating multi-user are backfilled at boot (`claim.ts`); the app always writes it and the poller skips a search that somehow has none. The old single-row `settings` table is gone - snooze moved onto `users`. Single mode is not a special case: it has exactly one implicit user row (`local@localhost`), so every query is user-scoped in all modes.

**Failure behavior.** eBay/API errors back off exponentially per search and surface on a status page. Discord send failures retry a few times; an alert that reaches no channel is left unconfirmed (`alerts.delivered_at` null) and redelivered at the next boot, unless it's over an hour old by then (a deal that stale isn't worth sending). An alert is considered delivered once any channel accepts it, so a redelivery never re-posts to a channel that already has it. Restart recovers state from Postgres (seen set persists), so crashes never re-alert old items. `GET /api/health` reports poller liveness from a scheduling heartbeat (200/503) for container and k8s probes.

## 5. Notifications

**MVP: Discord only**, via outbound webhook POST - no bot, no inbound connectivity, ~zero setup for the user (create webhook in a channel, paste URL).

Embed layout per new item:

- Thumbnail: item image
- Title: listing title, hyperlinked to the item
- Fields: price (+ shipping if present), **Buy It Now** / Auction badge, condition, listing time
- Deal context, best basis first:
  - **Sold**: median of what this search's tracked listings actually realized, when tracking is enabled (`searches.track_sold`) and ≥3 sales inside 30 days agree. See §3 for how a realized price is obtained without the Marketplace Insights API.
  - **Market**: comparison against a daily market baseline (median asking price of the same criteria with the price **cap removed but the floor kept** — the floor keeps sub-band accessories that share the query's keywords out of the median, the removed cap reveals the true going rate above the deal-hunt ceiling). Poller-managed on `searches.market_median` / `market_sampled_at`, refreshed once/day for searches with both a floor and a cap (`MARKET_SAMPLE_HOURS`)
  - **Typical**: median of recent alerts for the search, when there is no baseline yet; shown once ≥3 priced alerts exist
- Footer: which saved search matched

Two senders: `notify()` (Discord, `discord.ts`) and `notifyPush()` (Web Push, `push.ts`). The poller awaits both and ORs the results. Still deliberately no channel-plugin framework - a `Notifier` interface over two concrete functions is more code than calling both, so it waits for a third channel (Telegram) to actually land.

`deliveredAt` means "at least one target accepted", unchanged now that there are two kinds. A restart redelivers an alert only while **no** target has it, so a target that already got one can never be re-sent at the cost of one that failed alongside it never getting a retry. That trade predates push (it is already the case for two Discord webhooks); push joins the same set under the same rule.

**Push** is per device, not per user: subscriptions live in `push_subs`, keyed by an endpoint the browser mints. The VAPID keypair is generated on first use into `vapid_keys` rather than required as config, because the image is built once and a `NEXT_PUBLIC_*` key could never be set by anyone running the published container - so the public key is served from `/api/push` at runtime. The VAPID subject is a constant, never derived from the deployment URL: a localhost subject makes Apple return 403 BadJwtToken, which breaks every iPhone while Chrome keeps working. Endpoints are attacker-controlled input, so `validate.ts` allowlists the known push hosts at subscribe time for the same reason `parseChannelBody` pins Discord's prefix. Subscriptions are dropped on 404/410 only - every other status is transient, and reaping on 403 would delete every iOS subscriber at once.

## 6. Deployment

**Image:** single public image on docker.io (OSS, no private-repo limits). Multi-arch (amd64/arm64).

**No config files to mount** - env vars plus the database:

| var                                      | purpose                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`                           | Postgres connection string (Neon, local, anything)          |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`  | eBay app credentials (single mode only)                     |
| `EBAY_MARKETPLACE`                       | e.g. `EBAY_US` (default; single mode only)                  |
| `AUTH_MODE`                              | `single` (default, no auth) / `cloudflare` / `proxy`        |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Access app identity, required in `cloudflare` mode          |
| `AUTH_TRUSTED_HEADER`                    | email-bearing header, required in `proxy` mode              |
| `ENCRYPTION_KEY`                         | base64 32 bytes; encrypts eBay secrets saved through the UI |
| `LEGACY_OWNER_EMAIL`                     | one-time owner for pre-multi-user rows                      |
| `POLL_INTERVAL_DEFAULT`                  | fallback per-search interval (default 5 min)                |
| `CACHE_REFRESH_HOURS`                    | DB→cache refresh cadence (default 12)                       |
| `SEEN_RETENTION_DAYS`                    | how long `seen_items` dedupe rows are kept (default 90)     |

Config stopped being strictly env-only with multi-user: a shared deployment can't ship per-user eBay keys in the container's environment, so in `cloudflare`/`proxy` mode each user enters their own keys in the UI and they live encrypted in Postgres (the `EBAY_*` and `DISCORD_WEBHOOK_URL` vars are ignored there). Single mode keeps the env-only story intact - nothing is stored, no `ENCRYPTION_KEY` needed. Searches and webhooks were always UI-managed and in Postgres. `AUTH_MODE` and the vars it requires are resolved once at boot and fail closed.

**Targets:**

- **docker-compose** - reference deployment; optional bundled Postgres service for users who don't want Neon.
- **Proxmox LXC** - runs the image via Docker-in-LXC or as a plain Bun process; README notes, nothing special required since all traffic is outbound.
- **Kubernetes** - a single Deployment (one replica - the in-memory seen-cache and poll timers assume one instance) + Secret. Example manifest in `deploy/`.

**Recommended: home host + Cloudflare Tunnel.** Run the container on a home box (Proxmox LXC or Docker) and expose the UI through a Cloudflare Tunnel gated behind Cloudflare Access. The tunnel is outbound-only, so zero inbound ports are open and nothing on your LAN is reachable from the internet; Access provides auth in front, and `AUTH_MODE=cloudflare` makes the app verify Access's signed JWT itself rather than trust whatever reaches the origin. Tailscale or LAN-only work too - the app never requires inbound internet either way.

## 7. Roadmap

**Phase 1 - MVP**

- eBay Browse polling with per-search intervals, BIN filter, newly-listed sort, itemId dedupe
- Postgres persistence + in-memory cache (Neon-friendly)
- Discord webhook notifications with rich embeds
- Next.js UI: searches CRUD, alert history, status/quota page
- Docker image on docker.io, compose example, k8s manifest

**Phase 2 - More channels & filters**

- Telegram bot notifications (outbound send; long-polling if commands are wanted)
- Generic webhook channel (POST JSON → ntfy, Slack, Home Assistant, ...)
- Richer per-search filters: price caps ✓, condition ✓, exclude-keywords ✓, seller location
- Deal context: within-band **Typical** median ✓, daily **Market** baseline ✓ (cap removed, floor kept; asking prices), realized **Sold** median ✓ (enabled by default with per-search opt-out; see §3, no Marketplace Insights access required)
- Quota dashboard ✓ + adaptive polling: slow down to protect the daily budget ✓ (see §3). Speeding up on hot searches is deliberately **not** built - polling faster than the interval a user set is a promise ebae doesn't make.

**Phase 3 - Nice-to-haves**

- ~~PWA with web push notifications~~ ✅
- Two-way Telegram commands (/pause, /list, /add)
- Price-drop alerts on watched items
- Multi-marketplace (eBay UK/DE/etc. per search)

## 8. Open Questions

- **Marketplace scope for MVP:** single `EBAY_MARKETPLACE` env var globally, or per-search? (Leaning global for MVP.)
- **Seen-set pruning:** resolved - fixed-day retention pruned on each cache refresh, default 90 days, tunable via `SEEN_RETENTION_DAYS`. Tying retention to actual eBay listing lifetime is a future refinement.
