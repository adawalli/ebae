import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { alertsTag, bumpAlerts } from "@/lib/poller";
import { routeError } from "@/lib/route";
import { alerts as alertsTable } from "@/lib/schema";
import type { Alert } from "@/lib/types";

export const dynamic = "force-dynamic";

// These alerts are one user's. `private` keeps them out of any shared cache: this route
// answers differently per caller with nothing in the URL to say so, so a proxy or CDN storing
// one response could hand it to the wrong user. `no-cache` does not mean "don't store" - it
// means "revalidate every time", which is what makes the ETag load-bearing rather than a hint.
function validators(tag: string): Record<string, string> {
  return { ETag: `"${tag}"`, "Cache-Control": "private, no-cache" };
}

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const sp = new URL(req.url).searchParams;
  const searchId = sp.get("searchId") ? Number(sp.get("searchId")) : null;
  if (searchId !== null && !Number.isFinite(searchId))
    return NextResponse.json({ error: "invalid searchId" }, { status: 400 });
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 100, 1), 500);
  // This route is the only one of the three the UI polls every 10s that touches the DB, and
  // that poll alone is enough to keep a serverless Postgres (Neon) awake around the clock. The
  // poller knows in memory whether this user's alerts have changed, so an unchanged list is
  // answered without a query at all. Read before the query, never after: a poll landing between
  // the two only means the tag is one revision stale, so the client refetches on its next tick.
  // The reverse order could stamp a tag onto rows that predate it and go stale forever.
  const tag = alertsTag(user.id);
  if (tag && req.headers.get("if-none-match") === `"${tag}"`)
    return new NextResponse(null, { status: 304, headers: validators(tag) });
  try {
    // The owner clause is unconditional; searchId only narrows within it, so passing someone
    // else's id reads as an empty history rather than theirs.
    const where = and(
      eq(alertsTable.userId, user.id),
      searchId != null ? eq(alertsTable.searchId, searchId) : undefined,
    );
    const rows = await db().select().from(alertsTable).where(where).orderBy(desc(alertsTable.createdAt)).limit(limit);
    const alerts: Alert[] = rows.map((r) => ({
      id: r.id,
      searchId: r.searchId,
      searchQ: r.searchQ,
      itemId: r.itemId,
      title: r.title,
      price: r.price, // numeric mode:"number" -> number | null
      currency: r.currency,
      shippingCost: r.shippingCost,
      buyingOption: r.buyingOption as "FIXED_PRICE" | "AUCTION",
      condition: r.condition,
      imageUrl: r.imageUrl,
      itemUrl: r.itemUrl,
      createdAt: r.createdAt.toISOString(),
    }));
    return NextResponse.json({ alerts }, tag ? { headers: validators(tag) } : undefined);
  } catch (e) {
    return routeError(e, { method: "GET", path: "/api/alerts" }, { unavailable: true });
  }
}

// Clears alert history (the display log only). Leaves seen_items untouched so the
// poller does NOT re-alert on those listings. searchId scopes the clear; omit for all
// of the caller's own.
export async function DELETE(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const sp = new URL(req.url).searchParams;
  const searchId = sp.get("searchId") ? Number(sp.get("searchId")) : null;
  if (searchId !== null && !Number.isFinite(searchId))
    return NextResponse.json({ error: "invalid searchId" }, { status: 400 });
  try {
    // "omit searchId = clear all" means all of THIS user's: the owner clause is what stops a
    // bare DELETE from wiping the table for everyone.
    const where = and(
      eq(alertsTable.userId, user.id),
      searchId != null ? eq(alertsTable.searchId, searchId) : undefined,
    );
    await db().delete(alertsTable).where(where);
    bumpAlerts(user.id); // rows are gone; a tab still holding the old tag must not keep showing them
    return NextResponse.json({ ok: true });
  } catch (e) {
    return routeError(e, { method: "DELETE", path: "/api/alerts" }, { unavailable: true });
  }
}
