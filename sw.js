/* ProspectField service worker — self-updating, no version number to bump.

   - The app opens instantly from the cache (important on weak rural signal).
   - On every launch, and whenever the app returns to the foreground, the page
     sends "check": every app file is re-fetched past the HTTP cache, the cache is
     refreshed, and if index.html came back different every open window is sent
     "updated" so it can offer a one-tap Refresh.
   - Map tiles, terrain heights and the GeoPackage library live in their own
     caches that survive updates (expensive or slow to rebuild).

   After a change: just push. There is nothing to bump. */
"use strict";

var CACHE_PREFIX = "pf-";           /* every ProspectField cache starts with this — see activate */
var CACHE      = "pf-shell";        /* fixed name; never changes between deploys */
var TILE_CACHE = "pf-tiles";        /* map tiles (shared with the in-app region downloader) */
var ELEV_CACHE = "pf-elev";         /* terrain elevation profiles */
var LIB_CACHE  = "pf-libs";         /* on-demand libraries (sql.js for GeoPackage) */
var KEEP = [CACHE, TILE_CACHE, ELEV_CACHE, LIB_CACHE];
var INDEX = "./index.html";

/* Same-origin files: re-checked on every "check". */
var SHELL = [
  INDEX,
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
  "./favicon-32.png"
];
/* Pinned third-party files the app needs offline. The URLs carry an exact version, so
   they never change: fetched once at install (if missing), not re-checked. */
var CDN = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

function sameBytes(a, b){
  if (a.byteLength !== b.byteLength) return false;
  var x = new Uint8Array(a), y = new Uint8Array(b);
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/* Fetch one file past the HTTP cache and store it. Resolves true only when a copy was
   already cached and the new one differs. Errors and non-200 responses leave the cache
   alone, so a 404/503 from the host can never replace the offline app. */
function refresh(url){
  return fetch(url, { cache: "no-cache" }).then(function(res){
    if (!res || !res.ok) return false;
    return caches.open(CACHE).then(function(c){
      return c.match(url).then(function(old){
        return Promise.all([
          old ? old.arrayBuffer() : null,
          res.clone().arrayBuffer()
        ]).then(function(b){
          var changed = !!b[0] && !sameBytes(b[0], b[1]);
          return c.put(url, res).then(function(){ return changed; });
        });
      });
    });
  }).catch(function(){ return false; });
}

function refreshShell(){
  return Promise.all(SHELL.map(refresh)).then(function(changed){
    return changed[SHELL.indexOf(INDEX)];
  });
}

function fetchCdnOnce(){
  return caches.open(CACHE).then(function(c){
    return Promise.all(CDN.map(function(u){
      return c.match(u).then(function(hit){
        if (hit) return null;
        return fetch(u, { mode: "cors" }).then(function(res){
          if (res && res.ok) return c.put(u, res);
        }).catch(function(){ /* offline first install: the page still works without the map */ });
      });
    }));
  });
}

/* install: precache, then take over at once. Safe because the cache name is stable —
   a new worker never strands an open page on a deleted cache. */
self.addEventListener("install", function(e){
  e.waitUntil(Promise.all([refreshShell(), fetchCdnOnce()]).then(function(){ return self.skipWaiting(); }));
});

/* activate: delete only THIS app's other caches (the old versioned "pf-v22-shell" etc.).
   Cache Storage is shared by the whole origin — on <user>.github.io that is every
   project page — so never touch a cache without our prefix. */
self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        return (k.indexOf(CACHE_PREFIX) === 0 && KEEP.indexOf(k) < 0) ? caches.delete(k) : null;
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

/* Cache-first into a named cache, storing whatever arrives (opaque tiles included). */
function cacheFirst(cacheName, req, keepOpaque){
  return caches.open(cacheName).then(function(c){
    return c.match(req).then(function(hit){
      if (hit) return hit;
      return fetch(req).then(function(res){
        if (res && (res.ok || (keepOpaque && res.type === "opaque"))) c.put(req, res.clone());
        return res;
      });
    });
  });
}

self.addEventListener("fetch", function(e){
  var req = e.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  /* Map tiles — cache-first, and store what we fetch so panning builds the offline map. */
  if (url.hostname.indexOf("tile.openstreetmap.org") > -1 || url.hostname.indexOf("arcgisonline.com") > -1){
    e.respondWith(cacheFirst(TILE_CACHE, req, true).catch(function(){ return Response.error(); }));
    return;
  }
  /* sql.js for GeoPackage export — pinned version, cache-first so exports work offline. */
  if (url.hostname === "cdnjs.cloudflare.com" && url.pathname.indexOf("/ajax/libs/sql.js/") === 0){
    e.respondWith(cacheFirst(LIB_CACHE, req, false).catch(function(){ return offlineResponse(false); }));
    return;
  }
  /* Terrain elevation — network-first, cached so a fetched profile still draws offline. */
  if (url.hostname.indexOf("api.open-meteo.com") > -1){
    e.respondWith(
      fetch(req).then(function(res){
        if (res && res.ok){ var copy = res.clone(); caches.open(ELEV_CACHE).then(function(c){ c.put(req, copy); }); }
        return res;
      }).catch(function(){ return caches.match(req); })
    );
    return;
  }
  /* Leaflet (pinned) — served from the shell cache so the map works offline. */
  if (CDN.indexOf(req.url) > -1){
    e.respondWith(caches.match(req.url).then(function(hit){ return hit || fetch(req); }).catch(function(){ return offlineResponse(false); }));
    return;
  }
  /* Everything else cross-origin (Copernicus imagery, WhatsApp, Google Maps…) is left alone. */
  if (url.origin !== self.location.origin) return;

  /* The app itself → the cached copy, instantly; the network only if nothing is cached yet.
     Freshness comes from the page's "check" message, not from here. "The app itself" means
     any navigation, and also a plain request for the scope root or index.html (with or
     without ?query) — Chrome's installability / offline check fetches the start page that
     way, not as a navigation, and must get the app back even with no network. */
  var scopePath = new URL("./", self.registration.scope).pathname;
  var isApp = req.mode === "navigate" || url.pathname === scopePath || url.pathname === scopePath + "index.html";
  if (isApp){
    e.respondWith(
      caches.match(INDEX).then(function(hit){
        if (hit) return hit;
        return fetch(req).then(function(res){
          if (res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(INDEX, copy); }); }
          return res;
        }).catch(function(){ return offlineResponse(true); });
      })
    );
    return;
  }

  /* Other same-origin files → cache first, then network, keeping good responses. */
  e.respondWith(
    caches.match(req).then(function(hit){
      if (hit) return hit;
      return fetch(req).then(function(res){
        if (res && res.status === 200 && res.type === "basic"){
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put(req, copy); });
        }
        return res;
      }).catch(function(){ return offlineResponse(false); });
    })
  );
});

/* Never let a fetch handler reject (that shows up as "Failed to fetch" / "network error
   response" in the console): answer with a plain offline response instead. */
function offlineResponse(isPage){
  return new Response(isPage
      ? "<!doctype html><meta charset=utf-8><title>ProspectField</title><p style=\"font:16px system-ui;padding:24px\">ProspectField needs to be opened once with internet before it works offline.</p>"
      : "", {status: 503, statusText: "Offline", headers: {"Content-Type": isPage ? "text/html; charset=utf-8" : "text/plain"}});
}

/* "check" from a page: refresh the app files and, if index.html changed, tell every
   open window so each can offer a reload. ("skipWaiting" is still accepted from pages
   running the previous build, which used it to activate updates.) */
self.addEventListener("message", function(e){
  if (e.data === "skipWaiting"){ self.skipWaiting(); return; }
  if (e.data !== "check") return;
  e.waitUntil(
    refreshShell().then(function(changed){
      if (!changed) return;
      return self.clients.matchAll({ type: "window" }).then(function(list){
        list.forEach(function(c){ c.postMessage("updated"); });
      });
    })
  );
});
