const STORAGE_KEY = 'maptrip_v1';
const MIN_ACCURACY_M = 60;
const GPS_RECORD_MS  = 3000;

let map, myDotMarker, accuracyCircle, currentPos = null;
let activeTrip = null, activePolyline = null, timerTick = null;
let todayTrips = [], allMapLayers = [];

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
    document.getElementById('tile-toggle').textContent = currentTile === 'road' ? '🛰 衛星' : '🗺 地圖';
  });

  loadTodayFromStorage();
  startGpsWatch();
  updateTopBar();
  setInterval(updateTopBar, 30000);
}

function startGpsWatch() {
  if (!navigator.geolocation) { setGpsBadge('err', '⚠ 不支援定位'); return; }
  navigator.geolocation.watchPosition(onGpsUpdate, onGpsError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 });
}

function onGpsUpdate(pos) {
  const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
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
  }
}

function onGpsError(err) {
  const msgs = { 1: 'GPS 存取被拒', 2: 'GPS 訊號遺失', 3: 'GPS 逾時' };
  setGpsBadge('err', '⚠ ' + (msgs[err.code] || 'GPS 錯誤'));
}

function startTrip() {
  if (activeTrip)  { toast('行程進行中，請先按「已抵達」'); return; }
  if (!currentPos) { toast('等待 GPS 訊號中...'); return; }

  const dialog = document.getElementById('start-dialog');
  const input  = document.getElementById('dest-input');
  input.value  = '';
  dialog.style.display = 'flex';
  setTimeout(() => input.focus(), 100);

  document.getElementById('start-skip').onclick = () => {
    dialog.style.display = 'none';
    beginRecording();
  };
  document.getElementById('start-nav').onclick = () => {
    dialog.style.display = 'none';
    const dest = input.value.trim();
    if (dest) {
      const url = `https://www.google.com/maps/dir/?api=1` +
        `&origin=${currentPos.lat},${currentPos.lng}` +
        `&destination=${encodeURIComponent(dest)}` +
        `&travelmode=driving`;
      window.open(url, '_blank');
    }
    beginRecording();
  };

  input.addEventListener('keydown', function handler(e) {
    if (e.key === 'Enter') {
      input.removeEventListener('keydown', handler);
      document.getElementById('start-nav').click();
    }
  });
}

function beginRecording() {
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
  clearInterval(timerTick);
  const trip = { id: activeTrip.id, startTime: activeTrip.startTime, endTime: Date.now(),
                 coords: activeTrip.coords, totalDist: calcTotalDist(activeTrip.coords) };
  if (activePolyline) { map.removeLayer(activePolyline); activePolyline = null; }
  drawTripLine(trip, todayTrips.length + 1);
  todayTrips.push(trip);
  saveTodayToStorage(); updateTopBar();
  activeTrip = null;
  document.getElementById('start-btn').disabled = false;
  document.getElementById('rec-banner').style.display = 'none';
  const num = todayTrips.length;
  toast(`✓ 第 ${num} 趟完成｜${fmtDur(trip.endTime - trip.startTime)}｜${fmtDist(trip.totalDist)}`);
  showGoogleMapsPrompt(trip);
}

function showGoogleMapsPrompt(trip) {
  if (!trip.coords || trip.coords.length < 2) return;
  const start = trip.coords[0];
  const end   = trip.coords.at(-1);
  const el = document.getElementById('gmaps-prompt');
  el.style.display = 'flex';
  document.getElementById('gmaps-confirm').onclick = () => {
    el.style.display = 'none';
    const url = `https://www.google.com/maps/dir/?api=1` +
      `&origin=${start.lat},${start.lng}` +
      `&destination=${end.lat},${end.lng}` +
      `&travelmode=driving`;
    window.open(url, '_blank');
  };
  document.getElementById('gmaps-cancel').onclick = () => { el.style.display = 'none'; };
}

function drawTripLine(trip, idx) {
  const latlngs = trip.coords.map(c => [c.lat, c.lng]);
  const line = L.polyline(latlngs, { color: '#1A73E8', weight: 5, opacity: 0.85 }).addTo(map);
  line.on('click', () =>
    toast(`行程 ${idx}｜${fmtTime(trip.startTime)} → ${fmtTime(trip.endTime)}｜${fmtDur(trip.endTime - trip.startTime)}｜${fmtDist(trip.totalDist)}`));

  const startIcon = makeNumberIcon(idx, '#34A853');
  const endIcon   = makeDotIcon('#EA4335');
  const startMk = L.marker(latlngs[0], { icon: startIcon }).addTo(map);
  const endMk   = L.marker(latlngs.at(-1), { icon: endIcon }).addTo(map);
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
  body.innerHTML = todayTrips.map((t, i) => `
    <div class="trip-row" onclick="focusTrip(${i}); closeSheet()">
      <div class="trip-num">${i + 1}</div>
      <div class="trip-meta">
        <div class="trip-time">${fmtTime(t.startTime)} &rarr; ${fmtTime(t.endTime)}</div>
        <div class="trip-stats">${fmtDur(t.endTime - t.startTime)} &nbsp;|&nbsp; ${fmtDist(t.totalDist)}</div>
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
    const rows = trips.map((t, i) => `
      <div class="trip-row">
        <div class="trip-num">${i + 1}</div>
        <div class="trip-meta">
          <div class="trip-time">${fmtTime(t.startTime)} &rarr; ${fmtTime(t.endTime)}</div>
          <div class="trip-stats">${fmtDur(t.endTime - t.startTime)} &nbsp;|&nbsp; ${fmtDist(t.totalDist)}</div>
        </div>
      </div>`).join('');
    return `<div class="history-day">${day} · ${trips.length} 趟 · ${fmtDist(totalDist)}</div>${rows}`;
  }).join('');
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

function saveTodayToStorage() {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  raw[todayKey()] = todayTrips.map(({ id, startTime, endTime, coords, totalDist }) =>
    ({ id, startTime, endTime, coords, totalDist }));
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
