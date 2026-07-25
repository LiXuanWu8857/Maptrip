/* trip-store.js — 儲存層(IndexedDB,localStorage 後備)
 * ⚠️ 這是「模組化拆分指南」的骨架版,刻意簡化。
 *    正式接進 App 前，必須把 js/store.js 的真實邏輯搬進來:
 *    墓碑過濾、7 天遷移窗、寫入後重讀核對、逐日髒 JSON 檢查、深拷貝。
 *    也需解決與現有 js/store.js 的 window.TripStore 命名衝突。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'maptrip_lab', STORE = 'trips', LS_KEY = 'maptrip_lab_trips';

  function TripStore() {
    this._cache = {};      // { dayKey: [trip, ...] } 記憶體快取 = 同步讀寫來源
    this._db = null;
    this._mode = 'ls';     // 'idb' | 'ls'
    this._dirty = {};      // 待寫回的日
    this._writing = false; // 串行寫入旗標(順序保證)
  }

  TripStore.prototype.init = function () {
    var self = this;
    return new Promise(function (resolve) {
      try {                                        // 先把 LS 既有資料載入快取
        var raw = global.localStorage.getItem(LS_KEY);
        if (raw) self._cache = JSON.parse(raw) || {};
      } catch (e) { }

      if (!global.indexedDB) { self._mode = 'ls'; return resolve(self); }
      var req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function (ev) {
        self._db = ev.target.result; self._mode = 'idb';
        self._loadAllFromIDB().then(function () { resolve(self); });
      };
      req.onerror = function () { self._mode = 'ls'; resolve(self); };
    });
  };

  // 從 IDB 讀出並「聯集」到快取(以趟 id 為鍵,永不減少 → 不缺趟)
  TripStore.prototype._loadAllFromIDB = function () {
    var self = this;
    return new Promise(function (resolve) {
      try {
        var os = self._db.transaction(STORE, 'readonly').objectStore(STORE);
        var cur = os.openCursor();
        cur.onsuccess = function (e) {
          var c = e.target.result;
          if (c) { self._mergeDay(c.key, c.value); c.continue(); }
          else { resolve(); }
        };
        cur.onerror = function () { resolve(); };
      } catch (e) { resolve(); }
    });
  };

  // 以趟 id 去重的日聯集(對應文件「開機聯集合併」)
  TripStore.prototype._mergeDay = function (dayKey, incoming) {
    var have = this._cache[dayKey] || [];
    var byId = {};
    have.concat(incoming || []).forEach(function (t) {
      if (!t || !t.id) return;
      var old = byId[t.id];                        // 評分:取較新者(以 endTime 簡化)
      if (!old || (t.endTime || 0) >= (old.endTime || 0)) byId[t.id] = t;
    });
    this._cache[dayKey] = Object.keys(byId).map(function (k) { return byId[k]; });
  };

  // ---- 同步讀寫介面(與舊 localStorage 用法等價,呼叫端零改動)----
  TripStore.prototype.loadTrips = function (dayKey) {
    return (this._cache[dayKey] || []).slice();
  };
  TripStore.prototype.saveTrips = function (dayKey, trips) {
    this._cache[dayKey] = trips.slice();
    this._dirty[dayKey] = true;
    this._scheduleFlush();                         // 非同步串行寫回,不阻塞呼叫端
  };
  TripStore.prototype.getAll = function () { return this._cache; };

  TripStore.prototype._scheduleFlush = function () {
    var self = this;
    try { global.localStorage.setItem(LS_KEY, JSON.stringify(self._cache)); }
    catch (e) { }                                  // LS 滿了會走到這,IDB 才是主力
    if (self._mode !== 'idb' || self._writing) return;
    self._writing = true;
    var keys = Object.keys(self._dirty), i = 0;
    function next() {
      if (i >= keys.length) { self._writing = false; self._dirty = {}; return; }
      var k = keys[i++];
      try {
        var tx = self._db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(self._cache[k], k);
        tx.oncomplete = next; tx.onerror = next;   // 單日失敗不阻斷其他日
      } catch (e) { next(); }
    }
    next();
  };

  TripStore.prototype.mode = function () { return this._mode; };

  global.TripStore = TripStore;

})(typeof window !== 'undefined' ? window : globalThis);
