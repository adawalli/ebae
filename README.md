# ebae

_eBay, before anyone else._

Self-hosted eBay alerting. Polls your saved searches every 1-15 minutes via the official Browse API and pings Discord the moment a matching item lists - fast enough to catch Buy It Now drops before they're gone. One container, egress-only, nothing on your network exposed.

See [DESIGN.md](DESIGN.md) for architecture and roadmap.

## Quick start (dev)

```sh
cp .env.example .env.local   # set DATABASE_URL (Neon works great)
bun install
bun run dev
```

Open http://localhost:3000. Without eBay credentials the app runs in **mock mode**: the poller generates fake listings so you can try the whole flow (seeding, alerts, quota) before registering an eBay app.

## eBay credentials

1. Create a free account at [developer.ebay.com](https://developer.ebay.com) and create an app (production keyset).
2. Put the App ID and Cert ID in `.env.local` as `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`.
3. Restart. The status page shows the token going live.

Browse API default quota is 5,000 calls/day. The UI projects your daily usage as you add searches and the poller enforces the budget (`EBAY_DAILY_QUOTA`).

## Discord notifications

Create a webhook in your Discord channel (channel settings → Integrations → Webhooks) and set `DISCORD_WEBHOOK_URL`. Multiple targets can be added as rows in the `channels` table.

## Configuration

All config is env vars - see [.env.example](.env.example). Searches and webhooks live in Postgres and are managed in the UI.

| var                                     | purpose                                              | default                        |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `DATABASE_URL`                          | Postgres connection string                           | required                       |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | eBay app credentials                                 | unset = mock mode              |
| `EBAY_ENV`                              | `production` or `sandbox`                            | production                     |
| `EBAY_MARKETPLACE`                      | marketplace id                                       | `EBAY_US`                      |
| `DISCORD_WEBHOOK_URL`                   | notification target                                  | unset                          |
| `POLL_INTERVAL_DEFAULT`                 | fallback poll interval (min)                         | 5                              |
| `CACHE_REFRESH_HOURS`                   | DB → cache refresh cadence                           | 12                             |
| `MARKET_SAMPLE_HOURS`                   | market-baseline resample gap (band-limited searches) | 24                             |
| `EBAY_DAILY_QUOTA`                      | enforced daily call budget                           | 5000                           |
| `LOG_LEVEL`                             | `error`/`warn`/`info`/`debug`                        | `info`                         |
| `LOG_FORMAT`                            | `json` or `pretty`                                   | `pretty` on a TTY, else `json` |

## Deploy

```sh
docker compose up -d        # uses .env; bundled Postgres available in the compose file
```

Kubernetes: `deploy/k8s.yaml` (single replica - poll timers and the seen-item cache are in-process).

Recommended setup: run it on a home box and expose the UI through a Cloudflare Tunnel behind Cloudflare Access. All app traffic is outbound-only.
