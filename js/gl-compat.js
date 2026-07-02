// gl-compat.js — MapLibre GL 向量地圖引擎的 Leaflet 相容層（Beta）
// 目的：地圖旋轉（朝車頭）時，街道文字保持正立（向量文字即時重繪）。
// 做法：實作 app.js 用到的 Leaflet API 子集，底層轉譯成 MapLibre GL 呼叫，
//       app.js 完全不用改。切回標準地圖時本檔不載入，走原本 Leaflet。
//
// 座標/縮放慣例：
//  - 對外全部維持 Leaflet 慣例：[lat,lng]、Leaflet zoom（= GL zoom + 1）、
//    setBearing 為 leaflet-rotate 方向（= -GL bearing）。
(function () {
  'use strict';
  if (typeof maplibregl === 'undefined') return;

  var VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  var uid = 0;

  // 關鍵 CSS 內建保險：maplibre-gl.css 若從 CDN 載入失敗，
  // 少了 touch-action:none 這條，iOS 會把手勢當成頁面捲動 → 地圖完全不能拖/縮。
  // 這裡直接注入最必要的規則，CDN 掛了地圖照樣可操作。
  (function injectEssentialCss() {
    var st = document.createElement('style');
    st.textContent =
      '.maplibregl-map{position:relative;overflow:hidden;-webkit-tap-highlight-color:transparent}' +
      '.maplibregl-canvas-container{touch-action:none;-webkit-user-select:none;user-select:none}' +
      '.maplibregl-canvas{position:absolute;left:0;top:0;touch-action:none}' +
      '.maplibregl-marker{position:absolute;top:0;left:0;will-change:transform}' +
      '.maplibregl-control-container{display:none}';
    document.head.appendChild(st);
  })();

  function toLngLat(ll) {
    if (Array.isArray(ll)) return [ll[1], ll[0]];
    return [ll.lng, ll.lat];
  }
  function expandSubdomains(url, subs) {
    if (url.indexOf('{s}') === -1) return [url];
    return (subs || 'abc').split('').map(function (s) { return url.replace('{s}', s); });
  }

  // ---------- LatLngBounds ----------
  function LatLngBounds(coords) {
    var minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    (coords || []).forEach(function (c) {
      var lat = Array.isArray(c) ? c[0] : c.lat;
      var lng = Array.isArray(c) ? c[1] : c.lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    });
    this.bbox = [[minLng, minLat], [maxLng, maxLat]];
  }

  // ---------- Polyline ----------
  function Polyline(latlngs, style) {
    this._id = 'shim-line-' + (++uid);
    this._coords = (latlngs || []).map(toLngLat);
    this._style = style || {};
    this._map = null;
    this._removed = false;
    this._clicks = [];
  }
  Polyline.prototype._geojson = function () {
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: this._coords } };
  };
  Polyline.prototype.addTo = function (map) {
    var self = this;
    this._map = map;
    map._exec(function () {
      if (self._removed) return;
      var gl = map.gl;
      if (gl.getSource(self._id)) return;
      gl.addSource(self._id, { type: 'geojson', data: self._geojson() });
      var paint = {
        'line-color': self._style.color || '#3388ff',
        'line-width': self._style.weight != null ? self._style.weight : 3,
        'line-opacity': self._style.opacity != null ? self._style.opacity : 1
      };
      if (self._style.dashArray) {
        var w = self._style.weight || 3;
        paint['line-dasharray'] = String(self._style.dashArray).trim().split(/[\s,]+/)
          .map(function (n) { return parseFloat(n) / w; });
      }
      gl.addLayer({
        id: self._id, type: 'line', source: self._id,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: paint
      });
      map._overlayIds.push(self._id);
      self._clicks.forEach(function (fn) { gl.on('click', self._id, fn); });
    });
    return this;
  };
  Polyline.prototype.addLatLng = function (ll) {
    var self = this;
    this._coords.push(toLngLat(ll));
    if (this._map) this._map._exec(function () {
      var src = self._map.gl.getSource(self._id);
      if (src) src.setData(self._geojson());
    });
    return this;
  };
  Polyline.prototype.setLatLngs = function (lls) {
    var self = this;
    this._coords = (lls || []).map(toLngLat);
    if (this._map) this._map._exec(function () {
      var src = self._map.gl.getSource(self._id);
      if (src) src.setData(self._geojson());
    });
    return this;
  };
  Polyline.prototype.setStyle = function (st) {
    var self = this;
    if (!this._map) { Object.assign(this._style, st); return this; }
    this._map._exec(function () {
      var gl = self._map.gl;
      if (!gl.getLayer(self._id)) return;
      if (st.opacity != null) gl.setPaintProperty(self._id, 'line-opacity', st.opacity);
      if (st.color) gl.setPaintProperty(self._id, 'line-color', st.color);
      if (st.weight != null) gl.setPaintProperty(self._id, 'line-width', st.weight);
    });
    return this;
  };
  Polyline.prototype.on = function (type, fn) {
    if (type !== 'click') return this;
    var self = this;
    this._clicks.push(fn);
    if (this._map) this._map._exec(function () {
      if (self._map.gl.getLayer(self._id)) self._map.gl.on('click', self._id, fn);
    });
    return this;
  };
  Polyline.prototype._removeFrom = function (map) {
    var self = this;
    this._removed = true;
    map._exec(function () {
      var gl = map.gl;
      self._clicks.forEach(function (fn) { gl.off('click', self._id, fn); });
      if (gl.getLayer(self._id)) gl.removeLayer(self._id);
      if (gl.getSource(self._id)) gl.removeSource(self._id);
      var i = map._overlayIds.indexOf(self._id);
      if (i >= 0) map._overlayIds.splice(i, 1);
    });
  };

  // ---------- Marker（DOM，永遠正立） ----------
  function Marker(latlng, opts) {
    opts = opts || {};
    var icon = opts.icon || {};
    var el = document.createElement('div');
    el.innerHTML = icon.html || '';
    if (icon.iconSize) {
      el.style.width = icon.iconSize[0] + 'px';
      el.style.height = icon.iconSize[1] + 'px';
    }
    if (opts.zIndexOffset) el.style.zIndex = String(opts.zIndexOffset);
    var anchor = icon.iconAnchor || [0, 0];
    this._mk = new maplibregl.Marker({
      element: el, anchor: 'top-left',
      offset: [-anchor[0], -anchor[1]]
    }).setLngLat(toLngLat(latlng));
    this._el = el;
  }
  Marker.prototype.addTo = function (map) { this._mk.addTo(map.gl); return this; };
  Marker.prototype.setLatLng = function (ll) { this._mk.setLngLat(toLngLat(ll)); return this; };
  Marker.prototype.setOpacity = function (v) { this._el.style.opacity = String(v); return this; };
  Marker.prototype.getElement = function () { return this._el; };
  Marker.prototype._removeFrom = function () { this._mk.remove(); };

  // ---------- Circle（精度圈：多邊形近似） ----------
  function Circle(latlng, opts) {
    opts = opts || {};
    this._id = 'shim-circle-' + (++uid);
    this._center = toLngLat(latlng);
    this._radius = opts.radius || 0;
    this._opts = opts;
    this._map = null;
    this._removed = false;
  }
  Circle.prototype._geojson = function () {
    var pts = [], n = 48;
    var lat = this._center[1], lng = this._center[0];
    var dLat = this._radius / 111320;
    var dLng = this._radius / (111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * Math.PI * 2;
      pts.push([lng + Math.cos(a) * dLng, lat + Math.sin(a) * dLat]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } };
  };
  Circle.prototype.addTo = function (map) {
    var self = this;
    this._map = map;
    map._exec(function () {
      if (self._removed) return;
      var gl = map.gl;
      if (gl.getSource(self._id)) return;
      gl.addSource(self._id, { type: 'geojson', data: self._geojson() });
      gl.addLayer({
        id: self._id, type: 'fill', source: self._id,
        paint: {
          'fill-color': self._opts.fillColor || self._opts.color || '#3388ff',
          'fill-opacity': self._opts.fillOpacity != null ? self._opts.fillOpacity : 0.2
        }
      });
      map._overlayIds.push(self._id);
    });
    return this;
  };
  Circle.prototype._update = function () {
    var self = this;
    if (!this._map) return;
    this._map._exec(function () {
      var src = self._map.gl.getSource(self._id);
      if (src) src.setData(self._geojson());
    });
  };
  Circle.prototype.setLatLng = function (ll) { this._center = toLngLat(ll); this._update(); return this; };
  Circle.prototype.setRadius = function (r) { this._radius = r; this._update(); return this; };
  Circle.prototype._removeFrom = function (map) {
    var self = this;
    this._removed = true;
    map._exec(function () {
      var gl = map.gl;
      if (gl.getLayer(self._id)) gl.removeLayer(self._id);
      if (gl.getSource(self._id)) gl.removeSource(self._id);
      var i = map._overlayIds.indexOf(self._id);
      if (i >= 0) map._overlayIds.splice(i, 1);
    });
  };

  // ---------- TileLayer（衛星圖 / 無文字底圖 → raster 覆蓋層） ----------
  function TileLayer(url, opts) {
    this._id = 'shim-raster-' + (++uid);
    this._tiles = expandSubdomains(url.replace('{r}', ''), (opts || {}).subdomains);
    this._isBase = /lyrs=m/.test(url);   // Google 一般地圖 = 向量底圖本身 → no-op
    this._map = null;
    this._removed = false;
  }
  TileLayer.prototype.addTo = function (map) {
    var self = this;
    this._map = map;
    if (this._isBase) return this;      // 向量底圖就是道路圖，不需再疊
    this._removed = false;
    map._exec(function () {
      if (self._removed) return;
      var gl = map.gl;
      if (!gl.getSource(self._id)) {
        gl.addSource(self._id, { type: 'raster', tiles: self._tiles, tileSize: 256, maxzoom: 20 });
      }
      if (!gl.getLayer(self._id)) {
        gl.addLayer({ id: self._id, type: 'raster', source: self._id });
      }
      self._toBack(map);                // raster 一律墊在既有覆蓋層（路線等）下面
    });
    return this;
  };
  TileLayer.prototype._toBack = function (map) {
    var gl = map.gl;
    if (!gl.getLayer(this._id)) return;
    for (var i = 0; i < map._overlayIds.length; i++) {
      var oid = map._overlayIds[i];
      if (oid !== this._id && gl.getLayer(oid)) { gl.moveLayer(this._id, oid); return; }
    }
  };
  TileLayer.prototype.bringToBack = function () {
    var self = this;
    if (this._map) this._map._exec(function () { self._toBack(self._map); });
    return this;
  };
  TileLayer.prototype._removeFrom = function (map) {
    var self = this;
    this._removed = true;
    if (this._isBase) return;
    map._exec(function () {
      var gl = map.gl;
      if (gl.getLayer(self._id)) gl.removeLayer(self._id);
      if (gl.getSource(self._id)) gl.removeSource(self._id);
    });
  };

  // ---------- Map ----------
  function GlMap(containerId, opts) {
    var self = this;
    this._overlayIds = [];
    this._queue = [];
    this._ready = false;
    this._handlers = {};   // type → Map(origFn → wrappedFn)

    this.gl = new maplibregl.Map({
      container: containerId,
      style: VECTOR_STYLE,
      center: [121.565, 25.033],
      zoom: 14,
      attributionControl: false,
      pitchWithRotate: false,
      maxZoom: 20
    });
    // 關掉手勢旋轉/傾斜（旋轉由程式控制，與 Leaflet 版行為一致）
    try {
      this.gl.dragRotate.disable();
      this.gl.touchZoomRotate.disableRotation();
      this.gl.touchPitch.disable();
      this.gl.keyboard.disableRotation();
    } catch (e) {}

    this.gl.on('load', function () {
      self._ready = true;
      var q = self._queue; self._queue = [];
      q.forEach(function (fn) { try { fn(); } catch (e) {} });
    });
    // 向量樣式載入失敗 → 自動切回標準（Leaflet）引擎，App 不會卡白畫面
    var hadError = false;
    this.gl.on('error', function () { hadError = true; });
    setTimeout(function () {
      if (!self._ready && hadError) {
        try { localStorage.removeItem('maptrip_gl'); } catch (e) {}
        location.reload();
      }
    }, 20000);

    // Leaflet 風格 handler 物件
    this.dragging = {
      enable: function () { self.gl.dragPan.enable(); },
      disable: function () { self.gl.dragPan.disable(); }
    };
    this.touchZoom = {
      enable: function () { self.gl.touchZoomRotate.enable(); self.gl.touchZoomRotate.disableRotation(); },
      disable: function () { self.gl.touchZoomRotate.disable(); }
    };
    this.doubleClickZoom = {
      enable: function () { self.gl.doubleClickZoom.enable(); },
      disable: function () { self.gl.doubleClickZoom.disable(); }
    };
  }
  GlMap.prototype._exec = function (fn) {
    if (this._ready) { try { fn(); } catch (e) {} }
    else this._queue.push(fn);
  };
  GlMap.prototype.setView = function (ll, zoom) {
    var o = { center: toLngLat(ll) };
    if (zoom != null) o.zoom = zoom - 1;   // Leaflet zoom → GL zoom
    this.gl.jumpTo(o);
    return this;
  };
  GlMap.prototype.panTo = function (ll, opts) {
    opts = opts || {};
    this.gl.easeTo({
      center: toLngLat(ll),
      duration: opts.animate === false ? 0 : ((opts.duration || 0.5) * 1000)
    });
    return this;
  };
  GlMap.prototype.fitBounds = function (bounds, opts) {
    opts = opts || {};
    var ptl = opts.paddingTopLeft || [0, 0];
    var pbr = opts.paddingBottomRight || [0, 0];
    var o = {
      padding: { left: ptl[0], top: ptl[1], right: pbr[0], bottom: pbr[1] },
      duration: opts.animate === false ? 0 : 600
    };
    var bbox = bounds.bbox || bounds;
    var gl = this.gl;
    this._exec(function () { try { gl.fitBounds(bbox, o); } catch (e) {} });
    return this;
  };
  GlMap.prototype.getBoundsZoom = function (bounds, inside, pad) {
    pad = pad || { x: 0, y: 0 };
    try {
      var cam = this.gl.cameraForBounds(bounds.bbox || bounds,
        { padding: { top: pad.y, bottom: pad.y, left: pad.x, right: pad.x } });
      if (cam && cam.zoom != null) return cam.zoom + 1;   // → Leaflet zoom
    } catch (e) {}
    return 14;
  };
  GlMap.prototype.invalidateSize = function () { try { this.gl.resize(); } catch (e) {} return this; };
  GlMap.prototype.removeLayer = function (layer) {
    if (layer && layer._removeFrom) layer._removeFrom(this);
    return this;
  };
  GlMap.prototype.setBearing = function (b) { this.gl.setBearing(-b); return this; };
  GlMap.prototype.getBearing = function () { return -this.gl.getBearing(); };
  GlMap.prototype.on = function (type, fn) {
    var self = this;
    var wrapped = function () { fn(); };
    this._handlers[type] = this._handlers[type] || new Map();
    this._handlers[type].set(fn, wrapped);
    this.gl.on(type, wrapped);
    return this;
  };
  GlMap.prototype.off = function (type, fn) {
    var m = this._handlers[type];
    if (m && m.has(fn)) { this.gl.off(type, m.get(fn)); m.delete(fn); }
    return this;
  };

  // ---------- 對外的 L ----------
  window.L = {
    map: function (id, opts) { return new GlMap(id, opts); },
    tileLayer: function (url, opts) { return new TileLayer(url, opts); },
    polyline: function (lls, style) { return new Polyline(lls, style); },
    marker: function (ll, opts) { return new Marker(ll, opts); },
    circle: function (ll, opts) { return new Circle(ll, opts); },
    divIcon: function (opts) { return opts || {}; },
    latLngBounds: function (coords) { return new LatLngBounds(coords); },
    point: function (x, y) { return { x: x, y: y }; }
  };
  window.MAPTRIP_GL = true;   // 給 app.js / 診斷判斷目前引擎
})();
