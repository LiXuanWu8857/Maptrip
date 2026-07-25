/* geo-gate.js — GPS 品質閘門(源頭擋髒資料)*/
(function (global) {
  'use strict';

  // 可調參數集中在這(不要散在邏輯裡,方便日後用數據調)
  var CFG = {
    MAX_ACCURACY_M: 40,      // 精度 > 40m 的點不可信,丟棄
    MAX_SPEED_MPS: 50        // 瞬移 > 50m/s(≈180km/h)物理不可能,丟棄
  };

  // Haversine:兩點間地表距離(公尺)。純數學,無副作用。
  function distM(a, b) {
    var R = 6371000;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /**
   * 判斷一個新收到的 GPS 點該不該記錄。
   * @param {{lat,lng,accuracy,t}} pt   新的點(t = 毫秒時間戳)
   * @param {{lat,lng,t}|null} prev      上一個「已接受」的點(第一點傳 null)
   * @returns {{accept:boolean, reason:string}}
   */
  function accept(pt, prev) {
    if (!pt || typeof pt.lat !== 'number' || typeof pt.lng !== 'number') {
      return { accept: false, reason: 'invalid' };
    }
    // 閘門一:精度。GPS 冷啟動或都市峽谷,accuracy 會很大。
    if (typeof pt.accuracy === 'number' && pt.accuracy > CFG.MAX_ACCURACY_M) {
      return { accept: false, reason: 'accuracy' };
    }
    // 閘門二:瞬移速度。跟上一個接受點比,算出速度。
    if (prev && typeof pt.t === 'number' && typeof prev.t === 'number') {
      var dt = (pt.t - prev.t) / 1000;             // 秒
      if (dt > 0) {
        var v = distM(prev, pt) / dt;              // m/s
        if (v > CFG.MAX_SPEED_MPS) {
          return { accept: false, reason: 'teleport' };
        }
      }
    }
    return { accept: true, reason: 'ok' };
  }

  global.MaptripGeoGate = {
    accept: accept,
    distM: distM,      // 匯出讓其他模組(清理、里程)共用,不重複實作
    CFG: CFG           // 匯出讓測試可覆寫、讓主程式可微調
  };

})(typeof window !== 'undefined' ? window : globalThis);
