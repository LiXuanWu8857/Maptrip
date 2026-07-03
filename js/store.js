// ===== 行程儲存層（IndexedDB）=====
// localStorage 只有 ~10MB 上限，行程累積會撞牆且滿載時「靜默存不進去」；
// IndexedDB 配額為數百 MB 起跳，一勞永逸。
//
// 設計：記憶體快取為同步讀寫來源（介面與舊 localStorage 用法等價），
// 寫入以「日」為單位做髒檢查後非同步寫回 IndexedDB（寫入串行化，順序保證）。
// 第一次啟動自動把 localStorage 舊資料搬過來並核對筆數；
// 舊資料保留 7 天當保險，之後開機時自動清除釋放空間。
// IndexedDB 不可用（極舊環境/隱私模式）時整層退回 localStorage，行為與舊版相同。
window.TripStore = (function () {
  let db = null;
  let cache = {};            // day -> trips[]（記憶體即時來源）
  let dayJson = {};          // day -> 最後落盤的 JSON（髒檢查用）
  let useLS = false;         // 退回 localStorage 模式
  let lsKey = 'maptrip_v1';
  let writeChain = Promise.resolve();

  const clone = (o) => (typeof structuredClone === 'function')
    ? structuredClone(o) : JSON.parse(JSON.stringify(o));
  const countTrips = (o) => Object.values(o).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);

  function openDb(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('days'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open error'));
      setTimeout(() => reject(new Error('idb open timeout')), 4000);   // onblocked 等不到就退回
    });
  }

  function idbReadAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('days', 'readonly');
      const out = {};
      const req = tx.objectStore('days').openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { out[cur.key] = cur.value; cur.continue(); }
        else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function idbWrite(puts, dels) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('days', 'readwrite');
      const st = tx.objectStore('days');
      Object.keys(puts).forEach(day => st.put(puts[day], day));
      (dels || []).forEach(day => st.delete(day));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb abort'));
    });
  }

  async function init(storageKey) {
    lsKey = storageKey;
    try {
      if (!window.indexedDB) throw new Error('no idb');
      db = await openDb(storageKey);          // DB 名稱=儲存鍵：正式/測試模式自然隔離
      cache = await idbReadAll();

      // 一次性搬移：IndexedDB 還是空的、localStorage 有舊資料 → 搬過去並重讀核對筆數
      const legacy = localStorage.getItem(storageKey);
      if (!Object.keys(cache).length && legacy) {
        const old = JSON.parse(legacy);
        await idbWrite(old, []);
        const check = await idbReadAll();
        if (countTrips(check) !== countTrips(old)) throw new Error('migrate verify fail');
        cache = check;
        try { localStorage.setItem(storageKey + '_migrated', String(Date.now())); } catch (_) {}
      }

      // 搬移滿 7 天且 IndexedDB 有資料 → 移除 localStorage 舊備份（釋放空間）
      try {
        const mig = +localStorage.getItem(storageKey + '_migrated') || 0;
        if (mig && Date.now() - mig > 7 * 864e5 &&
            Object.keys(cache).length && localStorage.getItem(storageKey) != null) {
          localStorage.removeItem(storageKey);
        }
      } catch (_) {}

      Object.keys(cache).forEach(d => { dayJson[d] = JSON.stringify(cache[d]); });
    } catch (e) {
      // IndexedDB 整層失敗 → 退回 localStorage（行為與舊版完全相同）
      useLS = true;
      db = null;
      try { cache = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch (_) { cache = {}; }
    }
  }

  // 同步讀：回傳深拷貝（維持舊「每次 parse 都是新物件」的語意，呼叫端可放心改）
  function getAll() { return clone(cache); }

  // 同步寫：更新快取，變動的日子非同步寫回 IndexedDB。
  // localStorage 退回模式下與舊版相同（quota 例外會往外拋，呼叫端既有壓實重試邏輯照舊）
  function setAll(obj) {
    cache = clone(obj);
    if (useLS) {
      localStorage.setItem(lsKey, JSON.stringify(cache));
      return;
    }
    const puts = {}, dels = [];
    Object.keys(cache).forEach(day => {
      const j = JSON.stringify(cache[day]);
      if (dayJson[day] !== j) { puts[day] = cache[day]; dayJson[day] = j; }
    });
    Object.keys(dayJson).forEach(day => {
      if (!(day in cache)) { dels.push(day); delete dayJson[day]; }
    });
    if (!Object.keys(puts).length && !dels.length) return;
    const putsCopy = clone(puts);
    writeChain = writeChain
      .then(() => idbWrite(putsCopy, dels))
      .catch(() => {
        // IndexedDB 寫入失敗（罕見）：盡力寫進 localStorage 保底，下次成功寫入會回到正軌
        try { localStorage.setItem(lsKey, JSON.stringify(cache)); } catch (_) {}
      });
  }

  // 等待所有排隊中的寫入完成（測試/診斷用）
  function flush() { return writeChain; }

  // 儲存用量估算（bytes；IndexedDB 模式回報快取 JSON 大小，直觀等於行程資料量）
  function bytes() {
    try { return JSON.stringify(cache).length * 2; } catch (_) { return 0; }
  }

  function mode() { return useLS ? 'localStorage' : 'IndexedDB'; }

  return { init, getAll, setAll, flush, bytes, mode };
})();
