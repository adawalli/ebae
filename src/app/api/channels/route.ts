import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { log, redact } from "@/lib/log";
import { addUserChannel } from "@/lib/poller";
import { channels } from "@/lib/schema";
import type { Channel } from "@/lib/types";
import { parseChannelBody } from "@/lib/validate";

const alog = log.child({ component: "api" });

export const dynamic = "force-dynamic";

// A webhook URL is a bearer credential - anyone holding it can post to the channel, which is
// why log.ts scrubs it out of log lines. So a saved one only ever comes back as its tail:
// enough to tell two apart in the list, useless to anyone who lifts it off the page.
function mask(url: string): string {
  return `…${url.slice(-6)}`;
}

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  try {
    const rows = await db()
      .select({ id: channels.id, kind: channels.kind, webhookUrl: channels.webhookUrl })
      .from(channels)
      .where(eq(channels.userId, user.id))
      .orderBy(channels.id);
    const list: Channel[] = rows.map((r) => ({ id: r.id, kind: r.kind, webhookUrl: mask(r.webhookUrl) }));
    return NextResponse.json({ channels: list });
  } catch (e) {
    alog.error({ err: e, method: "GET", path: "/api/channels" }, "route error");
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const parsed = parseChannelBody(body);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  try {
    const [row] = await db()
      .insert(channels)
      .values({ userId: user.id, webhookUrl: parsed.webhookUrl })
      .returning({ id: channels.id, kind: channels.kind });
    await addUserChannel(user.id, parsed.webhookUrl);
    const channel: Channel = { id: row.id, kind: row.kind, webhookUrl: mask(parsed.webhookUrl) };
    return NextResponse.json({ channel }, { status: 201 });
  } catch (e) {
    alog.error({ err: e, method: "POST", path: "/api/channels" }, "route error");
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
