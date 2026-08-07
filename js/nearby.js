// nearby.js — 「找附近的 X」：搜尋當前位置附近的加油站／停車場，依直線距離排序，
// 點一下用 Google／Apple 地圖「開車導航」過去（走 MaptripNav 的導航選單）。
//
// 資料來源：OpenStreetMap Overpass API，免費免金鑰，與地圖 POI 同源。
// 「最近」用直線距離快速判定；實際開車路徑由 Google／Apple 導航計算（driving 模式）。
// 依賴：window.__mtLive.pos（即時定位）、window.toast、window.MaptripNav.open。
(function () {
  'use strict';

  var RADIUS = 5000;          // 搜尋半徑（公尺）
  var TOP_N  = 6;             // 最多列幾家
  var MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  // 類別設定：Overpass 標籤、標題、圖示、強調色、空結果文案、預設名稱
  var CATS = {
    fuel:    { tag: 'amenity=fuel',    title: '附近加油站', icon: '⛽', accent: '#188038', empty: '附近 5 公里內找不到加油站', dft: '加油站' },
    parking: { tag: 'amenity=parking', title: '附近停車場', icon: '🅿️', accent: '#1a56b0', empty: '附近 5 公里內找不到停車場', dft: '停車場' }
  };

  function pos()  { return window.__mtLive && window.__mtLive.pos; }
  function say(m) { if (window.toast) window.toast(m); }
  function setBusy(b) { var el = document.getElementById('hotspot-btn'); if (el) el.classList.toggle('loading', !!b); }

  // ---- 純函式（供測試）----
  function _haversine(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var la1 = a.lat * toR, la2 = b.lat * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  var DIRS = [
    { l: '北', a: '↑' }, { l: '東北', a: '↗' }, { l: '東', a: '→' }, { l: '東南', a: '↘' },
    { l: '南', a: '↓' }, { l: '西南', a: '↙' }, { l: '西', a: '←' }, { l: '西北', a: '↖' }
  ];
  function _bearingLabel(from, to) {
    var toR = Math.PI / 180, toD = 180 / Math.PI;
    var y = Math.sin((to.lng - from.lng) * toR) * Math.cos(to.lat * toR);
    var x = Math.cos(from.lat * toR) * Math.sin(to.lat * toR) -
            Math.sin(from.lat * toR) * Math.cos(to.lat * toR) * Math.cos((to.lng - from.lng) * toR);
    var brg = (Math.atan2(y, x) * toD + 360) % 360;
    return DIRS[Math.round(brg / 45) % 8];
  }
  function _fmtDist(m) {
    if (m < 950) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 9500 ? 1 : 0) + ' km';
  }
  function _name(tags, dft) {
    tags = tags || {};
    return tags['name:zh'] || tags.name || tags.brand || tags.operator || dft || '地點';
  }
  function _overpassBody(la, ln, tag) {
    var q = '[out:json][timeout:25];nwr(around:' + RADIUS + ',' + la + ',' + ln + ')[' + tag + '];out center 60;';
    return 'data=' + encodeURIComponent(q);
  }
  function _parse(elements, me, dft) {
    var out = [];
    (elements || []).forEach(function (e) {
      var lat = (e.lat != null) ? e.lat : (e.center && e.center.lat);
      var lng = (e.lon != null) ? e.lon : (e.center && e.center.lon);
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      out.push({ lat: lat, lng: lng, name: _name(e.tags, dft), dist: _haversine(me, { lat: lat, lng: lng }) });
    });
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out.slice(0, TOP_N);
  }

  function fetchOverpass(la, ln, tag) {
    var body = _overpassBody(la, ln, tag);
    function tryAt(i) {
      if (i >= MIRRORS.length) return Promise.resolve(null);
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
      var opt = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body };
      if (ctrl) opt.signal = ctrl.signal;
      return fetch(MIRRORS[i], opt).then(function (r) {
        clearTimeout(timer);
        if (!r || !r.ok) throw new Error('http ' + (r && r.status));
        return r.json();
      }).catch(function () { clearTimeout(timer); return tryAt(i + 1); });
    }
    return tryAt(0);
  }

  // ---- UI：底部清單（強調色用 CSS 變數 --acc，依類別切換）----
  var CSS =
    '#mt-nb-bd{position:fixed;inset:0;background:rgba(0,0,0,.25);z-index:19996;opacity:0;pointer-events:none;transition:opacity .2s;}' +
    '#mt-nb-bd.on{opacity:1;pointer-events:auto;}' +
    '#mt-nb{position:fixed;left:0;right:0;bottom:0;z-index:19997;transform:translateY(110%);transition:transform .22s ease;--acc:#188038;}' +
    '#mt-nb.on{transform:translateY(0);}' +
    '#mt-nb .in{max-width:520px;margin:0 auto;background:#fff;border-radius:16px 16px 0 0;' +
      'padding:14px 16px calc(14px + env(safe-area-inset-bottom));box-shadow:0 -6px 24px rgba(0,0,0,.18);max-height:70vh;overflow:auto;}' +
    '#mt-nb h3{font-size:15px;margin:0 0 2px;color:#1a1a1a;}' +
    '#mt-nb .sub{font-size:12px;color:#666;margin:0 0 12px;}' +
    '#mt-nb .row{display:flex;align-items:center;gap:12px;width:100%;font:inherit;text-align:left;' +
      'padding:12px 12px;border:1px solid #e2e6ea;background:#fff;color:#1a1a1a;border-radius:12px;cursor:pointer;margin-bottom:8px;}' +
    '#mt-nb .row.near{border-color:var(--acc);background:color-mix(in srgb,var(--acc) 8%,transparent);}' +
    '#mt-nb .row .ico{font-size:20px;}' +
    '#mt-nb .row .nm{flex:1;min-width:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '#mt-nb .row .d{font-size:13px;color:var(--acc);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;}' +
    '#mt-nb .row .d .dir{color:#666;margin-right:4px;}' +
    '#mt-nb .cx{text-align:center;color:#666;background:none;border:none;font:inherit;font-size:14px;width:100%;padding:8px;cursor:pointer;}' +
    '@media (prefers-color-scheme: dark){#mt-nb .in{background:#1c2024;}#mt-nb h3{color:#e8eaed;}#mt-nb .sub,#mt-nb .cx{color:#9aa0a6;}' +
      '#mt-nb .row{background:#1c2024;color:#e8eaed;border-color:#2a2f34;}#mt-nb .row .d .dir{color:#9aa0a6;}}';

  var _dom = null;
  function _ensureDom() {
    if (_dom) return _dom;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var bd = document.createElement('div'); bd.id = 'mt-nb-bd';
    var sheet = document.createElement('div'); sheet.id = 'mt-nb';
    sheet.innerHTML = '<div class="in"><h3 id="mt-nb-title">附近</h3><p class="sub" id="mt-nb-sub"></p>' +
                      '<div id="mt-nb-list"></div><button class="cx" id="mt-nb-x">關閉</button></div>';
    document.body.appendChild(bd); document.body.appendChild(sheet);
    _dom = { bd: bd, sheet: sheet, list: sheet.querySelector('#mt-nb-list'),
             title: sheet.querySelector('#mt-nb-title'), sub: sheet.querySelector('#mt-nb-sub') };
    bd.addEventListener('click', close);
    sheet.querySelector('#mt-nb-x').addEventListener('click', close);
    return _dom;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function render(list, me, cat) {
    var d = _ensureDom();
    d.sheet.style.setProperty('--acc', cat.accent);
    d.title.textContent = cat.title;
    d.sub.textContent = '依直線距離排序，點一下用 Google／Apple 開車導航';
    d.list.innerHTML = '';
    list.forEach(function (f, i) {
      var dir = _bearingLabel(me, f);
      var b = document.createElement('button');
      b.className = 'row' + (i === 0 ? ' near' : '');
      b.innerHTML = '<span class="ico">' + cat.icon + '</span><span class="nm">' + esc(f.name) + '</span>' +
                    '<span class="d"><span class="dir">' + dir.a + ' ' + dir.l + '</span>' + _fmtDist(f.dist) + '</span>';
      b.addEventListener('click', function () {
        if (window.MaptripNav) MaptripNav.open(f.name, f.lat, f.lng);
        else say('導航模組未載入');
      });
      d.list.appendChild(b);
    });
    d.bd.classList.add('on'); d.sheet.classList.add('on');
  }
  function close() { if (_dom) { _dom.bd.classList.remove('on'); _dom.sheet.classList.remove('on'); } }

  var busy = false;
  function run(kind) {
    var cat = CATS[kind] || CATS.fuel;
    if (busy) return;
    var me = pos();
    if (!me) { say('等待 GPS 訊號中…'); return; }
    busy = true; setBusy(true);
    say('搜尋' + cat.title + '中…');
    fetchOverpass(me.lat, me.lng, cat.tag).then(function (data) {
      busy = false; setBusy(false);
      if (!data) { say('地圖服務暫時無法連線，稍後再試'); return; }
      var list = _parse(data.elements, me, cat.dft);
      if (!list.length) { say(cat.empty); return; }
      render(list, me, cat);
    }).catch(function () { busy = false; setBusy(false); say('搜尋失敗，稍後再試'); });
  }

  window.MaptripNearby = {
    run: run, close: close, CATS: CATS,
    _haversine: _haversine, _bearingLabel: _bearingLabel, _fmtDist: _fmtDist,
    _name: _name, _parse: _parse, _overpassBody: _overpassBody
  };
})();
