/* =============================================================
 * sheet-drag.js — 底部 sheet 可拖曳展開（MaptripSheetDrag）
 * -------------------------------------------------------------
 * 使用者需求：今日行程/歷史 sheet 維持「浮動視窗（底部彈出）」的樣子，
 * 但拉把手/標題列往上可以「滑上整個版面」（展開接近全螢幕），往下拉則收回
 * 預設高度、再往下就關閉。只綁在 .sheet-handle / .sheet-header / .cb-header
 * （不碰內容捲動區，清單照常上下滑）。展開態用 CSS class `.sheet-expanded`
 * （max-height 由 CSS 決定、尊重安全區）；拖曳過程用 inline max-height 即時跟手。
 *
 * 【v281→v283 血淚三】iOS 上「往上拖沒反應」歷經三次修：
 *   v280 touch 事件但 touchmove 是 **被動（passive）** → iOS 上 preventDefault 無效 →
 *        垂直拖曳被當成捲頁接走、touchmove 不再送到 JS（這是根因）。
 *   v281 改 Pointer Events + setPointerCapture → iOS WKWebView 有已知 bug：
 *        pointerdown 內呼叫 setPointerCapture 會壓掉後續 pointermove（桌面 Playwright 測不出來）。
 *   v283 正解：**觸控裝置一律用 touch 事件，且 touchmove 明確 `{passive:false}` + 首次移動就
 *        preventDefault**。iOS 上一次手勢的 touchmove/touchend 全部回到 touchstart 的元素，
 *        故綁把手即可攔整段拖曳、不需 pointer capture。桌面（滑鼠）才走 Pointer Events。
 *        另接上黑盒子 `__mtLog`（sheetdrag:start/firstmove/end）→ 若真機再失敗可用數據判讀。
 * ============================================================= */
(function (global) {
  'use strict';

  // 觸控裝置（iPhone/iPad/Android）走 touch 事件；桌面（滑鼠）走 pointer 事件。
  var IS_TOUCH = typeof window !== 'undefined' &&
    (('ontouchstart' in window) ||
     (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));

  function log(m) { try { if (typeof global.__mtLog === 'function') global.__mtLog('sheetdrag:' + m); } catch (_) {} }

  function wire(sheet, closeFn) {
    if (!sheet || sheet._sdWired) return;
    sheet._sdWired = true;
    var grabs = [];
    var handle = sheet.querySelector('.sheet-handle'); if (handle) grabs.push(handle);
    var header = sheet.querySelector('.sheet-header'); if (header) grabs.push(header);
    var cbh = sheet.querySelector('.cb-header'); if (cbh) grabs.push(cbh);   // 批次抽成 sheet 的標題列
    if (!grabs.length) return;

    var startY = 0, startH = 0, dragging = false, maxFull = 600, lastH = 0, moved = false;

    function fullMax() { return Math.max(240, (window.innerHeight || 600) - 6); }
    function reset() { sheet.style.maxHeight = ''; sheet.classList.remove('sheet-expanded'); }
    sheet._sdReset = reset;

    // 座標抽取：touch 事件用 touches/changedTouches，pointer/mouse 事件用 clientY。
    function yOf(e) {
      if (e.touches && e.touches.length) return e.touches[0].clientY;
      if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientY;
      return e.clientY;
    }

    function onStart(e) {
      if (e.target.closest && e.target.closest('button')) return;   // 標題列按鈕不觸發拖曳
      startY = yOf(e);
      startH = sheet.getBoundingClientRect().height;
      lastH = startH; moved = false;
      maxFull = fullMax();
      dragging = true;
      sheet.style.transition = 'none';
      sheet.style.animation = 'none';
      log('start h=' + Math.round(startH));
    }
    function onMove(e) {
      if (!dragging) return;
      // 【iOS 關鍵】非被動 touchmove + 首次移動就 preventDefault：阻止 WKWebView 把垂直
      // 拖曳改判成捲頁（否則 touchmove 會停止送達，就是之前「拖不動」）。
      if (e.cancelable) e.preventDefault();
      var newH = startH - (yOf(e) - startY);            // 往上拖 → 變高
      if (newH > maxFull) newH = maxFull;
      if (newH < 120) newH = 120;
      lastH = newH;                                     // 用「拖到的目標高」決策（不重量測、避免 transition 時間差）
      if (!moved) { moved = true; log('firstmove'); }
      sheet.classList.remove('sheet-expanded');
      sheet.style.maxHeight = newH + 'px';
    }
    function onEnd() {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      sheet.style.animation = '';
      if (!moved) { reset(); return; }                  // 只是點一下把手、沒拖 → 回預設
      log('end lastH=' + Math.round(lastH) + ' max=' + Math.round(maxFull));
      // 太矮 → 關；夠高（>72% 全高）→ 展開全螢幕；其餘 → 回預設
      if (lastH < 160) { reset(); if (closeFn) closeFn(); return; }
      if (lastH > 0.72 * maxFull) { sheet.style.maxHeight = ''; sheet.classList.add('sheet-expanded'); }
      else { reset(); }
    }

    grabs.forEach(function (g) {
      g.style.touchAction = 'none';   // 再保險一層：讓瀏覽器別把垂直拖曳當捲動
      if (IS_TOUCH) {
        // iOS 正解：touchmove 明確非被動（第三參數 {passive:false}），才准 preventDefault。
        g.addEventListener('touchstart', onStart, { passive: true });
        g.addEventListener('touchmove', onMove, { passive: false });
        g.addEventListener('touchend', onEnd);
        g.addEventListener('touchcancel', onEnd);
      } else {
        // 桌面（滑鼠）：Pointer Events。setPointerCapture 讓拖出元素外仍收得到 move。
        g.addEventListener('pointerdown', function (e) {
          onStart(e);
          if (dragging) { try { g.setPointerCapture(e.pointerId); } catch (_) {} }
        });
        g.addEventListener('pointermove', onMove);
        g.addEventListener('pointerup', onEnd);
        g.addEventListener('pointercancel', onEnd);
      }
    });
  }

  // 開啟 sheet 時呼叫：清掉上次拖曳留下的高度/展開狀態，回到預設。
  function reset(sheet) { if (sheet && sheet._sdReset) sheet._sdReset(); }

  global.MaptripSheetDrag = { wire: wire, reset: reset };

})(typeof window !== 'undefined' ? window : globalThis);
