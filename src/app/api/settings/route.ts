import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { log, redact } from "@/lib/log";
import { getSnooze, setSnooze } from "@/lib/poller";
import { parseSnoozeBody } from "@/lib/validate";

const alog = log.child({ component: "api" });

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json({ snooze: getSnooze(user.id) });
}

export async function PUT(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const parsed = parseSnoozeBody(body);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  try {
    return NextResponse.json({ snooze: await setSnooze(user.id, parsed) });
  } catch (e) {
    alog.error({ err: e, method: "PUT", path: "/api/settings" }, "route error");
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
