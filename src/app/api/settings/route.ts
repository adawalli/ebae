import { NextResponse } from "next/server";
import { log, redact } from "@/lib/log";
import { getSnooze, setSnooze } from "@/lib/poller";
import { parseSnoozeBody } from "@/lib/validate";

const alog = log.child({ component: "api" });

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ snooze: getSnooze() });
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const parsed = parseSnoozeBody(body);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  try {
    return NextResponse.json({ snooze: await setSnooze(parsed) });
  } catch (e) {
    alog.error({ err: e, method: "PUT", path: "/api/settings" }, "route error");
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
