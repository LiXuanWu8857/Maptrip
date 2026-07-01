const APP_VERSION  = '1.1.166';
const TEST_MODE_ON = new URLSearchParams(location.search).has('test');
const STORAGE_KEY = TEST_MODE_ON ? 'maptrip_test_v1' : 'maptrip_v1';
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
let soloLayers = [];
let soloSet = [], soloIdx = 0, soloLabelFn = null;  // 單趟顯示：可左右切換的趟次集合
let soloFromHistory = false;  // 從歷史紀錄進入 solo 模式時為 true
let soloHistoryTile = null;   // 歷史 solo 時換用的無標示底圖
let wasMoving = false, stoppedTimer = null, arrivalBannerShown = false;
let autoFollow = false, wakeLock = null;
let activeSnapPending = false;
let autoStartTimer = null, autoStartShown = false, lastKnownPos = null;
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

const TILE_LAYERS = {
  road: L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 20 }),
  satellite: L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 20 })
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
  map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0,
                       preferCanvas: true })
         .setView([25.033, 121.565], 15);
  TILE_LAYERS.road.addTo(map);

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

  // 使用者手動拖地圖時，暫停自動跟隨
  map.on('dragstart', () => {
    if (autoFollow) setAutoFollow(false);
  });

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

  loadTodayFromStorage();
  startGpsWatch();
  updateTopBar();
  setInterval(updateTopBar, 30000);
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

  if (!myDotMarker) {
    const icon = L.divIcon({
      className: '',
      html: '<div style="width:16px;height:16px;border-radius:50%;background:#4285F4;border:2.5px solid #fff;box-shadow:0 0 6px rgba(66,133,244,0.6)"></div>',
      iconSize: [16, 16], iconAnchor: [8, 8]
    });
    myDotMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
    accuracyCircle = L.circle([lat, lng], {
      radius: acc, color: '#4285F4', fillColor: '#4285F4',
      fillOpacity: 0.06, weight: 1, opacity: 0.25
    }).addTo(map);
    map.setView([lat, lng], 16);
  } else {
    myDotMarker.setLatLng([lat, lng]);
    accuracyCircle.setLatLng([lat, lng]).setRadius(acc);
  }

  if (autoFollow) map.panTo([lat, lng], { animate: true, duration: 0.5 });

  if (activeTrip) {
    // 每次 GPS 更新都延伸折線（畫面即時跟隨軌跡）
    activePolyline.addLatLng([lat, lng]);

    // 每 GPS_RECORD_MS 才存一個座標點（節省儲存空間）
    const last = activeTrip.coords.at(-1);
    if (!last || Date.now() - last.t >= GPS_RECORD_MS) {
      activeTrip.coords.push({ lat, lng, t: Date.now() });
      // 定期把累積軌跡貼合到道路上（即時更新折線）
      const n = activeTrip.coords.length;
      if (n >= 4 && n % LIVE_SNAP_PTS === 0 && !activeSnapPending) {
        activeSnapPending = true;
        snapLiveRoute();
      }
    }
    checkArrival(effectiveSpeed);
  } else {
    checkAutoStart(effectiveSpeed);
  }
}

function checkArrival(speed) {
  if (speed == null || isNaN(speed) || speed < 0) return;
  if (speed > MOVING_SPEED_MS) {
    wasMoving = true;
    arrivalBannerShown = false;
    clearTimeout(stoppedTimer);
    stoppedTimer = null;
    hideArrivalBanner();
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
    const distance = Math.round(calcTotalDist(activeTrip.coords));
    liveAct()?.updateTrip({ elapsed, distance });
    floatWin()?.update({ elapsed, distance }).catch(() => {});
  } else {
    liveAct()?.heartbeat?.();
  }
}

function setAutoFollow(on) {
  autoFollow = on;
  const btn = document.getElementById('locate-btn');
  if (btn) btn.classList.toggle('follow-active', on);
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

  if (fromFloat) {
    // 由浮窗結束：記住這趟，叫出浮窗數字鍵盤輸入車資（見 saveFloatFare）
    pendingFareTrip = trip;
    floatWin()?.promptFare().catch(() => {});
  } else {
    floatWin()?.showIdle().catch(() => {});
    showFareDialog(trip);
  }
}

// 浮窗數字鍵盤按「確定/略過」後：把車資存到剛結束的那趟，並貼合路線存檔
async function saveFloatFare(fare, paymentMethod) {
  const trip = pendingFareTrip;
  pendingFareTrip = null;
  if (!trip) return;
  trip.fare = fare;
  trip.paymentMethod = paymentMethod || '';
  trip.roadCoords = await snapToRoads(trip.coords);
  saveTripFinal(trip);
}

// 背景結束：直接貼合道路並存檔（金額 0），不需 UI
async function saveTripBackground(trip) {
  trip.roadCoords = await snapToRoads(trip.coords);
  saveTripFinal(trip);
  toast('✓ 行程已結束，金額可稍後在清單補填');
}

function showFareDialog(trip) {
  document.getElementById('fs-start').textContent  = fmtTime(trip.startTime);
  document.getElementById('fs-end').textContent    = fmtTime(trip.endTime);
  document.getElementById('fs-dur').textContent    = fmtDur(trip.endTime - trip.startTime);
  document.getElementById('fs-dist').textContent   = fmtDist(trip.totalDist);
  document.getElementById('fare-input').value = '';

  document.getElementById('fare-overlay').style.display = 'block';
  document.getElementById('fare-dialog').classList.add('show');
  setTimeout(() => document.getElementById('fare-input').focus(), 300);

  const cashBtn = document.getElementById('fare-cash');
  const cardBtn = document.getElementById('fare-card');
  const skipBtn = document.getElementById('fare-skip');

  const save = async (fare, paymentMethod, label) => {
    trip.fare = fare;
    trip.paymentMethod = paymentMethod;
    trip.label = label || '';
    cashBtn.textContent = '路線貼合中…'; cashBtn.disabled = true;
    cardBtn.disabled = true; skipBtn.disabled = true;

    trip.roadCoords = await snapToRoads(trip.coords);

    document.getElementById('fare-overlay').style.display = 'none';
    document.getElementById('fare-dialog').classList.remove('show');
    cashBtn.textContent = '現金'; cashBtn.disabled = false;
    cardBtn.disabled = false; skipBtn.disabled = false;
    saveTripFinal(trip);
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
    const prev = todayTrips[todayTrips.length - 1];
    const prevCoords = prev.roadCoords || prev.coords;
    const curCoords  = trip.roadCoords || trip.coords;
    const gap = drawGapLine(prevCoords.at(-1), curCoords[0]);
    allMapLayers.push(gap);
  }
  drawTripLine(trip, todayTrips.length + 1);
  todayTrips.push(trip);
  saveTodayToStorage(); updateTopBar();
  const fareStr = trip.fare ? `　NT$ ${trip.fare}` : '';
  const roadTag = trip.roadCoords ? '' : '（直線）';
  toast(`✓ 第 ${todayTrips.length} 趟　${fmtDur(trip.endTime - trip.startTime)}　${fmtDist(trip.totalDist)}${fareStr}${roadTag}`);
}

// OSRM Map Matching：將 GPS 座標貼合到道路上
async function snapToRoads(coords) {
  if (coords.length < 2) return null;

  // OSRM 公開服務最多 100 點，超過則均勻取樣
  const MAX_PTS = 100;
  let pts = coords;
  if (pts.length > MAX_PTS) {
    const step = Math.floor(pts.length / (MAX_PTS - 1));
    pts = coords.filter((_, i) => i % step === 0);
    if (pts[pts.length - 1] !== coords[coords.length - 1])
      pts.push(coords[coords.length - 1]);
  }

  const coordStr = pts.map(c => `${c.lng},${c.lat}`).join(';');
  const radii    = pts.map(() => '30').join(';');
  const ts       = pts.map(c => Math.floor(c.t / 1000)).join(';');
  const url = `https://router.project-osrm.org/match/v1/driving/${coordStr}` +
    `?radiuses=${radii}&timestamps=${ts}&geometries=geojson&overview=full&annotations=false`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code === 'Ok' && data.matchings?.length) {
      return data.matchings.flatMap(m =>
        m.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
      );
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
  // 重建折線：貼合段 + 貼合後新增的原始 GPS 尾段
  const latlngs = snapped.map(c => [c.lat, c.lng]);
  activeTrip.coords.slice(snapshot.length).forEach(c => latlngs.push([c.lat, c.lng]));
  activePolyline.setLatLngs(latlngs);
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
  return L.polyline(bezierGapPoints(from, to),
    { color: '#EA4335', weight: 2.5, opacity: 0.75, dashArray: '6 5' }).addTo(map);
}

function drawTripLine(trip, idx) {
  // 優先用道路貼合座標，否則退回 GPS 直線
  const latlngs = (trip.roadCoords || trip.coords).map(c => [c.lat, c.lng]);
  const line = L.polyline(latlngs, { color: '#1A73E8', weight: 5, opacity: 0.85 }).addTo(map);
  line.on('click', () =>
    toast(`行程 ${idx}｜${fmtTime(trip.startTime)} → ${fmtTime(trip.endTime)}｜${fmtDur(trip.endTime - trip.startTime)}｜${fmtDist(trip.totalDist)}`));
  const startMk = L.marker(latlngs[0], { icon: makeNumberIcon(idx, '#34A853'), zIndexOffset: 10 }).addTo(map);
  const endMk   = L.marker(latlngs.at(-1), { icon: makeEndIcon() }).addTo(map);
  allMapLayers.push(line, startMk, endMk);
  trip._layers = [line, startMk, endMk];
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
  map.setView([currentPos.lat, currentPos.lng], 16);
}

function updateTopBar() {
  // 顯示「營業日」日期（07:00 之前仍算前一天）
  const d = new Date(Date.now() - DAY_SPLIT_HOUR * 3600 * 1000);
  document.getElementById('top-date').textContent =
    d.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' });
  document.getElementById('trip-count').textContent = todayTrips.length;
}

function refreshRecBanner() {
  if (!activeTrip) return;
  const elapsed = Date.now() - activeTrip.startTime;
  const dist    = calcTotalDist(activeTrip.coords);
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
  else if (action === 'history') showHistory();
  else if (action === 'sync') openSyncDialog();
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
          ${t.fare ? `　<span class="trip-fare-tag">NT$ ${t.fare}</span>${_payTag(t.paymentMethod)}` : _otherTag(t)}
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
  cashBtn.disabled = false; cardBtn.disabled = false;
  skipBtn.textContent = '取消'; skipBtn.disabled = false;

  document.getElementById('fare-overlay').style.display = 'block';
  document.getElementById('fare-dialog').classList.add('show');
  setTimeout(() => input.focus(), 300);

  const close = () => {
    document.getElementById('fare-overlay').style.display = 'none';
    document.getElementById('fare-dialog').classList.remove('show');
    document.getElementById('fare-header').textContent = '行程完成';
    skipBtn.textContent = '其他';
  };

  const saveEdit = (paymentMethod) => {
    trip.fare = parseInt(input.value) || 0;
    trip.paymentMethod = paymentMethod;
    close();
    saveTodayToStorage();
    renderTripSheet();
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
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
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

  // 淡化今日所有路線 layer（只在今日清單情境下有 allMapLayers）
  allMapLayers.forEach(l => {
    if (l.setStyle) l.setStyle({ opacity: 0.12 });
    else if (l.setOpacity) l.setOpacity(0.15);
  });

  // 畫選中行程的路線（歷史模式：黑色 Uber 風格；今日模式：藍色）
  const coords = (trip.roadCoords || trip.coords).map(c => [c.lat, c.lng]);
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
    (soloFromHistory ? `<div class="solo-hint">按兩下離開歷史模式</div>` : '');

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
  allMapLayers.forEach(l => {
    if (l.setStyle) l.setStyle({ opacity: 0.85 });
    else if (l.setOpacity) l.setOpacity(1);
  });
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
  saveTodayToStorage(); updateTopBar(); renderTripSheet();
  toast(`已刪除第 ${idx + 1} 趟`);
}

function confirmClearDay() {
  if (!todayTrips.length) { toast('今日無行程可清除'); return; }
  if (!confirm(`確定清除今日全部 ${todayTrips.length} 趟行程？`)) return;
  exitSoloMode();
  allMapLayers.forEach(l => map.removeLayer(l));
  allMapLayers = []; todayTrips = [];
  saveTodayToStorage(); updateTopBar(); closeSheet();
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
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
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
            <div class="trip-stats">${fmtDist(t.totalDist)}${t.fare ? `　<span class="trip-fare-tag">NT$ ${t.fare}</span>${_payTag(t.paymentMethod)}` : _otherTag(t)}</div>
          </div>
          <span class="trip-shot" onclick="captureHistoryTripShot(event,'${day}',${i})">📷</span>
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
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
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
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const trips = raw[dayKey] || [];
  if (!trips.length) { toast('該日無行程'); return; }
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
    const latlngs = (t.roadCoords || t.coords).map(c => [c.lat, c.lng]);
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

  // 隱藏當日行程圖層
  allMapLayers.forEach(l => {
    if (l.setStyle) l.setStyle({ opacity: 0, fillOpacity: 0 });
    else if (l.setOpacity) l.setOpacity(0);
  });

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
  allMapLayers.forEach(l => {
    if (l.setStyle) l.setStyle({ opacity: 0.85 });
    else if (l.setOpacity) l.setOpacity(1);
  });
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

async function captureTripsScreenshot(dayKey) {
  let trips, dateLabel;
  if (dayKey) {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    trips = raw[dayKey] || [];
    dateLabel = dayKeyToLabel(dayKey);
  } else {
    trips = todayTrips;
    dateLabel = dayKeyToLabel(todayKey());
  }
  if (!trips.length) { toast('無行程可截圖'); return; }

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
    '工作 ' + spanLabel, '12px system-ui, sans-serif', '#9aa0a6', 66);

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
  // 右上：日期（上）+ 工作時間（下），兩行互相置中
  _drawRightTwoLines(c, W - 20,
    _fullDateLabel(trip.startTime), '13px system-ui, sans-serif', '#e8eaed', 46,
    '工作 ' + fmtWork(trip.endTime - trip.startTime), '12px system-ui, sans-serif', '#9aa0a6', 66);

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
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
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

function renderSyncPanel() {
  if (!window.MaptripSync) return;
  const st = MaptripSync.status();
  applyLoginGate(st.state);
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
    statusEl.innerHTML = '已登入　<b>' + (st.email || '') + '</b><br><span class="sync-ok">✓ 行程自動同步中</span>';
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
  // 記錄中／單趟檢視／預覽／回放時，先不動畫面（資料已存好，下次正常載入會顯示）
  if (activeTrip || (typeof soloSet !== 'undefined' && soloSet.length) ||
      dayPreviewKey || replayRAF) { updateTopBar(); return; }
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

function openReplay() {
  if (!todayTrips.length) { toast('今日尚無行程可回放'); return; }
  replaySet = todayTrips;
  closeSheet();
  document.getElementById('replay-panel').classList.add('show');
  window._syncSpeedScroll?.();
  startReplay();
}

// 回放歷史任一天：載入該日行程、臨時畫出路線、開始回放
function replayDay(dayKey) {
  exitDayPreview();
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const trips = raw[dayKey] || [];
  if (!trips.length) { toast('該日無行程可回放'); return; }
  replaySet = trips;
  closeHistory(); closeSheet();
  clearReplayTempLayers();
  trips.forEach((t, i) => {
    const cur = t.roadCoords || t.coords;
    if (i > 0) {
      const prev = (trips[i - 1].roadCoords || trips[i - 1].coords);
      replayTempLayers.push(drawGapLine(prev.at(-1), cur[0]));
    }
    replayTempLayers.push(
      L.polyline(cur.map(c => [c.lat, c.lng]),
        { color: '#1A73E8', weight: 5, opacity: 0.9 }).addTo(map));
  });
  document.getElementById('replay-panel').classList.add('show');
  window._syncSpeedScroll?.();
  startReplay();
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
  document.getElementById('replay-panel').classList.remove('show');
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

function serializeTrip({ id, startTime, endTime, coords, totalDist, fare, roadCoords, paymentMethod, label }) {
  return { id, startTime, endTime, coords, totalDist, fare: fare || 0, paymentMethod: paymentMethod || '', ...(label ? { label } : {}), ...(roadCoords ? { roadCoords } : {}) };
}

function saveTodayToStorage() {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const affected = new Set([todayKey()]);
  // 先移除今天這一格的舊資料，刪除／清空才會真的寫回（否則 Object.assign 不會覆蓋空陣列）
  delete raw[todayKey()];
  // 依每趟「開始時間」的營業日歸檔，跨 7:00 也不會把昨天的行程蓋掉
  const grouped = {};
  for (const t of todayTrips) {
    const key = businessDayKey(t.startTime);
    affected.add(key);
    (grouped[key] = grouped[key] || []).push(serializeTrip(t));
  }
  Object.assign(raw, grouped);
  // 清掉任何空陣列的日期，歷史清單才不會出現空白日
  Object.keys(raw).forEach(k => { if (!raw[k] || !raw[k].length) delete raw[k]; });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
  // 推送變動的日期到雲端（未登入／未設定時 no-op）
  if (window.MaptripSync) MaptripSync.syncDays([...affected]);
}

function loadTodayFromStorage() {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const saved = raw[todayKey()] || [];
  if (!saved.length) return;
  saved.forEach((t, i) => {
    if (i > 0) {
      const prev = todayTrips[todayTrips.length - 1];
      const prevCoords = prev.roadCoords || prev.coords;
      const curCoords  = t.roadCoords || t.coords;
      const gap = drawGapLine(prevCoords.at(-1), curCoords[0]);
      allMapLayers.push(gap);
    }
    todayTrips.push({ ...t });
    drawTripLine(t, i + 1);
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
const REST_KEY = 'maptrip_rest';
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
// 點版本號 5 下 → 切換診斷模式（不需重 build / 改網址即可重新開啟診斷框）
let _verTapCount = 0, _verTapTimer = null;
function onVersionTap() {
  _verTapCount++;
  clearTimeout(_verTapTimer);
  _verTapTimer = setTimeout(() => { _verTapCount = 0; }, 1500);
  if (_verTapCount < 5) return;
  _verTapCount = 0;
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

function boot() {
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
  initMap();
  setTimeout(checkForUpdate, 2000);
  // 版本號顯示在「行程清單」底部；診斷模式開啟時標記
  const vl = document.getElementById('version-label');
  if (vl) vl.textContent = 'v' + APP_VERSION + (dbgEnabled() ? ' · 診斷中' : '');

  // 診斷模式開著時（含重新整理後），自動顯示可拖曳量測面板
  if (dbgEnabled()) setTimeout(probeLayout, 300);

  initSpeedSlider();

  // 雲端同步：載入登入狀態並開始監聽（未設定 Firebase 時安靜略過）
  if (window.MaptripSync) { try { MaptripSync.init(); } catch (e) {} }
}

// app.js 由 index.html 的 loader 動態載入，可能在 window load 之後才進來，
// 那時 'load' 事件已過、不會再觸發，因此要依 readyState 判斷是否立即啟動。
if (document.readyState === 'complete') {
  boot();
} else {
  window.addEventListener('load', boot);
}
