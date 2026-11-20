/* =============================================================
 * row-swipe.js — 行程列「向左滑顯示動作」（iPhone 式）MaptripRowSwipe
 * -------------------------------------------------------------
 * 每一列 .trip-row.swipeable 結構：
 *   <div class="trip-row swipeable">
 *     <div class="trip-actions"> … 編輯/截圖/刪除按鈕 …（絕對定位在右、藏在內容後面）</div>
 *     <div class="trip-swipe" onclick="開啟該趟"> … 序號/時間/金額 …（不透明、蓋住動作）</div>
 *   </div>
 * 手指往左滑 .trip-swipe → 露出右邊的動作鈕；放手過半就吸附打開，否則收回。一次只開一列。
 *
 * 【與既有手勢共存（血淚：sheet-drag/row-tap）】
 *  - sheet-drag 綁在 sheet（bubble, {passive:false}），只看「垂直 dy」決定動 sheet/原生捲動。
 *  - 本模組綁 document **capture 階段**（touchmove {passive:false}）：先於 sheet-drag 跑。
 *    一旦判定這段是「水平左滑」→ preventDefault + stopPropagation（capture 階段呼叫會連 bubble
 *    一起擋掉）→ sheet-drag 完全收不到這段 move（不會動到 sheet），原生捲動也被擋（不會捲）。
 *  - 垂直手勢：完全不碰（不 preventDefault、不 stopPropagation）→ 交給 sheet-drag / 原生捲動。
 *  - 滑動後瀏覽器補發的 click 要吞掉（否則放手誤觸「開啟該趟」）。
 *  - 桌面（細指標）由 CSS @media 直接把動作鈕內嵌顯示，不走本手勢（滑鼠無左滑）。
 * ============================================================= */
(function (global) {
  'use strict';

  var IS_TOUCH = typeof global !== 'undefined' &&
    (('ontouchstart' in global) || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));

  var ROW_SEL = '.swipeable';   // .trip-row.swipeable（行程列）＋ .history-day.swipeable（歷史每日列，v1.1.450）
  var DIR_THRESHOLD = 8;     // 超過幾 px 才判定方向
  var OPEN_RATIO = 0.4;      // 放手時滑超過動作寬度的幾成就吸附打開

  var startX = 0, startY = 0, mode = '';   // '' 未定 / 'h' 水平(本模組接管) / 'v' 垂直(放掉)
  var row = null, swipe = null, actionsW = 0, baseTx = 0, curTx = 0;
  var openRow = null;        // 目前打開的那一列（.trip-row）
  var swipedAt = 0;          // 最近一次「有滑動」的時間戳 → 用來吞掉補發 click

  function _swipe(r) { return r ? r.querySelector('.trip-swipe') : null; }
  function _actions(r) { return r ? r.querySelector('.trip-actions') : null; }

  function _setTx(sw, tx, animate) {
    if (!sw) return;
    sw.style.transition = animate ? '' : 'none';   // 拖曳中跟手不過渡；吸附才過渡（吃 CSS 的 .22s）
    sw.style.transform = tx ? ('translateX(' + tx + 'px)') : '';
  }

  // 關閉某一列（或目前打開的）
  function close(r) {
    r = r || openRow;
    if (!r) return;
    var sw = _swipe(r);
    _setTx(sw, 0, true);
    r.classList.remove('swipe-open');
    r.classList.remove('swiping');
    if (openRow === r) openRow = null;
  }
  function closeAll() { if (openRow) close(openRow); }

  function open(r) {
    if (!r) return;
    if (openRow && openRow !== r) close(openRow);
    var sw = _swipe(r), act = _actions(r);
    var w = act ? act.offsetWidth : 0;
    _setTx(sw, -w, true);
    r.classList.add('swipe-open');
    r.classList.remove('swiping');
    openRow = r;
  }

  function onStart(e) {
    var t = e.touches && e.touches[0]; if (!t) return;
    var r = e.target && e.target.closest ? e.target.closest(ROW_SEL) : null;
    // 點在動作鈕上 → 不起手（讓按鈕自己的 onclick 跑）
    if (e.target.closest && e.target.closest('.trip-actions')) { mode = 'v'; row = null; return; }
    // 已有別列打開、而這次點在別處 → 記著，touchend/點擊時收起
    mode = ''; row = r; swipe = _swipe(r); startX = t.clientX; startY = t.clientY; curTx = 0;
    if (r) {
      var act = _actions(r); actionsW = act ? act.offsetWidth : 0;
      baseTx = (openRow === r) ? -actionsW : 0;   // 已開著的列可從打開狀態繼續往右收
    } else { actionsW = 0; baseTx = 0; }
  }

  function onMove(e) {
    if (!row) return;
    var t = e.touches && e.touches[0]; if (!t) return;
    var dx = t.clientX - startX, dy = t.clientY - startY;
    if (!mode) {
      if (Math.abs(dx) < DIR_THRESHOLD && Math.abs(dy) < DIR_THRESHOLD) return;   // 還沒明顯方向
      // 偏向「垂直」：要明顯水平（水平量 > 垂直量 ×1.2）才接管，避免上下拖時誤開、底部露出色塊
      mode = (Math.abs(dx) > Math.abs(dy) * 1.2) ? 'h' : 'v';
      if (mode === 'v') { row = null; return; }   // 垂直 → 放掉，交給 sheet-drag/捲動
      if (row) row.classList.add('swiping');       // 進入左滑 → 顯示動作（平常隱藏，杜絕幽靈色塊）
    }
    if (mode !== 'h') return;
    // 水平：本模組接管這段手勢
    e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();   // capture 階段擋掉 → sheet-drag 收不到
    var tx = baseTx + dx;
    if (tx > 0) tx = 0;                             // 不給往右超過關閉位
    if (tx < -actionsW) tx = -actionsW - (tx + actionsW) * 0.4;   // 左超過上限 → 阻尼
    curTx = tx;
    _setTx(swipe, tx, false);
    if (Math.abs(dx) > 4) swipedAt = Date.now();
  }

  function onEnd() {
    if (!row) { mode = ''; return; }
    var r = row, sw = swipe;
    if (mode === 'h') {
      // 吸附：滑超過動作寬度 OPEN_RATIO 就打開，否則收回
      if (curTx < -actionsW * OPEN_RATIO) { open(r); }
      else { _setTx(sw, 0, true); r.classList.remove('swipe-open'); r.classList.remove('swiping'); if (openRow === r) openRow = null; }
      swipedAt = Date.now();
    } else {
      // 純點按（沒滑）：若點在「已打開的那一列」→ 收起、並吞掉這次 click（不開該趟）
      if (openRow && openRow === r) { close(r); swipedAt = Date.now(); }
      else if (openRow && openRow !== r) { close(openRow); }   // 點別列先收起已開的
    }
    row = null; swipe = null; mode = '';
  }

  // 吞掉滑動後補發的 click（避免放手誤觸「開啟該趟」）；也處理「列打開時點內容＝收起不開趟」
  function onClickCapture(e) {
    if (e.target.closest && e.target.closest('.trip-actions')) return;   // 動作鈕照常
    if (Date.now() - swipedAt < 500) {
      var r = e.target.closest ? e.target.closest(ROW_SEL) : null;
      if (r) { e.preventDefault(); e.stopPropagation(); }
    }
  }

  // 列表重畫後舊的 openRow 參考已失效 → 清掉
  function reset() { openRow = null; row = null; swipe = null; mode = ''; }

  function init() {
    if (!IS_TOUCH || typeof document === 'undefined' || init._done) return;
    init._done = true;
    document.addEventListener('touchstart', onStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onMove, { passive: false, capture: true });
    document.addEventListener('touchend', onEnd, { passive: true, capture: true });
    document.addEventListener('touchcancel', onEnd, { passive: true, capture: true });
    document.addEventListener('click', onClickCapture, { capture: true });
  }

  global.MaptripRowSwipe = {
    init: init, reset: reset, close: close, closeAll: closeAll, open: open,
    _onStart: onStart, _onMove: onMove, _onEnd: onEnd,   // 測試用
    _state: function () { return { openRow: openRow, mode: mode, curTx: curTx }; }
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
