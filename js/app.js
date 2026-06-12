const TEST_MODE_ON = new URLSearchParams(location.search).has('test');
const STORAGE_KEY = TEST_MODE_ON ? 'maptrip_test_v1' : 'maptrip_v1';
const MIN_ACCURACY_M = 60;
const GPS_RECORD_MS  = 3000;
const MOVING_SPEED_MS   = 4;   // >4 m/s (~15 km/h) = 行駛中
const STOPPED_SPEED_MS  = 1;   // <1 m/s (~3.6 km/h) = 停車
const ARRIVAL_DELAY_MS  = 8000; // 停車滿 8 秒才提示

let map, myDotMarker, accuracyCircle, currentPos = null;
let activeTrip = null, activePolyline = null, timerTick = null;
let todayTrips = [], allMapLayers = [];
let wasMoving = false, stoppedTimer = null, arrivalBannerShown = false;

const TEST_MODE = TEST_MODE_ON;
let simTick = 0, simTimer = null;

const TILE_LAYERS = {
  road: L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 20 }),
  satellite: L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    { subdomains: '0123', maxZoom: 20 })
};
let currentTile = 'road';

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: false })
         .setView([25.033, 121.565], 15);
  TILE_LAYERS.road.addTo(map);

  document.getElementById('tile-toggle').addEventListener('click', () => {
    map.removeLayer(TILE_LAYERS[currentTile]);
    currentTile = currentTile === 'road' ? 'satellite' : 'road';
    TILE_LAYERS[currentTile].addTo(map);
    document.getElementById('tile-toggle').textContent =
      currentTile === 'road' ? '🛰 衛星' : '🗺 地圖';
  });

  loadTodayFromStorage();
  startGpsWatch();
  updateTopBar();
  setInterval(updateTopBar, 30000);
}

function startGpsWatch() {
  if (TEST_MODE) { startSimulation(); return; }
  if (!navigator.geolocation) { setGpsBadge('err', '⚠ 不支援定位'); return; }
  navigator.geolocation.watchPosition(onGpsUpdate, onGpsError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 });
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

  if (activeTrip) {
    const last = activeTrip.coords.at(-1);
    if (!last || Date.now() - last.t >= GPS_RECORD_MS) {
      activeTrip.coords.push({ lat, lng, t: Date.now() });
      refreshActivePolyline();
    }
    checkArrival(speed);
  }
}

function checkArrival(speed) {
  // speed 可能是 null（某些裝置不提供），直接忽略
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

function onGpsError(err) {
  const msgs = { 1: 'GPS 存取被拒', 2: 'GPS 訊號遺失', 3: 'GPS 逾時' };
  setGpsBadge('err', '⚠ ' + (msgs[err.code] || 'GPS 錯誤'));
}

function startTrip() {
  if (activeTrip)  { toast('行程進行中，請先按「已抵達」'); return; }
  if (!currentPos) { toast('等待 GPS 訊號中...'); return; }
  beginRecording();
}

function beginRecording() {
  restartSimulation();
  wasMoving = false;
  arrivalBannerShown = false;
  activeTrip = { id: Date.now(), startTime: Date.now(), coords: [{ ...currentPos, t: Date.now() }] };
  activePolyline = L.polyline([[currentPos.lat, currentPos.lng]],
    { color: '#1A73E8', weight: 5, opacity: 0.9 }).addTo(map);
  document.getElementById('start-btn').disabled = true;
  document.getElementById('rec-banner').style.display = 'flex';
  timerTick = setInterval(refreshRecBanner, 1000);
  map.panTo([currentPos.lat, currentPos.lng]);
  toast('行程開始！');
}

function endTrip() {
  if (!activeTrip) return;
  clearInterval(timerTick);  timerTick = null;
  clearTimeout(stoppedTimer); stoppedTimer = null;
  hideArrivalBanner();

  const trip = {
    id: activeTrip.id, startTime: activeTrip.startTime, endTime: Date.now(),
    coords: activeTrip.coords, totalDist: calcTotalDist(activeTrip.coords), fare: 0
  };

  if (activePolyline) { map.removeLayer(activePolyline); activePolyline = null; }
  activeTrip = null;
  wasMoving = false; arrivalBannerShown = false;
  document.getElementById('start-btn').disabled = false;
  document.getElementById('rec-banner').style.display = 'none';

  showFareDialog(trip);
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

  const save = (fare) => {
    trip.fare = fare;
    document.getElementById('fare-overlay').style.display = 'none';
    document.getElementById('fare-dialog').classList.remove('show');
    saveTripFinal(trip);
  };

  document.getElementById('fare-save').onclick = () =>
    save(parseInt(document.getElementById('fare-input').value) || 0);
  document.getElementById('fare-skip').onclick = () => save(0);
}

function saveTripFinal(trip) {
  drawTripLine(trip, todayTrips.length + 1);
  todayTrips.push(trip);
  saveTodayToStorage(); updateTopBar();
  const fareStr = trip.fare ? `　NT$ ${trip.fare}` : '';
  toast(`✓ 第 ${todayTrips.length} 趟　${fmtDur(trip.endTime - trip.startTime)}　${fmtDist(trip.totalDist)}${fareStr}`);
}

function drawTripLine(trip, idx) {
  const latlngs = trip.coords.map(c => [c.lat, c.lng]);
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

function refreshActivePolyline() {
  if (!activePolyline || !activeTrip) return;
  activePolyline.setLatLngs(activeTrip.coords.map(c => [c.lat, c.lng]));
}

function centerOnMe() {
  if (!currentPos) { toast('尚未取得位置'); return; }
  map.setView([currentPos.lat, currentPos.lng], 16);
}

function updateTopBar() {
  const d = new Date();
  document.getElementById('top-date').textContent =
    d.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' });
  document.getElementById('trip-count').textContent = todayTrips.length;
}

function refreshRecBanner() {
  if (!activeTrip) return;
  document.getElementById('rec-time').textContent = fmtDur(Date.now() - activeTrip.startTime);
  document.getElementById('rec-dist').textContent = fmtDist(calcTotalDist(activeTrip.coords));
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
        <div class="trip-stats">${fmtDist(t.totalDist)}${t.fare ? `　<span class="trip-fare-tag">NT$ ${t.fare}</span>` : ''}</div>
      </div>
      <span class="trip-del" onclick="deleteTodayTrip(event,${i})">🗑</span>
    </div>`).join('');
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
  const days = Object.keys(raw).sort().reverse();
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
    return `<div class="history-day">${day}　${trips.length} 趟　${fmtDist(totalDist)}${fareStr}</div>${rows}`;
  }).join('');
}

// ===== 每日行程回放 =====
let replayDot = null, replayInterval = null;
let replayTripIdx = 0, replayCoordIdx = 0;
let replayPaused = false, replaySpeed = 5;

function openReplay() {
  if (!todayTrips.length) { toast('今日尚無行程可回放'); return; }
  closeSheet();
  document.getElementById('replay-panel').classList.add('show');
  startReplay();
}

function startReplay() {
  stopReplay();
  replayTripIdx = 0; replayCoordIdx = 0; replayPaused = false;
  document.getElementById('replay-play-btn').textContent = '⏸';

  const first = todayTrips[0].coords[0];
  replayDot = L.marker([first.lat, first.lng], {
    icon: L.divIcon({
      className: '',
      html: '<div class="replay-dot"></div>',
      iconSize: [22, 22], iconAnchor: [11, 11]
    }),
    zIndexOffset: 2000
  }).addTo(map);

  map.setView([first.lat, first.lng], 16);
  updateReplayPanel();
  scheduleStep();
}

function scheduleStep() {
  clearInterval(replayInterval);
  replayInterval = setInterval(stepReplay, Math.round(200 / replaySpeed));
}

function stepReplay() {
  if (replayPaused) return;
  const trip = todayTrips[replayTripIdx];
  if (!trip) { finishReplay(); return; }

  if (replayCoordIdx >= trip.coords.length) {
    replayTripIdx++;
    replayCoordIdx = 0;
    clearInterval(replayInterval);
    if (replayTripIdx >= todayTrips.length) { finishReplay(); return; }
    updateReplayPanel();
    const c = todayTrips[replayTripIdx].coords[0];
    replayDot.setLatLng([c.lat, c.lng]);
    map.panTo([c.lat, c.lng]);
    setTimeout(scheduleStep, 700);
    return;
  }

  const c = trip.coords[replayCoordIdx];
  replayDot.setLatLng([c.lat, c.lng]);
  map.panTo([c.lat, c.lng]);
  replayCoordIdx++;
}

function toggleReplayPause() {
  replayPaused = !replayPaused;
  document.getElementById('replay-play-btn').textContent = replayPaused ? '▶' : '⏸';
}

function setReplaySpeed(s, btn) {
  replaySpeed = s;
  document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (replayInterval) scheduleStep();
}

function stopReplay() {
  clearInterval(replayInterval); replayInterval = null;
  if (replayDot) { map.removeLayer(replayDot); replayDot = null; }
}

function closeReplay() {
  stopReplay();
  document.getElementById('replay-panel').classList.remove('show');
}

function finishReplay() {
  clearInterval(replayInterval); replayInterval = null;
  document.getElementById('replay-play-btn').textContent = '▶';
  document.getElementById('replay-trip-label').textContent = '回放完畢';
  toast('✓ 今日行程回放完畢');
}

function updateReplayPanel() {
  if (replayTripIdx >= todayTrips.length) return;
  const t = todayTrips[replayTripIdx];
  document.getElementById('replay-trip-label').textContent =
    `第 ${replayTripIdx + 1} 趟 / 共 ${todayTrips.length} 趟`;
  document.getElementById('replay-trip-info').textContent =
    `${fmtTime(t.startTime)} → ${fmtTime(t.endTime)}　${fmtDist(t.totalDist)}`;
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

function saveTodayToStorage() {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  raw[todayKey()] = todayTrips.map(({ id, startTime, endTime, coords, totalDist, fare }) =>
    ({ id, startTime, endTime, coords, totalDist, fare: fare || 0 }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
}

function loadTodayFromStorage() {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const saved = raw[todayKey()] || [];
  if (!saved.length) return;
  saved.forEach((t, i) => { todayTrips.push({ ...t }); drawTripLine(t, i + 1); });
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

window.addEventListener('load', initMap);
