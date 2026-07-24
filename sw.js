/* ProspectField service worker
   Strategy:
   - App shell (this page, icons, Leaflet): cache-first, so the app opens with no signal.
   - Map tiles: cache-first with background fill, so pre-downloaded regions work offline.
   - Everything else: network-first, falling back to cache.
   Bump SW_VERSION when the app changes so users get the new build.
*/
const SW_VERSION = 'pf-v11';
const SHELL_CACHE = SW_VERSION + '-shell';
const TILE_CACHE  = 'pf-tiles';          // shared with the in-app region downloader
const ELEV_CACHE  = 'pf-elev';           // terrain elevation profiles (persist across versions)
const RUNTIME     = SW_VERSION + '-runtime';

/* Files the app needs to start with no network at all. */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      // addAll fails the whole install if one item 404s, so add individually
      return Promise.all(SHELL.map(function (url) {
        return c.add(new Request(url, { cache: 'reload' })).catch(function () { /* skip */ });
      }));
    })
    // deliberately NOT calling skipWaiting() here: the page asks the user first,
    // then posts 'skipWaiting'. Swapping mid-session could reload the app while
    // someone is logging a sample.
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // keep the tile + elevation caches (expensive to rebuild), drop old app versions
        if (k === TILE_CACHE || k === ELEV_CACHE) return null;
        if (k.indexOf(SW_VERSION) === 0) return null;
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* 1. Map tiles — cache-first, and store whatever we fetch so panning builds the cache. */
  if (url.hostname.indexOf('tile.openstreetmap.org') > -1 ||
      url.hostname.indexOf('arcgisonline.com') > -1) {
    e.respondWith(
      caches.open(TILE_CACHE).then(function (c) {
        return c.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
            return res;
          }).catch(function () {
            return hit || Response.error();
          });
        });
      })
    );
    return;
  }

  /* 1b. Terrain elevation — network-first, cached so a fetched cross-section still
         draws when you are back offline. Small JSON, safe to keep across versions. */
  if (url.hostname.indexOf('api.open-meteo.com') > -1) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) { const copy = res.clone(); caches.open(ELEV_CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  /* 2. Satellite analysis layers — never cached (they are large and time-bound). */
  if (url.hostname.indexOf('sh.dataspace.copernicus.eu') > -1) return;

  /* 3. Navigation requests — serve the app shell offline. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  /* 4. Everything else — cache-first for the shell, network-first otherwise. */
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(RUNTIME).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
    })
  );
});
