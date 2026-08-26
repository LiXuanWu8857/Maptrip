/* =============================================================
 * recorder.js — 行程錄製狀態機（生命週期 / 復原 / 鎖屏方塊 / GPS 監看）
 * -------------------------------------------------------------
 * 從 app.js v1.1.258 的錄製區塊逐字抽出（body 與原版相同，僅把 app.js 私有
 * 狀態改成經 init(ctx) 注入的存取器；呼叫的全域函式執行期由 window 取用）。
 *
 * 邊界決定（血淚考量）：這是耦合最深、動到會賠錢（掉行程）的一塊，且使用者
 * 正在用。因此採「最小風險切法」——
 *   - 共用活狀態（activeTrip / activePolyline / currentPos / wakeLock / todayTrips /
 *     allMapLayers）仍留在 app.js（`let`），經 getter/setter 注入 → app.js 那
 *     十多處外部讀取 activeTrip/activePolyline 全部零改動。
 *   - onGpsUpdate 的「逐點收錄」子區塊（與地圖手勢狀態 _mapZooming/_mapTouching/
 *     _lineResyncPending 綁死）留在 app.js 原地不動 → GPS 熱路徑零風險。
 *   - 本模組只搬「行程生命週期＋復原持久化＋原生方塊/浮窗介面＋GPS 監看啟動」。
 *
 * 掛 window.MaptripRecorder；app.js 用同名薄包裝轉呼叫，呼叫端零改動。
 * ============================================================= */
(function (global) {
  'use strict';

  // ---- 注入的相依（init 時填入）----
  var ctx = {};
  function M() { return ctx.getMap(); }              // Leaflet map（app.js 私有）
  function A() { return ctx.getActive(); }           // activeTrip（app.js 私有）
  function P() { return ctx.getActivePolyline(); }   // activePolyline（app.js 私有）

  // ---- 模組私有狀態（原 app.js 私有，只有錄製函式用到，整組搬入）----
  var simTick = 0, simTimer = null;   // 測試模式模擬 GPS
  var nativeWatcherId = null;         // 原生背景定位 watcher id
  var lastHeartbeat = 0;              // 上次替鎖屏方塊續命的時間戳
  var _lastActiveSave = 0;            // 進行中行程復原暫存的節流時戳
  var pendingFareTrip = null;         // 由浮窗結束、等待數字鍵盤輸入車資的那趟
  var timerTick = null;               // 記錄中每秒刷新橫幅的計時器
  var ACTIVE_KEY = 'maptrip_active';  // init() 依 test 模式覆寫

  // ===== GPS 監看啟動 =====
  function startGpsWatch() {
    if (ctx.testMode) { startSimulation(); return; }
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
        speed:     location.speed,
        altitude:  location.altitude,           // 海拔高度（公尺），橋上/橋下量測用
        altitudeAccuracy: location.altitudeAccuracy   // 垂直精度（公尺）
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
    if (!ctx.testMode) return;
    clearInterval(simTimer);
    const base = ctx.getCurrentPos() || { lat: 25.0330, lng: 121.5654 };
    runSimulation(base);
  }

  function onGpsError(err) {
    const msgs = { 1: 'GPS 存取被拒', 2: 'GPS 訊號遺失', 3: 'GPS 逾時' };
    setGpsBadge('err', '⚠ ' + (msgs[err.code] || 'GPS 錯誤'));
  }

  // ===== 行程生命週期 =====
  function startTrip() {
    if (A())  { toast('行程進行中，請先按「已抵達」'); return; }
    if (!ctx.getCurrentPos()) { toast('等待 GPS 訊號中...'); return; }
    beginRecording();
  }

  // 鎖屏 widget 的 maptrip:// URL 路由（背景喚醒 appUrlOpen + 冷啟動 getLaunchUrl 共用）
  function handleWidgetUrl(url) {
    if (!url) return;
    if (url.indexOf('maptrip://start') === 0) widgetStart();
    else if (url.indexOf('maptrip://end') === 0 && A()) endTrip();
  }

  // 鎖屏 Widget 觸發的開始：背景被喚醒時 GPS 常還沒定位，
  // 若還沒鎖定就排隊，等下一筆 GPS 進來自動開始（見 app.js onGpsUpdate）。
  function widgetStart() {
    dbg('widgetStart active=' + !!A() + ' pos=' + !!ctx.getCurrentPos());
    if (A()) return;
    if (ctx.getCurrentPos()) { beginRecording(); }
    else { ctx.setPendingWidgetStart(true); toast('定位中，行程即將開始…'); }
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
      if (res?.action === 'end' && A()) { endTrip(); return true; }
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
    const at = A();
    if (at) {
      const elapsed  = Math.floor((now - at.startTime) / 1000);
      const distance = Math.round(activeDist());
      liveAct()?.updateTrip({ elapsed, distance });
      floatWin()?.update({ elapsed, distance }).catch(() => {});
    } else {
      liveAct()?.heartbeat?.();
    }
  }

  async function beginRecording() {
    goHome();   // 開始行程立刻回主頁（地圖），收起紀錄/歷史等覆蓋層
    restartSimulation();
    ctx.setActiveSnapPending(false);
    setAutoFollow(true);
    const pos = ctx.getCurrentPos();
    ctx.setActive({ id: Date.now(), startTime: Date.now(), coords: [{ ...pos, t: Date.now() }] });
    ctx.setActivePolyline(L.polyline([[pos.lat, pos.lng]],
      { color: '#1A73E8', weight: 5, opacity: 0.9 }).addTo(M()));
    const startBtn = document.getElementById('start-btn');
    startBtn.onclick = () => endTrip();   // 不傳參數：走 App 內車資對話框
    startBtn.querySelector('.ctrl-icon').textContent = '■';
    startBtn.querySelector('.ctrl-label').textContent = '結束';
    startBtn.classList.add('recording');
    document.getElementById('rec-banner').style.display = 'flex';
    timerTick = setInterval(refreshRecBanner, 1000);
    M().panTo([pos.lat, pos.lng]);
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
        const wl = await navigator.wakeLock.request('screen');
        ctx.setWakeLock(wl);
        // 系統在熄屏/切 App 時會自動釋放，記錄下來以便回前景時重取
        wl.addEventListener('release', () => { ctx.setWakeLock(null); });
      }
    } catch (_) { /* 不支援或被拒時靜默略過 */ }
  }

  // fromFloat=true：由浮動視窗的「結束」鈕觸發 → 車資改用浮窗數字鍵盤輸入
  function endTrip(fromFloat) {
    const at = A();
    if (!at) return;
    clearActiveTrip();   // 行程正式結束，清掉復原暫存
    clearInterval(timerTick);  timerTick = null;
    liveAct()?.endTrip();

    const trip = {
      id: at.id, startTime: at.startTime, endTime: Date.now(),
      coords: at.coords, totalDist: calcTotalDist(at.coords), fare: 0
    };

    const pl = P();
    if (pl) { M().removeLayer(pl); ctx.setActivePolyline(null); }
    ctx.setActive(null);
    setAutoFollow(false);
    const startBtn = document.getElementById('start-btn');
    startBtn.onclick = startTrip;
    startBtn.querySelector('.ctrl-icon').textContent = '▶';
    startBtn.querySelector('.ctrl-label').textContent = '開始';
    startBtn.classList.remove('recording');
    document.getElementById('rec-banner').style.display = 'none';

    // 釋放螢幕常亮鎖
    const wl = ctx.getWakeLock();
    if (wl) { wl.release().catch(() => {}); ctx.setWakeLock(null); }

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
  async function finalizeSavedTrip(trip, fare, paymentMethod, label, commission, dispatch, tip, tipMethod) {
    const apply = (t) => {
      t.fare = fare;
      t.paymentMethod = paymentMethod;
      if (commission !== undefined) t.commission = commission || 0;   // 抽成
      if (dispatch !== undefined) t.dispatch = dispatch || 0;         // 叫車費
      if (tip !== undefined) { t.tip = tip || 0; t.tipMethod = (tip ? (tipMethod || 'cash') : ''); }  // 小費/加收
      if (label !== undefined) t.label = label || '';
    };
    apply(trip);
    let mem = ctx.getTodayTrips().find(t => t.id === trip.id);
    if (mem && mem !== trip) apply(mem);
    saveTodayToStorage();   // 車資先存（貼路成功與否不影響金額）
    if (commission || dispatch) _pushCommission(trip.id, commission, dispatch);   // 抽成上雲
    updateTopBar();

    // 共享熱點：完成一趟載客（有上車點、非「其他」）→ 對去識別化格子 count +1
    // （只有加入車隊＋開分享才真的寫；前端去重＝一趟一次、每日上限）。座標只用粗網格。
    try {
      var _c0 = trip.coords && trip.coords[0];
      if (_c0 && typeof _c0.lat === 'number' && paymentMethod !== 'other' &&
          window.MaptripSync && MaptripSync.contributeHotspot) {
        MaptripSync.contributeHotspot(_c0.lat, _c0.lng, trip.startTime || Date.now(), trip.id);
      }
    } catch (_) {}

    const road = await snapToRoads(trip.coords);
    if (road) {
      // 以 id 重新定位目前清單中的那筆（可能已被同步刷新換新）
      mem = ctx.getTodayTrips().find(t => t.id === trip.id) || trip;
      mem.roadCoords = road;
      // 貼路成功 → 原始 GPS 座標只留頭尾（畫線/回放/截圖一律用 roadCoords）
      if (mem.coords && mem.coords.length > 2) {
        mem.coords = [mem.coords[0], mem.coords[mem.coords.length - 1]];
      }
      // 重畫這趟的路線（換成貼路座標）
      const idx = ctx.getTodayTrips().indexOf(mem);
      if (idx >= 0) {
        (mem._layers || []).forEach(l => {
          try { M().removeLayer(l); } catch (_) {}
          const j = ctx.getAllMapLayers().indexOf(l);
          if (j >= 0) ctx.getAllMapLayers().splice(j, 1);
        });
        drawTripLine(mem, idx + 1);
      }
      saveTodayToStorage();
    } else {
      // 貼路失敗（OSRM 拒收/離線）：至少把原始軌跡的飄移群清掉，
      // 讓顯示/儲存的路線不留鋸齒（貼路成功前的過渡狀態也乾淨）。
      mem = ctx.getTodayTrips().find(t => t.id === trip.id) || trip;
      if (mem.coords && mem.coords.length >= 4) {
        const cleaned = _cleanTrace(mem.coords);
        if (cleaned.length < mem.coords.length) {
          mem.coords = cleaned.map(c => ({ lat: c.lat, lng: c.lng, ...(c.t != null ? { t: c.t } : {}) }));
          const idx = ctx.getTodayTrips().indexOf(mem);
          if (idx >= 0) {
            (mem._layers || []).forEach(l => {
              try { M().removeLayer(l); } catch (_) {}
              const j = ctx.getAllMapLayers().indexOf(l);
              if (j >= 0) ctx.getAllMapLayers().splice(j, 1);
            });
            drawTripLine(mem, idx + 1);
          }
          saveTodayToStorage();
        }
      }
      // 60 秒後自動重試貼路（不必等下次開機）
      setTimeout(() => { if (!A()) retrySnapBacklog(2); }, 60000);
    }
    const ts = document.getElementById('trip-sheet');
    if (ts && ts.style.display !== 'none') renderTripSheet();
  }

  // ===== 進行中行程的「當機／重載」復原 =====
  // 記錄中定期把 activeTrip 存本機；重開 App 若偵測到未結束的行程，自動接回繼續記錄。
  function saveActiveTrip(force) {
    const at = A();
    if (!at) return;
    // 節流：每 5 秒存一次即可（pagehide/beforeunload 會強制補存），
    // 避免長行程每秒全量 JSON.stringify 造成不必要的耗電
    const now = Date.now();
    if (!force && now - _lastActiveSave < 5000) return;
    _lastActiveSave = now;
    try {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify({
        id: at.id, startTime: at.startTime,
        coords: at.coords, savedAt: now
      }));
    } catch (_) {}
  }
  function clearActiveTrip() { try { localStorage.removeItem(ACTIVE_KEY); } catch (_) {} }

  function restoreActiveTripIfAny() {
    if (A()) return;
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
    ctx.setActive({ id: s.id, startTime: s.startTime, coords: s.coords });
    ctx.setActivePolyline(L.polyline(s.coords.map(c => [c.lat, c.lng]),
      { color: '#1A73E8', weight: 5, opacity: 0.9 }).addTo(M()));
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
        elapsed: Math.floor((Date.now() - A().startTime) / 1000),
        distance: Math.round(calcTotalDist(A().coords))
      }).catch(() => {});
    } catch (_) {}
    toast('已接回記錄中的行程');
  }

  // 浮窗數字鍵盤按「確定/略過」後：把車資補進「已落盤」的那趟並貼路
  async function saveFloatFare(fare, paymentMethod, dispatch) {
    const trip = pendingFareTrip;
    pendingFareTrip = null;
    if (!trip) return;
    // 叫車費：浮窗（Android）帶 dispatch 進來就沿用；沒帶（舊版）預設 0。commission 一律 0（事後補）。
    await finalizeSavedTrip(trip, fare, paymentMethod || '', '', 0, dispatch != null ? dispatch : 0);
  }

  // 背景結束：直接貼合道路並存檔（金額 0），不需 UI
  async function saveTripBackground(trip) {
    trip.roadCoords = await snapToRoads(trip.coords);
    saveTripFinal(trip);
    toast('✓ 行程已結束，金額可稍後在清單補填');
  }

  // 初始化：注入 app.js 的 map 與共用活狀態存取器，並依 test 模式決定 ACTIVE_KEY
  function init(context) {
    ctx = context || {};
    ACTIVE_KEY = ctx.testMode ? 'maptrip_active_test' : 'maptrip_active';
  }

  global.MaptripRecorder = {
    init: init,
    startGpsWatch: startGpsWatch,
    startNativeGpsWatch: startNativeGpsWatch,
    startSimulation: startSimulation,
    runSimulation: runSimulation,
    restartSimulation: restartSimulation,
    onGpsError: onGpsError,
    startTrip: startTrip,
    beginRecording: beginRecording,
    endTrip: endTrip,
    requestWakeLock: requestWakeLock,
    handleWidgetUrl: handleWidgetUrl,
    widgetStart: widgetStart,
    consumePendingWidgetCmd: consumePendingWidgetCmd,
    consumePendingWidgetCmdRetry: consumePendingWidgetCmdRetry,
    widgetHeartbeat: widgetHeartbeat,
    finalizeSavedTrip: finalizeSavedTrip,
    saveActiveTrip: saveActiveTrip,
    clearActiveTrip: clearActiveTrip,
    restoreActiveTripIfAny: restoreActiveTripIfAny,
    saveFloatFare: saveFloatFare,
    saveTripBackground: saveTripBackground
  };

})(typeof window !== 'undefined' ? window : globalThis);
