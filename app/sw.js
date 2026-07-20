/* Daily — service worker. Push display + click-through. No caching (yet):
   the app is small and always-fresh beats stale. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || "Daily", {
      body: data.body || "",
      icon: "/app/icon-192.png",
      badge: "/app/icon-192.png",
      tag: data.tag || "daily",
      data: { url: data.url || "/app/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/app/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes("/app") && "focus" in w) return w.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
