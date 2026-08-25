import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { addUserChannel } from "@/lib/poller";
import { parseOr400, readJsonBody, routeError } from "@/lib/route";
import { channels } from "@/lib/schema";
import type { Channel } from "@/lib/types";
import { parseChannelBody } from "@/lib/validate";

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
      .select({ id: channels.id, kind: channels.kind, name: channels.name, webhookUrl: channels.webhookUrl })
      .from(channels)
      .where(eq(channels.userId, user.id))
      .orderBy(channels.id);
    const list: Channel[] = rows.map((r) => ({ ...r, webhookUrl: mask(r.webhookUrl) }));
    return NextResponse.json({ channels: list });
  } catch (e) {
    return routeError(e, { method: "GET", path: "/api/channels" }, { unavailable: true });
  }
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const parsed = parseOr400(body, parseChannelBody);
  if (parsed instanceof NextResponse) return parsed;
  try {
    const [row] = await db()
      .insert(channels)
      .values({ userId: user.id, name: parsed.name, webhookUrl: parsed.webhookUrl })
      .returning({ id: channels.id, kind: channels.kind, name: channels.name });
    await addUserChannel(user.id, { id: row.id, name: row.name, webhookUrl: parsed.webhookUrl });
    const channel: Channel = { ...row, webhookUrl: mask(parsed.webhookUrl) };
    return NextResponse.json({ channel }, { status: 201 });
  } catch (e) {
    return routeError(e, { method: "POST", path: "/api/channels" });
  }
}
