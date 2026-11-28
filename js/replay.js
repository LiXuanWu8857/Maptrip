/* replay.js — 每日行程回放（動畫迴圈 + 鏡頭跟隨，自成一體）
 * 從 app.js v1.1.257 的回放整段逐字搬出（isReplaying…updateReplayPanel）。
 * 這是第一個需要「依賴注入」的模組：用 getter 注入 Leaflet map 與需讀的 app.js 活狀態
 *   （todayTrips/activePolyline/currentPos/soloSet/dayPreviewKey），一律 call-time 取值不取快照。
 * 對外開放 tempLayers()（給 redrawAllLines 讀）與 isAnimating()（=!!replayRAF，涵蓋主迴圈與
 *   glideGap 轉場，共用單一 handle）。app.js 留同名薄包裝，HTML onclick / boot / 讓路判斷零改動。
 */
(function (global) {
  'use strict';

  var ctx = {
    getMap: function () { return null; },
    getTodayTrips: function () { return []; },
    getActivePolyline: function () { return null; },
    getCurrentPos: function () { return null; },
    getSoloSet: function () { return []; },
    getDayPreviewKey: function () { return null; },
    resumeFollow: function () {}
  };
  function init(o) { if (o) { for (var k in o) if (typeof o[k] === 'function') ctx[k] = o[k]; } }
  function M() { return ctx.getMap(); }   // Leaflet map（注入；call-time 取用，切 GL 引擎會整頁 reload）

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
  const usable = ctx.getTodayTrips().filter(_replayable);
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
    if (ctx.getActivePolyline()) { try { ctx.getActivePolyline().setStyle({ opacity: 0 }); } catch (_) {} }
    _replayHidToday = true;
    trips.forEach((t, i) => {
      const cur = tripPath(t);
      if (i > 0) {
        const prev = tripPath(trips[i - 1]);
        replayTempLayers.push(drawGapLine(prev.at(-1), cur[0]));
      }
      replayTempLayers.push(
        L.polyline(cur.map(c => [c.lat, c.lng]),
          { color: '#1A73E8', weight: 5, opacity: 0.9 }).addTo(M()));
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
  replayTempLayers.forEach(l => { try { M().removeLayer(l); } catch (_) {} });
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
  replayFitZoom = M().getBoundsZoom(bounds, false, L.point(60, 200));
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
  }).addTo(M());

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
  M().panTo([lat, lng], { animate: false });
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
  if (replayDot) { M().removeLayer(replayDot); replayDot = null; }
}

function closeReplay() {
  stopReplay();
  clearReplayTempLayers();
  // 還原被歷史回放隱藏的今日路線/標記
  if (_replayHidToday) {
    _replayHidToday = false;
    showTodayLayers(true);
    if (ctx.getActivePolyline()) { try { ctx.getActivePolyline().setStyle({ opacity: 0.9 }); } catch (_) {} }
  }
  document.getElementById('replay-panel').classList.remove('show');
  // 回放結束:5 秒後自動飛回目前位置、恢復跟隨
  if (ctx.getCurrentPos() && !ctx.getSoloSet().length && !ctx.getDayPreviewKey()) {
    ctx.resumeFollow();
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

  global.MaptripReplay = {
    init: init,
    isReplaying: isReplaying,
    isAnimating: function () { return !!replayRAF; },   // 主迴圈 or glideGap 任一在跑
    tempLayers: function () { return replayTempLayers; },
    openReplay: openReplay,
    replayDay: replayDay,
    startReplay: startReplay,
    closeReplay: closeReplay,
    toggleReplayPause: toggleReplayPause,
    initSpeedSlider: initSpeedSlider,
    clearReplayTempLayers: clearReplayTempLayers
  };

})(typeof window !== 'undefined' ? window : globalThis);
