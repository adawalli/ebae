import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { log, redact } from "@/lib/log";
import { createSearch, listSearches } from "@/lib/poller";
import { parseSearchBody } from "@/lib/validate";

const alog = log.child({ component: "api" });

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json({ searches: listSearches(user.id) });
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const parsed = parseSearchBody(body, false);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  try {
    const search = await createSearch(user.id, parsed as Parameters<typeof createSearch>[1]);
    return NextResponse.json({ search }, { status: 201 });
  } catch (e) {
    alog.error({ err: e, method: "POST", path: "/api/searches" }, "route error");
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
