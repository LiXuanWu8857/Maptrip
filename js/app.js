const APP_VERSION  = '1.1.264';
const TEST_MODE_ON = new URLSearchParams(location.search).has('test');
const STORAGE_KEY = TEST_MODE_ON ? 'maptrip_test_v1' : 'maptrip_v1';
// 行程儲存讀寫一律走 TripStore（IndexedDB，見 js/store.js）：
// 同步介面、記憶體快取，開機時 boot 之前完成初始化與舊資料搬移
function loadTrips() { return TripStore.getAll(); }
function saveTrips(raw) { TripStore.setAll(raw); }

// 把「抽成集合」的某趟抽成套回本機行程（記帳者在雲端改抽成 → 司機本機同步）。
// 回傳 true 表示有變動（呼叫端據以重繪）。
function applyCommission(tripId, commission, dispatch) {
  try {
    const id = isNaN(+tripId) ? tripId : +tripId;   // 趟 id 通常是數字
    const raw = loadTrips();
    let changed = false;
    Object.keys(raw).forEach(day => {
      (raw[day] || []).forEach(t => {
        if (t && (t.id === id || String(t.id) === String(tripId))) {
          if ((t.commission || 0) !== (commission || 0) || (t.dispatch || 0) !== (dispatch || 0)) {
            t.commission = commission || 0; t.dispatch = dispatch || 0; changed = true;
          }
        }
      });
    });
    if (changed) {
      saveTrips(raw);
      // 記憶體中的今日清單也同步
      todayTrips.forEach(t => {
        if (t && (t.id === id || String(t.id) === String(tripId))) { t.commission = commission || 0; t.dispatch = dispatch || 0; }
      });
    }
    return changed;
  } catch (_) { return false; }
}
window.applyCommission = applyCommission;
const MIN_ACCURACY_M = 60;
const GPS_RECORD_MS  = 1000;   // 每秒存一點，路線更細緻
const LIVE_SNAP_PTS  = 30;     // 每累積 30 點（約 30 秒）即時貼合一次道路

let map, myDotMarker, accuracyCircle, currentPos = null;
// 橋接：讓獨立模組（hotspots.js…）讀到即時的地圖與定位（兩者為 let，不在 window 上）
window.__mtLive = { get pos() { return currentPos; }, get map() { return map; } };
let activeTrip = null, activePolyline = null;   // timerTick 已隨錄製狀態機搬入 recorder.js
let todayTrips = [], allMapLayers = [];
// 今日圖層顯示狀態：normal＝正常、hidden＝歷史檢視（整組隱藏）、
// solo＝今日單趟預覽（線淡化當背景、點整組隱藏）。
// 重畫（貼路成功/同步）發生在任何狀態下，新圖層都要立即套用當前狀態。
let _todayMode = 'normal';
let soloLayers = [];
let soloSet = [], soloIdx = 0, soloLabelFn = null;  // 單趟顯示：可左右切換的趟次集合
let soloFromHistory = false;  // 從歷史紀錄進入 solo 模式時為 true
let soloHistoryTile = null;   // 歷史 solo 時換用的無標示底圖
let autoFollow = false, wakeLock = null;
let headingUp = false;          // 朝車頭模式（地圖旋轉跟隨行進方向）
let lastHeading = 0;            // headingRefPos/deviceCompassOn/lastMoveSpeed 已隨 orient.js 搬入
let _mapTouching = 0;           // 手指目前在地圖上的數量（>0 時暫停自動跟隨/旋轉）
let _mapZooming = false;        // 縮放動畫進行中（期間不可改動線條，否則整條線會飛走）
let _lineResyncPending = false; // 縮放/手勢期間累積的新點 → 結束後一次補畫
let myHeading = null;           // 我的位置朝向（GPS 行進方向 / 羅盤），供方向光束用
let _lastPanPos = null;         // 上次跟隨移動的位置（移動 <3m 不重跑跟隨動畫，省 GPU）
let _lastCircleAt = null;       // 上次精度圓圈的位置/精度（無實質變化不重畫）
let activeSnapPending = false;
let lastKnownPos = null;   // 上一個定位（GPS 無速度時用位移估速，見 onGpsUpdate）
let pendingWidgetStart = false;  // 鎖屏按了開始、但 GPS 還沒定位時，先排隊
// pendingFareTrip / lastHeartbeat 已隨錄製狀態機搬入 recorder.js

const TEST_MODE = TEST_MODE_ON;
// simTick / simTimer / nativeWatcherId 已隨錄製狀態機搬入 recorder.js

// 是否跑在 Capacitor 原生殼裡（iOS 或 Android App）
function isNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

// 目前原生平台：'ios' / 'android' / 'web'
function nativePlatform() {
  return window.Capacitor?.getPlatform ? window.Capacitor.getPlatform() : 'web';
}

// keepBuffer:0＝畫面外的圖磚立刻釋放（預設留 2 圈，解碼點陣圖是背景記憶體大戶；
// WKWebView 記憶體超標會整個被 iOS 砍掉，寧可回看舊區域時多抓一次網路）
const TILE_LAYERS = {
  road: L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 20, keepBuffer: 0, updateWhenIdle: true }),
  satellite: L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 20, keepBuffer: 0, updateWhenIdle: true })
};
let currentTile = 'road';

// Live Activity 插件的安全存取 helper（iOS 專屬，Android / web 一律回傳 null）
function liveAct() {
  return nativePlatform() === 'ios' ? window.Capacitor?.Plugins?.LiveActivity : null;
}

// 浮動視窗插件（Android 專屬，iOS / web 一律回傳 null）
// 行程記錄中時，浮一張小卡片在導航等其他 App 上方，對應 iOS 的 Live Activity。
function floatWin() {
  return nativePlatform() === 'android' ? window.Capacitor?.Plugins?.FloatingWindow : null;
}

// 第一次在 Android 記錄行程時，引導開啟「顯示在其他應用程式上層」權限（只問一次）。
// 使用者去設定開啟後，下一趟才會真的浮出視窗；這趟先靜默略過。
async function ensureFloatPermission() {
  const fw = floatWin();
  if (!fw) return;
  try {
    const { granted } = await fw.hasPermission();
    if (granted) return;
    if (localStorage.getItem('maptrip_float_asked')) return;
    localStorage.setItem('maptrip_float_asked', '1');
    const ok = confirm('要開啟「浮動視窗」嗎？\n\n開啟後會浮一張小卡片在導航等其他 App 上方，' +
                       '可直接開始/結束行程、輸入車資，卡片也能拖到任意位置。\n\n' +
                       '按確定前往設定，開啟「顯示在其他應用程式上層」。');
    if (ok) fw.requestPermission();
  } catch (_) {}
}

// WKWebView 安全區位移時，底部列可能被推到可視範圍外（home indicator 區）→ 點不到。
// 用 visualViewport 量測，若底部超出就用 transform 往上拉回；正常時不動作。
function ensureBottomBarVisible() {
  const bar = document.getElementById('bottom-bar');
  if (!bar) return;
  bar.style.transform = '';   // 先還原再量測，避免累加
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  const overflow = bar.getBoundingClientRect().bottom - vh;
  if (overflow > 1) bar.style.transform = `translateY(${-Math.ceil(overflow)}px)`;
}

function initMap() {
  // leaflet-rotate 已知問題修補（外掛原始碼中作者自留 @TODO）：
  // 捏合「同時」縮放+旋轉會讓圖層變換與內部座標脫鉤 —— 實測每次手勢偏移 ~7px 且會累積，
  // 這就是「縮放時路徑亂跑、貼不回地圖」的元兇。修補成 Google 地圖式手勢鎖定：
  // 依先達到門檻者鎖定為「縮放」或「旋轉」，二擇一，杜絕同時變換。
  if (L.Map && L.Map.TouchGestures && !L.Map.TouchGestures.__gLockPatched) {
    L.Map.TouchGestures.__gLockPatched = true;
    const proto = L.Map.TouchGestures.prototype;
    const origStart = proto._onTouchStart, origMove = proto._onTouchMove, origEnd = proto._onTouchEnd;
    proto._onTouchStart = function (e) {
      this._gLock = null; this._gStartAng = null;
      if (e.touches && e.touches.length === 2 && this._map) {
        const p1 = this._map.mouseEventToContainerPoint(e.touches[0]);
        const p2 = this._map.mouseEventToContainerPoint(e.touches[1]);
        const v = p1.subtract(p2);
        this._gStartAng = Math.atan2(v.y, v.x);
      }
      const ret = origStart.call(this, e);
      // 預先給定 _center/_zoom：旋轉鎖定會跳過縮放分支（不算 _center），
      // 少了這行 _move/_animateZoom 會拿到 undefined 而炸掉，地圖從此壞死（zoom=NaN、無法歸位）
      if (this._map) { this._center = this._map.getCenter(); this._zoom = this._map.getZoom(); }
      return ret;
    };
    proto._onTouchMove = function (e) {
      if (e.touches && e.touches.length === 2 && this._zooming && this._rotating && this._gLock == null) {
        const m = this._map;
        const p1 = m.mouseEventToContainerPoint(e.touches[0]);
        const p2 = m.mouseEventToContainerPoint(e.touches[1]);
        const v = p1.subtract(p2);
        // 防禦：若 _onTouchStart 的包裝沒被呼叫到（handler 在打補丁前就綁好原始參考），
        // 就在第一次 move 補記起始狀態，本幀不做鎖定判斷
        if (this._gStartAng == null) {
          this._gStartAng = Math.atan2(v.y, v.x);
          if (this._center == null) { this._center = m.getCenter(); this._zoom = m.getZoom(); }
        } else {
          const scale = p1.distanceTo(p2) / this._startDist;
          // 兩指連線的實際旋轉角（atan2 最短路徑；atan(x/y) 在 y<0 時會多出 ±180° 假旋轉，
          // 導致純捏合被誤鎖成「旋轉」）
          const dB = ((((Math.atan2(v.y, v.x) - this._gStartAng) * 180 / Math.PI) % 360) + 540) % 360 - 180;
          if (Math.abs(Math.log2(scale)) > 0.12) { this._gLock = 'zoom';   this._rotating = false; }
          else if (Math.abs(dB) > 12)            { this._gLock = 'rotate'; this._zooming  = false; }
        }
      }
      return origMove.call(this, e);
    };
    proto._onTouchEnd = function () { this._gLock = null; this._gStartAng = null; return origEnd.apply(this, arguments); };
  }

  map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0,
                       // 用 SVG 繪圖器：Canvas 與 leaflet-rotate 不相容，
                       // 旋轉狀態下縮放時線條會錯位亂跑
                       preferCanvas: false,
                       // leaflet-rotate：程式旋轉 + 雙指手勢旋轉
                       rotate: true, rotateControl: false, touchRotate: true,
                       shiftKeyRotate: false, bearing: 0 })
         .setView([25.033, 121.565], 15);
  TILE_LAYERS.road.addTo(map);

  // 今日行程專用 pane：歷史檢視（單趟/日預覽/回放）時整組隱藏，
  // 不再依賴逐一追蹤 allMapLayers（漏追蹤就會像使用者遇到的「今日點外漏」）
  try {
    if (map.createPane) {
      if (!map.getPane('todayLines')) { map.createPane('todayLines'); map.getPane('todayLines').style.zIndex = 410; }
      if (!map.getPane('todayMarks')) { map.createPane('todayMarks'); map.getPane('todayMarks').style.zIndex = 620; }
    }
  } catch (_) {}

  // 地圖旋轉時，讓指北針的針頭永遠指向真正的北方
  if (map.setBearing) {
    document.getElementById('compass-btn').style.display = 'flex';
    map.on('rotate', () => {
      updateCompassNeedle();
      updateMyHeadingArrow();
      // 手動雙指旋轉時，同步平滑旋轉器的內部角度（動畫中則不干預）。動畫狀態已搬入 orient.js。
      MaptripOrient.syncBearingFromMap();
    });
    updateCompassNeedle();
  }

  // WKWebView 首次載入時：容器尺寸常還沒就緒（地圖變灰），且安全區位移會把
  // 底部按鈕推到畫面外（home indicator 區）→ 點不到。fixLayout 同時處理兩者。
  const fixLayout = () => { map.invalidateSize(); ensureBottomBarVisible(); };
  setTimeout(fixLayout, 100);
  setTimeout(fixLayout, 500);
  setTimeout(fixLayout, 1200);
  window.addEventListener('resize', fixLayout);
  window.addEventListener('orientationchange', () => setTimeout(fixLayout, 250));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', ensureBottomBarVisible);
    window.visualViewport.addEventListener('scroll', ensureBottomBarVisible);
  }

  document.getElementById('tile-toggle').addEventListener('click', () => {
    map.removeLayer(TILE_LAYERS[currentTile]);
    currentTile = currentTile === 'road' ? 'satellite' : 'road';
    TILE_LAYERS[currentTile].addTo(map);
    document.getElementById('tile-toggle').textContent =
      currentTile === 'road' ? '🛰 衛星' : '🗺 地圖';
  });

  // 使用者手動移動地圖時，暫停自動跟隨；5 秒沒再操作就自動飛回原位繼續跟隨。
  // 用 movestart+手指在地圖上 判定「使用者手勢」：捏合縮放/雙指旋轉不會觸發 dragstart，
  // 只掛 dragstart 的話捏合移走地圖就永遠不會歸位（停車沒 GPS 更新時尤其明顯）
  const pauseFollowByUser = () => {
    // 歷史檢視（單趟/日預覽/回放）中不武裝自動歸位：使用者是在看過去的行程，不該被拉回目前位置
    if (autoFollow && !inBrowsingMode()) { setAutoFollow(false); _wantFollowResume = true; }
  };
  map.on('dragstart', pauseFollowByUser);                                // 滑鼠拖曳（桌機）
  map.on('movestart', () => { if (_mapTouching) pauseFollowByUser(); }); // 觸控手勢（拖、捏合、旋轉）
  map.on('dragend', scheduleFollowResume);
  map.on('zoomend', scheduleFollowResume);
  map.on('moveend', () => { if (_wantFollowResume && !_mapTouching) scheduleFollowResume(); });

  // 手指在地圖上時（捏合縮放/旋轉「不會」觸發 dragstart！）：
  // 暫停自動 panTo 與自動旋轉、停掉旋轉動畫，否則手勢會被程式搶走、畫面亂跳
  const mapEl = document.getElementById('map');
  const trackTouch = (e) => {
    _mapTouching = e.touches ? e.touches.length : 0;
    // 手勢開始 → 停掉朝車頭旋轉動畫（角度對齊目前地圖 bearing）。動畫狀態已搬入 orient.js。
    if (_mapTouching > 0) MaptripOrient.cancelBearingAnim();
  };
  // 計數掛在 document（不能只掛 #map）：手指在地圖按下、卻在懸浮按鈕/彈窗上放開時，
  // #map 收不到那個 touchend，計數會永遠卡在 >0 → 跟隨/旋轉/歸位全部停擺
  document.addEventListener('touchstart', trackTouch, { passive: true });
  document.addEventListener('touchend', trackTouch, { passive: true });
  document.addEventListener('touchcancel', trackTouch, { passive: true });
  const mapTouchDone = (e) => {
    trackTouch(e);
    if (_mapTouching !== 0) return;
    resyncLiveLine();
    // 沒在跟隨時，手指離開地圖也排一次 5 秒歸位（歷史檢視時除外）
    if (!autoFollow && !inBrowsingMode() && currentPos) _wantFollowResume = true;
    scheduleFollowResume();
  };
  mapEl.addEventListener('touchend', mapTouchDone, { passive: true });
  mapEl.addEventListener('touchcancel', mapTouchDone, { passive: true });

  // 縮放動畫期間「絕不」改動向量線（Leaflet 縮放中改線會用新座標系重算、疊在舊變換上 → 整條線飛走）
  map.on('zoomstart', () => { _mapZooming = true; });
  map.on('zoomend', () => { _mapZooming = false; resyncLiveLine(); redrawAllLines(); });
  // leaflet-rotate 已知問題：手勢式「縮小＋旋轉」後，SVG 折線的幾何有時沒跟著重算，
  // 整條路線飄離底圖（點/標記正常，只有線脫鉤）。底圖穩定後強制以目前投影重畫所有折線。
  // moveend 涵蓋 pan/zoom/rotate 手勢的收尾；rotate 連續事件則去抖 150ms 後補畫一次。
  map.on('moveend', () => { if (!_mapZooming && !_mapTouching) redrawAllLines(); });
  let _rotRedraw = null;
  map.on('rotate', () => { clearTimeout(_rotRedraw); _rotRedraw = setTimeout(() => { if (!_mapTouching) redrawAllLines(); }, 150); });

  // 單趟顯示列：左右滑切換趟次（往左滑＝下一趟，往右滑＝上一趟）
  setupSoloSwipe();

  // Live Activity（鎖屏方塊）整合
  if (isNative()) {
    const App = window.Capacitor?.Plugins?.App;
    const la = liveAct();
    dbg('boot v' + APP_VERSION + ' la=' + (la ? 'ok' : 'NULL'));
    if (la) {
      // 主要路徑：LiveActivityPlugin 直接截取 Capacitor URL notification → mapTripUrl 事件
      la.addListener?.('mapTripUrl', ({ url }) => { dbg('mapTripUrl ' + url); handleWidgetUrl(url); });
      // 備援路徑 A：Capacitor App plugin 的 appUrlOpen（若 AppDelegate/SceneDelegate 有轉發）
      App?.addListener('appUrlOpen', data => { dbg('appUrlOpen ' + data?.url); handleWidgetUrl(data?.url); });
      // 備援路徑 B：冷啟動 URL（被殺狀態時比 listener 早到）
      App?.getLaunchUrl?.().then(res => {
        if (res?.url) { dbg('launchUrl ' + res.url); handleWidgetUrl(res.url); }
      }).catch(() => {});
      // App Intent 按鈕（已停用，保留以防萬一）
      la.addListener?.('liveActivityCommand', ({ action }) => {
        dbg('event liveActivityCommand: ' + action);
        if (action === 'start') widgetStart();
        if (action === 'end'   && activeTrip)  endTrip();
      });
      // initActivity 先完成（非同步），再補做鎖屏暫存指令。
      // 不能同時呼叫：initActivity 會非同步建立閒置方塊，若此時 consumePendingWidgetCmd
      // 同步呼叫 startTrip 設為「記錄中」，initActivity 的 Task 跑完後會把方塊蓋回閒置。
      la.initActivity().then(() => { dbg('initActivity done → consume'); consumePendingWidgetCmdRetry(); });
      // 前景續命計時器（背景由 onGpsUpdate 觸發）。設 3 秒，配合 6 秒過期時間，
      // 即使前景時 GPS 沒更新，方塊也不會誤消失。
      setInterval(widgetHeartbeat, 3000);
      // 回到前景時：補做鎖屏指令；沒有指令且未記錄中才重建方塊（避免覆蓋記錄狀態）
      App?.addListener('appStateChange', ({ isActive }) => {
        dbg('appStateChange isActive=' + isActive);
        if (isActive) {
          fixLayout();
          consumePendingWidgetCmd().then(didAct => {
            if (!didAct && !activeTrip) la.initActivity();
          });
        }
      });
    }

    // Android 浮動視窗：結束鈕 / 點卡片回 App
    const fw = floatWin();
    if (fw) {
      dbg('boot v' + APP_VERSION + ' fw=ok');
      fw.addListener?.('floatCommand', ({ action }) => {
        dbg('floatCommand ' + action);
        if (action === 'start' && !activeTrip) startTrip();
        if (action === 'end' && activeTrip) endTrip(true);
      });
      // 浮窗數字鍵盤輸入的車資 → 存到剛結束的那趟
      fw.addListener?.('floatFare', ({ value, paymentMethod }) => {
        dbg('floatFare ' + value);
        saveFloatFare(value || 0, paymentMethod || '');
      });
      // 常駐顯示：有授權就先顯示閒置卡片（沒授權靜默略過）
      ensureFloatPermission().then(() => { if (!activeTrip) fw.showIdle().catch(() => {}); });
      // 回前景時重試（例如剛去設定開完權限）：未記錄中才補顯示閒置卡片
      App?.addListener('appStateChange', ({ isActive }) => {
        if (isActive && !activeTrip) fw.showIdle().catch(() => {});
      });
      // 記錄中時把時間/距離推給浮窗（widgetHeartbeat 內含 floatWin().update）
      setInterval(widgetHeartbeat, 3000);
    }
  }

  // 退到背景（跑導航等其他 App）時卸下圖磚：Google 圖磚的已解碼影像是背景時最大的
  // 記憶體佔用，而 WKWebView 記憶體超標會被 iOS 整個砍掉（回前景全白＋重載）。
  // 背景看不到地圖，卸掉零成本；回前景重掛，圖磚多半還在 HTTP 快取、瞬間回來。
  if (!window.MAPTRIP_GL) {
    document.addEventListener('visibilitychange', () => {
      try {
        const t = TILE_LAYERS[currentTile];
        if (document.hidden) { if (map.hasLayer(t)) map.removeLayer(t); }
        else if (!map.hasLayer(t)) t.addTo(map);
      } catch (_) {}
    });
  }

  // 注入錄製狀態機（recorder.js）需要的 map 與共用活狀態存取器（getter 呼叫時才讀，
  // 故 activeTrip/todayTrips 之後被同步刷新換新物件時模組仍拿得到最新）。須在
  // restoreActiveTripIfAny/startGpsWatch 之前完成。
  MaptripRecorder.init({
    testMode: TEST_MODE_ON,
    getMap: () => map,
    getActive: () => activeTrip,
    setActive: (v) => { activeTrip = v; },
    getActivePolyline: () => activePolyline,
    setActivePolyline: (v) => { activePolyline = v; },
    getCurrentPos: () => currentPos,
    getWakeLock: () => wakeLock,
    setWakeLock: (v) => { wakeLock = v; },
    setPendingWidgetStart: (v) => { pendingWidgetStart = v; },
    setActiveSnapPending: (v) => { activeSnapPending = v; },
    getTodayTrips: () => todayTrips,
    getAllMapLayers: () => allMapLayers
  });

  loadTodayFromStorage();
  // 電腦版「檢視台模式」：藏/停用 GPS 記錄相關 UI、選單補滑鼠點擊、加切換鈕（原生 App 不受影響）
  try { if (window.MaptripDesktop) MaptripDesktop.apply(); } catch (_) {}
  const _review = !!(window.MaptripDesktop && MaptripDesktop.isReview());
  if (!_review) {
    restoreActiveTripIfAny();   // 若上次重載/當掉時正在記錄，自動接回
    startGpsWatch();            // 檢視台版不啟動 GPS（記帳者/回放不需要定位）
  }
  updateTopBar();
  setInterval(updateTopBar, 30000);
  // 頁面即將卸載（重載/切走）前，把進行中的行程再存一次，把損失壓到最小
  window.addEventListener('pagehide', saveActiveTrip);
  window.addEventListener('beforeunload', saveActiveTrip);
}

// ===== 錄製狀態機（js/recorder.js，MaptripRecorder）=====
// 行程生命週期（start/begin/end/finalize）、進行中復原、鎖屏方塊/浮窗介面、GPS 監看啟動
// 已抽成模組（邏輯逐字不變，僅把 activeTrip/activePolyline/wakeLock 等共用活狀態經 init 注入）。
// 以下為同名薄包裝轉呼叫，呼叫端（含 HTML onclick、initMap 事件）零改動。
// 【刻意保留在 app.js】onGpsUpdate 的「逐點收錄」子區塊與 activeDist/snapLiveRoute——它們與
// 地圖手勢狀態 _mapZooming/_mapTouching/_lineResyncPending 綁死，是繪圖而非狀態機，故不搬，
// GPS 熱路徑零改動。onGpsUpdate 仍在下方原地。
function startGpsWatch() { return MaptripRecorder.startGpsWatch(); }
function startNativeGpsWatch() { return MaptripRecorder.startNativeGpsWatch(); }
function startSimulation() { return MaptripRecorder.startSimulation(); }
function runSimulation(base) { return MaptripRecorder.runSimulation(base); }
function restartSimulation() { return MaptripRecorder.restartSimulation(); }

function onGpsUpdate(pos) {
  const { latitude: lat, longitude: lng, accuracy: acc, speed, altitude: alt, altitudeAccuracy: altAcc } = pos.coords;

  // 計算有效速度（GPS 不提供時從位置差推算）
  let effectiveSpeed = speed;
  if ((effectiveSpeed == null || isNaN(effectiveSpeed) || effectiveSpeed < 0) && lastKnownPos) {
    const dt = (Date.now() - lastKnownPos.t) / 1000;
    if (dt > 0 && dt < 15) effectiveSpeed = haversine(lastKnownPos, { lat, lng }) / dt;
  }
  lastKnownPos = { lat, lng, t: Date.now() };
  currentPos = { lat, lng };
  setGpsBadge(acc <= MIN_ACCURACY_M ? 'on' : 'warn', `📍 ±${Math.round(acc)} m`);

  // 鎖屏在 GPS 定位前就按了開始：現在拿到第一筆定位，補開始行程
  if (pendingWidgetStart && !activeTrip) {
    pendingWidgetStart = false;
    beginRecording();
  }

  // 背景續命：背景 GPS 回呼會持續觸發，藉此刷新鎖屏方塊的 staleDate
  if (isNative()) widgetHeartbeat();

  // GPS 行進方向（移動時才可靠）→ 更新我的朝向
  if (pos.coords.heading != null && !isNaN(pos.coords.heading) &&
      pos.coords.heading >= 0 && effectiveSpeed > 1.5) {
    myHeading = pos.coords.heading;
  }

  if (!myDotMarker) {
    const icon = L.divIcon({
      className: '',
      // 方向光束：從藍點向外展開的漸層扇形（Google 地圖風格，取代舊的生硬三角形）
      html: '<div class="myloc"><div class="myloc-rot" style="display:none">' +
        '<svg class="myloc-beam" viewBox="0 0 60 60" width="60" height="60">' +
        '<defs><radialGradient id="mylocBeamGrad" cx="0.5" cy="0.5" r="0.5">' +
        '<stop offset="0%" stop-color="#4285F4" stop-opacity="0.65"/>' +
        '<stop offset="55%" stop-color="#4285F4" stop-opacity="0.35"/>' +
        '<stop offset="100%" stop-color="#4285F4" stop-opacity="0"/>' +
        '</radialGradient></defs>' +
        '<path d="M30 30 L16.9 6.4 A27 27 0 0 1 43.1 6.4 Z" fill="url(#mylocBeamGrad)"/>' +
        '</svg></div><div class="myloc-dot"></div></div>',
      iconSize: [60, 60], iconAnchor: [30, 30]
    });
    myDotMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
    accuracyCircle = L.circle([lat, lng], {
      radius: acc, color: '#4285F4', fillColor: '#4285F4',
      fillOpacity: 0.06, weight: 1, opacity: 0.25
    }).addTo(map);
    map.setView([lat, lng], 16);
    // 開機拿到第一筆定位就進入跟隨：地圖才會立刻朝車頭旋轉
    // （旋轉被 autoFollow 擋著，否則預設朝車頭要等按定位鈕/開始記錄才生效）
    setAutoFollow(true);
  } else {
    myDotMarker.setLatLng([lat, lng]);
    // 精度圓圈：位置/精度沒有實質變化就不重畫（GL 模式每次更新都會觸發整張重繪）
    if (!_lastCircleAt || haversine(_lastCircleAt, { lat, lng }) >= 3 ||
        Math.abs((_lastCircleAt.acc || 0) - (acc || 0)) >= 3) {
      _lastCircleAt = { lat, lng, acc };
      accuracyCircle.setLatLng([lat, lng]).setRadius(acc);
    }
  }
  updateMyHeadingArrow();

  // 跟隨移動門檻：停等紅燈時 GPS 每秒仍回報、位置只抖 1~3m，若每筆都跑 0.5 秒
  // 跟隨動畫，怠速時 GPU 全在做白工（發燙/卡頓主因之一）。移動 ≥3m 才跟隨，
  // 真正行駛（≥3m/s）每秒必過門檻，跟隨體感完全不變；靜止時地圖完全靜止。
  if (autoFollow && !_mapTouching && !inBrowsingMode()) {
    if (!_lastPanPos || haversine(_lastPanPos, { lat, lng }) >= 3) {
      _lastPanPos = { lat, lng };
      map.panTo([lat, lng], { animate: true, duration: 0.5 });
    }
  }

  if (activeTrip) {
    // GPS 品質閘門已抽成模組 js/geo-gate.js（判準不變：精度>40m 或 相對上點瞬移>50 m/s 不記錄）。
    // 都市峽谷/高架反射會產生亂飄點；過濾掉的點也不畫進即時折線，畫面與存檔一致（藍點仍照常移動）。
    const last = activeTrip.coords.at(-1);

    if (MaptripGeoGate.accept({ lat, lng, accuracy: acc, t: Date.now() }, last).accept) {
      // 每次 GPS 更新都延伸折線（畫面即時跟隨軌跡）。
      // 縮放/手勢期間先不畫（否則整條線會飛走），結束後 resyncLiveLine 一次補上
      if (_mapZooming || _mapTouching) _lineResyncPending = true;
      else activePolyline.addLatLng([lat, lng]);

      // 每 GPS_RECORD_MS 才存一個座標點（節省儲存空間）
      if (!last || Date.now() - last.t >= GPS_RECORD_MS) {
        if (last) activeTrip._dist = activeDist() + haversine(last, { lat, lng });  // 增量累加距離
        activeTrip.coords.push({ lat, lng, t: Date.now() });
        saveActiveTrip();   // 每存一個座標就更新復原暫存（內部節流 5 秒）
        // GPS 高度黑盒子（橋上/橋下量測用）：獨立於行程座標，不影響貼路/壓實/同步。
        // altitude/altitudeAccuracy 由外掛回傳，之前被丟棄；這裡收進 mt_altlog 供事後判讀。
        if (window.MaptripAlt) MaptripAlt.record({ t: Date.now(), lat, lng, alt, altAcc, spd: effectiveSpeed });
        // 定期把累積軌跡貼合到道路上（即時更新折線）
        const n = activeTrip.coords.length;
        if (n >= 4 && n % LIVE_SNAP_PTS === 0 && !activeSnapPending) {
          activeSnapPending = true;
          snapLiveRoute();
        }
      }
    }
  }

  // 地圖朝車頭旋轉放最後，並包 try/catch：即使旋轉出錯也絕不影響上面的行程記錄
  try { applyHeadingUp(lat, lng, effectiveSpeed, pos.coords.heading); } catch (_) {}
}

// 自動偵測彈窗（行駛中→問開始、停車→問結束）已於 v1.1.256 移除：行程一律手動開始/結束，
// 此功能長期停用（AUTO_PROMPTS=false）為死碼，整段（含到達/出發偵測、橫幅 UI、相關常數/變數）刪除。

function onGpsError(err) { return MaptripRecorder.onGpsError(err); }

function startTrip() { return MaptripRecorder.startTrip(); }

// 鎖屏 widget 的 maptrip:// URL 路由（背景喚醒 appUrlOpen + 冷啟動 getLaunchUrl 共用）
function handleWidgetUrl(url) { return MaptripRecorder.handleWidgetUrl(url); }

// 鎖屏 Widget 觸發的開始（GPS 未定位時排隊，見 recorder.js / app.js onGpsUpdate）
function widgetStart() { return MaptripRecorder.widgetStart(); }

// 補做鎖屏暫存指令；回傳 Promise<bool>，true 表示真的執行了指令（start 或 end）
function consumePendingWidgetCmd() { return MaptripRecorder.consumePendingWidgetCmd(); }

// 冷啟動補做：perform() 可能比 JS boot 晚執行（時序競賽），所以重試數次。
function consumePendingWidgetCmdRetry(tries = 6, gapMs = 600) { return MaptripRecorder.consumePendingWidgetCmdRetry(tries, gapMs); }

// 替鎖屏方塊「續命」：刷新原生端 staleDate；記錄中同時更新 elapsed + distance
function widgetHeartbeat() { return MaptripRecorder.widgetHeartbeat(); }

// 記錄中的累計距離（增量維護，長行程不必每秒全量重算）
function activeDist() {
  if (!activeTrip) return 0;
  if (activeTrip._dist == null) activeTrip._dist = calcTotalDist(activeTrip.coords);
  return activeTrip._dist;
}

function setAutoFollow(on) {
  autoFollow = on;
  if (on) {   // 已進入跟隨 → 取消排程中的自動歸位
    _wantFollowResume = false;
    clearTimeout(_resumeFollowTimer);
  }
  const btn = document.getElementById('locate-btn');
  if (btn) btn.classList.toggle('follow-active', on);
}

// 歷史檢視模式（單趟 / 日預覽 / 回放）：這些是在看過去的行程，自動歸位一律停用
function inBrowsingMode() {
  return (typeof soloSet !== 'undefined' && soloSet.length) ||
         dayPreviewKey || (typeof isReplaying === 'function' && isReplaying());
}

// 拖動暫停跟隨後：5 秒無操作自動飛回目前位置、恢復跟隨（含朝車頭旋轉）
let _resumeFollowTimer = null, _wantFollowResume = false;
function scheduleFollowResume() {
  if (!_wantFollowResume) return;
  clearTimeout(_resumeFollowTimer);
  _resumeFollowTimer = setTimeout(() => {
    if (!_wantFollowResume) return;
    // 進入歷史檢視 → 直接取消歸位（不再拉回目前位置）
    if (inBrowsingMode()) { _wantFollowResume = false; return; }
    // 手指還在地圖上（手勢進行中）→ 延後再試
    if (_mapTouching) { scheduleFollowResume(); return; }
    _wantFollowResume = false;
    if (!currentPos) return;
    setAutoFollow(true);
    map.panTo([currentPos.lat, currentPos.lng], { animate: true, duration: 0.8 });
    if (headingUp && lastHeading) setTargetBearing(-lastHeading);
  }, 5000);
}

async function beginRecording() { return MaptripRecorder.beginRecording(); }

// 取得螢幕常亮鎖
async function requestWakeLock() { return MaptripRecorder.requestWakeLock(); }

// 回到前景時自動重新鎖定螢幕常亮（系統會在熄屏/切 App 時釋放鎖）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeTrip && wakeLock === null) {
    requestWakeLock();
  }
});

// fromFloat=true：由浮動視窗的「結束」鈕觸發 → 車資改用浮窗數字鍵盤輸入
function endTrip(fromFloat) { return MaptripRecorder.endTrip(fromFloat); }

// 更新「已落盤」的行程：補車資 / 付款方式 / 貼路座標，並重畫該趟路線。（以 id 重新定位避免寫到孤兒物件）
async function finalizeSavedTrip(trip, fare, paymentMethod, label, commission, dispatch) {
  return MaptripRecorder.finalizeSavedTrip(trip, fare, paymentMethod, label, commission, dispatch);
}

// ===== 進行中行程的「當機／重載」復原（js/recorder.js）=====
function saveActiveTrip(force) { return MaptripRecorder.saveActiveTrip(force); }
function clearActiveTrip() { return MaptripRecorder.clearActiveTrip(); }
function restoreActiveTripIfAny() { return MaptripRecorder.restoreActiveTripIfAny(); }

// 浮窗數字鍵盤按「確定/略過」後：把車資補進「已落盤」的那趟並貼路
async function saveFloatFare(fare, paymentMethod) { return MaptripRecorder.saveFloatFare(fare, paymentMethod); }

// 背景結束：直接貼合道路並存檔（金額 0），不需 UI
async function saveTripBackground(trip) { return MaptripRecorder.saveTripBackground(trip); }

// 把某趟的抽成/叫車費寫進雲端「抽成集合」（司機本人；記帳者才看得到，也是雙向來源）
function _pushCommission(tripId, commission, dispatch) {
  try {
    if (window.MaptripSync && MaptripSync.writeCommission && MaptripSync.myUid && MaptripSync.myUid())
      MaptripSync.writeCommission(MaptripSync.myUid(), tripId, commission, dispatch).catch(() => {});
  } catch (_) {}
}

// 車資對話框（叫車費切換/抽成欄/付款）已抽成模組 js/fare-dialog.js（MaptripFareDialog，
// body 逐字不變、狀態 _dispatchOn/_dispatchAmt 為模組私有）。以下為同名薄包裝轉呼叫，
// 呼叫端（editFare/editHistoryFare、recorder.js showFareDialog、HTML onclick）零改動。
// （DISPATCH_FEE 已隨對話框搬入 fare-dialog.js；app.js 內已無引用處）
function toggleDispatch() { return MaptripFareDialog.toggleDispatch(); }
function _readFareExtra() { return MaptripFareDialog._readFareExtra(); }
function _setFareExtra(commission, dispatch) { return MaptripFareDialog._setFareExtra(commission, dispatch); }
function _showCommissionField(show) { return MaptripFareDialog._showCommissionField(show); }
function showFareDialog(trip) { return MaptripFareDialog.showFareDialog(trip); }

function saveTripFinal(trip) {
  if (todayTrips.length > 0) {
    try {
      const prevCoords = tripPath(todayTrips[todayTrips.length - 1]);
      const curCoords  = tripPath(trip);
      if (prevCoords.length && curCoords.length)
        allMapLayers.push(drawGapLine(prevCoords.at(-1), curCoords[0]));
    } catch (_) {}
  }
  drawTripLine(trip, todayTrips.length + 1);
  todayTrips.push(trip);
  saveTodayToStorage(); updateTopBar();
  const fareStr = trip.fare ? `　NT$ ${trip.fare}` : '';
  toast(`✓ 第 ${todayTrips.length} 趟　${fmtDur(trip.endTime - trip.startTime)}　${fmtDist(trip.totalDist)}${fareStr}`);
}

// OSRM 貼路（_sampleTrack / _snapSane / snapToRoads）已抽成模組 js/snap.js（MaptripSnap，
// 邏輯逐字不變、已用 sampleTrack/snapSane 純函式回歸＋snapToRoads 7 情境測試驗證與原版一致）。
// snapToRoads 見下方委派；診斷用 window._snapErr 仍由模組寫入，retrySnapBacklog 照常讀取。

// GPS 飄移群清理已抽成模組 js/geo-clean.js（_perpM/_dropSpikes/_cleanTrace 邏輯逐字不變，
// 已用 404 案例回歸測試驗證與原版輸出完全相同）。這裡保留同名 _cleanTrace 委派，
// 呼叫端（snapToRoads / retrySnapBacklog / finalize 等）不需改動。
function _cleanTrace(coords) { return MaptripGeoClean.cleanTrace(coords); }

async function snapToRoads(coords) { return MaptripSnap.snapToRoads(coords); }

// 即時路線貼合：行程進行中定期更新地圖折線為道路路徑
async function snapLiveRoute() {
  if (!activeTrip) { activeSnapPending = false; return; }
  const snapshot = activeTrip.coords.slice(); // 快照避免競態
  const snapped = await snapToRoads(snapshot);
  activeSnapPending = false;
  if (!snapped || !activePolyline || !activeTrip) return;
  if (_mapZooming || _mapTouching) { _lineResyncPending = true; return; }  // 縮放中不改線
  // 重建折線：貼合段 + 貼合後新增的原始 GPS 尾段
  const latlngs = snapped.map(c => [c.lat, c.lng]);
  activeTrip.coords.slice(snapshot.length).forEach(c => latlngs.push([c.lat, c.lng]));
  activePolyline.setLatLngs(latlngs);
}

// 底圖穩定後（縮放/旋轉/平移收尾）強制以目前投影重畫所有折線。
// 修 leaflet-rotate 手勢式縮放+旋轉後 SVG 折線幾何沒跟著重算、整條飄離底圖的問題。
// 標準地圖才需要；GL（向量）由引擎原生處理，redraw 不存在時自動略過。
function redrawAllLines() {
  const redraw = (l) => { if (l && typeof l.redraw === 'function') { try { l.redraw(); } catch (_) {} } };
  try { allMapLayers.forEach(redraw); } catch (_) {}
  try { if (typeof soloLayers !== 'undefined') soloLayers.forEach(redraw); } catch (_) {}
  try { if (typeof dayPreviewLayers !== 'undefined') dayPreviewLayers.forEach(redraw); } catch (_) {}
  try { if (window.MaptripReplay) MaptripReplay.tempLayers().forEach(redraw); } catch (_) {}
  try { redraw(activePolyline); } catch (_) {}
}

// 縮放/手勢結束後：把期間累積、沒畫進去的點一次補上（整條線從記錄座標重建）
function resyncLiveLine() {
  if (!_lineResyncPending) return;
  if (_mapZooming || _mapTouching) return;   // 還在動，等真正結束
  _lineResyncPending = false;
  if (activePolyline && activeTrip && activeTrip.coords.length) {
    activePolyline.setLatLngs(activeTrip.coords.map(c => [c.lat, c.lng]));
  }
}

// 兩趟之間的連接曲線座標（二次 Bezier，向外彎一點）
function bezierGapPoints(from, to) {
  const lat0 = from.lat, lng0 = from.lng;
  const lat2 = to.lat,   lng2 = to.lng;
  const dLat = lat2 - lat0, dLng = lng2 - lng0;
  const midLat = (lat0 + lat2) / 2 - dLng * 0.25;
  const midLng = (lng0 + lng2) / 2 + dLat * 0.25;
  const pts = [];
  for (let i = 0; i <= 32; i++) {
    const t = i / 32, u = 1 - t;
    pts.push([u*u*lat0 + 2*u*t*midLat + t*t*lat2,
              u*u*lng0 + 2*u*t*midLng + t*t*lng2]);
  }
  return pts;
}

function drawGapLine(from, to) {
  const gap = L.polyline(bezierGapPoints(from, to),
    { color: '#EA4335', weight: 2.5, opacity: 0.75, dashArray: '6 5', pane: _todayPane('todayLines') }).addTo(map);
  _applyTodayMode([gap]);
  return gap;
}

// 回傳存在的 today pane 名稱；不存在（GL 模式或建立失敗）回 undefined → 用預設 pane
function _todayPane(name) {
  try { if (map.getPane && map.getPane(name)) return name; } catch (_) {}
  return undefined;
}
// 整組顯示/隱藏今日行程圖層（pane 一次搞定，不漏任何一個標記/線）
function showTodayLayers(on) {
  _todayMode = on ? 'normal' : 'hidden';
  ['todayLines', 'todayMarks'].forEach(p => {
    try { const pane = map.getPane && map.getPane(p); if (pane) pane.style.display = on ? '' : 'none'; } catch (_) {}
  });
  // GL 模式或未進 pane 的圖層：線用不透明度、點用 setOpacity（GL shim 0＝display:none）
  allMapLayers.forEach(l => {
    if (l.setStyle) { try { l.setStyle({ opacity: on ? 0.85 : 0 }); } catch (_) {} }
    else if (l.setOpacity) { try { l.setOpacity(on ? 1 : 0); } catch (_) {} }
  });
}
// 依當前 _todayMode 套用圖層外觀。修正兩個外漏源：
// (1) 貼路成功/同步的「重畫」發生在歷史/單趟檢視期間 → 新圖層原本以全濃度冒出
// (2) 今日單趟預覽的「點」：淡化在 GL 會被引擎重繪蓋回全濃度 → 改為整組隱藏
function _applyTodayMode(layers) {
  if (_todayMode === 'normal') return;
  const lineOp = _todayMode === 'solo' ? 0.12 : 0;
  layers.forEach(l => {
    if (!l) return;
    if (l.setStyle) { try { l.setStyle({ opacity: lineOp }); } catch (_) {} }
    else if (l.setOpacity) { try { l.setOpacity(0); } catch (_) {} }
  });
}

// 取一趟的可畫路徑：極舊雲端資料可能沒有座標，一律回傳陣列（可能為空），
// 呼叫端遇空就略過繪製 —— 一趟壞資料絕不能讓整個載入/預覽/回放迴圈死掉
function tripPath(t) {
  if (!t) return [];
  let c = t.roadCoords || t.coords;
  // 假路線防線（顯示層）：貼路路徑比記錄距離長太多（>1.4 倍 + 500m）＝飄點造成的
  // 繞遠假路線 → 永不顯示，退回原始座標。比一次性修復堅固：就算雲端同步把舊的
  // 假路線蓋回本機，畫面也不受影響。結果快取在 _roadBad，不必每次重算路徑長。
  if (t.roadCoords && t.totalDist > 0) {
    if (t._roadBad === undefined) {
      try { t._roadBad = calcTotalDist(t.roadCoords) > t.totalDist * 1.4 + 500; }
      catch (_) { t._roadBad = false; }
    }
    if (t._roadBad) c = t.coords;
  }
  return Array.isArray(c) ? c : [];
}

function drawTripLine(trip, idx) {
  // 優先用道路貼合座標，否則退回 GPS 直線
  const latlngs = tripPath(trip).map(c => [c.lat, c.lng]);
  if (!latlngs.length) { trip._layers = []; return; }   // 無座標的舊趟：不畫線，清單/金額照常
  const line = L.polyline(latlngs, { color: '#1A73E8', weight: 5, opacity: 0.85, pane: _todayPane('todayLines') }).addTo(map);
  // 點該行程路徑 → 進入該趟的單趟預覽（今日）
  line.on('click', () => {
    const k = todayTrips.indexOf(trip);
    if (k < 0) return;
    soloFromHistory = false;
    openSoloTrip(todayTrips, k, i => `第 ${i + 1} 趟 / 共 ${todayTrips.length} 趟`);
  });
  const startMk = L.marker(latlngs[0], { icon: makeNumberIcon(idx, '#34A853'), zIndexOffset: 10, pane: _todayPane('todayMarks') }).addTo(map);
  const endMk   = L.marker(latlngs.at(-1), { icon: makeEndIcon(), pane: _todayPane('todayMarks') }).addTo(map);
  allMapLayers.push(line, startMk, endMk);
  trip._layers = [line, startMk, endMk];
  _applyTodayMode(trip._layers);   // 歷史/單趟檢視期間重畫的趟：立即套用當前狀態，不外漏
}

// 深色模式偵測（系統設定）
function _isDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
// 無標示底圖（淺/深）
const NOLABEL_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png';
const NOLABEL_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png';

// 地圖標記圖示工廠已抽成模組 js/icons.js（MaptripIcons，純函式，body 逐字不變）。
// 以下為同名薄包裝轉呼叫，呼叫端零改動。
function makeNumberIcon(n, color, dark) { return MaptripIcons.makeNumberIcon(n, color, dark); }
function makeDotIcon(color) { return MaptripIcons.makeDotIcon(color); }
function makeStartIcon() { return MaptripIcons.makeStartIcon(); }
function makeEndIcon() { return MaptripIcons.makeEndIcon(); }
function makePreviewDotIcon() { return MaptripIcons.makePreviewDotIcon(); }
function makePreviewSquareIcon(dark) { return MaptripIcons.makePreviewSquareIcon(dark); }

function centerOnMe() {
  if (!currentPos) { toast('尚未取得位置'); return; }
  setAutoFollow(true);
  enableDeviceCompass();   // 開啟羅盤：停著也能顯示方向光束
  map.setView([currentPos.lat, currentPos.lng], 16);
  // 朝車頭模式：恢復跟隨的同時也恢復自動旋轉
  if (headingUp && lastHeading) setTargetBearing(-lastHeading);
}

// 兩點間方位角（度，正北為 0，順時針）
// 地圖朝向/羅盤/方向光束（朝車頭旋轉）已抽成模組 js/orient.js（MaptripOrient，body 逐字不變，
// 依賴注入 map 與共用活狀態 myHeading/headingUp/lastHeading/autoFollow/_mapTouching/soloSet/
// dayPreviewKey）。以下為同名薄包裝轉呼叫，呼叫端（onGpsUpdate/scheduleFollowResume/預覽/
// HTML onclick/boot）零改動。手勢動畫中止改呼叫 MaptripOrient.cancelBearingAnim()（見 initMap）。
// headingRefPos/deviceCompassOn/lastMoveSpeed 與動畫角度/RAF handle 隨模組搬入。
function bearingBetween(a, b) { return MaptripOrient.bearingBetween(a, b); }
function updateCompassNeedle() { return MaptripOrient.updateCompassNeedle(); }
function updateMyHeadingArrow() { return MaptripOrient.updateMyHeadingArrow(); }
function setTargetBearing(deg) { return MaptripOrient.setTargetBearing(deg); }
function resetBearingNow() { return MaptripOrient.resetBearingNow(); }
function toggleCompass() { return MaptripOrient.toggleCompass(); }
function enableDeviceCompass(silent) { return MaptripOrient.enableDeviceCompass(silent); }
function applyHeadingUp(lat, lng, effectiveSpeed, gpsHeading) { return MaptripOrient.applyHeadingUp(lat, lng, effectiveSpeed, gpsHeading); }
// 注入 map 與共用活狀態存取器（getter 呼叫時才讀 → map 於 initMap 建立後仍取得最新）。
MaptripOrient.init({
  getMap: () => map,
  getMyDotMarker: () => myDotMarker,
  getMyHeading: () => myHeading,        setMyHeading: (v) => { myHeading = v; },
  getHeadingUp: () => headingUp,        setHeadingUp: (v) => { headingUp = v; },
  getLastHeading: () => lastHeading,    setLastHeading: (v) => { lastHeading = v; },
  getAutoFollow: () => autoFollow,
  getMapTouching: () => _mapTouching,
  getSoloSet: () => soloSet,
  getDayPreviewKey: () => dayPreviewKey
});

let _uiDayKey = null;   // 目前 UI 顯示的營業日，跨 7:00 換日時用來觸發刷新
function updateTopBar() {
  // 顯示「營業日」日期（07:00 之前仍算前一天）
  const d = new Date(Date.now() - DAY_SPLIT_HOUR * 3600 * 1000);
  document.getElementById('top-date').textContent =
    d.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' });
  document.getElementById('trip-count').textContent = todayTrips.length;
  // App 長開跨過 7:00：自動把「今日」清單換成新營業日（記錄中不動，結束後會刷新）
  const dk = todayKey();
  if (_uiDayKey == null) _uiDayKey = dk;
  else if (dk !== _uiDayKey && !activeTrip) {
    _uiDayKey = dk;
    if (typeof refreshAfterSync === 'function') refreshAfterSync();
  }
}

function refreshRecBanner() {
  if (!activeTrip) return;
  const elapsed = Date.now() - activeTrip.startTime;
  const dist    = activeDist();
  document.getElementById('rec-time').textContent = fmtDur(elapsed);
  document.getElementById('rec-dist').textContent = fmtDist(dist);
  liveAct()?.updateTrip({ elapsed: Math.floor(elapsed / 1000), distance: Math.round(dist) });
}

// WKWebView reload 後 CSS 位置已被 reload-fix 更新，但 compositor 仍用舊視覺座標，
// 導致 touch clientY 與 getBoundingClientRect 之間差了 env(safe-area-inset-top)。
// 用探針 div 量出這個 offset，補正後再對比按鈕 rect。
function _menuHitBtn(e) {
  const menu = document.getElementById('top-menu');
  if (!menu || menu.style.display === 'none') return null;
  const t = e.changedTouches && e.changedTouches[0];
  if (!t) return null;
  const x = t.clientX;
  let y = t.clientY;
  // 只在 iOS reload 狀態下修正：reload-fix 把固定元素往上移了 safe-area-inset-top，
  // 但 touch 座標仍對應舊的視覺位置，所以減掉這個差值再和 getBCR 比較。
  if (nativePlatform() === 'ios' && document.getElementById('reload-fix')) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);left:0;width:0;height:0;pointer-events:none;visibility:hidden;';
    document.body.appendChild(probe);
    y -= probe.getBoundingClientRect().top;
    document.body.removeChild(probe);
  }
  let hit = null;
  menu.querySelectorAll('button[data-menu]').forEach(b => {
    const r = b.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom && x >= r.left && x <= r.right) hit = b;
  });
  return hit;
}
// 手指按下：自己用修正後座標標記高亮（原生 :active 會亮錯按鈕）
function _menuTouchStart(e) {
  const hit = _menuHitBtn(e);
  document.querySelectorAll('#top-menu button.pressed').forEach(b => b.classList.remove('pressed'));
  if (hit) hit.classList.add('pressed');
}
function _menuTouchEnd(e) {
  const menu = document.getElementById('top-menu');
  if (!menu || menu.style.display === 'none') return;
  e.preventDefault();
  const hit = _menuHitBtn(e);
  const action = hit ? hit.getAttribute('data-menu') : null;
  closeTopMenu();
  _dispatchMenu(action);
}
// 選單派發（touch 與電腦版滑鼠點擊共用）。防重：400ms 內同一次點的 touch+click 只派一次。
let _lastMenuAt = 0;
function _dispatchMenu(action) {
  if (!action) return;
  const now = Date.now();
  if (now - _lastMenuAt < 400) return;
  _lastMenuAt = now;
  if (action === 'today') toggleTripList();
  else if (action === 'finance') { closeSheet(); if (window.openFinance) window.openFinance(); }
  else if (action === 'bookkeeper') { closeSheet(); if (window.openBookkeeper) window.openBookkeeper(); }
  else if (action === 'history') showHistory();
  else if (action === 'sync') openSyncDialog();
  else if (action === 'hotspot') { closeSheet(); if (window.openHotspots) window.openHotspots(); }
  else if (action === 'glmap') toggleGlEngine();
  else if (action === 'reviewtoggle') { if (window.MaptripDesktop) MaptripDesktop.toggle(); }
}
window._dispatchMenu = _dispatchMenu;

// 切換地圖引擎：向量（MapLibre GL，旋轉時文字保持正立）↔ 標準（Leaflet）
function toggleGlEngine() {
  if (activeTrip) { toast('行程記錄中，請先結束再切換地圖引擎'); return; }
  // 依「目前實際引擎」切換：向量預設開啟，'0'=強制標準、'1'=強制向量
  if (window.MAPTRIP_GL) localStorage.setItem('maptrip_gl', '0');   // 目前向量 → 換標準
  else localStorage.setItem('maptrip_gl', '1');                     // 目前標準 → 換向量
  try { sessionStorage.removeItem('gl_fail'); localStorage.removeItem('mt_glfail'); localStorage.removeItem('mt_rl'); } catch (_) {}
  location.reload();
}

function toggleTopMenu() {
  const menu = document.getElementById('top-menu');
  if (menu.style.display !== 'none') { closeTopMenu(); return; }
  menu.style.display = 'block';
  // 延遲 100ms 避免開啟選單的那次 touch 立即又觸發
  setTimeout(() => {
    document.addEventListener('touchstart', _menuTouchStart, { passive: true });
    document.addEventListener('touchend', _menuTouchEnd, { passive: false });
  }, 100);
}
function closeTopMenu() {
  const menu = document.getElementById('top-menu');
  menu.style.display = 'none';
  menu.querySelectorAll('button.pressed').forEach(b => b.classList.remove('pressed'));
  document.removeEventListener('touchstart', _menuTouchStart, { passive: true });
  document.removeEventListener('touchend', _menuTouchEnd, { passive: false });
}

function toggleTripList() {
  const sheet = document.getElementById('trip-sheet');
  const overlay = document.getElementById('sheet-overlay');
  if (sheet.style.display === 'none') {
    renderTripSheet(); sheet.style.display = 'flex'; overlay.style.display = 'block';
  } else { closeSheet(); }
}

function closeSheet() {
  document.getElementById('trip-sheet').style.display = 'none';
  document.getElementById('sheet-overlay').style.display = 'none';
}

function closeActiveSheet() {
  if (document.getElementById('history-sheet').style.display !== 'none') closeHistory();
  else closeSheet();
}

// 回到主頁（地圖）：關掉所有覆蓋層（今日紀錄 / 歷史 / 回放 / 地圖預覽）
function goHome() {
  try { closeSheet(); } catch (_) {}
  try { if (window.closeFinance) closeFinance(); } catch (_) {}
  try { if (window.closeBookkeeper) closeBookkeeper(); } catch (_) {}
  try { closeHistory(); } catch (_) {}
  try { if (document.getElementById('replay-panel')?.classList.contains('show')) closeReplay(); } catch (_) {}
  try { if (document.body.classList.contains('day-preview-active')) exitDayPreview(); } catch (_) {}
}

function renderTripSheet() {
  const body = document.getElementById('sheet-body');
  if (!todayTrips.length) {
    body.innerHTML = '<div class="empty-state">今日尚無行程紀錄<br>按「開始行程」開始追蹤</div>'; return;
  }
  const totalDist = todayTrips.reduce((s, t) => s + (t.totalDist || 0), 0);
  const restMin = getRestMin(todayKey());
  const restHr = restMin ? +(restMin / 60).toFixed(2) : '';
  const work = workMs(todayTrips, restMin);
  const fareLine = _fareLineHtml(todayTrips, work);
  const summary = `<div class="day-summary">
    <div class="ds-top">
      <span>${todayTrips.length} 趟</span>
      <span>${fmtDist(totalDist)}</span>
      <button class="screenshot-btn" onclick="captureTripsScreenshot(null)">截圖</button>
    </div>
    ${fareLine ? `<div class="ds-bot">${fareLine}</div>` : ''}
    <div class="ds-time">
      <span>工作 <b>${fmtWork(work)}</b></span>
      <span class="rest-wrap">休息
        <input class="rest-input" type="number" inputmode="decimal" min="0" step="0.5"
               value="${restHr}" placeholder="0" onchange="setTodayRest(this.value)"> 小時</span>
    </div>
  </div>`;
  body.innerHTML = summary + todayTrips.map((t, i) => `
    <div class="trip-row" onclick="showSoloTripFromToday(${i}); closeSheet()">
      <div class="trip-num">${i + 1}</div>
      <div class="trip-meta">
        <div class="trip-time">${fmtTime(t.startTime)} → ${fmtTime(t.endTime)}　<span class="trip-dur">${fmtDur(t.endTime - t.startTime)}</span></div>
        <div class="trip-stats">
          ${fmtDist(t.totalDist)}
          ${t.fare ? `　<span class="trip-fare-tag">NT$ ${t.fare}</span>${_payTag(t.paymentMethod)}` : _otherTag(t)}${_extraTag(t)}
          <button class="fare-edit-btn" onclick="editFare(event,${i})">${(t.fare || t.paymentMethod === 'other') ? '✏' : '＋金額'}</button>
        </div>
      </div>
      <span class="trip-shot" onclick="captureTodayTripShot(event,${i})">📷</span>
      <span class="trip-del" onclick="deleteTodayTrip(event,${i})">🗑</span>
    </div>`).join('');
}

// 設定今日休息時間（輸入為小時，內部存分鐘）
function setTodayRest(hoursStr) {
  const hr = Math.max(0, parseFloat(hoursStr) || 0);
  setRestMin(todayKey(), Math.round(hr * 60));
  renderTripSheet();
}

function editFare(e, idx) {
  e.stopPropagation();
  const trip = todayTrips[idx];

  document.getElementById('fs-start').textContent = fmtTime(trip.startTime);
  document.getElementById('fs-end').textContent   = fmtTime(trip.endTime);
  document.getElementById('fs-dur').textContent   = fmtDur(trip.endTime - trip.startTime);
  document.getElementById('fs-dist').textContent  = fmtDist(trip.totalDist);
  document.getElementById('fare-header').textContent = `第 ${idx + 1} 趟 — 編輯金額`;

  const input   = document.getElementById('fare-input');
  const cashBtn = document.getElementById('fare-cash');
  const cardBtn = document.getElementById('fare-card');
  const skipBtn = document.getElementById('fare-skip');
  input.value = trip.fare || '';
  _setFareExtra(trip.commission, trip.dispatch);
  _showCommissionField(true);   // 編輯時可改抽成
  cashBtn.disabled = false; cardBtn.disabled = false;
  skipBtn.textContent = '取消'; skipBtn.disabled = false;

  document.getElementById('fare-overlay').style.display = 'block';
  document.getElementById('fare-dialog').classList.add('show');
  // 編輯時不自動彈鍵盤：讓「現金/刷卡」按鈕不被鍵盤蓋住，可直接點選切換

  const close = () => {
    document.getElementById('fare-overlay').style.display = 'none';
    document.getElementById('fare-dialog').classList.remove('show');
    document.getElementById('fare-header').textContent = '行程完成';
    skipBtn.textContent = '其他';
  };

  const saveEdit = (paymentMethod) => {
    const ex = _readFareExtra();
    trip.fare = parseInt(input.value) || 0;
    trip.paymentMethod = paymentMethod;
    trip.commission = ex.commission;
    trip.dispatch = ex.dispatch;
    if (paymentMethod !== 'other') trip.label = '';   // 由「其他」轉成付費 → 清掉備注
    close();
    saveTodayToStorage();
    _pushCommission(trip.id, ex.commission, ex.dispatch);
    renderTripSheet();
  };

  cashBtn.onclick = () => saveEdit('cash');
  cardBtn.onclick = () => saveEdit('card');
  skipBtn.onclick = close;
}

// 編輯「歷史」某趟的金額 / 現金刷卡
function editHistoryFare(e, day, idx) {
  e.stopPropagation();
  const raw = loadTrips();
  const trip = (raw[day] || [])[idx];
  if (!trip) return;

  document.getElementById('fs-start').textContent = fmtTime(trip.startTime);
  document.getElementById('fs-end').textContent   = fmtTime(trip.endTime);
  document.getElementById('fs-dur').textContent   = fmtDur(trip.endTime - trip.startTime);
  document.getElementById('fs-dist').textContent  = fmtDist(trip.totalDist);
  document.getElementById('fare-header').textContent = `${day} 第 ${idx + 1} 趟 — 編輯`;

  const input   = document.getElementById('fare-input');
  const cashBtn = document.getElementById('fare-cash');
  const cardBtn = document.getElementById('fare-card');
  const skipBtn = document.getElementById('fare-skip');
  input.value = trip.fare || '';
  _setFareExtra(trip.commission, trip.dispatch);
  _showCommissionField(true);   // 編輯時可改抽成
  cashBtn.disabled = false; cardBtn.disabled = false;
  skipBtn.textContent = '取消'; skipBtn.disabled = false;

  document.getElementById('fare-overlay').style.display = 'block';
  document.getElementById('fare-dialog').classList.add('show');
  // 編輯時不自動彈鍵盤：可直接點現金/刷卡切換

  const close = () => {
    document.getElementById('fare-overlay').style.display = 'none';
    document.getElementById('fare-dialog').classList.remove('show');
    document.getElementById('fare-header').textContent = '行程完成';
    skipBtn.textContent = '其他';
  };

  const tripId = trip.id;   // 用 id 定位，避免期間同步併入新趟造成索引位移
  const saveEdit = (paymentMethod) => {
    const fare = parseInt(input.value) || 0;
    const ex = _readFareExtra();
    const cur = loadTrips();
    const target = (cur[day] || []).find(t => t.id === tripId);
    if (target) {
      target.fare = fare;
      target.paymentMethod = paymentMethod;
      target.commission = ex.commission;
      target.dispatch = ex.dispatch;
      if (paymentMethod !== 'other') target.label = '';   // 由「其他」轉成付費 → 清掉備注
      saveTrips(cur);
      if (window.MaptripSync) MaptripSync.syncDays([day]);
    }
    // 若編輯的是「今日」的趟，記憶體中的 todayTrips 也要同步，
    // 否則下一次 saveTodayToStorage 合併會用舊值蓋回去
    const mem = todayTrips.find(t => t.id === tripId);
    if (mem) { mem.fare = fare; mem.paymentMethod = paymentMethod; mem.commission = ex.commission; mem.dispatch = ex.dispatch; if (paymentMethod !== 'other') mem.label = ''; }
    _pushCommission(tripId, ex.commission, ex.dispatch);
    close();
    renderHistorySheet();
  };

  cashBtn.onclick = () => saveEdit('cash');
  cardBtn.onclick = () => saveEdit('card');
  skipBtn.onclick = close;
}

// ---- 批次編輯抽成（歷史某日一次填好各趟不同抽成、一起儲存）----
// 抽成通常兩天後才知道，所以行程完成當下不問，改在歷史批次補。
let _cbDay = null;
function _ensureCommissionSheet() {
  let sheet = document.getElementById('commission-sheet');
  if (sheet) return sheet;
  const ov = document.createElement('div');
  ov.id = 'commission-overlay';
  ov.onclick = closeCommissionBatch;
  document.body.appendChild(ov);
  sheet = document.createElement('div');
  sheet.id = 'commission-sheet';
  sheet.innerHTML =
    '<div class="sheet-handle"></div>' +
    '<div class="cb-header"><span id="cb-title"></span>' +
    '<button class="sheet-close" onclick="closeCommissionBatch()">✕</button></div>' +
    '<div class="cb-note">抽成通常兩天後才知道；可一次填好當日各趟後一起儲存</div>' +
    '<div id="cb-body"></div>' +
    '<div class="cb-btns"><button class="cb-cancel" onclick="closeCommissionBatch()">取消</button>' +
    '<button class="cb-save" onclick="saveCommissionBatch()">全部儲存</button></div>';
  document.body.appendChild(sheet);
  return sheet;
}
function openCommissionBatch(day) {
  _cbDay = day;
  const raw = loadTrips();
  const trips = (raw[day] || []);
  if (!trips.length) { toast('這天沒有行程'); return; }
  _ensureCommissionSheet();
  document.getElementById('cb-title').textContent = `批次抽成 — ${day}`;
  const body = document.getElementById('cb-body');
  body.innerHTML = trips.map((t, i) => {
    const pay = t.paymentMethod === 'other' ? '其他'
      : (t.fare ? `NT$ ${t.fare} ${t.paymentMethod === 'card' ? '刷卡' : '現金'}` : '未填金額');
    return `<div class="cb-row">
        <span class="cb-num">${i + 1}</span>
        <div class="cb-mid"><div class="cb-time">${fmtTime(t.startTime)} → ${fmtTime(t.endTime)}</div>
          <div class="cb-fare">${pay}</div></div>
        <div class="cb-inwrap"><span>抽成</span>
          <input class="cb-inp" type="number" inputmode="numeric" min="0" placeholder="0"
                 data-id="${t.id}" value="${t.commission || ''}"></div>
      </div>`;
  }).join('');
  document.getElementById('commission-overlay').style.display = 'block';
  document.getElementById('commission-sheet').classList.add('show');
}
function closeCommissionBatch() {
  const s = document.getElementById('commission-sheet');
  if (s) s.classList.remove('show');
  const ov = document.getElementById('commission-overlay');
  if (ov) ov.style.display = 'none';
  _cbDay = null;
}
function saveCommissionBatch() {
  const day = _cbDay;
  if (!day) return;
  const inputs = document.querySelectorAll('#cb-body .cb-inp');
  const cur = loadTrips();
  const arr = cur[day] || [];
  let changed = 0;
  inputs.forEach(inp => {
    const id = inp.getAttribute('data-id');
    const val = parseInt(inp.value) || 0;
    const t = arr.find(x => String(x.id) === String(id));
    if (!t) return;
    if ((t.commission || 0) !== val) {
      t.commission = val; changed++;
      _pushCommission(t.id, val, t.dispatch || 0);   // 各趟抽成上雲
      const mem = todayTrips.find(x => String(x.id) === String(id));
      if (mem) mem.commission = val;
    }
  });
  if (changed) {
    saveTrips(cur);
    if (window.MaptripSync) MaptripSync.syncDays([day]);
  }
  closeCommissionBatch();
  renderHistorySheet();
  toast(changed ? `已更新 ${changed} 筆抽成` : '沒有變更');
}

// 把 "2026-06-17" 格式的 dayKey 轉成「6月17日 週三」
function dayKeyToLabel(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('zh-TW',
    { month: 'long', day: 'numeric', weekday: 'short' });
}

// 從今日清單點某趟 → 進入可左右切換的單趟顯示
function showSoloTripFromToday(idx) {
  soloFromHistory = false;
  const dateLabel = new Date().toLocaleDateString('zh-TW',
    { month: 'long', day: 'numeric', weekday: 'short' });
  openSoloTrip(todayTrips, idx, i =>
    `${dateLabel}　第 ${i + 1} 趟 / 共 ${todayTrips.length} 趟`);
}

// 從歷史某日點某趟 → 進入可左右切換的單趟顯示（限定在那一天的趟次內切換）
function showHistoryTrip(day, idx) {
  const raw = loadTrips();
  if (!raw[day]?.length) return;
  soloFromHistory = true;
  closeHistory();
  openSoloTrip(raw[day], idx, i =>
    `${dayKeyToLabel(day)}　第 ${i + 1} 趟 / 共 ${raw[day].length} 趟`);
}

// 動態量測 UI 元素實際位置，回傳 fitBounds padding（確保路線不被頂列/底列遮住）
function fitMapToRoute(coords, bottomElId, opts = {}) {
  if (!coords?.length) return;
  const topEl  = document.getElementById('top-bar');
  const botEl  = bottomElId ? document.getElementById(bottomElId) : null;

  // 量測 safe-area-inset-top（動態島高度），確保 topPad 不低於它
  const safeTmp = document.createElement('div');
  safeTmp.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top,0px);pointer-events:none;visibility:hidden';
  document.body.appendChild(safeTmp);
  const safeTop = safeTmp.getBoundingClientRect().height;
  safeTmp.remove();

  const topBarBottom = topEl ? topEl.getBoundingClientRect().bottom : 48;
  const topPad = Math.max(topBarBottom, safeTop) + 20;  // 至少動態島下方 + 20px 緩衝

  const botR   = botEl   ? botEl.getBoundingClientRect() : null;
  const botPad = (botR && botR.top > 10)
    ? (window.innerHeight - botR.top + 20)  // 緩衝從 8 → 20
    : (opts.botFallback ?? 80);
  map.fitBounds(L.latLngBounds(coords),
    { animate: opts.animate ?? true,
      paddingTopLeft:     [56, topPad],
      paddingBottomRight: [56, botPad] });
}

// 設定要顯示的趟次集合與起始索引，然後渲染
function openSoloTrip(set, idx, labelFn) {
  if (!set?.length) return;
  setAutoFollow(false);   // 歷史檢視：關閉跟隨與 5 秒歸位
  resetBearingNow();   // 單趟檢視固定指北
  exitDayPreview();
  // 單趟預覽一律換成無標示白底圖（今日與歷史一致，突顯路線），退出時還原
  map.removeLayer(TILE_LAYERS[currentTile]);
  soloHistoryTile = L.tileLayer(_isDark() ? NOLABEL_DARK : NOLABEL_LIGHT,
    { subdomains: 'abcd', maxZoom: 20 }
  ).addTo(map);
  soloHistoryTile.bringToBack();
  soloSet = set;
  soloIdx = Math.max(0, Math.min(idx, set.length - 1));
  soloLabelFn = labelFn;
  // 禁止地圖拖曳，改由整個地圖面左右滑切換趟次
  map.dragging.disable();
  map.touchZoom.disable();
  document.getElementById('map').addEventListener('touchstart', _soloTouchStart, { passive: true });
  document.getElementById('map').addEventListener('touchend',   _soloTouchEnd,   { passive: true });
  // 先顯示 solo-bar，讓瀏覽器先算好 layout，fitBounds 才能量到正確高度
  document.getElementById('solo-bar').style.display = 'flex';
  renderSoloTrip();
}

// 渲染目前 soloIdx 指向的那一趟（清掉前一趟的圖層、淡化其他路線）
function renderSoloTrip() {
  const trip = soloSet[soloIdx];
  if (!trip?.coords?.length) return;

  // 清掉上一趟的單趟圖層
  soloLayers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
  soloLayers = [];
  clearReplayTempLayers();

  if (soloFromHistory) {
    // 從歷史進單趟：今日行程整組隱藏（不外漏今日的點/線）
    showTodayLayers(false);
  } else {
    // 今日清單內看單趟：其他趟的「線」淡化當背景（保留脈絡）、「點」整組隱藏。
    // 點不能用淡化：GL 模式下 MapLibre 每次重繪會把 marker 不透明度蓋回全濃度，
    // 淡化的點會全部冒出來（使用者看到滿地圖其他趟的點）
    _todayMode = 'solo';
    allMapLayers.forEach(l => {
      if (l.setStyle) { try { l.setStyle({ opacity: 0.12 }); } catch (_) {} }
      else if (l.setOpacity) { try { l.setOpacity(0); } catch (_) {} }
    });
  }

  // 畫選中行程的路線（歷史模式：黑色 Uber 風格；今日模式：藍色）
  const coords = tripPath(trip).map(c => [c.lat, c.lng]);
  if (!coords.length) { toast('這趟是舊資料，沒有路線座標'); }
  else
  if (soloFromHistory) {
    const dark = _isDark();
    const inkColor = dark ? '#f1f3f4' : '#1a1a1a';
    soloLayers.push(
      L.polyline(coords, { color: inkColor, weight: 5, opacity: 1 }).addTo(map),
      L.marker(coords[0],     { icon: makeNumberIcon(soloIdx + 1, inkColor, dark), zIndexOffset: 10 }).addTo(map),
      L.marker(coords.at(-1), { icon: makePreviewSquareIcon(dark) }).addTo(map)
    );
  } else {
    soloLayers.push(
      L.polyline(coords, { color: '#1A73E8', weight: 7, opacity: 1 }).addTo(map),
      L.marker(coords[0],     { icon: makeStartIcon(), zIndexOffset: 10 }).addTo(map),
      L.marker(coords.at(-1), { icon: makeEndIcon()   }).addTo(map)
    );
  }
  fitMapToRoute(coords, 'solo-bar');

  const label = soloLabelFn ? soloLabelFn(soloIdx) : '';
  const info  = `${fmtTime(trip.startTime)} → ${fmtTime(trip.endTime)}　${fmtDist(trip.totalDist)}`;
  // 兩行顯示：第一行日期+趟次，第二行時間+里程；歷史模式多一行提示
  document.getElementById('solo-info').innerHTML =
    `<div class="solo-line1">${label}</div>` +
    `<div class="solo-line2">${info}</div>` +
    `<div class="solo-hint">${soloFromHistory ? '按兩下地圖離開歷史模式' : '按兩下地圖回全部行程'}</div>`;

  // 首尾趟把箭頭變淡（沒有上一趟/下一趟）
  const prevBtn = document.getElementById('solo-prev');
  const nextBtn = document.getElementById('solo-next');
  if (prevBtn) prevBtn.style.opacity = soloIdx > 0 ? '1' : '0.25';
  if (nextBtn) nextBtn.style.opacity = soloIdx < soloSet.length - 1 ? '1' : '0.25';
}

// 上一趟 / 下一趟（左右滑或按箭頭）
function soloPrev() { if (soloIdx > 0)                  { soloIdx--; renderSoloTrip(); } }
function soloNext() { if (soloIdx < soloSet.length - 1) { soloIdx++; renderSoloTrip(); } }

// 在單趟資訊列上偵測水平滑動，切換趟次
function setupSoloSwipe() {
  const bar = document.getElementById('solo-bar');
  if (!bar) return;
  let x0 = null, y0 = null;
  bar.addEventListener('touchstart', e => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });
  bar.addEventListener('touchend', e => {
    if (x0 === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = y0 = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) soloNext();   // 往左滑 → 下一趟
      else        soloPrev();   // 往右滑 → 上一趟
    }
  }, { passive: true });
}

// 單趟預覽的「截圖」：截目前顯示的那一趟
function captureSoloShot() {
  const trip = soloSet[soloIdx];
  if (trip) captureSingleTripScreenshot(trip);
}

function exitSoloMode() {
  soloLayers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
  soloLayers = [];
  // 還原底圖（歷史模式才有換）
  if (soloHistoryTile) {
    map.removeLayer(soloHistoryTile);
    soloHistoryTile = null;
    TILE_LAYERS[currentTile].addTo(map);
  }
  soloSet = []; soloIdx = 0; soloLabelFn = null; soloFromHistory = false;
  showTodayLayers(true);   // 還原今日行程圖層（pane 顯示 + 不透明度）
  // 恢復地圖拖曳
  map.dragging.enable();
  map.touchZoom.enable();
  document.getElementById('map').removeEventListener('touchstart', _soloTouchStart);
  document.getElementById('map').removeEventListener('touchend',   _soloTouchEnd);
  document.getElementById('solo-bar').style.display = 'none';
}

// 從任何非主頁狀態（單趟 / 日預覽 / 清單 / 回放）回到地圖主頁
function backToMainMap() {
  if (soloSet.length) exitSoloMode();
  if (document.body.classList.contains('day-preview-active')) exitDayPreview();
  goHome();
}

// 地圖層級的水平滑動 → 切換單趟（solo mode 時才掛上）
let _soloSwX = null, _soloSwY = null, _soloLastTap = 0;
function _soloTouchStart(e) {
  const t = e.touches[0]; _soloSwX = t.clientX; _soloSwY = t.clientY;
}
function _soloTouchEnd(e) {
  if (_soloSwX === null) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - _soloSwX, dy = t.clientY - _soloSwY;
  _soloSwX = _soloSwY = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    _soloLastTap = 0;
    if (dx < 0) soloNext(); else soloPrev();
    return;
  }
  // 點擊（移動量小）→ 偵測連點兩下
  if (Math.abs(dx) < 20 && Math.abs(dy) < 20) {
    const now = Date.now();
    if (now - _soloLastTap < 350) {
      _soloLastTap = 0;
      backToMainMap();
    } else {
      _soloLastTap = now;
    }
  }
}

function deleteTodayTrip(e, idx) {
  e.stopPropagation();
  if (!confirm(`刪除第 ${idx + 1} 趟行程？`)) return;
  const t = todayTrips[idx];
  if (t._layers) t._layers.forEach(l => map.removeLayer(l));
  todayTrips.splice(idx, 1);
  removeTripFromStorage(t.id);   // 明確移除該趟（合併存檔不會救回）
  updateTopBar(); renderTripSheet();
  toast(`已刪除第 ${idx + 1} 趟`);
}

// 刪除「歷史」某趟（含雲端與墓碑，同今日刪除的安全機制）
function deleteHistoryTrip(e, day, idx) {
  e.stopPropagation();
  const raw = loadTrips();
  const trip = (raw[day] || [])[idx];
  if (!trip) return;
  if (!confirm(`刪除 ${day} 第 ${idx + 1} 趟行程？`)) return;
  // 若剛好是今日的趟：同步清掉記憶體與地圖圖層
  const mem = todayTrips.find(t => t.id === trip.id);
  if (mem) {
    if (mem._layers) mem._layers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
    const mi = todayTrips.indexOf(mem);
    if (mi >= 0) todayTrips.splice(mi, 1);
    updateTopBar();
  }
  removeTripFromStorage(trip.id);   // 儲存+雲端+墓碑
  renderHistorySheet();
  toast('已刪除該趟行程');
}

function confirmClearDay() {
  if (!todayTrips.length) { toast('今日無行程可清除'); return; }
  if (!confirm(`確定清除今日全部 ${todayTrips.length} 趟行程？`)) return;
  exitSoloMode();
  allMapLayers.forEach(l => map.removeLayer(l));
  allMapLayers = [];
  // 明確逐趟移除本機（合併存檔不會救回），再清空記憶體
  todayTrips.slice().forEach(t => removeTripFromStorage(t.id));
  todayTrips = [];
  updateTopBar(); closeSheet();
  toast('今日行程已清除');
}

function showHistory() {
  renderHistorySheet();
  document.getElementById('history-sheet').style.display = 'flex';
  document.getElementById('sheet-overlay').style.display = 'block';
}
function closeHistory() {
  document.getElementById('history-sheet').style.display = 'none';
  document.getElementById('sheet-overlay').style.display = 'none';
}

function renderHistorySheet() {
  const body = document.getElementById('history-body');
  const raw = loadTrips();
  const days = Object.keys(raw).sort().reverse().filter(d => raw[d]?.length > 0);
  if (!days.length) { body.innerHTML = '<div class="empty-state">尚無歷史紀錄</div>'; return; }

  // 依月份（YYYY-MM）分組，月份由近到遠
  const months = [], monthMap = {};
  days.forEach(day => {
    const mk = day.slice(0, 7);
    if (!monthMap[mk]) { monthMap[mk] = []; months.push(mk); }
    monthMap[mk].push(day);
  });

  let globalDayIdx = 0;
  body.innerHTML = months.map((mk, monthIdx) => {
    const mDays = monthMap[mk];
    const mTrips = mDays.flatMap(d => raw[d]);
    const mDist = mTrips.reduce((s, t) => s + (t.totalDist || 0), 0);
    const mWork = mDays.reduce((s, d) => s + workMs(raw[d], getRestMin(d)), 0);
    const mFareLine = _fareLineHtml(mTrips, mWork);
    const [yy, mm] = mk.split('-');
    const monthLabel = `${yy}年${parseInt(mm, 10)}月`;
    const monthOpen = monthIdx === 0;   // 最近月份展開，較遠月份預設收折

    const daysHtml = mDays.map(day => {
      const trips = raw[day];
      const totalDist = trips.reduce((s, t) => s + (t.totalDist || 0), 0);
      const dRestMin = getRestMin(day);
      const dRestHr = dRestMin ? +(dRestMin / 60).toFixed(2) : '';
      const dWork = workMs(trips, dRestMin);
      const fareLine = _fareLineHtml(trips, dWork);
      const isOpen = globalDayIdx === 0;   // 全清單最近一天展開
      globalDayIdx++;
      const restRow = `<div class="dr-rest">工作 <b id="work-${day}">${fmtWork(dWork)}</b>　休息
        <input class="rest-input" type="number" inputmode="decimal" min="0" step="0.5"
               value="${dRestHr}" placeholder="0" onchange="setHistoryRest('${day}', this.value)"> 小時</div>`;
      const rows = restRow + trips.map((t, i) => `
        <div class="trip-row" onclick="showHistoryTrip('${day}',${i})">
          <div class="trip-num">${i + 1}</div>
          <div class="trip-meta">
            <div class="trip-time">${fmtTime(t.startTime)} → ${fmtTime(t.endTime)}　<span class="trip-dur">${fmtDur(t.endTime - t.startTime)}</span></div>
            <div class="trip-stats">${fmtDist(t.totalDist)}${t.fare ? `　<span class="trip-fare-tag">NT$ ${t.fare}</span>${_payTag(t.paymentMethod)}` : _otherTag(t)}${_extraTag(t)}</div>
          </div>
          <span class="trip-edit" onclick="editHistoryFare(event,'${day}',${i})">✏</span>
          <span class="trip-del" onclick="deleteHistoryTrip(event,'${day}',${i})">🗑</span>
          <span style="color:#9aa0a6;font-size:1rem;padding:4px 2px">›</span>
        </div>`).join('');
      return `<div class="history-day" onclick="toggleDay('${day}')">
          <span class="day-caret">${isOpen ? '▼' : '▶'}</span>
          <span class="day-info"><span class="day-info-top">${day}　${trips.length} 趟　${fmtDist(totalDist)}</span>${fareLine ? `<span class="day-info-bot">${fareLine}</span>` : ''}</span>
          <button class="preview-map-btn" onclick="event.stopPropagation();previewDay('${day}')">地圖</button>
          <button class="commission-btn" onclick="event.stopPropagation();openCommissionBatch('${day}')">抽成</button>
          <button class="replay-btn" onclick="event.stopPropagation();replayDay('${day}')">▶ 回放</button>
        </div>
        <div class="day-rows${isOpen ? '' : ' collapsed'}" id="day-rows-${day}">${rows}</div>`;
    }).join('');

    return `<div class="history-month" onclick="toggleMonth('${mk}')">
        <span class="month-caret">${monthOpen ? '▼' : '▶'}</span>
        <span class="month-info">
          <span class="month-title">${monthLabel}</span>
          <span class="month-sub">${mTrips.length} 趟　${fmtDist(mDist)}　工作 <span id="mwork-${mk}">${fmtWork(mWork)}</span></span>
          ${mFareLine ? `<span class="month-fare">${mFareLine}</span>` : ''}
        </span>
      </div>
      <div class="month-days${monthOpen ? '' : ' collapsed'}" id="month-days-${mk}">${daysHtml}</div>`;
  }).join('');
}

// 設定歷史某日休息時間（小時）— 只就地更新該日/該月工作時長，避免整頁重繪收折
function setHistoryRest(day, hoursStr) {
  const hr = Math.max(0, parseFloat(hoursStr) || 0);
  setRestMin(day, Math.round(hr * 60));
  const raw = loadTrips();
  const wEl = document.getElementById('work-' + day);
  if (wEl) wEl.textContent = fmtWork(workMs(raw[day] || [], getRestMin(day)));
  const mk = day.slice(0, 7);
  const mEl = document.getElementById('mwork-' + mk);
  if (mEl) {
    const mWork = Object.keys(raw).filter(d => d.slice(0, 7) === mk)
      .reduce((s, d) => s + workMs(raw[d] || [], getRestMin(d)), 0);
    mEl.textContent = fmtWork(mWork);
  }
}

function toggleMonth(mk) {
  const el = document.getElementById('month-days-' + mk);
  if (!el) return;
  const caret = el.previousElementSibling.querySelector('.month-caret');
  const nowCollapsed = el.classList.toggle('collapsed');
  if (caret) caret.textContent = nowCollapsed ? '▶' : '▼';
}

function toggleDay(day) {
  const rows = document.getElementById('day-rows-' + day);
  const caret = rows.previousElementSibling.querySelector('.day-caret');
  const nowCollapsed = rows.classList.toggle('collapsed');
  caret.textContent = nowCollapsed ? '▶' : '▼';
}

// ===== 日預覽（歷史某日全部路線靜態展示）=====
let dayPreviewLayers = [], dayPreviewKey = null, dayPreviewTile = null;

function previewDay(dayKey) {
  const raw = loadTrips();
  const trips = raw[dayKey] || [];
  if (!trips.length) { toast('該日無行程'); return; }
  setAutoFollow(false);   // 歷史檢視：關閉跟隨與 5 秒歸位
  resetBearingNow();   // 日預覽固定指北
  exitDayPreview();
  dayPreviewKey = dayKey;
  closeHistory();

  // 先顯示 bar（讓 fitMapToRoute 量到正確高度）
  const totalDist = trips.reduce((s, t) => s + (t.totalDist || 0), 0);
  const totalFare = trips.reduce((s, t) => s + (t.fare || 0), 0);
  document.getElementById('dp-info').innerHTML =
    `<div class="dp-day">${dayKeyToLabel(dayKey)}</div>` +
    `<div class="dp-stats">${trips.length} 趟　${fmtDist(totalDist)}${totalFare ? `　NT$ ${totalFare.toLocaleString()}` : ''}</div>`;
  document.getElementById('day-preview-bar').style.display = 'flex';
  document.body.classList.add('day-preview-active');
  // 日預覽時：雙擊地圖回主頁（暫時關掉 Leaflet 雙擊放大避免衝突）
  map.doubleClickZoom.disable();
  map.on('dblclick', backToMainMap);

  // 深色模式：深色底圖 + 淺色路線/點；淺色模式：淺色底圖 + 黑色路線/點
  const dark = _isDark();
  const inkColor = dark ? '#f1f3f4' : '#1a1a1a';

  const allCoords = [];
  trips.forEach((t, i) => {
    const latlngs = tripPath(t).map(c => [c.lat, c.lng]);
    if (!latlngs.length) return;   // 無座標的舊趟：略過不畫
    allCoords.push(...latlngs);
    const line = L.polyline(latlngs, { color: inkColor, weight: 2.5, opacity: 1 }).addTo(map);
    line.on('click', () => { exitDayPreview(); showHistoryTrip(dayKey, i); });
    const startMk = L.marker(latlngs[0],     { icon: makeNumberIcon(i + 1, inkColor, dark), zIndexOffset: 10 }).addTo(map);
    const endMk   = L.marker(latlngs.at(-1), { icon: makePreviewSquareIcon(dark) }).addTo(map);
    dayPreviewLayers.push(line, startMk, endMk);
  });
  // 換成無標示底圖（深色模式用 Dark No Labels）
  map.removeLayer(TILE_LAYERS[currentTile]);
  dayPreviewTile = L.tileLayer(dark ? NOLABEL_DARK : NOLABEL_LIGHT,
    { subdomains: 'abcd', maxZoom: 20 }).addTo(map);
  dayPreviewTile.bringToBack();

  // 隱藏當日行程圖層（整組 pane，不漏任何標記/線）
  showTodayLayers(false);

  if (allCoords.length) fitMapToRoute(allCoords, 'day-preview-bar');
}

function exitDayPreview() {
  dayPreviewLayers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
  dayPreviewLayers = [];
  dayPreviewKey = null;
  // 還原 Leaflet 雙擊放大
  map.off('dblclick', backToMainMap);
  map.doubleClickZoom.enable();
  document.body.classList.remove('day-preview-active');
  document.getElementById('day-preview-bar').style.display = 'none';
  // 還原原本底圖
  if (dayPreviewTile) { map.removeLayer(dayPreviewTile); dayPreviewTile = null; }
  TILE_LAYERS[currentTile].addTo(map);
  // 還原當日行程圖層
  showTodayLayers(true);
}

// ===== 里程截圖 =====

// ── 截圖已抽到 js/screenshot.js（MaptripShot）；以下為相容薄包裝，呼叫端（HTML onclick 等）零改動。
//    todayTrips 以 init 注入。 ──
MaptripShot.init({ todayTrips: () => todayTrips });
function captureTripsScreenshot(dayKey, includeOther) { return MaptripShot.captureTripsScreenshot(dayKey, includeOther); }
function captureSingleTripScreenshot(trip) { return MaptripShot.captureSingleTripScreenshot(trip); }
function captureTodayTripShot(e, i) { return MaptripShot.captureTodayTripShot(e, i); }
function captureHistoryTripShot(e, dayKey, i) { return MaptripShot.captureHistoryTripShot(e, dayKey, i); }
function shareScreenshot() { return MaptripShot.shareScreenshot(); }
function saveImageToPhotos() { return MaptripShot.saveImageToPhotos(); }
function closeScreenshotPreview() { return MaptripShot.closeScreenshotPreview(); }

// ===== 雲端同步 UI =====

// 雲端登入閘門 / 同步面板 UI 已抽成模組 js/sync-ui.js（MaptripSyncUI，body 逐字不變，
// APP_VERSION 經 init 注入）。以下為同名薄包裝轉呼叫，呼叫端（HTML onclick、選單、
// sync.js 的 window.renderSyncPanel 回呼）零改動。refreshAfterSync 留 app.js（見下）。
MaptripSyncUI.init({ appVersion: APP_VERSION });
function openSyncDialog() { return MaptripSyncUI.openSyncDialog(); }
function closeSyncDialog() { return MaptripSyncUI.closeSyncDialog(); }
function submitGateLogin() { return MaptripSyncUI.submitGateLogin(); }
function renderSyncPanel() { return MaptripSyncUI.renderSyncPanel(); }
function submitSyncLogin() { return MaptripSyncUI.submitSyncLogin(); }

// 雲端把新資料併進 localStorage 後呼叫：重繪今日 + 更新開啟中的清單
function refreshAfterSync() {
  // 記錄中／單趟檢視／預覽／回放時不動地圖圖層（下次正常載入會重畫），
  // 但仍把儲存中多出來的趟「補進」今日清單，頂列趟數與清單才會即時正確
  if (activeTrip || (typeof soloSet !== 'undefined' && soloSet.length) ||
      dayPreviewKey || (window.MaptripReplay && MaptripReplay.isAnimating())) {
    try {
      const saved = loadTrips()[todayKey()] || [];
      const have = new Set(todayTrips.map(t => t.id));
      let added = false;
      saved.forEach(t => { if (t && t.id != null && !have.has(t.id)) { todayTrips.push(t); added = true; } });
      if (added) todayTrips.sort((a, b) => a.startTime - b.startTime);
    } catch (_) {}
    updateTopBar(); return;
  }
  allMapLayers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
  allMapLayers = [];
  todayTrips = [];
  loadTodayFromStorage();
  updateTopBar();
  const ts = document.getElementById('trip-sheet');
  if (ts && ts.style.display !== 'none') renderTripSheet();
  const hs = document.getElementById('history-sheet');
  if (hs && hs.style.display !== 'none') renderHistorySheet();
}

// ── 回放已抽到 js/replay.js（MaptripReplay）；狀態＋動畫迴圈整組搬入，用 getter 注入 map 與
//    需讀的 app.js 活狀態；對外開放 tempLayers()/isAnimating()。以下為相容薄包裝，呼叫端零改動。 ──
MaptripReplay.init({
  getMap: () => map,
  getTodayTrips: () => todayTrips,
  getActivePolyline: () => activePolyline,
  getCurrentPos: () => currentPos,
  getSoloSet: () => soloSet,
  getDayPreviewKey: () => dayPreviewKey,
  resumeFollow: () => { _wantFollowResume = true; scheduleFollowResume(); }
});
function isReplaying() { return MaptripReplay.isReplaying(); }
function openReplay() { return MaptripReplay.openReplay(); }
function replayDay(dayKey) { return MaptripReplay.replayDay(dayKey); }
function startReplay() { return MaptripReplay.startReplay(); }
function closeReplay() { return MaptripReplay.closeReplay(); }
function toggleReplayPause() { return MaptripReplay.toggleReplayPause(); }
function initSpeedSlider() { return MaptripReplay.initSpeedSlider(); }
function clearReplayTempLayers() { return MaptripReplay.clearReplayTempLayers(); }

// 每日以早上 7:00 為分界：07:00 之前算前一天
// （例：6/16 的紀錄＝6/16 早上 7:00 ～ 6/17 早上 6:59）
// 序列化 / 合併存檔 / 壓實 / 刪除墓碑 / 營業日已抽成模組 js/storage.js（MaptripStorage，
// body 逐字不變）。以下為同名薄包裝轉呼叫，呼叫端（含 recorder.js、finance.js window.* 存取）零改動。
// slimTripForStorage 由模組直接掛 window。DAY_SPLIT_HOUR/DELETED_KEY 隨模組搬入。
MaptripStorage.init({ testMode: TEST_MODE_ON, getTodayTrips: () => todayTrips });
const DAY_SPLIT_HOUR = 7;   // updateTopBar 顯示營業日仍直接用（模組內另有同值，各自 scope）
function businessDayKey(ts = Date.now()) { return MaptripStorage.businessDayKey(ts); }
function todayKey() { return MaptripStorage.todayKey(); }
function _r5(v) { return MaptripStorage._r5(v); }
function _simplifyPath(pts, tol) { return MaptripStorage._simplifyPath(pts, tol); }
function serializeTrip(t) { return MaptripStorage.serializeTrip(t); }
function saveTodayToStorage() { return MaptripStorage.saveTodayToStorage(); }
function compactStorage(aggressive) { return MaptripStorage.compactStorage(aggressive); }

// 開機補貼路：歷史上貼路失敗的趟重試貼路，成功後把原始座標縮成頭尾。
// 每次開機最多處理 maxTrips 趟（對公用 OSRM 客氣一點），失敗的下次再試。
async function retrySnapBacklog(maxTrips = 5) {
  try {
    const raw = loadTrips();
    const jobs = [];
    Object.keys(raw).forEach(day => (raw[day] || []).forEach(t => {
      // _snapN：累積失敗次數（隨行程存檔）。超過 15 次＝救不回來（如訊號漂太遠），
      // 不再無限重試、也不再每次開機跳失敗提示
      if (!t.roadCoords && t.coords && t.coords.length > 20 && (t._snapN || 0) < 15) jobs.push({ day, id: t.id });
    }));
    if (!jobs.length) return;
    let done = 0, failed = 0;
    for (const j of jobs) {
      if (done + failed >= maxTrips || activeTrip) break;   // 記錄中不佔用網路
      const cur = loadTrips();  // 重讀避免蓋掉期間變動
      const trip = (cur[j.day] || []).find(t => t.id === j.id);
      if (!trip || trip.roadCoords) continue;
      const road = await snapToRoads(trip.coords);
      if (!road) {
        failed++;
        trip._snapN = (trip._snapN || 0) + 1;
        // 貼路仍失敗 → 至少清掉原始軌跡的飄移群（鋸齒/停等飄移），
        // 讓顯示乾淨；下次重試用清理後的座標，貼路成功率也提高
        if (trip.coords && trip.coords.length >= 4) {
          const cleaned = _cleanTrace(trip.coords);
          if (cleaned.length < trip.coords.length) {
            trip.coords = cleaned.map(c => ({ lat: c.lat, lng: c.lng, ...(c.t != null ? { t: c.t } : {}) }));
            const memC = todayTrips.find(t => t.id === j.id);
            if (memC) {
              memC.coords = trip.coords;
              const mi = todayTrips.indexOf(memC);
              (memC._layers || []).forEach(l => {
                try { map.removeLayer(l); } catch (_) {}
                const k = allMapLayers.indexOf(l);
                if (k >= 0) allMapLayers.splice(k, 1);
              });
              drawTripLine(memC, mi + 1);
            }
          }
        }
        saveTrips(cur);
        if (window.MaptripSync) MaptripSync.syncDays([j.day]);
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      trip.roadCoords = _simplifyPath(road, 0.00004).map(c => ({ lat: _r5(c.lat), lng: _r5(c.lng) }));
      trip.coords = [trip.coords[0], trip.coords[trip.coords.length - 1]]
        .map(c => ({ lat: c.lat, lng: c.lng }));
      saveTrips(cur);
      if (window.MaptripSync) MaptripSync.syncDays([j.day]);
      // 今日清單中的趟 → 同步記憶體並立即重畫成貼路線
      const memT = todayTrips.find(t => t.id === j.id);
      if (memT) {
        memT.roadCoords = trip.roadCoords;
        memT.coords = trip.coords;
        const mi = todayTrips.indexOf(memT);
        (memT._layers || []).forEach(l => {
          try { map.removeLayer(l); } catch (_) {}
          const k = allMapLayers.indexOf(l);
          if (k >= 0) allMapLayers.splice(k, 1);
        });
        drawTripLine(memT, mi + 1);
      }
      done++;
      await new Promise(r => setTimeout(r, 800));   // 節流
    }
    // 成功才提示；失敗改記進黑盒子（使用者不想看到失敗提示，開診斷模式才顯示）
    if (done && !failed) toast(`已補貼路 ${done} 趟`);
    else if (failed) {
      try { window.__mtLog && window.__mtLog(`snap fail x${failed} (${window._snapErr || '未知'})`); } catch (_) {}
      if (dbgEnabled()) toast(`補貼路：成功 ${done}、失敗 ${failed}（${window._snapErr || '未知'}）`);
    }
  } catch (_) {}
}

// 本機儲存用量（bytes，UTF-16 估算）
// storageBytes / addDeletedId / removeTripFromStorage / DELETED_KEY 已隨 storage.js 搬入。
function storageBytes() { return MaptripStorage.storageBytes(); }
function removeTripFromStorage(id) { return MaptripStorage.removeTripFromStorage(id); }

function loadTodayFromStorage() {
  let raw = {};
  try { raw = loadTrips(); } catch (_) {}
  const saved = raw[todayKey()] || [];
  if (!saved.length) return;
  saved.forEach((t, i) => {
    // 用同一個物件入陣列並畫線：_layers 才會掛在 todayTrips 內的那份，
    // 之後刪除該趟才能正確移除地圖上的線（否則會留幽靈路線）。
    // 逐趟 try/catch：一趟壞資料絕不能截斷整個今日載入（趟數會變少）
    const copy = { ...t };
    try {
      if (i > 0) {
        const prevCoords = tripPath(todayTrips[todayTrips.length - 1]);
        const curCoords  = tripPath(t);
        if (prevCoords.length && curCoords.length)
          allMapLayers.push(drawGapLine(prevCoords.at(-1), curCoords[0]));
      }
    } catch (_) {}
    todayTrips.push(copy);
    try { drawTripLine(copy, i + 1); } catch (_) { copy._layers = []; }
  });
  updateTopBar();
}

// ── 工具函式已抽到 js/util.js（MaptripUtil）；以下為相容薄包裝，呼叫端（含 finance.js 的
//    window.* 存取）一行都不用改。body 逐字搬移，行為與原版完全相同。
//    註：_fareLineHtml 沿用 v1.1.254 的第二參數 workMsVal（總計旁顯示 $X/hr）。 ──
MaptripUtil.init({ testMode: TEST_MODE_ON });   // REST_KEY 對齊 test 模式
function haversine(a, b) { return MaptripUtil.haversine(a, b); }
function calcTotalDist(coords) { return MaptripUtil.calcTotalDist(coords); }
function fmtDist(m) { return MaptripUtil.fmtDist(m); }
function fmtDur(ms) { return MaptripUtil.fmtDur(ms); }
function fmtWork(ms) { return MaptripUtil.fmtWork(ms); }
function fmtTime(ts) { return MaptripUtil.fmtTime(ts); }
function _payTag(pm) { return MaptripUtil._payTag(pm); }
function _otherTag(t) { return MaptripUtil._otherTag(t); }
function _extraTag(t) { return MaptripUtil._extraTag(t); }
function _fareStats(trips) { return MaptripUtil._fareStats(trips); }
function _fareLineHtml(trips, workMsVal) { return MaptripUtil._fareLineHtml(trips, workMsVal); }
function getRestMin(dayKey) { return MaptripUtil.getRestMin(dayKey); }
function setRestMin(dayKey, min) { return MaptripUtil.setRestMin(dayKey, min); }
function workMs(trips, restMin) { return MaptripUtil.workMs(trips, restMin); }

function setGpsBadge(state, text) {
  const el = document.getElementById('gps-badge');
  el.textContent = text; el.className = `badge-${state}`;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

// 診斷訊息：預設隱藏，需要查修時把診斷模式打開（在「行程清單」點版本號 5 下，
// 或 localStorage.maptrip_debug='1'）。dbg() 呼叫一直都在，開啟即顯示，不必改程式。
function dbgEnabled() {
  return TEST_MODE_ON || localStorage.getItem('maptrip_debug') === '1';
}
// 開機黑盒子檢視器：顯示 mt_bootlog（每次開場/重載/看門狗事件）＋當前異常旗標，
// 使用者截圖回報即可還原「一直重置」的完整事件序列（新→舊排列）
function showBootLog() {
  document.getElementById('bootlog-box')?.remove();
  let log = [];
  try { log = JSON.parse(localStorage.getItem('mt_bootlog') || '[]'); } catch (_) {}
  const flags = ['mt_glfail_reason', 'mt_glerr', 'mt_rl', 'mt_run', 'mt_glfail', 'maptrip_gl']
    .map(k => { const v = localStorage.getItem(k); return v ? k + '=' + v : null; })
    .filter(Boolean).join('\n');
  const box = document.createElement('div');
  box.id = 'bootlog-box';
  box.style.cssText = 'position:fixed;top:56px;left:8px;right:8px;bottom:90px;z-index:99999;'
    + 'background:rgba(0,0,0,0.92);color:#9ef;font:11px/1.5 monospace;'
    + 'padding:10px 12px;border-radius:10px;overflow:auto;white-space:pre-wrap;-webkit-overflow-scrolling:touch';
  box.textContent = '📦 開機黑盒子 v' + APP_VERSION + '（點擊關閉）\n'
    + (flags ? '── 旗標 ──\n' + flags + '\n' : '')
    + '── 事件（新→舊）──\n'
    + (log.length ? log.slice().reverse().join('\n') : '（尚無記錄）');
  box.onclick = (e) => { if (e.target === box) box.remove(); };
  // 高度診斷入口（GPS 高度黑盒子；橋上/橋下量測）
  if (window.MaptripAlt) {
    const ab = document.createElement('div');
    ab.textContent = '📈 高度診斷（點我）';
    ab.style.cssText = 'position:sticky;bottom:0;margin-top:10px;padding:10px;text-align:center;'
      + 'background:#1a73e8;color:#fff;border-radius:8px;cursor:pointer;font:13px sans-serif';
    ab.onclick = (e) => { e.stopPropagation(); MaptripAlt.showPanel(); };
    box.appendChild(ab);
  }
  document.body.appendChild(box);
}

// 點版本號 3 下 → 開機黑盒子；5 下 → 切換診斷模式（不需重 build / 改網址）
let _verTapCount = 0, _verTapTimer = null;
function onVersionTap() {
  _verTapCount++;
  clearTimeout(_verTapTimer);
  _verTapTimer = setTimeout(() => { _verTapCount = 0; }, 1500);
  if (_verTapCount === 3) showBootLog();
  if (_verTapCount < 5) return;
  _verTapCount = 0;
  document.getElementById('bootlog-box')?.remove();
  const on = localStorage.getItem('maptrip_debug') === '1';
  if (on) {
    localStorage.removeItem('maptrip_debug');
    document.getElementById('dbg-box')?.remove();
    document.getElementById('probe-panel')?.remove();
    toast('診斷模式已關閉');
  } else {
    localStorage.setItem('maptrip_debug', '1');
    toast('診斷模式已開啟');
    setTimeout(probeLayout, 100);
  }
  const vl = document.getElementById('version-label');
  if (vl) vl.textContent = 'v' + APP_VERSION + (dbgEnabled() ? ' · 診斷中' : '');
}
function dbg(msg) {
  if (!dbgEnabled()) return;
  let box = document.getElementById('dbg-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'dbg-box';
    box.style.cssText = 'position:fixed;top:60px;left:8px;right:8px;z-index:99999;'
      + 'background:rgba(0,0,0,0.82);color:#0f0;font:11px/1.4 monospace;'
      + 'padding:6px 8px;border-radius:6px;max-height:40vh;overflow:auto;white-space:pre-wrap';
    box.onclick = () => box.remove();
    document.body.appendChild(box);
  }
  const t = new Date().toLocaleTimeString();
  box.textContent += `[${t}] ${msg}\n`;
}

// ===== 可拖曳浮動量測面板 =====
function probeLayout() {
  document.getElementById('probe-panel')?.remove();

  // 用暫時元素量測 safe-area
  const tmp = document.createElement('div');
  tmp.style.cssText = 'position:fixed;top:0;left:0;width:1px;pointer-events:none;visibility:hidden';
  document.body.appendChild(tmp);
  tmp.style.height = 'env(safe-area-inset-top,0px)';
  const safeTop = tmp.getBoundingClientRect().height;
  tmp.style.height = 'env(safe-area-inset-bottom,0px)';
  const safeBot = tmp.getBoundingClientRect().height;
  tmp.remove();

  const vh = window.visualViewport?.height || window.innerHeight;
  const vw = window.visualViewport?.width || window.innerWidth;

  function r(id) {
    const el = document.getElementById(id);
    if (!el) return 'N/A';
    const rc = el.getBoundingClientRect();
    return `t:${rc.top.toFixed(1)} b:${rc.bottom.toFixed(1)} h:${rc.height.toFixed(1)}`;
  }
  function rq(sel) {
    const el = document.querySelector(sel);
    if (!el) return 'N/A';
    const rc = el.getBoundingClientRect();
    return `t:${rc.top.toFixed(1)} b:${rc.bottom.toFixed(1)} h:${rc.height.toFixed(1)}`;
  }

  let navType = '?';
  try { const n = performance.getEntriesByType('navigation'); navType = n.length ? n[0].type : 'N/A'; } catch(e) {}

  const lines = [
    `nav: ${navType}`,
    `vh:${vh}  vw:${vw}`,
    `safe↑:${safeTop}px  safe↓:${safeBot}px`,
    `#top-bar  ${r('top-bar')}`,
    `#bottom-bar ${r('bottom-bar')}`,
    `#bottom-buttons ${r('bottom-buttons')}`,
    `.ctrl-btn ${rq('.ctrl-btn')}`,
  ];

  const panel = document.createElement('div');
  panel.id = 'probe-panel';
  panel.style.cssText = 'position:fixed;top:80px;right:8px;z-index:999999;width:270px;'
    + 'background:rgba(0,0,0,0.88);color:#0f0;font:10.5px/1.5 monospace;'
    + 'border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.5);touch-action:none;user-select:none;';
  panel.innerHTML =
    '<div id="probe-handle" style="display:flex;align-items:center;justify-content:space-between;'
    + 'padding:6px 10px 5px;background:rgba(255,255,255,0.1);border-radius:10px 10px 0 0;cursor:grab">'
    + '<span style="font-weight:700;color:#fff;font-size:11px">📐 Probe</span>'
    + '<div style="display:flex;gap:10px">'
    + '<button id="probe-refresh" style="background:none;border:none;color:#0f0;font:13px monospace;cursor:pointer;padding:0" title="重新量測">↺</button>'
    + '<button id="probe-close" style="background:none;border:none;color:#f66;font:13px monospace;cursor:pointer;padding:0" title="關閉">✕</button>'
    + '</div></div>'
    + '<div style="padding:6px 10px 8px;white-space:pre">' + lines.join('\n') + '</div>';
  document.body.appendChild(panel);

  document.getElementById('probe-refresh').onclick = probeLayout;
  document.getElementById('probe-close').onclick = () => {
    panel.remove();
    document.getElementById('probe-slider-log')?.remove();
  };

  // 速度滑桿 scroll 診斷
  const hitareaEl = document.getElementById('speed-scroll-hitarea');
  let sliderLog = document.getElementById('probe-slider-log');
  if (!sliderLog) {
    sliderLog = document.createElement('div');
    sliderLog.id = 'probe-slider-log';
    sliderLog.style.cssText = 'position:fixed;bottom:170px;right:8px;z-index:999999;width:220px;'
      + 'background:rgba(0,0,0,0.88);color:#ff0;font:10px/1.5 monospace;'
      + 'border-radius:8px;padding:6px 10px;touch-action:none;pointer-events:none;';
    document.body.appendChild(sliderLog);
  }
  if (hitareaEl) {
    hitareaEl.addEventListener('scroll', () => {
      const max = hitareaEl.scrollWidth - hitareaEl.clientWidth;
      const ratio = max > 0 ? 1 - hitareaEl.scrollLeft / max : 0;
      sliderLog.innerHTML =
        `<b style="color:#0f0">speed-scroll probe</b>\n` +
        `scroll event ✓\n` +
        `scrollLeft: ${hitareaEl.scrollLeft.toFixed(1)}\n` +
        `max: ${max.toFixed(1)}\n` +
        `ratio→val: ${ratio.toFixed(3)} → ${Math.round(1 + ratio * 19)}`;
    }, { passive: true });
    sliderLog.innerHTML = '<b style="color:#0f0">speed-scroll probe</b>\n在速度滑桿上滑動即顯示';
  } else {
    sliderLog.innerHTML = '<b style="color:#f66">speed-scroll-hitarea 不存在！</b>';
  }

  // 拖曳支援
  const handle = document.getElementById('probe-handle');
  let dragging = false, sx, sy, ox, oy;
  handle.addEventListener('pointerdown', e => {
    dragging = true;
    handle.style.cursor = 'grabbing';
    sx = e.clientX; sy = e.clientY;
    const rc = panel.getBoundingClientRect();
    ox = rc.left; oy = rc.top;
    panel.style.right = 'auto';
    panel.style.left = ox + 'px';
    panel.style.top  = oy + 'px';
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const newL = Math.max(0, Math.min(ox + e.clientX - sx, vw - panel.offsetWidth));
    const newT = Math.max(0, Math.min(oy + e.clientY - sy, vh - panel.offsetHeight));
    panel.style.left = newL + 'px';
    panel.style.top  = newT + 'px';
    e.preventDefault();
  });
  handle.addEventListener('pointerup',    () => { dragging = false; handle.style.cursor = 'grab'; });
  handle.addEventListener('pointercancel',() => { dragging = false; handle.style.cursor = 'grab'; });
}

// ===== 版本更新偵測 =====
// 重新整理一律用 location.reload()：不改變網址，才能保留 Capacitor 原生環境
// （改網址會脫離原生橋接、變成純網頁版）。新鮮度由 Service Worker 負責。
function hardReload() {
  if (activeTrip) { toast('行程記錄中，請先結束行程再重新整理'); return; }
  location.reload();
}

function checkForUpdate() {
  // 安全措施：確保 fare overlay 沒有卡住
  const fo = document.getElementById('fare-overlay');
  if (fo && fo.style.display === 'block') {
    fo.style.display = 'none';
    document.getElementById('fare-dialog').classList.remove('show');
  }
  localStorage.setItem('maptrip_version', APP_VERSION);
}

// 掃描並移除「假路線」：roadCoords 路徑長明顯超過記錄距離（>1.4 倍 + 500m）
// ＝GPS 飄點讓 /route 後備繞遠產生的假路線 → 移除、重新上雲。
// notify=true 時顯示修復提示（僅開機第一掃，避免重複打擾）
function healBogusRoads(notify) {
  try {
    const all = loadTrips();
    const fixedDays = new Set();
    Object.keys(all).forEach(day => (all[day] || []).forEach(t => {
      if (t.roadCoords && t.totalDist > 0 &&
          calcTotalDist(t.roadCoords) > t.totalDist * 1.4 + 500) {
        delete t.roadCoords;
        delete t._roadBad;
        fixedDays.add(day);
      }
    }));
    if (!fixedDays.size) return;
    saveTrips(all);
    if (window.MaptripSync) { try { MaptripSync.syncDays([...fixedDays]); } catch (_) {} }
    if (notify) setTimeout(() => toast(`已修復 ${fixedDays.size} 天內的異常貼路路線`), 2500);
    else if (typeof refreshAfterSync === 'function') { try { refreshAfterSync(); } catch (_) {} }
  } catch (_) {}
}

// 一次性清理「未貼路且含飄移群」的既有行程：不受 _snapN 重試上限影響
// （今天貼路一直失敗、_snapN 已滿的鋸齒趟也要清）。以版本旗標保證每版只跑一次。
function healZigzagTraces() {
  try {
    if (localStorage.getItem('maptrip_zigfix') === 'v246') return;
    const all = loadTrips();
    const fixedDays = new Set();
    Object.keys(all).forEach(day => (all[day] || []).forEach(t => {
      if (t.roadCoords || !t.coords || t.coords.length < 4) return;
      const cleaned = _cleanTrace(t.coords);
      if (cleaned.length < t.coords.length) {
        t.coords = cleaned.map(c => ({ lat: c.lat, lng: c.lng, ...(c.t != null ? { t: c.t } : {}) }));
        fixedDays.add(day);
      }
    }));
    localStorage.setItem('maptrip_zigfix', 'v246');
    if (!fixedDays.size) return;
    saveTrips(all);
    if (window.MaptripSync) { try { MaptripSync.syncDays([...fixedDays]); } catch (_) {} }
    if (typeof refreshAfterSync === 'function') { try { refreshAfterSync(); } catch (_) {} }
  } catch (_) {}
}

function boot() {
  // App 成功啟動 → 清掉「自動重載計數」（健康狀態，避免殘留計數誤判為迴圈）
  try { localStorage.removeItem('mt_rl'); } catch (_) {}
  // 崩潰偵測心跳（見 index.html 開頭）：活著就每 5 秒蓋一次時間戳。
  // 全新開場時發現上個行程 45 秒內還活著＝被系統砍掉，累積 4 次自動切標準地圖。
  const _beat = () => { try { localStorage.setItem('mt_alive', String(Date.now())); } catch (_) {} };
  _beat();
  setInterval(_beat, 5000);
  // 穩定執行 90 秒 → 清掉「崩潰迴圈計數」（撐不過 90 秒就被砍＝疑似記憶體迴圈，計數保留累積）
  setTimeout(() => { try { localStorage.removeItem('mt_run'); } catch (_) {} }, 90000);
  // 若剛因異常被切回標準地圖 → 告知使用者原因（診斷關鍵：知道是哪條路徑觸發）
  try {
    const reason = localStorage.getItem('mt_glfail_reason');
    if (reason && !window.MAPTRIP_GL) {
      localStorage.removeItem('mt_glfail_reason');
      const msg = reason === 'crashloop' ? '向量地圖不穩定（疑似記憶體），已暫時改用標準地圖（3 小時後自動再試）'
        : reason === 'reloadloop' ? '偵測到重載迴圈，已暫時改用標準地圖（3 小時後自動再試）'
        : reason === 'jsfail' ? '向量地圖發生錯誤，已暫時改用標準地圖（3 小時後自動再試）'
        : '向量地圖載入失敗，已暫時改用標準地圖（3 小時後自動再試）';
      setTimeout(() => toast(msg), 2000);
    }
  } catch (_) {}
  // Service Worker：攔截導覽請求，以 no-store 取得最新 index.html，
  // 永久解決 WKWebView 的 HTML 快取問題。註冊後「不」主動跳轉，避免脫離原生環境。
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // 冷啟動（navigate）時，重置診斷旗標，避免殘留 localStorage 讓面板意外出現
  try {
    const navEntries = performance.getEntriesByType('navigation');
    const navType = navEntries.length ? navEntries[0].type : '';
    if (navType !== 'reload') localStorage.removeItem('maptrip_debug');
  } catch (e) {}

  document.body.classList.add('platform-' + nativePlatform());
  // 一次性儲存壓實（每個壓實版本只跑一次）：釋放舊全精度資料佔用的空間，
  // 避免 localStorage 滿載導致存檔靜默失敗
  try {
    if (localStorage.getItem('maptrip_compacted') !== 'v4') {
      const before = storageBytes();
      if (compactStorage(false)) {
        localStorage.setItem('maptrip_compacted', 'v4');
        const freed = before - storageBytes();
        if (freed > 200000) setTimeout(() => toast(`已整理儲存空間，釋放 ${(freed / 1048576).toFixed(1)} MB`), 1500);
      }
    }
  } catch (_) {}
  // 修復假路線（每次開機都掃，不再一次性）：v1.1.234 的 /route 後備可能把含飄點的趟
  // 貼成「繞一大圈」的假路線。一次性修復會被「雲端同步稍後把舊資料蓋回來」打敗，
  // 所以：每次開機掃一遍＋開機 25 秒後（初始雲端同步落地後）再掃一遍，
  // 雲端副本遲早會被覆蓋成修復後的正確版本。顯示層另有 tripPath 防線，畫面永不受影響。
  healBogusRoads(true);
  setTimeout(() => healBogusRoads(false), 25000);
  healZigzagTraces();   // 一次性清理既有鋸齒/飄移群的未貼路趟
  initMap();
  // 依目前引擎更新選單文字
  const glBtn = document.getElementById('glmap-menu-btn');
  if (glBtn) glBtn.textContent = window.MAPTRIP_GL ? '🗺 換回標準地圖' : '🧪 新地圖引擎（Beta）';
  // 朝行進方向預設開啟（按指北針可關，選擇會記住）
  try {
    headingUp = localStorage.getItem('maptrip_headup') !== '0';
    if (headingUp) document.getElementById('compass-btn')?.classList.add('heading-on');
  } catch (_) {}
  // 開機自動嘗試啟用羅盤（先前授權過就生效），方向光束一開始就會顯示
  setTimeout(() => { try { enableDeviceCompass(true); } catch (_) {} }, 800);
  // 開機 10 秒後補貼路（未在記錄中才跑），逐步把「直線趟」修成真實路線
  setTimeout(() => { if (!activeTrip) retrySnapBacklog(); }, 10000);
  setTimeout(checkForUpdate, 2000);
  // 版本號顯示在「行程清單」底部；診斷模式開啟時標記
  const vl = document.getElementById('version-label');
  if (vl) vl.textContent = 'v' + APP_VERSION + (dbgEnabled() ? ' · 診斷中' : '');

  // 診斷模式開著時（含重新整理後），自動顯示可拖曳量測面板
  if (dbgEnabled()) setTimeout(probeLayout, 300);

  initSpeedSlider();

  // 雲端同步：載入登入狀態並開始監聽（未設定 Firebase 時安靜略過）
  if (window.MaptripSync) { try { MaptripSync.init(); } catch (e) {} }

  // 開機完成：解除 index.html 的 25 秒看門狗，並寫入黑盒子
  window.__mtBooted = true;
  try {
    window.__mtLog && window.__mtLog('boot ok v' + APP_VERSION + ' ' + (window.MAPTRIP_GL ? 'gl' : 'lf')
      + (activeTrip ? ' rec' : ''));
  } catch (_) {}
}

// 先完成儲存層初始化（IndexedDB 開啟＋舊資料搬移）再 boot，
// boot 內所有 loadTrips() 才讀得到資料。init 內部已處理所有失敗（退回 localStorage），不會 reject。
function startApp() {
  if (window.__mtReloadPending) return;   // 冷啟動自動 reload 即將發生：這一次絕不啟動
  TripStore.init(STORAGE_KEY).then(() => {
    // boot 在 .then 裡執行，丟出的例外會被 Promise 吞掉（畫面上完全無聲）——
    // GL 模式下若開機半途出錯（地圖引擎建不起來等），App 會呈現「按鈕全無反應、
    // 無法開始行程」的半死狀態。這裡接住：記下原因、防迴圈重載，重載後自動走標準地圖。
    try {
      boot();
    } catch (e) {
      if (window.MAPTRIP_GL) {
        try {
          localStorage.setItem('mt_glfail', String(Date.now()));
          localStorage.setItem('mt_glfail_reason', 'jsfail');
          localStorage.setItem('mt_glerr', String((e && e.stack) || e).slice(0, 300));
        } catch (_) {}
        (window.__mtSafeReload || location.reload.bind(location))();
        return;
      }
      throw e;   // 標準地圖模式的錯誤照常拋出（可見、可診斷）
    }
    // 開機合併有從備份撿回行程 → 讓使用者知道
    if (window._storeMerged > 0) setTimeout(() => toast(`已從備份補回 ${window._storeMerged} 趟行程`), 1200);
  });
}

// app.js 由 index.html 的 loader 動態載入，可能在 window load 之後才進來，
// 那時 'load' 事件已過、不會再觸發，因此要依 readyState 判斷是否立即啟動。
if (document.readyState === 'complete') {
  startApp();
} else {
  window.addEventListener('load', startApp);
}
