// ===== 開始行程後跳轉 App（MaptripAutoNav，v1.1.459）=====
// 按「開始行程」後（僅前景），跳出選單讓司機選要切到哪個 App（預設：55688 司機版、Google 地圖）。
// 設定面板：總開關＋每個 App 是否出現在選單（開關）。只勾一個 App ＝直接跳、不問。
//
// 開啟方式：window.open(scheme,'_blank')，Capacitor WKWebView 把非 http(s) 交給 iOS 開對應 App
// （同 tel:／導航，不需改 Info.plist：UIApplication.open 不需 LSApplicationQueriesSchemes）。
// 後備：開了 scheme 後 1.5 秒畫面仍在前景＝沒跳走（沒裝／scheme 不對）→ 改開 fallback 網址
//   （Google＝地圖網頁、55688＝App Store 頁面，已安裝時頁面上就是「開啟」鈕）。
// 舊版旗標 maptrip_autonav（'1'/'0'）沿用為總開關。
(function () {
  'use strict';
  var global = window;

  var MASTER_KEY = 'maptrip_autonav';        // 總開關（v1.1.454 起）
  var PREF_KEY = 'maptrip_autonav_apps';     // { on: {id:bool} }

  // App 清單（預設 on＝出現在選單）
  var APPS = [
    { id: 'taxi55688', name: '55688 司機版', icon: '🚕', def: true,
      url: 'taiwantaxidriver://',
      fallback: 'https://apps.apple.com/tw/app/id1190486682' },
    { id: 'gmaps', name: 'Google 地圖', icon: '🟢', def: true,
      url: 'comgooglemaps://',
      fallback: 'https://www.google.com/maps' },
    { id: 'amaps', name: 'Apple 地圖', icon: '🍎', def: false,
      url: 'maps://',
      fallback: '' }
  ];

  function _ls(k) { try { return global.localStorage.getItem(k); } catch (_) { return null; } }
  function _lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (_) {} }

  function isOn() { return _ls(MASTER_KEY) === '1'; }
  function setOn(v) { _lsSet(MASTER_KEY, v ? '1' : '0'); _syncMenuLabel(); }

  function _prefs() {
    var p = null; try { p = JSON.parse(_ls(PREF_KEY) || 'null'); } catch (_) {}
    return (p && typeof p === 'object' && p.on && typeof p.on === 'object') ? p : { on: {} };
  }
  function appOn(id) {
    var p = _prefs();
    if (Object.prototype.hasOwnProperty.call(p.on, id)) return !!p.on[id];
    var a = _find(id); return !!(a && a.def);
  }
  function setAppOn(id, v) {
    var p = _prefs(); p.on[id] = !!v; _lsSet(PREF_KEY, JSON.stringify(p));
  }
  function _find(id) { for (var i = 0; i < APPS.length; i++) if (APPS[i].id === id) return APPS[i]; return null; }
  function enabledApps() { return APPS.filter(function (a) { return appOn(a.id); }); }

  // 純函式：行程開始時要做什麼 → 'none' | 'direct' | 'pick'
  function decide(masterOn, visible, nEnabled) {
    if (!masterOn || !visible || nEnabled <= 0) return 'none';
    return nEnabled === 1 ? 'direct' : 'pick';
  }

  // 開 App：scheme → 1.5 秒仍在前景就開後備網址
  function launch(id) {
    var a = _find(id); if (!a) return;
    try { global.__mtLog && global.__mtLog('autonav:open ' + id); } catch (_) {}
    var left = false;
    function onHide() { if (document.visibilityState === 'hidden') left = true; }
    function onBlur() { left = true; }
    document.addEventListener('visibilitychange', onHide);
    global.addEventListener('blur', onBlur);
    try { global.open(a.url, '_blank'); } catch (_) {}
    setTimeout(function () {
      document.removeEventListener('visibilitychange', onHide);
      global.removeEventListener('blur', onBlur);
      if (!left && a.fallback && document.visibilityState === 'visible') {
        try { global.__mtLog && global.__mtLog('autonav:fallback ' + id); } catch (_) {}
        try { global.open(a.fallback, '_blank'); } catch (_) {}
      }
    }, 1500);
  }

  // 行程開始時呼叫（recorder.beginRecording）
  function onTripStart() {
    var visible = (typeof document === 'undefined') || document.visibilityState === 'visible';
    var apps = enabledApps();
    var d = decide(isOn(), visible, apps.length);
    if (d === 'none') return d;
    setTimeout(function () {
      if (d === 'direct') launch(apps[0].id);
      else openPicker();
    }, 350);   // 讓「行程開始！」toast、存檔、原生方塊切換先跑完
    return d;
  }

  // ---------- UI ----------
  var CSS =
    '#mt-an-bd{position:fixed;inset:0;background:rgba(0,0,0,.25);z-index:19998;opacity:0;pointer-events:none;transition:opacity .2s;}' +
    '#mt-an-bd.on{opacity:1;pointer-events:auto;}' +
    '.mt-an{position:fixed;left:0;right:0;bottom:0;z-index:19999;transform:translateY(110%);transition:transform .22s ease;}' +
    '.mt-an.on{transform:translateY(0);}' +
    '.mt-an .in{max-width:520px;margin:0 auto;background:#fff;border-radius:16px 16px 0 0;' +
      'padding:14px 16px calc(6px + env(safe-area-inset-bottom));box-shadow:0 -6px 24px rgba(0,0,0,.18);}' +
    '.mt-an h3{font-size:15px;margin:0 0 3px;color:#1a1a1a;}' +
    '.mt-an .sub{font-size:12.5px;color:#666;margin:0 0 12px;}' +
    '.mt-an button.nb{display:flex;align-items:center;gap:10px;width:100%;font:inherit;font-size:15px;' +
      'padding:13px 14px;border:1px solid #e2e6ea;background:#fff;color:#1a1a1a;border-radius:12px;cursor:pointer;margin-bottom:9px;}' +
    '.mt-an .ico{font-size:19px;}' +
    '.mt-an .row{display:flex;align-items:center;gap:10px;padding:11px 4px;border-bottom:1px solid #eef0f2;font-size:15px;color:#1a1a1a;}' +
    '.mt-an .row .nm{flex:1;}' +
    '.mt-an .row.master{font-weight:700;}' +
    '.mt-an .sw{position:relative;width:46px;height:27px;border-radius:14px;background:#c7ccd1;border:none;cursor:pointer;flex:none;transition:background .15s;}' +
    '.mt-an .sw::after{content:"";position:absolute;top:3px;left:3px;width:21px;height:21px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.3);}' +
    '.mt-an .sw.on{background:#34a853;}.mt-an .sw.on::after{left:22px;}' +
    '.mt-an .apps.dim{opacity:.45;}' +
    '.mt-an button.cx{text-align:center;color:#666;background:none;border:none;font:inherit;font-size:14px;width:100%;padding:8px 8px 2px;margin-top:4px;cursor:pointer;}' +
    '@media (prefers-color-scheme: dark){' +
      '.mt-an .in{background:#1c2024;}.mt-an h3,.mt-an .row{color:#e8eaed;}.mt-an .sub{color:#9aa0a6;}' +
      '.mt-an .row{border-color:#2a2f34;}' +
      '.mt-an button.nb{background:#1c2024;color:#e8eaed;border-color:#2a2f34;}.mt-an button.cx{color:#9aa0a6;}}';

  var _bd = null, _picker = null, _settings = null;
  function _esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function _ensureBase() {
    if (_bd) return;
    var st = document.createElement('style'); st.id = 'mt-an-css'; st.textContent = CSS; document.head.appendChild(st);
    _bd = document.createElement('div'); _bd.id = 'mt-an-bd';
    _bd.addEventListener('click', close);
    document.body.appendChild(_bd);
  }
  function _sheet(id) {
    var el = document.getElementById(id);
    if (!el) { el = document.createElement('div'); el.id = id; el.className = 'mt-an'; document.body.appendChild(el); }
    return el;
  }
  function _show(el) { _bd.classList.add('on'); el.classList.add('on'); }
  function close() {
    if (_bd) _bd.classList.remove('on');
    if (_picker) _picker.classList.remove('on');
    if (_settings) _settings.classList.remove('on');
  }

  // 行程開始選單
  function openPicker() {
    _ensureBase();
    _picker = _sheet('mt-an-pick');
    var apps = enabledApps();
    _picker.innerHTML = '<div class="in"><h3>行程開始！</h3><p class="sub">要切換到哪個 App？（MapTrip 在背景繼續記錄）</p>' +
      apps.map(function (a) {
        return '<button class="nb" data-app="' + _esc(a.id) + '"><span class="ico">' + a.icon + '</span><b>' + _esc(a.name) + '</b></button>';
      }).join('') +
      '<button class="cx" data-x="1">不用，留在 MapTrip</button></div>';
    _picker.onclick = function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.getAttribute('data-x')) { close(); return; }
      var id = b.getAttribute('data-app'); if (!id) return;
      close(); launch(id);
    };
    _show(_picker);
  }

  // 設定面板（選單「🧭 開始後跳轉 App」）
  function openSettings() {
    _ensureBase();
    _settings = _sheet('mt-an-set');
    _renderSettings();
    _show(_settings);
  }
  function _renderSettings() {
    var on = isOn();
    _settings.innerHTML = '<div class="in"><h3>🧭 開始後跳轉 App</h3>' +
      '<p class="sub">按「開始行程」後跳出選單，選要切到哪個 App。只開一個＝直接跳、不問。</p>' +
      '<div class="row master"><span class="nm">開始後跳出選單</span><button class="sw' + (on ? ' on' : '') + '" data-master="1" aria-label="總開關"></button></div>' +
      '<div class="apps' + (on ? '' : ' dim') + '">' +
      APPS.map(function (a) {
        return '<div class="row"><span class="ico">' + a.icon + '</span><span class="nm">' + _esc(a.name) + '</span>' +
          '<button class="sw' + (appOn(a.id) ? ' on' : '') + '" data-app="' + _esc(a.id) + '" aria-label="' + _esc(a.name) + '"></button></div>';
      }).join('') + '</div>' +
      '<button class="cx" data-x="1">完成</button></div>';
    _settings.onclick = function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.getAttribute('data-x')) { close(); return; }
      if (b.getAttribute('data-master')) { setOn(!isOn()); _renderSettings(); return; }
      var id = b.getAttribute('data-app');
      if (id) { setAppOn(id, !appOn(id)); _renderSettings(); }
    };
  }

  function _syncMenuLabel() {
    var b = document.getElementById('autonav-menu-btn');
    if (b) b.textContent = '🧭 開始後跳轉 App：' + (isOn() ? '開' : '關');
  }

  global.MaptripAutoNav = {
    APPS: APPS,
    isOn: isOn, setOn: setOn, appOn: appOn, setAppOn: setAppOn, enabledApps: enabledApps,
    decide: decide, launch: launch, onTripStart: onTripStart,
    openPicker: openPicker, openSettings: openSettings, close: close,
    syncMenuLabel: _syncMenuLabel
  };
})();
