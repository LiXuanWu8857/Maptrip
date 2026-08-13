/* =============================================================
 * row-tap.js — 行程列點按錯位修正（MaptripRowTap）
 * -------------------------------------------------------------
 * 問題：iOS WKWebView 在底部 sheet 的堆疊清單（行程列／歷史日期列／月份列）裡，
 * 點某一列時「顯示/開啟」會落到相鄰的下一列。
 * 真機黑盒子（rowtap 診斷）證實：touchstart 事件路由到的列（＝手指起手那一列）永遠正確，
 * 但原生 :active／合成 click 有時被位移到相鄰列。
 * 解法（兩道）：
 *  ① 點按一律改由「起手那一列」直接觸發（row.click()）＝動作一定落在正確那列。
 *  ② **click 攔截器**：光靠 touchend.preventDefault() 在 WKWebView 不一定擋得掉隨後被位移的原生
 *     click——若那顆 offset click 仍發到「相鄰列」上，會在我們正確開啟後 ~300ms 又把「下面那格」打開
 *     ＝使用者看到的「按在不對的地方」。因此起手一列點按後，700ms 內於 capture 階段攔掉「落在其他列
 *     上的原生 click」（只擋列，放行按鈕/輸入等非列點擊，也放行我們自己的合成 click）。
 * 不加背景高亮——iOS 會把清單列的背景高亮畫到相鄰下一列（合成位移），反而造成「高亮顯示在按的下面那格」；
 * 點按立即開啟正確那趟＝已有回饋。列內按鈕（地圖/抽成/回放/編輯/刪除，各有自己的 onclick）不接管、
 * 交給原生。只在觸控裝置啟用；桌面走原生 click。
 * ============================================================= */
(function (global) {
  'use strict';

  var IS_TOUCH = typeof global !== 'undefined' &&
    (('ontouchstart' in global) ||
     (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));

  var sRow = null, sx = 0, sy = 0, moved = false;
  var MOVE_TOL = 10;   // 位移超過此值＝捲動/拖曳，不當點按
  var firedRow = null;         // 我們正在合成 click 的那一列（放行自己的 click 用）
  var blockUntil = 0;          // 這個時間點之前，攔掉「落在其他列上的」原生 click
  var BLOCK_MS = 700;          // iOS 位移 click 通常在 touchend 後 ~300ms 內到

  // 會接管的「列」類型：底部 sheet 裡會被 iOS 合成位移的堆疊清單列。
  // 行程列（trip-row）、歷史日期列（history-day）、歷史月份列（history-month）。
  var ROW_CLASSES = ['trip-row', 'history-day', 'history-month'];
  // 只接管「列本身」的點按：從觸控目標往上找最近的 onclick 元素，必須就是上述列之一。
  // （列內的地圖/抽成/回放/編輯/刪除各有自己的 onclick → closest 會先命中它們 → 不接管、交給原生。）
  function _rowOf(target) {
    var oc = (target && target.closest) ? target.closest('[onclick]') : null;
    if (!oc || !oc.classList) return null;
    for (var i = 0; i < ROW_CLASSES.length; i++) if (oc.classList.contains(ROW_CLASSES[i])) return oc;
    return null;
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
    if (e && e.cancelable && e.preventDefault) e.preventDefault();   // 先嘗試擋掉隨後被位移的原生 click
    try { if (global.__mtLog) global.__mtLog('rowfire ' + (row.getAttribute('data-row') || '?')); } catch (_) {}
    // ② 啟動 click 攔截窗：我們自己的 row.click() 會同步觸發（firedRow 放行），
    //    之後 700ms 內若有「落在其他列上的」原生 click（iOS 位移）就攔掉。
    firedRow = row; blockUntil = Date.now() + BLOCK_MS;
    try { row.click(); } catch (_) {}   // 觸發「正確那列」的 onclick（同步）
    firedRow = null;                    // 同步 click 已跑完；之後到的都是待攔的位移 click
  }
  function onCancel() { sRow = null; }

  // capture 階段 click 攔截：只在「起手點按後的短窗內」作用。
  // - 命中的元素不是我們接管的列（按鈕/輸入等）→ 放行。
  // - 是我們自己的合成 click（target 在 firedRow 內）→ 放行。
  // - 是「落在其他列上的」原生位移 click → 攔掉（就是這顆把「下面那格」打開）。
  function onClickCapture(e) {
    if (Date.now() > blockUntil) return;
    var r = _rowOf(e.target);
    if (!r) return;                                   // 非列點擊（按鈕/輸入…）→ 放行
    if (firedRow && (r === firedRow)) return;         // 我們自己的合成 click → 放行
    try { if (global.__mtLog) global.__mtLog('rowblock ' + (r.getAttribute('data-row') || '?')); } catch (_) {}
    if (e.stopPropagation) e.stopPropagation();
    if (e.preventDefault) e.preventDefault();          // 吃掉這顆位移 click
    blockUntil = 0;                                    // 一次點按只擋一顆，避免影響後續正常點擊
  }

  function bind(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || doc._rowTapWired) return;
    doc._rowTapWired = true;
    doc.addEventListener('touchstart', onStart, { passive: true, capture: true });
    doc.addEventListener('touchmove', onMove, { passive: true, capture: true });
    doc.addEventListener('touchend', onEnd, { passive: false, capture: true });
    doc.addEventListener('touchcancel', onCancel, { passive: true, capture: true });
    doc.addEventListener('click', onClickCapture, true);   // capture：搶在列的 onclick 之前
  }

  if (IS_TOUCH) bind(typeof document !== 'undefined' ? document : null);

  global.MaptripRowTap = {
    bind: bind, IS_TOUCH: IS_TOUCH,
    _onStart: onStart, _onMove: onMove, _onEnd: onEnd, _onCancel: onCancel,
    _rowOf: _rowOf, _state: function () { return { row: sRow, moved: moved }; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
