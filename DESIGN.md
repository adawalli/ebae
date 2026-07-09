# ebae - Design & Roadmap

Self-hosted eBay alerting. Poll your saved searches every few minutes, get a Discord ping the moment a matching item lists - fast enough to catch Buy It Now drops before they're gone.

## 1. Problem & Goal

eBay's native saved-search alerts are slow - often hours behind. For sought-after items with Buy It Now, the item is gone long before the email arrives. Whoever sees the listing first wins.

**Goal:** notify within 1-5 minutes of an item being listed. Self-hosted, open source, one container, egress-only (nothing on your network needs to be reachable from the internet).

## 2. Non-Goals

- **No sniping or auto-buying.** Alerting only; the human clicks Buy.
- **No scraping.** Official eBay developer API only - keeps the project ToS-clean and stable.
- **No multi-user / SaaS.** Single-tenant, one household. Auth beyond what your reverse proxy (e.g. cloudflared) provides is out of scope for MVP.
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

The scaling lever is a **per-search poll interval**: hot searches at 1-2 min, casual ones at 10-15 min. The UI shows projected daily call usage as searches are added, and the poller enforces a global budget so a misconfiguration can't blow the quota.

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

- Poller runs entirely from an **in-memory cache** of searches and seen item IDs.
- Cache is loaded at boot, refreshed from DB every 8-12 h (configurable), and **written through immediately** on any UI mutation (create/edit/pause a search updates DB and cache in the same request - no manual refresh needed).
- DB is only touched when: config changes, a new item is found (insert seen_item + alert_log row), or the periodic refresh fires.
- A steady state with no new items and no config changes = zero DB queries between refreshes.

**Data model** (small, boring):

| table        | purpose                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `searches`   | query terms, filters (BIN-only, price cap, category), poll interval, enabled flag                |
| `seen_items` | `(search_id, item_id)` - the dedupe set; prunable after N days                                   |
| `channels`   | notification targets (MVP: Discord webhook URL, one or more)                                     |
| `settings`   | single-row global config (currently the optional overnight poll snooze window + timezone)        |
| `alerts`     | log of sent notifications (item snapshot: title, price, image, url) - powers the UI history view |

**Failure behavior.** eBay/API errors back off exponentially per search and surface on a status page; Discord send failures retry a few times then log. Restart recovers state from Postgres (seen set persists), so crashes never re-alert old items.

## 5. Notifications

**MVP: Discord only**, via outbound webhook POST - no bot, no inbound connectivity, ~zero setup for the user (create webhook in a channel, paste URL).

Embed layout per new item:

- Thumbnail: item image
- Title: listing title, hyperlinked to the item
- Fields: price (+ shipping if present), **Buy It Now** / Auction badge, condition, listing time
- Deal context: a **Typical** field comparing the price to the median of recent alerts for the same search (shown once ≥3 priced alerts exist)
- Footer: which saved search matched

One `notify(item, search)` function with Discord as the only implementation. Deliberately no channel-plugin framework yet - a `Notifier` interface gets extracted when the second channel (Telegram) actually lands.

## 6. Deployment

**Image:** single public image on docker.io (OSS, no private-repo limits). Multi-arch (amd64/arm64).

**Config is env-only** - no config files to mount:

| var                                     | purpose                                            |
| --------------------------------------- | -------------------------------------------------- |
| `DATABASE_URL`                          | Postgres connection string (Neon, local, anything) |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | eBay app credentials                               |
| `EBAY_MARKETPLACE`                      | e.g. `EBAY_US` (default)                           |
| `POLL_INTERVAL_DEFAULT`                 | fallback per-search interval (default 5 min)       |
| `CACHE_REFRESH_HOURS`                   | DB→cache refresh cadence (default 12)              |

Everything else (searches, webhooks) is managed in the UI and lives in Postgres.

**Targets:**

- **docker-compose** - reference deployment; optional bundled Postgres service for users who don't want Neon.
- **Proxmox LXC** - runs the image via Docker-in-LXC or as a plain Bun process; README notes, nothing special required since all traffic is outbound.
- **Kubernetes** - a single Deployment (one replica - the in-memory seen-cache and poll timers assume one instance) + Secret. Example manifest in `deploy/`.

**Recommended: home host + Cloudflare Tunnel.** Run the container on a home box (Proxmox LXC or Docker) and expose the UI through a Cloudflare Tunnel gated behind Cloudflare Access. The tunnel is outbound-only, so zero inbound ports are open and nothing on your LAN is reachable from the internet; Access provides auth in front. Tailscale or LAN-only work too - the app never requires inbound internet either way.

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
- Quota dashboard + adaptive polling (slow down overnight, speed up on hot searches)

**Phase 3 - Nice-to-haves**

- PWA with web push notifications
- Two-way Telegram commands (/pause, /list, /add)
- Price-drop alerts on watched items
- Multi-marketplace (eBay UK/DE/etc. per search)

## 8. Open Questions

- **Marketplace scope for MVP:** single `EBAY_MARKETPLACE` env var globally, or per-search? (Leaning global for MVP.)
- **Seen-set pruning:** how long to retain `seen_items` rows - fixed 90 days, or tied to eBay listing lifetime?
