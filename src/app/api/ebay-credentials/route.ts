import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { type EbayCreds, requestToken } from "@/lib/ebay";
import { log, redact } from "@/lib/log";
import { setUserCreds } from "@/lib/poller";
import { users } from "@/lib/schema";
import { parseEbayCredsBody } from "@/lib/validate";

const alog = log.child({ component: "api" });

export const dynamic = "force-dynamic";

// There is deliberately no GET. Whether creds exist, plus clientId/env/marketplace, ride on
// /api/status; the client secret is write-only and no API returns it in any form, encrypted
// or masked. Reading it back is a feature nobody needs and a leak everyone would inherit.

export async function PUT(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  // Checked before the eBay round-trip: with no key there is nowhere to put the secret, so
  // validating it first would just be a wasted call. Single-mode deployments on env creds
  // never save through the UI and so never need one.
  if (!process.env.ENCRYPTION_KEY?.trim())
    return NextResponse.json(
      {
        error:
          "ENCRYPTION_KEY is not set, so this server cannot store credentials (generate with: openssl rand -base64 32)",
      },
      { status: 503 },
    );
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const parsed = parseEbayCredsBody(body);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });

  const creds: EbayCreds = { userId: user.id, ...parsed };
  try {
    // Prove the keys mint a token before storing them, so a typo is a message in the UI now
    // rather than a search that silently never polls.
    await requestToken(creds);
  } catch (e) {
    // The message is eBay's own status + body (requestToken never puts the Basic header or the
    // secret in it); redact() is a second pair of hands, not the guarantee.
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 400 });
  }

  try {
    await db()
      .update(users)
      .set({
        ebayClientId: parsed.clientId,
        // AAD binds the ciphertext to this user id: moved to another row, it stops decrypting.
        ebayClientSecretEnc: encryptSecret(parsed.clientSecret, String(user.id)),
        ebayEnv: parsed.env,
        ebayMarketplace: parsed.marketplace,
        ebayVerifiedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    // Write-through, or the save sits inert until the next reload 12h from now.
    await setUserCreds(user.id, creds);
    return NextResponse.json({ ok: true });
  } catch (e) {
    alog.error({ err: e, method: "PUT", path: "/api/ebay-credentials" }, "route error");
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}

// Clears the keys; the user's searches go idle (mode "no-creds") rather than being deleted.
// env/marketplace stay: they're preferences, not secrets, and are the defaults if keys return.
export async function DELETE(req: Request) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  try {
    await db()
      .update(users)
      .set({ ebayClientId: null, ebayClientSecretEnc: null, ebayVerifiedAt: null })
      .where(eq(users.id, user.id));
    await setUserCreds(user.id, null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    alog.error({ err: e, method: "DELETE", path: "/api/ebay-credentials" }, "route error");
    return NextResponse.json({ error: redact(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
