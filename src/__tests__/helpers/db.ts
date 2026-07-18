// In-memory Postgres for tests. db.ts resolves its client through globalThis singletons and
// only reads DATABASE_URL on the first db() call, so assigning __ebaeDb before anything
// touches the database swaps the whole app - routes, poller and auth alike - onto PGlite
// without production needing a test seam of its own.
//
// Not a *.test.ts file, so `next build` typechecks it: it must never import bun:test.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Entry } from "@/lib/poller";
import * as schema from "@/lib/schema";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

type Globals = typeof globalThis & {
  __ebaeDb?: unknown;
  __ebaeSql?: unknown;
  __ebaeState?: { entries?: Map<number, Entry> };
  __ebaeUsers?: unknown;
  __ebaeJwks?: unknown;
  __ebaeTokens?: unknown;
  __ebaeMock?: unknown;
};

const g = globalThis as Globals;

let open: PGlite | undefined;

// Applies the same ./drizzle migrations production boots with, so a schema change that
// forgets a migration fails here too. migrateToLatest() can't be reused: it is pinned to
// the postgres-js migrator.
export async function freshTestDb(): Promise<TestDb> {
  resetPoller();
  // Single mode, no credentials: requireUser provisions the local user without any headers
  // and the poller picks its mock branch, so no test can reach the network.
  delete process.env.DATABASE_URL;
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.EBAY_CLIENT_SECRET;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.AUTH_MODE;

  // One instance per test, so the previous one is released rather than left holding its WASM
  // heap for the rest of the run.
  await open?.close();
  open = new PGlite();
  const database = drizzle(open, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });
  g.__ebaeDb = database;
  return database;
}

// Every cache the app keeps on globalThis. Timers are cleared first: an entry left holding a
// setTimeout would fire into the next test's database.
export function resetPoller(): void {
  for (const e of g.__ebaeState?.entries?.values() ?? []) if (e.timer) clearTimeout(e.timer);
  delete g.__ebaeState;
  delete g.__ebaeDb;
  delete g.__ebaeSql;
  delete g.__ebaeUsers;
  delete g.__ebaeJwks;
  delete g.__ebaeTokens;
  delete g.__ebaeMock;
}
