// hotspots.js — 「找客熱區」：搜尋當前位置 2 公里內、人潮／叫車機會較高的區域。
//
// 【為什麼不是串 Google 即時人潮】
//   Google 地圖上的「熱門時段（Popular Times）」從未開放任何官方 API，只能靠違反
//   服務條款、隨時會壞的非官方爬蟲——在 WKWebView 遠端網頁裡不可能穩定跑。
//   所以本功能改用兩個免費、免金鑰、可穩定運作的訊號來估「哪裡人多、哪裡好叫車」：
//     A. OpenStreetMap（Overpass API）2km 內「會聚人的場所」：車站/捷運、百貨、夜市、
//        醫院、飯店、大學、景點、夜生活、廟宇……依類型加權，再乘「時段權重」。
//     B. 司機自己的歷史上車點（每趟 coords[0]）：過去實際在哪接到客＝最直接的證據，
//        近期、同時段的權重更高。
//   兩者用 350m 網格聚合成「熱區」，排名後在地圖標點＋底部清單呈現方位與距離。
//
// 依賴 app.js 的全域：window.__mtLive（即時 pos/map）、haversine、toast、loadTrips、L。
(function () {
  'use strict';

  var RADIUS = 2000;          // 搜尋半徑（公尺）
  var CELL   = 350;           // 聚合網格邊長（公尺）
  var TOP_N  = 6;             // 顯示前幾名熱區
  var MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  var markers = [];           // 目前地圖上的熱區標記
  var ring = null;            // 2km 範圍圈
  var busy = false;

  // 時段（與 finance.js 一致）：一天切 8 段，深夜跨午夜。用來即時篩「當前時段」的歷史上車點。
  var BUCKETS = [
    { label: '清晨', s: 5, e: 7 }, { label: '早尖峰', s: 7, e: 9 }, { label: '上午', s: 9, e: 11 },
    { label: '中午', s: 11, e: 14 }, { label: '下午', s: 14, e: 17 }, { label: '晚尖峰', s: 17, e: 19 },
    { label: '晚間', s: 19, e: 22 }, { label: '深夜', s: 22, e: 5 }
  ];
  function bucketOf(h) {
    for (var i = 0; i < BUCKETS.length; i++) {
      var b = BUCKETS[i];
      if (b.s < b.e) { if (h >= b.s && h < b.e) return i; }
      else { if (h >= b.s || h < b.e) return i; }
    }
    return -1;
  }
  function bucketRange(bi) { var b = BUCKETS[bi]; return b ? (b.s + '–' + b.e + ' 點') : ''; }

  // ---- 星期幾 / 國定假日加權（研究：day-of-week 為需求預測前三大特徵）----
  // 假日的需求型態≈週末休閒（無通勤尖峰、景點/夜生活上升），故把「國定假日」視同「休息日」。
  // 表僅 2026（民國115年，人事行政總處辦公日曆表；2026 起只補假不補班）——**每年需更新**。
  var HOLIDAYS = {
    2026: new Set([
      '2026-01-01',                                                                                         // 元旦
      '2026-02-14','2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22', // 春節 9 連假
      '2026-02-28','2026-03-02',                                                                            // 和平紀念日＋補假
      '2026-04-04','2026-04-05','2026-04-06',                                                               // 兒童節/清明＋補假
      '2026-05-01','2026-05-02','2026-05-03',                                                               // 勞動節 3 連假
      '2026-06-19','2026-06-20','2026-06-21',                                                               // 端午 3 連假
      '2026-09-25','2026-09-26','2026-09-27','2026-09-28',                                                  // 中秋＋教師節 4 連假
      '2026-10-10','2026-10-11','2026-10-12',                                                               // 國慶＋補假
      '2026-10-25','2026-10-26',                                                                            // 光復節＋補假
      '2026-12-25'                                                                                          // 行憲紀念日
    ])
  };
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function isOffDay(d) { var wd = d.getDay(); if (wd === 0 || wd === 6) return true; var s = HOLIDAYS[d.getFullYear()]; return !!(s && s.has(ymd(d))); }
  function dayInfo(d) { return { off: isOffDay(d), wd: d.getDay() }; }
  // 上車時間 ts 相對「今天」的星期權重：同一星期幾 ×1.4、同日型（都休或都上班）×1.0、日型不同 ×0.65
  function dayFactor(ts, today) {
    var d = new Date(ts), off = isOffDay(d);
    if (off === today.off) return d.getDay() === today.wd ? 1.4 : 1.0;
    return 0.65;
  }

  function pos()  { return window.__mtLive && window.__mtLive.pos; }
  function gmap() { return window.__mtLive && window.__mtLive.map; }
  function say(m) { if (window.toast) window.toast(m); }
  function H(a, b) {
    if (window.haversine) return window.haversine(a, b);
    var R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  // 類型：base=基礎權重、label=中文、tod(h)=時段乘數（h 為 0-23 小時）
  var CATS = {
    transit:  { label: '交通樞紐（車站/捷運）', base: 10, tod: function (h) { return (h >= 7 && h < 9) || (h >= 17 && h < 19) ? 1.4 : (h >= 6 && h < 23 ? 1.1 : 0.8); } },
    hospital: { label: '醫院',                   base: 7,  tod: function (h) { return (h >= 7 && h < 12) ? 1.35 : (h >= 12 && h < 17 ? 1.0 : 0.6); } },
    mall:     { label: '百貨／商場',             base: 8,  tod: function (h) { return (h >= 11 && h < 22) ? 1.3 : 0.6; } },
    market:   { label: '市場／夜市',             base: 8,  tod: function (h) { return (h >= 16 && h <= 23) ? 1.5 : (h >= 0 && h < 2 ? 0.9 : 0.5); } },
    hotel:    { label: '飯店／旅館',             base: 6,  tod: function (h) { return (h >= 6 && h < 10) || (h >= 21 && h <= 23) ? 1.2 : 1.0; } },
    uni:      { label: '大學／學院',             base: 5,  tod: function (h) { return (h >= 7 && h < 10) || (h >= 16 && h < 20) ? 1.3 : 1.0; } },
    cinema:   { label: '電影院／劇院',           base: 5,  tod: function (h) { return (h >= 13 && h <= 23) ? 1.3 : 0.8; } },
    attract:  { label: '景點',                   base: 4,  tod: function (h) { return (h >= 9 && h < 18) ? 1.2 : 0.8; } },
    night:    { label: '夜生活（酒吧/夜店）',    base: 5,  tod: function (h) { return (h >= 20 && h <= 23) ? 1.6 : (h >= 0 && h < 3 ? 1.4 : 0.4); } },
    worship:  { label: '廟宇／宗教場所',         base: 3,  tod: function (h) { return (h >= 6 && h < 11) ? 1.15 : 1.0; } },
    history:  { label: '你常上車的熱點',         base: 6,  tod: function () { return 1; } }
  };

  // OSM 標籤 → 類型
  function classify(t) {
    if (!t) return null;
    if (t.railway === 'station' || t.station === 'subway' || t.amenity === 'bus_station' ||
        t.public_transport === 'station') return 'transit';
    if (t.amenity === 'hospital') return 'hospital';
    if (t.shop === 'mall' || t.shop === 'department_store') return 'mall';
    if (t.amenity === 'marketplace') return 'market';
    if (t.tourism === 'hotel') return 'hotel';
    if (t.amenity === 'university' || t.amenity === 'college') return 'uni';
    if (t.amenity === 'cinema' || t.amenity === 'theatre') return 'cinema';
    if (t.tourism === 'attraction' || t.tourism === 'museum' || t.tourism === 'theme_park') return 'attract';
    if (t.amenity === 'nightclub' || t.amenity === 'bar' || t.amenity === 'pub') return 'night';
    if (t.amenity === 'place_of_worship') return 'worship';
    return null;
  }

  function overpassQuery(la, ln) {
    var r = RADIUS, c = 'around:' + r + ',' + la.toFixed(6) + ',' + ln.toFixed(6);
    return '[out:json][timeout:25];(' +
      'node(' + c + ')[railway=station];' +
      'node(' + c + ')[station=subway];' +
      'node(' + c + ')[amenity=bus_station];' +
      'nwr(' + c + ')[amenity=hospital];' +
      'nwr(' + c + ')[shop=mall];' +
      'nwr(' + c + ')[shop=department_store];' +
      'nwr(' + c + ')[amenity=marketplace];' +
      'nwr(' + c + ')[tourism=hotel];' +
      'nwr(' + c + ')[amenity=university];' +
      'nwr(' + c + ')[amenity=college];' +
      'nwr(' + c + ')[amenity=cinema];' +
      'nwr(' + c + ')[amenity=theatre];' +
      'nwr(' + c + ')[tourism=attraction];' +
      'nwr(' + c + ')[tourism=museum];' +
      'node(' + c + ')[amenity=nightclub];' +
      'node(' + c + ')[amenity=bar];' +
      'node(' + c + ')[amenity=pub];' +
      'nwr(' + c + ')[amenity=place_of_worship];' +
      ');out center tags 200;';
  }

  // 抓 Overpass（依序試鏡像；20 秒逾時；失敗回 null）
  function fetchOverpass(la, ln) {
    var body = 'data=' + encodeURIComponent(overpassQuery(la, ln));
    function tryAt(i) {
      if (i >= MIRRORS.length) return Promise.resolve(null);
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
      var opt = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body };
      if (ctrl) opt.signal = ctrl.signal;
      return fetch(MIRRORS[i], opt).then(function (r) {
        clearTimeout(timer);
        if (!r || !r.ok) throw new Error('http ' + (r && r.status));
        return r.json();
      }).catch(function () { clearTimeout(timer); return tryAt(i + 1); });
    }
    return tryAt(0);
  }

  // 歷史上車點（每趟 coords[0]），附發生時間供近期/同時段加權
  function historyPickups() {
    var out = [], raw = (window.loadTrips ? window.loadTrips() : {}) || {};
    Object.keys(raw).forEach(function (day) {
      (raw[day] || []).forEach(function (tr) {
        var c = tr && tr.coords && tr.coords[0];
        if (c && typeof c.lat === 'number' && typeof c.lng === 'number') {
          out.push({ lat: c.lat, lng: c.lng, t: tr.startTime || 0 });
        }
      });
    });
    return out;
  }

  // 即時：只看「當前時段」＋「附近 2km」的歷史上車點，就地聚類排名（免等網路）。
  // 這是使用者要的「更即時」：直接讀當下位置與時間，秀出這個時段你都在哪裡上車。
  function cellOf(origin, p) {
    var xy = toXY(origin, p);
    return Math.floor(xy.x / CELL) + '_' + Math.floor(xy.y / CELL);
  }
  function buildHistoryNow(me) {
    var nowT = new Date(), bi = bucketOf(nowT.getHours());
    var nowH = nowT.getHours() + nowT.getMinutes() / 60, today = dayInfo(nowT);
    var now = Date.now(), DAY = 86400000, cells = {};
    historyPickups().forEach(function (hp) {
      if (!hp.t) return;
      var p = { lat: hp.lat, lng: hp.lng };
      if (H(me, p) > RADIUS) return;
      // 軟時段窗（±2h，1h 內滿權）取代硬分桶：不再「差幾分鐘就整筆漏掉」（8:59 vs 9:01）
      var pd = new Date(hp.t), ph = pd.getHours() + pd.getMinutes() / 60;
      var hd = Math.abs(ph - nowH); hd = Math.min(hd, 24 - hd);
      var tw = hd <= 1 ? 1.0 : (hd <= 2 ? 0.6 : 0);
      if (tw === 0) return;
      var age = (now - hp.t) / DAY;
      var rf = age <= 30 ? 1.5 : (age <= 90 ? 1.0 : 0.6);        // 近期權重高
      var w = rf * tw * dayFactor(hp.t, today);                  // 近期 × 時段 × 星期幾/假日
      var k = cellOf(me, p);
      var c = cells[k] || (cells[k] = { n: 0, score: 0, wlat: 0, wlng: 0, wsum: 0 });
      c.n++; c.score += w; c.wlat += p.lat * w; c.wlng += p.lng * w; c.wsum += w;
    });
    // 最少趟數門檻：優先只留 ≥2 趟的格（去單筆雜訊）；若全都是單筆才放寬到 1（免退回網路）
    var keys = Object.keys(cells);
    var solid = keys.filter(function (k) { return cells[k].n >= 2; });
    var use = solid.length ? solid : keys;
    var list = use.map(function (k) {
      var c = cells[k], center = { lat: c.wlat / c.wsum, lng: c.wlng / c.wsum };
      return {
        center: center, score: c.score, count: c.n, cats: { history: c.score },
        dist: H(me, center), brg: bearing(me, center), reasons: ['你常上車的熱點'], histLed: true
      };
    });
    list.sort(function (a, b) { return b.score - a.score; });
    return { bucket: bi, zones: list.slice(0, TOP_N) };
  }

  // 經緯度 → 相對 origin 的公尺座標（等距近似）
  function toXY(origin, p) {
    var mPerDeg = 111320;
    return {
      x: (p.lng - origin.lng) * mPerDeg * Math.cos(origin.lat * Math.PI / 180),
      y: (p.lat - origin.lat) * mPerDeg
    };
  }

  function bearing(a, b) {
    var y = Math.sin((b.lng - a.lng) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
    var x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) -
      Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lng - a.lng) * Math.PI / 180);
    var d = Math.atan2(y, x) * 180 / Math.PI;
    return (d + 360) % 360;
  }
  var COMPASS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
  function compass(deg) { return COMPASS[Math.round(deg / 45) % 8]; }

  // 主流程：把 POI 與歷史點丟進 350m 網格聚合、計分、排名
  function build(elements, me) {
    var hour = new Date().getHours();
    var cells = {};            // key -> cluster
    function cellOf(p) {
      var xy = toXY(me, p);
      return Math.floor(xy.x / CELL) + '_' + Math.floor(xy.y / CELL);
    }
    function bucket(p) {
      var k = cellOf(p);
      if (!cells[k]) cells[k] = { score: 0, cats: {}, wlat: 0, wlng: 0, wsum: 0 };
      return cells[k];
    }
    function add(p, key, w) {
      if (w <= 0) return;
      var c = bucket(p);
      c.score += w;
      c.cats[key] = (c.cats[key] || 0) + w;
      c.wlat += p.lat * w; c.wlng += p.lng * w; c.wsum += w;
    }

    // A. OSM 場所
    (elements || []).forEach(function (el) {
      var la = (el.lat != null) ? el.lat : (el.center && el.center.lat);
      var ln = (el.lon != null) ? el.lon : (el.center && el.center.lon);
      if (la == null || ln == null) return;
      var p = { lat: la, lng: ln };
      if (H(me, p) > RADIUS) return;
      var key = classify(el.tags);
      if (!key) return;
      var cat = CATS[key];
      add(p, key, cat.base * cat.tod(hour));
    });

    // B. 歷史上車點（近 30 天 ×1.5、30-90 天 ×1.0、更久 ×0.6；同時段±2h ×1.5；
    //    同星期幾/同日型加權；每格上限 30）
    var now = Date.now(), DAY = 86400000, today = dayInfo(new Date());
    historyPickups().forEach(function (h) {
      var p = { lat: h.lat, lng: h.lng };
      if (H(me, p) > RADIUS) return;
      var age = (now - h.t) / DAY;
      var rf = age <= 30 ? 1.5 : (age <= 90 ? 1.0 : 0.6);
      var todM = 1.0;
      if (h.t) { var dh = Math.abs(new Date(h.t).getHours() - hour); if (Math.min(dh, 24 - dh) <= 2) todM = 1.5; }
      var dayM = h.t ? dayFactor(h.t, today) : 1;
      var c = bucket(p);
      var cur = c.cats.history || 0, addW = CATS.history.base * rf * todM * dayM;
      if (cur + addW > 30) addW = Math.max(0, 30 - cur);
      add(p, 'history', addW);
    });

    // 整理成陣列，算中心、距離、方位、理由
    var list = Object.keys(cells).map(function (k) {
      var c = cells[k];
      var center = { lat: c.wlat / c.wsum, lng: c.wlng / c.wsum };
      var top = Object.keys(c.cats).sort(function (a, b) { return c.cats[b] - c.cats[a]; });
      return {
        center: center, score: c.score, cats: c.cats,
        dist: H(me, center), brg: bearing(me, center),
        reasons: top.slice(0, 2).map(function (key) { return CATS[key].label; }),
        histLed: top[0] === 'history'
      };
    }).filter(function (z) { return z.score > 0; });

    list.sort(function (a, b) { return b.score - a.score; });
    return list.slice(0, TOP_N);
  }

  // ---- 地圖標記 ----
  function clearMap() {
    var m = gmap();
    markers.forEach(function (mk) { try { m.removeLayer(mk); } catch (_) {} });
    markers = [];
    if (ring) { try { m.removeLayer(ring); } catch (_) {} ring = null; }
  }
  var RANKC = ['#d93025', '#e8710a', '#f9ab00', '#1a73e8', '#1a73e8', '#1a73e8'];
  function drawMap(zones, me) {
    var m = gmap();
    if (!m || !window.L) return;
    clearMap();
    try {
      ring = L.circle([me.lat, me.lng], { radius: RADIUS, color: '#1a73e8', weight: 1, opacity: 0.5,
        fill: true, fillColor: '#1a73e8', fillOpacity: 0.04, interactive: false });
      ring.addTo(m);
    } catch (_) {}
    zones.forEach(function (z, i) {
      try {
        var col = RANKC[i] || '#1a73e8';
        var html = '<div class="hs-pin" style="background:' + col + '">' + (i + 1) + '</div>';
        var icon = L.divIcon({ className: 'hs-pin-wrap', html: html, iconSize: [30, 30], iconAnchor: [15, 15] });
        var mk = L.marker([z.center.lat, z.center.lng], { icon: icon });
        mk.addTo(m);
        // 綁點擊：標準 Leaflet 有 marker.on；向量相容層（gl-compat）的 Marker 沒有 .on，
        // 改用 DOM 元素監聽（否則向量模式會丟 TypeError，整個 drawMap 崩潰）。
        (function (idx) {
          if (typeof mk.on === 'function') { mk.on('click', function () { focusZone(idx); }); }
          else if (mk.getElement) { var el = mk.getElement(); if (el) el.addEventListener('click', function () { focusZone(idx); }); }
        })(i);
        markers.push(mk);
      } catch (_) {}
    });
  }

  function fireIcons(score, max) {
    var n = Math.max(1, Math.min(5, Math.round(score / (max || 1) * 5)));
    var s = ''; for (var i = 0; i < n; i++) s += '🔥'; return s;
  }

  // ---- 底部清單面板 ----
  var lastZones = [];
  function renderPanel(zones, me, meta) {
    meta = meta || {};
    var histMode = meta.mode === 'history';
    lastZones = zones;
    var panel = document.getElementById('hs-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'hs-panel';
      document.body.appendChild(panel);
    }
    if (!zones.length) {
      panel.innerHTML = '<div class="hs-head"><span>🔥 找客熱區</span>' +
        '<button class="hs-close" onclick="MaptripHotspots.close()">✕</button></div>' +
        '<div class="hs-empty">附近 2 公里內找不到明顯的人潮熱點。<br>可能是資料較少的區域，換個位置再試試。</div>';
      panel.style.display = 'block';
      return;
    }
    var max = zones[0].score;
    var rows = zones.map(function (z, i) {
      var km = z.dist >= 1000 ? (z.dist / 1000).toFixed(1) + ' km' : Math.round(z.dist) + ' m';
      var arrow = '<span class="hs-arrow" style="transform:rotate(' + z.brg + 'deg)">↑</span>';
      var name = z.histLed ? '你常上車的熱點' : z.reasons[0];
      var sub = (histMode && z.count) ? (z.count + ' 趟 · 這個時段常上車') : z.reasons.join('、');
      return '<div class="hs-row" onclick="MaptripHotspots.focus(' + i + ')">' +
        '<div class="hs-rank" style="background:' + (RANKC[i] || '#1a73e8') + '">' + (i + 1) + '</div>' +
        '<div class="hs-dir">' + arrow + '<span>' + compass(z.brg) + '</span></div>' +
        '<div class="hs-main"><div class="hs-name">' + name + '</div>' +
        '<div class="hs-sub">' + sub + '</div></div>' +
        '<div class="hs-meta"><div class="hs-fire">' + fireIcons(z.score, max) + '</div>' +
        '<div class="hs-dist">' + km + '</div></div></div>';
    }).join('');
    var title = histMode
      ? '🔥 找客熱區 · 現在【' + (BUCKETS[meta.bucket] ? BUCKETS[meta.bucket].label : '此時段') + '】'
      : '🔥 找客熱區（2 公里內）';
    var note = histMode
      ? '你在附近 2km、這個時段的歷史上車點（同星期幾/假日加權，越上面越常上車）'
      : '依「會聚人的場所＋你的歷史上車點＋現在時段/星期」估算，越上面越有機會';
    panel.innerHTML = '<div class="hs-head"><span>' + title + '</span>' +
      '<button class="hs-close" onclick="MaptripHotspots.close()">✕</button></div>' +
      '<div class="hs-note">' + note + '</div>' +
      '<div class="hs-list">' + rows + '</div>';
    panel.style.display = 'block';
  }

  function focusZone(i) {
    var z = lastZones[i], m = gmap();
    if (!z || !m) return;
    try { m.setView([z.center.lat, z.center.lng], 16, { animate: true }); } catch (_) {
      m.panTo([z.center.lat, z.center.lng]);
    }
  }

  function setBusy(b) {
    busy = b;
    var btn = document.getElementById('hotspot-btn');
    if (btn) btn.classList.toggle('loading', b);
  }

  function run() {
    if (busy) return;
    var me = pos();
    if (!me) { say('等待 GPS 訊號中…'); return; }

    // 1) 即時：先用「當前時段的歷史上車點」秒出（不等網路），這才是使用者要的即時感
    var hn = buildHistoryNow(me);
    if (hn.zones.length) {
      drawMap(hn.zones, me);
      renderPanel(hn.zones, me, { mode: 'history', bucket: hn.bucket });
      say('現在【' + (BUCKETS[hn.bucket] ? BUCKETS[hn.bucket].label : '此時段') + '】· 你這個時段的上車熱點');
      return;
    }

    // 2) 這個時段還沒有歷史 → 退回附近場所（Overpass）估算
    setBusy(true);
    say('這個時段還沒有歷史，改用附近場所估算…');
    fetchOverpass(me.lat, me.lng).then(function (data) {
      var els = (data && data.elements) || null;
      var zones = build(els || [], me);
      setBusy(false);
      if (!els && !zones.length) { say('地圖服務暫時無法連線，稍後再試'); renderPanel([], me, { mode: 'poi' }); return; }
      if (!els) say('地圖服務忙線，先用你的歷史紀錄估算');
      drawMap(zones, me);
      renderPanel(zones, me, { mode: 'poi' });
    }).catch(function () {
      setBusy(false);
      var zones = build([], me);      // 最後防線：只用歷史
      drawMap(zones, me);
      renderPanel(zones, me, { mode: 'poi' });
      say(zones.length ? '用你的歷史紀錄估算' : '搜尋失敗，稍後再試');
    });
  }

  function close() {
    var panel = document.getElementById('hs-panel');
    if (panel) panel.style.display = 'none';
    clearMap();
  }

  window.MaptripHotspots = { run: run, close: close, focus: focusZone,
    _buildHistoryNow: buildHistoryNow, _bucketOf: bucketOf, _isOffDay: isOffDay, _dayFactor: dayFactor };
  window.openHotspots = run;
})();
