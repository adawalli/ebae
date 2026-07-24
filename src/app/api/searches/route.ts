import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createSearch, listSearches } from "@/lib/poller";
import { parseOr400, readJsonBody, routeError } from "@/lib/route";
import { parseSearchBody } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json({ searches: listSearches(user.id) });
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const parsed = parseOr400(body, (b) => parseSearchBody(b, false));
  if (parsed instanceof NextResponse) return parsed;
  try {
    const search = await createSearch(user.id, parsed as Parameters<typeof createSearch>[1]);
    return NextResponse.json({ search }, { status: 201 });
  } catch (e) {
    return routeError(e, { method: "POST", path: "/api/searches" });
  }
}
