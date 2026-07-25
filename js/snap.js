/* snap.js — OSRM 貼路（Map Matching /match + /route 後備）
 * 從 app.js 原封搬出 _sampleTrack / _snapSane / snapToRoads（邏輯逐字不變）。
 * 相依：MaptripGeoClean.cleanTrace（飄移群不進貼路）；內含與 app.js 相同的 haversine / calcTotalDist。
 * 診斷：沿用 window._snapErr（診斷模式顯示真正失敗原因；app.js retrySnapBacklog 讀取）。
 *
 * 心法（勿改，血淚）：OSRM 公開 /match 點數上限會變 → 自適應降階取樣 95→60→40→25；
 * 連 25 點也被拒 → 後備 /route 以途經點近似；貼路繞太遠（比原始長太多）＝飄點造成的假路線 → 棄用、保留原始軌跡。
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
  function calcTotalDist(coords) {
    var d = 0;
    for (var i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
    return d;
  }

  // 均勻取樣至最多 maxPts 點（step 用 ceil 才保證取樣後 ≤ maxPts；結尾補回真正的終點）
  function sampleTrack(coords, maxPts) {
    var pts = coords;
    if (pts.length > maxPts) {
      var step = Math.ceil(pts.length / maxPts);
      pts = coords.filter(function (_, i) { return i % step === 0; });
      if (pts.length >= maxPts) pts = pts.slice(0, maxPts - 1);
      if (pts[pts.length - 1] !== coords[coords.length - 1])
        pts.push(coords[coords.length - 1]);
    }
    return pts;
  }

  // 貼路結果健全性檢查：貼出來比原始軌跡長太多 → 必是飄點繞遠，棄用。
  function snapSane(result, coords, ratio, slack) {
    try {
      var raw = calcTotalDist(coords);
      return calcTotalDist(result) <= raw * (ratio || 1.4) + (slack || 500);
    } catch (_) { return true; }
  }

  async function snapToRoads(coords) {
    if (coords.length < 2) return null;
    coords = global.MaptripGeoClean.cleanTrace(coords);   // 飄移群不進貼路（否則被當必經點繞路、產生假路線）

    // OSRM 公開伺服器點數上限「會變」→ 被嫌太大就自動縮小取樣數再試。
    for (var mi = 0; mi < 4; mi++) {
      var maxPts = [95, 60, 40, 25][mi];
      var pts = sampleTrack(coords, maxPts);
      var coordStr = pts.map(function (c) { return c.lng + ',' + c.lat; }).join(';');
      var hasT = pts.every(function (c) { return typeof c.t === 'number' && isFinite(c.t); });
      var tsStr = hasT ? pts.map(function (c) { return Math.floor(c.t / 1000); }).join(';') : null;

      var attempts = [
        { r: 50, ts: !!tsStr },
        { r: 50, ts: false },
        { r: 30, ts: false }
      ];
      var tooBig = false;
      for (var ai = 0; ai < attempts.length; ai++) {
        var a = attempts[ai];
        var radii = pts.map(function () { return String(a.r); }).join(';');
        var tsParam = (a.ts && tsStr) ? ('&timestamps=' + tsStr) : '';
        var url = 'https://router.project-osrm.org/match/v1/driving/' + coordStr +
          '?radiuses=' + radii + tsParam + '&geometries=geojson&overview=full&annotations=false';
        try {
          var res = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) {
            var detail = '';
            try { var body = await res.json(); detail = body.code || body.message || ''; } catch (_) {}
            global._snapErr = 'HTTP' + res.status + (detail ? ':' + detail : '');
            if (/toobig/i.test(detail)) { tooBig = true; break; }
            continue;
          }
          var data = await res.json();
          if (data.code === 'Ok' && data.matchings && data.matchings.length) {
            var out = data.matchings.reduce(function (acc, m) {
              return acc.concat(m.geometry.coordinates.map(function (p) { return { lat: p[1], lng: p[0] }; }));
            }, []);
            if (snapSane(out, coords)) { global._snapErr = null; return out; }
            global._snapErr = '貼路繞遠(棄用)';
            continue;
          }
          global._snapErr = data.code || 'NoMatch';
        } catch (e) {
          global._snapErr = (e && e.name === 'TimeoutError') ? '逾時' : '網路錯誤';
          return null;
        }
      }
      if (!tooBig) return null;
    }
    // /match 連最小取樣都被拒 → 後備 /route（取樣點當途經點）
    try {
      var pts2 = sampleTrack(coords, 25);
      var coordStr2 = pts2.map(function (c) { return c.lng + ',' + c.lat; }).join(';');
      var url2 = 'https://router.project-osrm.org/route/v1/driving/' + coordStr2 +
        '?overview=full&geometries=geojson&steps=false&annotations=false';
      var res2 = await fetch(url2, { signal: AbortSignal.timeout(10000) });
      if (res2.ok) {
        var data2 = await res2.json();
        if (data2.code === 'Ok' && data2.routes && data2.routes.length) {
          var out2 = data2.routes[0].geometry.coordinates.map(function (p) { return { lat: p[1], lng: p[0] }; });
          if (snapSane(out2, coords, 1.2, 200)) { global._snapErr = null; return out2; }
          global._snapErr = '貼路繞遠(棄用)';
        }
      }
    } catch (_) {}
    return null;
  }

  global.MaptripSnap = {
    snapToRoads: snapToRoads,
    sampleTrack: sampleTrack,
    snapSane: snapSane,
    calcTotalDist: calcTotalDist
  };

})(typeof window !== 'undefined' ? window : globalThis);
