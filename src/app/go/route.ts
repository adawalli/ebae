import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// iOS home-screen PWAs ignore a service-worker openWindow() to a cross-origin URL and just
// reopen the app at its start URL. So notificationclick opens this same-origin bounce, which
// iOS honours, and we 302 out to the listing (which escapes to Safari). The host allowlist
// keeps this from becoming an open redirect: `u` comes off a push payload, but validating it
// here means a crafted /go?u= link can only ever land on eBay.
function toEbay(u: string | null): URL | null {
  if (!u) return null;
  try {
    const target = new URL(u);
    if (target.protocol !== "https:") return null;
    if (target.hostname !== "ebay.com" && !target.hostname.endsWith(".ebay.com")) return null;
    return target;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const target = toEbay(new URL(req.url).searchParams.get("u"));
  return NextResponse.redirect(new URL(target ? target.href : "/", req.url));
}
