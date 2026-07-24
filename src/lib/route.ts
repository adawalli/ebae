import { NextResponse } from "next/server";
import { log, redact } from "@/lib/log";

const alog = log.child({ component: "api" });

// Every DB-touching handler ends its catch the same way: log the failure with method+path,
// then answer. Two shapes exist - a redacted 500 that surfaces the cause (writes), or a fixed
// 503 "Service unavailable" for reads that must reveal nothing. Centralized so a new handler
// can't forget the redact() safeguard or the structured log shape.
export function routeError(
  e: unknown,
  ctx: { method: string; path: string },
  opts?: { status?: number; unavailable?: boolean },
): NextResponse {
  alog.error({ err: e, method: ctx.method, path: ctx.path }, "route error");
  if (opts?.unavailable) return NextResponse.json({ error: "Service unavailable" }, { status: opts.status ?? 503 });
  return NextResponse.json(
    { error: redact(e instanceof Error ? e.message : String(e)) },
    { status: opts?.status ?? 500 },
  );
}

// Read + JSON-parse a request body, or a 400 the caller returns as-is. Callers narrow the
// success value with `if (body instanceof NextResponse) return body;`.
export async function readJsonBody(req: Request): Promise<unknown | NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  return body;
}

// Run a validator whose contract is `T | string` (string = the error message), turning the
// error branch into a 400. Same narrow-on-NextResponse convention as readJsonBody.
export function parseOr400<T>(body: unknown, parser: (b: unknown) => T | string): T | NextResponse {
  const parsed = parser(body);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  return parsed;
}
