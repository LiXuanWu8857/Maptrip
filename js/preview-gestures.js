/* =============================================================
 * preview-gestures.js — 歷史預覽（單趟／整日）地圖手勢鎖定（MaptripPreviewGestures）
 * -------------------------------------------------------------
 * 歷史檢視時：關閉拖曳（不平移）、但保留「平滑的雙指縮放」。
 *
 * 為何不用 map.centerZoom（以中心縮放）：
 *   GL（MapLibre）的 centerZoom 靠「每次 move 事件就 setCenter() 把中心拉回」的守衛
 *   達成不平移，但那會**打斷 MapLibre 的縮放動畫** → 使用者回報「縮放一格一格、不滑順」。
 *   故改用地圖原生縮放（GL＝touchZoomRotate、Leaflet＝touchZoom，皆平滑跟手），只關拖曳＝不平移。
 *   （雙指縮放本來就會以兩指中點為錨，屬「縮放」不是「平移」；單指無法拖動地圖。）
 *
 * 純函式（map 由呼叫端傳入），零 DOM 依賴，方便單元測試。
 * ============================================================= */
(function (global) {
  'use strict';

  // 進入歷史預覽：關拖曳（不平移）、開平滑雙指縮放
  function lock(map) {
    if (!map) return;
    try { if (map.dragging) map.dragging.disable(); } catch (_) {}
    try { if (map.touchZoom) map.touchZoom.enable(); } catch (_) {}   // GL→touchZoomRotate、Leaflet→touchZoom，皆平滑
  }

  // 離開歷史預覽：還原拖曳（縮放本來就是主地圖預設，維持開啟）
  function unlock(map) {
    if (!map) return;
    try { if (map.dragging) map.dragging.enable(); } catch (_) {}
    try { if (map.touchZoom) map.touchZoom.enable(); } catch (_) {}
  }

  // 舊版（centerZoom 中心鎖）需要在切趟/重新 fit 後更新鎖定中心；改用原生縮放後不再需要，保留 no-op 相容呼叫端。
  function recenter(map) { /* no-op：不再使用中心守衛 */ }

  global.MaptripPreviewGestures = { lock: lock, unlock: unlock, recenter: recenter };

})(typeof window !== 'undefined' ? window : globalThis);
