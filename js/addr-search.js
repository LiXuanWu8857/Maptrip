// addr-search.js — 「搜尋地址」：輸入地址 → OpenStreetMap Nominatim 地理編碼 →
// 地圖跳到該處並放一個紅色標記（點標記可用 Google／Apple 開車導航）。
// 免費免金鑰（限台灣、繁中優先），與 finance.js 的反向地理編碼同源。
// 依賴：window.__mtLive.map、window.L、window.MaptripNav.open、window.toast。
(function () {
  'use strict';

  var GEO = 'https://nominatim.openstreetmap.org/search';
  function gmap() { return window.__mtLive && window.__mtLive.map; }
  function say(m) { if (window.toast) window.toast(m); }

  // display_name 太長 → 取前兩段當簡稱
  function _short(name) {
    var segs = String(name == null ? '' : name).split(',').slice(0, 2)
      .map(function (s) { return s.trim(); }).filter(Boolean);
    return segs.join('，') || '搜尋位置';
  }
  function geocode(q) {
    var url = GEO + '?format=jsonv2&limit=1&countrycodes=tw&accept-language=zh-TW&q=' + encodeURIComponent(q);
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
    var opt = {}; if (ctrl) opt.signal = ctrl.signal;
    return fetch(url, opt).then(function (r) {
      clearTimeout(timer); if (!r || !r.ok) throw new Error('http'); return r.json();
    }).catch(function () { clearTimeout(timer); return null; });
  }

  var CSS =
    '#mt-addr-bd{position:fixed;inset:0;z-index:19994;background:rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .2s;}' +
    '#mt-addr-bd.on{opacity:1;pointer-events:auto;}' +
    '#mt-addr{position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top) + 54px);z-index:19995;' +
      'transform:translateY(-16px);opacity:0;transition:transform .2s ease,opacity .2s ease;pointer-events:none;}' +
    '#mt-addr.on{transform:none;opacity:1;pointer-events:auto;}' +
    '#mt-addr .in{max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:10px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.22);display:flex;gap:8px;align-items:center;}' +
    '#mt-addr input{flex:1;min-width:0;border:1px solid #e2e6ea;border-radius:10px;padding:11px 12px;' +
      'font:inherit;font-size:16px;background:#fff;color:#1a1a1a;outline:none;}' +
    '#mt-addr input:focus{border-color:#1a73e8;}' +
    '#mt-addr .go{border:none;background:#1a73e8;color:#fff;font:inherit;font-size:16px;font-weight:600;' +
      'padding:11px 16px;border-radius:10px;cursor:pointer;flex:none;}' +
    '.mt-addr-pin{width:22px;height:22px;border-radius:50%;background:#d93025;border:3px solid #fff;' +
      'box-shadow:0 1px 5px rgba(0,0,0,.45);}' +
    '@media (prefers-color-scheme: dark){#mt-addr .in{background:#1c2024;}' +
      '#mt-addr input{background:#12161a;color:#e8eaed;border-color:#2a2f34;}}';

  var _dom = null, _marker = null, _busy = false;
  function _ensure() {
    if (_dom) return _dom;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var bd = document.createElement('div'); bd.id = 'mt-addr-bd';
    var box = document.createElement('div'); box.id = 'mt-addr';
    box.innerHTML = '<div class="in"><input id="mt-addr-i" type="search" enterkeyhint="search" ' +
                    'placeholder="輸入地址或地點名稱…" autocomplete="off"><button class="go" id="mt-addr-go">搜尋</button></div>';
    document.body.appendChild(bd); document.body.appendChild(box);
    _dom = { bd: bd, box: box, input: box.querySelector('#mt-addr-i'), go: box.querySelector('#mt-addr-go') };
    bd.addEventListener('click', close);
    _dom.go.addEventListener('click', submit);
    _dom.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    return _dom;
  }

  function open() {
    var d = _ensure();
    d.bd.classList.add('on'); d.box.classList.add('on');
    try { d.input.focus(); } catch (_) {}
  }
  function close() { if (_dom) { _dom.bd.classList.remove('on'); _dom.box.classList.remove('on'); } }

  function dropMarker(lat, lng, name) {
    var m = gmap(); if (!m || !window.L) return;
    if (_marker) { try { m.removeLayer(_marker); } catch (_) {} _marker = null; }
    var icon = L.divIcon({ className: 'mt-addr-pinwrap', html: '<div class="mt-addr-pin"></div>', iconSize: [26, 26], iconAnchor: [13, 13] });
    _marker = L.marker([lat, lng], { icon: icon });
    _marker.addTo(m);
    function nav() { if (window.MaptripNav) MaptripNav.open(name, lat, lng); }
    if (typeof _marker.on === 'function') { _marker.on('click', nav); }
    else if (_marker.getElement) { var el = _marker.getElement(); if (el) el.addEventListener('click', nav); }
  }

  function submit() {
    if (_busy) return;
    var q = (_dom && _dom.input.value || '').trim();
    if (!q) { try { _dom.input.focus(); } catch (_) {} return; }
    _busy = true; say('搜尋地址中…');
    geocode(q).then(function (arr) {
      _busy = false;
      if (!arr || !arr.length) { say('找不到「' + q + '」，換個關鍵字試試'); return; }
      var r = arr[0], lat = +r.lat, lng = +r.lon, name = _short(r.display_name);
      if (!isFinite(lat) || !isFinite(lng)) { say('地址結果異常，稍後再試'); return; }
      close();
      var m = gmap();
      if (m) { try { m.setView([lat, lng], 16); } catch (_) { try { m.panTo([lat, lng]); } catch (e) {} } }
      dropMarker(lat, lng, name);
      say('已跳到：' + name + '（點紅色標記可導航）');
    }).catch(function () { _busy = false; say('搜尋失敗，稍後再試'); });
  }

  window.MaptripAddr = { open: open, close: close, submit: submit, geocode: geocode, _short: _short };
})();
