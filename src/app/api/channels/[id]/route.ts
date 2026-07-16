import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { log, redact } from "@/lib/log";
import { removeUserChannel } from "@/lib/poller";
import { channels } from "@/lib/schema";

const alog = log.child({ component: "api" });

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    // Ownership rides in the where clause, so someone else's id deletes nothing and reads back
    // as a 404 - indistinguishable from one that never existed, same as searches.
    const [row] = await db()
      .delete(channels)
      .where(and(eq(channels.id, id), eq(channels.userId, user.id)))
      .returning({ webhookUrl: channels.webhookUrl });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    await removeUserChannel(user.id, row.webhookUrl);
    return NextResponse.json({ ok: true });
  } catch (e) {
    alog.error({ err: e, method: "DELETE", path: `/api/channels/${id}` }, "route error");
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
