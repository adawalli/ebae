import { and, count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { removeUserChannel, renameUserChannel } from "@/lib/poller";
import { parseOr400, readJsonBody, routeError } from "@/lib/route";
import { channels, searches } from "@/lib/schema";
import type { Channel } from "@/lib/types";
import { parseChannelName } from "@/lib/validate";

export const dynamic = "force-dynamic";

function isAssignedChannelViolation(error: unknown): boolean {
  let current = error;
  while (current && typeof current === "object") {
    const record = current as Record<string, unknown>;
    if (
      (record.code === "23001" || record.code === "23503") &&
      (record.constraint === "searches_channel_id_channels_id_fk" ||
        record.constraint_name === "searches_channel_id_channels_id_fk")
    )
      return true;
    current = record.cause;
  }
  return false;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const parsed = parseOr400(body, parseChannelName);
  if (parsed instanceof NextResponse) return parsed;
  try {
    const [row] = await db()
      .update(channels)
      .set({ name: parsed.name })
      .where(and(eq(channels.id, id), eq(channels.userId, user.id)))
      .returning({ id: channels.id, kind: channels.kind, name: channels.name, webhookUrl: channels.webhookUrl });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    await renameUserChannel(user.id, row.id, row.name);
    const channel: Channel = { ...row, webhookUrl: `…${row.webhookUrl.slice(-6)}` };
    return NextResponse.json({ channel });
  } catch (e) {
    return routeError(e, { method: "PATCH", path: `/api/channels/${id}` });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const [owned] = await db()
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, id), eq(channels.userId, user.id)));
    if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });
    const [assigned] = await db().select({ count: count() }).from(searches).where(eq(searches.channelId, id));
    if (assigned.count) {
      const noun = assigned.count === 1 ? "search; reassign it" : "searches; reassign them";
      return NextResponse.json(
        { error: `webhook is assigned to ${assigned.count} saved ${noun} before deleting` },
        { status: 409 },
      );
    }
    // Ownership rides in the where clause, so someone else's id deletes nothing and reads back
    // as a 404 - indistinguishable from one that never existed, same as searches.
    const [row] = await db()
      .delete(channels)
      .where(and(eq(channels.id, id), eq(channels.userId, user.id)))
      .returning({ id: channels.id });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    await removeUserChannel(user.id, row.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // The FK closes the race between the assignment count and DELETE. Keep that safe rejection
    // on the route's 409 contract instead of leaking it as a generic write failure.
    if (isAssignedChannelViolation(e))
      return NextResponse.json(
        { error: "webhook is assigned to a saved search; reassign it before deleting" },
        { status: 409 },
      );
    return routeError(e, { method: "DELETE", path: `/api/channels/${id}` });
  }
}
