// Service worker de Súper Predict: solo recibe y muestra los avisos push (no guarda nada en caché).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { t: "Súper Predict", b: e.data ? e.data.text() : "" }; }
  // Número rojo del icono: el servidor manda en "n" los partidos abiertos que aún no has pronosticado; así se actualiza aunque la app esté cerrada
  const nav = self.navigator, insignia = typeof d.n === "number" && nav && "setAppBadge" in nav
    ? (d.n > 0 ? nav.setAppBadge(d.n) : nav.clearAppBadge()).catch(() => {}) : null;
  e.waitUntil(Promise.all([insignia, self.registration.showNotification(d.t || "Súper Predict", {
    body: d.b || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || undefined,
    renotify: !!d.tag,   // misma etiqueta (p. ej. dos pruebas seguidas): el aviso vuelve a sonar en vez de cambiarse en silencio
    data: { url: d.url || "/" },
  })]));
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

// Si el navegador renueva o invalida la suscripción por su cuenta, se vuelve a suscribir y se lo cuenta al servidor
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    try {
      const old = e.oldSubscription;
      const key = (old && old.options && old.options.applicationServerKey) || (e.newSubscription && e.newSubscription.options && e.newSubscription.options.applicationServerKey);
      const sub = e.newSubscription || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
      if (!sub || !old) return;
      await fetch("/api/push/resub", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ old: old.endpoint, sub: sub.toJSON() }) });
    } catch (_) {}
  })());
});
