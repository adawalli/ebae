import { NextResponse } from "next/server";
import { EBAY_DOMAIN } from "@/lib/utils";

export const dynamic = "force-dynamic";

// eBay returns marketplace-specific listing domains (ebay.co.uk, ebay.de, …), so the allowlist
// has to cover every marketplace the app supports, not just ebay.com - otherwise a non-US
// listing gets rejected and falls back to "/", reproducing the very bug this route fixes.
const EBAY_HOSTS = new Set(Object.values(EBAY_DOMAIN));

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
    // Exact host or a subdomain of an allowed domain. endsWith(".ebay.de") rejects lookalikes
    // like evilebay.de and ebay.de.attacker.com that a bare suffix check would let through.
    const host = target.hostname;
    const ok = [...EBAY_HOSTS].some((d) => host === d || host.endsWith(`.${d}`));
    return ok ? target : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const target = toEbay(new URL(req.url).searchParams.get("u"));
  return NextResponse.redirect(new URL(target ? target.href : "/", req.url));
}
