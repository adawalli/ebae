# Repository Guidelines

## Project Structure & Module Organization

This is a Bun-managed Next.js application for self-hosted eBay alerts. App routes and UI live in `src/app/`, including API routes under `src/app/api/`. Shared server logic is in `src/lib/`: database setup in `db.ts`, eBay integration in `ebay.ts`, Discord notifications in `discord.ts`, validation in `validate.ts`, and the in-process poller in `poller.ts`. Static files belong in `public/`. Deployment assets are `Dockerfile`, `docker-compose.yml`, and `deploy/k8s.yaml`. Architecture notes and roadmap live in `DESIGN.md`.

## Build, Test, and Development Commands

- `bun install`: install dependencies from `bun.lock`.
- `bun run dev`: start the local Next.js dev server at `http://localhost:3000`.
- `bun run lint`: run ESLint with the Next.js core-web-vitals and TypeScript rules.
- `bun run build`: create a production Next.js build.
- `bun run start`: serve the production build after `bun run build`.
- `docker compose up -d`: build and run the containerized app using `.env`.

The app requires `DATABASE_URL`. Without eBay credentials, it runs in mock mode for local workflow testing.

## Coding Style & Naming Conventions

Use TypeScript with `strict` enabled and prefer imports through the `@/*` alias for `src/*`. Follow the existing style: two-space indentation, double quotes, semicolons, React function components, and small helper functions near their call sites. Keep API handlers in `route.ts` files and shared domain types in `src/lib/types.ts`. Environment variables should be uppercase snake case and documented in `README.md` when added.

## Testing Guidelines

No automated test framework is currently configured. For now, run `bun run lint` and `bun run build` before opening a PR. When adding tests, colocate them with the related module using a clear suffix such as `poller.test.ts` or place broader integration tests under `src/__tests__/`. Prefer focused tests around polling, validation, quota behavior, and API route responses.

## Commit & Pull Request Guidelines

Current history uses concise, imperative commit messages, for example `Initial commit: design doc and gitignore`. Continue with short subject lines that name the change and, when useful, a scope after a colon.

PRs should include a brief summary, verification commands run, linked issues if applicable, and screenshots for UI changes. Call out configuration or migration impacts, especially changes involving `DATABASE_URL`, eBay credentials, Discord webhooks, polling intervals, or deployment manifests.

## Security & Configuration Tips

Do not commit `.env`, `.env.local`, credentials, webhook URLs, or database connection strings. Keep eBay and Discord secrets in environment variables. Treat `deploy/k8s.yaml` and Compose changes as production-affecting unless explicitly marked experimental.
