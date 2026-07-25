/* geo-clean.js — GPS 飄移群清理（純函式）
 * 從 app.js 原封搬出 _perpM / _dropSpikes / _cleanTrace（邏輯逐字不變）。
 * 內含一份與 app.js 相同的 haversine（IIFE 區域，不與全域衝突）。
 *
 * 心法（勿改判準，這是 v246 血淚）：飄移常是「一叢」來回鋸齒，
 * 要「繞行>2.5×且多繞60m」且「甩回原地(<35m) 或 尖刺(apex>端距2×)」，
 * 且「第一個中間點自己偏離>15m」才刪整叢；_cleanTrace 迭代 4 趟，
 * 安全閥＝清掉>40%（且原>=25點）視為誤傷、還原原始軌跡。
 */
(function (global) {
  'use strict';

  function haversine(a, b) {
    var R = 6371000;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var x = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.pow(Math.sin(dLng / 2), 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  // 點 p 到線段 a-b 的垂直距離（公尺，區域平面近似，短距離足夠準）
  function perpM(a, b, p) {
    var kx = 111000 * Math.cos(a.lat * Math.PI / 180), ky = 111000;
    var ax = a.lng * kx, ay = a.lat * ky, bx = b.lng * kx, by = b.lat * ky, px = p.lng * kx, py = p.lat * ky;
    var dx = bx - ax, dy = by - ay;
    var len = Math.hypot(dx, dy) || 1;
    return Math.abs((px - ax) * dy - (py - ay) * dx) / len;
  }

  // 剔除「來回飄移群」。從上一個保留點 a 往前看最多 4 點。
  function dropSpikes(coords) {
    if (!coords || coords.length < 3) return coords;
    var out = [coords[0]];
    var i = 1;
    while (i < coords.length) {
      if (i === coords.length - 1) { out.push(coords[i]); break; }
      var a = out[out.length - 1];
      var collapsed = false;
      for (var j = i + 1; j <= Math.min(i + 4, coords.length - 1); j++) {
        var via = haversine(a, coords[i]);
        for (var k = i; k < j; k++) via += haversine(coords[k], coords[k + 1]);
        var direct = haversine(a, coords[j]);
        if (via > direct * 2.5 && via - direct > 60 && perpM(a, coords[j], coords[i]) > 15) {
          var apex = 0;
          for (var k2 = i; k2 < j; k2++) apex = Math.max(apex, perpM(a, coords[j], coords[k2]));
          if (direct < 35 || apex > direct * 2) { i = j; collapsed = true; break; }
        }
      }
      if (!collapsed) { out.push(coords[i]); i++; }
    }
    return out;
  }

  // 迭代清理鋸齒/飄點群。安全閥：清掉 >40% 的點（且原 >=25 點）＝門檻誤傷，還原。
  function cleanTrace(coords) {
    if (!coords || coords.length < 4) return coords;
    var cur = coords;
    for (var pass = 0; pass < 4; pass++) {
      var next = dropSpikes(cur);
      if (next.length === cur.length) break;   // 穩定：沒有飄點可剝了
      cur = next;
    }
    if (coords.length >= 25 && cur.length < coords.length * 0.6) return coords;
    return cur;
  }

  global.MaptripGeoClean = {
    perpM: perpM,
    dropSpikes: dropSpikes,
    cleanTrace: cleanTrace,
    haversine: haversine
  };

})(typeof window !== 'undefined' ? window : globalThis);
