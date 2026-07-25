/* bg-geo.js — 背景定位封裝(隔離 Capacitor 插件)*/
(function (global) {
  'use strict';

  function makeCapacitorGeo(BgGeo) {
    var watchId = null;
    return {
      kind: 'capacitor',
      start: function (onPoint) {
        BgGeo.addWatcher({
          backgroundMessage: '行程記錄中',
          backgroundTitle: 'Maptrip',
          requestPermissions: true,
          stale: false,
          distanceFilter: 5        // 移動 5m 才回報,省電也省髒點
        }, function (loc, err) {
          if (err) return;
          onPoint({ lat: loc.latitude, lng: loc.longitude,
                    accuracy: loc.accuracy, t: Date.now() });
        }).then(function (id) { watchId = id; });
      },
      stop: function () {
        if (watchId) { BgGeo.removeWatcher({ id: watchId }); watchId = null; }
      }
    };
  }

  function makeBrowserGeo() {
    var id = null;
    return {
      kind: 'browser',   // 注意:瀏覽器一進背景就停,僅前景可用
      start: function (onPoint) {
        if (!global.navigator || !global.navigator.geolocation) return;
        id = global.navigator.geolocation.watchPosition(function (p) {
          onPoint({ lat: p.coords.latitude, lng: p.coords.longitude,
                    accuracy: p.coords.accuracy, t: Date.now() });
        }, function () { }, { enableHighAccuracy: true, maximumAge: 0 });
      },
      stop: function () {
        if (id != null && global.navigator && global.navigator.geolocation) {
          global.navigator.geolocation.clearWatch(id); id = null;
        }
      }
    };
  }

  function makeMockGeo() {
    var cb = null;
    return {
      kind: 'mock',
      start: function (onPoint) { cb = onPoint; },
      stop: function () { cb = null; },
      _feed: function (pt) { if (cb) cb(pt); }     // 測試用:手動餵點
    };
  }

  function detect() {
    var cap = global.Capacitor;
    var BgGeo = global.BackgroundGeolocation ||
      (cap && cap.Plugins && cap.Plugins.BackgroundGeolocation);
    if (BgGeo) return makeCapacitorGeo(BgGeo);
    if (global.navigator && global.navigator.geolocation) return makeBrowserGeo();
    return makeMockGeo();
  }

  global.MaptripBgGeo = { detect: detect, _makeMock: makeMockGeo };

})(typeof window !== 'undefined' ? window : globalThis);
