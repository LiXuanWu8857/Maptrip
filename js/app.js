const STORAGE_KEY = 'maptrip_v1';
const MIN_ACCURACY_M = 60;
const GPS_RECORD_MS  = 3000;

let map = null, myDot = null, accuracyCircle = null, currentPos = null;
let activeTrip = null, activePolyline = null, timerTick = null;
let todayTrips = [], allMapMarkers = [];

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    zoom: 15, center: { lat: 25.033, lng: 121.565 },
    mapTypeId: 'roadmap', disableDefaultUI: true,
    gestureHandling: 'greedy', clickableIcons: false,
    styles: [
      { featureType: 'poi',     stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', stylers: [{ visibility: 'simplified' }] }
    ]
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
  const latlng = { lat, lng };
  if (!myDot) {
    myDot = new google.maps.Marker({
      position: latlng, map,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9,
              fillColor: '#4285F4', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2.5 },
      zIndex: 200
    });
    accuracyCircle = new google.maps.Circle({
      center: latlng, radius: acc, map,
      strokeColor: '#4285F4', strokeOpacity: 0.25, strokeWeight: 1,
      fillColor: '#4285F4', fillOpacity: 0.06
    });
    map.panTo(latlng);
  } else {
    myDot.setPosition(latlng);
    accuracyCircle.setCenter(latlng); accuracyCircle.setRadius(acc);
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
  activeTrip = { id: Date.now(), startTime: Date.now(), coords: [{ ...currentPos, t: Date.now() }] };
  activePolyline = new google.maps.Polyline({
    path: [currentPos], map, strokeColor: '#1A73E8', strokeOpacity: 0.9, strokeWeight: 5
  });
  document.getElementById('start-btn').disabled = true;
  document.getElementById('rec-banner').style.display = 'flex';
  timerTick = setInterval(refreshRecBanner, 1000);
  map.panTo(currentPos);
  toast('行程開始！');
}

function endTrip() {
  if (!activeTrip) return;
  clearInterval(timerTick);
  const trip = { id: activeTrip.id, startTime: activeTrip.startTime, endTime: Date.now(),
                 coords: activeTrip.coords, totalDist: calcTotalDist(activeTrip.coords) };
  if (activePolyline) { activePolyline.setMap(null); activePolyline = null; }
  trip.polylineRef = drawTripLine(trip, todayTrips.length + 1);
  todayTrips.push(trip);
  saveTodayToStorage(); updateTopBar();
  activeTrip = null;
  document.getElementById('start-btn').disabled = false;
  document.getElementById('rec-banner').style.display = 'none';
  toast(`✓ 第 ${todayTrips.length} 趟完成｜${fmtDur(trip.endTime - trip.startTime)}｜${fmtDist(trip.totalDist)}`);
}

function drawTripLine(trip, idx) {
  const path = trip.coords.map(c => ({ lat: c.lat, lng: c.lng }));
  const line = new google.maps.Polyline({ path, map, strokeColor: '#1A73E8', strokeOpacity: 0.85, strokeWeight: 5 });
  const startMk = new google.maps.Marker({ position: path[0], map, icon: dotIcon('#34A853'),
    label: { text: String(idx), color: '#fff', fontSize: '11px', fontWeight: 'bold' } });
  const endMk = new google.maps.Marker({ position: path.at(-1), map, icon: dotIcon('#EA4335') });
  allMapMarkers.push(startMk, endMk);
  line.addListener('click', () =>
    toast(`行程 ${idx}｜${fmtTime(trip.startTime)} → ${fmtTime(trip.endTime)}｜${fmtDur(trip.endTime - trip.startTime)}｜${fmtDist(trip.totalDist)}`));
  return line;
}

function dotIcon(color) {
  return { path: google.maps.SymbolPath.CIRCLE, scale: 7,
           fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 };
}

function refreshActivePolyline() {
  if (!activePolyline || !activeTrip) return;
  activePolyline.setPath(activeTrip.coords.map(c => ({ lat: c.lat, lng: c.lng })));
}

function centerOnMe() {
  if (!currentPos) { toast('尚未取得位置'); return; }
  map.panTo(currentPos); map.setZoom(16);
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
  const bounds = new google.maps.LatLngBounds();
  trip.coords.forEach(c => bounds.extend({ lat: c.lat, lng: c.lng }));
  map.fitBounds(bounds, { top: 60, bottom: 90, left: 16, right: 16 });
}

function deleteTodayTrip(e, idx) {
  e.stopPropagation();
  if (!confirm(`刪除第 ${idx + 1} 趟行程？`)) return;
  const t = todayTrips[idx];
  if (t.polylineRef) t.polylineRef.setMap(null);
  todayTrips.splice(idx, 1);
  saveTodayToStorage(); updateTopBar(); renderTripSheet();
  toast(`已刪除第 ${idx + 1} 趟`);
}

function confirmClearDay() {
  if (!todayTrips.length) { toast('今日無行程可清除'); return; }
  if (!confirm(`確定清除今日全部 ${todayTrips.length} 趟行程？`)) return;
  todayTrips.forEach(t => { if (t.polylineRef) t.polylineRef.setMap(null); });
  allMapMarkers.forEach(m => m.setMap(null));
  allMapMarkers = []; todayTrips = [];
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
  saved.forEach((t, i) => { todayTrips.push({ ...t, polylineRef: drawTripLine(t, i + 1) }); });
  const bounds = new google.maps.LatLngBounds();
  saved.forEach(t => t.coords.forEach(c => bounds.extend({ lat: c.lat, lng: c.lng })));
  if (!bounds.isEmpty()) map.fitBounds(bounds, { top: 60, bottom: 90, left: 16, right: 16 });
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
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2800);
}
