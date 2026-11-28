/* =============================================================
 * pinch-view.js — 對某元素加「雙指縮放 + 單指拖曳 + 雙擊還原」（MaptripPinch）
 * -------------------------------------------------------------
 * 用於截圖預覽（#screenshot-img）：純檢視手勢，只用 CSS transform 縮放/平移，
 * 不改截圖產生邏輯、分享/存檔仍用原始 blob（放大只是看細節）。
 *
 * iOS 觸控鐵律（血淚 §10）：
 *   - 用 touch 事件（非 pointer；WKWebView 對 pointerdown+setPointerCapture 會壓掉 pointermove）。
 *   - touchmove 用 {passive:false} 並在手勢中 preventDefault（否則背景會跟著捲/觸發 backdrop 關閉）。
 *   - 手勢進行中不碰 CSS animation；只在雙擊/放手 snap 時短暫加 transition:transform，手勢中移除。
 *   - scale==1 時完全不攔截，讓 backdrop 單擊仍能關閉預覽。
 * ============================================================= */
(function (global) {
  'use strict';

  function wire(el, opts) {
    if (!el) return { reset: function () {}, unwire: function () {} };
    opts = opts || {};
    var MIN = opts.min || 1, MAX = opts.max || 2.5, DBL = opts.doubleScale || 2;

    var scale = 1, tx = 0, ty = 0;
    // 手勢狀態
    var mode = null;            // 'pinch' | 'pan' | null
    var startDist = 0, startScale = 1, cx0 = 0, cy0 = 0, tx0 = 0, ty0 = 0;
    var panX = 0, panY = 0, moved = false, multiTouched = false;
    var lastTapT = 0, lastTapX = 0, lastTapY = 0;

    function apply() {
      el.style.transformOrigin = 'center center';
      el.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }
    function clampScale(s) { return Math.max(MIN, Math.min(MAX, s)); }
    function clampPan() {
      // 縮放後圖的可視尺寸＝natural×scale；允許平移到「邊緣不越過中心」，scale==1 → 不能移
      var maxX = Math.max(0, (el.clientWidth * (scale - 1)) / 2);
      var maxY = Math.max(0, (el.clientHeight * (scale - 1)) / 2);
      tx = Math.max(-maxX, Math.min(maxX, tx));
      ty = Math.max(-maxY, Math.min(maxY, ty));
    }
    function reset() {
      scale = 1; tx = 0; ty = 0; mode = null; multiTouched = false;
      el.style.transition = 'none';
      apply();
    }
    function _dist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.hypot(dx, dy); }
    function _midX(t) { return (t[0].clientX + t[1].clientX) / 2; }
    function _midY(t) { return (t[0].clientY + t[1].clientY) / 2; }

    function onStart(e) {
      var t = e.touches;
      el.style.transition = 'none';   // 手勢中即時跟手、不重播動畫
      if (t.length >= 2) {
        mode = 'pinch'; multiTouched = true;
        startDist = _dist(t) || 1; startScale = scale;
        var r = el.getBoundingClientRect();
        cx0 = r.left + r.width / 2; cy0 = r.top + r.height / 2;   // 起手時的視覺中心
        tx0 = tx; ty0 = ty;
        e.preventDefault();
      } else if (t.length === 1) {
        if (scale > 1) {            // 放大狀態才啟用單指拖曳
          mode = 'pan'; panX = t[0].clientX; panY = t[0].clientY; tx0 = tx; ty0 = ty; moved = false;
          e.preventDefault();
        } else {
          mode = null;              // scale==1：不攔截，讓 backdrop/單擊可關閉；仍記錄以判雙擊
        }
      }
    }
    function onMove(e) {
      var t = e.touches;
      if (mode === 'pinch' && t.length >= 2) {
        var ns = clampScale(startScale * (_dist(t) / startDist));
        var mx = _midX(t), my = _midY(t);
        // 以兩指中點為錨：tx' = tx0 + (mx-cx0)*(1 - ns/startScale)
        tx = tx0 + (mx - cx0) * (1 - ns / startScale);
        ty = ty0 + (my - cy0) * (1 - ns / startScale);
        scale = ns; clampPan(); apply();
        e.preventDefault();
      } else if (mode === 'pan' && t.length === 1) {
        tx = tx0 + (t[0].clientX - panX); ty = ty0 + (t[0].clientY - panY);
        if (Math.abs(t[0].clientX - panX) > 3 || Math.abs(t[0].clientY - panY) > 3) moved = true;
        clampPan(); apply();
        e.preventDefault();
      }
    }
    function _zoomAbout(px, py, ns) {
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var s0 = scale;
      tx = tx + (px - cx) * (1 - ns / s0);
      ty = ty + (py - cy) * (1 - ns / s0);
      scale = ns; clampPan();
      el.style.transition = 'transform .2s ease'; apply();
    }
    function onEnd(e) {
      var remaining = e.touches ? e.touches.length : 0;
      if (mode === 'pinch') {
        if (remaining < 2) { mode = remaining === 1 ? null : null; }   // 多指放到剩 1 指：本段結束（不當拖曳/點擊）
        if (scale <= 1.02) { scale = 1; tx = 0; ty = 0; el.style.transition = 'transform .2s ease'; apply(); }
        if (remaining === 0) multiTouched = false;
        return;
      }
      if (multiTouched) { if (remaining === 0) multiTouched = false; mode = null; return; }
      // 單指結束：判雙擊（僅在沒有明顯拖曳時）
      if (mode === 'pan' && moved) { mode = null; return; }
      var ct = (e.changedTouches && e.changedTouches[0]) || null;
      if (!ct) { mode = null; return; }
      var now = Date.now();
      var isDbl = (now - lastTapT < 300) && Math.abs(ct.clientX - lastTapX) < 30 && Math.abs(ct.clientY - lastTapY) < 30;
      if (isDbl) {
        lastTapT = 0;
        if (scale > 1) { scale = 1; tx = 0; ty = 0; el.style.transition = 'transform .2s ease'; apply(); }
        else { _zoomAbout(ct.clientX, ct.clientY, DBL); }
        e.preventDefault();
      } else {
        lastTapT = now; lastTapX = ct.clientX; lastTapY = ct.clientY;
      }
      mode = null;
    }

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onEnd, { passive: false });
    // 換圖（初次開圖 / 勾「其他」重畫）→ 自動回到 1×
    el.addEventListener('load', reset);

    function unwire() {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('load', reset);
    }
    reset();
    return { reset: reset, unwire: unwire, _state: function () { return { scale: scale, tx: tx, ty: ty }; } };
  }

  var _inst = null;
  // 對截圖預覽圖掛手勢（開機一次；元素固定）。回傳可 reset 的實例。
  function initScreenshot() {
    var img = document.getElementById('screenshot-img');
    if (!img) return null;
    if (_inst) return _inst;
    _inst = wire(img, { max: 2.5, doubleScale: 2 });
    return _inst;
  }
  function reset() { if (_inst) _inst.reset(); }

  global.MaptripPinch = { wire: wire, initScreenshot: initScreenshot, reset: reset };

})(typeof window !== 'undefined' ? window : globalThis);
