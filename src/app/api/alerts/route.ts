import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { alerts as alertsTable } from "@/lib/schema";
import type { Alert } from "@/lib/types";

const alog = log.child({ component: "api" });

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const searchId = sp.get("searchId") ? Number(sp.get("searchId")) : null;
  if (searchId !== null && !Number.isFinite(searchId))
    return NextResponse.json({ error: "invalid searchId" }, { status: 400 });
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 100, 1), 500);
  try {
    const where = searchId != null && Number.isFinite(searchId) ? eq(alertsTable.searchId, searchId) : undefined;
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
    return NextResponse.json({ alerts });
  } catch (e) {
    alog.error({ err: e, method: "GET", path: "/api/alerts" }, "route error");
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}

// Clears alert history (the display log only). Leaves seen_items untouched so the
// poller does NOT re-alert on those listings. searchId scopes the clear; omit for all.
export async function DELETE(req: Request) {
  const sp = new URL(req.url).searchParams;
  const searchId = sp.get("searchId") ? Number(sp.get("searchId")) : null;
  if (searchId !== null && !Number.isFinite(searchId))
    return NextResponse.json({ error: "invalid searchId" }, { status: 400 });
  try {
    const where = searchId != null ? eq(alertsTable.searchId, searchId) : undefined;
    await db().delete(alertsTable).where(where);
    return NextResponse.json({ ok: true });
  } catch (e) {
    alog.error({ err: e, method: "DELETE", path: "/api/alerts" }, "route error");
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}
