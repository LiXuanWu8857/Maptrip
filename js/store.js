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
      setTimeout(() => reject(new Error('idb open timeout')), 8000);   // onblocked 等不到就退回
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

      // 只要 localStorage 還有行程資料，每次開機都做「聯集合併」（以趟 id 為鍵，永不減少）。
      // 不是一次性搬移：這樣不論是 (a) 搬移被開機自動 reload 攔腰打斷留下半套資料、
      // (b) 某場次 IndexedDB 開太慢退回 localStorage 模式、行程寫在 localStorage、
      // (c) 系統把 IndexedDB 清掉，下次開機都會自動把兩邊資料補齊，不會有缺趟。
      const legacy = localStorage.getItem(storageKey);
      if (legacy) {
        const old = JSON.parse(legacy);
        // 墓碑（使用者刪除的趟 id）：備份裡可能還留著已刪的趟，合併時必須排除，否則刪掉的會復活
        let dead = new Set();
        try {
          const delKey = storageKey.indexOf('test') >= 0 ? 'maptrip_deleted_test' : 'maptrip_deleted';
          dead = new Set(JSON.parse(localStorage.getItem(delKey) || '[]')
            .map(d => d && d.id).filter(v => v != null));
        } catch (_) {}
        const puts = {};
        let recovered = 0;
        Object.keys(old).forEach(day => {
          const byId = new Map();
          (cache[day] || []).forEach(t => { if (t && t.id != null) byId.set(t.id, t); });
          let added = 0;
          (old[day] || []).forEach(t => {
            if (t && t.id != null && !byId.has(t.id) && !dead.has(t.id)) { byId.set(t.id, t); added++; }
          });
          if (added) {
            puts[day] = [...byId.values()].sort((a, b) => a.startTime - b.startTime);
            recovered += added;
          }
        });
        if (Object.keys(puts).length) {
          await idbWrite(puts, []);
          const check = await idbReadAll();              // 重讀逐日核對：寫進去的必須讀得回來
          Object.keys(puts).forEach(day => {
            if (JSON.stringify(check[day]) !== JSON.stringify(puts[day])) throw new Error('merge verify fail');
          });
          cache = check;
          try { localStorage.setItem(storageKey + '_migrated', String(Date.now())); } catch (_) {}
          window._storeMerged = recovered;               // 開機提示用（app.js 讀取）
        }
      }

      // 合併狀態穩定滿 7 天 → 移除 localStorage 舊備份（釋放空間；期間都是雙保險）
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

  // 某日趟數（不做深拷貝，供每秒更新的 UI 使用）
  function dayCount(day) { return (cache[day] || []).length; }

  // 徹底清空本機行程（換帳號用）：記憶體快取＋IndexedDB 物件庫內容＋localStorage 舊備份＋搬移旗標。
  // 少清任何一處都會在下次開機被聯集合併「復活」回來，所以四處都要清。
  function clearAll() {
    cache = {}; dayJson = {};
    try { localStorage.removeItem(lsKey); localStorage.removeItem(lsKey + '_migrated'); } catch (_) {}
    if (useLS) { try { localStorage.setItem(lsKey, '{}'); } catch (_) {} return Promise.resolve(); }
    writeChain = writeChain.then(function () {
      return new Promise(function (res) {
        try {
          var tx = db.transaction('days', 'readwrite');
          tx.objectStore('days').clear();
          tx.oncomplete = function () { res(); };
          tx.onerror = function () { res(); };
          tx.onabort = function () { res(); };
        } catch (_) { res(); }
      });
    });
    return writeChain;
  }

  return { init, getAll, setAll, flush, bytes, mode, dayCount, clearAll };
})();
