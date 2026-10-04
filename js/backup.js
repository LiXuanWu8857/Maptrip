/* =============================================================
 * backup.js — 行程資料備份/還原（MaptripBackup）
 * -------------------------------------------------------------
 * 目的：在做「換日規則遷移」這種不可逆、動到主鍵/雲端的動作前，先讓使用者
 *   把全部資料匯出成一個 JSON 檔存起來（可離線保存、可還原）。
 *
 *   - collect()      ：把本機（＝已與雲端合併同步）的行程/支出/刪除墓碑打包成一個物件（純函式，好測）
 *   - exportFile()   ：collect() → JSON 檔，iOS 優先走分享(存到「檔案」App/雲端)、否則下載
 *   - restore(obj)   ：把備份寫回本機 TripStore 並重新同步回雲端（誤遷移時救援）
 *   - snapshot(tag)  ：把目前資料存一份到本機（遷移前自動快照，供 restoreSnapshot 就地還原）
 *   - restoreSnapshot(tag)
 *
 * 只讀寫既有全域（loadTrips/saveTrips/TripStore/MaptripSync/localStorage），不動 UI。
 * ============================================================= */
(function (global) {
  'use strict';

  var EXPENSE_KEY = 'maptrip_expenses';
  var DELETED_KEY = 'maptrip_deleted';
  var SNAP_PREFIX = 'maptrip_backup_';   // + tag

  function _lsGet(k, dflt) { try { return JSON.parse(localStorage.getItem(k) || dflt); } catch (_) { try { return JSON.parse(dflt); } catch (__) { return null; } } }

  // 純函式：把目前本機資料打包成備份物件。days 來自 loadTrips（開機已聯集雲端）。
  function collect() {
    var days = (global.loadTrips ? global.loadTrips() : {}) || {};
    var expenses = _lsGet(EXPENSE_KEY, '[]') || [];
    var deleted = _lsGet(DELETED_KEY, '[]') || [];
    var uid = '';
    try { uid = (global.MaptripSync && MaptripSync.myUid && MaptripSync.myUid()) || ''; } catch (_) {}
    var dayKeys = Object.keys(days), tripCount = 0;
    dayKeys.forEach(function (d) { tripCount += (days[d] || []).length; });
    return {
      app: 'maptrip', kind: 'backup', schema: 1,
      version: global.INDEX_VERSION || '',
      exportedAt: Date.now(), uid: uid,
      dayCount: dayKeys.length, tripCount: tripCount,
      days: days, expenses: expenses, deleted: deleted
    };
  }

  function _stamp(ts) {
    var d = new Date(ts || Date.now());
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function _download(blob, name) {
    try {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (_) {} }, 4000);
    } catch (_) {}
  }

  // 匯出成 JSON 檔：iOS WKWebView 優先分享（可存到「檔案」App／雲端／傳給自己），否則瀏覽器下載。
  function exportFile() {
    var data = collect();
    var json = JSON.stringify(data);
    var name = 'maptrip-backup-' + _stamp(data.exportedAt) + '.json';
    var blob = new Blob([json], { type: 'application/json' });
    var file = null;
    try { file = new File([blob], name, { type: 'application/json' }); } catch (_) {}
    var shared = false;
    try {
      if (file && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        navigator.share({ files: [file], title: 'Maptrip 備份' }).catch(function () { _download(blob, name); });
        shared = true;
      }
    } catch (_) {}
    if (!shared) _download(blob, name);
    try { if (global.toast) toast('備份 ' + data.tripCount + ' 趟／' + data.dayCount + ' 天'); } catch (_) {}
    return data;
  }

  // 把備份物件寫回本機並重新同步回雲端（誤遷移救援）。回傳寫回天數。
  function restore(obj) {
    if (!obj || obj.kind !== 'backup' || !obj.days) throw new Error('備份檔格式不符');
    if (global.TripStore && TripStore.setAll) TripStore.setAll(obj.days);
    else if (global.saveTrips) global.saveTrips(obj.days);
    if (obj.expenses) { try { localStorage.setItem(EXPENSE_KEY, JSON.stringify(obj.expenses)); } catch (_) {} }
    if (obj.deleted) { try { localStorage.setItem(DELETED_KEY, JSON.stringify(obj.deleted)); } catch (_) {} }
    try { if (global.MaptripSync && MaptripSync.syncDays) MaptripSync.syncDays(Object.keys(obj.days)); } catch (_) {}
    try { if (global.refreshAfterSync) global.refreshAfterSync(); } catch (_) {}
    return { days: Object.keys(obj.days).length };
  }

  // 遷移前自動快照到本機（不需使用者操作；供程式就地還原）。回傳是否成功。
  function snapshot(tag) {
    try { localStorage.setItem(SNAP_PREFIX + (tag || 'premigrate'), JSON.stringify(collect())); return true; }
    catch (_) { return false; }   // 資料太大 localStorage 塞不下 → 交回呼叫端改走匯出檔
  }
  function readSnapshot(tag) { return _lsGet(SNAP_PREFIX + (tag || 'premigrate'), 'null'); }
  function restoreSnapshot(tag) {
    var s = readSnapshot(tag);
    if (!s) throw new Error('找不到快照');
    return restore(s);
  }

  global.MaptripBackup = {
    collect: collect, exportFile: exportFile, restore: restore,
    snapshot: snapshot, readSnapshot: readSnapshot, restoreSnapshot: restoreSnapshot,
    _stamp: _stamp
  };

})(typeof window !== 'undefined' ? window : globalThis);
