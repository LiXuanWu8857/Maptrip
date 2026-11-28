// finance.js — 收支報表（支出記錄 + 淨收入）與效率分析
// 自成一檔：注入樣式、動態建立面板 DOM，只靠 app.js 的全域函式
// （loadTrips / businessDayKey / todayKey / fmtDist / toast / workMs / getRestMin）。
(function () {
  'use strict';
  var TEST = /(?:\?|&)test\b/.test(location.search);
  var EXPENSE_KEY = TEST ? 'maptrip_expenses_test' : 'maptrip_expenses';

  var CATS = [
    { k: 'fuel',      label: '加油',      icon: '⛽' },
    { k: 'carwash',   label: '洗車',      icon: '🧼' },
    { k: 'maintain',  label: '保養維修',  icon: '🔧' },
    { k: 'rent',      label: '靠行/租金', icon: '🏢' },
    { k: 'insurance', label: '保險',      icon: '🛡️' },
    { k: 'toll',      label: '停車/過路', icon: '🅿️' },
    { k: 'meal',      label: '餐飲',      icon: '🍱' },
    { k: 'other',     label: '其他',      icon: '📦' }
  ];
  var CAT_MAP = {}; CATS.forEach(function (c) { CAT_MAP[c.k] = c; });
  var WD = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

  // 上車熱點 × 時段：一天切 8 段（涵蓋 0-23 全時；深夜跨午夜）
  var TBUCKETS = [
    { label: '清晨',   s: 5,  e: 7 },
    { label: '早尖峰', s: 7,  e: 9 },
    { label: '上午',   s: 9,  e: 11 },
    { label: '中午',   s: 11, e: 14 },
    { label: '下午',   s: 14, e: 17 },
    { label: '晚尖峰', s: 17, e: 19 },
    { label: '晚間',   s: 19, e: 22 },
    { label: '深夜',   s: 22, e: 5 }
  ];
  var PK_CELL = 300;       // 上車點聚合網格邊長（公尺）
  var PK_TOP  = 6;         // 熱點排行顯示前幾名
  var GEO_KEY = 'maptrip_geocache';

  var _month = null;       // 'YYYY-MM'（相容保留；期間改由 _ptype/_anchor 驅動）
  var _ptype = 'month';    // 期間型態：day/week/month/quarter/year（業績分析 v1.1.468）
  var _anchor = null;      // 期間錨點（某日 key）；null＝今天
  var _lastCtx = null;     // 最近一次 render 的分析結果（供「複製給 AI」沿用）
  var _view = 'io';        // 'io'（收支）/ 'an'（分析）
  var _addOpen = false;
  var _lastPk = null;      // 最近一次上車熱點分析結果（供地名補上）
  var _pkToken = 0;        // 地名補上的世代序號（避免舊 render 的非同步覆寫）

  // ---------- 資料 ----------
  // 支出＝雲端為主＋localStorage 快取：
  //   - loadExp()/saveExp() 仍是「同步快取層」，所有計算（revenueOfMonth 等）照舊只讀快取，一行不改。
  //   - 快取由雲端 onSnapshot 餵飽（bindExpenseSync）；本機新增/刪除先寫快取（樂觀更新）再推雲。
  //   - 離線時退回純快取，體驗不斷。
  var MIGRATED_KEY = TEST ? 'maptrip_exp_migrated_test' : 'maptrip_exp_migrated';
  var _unsubExp = null;
  var _expBound = false;
  function loadExp() { try { return JSON.parse(localStorage.getItem(EXPENSE_KEY) || '[]'); } catch (_) { return []; } }
  function saveExp(list) { try { localStorage.setItem(EXPENSE_KEY, JSON.stringify(list)); } catch (_) {} }
  function S() { return window.MaptripSync; }
  function myUid() { try { return S() && S().myUid && S().myUid(); } catch (_) { return null; } }

  // 綁定雲端支出同步（登入後、開報表時呼叫一次）：先遷移舊資料，再訂閱即時快照回填快取。
  async function bindExpenseSync() {
    var s = S(), uid = myUid();
    if (_expBound || !s || !uid || !s.listenExpenses) return;
    _expBound = true;
    // 一次性遷移：把本機既有支出推上雲（只做一次，用旗標防重）。
    try {
      if (localStorage.getItem(MIGRATED_KEY) !== '1') {
        var local = loadExp();
        for (var i = 0; i < local.length; i++) {
          var e = local[i];
          // 舊資料 id 是 Date.now()，統一成 <uid>_<id> 讓雲端不撞號、可辨識來源。
          await s.writeExpense(uid, { id: uid + '_' + (e.id || (Date.now() + i)),
            cat: e.cat, amount: e.amount, note: e.note, day: e.day, ts: e.ts || e.id || Date.now() });
        }
        localStorage.setItem(MIGRATED_KEY, '1');
      }
    } catch (_) {}   // 遷移失敗不擋（下次啟用再試，writeExpense 用 merge 冪等）
    // 訂閱：雲端變動 → 覆蓋快取 → 若報表開著就重繪。
    try {
      _unsubExp = s.listenExpenses(uid, function (list) {
        saveExp(list || []);
        if (document.getElementById('finance-sheet') &&
            document.getElementById('finance-sheet').classList.contains('show')) render();
      });
    } catch (_) {}
  }

  // 換帳號時重置：取消訂閱、清支出快取、放開綁定旗標（下次開報表重新綁新帳號）。
  // 由 sync.js 的 _clearLocalForSwitch 呼叫（與 v265 行程隔離同一類坑）。
  // 注意：不清 MIGRATED_KEY——它是「這台裝置的舊本機支出是否已搬雲端」的一次性裝置級旗標，
  //       與帳號無關；清了會讓換回舊帳號時又把（已清空的）本機當成待遷移。
  function resetExpenseSync() {
    try { if (_unsubExp) _unsubExp(); } catch (_) {}
    _unsubExp = null; _expBound = false;
    saveExp([]);   // 清掉上一個帳號殘留的支出快取
  }
  function monthOf(dayKey) { return String(dayKey || '').slice(0, 7); }
  function curMonth() { return monthOf(window.todayKey ? todayKey() : new Date().toISOString().slice(0, 10)); }
  function nf(n) { return (Math.round(n) || 0).toLocaleString(); }

  // ---------- 期間系統（業績分析 v1.1.468）----------
  // 以 MaptripPerf 的純函式做「日/週/月/季/年」切換與分析；finance 只負責取資料與畫面。
  var PSEG = [{ k: 'day', t: '日' }, { k: 'week', t: '週' }, { k: 'month', t: '月' }, { k: 'quarter', t: '季' }, { k: 'year', t: '年' }];
  function PF() { return window.MaptripPerf; }
  function curToday() { return window.todayKey ? todayKey() : new Date().toISOString().slice(0, 10); }
  function restMinOf(day) { try { return window.getRestMin ? getRestMin(day) : 0; } catch (_) { return 0; } }
  // 併入記帳者補登手動趟（顯示層，不進 days）→ 車資算進營收；工時 workMs 內部排除手動。
  function mergedDays() {
    var raw = (window.loadTrips ? loadTrips() : {}) || {};
    if (window.MaptripManual && MaptripManual.mergeInto) { try { raw = MaptripManual.mergeInto(raw); } catch (_) {} }
    return raw;
  }
  function curInfo() { return PF().periodInfo(_ptype, _anchor || curToday()); }
  // 期間內支出（依日期範圍，非趟 key；避免無趟日支出被漏算）
  function expsInPeriod(info) {
    var byCat = {}, total = 0, rows = [];
    loadExp().forEach(function (e) {
      if (!info.inRange(String(e.day || ''))) return;
      total += e.amount || 0; byCat[e.cat] = (byCat[e.cat] || 0) + (e.amount || 0); rows.push(e);
    });
    rows.sort(function (a, b) { return (b.day + '').localeCompare(a.day + '') || (b.ts || 0) - (a.ts || 0); });
    return { total: total, byCat: byCat, rows: rows };
  }
  // 一次算出目前期間的 money + 效率分析（兩個 tab 共用，避免重複計算）
  function curAnalysis() {
    var info = curInfo(), md = mergedDays(), keys = PF().keysInRange(md, info);
    var exps = expsInPeriod(info);
    var a = PF().analyze(md, keys, { commissions: null, expenses: exps.rows, restMinOf: restMinOf });
    return { info: info, keys: keys, exps: exps, a: a };
  }

  // 月報表核心（純函式，單一算錢來源）：吃 days/commissions/expenses/月份 → 營收/抽成/叫車/支出/淨利。
  // 記帳者報表用 readDriverData 餵、finance 自己用 loadTrips 餵（commissions=null→用行程自帶 t.commission）。
  //   - 排除「其他」付款（多為自用/非載客）
  //   - 抽成/叫車：commissions[id] 有值優先（明確填 0 也優先），否則沿用行程自帶 t.commission/t.dispatch
  //   - 淨利 = 營收 − 抽成 − 叫車 − 支出
  function monthReport(days, commissions, expenses, ym) {
    var month = ym ? String(ym).slice(0, 7) : curMonth();
    var fare = 0, cash = 0, card = 0, voucher = 0, dist = 0, trips = 0, comm = 0, disp = 0;
    Object.keys(days || {}).forEach(function (day) {
      if (String(day).slice(0, 7) !== month) return;
      (days[day] || []).forEach(function (t) {
        if (t.paymentMethod === 'other') return;
        // 代收取消費（v1.1.455）：現金+a、刷卡−a、不計營收/趟數/里程/抽成（淨 0）
        if (t.cancelCollect) { var ca = t.fare || 0; cash += ca; card -= ca; return; }
        var f = t.fare || 0; fare += f; dist += t.totalDist || 0; trips++;
        var c = commissions && commissions[String(t.id)];
        comm += (c && c.commission != null) ? c.commission : (t.commission || 0);
        disp += (c && c.dispatch != null) ? c.dispatch : (t.dispatch || 0);
        if (t.paymentMethod === 'card') card += f;
        else if (t.paymentMethod === 'voucher') { card += f; voucher += f; }   // 紙本簽單：算進刷卡（voucher＝其中簽單）
        else cash += f;
        // 小費/加收（同一筆、付款方式可與主車資不同，例如刷卡車資＋現金小費）
        var tip = t.tip || 0;
        if (tip) { fare += tip; if ((t.tipMethod || 'cash') === 'card') card += tip; else cash += tip; }
      });
    });
    var expTotal = 0;
    (expenses || []).forEach(function (e) { if (String(e.day || '').slice(0, 7) === month) expTotal += e.amount || 0; });
    return { month: month, fare: fare, cash: cash, card: card, voucher: voucher, dist: dist, trips: trips,
      comm: comm, disp: disp, expTotal: expTotal, net: fare - comm - disp - expTotal };
  }

  // 某月營收（載客車資，排除「其他」）＋里程＋趟數＋現金/刷卡＋工時。
  // 算錢部分改走共用 monthReport（單一來源）；工時 workMs 仍在此就地累加（需 app.js 全域）。
  function revenueOfMonth(month) {
    var raw = (window.loadTrips ? loadTrips() : {}) || {};
    // 併入記帳者補登的手動紀錄（顯示層，不進 days）→ 車資算進營收（工時 workMs 內部排除手動）
    if (window.MaptripManual && MaptripManual.mergeInto) raw = MaptripManual.mergeInto(raw);
    var rep = monthReport(raw, null, null, month);   // commissions=null → 用行程自帶 t.commission
    var workMs = 0;
    Object.keys(raw).forEach(function (day) {
      if (monthOf(day) !== month) return;
      if (window.workMs && window.getRestMin) workMs += workMs0(raw[day] || [], getRestMin(day));
    });
    return { fare: rep.fare, cash: rep.cash, card: rep.card, voucher: rep.voucher, dist: rep.dist, trips: rep.trips, workMs: workMs, comm: rep.comm, disp: rep.disp };
  }
  function workMs0(arr, restMin) { try { return workMs(arr, restMin); } catch (_) { return 0; } }

  function expensesOfMonth(month) {
    var byCat = {}; var total = 0; var rows = [];
    loadExp().forEach(function (e) {
      if (monthOf(e.day) !== month) return;
      total += e.amount || 0;
      byCat[e.cat] = (byCat[e.cat] || 0) + (e.amount || 0);
      rows.push(e);
    });
    rows.sort(function (a, b) { return (b.day + '').localeCompare(a.day + '') || b.ts - a.ts; });
    return { total: total, byCat: byCat, rows: rows };
  }

  // ---------- 分析 ----------
  function analyze(month) {
    var raw = (window.loadTrips ? loadTrips() : {}) || {};
    var byHour = [], byDow = [];
    for (var i = 0; i < 24; i++) byHour.push({ n: 0, fare: 0 });
    for (var j = 0; j < 7; j++) byDow.push({ n: 0, fare: 0 });
    Object.keys(raw).forEach(function (day) {
      if (monthOf(day) !== month) return;
      (raw[day] || []).forEach(function (t) {
        if (t.paymentMethod === 'other') return;
        var d = new Date(t.startTime), h = d.getHours(), w = d.getDay(), f = t.fare || 0;
        byHour[h].n++; byHour[h].fare += f;
        byDow[w].n++; byDow[w].fare += f;
      });
    });
    return { byHour: byHour, byDow: byDow };
  }

  // ---------- 上車熱點 × 時段 ----------
  // 一天中 hour 落在哪個時段（找不到回 -1）；深夜段跨午夜要繞回來判斷
  function bucketIndexOf(h) {
    for (var i = 0; i < TBUCKETS.length; i++) {
      var b = TBUCKETS[i];
      if (b.s < b.e) { if (h >= b.s && h < b.e) return i; }
      else { if (h >= b.s || h < b.e) return i; }
    }
    return -1;
  }
  function bucketRange(b) { return b.s + '–' + b.e + ' 點'; }

  // 經緯度 → 相對 origin 的公尺座標（等距近似，與 hotspots.js 同法）
  function toXY(origin, p) {
    var mPerDeg = 111320;
    return {
      x: (p.lng - origin.lng) * mPerDeg * Math.cos(origin.lat * Math.PI / 180),
      y: (p.lat - origin.lat) * mPerDeg
    };
  }

  // 掃全部歷史的上車點（每趟 coords[0]），聚成 300m 網格，並記每格的時段分佈。
  // 排除「其他」付款（多為自用/非載客）。時段熱點需要量，所以刻意不受月份篩選。
  function analyzePickups() {
    var raw = (window.loadTrips ? loadTrips() : {}) || {};
    var pts = [];
    Object.keys(raw).forEach(function (day) {
      (raw[day] || []).forEach(function (t) {
        if (t.paymentMethod === 'other') return;
        var c = t.coords && t.coords[0];
        if (!c || typeof c.lat !== 'number' || typeof c.lng !== 'number') return;
        pts.push({ lat: c.lat, lng: c.lng, h: new Date(t.startTime).getHours(), fare: t.fare || 0 });
      });
    });
    if (!pts.length) return { clusters: [], byBucket: [], total: 0 };

    var origin = pts[0], cells = {};
    pts.forEach(function (p) {
      var xy = toXY(origin, p);
      var k = Math.floor(xy.x / PK_CELL) + '_' + Math.floor(xy.y / PK_CELL);
      var c = cells[k];
      if (!c) { c = cells[k] = { key: k, n: 0, fare: 0, wlat: 0, wlng: 0, buckets: [] };
        for (var z = 0; z < TBUCKETS.length; z++) c.buckets.push(0); }
      c.n++; c.fare += p.fare; c.wlat += p.lat; c.wlng += p.lng;
      var bi = bucketIndexOf(p.h); if (bi >= 0) c.buckets[bi]++;
    });

    var list = Object.keys(cells).map(function (k) {
      var c = cells[k];
      c.lat = c.wlat / c.n; c.lng = c.wlng / c.n;
      c.avgFare = c.n ? c.fare / c.n : 0;
      var pb = -1, pv = 0;
      c.buckets.forEach(function (v, i) { if (v > pv) { pv = v; pb = i; } });
      c.peakBucket = pb;
      return c;
    });
    list.sort(function (a, b) { return b.n - a.n; });

    // 每個時段內，各熱點依該時段趟數排名（首名＝該時段人最多的地點）
    var byBucket = TBUCKETS.map(function (_, bi) {
      return list.filter(function (c) { return c.buckets[bi] > 0; })
        .sort(function (a, b) { return b.buckets[bi] - a.buckets[bi]; });
    });
    return { clusters: list, byBucket: byBucket, total: pts.length };
  }

  // 反向地理編碼（Nominatim）＋ localStorage 快取。離線／失敗都安靜退場，
  // 不影響趟數統計（趟數才是主要訊號）。快取 key＝小數 3 位（約 100m）。
  function geoCache() { try { return JSON.parse(localStorage.getItem(GEO_KEY) || '{}'); } catch (_) { return {}; } }
  function saveGeoCache(o) { try { localStorage.setItem(GEO_KEY, JSON.stringify(o)); } catch (_) {} }
  function geoKey(lat, lng) { return lat.toFixed(3) + ',' + lng.toFixed(3); }
  function cachedName(lat, lng) { var c = geoCache()[geoKey(lat, lng)]; return c && c.name ? c.name : ''; }

  function pickName(j) {
    if (!j) return '';
    var a = j.address || {};
    var road = a.road || a.pedestrian || a.footway || a.residential || '';
    var area = a.neighbourhood || a.quarter || a.suburb || a.village || a.town || a.city_district || '';
    var poi = j.name || a.amenity || a.building || a.shop || '';
    var main = poi || road || area || (j.display_name ? j.display_name.split(',')[0].trim() : '');
    if (!main) return '';
    if (area && main !== area) return main + '（' + area + '）';
    return main;
  }

  function revGeocode(lat, lng) {
    var cache = geoCache(), key = geoKey(lat, lng);
    if (cache[key]) return Promise.resolve(cache[key].name || '');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve('');
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=zh-TW&lat=' +
      lat + '&lon=' + lng;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
    var opt = { headers: { 'Accept': 'application/json' } };
    if (ctrl) opt.signal = ctrl.signal;
    return fetch(url, opt).then(function (r) {
      clearTimeout(timer);
      if (!r || !r.ok) throw new Error('http ' + (r && r.status));
      return r.json();
    }).then(function (j) {
      var nm = pickName(j);
      cache[key] = { name: nm, ts: Date.now() };   // 空字串也快取，避免重複打空
      saveGeoCache(cache);
      return nm;
    }).catch(function () { clearTimeout(timer); return ''; });
  }

  // render 後把「查詢中…」換成真正地名：只查目前畫面上出現的熱點，
  // 依 Nominatim 用量規範每筆間隔 1.1 秒，已快取者不等待。
  function nameSpan(c) {
    var nm = cachedName(c.lat, c.lng);
    return '<span class="pk-name" data-pk="' + esc(c.key) + '">' + (nm ? esc(nm) : '查詢中…') + '</span>';
  }
  function setPkName(pkKey, txt) {
    var els = document.querySelectorAll('.pk-name[data-pk="' + pkKey + '"]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].textContent === '查詢中…' || txt) els[i].textContent = txt || '未命名地點';
    }
  }
  function hydratePickupNames() {
    var pk = _lastPk; if (!pk || !pk.total) return;
    var my = ++_pkToken, seen = {}, queue = [];
    function push(c) { if (c && !seen[c.key]) { seen[c.key] = 1; queue.push(c); } }
    pk.byBucket.forEach(function (arr) { if (arr && arr[0]) push(arr[0]); });
    pk.clusters.slice(0, PK_TOP).forEach(push);
    (function step(i) {
      if (i >= queue.length || my !== _pkToken) return;
      var c = queue[i];
      if (cachedName(c.lat, c.lng)) { setPkName(c.key, cachedName(c.lat, c.lng)); return step(i + 1); }
      revGeocode(c.lat, c.lng).then(function (nm) {
        if (my !== _pkToken) return;
        setPkName(c.key, nm);
        setTimeout(function () { step(i + 1); }, 1100);
      });
    })(0);
  }

  // ---------- DOM ----------
  function injectCss() {
    if (document.getElementById('finance-css')) return;
    var s = document.createElement('style'); s.id = 'finance-css';
    s.textContent =
      '#finance-sheet{position:fixed;bottom:0;left:0;right:0;max-height:82vh;background:#fff;' +
      'border-radius:20px 20px 0 0;border-top:1px solid rgba(0,0,0,0.08);z-index:31;display:none;' +
      'flex-direction:column;box-shadow:0 -4px 24px rgba(0,0,0,0.1);padding-bottom:env(safe-area-inset-bottom,0);animation:slideUp .25s ease;transition:max-height .2s ease,border-radius .2s ease}' +
      '#finance-sheet.show{display:flex}' +
      '.fin-mbar{display:flex;align-items:center;justify-content:center;gap:18px;padding:4px 0 8px}' +
      '.fin-mbar button{background:none;border:none;font-size:1.4rem;color:#1a73e8;cursor:pointer;padding:0 6px;line-height:1}' +
      '.fin-mbar span{font-size:1rem;font-weight:700;color:#202124;min-width:120px;text-align:center}' +
      '.fin-tabs{display:flex;gap:8px;padding:0 16px 8px}' +
      '.fin-tab{flex:1;padding:9px;border:none;border-radius:10px;background:#f1f3f4;color:#5f6368;font-weight:600;font-family:inherit;font-size:.9rem;cursor:pointer}' +
      '.fin-tab.active{background:#1a73e8;color:#fff}' +
      // 期間切換（日/週/月/季/年）
      '.fin-pseg{display:flex;gap:4px;padding:2px 16px 6px}' +
      '.fin-ps{flex:1;padding:7px 0;border:none;border-radius:8px;background:#f1f3f4;color:#5f6368;font-weight:600;font-size:.82rem;font-family:inherit;cursor:pointer}' +
      '.fin-ps.on{background:#1a73e8;color:#fff}' +
      // 複製給 AI
      '.fin-ai-btn{width:100%;margin:12px 0 2px;display:flex;flex-direction:column;align-items:center;gap:2px;background:linear-gradient(135deg,#34a853,#188038);color:#fff;border:none;border-radius:14px;padding:13px;font-size:.95rem;font-weight:700;font-family:inherit;cursor:pointer}' +
      '.fin-ai-btn .sub{font-size:.68rem;font-weight:500;opacity:.9}.fin-ai-btn:active{opacity:.9}' +
      // 時間效率
      '.fin-eff{background:#f8f9fa;border-radius:14px;padding:14px}' +
      '.fin-efflabs{display:flex;justify-content:space-between;font-size:.8rem;font-weight:600;margin-bottom:5px}' +
      '.fin-efflabs .ld{color:#1a73e8}.fin-efflabs .idl{color:#e8710a}' +
      '.fin-effbar{display:flex;height:20px;border-radius:7px;overflow:hidden;background:#e8eaed}' +
      '.fin-effbar .ld{background:#1a73e8}.fin-effbar .idl{background:#f1a33c}' +
      '.fin-effrow{display:flex;gap:10px;margin-top:12px}' +
      '.fin-effm{flex:1;text-align:center}.fin-effm .v{font-size:1.02rem;font-weight:700;color:#202124}.fin-effm .k{font-size:.7rem;color:#5f6368;margin-top:2px}' +
      '.fin-bars.bk .fin-bar .cap{font-size:.6rem}' +
      // 星期×時段 熱力圖
      '.fin-heat{display:grid;grid-template-columns:18px repeat(8,1fr);gap:3px}' +
      '.fin-hc{height:22px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:.58rem;color:#fff}' +
      '.fin-hc.hh{background:none;color:#9aa0a6;font-size:.56rem;height:auto;padding-bottom:1px}' +
      '.fin-hc.hr{background:none;color:#5f6368;font-size:.62rem;font-weight:600}' +
      '.fin-hc.empty{background:#eceff1}' +
      '.fin-hc.cell{cursor:pointer;-webkit-tap-highlight-color:transparent}' +
      '.fin-hc.cell.press{outline:2px solid #202124;outline-offset:-1px}' +
      // 短趟盈虧 + 行動建議
      '.fin-short{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.fin-short .fin-stat .val{font-size:1.05rem}' +
      '.fin-advice{background:rgba(26,115,232,.06);border:1px solid rgba(26,115,232,.16);border-radius:12px;padding:10px 12px}' +
      '.fin-advice ul{margin:0;padding-left:18px}.fin-advice li{font-size:.84rem;color:#3c4043;line-height:1.5;margin:3px 0}' +
      '#finance-body{overflow-y:auto;flex:1;padding:0 16px 16px}' +
      '.fin-net{background:linear-gradient(135deg,#1a73e8,#0b57c7);color:#fff;border-radius:16px;padding:16px 18px;margin-bottom:12px}' +
      '.fin-net .lbl{font-size:.8rem;opacity:.85}.fin-net .val{font-size:1.9rem;font-weight:800;margin-top:2px}' +
      '.fin-net .sub{display:flex;gap:16px;margin-top:8px;font-size:.82rem;opacity:.95}' +
      '.fin-row2{display:flex;gap:10px;margin-bottom:12px}' +
      '.fin-card{flex:1;background:#f8f9fa;border-radius:12px;padding:12px 14px}' +
      '.fin-card .lbl{font-size:.76rem;color:#5f6368}.fin-card .val{font-size:1.25rem;font-weight:700;margin-top:2px}' +
      '.fin-card .val.rev{color:#188038}.fin-card .val.exp{color:#d93025}' +
      '.fin-sec{font-size:.82rem;color:#5f6368;font-weight:600;margin:14px 2px 8px}' +
      '.fin-catgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
      '.fin-catcell{display:flex;align-items:center;gap:8px;background:#f8f9fa;border-radius:10px;padding:9px 11px}' +
      '.fin-catcell .ic{font-size:1.1rem}.fin-catcell .nm{flex:1;font-size:.82rem;color:#3c4043}.fin-catcell .am{font-weight:700;font-size:.9rem;color:#202124}' +
      '.fin-add-btn{width:100%;margin-top:10px;background:rgba(26,115,232,.08);color:#1a73e8;border:1px solid rgba(26,115,232,.25);' +
      'border-radius:12px;padding:12px;font-size:.9rem;font-weight:600;font-family:inherit;cursor:pointer}' +
      '.fin-pull-btn{width:100%;margin-top:10px;background:rgba(245,124,0,.08);color:#e8710a;border:1px solid rgba(245,124,0,.28);' +
      'border-radius:12px;padding:11px;font-size:.86rem;font-weight:600;font-family:inherit;cursor:pointer}' +
      '.fin-pull-btn:active{opacity:.8}' +
      '.fin-explist{margin-top:6px}' +
      '.fin-exprow{display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid rgba(0,0,0,.05)}' +
      '.fin-exprow .ic{font-size:1.15rem}.fin-exprow .mid{flex:1;min-width:0}' +
      '.fin-exprow .t1{font-size:.86rem;color:#202124}.fin-exprow .t2{font-size:.72rem;color:#9aa0a6;margin-top:1px}' +
      '.fin-exprow .am{font-weight:700;color:#d93025}.fin-exprow .del{background:none;border:none;color:#c5c9cd;font-size:1rem;cursor:pointer;padding:2px 4px}' +
      '.fin-empty{text-align:center;color:#9aa0a6;font-size:.85rem;padding:26px 0}' +
      '.fin-form{background:#f8f9fa;border-radius:14px;padding:12px;margin-top:10px}' +
      '.fin-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}' +
      '.fin-chip{padding:7px 11px;border-radius:999px;border:1px solid rgba(0,0,0,.12);background:#fff;font-size:.8rem;color:#3c4043;cursor:pointer}' +
      '.fin-chip.on{background:#1a73e8;color:#fff;border-color:#1a73e8}' +
      '.fin-inp{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid rgba(0,0,0,.15);border-radius:10px;font-size:1rem;line-height:1.3;font-family:inherit;margin-bottom:8px;background:#fff}' +
      // iOS 的 type=date 會用原生尺寸（較高、置中）→ 關掉原生外觀，讓它和金額/備註一致
      'input.fin-inp[type=date]{-webkit-appearance:none;appearance:none;text-align:left;min-height:0;height:auto}' +
      'input.fin-inp[type=date]::-webkit-date-and-time-value{text-align:left;margin:0}' +
      '.fin-form-btns{display:flex;gap:8px}.fin-form-btns button{flex:1;padding:11px;border:none;border-radius:10px;font-size:.9rem;font-weight:600;font-family:inherit;cursor:pointer}' +
      '.fin-ok{background:#1a73e8;color:#fff}.fin-cancel{background:#e8eaed;color:#3c4043}' +
      '.fin-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px}' +
      '.fin-stat{background:#f8f9fa;border-radius:12px;padding:12px 14px}' +
      '.fin-stat .lbl{font-size:.74rem;color:#5f6368}.fin-stat .val{font-size:1.15rem;font-weight:700;color:#202124;margin-top:3px}' +
      '.fin-chart{margin-top:6px}' +
      '.fin-bars{display:flex;align-items:flex-end;gap:2px;height:110px;padding-top:6px}' +
      '.fin-bar{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}' +
      '.fin-bar .b{width:70%;min-height:2px;background:#1a73e8;border-radius:3px 3px 0 0;transition:height .2s}' +
      '.fin-bar .b.dim{background:#c6dafc}' +
      '.fin-bar .cap{font-size:.58rem;color:#9aa0a6;margin-top:3px;white-space:nowrap}' +
      '.fin-bars.wd .fin-bar .cap{font-size:.72rem}' +
      '.fin-bar{cursor:pointer;-webkit-tap-highlight-color:transparent}' +
      '.fin-bar.press .b{background:#0b57c7}' +
      '.fin-hint{font-weight:400;color:#9aa0a6;font-size:.68rem;margin-left:4px}' +
      '#fin-tip{position:fixed;z-index:60;display:none;pointer-events:none;background:#202124;color:#fff;' +
      'font-size:.8rem;font-weight:600;padding:6px 10px;border-radius:8px;white-space:nowrap;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.28);font-variant-numeric:tabular-nums}' +
      '.pk-note{font-weight:400;color:#9aa0a6;font-size:.72rem;margin-left:4px}' +
      '.pk-buckets{display:flex;flex-direction:column;gap:1px;background:#f1f3f4;border-radius:12px;overflow:hidden}' +
      '.pk-brow{display:flex;align-items:center;gap:10px;background:#fff;padding:9px 12px}' +
      '.pk-btime{flex:0 0 84px;line-height:1.15}.pk-btime b{display:block;font-size:.86rem;color:#202124}' +
      '.pk-btime span{font-size:.68rem;color:#9aa0a6}' +
      '.pk-bplace{flex:1;min-width:0;display:flex;align-items:center;gap:8px}' +
      '.pk-name{flex:1;min-width:0;font-size:.9rem;color:#3c4043;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.pk-cnt{flex:none;font-size:.82rem;font-weight:700;color:#188038}' +
      '.pk-rank{display:flex;flex-direction:column;gap:6px}' +
      '.pk-rrow{display:flex;align-items:center;gap:10px;background:#f8f9fa;border-radius:12px;padding:10px 12px}' +
      '.pk-rk{flex:none;width:22px;height:22px;border-radius:50%;background:#c6dafc;color:#1a4b8c;font-size:.78rem;' +
      'font-weight:700;display:flex;align-items:center;justify-content:center}' +
      '.pk-rk1{background:#d93025;color:#fff}.pk-rk2{background:#e8710a;color:#fff}.pk-rk3{background:#f9ab00;color:#fff}' +
      '.pk-rmid{flex:1;min-width:0}.pk-rmid .pk-name{display:block;font-size:.92rem;color:#202124;font-weight:600}' +
      '.pk-rsub{font-size:.74rem;color:#9aa0a6;margin-top:2px}' +
      '@media (prefers-color-scheme: dark){' +
      '.pk-buckets{background:#111}.pk-brow{background:#242424}.pk-btime b{color:#e8eaed}' +
      '.pk-name{color:#c8ccd2}.pk-rrow{background:#242424}.pk-rmid .pk-name{color:#e8eaed}' +
      '.pk-rk{background:#2f3b4d;color:#c6dafc}' +
      '#finance-sheet{background:#1a1a1a;border-top-color:rgba(255,255,255,.07)}' +
      '.fin-mbar span{color:#e8eaed}.fin-tab{background:#2a2a2a;color:#9aa0a6}' +
      '.fin-ps{background:#2a2a2a;color:#9aa0a6}' +
      '.fin-eff,.fin-short .fin-stat{background:#242424}.fin-effbar{background:#333}' +
      '.fin-effm .v{color:#e8eaed}.fin-effm .k{color:#9aa0a6}' +
      '.fin-hc.empty{background:#2a2a2a}.fin-hc.hr{color:#9aa0a6}' +
      '.fin-advice{background:rgba(138,180,248,.08);border-color:rgba(138,180,248,.2)}.fin-advice li{color:#c8ccd2}' +
      '.fin-card,.fin-catcell,.fin-stat,.fin-form{background:#242424}' +
      '.fin-card .lbl,.fin-stat .lbl,.fin-catcell .nm{color:#9aa0a6}.fin-card .val,.fin-stat .val,.fin-catcell .am{color:#e8eaed}' +
      '.fin-exprow .t1{color:#e8eaed}.fin-chip{background:#2a2a2a;border-color:rgba(255,255,255,.15);color:#c8ccd2}' +
      '.fin-inp{background:#2a2a2a;border-color:rgba(255,255,255,.15);color:#e8eaed}.fin-cancel{background:#333;color:#c8ccd2}' +
      '.fin-sec{color:#9aa0a6}}';
    document.head.appendChild(s);
  }

  function ensureSheet() {
    injectCss();
    var sheet = document.getElementById('finance-sheet');
    if (sheet) return sheet;
    sheet = document.createElement('div');
    sheet.id = 'finance-sheet';
    sheet.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-header"><span>收支報表</span>' +
      '<button class="sheet-close" onclick="closeFinance()">✕</button></div>' +
      '<div class="fin-pseg">' +
      PSEG.map(function (p) { return '<button id="fin-ps-' + p.k + '" class="fin-ps" onclick="MaptripFinance.setPeriod(\'' + p.k + '\')">' + p.t + '</button>'; }).join('') +
      '</div>' +
      '<div class="fin-mbar"><button onclick="MaptripFinance.shiftPeriod(-1)">‹</button>' +
      '<span id="fin-period-label"></span>' +
      '<button onclick="MaptripFinance.shiftPeriod(1)">›</button></div>' +
      '<div class="fin-tabs">' +
      '<button id="fin-tab-io" class="fin-tab active" onclick="MaptripFinance.tab(\'io\')">收支</button>' +
      '<button id="fin-tab-an" class="fin-tab" onclick="MaptripFinance.tab(\'an\')">分析</button></div>' +
      '<div id="finance-body"></div>';
    document.body.appendChild(sheet);
    return sheet;
  }

  // ---------- 渲染 ----------
  function monthLabel(m) {
    var p = m.split('-'); return p[0] + ' 年 ' + parseInt(p[1], 10) + ' 月';
  }

  function render() {
    var ctx = curAnalysis();
    _lastCtx = ctx;
    var lbl = document.getElementById('fin-period-label');
    if (lbl) lbl.textContent = ctx.info.label;
    PSEG.forEach(function (p) { var b = document.getElementById('fin-ps-' + p.k); if (b) b.classList.toggle('on', _ptype === p.k); });
    document.getElementById('fin-tab-io').classList.toggle('active', _view === 'io');
    document.getElementById('fin-tab-an').classList.toggle('active', _view === 'an');
    var body = document.getElementById('finance-body');
    body.innerHTML = _view === 'io' ? renderIO(ctx) : renderAnalytics(ctx);
    if (_view === 'an') { hydratePickupNames(); bindChartTips(); }
  }

  // 點一下長條圖看金額（手機沒有 hover，title 看不到）：按一下顯示金額氣泡，
  // 再按同一根 / 按別處 / 捲動 / 4 秒後自動收起。事件委派綁在 #finance-body（跨 render 不變），
  // 氣泡掛 document.body（不被 overflow 裁切）。
  function bindChartTips() {
    var body = document.getElementById('finance-body');
    if (!body || body._tipBound) return;
    body._tipBound = true;

    var tip = document.getElementById('fin-tip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'fin-tip'; tip.style.display = 'none'; document.body.appendChild(tip); }
    var active = null, autoHide = null;

    function show(bar) {
      var txt = bar.getAttribute('data-tip'); if (!txt) return;
      if (active) active.classList.remove('press');
      active = bar; bar.classList.add('press');
      tip.textContent = txt; tip.style.display = 'block';
      var r = bar.getBoundingClientRect(), tr = tip.getBoundingClientRect();
      var left = r.left + r.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
      var top = r.top - tr.height - 8;
      if (top < 8) top = r.bottom + 8;           // 太靠頂就顯示在長條下方
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(top) + 'px';
      clearTimeout(autoHide); autoHide = setTimeout(hide, 4000);   // 4 秒自動收起
    }
    function hide() {
      clearTimeout(autoHide); autoHide = null;
      tip.style.display = 'none';
      if (active) { active.classList.remove('press'); active = null; }
    }
    tip._finHide = hide;   // 供測試/外部收起

    // 按一下長條 → 顯示；再按同一根 / 按內容其他地方 → 收起
    body.addEventListener('click', function (e) {
      var bar = e.target.closest && e.target.closest('.fin-bar, .fin-hc.cell');
      if (!bar) { hide(); return; }
      if (bar === active) { hide(); return; }
      show(bar);
    });
    body.addEventListener('scroll', hide, { passive: true });
    // 點到報表內容以外（關閉/其他區域）也收起
    document.addEventListener('click', function (e) {
      if (!active) return;
      var inBody = e.target.closest && e.target.closest('#finance-body');
      if (!inBody) hide();
    });
  }

  function renderIO(ctx) {
    ctx = ctx || curAnalysis();
    var m = ctx.a.money, exp = ctx.exps;
    var deduct = m.comm + m.disp;   // 抽成 + 叫車費（公司抽走）
    var net = m.fare - deduct - exp.total;
    var h = '';
    h += '<div class="fin-net"><div class="lbl">淨收入（營收 − 抽成 − 支出）</div>' +
      '<div class="val">NT$ ' + nf(net) + '</div>' +
      '<div class="sub"><span>現金 ' + nf(m.cash) + '</span><span>刷卡 ' + nf(m.card) + '</span>' +
      '<span>' + m.trips + ' 趟</span></div></div>';
    h += '<div class="fin-row2">' +
      '<div class="fin-card"><div class="lbl">營收</div><div class="val rev">' + nf(m.fare) + '</div></div>' +
      '<div class="fin-card"><div class="lbl">抽成/叫車</div><div class="val exp">' + nf(deduct) + '</div></div>' +
      '<div class="fin-card"><div class="lbl">支出</div><div class="val exp">' + nf(exp.total) + '</div></div></div>';

    // 更新記帳者抽成：主動抓一次雲端抽成套進本機（記帳者填的抽成 → 這裡才看得到）
    h += '<button class="fin-pull-btn" onclick="MaptripFinance.pullComm()">↻ 更新記帳者填的抽成</button>';

    h += '<div class="fin-sec">支出分類</div><div class="fin-catgrid">';
    CATS.forEach(function (c) {
      var amt = exp.byCat[c.k] || 0;
      h += '<div class="fin-catcell"><span class="ic">' + c.icon + '</span>' +
        '<span class="nm">' + c.label + '</span><span class="am">' + (amt ? nf(amt) : '—') + '</span></div>';
    });
    h += '</div>';

    h += _addOpen ? renderAddForm() :
      '<button class="fin-add-btn" onclick="MaptripFinance.toggleAdd(true)">＋ 記一筆支出</button>';

    h += '<div class="fin-sec">明細（' + exp.rows.length + '）</div>';
    if (!exp.rows.length) {
      h += '<div class="fin-empty">本月尚無支出紀錄</div>';
    } else {
      h += '<div class="fin-explist">';
      exp.rows.forEach(function (e) {
        var c = CAT_MAP[e.cat] || CAT_MAP.other;
        h += '<div class="fin-exprow"><span class="ic">' + c.icon + '</span>' +
          '<div class="mid"><div class="t1">' + c.label + (e.note ? '：' + esc(e.note) : '') + '</div>' +
          '<div class="t2">' + e.day + '</div></div>' +
          '<span class="am">-' + nf(e.amount) + '</span>' +
          // id 現在是字串（<uid>_<ts>）→ 一定要加引號，否則 onclick 把它當變數→ReferenceError 刪不掉。
          '<button class="del" onclick="MaptripFinance.delExp(\'' + esc(String(e.id)) + '\')">🗑</button></div>';
      });
      h += '</div>';
    }
    return h;
  }

  var _formCat = 'fuel';
  function renderAddForm() {
    var chips = CATS.map(function (c) {
      return '<span class="fin-chip' + (c.k === _formCat ? ' on' : '') + '" onclick="MaptripFinance.pickCat(\'' + c.k + '\')">' +
        c.icon + ' ' + c.label + '</span>';
    }).join('');
    var info = curInfo();
    var defDay = info.inRange(curToday()) ? curToday() : info.start;
    return '<div class="fin-form">' +
      '<div class="fin-chips">' + chips + '</div>' +
      '<input class="fin-inp" id="fin-amt" type="number" inputmode="numeric" placeholder="金額 (NT$)">' +
      '<input class="fin-inp" id="fin-note" type="text" placeholder="備註（選填，如：中油加滿）">' +
      '<input class="fin-inp" id="fin-day" type="date" value="' + defDay + '">' +
      '<div class="fin-form-btns">' +
      '<button class="fin-cancel" onclick="MaptripFinance.toggleAdd(false)">取消</button>' +
      '<button class="fin-ok" onclick="MaptripFinance.saveAdd()">確定</button></div></div>';
  }

  // 熱力圖顯示順序（週一..週日）與短標籤
  var HEAT_DOW = [1, 2, 3, 4, 5, 6, 0];
  var HEAT_WD = ['一', '二', '三', '四', '五', '六', '日'];
  var HEAT_BK = ['清晨', '早峰', '上午', '中午', '下午', '晚峰', '晚間', '深夜'];
  // 星期 × 時段 時薪熱力圖（綠＝高、紅＝低；空白＝該格無載客）
  function renderHeat(a) {
    var vals = [];
    a.heat.forEach(function (row) { row.forEach(function (c) { if (c.has && c.hr > 0) vals.push(c.hr); }); });
    var mn = vals.length ? Math.min.apply(null, vals) : 0;
    var mx = vals.length ? Math.max.apply(null, vals) : 1;
    var h = '<div class="fin-heat"><div class="fin-hc hh"></div>';
    HEAT_BK.forEach(function (lb) { h += '<div class="fin-hc hh">' + lb + '</div>'; });
    HEAT_DOW.forEach(function (dw, ri) {
      h += '<div class="fin-hc hr">' + HEAT_WD[ri] + '</div>';
      for (var b = 0; b < 8; b++) {
        var c = a.heat[dw][b];
        if (!c.has || c.hr <= 0) { h += '<div class="fin-hc empty"></div>'; continue; }
        var t = mx > mn ? (c.hr - mn) / (mx - mn) : 1;        // 0..1
        var hue = Math.round(120 * t);                        // 紅0 → 綠120
        var tip = HEAT_WD[ri] + ' ' + HEAT_BK[b] + '　NT$ ' + nf(c.hr) + '/hr';
        h += '<div class="fin-hc cell" title="' + tip + '" data-tip="' + tip + '" style="background:hsl(' + hue + ',62%,45%)"></div>';
      }
    });
    return h + '</div>';
  }

  function renderAnalytics(ctx) {
    ctx = ctx || curAnalysis();
    var a = ctx.a, m = a.money;
    var bestBucket = null;
    a.bucketHr.forEach(function (x) { if (x.hr > 0 && (!bestBucket || x.hr > bestBucket.hr)) bestBucket = x; });
    var bestLabel = bestBucket ? bestBucket.label : '—';

    var h = '<div class="fin-stats">' +
      '<div class="fin-stat"><div class="lbl">每小時淨收入</div><div class="val">NT$ ' + nf(a.perHrNet) + '</div></div>' +
      '<div class="fin-stat"><div class="lbl">每公里營收</div><div class="val">NT$ ' + a.perKm.toFixed(1) + '</div></div>' +
      '<div class="fin-stat"><div class="lbl">平均每趟</div><div class="val">NT$ ' + nf(a.perTrip) + '</div></div>' +
      '<div class="fin-stat"><div class="lbl">最賺時段</div><div class="val">' + bestLabel + '</div></div>' +
      '</div>';

    // 複製給 AI（核心：讓使用者把純統計貼到對話討論）
    h += '<button class="fin-ai-btn" onclick="MaptripFinance.copyAi()">📋 複製業績數據 · 給 AI 討論' +
      '<span class="sub">純統計、不含位置／個資，貼到對話即可要建議</span></button>';

    if (!m.trips) return h + '<div class="fin-empty">此期間尚無載客紀錄可分析</div>';

    // 時間效率
    var loadedPct = a.workMs > 0 ? Math.round((1 - a.idleRatio) * 100) : 0;
    var idlePct = 100 - loadedPct;
    h += '<div class="fin-sec">時間效率</div><div class="fin-eff">' +
      '<div class="fin-efflabs"><span class="ld">載客 ' + loadedPct + '%</span><span class="idl">空車 ' + idlePct + '%</span></div>' +
      '<div class="fin-effbar"><div class="ld" style="width:' + loadedPct + '%"></div><div class="idl" style="width:' + idlePct + '%"></div></div>' +
      '<div class="fin-effrow">' +
      '<div class="fin-effm"><div class="v">' + a.avgGapMin.toFixed(0) + ' 分</div><div class="k">趟間等待</div></div>' +
      '<div class="fin-effm"><div class="v">' + a.avgDeadKm.toFixed(1) + ' km</div><div class="k">下車後空跑</div></div>' +
      '<div class="fin-effm"><div class="v">NT$ ' + nf(a.loadedRate) + '</div><div class="k">載客時薪</div></div>' +
      '</div></div>';

    // 各時段時薪（8 條；點一下看明細）
    h += '<div class="fin-sec">各時段時薪 <span class="fin-hint">點一下看明細</span></div><div class="fin-chart"><div class="fin-bars bk">';
    var maxBk = Math.max.apply(null, a.bucketHr.map(function (x) { return x.hr; })) || 1;
    a.bucketHr.forEach(function (x) {
      var pct = Math.round(x.hr / maxBk * 100);
      var hot = bestBucket && x.label === bestBucket.label && x.hr > 0;
      var tip = x.label + '　NT$ ' + nf(x.hr) + '/hr　' + x.trips + ' 趟';
      h += '<div class="fin-bar" title="' + tip + '" data-tip="' + tip + '">' +
        '<div class="b' + (hot ? '' : ' dim') + '" style="height:' + pct + '%"></div>' +
        '<div class="cap">' + x.label + '</div></div>';
    });
    h += '</div></div>';

    // 星期 × 時段 時薪熱力圖
    h += '<div class="fin-sec">星期 × 時段 時薪熱力圖 <span class="fin-hint">綠＝高 · 紅＝低</span></div>';
    h += renderHeat(a);

    // 短趟盈虧
    h += '<div class="fin-sec">短趟盈虧（車資 &lt; NT$ ' + a.shortTh + '）</div><div class="fin-short">' +
      '<div class="fin-stat"><div class="lbl">短趟佔比</div><div class="val">' + Math.round(a.shortPct * 100) + '%</div></div>' +
      '<div class="fin-stat"><div class="lbl">短趟實際時薪</div><div class="val">NT$ ' + nf(a.shortEffHr) + '</div></div>' +
      '<div class="fin-stat"><div class="lbl">接駁空跑</div><div class="val">' + a.shortDeadKm.toFixed(1) + ' km</div></div>' +
      '</div>';

    // 行動建議（自動生成）
    var adv = PF().advice(a);
    h += '<div class="fin-sec">行動建議</div><div class="fin-advice"><ul>';
    adv.forEach(function (s) { h += '<li>' + esc(s) + '</li>'; });
    h += '</ul></div>';

    // 既有圖：各時段營收（24）＋各星期營收（7）
    h += '<div class="fin-sec">各時段營收 <span class="fin-hint">點一下看金額</span></div><div class="fin-chart"><div class="fin-bars">';
    var maxH = Math.max.apply(null, a.byHour.map(function (x) { return x.fare; })) || 1;
    var bestH = -1, bv = 0; a.byHour.forEach(function (x, i) { if (x.fare > bv) { bv = x.fare; bestH = i; } });
    a.byHour.forEach(function (x, i) {
      var pct = Math.round(x.fare / maxH * 100);
      var cap = (i % 3 === 0) ? i : '';
      var tip = i + ':00–' + (i + 1) + ':00　NT$ ' + nf(x.fare) + '　' + x.n + ' 趟';
      h += '<div class="fin-bar" title="' + tip + '" data-tip="' + tip + '"><div class="b' + (i === bestH ? '' : ' dim') + '" style="height:' + pct + '%"></div><div class="cap">' + cap + '</div></div>';
    });
    h += '</div></div>';

    h += '<div class="fin-sec">各星期營收 <span class="fin-hint">點一下看金額</span></div><div class="fin-chart"><div class="fin-bars wd">';
    var maxW = Math.max.apply(null, a.byDow.map(function (x) { return x.fare; })) || 1;
    a.byDow.forEach(function (x, i) {
      var pct = Math.round(x.fare / maxW * 100);
      var tip = WD[i] + '　NT$ ' + nf(x.fare) + '　' + x.n + ' 趟';
      h += '<div class="fin-bar" title="' + tip + '" data-tip="' + tip + '"><div class="b" style="height:' + pct + '%"></div><div class="cap">' + WD[i].slice(1) + '</div></div>';
    });
    h += '</div></div>';

    h += renderPickups();
    return h;
  }

  // 上車熱點 × 時段（跨全部歷史，不受上方月份篩選）
  function renderPickups() {
    var pk = analyzePickups();
    _lastPk = pk;
    if (!pk.total) {
      return '<div class="fin-sec">上車熱點 × 時段</div>' +
        '<div class="fin-empty">還沒有足夠的上車紀錄可分析</div>';
    }
    var h = '<div class="fin-sec">各時段最熱上車點 <span class="pk-note">依全部歷史 · 共 ' + pk.total + ' 趟</span></div>';
    h += '<div class="pk-buckets">';
    var any = false;
    TBUCKETS.forEach(function (b, bi) {
      var arr = pk.byBucket[bi];
      if (!arr || !arr.length) return;
      any = true;
      var top = arr[0];
      h += '<div class="pk-brow">' +
        '<div class="pk-btime"><b>' + b.label + '</b><span>' + bucketRange(b) + '</span></div>' +
        '<div class="pk-bplace">' + nameSpan(top) +
        '<span class="pk-cnt">' + top.buckets[bi] + ' 趟</span></div></div>';
    });
    if (!any) h += '<div class="fin-empty">上車點時間資料不足</div>';
    h += '</div>';

    h += '<div class="fin-sec">上車熱點排行</div><div class="pk-rank">';
    pk.clusters.slice(0, PK_TOP).forEach(function (c, i) {
      var pb = c.peakBucket >= 0 ? TBUCKETS[c.peakBucket].label : '—';
      h += '<div class="pk-rrow"><span class="pk-rk pk-rk' + (i < 3 ? i + 1 : 'x') + '">' + (i + 1) + '</span>' +
        '<div class="pk-rmid">' + nameSpan(c) +
        '<div class="pk-rsub">' + c.n + ' 趟 · 均 NT$ ' + nf(c.avgFare) + ' · 常在' + pb + '</div></div></div>';
    });
    h += '</div>';
    return h;
  }

  function esc(s) { return String(s).replace(/[<>&"]/g, function (m) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m]; }); }

  // ---------- 動作 ----------
  function open() {
    ensureSheet();
    bindExpenseSync();   // 確保雲端支出同步已啟動（首次會遷移舊資料＋訂閱）
    _anchor = _anchor || curToday();
    _view = 'io'; _addOpen = false;
    var fs = document.getElementById('finance-sheet');
    // 可拖曳展開（把手/標題列往上拉到全螢幕）；開啟時 reset 回預設高度
    try { if (window.MaptripSheetDrag) { MaptripSheetDrag.wire(fs, close); MaptripSheetDrag.reset(fs); } } catch (_) {}
    fs.classList.add('show');
    var ov = document.getElementById('sheet-overlay');
    if (ov) { ov.style.display = 'block'; ov.onclick = close; }
    render();
  }
  function close() {
    var s = document.getElementById('finance-sheet'); if (s) s.classList.remove('show');
    var ov = document.getElementById('sheet-overlay');
    if (ov) { ov.style.display = 'none'; ov.onclick = window.closeActiveSheet || null; }
    _addOpen = false;
  }
  // 期間切換（日/週/月/季/年）
  function setPeriod(t) {
    if (!PSEG.some(function (p) { return p.k === t; })) return;
    _ptype = t; _anchor = _anchor || curToday(); _addOpen = false; render();
  }
  // 上一個／下一個期間（依目前型態）
  function shiftPeriod(d) {
    var info = curInfo(); _anchor = d < 0 ? info.prev : info.next; _addOpen = false; render();
  }
  // 相容舊呼叫：切到「月」再移動
  function shiftMonth(d) { setPeriod('month'); shiftPeriod(d); }
  function tab(v) { _view = v; _addOpen = false; render(); }
  // 複製業績數據給 AI 討論（純統計、不含座標/個資）
  function copyText(t) {
    function okToast() { if (window.toast) toast('已複製業績數據，貼到對話即可討論'); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(okToast, function () { fallbackCopy(t, okToast); });
        return;
      }
    } catch (_) {}
    fallbackCopy(t, okToast);
  }
  function fallbackCopy(t, okToast) {
    try {
      var ta = document.createElement('textarea'); ta.value = t;
      ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); okToast();
    } catch (_) { if (window.toast) toast('複製失敗，請手動截圖'); }
  }
  function copyAi() {
    var ctx = _lastCtx || curAnalysis();
    var names = [];
    try {
      if (_lastPk && _lastPk.clusters) {
        names = _lastPk.clusters.slice(0, 5).map(function (c) { return (pickName(c) || '').trim(); })
          .filter(function (s) { return s && s !== '未命名地點'; });
      }
    } catch (_) {}
    copyText(PF().aiText(ctx.a, ctx.info.label, names));
  }
  // 主動抓一次記帳者填的抽成（雲端 commissions），套進本機各趟後重畫報表。
  function pullComm() {
    if (!(window.MaptripSync && MaptripSync.pullCommissions)) { if (window.toast) toast('雲端未啟用'); return; }
    if (!MaptripSync.myUid || !MaptripSync.myUid()) { if (window.toast) toast('請先登入雲端同步'); return; }
    if (window.toast) toast('更新中…');
    MaptripSync.pullCommissions().then(function (n) {
      render();
      if (window.toast) toast(n > 0 ? ('已更新 ' + n + ' 筆抽成') : '沒有新的抽成');
    }).catch(function (e) {
      if (window.toast) toast('更新失敗：' + ((e && e.code) || (e && e.message) || '未知'));
    });
  }
  function toggleAdd(on) { _addOpen = on; render(); if (on) setTimeout(function () { var el = document.getElementById('fin-amt'); if (el) el.focus(); }, 60); }
  function pickCat(k) { _formCat = k; render(); }
  function saveAdd() {
    var amt = parseInt((document.getElementById('fin-amt') || {}).value, 10);
    if (!amt || amt <= 0) { if (window.toast) toast('請輸入金額'); return; }
    var note = ((document.getElementById('fin-note') || {}).value || '').trim();
    var day = (document.getElementById('fin-day') || {}).value || (window.todayKey ? todayKey() : _month + '-01');
    var uid = myUid();
    var id = (uid || 'local') + '_' + Date.now();
    var rec = { id: id, cat: _formCat, amount: amt, note: note, day: day, ts: Date.now() };
    var list = loadExp();
    list.push(rec);
    saveExp(list);                                   // 樂觀更新快取（離線也先看得到）
    _addOpen = false;
    // 若記到目前期間之外，把錨點移到那天才看得到（保持目前期間型態）
    if (!curInfo().inRange(day)) _anchor = day;
    render();
    if (window.toast) toast('已記錄支出 NT$ ' + nf(amt));
    // 推雲端（成功後 onSnapshot 會再回填一次，冪等）。離線／未登入就只留快取。
    var s = S();
    if (s && uid && s.writeExpense) { s.writeExpense(uid, rec).catch(function () {}); }
  }
  function delExp(id) {
    if (!confirm('刪除這筆支出？')) return;
    // 用字串比對：新 id 是字串、舊快取可能還是數字，String() 兩邊都吃得到。
    saveExp(loadExp().filter(function (e) { return String(e.id) !== String(id); }));   // 樂觀更新快取
    render();
    var s = S(), uid = myUid();
    if (s && uid && s.deleteExpense) { s.deleteExpense(uid, id).catch(function () {}); }
  }

  window.MaptripFinance = { open: open, close: close, shiftMonth: shiftMonth, tab: tab, toggleAdd: toggleAdd, pickCat: pickCat, saveAdd: saveAdd, delExp: delExp,
    setPeriod: setPeriod, shiftPeriod: shiftPeriod, copyAi: copyAi,   // 業績分析：期間切換＋複製給 AI（v1.1.468）
    bindExpenseSync: bindExpenseSync, resetExpenseSync: resetExpenseSync,
    CATS: CATS, CAT_MAP: CAT_MAP,   // 供 bookkeeper.js 沿用同一套支出分類（單一來源）
    monthReport: monthReport,       // 單一算錢來源：記帳者月報表與 finance 共用
    _analyzePickups: analyzePickups, _bucketIndexOf: bucketIndexOf, _pickName: pickName,
    pullComm: pullComm,                // 收支頁「更新記帳者抽成」鈕
    _bindChartTips: bindChartTips };   // 供測試：長條圖點一下看金額
  window.openFinance = open;
  window.closeFinance = close;
})();
