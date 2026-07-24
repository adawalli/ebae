import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getSnooze, setSnooze } from "@/lib/poller";
import { parseOr400, readJsonBody, routeError } from "@/lib/route";
import { parseSnoozeBody } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json({ snooze: getSnooze(user.id) });
}

export async function PUT(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const parsed = parseOr400(body, parseSnoozeBody);
  if (parsed instanceof NextResponse) return parsed;
  try {
    return NextResponse.json({ snooze: await setSnooze(user.id, parsed) });
  } catch (e) {
    return routeError(e, { method: "PUT", path: "/api/settings" });
  }
}
