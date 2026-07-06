import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { log } from "./log";
import * as schema from "./schema";

const dblog = log.child({ component: "db" });

type Client = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;
const g = globalThis as typeof globalThis & { __ebaeSql?: Client; __ebaeDb?: Db };

function client(): Client {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return (g.__ebaeSql ??= postgres(process.env.DATABASE_URL, {
    max: 4,
    idle_timeout: 30, // lets serverless Postgres (Neon) suspend between touches
    // The migrator re-bootstraps its ledger (CREATE SCHEMA/TABLE IF NOT EXISTS) every
    // boot, which spams "already exists, skipping" NOTICEs. Drop NOTICE, keep warnings+.
    onnotice: (n) => {
      if (n.severity !== "NOTICE") dblog.warn({ notice: n }, "postgres notice");
    },
  }));
}

export function db(): Db {
  return (g.__ebaeDb ??= drizzle(client(), { schema }));
}

// Applies pending drizzle migrations on boot (replaces the old initSchema bootstrap).
// migrationsFolder is relative to cwd; the Dockerfile copies ./drizzle into the image.
// Assumes a fresh or already-migrated DB: the baseline migration is NOT idempotent
// against tables left by the pre-drizzle initSchema, so wipe such a DB before upgrading.
export async function migrateToLatest() {
  await migrate(db(), { migrationsFolder: "./drizzle" });
  dblog.info("database migrated");
}
