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

  // WebGL 探測：WKWebView 的 GPU 行程剛被系統砍掉時，建立 WebGL context 會失敗，
  // 屆時 maplibregl.Map 直接 throw、App 開機半途死掉（按鈕全無反應、無法開始行程）。
  // 先探測，不行就不啟用相容層 —— index.html 驗到 MAPTRIP_GL 不存在會自動走標準地圖。
  try {
    var _pc = document.createElement('canvas');
    _pc.width = _pc.height = 1;
    var _pgl = _pc.getContext('webgl2') || _pc.getContext('webgl') || _pc.getContext('experimental-webgl');
    if (!_pgl) return;
    var _lose = _pgl.getExtension('WEBGL_lose_context');   // 探測完立刻釋放 context
    if (_lose) _lose.loseContext();
  } catch (e) { return; }

  // 底圖：Positron 極簡（乾淨、藍色行程線最跳）。站點/加油站/停車場等 POI 由
  // MaptripTransit 依需求疊回（Positron 預設不畫 POI）。台灣公路盾牌照常（自建疊加層，
  // 讀同一份 transportation_name 向量資料，不依賴底圖樣式）。
  var VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/positron';
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

  // 台灣公路路標配色（依交通部圖示，顏色以官方圖逐像素量得）：
  //   國道＝綠梅花白花黑字、省道＝深藍盾白字、快速＝暗紅盾白字、縣道＝白底黑框
  var TW_COLOR = {
    national:   { plum: '#02b34d', fill: '#ffffff', text: '#111111' },
    provincial: { fill: '#022977', text: '#ffffff' },
    expressway: { fill: '#8f1d20', text: '#ffffff' },
    county:     { fill: '#ffffff', line: '#111111', text: '#111111' }
  };
  function _cv(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function _num(ctx, t, x, y, fs, color) {
    ctx.fillStyle = color;
    ctx.font = 'bold ' + fs + 'px system-ui,-apple-system,Arial,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, x, y);
  }
  // 平滑盾框（省道/快速）：頂中／左右腰／底中 四錨點連續曲線，各處切線同向 → 無折點、無鋸齒。
  function _shieldPath(ctx, cx, top, W, H) {
    var nx = function (v) { return cx + v * W; }, ny = function (v) { return top + v * H; };
    var xw = 0.48, yw = 0.32;                        // 最寬點：半寬 0.48W、位在高 0.32（偏上＝盾形）
    ctx.beginPath();
    ctx.moveTo(nx(0), ny(0.0));
    ctx.bezierCurveTo(nx(0.28), ny(0.0),   nx(xw), ny(yw - 0.22), nx(xw), ny(yw));   // 頂中→右腰
    ctx.bezierCurveTo(nx(xw),  ny(yw + 0.34), nx(0.16), ny(1.0),  nx(0),  ny(1.0));  // 右腰→底中（圓底）
    ctx.bezierCurveTo(nx(-0.16), ny(1.0), nx(-xw), ny(yw + 0.34), nx(-xw), ny(yw));  // 底中→左腰
    ctx.bezierCurveTo(nx(-xw), ny(yw - 0.22), nx(-0.28), ny(0.0), nx(0), ny(0.0));   // 左腰→頂中
    ctx.closePath();
  }
  // 梅花（5 瓣、花瓣朝上）：均勻邊框＝綠花與白花「花瓣圓心固定、半徑各減同一 erode」等距內縮。國道用。
  function _blossom(ctx, cx, cy, R, color, erode) {
    erode = erode || 0; ctx.fillStyle = color;
    var pr = R * 0.46, pd = R - pr, i, a;
    for (i = 0; i < 5; i++) {
      a = -Math.PI / 2 + i * 2 * Math.PI / 5;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * pd, cy + Math.sin(a) * pd, pr - erode, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.50 - erode, 0, 2 * Math.PI); ctx.fill();
  }
  // 產生一張路標圖（pixelRatio 2），回傳 ImageData 供 gl.addImage 用
  function drawTwShield(type, ref) {
    var col = TW_COLOR[type];
    if (!col) return null;
    var num = String(ref == null ? '' : ref).replace(/\D/g, '') || '?';
    var P = 2, fs = 16 * P, ctx, c;
    var probe = _cv(4, 4).getContext('2d');
    probe.font = 'bold ' + fs + 'px system-ui,-apple-system,Arial,sans-serif';
    var tw = Math.ceil(probe.measureText(num).width);

    if (type === 'national') {                       // 國道：綠梅花、白花、黑字、均勻框、數字置中偏下
      var S = Math.max(30 * P, tw + 18 * P);
      c = _cv(S, S); ctx = c.getContext('2d');
      var R = S / 2 * 0.94, b = R * 0.12;
      _blossom(ctx, S / 2, S / 2, R, col.plum, 0);   // 綠外框（等距內縮 → 均勻）
      _blossom(ctx, S / 2, S / 2, R, col.fill, b);   // 白內填
      _num(ctx, num, S / 2, S / 2 - R * 0.04, R * 0.82, col.text);
      return ctx.getImageData(0, 0, S, S);
    }
    if (type === 'county') {                          // 縣道：白底黑框圓角方
      var h = 26 * P, w = Math.max(h, tw + 12 * P), r = 6 * P, lw = 2 * P;
      c = _cv(w, h); ctx = c.getContext('2d');
      var x0 = lw / 2, y0 = lw / 2, rw = w - lw, rh = h - lw;
      ctx.beginPath();
      ctx.moveTo(x0 + r, y0); ctx.arcTo(x0 + rw, y0, x0 + rw, y0 + rh, r);
      ctx.arcTo(x0 + rw, y0 + rh, x0, y0 + rh, r); ctx.arcTo(x0, y0 + rh, x0, y0, r);
      ctx.arcTo(x0, y0, x0 + rw, y0, r); ctx.closePath();
      ctx.fillStyle = col.fill; ctx.fill();
      ctx.lineWidth = lw; ctx.strokeStyle = col.line; ctx.stroke();
      _num(ctx, num, w / 2, h / 2, 15 * P, col.text);
      return ctx.getImageData(0, 0, w, h);
    }
    // 省道 / 快速：平滑盾＋白內框、數字往下放大
    var W = Math.max(30 * P, tw + 16 * P), H = Math.round(W * 1.02), pad = 2 * P;
    var cw = W + pad * 2, chh = H + pad * 2, cx = cw / 2, top = pad;
    c = _cv(cw, chh); ctx = c.getContext('2d');
    _shieldPath(ctx, cx, top, W, H); ctx.fillStyle = col.fill; ctx.fill();
    var cy = top + H * 0.45;                          // 白內框＝整體縮 0.85 疊白線（維持平滑）
    ctx.save(); ctx.translate(cx, cy); ctx.scale(0.85, 0.85); ctx.translate(-cx, -cy);
    _shieldPath(ctx, cx, top, W, H); ctx.lineWidth = Math.max(1.6, W * 0.03) / 0.85; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.restore();
    _num(ctx, num, cx, top + H * 0.45, H * 0.44, col.text);
    return ctx.getImageData(0, 0, cw, chh);
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
  // 記憶體瘦身：3D 建築（fill-extrusion）純裝飾卻吃大量 GPU/記憶體，
  // 開車記錄用不到；WKWebView 記憶體超標會整頁被 iOS 砍掉 → 全部隱藏。
  function trimStyleMemory(gl) {
    try {
      ((gl.getStyle() || {}).layers || []).forEach(function (ly) {
        if (ly.type === 'fill-extrusion') {
          try { gl.setLayoutProperty(ly.id, 'visibility', 'none'); } catch (_) {}
        }
      });
    } catch (e) {}
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
  Marker.prototype.setOpacity = function (v) {
    // MapLibre 每次 render 會重寫 marker 元素的 style.opacity（淡入/遮蔽管理），
    // 用 opacity 隱藏會在下一幀被蓋回可見（「歷史行程裡今日的點又出現」的元兇）
    // → 隱藏（0）一律改用 display，MapLibre 不會動它
    if (+v === 0) { this._el.style.display = 'none'; }
    else { this._el.style.display = ''; this._el.style.opacity = String(v); }
    return this;
  };
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

    try {
      this.gl = new maplibregl.Map({
        container: containerId,
        style: VECTOR_STYLE,
        center: [121.565, 25.033],
        zoom: 14,
        attributionControl: false,
        pitchWithRotate: false,
        maxZoom: 20,
        // 記憶體控管：WKWebView 記憶體超標會整頁被系統砍掉重載（≈30 秒一次的重整迴圈）。
        // 3x 螢幕的畫布記憶體是 2x 的 2.25 倍 → 上限 2x；磁磚快取也設上限。
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        maxTileCacheSize: 24,   // 再縮圖磚快取：省記憶體優先（回看舊區域多花一點網路）
        fadeDuration: 150,
        // 中日韓文字用「裝置系統字型」就地繪製（不下載 CJK glyph）：
        // iOS = PingFang、Android = Noto Sans CJK，和 App 內部 system-ui 一致。
        // 英數仍走樣式內建 SDF 字型（Noto Sans，接近系統無襯線）。
        localIdeographFontFamily: '-apple-system, "PingFang TC", "PingFang SC", "Heiti TC", "Microsoft JhengHei", system-ui, sans-serif'
      });
    } catch (e) {
      // 地圖引擎建立失敗（WebGL context 偶發建不起來等）→ 記下失敗、防迴圈重載；
      // 重載後 3 小時內走標準地圖並提示原因，App 不會半死
      try {
        localStorage.setItem('mt_glfail', String(Date.now()));
        localStorage.setItem('mt_glfail_reason', 'jsfail');
        localStorage.setItem('mt_glerr', String((e && e.stack) || e).slice(0, 300));
      } catch (_e) {}
      (window.__mtSafeReload || location.reload.bind(location))();
      throw e;   // 讓 app.js 的開機守門員停止本次啟動（頁面即將重載）
    }
    // GPU 行程被系統砍掉（背景跑導航 App 時常見）→ WebGL context 遺失、地圖凍結。
    // MapLibre 會嘗試自動復原；5 秒內沒復原就防迴圈重載一次，回來就是全新 context。
    try {
      var _cv = this.gl.getCanvas();
      var _lostTimer = null;
      _cv.addEventListener('webglcontextlost', function () {
        clearTimeout(_lostTimer);
        _lostTimer = setTimeout(function () {
          (window.__mtSafeReload || location.reload.bind(location))();
        }, 5000);
      });
      _cv.addEventListener('webglcontextrestored', function () { clearTimeout(_lostTimer); });
    } catch (e) {}
    // 允許雙指旋轉手勢；關掉傾斜（保持 2D）
    try {
      this.gl.dragRotate.disable();
      this.gl.touchPitch.disable();
      this.gl.keyboard.disableRotation();
    } catch (e) {}

    this.gl.on('load', function () {
      self._ready = true;
      // 成功載入 → 清掉「最近失敗」與「重載計數」，回到健康狀態
      try { localStorage.removeItem('mt_glfail'); localStorage.removeItem('mt_rl'); } catch (e) {}
      try { installTwShields(self.gl); } catch (e) {}   // 台灣公路盾牌
      try { if (window.MaptripTransit) MaptripTransit.install(self.gl, window.MaptripNav && MaptripNav.open); } catch (e) {}  // 車站/機場/加油站/停車場 + 點擊導航
      trimStyleMemory(self.gl);                          // 隱藏 3D 建築省記憶體
      var q = self._queue; self._queue = [];
      q.forEach(function (fn) { try { fn(); } catch (e) {} });
    });
    // 向量樣式載入失敗 → 自動切回標準（Leaflet）引擎，App 不會卡白畫面。
    // 重要：任何一片圖磚/字型在行動網路上暫時失敗都會觸發 error 事件，
    // 而 load 事件可能被個別資源拖住 —— 不能只憑「有 error 且 load 未發」就重載，
    // 否則地圖明明可用卻每 ~30 秒重載一次（20s 看門狗 + 開機時間）。
    var hadError = false;
    this.gl.on('error', function () { hadError = true; });
    var readyFallback = function () {
      // 樣式其實已可用（load 被個別資源拖住）→ 直接視為就緒，絕不重載
      if (self._ready) return true;
      var styleOk = false;
      try { styleOk = self.gl.isStyleLoaded(); } catch (e) {}
      if (!styleOk) return false;
      self._ready = true;
      try { localStorage.removeItem('mt_glfail'); localStorage.removeItem('mt_rl'); } catch (e) {}
      try { installTwShields(self.gl); } catch (e) {}
      try { if (window.MaptripTransit) MaptripTransit.install(self.gl, window.MaptripNav && MaptripNav.open); } catch (e) {}
      trimStyleMemory(self.gl);
      var q = self._queue; self._queue = [];
      q.forEach(function (fn) { try { fn(); } catch (e) {} });
      return true;
    };
    setTimeout(function () {
      if (readyFallback()) return;          // 20 秒：樣式可用就放行
      setTimeout(function () {
        if (readyFallback()) return;        // 40 秒：再給一次機會
        if (hadError) {
          // 真的載不起來 → 記下失敗（3 小時走標準地圖）＋原因，用防迴圈重載
          try {
            localStorage.setItem('mt_glfail', String(Date.now()));
            localStorage.setItem('mt_glfail_reason', 'loadfail');
          } catch (e) {}
          (window.__mtSafeReload || location.reload.bind(location))();
        }
      }, 20000);
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
  // 對外維持 Leaflet 慣例 {lat,lng}（找附近以「地圖中心」為準時會用到）
  GlMap.prototype.getCenter = function () {
    var c = this.gl.getCenter();
    return { lat: c.lat, lng: c.lng };
  };
  GlMap.prototype.getZoom = function () { return this.gl.getZoom() + 1; };   // GL zoom → Leaflet zoom
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
