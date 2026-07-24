import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { buyingOptionLabel, money } from "./format";
import { log } from "./log";
import { vapidKeys } from "./schema";
import type { Item, PushSub, Search } from "./types";

const plog = log.child({ component: "push" });

// A contact URI for the application, not for this deployment. It is deliberately a
// constant: deriving it from the app's own URL would yield a localhost subject on the
// default setup, and Apple rejects those with 403 BadJwtToken - so every iPhone would
// silently get nothing while Chrome and Firefox worked fine. Override if you'd rather
// the push services could reach you rather than the project.
const SUBJECT = process.env.VAPID_SUBJECT ?? "https://github.com/adawalli/ebae";

// A listing alert is only actionable while the listing is live, so it expires in an
// hour rather than web-push's 4-week default (which would announce an item that sold
// three weeks ago). No `topic`: topics coalesce, so five listings matching one search
// while the phone is offline would collapse into only the newest.
const TTL_SECONDS = 3600;

type Vapid = { publicKey: string; privateKey: string };

let cached: Vapid | null = null;

// Env first, else the single vapid_keys row, else generate one. Never called from
// tryBoot: a failure here must not reach st.bootError, because a failing insert's
// message carries the params - and the params are the keypair.
export async function vapid(): Promise<Vapid | null> {
  if (cached) return cached;
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (pub && priv) {
    cached = { publicKey: pub, privateKey: priv };
    return cached;
  }
  try {
    const database = db();
    const [row] = await database.select().from(vapidKeys).where(eq(vapidKeys.id, 1));
    if (row) {
      cached = { publicKey: row.publicKey, privateKey: row.privateKey };
      return cached;
    }
    const kp = webpush.generateVAPIDKeys();
    // onConflictDoNothing + re-select: two requests can race here on a cold start, and
    // the loser must end up with the winner's keys, not its own (same pattern as auth.ts).
    await database
      .insert(vapidKeys)
      .values({ id: 1, ...kp })
      .onConflictDoNothing();
    const [saved] = await database.select().from(vapidKeys).where(eq(vapidKeys.id, 1));
    if (!saved) return null;
    cached = { publicKey: saved.publicKey, privateKey: saved.privateKey };
    plog.info("generated a VAPID keypair");
    return cached;
  } catch (e) {
    // Deliberately not the error message: on a query failure drizzle puts the bound
    // params in it, and here those are the private key.
    plog.error({ type: e instanceof Error ? e.name : "error" }, "VAPID key lookup failed");
    return null;
  }
}

function body(item: Item, search: Search) {
  const price = item.price == null ? "" : money(item.price, item.currency);
  const ship = item.shippingCost === 0 ? " · free shipping" : "";
  return JSON.stringify({
    title: item.title ?? "Untitled listing",
    body: [price + ship, buyingOptionLabel(item.buyingOption), item.condition].filter(Boolean).join(" · "),
    url: item.itemUrl,
    image: item.imageUrl,
    tag: `${search.id}:${item.itemId}`, // dedupes a redelivery against the same listing
  });
}

// Sends to every subscription. Never throws - a dead device must not stall the poll loop.
// Mirrors discord.ts's notify(): same return shape, and logs identify a subscription by
// index, never by endpoint (which is bearer-equivalent). `dead` carries the endpoints the
// push service rejected for good; the caller owns deleting them.
export async function notifyPush(
  item: Item,
  search: Search,
  subs: PushSub[],
): Promise<{ error: string | null; anyDelivered: boolean; dead: string[] }> {
  const keys = await vapid();
  if (!keys) return { error: "push is not configured", anyDelivered: false, dead: [] };
  const payload = body(item, search);
  let lastError: string | null = null;
  let anyDelivered = false;
  const dead: string[] = [];

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
        vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: TTL_SECONDS,
        urgency: "high", // beating other buyers to the listing is the entire point
      });
      anyDelivered = true;
      plog.debug({ sub: i }, "delivered");
    } catch (e) {
      // web-push rejects on every non-2xx, so the status has to be discriminated: only
      // 404/410 mean the subscription is gone for good. Deleting on anything else would
      // reap live subscriptions on a transient 500, and would wipe every iOS subscriber
      // on the 403 a bad VAPID subject produces.
      const status = (e as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        dead.push(s.endpoint);
        plog.debug({ sub: i, status }, "subscription gone - reaping");
        continue;
      }
      lastError = status ? `Push ${status}` : `Push send failed (${e instanceof Error ? e.name : "error"})`;
      plog.warn({ sub: i, status }, "push failed");
    }
  }
  return { error: lastError, anyDelivered, dead };
}
