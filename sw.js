// Service Worker v1.1.260
// 職責：
// 1. 導覽（index.html）：網路優先（no-store，永遠拿最新版），但「4 秒沒回應或離線」
//    → 改用上次成功的快取副本。修正：過隧道/地下室時 WKWebView 行程被砍後重載，
//    以前必定白屏（no-store 且無任何後備），現在直接用快取秒開。
// 2. 自家版本化資源（?v=）與鎖定版本的地圖函式庫（leaflet/maplibre，URL 即版本）：
//    快取優先。重載/離線時不必重抓，恢復速度大幅加快。
// 3. 其他請求（Google 圖磚、向量圖磚、Firebase…）一律不攔截，照常走網路。
// 快取名稱帶版本號：升版啟用新 SW 時自動刪除舊版快取。
var VER = 'v1.1.260';
var CORE = 'mt-core-' + VER;      // index.html 離線後備
var ASSETS = 'mt-assets-' + VER;  // 版本化資源 + 函式庫
var INDEX_KEY = self.registration.scope + '__index__';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k !== CORE && k !== ASSETS; })
      .map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

// 鎖定版本的第三方函式庫／向量地圖靜態資源（URL 內含版本，內容不變 → 可安心快取優先）。
// 注意排除 openfreemap 的向量「圖磚」資料（/planet 路徑，量大且會輪替）。
function isLib(u) {
  if (/(^|\.)(unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)$/.test(u.hostname) &&
      /(leaflet|maplibre)/.test(u.pathname)) return true;
  if (u.hostname === 'tiles.openfreemap.org' &&
      /^\/(styles|sprites|fonts)\//.test(u.pathname)) return true;
  return false;
}

self.addEventListener('fetch', function (e) {
  var u;
  try { u = new URL(e.request.url); } catch (_) { return; }

  // ---- 導覽：網路優先（拿最新），4 秒逾時 / 失敗 → 快取後備 ----
  if (e.request.mode === 'navigate') {
    e.respondWith((async function () {
      var cache = await caches.open(CORE);
      var net = fetch(e.request.url, { cache: 'no-store' }).then(function (r) {
        if (r && r.ok) cache.put(INDEX_KEY, r.clone());
        return r;
      }).catch(function () { return null; });
      var slow = new Promise(function (res) { setTimeout(res, 4000); })
        .then(function () { return cache.match(INDEX_KEY); });
      var r = await Promise.race([net, slow]);
      if (r) return r;
      r = await cache.match(INDEX_KEY);            // 網路快速失敗（明確離線）時
      if (r) return r;
      return fetch(e.request);                     // 從未成功載入過：照原樣送出
    })());
    return;
  }

  // ---- 自家版本化資源（?v=）：快取優先，URL 變（升版）自然失效 ----
  if (u.origin === self.location.origin && u.search.indexOf('v=') >= 0) {
    e.respondWith((async function () {
      var hit = await caches.match(e.request.url);
      if (hit) return hit;
      var r = await fetch(e.request);
      if (r && r.ok) {
        var cache = await caches.open(ASSETS);
        cache.put(e.request.url, r.clone());
      }
      return r;
    })());
    return;
  }

  // ---- 鎖定版本的函式庫：快取優先；以 CORS 重抓（可驗證 r.ok，避免把錯誤頁存進快取）----
  if (isLib(u)) {
    e.respondWith((async function () {
      var hit = await caches.match(e.request.url);
      if (hit) return hit;
      try {
        var r = await fetch(e.request.url, { mode: 'cors' });
        if (r && r.ok) {
          var cache = await caches.open(ASSETS);
          cache.put(e.request.url, r.clone());
          return r;
        }
      } catch (_) {}
      return fetch(e.request);                     // CORS 不通就照原樣送出（不快取）
    })());
    return;
  }
  // 其他請求：不攔截
});
