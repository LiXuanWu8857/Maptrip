/* =============================================================
 * sheet-drag.js — 底部 sheet 可拖曳展開（MaptripSheetDrag）
 * -------------------------------------------------------------
 * 使用者需求：今日行程/歷史 sheet 維持「浮動視窗（底部彈出）」的樣子，
 * 但拉把手/標題列往上可以「滑上整個版面」（展開接近全螢幕），往下拉則收回
 * 預設高度、再往下就關閉。只綁在 .sheet-handle 與 .sheet-header（不碰內容捲動區，
 * 清單照常上下滑）。展開態用 CSS class `.sheet-expanded`（max-height 由 CSS 決定、
 * 尊重安全區）；拖曳過程用 inline max-height 即時跟手。
 * ============================================================= */
(function (global) {
  'use strict';

  function wire(sheet, closeFn) {
    if (!sheet || sheet._sdWired) return;
    sheet._sdWired = true;
    var grabs = [];
    var handle = sheet.querySelector('.sheet-handle'); if (handle) grabs.push(handle);
    var header = sheet.querySelector('.sheet-header'); if (header) grabs.push(header);
    if (!grabs.length) return;

    var startY = 0, startH = 0, dragging = false, maxFull = 600, lastH = 0, moved = false;

    function fullMax() { return Math.max(240, (window.innerHeight || 600) - 6); }
    function reset() { sheet.style.maxHeight = ''; sheet.classList.remove('sheet-expanded'); }
    sheet._sdReset = reset;

    function onStart(e) {
      if (e.target.closest && e.target.closest('button')) return;   // 標題列按鈕不觸發拖曳
      var t = e.touches ? e.touches[0] : e;
      startY = t.clientY;
      startH = sheet.getBoundingClientRect().height;
      lastH = startH; moved = false;
      maxFull = fullMax();
      dragging = true;
      sheet.style.transition = 'none';
      sheet.style.animation = 'none';
    }
    function onMove(e) {
      if (!dragging) return;
      var t = e.touches ? e.touches[0] : e;
      var newH = startH - (t.clientY - startY);        // 往上拖 → 變高
      if (newH > maxFull) newH = maxFull;
      if (newH < 120) newH = 120;
      lastH = newH; moved = true;                      // 用「拖到的目標高」決策（不重量測，避免 transition 時間差）
      sheet.classList.remove('sheet-expanded');
      sheet.style.maxHeight = newH + 'px';
      if (e.cancelable) e.preventDefault();            // 拖把手時不要順帶捲頁
    }
    function onEnd() {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      sheet.style.animation = '';
      if (!moved) { reset(); return; }                 // 只是點一下把手、沒拖 → 回預設
      // 依「拖到的目標高」決策：太矮 → 關；夠高（>78% 全高）→ 展開全螢幕；其餘 → 回預設
      if (lastH < 160) { reset(); if (closeFn) closeFn(); return; }
      if (lastH > 0.78 * maxFull) { sheet.style.maxHeight = ''; sheet.classList.add('sheet-expanded'); }
      else { reset(); }
    }

    grabs.forEach(function (g) {
      // 關鍵（iOS）：把手/標題列設 touch-action:none，瀏覽器才不會把「垂直拖曳」
      // 當成捲動先接走，JS 才拿得到 touchmove 來即時調整高度（否則往上拖沒反應）。
      g.style.touchAction = 'none';
      g.addEventListener('touchstart', onStart, { passive: true });
      g.addEventListener('touchmove', onMove, { passive: false });
      g.addEventListener('touchend', onEnd);
      g.addEventListener('touchcancel', onEnd);
      g.addEventListener('mousedown', function (e) {
        onStart(e);
        function mm(ev) { onMove(ev); }
        function mu(ev) { onEnd(ev); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); }
        document.addEventListener('mousemove', mm);
        document.addEventListener('mouseup', mu);
      });
    });
  }

  // 開啟 sheet 時呼叫：清掉上次拖曳留下的高度/展開狀態，回到預設。
  function reset(sheet) { if (sheet && sheet._sdReset) sheet._sdReset(); }

  global.MaptripSheetDrag = { wire: wire, reset: reset };

})(typeof window !== 'undefined' ? window : globalThis);
