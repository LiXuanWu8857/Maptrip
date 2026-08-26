/* =============================================================
 * altlog.js — GPS 高度黑盒子（橋上/橋下量測，第一步：先收資料再判斷可行性）
 * -------------------------------------------------------------
 * 為什麼獨立一個 ring，而不是塞進行程座標：行程座標會被貼路壓實成頭尾、也會上雲同步，
 * 高度混進去會被壓掉、也污染同步。這裡用獨立的 localStorage ring（mt_altlog），
 * 只在記錄中收 altitude/altitudeAccuracy/speed，完全不動現有記錄/貼路/同步行為。
 *
 * 用法：app.js onGpsUpdate 記錄座標時呼叫 MaptripAlt.record(...)。
 *       版本號連點 3 下開黑盒子 → 「📈 高度診斷」→ showPanel()：畫高度曲線＋±精度帶＋統計，
 *       可截圖或「複製數據」貼給開發者判讀（GPS 垂直精度是否足以分辨 5-15m 的高架）。
 * ============================================================= */
(function (global) {
  'use strict';

  var KEY = 'mt_altlog', CAP = 2000;
  var buf = null, lastFlush = 0;

  function load() {
    if (buf) return buf;
    try { buf = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) { buf = []; }
    if (!Array.isArray(buf)) buf = [];
    return buf;
  }
  function flush(force) {
    var now = Date.now();
    if (!force && now - lastFlush < 5000) return;   // 節流：最多每 5 秒落盤一次
    lastFlush = now;
    try { localStorage.setItem(KEY, JSON.stringify(buf)); } catch (_) {}
  }
  function r5(v) { return Math.round(v * 1e5) / 1e5; }
  function num(v, dp) { return (v == null || isNaN(v)) ? null : (dp ? Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp) : Math.round(v)); }

  function record(p) {
    if (!p) return;
    load();
    buf.push({ t: p.t || Date.now(), la: r5(p.lat), ln: r5(p.lng),
      al: num(p.alt, 1), ac: num(p.altAcc, 0), sp: num(p.spd, 1) });
    if (buf.length > CAP) buf.splice(0, buf.length - CAP);
    flush(false);
  }
  function reset() { buf = []; try { localStorage.setItem(KEY, '[]'); } catch (_) {} lastFlush = Date.now(); }
  function data() { flush(true); return load().slice(); }

  // 統計：只看有高度的點
  function report() {
    var d = load();
    var withAlt = d.filter(function (e) { return e.al != null; });
    var n = withAlt.length;
    if (!n) return { n: 0, total: d.length };
    var als = withAlt.map(function (e) { return e.al; });
    var acs = withAlt.map(function (e) { return e.ac; }).filter(function (v) { return v != null; });
    var min = Math.min.apply(null, als), max = Math.max.apply(null, als);
    var accSorted = acs.slice().sort(function (a, b) { return a - b; });
    var accMed = accSorted.length ? accSorted[Math.floor(accSorted.length / 2)] : null;
    var accAvg = acs.length ? Math.round(acs.reduce(function (a, b) { return a + b; }, 0) / acs.length) : null;
    var durMin = d.length ? Math.round((d[d.length - 1].t - d[0].t) / 60000 * 10) / 10 : 0;
    return { n: n, total: d.length, altMin: min, altMax: max, range: Math.round((max - min) * 10) / 10,
      accAvg: accAvg, accMed: accMed, durMin: durMin, nullAlt: d.length - n };
  }

  // 抽稀成最多 m 個樣本（畫圖/複製用）
  function decimate(arr, m) {
    if (arr.length <= m) return arr.slice();
    var out = [], step = arr.length / m;
    for (var i = 0; i < m; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  }

  // 複製用的精簡文字（統計＋抽稀高度/精度序列，貼給開發者判讀）
  function copyText() {
    var r = report(), d = load();
    if (!r.n) return '（尚無高度資料，先在記錄中跑一趟高架）';
    var s = decimate(d, 80);
    var alt = s.map(function (e) { return e.al == null ? 'x' : e.al; }).join(',');
    var acc = s.map(function (e) { return e.ac == null ? 'x' : e.ac; }).join(',');
    var spd = s.map(function (e) { return e.sp == null ? 'x' : e.sp; }).join(',');
    return 'Maptrip 高度診斷 v' + (global.APP_VERSION || '') + '\n' +
      'points=' + r.n + '/' + r.total + '  dur=' + r.durMin + 'min\n' +
      'alt: ' + r.altMin + '~' + r.altMax + '  range=' + r.range + 'm\n' +
      'altAcc: avg=' + r.accAvg + '  median=' + r.accMed + 'm\n' +
      'ALT[' + s.length + ']=' + alt + '\n' +
      'ACC[' + s.length + ']=' + acc + '\n' +
      'SPD[' + s.length + ']=' + spd;
  }

  // 畫高度曲線＋±精度帶（帶明顯超出精度帶＝高度可分辨橋上/橋下）
  function draw(canvas) {
    var d = load().filter(function (e) { return e.al != null; });
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (d.length < 2) {
      ctx.fillStyle = '#888'; ctx.font = '13px sans-serif';
      ctx.fillText('尚無足夠高度資料', 12, H / 2);
      return;
    }
    var s = decimate(d, Math.min(d.length, 240));
    var lo = Infinity, hi = -Infinity;
    s.forEach(function (e) {
      var a = e.al, c = e.ac || 0;
      if (a - c < lo) lo = a - c; if (a + c > hi) hi = a + c;
    });
    if (hi - lo < 4) { var mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }   // 至少 4m 縱幅
    var padL = 34, padR = 8, padT = 8, padB = 16;
    var x = function (i) { return padL + (W - padL - padR) * (i / (s.length - 1)); };
    var y = function (a) { return padT + (H - padT - padB) * (1 - (a - lo) / (hi - lo)); };

    // ±精度帶
    ctx.beginPath();
    s.forEach(function (e, i) { var yy = y(e.al + (e.ac || 0)); i ? ctx.lineTo(x(i), yy) : ctx.moveTo(x(i), yy); });
    for (var i = s.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(s[i].al - (s[i].ac || 0)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,120,120,0.25)'; ctx.fill();

    // 高度線
    ctx.beginPath();
    s.forEach(function (e, i) { var yy = y(e.al); i ? ctx.lineTo(x(i), yy) : ctx.moveTo(x(i), yy); });
    ctx.strokeStyle = '#1a73e8'; ctx.lineWidth = 2; ctx.stroke();

    // Y 軸刻度（lo / hi）
    ctx.fillStyle = '#aaa'; ctx.font = '10px monospace';
    ctx.fillText(Math.round(hi) + 'm', 2, padT + 8);
    ctx.fillText(Math.round(lo) + 'm', 2, H - padB);
  }

  function showPanel() {
    document.getElementById('altlog-box')?.remove();
    var r = report();
    var box = document.createElement('div');
    box.id = 'altlog-box';
    box.style.cssText = 'position:fixed;top:56px;left:8px;right:8px;bottom:70px;z-index:100000;'
      + 'background:rgba(10,12,16,0.96);color:#cde;font:12px/1.5 -apple-system,sans-serif;'
      + 'padding:12px;border-radius:12px;overflow:auto;-webkit-overflow-scrolling:touch';

    var head = document.createElement('div');
    head.style.cssText = 'font-weight:700;margin-bottom:8px';
    head.textContent = '📈 GPS 高度診斷（橋上/橋下量測）';
    box.appendChild(head);

    var stat = document.createElement('div');
    stat.style.cssText = 'font:11px/1.6 monospace;margin-bottom:8px;color:#9ef;white-space:pre-wrap';
    if (!r.n) {
      stat.textContent = '尚無高度資料。\n請先「開始記錄」跑一趟高架（上橋→橋上→下橋），\n回來再開這裡看。\n\n提示：iOS 需給定位權限；部分裝置 GPS 不提供高度（會顯示 x）。';
    } else {
      var verdict = (r.range != null && r.accMed != null)
        ? (r.range > r.accMed * 2 ? '✅ 高度變化明顯大於精度 → 可能分得出上/下'
           : (r.range > r.accMed ? '🟡 高度變化略大於精度 → 邊界，需更多資料'
           : '❌ 高度變化被精度雜訊蓋過 → GPS 高度恐不夠'))
        : '';
      stat.textContent =
        '樣本：' + r.n + ' 點（有高度）/ ' + r.total + ' 總點，時長 ' + r.durMin + ' 分\n' +
        '高度：' + r.altMin + ' ~ ' + r.altMax + ' m，範圍 ' + r.range + ' m\n' +
        '垂直精度 altAcc：平均 ' + r.accAvg + ' m、中位 ' + r.accMed + ' m\n' +
        '沒高度的點：' + r.nullAlt + '\n' + verdict;
    }
    box.appendChild(stat);

    var cv = document.createElement('canvas');
    cv.width = Math.min(window.innerWidth - 40, 520); cv.height = 150;
    cv.style.cssText = 'width:100%;max-width:520px;background:#0e1116;border-radius:8px;display:block;margin-bottom:6px';
    box.appendChild(cv);
    var cap = document.createElement('div');
    cap.style.cssText = 'font:10px monospace;color:#889;margin-bottom:10px';
    cap.textContent = '藍線＝高度；灰帶＝±垂直精度。藍線的「階梯」若明顯突出灰帶，代表上/下橋分得出來。';
    box.appendChild(cap);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    function mkBtn(txt, bg, fn) {
      var b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'flex:1;min-width:90px;padding:10px;border:none;border-radius:8px;color:#fff;font-size:13px;background:' + bg;
      b.onclick = function (e) { e.stopPropagation(); fn(); };
      return b;
    }
    row.appendChild(mkBtn('📋 複製數據', '#1a73e8', function () {
      var txt = copyText();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(function () { toastMsg('已複製，貼給開發者判讀'); },
            function () { fallbackCopy(txt); });
        } else fallbackCopy(txt);
      } catch (_) { fallbackCopy(txt); }
    }));
    row.appendChild(mkBtn('🗑 重設', '#c0392b', function () {
      if (confirm('清空高度紀錄，重新量測？')) { reset(); showPanel(); }
    }));
    row.appendChild(mkBtn('關閉', '#555', function () { box.remove(); }));
    box.appendChild(row);

    box.onclick = function (e) { if (e.target === box) box.remove(); };
    document.body.appendChild(box);
    try { draw(cv); } catch (_) {}
  }

  function toastMsg(m) { if (global.toast) global.toast(m); }
  function fallbackCopy(txt) {
    try {
      var ta = document.createElement('textarea');
      ta.value = txt; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toastMsg('已複製（相容模式）');
    } catch (_) { toastMsg('複製失敗，請截圖'); }
  }

  global.MaptripAlt = {
    record: record, reset: reset, data: data, report: report,
    copyText: copyText, draw: draw, showPanel: showPanel, _decimate: decimate
  };

})(typeof window !== 'undefined' ? window : globalThis);
