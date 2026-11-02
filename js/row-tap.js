/* =============================================================
 * row-tap.js — 行程列點按錯位「診斷 + 原生直通」（MaptripRowTap）
 * -------------------------------------------------------------
 * 背景：iOS WKWebView 在底部 sheet 的堆疊清單（行程列 trip-row／歷史日期列 history-day／
 * 月份列 history-month）裡，點某一列時「開啟/展開」有時落到相鄰的下一列。
 *
 * 前幾版嘗試「用 touchstart 那一列 row.click() 取代原生 click、並攔掉位移的原生 click」——
 * 真機黑盒子顯示：rowfire 有觸發、rowblock 從未觸發。這推翻了「第二顆位移原生 click」假設：
 * 若真有那顆位移 click，capture 階段的攔截器一定會攔到並記 rowblock。最符合數據的解釋是
 * 「touchstart 命中的列（sRow）本身就偏了一格」，用它 click 反而開錯，preventDefault 又吃掉了
 * 可能正確的原生 click。
 *
 * 因此本版**改回原生 click 直通**（不 preventDefault、不代打 click、不攔截），保留 CSS 的
 * 高亮/選字移除；同時加**決定性診斷**：每次點按記下
 *   rd s=<起手列> f=<起手座標 elementFromPoint 的列> y=<Y>   （touchstart）
 *   rup s=<起手列> y=<Y>                                     （touchend，未移動＝點按）
 *   rc  c=<原生 click 命中列> f=<click 座標 elementFromPoint 的列> y=<Y>  （原生 click）
 * 比對 s / f / c 三者，即可判定偏移發生在哪一層（touchstart 命中？原生 click 命中？還是純視覺）。
 * 只在觸控裝置掛載；桌面走原生。列內按鈕（地圖/抽成/回放/編輯/刪除）各有自己的 onclick，照常原生。
 * ============================================================= */
(function (global) {
  'use strict';

  var IS_TOUCH = typeof global !== 'undefined' &&
    (('ontouchstart' in global) ||
     (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));

  var ROW_CLASSES = ['trip-row', 'history-day', 'history-month'];
  function _rowOf(target) {
    var oc = (target && target.closest) ? target.closest('[onclick]') : null;
    if (!oc || !oc.classList) return null;
    for (var i = 0; i < ROW_CLASSES.length; i++) if (oc.classList.contains(ROW_CLASSES[i])) return oc;
    return null;
  }
  function rid(row) { try { return (row && row.getAttribute && row.getAttribute('data-row')) || '?'; } catch (_) { return '?'; } }
  function log(m) { try { if (typeof global.__mtLog === 'function') global.__mtLog(m); } catch (_) {} }
  function efpRow(x, y) {
    try { return _rowOf((typeof document !== 'undefined') ? document.elementFromPoint(x, y) : null); }
    catch (_) { return null; }
  }

  var sRow = null, sx = 0, sy = 0, moved = false, tapAt = 0;
  var MOVE_TOL = 10;   // 位移超過此值＝捲動/拖曳，不當點按

  function onStart(e) {
    sRow = null;
    try {
      var t = e.touches && e.touches[0]; if (!t) return;
      var row = _rowOf(e.target); if (!row) return;
      sx = t.clientX; sy = t.clientY; moved = false; sRow = row;
      var f = efpRow(sx, sy);
      log('rd s=' + rid(row) + ' f=' + (f ? rid(f) : '-') + ' y=' + Math.round(sy));
    } catch (_) { sRow = null; }
  }
  function onMove(e) {
    if (!sRow) return;
    var t = e.touches && e.touches[0]; if (!t) return;
    if (Math.abs(t.clientX - sx) > MOVE_TOL || Math.abs(t.clientY - sy) > MOVE_TOL) {
      moved = true; sRow = null;   // 變成捲動/拖曳 → 放手（不記為點按）
    }
  }
  function onEnd() {
    var row = sRow; sRow = null;
    if (!row || moved) return;
    tapAt = Date.now();
    // 原生直通：不接管、不 preventDefault、不代打 click。只記錄起手列，交給原生 click。
    log('rup s=' + rid(row) + ' y=' + Math.round(sy));
  }
  function onCancel() { sRow = null; }

  // 只記錄（不攔截）「剛剛那次點按」附近的原生 click，供比對命中列。
  function onClickCapture(e) {
    if (Date.now() - tapAt > 1500) return;
    var r = _rowOf(e.target);
    var x = e.clientX, y = e.clientY;
    var f = (x || y) ? efpRow(x, y) : null;
    log('rc c=' + (r ? rid(r) : '-') + ' f=' + (f ? rid(f) : '-') + ' y=' + Math.round(y || 0));
  }

  function bind(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || doc._rowTapWired) return;
    doc._rowTapWired = true;
    doc.addEventListener('touchstart', onStart, { passive: true, capture: true });
    doc.addEventListener('touchmove', onMove, { passive: true, capture: true });
    doc.addEventListener('touchend', onEnd, { passive: true, capture: true });   // 被動：不再 preventDefault
    doc.addEventListener('touchcancel', onCancel, { passive: true, capture: true });
    doc.addEventListener('click', onClickCapture, true);   // capture：只記錄、不阻擋
  }

  if (IS_TOUCH) bind(typeof document !== 'undefined' ? document : null);

  global.MaptripRowTap = {
    bind: bind, IS_TOUCH: IS_TOUCH,
    _onStart: onStart, _onMove: onMove, _onEnd: onEnd, _onCancel: onCancel,
    _onClickCapture: onClickCapture, _rowOf: _rowOf,
    _state: function () { return { row: sRow, moved: moved, tapAt: tapAt }; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
