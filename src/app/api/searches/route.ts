import { NextResponse } from "next/server";
import { createSearch, listSearches } from "@/lib/poller";
import { parseSearchBody } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ searches: listSearches() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const parsed = parseSearchBody(body, false);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  try {
    const search = await createSearch(parsed as Parameters<typeof createSearch>[0]);
    return NextResponse.json({ search }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
