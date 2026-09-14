// ===== 大眾運輸/加油站/停車場圖層（MaptripTransit）=====
// 向量（MapLibre GL）專屬：Positron 底圖很乾淨、預設不畫 POI，這裡把「開車有用」的幾類
// 從同一份 OpenMapTiles 向量圖磚（poi / aerodrome_label 圖層）挑出來疊回去，並標名稱。
//   捷運＝class=railway 且 subclass=subway → 方形 M
//   火車＝class=railway 且非 subway（穩健：未知 subclass 一律歸火車）→ 圓形火車
//   機場＝aerodrome_label ＋ poi class=aerodrome → 飛機
//   加油站＝class=fuel → 綠油槍　停車場＝class=parking → 藍 P
// 點任一個 → 呼叫 onNavigate(name, lat, lng)（接 MaptripNav 開導航選單）。
// 做法比照台灣公路盾牌（gl-compat.js installTwShields）：canvas 即時畫圖示 addImage。
(function () {
  'use strict';

  // ---- 純函式：站點分類（供測試）----
  // 回 'metro' | 'train' | null。class 非 railway → null。
  function classify(cls, subclass) {
    if (String(cls == null ? '' : cls) !== 'railway') return null;
    return String(subclass == null ? '' : subclass) === 'subway' ? 'metro' : 'train';
  }

  var NAME = ['coalesce', ['get', 'name:zh'], ['get', 'name:zh-Hant'], ['get', 'name']];
  var FONT = ['Noto Sans Regular'];
  var P = 2;

  // ---- 圖示（canvas → ImageData 供 gl.addImage）----
  function _cv(s) { var c = document.createElement('canvas'); c.width = c.height = s * P; return c; }
  function _img(c) { return c.getContext('2d').getImageData(0, 0, c.width, c.height); }
  function _rr(x, X, Y, w, h, r) {
    x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r);
    x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath();
  }
  function drawMetro() {                       // 藍底圓角方 + 白 M
    var s = 20, c = _cv(s), x = c.getContext('2d'), d = s * P, p = 2 * P;
    x.fillStyle = '#1a73e8'; _rr(x, p, p, d - 2 * p, d - 2 * p, 4 * P); x.fill();
    x.lineWidth = 1.4 * P; x.strokeStyle = '#fff'; x.stroke();
    x.fillStyle = '#fff'; x.font = 'bold ' + (12 * P) + 'px system-ui,-apple-system,Arial';
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('M', d / 2, d / 2 + 0.5 * P);
    return _img(c);
  }
  function drawTrain() {                        // 白底圓 + 藍車廂
    var s = 20, c = _cv(s), x = c.getContext('2d'), d = s * P;
    x.beginPath(); x.arc(d / 2, d / 2, d / 2 - 1.5 * P, 0, 7); x.fillStyle = '#fff'; x.fill();
    x.lineWidth = 1.4 * P; x.strokeStyle = '#1a73e8'; x.stroke();
    x.fillStyle = '#1a73e8'; var bw = 9 * P, bh = 8 * P, bx = (d - bw) / 2, by = (d - bh) / 2 - 0.5 * P;
    _rr(x, bx, by, bw, bh, 2 * P); x.fill();
    x.fillStyle = '#fff'; x.fillRect(bx + 1.4 * P, by + 1.6 * P, bw - 2.8 * P, 2.6 * P);
    x.fillStyle = '#1a73e8';
    x.beginPath(); x.arc(bx + 2.4 * P, by + bh + 1 * P, 1.3 * P, 0, 7); x.fill();
    x.beginPath(); x.arc(bx + bw - 2.4 * P, by + bh + 1 * P, 1.3 * P, 0, 7); x.fill();
    return _img(c);
  }
  function drawAirport() {                      // 紫底圓 + 白飛機
    var s = 22, c = _cv(s), x = c.getContext('2d'), d = s * P;
    x.beginPath(); x.arc(d / 2, d / 2, d / 2 - 1.5 * P, 0, 7); x.fillStyle = '#7b1fa2'; x.fill();
    x.lineWidth = 1.4 * P; x.strokeStyle = '#fff'; x.stroke();
    x.save(); x.translate(d / 2, d / 2); x.rotate(-Math.PI / 4); x.fillStyle = '#fff';
    var L = 7 * P;
    x.fillRect(-0.9 * P, -L * 0.5, 1.8 * P, L);
    x.fillRect(-L * 0.42, -1.2 * P, L * 0.84, 2.2 * P);
    x.fillRect(-L * 0.20, L * 0.30, L * 0.40, 1.6 * P);
    x.restore(); return _img(c);
  }
  function drawFuel() {                         // 綠底圓角方 + 白油槍
    var s = 20, c = _cv(s), x = c.getContext('2d'), d = s * P, p = 2 * P;
    x.fillStyle = '#188038'; _rr(x, p, p, d - 2 * p, d - 2 * p, 4 * P); x.fill();
    x.lineWidth = 1.4 * P; x.strokeStyle = '#fff'; x.stroke();
    x.fillStyle = '#fff'; _rr(x, d * 0.30, d * 0.28, d * 0.24, d * 0.44, 1.5 * P); x.fill();
    x.strokeStyle = '#fff'; x.lineWidth = 1.6 * P; x.beginPath();
    x.moveTo(d * 0.54, d * 0.40); x.lineTo(d * 0.66, d * 0.40); x.lineTo(d * 0.66, d * 0.60); x.stroke();
    return _img(c);
  }
  function drawParking() {                      // 藍底圓角方 + 白 P
    var s = 20, c = _cv(s), x = c.getContext('2d'), d = s * P, p = 2 * P;
    x.fillStyle = '#1a56b0'; _rr(x, p, p, d - 2 * p, d - 2 * p, 4 * P); x.fill();
    x.lineWidth = 1.4 * P; x.strokeStyle = '#fff'; x.stroke();
    x.fillStyle = '#fff'; x.font = 'bold ' + (12 * P) + 'px system-ui,-apple-system,Arial';
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('P', d / 2, d / 2 + 0.5 * P);
    return _img(c);
  }
  var DRAW = { metro: drawMetro, train: drawTrain, airport: drawAirport, fuel: drawFuel, parking: drawParking };

  function _firstVectorSource(gl) {
    var s = ((gl.getStyle && gl.getStyle()) || {}).sources || {};
    for (var id in s) { if (s[id] && s[id].type === 'vector') return id; }
    return 'openmaptiles';
  }

  // 圖層規格：每筆 = { id, icon, srcLayer, filter, color, minI, minL, overlap }
  function _specs(src) {
    return [
      { id: 'mt-metro', icon: 'metro', srcLayer: 'poi',
        filter: ['all', ['==', ['get', 'class'], 'railway'], ['==', ['get', 'subclass'], 'subway']],
        color: '#0b57cf', minI: 11, minL: 12.5, overlap: true },
      { id: 'mt-train', icon: 'train', srcLayer: 'poi',
        filter: ['all', ['==', ['get', 'class'], 'railway'], ['!=', ['get', 'subclass'], 'subway']],
        color: '#0b57cf', minI: 10, minL: 12, overlap: true },
      { id: 'mt-airport', icon: 'airport', srcLayer: 'aerodrome_label',
        filter: null, color: '#6a1b9a', minI: 8, minL: 9, overlap: true },
      { id: 'mt-airport2', icon: 'airport', srcLayer: 'poi',
        filter: ['==', ['get', 'class'], 'aerodrome'],
        color: '#6a1b9a', minI: 9, minL: 9, overlap: true },
      { id: 'mt-fuel', icon: 'fuel', srcLayer: 'poi',
        filter: ['==', ['get', 'class'], 'fuel'],
        color: '#127a45', minI: 14, minL: 15, overlap: false },
      { id: 'mt-parking', icon: 'parking', srcLayer: 'poi',
        filter: ['==', ['get', 'class'], 'parking'],
        color: '#0b57cf', minI: 14.5, minL: 15.5, overlap: false }
    ];
  }

  // 安裝到 GL 地圖：加圖示、加圖層、綁點擊導航。onNavigate(name, lat, lng)。
  function install(gl, onNavigate) {
    if (!gl) return false;
    var src = _firstVectorSource(gl);

    // 圖示
    Object.keys(DRAW).forEach(function (k) {
      var iid = 'mt-ic-' + k;
      try { if (!(gl.hasImage && gl.hasImage(iid))) gl.addImage(iid, DRAW[k](), { pixelRatio: P }); } catch (e) {}
    });

    _specs(src).forEach(function (sp) {
      var iconLayer = sp.id + '-icon', lblLayer = sp.id + '-lbl';
      // 圖示層
      try {
        if (!(gl.getLayer && gl.getLayer(iconLayer))) {
          var iconDef = {
            id: iconLayer, type: 'symbol', source: src, 'source-layer': sp.srcLayer, minzoom: sp.minI,
            layout: { 'icon-image': 'mt-ic-' + sp.icon, 'icon-size': 0.62, 'icon-allow-overlap': !!sp.overlap }
          };
          if (sp.filter) iconDef.filter = sp.filter;
          gl.addLayer(iconDef);
        }
      } catch (e) {}
      // 名稱層
      try {
        if (!(gl.getLayer && gl.getLayer(lblLayer))) {
          var lblDef = {
            id: lblLayer, type: 'symbol', source: src, 'source-layer': sp.srcLayer, minzoom: sp.minL,
            layout: {
              'text-field': NAME, 'text-font': FONT, 'text-size': 11.5,
              'text-offset': [0, 1.05], 'text-anchor': 'top', 'text-optional': true
            },
            paint: { 'text-color': sp.color, 'text-halo-color': '#fff', 'text-halo-width': 1.4 }
          };
          if (sp.filter) lblDef.filter = sp.filter;
          gl.addLayer(lblDef);
        }
      } catch (e) {}
      // 點擊導航（綁在圖示層）
      if (typeof onNavigate === 'function') {
        try {
          gl.on('click', iconLayer, function (e) {
            var f = (e && e.features && e.features[0]) || null;
            if (!f) return;
            var c = (f.geometry && f.geometry.coordinates) || null;   // [lng, lat]
            if (!c) return;
            var p = f.properties || {};
            var nm = p['name:zh'] || p['name:zh-Hant'] || p.name || '';
            onNavigate(nm, c[1], c[0]);
          });
        } catch (e) {}
      }
    });
    return true;
  }

  window.MaptripTransit = {
    classify: classify,
    install: install,
    draw: DRAW,            // 供測試/校準
    _specs: _specs         // 供測試（filter/minzoom 驗證）
  };
})();
