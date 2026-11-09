const CACHE_NAME = "mihwar-shell-v152";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./css/tokens.css",
  "./css/base.css",
  "./css/theme.css",
  "./js/app.js",
  "./js/app.js?v=114",
  "./js/router.js",
  "./js/db.js",
  "./js/store.js",
  "./js/sync.js",
  "./js/utils/dates.js",
  "./js/utils/recurrence.js",
  "./js/utils/quickadd.js",
  "./js/utils/okr.js",
  "./js/utils/plans.js",
  "./js/utils/notifications.js",
  "./js/utils/task-metrics.js",
  "./js/utils/life-areas.js",
  "./js/utils/completion-dialog.js",
  "./js/utils/prayer-times.js",
  "./js/views/today.js",
  "./js/views/dashboard.js",
  "./js/views/dashboard.js?v=112",
  "./js/views/tasks.js",
  "./js/views/tasks.js?v=109",
  "./css/theme.css?v=144",
  "./js/views/goals.js",
  "./js/views/habits.js",
  "./js/views/focus.js",
  "./js/views/journal.js",
  "./js/views/reports.js",
  "./js/views/settings.js",
  "./js/views/help.js",
  "./js/export/csv.js",
  "./js/export/xlsx.js",
  "./js/export/pdf.js",
  "./js/export/share.js",
  "./assets/icons/icon.svg",
];

self.addEventListener("install", (event) => {
  const requests = APP_SHELL.map((path) => new Request(new URL(path, self.registration.scope), { cache: "reload" }));
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(requests)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("mihwar-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(caches.match(request).then(async (cached) => {
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch (error) {
        const fallback = await caches.match(new URL("./index.html", self.registration.scope).href);
        if (fallback) return fallback;
        throw error;
      }
    }));
    return;
  }

  if (["script", "style"].includes(request.destination)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    })),
  );
});
