// ebae's service worker exists only to receive push. There is deliberately no offline
// caching: the UI is a live dashboard that re-polls every 10s and has nothing useful to
// say without the server. Installability doesn't need a service worker either - it needs
// the manifest, the 192/512 icons, and HTTPS.

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    // A payload we can't parse still has to raise something visible: iOS counts a push
    // that shows no notification as a silent-push violation and drops the subscription
    // after a few of them.
  }
  const title = d.title || "New listing";
  // waitUntil is mandatory, not tidiness: without it the worker can be killed before the
  // notification is shown, which iOS also scores as a silent push.
  event.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      image: d.image || undefined,
      // Same listing twice (a redelivery) replaces rather than stacks.
      tag: d.tag || undefined,
      data: { url: d.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Straight to the listing. No matchAll/focus dance: the target is an ebay.com URL and
  // matchAll only ever returns this origin's own clients, so there is nothing to match.
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(self.clients.openWindow(url));
});
