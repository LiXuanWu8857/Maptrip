// ===== 一鍵導航選單（MaptripNav）=====
// 點地圖上的站點/加油站/停車場 → 跳出「用 Google / Apple 導航」選單。
// 為什麼用通用網址（https）而非 App scheme：
//   - Google：maps/dir/?api=1 —— 有裝 Google Maps App 就開 App、沒裝就開網頁，永遠成立。
//   - Apple：maps.apple.com —— iOS 一律開 Apple 地圖。
//   兩者都不需要改 Info.plist 的 LSApplicationQueriesSchemes，也不必偵測有沒有裝。
// 開啟方式用 window.open(url,'_blank')：Capacitor WKWebView 對 _blank 會交給系統處理、
//   啟動對應地圖 App（若日後遇到 WKWebView 攔截，再於 native 委派放行；web 端邏輯不變）。
(function () {
  'use strict';

  // ---- 純函式：組導航網址（供測試）----
  function googleUrl(lat, lng) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' +
           encodeURIComponent(lat + ',' + lng) + '&travelmode=driving';
  }
  function appleUrl(lat, lng) {
    return 'https://maps.apple.com/?daddr=' + encodeURIComponent(lat + ',' + lng) + '&dirflg=d';
  }

  var CSS =
    '#mt-nav-bd{position:fixed;inset:0;background:rgba(0,0,0,.25);z-index:19998;opacity:0;' +
      'pointer-events:none;transition:opacity .2s;}' +
    '#mt-nav-bd.on{opacity:1;pointer-events:auto;}' +
    '#mt-nav{position:fixed;left:0;right:0;bottom:0;z-index:19999;transform:translateY(110%);' +
      'transition:transform .22s ease;}' +
    '#mt-nav.on{transform:translateY(0);}' +
    '#mt-nav .in{max-width:520px;margin:0 auto;background:#fff;border-radius:16px 16px 0 0;' +
      'padding:14px 16px calc(6px + env(safe-area-inset-bottom));box-shadow:0 -6px 24px rgba(0,0,0,.18);}' +
    '#mt-nav h3{font-size:15px;margin:0 0 3px;color:#1a1a1a;}' +
    '#mt-nav .sub{font-size:12.5px;color:#666;margin:0 0 12px;}' +
    '#mt-nav button.nb{display:flex;align-items:center;gap:10px;width:100%;font:inherit;font-size:15px;' +
      'padding:13px 14px;border:1px solid #e2e6ea;background:#fff;color:#1a1a1a;border-radius:12px;' +
      'cursor:pointer;margin-bottom:9px;}' +
    '#mt-nav button.nb .ico{font-size:19px;}' +
    '#mt-nav button.cx{text-align:center;color:#666;background:none;border:none;font:inherit;font-size:14px;' +
      'width:100%;padding:6px 8px 2px;margin-top:2px;cursor:pointer;}' +
    '@media (prefers-color-scheme: dark){' +
      '#mt-nav .in{background:#1c2024;}#mt-nav h3{color:#e8eaed;}#mt-nav .sub{color:#9aa0a6;}' +
      '#mt-nav button.nb{background:#1c2024;color:#e8eaed;border-color:#2a2f34;}' +
      '#mt-nav button.cx{color:#9aa0a6;}}';

  var _dom = null;   // { bd, sheet, name, gBtn, aBtn }
  var _cur = null;   // { lat, lng }

  function _ensureDom() {
    if (_dom) return _dom;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

    var bd = document.createElement('div'); bd.id = 'mt-nav-bd';
    var sheet = document.createElement('div'); sheet.id = 'mt-nav';
    sheet.innerHTML =
      '<div class="in">' +
        '<h3 id="mt-nav-name">導航</h3>' +
        '<p class="sub">要用哪個 App 導航到這裡？</p>' +
        '<button class="nb" id="mt-nav-g"><span class="ico">🟢</span><b>Google 地圖</b></button>' +
        '<button class="nb" id="mt-nav-a"><span class="ico">🍎</span><b>Apple 地圖</b></button>' +
        '<button class="cx" id="mt-nav-x">取消</button>' +
      '</div>';
    document.body.appendChild(bd);
    document.body.appendChild(sheet);

    var d = {
      bd: bd, sheet: sheet,
      name: sheet.querySelector('#mt-nav-name'),
      gBtn: sheet.querySelector('#mt-nav-g'),
      aBtn: sheet.querySelector('#mt-nav-a'),
      xBtn: sheet.querySelector('#mt-nav-x')
    };
    bd.addEventListener('click', close);
    d.xBtn.addEventListener('click', close);
    d.gBtn.addEventListener('click', function () { _go(googleUrl); });
    d.aBtn.addEventListener('click', function () { _go(appleUrl); });
    _dom = d;
    return d;
  }

  function _go(builder) {
    if (!_cur) return;
    try { window.open(builder(_cur.lat, _cur.lng), '_blank'); } catch (e) {}
    close();
  }

  // 開啟導航選單：name 目的地名稱、lat/lng 座標
  function open(name, lat, lng) {
    if (lat == null || lng == null) return;
    var d = _ensureDom();
    _cur = { lat: lat, lng: lng };
    d.name.textContent = '導航到：' + (name || '這個地點');
    d.bd.classList.add('on'); d.sheet.classList.add('on');
  }
  function close() {
    if (!_dom) return;
    _dom.bd.classList.remove('on'); _dom.sheet.classList.remove('on');
    _cur = null;
  }

  window.MaptripNav = {
    open: open, close: close,
    googleUrl: googleUrl, appleUrl: appleUrl
  };
})();
