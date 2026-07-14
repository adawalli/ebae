import { NextResponse } from "next/server";
import { health } from "@/lib/poller";

export const dynamic = "force-dynamic";

// Liveness/readiness probe target. 200 when the poller is booted and its scheduling loop
// is alive; 503 while booting, on boot failure, or if the heartbeat has gone stale.
export async function GET() {
  const h = health();
  return NextResponse.json(h, { status: h.ok ? 200 : 503 });
}
