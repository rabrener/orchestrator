// Minimal service worker — exists only so Chrome treats the app as installable.
// No offline caching, no asset preload — keeps localhost dev iteration simple.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Pass through to network. Intentional no-op.
});
