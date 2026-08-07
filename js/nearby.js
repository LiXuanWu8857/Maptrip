// nearby.js — 「找附近的 X」：搜尋當前位置附近的加油站／停車場／便利商店。
// 地圖優先：結果直接以「①②③…（依直線距離近→遠）」編號釘標在地圖上，
// 點釘子即跳導航選單（MaptripNav，Google／Apple 開車導航）。不再用底部清單。
// 便利商店會備註有無廁所（OSM toilets 標籤）：有廁所的釘子加 🚻，導航選單也註明。
//
// 資料來源：OpenStreetMap Overpass API，免費免金鑰，與地圖 POI 同源。
// 「最近」用直線距離快速判定；實際開車路徑由 Google／Apple 導航計算（driving 模式）。
// 依賴：window.__mtLive.pos / .map（即時定位/地圖）、window.toast、window.MaptripNav.open、window.L。
(function () {
  'use strict';

  var RADIUS = 5000;          // 搜尋半徑（公尺）
  var TOP_N  = 8;             // 最多標幾家
  var MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  // 類別設定：Overpass 標籤、標題、圖示、釘子色、空結果文案、預設名稱、是否備註廁所
  var CATS = {
    fuel:    { tag: 'amenity=fuel',      title: '附近加油站',   icon: '⛽', accent: '#188038', empty: '附近 5 公里內找不到加油站',   dft: '加油站',   short: '加油站' },
    parking: { tag: 'amenity=parking',   title: '附近停車場',   icon: '🅿️', accent: '#1a56b0', empty: '附近 5 公里內找不到停車場',   dft: '停車場',   short: '停車場' },
    store:   { tag: 'shop=convenience',  title: '附近便利商店', icon: '🏪', accent: '#e8710a', empty: '附近 5 公里內找不到便利商店', dft: '便利商店', short: '便利商店', wc: true }
  };

  function pos()  { return window.__mtLive && window.__mtLive.pos; }
  function gmap() { return window.__mtLive && window.__mtLive.map; }
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
  function _fmtDist(m) {
    if (m < 950) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 9500 ? 1 : 0) + ' km';
  }
  function _name(tags, dft) {
    tags = tags || {};
    return tags['name:zh'] || tags.name || tags.brand || tags.operator || dft || '地點';
  }
  // 廁所：OSM toilets / toilets:access → 'yes' | 'no' | ''（未標示）
  function _toilet(tags) {
    tags = tags || {};
    var t = tags.toilets || tags['toilets:access'];
    if (t === 'yes' || t === 'customers' || t === 'public') return 'yes';
    if (t === 'no' || t === 'none') return 'no';
    return '';
  }
  function _overpassBody(la, ln, tag) {
    var q = '[out:json][timeout:25];nwr(around:' + RADIUS + ',' + la + ',' + ln + ')[' + tag + '];out center 80;';
    return 'data=' + encodeURIComponent(q);
  }
  function _parse(elements, me, dft, wantWc) {
    var out = [];
    (elements || []).forEach(function (e) {
      var lat = (e.lat != null) ? e.lat : (e.center && e.center.lat);
      var lng = (e.lon != null) ? e.lon : (e.center && e.center.lon);
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      out.push({ lat: lat, lng: lng, name: _name(e.tags, dft),
                 dist: _haversine(me, { lat: lat, lng: lng }),
                 wc: wantWc ? _toilet(e.tags) : '' });
    });
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out.slice(0, TOP_N);
  }
  // 導航選單的備註：距離（＋便利商店的廁所狀態）
  function _note(f, cat) {
    var s = _fmtDist(f.dist);
    if (cat.wc) s += ' · ' + (f.wc === 'yes' ? '🚻 有廁所' : f.wc === 'no' ? '🚫 沒有廁所' : '廁所未標示');
    return s;
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

  // ---- UI：地圖編號釘 ＋「清除」浮鈕（無底部清單）----
  var CSS =
    '.mt-nb-pin{position:relative;width:26px;height:26px;border-radius:50%;background:#188038;color:#fff;' +
      'font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 1px 5px rgba(0,0,0,.45);border:2px solid #fff;}' +
    '.mt-nb-pin .wc{position:absolute;top:-8px;right:-10px;width:16px;height:16px;border-radius:50%;background:#fff;' +
      'font-size:10px;font-style:normal;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(0,0,0,.3);}' +
    '#mt-nb-clear{position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top) + 56px);' +
      'z-index:16;display:none;border:none;background:rgba(0,0,0,.72);color:#fff;font:inherit;font-size:13px;' +
      'font-weight:600;padding:7px 15px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;}' +
    '#mt-nb-clear.on{display:block;}';

  var _cssAdded = false, _clearBtn = null, _markers = [];
  function _ensureUi() {
    if (!_cssAdded) { var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); _cssAdded = true; }
    if (!_clearBtn) {
      _clearBtn = document.createElement('button');
      _clearBtn.id = 'mt-nb-clear'; _clearBtn.textContent = '✕ 清除搜尋';
      _clearBtn.addEventListener('click', close);
      document.body.appendChild(_clearBtn);
    }
    return _clearBtn;
  }

  function clearMap() {
    var m = gmap();
    if (m) _markers.forEach(function (mk) { try { m.removeLayer(mk); } catch (_) {} });
    _markers = [];
    if (_clearBtn) _clearBtn.classList.remove('on');
  }

  function drawMap(list, anchor, cat) {
    var m = gmap(); if (!m || !window.L) return;
    clearMap();
    var pts = [];
    list.forEach(function (f, i) {
      try {
        var wcBadge = (cat.wc && f.wc === 'yes') ? '<i class="wc">🚻</i>' : '';
        var html = '<div class="mt-nb-pin" style="background:' + cat.accent + '">' + (i + 1) + wcBadge + '</div>';
        var icon = L.divIcon({ className: 'mt-nb-pinwrap', html: html, iconSize: [30, 30], iconAnchor: [15, 15] });
        var mk = L.marker([f.lat, f.lng], { icon: icon });
        mk.addTo(m);
        (function (ff) {
          var note = _note(ff, cat);
          function go() { if (window.MaptripNav) MaptripNav.open(ff.name, ff.lat, ff.lng, note); }
          if (typeof mk.on === 'function') { mk.on('click', go); }
          else if (mk.getElement) { var el = mk.getElement(); if (el) el.addEventListener('click', go); }
        })(f);
        _markers.push(mk); pts.push([f.lat, f.lng]);
      } catch (_) {}
    });
    if (anchor) pts.push([anchor.lat, anchor.lng]);
    if (pts.length) {
      try {
        m.fitBounds(L.latLngBounds(pts), {
          paddingTopLeft: [40, 100], paddingBottomRight: [40, 70], maxZoom: 16, animate: true
        });
      } catch (_) {}
    }
  }

  function render(list, me, cat) {
    drawMap(list, me, cat);
    _ensureUi().classList.add('on');
    var wcHint = cat.wc ? '（🚻＝有廁所）' : '';
    say('找到 ' + list.length + ' 家' + cat.short + wcHint + '，點地圖上的釘子開車導航');
  }
  function close() { clearMap(); }

  var busy = false;
  function run(kind) {
    var cat = CATS[kind] || CATS.fuel;
    if (busy) return;
    // 搜尋中心＝地圖當下中心（把地圖移到哪就搜哪；無地圖則退回 GPS）
    var m = gmap(), center = null;
    try { if (m && m.getCenter) { var c = m.getCenter(); if (c && c.lat != null) center = { lat: c.lat, lng: c.lng }; } } catch (_) {}
    var me = pos();
    var searchAt = center || me;
    if (!searchAt) { say('地圖尚未就緒，稍後再試'); return; }
    var distFrom = me || searchAt;             // 距離基準：有 GPS 用 GPS（＝離你多遠），否則用搜尋中心
    busy = true; setBusy(true);
    say('搜尋附近' + cat.short + '中…');
    fetchOverpass(searchAt.lat, searchAt.lng, cat.tag).then(function (data) {
      busy = false; setBusy(false);
      if (!data) { say('地圖服務暫時無法連線，稍後再試'); return; }
      var list = _parse(data.elements, distFrom, cat.dft, !!cat.wc);
      if (!list.length) { say(cat.empty); return; }
      render(list, searchAt, cat);
    }).catch(function () { busy = false; setBusy(false); say('搜尋失敗，稍後再試'); });
  }

  window.MaptripNearby = {
    run: run, close: close, clearMap: clearMap, CATS: CATS,
    _haversine: _haversine, _fmtDist: _fmtDist, _name: _name, _toilet: _toilet,
    _parse: _parse, _overpassBody: _overpassBody, _note: _note, _drawMap: drawMap
  };
})();
