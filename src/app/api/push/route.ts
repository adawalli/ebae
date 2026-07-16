import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { addUserPush, removeUserPush } from "@/lib/poller";
import { vapid } from "@/lib/push";
import { pushSubs } from "@/lib/schema";
import { parsePushBody } from "@/lib/validate";

const alog = log.child({ component: "api" });

export const dynamic = "force-dynamic";

// The VAPID public key. It has to be served rather than inlined as NEXT_PUBLIC_*: the
// image is built once and self-hosters run that build, so a build-time value could never
// be set by anyone running the published container.
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const keys = await vapid();
  if (!keys) return NextResponse.json({ error: "push is not configured" }, { status: 503 });
  return NextResponse.json({ publicKey: keys.publicKey });
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const parsed = parsePushBody(body);
  if (typeof parsed === "string") {
    // Loud on purpose: the push services reserve the right to change their hostnames, so
    // a rejection here is either an attack or the allowlist going stale - and the second
    // one would otherwise look like push silently not working.
    alog.warn({ host: hostOf(body?.endpoint), reason: parsed }, "push subscribe rejected");
    return NextResponse.json({ error: parsed }, { status: 400 });
  }
  try {
    const database = db();
    // endpoint is globally unique, so a device moving between accounts (a shared browser,
    // a re-login) reassigns the row. Find the old owner first: without this its cached
    // list would keep pushing this user's alerts to that device until the next reload.
    const [existing] = await database
      .select({ userId: pushSubs.userId })
      .from(pushSubs)
      .where(eq(pushSubs.endpoint, parsed.endpoint));
    await database
      .insert(pushSubs)
      .values({ userId: user.id, ...parsed })
      .onConflictDoUpdate({
        target: pushSubs.endpoint,
        set: { userId: user.id, p256dh: parsed.p256dh, auth: parsed.auth },
      });
    if (existing && existing.userId !== user.id) await removeUserPush(existing.userId, parsed.endpoint);
    await addUserPush(user.id, parsed);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    alog.error({ err: e, method: "POST", path: "/api/push" }, "route error");
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  try {
    // Ownership in the WHERE clause, same as the channels delete: another user's
    // subscription is simply not found rather than reported as forbidden.
    await db()
      .delete(pushSubs)
      .where(and(eq(pushSubs.endpoint, endpoint), eq(pushSubs.userId, user.id)));
    await removeUserPush(user.id, endpoint);
    return NextResponse.json({ ok: true });
  } catch (e) {
    alog.error({ err: e, method: "DELETE", path: "/api/push" }, "route error");
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}

// Host only - the full endpoint is a credential and must never reach a log line.
function hostOf(endpoint: unknown): string {
  if (typeof endpoint !== "string") return "(none)";
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "(unparseable)";
  }
}
