const APP_VERSION  = '1.1.241';
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
const MOVING_SPEED_MS      = 4;     // >4 m/s (~15 km/h) = 行駛中
const STOPPED_SPEED_MS     = 1;     // <1 m/s (~3.6 km/h) = 停車
const ARRIVAL_DELAY_MS     = 8000;  // 停車滿 8 秒才提示
const AUTO_START_SPEED_MS  = 5 / 3.6; // >5 km/h 持續才問是否開始
const AUTO_START_DELAY_MS  = 4000;  // 行駛滿 4 秒才跳提示

let map, myDotMarker, accuracyCircle, currentPos = null;
let activeTrip = null, activePolyline = null, timerTick = null;
let todayTrips = [], allMapLayers = [];
let _todayLayersHidden = false;   // 歷史檢視中＝true：此期間「新畫」的今日圖層也要立即隱藏
let soloLayers = [];
let soloSet = [], soloIdx = 0, soloLabelFn = null;  // 單趟顯示：可左右切換的趟次集合
let soloFromHistory = false;  // 從歷史紀錄進入 solo 模式時為 true
let soloHistoryTile = null;   // 歷史 solo 時換用的無標示底圖
let wasMoving = false, stoppedTimer = null, arrivalBannerShown = false;
let autoFollow = false, wakeLock = null;
let headingUp = false;          // 朝車頭模式（地圖旋轉跟隨行進方向）
let lastHeading = 0, headingRefPos = null;
let deviceCompassOn = false, lastMoveSpeed = 0;
let _mapTouching = 0;           // 手指目前在地圖上的數量（>0 時暫停自動跟隨/旋轉）
let _mapZooming = false;        // 縮放動畫進行中（期間不可改動線條，否則整條線會飛走）
let _lineResyncPending = false; // 縮放/手勢期間累積的新點 → 結束後一次補畫
let myHeading = null;           // 我的位置朝向（GPS 行進方向 / 羅盤），供方向光束用
let _lastPanPos = null;         // 上次跟隨移動的位置（移動 <3m 不重跑跟隨動畫，省 GPU）
let _lastCircleAt = null;       // 上次精度圓圈的位置/精度（無實質變化不重畫）
let activeSnapPending = false;
let autoStartTimer = null, autoStartShown = false, autoStartResetTimer = null, lastKnownPos = null;
let pendingWidgetStart = false;  // 鎖屏按了開始、但 GPS 還沒定位時，先排隊
let pendingFareTrip = null;      // 由浮窗結束、等待數字鍵盤輸入車資的那趟
let lastHeartbeat = 0;           // 上次替鎖屏方塊「續命」的時間戳

const TEST_MODE = TEST_MODE_ON;
let simTick = 0, simTimer = null;
let nativeWatcherId = null;

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
      // 手動雙指旋轉時，同步平滑旋轉器的內部角度（動畫中則不干預）
      if (_bearingRAF == null) {
        _animBearing = _targetBearing = ((map.getBearing() % 360) + 360) % 360;
      }
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
    if (_mapTouching > 0 && _bearingRAF != null) {
      cancelAnimationFrame(_bearingRAF); _bearingRAF = null;
      _animBearing = _targetBearing = ((map.getBearing() % 360) + 360) % 360;
    }
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
  map.on('zoomend', () => { _mapZooming = false; resyncLiveLine(); });

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

  loadTodayFromStorage();
  restoreActiveTripIfAny();   // 若上次重載/當掉時正在記錄，自動接回
  startGpsWatch();
  updateTopBar();
  setInterval(updateTopBar, 30000);
  // 頁面即將卸載（重載/切走）前，把進行中的行程再存一次，把損失壓到最小
  window.addEventListener('pagehide', saveActiveTrip);
  window.addEventListener('beforeunload', saveActiveTrip);
}

function startGpsWatch() {
  if (TEST_MODE) { startSimulation(); return; }
  if (isNative()) { startNativeGpsWatch(); return; }
  if (!navigator.geolocation) { setGpsBadge('err', '⚠ 不支援定位'); return; }
  navigator.geolocation.watchPosition(onGpsUpdate, onGpsError,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 });
}

// 原生 iOS：用背景定位外掛，鎖屏 / 切到 55688 時仍持續記錄
function startNativeGpsWatch() {
  const BG = window.Capacitor.Plugins.BackgroundGeolocation;
  if (!BG) { setGpsBadge('err', '⚠ 背景定位未安裝'); return; }
  const result = BG.addWatcher({
    backgroundTitle: 'Maptrip 行程記錄中',
    backgroundMessage: '正在背景記錄你的路線',
    requestPermissions: true,
    stale: false,
    distanceFilter: 0   // 每次定位都回報（含停車），確保到站偵測正常運作
  }, (location, error) => {
    if (error) {
      if (error.code === 'NOT_AUTHORIZED') setGpsBadge('err', '⚠ 定位權限被拒');
      return;
    }
    onGpsUpdate({ coords: {
      latitude:  location.latitude,
      longitude: location.longitude,
      accuracy:  location.accuracy,
      speed:     location.speed
    }});
  });
  // addWatcher 在不同版本可能回傳 Promise<id> 或直接回傳 id 字串，兩者皆相容
  Promise.resolve(result)
    .then(id => { nativeWatcherId = id; })
    .catch(() => setGpsBadge('err', '⚠ 背景定位啟動失敗'));
}

// ===== 測試模式：模擬 GPS（網址加 ?test=1 啟用）=====
// 流程：靜止 5 秒 → 行駛 25 秒（約 12 m/s）→ 停車（觸發到站偵測）
// 起點優先使用裝置真實位置，抓不到才退回台北 101
function startSimulation() {
  toast('🧪 測試模式：模擬 GPS 已啟用');
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p => runSimulation({ lat: p.coords.latitude, lng: p.coords.longitude }),
      ()  => runSimulation({ lat: 25.0330, lng: 121.5654 }),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  } else {
    runSimulation({ lat: 25.0330, lng: 121.5654 });
  }
}

function runSimulation(base) {
  simTick = 0;
  clearInterval(simTimer);
  simTimer = setInterval(() => {
    simTick++;
    let lat, lng, speed;
    if (simTick <= 5) {            // 靜止暖機
      lat = base.lat; lng = base.lng; speed = 0;
    } else if (simTick <= 30) {    // 行駛中：往東北移動
      const p = simTick - 5;
      lat = base.lat + p * 0.0001;
      lng = base.lng + p * 0.00012;
      speed = 12;
    } else {                       // 停車：停在終點
      lat = base.lat + 25 * 0.0001;
      lng = base.lng + 25 * 0.00012;
      speed = 0;
    }
    onGpsUpdate({ coords: { latitude: lat, longitude: lng, accuracy: 10, speed } });
  }, 1000);
}

function restartSimulation() {
  if (!TEST_MODE) return;
  clearInterval(simTimer);
  const base = currentPos || { lat: 25.0330, lng: 121.5654 };
  runSimulation(base);
}

function onGpsUpdate(pos) {
  const { latitude: lat, longitude: lng, accuracy: acc, speed } = pos.coords;

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
    // GPS 品質閘門：都市峽谷/高架下的反射訊號會產生亂飄的點，
    // (1) 水平精度太差（>40m）不記錄；(2) 相對上一點為物理上不可能的瞬移（>50 m/s）不記錄。
    // 過濾掉的點也不畫進即時折線，畫面與存檔一致（藍點仍照常移動）。
    const last = activeTrip.coords.at(-1);
    const badAcc = acc != null && acc > 40;
    const isJump = last &&
      haversine(last, { lat, lng }) / Math.max(1, (Date.now() - last.t) / 1000) > 50;

    if (!badAcc && !isJump) {
      // 每次 GPS 更新都延伸折線（畫面即時跟隨軌跡）。
      // 縮放/手勢期間先不畫（否則整條線會飛走），結束後 resyncLiveLine 一次補上
      if (_mapZooming || _mapTouching) _lineResyncPending = true;
      else activePolyline.addLatLng([lat, lng]);

      // 每 GPS_RECORD_MS 才存一個座標點（節省儲存空間）
      if (!last || Date.now() - last.t >= GPS_RECORD_MS) {
        if (last) activeTrip._dist = activeDist() + haversine(last, { lat, lng });  // 增量累加距離
        activeTrip.coords.push({ lat, lng, t: Date.now() });
        saveActiveTrip();   // 每存一個座標就更新復原暫存（內部節流 5 秒）
        // 定期把累積軌跡貼合到道路上（即時更新折線）
        const n = activeTrip.coords.length;
        if (n >= 4 && n % LIVE_SNAP_PTS === 0 && !activeSnapPending) {
          activeSnapPending = true;
          snapLiveRoute();
        }
      }
    }
    checkArrival(effectiveSpeed);
  } else {
    checkAutoStart(effectiveSpeed);
  }

  // 地圖朝車頭旋轉放最後，並包 try/catch：即使旋轉出錯也絕不影響上面的行程記錄
  try { applyHeadingUp(lat, lng, effectiveSpeed, pos.coords.heading); } catch (_) {}
}

// 自動偵測彈窗（行駛中→問開始、停車→問結束)已依使用者要求停用：行程一律手動開始/結束。
// 想恢復把這個開關改回 true 即可。
const AUTO_PROMPTS = false;

function checkArrival(speed) {
  if (!AUTO_PROMPTS) return;
  if (speed == null || isNaN(speed) || speed < 0) return;
  if (speed > MOVING_SPEED_MS) {
    wasMoving = true;
    arrivalBannerShown = false;
    clearTimeout(stoppedTimer);
    stoppedTimer = null;
    hideArrivalBanner();
  } else if (speed >= STOPPED_SPEED_MS) {
    // 慢速蠕行（塞車 1~4 m/s）：不算停車，取消倒數，避免誤跳「已抵達」
    clearTimeout(stoppedTimer);
    stoppedTimer = null;
  } else if (speed < STOPPED_SPEED_MS && wasMoving && !arrivalBannerShown) {
    if (stoppedTimer) return; // 已在倒數中，不重複設定
    stoppedTimer = setTimeout(() => {
      stoppedTimer = null;
      if (activeTrip && !arrivalBannerShown) {
        arrivalBannerShown = true;
        showArrivalBanner();
      }
    }, ARRIVAL_DELAY_MS);
  }
}

function showArrivalBanner() {
  const b = document.getElementById('arrival-banner');
  b.classList.add('show');
  clearTimeout(b._autoDismiss);
  b._autoDismiss = setTimeout(() => hideArrivalBanner(), 30000);
}

function hideArrivalBanner() {
  document.getElementById('arrival-banner').classList.remove('show');
}

function arrivalConfirm() {
  hideArrivalBanner();
  endTrip();
}

function arrivalDismiss() {
  hideArrivalBanner();
  wasMoving = false;
  arrivalBannerShown = false;
}

function checkAutoStart(speed) {
  if (!AUTO_PROMPTS) return;
  if (activeTrip || autoStartShown) return;
  if (speed == null || isNaN(speed) || speed < 0) return;
  if (speed > AUTO_START_SPEED_MS) {
    if (!autoStartTimer) {
      autoStartTimer = setTimeout(() => {
        autoStartTimer = null;
        if (!activeTrip && !autoStartShown) {
          autoStartShown = true;
          document.getElementById('autostart-banner').classList.add('show');
        }
      }, AUTO_START_DELAY_MS);
    }
  } else {
    clearTimeout(autoStartTimer);
    autoStartTimer = null;
  }
  // 「略過」後：停止移動連續 2 分鐘即重置，下次出發能再次提示
  if (autoStartShown && speed < STOPPED_SPEED_MS) {
    if (!autoStartResetTimer) autoStartResetTimer = setTimeout(() => {
      autoStartResetTimer = null;
      autoStartShown = false;
    }, 120000);
  } else if (autoStartResetTimer) {
    clearTimeout(autoStartResetTimer);
    autoStartResetTimer = null;
  }
}

function confirmAutoStart() {
  document.getElementById('autostart-banner').classList.remove('show');
  autoStartShown = false;
  beginRecording();
}

function dismissAutoStart() {
  document.getElementById('autostart-banner').classList.remove('show');
  autoStartShown = true; // 略過後本次不再提示，直到停車再重置
  clearTimeout(autoStartTimer);
  autoStartTimer = null;
}

function onGpsError(err) {
  const msgs = { 1: 'GPS 存取被拒', 2: 'GPS 訊號遺失', 3: 'GPS 逾時' };
  setGpsBadge('err', '⚠ ' + (msgs[err.code] || 'GPS 錯誤'));
}

function startTrip() {
  if (activeTrip)  { toast('行程進行中，請先按「已抵達」'); return; }
  if (!currentPos) { toast('等待 GPS 訊號中...'); return; }
  beginRecording();
}

// 鎖屏 widget 的 maptrip:// URL 路由（背景喚醒 appUrlOpen + 冷啟動 getLaunchUrl 共用）
function handleWidgetUrl(url) {
  if (!url) return;
  if (url.indexOf('maptrip://start') === 0) widgetStart();
  else if (url.indexOf('maptrip://end') === 0 && activeTrip) endTrip();
}

// 鎖屏 Widget 觸發的開始：背景被喚醒時 GPS 常還沒定位，
// 若還沒鎖定就排隊，等下一筆 GPS 進來自動開始（見 onGpsUpdate）。
function widgetStart() {
  dbg('widgetStart active=' + !!activeTrip + ' pos=' + !!currentPos);
  if (activeTrip) return;
  if (currentPos) { beginRecording(); }
  else { pendingWidgetStart = true; toast('定位中，行程即將開始…'); }
}

// 補做鎖屏暫存指令；回傳 Promise<bool>，true 表示真的執行了指令（start 或 end）
function consumePendingWidgetCmd() {
  const la = liveAct();
  const p = la?.consumePendingCommand?.();
  if (!p || typeof p.then !== 'function') { dbg('consume: no method'); return Promise.resolve(false); }
  return p.then(res => {
    // 完整診斷：std=標準 UserDefaults，grp=App Group；proc=perform() 跑在哪個 process
    dbg('consume act=' + JSON.stringify(res?.action)
        + ' | std raw=' + JSON.stringify(res?.stdRaw) + ' age=' + res?.stdAge + ' proc=' + res?.stdProc
        + ' | grp raw=' + JSON.stringify(res?.grpRaw) + ' age=' + res?.grpAge + ' proc=' + res?.grpProc
        + ' grpNil=' + res?.grpNil
        + ' | app=' + res?.appProc);
    if (res?.action === 'start') { widgetStart(); return true; }
    if (res?.action === 'end' && activeTrip) { endTrip(); return true; }
    return false;
  }).catch(e => { dbg('consume err ' + e); return false; });
}

// 冷啟動補做：perform() 可能比 JS boot 晚執行（時序競賽），所以重試數次。
// 任一次成功（執行了指令）就停止；全部落空才放棄。
function consumePendingWidgetCmdRetry(tries = 6, gapMs = 600) {
  return consumePendingWidgetCmd().then(didAct => {
    if (didAct || tries <= 1) return didAct;
    return new Promise(r => setTimeout(r, gapMs))
      .then(() => consumePendingWidgetCmdRetry(tries - 1, gapMs));
  });
}

// 替鎖屏方塊「續命」：刷新原生端的 staleDate。節流到至少每 2 秒一次（過期時間設 6 秒，
// 續命須明顯比它快，App 活著時方塊才不會誤消失）。
// 記錄中時同時更新 elapsed + distance，讓 widget 在背景也能即時顯示行程資訊。
function widgetHeartbeat() {
  const now = Date.now();
  if (now - lastHeartbeat < 2000) return;
  lastHeartbeat = now;
  if (activeTrip) {
    const elapsed  = Math.floor((now - activeTrip.startTime) / 1000);
    const distance = Math.round(activeDist());
    liveAct()?.updateTrip({ elapsed, distance });
    floatWin()?.update({ elapsed, distance }).catch(() => {});
  } else {
    liveAct()?.heartbeat?.();
  }
}

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

async function beginRecording() {
  goHome();   // 開始行程立刻回主頁（地圖），收起紀錄/歷史等覆蓋層
  restartSimulation();
  wasMoving = false;
  arrivalBannerShown = false;
  activeSnapPending = false;
  setAutoFollow(true);
  activeTrip = { id: Date.now(), startTime: Date.now(), coords: [{ ...currentPos, t: Date.now() }] };
  activePolyline = L.polyline([[currentPos.lat, currentPos.lng]],
    { color: '#1A73E8', weight: 5, opacity: 0.9 }).addTo(map);
  const startBtn = document.getElementById('start-btn');
  startBtn.onclick = () => endTrip();   // 不傳參數：走 App 內車資對話框
  startBtn.querySelector('.ctrl-icon').textContent = '■';
  startBtn.querySelector('.ctrl-label').textContent = '結束';
  startBtn.classList.add('recording');
  document.getElementById('rec-banner').style.display = 'flex';
  timerTick = setInterval(refreshRecBanner, 1000);
  map.panTo([currentPos.lat, currentPos.lng]);
  toast('行程開始！');
  liveAct()?.startTrip();
  // Android 浮動視窗切到「記錄中」狀態
  floatWin()?.showRecording({ elapsed: 0, distance: 0 }).catch(() => {});
  saveActiveTrip();   // 立即存一份，供重載復原

  // 螢幕常亮（避免 iOS 熄屏後 GPS 被節流）
  await requestWakeLock();
}

// 取得螢幕常亮鎖
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      // 系統在熄屏/切 App 時會自動釋放，記錄下來以便回前景時重取
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) { /* 不支援或被拒時靜默略過 */ }
}

// 回到前景時自動重新鎖定螢幕常亮（系統會在熄屏/切 App 時釋放鎖）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeTrip && wakeLock === null) {
    requestWakeLock();
  }
});

// fromFloat=true：由浮動視窗的「結束」鈕觸發 → 車資改用浮窗數字鍵盤輸入
function endTrip(fromFloat) {
  if (!activeTrip) return;
  clearActiveTrip();   // 行程正式結束，清掉復原暫存
  clearInterval(timerTick);  timerTick = null;
  liveAct()?.endTrip();
  clearTimeout(stoppedTimer); stoppedTimer = null;
  hideArrivalBanner();

  const trip = {
    id: activeTrip.id, startTime: activeTrip.startTime, endTime: Date.now(),
    coords: activeTrip.coords, totalDist: calcTotalDist(activeTrip.coords), fare: 0
  };

  if (activePolyline) { map.removeLayer(activePolyline); activePolyline = null; }
  activeTrip = null;
  wasMoving = false; arrivalBannerShown = false;
  autoStartShown = false; // 行程結束後，下次出發可再次偵測
  setAutoFollow(false);
  const startBtn = document.getElementById('start-btn');
  startBtn.onclick = startTrip;
  startBtn.querySelector('.ctrl-icon').textContent = '▶';
  startBtn.querySelector('.ctrl-label').textContent = '開始';
  startBtn.classList.remove('recording');
  document.getElementById('rec-banner').style.display = 'none';

  // 釋放螢幕常亮鎖
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }

  // 先立即落盤（fare=0）：從此刻起這趟就安全了，即使車資輸入前
  // App 被殺/重載也不會遺失；車資與貼路稍後用更新的方式補上。
  saveTripFinal(trip);

  if (fromFloat) {
    // 由浮窗結束：記住這趟，叫出浮窗數字鍵盤輸入車資（見 saveFloatFare）
    pendingFareTrip = trip;
    floatWin()?.promptFare().catch(() => {});
  } else {
    floatWin()?.showIdle().catch(() => {});
    showFareDialog(trip);
  }
}

// 更新「已落盤」的行程：補車資 / 付款方式 / 貼路座標，並重畫該趟路線。
// 注意：貼路是慢速網路操作，期間畫面可能被雲端同步刷新（todayTrips 換成新物件），
// 所以寫回時一律用「行程 id」重新定位，不依賴物件同一性，否則結果會寫到孤兒物件上遺失。
async function finalizeSavedTrip(trip, fare, paymentMethod, label, commission, dispatch) {
  const apply = (t) => {
    t.fare = fare;
    t.paymentMethod = paymentMethod;
    if (commission !== undefined) t.commission = commission || 0;   // 抽成
    if (dispatch !== undefined) t.dispatch = dispatch || 0;         // 叫車費
    if (label !== undefined) t.label = label || '';
  };
  apply(trip);
  let mem = todayTrips.find(t => t.id === trip.id);
  if (mem && mem !== trip) apply(mem);
  saveTodayToStorage();   // 車資先存（貼路成功與否不影響金額）
  if (commission || dispatch) _pushCommission(trip.id, commission, dispatch);   // 抽成上雲
  updateTopBar();

  const road = await snapToRoads(trip.coords);
  if (road) {
    // 以 id 重新定位目前清單中的那筆（可能已被同步刷新換新）
    mem = todayTrips.find(t => t.id === trip.id) || trip;
    mem.roadCoords = road;
    // 貼路成功 → 原始 GPS 座標只留頭尾（畫線/回放/截圖一律用 roadCoords）
    if (mem.coords && mem.coords.length > 2) {
      mem.coords = [mem.coords[0], mem.coords[mem.coords.length - 1]];
    }
    // 重畫這趟的路線（換成貼路座標）
    const idx = todayTrips.indexOf(mem);
    if (idx >= 0) {
      (mem._layers || []).forEach(l => {
        try { map.removeLayer(l); } catch (_) {}
        const j = allMapLayers.indexOf(l);
        if (j >= 0) allMapLayers.splice(j, 1);
      });
      drawTripLine(mem, idx + 1);
    }
    saveTodayToStorage();
  } else {
    // 貼路失敗：60 秒後自動重試（不必等下次開機）
    setTimeout(() => { if (!activeTrip) retrySnapBacklog(2); }, 60000);
  }
  const ts = document.getElementById('trip-sheet');
  if (ts && ts.style.display !== 'none') renderTripSheet();
}

// ===== 進行中行程的「當機／重載」復原 =====
// 記錄中定期把 activeTrip 存本機；重開 App 若偵測到未結束的行程，自動接回繼續記錄。
const ACTIVE_KEY = TEST_MODE_ON ? 'maptrip_active_test' : 'maptrip_active';
let _lastActiveSave = 0;
function saveActiveTrip(force) {
  if (!activeTrip) return;
  // 節流：每 5 秒存一次即可（pagehide/beforeunload 會強制補存），
  // 避免長行程每秒全量 JSON.stringify 造成不必要的耗電
  const now = Date.now();
  if (!force && now - _lastActiveSave < 5000) return;
  _lastActiveSave = now;
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({
      id: activeTrip.id, startTime: activeTrip.startTime,
      coords: activeTrip.coords, savedAt: now
    }));
  } catch (_) {}
}
function clearActiveTrip() { try { localStorage.removeItem(ACTIVE_KEY); } catch (_) {} }

function restoreActiveTripIfAny() {
  if (activeTrip) return;
  let s = null;
  try { s = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null'); } catch (_) {}
  if (!s || !Array.isArray(s.coords) || !s.coords.length) return;
  if (s.savedAt && Date.now() - s.savedAt > 12 * 3600 * 1000) {
    // 超過 12 小時不接回，但軌跡不丟：以最後一點時間存成完成行程（金額可補填）
    clearActiveTrip();
    try {
      const last = s.coords[s.coords.length - 1];
      const trip = { id: s.id, startTime: s.startTime, endTime: (last && last.t) || s.savedAt,
                     coords: s.coords, totalDist: calcTotalDist(s.coords), fare: 0 };
      const day = businessDayKey(trip.startTime);
      const raw = loadTrips();
      (raw[day] = raw[day] || []).push(serializeTrip(trip));
      raw[day].sort((a, b) => a.startTime - b.startTime);
      saveTrips(raw);
      if (window.MaptripSync) MaptripSync.syncDays([day]);
      toast('已將中斷的行程存檔，金額可稍後補填');
    } catch (_) {}
    return;
  }
  activeTrip = { id: s.id, startTime: s.startTime, coords: s.coords };
  activePolyline = L.polyline(s.coords.map(c => [c.lat, c.lng]),
    { color: '#1A73E8', weight: 5, opacity: 0.9 }).addTo(map);
  setAutoFollow(true);
  const startBtn = document.getElementById('start-btn');
  startBtn.onclick = () => endTrip();
  startBtn.querySelector('.ctrl-icon').textContent = '■';
  startBtn.querySelector('.ctrl-label').textContent = '結束';
  startBtn.classList.add('recording');
  document.getElementById('rec-banner').style.display = 'flex';
  timerTick = setInterval(refreshRecBanner, 1000);
  refreshRecBanner();
  requestWakeLock();
  try { liveAct()?.startTrip?.(); } catch (_) {}
  try {
    floatWin()?.showRecording({
      elapsed: Math.floor((Date.now() - activeTrip.startTime) / 1000),
      distance: Math.round(calcTotalDist(activeTrip.coords))
    }).catch(() => {});
  } catch (_) {}
  toast('已接回記錄中的行程');
}

// 浮窗數字鍵盤按「確定/略過」後：把車資補進「已落盤」的那趟並貼路
async function saveFloatFare(fare, paymentMethod) {
  const trip = pendingFareTrip;
  pendingFareTrip = null;
  if (!trip) return;
  await finalizeSavedTrip(trip, fare, paymentMethod || '');
}

// 背景結束：直接貼合道路並存檔（金額 0），不需 UI
async function saveTripBackground(trip) {
  trip.roadCoords = await snapToRoads(trip.coords);
  saveTripFinal(trip);
  toast('✓ 行程已結束，金額可稍後在清單補填');
}

// 把某趟的抽成/叫車費寫進雲端「抽成集合」（司機本人；記帳者才看得到，也是雙向來源）
function _pushCommission(tripId, commission, dispatch) {
  try {
    if (window.MaptripSync && MaptripSync.writeCommission && MaptripSync.myUid && MaptripSync.myUid())
      MaptripSync.writeCommission(MaptripSync.myUid(), tripId, commission, dispatch).catch(() => {});
  } catch (_) {}
}

// 讀 / 寫車資對話框的「抽成 / 叫車費」欄位
function _readFareExtra() {
  return {
    commission: parseInt(document.getElementById('fare-commission').value) || 0,
    dispatch: parseInt(document.getElementById('fare-dispatch').value) || 0
  };
}
function _setFareExtra(commission, dispatch) {
  document.getElementById('fare-commission').value = commission || '';
  document.getElementById('fare-dispatch').value = dispatch || '';
}

function showFareDialog(trip) {
  document.getElementById('fs-start').textContent  = fmtTime(trip.startTime);
  document.getElementById('fs-end').textContent    = fmtTime(trip.endTime);
  document.getElementById('fs-dur').textContent    = fmtDur(trip.endTime - trip.startTime);
  document.getElementById('fs-dist').textContent   = fmtDist(trip.totalDist);
  document.getElementById('fare-input').value = '';
  _setFareExtra(0, 0);

  document.getElementById('fare-overlay').style.display = 'block';
  document.getElementById('fare-dialog').classList.add('show');
  setTimeout(() => document.getElementById('fare-input').focus(), 300);

  const cashBtn = document.getElementById('fare-cash');
  const cardBtn = document.getElementById('fare-card');
  const skipBtn = document.getElementById('fare-skip');

  const save = (fare, paymentMethod, label) => {
    // 行程在 endTrip 時已落盤；這裡立即關閉對話框，車資與貼路在背景補上
    const ex = _readFareExtra();
    document.getElementById('fare-overlay').style.display = 'none';
    document.getElementById('fare-dialog').classList.remove('show');
    finalizeSavedTrip(trip, fare, paymentMethod, label || '', ex.commission, ex.dispatch);
  };

  cashBtn.onclick = () => save(parseInt(document.getElementById('fare-input').value) || 0, 'cash');
  cardBtn.onclick = () => save(parseInt(document.getElementById('fare-input').value) || 0, 'card');
  // 其他：輸入名稱（如「騎腳踏車」），不需金額，時間照算進工作時間
  skipBtn.onclick = () => {
    const name = (prompt('輸入名稱（例如：騎腳踏車）', '') || '').trim();
    save(0, 'other', name);
  };
}

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

// OSRM Map Matching：將 GPS 座標貼合到道路上
// 均勻取樣至最多 maxPts 點（step 用 ceil 才保證取樣後 ≤ maxPts；結尾補回真正的終點）
function _sampleTrack(coords, maxPts) {
  let pts = coords;
  if (pts.length > maxPts) {
    const step = Math.ceil(pts.length / maxPts);
    pts = coords.filter((_, i) => i % step === 0);
    if (pts.length >= maxPts) pts = pts.slice(0, maxPts - 1);
    if (pts[pts.length - 1] !== coords[coords.length - 1])
      pts.push(coords[coords.length - 1]);
  }
  return pts;
}

// 貼路結果健全性檢查：貼出來的路徑若比原始軌跡長太多，必定是 GPS 飄點
// 把路線拉去繞遠路（/route 會把每個取樣點當必經點）→ 寧可不貼，維持原始軌跡。
// ratio/slack 可依來源調整：/route 較容易產生繞路 → 用更嚴的門檻
function _snapSane(result, coords, ratio, slack) {
  try {
    const raw = calcTotalDist(coords);
    return calcTotalDist(result) <= raw * (ratio || 1.4) + (slack || 500);
  } catch (_) { return true; }
}

// 剔除孤立飄點：經過 p 的繞行距離遠大於直接連前後點（>2.5 倍且多繞 60m 以上）
// ＝孤立飄點。少了它，貼路就不會繞一個街廓去「經過」飄點（小圈假路線的成因）。
// 只影響貼路輸入，原始記錄座標不動。
function _dropSpikes(coords) {
  if (!coords || coords.length < 3) return coords;
  const out = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const a = out[out.length - 1], p = coords[i], b = coords[i + 1];
    const via = haversine(a, p) + haversine(p, b);
    const direct = haversine(a, b);
    if (via > direct * 2.5 && via - direct > 60) continue;
    out.push(p);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

async function snapToRoads(coords) {
  if (coords.length < 2) return null;
  coords = _dropSpikes(coords);   // 孤立飄點不進貼路（否則會被當必經點繞路）

  // OSRM 公開伺服器的點數上限「會變」（曾為 100；2026-07 實測連 95 點也被 TooBig 拒絕）。
  // 不猜固定上限：被嫌太大就自動縮小取樣數再試，任何伺服器設定都能自我適應。
  for (const maxPts of [95, 60, 40, 25]) {
    const pts = _sampleTrack(coords, maxPts);
    const coordStr = pts.map(c => `${c.lng},${c.lat}`).join(';');
    const hasT = pts.every(c => typeof c.t === 'number' && isFinite(c.t));
    const tsStr = hasT ? pts.map(c => Math.floor(c.t / 1000)).join(';') : null;

    // 依序嘗試多組參數（半徑 / 有無時間戳）：伺服器嫌哪個參數都能自動降級成功。
    // 失敗時把「回應內文的錯誤碼」記進 _snapErr，診斷提示會顯示真正原因。
    const attempts = [
      { r: 50, ts: !!tsStr },
      { r: 50, ts: false },
      { r: 30, ts: false }
    ];
    let tooBig = false;
    for (const a of attempts) {
      const radii = pts.map(() => String(a.r)).join(';');
      const tsParam = (a.ts && tsStr) ? `&timestamps=${tsStr}` : '';
      const url = `https://router.project-osrm.org/match/v1/driving/${coordStr}` +
        `?radiuses=${radii}${tsParam}&geometries=geojson&overview=full&annotations=false`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
          let detail = '';
          try { const body = await res.json(); detail = body.code || body.message || ''; } catch (_) {}
          window._snapErr = 'HTTP' + res.status + (detail ? ':' + detail : '');
          // 點數超限：換半徑/時間戳都沒用，直接跳到下一級較小的取樣數
          if (/toobig/i.test(detail)) { tooBig = true; break; }
          continue;   // 其他錯誤 → 換下一組參數
        }
        const data = await res.json();
        if (data.code === 'Ok' && data.matchings?.length) {
          const out = data.matchings.flatMap(m =>
            m.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
          );
          if (_snapSane(out, coords)) { window._snapErr = null; return out; }
          window._snapErr = '貼路繞遠(棄用)';
          continue;   // 換參數（較小半徑可能甩掉飄點）
        }
        window._snapErr = data.code || 'NoMatch';
        // NoMatch 換參數也難救，但半徑不同仍值得一試 → 繼續
      } catch (e) {
        window._snapErr = (e && e.name === 'TimeoutError') ? '逾時' : '網路錯誤';
        return null;   // 網路層問題，換參數/縮點數都無意義
      }
    }
    if (!tooBig) return null;   // 非點數問題（NoMatch 等）：縮小取樣也救不了
    // TooBig → 下一輪用更小的取樣數再試
  }
  // /match 連最小取樣（25 點）都被拒 → 公開伺服器可能已收緊/停用貼合服務。
  // 後備：改用 /route 以「途經點」近似貼路（把取樣點當依序經過的路口，走路網連起來）
  try {
    const pts = _sampleTrack(coords, 25);
    const coordStr = pts.map(c => `${c.lng},${c.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}` +
      `?overview=full&geometries=geojson&steps=false&annotations=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      if (data.code === 'Ok' && data.routes?.length) {
        const out = data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
        // /route 把取樣點當必經點、容易產生繞路 → 用更嚴的門檻（1.2 倍 + 200m），
        // 連「繞一個街廓的小圈」也擋下
        if (_snapSane(out, coords, 1.2, 200)) { window._snapErr = null; return out; }
        window._snapErr = '貼路繞遠(棄用)';
      }
    }
  } catch (_) {}
  return null;
}

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
  _applyTodayHidden([gap]);
  return gap;
}

// 回傳存在的 today pane 名稱；不存在（GL 模式或建立失敗）回 undefined → 用預設 pane
function _todayPane(name) {
  try { if (map.getPane && map.getPane(name)) return name; } catch (_) {}
  return undefined;
}
// 整組顯示/隱藏今日行程圖層（pane 一次搞定，不漏任何一個標記/線）
function showTodayLayers(on) {
  _todayLayersHidden = !on;   // 記住狀態：隱藏期間「新畫」的圖層（貼路重畫/同步重畫）也要隱藏
  ['todayLines', 'todayMarks'].forEach(p => {
    try { const pane = map.getPane && map.getPane(p); if (pane) pane.style.display = on ? '' : 'none'; } catch (_) {}
  });
  // GL 模式或未進 pane 的圖層：用不透明度保險（維持舊行為）
  allMapLayers.forEach(l => {
    if (l.setStyle) { try { l.setStyle({ opacity: on ? 0.85 : 0 }); } catch (_) {} }
    else if (l.setOpacity) { try { l.setOpacity(on ? 1 : 0); } catch (_) {} }
  });
}
// 新建立的今日圖層若正處於「歷史檢視隱藏中」→ 立即套用隱藏。
// 修正：補貼路成功/同步後的「重畫」若發生在歷史檢視期間，新圖層原本會直接冒出來
// （GL 模式沒有 pane 保護，今日的點就這樣外漏到歷史畫面）
function _applyTodayHidden(layers) {
  if (!_todayLayersHidden) return;
  layers.forEach(l => {
    if (!l) return;
    if (l.setStyle) { try { l.setStyle({ opacity: 0 }); } catch (_) {} }
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
  _applyTodayHidden(trip._layers);   // 歷史檢視期間重畫的趟：立即隱藏，不外漏
}

// 深色模式偵測（系統設定）
function _isDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
// 無標示底圖（淺/深）
const NOLABEL_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png';
const NOLABEL_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png';

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

function centerOnMe() {
  if (!currentPos) { toast('尚未取得位置'); return; }
  setAutoFollow(true);
  enableDeviceCompass();   // 開啟羅盤：停著也能顯示方向光束
  map.setView([currentPos.lat, currentPos.lng], 16);
  // 朝車頭模式：恢復跟隨的同時也恢復自動旋轉
  if (headingUp && lastHeading) setTargetBearing(-lastHeading);
}

// 兩點間方位角（度，正北為 0，順時針）
function bearingBetween(a, b) {
  const toR = d => d * Math.PI / 180, toD = r => r * 180 / Math.PI;
  const dLon = toR(b.lng - a.lng);
  const y = Math.sin(dLon) * Math.cos(toR(b.lat));
  const x = Math.cos(toR(a.lat)) * Math.sin(toR(b.lat)) -
            Math.sin(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.cos(dLon);
  return (toD(Math.atan2(y, x)) + 360) % 360;
}

// 角度累積器：讓 CSS transition 永遠走最短路徑，
// 跨 0°/360° 時不會反向繞一整圈（例：350°→10° 只轉 +20°，不轉 -340°）
function _accumAngle(prev, targetDeg) {
  const diff = ((targetDeg - prev) % 360 + 540) % 360 - 180;
  return prev + diff;
}

// 指北針針頭旋轉，永遠指向真北（= 地圖 bearing 的反向）
let _needleAnim = 0;
function updateCompassNeedle() {
  const n = document.getElementById('compass-needle');
  if (!n || !map.getBearing) return;
  _needleAnim = _accumAngle(_needleAnim, -map.getBearing());
  n.style.transform = `rotate(${_needleAnim}deg)`;
}

// 我的位置方向光束：指向 myHeading（考慮地圖旋轉，畫面上永遠指對方向）
let _beamAnim = null;
function updateMyHeadingArrow() {
  if (!myDotMarker || !myDotMarker.getElement) return;
  const el = myDotMarker.getElement();
  if (!el) return;
  const rot = el.querySelector('.myloc-rot');
  if (!rot) return;
  if (myHeading == null) return;   // 尚無方向資料，維持現狀（一旦顯示就不再隱藏）
  const mapB = (map.getBearing && map.getBearing()) || 0;
  const target = myHeading + mapB;
  rot.style.display = '';
  if (_beamAnim == null) {
    // 第一次顯示：直接定位、不做動畫（避免從 0 度掃一圈過去）
    rot.style.transition = 'none';
    _beamAnim = target;
    rot.style.transform = `rotate(${_beamAnim}deg)`;
    void rot.offsetWidth;
    rot.style.transition = '';
    return;
  }
  _beamAnim = _accumAngle(_beamAnim, target);
  rot.style.transform = `rotate(${_beamAnim}deg)`;
}

// 平滑旋轉：以 rAF 緩動到目標角度（走最短角度差），避免硬切造成卡頓
let _targetBearing = 0, _animBearing = 0, _bearingRAF = null;
function setTargetBearing(deg) {
  if (!map.setBearing) return;
  _targetBearing = ((deg % 360) + 360) % 360;
  if (_bearingRAF == null) _bearingRAF = requestAnimationFrame(_stepBearing);
}
function _stepBearing() {
  let diff = ((_targetBearing - _animBearing + 540) % 360) - 180;   // -180..180 最短路徑
  if (Math.abs(diff) < 0.4) {
    _animBearing = _targetBearing;
    map.setBearing(_animBearing);
    _bearingRAF = null;
    return;
  }
  _animBearing = (_animBearing + diff * 0.2 + 360) % 360;            // 每幀補 20%
  map.setBearing(_animBearing);
  _bearingRAF = requestAnimationFrame(_stepBearing);
}
// 立即歸位指北（切換到預覽/單趟時用，不做動畫）
function resetBearingNow() {
  if (!map.setBearing) return;
  if (_bearingRAF != null) { cancelAnimationFrame(_bearingRAF); _bearingRAF = null; }
  _targetBearing = _animBearing = 0;
  map.setBearing(0);
}

// 按指北針：在「朝車頭」與「鎖定指北」間切換
function toggleCompass() {
  if (!map.setBearing) return;
  headingUp = !headingUp;
  try { localStorage.setItem('maptrip_headup', headingUp ? '1' : '0'); } catch (_) {}
  const btn = document.getElementById('compass-btn');
  if (headingUp) {
    btn.classList.add('heading-on');
    enableDeviceCompass();                            // 啟用手機羅盤（停著也能轉）
    if (lastHeading) setTargetBearing(-lastHeading);
    toast('地圖朝行進方向');
  } else {
    btn.classList.remove('heading-on');
    setTargetBearing(0);                              // 平滑轉回指北
    toast('地圖已鎖定指北');
  }
}

// 啟用手機羅盤：iOS 需經使用者手勢請求權限（指北針點擊即手勢）。
// silent=true 用於開機自動嘗試：先前授權過就直接生效（不會跳視窗），
// 尚未授權則安靜略過，等使用者按指北針/定位鈕時再正式請求。
function enableDeviceCompass(silent) {
  if (deviceCompassOn) return;
  const start = () => {
    window.addEventListener('deviceorientationabsolute', onDeviceOrient, true);
    window.addEventListener('deviceorientation', onDeviceOrient, true);
    deviceCompassOn = true;
  };
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then(res => {
          if (res === 'granted') start();
          else if (!silent) toast('未授權羅盤，移動時仍會依 GPS 轉向');
        })
        .catch(() => {});
    } else { start(); }
  } catch (_) {}
}

// 羅盤回呼：停著或低速時用手機朝向轉地圖；高速行駛時交給 GPS 方向。
// 節流＋死區（關鍵）：iOS 羅盤每秒回報 ~60 次且靜止時恆抖 ±1-2°，
// 若全量餵進旋轉動畫，目標角永遠在變、動畫迴圈永不停 → 地圖 60fps 無限重繪
// → GPU/CPU 滿載、手機發燙、記憶體+熱壓力 → WKWebView 行程每隔幾秒被 iOS 砍掉。
// 節流到最多 ~7 次/秒；並與「目前已套用的方向」比較，差 <2.5° 一律不動
// （比「與上一筆比」強：抖動繞著錨點慢慢晃也擋得住）。靜止零重繪，真轉向瞬間通過。
let _lastOrientT = 0;
function onDeviceOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    h = e.webkitCompassHeading;                  // iOS：0=北、順時針
  } else if (e.alpha != null && (e.absolute || e.absolute === undefined)) {
    h = (360 - e.alpha) % 360;                   // Android
  }
  if (h == null || isNaN(h)) return;
  const _now = Date.now();
  if (_now - _lastOrientT < 150) return;
  _lastOrientT = _now;
  if (myHeading != null &&
      Math.abs(((h - myHeading + 540) % 360) - 180) < 2.5) return;
  // 只要在移動就優先用 GPS 行進方向（不限記錄中）：
  // 手機架在車上時羅盤指的是「手機面向」而非行進方向，行進中會與實際方向不符
  const driving = lastMoveSpeed > 1.2;
  if (!driving) {
    myHeading = h;                                // 停/慢速：羅盤朝向 = 我的朝向
    updateMyHeadingArrow();
    lastHeading = h;
    if (headingUp && map.setBearing && autoFollow && !_mapTouching && !inBrowsingMode()) setTargetBearing(-h);   // 拖動/手勢/歷史檢視中不搶地圖
  }
}

// 記錄中每筆 GPS：若開啟朝車頭，讓地圖旋轉到行進方向。
// 使用者拖動地圖（autoFollow 關閉）時暫停自動旋轉，地圖可自由移動；
// 按「我的位置」恢復跟隨後旋轉才繼續（同 Google 地圖行為）。
function applyHeadingUp(lat, lng, effectiveSpeed, gpsHeading) {
  lastMoveSpeed = effectiveSpeed || 0;
  if (!headingUp || !map.setBearing) return;
  if (soloSet.length || dayPreviewKey || isReplaying()) return;   // 預覽/單趟/回放模式不旋轉
  let heading = gpsHeading;
  if (heading == null || isNaN(heading) || heading < 0) {
    if (headingRefPos && effectiveSpeed > 1) heading = bearingBetween(headingRefPos, { lat, lng });
    else heading = lastHeading;
  }
  if (effectiveSpeed > 1) { lastHeading = heading; headingRefPos = { lat, lng }; }
  if (!autoFollow || _mapTouching) return;        // 使用者正在自由瀏覽/操作手勢 → 不搶地圖
  if (effectiveSpeed > 0.8) {
    // 死區：直線行駛時 GPS 方向每秒恆抖 ±2~5°，全量餵進旋轉動畫會讓記錄中的地圖
    // 近乎連續重繪（發燙/卡頓主因之一）。與目前地圖方向差 <3° 不轉；
    // 真正轉彎遠超過 3°，瞬間通過、跟隨體感不變。
    const tgt = (((-lastHeading) % 360) + 360) % 360;
    const diff = Math.abs(((tgt - _targetBearing + 540) % 360) - 180);
    if (diff >= 3) setTargetBearing(-lastHeading);
  }
}

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
  if (action === 'today') toggleTripList();
  else if (action === 'finance') { closeSheet(); if (window.openFinance) window.openFinance(); }
  else if (action === 'bookkeeper') { closeSheet(); if (window.openBookkeeper) window.openBookkeeper(); }
  else if (action === 'history') showHistory();
  else if (action === 'sync') openSyncDialog();
  else if (action === 'glmap') toggleGlEngine();
}

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
  const fareLine = _fareLineHtml(todayTrips);
  const restMin = getRestMin(todayKey());
  const restHr = restMin ? +(restMin / 60).toFixed(2) : '';
  const work = workMs(todayTrips, restMin);
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
  // 歷史模式：換成無標示底圖（CartoDB），退出時還原
  if (soloFromHistory) {
    map.removeLayer(TILE_LAYERS[currentTile]);
    soloHistoryTile = L.tileLayer(_isDark() ? NOLABEL_DARK : NOLABEL_LIGHT,
      { subdomains: 'abcd', maxZoom: 20 }
    ).addTo(map);
    soloHistoryTile.bringToBack();
  }
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
    // 今日清單內看單趟：把其他趟淡化當背景（保留脈絡）
    allMapLayers.forEach(l => {
      if (l.setStyle) l.setStyle({ opacity: 0.12 });
      else if (l.setOpacity) l.setOpacity(0.15);
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
    const mFareLine = _fareLineHtml(mTrips);
    const mWork = mDays.reduce((s, d) => s + workMs(raw[d], getRestMin(d)), 0);
    const [yy, mm] = mk.split('-');
    const monthLabel = `${yy}年${parseInt(mm, 10)}月`;
    const monthOpen = monthIdx === 0;   // 最近月份展開，較遠月份預設收折

    const daysHtml = mDays.map(day => {
      const trips = raw[day];
      const totalDist = trips.reduce((s, t) => s + (t.totalDist || 0), 0);
      const fareLine = _fareLineHtml(trips);
      const dRestMin = getRestMin(day);
      const dRestHr = dRestMin ? +(dRestMin / 60).toFixed(2) : '';
      const dWork = workMs(trips, dRestMin);
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

function _latlngToWorldPx(lat, lng, z) {
  const s = 256 * Math.pow(2, z);
  const t = Math.sin(lat * Math.PI / 180);
  return { x: (lng + 180) / 360 * s, y: (0.5 - Math.log((1 + t) / (1 - t)) / (4 * Math.PI)) * s };
}

function _loadTile(url) {
  return new Promise(r => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => r(img); img.onerror = () => r(null); img.src = url;
  });
}

async function captureTripsScreenshot(dayKey, includeOther) {
  let trips, dateLabel;
  if (dayKey) {
    const raw = loadTrips();
    trips = raw[dayKey] || [];
    dateLabel = dayKeyToLabel(dayKey);
  } else {
    trips = todayTrips;
    dateLabel = dayKeyToLabel(todayKey());
  }
  if (!trips.length) { toast('無行程可截圖'); return; }
  // 若當天有「其他」行程，第一次先問要不要包含（不影響已存的資料，只影響這張截圖）
  const hasOther = trips.some(t => t.paymentMethod === 'other');
  if (hasOther && includeOther === undefined) {
    includeOther = confirm('截圖要包含「其他」行程嗎？\n（確定＝包含、取消＝排除）');
  }
  if (includeOther === false) trips = trips.filter(t => t.paymentMethod !== 'other');
  if (!trips.length) { toast('排除「其他」後無行程可截圖'); return; }

  const W = 390, H = 485;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2; canvas.height = H * 2;
  const c = canvas.getContext('2d');
  c.scale(2, 2);

  // 卡片背景
  c.fillStyle = '#141414';
  _rrect(c, 0, 0, W, H, 24); c.fill();

  // 左：去背 LOGO（右上角日期+時間範圍待地圖畫完後再繪）
  _drawBrand(c, 20, 28, 42);

  // 路線區（先算時間範圍，待地圖畫完後再繪右上角，避免被蓋掉）
  const firstStart = trips[0].startTime;
  const lastEnd = trips[trips.length - 1].endTime;

  // 路線區
  const rX = 16, rY = 88, rW = W - 32, rH = 310;
  const allPts = trips.flatMap(t => (t.roadCoords || t.coords || []).map(p => [p.lat, p.lng]));

  if (allPts.length > 1) {
    // 選擇最佳縮放等級（最多載入 16 tiles）
    let z = 12, sc, viewX0, viewY0;
    for (let zz = 16; zz >= 9; zz--) {
      const wps = allPts.map(([la, ln]) => _latlngToWorldPx(la, ln, zz));
      const wxs = wps.map(p => p.x), wys = wps.map(p => p.y);
      const sX = (Math.max(...wxs) - Math.min(...wxs)) || 1;
      const sY = (Math.max(...wys) - Math.min(...wys)) || 1;
      const _sc = Math.min(rW / sX, rH / sY) * 0.7;
      if ((Math.ceil(rW / _sc / 256) + 1) * (Math.ceil(rH / _sc / 256) + 1) <= 16) {
        z = zz; sc = _sc;
        const wcX = (Math.min(...wxs) + Math.max(...wxs)) / 2;
        const wcY = (Math.min(...wys) + Math.max(...wys)) / 2;
        viewX0 = wcX - rW / (2 * sc);
        viewY0 = wcY - rH / (2 * sc);
        break;
      }
    }

    // 載入 CartoDB Dark 底圖 tiles
    const TS = 256, maxT = Math.pow(2, z) - 1;
    const tx0 = Math.floor(viewX0 / TS), ty0 = Math.floor(viewY0 / TS);
    const tx1 = Math.ceil((viewX0 + rW / sc) / TS), ty1 = Math.ceil((viewY0 + rH / sc) / TS);
    const subs = ['a', 'b', 'c', 'd'], jobs = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      if (tx < 0 || ty < 0 || tx > maxT || ty > maxT) continue;
      jobs.push(_loadTile(`https://${subs[(tx + ty) % 4]}.basemaps.cartocdn.com/dark_all/${z}/${tx}/${ty}.png`).then(img => ({ img, tx, ty })));
    }
    const tiles = await Promise.all(jobs);

    // 裁剪並繪製底圖
    c.save();
    c.beginPath(); _rrect(c, rX, rY, rW, rH, 14); c.clip();
    c.fillStyle = '#1a2035'; c.fillRect(rX, rY, rW, rH);
    tiles.forEach(({ img, tx, ty }) => {
      if (!img) return;
      c.drawImage(img, rX + (tx * TS - viewX0) * sc, rY + (ty * TS - viewY0) * sc, TS * sc, TS * sc);
    });

    // 繪製路線（先畫所有線，編號之後另一輪畫在最上層）
    const wp2c = (la, ln) => { const wp = _latlngToWorldPx(la, ln, z); return [rX + (wp.x - viewX0) * sc, rY + (wp.y - viewY0) * sc]; };
    const COLS = ['#4fc3f7','#81c784','#ffb74d','#f06292','#ce93d8','#80cbc4','#a5d6a7','#fff176'];
    const starts = [];
    trips.forEach((t, i) => {
      const pts = (t.roadCoords || t.coords || []).map(p => [p.lat, p.lng]);
      if (pts.length < 2) return;
      const [sx, sy] = wp2c(pts[0][0], pts[0][1]);
      starts.push([sx, sy, i + 1]);
      c.beginPath(); c.moveTo(sx, sy);
      pts.slice(1).forEach(p => { const [px, py] = wp2c(p[0], p[1]); c.lineTo(px, py); });
      c.strokeStyle = COLS[i % COLS.length]; c.lineWidth = 2.5; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke();
    });
    // 編號標記（白底深字圓，疊在所有路線之上）
    starts.forEach(([sx, sy, num]) => {
      const r = 9;
      c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2);
      c.fillStyle = '#1a1a1a'; c.fill();
      c.lineWidth = 1.5; c.strokeStyle = '#ffffff'; c.stroke();
      c.fillStyle = '#ffffff';
      c.font = `bold ${num > 9 ? 9 : 11}px system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'alphabetic';
      const m = c.measureText(String(num));
      const textH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      c.fillText(String(num), sx, sy + m.actualBoundingBoxAscent - textH / 2);
    });
    c.restore();
  } else {
    c.fillStyle = '#1a2035'; _rrect(c, rX, rY, rW, rH, 14); c.fill();
  }

  // 右上角：日期（上）+ 工作時長（已扣休息）（下）
  const restMin = getRestMin(dayKey || todayKey());
  const spanLabel = fmtWork(workMs(trips, restMin));
  _drawRightTwoLines(c, W - 20,
    _fullDateLabel(firstStart), '13px system-ui, sans-serif', '#e8eaed', 46,
    spanLabel, '12px system-ui, sans-serif', '#9aa0a6', 66);

  // 統計
  const totalDist = trips.reduce((s, t) => s + (t.totalDist || 0), 0);
  const totalFare = trips.reduce((s, t) => s + (t.fare || 0), 0);
  const sY = rY + rH + 18;
  c.strokeStyle = '#2a2a2a'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(24, sY - 4); c.lineTo(W - 24, sY - 4); c.stroke();

  // 趟數 / 里程 / 收入
  const statCols = totalFare ? [W * 0.2, W * 0.5, W * 0.8] : [W * 0.3, W * 0.7];
  const vals = totalFare
    ? [`${trips.length} 趟`, fmtDist(totalDist), `NT$ ${totalFare.toLocaleString()}`]
    : [`${trips.length} 趟`, fmtDist(totalDist)];
  const lbls = totalFare ? ['行程', '里程', '收入'] : ['行程', '里程'];
  c.textAlign = 'center';
  statCols.forEach((x, i) => {
    c.fillStyle = '#ffffff'; c.font = 'bold 17px system-ui, sans-serif'; c.fillText(vals[i], x, sY + 23);
    c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif'; c.fillText(lbls[i], x, sY + 39);
  });
  c.fillStyle = '#3c4043'; c.font = '10px system-ui, sans-serif'; c.textAlign = 'center';
  c.fillText('Maptrip · 行程紀錄', W / 2, H - 14);

  await new Promise(resolve => {
    canvas.toBlob(blob => {
      _screenshotBlob = blob; _screenshotLabel = dateLabel;
      const url = URL.createObjectURL(blob);
      document.getElementById('screenshot-img').src = url;
      document.getElementById('screenshot-preview').style.display = 'flex';
      resolve();
    }, 'image/png');
  });
}

// 單趟截圖
async function captureSingleTripScreenshot(trip) {
  if (!trip) return;
  const d = new Date(trip.startTime);
  const weekDays = ['週日','週一','週二','週三','週四','週五','週六'];
  const dateLabel = `${d.getMonth()+1}月${d.getDate()}日${weekDays[d.getDay()]}`;
  const fileLabel = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;

  const W = 390, H = 485;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2; canvas.height = H * 2;
  const c = canvas.getContext('2d');
  c.scale(2, 2);

  c.fillStyle = '#141414';
  _rrect(c, 0, 0, W, H, 24); c.fill();

  // 左：去背 LOGO
  _drawBrand(c, 20, 28, 42);
  // 右上：一般行程 → 日期（上）+ 行程時間（下）；
  //       「其他」行程（有備注）→ 日期（上）/ 開始-結束時間（中）/ 備注（下）
  const _note = (trip.label || '').trim();
  if (trip.paymentMethod === 'other' && _note) {
    _drawRightThreeLines(c, W - 20, [
      { t: dateLabel, f: '13px system-ui, sans-serif', c: '#e8eaed', y: 38 },
      { t: `${fmtTime(trip.startTime)}-${fmtTime(trip.endTime)}`, f: '12px system-ui, sans-serif', c: '#c8ccd2', y: 56 },
      { t: _note, f: '12px system-ui, sans-serif', c: '#9aa0a6', y: 74 }
    ]);
  } else {
    _drawRightTwoLines(c, W - 20,
      _fullDateLabel(trip.startTime), '13px system-ui, sans-serif', '#e8eaed', 46,
      fmtWork(trip.endTime - trip.startTime), '12px system-ui, sans-serif', '#9aa0a6', 66);
  }

  const rX = 16, rY = 88, rW = W - 32, rH = 310;
  const pts = (trip.roadCoords || trip.coords || []).map(p => [p.lat, p.lng]);

  if (pts.length > 1) {
    let z = 12, sc, viewX0, viewY0;
    for (let zz = 16; zz >= 9; zz--) {
      const wps = pts.map(([la, ln]) => _latlngToWorldPx(la, ln, zz));
      const wxs = wps.map(p => p.x), wys = wps.map(p => p.y);
      const sX = (Math.max(...wxs) - Math.min(...wxs)) || 1;
      const sY2 = (Math.max(...wys) - Math.min(...wys)) || 1;
      const _sc = Math.min(rW / sX, rH / sY2) * 0.7;
      if ((Math.ceil(rW / _sc / 256) + 1) * (Math.ceil(rH / _sc / 256) + 1) <= 16) {
        z = zz; sc = _sc;
        const wcX = (Math.min(...wxs) + Math.max(...wxs)) / 2;
        const wcY = (Math.min(...wys) + Math.max(...wys)) / 2;
        viewX0 = wcX - rW / (2 * sc);
        viewY0 = wcY - rH / (2 * sc);
        break;
      }
    }
    const TS = 256, maxT = Math.pow(2, z) - 1;
    const tx0 = Math.floor(viewX0 / TS), ty0 = Math.floor(viewY0 / TS);
    const tx1 = Math.ceil((viewX0 + rW / sc) / TS), ty1 = Math.ceil((viewY0 + rH / sc) / TS);
    const subs = ['a','b','c','d'], jobs = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      if (tx < 0 || ty < 0 || tx > maxT || ty > maxT) continue;
      jobs.push(_loadTile(`https://${subs[(tx+ty)%4]}.basemaps.cartocdn.com/dark_all/${z}/${tx}/${ty}.png`).then(img => ({ img, tx, ty })));
    }
    const tiles = await Promise.all(jobs);

    c.save();
    c.beginPath(); _rrect(c, rX, rY, rW, rH, 14); c.clip();
    c.fillStyle = '#1a2035'; c.fillRect(rX, rY, rW, rH);
    tiles.forEach(({ img, tx, ty }) => {
      if (!img) return;
      c.drawImage(img, rX + (tx * TS - viewX0) * sc, rY + (ty * TS - viewY0) * sc, TS * sc, TS * sc);
    });

    const wp2c = (la, ln) => { const wp = _latlngToWorldPx(la, ln, z); return [rX + (wp.x - viewX0) * sc, rY + (wp.y - viewY0) * sc]; };
    c.beginPath();
    const [sx0, sy0] = wp2c(pts[0][0], pts[0][1]);
    c.moveTo(sx0, sy0);
    pts.slice(1).forEach(p => { const [px, py] = wp2c(p[0], p[1]); c.lineTo(px, py); });
    c.strokeStyle = '#4fc3f7'; c.lineWidth = 2.5; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke();
    c.beginPath(); c.arc(sx0, sy0, 5, 0, Math.PI * 2);
    c.fillStyle = '#4fc3f7'; c.fill();
    c.restore();
  } else {
    c.fillStyle = '#1a2035'; _rrect(c, rX, rY, rW, rH, 14); c.fill();
  }

  // 統計：行程時間 + 里程 + 車資(選填)；時間已移到右上角
  const hasFare = !!trip.fare;
  const sY = rY + rH + 18;
  c.strokeStyle = '#2a2a2a'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(24, sY - 4); c.lineTo(W - 24, sY - 4); c.stroke();

  const cols = hasFare ? [W*0.25, W*0.5, W*0.75] : [W*0.33, W*0.67];
  c.textAlign = 'center';

  // 行程時間
  c.fillStyle = '#ffffff'; c.font = 'bold 17px system-ui, sans-serif';
  c.fillText(fmtDur(trip.endTime - trip.startTime), cols[0], sY + 20);
  c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif';
  c.fillText('行程', cols[0], sY + 35);

  // 里程
  c.fillStyle = '#ffffff'; c.font = 'bold 17px system-ui, sans-serif';
  c.fillText(fmtDist(trip.totalDist), cols[1], sY + 20);
  c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif';
  c.fillText('里程', cols[1], sY + 35);

  // 車資（選填）
  if (hasFare) {
    c.fillStyle = '#ffffff'; c.font = 'bold 17px system-ui, sans-serif';
    c.fillText('NT$ ' + trip.fare, cols[2], sY + 20);
    c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif';
    c.fillText('車資', cols[2], sY + 35);
  }

  c.fillStyle = '#3c4043'; c.font = '10px system-ui, sans-serif'; c.textAlign = 'center';
  c.fillText('Maptrip · 行程紀錄', W / 2, H - 14);

  await new Promise(resolve => {
    canvas.toBlob(blob => {
      _screenshotBlob = blob; _screenshotLabel = fileLabel;
      const url = URL.createObjectURL(blob);
      document.getElementById('screenshot-img').src = url;
      document.getElementById('screenshot-preview').style.display = 'flex';
      resolve();
    }, 'image/png');
  });
}

function captureTodayTripShot(e, i) {
  e.stopPropagation();
  captureSingleTripScreenshot(todayTrips[i]);
}

function captureHistoryTripShot(e, dayKey, i) {
  e.stopPropagation();
  const raw = loadTrips();
  const trip = (raw[dayKey] || [])[i];
  if (trip) captureSingleTripScreenshot(trip);
}

let _screenshotBlob = null, _screenshotLabel = '';

function _shareImageFile(withTitle) {
  if (!_screenshotBlob) return;
  const file = new File([_screenshotBlob], `maptrip-${_screenshotLabel}.png`, { type: 'image/png' });
  const opts = withTitle ? { files: [file], title: `Maptrip ${_screenshotLabel}` } : { files: [file] };
  if (navigator.share) {
    navigator.share(opts).catch(() => _fallbackDownload());
  } else {
    _fallbackDownload();
  }
}

function _fallbackDownload() {
  if (!_screenshotBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(_screenshotBlob);
  a.download = `maptrip-${_screenshotLabel}.png`;
  a.click();
}

function shareScreenshot() { _shareImageFile(true); }

function saveImageToPhotos() {
  if (!_screenshotBlob) return;
  // 優先走原生 PHPhotoLibrary（iOS Capacitor）
  const plugin = window.Capacitor?.Plugins?.LiveActivity;
  if (plugin?.savePhotoBase64) {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.replace(/^data:[^;]+;base64,/, '');
      plugin.savePhotoBase64({ base64 })
        .then(() => toast('已儲存到相片庫'))
        .catch(() => _shareImageFile(false));
    };
    reader.readAsDataURL(_screenshotBlob);
  } else {
    _shareImageFile(false);
  }
}

function closeScreenshotPreview() {
  document.getElementById('screenshot-preview').style.display = 'none';
}

function _rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// 在截圖上畫去背的雙 X LOGO（半透明藍 X 偏右上 + 實心粉紅 X 偏左下）
// x,y=左上角；s=尺寸。座標取自原始 logo SVG，等比縮放置中。
function _drawLogoX(c, x, y, s) {
  // SVG icon 兩個 X 的整體邊界框：x 123..389 (266)、y 136..376 (240)
  const sc = s / 280, ox = x + (s - 266 * sc) / 2 - 123 * sc, oy = y + (s - 240 * sc) / 2 - 136 * sc;
  const P = (ix, iy) => [ox + ix * sc, oy + iy * sc];
  c.save();
  c.lineCap = 'round';
  c.lineWidth = 46 * sc;
  const line = (p1, p2) => { const a = P(...p1), b = P(...p2); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); };
  // 半透明藍 X（偏右上）
  let g = c.createLinearGradient(...P(216, 159), ...P(366, 309));
  g.addColorStop(0, '#7CD8FF'); g.addColorStop(1, '#46B0FF');
  c.strokeStyle = g; c.globalAlpha = 0.5;
  line([216, 159], [366, 309]); line([366, 159], [216, 309]);
  // 實心粉紅 X（偏左下）
  g = c.createLinearGradient(...P(146, 203), ...P(296, 353));
  g.addColorStop(0, '#FF7AC6'); g.addColorStop(1, '#FF5E62');
  c.strokeStyle = g; c.globalAlpha = 1.0;
  line([146, 203], [296, 353]); line([296, 203], [146, 353]);
  c.restore();
}

// 截圖左上角品牌組合：雙 X LOGO + 「Maptrip」
function _drawBrand(c, x, y, s) {
  _drawLogoX(c, x, y, s);
  c.save();
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillStyle = '#FF5E8A';
  c.font = 'bold 19px system-ui, sans-serif';
  c.fillText('Maptrip', x + s + 8, y + s * 0.52);
  c.restore();
}

// 右上角兩行（日期 + 時間）互相置中，整體靠右邊界 rightX 對齊
function _drawRightTwoLines(c, rightX, l1, f1, c1, y1, l2, f2, c2, y2) {
  c.save();
  c.textAlign = 'center';
  c.font = f1; const w1 = c.measureText(l1).width;
  c.font = f2; const w2 = c.measureText(l2).width;
  const cx = rightX - Math.max(w1, w2) / 2;
  c.fillStyle = c1; c.font = f1; c.fillText(l1, cx, y1);
  c.fillStyle = c2; c.font = f2; c.fillText(l2, cx, y2);
  c.restore();
}

// 右上角三行（共用相同水平中心，右對齊）
function _drawRightThreeLines(c, rightX, rows) {
  c.save();
  c.textAlign = 'center';
  let maxW = 0;
  rows.forEach(r => { c.font = r.f; maxW = Math.max(maxW, c.measureText(r.t).width); });
  const cx = rightX - maxW / 2;
  rows.forEach(r => { c.fillStyle = r.c; c.font = r.f; c.fillText(r.t, cx, r.y); });
  c.restore();
}

// 截圖用完整日期：2026年6月24日 星期三
function _fullDateLabel(ts) {
  const d = new Date(ts);
  const wd = '日一二三四五六'[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${wd}`;
}

// ===== 雲端同步 UI =====

function openSyncDialog() {
  renderSyncPanel();
  document.getElementById('sync-overlay').style.display = 'block';
  document.getElementById('sync-dialog').style.display = 'block';
}

function closeSyncDialog() {
  document.getElementById('sync-overlay').style.display = 'none';
  document.getElementById('sync-dialog').style.display = 'none';
}

function applyLoginGate(state) {
  const gate = document.getElementById('login-gate');
  if (!gate) return;
  // 只有「Firebase 已就緒且未登入」才強制擋；未設定/離線時不擋，避免 App 無法使用
  if (state === 'signedout') {
    gate.style.display = 'flex';
    const ver = document.getElementById('gate-version');
    if (ver) ver.textContent = 'v' + APP_VERSION;
    // logo 帶版本參數防快取（避免 WKWebView 用到舊的含標語版本）
    const logoImg = document.getElementById('gate-logo-img');
    if (logoImg && !logoImg.src.includes('?v=' + APP_VERSION)) logoImg.src = 'icons/logo.svg?v=' + APP_VERSION;
    const btn = document.getElementById('gate-btn');
    if (btn) {
      const busy = window.MaptripSync && MaptripSync.isBusy && MaptripSync.isBusy();
      btn.disabled = !!busy;
      btn.textContent = busy ? '登入中…' : '登入 / 註冊';
    }
  } else {
    gate.style.display = 'none';
  }
}

function submitGateLogin() {
  const email = (document.getElementById('gate-email') || {}).value || '';
  const pw = (document.getElementById('gate-pw') || {}).value || '';
  MaptripSync.signIn(email, pw);
}

let _nameAsking = false;
// 登入後若沒設定名字 → 要求輸入（取消/留空直接登出）。記帳者辨識用。
function maybeAskName(st) {
  if (!st || !st.needsName || _nameAsking) return;
  _nameAsking = true;
  setTimeout(() => {
    const name = (prompt('請輸入你的名字\n（讓記帳者辨識，例如：阿明）', '') || '').trim();
    if (!name) { MaptripSync.signOut(); toast('未輸入名字，已登出'); }
    else { MaptripSync.setName(name); toast('名字已設定：' + name); }
    _nameAsking = false;
  }, 150);
}

function renderSyncPanel() {
  if (!window.MaptripSync) return;
  const st = MaptripSync.status();
  applyLoginGate(st.state);
  maybeAskName(st);
  const statusEl = document.getElementById('sync-status');
  const actEl = document.getElementById('sync-actions');
  if (!statusEl) return;
  const busy = MaptripSync.isBusy && MaptripSync.isBusy();
  if (st.state === 'unconfigured') {
    statusEl.innerHTML = '雲端同步尚未設定完成，請稍後再試。';
    actEl.innerHTML = '';
  } else if (st.state === 'signedout') {
    // 保留已輸入的值（重繪時不清空）
    const prevEmail = (document.getElementById('sync-email') || {}).value || '';
    const prevPw = (document.getElementById('sync-pw') || {}).value || '';
    statusEl.innerHTML = '登入後行程會自動備份到雲端。<br>換手機或重裝 App，登入同一帳號即可還原。<br><span class="sync-hint">第一次輸入即自動建立帳號。</span>';
    actEl.innerHTML =
      '<input id="sync-email" class="sync-input" type="email" inputmode="email" ' +
      'autocomplete="username" placeholder="電子郵件" value="' + prevEmail + '">' +
      '<input id="sync-pw" class="sync-input" type="password" ' +
      'autocomplete="current-password" placeholder="密碼（至少 6 碼）" value="' + prevPw + '">' +
      '<button class="sync-google" ' + (busy ? 'disabled' : '') + ' onclick="submitSyncLogin()">' +
      (busy ? '登入中…' : '登入 / 註冊') + '</button>';
  } else {
    const c = st.cloud || { days: 0, trips: 0 };
    statusEl.innerHTML = '已登入　<b>' + (st.email || '') + '</b><br><span class="sync-ok">✓ 行程自動同步中</span>'
      + '<br><span class="sync-hint">雲端：' + c.days + ' 天　' + c.trips + ' 趟'
      + '　本機：' + (TripStore.bytes() / 1048576).toFixed(1) + ' MB（' + TripStore.mode() + '）</span>';
    actEl.innerHTML = '<button class="sync-out" onclick="MaptripSync.signOut()">登出</button>';
  }
}

function submitSyncLogin() {
  const email = (document.getElementById('sync-email') || {}).value || '';
  const pw = (document.getElementById('sync-pw') || {}).value || '';
  MaptripSync.signIn(email, pw);
}

// 雲端把新資料併進 localStorage 後呼叫：重繪今日 + 更新開啟中的清單
function refreshAfterSync() {
  // 記錄中／單趟檢視／預覽／回放時不動地圖圖層（下次正常載入會重畫），
  // 但仍把儲存中多出來的趟「補進」今日清單，頂列趟數與清單才會即時正確
  if (activeTrip || (typeof soloSet !== 'undefined' && soloSet.length) ||
      dayPreviewKey || replayRAF) {
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

// ===== 每日行程回放 =====
let replayDot = null, replayRAF = null;
let replayTripIdx = 0, replayProgress = 0; // replayProgress：在當前趟 coords 的浮點索引
let replayPaused = false, replaySpeed = 5;
let replayCoords = null;       // 當前趟的回放座標（優先用 roadCoords）
let replayLastTs = 0;          // 上一個動畫影格時間戳
let replayPauseTimer = null;   // 結束點停留 2 秒的計時器
let replayTripCenter = null, replayFitZoom = 14, replayCloseZoom = 16.5;
const REPLAY_CLOSE_ZOOM = 16.5; // 跟隨時的近距離縮放層級
let replaySet = [];            // 目前回放的行程陣列（今日或歷史某日）
let replayTempLayers = [];     // 回放歷史日時臨時畫上的路線，關閉時清除

// 回放進行中(面板開著):所有自動運鏡(GPS 跟隨/旋轉/5 秒歸位)都要讓路,
// 否則每秒的 GPS 更新會把鏡頭從回放點拉回目前位置,回放看起來就是壞的
function isReplaying() {
  const p = document.getElementById('replay-panel');
  return !!(p && p.classList.contains('show'));
}

// 可回放的趟：至少要有一個座標點（歷史雲端資料中有極舊格式的趟沒有座標，
// 不過濾的話 startReplay 會直接拋例外，面板卡在預設文字、回放整個死掉）
function _replayable(t) {
  const c = t && (t.roadCoords || t.coords);
  return Array.isArray(c) && c.length >= 1;
}

function openReplay() {
  const usable = todayTrips.filter(_replayable);
  if (!usable.length) { toast('今日尚無行程可回放'); return; }
  replaySet = usable;
  closeSheet();
  document.getElementById('replay-panel').classList.add('show');
  window._syncSpeedScroll?.();
  startReplay();
}

// 回放歷史任一天：載入該日行程、臨時畫出路線、開始回放
let _replayHidToday = false;
function replayDay(dayKey) {
  try {
    exitDayPreview();
    const raw = loadTrips();
    const all = raw[dayKey] || [];
    const trips = all.filter(_replayable);
    if (!trips.length) { toast('該日無行程可回放'); return; }
    if (trips.length < all.length) toast(`已略過 ${all.length - trips.length} 趟無座標的舊資料`);
    replaySet = trips;
    closeHistory(); closeSheet();
    clearReplayTempLayers();
    // 歷史回放：把「今日」的路線與標記全部隱藏（含記錄中的即時線），關閉回放時還原
    showTodayLayers(false);
    if (activePolyline) { try { activePolyline.setStyle({ opacity: 0 }); } catch (_) {} }
    _replayHidToday = true;
    trips.forEach((t, i) => {
      const cur = tripPath(t);
      if (i > 0) {
        const prev = tripPath(trips[i - 1]);
        replayTempLayers.push(drawGapLine(prev.at(-1), cur[0]));
      }
      replayTempLayers.push(
        L.polyline(cur.map(c => [c.lat, c.lng]),
          { color: '#1A73E8', weight: 5, opacity: 0.9 }).addTo(map));
    });
    document.getElementById('replay-panel').classList.add('show');
    window._syncSpeedScroll?.();
    startReplay();
  } catch (e) {
    toast('回放失敗：' + ((e && e.message) || e));
    closeReplay();
  }
}

function clearReplayTempLayers() {
  replayTempLayers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
  replayTempLayers = [];
}

function replayCoordsForTrip(trip) {
  // 優先用道路貼合座標（更平滑），無則用原始 GPS 座標
  return trip.roadCoords || trip.coords;
}

// 計算某趟的整段範圍與縮放層級（給運鏡用）
function setupReplayTrip(idx) {
  replayCoords = replayCoordsForTrip(replaySet[idx]);
  replayProgress = 0;
  const bounds = L.latLngBounds(replayCoords.map(c => [c.lat, c.lng]));
  replayTripCenter = bounds.getCenter();
  // 預留上方狀態列與下方面板空間，讓整段路線完整可見
  replayFitZoom = map.getBoundsZoom(bounds, false, L.point(60, 200));
  replayCloseZoom = Math.max(REPLAY_CLOSE_ZOOM, replayFitZoom);
}

function startReplay() {
  stopReplay();
  replayTripIdx = 0; replayPaused = false;
  setupReplayTrip(0);
  document.getElementById('replay-play-btn').textContent = '⏸';

  const first = replayCoords[0];
  replayDot = L.marker([first.lat, first.lng], {
    icon: L.divIcon({
      className: 'replay-marker-icon',
      html: '<div class="replay-dot"></div>',
      iconSize: [22, 22], iconAnchor: [11, 11]
    }),
    zIndexOffset: 2000
  }).addTo(map);

  frameReplayTrip();
  updateReplayPanel();
  startReplayRAF();
}

// 將整段路線框進畫面：每趟只設定一次相機，避免逐影格縮放造成閃爍
function frameReplayTrip(animate = false) {
  fitMapToRoute(replayCoords.map(c => [c.lat, c.lng]), 'replay-panel',
    { animate, botFallback: 160 });
}

function startReplayRAF() {
  cancelAnimationFrame(replayRAF);
  replayLastTs = 0;
  replayRAF = requestAnimationFrame(replayFrame);
}

// 每影格依經過時間前進，並內插座標 → 不論幾倍速都平滑、不晃動
function replayFrame(ts) {
  if (replayPaused) { replayLastTs = ts; replayRAF = requestAnimationFrame(replayFrame); return; }
  if (!replayLastTs) replayLastTs = ts;
  let dt = ts - replayLastTs;
  if (dt > 100) dt = 100; // App 切回前景時避免一次跳太多
  replayLastTs = ts;

  replayProgress += dt * (replaySpeed / 200); // 1x 約 5 點/秒

  const lastIdx = replayCoords.length - 1;
  if (replayProgress >= lastIdx) {
    replayProgress = lastIdx;
    renderReplayFrame();
    endOfTripTransition();
    return;
  }
  renderReplayFrame();
  replayRAF = requestAnimationFrame(replayFrame);
}

function renderReplayFrame() {
  const lastIdx = replayCoords.length - 1;
  const i = Math.min(Math.floor(replayProgress), lastIdx);
  const frac = replayProgress - i;
  const a = replayCoords[i];
  const b = replayCoords[Math.min(i + 1, lastIdx)];
  const lat = a.lat + (b.lat - a.lat) * frac;
  const lng = a.lng + (b.lng - a.lng) * frac;
  replayDot.setLatLng([lat, lng]);
  map.panTo([lat, lng], { animate: false });
}

// 一趟結束：停留 2 秒，再沿紅線快速滑到下一趟起點
function endOfTripTransition() {
  cancelAnimationFrame(replayRAF); replayRAF = null;
  const prevEnd = replayCoords[replayCoords.length - 1];
  replayTripIdx++;
  if (replayTripIdx >= replaySet.length) { finishReplay(); return; }
  setupReplayTrip(replayTripIdx);
  updateReplayPanel();
  const nextStart = replayCoords[0];
  replayPauseTimer = setTimeout(() => {
    glideGap(prevEnd, nextStart, () => {
      replayProgress = 0;
      frameReplayTrip(true);
      startReplayRAF();
    });
  }, 2000);
}

// 沿紅色 Bezier 連接線快速移動（約 0.6 秒，與回放倍率無關）
function glideGap(from, to, onDone) {
  const pts = bezierGapPoints(from, to);
  const lastIdx = pts.length - 1;
  const speed = lastIdx / 600;
  let gi = 0, last = 0;
  const step = (ts) => {
    if (replayPaused) { last = ts; replayRAF = requestAnimationFrame(step); return; }
    if (!last) last = ts;
    let dt = ts - last; if (dt > 100) dt = 100; last = ts;
    gi += dt * speed;
    if (gi >= lastIdx) {
      replayDot.setLatLng(pts[lastIdx]);
      onDone();
      return;
    }
    const idx = Math.floor(gi), frac = gi - idx;
    const a = pts[idx], b = pts[idx + 1];
    replayDot.setLatLng([a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]);
    replayRAF = requestAnimationFrame(step);
  };
  replayRAF = requestAnimationFrame(step);
}

function toggleReplayPause() {
  replayPaused = !replayPaused;
  document.getElementById('replay-play-btn').textContent = replayPaused ? '▶' : '⏸';
}

function onSpeedSlider(v) {
  replaySpeed = parseInt(v) || 1;
  document.getElementById('speed-value').textContent = `${replaySpeed}x`;
}

function initSpeedSlider() {
  const fill    = document.getElementById('speed-fill');
  const thumb   = document.getElementById('speed-thumb');
  const hitarea = document.getElementById('speed-scroll-hitarea');
  if (!hitarea) return;

  function applyRatio(ratio) {
    const v   = Math.round(1 + ratio * 19);  // 1x–20x
    const pct = (ratio * 100).toFixed(1) + '%';
    fill.style.width = pct;
    thumb.style.left = pct;
    onSpeedSlider(v);
  }

  // scroll 由 iOS 原生處理，完全可靠，不需要 touchmove
  // 向右拖 = scrollLeft 減少（iOS 捲動慣例反向）→ 用 1-ratio 讓右邊 = 快
  hitarea.addEventListener('scroll', () => {
    const max = hitarea.scrollWidth - hitarea.clientWidth;
    if (max > 0) applyRatio(1 - hitarea.scrollLeft / max);
  }, { passive: true });

  // 同步捲動位置到目前速度（在 replay panel 顯示後呼叫才能量到正確寬度）
  function syncScroll() {
    requestAnimationFrame(() => {
      const max = hitarea.scrollWidth - hitarea.clientWidth;
      if (max > 0) hitarea.scrollLeft = (1 - (replaySpeed - 1) / 19) * max;
    });
  }
  window._syncSpeedScroll = syncScroll;

  applyRatio((replaySpeed - 1) / 19);
  syncScroll();
}

function stopReplay() {
  cancelAnimationFrame(replayRAF); replayRAF = null;
  clearTimeout(replayPauseTimer); replayPauseTimer = null;
  if (replayDot) { map.removeLayer(replayDot); replayDot = null; }
}

function closeReplay() {
  stopReplay();
  clearReplayTempLayers();
  // 還原被歷史回放隱藏的今日路線/標記
  if (_replayHidToday) {
    _replayHidToday = false;
    showTodayLayers(true);
    if (activePolyline) { try { activePolyline.setStyle({ opacity: 0.9 }); } catch (_) {} }
  }
  document.getElementById('replay-panel').classList.remove('show');
  // 回放結束:5 秒後自動飛回目前位置、恢復跟隨
  if (currentPos && !soloSet.length && !dayPreviewKey) {
    _wantFollowResume = true;
    scheduleFollowResume();
  }
}

function finishReplay() {
  cancelAnimationFrame(replayRAF); replayRAF = null;
  document.getElementById('replay-play-btn').textContent = '▶';
  document.getElementById('replay-trip-label').textContent = '回放完畢';
  toast('✓ 行程回放完畢');
}

function updateReplayPanel() {
  if (replayTripIdx >= replaySet.length) return;
  const t = replaySet[replayTripIdx];
  const dateStr = new Date(t.startTime).toLocaleDateString('zh-TW',
    { month: 'long', day: 'numeric', weekday: 'short' });
  // 第一行：日期 + 第幾趟 / 共幾趟
  document.getElementById('replay-trip-label').textContent =
    `${dateStr}　第 ${replayTripIdx + 1} 趟 / 共 ${replaySet.length} 趟`;
  // 第二行：開始 → 結束時間 + 里程
  document.getElementById('replay-trip-info').textContent =
    `${fmtTime(t.startTime)} → ${fmtTime(t.endTime)}　${fmtDist(t.totalDist)}`;
}

// 每日以早上 7:00 為分界：07:00 之前算前一天
// （例：6/16 的紀錄＝6/16 早上 7:00 ～ 6/17 早上 6:59）
const DAY_SPLIT_HOUR = 7;

function businessDayKey(ts = Date.now()) {
  const d = new Date(ts - DAY_SPLIT_HOUR * 3600 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayKey() { return businessDayKey(); }

// 座標 5 位小數 ≈ 1.1m 精度：對顯示/統計無感，但 JSON 體積省一半以上
function _r5(v) { return Math.round(v * 1e5) / 1e5; }

// Douglas-Peucker 路線簡化（迭代版，tol 以「度」為單位，0.00004 ≈ 4.4m）。
// 只用在道路貼合線（畫線用），totalDist 統計早已存好，不受影響。
function _simplifyPath(pts, tol) {
  if (!pts || pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, maxI = -1;
    const ax = pts[a].lng, ay = pts[a].lat, bx = pts[b].lng, by = pts[b].lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let d;
      if (len2 === 0) {
        d = Math.hypot(pts[i].lng - ax, pts[i].lat - ay);
      } else {
        const t = ((pts[i].lng - ax) * dx + (pts[i].lat - ay) * dy) / len2;
        const cl = Math.max(0, Math.min(1, t));
        d = Math.hypot(pts[i].lng - (ax + cl * dx), pts[i].lat - (ay + cl * dy));
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol && maxI > 0) { keep[maxI] = 1; stack.push([a, maxI], [maxI, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function serializeTrip({ id, startTime, endTime, coords, totalDist, fare, roadCoords, paymentMethod, label, commission, dispatch }) {
  // 注意：t 可能不存在（壓實後的舊資料）。絕不能寫成 t: undefined —
  // Firestore 會以 invalid-argument 拒收整份文件，導致雲端備份失敗。
  const slimCoords = (coords || []).map(c =>
    (typeof c.t === 'number' && isFinite(c.t))
      ? { lat: _r5(c.lat), lng: _r5(c.lng), t: c.t }
      : { lat: _r5(c.lat), lng: _r5(c.lng) });
  let slimRoad = null;
  if (roadCoords) {
    slimRoad = _simplifyPath(roadCoords, 0.00004).map(c => ({ lat: _r5(c.lat), lng: _r5(c.lng) }));
  }
  return { id, startTime, endTime, coords: slimCoords, totalDist, fare: fare || 0, paymentMethod: paymentMethod || '',
    ...(label ? { label } : {}),
    ...(commission ? { commission } : {}),   // 抽成
    ...(dispatch ? { dispatch } : {}),        // 叫車費
    ...(slimRoad ? { roadCoords: slimRoad } : {}) };
}

// 給 sync.js 用：雲端資料「進入本機前」先瘦身。
// 沒有這層的話，雲端殘留的胖資料（壓實前的全量座標）會在同步時
// 把剛壓實的本機資料再灌肥回去（2MB → 10MB 的元兇）。
window.slimTripForStorage = function (t) {
  try {
    const slim = serializeTrip(t);
    // 假路線防線（同步層）：「繞遠假路線」（roadCoords 遠長於記錄距離）進入合併前
    // 直接剝除。否則合併評分偏好「帶 roadCoords 的版本」→ 修復後的乾淨版永遠
    // 輸給雲端殘留的假路線版 → 每次開機修復、每次同步又被蓋回 → 無限來回，
    // 而每一回合都是全量合併＋回推（資料量大後就是記憶體/CPU 風暴）
    if (slim.roadCoords && slim.totalDist > 0 &&
        calcTotalDist(slim.roadCoords) > slim.totalDist * 1.4 + 500) {
      delete slim.roadCoords;
    }
    const day = businessDayKey(slim.startTime);
    if (day !== todayKey()) {
      if (slim.roadCoords && slim.coords && slim.coords.length > 2) {
        slim.coords = [slim.coords[0], slim.coords[slim.coords.length - 1]]
          .map(c => ({ lat: c.lat, lng: c.lng }));
      } else if (slim.coords && slim.coords.length > 20) {
        slim.coords = _simplifyPath(slim.coords.map(c => ({ lat: c.lat, lng: c.lng })), 0.00004);
      }
    }
    return slim;
  } catch (_) { return t; }
};

// 合併式存檔：以趟 id 為鍵，todayTrips（目前/編輯後）優先覆蓋；
// localStorage 既有、但 todayTrips 這次沒帶到的趟「保留」，
// 這樣即使 todayTrips 一時不完整，也絕不會把本機既有的行程弄丟。
// （刪除走 removeTripFromStorage，不經過這裡的合併。）
function _deletedIdSet() {
  try { return new Set(JSON.parse(localStorage.getItem(DELETED_KEY) || '[]').map(d => d && d.id).filter(v => v != null)); }
  catch (_) { return new Set(); }
}
function saveTodayToStorage() {
  const raw = loadTrips();
  const dead = _deletedIdSet();
  const affected = new Set([todayKey()]);
  const grouped = {};
  for (const t of todayTrips) {
    const key = businessDayKey(t.startTime);
    affected.add(key);
    (grouped[key] = grouped[key] || []).push(serializeTrip(t));
  }
  affected.forEach(day => {
    const byId = new Map();
    (raw[day] || []).forEach(t => { if (t && t.id != null && !dead.has(t.id)) byId.set(t.id, t); });
    (grouped[day] || []).forEach(t => { if (t && t.id != null && !dead.has(t.id)) byId.set(t.id, t); });
    const merged = [...byId.values()].sort((a, b) => a.startTime - b.startTime);
    if (merged.length) raw[day] = merged; else delete raw[day];
  });
  try {
    saveTrips(raw);
  } catch (e) {
    // 儲存空間滿：先壓實歷史資料再重試一次，仍失敗才提示
    compactStorage(true);
    try {
      saveTrips(raw);
      toast('儲存空間已自動整理');
    } catch (e2) {
      toast('⚠ 本機儲存空間不足，行程可能無法保存！');
    }
  }
  if (window.MaptripSync) MaptripSync.syncDays([...affected]);
}

// ===== 儲存空間壓實 =====
// 歷史行程重新序列化（座標降精度＋路線簡化）；aggressive=true 時，
// 已有貼路線的行程原始 GPS 座標只留頭尾（畫圖/回放本來就優先用 roadCoords）。
// 解決「localStorage 滿 → 每次存檔靜默失敗 → 重整後行程消失」的根本問題。
function compactStorage(aggressive) {
  try {
    const raw = loadTrips();
    if (!Object.keys(raw).length) return true;
    const dropCut = businessDayKey(Date.now() - 7 * 864e5);   // 7 天前
    const tk = todayKey();
    Object.keys(raw).forEach(day => {
      raw[day] = (raw[day] || []).map(t => {
        const slim = serializeTrip(t);
        // 非今日：原始座標的每點時間戳已無用途（貼路只在存檔當下做）→ 丟棄
        if (day !== tk && slim.coords) {
          slim.coords = slim.coords.map(c => ({ lat: c.lat, lng: c.lng }));
        }
        // 7 天前（或緊急模式時非今日）且已有貼路線 → 原始座標只留頭尾
        // （畫線/回放/截圖一律優先用 roadCoords，不受影響）
        if (slim.roadCoords && slim.coords && slim.coords.length > 2 &&
            (day < dropCut || (aggressive && day !== tk))) {
          slim.coords = [slim.coords[0], slim.coords[slim.coords.length - 1]];
        } else if (!slim.roadCoords && day !== tk && slim.coords && slim.coords.length > 20) {
          // 沒有貼路線的舊行程（歷史上貼路失敗的）：座標本身做路徑簡化，
          // 形狀不變、點數大減（距離統計早已存好，不受影響）
          slim.coords = _simplifyPath(slim.coords, 0.00004);
        }
        return slim;
      });
    });
    saveTrips(raw);
    return true;
  } catch (e) { return false; }
}

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
        saveTrips(cur);
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
function storageBytes() {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      n += k.length + (localStorage.getItem(k) || '').length;
    }
  } catch (_) {}
  return n * 2;
}

// 刪除墓碑：記住已刪除的趟 id，讓合併同步不會把它加回來
const DELETED_KEY = TEST_MODE_ON ? 'maptrip_deleted_test' : 'maptrip_deleted';
function addDeletedId(id) {
  let arr;
  try { arr = JSON.parse(localStorage.getItem(DELETED_KEY) || '[]'); } catch (_) { arr = []; }
  arr = arr.filter(d => d && d.id !== id);
  arr.push({ id, at: Date.now() });
  const cutoff = Date.now() - 90 * 864e5;   // 保留 90 天的墓碑
  arr = arr.filter(d => (d.at || 0) > cutoff);
  localStorage.setItem(DELETED_KEY, JSON.stringify(arr));
}

// 明確從本機移除某趟（供刪除使用，不會被合併存檔／雲端救回）
function removeTripFromStorage(id) {
  addDeletedId(id);   // 先立墓碑，避免同步又加回來
  const raw = loadTrips();
  const affected = [];
  Object.keys(raw).forEach(day => {
    if (!Array.isArray(raw[day])) return;
    const before = raw[day].length;
    raw[day] = raw[day].filter(t => t.id !== id);
    if (raw[day].length !== before) affected.push(day);
    if (!raw[day].length) delete raw[day];
  });
  saveTrips(raw);
  // 從雲端移除該趟 + 把刪除名單推上雲端（跨裝置生效）
  if (window.MaptripSync) {
    if (MaptripSync.deleteTripFromCloud) affected.forEach(day => MaptripSync.deleteTripFromCloud(day, id));
    if (MaptripSync.pushDeleted) MaptripSync.pushDeleted();
  }
}

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

function calcTotalDist(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}

function haversine(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function fmtDist(m) { return !m ? '0 m' : m >= 1000 ? `${(m/1000).toFixed(1)} km` : `${Math.round(m)} m`; }
function _payTag(pm) {
  if (pm === 'cash') return '<span class="pay-tag pay-cash">現金</span>';
  if (pm === 'card') return '<span class="pay-tag pay-card">刷卡</span>';
  return '';
}
// 「其他」類行程的名稱標籤（如騎腳踏車）
function _otherTag(t) {
  if (t.paymentMethod === 'other') return `<span class="pay-tag pay-other">${t.label || '其他'}</span>`;
  return '';
}
// 抽成 / 叫車費標籤（記錄公司抽成用）
function _extraTag(t) {
  let s = '';
  if (t.commission) s += `　<span class="extra-tag">抽成 ${t.commission}</span>`;
  if (t.dispatch)   s += `　<span class="extra-tag">叫車 ${t.dispatch}</span>`;
  return s;
}
// 統計一組行程的刷卡 / 現金 / 總計金額
function _fareStats(trips) {
  let card = 0, cash = 0, total = 0;
  trips.forEach(t => {
    const f = t.fare || 0; total += f;
    if (t.paymentMethod === 'card') card += f;
    else if (t.paymentMethod === 'cash') cash += f;
  });
  return { card, cash, total };
}
// 產生「刷卡：X　現金：Y　總計：Z」一行；無金額回傳空字串
function _fareLineHtml(trips) {
  const { card, cash, total } = _fareStats(trips);
  if (!total) return '';
  return `<span class="fl-card">刷卡：${card.toLocaleString()}</span>` +
         `<span class="fl-cash">現金：${cash.toLocaleString()}</span>` +
         `<span class="fl-total">總計：${total.toLocaleString()}</span>`;
}
function fmtDur(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
  if (h > 0) return `${h}h ${m%60}m`;
  return `${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}
// 工作時長中文：X小時Y分
function fmtWork(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}小時${m}分` : `${m}分`;
}

// 每日休息時間（分鐘）儲存，key = dayKey
const REST_KEY = TEST_MODE_ON ? 'maptrip_rest_test' : 'maptrip_rest';
function getRestMin(dayKey) {
  try { return JSON.parse(localStorage.getItem(REST_KEY) || '{}')[dayKey] || 0; }
  catch (_) { return 0; }
}
function setRestMin(dayKey, min) {
  let r = {};
  try { r = JSON.parse(localStorage.getItem(REST_KEY) || '{}'); } catch (_) {}
  if (min > 0) r[dayKey] = min; else delete r[dayKey];
  localStorage.setItem(REST_KEY, JSON.stringify(r));
}
// 一組行程的「實際工作時長」= (最後結束 - 第一筆開始) - 休息
function workMs(trips, restMin) {
  if (!trips || !trips.length) return 0;
  const span = trips[trips.length - 1].endTime - trips[0].startTime;
  return Math.max(0, span - (restMin || 0) * 60000);
}
function fmtTime(ts) { return new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }); }

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
  box.onclick = () => box.remove();
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
