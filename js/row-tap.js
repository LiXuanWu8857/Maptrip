/* =============================================================
 * row-tap.js — 行程列點按錯位修正（MaptripRowTap）
 * -------------------------------------------------------------
 * 問題：iOS WKWebView 在底部 sheet 的行程清單裡，點某一列時「顯示/開啟」會落到相鄰的下一列。
 * 真機黑盒子（rowtap 診斷）證實：touchstart 事件路由到的列（＝手指起手那一列）永遠正確，
 * 但原生 :active／合成 click 有時被位移到相鄰列。
 * 解法：點按一律改由「起手那一列」直接觸發（row.click()），並 preventDefault 擋掉隨後可能被位移的
 * 原生 click。不加背景高亮——iOS 會把清單列的背景高亮畫到相鄰下一列（合成位移），反而造成
 * 「高亮顯示在按的下面那格」；點按立即開啟正確那趟＝已有回饋。列內按鈕（編輯/刪除/截圖，各有自己的
 * onclick）不接管、交給原生。只在觸控裝置啟用；桌面走原生 click。
 * ============================================================= */
(function (global) {
  'use strict';

  var IS_TOUCH = typeof global !== 'undefined' &&
    (('ontouchstart' in global) ||
     (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));

  var sRow = null, sx = 0, sy = 0, moved = false;
  var MOVE_TOL = 10;   // 位移超過此值＝捲動/拖曳，不當點按

  // 只接管「列本身」的點按：從觸控目標往上找最近的 onclick 元素，必須就是 .trip-row。
  // （列內的編輯/刪除/截圖各有自己的 onclick → closest 會先命中它們 → 不接管、交給原生。）
  function _rowOf(target) {
    var oc = (target && target.closest) ? target.closest('[onclick]') : null;
    return (oc && oc.classList && oc.classList.contains('trip-row')) ? oc : null;
  }

  function onStart(e) {
    sRow = null;
    try {
      var t = e.touches && e.touches[0]; if (!t) return;
      var row = _rowOf(e.target); if (!row) return;
      sx = t.clientX; sy = t.clientY; moved = false; sRow = row;
    } catch (_) { sRow = null; }
  }
  function onMove(e) {
    if (!sRow) return;
    var t = e.touches && e.touches[0]; if (!t) return;
    if (Math.abs(t.clientX - sx) > MOVE_TOL || Math.abs(t.clientY - sy) > MOVE_TOL) {
      moved = true; sRow = null;   // 變成捲動/拖曳 → 放手
    }
  }
  function onEnd(e) {
    var row = sRow; sRow = null;
    if (!row || moved) return;
    if (e && e.cancelable && e.preventDefault) e.preventDefault();   // 擋掉隨後被位移的原生 click
    try { if (global.__mtLog) global.__mtLog('rowfire ' + (row.getAttribute('data-row') || '?')); } catch (_) {}
    try { row.click(); } catch (_) {}   // 觸發「正確那列」的 onclick
  }
  function onCancel() { sRow = null; }

  function bind(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || doc._rowTapWired) return;
    doc._rowTapWired = true;
    doc.addEventListener('touchstart', onStart, { passive: true, capture: true });
    doc.addEventListener('touchmove', onMove, { passive: true, capture: true });
    doc.addEventListener('touchend', onEnd, { passive: false, capture: true });
    doc.addEventListener('touchcancel', onCancel, { passive: true, capture: true });
  }

  if (IS_TOUCH) bind(typeof document !== 'undefined' ? document : null);

  global.MaptripRowTap = {
    bind: bind, IS_TOUCH: IS_TOUCH,
    _onStart: onStart, _onMove: onMove, _onEnd: onEnd, _onCancel: onCancel,
    _rowOf: _rowOf, _state: function () { return { row: sRow, moved: moved }; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
