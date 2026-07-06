import { NextResponse } from "next/server";
import { log, redact } from "@/lib/log";
import { deleteSearch, updateSearch } from "@/lib/poller";
import { parseSearchBody } from "@/lib/validate";

const alog = log.child({ component: "api" });

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const parsed = parseSearchBody(body, true);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  try {
    const search = await updateSearch(id, parsed);
    if (!search) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ search });
  } catch (e) {
    alog.error({ err: e, method: "PATCH", path: `/api/searches/${id}` }, "route error");
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  try {
    const ok = await deleteSearch(id);
    if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    alog.error({ err: e, method: "DELETE", path: `/api/searches/${id}` }, "route error");
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
