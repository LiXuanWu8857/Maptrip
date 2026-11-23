// ===== 開始行程後跳轉 App（MaptripAutoNav，v1.1.459）=====
// 按「開始行程」後（僅前景），跳出選單讓司機選要切到哪個 App（預設：55688 司機版、Google 地圖）。
// 設定面板：總開關＋每個 App 是否出現在選單（開關）。只勾一個 App ＝直接跳、不問。
//
// 開啟方式：window.open(scheme,'_blank')，Capacitor WKWebView 把非 http(s) 交給 iOS 開對應 App
// （同 tel:／導航，不需改 Info.plist：UIApplication.open 不需 LSApplicationQueriesSchemes）。
// 後備：依序試網址（每個 1.2 秒），畫面一直在前景＝沒跳走 → 改開 fallback 網址
//   （Google＝地圖網頁、55688＝App Store 頁面，已安裝時頁面上就是「開啟」鈕）。v1.1.461 起可填 iPhone 捷徑名稱。
// 舊版旗標 maptrip_autonav（'1'/'0'）沿用為總開關。
(function () {
  'use strict';
  var global = window;

  var MASTER_KEY = 'maptrip_autonav';        // 總開關（v1.1.454 起）
  var PREF_KEY = 'maptrip_autonav_apps';     // { on: {id:bool}, sc: {id:捷徑名稱} }
  var END_KEY = 'maptrip_autonav_end';       // v1.1.462：結束收款後跳 55688（'1' 開，預設關）
  // v1.1.463：結束也跟開始一樣＝總開關＋各 App 開關（prefs.end）；結束預設只開 55688
  var END_DEF = { taxi55688: true, gmaps: false, amaps: false };
  var END_PAYS = { cash: 1, card: 1, voucher: 1 };   // 現金／刷卡／紙本簽單才跳；「其他」不跳
  // v1.1.464：主頁右上角快捷鈕（prefs.bar），預設 55688／Google 地圖（v1.1.465 使用者要求拿掉 Uber）
  var BAR_DEF = { taxi55688: true, gmaps: true };

  // App 清單（預設 on＝出現在選單）
  var APPS = [
    // 55688 司機版：官方 scheme 查無資料 → 依序試幾個候選（iOS 開不認得的 scheme＝靜默失敗、無副作用），
    // 都沒跳走 → App Store 頁（itms-apps:// 一律由 App Store 處理；已安裝時頁上是「開啟」）。
    // 最穩的直接跳法＝設定裡填「iPhone 捷徑」名稱（捷徑：打開 App → 55688司機版），會排在最先試。
    { id: 'taxi55688', name: '55688 司機版', icon: '🚕', def: true, shortcut: true, storeId: '1190486682',
      urls: ['twtaxidriver://', 'tw.com.masterhand.twtaxidriver://', 'taiwantaxidriver://', 'masterhand://'],
      fallback: 'itms-apps://apps.apple.com/app/id1190486682', badge: { t: '55', bg: '#f9c400', fg: '#1a1a1a' } },
    { id: 'gmaps', name: 'Google 地圖', icon: '🟢', def: true, storeId: '585027354',
      urls: ['comgooglemaps://'],
      fallback: 'https://www.google.com/maps', badge: { t: 'G', bg: '#1a73e8', fg: '#fff' } },
    { id: 'amaps', name: 'Apple 地圖', icon: '🍎', def: false, storeId: '915056765',
      urls: ['maps://'],
      fallback: '', badge: { t: 'A', bg: '#34c759', fg: '#fff' } }
  ];
  // 自訂 App（v1.1.464）：使用者自己加，名稱＋iPhone 捷徑名稱（捷徑「打開 App → X」＝任何 App 都能開）
  function _customApps() {
    var c = _prefs().custom;
    if (!Array.isArray(c)) return [];
    return c.filter(function (x) { return x && x.id && x.name; }).map(function (x) {
      return { id: x.id, name: x.name, icon: '⭐', custom: true, shortcut: true, urls: [], fallback: '',
        badge: { t: String(x.name).trim().charAt(0) || '?', bg: '#5f6368', fg: '#fff' } };
    });
  }
  function allApps() { return APPS.concat(_customApps()); }
  function addCustomApp(name, scName) {
    name = String(name || '').trim(); scName = String(scName || '').trim();
    if (!name) return null;
    var p = _prefs(); if (!Array.isArray(p.custom)) p.custom = [];
    var id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    p.custom.push({ id: id, name: name });
    if (!p.sc || typeof p.sc !== 'object') p.sc = {};
    p.sc[id] = scName || name;
    if (!p.bar || typeof p.bar !== 'object') p.bar = {};
    p.bar[id] = true;   // 新增的自訂 App 預設出現在主頁右上角
    _lsSet(PREF_KEY, JSON.stringify(p));
    return id;
  }
  function removeCustomApp(id) {
    var p = _prefs(); if (!Array.isArray(p.custom)) return;
    p.custom = p.custom.filter(function (x) { return x && x.id !== id; });
    ['on', 'end', 'bar', 'sc'].forEach(function (k) { if (p[k] && typeof p[k] === 'object') delete p[k][id]; });
    _lsSet(PREF_KEY, JSON.stringify(p));
  }

  function _ls(k) { try { return global.localStorage.getItem(k); } catch (_) { return null; } }
  function _lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (_) {} }

  function isOn() { return _ls(MASTER_KEY) === '1'; }
  function setOn(v) { _lsSet(MASTER_KEY, v ? '1' : '0'); _syncMenuLabel(); }

  function _prefs() {
    var p = null; try { p = JSON.parse(_ls(PREF_KEY) || 'null'); } catch (_) {}
    return (p && typeof p === 'object' && p.on && typeof p.on === 'object') ? p : { on: {} };
  }
  // phase：'start'（預設）或 'end'——兩段各自一組 App 開關
  function _bucket(p, phase) {
    if (phase !== 'end' && phase !== 'bar') return p.on;
    if (!p[phase] || typeof p[phase] !== 'object') p[phase] = {};
    return p[phase];
  }
  function appOn(id, phase) {
    var p = _prefs(), m = _bucket(p, phase);
    if (Object.prototype.hasOwnProperty.call(m, id)) return !!m[id];
    if (phase === 'end') return !!END_DEF[id];
    if (phase === 'bar') return !!BAR_DEF[id];
    var a = _find(id); return !!(a && a.def);
  }
  function setAppOn(id, v, phase) {
    var p = _prefs(); _bucket(p, phase)[id] = !!v; _lsSet(PREF_KEY, JSON.stringify(p));
    if (phase === 'bar') renderBar();
  }
  // iPhone 捷徑名稱（選填）：有填就先用 shortcuts://run-shortcut 開（捷徑 App 一定在、scheme 官方）
  function shortcutName(id) { var p = _prefs(); return (p.sc && typeof p.sc[id] === 'string') ? p.sc[id].trim() : ''; }
  function setShortcutName(id, name) {
    var p = _prefs(); if (!p.sc || typeof p.sc !== 'object') p.sc = {};
    p.sc[id] = String(name || '').trim(); _lsSet(PREF_KEY, JSON.stringify(p));
  }
  // 純函式：這個 App 要依序試哪些網址（捷徑優先）
  function urlsFor(a, scName) {
    var list = [];
    if (scName) list.push('shortcuts://run-shortcut?name=' + encodeURIComponent(scName));
    return list.concat(a.urls || []);
  }
  function _find(id) { var L = allApps(); for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i]; return null; }
  function enabledApps(phase) { return allApps().filter(function (a) { return appOn(a.id, phase); }); }

  // 純函式：行程開始時要做什麼 → 'none' | 'direct' | 'pick'
  function decide(masterOn, visible, nEnabled) {
    if (!masterOn || !visible || nEnabled <= 0) return 'none';
    return nEnabled === 1 ? 'direct' : 'pick';
  }

  // 開外部網址。App 殼（Capacitor）內改用 location.href：WKWebView 的 window.open 只在「點擊當下」放行
  // （v1.1.459 血淚：55688 scheme 沒反應後，1.5 秒後的 App Store 後備 window.open 已非點擊當下→被擋＝完全沒反應）。
  // location.href 走 Capacitor 導覽委派：非本站網址／非 http scheme 一律交 UIApplication.open，不需點擊手勢、
  // 頁面也不會離開（導覽被 cancel）。瀏覽器（Safari 後備）仍用 window.open，免得把 MapTrip 頁面導走。
  function _isNative() {
    try { return !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform()); } catch (_) { return false; }
  }
  var _navTo = function (u) { global.location.href = u; };   // 測試可替換（_setNav）
  function _openUrl(u) {
    if (_isNative()) { try { _navTo(u); return; } catch (_) {} }
    try { global.open(u, '_blank'); } catch (_) {}
  }

  // 開 App：依序試網址，每個等 STEP_MS 看有沒有跳走（blur/hidden）；都沒跳走 → 後備網址。
  // 每一步都記黑盒子（autonav:try/ok/fallback），實機失敗時用數據判讀是哪一步。
  var STEP_MS = 1200;
  function launch(id) {
    var a = _find(id); if (!a) return;
    var list = urlsFor(a, a.shortcut ? shortcutName(id) : '');
    var left = false, i = 0;
    function log(m) { try { global.__mtLog && global.__mtLog('autonav:' + m); } catch (_) {} }
    function onHide() { if (document.visibilityState === 'hidden') { if (!left) log('ok hidden ' + id + ' #' + (i - 1)); left = true; } }
    function onBlur() { if (!left) log('ok blur ' + id + ' #' + (i - 1)); left = true; }
    document.addEventListener('visibilitychange', onHide);
    global.addEventListener('blur', onBlur);
    function done() { document.removeEventListener('visibilitychange', onHide); global.removeEventListener('blur', onBlur); }
    function step() {
      if (left) { done(); return; }
      if (i < list.length) {
        var u = list[i++]; log('try ' + id + ' ' + u.slice(0, 48));
        _openUrl(u);
        setTimeout(step, STEP_MS);
        return;
      }
      done();
      if (a.fallback && document.visibilityState === 'visible') { log('fallback ' + id); _openUrl(a.fallback); }
      else log('fail ' + id);
    }
    step();
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

  // ---------- 結束收款後跳 55688（v1.1.462）----------
  function endOn() { return _ls(END_KEY) === '1'; }
  function setEndOn(v) { _lsSet(END_KEY, v ? '1' : '0'); _syncMenuLabel(); }
  // 純函式：結束收款要做什麼 → 'none' | 'direct' | 'pick'（現金／刷卡／簽單才跳）
  function decideEnd(on, visible, paymentMethod, nEnabled) {
    if (!END_PAYS[paymentMethod]) return 'none';
    return decide(on, visible, nEnabled == null ? 1 : nEnabled);
  }
  // 車資對話框按「現金／刷卡／簽單」存檔時呼叫（recorder.finalizeSavedTrip）
  function onTripEnd(paymentMethod) {
    var visible = (typeof document === 'undefined') || document.visibilityState === 'visible';
    var apps = enabledApps('end');
    var d = decideEnd(endOn(), visible, paymentMethod, apps.length);
    if (d === 'none') return d;
    try { global.__mtLog && global.__mtLog('autonav:end ' + paymentMethod + ' ' + d); } catch (_) {}
    setTimeout(function () {   // 讓存檔（IndexedDB）與 toast 先跑完再跳走
      if (d === 'direct') launch(apps[0].id);
      else openPicker('end');
    }, 500);
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
    '.mt-an .sec{font-size:12.5px;font-weight:700;color:#1a73e8;margin:14px 4px 0;}' +
    '.mt-an .sw{position:relative;width:46px;height:27px;border-radius:14px;background:#c7ccd1;border:none;cursor:pointer;flex:none;transition:background .15s;}' +
    '.mt-an .sw::after{content:"";position:absolute;top:3px;left:3px;width:21px;height:21px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.3);}' +
    '.mt-an .sw.on{background:#34a853;}.mt-an .sw.on::after{left:22px;}' +
    '.mt-an .apps.dim{opacity:.45;}' +
    '.an-badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 3px;box-sizing:border-box;' +
      'border-radius:6px;font:700 12px/1 -apple-system,system-ui,sans-serif;letter-spacing:-.3px;vertical-align:middle;}' +
    '#an-bar{display:flex;align-items:center;gap:6px;}' +
    '.an-badge{position:relative;overflow:hidden;}' +
    '.an-badge .an-ic{position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;object-fit:cover;}' +
    '.an-badge.has-ic{background:transparent!important;color:transparent!important;}' +
    '#an-bar .an-bbtn{background:transparent!important;}' +
    '#an-bar .an-bbtn .an-badge.has-ic{min-width:30px;height:30px;border-radius:8px;box-shadow:0 0 0 .5px rgba(0,0,0,.15);}' +
    '#top-bar.an-tight #an-bar .an-bbtn .an-badge.has-ic{min-width:28px;height:28px;}' +
    '#an-bar .an-bbtn{width:34px;height:34px;padding:0;}' +
    '#an-bar .an-bbtn .an-badge{min-width:24px;height:24px;font-size:13px;}' +
    '#top-date,#top-tripcount{white-space:nowrap;}' +
    '#top-bar.an-tight #top-actions{gap:5px;}#top-bar.an-tight #top-left{gap:8px;}' +
    '#top-bar.an-tight #an-bar{gap:4px;}#top-bar.an-tight #an-bar .an-bbtn{width:30px;height:32px;}' +
    '#top-bar.an-tight #an-bar .an-bbtn .an-badge{min-width:22px;height:22px;font-size:12px;}' +
    '.mt-an .sec .del{float:right;font:inherit;font-size:12px;color:#d93025;background:none;border:1px solid #f1c0bc;border-radius:8px;padding:2px 8px;cursor:pointer;}' +
    '.mt-an .scrow{padding:4px 4px 12px 38px;border-bottom:1px solid #eef0f2;}' +
    '.mt-an .scrow label{display:block;font-size:12px;color:#666;margin-bottom:4px;}' +
    '.mt-an .scrow input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:8px 10px;border:1px solid #d5d9de;border-radius:8px;background:#fff;color:#1a1a1a;}' +
    '.mt-an button.cx{text-align:center;color:#666;background:none;border:none;font:inherit;font-size:14px;width:100%;padding:8px 8px 2px;margin-top:4px;cursor:pointer;}' +
    '@media (prefers-color-scheme: dark){' +
      '.mt-an .in{background:#1c2024;}.mt-an h3,.mt-an .row{color:#e8eaed;}.mt-an .sub{color:#9aa0a6;}' +
      '.mt-an .row,.mt-an .scrow{border-color:#2a2f34;}.mt-an .scrow label{color:#9aa0a6;}' +
      '.mt-an .scrow input{background:#12161a;color:#e8eaed;border-color:#2a2f34;}' +
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

  // 選單（phase：'start' 行程開始／'end' 收款完成）
  function openPicker(phase) {
    _ensureBase();
    _picker = _sheet('mt-an-pick');
    var apps = enabledApps(phase);
    var head = phase === 'end'
      ? '<h3>收款完成！</h3><p class="sub">要切換到哪個 App？</p>'
      : '<h3>行程開始！</h3><p class="sub">要切換到哪個 App？（MapTrip 在背景繼續記錄）</p>';
    _picker.innerHTML = '<div class="in">' + head +
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
  function _appRows(phase, on) {
    return '<div class="apps' + (on ? '' : ' dim') + '">' +
      allApps().map(function (a) {
        return '<div class="row"><span class="ico">' + _badgeHtml(a) + '</span><span class="nm">' + _esc(a.name) + '</span>' +
          '<button class="sw' + (appOn(a.id, phase) ? ' on' : '') + '" data-app="' + _esc(a.id) + '" data-phase="' + phase + '" aria-label="' + _esc(a.name) + '"></button></div>';
      }).join('') + '</div>';
  }
  function _renderSettings() {
    var on = isOn(), eon = endOn();
    var sc = allApps().filter(function (a) { return a.shortcut; });
    _settings.innerHTML = '<div class="in" style="max-height:calc(100dvh - 40px);overflow-y:auto"><h3>🧭 跳轉 App</h3>' +
      '<div class="sec">主頁右上角快捷鈕</div>' +
      '<p class="sub" style="margin:2px 4px 0">開著的 App 會出現在主頁右上角，點一下直接跳過去。一般 iPhone 放得下 3 個，再多的會依順序自動藏起來（Pro Max 可到 ' + BAR_MAX + ' 個）。</p>' +
      _appRows('bar', true) +
      '<p class="sub" style="margin:10px 4px 0">開始／結束：只開一個 App＝直接跳、不問；開兩個以上＝跳出選單讓你選。</p>' +
      '<div class="sec">開始行程後</div>' +
      '<div class="row master"><span class="nm">開始後跳轉</span><button class="sw' + (on ? ' on' : '') + '" data-master="start" aria-label="開始後跳轉"></button></div>' +
      _appRows('start', on) +
      '<div class="sec">結束收款後（現金／刷卡／簽單）</div>' +
      '<div class="row master"><span class="nm">結束後跳轉</span><button class="sw' + (eon ? ' on' : '') + '" data-master="end" aria-label="結束後跳轉"></button></div>' +
      _appRows('end', eon) +
      '<p class="sub" style="margin:6px 4px 0">選「其他」不會跳。</p>' +
      sc.map(function (a) {
        return '<div class="sec">' + _badgeHtml(a) + ' ' + _esc(a.name) + ' 開啟方式' +
            (a.custom ? ' <button class="del" data-del="' + _esc(a.id) + '">刪除</button>' : '') + '</div>' +
          '<div class="scrow" style="padding-left:4px"><label>' + (a.custom ? 'iPhone 捷徑名稱（必填）' : '用 iPhone 捷徑開啟（選填，填捷徑名稱）') + '</label>' +
          '<input type="text" data-sc="' + _esc(a.id) + '" placeholder="例如：' + _esc(a.custom ? a.name : '55688') + '" value="' + _esc(shortcutName(a.id)) + '"></div>';
      }).join('') +
      '<div class="sec">＋ 新增其他 App</div>' +
      '<div class="scrow" style="padding-left:4px"><label>任何 App 都能加：先在「捷徑」App 建一個「打開 App → 那個 App」的捷徑，再把名稱填在這</label>' +
        '<input type="text" id="mt-an-newname" placeholder="顯示名稱，例如：LINE TAXI" style="margin-bottom:6px">' +
        '<input type="text" id="mt-an-newsc" placeholder="捷徑名稱（不填＝同顯示名稱）">' +
        '<button class="nb" data-add="1" style="margin:8px 0 0;justify-content:center"><b>＋ 新增</b></button></div>' +
      '<button class="cx" data-x="1">完成</button></div>';
    _settings.onclick = function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.getAttribute('data-x')) { close(); return; }
      if (b.getAttribute('data-add')) {
        var nm = (document.getElementById('mt-an-newname') || {}).value, scn = (document.getElementById('mt-an-newsc') || {}).value;
        if (addCustomApp(nm, scn)) { renderBar(); _renderSettings(); fetchIcons(false); }
        return;
      }
      var del = b.getAttribute('data-del');
      if (del) { removeCustomApp(del); renderBar(); _renderSettings(); return; }
      var m = b.getAttribute('data-master');
      if (m === 'start') { setOn(!isOn()); _renderSettings(); return; }
      if (m === 'end') { setEndOn(!endOn()); _renderSettings(); return; }
      var id = b.getAttribute('data-app'), ph = b.getAttribute('data-phase');
      if (id) { setAppOn(id, !appOn(id, ph), ph); _renderSettings(); }
    };
    var ins = _settings.querySelectorAll('input[data-sc]');
    for (var k = 0; k < ins.length; k++) {
      ins[k].addEventListener('input', function (e) { setShortcutName(e.target.getAttribute('data-sc'), e.target.value); renderBar(); });
    }
  }

  // ---------- 主頁右上角快捷鈕（v1.1.464）----------
  var BAR_MAX = 4;
  // App 官方圖示（v1.1.466）：在使用者手機上用 iTunes lookup/search API（JSONP，免 CORS）查 App Store 圖示網址，
  // 快取 localStorage `maptrip_appicons`（7 天刷新）；查不到／圖片載入失敗 → 退回色塊字標（字標一直墊在底下）。
  // 內建 App 用 storeId 查；自訂 App 用名稱搜尋 App Store 第一筆。
  var ICON_KEY = 'maptrip_appicons', ICON_TTL = 7 * 864e5;
  function _iconCache() { try { var c = JSON.parse(_ls(ICON_KEY) || '{}'); return (c && typeof c === 'object') ? c : {}; } catch (_) { return {}; } }
  function _iconKey(a) { return a.storeId ? 'id:' + a.storeId : (a.custom ? 'q:' + String(a.name).trim().toLowerCase() : ''); }
  function iconUrl(a) {
    var k = _iconKey(a); if (!k) return '';
    var e = _iconCache()[k];
    return (e && typeof e.u === 'string' && /^https:\/\//.test(e.u)) ? e.u : '';
  }
  // 純函式：iTunes API 回應 → 圖示網址（優先 512→改小尺寸省流量）
  function _artFrom(r) {
    if (!r) return '';
    var u = r.artworkUrl512 || r.artworkUrl100 || r.artworkUrl60 || '';
    if (!/^https:\/\//.test(u)) return '';
    return u.replace(/\/\d+x\d+(bb)?\.(png|jpg|jpeg|webp)$/i, '/120x120bb.png');
  }
  var _jsonpN = 0;
  function _jsonp(url, cb) {
    var name = '__mtIconCb' + (++_jsonpN) + '_' + Date.now().toString(36);
    var sc = document.createElement('script'), done = false;
    function fin(d) { if (done) return; done = true; try { delete global[name]; } catch (_) { global[name] = undefined; } if (sc.parentNode) sc.parentNode.removeChild(sc); cb(d); }
    global[name] = function (d) { fin(d); };
    sc.onerror = function () { fin(null); };
    setTimeout(function () { fin(null); }, 10000);
    sc.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + name;
    document.head.appendChild(sc);
  }
  var _iconBusy = false;
  function fetchIcons(force) {
    if (_iconBusy || typeof document === 'undefined') return;
    var cache = _iconCache(), now = Date.now();
    var stale = function (k) { var e = cache[k]; return force || !e || !(now - (e.t || 0) < (e.u ? ICON_TTL : 864e5)); };   // 查不到的 1 天後再試
    var ids = [], qs = [];
    allApps().forEach(function (a) {
      var k = _iconKey(a); if (!k || !stale(k)) return;
      if (a.storeId) ids.push(a.storeId); else qs.push(a);
    });
    if (!ids.length && !qs.length) return;
    _iconBusy = true;
    var pending = (ids.length ? 1 : 0) + qs.length;
    function save(k, u) { var c = _iconCache(); c[k] = { u: u || '', t: Date.now() }; _lsSet(ICON_KEY, JSON.stringify(c)); }
    function one() {
      if (--pending > 0) return;
      _iconBusy = false;
      try { global.__mtLog && global.__mtLog('autonav:icons ' + Object.keys(_iconCache()).length); } catch (_) {}
      renderBar();
      if (_settings && _settings.classList.contains('on')) _renderSettings();
    }
    if (ids.length) {
      _jsonp('https://itunes.apple.com/lookup?country=tw&id=' + ids.join(','), function (d) {
        var got = {};
        ((d && d.results) || []).forEach(function (r) { if (r && r.trackId) got[String(r.trackId)] = _artFrom(r); });
        ids.forEach(function (id) { if (d) save('id:' + id, got[id] || ''); });   // 網路失敗（d=null）不寫快取，下次再試
        one();
      });
    }
    qs.forEach(function (a) {
      _jsonp('https://itunes.apple.com/search?country=tw&entity=software&limit=1&term=' + encodeURIComponent(a.name), function (d) {
        if (d) save(_iconKey(a), _artFrom(d.results && d.results[0]));
        one();
      });
    });
  }
  function _badgeHtml(a) {
    var b = a.badge || { t: '?', bg: '#5f6368', fg: '#fff' };
    var u = iconUrl(a);
    return '<span class="an-badge' + (u ? ' has-ic' : '') + '" style="background:' + b.bg + ';color:' + b.fg + '">' + _esc(b.t) +
      (u ? '<img class="an-ic" alt="" src="' + _esc(u) + '" onerror="this.parentNode.classList.remove(\'has-ic\');this.remove()">' : '') + '</span>';
  }
  function barApps() { return enabledApps('bar').slice(0, BAR_MAX); }
  function renderBar() {
    if (typeof document === 'undefined') return;
    var host = document.getElementById('top-actions'); if (!host) return;
    _ensureBase();
    var bar = document.getElementById('an-bar');
    if (!bar) {
      bar = document.createElement('span'); bar.id = 'an-bar';
      host.insertBefore(bar, host.firstChild);
      bar.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[data-app]') : null; if (!b) return;
        e.stopPropagation(); launch(b.getAttribute('data-app'));
      });
    }
    var apps = barApps();
    bar.innerHTML = apps.map(function (a) {
      return '<button class="icon-btn an-bbtn" data-app="' + _esc(a.id) + '" title="' + _esc(a.name) + '" aria-label="開啟 ' + _esc(a.name) + '">' + _badgeHtml(a) + '</button>';
    }).join('');
    bar.style.display = apps.length ? '' : 'none';
    _watchTopLeft();
    _fitBar();
  }
  // 頂列放不下時：先縮小（an-tight），還放不下就從尾端藏起快捷鈕（日期／趟數不被擠換行）
  function _overflow() {
    var tb = document.getElementById('top-bar'), l = document.getElementById('top-left'), r = document.getElementById('top-actions');
    if (!tb || !l || !r) return false;
    return l.getBoundingClientRect().right > r.getBoundingClientRect().left - 4 || tb.scrollWidth > tb.clientWidth + 1;
  }
  function _fitBar() {
    var tb = document.getElementById('top-bar'), bar = document.getElementById('an-bar');
    if (!tb || !bar) return;
    tb.classList.remove('an-tight');
    var btns = bar.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].style.display = '';
    if (!_overflow()) return;
    tb.classList.add('an-tight');
    for (var j = btns.length - 1; j >= 1 && _overflow(); j--) btns[j].style.display = 'none';
  }
  try { global.addEventListener('resize', function () { _fitBar(); }); } catch (_) {}
  // 日期／趟數是開機後才填、之後會變（「12 趟」）→ 內容一變就重量；開機後再補兩次
  var _fitObs = false;
  function _watchTopLeft() {
    if (_fitObs) return;
    var l = document.getElementById('top-left');
    if (!l || typeof MutationObserver === 'undefined') return;
    _fitObs = true;
    var t = null;
    new MutationObserver(function () { clearTimeout(t); t = setTimeout(_fitBar, 50); })
      .observe(l, { childList: true, characterData: true, subtree: true });
    setTimeout(_fitBar, 1500); setTimeout(_fitBar, 4000);
  }

  function _syncMenuLabel() {
    var b = document.getElementById('autonav-menu-btn');
    if (b) b.textContent = '🧭 跳轉 App：' + ((isOn() || endOn()) ? '開' : '關');
  }

  global.MaptripAutoNav = {
    APPS: APPS,
    isOn: isOn, setOn: setOn, appOn: appOn, setAppOn: setAppOn, enabledApps: enabledApps,
    decide: decide, launch: launch, urlsFor: urlsFor, shortcutName: shortcutName, setShortcutName: setShortcutName, STEP_MS: STEP_MS, _openUrl: _openUrl, _isNative: _isNative, _setNav: function (f) { _navTo = f; }, onTripStart: onTripStart, endOn: endOn, setEndOn: setEndOn, decideEnd: decideEnd, onTripEnd: onTripEnd,
    openPicker: openPicker, openSettings: openSettings, close: close,
    syncMenuLabel: _syncMenuLabel,
    allApps: allApps, _fitBar: _fitBar, fetchIcons: fetchIcons, iconUrl: iconUrl, _artFrom: _artFrom, addCustomApp: addCustomApp, removeCustomApp: removeCustomApp, renderBar: renderBar, barApps: barApps, BAR_MAX: BAR_MAX
  };
  // 開機就把右上角快捷鈕畫上（DOM 已在 index.html 裡，script 在 body 尾端載入）；稍後背景查官方圖示
  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderBar);
    else renderBar();
    setTimeout(function () { fetchIcons(false); }, 3000);
  } catch (_) {}
})();
