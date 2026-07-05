// finance.js — 收支報表（支出記錄 + 淨收入）與效率分析
// 自成一檔：注入樣式、動態建立面板 DOM，只靠 app.js 的全域函式
// （loadTrips / businessDayKey / todayKey / fmtDist / toast / workMs / getRestMin）。
(function () {
  'use strict';
  var TEST = /(?:\?|&)test\b/.test(location.search);
  var EXPENSE_KEY = TEST ? 'maptrip_expenses_test' : 'maptrip_expenses';

  var CATS = [
    { k: 'fuel',      label: '加油',      icon: '⛽' },
    { k: 'maintain',  label: '保養維修',  icon: '🔧' },
    { k: 'rent',      label: '靠行/租金', icon: '🏢' },
    { k: 'insurance', label: '保險',      icon: '🛡️' },
    { k: 'toll',      label: '停車/過路', icon: '🅿️' },
    { k: 'meal',      label: '餐飲',      icon: '🍱' },
    { k: 'other',     label: '其他',      icon: '📦' }
  ];
  var CAT_MAP = {}; CATS.forEach(function (c) { CAT_MAP[c.k] = c; });
  var WD = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

  var _month = null;       // 'YYYY-MM'（目前檢視月份）
  var _view = 'io';        // 'io'（收支）/ 'an'（分析）
  var _addOpen = false;

  // ---------- 資料 ----------
  function loadExp() { try { return JSON.parse(localStorage.getItem(EXPENSE_KEY) || '[]'); } catch (_) { return []; } }
  function saveExp(list) { try { localStorage.setItem(EXPENSE_KEY, JSON.stringify(list)); } catch (_) {} }
  function monthOf(dayKey) { return String(dayKey || '').slice(0, 7); }
  function curMonth() { return monthOf(window.todayKey ? todayKey() : new Date().toISOString().slice(0, 10)); }
  function nf(n) { return (Math.round(n) || 0).toLocaleString(); }

  // 某月營收（載客車資，排除「其他」）＋里程＋趟數＋現金/刷卡
  function revenueOfMonth(month) {
    var raw = (window.loadTrips ? loadTrips() : {}) || {};
    var fare = 0, cash = 0, card = 0, dist = 0, trips = 0, workMs = 0;
    Object.keys(raw).forEach(function (day) {
      if (monthOf(day) !== month) return;
      var arr = raw[day] || [];
      arr.forEach(function (t) {
        if (t.paymentMethod === 'other') return;
        var f = t.fare || 0; fare += f; dist += t.totalDist || 0; trips++;
        if (t.paymentMethod === 'card') card += f; else cash += f;
      });
      if (window.workMs && window.getRestMin) workMs += workMs0(arr, getRestMin(day));
    });
    return { fare: fare, cash: cash, card: card, dist: dist, trips: trips, workMs: workMs };
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

  // ---------- DOM ----------
  function injectCss() {
    if (document.getElementById('finance-css')) return;
    var s = document.createElement('style'); s.id = 'finance-css';
    s.textContent =
      '#finance-sheet{position:fixed;bottom:0;left:0;right:0;max-height:82vh;background:#fff;' +
      'border-radius:20px 20px 0 0;border-top:1px solid rgba(0,0,0,0.08);z-index:31;display:none;' +
      'flex-direction:column;box-shadow:0 -4px 24px rgba(0,0,0,0.1);padding-bottom:env(safe-area-inset-bottom,0);animation:slideUp .25s ease}' +
      '#finance-sheet.show{display:flex}' +
      '.fin-mbar{display:flex;align-items:center;justify-content:center;gap:18px;padding:4px 0 8px}' +
      '.fin-mbar button{background:none;border:none;font-size:1.4rem;color:#1a73e8;cursor:pointer;padding:0 6px;line-height:1}' +
      '.fin-mbar span{font-size:1rem;font-weight:700;color:#202124;min-width:120px;text-align:center}' +
      '.fin-tabs{display:flex;gap:8px;padding:0 16px 8px}' +
      '.fin-tab{flex:1;padding:9px;border:none;border-radius:10px;background:#f1f3f4;color:#5f6368;font-weight:600;font-family:inherit;font-size:.9rem;cursor:pointer}' +
      '.fin-tab.active{background:#1a73e8;color:#fff}' +
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
      '@media (prefers-color-scheme: dark){' +
      '#finance-sheet{background:#1a1a1a;border-top-color:rgba(255,255,255,.07)}' +
      '.fin-mbar span{color:#e8eaed}.fin-tab{background:#2a2a2a;color:#9aa0a6}' +
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
      '<div class="fin-mbar"><button onclick="MaptripFinance.shiftMonth(-1)">‹</button>' +
      '<span id="fin-month-label"></span>' +
      '<button onclick="MaptripFinance.shiftMonth(1)">›</button></div>' +
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
    var lbl = document.getElementById('fin-month-label');
    if (lbl) lbl.textContent = monthLabel(_month);
    document.getElementById('fin-tab-io').classList.toggle('active', _view === 'io');
    document.getElementById('fin-tab-an').classList.toggle('active', _view === 'an');
    var body = document.getElementById('finance-body');
    body.innerHTML = _view === 'io' ? renderIO() : renderAnalytics();
  }

  function renderIO() {
    var rev = revenueOfMonth(_month);
    var exp = expensesOfMonth(_month);
    var net = rev.fare - exp.total;
    var h = '';
    h += '<div class="fin-net"><div class="lbl">淨收入（營收 − 支出）</div>' +
      '<div class="val">NT$ ' + nf(net) + '</div>' +
      '<div class="sub"><span>現金 ' + nf(rev.cash) + '</span><span>刷卡 ' + nf(rev.card) + '</span>' +
      '<span>' + rev.trips + ' 趟</span></div></div>';
    h += '<div class="fin-row2">' +
      '<div class="fin-card"><div class="lbl">營收</div><div class="val rev">' + nf(rev.fare) + '</div></div>' +
      '<div class="fin-card"><div class="lbl">支出</div><div class="val exp">' + nf(exp.total) + '</div></div></div>';

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
          '<button class="del" onclick="MaptripFinance.delExp(' + e.id + ')">🗑</button></div>';
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
    var defDay = (_month === curMonth() && window.todayKey) ? todayKey() : _month + '-01';
    return '<div class="fin-form">' +
      '<div class="fin-chips">' + chips + '</div>' +
      '<input class="fin-inp" id="fin-amt" type="number" inputmode="numeric" placeholder="金額 (NT$)">' +
      '<input class="fin-inp" id="fin-note" type="text" placeholder="備註（選填，如：中油加滿）">' +
      '<input class="fin-inp" id="fin-day" type="date" value="' + defDay + '">' +
      '<div class="fin-form-btns">' +
      '<button class="fin-cancel" onclick="MaptripFinance.toggleAdd(false)">取消</button>' +
      '<button class="fin-ok" onclick="MaptripFinance.saveAdd()">確定</button></div></div>';
  }

  function renderAnalytics() {
    var rev = revenueOfMonth(_month);
    var exp = expensesOfMonth(_month);
    var net = rev.fare - exp.total;
    var a = analyze(_month);
    var workH = rev.workMs / 3600000;
    var perHour = workH > 0.05 ? net / workH : 0;
    var perKm = rev.dist > 0 ? rev.fare / (rev.dist / 1000) : 0;
    var perTrip = rev.trips > 0 ? rev.fare / rev.trips : 0;
    // 最賺時段
    var bestH = -1, bestV = 0;
    a.byHour.forEach(function (x, i) { if (x.fare > bestV) { bestV = x.fare; bestH = i; } });
    var bestLabel = bestH < 0 ? '—' : (bestH + ':00–' + (bestH + 1) + ':00');

    var h = '<div class="fin-stats">' +
      '<div class="fin-stat"><div class="lbl">每小時淨收入</div><div class="val">NT$ ' + nf(perHour) + '</div></div>' +
      '<div class="fin-stat"><div class="lbl">每公里營收</div><div class="val">NT$ ' + perKm.toFixed(1) + '</div></div>' +
      '<div class="fin-stat"><div class="lbl">平均每趟</div><div class="val">NT$ ' + nf(perTrip) + '</div></div>' +
      '<div class="fin-stat"><div class="lbl">最賺時段</div><div class="val">' + bestLabel + '</div></div>' +
      '</div>';

    if (!rev.trips) return h + '<div class="fin-empty">本月尚無載客紀錄可分析</div>';

    // 每小時營收（24 條）
    h += '<div class="fin-sec">各時段營收</div><div class="fin-chart"><div class="fin-bars">';
    var maxH = Math.max.apply(null, a.byHour.map(function (x) { return x.fare; })) || 1;
    a.byHour.forEach(function (x, i) {
      var pct = Math.round(x.fare / maxH * 100);
      var cap = (i % 3 === 0) ? i : '';
      h += '<div class="fin-bar" title="' + i + ':00　' + nf(x.fare) + '（' + x.n + '趟）">' +
        '<div class="b' + (i === bestH ? '' : ' dim') + '" style="height:' + pct + '%"></div>' +
        '<div class="cap">' + cap + '</div></div>';
    });
    h += '</div></div>';

    // 星期幾營收（7 條）
    h += '<div class="fin-sec">各星期營收</div><div class="fin-chart"><div class="fin-bars wd">';
    var maxW = Math.max.apply(null, a.byDow.map(function (x) { return x.fare; })) || 1;
    a.byDow.forEach(function (x, i) {
      var pct = Math.round(x.fare / maxW * 100);
      h += '<div class="fin-bar" title="' + WD[i] + '　' + nf(x.fare) + '（' + x.n + '趟）">' +
        '<div class="b" style="height:' + pct + '%"></div>' +
        '<div class="cap">' + WD[i].slice(1) + '</div></div>';
    });
    h += '</div></div>';
    return h;
  }

  function esc(s) { return String(s).replace(/[<>&"]/g, function (m) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m]; }); }

  // ---------- 動作 ----------
  function open() {
    ensureSheet();
    _month = _month || curMonth();
    _view = 'io'; _addOpen = false;
    document.getElementById('finance-sheet').classList.add('show');
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
  function shiftMonth(d) {
    var p = _month.split('-'); var dt = new Date(+p[0], +p[1] - 1 + d, 1);
    _month = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
    _addOpen = false; render();
  }
  function tab(v) { _view = v; _addOpen = false; render(); }
  function toggleAdd(on) { _addOpen = on; render(); if (on) setTimeout(function () { var el = document.getElementById('fin-amt'); if (el) el.focus(); }, 60); }
  function pickCat(k) { _formCat = k; render(); }
  function saveAdd() {
    var amt = parseInt((document.getElementById('fin-amt') || {}).value, 10);
    if (!amt || amt <= 0) { if (window.toast) toast('請輸入金額'); return; }
    var note = ((document.getElementById('fin-note') || {}).value || '').trim();
    var day = (document.getElementById('fin-day') || {}).value || (window.todayKey ? todayKey() : _month + '-01');
    var list = loadExp();
    list.push({ id: Date.now(), cat: _formCat, amount: amt, note: note, day: day, ts: Date.now() });
    saveExp(list);
    _addOpen = false;
    // 若記到別的月份，跳到那個月才看得到
    if (monthOf(day) !== _month) _month = monthOf(day);
    render();
    if (window.toast) toast('已記錄支出 NT$ ' + nf(amt));
  }
  function delExp(id) {
    if (!confirm('刪除這筆支出？')) return;
    saveExp(loadExp().filter(function (e) { return e.id !== id; }));
    render();
  }

  window.MaptripFinance = { open: open, close: close, shiftMonth: shiftMonth, tab: tab, toggleAdd: toggleAdd, pickCat: pickCat, saveAdd: saveAdd, delExp: delExp };
  window.openFinance = open;
  window.closeFinance = close;
})();
