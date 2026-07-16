import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { status } from "@/lib/poller";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json(status(user.id));
}
