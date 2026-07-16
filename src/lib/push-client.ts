// Browser half of Web Push. Server-side lives in push.ts.

// Feature detection is the whole capability test. Notably it also answers "is this an
// installed iOS web app?" for free: iOS exposes PushManager only in an installed app, so
// a Safari tab fails this check and never sees the UI. matchMedia(display-mode) and
// navigator.standalone would only re-derive the same answer.
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

async function ready(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js");
  // Not the register() result: subscribing before the worker controls the page is a
  // documented silent no-op.
  return navigator.serviceWorker.ready;
}

const UNCONFIGURED = "Push is not configured on this server.";

// The server's VAPID public key, or a message saying why there isn't one.
async function publicKey(): Promise<{ key: string } | { error: string }> {
  const res = await fetch("/api/push");
  // Only reachable behind an auth proxy, but worth its own message: "not configured" would
  // send someone hunting a server problem when reloading the page is the whole fix.
  if (res.status === 401) return { error: "Your session expired. Reload the page and try again." };
  if (!res.ok) return { error: UNCONFIGURED }; // 503 = push isn't configured
  const key = (await res.json())?.publicKey;
  return typeof key === "string" ? { key } : { error: UNCONFIGURED };
}

// A subscription is bound to the VAPID key that created it. If the server's key has since
// changed (an operator pinned VAPID_* over an auto-generated pair), the old subscription
// still looks healthy to the browser but every send fails with a 400 - and 400 is not a
// reaping status, so the row would sit there dead forever.
function boundTo(sub: PushSubscription, key: string): boolean {
  const raw = sub.options.applicationServerKey;
  if (!raw) return false;
  const bytes = new Uint8Array(raw);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === key;
}

// "stale" is the server saying a push service already declared this endpoint dead, so the
// subscription has to be replaced rather than re-asserted.
type SaveResult = "ok" | "stale" | "failed";

async function save(sub: PushSubscription): Promise<SaveResult> {
  const res = await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // toJSON() gives {endpoint, expirationTime, keys:{p256dh, auth}} already base64url'd.
    body: JSON.stringify(sub.toJSON()),
  });
  if (res.ok) return "ok";
  return res.status === 409 ? "stale" : "failed";
}

// Drops whatever this registration holds and mints a new subscription. Unsubscribing first
// is not optional: subscribe() throws InvalidStateError while a subscription on a different
// key is still live.
async function resubscribe(reg: ServiceWorkerRegistration, key: string): Promise<PushSubscription> {
  const old = await reg.pushManager.getSubscription();
  await old?.unsubscribe();
  return reg.pushManager.subscribe({
    userVisibleOnly: true, // required by Chrome and Edge; they reject without it
    // A base64url string is accepted directly - the urlBase64ToUint8Array helper that
    // every tutorial copies has been unnecessary for years.
    applicationServerKey: key,
  });
}

// Subscribes this device and registers it server-side. Returns an error string, or null
// on success.
export async function enablePush(): Promise<string | null> {
  if (Notification.permission === "denied") return "Notifications are blocked for this site in your browser.";
  const pk = await publicKey();
  if ("error" in pk) return pk.error;
  // Must be called from a user gesture; Safari in particular ignores it otherwise.
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notification permission was not granted.";
  const reg = await ready();
  const held = await reg.pushManager.getSubscription();
  const sub = held && boundTo(held, pk.key) ? held : await resubscribe(reg, pk.key);
  let saved = await save(sub);
  // The browser handed back an endpoint the server knows is dead. One retry only: a freshly
  // minted endpoint that still comes back stale is not something a loop can fix.
  if (saved === "stale") saved = await save(await resubscribe(reg, pk.key));
  return saved === "ok" ? null : "Could not save the subscription.";
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  // Unsubscribe first, then drop the row. The other order turns push back on behind the
  // user's back: if unsubscribe() throws once the row is gone, the browser still holds a
  // live subscription and the next refreshPush() posts it straight back. This way a failed
  // DELETE only strands a row whose endpoint now 410s, which the next alert reaps.
  await sub.unsubscribe();
  await fetch("/api/push", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported() || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

// Re-registers this device's existing subscription with the server. Called on every app
// load, because a subscribe-once model rots: iOS silently expires endpoints after a week
// or two and after inactivity, and Chrome revokes notification permission for sites the
// user rarely opens. Both happen with no event, so the only way to notice is to re-assert
// on load. Cheap - it POSTs only when the browser still holds a subscription, and the
// upsert is keyed on the endpoint.
export async function refreshPush(): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (!sub) return;
    const pk = await publicKey();
    if ("error" in pk) return;
    // Two ways a subscription the browser still calls healthy is already dead, neither of
    // which it reports: the push service expired the endpoint (iOS does this silently and
    // Safari fires no pushsubscriptionchange - the server saw the 404/410 and answers 409
    // here), or VAPID_* was rotated and every send now 400s, which is deliberately never
    // reaped so nothing else would ever notice. Re-asserting either just leaves it dead
    // with the toggle still showing push as on. Replacing is the only way out, and an app
    // load is the one moment we can find out.
    const dead = !boundTo(sub, pk.key) || (await save(sub)) === "stale";
    // ready() rather than a fresh register: currentSubscription() already found a worker.
    if (dead) await save(await resubscribe(await ready(), pk.key));
  } catch {
    // Never surface: this is background maintenance the user didn't ask for.
  }
}
