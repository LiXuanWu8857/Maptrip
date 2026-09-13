/* oneway.js — 在地圖上顯示「單行道」及其行駛方向（MaptripOneway）。
 *
 * 使用者要的：地圖上看到哪些是單行道、以及該往哪個方向開。
 * 作法：Overpass 抓地圖中心半徑內、oneway=yes/-1 的可行駛道路（out geom 取幾何），
 *   每條畫成一條紫色折線＋末端箭頭。OSM 通常在路口把路切段 → 約等於「每街廓一個方向箭頭」。
 *
 * 關鍵設計（血淚預防）：本 App 地圖會「朝車頭旋轉」。若用螢幕固定的 divIcon 箭頭圖示，
 *   地圖一轉、箭頭就指錯方向。故**箭頭用地理座標的折線 chevron**（跟 OSM 幾何同一條 polyline），
 *   隨地圖投影一起旋轉 → 任何朝向都正確。且整條路含箭頭是**同一條 polyline**（GL 只吃 1 個 layer，控效能）。
 *
 * 依賴：window.__mtLive.map（gl-compat：getCenter/getZoom/on('moveend'/'zoomend')/.off 兩引擎皆有；
 *   無 getBounds 故用中心＋半徑 around: 查詢，比照 restrictions.js）、window.L、window.toast。
 *   純函式（_bearing/_dest/_arrowPath/_parseWays/_overpassBody）供 Playwright 測試。
 */
(function (global) {
  'use strict';

  var KEY_ON = 'maptrip_oneway_on';   // 開關狀態（跨 session 記住，司機開著開車）
  var MINZOOM = 16;                    // 低於此縮放不顯示（避免整城市塞爆＋Overpass 過大）
  var RADIUS = 650;                    // 抓取半徑（公尺，中心＝地圖中心）
  var REFETCH_MOVE = 300;             // 中心移動超過這距離才重抓（省流量/Overpass）
  var CAP_WAYS = 200;                  // 單次最多畫幾條（防爆）
  var BARB_M = 11;                     // 箭頭 chevron 兩翼長度（公尺）
  var COLOR = '#7C4DFF';               // 紫（與行程藍/青、禁轉紅橘、金額綠都區隔）
  var WEIGHT = 4, OPACITY = 0.85;
  // 只取「可行駛」道路（排除人行道/自行車道/階梯等，計程車無關）
  var HW = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|' +
           'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$';
  var MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  // ---------- 純函式（供測試）----------
  var D = Math.PI / 180;
  function _haversine(a, b) {
    var R = 6371000, dLat = (b.lat - a.lat) * D, dLng = (b.lng - a.lng) * D;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // a,b = {lat,lng} → 前進方位角（度，0=北 順時針）
  function _bearing(a, b) {
    var la1 = a.lat * D, la2 = b.lat * D, dLo = (b.lng - a.lng) * D;
    var y = Math.sin(dLo) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
    return (Math.atan2(y, x) / D + 360) % 360;
  }
  // 從 p 依方位角 brg（度）走 distM 公尺 → {lat,lng}
  function _dest(p, brg, distM) {
    var d = distM / 6371000, b = brg * D, la1 = p.lat * D, lo1 = p.lng * D;
    var la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
    var lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return { lat: la2 / D, lng: ((lo2 / D + 540) % 360) - 180 };
  }
  // pts＝行駛順序的 {lat,lng}[]（…→終點）。回傳「整條路＋終點 chevron 箭頭」的點陣列（同一條折線）。
  // chevron＝從終點 E 往回張開兩翼（θ±150°），畫成 …→E→翼L→E→翼R（回描一段，視覺上就是箭頭 V）。
  function _arrowPath(pts, barbM) {
    barbM = barbM || BARB_M;
    var n = pts.length;
    if (n < 2) return pts.slice();
    var E = pts[n - 1], P = pts[n - 2];
    var th = _bearing(P, E);
    var bL = _dest(E, th + 150, barbM), bR = _dest(E, th - 150, barbM);
    return pts.concat([bL, E, bR]);
  }
  // Overpass elements → [{id, pts}]（pts 已轉成行駛順序：oneway=-1 反轉節點順序）
  function _parseWays(els) {
    var out = [];
    (els || []).forEach(function (e) {
      if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) return;
      var ow = (e.tags && e.tags.oneway) || '';
      if (!/^(yes|true|1|-1|reverse)$/.test(ow)) return;
      var pts = e.geometry.map(function (g) { return { lat: g.lat, lng: g.lon }; });
      if (ow === '-1' || ow === 'reverse') pts.reverse();
      out.push({ id: e.id, pts: pts });
    });
    return out;
  }
  function _overpassBody(lat, lng, radius) {
    var q = '[out:json][timeout:25];way(around:' + (radius || RADIUS) + ',' + lat + ',' + lng + ')' +
      '["oneway"~"^(yes|true|1|-1)$"]["highway"~"' + HW + '"];out geom;';
    return 'data=' + encodeURIComponent(q);
  }

  // ---------- 地圖繪製 ----------
  function gmap() { return window.__mtLive && window.__mtLive.map; }
  function say(m) { if (window.toast) window.toast(m); }
  var _lines = [];
  function clearDraw() {
    var m = gmap();
    _lines.forEach(function (pl) { try { m && m.removeLayer(pl); } catch (_) {} });
    _lines = [];
  }
  function _draw(ways) {
    var m = gmap(); if (!m || !window.L) return;
    clearDraw();
    ways.slice(0, CAP_WAYS).forEach(function (w) {
      try {
        var path = _arrowPath(w.pts, BARB_M).map(function (p) { return [p.lat, p.lng]; });
        var pl = L.polyline(path, { color: COLOR, weight: WEIGHT, opacity: OPACITY });
        pl.addTo(m);
        _lines.push(pl);
      } catch (_) {}
    });
  }

  // ---------- Overpass（多鏡像平行競速，比照 restrictions.js）----------
  function _fetchOverpass(lat, lng) {
    var body = _overpassBody(lat, lng, RADIUS);
    return new Promise(function (resolve) {
      var pending = MIRRORS.length, settled = false;
      MIRRORS.forEach(function (url) {
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
        var opt = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body };
        if (ctrl) opt.signal = ctrl.signal;
        fetch(url, opt).then(function (r) { clearTimeout(timer); if (!r || !r.ok) throw new Error('http'); return r.json(); })
          .then(function (d) { if (!settled) { settled = true; resolve(d); } })
          .catch(function () { clearTimeout(timer); pending--; if (pending <= 0 && !settled) { settled = true; resolve(null); } });
      });
    });
  }
  var _fetching = false, _lastCenter = null;
  function _fetchAndDraw(lat, lng, quiet) {
    if (_fetching) return;
    _fetching = true;
    if (!quiet) say('載入單行道…');
    _fetchOverpass(lat, lng).then(function (data) {
      _fetching = false;
      if (!_enabled) return;                       // 抓的途中被關掉
      if (!data) { if (!quiet) say('地圖服務暫時無法連線'); return; }
      var ways = _parseWays(data.elements || []);
      _lastCenter = { lat: lat, lng: lng };
      _draw(ways);
      if (!quiet) say(ways.length ? ('單行道 ' + Math.min(ways.length, CAP_WAYS) + ' 條，箭頭＝行駛方向') : '附近沒有單行道資料');
    }).catch(function () { _fetching = false; if (!quiet) say('載入失敗，稍後再試'); });
  }

  // ---------- 生命週期 / 開關 ----------
  var _enabled = false, _moveTimer = null, _lowZoomToasted = false;
  var _onMoveEnd = function () {
    if (!_enabled) return;
    clearTimeout(_moveTimer);
    _moveTimer = setTimeout(_maybeRefetch, 600);
  };
  function _maybeRefetch() {
    var m = gmap(); if (!m || !_enabled) return;
    if (m.getZoom() < MINZOOM) { clearDraw(); _lastCenter = null; return; }
    var c = m.getCenter();
    if (_lastCenter && _lines.length &&
        _haversine(_lastCenter, { lat: c.lat, lng: c.lng }) < REFETCH_MOVE) return;
    _fetchAndDraw(c.lat, c.lng, true);
  }
  function enable() {
    var m = gmap();
    _enabled = true;
    try { localStorage.setItem(KEY_ON, '1'); } catch (_) {}
    if (!m) { say('地圖尚未就緒'); return; }
    m.on('moveend', _onMoveEnd); m.on('zoomend', _onMoveEnd);
    if (m.getZoom() < MINZOOM) { say('放大地圖即顯示單行道方向'); _lowZoomToasted = true; return; }
    var c = m.getCenter(); _fetchAndDraw(c.lat, c.lng, false);
  }
  function disable() {
    _enabled = false;
    try { localStorage.setItem(KEY_ON, '0'); } catch (_) {}
    var m = gmap();
    if (m) { try { m.off('moveend', _onMoveEnd); m.off('zoomend', _onMoveEnd); } catch (_) {} }
    clearTimeout(_moveTimer); _lastCenter = null; _lowZoomToasted = false;
    clearDraw();
    say('已關閉單行道方向');
  }
  function toggle() { if (_enabled) disable(); else enable(); }
  function isOn() { return _enabled; }
  // 開機還原：上次開著就自動開（地圖已備妥後由 app.js boot 呼叫）
  function init() {
    try { if (localStorage.getItem(KEY_ON) === '1') enable(); } catch (_) {}
  }

  global.MaptripOneway = {
    init: init, toggle: toggle, enable: enable, disable: disable, isOn: isOn,
    // 純函式（測試）
    _bearing: _bearing, _dest: _dest, _arrowPath: _arrowPath, _parseWays: _parseWays,
    _overpassBody: _overpassBody, _haversine: _haversine
  };
})(typeof window !== 'undefined' ? window : globalThis);
