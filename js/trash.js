/* =============================================================
 * trash.js — 刪除行程回收桶（MaptripTrash，24 小時可復原）
 * -------------------------------------------------------------
 * 刪除原本經 storage.js removeTripFromStorage 直接清掉本機＋雲端、無法復原。
 * 本模組在刪除當下先把「整筆趟(serializeTrip)＋日 key＋deletedAt」留起來，24h 內可復原，
 * 逾時「懶清」（開機/開回收桶時）才真正清掉。
 *
 * 存放：獨立 IndexedDB（DB 名 maptrip_trash / _test），不塞 localStorage（避免踩
 *   「儲存空間滿→存檔靜默失敗」老坑；座標大）；IndexedDB 不可用時退回 localStorage 保底。
 * 範圍：GPS 路線行程（走 removeTripFromStorage 那條）；記帳者手動補登不在此。
 *
 * 還原（restore）四件事缺一不可（否則被同步機制再刪）：
 *   ① 解墓碑（MaptripSync.undeleteId：清本機 maptrip_deleted 該 id ＋ pushDeleted 更新雲端）
 *   ② 寫回本機 raw[day]（合併不覆蓋）→ saveTrips
 *   ③ MaptripSync.syncDays([day]) 重建雲端文件
 *   ④ 從回收桶移除該筆
 * ============================================================= */
(function (global) {
  'use strict';

  var TTL_MS = 24 * 3600 * 1000;
  var DB_NAME = 'maptrip_trash', STORE = 'trash', LS_KEY = 'maptrip_trash';
  var _db = null, _useLS = false, _ready = null;

  function _serialize(trip) {
    try { return (global.MaptripStorage && MaptripStorage.serializeTrip) ? MaptripStorage.serializeTrip(trip) : JSON.parse(JSON.stringify(trip)); }
    catch (_) { try { return JSON.parse(JSON.stringify(trip)); } catch (__) { return trip; } }
  }
  function _toast(m) { try { if (global.toast) global.toast(m); } catch (_) {} }

  function _openDb() {
    return new Promise(function (resolve) {
      try {
        if (!global.indexedDB) { _useLS = true; return resolve(); }
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () { try { req.result.createObjectStore(STORE, { keyPath: 'id' }); } catch (_) {} };
        req.onsuccess = function () { _db = req.result; resolve(); };
        req.onerror = function () { _useLS = true; resolve(); };
        setTimeout(function () { if (!_db && !_useLS) { _useLS = true; resolve(); } }, 8000);
      } catch (_) { _useLS = true; resolve(); }
    });
  }
  function init(opts) {
    opts = opts || {};
    if (opts.testMode) { DB_NAME = 'maptrip_trash_test'; LS_KEY = 'maptrip_trash_test'; }
    _ready = _openDb().then(function () { return purgeExpired(); }).catch(function () {});
    return _ready;
  }
  function _whenReady() { return _ready || (_ready = _openDb()); }

  // ── localStorage 後備 ──
  function _lsAll() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') || []; } catch (_) { return []; } }
  function _lsSave(a) { try { localStorage.setItem(LS_KEY, JSON.stringify(a || [])); } catch (_) {} }

  function _idbReadAll() {
    return new Promise(function (resolve) {
      if (_useLS || !_db) return resolve(_lsAll());
      try {
        var out = [], tx = _db.transaction(STORE, 'readonly'), req = tx.objectStore(STORE).openCursor();
        req.onsuccess = function () { var c = req.result; if (c) { out.push(c.value); c.continue(); } else resolve(out); };
        req.onerror = function () { resolve(_lsAll()); };
      } catch (_) { resolve(_lsAll()); }
    });
  }
  function _idbPut(rec) {
    if (_useLS || !_db) { var a = _lsAll().filter(function (r) { return r.id !== rec.id; }); a.push(rec); _lsSave(a); return Promise.resolve(); }
    return new Promise(function (resolve) {
      try { var tx = _db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(rec); tx.oncomplete = function () { resolve(); }; tx.onerror = function () { var a = _lsAll().filter(function (r) { return r.id !== rec.id; }); a.push(rec); _lsSave(a); resolve(); }; }
      catch (_) { resolve(); }
    });
  }
  function _idbDel(id) {
    id = String(id);
    if (_useLS || !_db) { _lsSave(_lsAll().filter(function (r) { return r.id !== id; })); return Promise.resolve(); }
    return new Promise(function (resolve) {
      try { var tx = _db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(id); tx.oncomplete = function () { resolve(); }; tx.onerror = function () { resolve(); }; }
      catch (_) { resolve(); }
    });
  }

  // push：刪除當下把整筆留起來（rec 同步建好、落盤延到 IDB 就緒）。在清資料「之前」呼叫。
  function push(trip, day) {
    if (!trip || trip.id == null) return;
    var rec = { id: String(trip.id), trip: _serialize(trip), day: day || '', deletedAt: Date.now() };
    _whenReady().then(function () { _idbPut(rec); });
  }

  // 逾時懶清：丟掉 deletedAt + TTL < now 的。回傳清掉筆數。
  function purgeExpired() {
    return _idbReadAll().then(function (arr) {
      var now = Date.now(), dead = arr.filter(function (r) { return (r.deletedAt || 0) + TTL_MS < now; });
      return Promise.all(dead.map(function (r) { return _idbDel(r.id); })).then(function () { return dead.length; });
    });
  }

  // 清單（未逾時、附剩餘可復原毫秒），由新到舊。
  function list() {
    return _whenReady().then(purgeExpired).then(_idbReadAll).then(function (arr) {
      var now = Date.now();
      return arr.filter(function (r) { return (r.deletedAt || 0) + TTL_MS >= now; })
        .map(function (r) { return { id: r.id, trip: r.trip, day: r.day, deletedAt: r.deletedAt, remainMs: Math.max(0, (r.deletedAt || 0) + TTL_MS - now) }; })
        .sort(function (a, b) { return b.deletedAt - a.deletedAt; });
    });
  }
  function count() { return list().then(function (a) { return a.length; }); }
  function remove(id) { return _idbDel(id); }
  function clear() { return _idbReadAll().then(function (arr) { return Promise.all(arr.map(function (r) { return _idbDel(r.id); })); }); }

  // 還原一筆：解墓碑 → 寫回本機 → 重建雲端 → 移出回收桶。回傳 {restored, day} 或 {error}。
  function restore(id) {
    id = String(id);
    return _whenReady().then(_idbReadAll).then(function (arr) {
      var rec = null;
      for (var i = 0; i < arr.length; i++) { if (String(arr[i].id) === id) { rec = arr[i]; break; } }
      if (!rec || !rec.trip) { _toast('找不到可復原的行程'); return { error: 'not-found' }; }
      var day = rec.day || '';
      // ① 解墓碑（本機＋雲端）——最關鍵，否則同步會把還原的趟再濾掉／再刪
      try { if (global.MaptripSync && MaptripSync.undeleteId) MaptripSync.undeleteId(rec.trip.id); } catch (_) {}
      // ② 寫回本機 raw[day]（依 id 合併、不覆蓋整天）
      try {
        var raw = (global.loadTrips ? loadTrips() : {}) || {};
        var arrDay = (raw[day] || []).slice();
        if (!arrDay.some(function (t) { return t && t.id === rec.trip.id; })) arrDay.push(rec.trip);
        arrDay.sort(function (a, b) { return (a && a.startTime || 0) - (b && b.startTime || 0); });
        raw[day] = arrDay;
        if (global.saveTrips) saveTrips(raw);
      } catch (_) {}
      // ③ 重建雲端文件
      try { if (global.MaptripSync && MaptripSync.syncDays) MaptripSync.syncDays([day]); } catch (_) {}
      // ④ 移出回收桶
      return _idbDel(id).then(function () {
        try { if (global.refreshAfterSync) refreshAfterSync(); } catch (_) {}
        return { restored: true, day: day };
      });
    });
  }

  // ── 回收桶面板（UI）──
  function _fmtRemain(ms) {
    var h = Math.floor(ms / 3600000); if (h >= 1) return h + ' 小時後永久刪除';
    var m = Math.max(1, Math.floor(ms / 60000)); return m + ' 分鐘後永久刪除';
  }
  function _fmtTime(ts) { try { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); } catch (_) { return ''; } }
  function _payTag(t) { if (!t) return ''; if (t.paymentMethod === 'card') return '刷卡'; if (t.paymentMethod === 'cash') return '現金'; return t.label || '其他'; }
  function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function openPanel() {
    var ov = document.getElementById('trash-overlay'), dl = document.getElementById('trash-dialog');
    if (!ov || !dl) return;
    ov.style.display = 'block'; dl.style.display = 'block';
    renderPanel();
  }
  function closePanel() {
    var ov = document.getElementById('trash-overlay'), dl = document.getElementById('trash-dialog');
    if (ov) ov.style.display = 'none'; if (dl) dl.style.display = 'none';
  }
  function renderPanel() {
    var body = document.getElementById('trash-body');
    if (!body) return;
    body.innerHTML = '<div class="sync-hint" style="text-align:center;padding:12px">讀取中…</div>';
    list().then(function (arr) {
      if (!arr.length) { body.innerHTML = '<div class="empty-state">沒有可復原的行程</div>'; return; }
      body.innerHTML = arr.map(function (r) {
        var t = r.trip || {};
        var fareTxt = t.fare ? ('NT$ ' + t.fare + ' ' + _payTag(t)) : (t.label || '其他');
        return '<div class="trash-row">' +
          '<div class="trash-meta"><div class="trash-t">' + _esc(r.day) + '　' + _fmtTime(t.startTime) + '</div>' +
          '<div class="trash-sub">' + _esc(fareTxt) + '　·　' + _esc(_fmtRemain(r.remainMs)) + '</div></div>' +
          '<button class="trash-restore" onclick="MaptripTrash.uiRestore(\'' + encodeURIComponent(r.id) + '\')">復原</button>' +
          '</div>';
      }).join('');
    });
  }
  function uiRestore(encId) {
    var id = decodeURIComponent(encId);
    restore(id).then(function (res) {
      if (res && res.restored) { _toast('已復原行程'); try { if (global.renderHistorySheet) renderHistorySheet(true); } catch (_) {} try { if (global.renderTripSheet) renderTripSheet(); } catch (_) {} }
      renderPanel();
    });
  }

  global.MaptripTrash = {
    init: init, push: push, list: list, count: count, purgeExpired: purgeExpired,
    restore: restore, remove: remove, clear: clear,
    openPanel: openPanel, closePanel: closePanel, renderPanel: renderPanel, uiRestore: uiRestore,
    _fmtRemain: _fmtRemain, TTL_MS: TTL_MS
  };

})(typeof window !== 'undefined' ? window : globalThis);
