// OnSite service worker: shows alerts when the app is closed, opens the right screen when tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(
    self.registration.showNotification(d.title || "OnSite", {
      body: d.body || "",
      tag: d.tag,
      renotify: Boolean(d.tag),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: typeof d.url === "string" ? d.url : "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only ever open this app: resolve the link and compare origins ("//elsewhere" and "/\elsewhere" resolve off-site).
  let target;
  try { target = new URL(event.notification.data?.url || "/", self.location.origin); } catch { target = null; }
  const url = target && target.origin === self.location.origin ? target.href : self.location.origin + "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => { try { return new URL(w.url).origin === self.location.origin; } catch { return false; } });
      if (!open) return self.clients.openWindow(url);
      // navigate() refuses windows this worker doesn't control yet — open a fresh one instead of doing nothing
      return open.navigate(url).then((w) => (w || open).focus(), () => self.clients.openWindow(url));
    })
  );
});
