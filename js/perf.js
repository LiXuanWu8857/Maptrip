// perf.js — 業績分析計算（MaptripPerf，純函式、可測）。
// 吃「已併入手動趟的 days」＋一組日 key，算出：期間金額、時間效率（載客/空車/空跑）、
// 各時段時薪、星期×時段時薪熱力圖、短趟盈虧、行動建議、以及「複製給 AI」的文字摘要。
// 不碰 DOM、不打網路；距離用 MaptripUtil.haversine、工時用 MaptripUtil.workMs（單一來源）。
(function (global) {
  'use strict';

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
  var WD = ['日', '一', '二', '三', '四', '五', '六'];   // getDay() 0=日
  var REST_MS = 90 * 60000;     // 與 util.workMs 同門檻（>90 分空檔＝休息、不算工時）
  var SHORT_TH = 150;           // 短趟門檻（元）

  function U() { return global.MaptripUtil; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateOf(key) { var p = String(key).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dowOf(key) { return dateOf(key).getDay(); }
  function hourOf(ts) { return new Date(ts).getHours(); }
  function keyOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function addDays(key, n) { var d = dateOf(key); d.setDate(d.getDate() + n); return keyOf(d); }
  function avg(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }

  // 時段 index（0-23 → 0-7）；深夜段 22–隔日5 跨午夜
  function bucketOf(h) {
    for (var i = 0; i < TBUCKETS.length; i++) {
      var b = TBUCKETS[i];
      if (b.s < b.e) { if (h >= b.s && h < b.e) return i; }
      else { if (h >= b.s || h < b.e) return i; }   // 跨午夜
    }
    return 7;
  }

  // ---------- 期間 ----------
  // type ∈ day/week/month/quarter/year；anchor='YYYY-MM-DD'。
  // 回 { start, end(不含), label, prev, next, inRange(key) }；日期字串可直接字典序比較。
  function periodInfo(type, anchor) {
    var d = dateOf(anchor), y = d.getFullYear(), m = d.getMonth(), start, end, label, prev, next;
    if (type === 'day') {
      start = anchor; end = addDays(anchor, 1); label = anchor + '（' + WD[dowOf(anchor)] + '）';
      prev = addDays(anchor, -1); next = addDays(anchor, 1);
    } else if (type === 'week') {
      var wd = dowOf(anchor), off = (wd === 0 ? 6 : wd - 1);   // 週一為首
      start = addDays(anchor, -off); end = addDays(start, 7);
      var last = addDays(start, 6);
      label = start.slice(5).replace('-', '/') + '–' + last.slice(5).replace('-', '/');
      prev = addDays(start, -7); next = addDays(start, 7);
    } else if (type === 'quarter') {
      var q = Math.floor(m / 3), sm = q * 3;
      start = y + '-' + pad2(sm + 1) + '-01';
      var ed = new Date(y, sm + 3, 1); end = keyOf(ed);
      label = y + ' 年 Q' + (q + 1);
      prev = keyOf(new Date(y, sm - 3, 1)); next = keyOf(new Date(y, sm + 3, 1));
    } else if (type === 'year') {
      start = y + '-01-01'; end = (y + 1) + '-01-01'; label = y + ' 年';
      prev = (y - 1) + '-01-01'; next = (y + 1) + '-01-01';
    } else { // month
      start = y + '-' + pad2(m + 1) + '-01';
      end = keyOf(new Date(y, m + 1, 1));
      label = y + ' 年 ' + (m + 1) + ' 月';
      prev = keyOf(new Date(y, m - 1, 1)); next = keyOf(new Date(y, m + 1, 1));
    }
    return { type: type, start: start, end: end, label: label, prev: prev, next: next,
      inRange: function (key) { return key >= start && key < end; } };
  }

  // 從 days 取出落在期間內、且有資料的日 key（排序）
  function keysInRange(days, info) {
    return Object.keys(days || {}).filter(function (k) {
      return info.inRange(k) && (days[k] || []).length;
    }).sort();
  }

  // ---------- 金額（與 finance.monthReport 同口徑；以明確 key 集合計）----------
  // 注意：expenses 需由呼叫端「先依期間過濾好」再傳入（這裡全部加總）——
  // 因為 keys 只含「有趟的日子」，若用 keys 濾支出，落在無趟日的支出會被漏算。
  function money(days, keys, commissions, expenses) {
    var fare = 0, cash = 0, card = 0, voucher = 0, comm = 0, disp = 0, dist = 0, trips = 0, tip = 0;
    keys.forEach(function (day) {
      (days[day] || []).forEach(function (t) {
        if (t.paymentMethod === 'other') return;
        if (t.cancelCollect) { var a = t.fare || 0; cash += a; card -= a; return; }   // 代收取消費：淨 0
        var f = t.fare || 0; fare += f; dist += t.totalDist || 0; trips++;
        var c = commissions && commissions[String(t.id)];
        comm += (c && c.commission != null) ? c.commission : (t.commission || 0);
        disp += (c && c.dispatch != null) ? c.dispatch : (t.dispatch || 0);
        if (t.paymentMethod === 'card') card += f;
        else if (t.paymentMethod === 'voucher') { card += f; voucher += f; }
        else cash += f;
        var tp = t.tip || 0; if (tp) { fare += tp; tip += tp; if ((t.tipMethod || 'cash') === 'card') card += tp; else cash += tp; }
      });
    });
    var expTotal = 0;
    (expenses || []).forEach(function (e) { expTotal += e.amount || 0; });   // 呼叫端已依期間過濾
    return { fare: fare, cash: cash, card: card, voucher: voucher, comm: comm, disp: disp,
      expTotal: expTotal, net: fare - comm - disp - expTotal, dist: dist, trips: trips, tip: tip };
  }

  // 計入營收的趟（非「其他」、非代收取消費）
  function isFareTrip(t) { return t && t.paymentMethod !== 'other' && !t.cancelCollect; }
  // 可算「時間效率/空跑」的 GPS 趟：有起訖時間與時長、有座標、非取消/其他/代收
  function isGps(t) {
    return t && t.startTime && t.endTime && t.endTime > t.startTime &&
      t.paymentMethod !== 'other' && !t.cancelCollect && !t.cancelFee &&
      Array.isArray(t.coords) && t.coords.length >= 1;
  }
  function wm(arr, restMin) { try { return U().workMs(arr, restMin || 0); } catch (_) { return 0; } }
  function firstC(t) { return t.coords[0]; }
  function lastC(t) { return t.coords[t.coords.length - 1]; }

  // 建議班表：從 7×8 熱力圖挑「明顯高於平均＝建議多出車」與「明顯低於＝可休息」的格。
  // refHr＝整體營收時薪；門檻 ±15%。**最少 2 趟**才納入（避免某天一張幸運長程被當常態）；
  // 可用格太少時放寬到 ≥1 趟。各取最多 4 格。
  function scheduleFrom(heat, refHr) {
    function collect(minN) {
      var out = [];
      heat.forEach(function (row, dw) {
        row.forEach(function (c, b) { if (c.has && c.hr > 0 && (c.n || 0) >= minN) out.push({ dw: dw, b: b, hr: c.hr, n: c.n || 0 }); });
      });
      return out;
    }
    var cells = collect(2);
    if (cells.length < 4) cells = collect(1);
    cells.sort(function (a, b) { return b.hr - a.hr; });
    var hi = refHr * 1.15, lo = refHr * 0.85;
    var go = cells.filter(function (c) { return c.hr >= hi; }).slice(0, 4);
    var restAll = cells.filter(function (c) { return c.hr <= lo; });
    var rest = restAll.slice(Math.max(0, restAll.length - 4)).reverse();   // 最低的在前
    return { go: go, rest: rest };
  }

  // ---------- 核心分析 ----------
  // opts: { commissions, expenses, restMinOf(day)->分鐘, shortThreshold }
  function analyze(days, keys, opts) {
    opts = opts || {};
    var commissions = opts.commissions || {}, expenses = opts.expenses || [];
    var restMinOf = opts.restMinOf || function () { return 0; };
    var shortTh = opts.shortThreshold || SHORT_TH;
    var m = money(days, keys, commissions, expenses);

    var workMsTotal = 0, loadedMs = 0;
    var byHour = []; for (var i = 0; i < 24; i++) byHour.push({ fare: 0, n: 0 });
    var byDow = []; for (i = 0; i < 7; i++) byDow.push({ fare: 0, n: 0 });
    var buckRev = [0,0,0,0,0,0,0,0], buckWork = [0,0,0,0,0,0,0,0], buckN = [0,0,0,0,0,0,0,0];
    var cellRev = {}, cellWork = {}, cellN = {};   // "dow-bucket"
    var gaps = [], deads = [];
    var fareN = 0, shortN = 0, shortRev = 0, shortLoadMs = 0, shortGapMs = 0, shortDeadKm = 0, shortDeadN = 0;

    keys.forEach(function (day) {
      var arr = (days[day] || []);
      workMsTotal += wm(arr, restMinOf(day));
      var gps = arr.filter(isGps).slice().sort(function (a, b) { return a.startTime - b.startTime; });
      gps.forEach(function (t) { loadedMs += (t.endTime - t.startTime); });

      // 分時段（以起點 hour 分桶）
      var byB = {};
      gps.forEach(function (t) { var b = bucketOf(hourOf(t.startTime)); (byB[b] = byB[b] || []).push(t); });
      var dw = dowOf(day);
      Object.keys(byB).forEach(function (bk) {
        var b = +bk, g = byB[bk];
        var rev = g.reduce(function (s, t) { return s + (t.fare || 0) + (t.tip || 0); }, 0);
        var w = wm(g, 0);   // 該段趟的 span 扣長休息＝該段工時
        buckRev[b] += rev; buckWork[b] += w; buckN[b] += g.length;
        var ck = dw + '-' + b;
        cellRev[ck] = (cellRev[ck] || 0) + rev; cellWork[ck] = (cellWork[ck] || 0) + w;
        cellN[ck] = (cellN[ck] || 0) + g.length;
      });

      // 各時段/星期營收（沿用既有圖，含所有計入營收的趟）
      arr.forEach(function (t) {
        if (!isFareTrip(t) || !t.startTime) return;
        var f = (t.fare || 0) + (t.tip || 0);
        byHour[hourOf(t.startTime)].fare += f; byHour[hourOf(t.startTime)].n++;
        byDow[dw].fare += f; byDow[dw].n++;
      });

      // 空跑/等待（相鄰 GPS 趟）
      for (var j = 1; j < gps.length; j++) {
        var A = gps[j - 1], B = gps[j], g = B.startTime - A.endTime;
        if (g > 0 && g < REST_MS) {
          gaps.push(g / 60000);
          var ac = lastC(A), bc = firstC(B);
          if (ac && bc && ac.lat != null && bc.lat != null) deads.push(U().haversine(ac, bc) / 1000);
        }
      }

      // 短趟盈虧
      gps.forEach(function (t, idx) {
        var f = t.fare || 0; if (f <= 0) return; fareN++;
        if (f < shortTh) {
          shortN++; shortRev += f; shortLoadMs += (t.endTime - t.startTime);
          if (idx > 0) {
            var prev = gps[idx - 1], gg = t.startTime - prev.endTime;
            if (gg > 0 && gg < REST_MS) {
              shortGapMs += gg;
              var pc = lastC(prev), cc = firstC(t);
              if (pc && cc && pc.lat != null && cc.lat != null) { shortDeadKm += U().haversine(pc, cc) / 1000; shortDeadN++; }
            }
          }
        }
      });
    });

    var workH = workMsTotal / 3600000;
    var idleMs = Math.max(0, workMsTotal - loadedMs);
    var bucketHr = TBUCKETS.map(function (b, k) {
      return { label: b.label, s: b.s, e: b.e, hr: buckWork[k] > 0 ? buckRev[k] / (buckWork[k] / 3600000) : 0, trips: buckN[k], rev: buckRev[k] };
    });
    var heat = [];
    for (var d2 = 0; d2 < 7; d2++) {
      var row = [];
      for (var b2 = 0; b2 < 8; b2++) {
        var ck2 = d2 + '-' + b2, w2 = cellWork[ck2] || 0;
        row.push({ hr: w2 > 0 ? (cellRev[ck2] || 0) / (w2 / 3600000) : 0, has: w2 > 0, n: cellN[ck2] || 0 });
      }
      heat.push(row);
    }
    var best = null, worst = null;
    heat.forEach(function (r, dw2) { r.forEach(function (c, b3) {
      if (!c.has || c.hr <= 0) return;
      if (!best || c.hr > best.hr) best = { hr: c.hr, dw: dw2, b: b3 };
      if (!worst || c.hr < worst.hr) worst = { hr: c.hr, dw: dw2, b: b3 };
    }); });
    var refHr = workH > 0.02 ? m.fare / workH : 0;
    var schedule = scheduleFrom(heat, refHr);

    return {
      money: m, workMs: workMsTotal, loadedMs: loadedMs, idleMs: idleMs,
      idleRatio: workMsTotal > 0 ? idleMs / workMsTotal : 0,
      perHrNet: workH > 0.02 ? m.net / workH : 0,
      perHrGross: refHr,
      schedule: schedule,
      loadedRate: loadedMs > 0 ? m.fare / (loadedMs / 3600000) : 0,
      perKm: m.dist > 0 ? m.fare / (m.dist / 1000) : 0,
      perTrip: m.trips > 0 ? m.fare / m.trips : 0,
      avgGapMin: avg(gaps), avgDeadKm: avg(deads),
      byHour: byHour, byDow: byDow, bucketHr: bucketHr, heat: heat, best: best, worst: worst,
      shortTh: shortTh, shortN: shortN, shortPct: fareN > 0 ? shortN / fareN : 0,
      shortDeadKm: shortDeadN ? shortDeadKm / shortDeadN : 0,
      shortEffHr: (shortLoadMs + shortGapMs) > 0 ? shortRev / ((shortLoadMs + shortGapMs) / 3600000) : 0
    };
  }

  function cellName(cell) { return '週' + WD[cell.dw] + ' ' + TBUCKETS[cell.b].label; }
  function nf(n) { return Math.round(n || 0).toLocaleString(); }

  // 行動建議（從數據自動生成；回字串陣列）
  function advice(a) {
    var out = [];
    if (a.best && a.worst && a.best !== a.worst) {
      out.push('你最賺：' + cellName(a.best) + ' NT$' + nf(a.best.hr) + '/hr；最不賺：' +
        cellName(a.worst) + ' NT$' + nf(a.worst.hr) + '/hr。多排前者、少耗後者。');
    }
    if (a.idleRatio >= 0.35) {
      out.push('空車率 ' + Math.round(a.idleRatio * 100) + '% 偏高（出車時間有這麼多在空車/等客）。' +
        '把「下車後空跑」壓低、往下一個熱點方向移動，時薪最有感。');
    }
    if (a.shortPct >= 0.25 && a.shortEffHr > 0) {
      out.push('短趟（<NT$' + a.shortTh + '）佔 ' + Math.round(a.shortPct * 100) + '%，實際時薪只約 NT$' +
        nf(a.shortEffHr) + '。低需求時段的短趟盡量在熱區接（空跑短才划算）。');
    }
    if (!out.length) out.push('資料量再多一點，建議會更準。先確保每趟都有按開始/結束，時間才抓得到。');
    return out;
  }

  // 複製給 AI 的文字摘要（純統計、不含座標/個資）
  function aiText(a, periodLabel, topPlaces) {
    var m = a.money, L = [];
    L.push('【Maptrip 業績數據 · ' + (periodLabel || '') + '】');
    L.push('營收 ' + nf(m.fare) + ' / 淨收入 ' + nf(m.net) + '（抽成 ' + nf(m.comm) + ' 叫車 ' + nf(m.disp) + ' 支出 ' + nf(m.expTotal) + '）');
    L.push('趟數 ' + m.trips + ' / 里程 ' + (m.dist / 1000).toFixed(1) + ' km / 工時 ' + (a.workMs / 3600000).toFixed(1) + ' 小時');
    L.push('時薪：淨 ' + nf(a.perHrNet) + ' / 營收 ' + nf(a.perHrGross) + '；每公里 ' + a.perKm.toFixed(1) + '；每趟 ' + nf(a.perTrip));
    L.push('時間效率：載客 ' + Math.round((1 - a.idleRatio) * 100) + '% / 空車 ' + Math.round(a.idleRatio * 100) + '%；趟間等待 ' + a.avgGapMin.toFixed(1) + ' 分；下車後空跑 ' + a.avgDeadKm.toFixed(1) + ' km；載客時薪 ' + nf(a.loadedRate));
    L.push('各時段時薪：' + a.bucketHr.map(function (x) { return x.label + ' ' + nf(x.hr); }).join('、'));
    if (a.best) L.push('最賺：' + cellName(a.best) + ' ' + nf(a.best.hr) + '/hr');
    if (a.worst) L.push('最不賺：' + cellName(a.worst) + ' ' + nf(a.worst.hr) + '/hr');
    if (a.schedule && a.schedule.go.length) L.push('建議多出車：' + a.schedule.go.map(function (c) { return cellName(c) + ' ' + nf(c.hr) + '/hr(' + c.n + '趟)'; }).join('、'));
    if (a.schedule && a.schedule.rest.length) L.push('建議可休息：' + a.schedule.rest.map(function (c) { return cellName(c) + ' ' + nf(c.hr) + '/hr'; }).join('、'));
    L.push('短趟<' + a.shortTh + '：佔 ' + Math.round(a.shortPct * 100) + '%、實際時薪 ' + nf(a.shortEffHr) + '、接駁空跑 ' + a.shortDeadKm.toFixed(1) + ' km');
    if (topPlaces && topPlaces.length) L.push('常見上車點：' + topPlaces.slice(0, 5).join('、'));
    L.push('請用上面數據，具體建議我怎麼安排班表/走位來拉高時薪與載客。');
    return L.join('\n');
  }

  global.MaptripPerf = {
    TBUCKETS: TBUCKETS, WD: WD, SHORT_TH: SHORT_TH,
    periodInfo: periodInfo, keysInRange: keysInRange, money: money, analyze: analyze,
    advice: advice, aiText: aiText, cellName: cellName,
    _bucketOf: bucketOf, _dowOf: dowOf, _addDays: addDays, _scheduleFrom: scheduleFrom   // 供測試
  };
})(typeof window !== 'undefined' ? window : globalThis);
