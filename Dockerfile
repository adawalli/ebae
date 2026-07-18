# deps: bun honors bun.lock and installs fast
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# build: next build runs on node
FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node_modules/.bin/next build

# run: standalone output, non-root
FROM node:24-alpine
WORKDIR /app
# NEXT_MANUAL_SIG_HANDLE: let poller/boot.ts own SIGTERM/SIGINT so its shutdown flush
# completes; otherwise Next's own handler process.exit()s and cuts the DB write off.
# APP_VERSION: the image tag, threaded in at build time so the UI is self-describing
# without a package.json bump. Falls back to "dev" for local builds.
ARG APP_VERSION=dev
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 NEXT_MANUAL_SIG_HANDLE=true APP_VERSION=$APP_VERSION
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
USER node
EXPOSE 3000
# node has global fetch; the run image has no curl/wget. start-period covers boot + DB migrate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
