/* =============================================================
 * preview-gestures.js — 歷史預覽（單趟／整日）地圖手勢鎖定（MaptripPreviewGestures）
 * -------------------------------------------------------------
 * 歷史檢視時：關閉拖曳（不平移）、只保留「以畫面中心」的雙指縮放。
 * 兩地圖引擎一致——都走 map.centerZoom facade：
 *   - 向量（MapLibre GL）：gl-compat 內建 centerZoom（touchZoomRotate + 中心守衛）
 *   - 標準（Leaflet）：initMap polyfill 用原生 touchZoom:'center'（繞地圖中心而非手指）
 * 故單趟與整日預覽共用同一套：鎖平移 + 中心雙指縮放。
 *
 * 純函式（map 由呼叫端傳入），零 DOM 依賴，方便單元測試。
 * ============================================================= */
(function (global) {
  'use strict';

  // 進入歷史預覽：關拖曳、開「以中心縮放」的雙指縮放
  function lock(map) {
    if (!map) return;
    try { if (map.dragging) map.dragging.disable(); } catch (_) {}
    try {
      if (map.centerZoom) map.centerZoom.enable();
      else if (map.touchZoom) map.touchZoom.disable();   // 極端後備（無 centerZoom facade）：至少不亂平移縮放
    } catch (_) {}
  }

  // 離開歷史預覽：還原拖曳、還原主地圖縮放（繞手指）
  function unlock(map) {
    if (!map) return;
    try { if (map.dragging) map.dragging.enable(); } catch (_) {}
    try {
      if (map.centerZoom) map.centerZoom.disable();
      else if (map.touchZoom) map.touchZoom.enable();
    } catch (_) {}
  }

  // 切趟／重新 fitBounds 後更新 GL 的中心鎖（暫停守衛讓 fit 動畫跑完再抓新中心）。
  // 標準 Leaflet 的 setCenter 為 no-op（'center' 模式原生繞中心，不需鎖）。
  function recenter(map) {
    try { if (map && map.centerZoom && map.centerZoom.setCenter) map.centerZoom.setCenter(); } catch (_) {}
  }

  global.MaptripPreviewGestures = { lock: lock, unlock: unlock, recenter: recenter };

})(typeof window !== 'undefined' ? window : globalThis);
