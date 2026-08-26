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

  // 收「停等紅燈原地飄移成一叢/一圈」的群（v275）。dropSpikes 只往前看 4 點，
  // 但紅燈久等會堆出「幾十個點的一小圈」，遠超過 4 點窗、收不掉（使用者實例：路口一個小方框）。
  // 判準：從上一個保留點 a 出發，一段路徑在「小範圍內（離 a <CAP）繞了不少路（via>=MINVIA）、
  // 點數夠多（>=MINPTS）後又繞回 a 附近（<RETURN）」＝原地飄移 → 整叢收掉、只留 a 當代表。
  //   CAP=100m 是關鍵護欄：真的繞街廓（半徑通常 >100m）會先超過 CAP 而不被收，只收侷限的小圈。
  function collapseStalls(coords) {
    if (!coords || coords.length < 5) return coords;
    var RETURN = 35, CAP = 100, MAXN = 40, MINPTS = 5, MINVIA = 100;
    var out = [coords[0]];
    var i = 1;
    while (i < coords.length) {
      var a = out[out.length - 1];
      var best = -1, curMaxR = 0, via = haversine(a, coords[i]);
      for (var j = i; j <= Math.min(i + MAXN, coords.length - 1); j++) {
        if (j > i) via += haversine(coords[j - 1], coords[j]);
        var r = haversine(a, coords[j]);
        if (r > curMaxR) curMaxR = r;
        if (curMaxR > CAP) break;                     // 跑太遠＝真的在移動，不是原地飄移
        if (j - i + 1 >= MINPTS && r < RETURN && curMaxR >= 20 && via >= MINVIA) best = j;
      }
      if (best > i) { i = best + 1; continue; }        // 丟掉 i..best（原地飄移叢），a 當代表點
      out.push(coords[i]); i++;
    }
    return out;
  }

  // 迭代清理鋸齒/飄點群。安全閥：清掉 >40% 的點（且原 >=25 點）＝門檻誤傷，還原。
  function cleanTrace(coords) {
    if (!coords || coords.length < 4) return coords;
    // 先收原地飄移叢（紅燈停等，v275）。這步收的是「繞回原地的小範圍叢」，本來就該收一大票點，
    // 故不納入下方 40% 安全閥（否則長紅燈的合理收斂會被誤判成誤傷而還原）。
    var stalled = collapseStalls(coords);
    var cur = stalled;
    for (var pass = 0; pass < 4; pass++) {
      var next = dropSpikes(cur);
      if (next.length === cur.length) break;   // 穩定：沒有飄點可剝了
      cur = next;
    }
    // 安全閥只防 dropSpikes 誤傷（相對已收斂的 stalled 比例）；collapseStalls 的收斂不算誤傷。
    if (stalled.length >= 25 && cur.length < stalled.length * 0.6) return stalled;
    return cur;
  }

  global.MaptripGeoClean = {
    perpM: perpM,
    dropSpikes: dropSpikes,
    collapseStalls: collapseStalls,
    cleanTrace: cleanTrace,
    haversine: haversine
  };

})(typeof window !== 'undefined' ? window : globalThis);
