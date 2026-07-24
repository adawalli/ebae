import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { deleteSearch, listSearches, updateSearch } from "@/lib/poller";
import { parseOr400, readJsonBody, routeError } from "@/lib/route";
import { parseSearchBody } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const id = Number((await params).id);
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const parsed = parseOr400(body, (b) => parseSearchBody(b, true));
  if (parsed instanceof NextResponse) return parsed;
  // A partial PATCH sees only the bound(s) in this body; validate can't cross-check the one it
  // isn't touching. Merge with the stored search so a lone priceFloor can't invert an existing cap.
  // Reading the user's own list keeps someone else's id from resolving here - updateSearch would
  // 404 it anyway, but this must not read their bounds to get there.
  if (parsed.priceFloor !== undefined || parsed.priceCap !== undefined) {
    const cur = listSearches(user.id).find((s) => s.id === id);
    const floor = parsed.priceFloor !== undefined ? (parsed.priceFloor as number | null) : (cur?.priceFloor ?? null);
    const cap = parsed.priceCap !== undefined ? (parsed.priceCap as number | null) : (cur?.priceCap ?? null);
    if (floor != null && cap != null && floor >= cap)
      return NextResponse.json({ error: "priceFloor must be less than priceCap" }, { status: 400 });
  }
  try {
    const search = await updateSearch(user.id, id, parsed);
    if (!search) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ search });
  } catch (e) {
    return routeError(e, { method: "PATCH", path: `/api/searches/${id}` });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const id = Number((await params).id);
  try {
    const ok = await deleteSearch(user.id, id);
    if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return routeError(e, { method: "DELETE", path: `/api/searches/${id}` });
  }
}
