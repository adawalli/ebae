import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import type { Alert } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const searchId = sp.get("searchId") ? Number(sp.get("searchId")) : null;
  if (searchId !== null && !Number.isFinite(searchId))
    return NextResponse.json({ error: "invalid searchId" }, { status: 400 });
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 100, 1), 500);
  try {
    const db = sql();
    const rows =
      searchId != null && Number.isFinite(searchId)
        ? await db`SELECT * FROM alerts WHERE search_id = ${searchId} ORDER BY created_at DESC LIMIT ${limit}`
        : await db`SELECT * FROM alerts ORDER BY created_at DESC LIMIT ${limit}`;
    const alerts: Alert[] = rows.map((r) => ({
      id: r.id,
      searchId: r.search_id,
      searchQ: r.search_q,
      itemId: r.item_id,
      title: r.title,
      price: r.price == null ? null : Number(r.price),
      currency: r.currency,
      shippingCost: r.shipping_cost == null ? null : Number(r.shipping_cost),
      buyingOption: r.buying_option,
      condition: r.condition,
      imageUrl: r.image_url,
      itemUrl: r.item_url,
      createdAt: new Date(r.created_at).toISOString(),
    }));
    return NextResponse.json({ alerts });
  } catch {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}
