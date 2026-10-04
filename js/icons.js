/* =============================================================
 * icons.js — 地圖標記圖示工廠（Leaflet divIcon）
 * -------------------------------------------------------------
 * 從 app.js v1.1.259 逐字抽出（body 與原版完全相同）。
 * 全為純函式：只用全域 L.divIcon，深色由參數 dark 傳入，不碰任何 App 狀態。
 * 掛 window.MaptripIcons；app.js 留同名薄包裝轉呼叫，呼叫端零改動。
 * ============================================================= */
(function (global) {
  'use strict';

  // dark=true 時：淺色填色配深色外框/數字（深色底圖才看得見）
  function makeNumberIcon(n, color, dark) {
    const edge = dark ? '#1a1a1a' : '#fff';
    return L.divIcon({
      className: '',
      html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2px solid ${edge};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:${edge};">${n}</div>`,
      iconSize: [20, 20], iconAnchor: [10, 10]
    });
  }

  function makeDotIcon(color) {
    return L.divIcon({
      className: '',
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7]
    });
  }

  // 起點：綠色圓形＋「起」
  function makeStartIcon() {
    return L.divIcon({
      className: '',
      html: '<div style="width:16px;height:16px;border-radius:50%;background:#34A853;border:2px solid #fff;'
          + 'box-shadow:0 1px 4px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;">'
          + '<span style="color:#fff;font-size:7px;font-weight:700;line-height:1;font-family:sans-serif">起</span></div>',
      iconSize: [16, 16], iconAnchor: [8, 8]
    });
  }

  // 終點：紅色圓形＋白色實心小圓
  function makeEndIcon() {
    return L.divIcon({
      className: '',
      html: '<div style="width:16px;height:16px;border-radius:50%;background:#EA4335;border:2px solid #fff;'
          + 'box-shadow:0 1px 4px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;">'
          + '<div style="width:5px;height:5px;background:#fff;border-radius:50%;"></div></div>',
      iconSize: [16, 16], iconAnchor: [8, 8]
    });
  }

  function makePreviewDotIcon() {
    return L.divIcon({
      className: '',
      html: '<div style="width:18px;height:18px;border-radius:50%;background:#1a1a1a;box-shadow:0 1px 4px rgba(0,0,0,0.35);"></div>',
      iconSize: [18, 18], iconAnchor: [9, 9]
    });
  }

  function makePreviewSquareIcon(dark) {
    const fill = dark ? '#f1f3f4' : '#1a1a1a';
    return L.divIcon({
      className: '',
      html: `<div style="width:16px;height:16px;background:${fill};border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,0.35);"></div>`,
      iconSize: [16, 16], iconAnchor: [8, 8]
    });
  }

  global.MaptripIcons = {
    makeNumberIcon: makeNumberIcon,
    makeDotIcon: makeDotIcon,
    makeStartIcon: makeStartIcon,
    makeEndIcon: makeEndIcon,
    makePreviewDotIcon: makePreviewDotIcon,
    makePreviewSquareIcon: makePreviewSquareIcon
  };

})(typeof window !== 'undefined' ? window : globalThis);
