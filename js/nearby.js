// nearby.js — 「找附近的 X」：搜尋當前位置附近的加油站／停車場／便利商店。
// 地圖優先：結果直接以「①②③…（依直線距離近→遠）」編號釘標在地圖上，
// 點釘子即跳導航選單（MaptripNav，Google／Apple 開車導航）。不再用底部清單。
// 便利商店會備註有無廁所（OSM toilets 標籤）：有廁所的釘子加 🚻，導航選單也註明。
//
// 資料來源：OpenStreetMap Overpass API，免費免金鑰，與地圖 POI 同源。
// 「最近」用直線距離快速判定；實際開車路徑由 Google／Apple 導航計算（driving 模式）。
// 依賴：window.__mtLive.pos / .map（即時定位/地圖）、window.toast、window.MaptripNav.open、window.L。
(function () {
  'use strict';

  var RADIUS = 3000;          // 搜尋半徑（公尺）：3km 對加油/停車/超商已足夠，且查詢更快
  var TOP_N  = 12;            // 最多標幾家（放寬，避免密集區把附近的擠掉）
  var MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  // 便利商店品牌後備：OSM 常有把 7-11/全家…只給 name 沒給 shop=convenience 的情況，
  // 用「有 shop 標籤＋名稱吻合連鎖」補抓（避免只靠 shop=convenience 漏掉）。
  var STORE_BRAND = '7-ELEVEN|7-11|統一超商|small mart|全家|FamilyMart|Family Mart|萊爾富|Hi-Life|OK超商|OK mart|OK・mart|來來';
  // 便利商店排除：蝦皮店到店等「純寄取貨點」在 OSM 常被標 shop=convenience，但不是便利商店 → 濾掉。
  var STORE_EXCLUDE = '蝦皮|Shopee|店到店|賣貨便|蝦皮購物';
  // 類別設定：Overpass 選擇器（可多個做 union）、標題、圖示、釘子色、空結果文案、預設名稱、是否備註廁所
  var CATS = {
    fuel:    { sels: ['amenity=fuel'],
               title: '附近加油站',   icon: '⛽', accent: '#188038', empty: '附近 3 公里內找不到加油站',   dft: '加油站',   short: '加油站' },
    parking: { sels: ['amenity=parking'],
               title: '附近停車場',   icon: '🅿️', accent: '#1a56b0', empty: '附近 3 公里內找不到停車場',   dft: '停車場',   short: '停車場' },
    store:   { sels: ['shop=convenience', 'shop][name~"' + STORE_BRAND + '",i'], exclude: STORE_EXCLUDE,
               title: '附近便利商店', icon: '🏪', accent: '#e8710a', empty: '附近 3 公里內找不到便利商店', dft: '便利商店', short: '便利商店', wc: true }
  };

  function pos()  { return window.__mtLive && window.__mtLive.pos; }
  function gmap() { return window.__mtLive && window.__mtLive.map; }
  function say(m) { if (window.toast) window.toast(m); }
  function setBusy(b) { var el = document.getElementById('hotspot-btn'); if (el) el.classList.toggle('loading', !!b); }

  // ---- 純函式（供測試）----
  function _haversine(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var la1 = a.lat * toR, la2 = b.lat * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function _fmtDist(m) {
    if (m < 950) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 9500 ? 1 : 0) + ' km';
  }
  function _name(tags, dft) {
    tags = tags || {};
    return tags['name:zh'] || tags.name || tags.brand || tags.operator || dft || '地點';
  }
  // 廁所：OSM toilets / toilets:access → 'yes' | 'no' | ''（未標示）
  function _toilet(tags) {
    tags = tags || {};
    var t = tags.toilets || tags['toilets:access'];
    if (t === 'yes' || t === 'customers' || t === 'public') return 'yes';
    if (t === 'no' || t === 'none') return 'no';
    return '';
  }
  // centers＝一或多個搜尋中心（地圖中心＋GPS），sels＝一或多個 Overpass 選擇器；
  // 全部做 union，一次抓齊（涵蓋「地圖看的點」與「我人在的點」兩處附近）。
  function _overpassBody(centers, sels) {
    if (!Array.isArray(centers)) centers = [centers];
    if (!Array.isArray(sels)) sels = [sels];
    var parts = [];
    centers.forEach(function (c) {
      if (!c || c.lat == null || c.lng == null) return;
      sels.forEach(function (sel) {
        parts.push('nwr(around:' + RADIUS + ',' + c.lat + ',' + c.lng + ')[' + sel + '];');
      });
    });
    var q = '[out:json][timeout:25];(' + parts.join('') + ');out center 120;';
    return 'data=' + encodeURIComponent(q);
  }
  function _parse(elements, me, dft, wantWc, exclude) {
    var out = [], seen = {};
    var exRe = exclude ? new RegExp(exclude, 'i') : null;
    (elements || []).forEach(function (e) {
      var lat = (e.lat != null) ? e.lat : (e.center && e.center.lat);
      var lng = (e.lon != null) ? e.lon : (e.center && e.center.lon);
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      // 排除清單：蝦皮店到店等純寄取貨點（名稱/品牌/營運者任一命中就丟）
      var tg = e.tags || {};
      if (exRe && exRe.test((tg['name:zh'] || '') + ' ' + (tg.name || '') + ' ' + (tg.brand || '') + ' ' + (tg.operator || ''))) return;
      // union 會重覆命中同一點（多中心／多選擇器）→ 依 type+id 去重
      var key = (e.type || '') + '/' + (e.id != null ? e.id : (lat + ',' + lng));
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ lat: lat, lng: lng, name: _name(e.tags, dft),
                 dist: _haversine(me, { lat: lat, lng: lng }),
                 wc: wantWc ? _toilet(e.tags) : '' });
    });
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out.slice(0, TOP_N);
  }
  // 導航選單的備註：距離（＋便利商店的廁所狀態）
  function _note(f, cat) {
    var s = _fmtDist(f.dist);
    if (cat.wc) s += ' · ' + (f.wc === 'yes' ? '🚻 有廁所' : f.wc === 'no' ? '🚫 沒有廁所' : '廁所未標示');
    return s;
  }

  // 兩個鏡像「並行競速」，誰先成功用誰（舊版是序列：第一個卡住要等 20 秒才換 → 特別慢）。
  function fetchOverpass(centers, sels) {
    var body = _overpassBody(centers, sels);
    return new Promise(function (resolve) {
      var pending = MIRRORS.length, settled = false;
      MIRRORS.forEach(function (url) {
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
        var opt = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body };
        if (ctrl) opt.signal = ctrl.signal;
        fetch(url, opt).then(function (r) {
          clearTimeout(timer);
          if (!r || !r.ok) throw new Error('http ' + (r && r.status));
          return r.json();
        }).then(function (data) {
          if (!settled) { settled = true; resolve(data); }         // 先到先用
        }).catch(function () {
          clearTimeout(timer);
          pending--;
          if (pending <= 0 && !settled) { settled = true; resolve(null); }   // 兩個都掛才算失敗
        });
      });
    });
  }

  // ---- UI：地圖編號釘 ＋「清除」浮鈕（無底部清單）----
  var CSS =
    // 釘子＝類別 Emoji（加油站⛽／停車場🅿️／便利商店🏪）為主，白底＋類別色外框
    '.mt-nb-pin{position:relative;width:32px;height:32px;border-radius:50%;background:#fff;' +
      'font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 1px 6px rgba(0,0,0,.4);border:2px solid #188038;}' +
    // 排名數字＝右上角小徽章（縮小、不擋 Emoji）
    '.mt-nb-pin .num{position:absolute;top:-7px;right:-7px;min-width:16px;height:16px;padding:0 3px;box-sizing:border-box;' +
      'border-radius:8px;background:#188038;color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;' +
      'box-shadow:0 1px 2px rgba(0,0,0,.35);}' +
    // 廁所徽章移到右下角，避免和右上角數字打架
    '.mt-nb-pin .wc{position:absolute;bottom:-6px;right:-8px;width:15px;height:15px;border-radius:50%;background:#fff;' +
      'font-size:9px;font-style:normal;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(0,0,0,.3);}' +
    '#mt-nb-clear{position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top) + 56px);' +
      'z-index:16;display:none;border:none;background:rgba(0,0,0,.72);color:#fff;font:inherit;font-size:13px;' +
      'font-weight:600;padding:7px 15px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;}' +
    '#mt-nb-clear.on{display:block;}';

  var _cssAdded = false, _clearBtn = null, _markers = [];
  function _ensureUi() {
    if (!_cssAdded) { var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); _cssAdded = true; }
    if (!_clearBtn) {
      _clearBtn = document.createElement('button');
      _clearBtn.id = 'mt-nb-clear'; _clearBtn.textContent = '✕ 清除搜尋';
      _clearBtn.addEventListener('click', close);
      document.body.appendChild(_clearBtn);
    }
    return _clearBtn;
  }

  function clearMap() {
    var m = gmap();
    if (m) _markers.forEach(function (mk) { try { m.removeLayer(mk); } catch (_) {} });
    _markers = [];
    if (_clearBtn) _clearBtn.classList.remove('on');
  }

  function drawMap(list, anchor, cat) {
    var m = gmap(); if (!m || !window.L) return;
    clearMap();
    var pts = [];
    list.forEach(function (f, i) {
      try {
        var wcBadge = (cat.wc && f.wc === 'yes') ? '<i class="wc">🚻</i>' : '';
        var numBadge = '<i class="num" style="background:' + cat.accent + '">' + (i + 1) + '</i>';
        var html = '<div class="mt-nb-pin" style="border-color:' + cat.accent + '">' + cat.icon + numBadge + wcBadge + '</div>';
        var icon = L.divIcon({ className: 'mt-nb-pinwrap', html: html, iconSize: [34, 34], iconAnchor: [17, 17] });
        var mk = L.marker([f.lat, f.lng], { icon: icon });
        mk.addTo(m);
        (function (ff) {
          var note = _note(ff, cat);
          function go() { if (window.MaptripNav) MaptripNav.open(ff.name, ff.lat, ff.lng, note); }
          if (typeof mk.on === 'function') { mk.on('click', go); }
          else if (mk.getElement) { var el = mk.getElement(); if (el) el.addEventListener('click', go); }
        })(f);
        _markers.push(mk); pts.push([f.lat, f.lng]);
      } catch (_) {}
    });
    if (anchor) pts.push([anchor.lat, anchor.lng]);
    if (pts.length) {
      try {
        m.fitBounds(L.latLngBounds(pts), {
          paddingTopLeft: [40, 100], paddingBottomRight: [40, 70], maxZoom: 16, animate: true
        });
      } catch (_) {}
    }
  }

  function render(list, me, cat) {
    drawMap(list, me, cat);
    _ensureUi().classList.add('on');
    var wcHint = cat.wc ? '（🚻＝有廁所）' : '';
    say('找到 ' + list.length + ' 家' + cat.short + wcHint + '，點地圖上的釘子開車導航');
  }
  function close() { clearMap(); }

  var busy = false;
  function run(kind) {
    var cat = CATS[kind] || CATS.fuel;
    if (busy) return;
    // 搜尋中心＝地圖當下中心（把地圖移到哪就搜哪；無地圖則退回 GPS）
    var m = gmap(), center = null;
    try { if (m && m.getCenter) { var c = m.getCenter(); if (c && c.lat != null) center = { lat: c.lat, lng: c.lng }; } } catch (_) {}
    var me = pos();
    var searchAt = center || me;
    if (!searchAt) { say('地圖尚未就緒，稍後再試'); return; }
    var distFrom = me || searchAt;             // 距離基準：有 GPS 用 GPS（＝離你多遠），否則用搜尋中心
    // 搜尋中心：地圖中心 ＋ GPS 一起抓（union）；兩者很近（<300m）就只用一個，省流量。
    var centers = [center];
    if (me && (!center || _haversine(center, me) > 300)) centers.push(me);
    centers = centers.filter(Boolean);
    if (!centers.length) centers = [searchAt];
    busy = true; setBusy(true);
    say('搜尋附近' + cat.short + '中…');
    fetchOverpass(centers, cat.sels).then(function (data) {
      busy = false; setBusy(false);
      if (!data) { say('地圖服務暫時無法連線，稍後再試'); return; }
      var list = _parse(data.elements, distFrom, cat.dft, !!cat.wc, cat.exclude);
      if (!list.length) { say(cat.empty); return; }
      render(list, searchAt, cat);
    }).catch(function () { busy = false; setBusy(false); say('搜尋失敗，稍後再試'); });
  }

  window.MaptripNearby = {
    run: run, close: close, clearMap: clearMap, CATS: CATS,
    _haversine: _haversine, _fmtDist: _fmtDist, _name: _name, _toilet: _toilet,
    _parse: _parse, _overpassBody: _overpassBody, _note: _note, _drawMap: drawMap
  };
})();
