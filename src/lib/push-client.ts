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

async function publicKey(): Promise<string | null> {
  const res = await fetch("/api/push");
  if (!res.ok) return null; // 503 = push isn't configured
  return (await res.json()).publicKey ?? null;
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

async function save(sub: PushSubscription): Promise<boolean> {
  const res = await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // toJSON() gives {endpoint, expirationTime, keys:{p256dh, auth}} already base64url'd.
    body: JSON.stringify(sub.toJSON()),
  });
  return res.ok;
}

// Subscribes this device and registers it server-side. Returns an error string, or null
// on success.
export async function enablePush(): Promise<string | null> {
  if (Notification.permission === "denied") return "Notifications are blocked for this site in your browser.";
  const key = await publicKey();
  if (!key) return "Push is not configured on this server.";
  // Must be called from a user gesture; Safari in particular ignores it otherwise.
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notification permission was not granted.";
  const reg = await ready();
  let sub = await reg.pushManager.getSubscription();
  // subscribe() throws InvalidStateError if a subscription on a different key is still
  // live, so the stale one has to go first rather than just being resubscribed over.
  if (sub && !boundTo(sub, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true, // required by Chrome and Edge; they reject without it
    // A base64url string is accepted directly - the urlBase64ToUint8Array helper that
    // every tutorial copies has been unnecessary for years.
    applicationServerKey: key,
  });
  return (await save(sub)) ? null : "Could not save the subscription.";
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/push", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe();
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
    if (sub) await save(sub);
  } catch {
    // Never surface: this is background maintenance the user didn't ask for.
  }
}
