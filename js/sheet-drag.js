/* =============================================================
 * sheet-drag.js — 底部 sheet 可拖曳展開 + 內容連動展開/收折（MaptripSheetDrag）
 * -------------------------------------------------------------
 * 使用者需求（v284 精進）：不只把手能拖，**滑動內容時 sheet 也一起往上滑（展開）**，
 * 捲到內容頂端後再往下滑才會跟著往下收折——＝iOS 地圖那種「底部 sheet ＋巢狀捲動」。
 *
 * 手勢判定（每次觸控開始時記狀態，第一個明顯方向決定這一段要「動 sheet」還是「原生捲動」）：
 *   往上滑：未展開 → 動 sheet（展開）；已展開 → 交給內容原生捲動。
 *   往下滑：內容在頂端 → 動 sheet（收折/關閉）；內容不在頂端 → 原生捲動（先捲回頂端，
 *          回到頂端後放手、再往下滑才收折＝使用者要的「回到頂端才收折」）。
 * 把手/標題列沒有可捲動內容 → 一律當「動 sheet」。
 *
 * 【iOS 血淚（v280→v283）】touchmove 監聽必須 **非被動 `{passive:false}`** 才能 preventDefault，
 * 否則垂直拖曳被 WKWebView 當捲頁接走、事件不再送達＝拖不動。Pointer Events + setPointerCapture
 * 在 iOS 上會踩「pointerdown 內 capture 壓掉 pointermove」的 bug，故觸控裝置一律走 touch 事件，
 * 桌面（滑鼠）才走 Pointer Events。黑盒子 `__mtLog`（sheetdrag:*）供真機診斷。
 * ============================================================= */
(function (global) {
  'use strict';

  var IS_TOUCH = typeof window !== 'undefined' &&
    (('ontouchstart' in window) ||
     (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));

  function log(m) { try { if (typeof global.__mtLog === 'function') global.__mtLog('sheetdrag:' + m); } catch (_) {} }

  function wire(sheet, closeFn) {
    if (!sheet || sheet._sdWired) return;
    sheet._sdWired = true;

    var startY = 0, startH = 0, dragging = false, mode = '', maxFull = 600, lastH = 0, moved = false, scrollEl = null;

    function fullMax() { return Math.max(240, (window.innerHeight || 600) - 6); }
    function reset() { sheet.style.maxHeight = ''; sheet.classList.remove('sheet-expanded'); }
    sheet._sdReset = reset;
    function isExpanded() { return sheet.classList.contains('sheet-expanded'); }

    // 觸控點往上找 sheet 內「可捲動」的容器（overflow-y auto/scroll 且真的有得捲）；handle/header 回 null。
    function scrollableFrom(node) {
      while (node && node !== sheet && node.nodeType === 1) {
        if (node.scrollHeight - node.clientHeight > 2) {
          var oy = getComputedStyle(node).overflowY;
          if (oy === 'auto' || oy === 'scroll') return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    function yOf(e) {
      if (e.touches && e.touches.length) return e.touches[0].clientY;
      if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientY;
      return e.clientY;
    }

    function onStart(e) {
      if (e.target.closest && e.target.closest('button, input, textarea, select, a')) return;
      startY = yOf(e);
      startH = sheet.getBoundingClientRect().height;
      lastH = startH; moved = false; dragging = true; mode = '';
      maxFull = fullMax();
      scrollEl = scrollableFrom(e.target);
      // 注意：這裡**不**碰 transition/animation/class——純捲動手勢要完全不動 sheet（否則會閃/抖）。
    }

    function onMove(e) {
      if (!dragging) return;
      var y = yOf(e), dy = y - startY;                    // dy<0 往上、dy>0 往下
      if (!mode) {
        if (Math.abs(dy) < 4) return;                     // 等有明顯方向再決定（避免誤判 / 微抖）
        var up = dy < 0;
        var atTop = !scrollEl || scrollEl.scrollTop <= 0;
        // 已展開（在最頂端）往上滑：一律交給內容原生捲動，絕不再動 sheet（使用者：頂端別再偵測上滑）
        if (up) mode = isExpanded() ? 'scroll' : 'sheet';
        else    mode = atTop ? 'sheet' : 'scroll';              // 內容在頂端往下→收折；否則先原生捲回頂端
        log('mode=' + mode + ' up=' + up + ' atTop=' + atTop + ' exp=' + isExpanded());
        if (mode === 'scroll') { dragging = false; return; }    // 交給原生捲動，這段手勢完全不碰 sheet
        // 確定要「動 sheet」：以此刻為新基準（rebase），之後 max-height 與手指 1:1、起步不跳＝同步滑動。
        startY = y; startH = sheet.getBoundingClientRect().height; dy = 0;
        // 只讓 border-radius 平滑（0.15s），max-height 不列進 transition＝即時跟手不延遲。
        // **絕不碰 animation**：sheet 的 CSS `animation:slideUp` 只在開啟時播一次，
        // 這裡若動它（設 none 再還原）會在放手時重播進場動畫＝「閃一下」＋整個被往上甩。
        sheet.style.transition = 'border-radius .15s ease';
      }
      if (mode !== 'sheet') return;
      if (e.cancelable) e.preventDefault();               // 【iOS 關鍵】非被動 + preventDefault 才動得了 sheet
      var newH = startH - dy;                             // 從 rebase 基準連續計算，1:1 跟手
      if (newH > maxFull) newH = maxFull;
      if (newH < 120) newH = 120;
      lastH = newH; moved = true;
      sheet.classList.remove('sheet-expanded');
      sheet.style.maxHeight = newH + 'px';
    }

    function onEnd() {
      var wasSheet = dragging && mode === 'sheet' && moved;
      dragging = false; mode = '';
      if (!wasSheet) return;                              // 純捲動 / 點按 → 完全沒動過 sheet，不用還原
      sheet.style.transition = '';                       // 回到 CSS（max-height 0.2s 做 snap；不碰 animation＝不重播進場、不閃）
      var vh = window.innerHeight || 600;
      log('end lastH=' + Math.round(lastH) + ' vh=' + Math.round(vh));
      // 下拉到「低於半螢幕」→ 直接關閉（使用者：下拉超過螢幕一半就關）
      if (lastH < 0.5 * vh) { reset(); if (closeFn) closeFn(); return; }
      if (lastH > 0.72 * maxFull) { sheet.style.maxHeight = ''; sheet.classList.add('sheet-expanded'); }
      else { reset(); }
    }

    if (IS_TOUCH) {
      // 觸控：整張 sheet 都能起手（把手/標題列/內容都行），touchmove 明確非被動才准 preventDefault。
      sheet.addEventListener('touchstart', onStart, { passive: true });
      sheet.addEventListener('touchmove', onMove, { passive: false });
      sheet.addEventListener('touchend', onEnd);
      sheet.addEventListener('touchcancel', onEnd);
    } else {
      // 桌面（滑鼠）：只綁把手/標題列（內容用滾輪捲動，不用滑鼠拖曳移動 sheet）。
      var grabs = [];
      var handle = sheet.querySelector('.sheet-handle'); if (handle) grabs.push(handle);
      var header = sheet.querySelector('.sheet-header'); if (header) grabs.push(header);
      var cbh = sheet.querySelector('.cb-header'); if (cbh) grabs.push(cbh);
      grabs.forEach(function (g) {
        g.style.touchAction = 'none';
        g.addEventListener('pointerdown', function (e) {
          onStart(e);
          if (dragging) { try { g.setPointerCapture(e.pointerId); } catch (_) {} }
        });
        g.addEventListener('pointermove', onMove);
        g.addEventListener('pointerup', onEnd);
        g.addEventListener('pointercancel', onEnd);
      });
    }
  }

  // 開啟 sheet 時呼叫：清掉上次拖曳留下的高度/展開狀態，回到預設。
  function reset(sheet) { if (sheet && sheet._sdReset) sheet._sdReset(); }

  global.MaptripSheetDrag = { wire: wire, reset: reset };

})(typeof window !== 'undefined' ? window : globalThis);
