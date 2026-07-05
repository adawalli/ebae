import postgres from "postgres";

const g = globalThis as typeof globalThis & { __ebaeSql?: ReturnType<typeof postgres> };

export function sql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  // idle_timeout lets serverless Postgres (Neon) suspend between touches
  g.__ebaeSql ??= postgres(process.env.DATABASE_URL, { max: 4, idle_timeout: 30 });
  return g.__ebaeSql;
}

// ponytail: CREATE IF NOT EXISTS on boot instead of a migration tool; revisit when the schema actually changes
export async function initSchema() {
  const db = sql();
  await db`CREATE TABLE IF NOT EXISTS searches (
    id SERIAL PRIMARY KEY,
    q TEXT NOT NULL,
    category_id TEXT,
    price_cap NUMERIC,
    bin_only BOOLEAN NOT NULL DEFAULT true,
    include_auctions BOOLEAN NOT NULL DEFAULT false,
    interval_min INTEGER NOT NULL DEFAULT 5,
    enabled BOOLEAN NOT NULL DEFAULT true,
    seeded BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await db`CREATE TABLE IF NOT EXISTS seen_items (
    search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (search_id, item_id)
  )`;
  await db`CREATE TABLE IF NOT EXISTS channels (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'discord',
    webhook_url TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true
  )`;
  await db`CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    search_id INTEGER REFERENCES searches(id) ON DELETE SET NULL,
    search_q TEXT NOT NULL,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    price NUMERIC,
    currency TEXT NOT NULL DEFAULT 'USD',
    shipping_cost NUMERIC,
    buying_option TEXT NOT NULL DEFAULT 'FIXED_PRICE',
    condition TEXT,
    image_url TEXT,
    item_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
}
