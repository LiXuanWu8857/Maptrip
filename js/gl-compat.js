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

  // ================= 台灣公路盾牌（依交通部現行圖示） =================
  // OpenFreeMap Liberty 用 OpenMapTiles schema：道路編號在 transportation_name
  // 圖層，欄位 class（等級）與 ref（編號）。Liberty 內建的是國際通用盾牌，
  // 這裡改成台灣式：國道=綠梅花、快速=紅盾、省道=藍盾、縣道=黃牌。
  // 依台灣公路編號範圍分類（國道1-10 / 快速台61-88 / 省道台1-39 / 縣道101-299）。
  function classifyTwRoad(cls, ref) {
    cls = String(cls == null ? '' : cls);
    var raw = String(ref == null ? '' : ref);
    if (!/\d/.test(raw)) return null;                        // 無數字（純名稱）→ 不掛盾
    var n = parseInt((raw.match(/\d+/) || ['0'])[0], 10);
    if (cls === 'motorway') return 'national';               // 國道（先判等級）
    // 鄉道/區道等地名字首（北37、南113、竹35…）→ 跳過（台/臺/國/省/縣/道/號 不算地名）
    if (/[一-鿿]/.test(raw) && !/[台臺國省縣道號]/.test(raw)) return null;
    if (n >= 61 && n <= 88) return 'expressway';             // 快速公路 台61-88
    if (n >= 100 && n <= 299) return 'county';               // 縣道 三位數
    if (n >= 1 && n <= 39) return 'provincial';              // 省道 台1-39
    return null;
  }

  // 依交通部實際圖示：省道=白底藍框倒三角、快速=暗紅倒三角白字、
  //                    國道=白梅花綠框黑字、縣道=白底黑框方形
  var TW_STYLE = {
    provincial: { shape: 'pick',   fill: '#ffffff', line: '#12489e', text: '#12489e', dbl: true },
    expressway: { shape: 'pick',   fill: '#8f1d20', line: '#ffffff', text: '#ffffff' },
    national:   { shape: 'plum',   fill: '#ffffff', line: '#1a7a3c', text: '#111111' },
    county:     { shape: 'square', fill: '#ffffff', line: '#111111', text: '#111111' }
  };
  function _cv(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function _num(ctx, t, x, y, fs, color) {
    ctx.fillStyle = color;
    ctx.font = 'bold ' + fs + 'px system-ui,-apple-system,Arial,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, x, y);
  }
  // 盾形（上寬圓、中段仍寬、底部收成圓尖）—— 省道/快速用
  function _pick(ctx, x, y, w, h) {
    ctx.beginPath();
    ctx.moveTo(x + w * 0.5, y);
    ctx.bezierCurveTo(x + w * 0.98, y,        x + w,        y + h * 0.30, x + w * 0.85, y + h * 0.56);
    ctx.bezierCurveTo(x + w * 0.73, y + h * 0.80, x + w * 0.57, y + h * 0.95, x + w * 0.5,  y + h);
    ctx.bezierCurveTo(x + w * 0.43, y + h * 0.95, x + w * 0.27, y + h * 0.80, x + w * 0.15, y + h * 0.56);
    ctx.bezierCurveTo(x,            y + h * 0.30, x + w * 0.02, y,            x + w * 0.5,  y);
    ctx.closePath();
  }
  // 梅花（5 瓣）— 用單一 fill 顏色畫；白花綠框靠先綠後白內縮兩層達成
  function _blossom(ctx, cx, cy, R, fill) {
    ctx.fillStyle = fill;
    var pr = R * 0.46;
    for (var i = 0; i < 5; i++) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / 5;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (R - pr), cy + Math.sin(a) * (R - pr), pr, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.54, 0, 2 * Math.PI); ctx.fill();
  }
  // 產生一張盾牌圖（pixelRatio 2），回傳 ImageData 供 gl.addImage 用
  function drawTwShield(type, ref) {
    var s = TW_STYLE[type];
    if (!s) return null;
    var num = String(ref == null ? '' : ref).replace(/\D/g, '') || '?';
    var P = 2, fs = 16 * P, ctx, c;
    var probe = _cv(4, 4).getContext('2d');
    probe.font = 'bold ' + fs + 'px system-ui,-apple-system,Arial,sans-serif';
    var tw = Math.ceil(probe.measureText(num).width);

    if (s.shape === 'plum') {                       // 國道：白梅花 + 綠框
      var S = Math.max(28 * P, tw + 20 * P);
      c = _cv(S, S); ctx = c.getContext('2d');
      _blossom(ctx, S / 2, S / 2, S / 2 * 0.97, s.line);          // 綠外框
      _blossom(ctx, S / 2, S / 2, S / 2 * 0.97 - 2.4 * P, s.fill); // 白內填
      _num(ctx, num, S / 2, S / 2, fs, s.text);
      return ctx.getImageData(0, 0, S, S);
    }
    if (s.shape === 'square') {                     // 縣道：白底黑框方形
      var h = 26 * P, w = Math.max(h, tw + 12 * P), lw = 2 * P;
      c = _cv(w, h); ctx = c.getContext('2d');
      ctx.fillStyle = s.fill; ctx.fillRect(lw / 2, lw / 2, w - lw, h - lw);
      ctx.lineWidth = lw; ctx.strokeStyle = s.line; ctx.strokeRect(lw / 2, lw / 2, w - lw, h - lw);
      _num(ctx, num, w / 2, h / 2, fs, s.text);
      return ctx.getImageData(0, 0, w, h);
    }
    // 省道 / 快速：盾形（數字在上半寬處）
    var pw = Math.max(30 * P, tw + 20 * P), ph = Math.round(pw * 1.16), pad = 2 * P;
    c = _cv(pw, ph); ctx = c.getContext('2d');
    _pick(ctx, pad, pad, pw - 2 * pad, ph - 2 * pad);
    ctx.fillStyle = s.fill; ctx.fill();
    ctx.lineWidth = 2.4 * P; ctx.strokeStyle = s.line; ctx.lineJoin = 'round'; ctx.stroke();
    if (s.dbl) {                                     // 省道：內側細藍線（雙框效果）
      _pick(ctx, pad + 3.4 * P, pad + 3 * P, pw - 2 * pad - 6.8 * P, ph - 2 * pad - 7 * P);
      ctx.lineWidth = 1 * P; ctx.strokeStyle = s.line; ctx.stroke();
    }
    _num(ctx, num, pw / 2, ph * 0.42, fs, s.text);  // 數字置上半寬處（避開下方圓尖）
    return ctx.getImageData(0, 0, pw, ph);
  }
  var _blankPx = { width: 1, height: 1, data: new Uint8Array(4) };

  function _firstVectorSource(style) {
    var s = (style && style.sources) || {};
    for (var id in s) { if (s[id] && s[id].type === 'vector') return id; }
    return null;
  }
  // 在 GL 地圖套用台灣盾牌（樣式載入後呼叫）
  function installTwShields(gl) {
    try {
      var style = gl.getStyle();
      var src = _firstVectorSource(style);
      if (!src) return false;
      // 需要的盾牌圖即時畫、即時加入（id 內含 class 與 ref）
      gl.on('styleimagemissing', function (e) {
        var id = e && e.id;
        if (!id || id.indexOf('tw|') !== 0) return;
        if (gl.hasImage && gl.hasImage(id)) return;
        var p = id.split('|');                     // tw|<class>|<ref…>
        var ref = p.slice(2).join('|');
        var type = classifyTwRoad(p[1], ref);
        var img = type ? drawTwShield(type, ref) : _blankPx;
        try { gl.addImage(id, img || _blankPx, { pixelRatio: 2 }); } catch (_) {}
      });
      // 隱藏 Liberty 內建的國際通用路牌盾（保留純街名文字層）
      (style.layers || []).forEach(function (ly) {
        if (ly.type === 'symbol' && ly['source-layer'] === 'transportation_name') {
          var lo = ly.layout || {};
          if (lo['icon-image']) { try { gl.setLayoutProperty(ly.id, 'visibility', 'none'); } catch (_) {} }
        }
      });
      // 疊上台灣盾牌層
      gl.addLayer({
        id: 'maptrip-tw-shields', type: 'symbol', source: src,
        'source-layer': 'transportation_name', minzoom: 6,
        filter: ['all', ['has', 'ref'], ['!=', ['coalesce', ['get', 'ref'], ''], '']],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 300,
          'icon-image': ['concat', 'tw|', ['coalesce', ['get', 'class'], ''], '|', ['coalesce', ['get', 'ref'], '']],
          'icon-size': 0.5, 'icon-rotation-alignment': 'viewport',
          'icon-allow-overlap': false, 'icon-padding': 2
        }
      });
      return true;
    } catch (e) { return false; }
  }
  // 診斷：取樣目前畫面載入到的道路 class/ref/network（上機校準用）
  function sampleTwRoads(gl) {
    try {
      var src = _firstVectorSource(gl.getStyle());
      if (!src) return [];
      var fs = gl.querySourceFeatures(src, { sourceLayer: 'transportation_name' }) || [];
      var seen = {}, out = [];
      fs.forEach(function (f) {
        var p = f.properties || {};
        var key = (p.class || '') + '|' + (p.ref || '');
        if (p.ref && !seen[key]) {
          seen[key] = 1;
          out.push({ cls: p.class, ref: p.ref, network: p.network, type: classifyTwRoad(p.class, p.ref) });
        }
      });
      return out;
    } catch (e) { return []; }
  }
  window.MaptripTwShields = {
    classify: classifyTwRoad, draw: drawTwShield,
    install: installTwShields, sample: sampleTwRoads
  };

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
  // Leaflet LatLngBounds 介面（回放/取景會用到；缺了會 throw "getCenter is not a function"）
  LatLngBounds.prototype.getCenter = function () {
    return { lat: (this.bbox[0][1] + this.bbox[1][1]) / 2,
             lng: (this.bbox[0][0] + this.bbox[1][0]) / 2 };
  };
  LatLngBounds.prototype.isValid = function () {
    return isFinite(this.bbox[0][0]) && isFinite(this.bbox[0][1]) &&
           isFinite(this.bbox[1][0]) && isFinite(this.bbox[1][1]);
  };

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
    // 允許雙指旋轉手勢；關掉傾斜（保持 2D）
    try {
      this.gl.dragRotate.disable();
      this.gl.touchPitch.disable();
      this.gl.keyboard.disableRotation();
    } catch (e) {}

    this.gl.on('load', function () {
      self._ready = true;
      try { installTwShields(self.gl); } catch (e) {}   // 台灣公路盾牌
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
      enable: function () { self.gl.touchZoomRotate.enable(); },
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
