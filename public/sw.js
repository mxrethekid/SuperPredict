// Service worker de Súper Predict: solo recibe y muestra los avisos push (no guarda nada en caché).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { t: "Súper Predict", b: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.t || "Súper Predict", {
    body: d.b || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) if ("focus" in w) return w.focus();   // si la app ya está abierta, se trae al frente
    return self.clients.openWindow(url);
  })());
});
