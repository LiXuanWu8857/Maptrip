/* =============================================================
 * util.js — 通用工具函式（距離 / 格式化 / 費用標籤 / 休息時間）
 * -------------------------------------------------------------
 * 從 app.js v1.1.252 的 3443–3524 逐字抽出（body 與原版完全相同）。
 * 全為純函式，except getRestMin/setRestMin 碰 localStorage。
 * 掛 window.MaptripUtil；app.js 用同名薄包裝轉呼叫，呼叫端零改動。
 * REST_KEY 依 test 模式，用 init({testMode}) 對齊 app.js 的 TEST_MODE_ON。
 * ============================================================= */
(function (global) {
  'use strict';

  var REST_KEY = 'maptrip_rest';   // init() 依 test 模式覆寫

  // ---- 距離 ----
  function haversine(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function calcTotalDist(coords) {
    let d = 0;
    for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
    return d;
  }

  // ---- 格式化 ----
  function fmtDist(m) { return !m ? '0 m' : m >= 1000 ? `${(m/1000).toFixed(1)} km` : `${Math.round(m)} m`; }
  function fmtDur(ms) {
    const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
    if (h > 0) return `${h}h ${m%60}m`;
    return `${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }
  function fmtWork(ms) {
    const totalMin = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h > 0 ? `${h}小時${m}分` : `${m}分`;
  }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }); }

  // ---- 費用標籤 / 統計 ----
  function _payTag(pm) {
    if (pm === 'cash') return '<span class="pay-tag pay-cash">現金</span>';
    if (pm === 'card') return '<span class="pay-tag pay-card">刷卡</span>';
    return '';
  }
  function _otherTag(t) {
    if (t.paymentMethod === 'other') return `<span class="pay-tag pay-other">${t.label || '其他'}</span>`;
    return '';
  }
  function _extraTag(t) {
    let s = '';
    if (t.commission) s += `　<span class="extra-tag">抽成 ${t.commission}</span>`;
    if (t.dispatch)   s += `　<span class="extra-tag">叫車 ${t.dispatch}</span>`;
    return s;
  }
  function _fareStats(trips) {
    let card = 0, cash = 0, total = 0;
    trips.forEach(t => {
      const f = t.fare || 0; total += f;
      if (t.paymentMethod === 'card') card += f;
      else if (t.paymentMethod === 'cash') cash += f;
    });
    return { card, cash, total };
  }
  // 傳入 workMsVal（實際工作時長 ms）且 > 0 時，在總計旁加上每小時金額 $X/hr（v1.1.254）。
  function _fareLineHtml(trips, workMsVal) {
    const { card, cash, total } = _fareStats(trips);
    if (!total) return '';
    let html = `<span class="fl-card">刷卡：${card.toLocaleString()}</span>` +
           `<span class="fl-cash">現金：${cash.toLocaleString()}</span>` +
           `<span class="fl-total">總計：${total.toLocaleString()}</span>`;
    if (workMsVal && workMsVal > 0) {
      const rate = Math.round(total / (workMsVal / 3600000));
      html += `<span class="fl-rate">$${rate.toLocaleString()}/hr</span>`;
    }
    return html;
  }

  // ---- 休息時間（碰 localStorage）----
  function getRestMin(dayKey) {
    try { return JSON.parse(localStorage.getItem(REST_KEY) || '{}')[dayKey] || 0; }
    catch (_) { return 0; }
  }
  function setRestMin(dayKey, min) {
    let r = {};
    try { r = JSON.parse(localStorage.getItem(REST_KEY) || '{}'); } catch (_) {}
    if (min > 0) r[dayKey] = min; else delete r[dayKey];
    localStorage.setItem(REST_KEY, JSON.stringify(r));
  }
  function workMs(trips, restMin) {
    if (!trips || !trips.length) return 0;
    const span = trips[trips.length - 1].endTime - trips[0].startTime;
    return Math.max(0, span - (restMin || 0) * 60000);
  }

  // 初始化：對齊 app.js 的 TEST_MODE_ON，決定 REST_KEY
  function init(opts) {
    opts = opts || {};
    REST_KEY = opts.testMode ? 'maptrip_rest_test' : 'maptrip_rest';
  }

  global.MaptripUtil = {
    init: init,
    haversine: haversine, calcTotalDist: calcTotalDist,
    fmtDist: fmtDist, fmtDur: fmtDur, fmtWork: fmtWork, fmtTime: fmtTime,
    _payTag: _payTag, _otherTag: _otherTag, _extraTag: _extraTag,
    _fareStats: _fareStats, _fareLineHtml: _fareLineHtml,
    getRestMin: getRestMin, setRestMin: setRestMin, workMs: workMs
  };

})(typeof window !== 'undefined' ? window : globalThis);
