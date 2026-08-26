// MaptripExport — 把記帳者記錄的內容整理成「可貼進 Excel 的 TSV（tab 分隔）」。
// 設計：純函式產生表格資料 → 組成 TSV 文字 → 一鍵複製到剪貼簿，使用者到 Excel 直接 Ctrl+V 自動分欄。
// 只做「複製到剪貼簿」單一管道（手機/桌面都能用、無 iOS 下載限制、無檔案編碼亂碼問題）。
// 三張表：①月彙總 ②逐趟明細 ③支出明細。算錢一律沿用 finance.monthReport（單一來源，不分岔）。
window.MaptripExport = (function () {
  'use strict';

  var WD = ['日', '一', '二', '三', '四', '五', '六'];
  function wd(day) { try { return WD[new Date(day + 'T00:00:00').getDay()] || ''; } catch (_) { return ''; } }
  function hm(ts) {
    try {
      var d = new Date(ts);
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    } catch (_) { return ''; }
  }
  function km(m) { return ((m || 0) / 1000).toFixed(1); }
  function payLabel(t) {
    if (t.paymentMethod === 'card') return '刷卡';
    if (t.paymentMethod === 'cash') return '現金';
    return t.label || '其他';
  }

  // TSV 安全化：cell 內的 tab/換行會破壞欄位對齊 → 換成空白；前後空白修掉。
  function cell(v) {
    return String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim();
  }
  // rows = 二維陣列 → TSV 文字（每列 tab 分隔、列間換行）。
  function tsv(rows) {
    return (rows || []).map(function (r) { return (r || []).map(cell).join('\t'); }).join('\n');
  }

  // 併入記帳者補登的手動趟（顯示層）。與 bookkeeper._mergeManual 同語意，但這裡只為匯出用、輕量重排。
  function _mergeManual(days, manualTrips) {
    var out = {};
    Object.keys(days || {}).forEach(function (d) { out[d] = (days[d] || []).slice(); });
    (manualTrips || []).forEach(function (m) {
      var d = m.day; if (!d) return;
      if (!out[d]) out[d] = [];
      var mm = {}; for (var k in m) mm[k] = m[k]; mm._manual = true;
      out[d].push(mm);
    });
    Object.keys(out).forEach(function (d) {
      out[d].sort(function (a, b) { return (a.startTime || 0) - (b.startTime || 0); });
    });
    return out;
  }

  // 每趟套用記帳者覆蓋值（車資 fareOverride、抽成、叫車），並鎖現金抽成＝0（與面板一致）。
  function _tripFields(t, commissions) {
    var c = (commissions && commissions[String(t.id)]) || {};
    var cashLock = t.paymentMethod === 'cash';
    var fare = (c.fareOverride != null) ? c.fareOverride : (t.fare || 0);
    var comm = cashLock ? 0 : (c.commission != null ? c.commission : (t.commission || 0));
    var disp = (c.dispatch != null) ? c.dispatch : (t.dispatch || 0);
    return { fare: fare, comm: comm, disp: disp };
  }

  // 併手動趟 + 套記帳者覆蓋車資（fareOverride）成一份「解析後 days」，讓月彙總與逐趟明細用同一份資料
  // （否則 monthReport 讀 t.fare 不含手動趟、也不反映 fareOverride → 兩張表對不起來）。
  function _resolveDays(days, commissions, manualTrips) {
    var merged = _mergeManual(days, manualTrips);
    var out = {};
    Object.keys(merged).forEach(function (d) {
      out[d] = merged[d].map(function (t) {
        var c = commissions && commissions[String(t.id)];
        if (c && c.fareOverride != null && c.fareOverride !== t.fare) {
          var nt = {}; for (var k in t) nt[k] = t[k]; nt.fare = c.fareOverride; return nt;
        }
        return t;
      });
    });
    return out;
  }

  // ① 月彙總：每個月一列。用「解析後 days」沿用 finance.monthReport（單一算錢來源）。
  var SUM_HEAD = ['月份', '營收', '現金', '刷卡', '抽成', '叫車', '支出', '淨利', '趟數', '里程(km)'];
  function summaryRows(days, commissions, expenses, manualTrips) {
    var F = window.MaptripFinance;
    if (!F || !F.monthReport) return [SUM_HEAD.slice()];
    var resolved = _resolveDays(days, commissions, manualTrips);
    var months = {};
    Object.keys(resolved).forEach(function (d) { months[String(d).slice(0, 7)] = true; });
    (expenses || []).forEach(function (e) { if (e.day) months[String(e.day).slice(0, 7)] = true; });
    var list = Object.keys(months).sort();
    var rows = [SUM_HEAD.slice()];
    list.forEach(function (m) {
      var r = F.monthReport(resolved, commissions, expenses, m);
      rows.push([m, r.fare, r.cash, r.card, r.comm, r.disp, r.expTotal, r.net, r.trips, km(r.dist)]);
    });
    return rows;
  }

  // ② 逐趟明細：所有月份、每趟一列（排除「其他/自用」，與帳務一致）。ym 非空則只出該月。
  var TRIP_HEAD = ['日期', '星期', '時間', '付款', '車資', '抽成', '叫車', '里程(km)', '來源', '備註'];
  function tripRows(days, commissions, manualTrips, ym) {
    var merged = _mergeManual(days, manualTrips);
    var month = ym ? String(ym).slice(0, 7) : null;
    var dayKeys = Object.keys(merged).filter(function (d) {
      return !month || String(d).slice(0, 7) === month;
    }).sort();
    var rows = [TRIP_HEAD.slice()];
    dayKeys.forEach(function (day) {
      merged[day].forEach(function (t) {
        if (t.paymentMethod === 'other') return;   // 自用/非載客不計帳
        var f = _tripFields(t, commissions);
        rows.push([
          day, wd(day), hm(t.startTime), payLabel(t),
          f.fare, f.comm, f.disp, km(t.totalDist),
          t._manual ? '手動' : 'GPS', t.label || ''
        ]);
      });
    });
    return rows;
  }

  // ③ 支出明細：每筆一列。ym 非空則只出該月。
  var EXP_HEAD = ['日期', '分類', '金額', '備註'];
  function expenseRows(expenses, ym) {
    var month = ym ? String(ym).slice(0, 7) : null;
    var catMap = (window.MaptripFinance && window.MaptripFinance.CAT_MAP) || {};
    var rows = [EXP_HEAD.slice()];
    (expenses || []).slice()
      .filter(function (e) { return !month || String(e.day || '').slice(0, 7) === month; })
      .sort(function (a, b) { return String(a.day || '').localeCompare(String(b.day || '')); })
      .forEach(function (e) {
        var cat = (catMap[e.cat] && catMap[e.cat].label) || e.cat || '其他';
        rows.push([e.day || '', cat, e.amount || 0, e.note || '']);
      });
    return rows;
  }

  // 三張表合併成一段 TSV（區塊標題 + 空行分隔），一鍵複製即含全部。
  // data = { days, commissions, manualTrips, expenses, name }；ym 非空＝只出該月（null＝全部）。
  function buildTSV(data, ym) {
    data = data || {};
    var title = (data.name ? '司機：' + data.name : '記帳資料') + (ym ? '　' + String(ym).slice(0, 7) : '　全部');
    var parts = [];
    parts.push('【' + title + '】');
    parts.push('');
    parts.push('◆ 月彙總');
    parts.push(tsv(summaryRows(data.days, data.commissions, data.expenses, data.manualTrips)));
    parts.push('');
    parts.push('◆ 逐趟明細');
    parts.push(tsv(tripRows(data.days, data.commissions, data.manualTrips, ym)));
    parts.push('');
    parts.push('◆ 支出明細');
    parts.push(tsv(expenseRows(data.expenses, ym)));
    return parts.join('\n');
  }

  // 複製到剪貼簿（clipboard API 優先、execCommand 後備），回傳 Promise<bool>。
  function copy(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(_legacyCopy(text)); });
      } else {
        resolve(_legacyCopy(text));
      }
    });
  }
  function _legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      var ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }

  // 面板呼叫：組 TSV → 複製 → toast。data 來源＝記帳者 _cache 或司機自己的資料。
  function copyReport(data, ym) {
    var text = buildTSV(data, ym);
    return copy(text).then(function (ok) {
      if (window.toast) window.toast(ok ? '📋 已複製，到 Excel 貼上（Ctrl+V）自動分欄' : '複製失敗，請改用截圖');
      return ok;
    });
  }

  return {
    buildTSV: buildTSV, copyReport: copyReport, copy: copy,
    // 純函式供測試
    summaryRows: summaryRows, tripRows: tripRows, expenseRows: expenseRows,
    tsv: tsv, _mergeManual: _mergeManual, _tripFields: _tripFields
  };
})();
