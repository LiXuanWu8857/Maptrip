/* geo-gate.js — GPS 品質閘門（源頭擋髒資料）
 * 從 app.js 的 GPS 品質閘門（原內嵌於 onGpsUpdate）原封搬出。
 * 判準（與原本一致）：水平精度 > 40m 不記錄；相對前點瞬移 > 50 m/s（≈180km/h）不記錄。
 * 內含一份與 app.js 相同的 haversine（IIFE 區域變數，不與全域衝突）。
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

  /**
   * 一個新收到的 GPS 點該不該記錄。
   * @param {{lat,lng,accuracy,t}} pt   新點（t = 毫秒時間戳，通常 Date.now()）
   * @param {{lat,lng,t}|null} prev      上一個「已接受」的點（第一點傳 null）
   * @returns {{accept:boolean, reason:string}}
   */
  function accept(pt, prev) {
    var badAcc = pt && pt.accuracy != null && pt.accuracy > 40;
    var isJump = !!(prev &&
      haversine(prev, pt) / Math.max(1, (pt.t - prev.t) / 1000) > 50);
    if (badAcc) return { accept: false, reason: 'accuracy' };
    if (isJump) return { accept: false, reason: 'teleport' };
    return { accept: true, reason: 'ok' };
  }

  global.MaptripGeoGate = { accept: accept, haversine: haversine };

})(typeof window !== 'undefined' ? window : globalThis);
