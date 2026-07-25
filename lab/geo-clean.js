/* geo-clean.js — GPS 飄移群清理(純函式)*/
(function (global) {
  'use strict';

  var gate = global.MaptripGeoGate;              // 共用 distM,不重造
  var distM = gate ? gate.distM : function () { return 0; };

  var CFG = {
    DETOUR_RATIO: 2.5,     // 繞行/直線 > 2.5 才算可疑
    EXTRA_M: 60,           // 且多繞 > 60m
    SNAPBACK_M: 35,        // 端點 < 35m = 甩回原地
    APEX_RATIO: 2,         // 或 垂距 apex > 端距 2× = 尖刺
    MID_DEVIATE_M: 15,     // 第一個中間點自己要偏離 > 15m(避免連坐直行)
    WINDOW: 4,             // 視窗式往前看 4 點,收整叢
    ITERATIONS: 4,         // 迭代 4 趟
    MIN_POINTS: 25         // 安全閥:< 25 點不清理,防過度清理短軌跡
  };

  // 點到線段的垂直距離(公尺)。對應文件 _perpM()。
  function perpM(p, a, b) {
    var ax = a.lng, ay = a.lat, bx = b.lng, by = b.lat, px = p.lng, py = p.lat;
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return distM(p, a);
    var t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    var proj = { lng: ax + t * dx, lat: ay + t * dy };
    return distM(p, proj);
  }

  /** 剔除孤立飄點/飄移叢。對應文件 _dropSpikes()。純函式,不改原陣列。 */
  function dropSpikes(coords) {
    if (!Array.isArray(coords) || coords.length < CFG.MIN_POINTS) {
      return coords ? coords.slice() : [];
    }
    var out = coords.slice();
    for (var i = 1; i < out.length - 1; i++) {
      var start = out[i - 1];
      var end = out[Math.min(i + CFG.WINDOW, out.length - 1)];
      var pathLen = 0;
      for (var k = i - 1; k < Math.min(i + CFG.WINDOW, out.length - 1); k++) {
        pathLen += distM(out[k], out[k + 1]);
      }
      var straight = distM(start, end);
      if (straight === 0) continue;
      var ratio = pathLen / straight;
      var extra = pathLen - straight;
      if (ratio <= CFG.DETOUR_RATIO || extra <= CFG.EXTRA_M) continue;   // 條件一:繞很多
      var apex = perpM(out[i], start, end);
      var snapback = straight < CFG.SNAPBACK_M;
      var spike = apex > straight * CFG.APEX_RATIO;
      if (!snapback && !spike) continue;                                 // 條件二:甩回/尖刺
      if (perpM(out[i], start, end) < CFG.MID_DEVIATE_M) continue;       // 條件三:自己偏離
      var removeEnd = Math.min(i + CFG.WINDOW, out.length - 1);          // 通過三關 → 移除整叢
      out.splice(i, removeEnd - i);
    }
    return out;
  }

  /** 迭代清理。對應文件 _cleanTrace(),跑數趟直到穩定。 */
  function cleanTrace(coords) {
    var cur = Array.isArray(coords) ? coords.slice() : [];
    if (cur.length < CFG.MIN_POINTS) return cur;   // 安全閥
    for (var n = 0; n < CFG.ITERATIONS; n++) {
      var before = cur.length;
      cur = dropSpikes(cur);
      if (cur.length === before) break;            // 穩定就提早停
    }
    return cur;
  }

  global.MaptripGeoClean = {
    dropSpikes: dropSpikes,
    cleanTrace: cleanTrace,
    perpM: perpM,
    CFG: CFG
  };

})(typeof window !== 'undefined' ? window : globalThis);
