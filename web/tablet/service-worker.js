var CACHE = 'jeeves-tablet-v1';
self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(cache) {
    return cache.addAll(['/tablet/', '/tablet/index.html', '/tablet/css/tablet.css', '/tablet/js/app.js', '/tablet/js/websocket.js', '/tablet/js/audio-capture.js', '/tablet/js/dashboard.js', '/tablet/js/keep-alive.js']);
  }).then(function() { return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
  }).then(function() { return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e) {
  e.respondWith(caches.match(e.request).then(function(cached) {
    return cached || fetch(e.request);
  }));
});
