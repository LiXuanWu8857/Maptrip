/* =============================================================
 * storage.js — 行程序列化 / 合併存檔 / 壓實 / 刪除墓碑 / 營業日
 * -------------------------------------------------------------
 * 從 app.js v1.1.259 逐字抽出（body 與原版相同）。這是 store.js（TripStore／IndexedDB
 * 低階存取）之上的「高階持久化邏輯」：把記憶體行程序列化瘦身、以趟 id 合併落盤、
 * 儲存空間壓實、刪除墓碑、營業日（07:00 換日）計算。
 *
 * 注入（init）：testMode（決定 DELETED_KEY）、getTodayTrips（saveTodayToStorage 用）。
 * 呼叫的全域函式（loadTrips/saveTrips/toast/calcTotalDist/MaptripSync）執行期由 window 取用。
 * 掛 window.MaptripStorage；app.js 留同名薄包裝轉呼叫，呼叫端零改動。
 * 【留在 app.js】retrySnapBacklog / loadTodayFromStorage——它們重畫地圖（drawTripLine/
 * allMapLayers/map），是繪圖不是儲存，故不搬。
 * ============================================================= */
(function (global) {
  'use strict';

  var ctx = {};
  const DAY_SPLIT_HOUR = 7;
  var DELETED_KEY = 'maptrip_deleted';   // init() 依 test 模式覆寫

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

  function serializeTrip({ id, startTime, endTime, coords, totalDist, fare, roadCoords, paymentMethod, label, commission, dispatch, tip, tipMethod }) {
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
      ...(tip ? { tip } : {}),                  // 小費/加收（金額）
      ...(tip && tipMethod ? { tipMethod } : {}),   // 小費付款方式（cash/card）
      ...(slimRoad ? { roadCoords: slimRoad } : {}) };
  }

  // 給 sync.js 用：雲端資料「進入本機前」先瘦身。
  // 沒有這層的話，雲端殘留的胖資料（壓實前的全量座標）會在同步時
  // 把剛壓實的本機資料再灌肥回去（2MB → 10MB 的元兇）。
  global.slimTripForStorage = function (t) {
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
    for (const t of ctx.getTodayTrips()) {
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

  function init(context) {
    ctx = context || {};
    DELETED_KEY = ctx.testMode ? 'maptrip_deleted_test' : 'maptrip_deleted';
  }

  global.MaptripStorage = {
    init: init,
    businessDayKey: businessDayKey,
    todayKey: todayKey,
    _r5: _r5,
    _simplifyPath: _simplifyPath,
    serializeTrip: serializeTrip,
    saveTodayToStorage: saveTodayToStorage,
    compactStorage: compactStorage,
    storageBytes: storageBytes,
    addDeletedId: addDeletedId,
    removeTripFromStorage: removeTripFromStorage
  };

})(typeof window !== 'undefined' ? window : globalThis);
