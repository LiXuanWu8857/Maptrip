/* =============================================================
 * desktop-mode.js — 電腦版「檢視台模式」（記帳者 + 回放 為主）
 * -------------------------------------------------------------
 * 使用者需求：電腦（瀏覽器）當「記帳者／回放檢視台」，GPS 記錄那些不顯示也無功用。
 * 判定方式＝手動切換鈕（選單裡「切換 檢視台版／司機版」），旗標記在這台裝置（localStorage）。
 *   - **原生 iOS App 永遠是司機版**（不受旗標影響、也不顯示切換鈕）——避免司機誤切丟失記錄。
 *   - **瀏覽器**：①補上選單滑鼠點擊（原本選單只綁 touch，電腦滑鼠點不動）；②加切換鈕；
 *     ③檢視台版時用 CSS 藏掉並停用 GPS/記錄相關（開始記錄、找客熱區、定位、GPS 標記、
 *     底部列、選單的今日行程/找客熱區），並在 app.js 跳過 startGpsWatch。
 *   - 保留：記帳者、回放（從歷史每日「▶ 回放」）、歷史行程、雲端同步（登入）、收支報表。
 * 掛 window.MaptripDesktop；app.js 於 boot 呼叫 apply()、initMap 依 isReview() 決定是否啟動 GPS。
 * ============================================================= */
(function (global) {
  'use strict';

  var KEY = 'maptrip_review';

  function isBrowser() {
    try { return !(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()); }
    catch (_) { return true; }
  }
  function flagOn() { try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; } }
  // 檢視台模式：只有「瀏覽器 ＋ 旗標開」才算；原生 App 永遠司機版。
  function isReview() { return isBrowser() && flagOn(); }

  function toggle() {
    try { localStorage.setItem(KEY, flagOn() ? '0' : '1'); } catch (_) {}
    location.reload();   // 乾淨地重新套用（藏/顯、要不要啟動 GPS）
  }

  var CSS =
    'body.dm-review #start-btn,' +
    'body.dm-review #hotspot-btn,' +
    'body.dm-review #locate-btn,' +
    'body.dm-review #compass-btn,' +
    'body.dm-review #gps-badge,' +
    'body.dm-review #bottom-bar,' +
    'body.dm-review #top-menu button[data-menu="today"],' +
    'body.dm-review #top-menu button[data-menu="hotspot"]{display:none!important}';

  function injectCss() {
    if (document.getElementById('dm-css')) return;
    var s = document.createElement('style'); s.id = 'dm-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // 選單加「切換 檢視台版/司機版」鈕（只在瀏覽器；用既有 data-menu 派發機制 → reviewtoggle）
  function addToggleItem() {
    var menu = document.getElementById('top-menu');
    if (!menu || menu.querySelector('button[data-menu="reviewtoggle"]')) return;
    var b = document.createElement('button');
    b.setAttribute('data-menu', 'reviewtoggle');
    b.textContent = isReview() ? '🚕 切換司機版' : '🖥 切換檢視台版';
    menu.appendChild(b);
  }

  // 讓選單能用滑鼠點（原本只綁 touch）：委派給 app.js 的 window._dispatchMenu（含防重派發）
  function wireMouseMenu() {
    var menu = document.getElementById('top-menu');
    if (!menu || menu._dmWired) return;
    menu._dmWired = true;
    menu.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('button[data-menu]');
      if (!btn) return;
      var action = btn.getAttribute('data-menu');
      if (window.closeTopMenu) window.closeTopMenu();
      if (window._dispatchMenu) window._dispatchMenu(action);
    });
  }

  function apply() {
    if (!isBrowser()) return;   // 原生 App 完全不動（司機版）
    injectCss();
    wireMouseMenu();
    addToggleItem();
    if (isReview()) document.body.classList.add('dm-review');
  }

  global.MaptripDesktop = { apply: apply, toggle: toggle, isReview: isReview, isBrowser: isBrowser };

})(typeof window !== 'undefined' ? window : globalThis);
