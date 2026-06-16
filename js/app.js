const APP_VERSION  = '1.1.31';
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
let wasMoving = false, stoppedTimer = null, arrivalBannerShown = false;
let autoFollow = false, wakeLock = null;
let activeSnapPending = false;
let autoStartTimer = null, autoStartShown = false, lastKnownPos = null;

const TEST_MODE = TEST_MODE_ON;
let simTick = 0, simTimer = null;
let nativeWatcherId = null;

// 是否跑在 Capacitor 原生殼裡（iOS App）
function isNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

const TILE_LAYERS = {
  road: L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 20 }),
  satellite: L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 20 })
};
let currentTile = 'road';

// Live Activity 插件的安全存取 helper
function liveAct() {
  return isNative() ? window.Capacitor?.Plugins?.LiveActivity : null;
}

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0 })
         .setView([25.033, 121.565], 15);
  TILE_LAYERS.road.addTo(map);

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

  // Live Activity（鎖屏方塊）整合
  if (isNative()) {
    // 後援：舊版 Link 按鈕會開 App 再觸發
    window.Capacitor?.Plugins?.App?.addListener('appUrlOpen', data => {
      if (data?.url === 'maptrip://start' && !activeTrip) startTrip();
      if (data?.url === 'maptrip://end'   && activeTrip)  endTrip(true);
    });
    const la = liveAct();
    if (la) {
      // App Intent 按鈕：在背景直接收到指令，不跳轉到 App
      la.addListener?.('liveActivityCommand', ({ action }) => {
        if (action === 'start' && !activeTrip) startTrip();
        if (action === 'end'   && activeTrip)  endTrip(true);
      });
      // 顯示閒置狀態的方塊（鎖屏「開始行程」按鈕）
      la.initActivity();
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

function setAutoFollow(on) {
  autoFollow = on;
  const btn = document.getElementById('locate-btn');
  if (btn) btn.classList.toggle('follow-active', on);
}

async function beginRecording() {
  restartSimulation();
  wasMoving = false;
  arrivalBannerShown = false;
  activeSnapPending = false;
  setAutoFollow(true);
  activeTrip = { id: Date.now(), startTime: Date.now(), coords: [{ ...currentPos, t: Date.now() }] };
  activePolyline = L.polyline([[currentPos.lat, currentPos.lng]],
    { color: '#1A73E8', weight: 5, opacity: 0.9 }).addTo(map);
  document.getElementById('start-btn').disabled = true;
  document.getElementById('rec-banner').style.display = 'flex';
  timerTick = setInterval(refreshRecBanner, 1000);
  map.panTo([currentPos.lat, currentPos.lng]);
  toast('行程開始！');
  liveAct()?.startTrip();

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

// silent=true：從鎖屏 Live Activity 結束，不跳金額對話框（金額之後可在清單補填）
function endTrip(silent = false) {
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
  document.getElementById('start-btn').disabled = false;
  document.getElementById('rec-banner').style.display = 'none';

  // 釋放螢幕常亮鎖
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }

  if (silent) { saveTripBackground(trip); }
  else        { showFareDialog(trip); }
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

  const save = async (fare) => {
    trip.fare = fare;
    const saveBtn = document.getElementById('fare-save');
    const skipBtn = document.getElementById('fare-skip');
    saveBtn.textContent = '路線貼合中…'; saveBtn.disabled = true; skipBtn.disabled = true;

    trip.roadCoords = await snapToRoads(trip.coords);

    document.getElementById('fare-overlay').style.display = 'none';
    document.getElementById('fare-dialog').classList.remove('show');
    saveBtn.textContent = '儲存行程'; saveBtn.disabled = false; skipBtn.disabled = false;
    saveTripFinal(trip);
  };

  document.getElementById('fare-save').onclick = () =>
    save(parseInt(document.getElementById('fare-input').value) || 0);
  document.getElementById('fare-skip').onclick = () => save(0);
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
  const startMk = L.marker(latlngs[0], { icon: makeNumberIcon(idx, '#34A853') }).addTo(map);
  const endMk   = L.marker(latlngs.at(-1), { icon: makeDotIcon('#EA4335') }).addTo(map);
  allMapLayers.push(line, startMk, endMk);
  trip._layers = [line, startMk, endMk];
}

function makeNumberIcon(n, color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:24px;height:24px;border-radius:50%;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;">${n}</div>`,
    iconSize: [24, 24], iconAnchor: [12, 12]
  });
}

function makeDotIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;"></div>`,
    iconSize: [14, 14], iconAnchor: [7, 7]
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

function renderTripSheet() {
  const body = document.getElementById('sheet-body');
  if (!todayTrips.length) {
    body.innerHTML = '<div class="empty-state">今日尚無行程紀錄<br>按「開始行程」開始追蹤</div>'; return;
  }
  const totalFare = todayTrips.reduce((s, t) => s + (t.fare || 0), 0);
  const totalDist = todayTrips.reduce((s, t) => s + (t.totalDist || 0), 0);
  const summary = `<div class="day-summary">
    <span>${todayTrips.length} 趟</span>
    <span>${fmtDist(totalDist)}</span>
    ${totalFare ? `<span class="day-fare">NT$ ${totalFare.toLocaleString()}</span>` : ''}
  </div>`;
  body.innerHTML = summary + todayTrips.map((t, i) => `
    <div class="trip-row" onclick="focusTrip(${i}); closeSheet()">
      <div class="trip-num">${i + 1}</div>
      <div class="trip-meta">
        <div class="trip-time">${fmtTime(t.startTime)} → ${fmtTime(t.endTime)}　<span class="trip-dur">${fmtDur(t.endTime - t.startTime)}</span></div>
        <div class="trip-stats">
          ${fmtDist(t.totalDist)}
          ${t.fare ? `　<span class="trip-fare-tag">NT$ ${t.fare}</span>` : ''}
          <button class="fare-edit-btn" onclick="editFare(event,${i})">${t.fare ? '✏' : '＋金額'}</button>
        </div>
      </div>
      <span class="trip-del" onclick="deleteTodayTrip(event,${i})">🗑</span>
    </div>`).join('');
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
  const saveBtn = document.getElementById('fare-save');
  const skipBtn = document.getElementById('fare-skip');
  input.value = trip.fare || '';
  saveBtn.textContent = '儲存'; saveBtn.disabled = false;
  skipBtn.textContent = '取消'; skipBtn.disabled = false;

  document.getElementById('fare-overlay').style.display = 'block';
  document.getElementById('fare-dialog').classList.add('show');
  setTimeout(() => input.focus(), 300);

  const close = () => {
    document.getElementById('fare-overlay').style.display = 'none';
    document.getElementById('fare-dialog').classList.remove('show');
    document.getElementById('fare-header').textContent = '行程完成';
    saveBtn.textContent = '儲存行程';
    skipBtn.textContent = '略過';
  };

  saveBtn.onclick = () => {
    trip.fare = parseInt(input.value) || 0;
    close();
    saveTodayToStorage();
    renderTripSheet();
  };
  skipBtn.onclick = close;
}

function focusTrip(idx) {
  const trip = todayTrips[idx];
  if (!trip?.coords?.length) return;
  const bounds = L.latLngBounds(trip.coords.map(c => [c.lat, c.lng]));
  map.fitBounds(bounds, { paddingTopLeft: [16, 60], paddingBottomRight: [16, 90] });
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
  allMapLayers.forEach(l => map.removeLayer(l));
  allMapLayers = []; todayTrips = [];
  saveTodayToStorage(); updateTopBar(); closeSheet();
  toast('今日行程已清除');
}

function showHistory() { renderHistorySheet(); document.getElementById('history-sheet').style.display = 'flex'; }
function closeHistory() { document.getElementById('history-sheet').style.display = 'none'; }

function renderHistorySheet() {
  const body = document.getElementById('history-body');
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const days = Object.keys(raw).sort().reverse().filter(d => raw[d]?.length > 0);
  if (!days.length) { body.innerHTML = '<div class="empty-state">尚無歷史紀錄</div>'; return; }
  body.innerHTML = days.map(day => {
    const trips = raw[day];
    const totalDist = trips.reduce((s, t) => s + (t.totalDist || 0), 0);
    const totalFare = trips.reduce((s, t) => s + (t.fare || 0), 0);
    const fareStr = totalFare ? `　NT$ ${totalFare.toLocaleString()}` : '';
    const rows = trips.map((t, i) => `
      <div class="trip-row">
        <div class="trip-num">${i + 1}</div>
        <div class="trip-meta">
          <div class="trip-time">${fmtTime(t.startTime)} → ${fmtTime(t.endTime)}　<span class="trip-dur">${fmtDur(t.endTime - t.startTime)}</span></div>
          <div class="trip-stats">${fmtDist(t.totalDist)}${t.fare ? `　<span class="trip-fare-tag">NT$ ${t.fare}</span>` : ''}</div>
        </div>
      </div>`).join('');
    return `<div class="history-day">
        <span>${day}　${trips.length} 趟　${fmtDist(totalDist)}${fareStr}</span>
        <button class="replay-btn" onclick="replayDay('${day}')">▶ 回放</button>
      </div>${rows}`;
  }).join('');
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
  startReplay();
}

// 回放歷史任一天：載入該日行程、臨時畫出路線、開始回放
function replayDay(dayKey) {
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
function frameReplayTrip() {
  const bounds = L.latLngBounds(replayCoords.map(c => [c.lat, c.lng]));
  map.fitBounds(bounds, { animate: false, paddingTopLeft: [30, 70], paddingBottomRight: [30, 220] });
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

// 只移動小點，相機固定（每趟框一次）→ 完全不閃爍
function renderReplayFrame() {
  const lastIdx = replayCoords.length - 1;
  const i = Math.min(Math.floor(replayProgress), lastIdx);
  const frac = replayProgress - i;
  const a = replayCoords[i];
  const b = replayCoords[Math.min(i + 1, lastIdx)];
  const lat = a.lat + (b.lat - a.lat) * frac;
  const lng = a.lng + (b.lng - a.lng) * frac;
  replayDot.setLatLng([lat, lng]);
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
  // 把「前一趟終點 → 下一趟起點」框進畫面，glide 期間相機不動 → 不閃
  map.fitBounds(L.latLngBounds([[prevEnd.lat, prevEnd.lng], [nextStart.lat, nextStart.lng]]),
    { animate: false, paddingTopLeft: [40, 80], paddingBottomRight: [40, 220] });
  replayPauseTimer = setTimeout(() => {
    glideGap(prevEnd, nextStart, () => {
      replayProgress = 0;
      frameReplayTrip();
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
  // rAF 迴圈會即時讀取 replaySpeed，不需重新排程
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
  document.getElementById('replay-trip-label').textContent =
    `第 ${replayTripIdx + 1} 趟 / 共 ${replaySet.length} 趟`;
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

function serializeTrip({ id, startTime, endTime, coords, totalDist, fare, roadCoords }) {
  return { id, startTime, endTime, coords, totalDist, fare: fare || 0, ...(roadCoords ? { roadCoords } : {}) };
}

function saveTodayToStorage() {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  // 先移除今天這一格的舊資料，刪除／清空才會真的寫回（否則 Object.assign 不會覆蓋空陣列）
  delete raw[todayKey()];
  // 依每趟「開始時間」的營業日歸檔，跨 7:00 也不會把昨天的行程蓋掉
  const grouped = {};
  for (const t of todayTrips) {
    const key = businessDayKey(t.startTime);
    (grouped[key] = grouped[key] || []).push(serializeTrip(t));
  }
  Object.assign(raw, grouped);
  // 清掉任何空陣列的日期，歷史清單才不會出現空白日
  Object.keys(raw).forEach(k => { if (!raw[k] || !raw[k].length) delete raw[k]; });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
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
  const allCoords = saved.flatMap(t => t.coords.map(c => [c.lat, c.lng]));
  if (allCoords.length) {
    map.fitBounds(L.latLngBounds(allCoords), { paddingTopLeft: [16, 60], paddingBottomRight: [16, 90] });
  }
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
function fmtDur(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
  if (h > 0) return `${h}h ${m%60}m`;
  return `${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
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

window.addEventListener('load', () => {
  // Service Worker：攔截導覽請求，以 no-store 取得最新 index.html，
  // 永久解決 WKWebView 的 HTML 快取問題。註冊後「不」主動跳轉，避免脫離原生環境。
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  initMap();
  setTimeout(checkForUpdate, 2000);
});
