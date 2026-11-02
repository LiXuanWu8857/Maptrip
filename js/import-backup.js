/* =============================================================
 * import-backup.js — 匯入備份 / 還原行程（含路線、解墓碑）（MaptripImport）
 * -------------------------------------------------------------
 * App 只有「匯出」沒有「匯入」，被刪的行程（含 GPS 路線）救不回。
 * 本模組讓使用者在同步面板選一個備份 .json → 依「趟 id 合併」回本機/雲端：
 *   - 合併不覆蓋：備份有、本機沒有的 id 才補進來；同 id 保留本機（不覆蓋較新）。
 *   - 解墓碑：實際補回的 id 從 maptrip_deleted（本機＋雲端 pushDeleted）移除，
 *     否則同步會把剛救回的趟再刪掉——這是「被刪救不回」的靈魂。
 *   - 只用備份的 days；忽略備份自帶的 deleted（套用可能反而清掉現有資料）。
 *   - 跨帳號需確認（比對 uid），避免污染雲端。
 *   - 趟經 serializeTrip 正規化（保留完整 coords＝路線；不重算里程/金額）。
 *
 * 純函式 planImport() 供測試；其餘為檔案選取/存檔/上雲的接線。
 * ============================================================= */
(function (global) {
  'use strict';

  var DELETED_KEY = 'maptrip_deleted';

  function _valid(b) {
    return !!(b && b.app === 'maptrip' && b.kind === 'backup' && b.days &&
      typeof b.days === 'object' && !Array.isArray(b.days));
  }

  // 純函式：規劃匯入結果。不寫任何東西，只算出「合併後的 days、要補的 id、受影響的日子」。
  //   backup      ：備份物件（§1 schema）
  //   currentRaw  ：目前本機 days（loadTrips() 結果；{ dayKey: [trip,...] }）
  //   currentUid  ：目前登入 uid（用於跨帳號比對）
  //   opts.serialize ：正規化函式（預設用全域 serializeTrip；無則原樣帶入）
  //   opts.deletedIds：目前墓碑 id 陣列（算「救回幾筆先前刪除的」）
  function planImport(backup, currentRaw, currentUid, opts) {
    opts = opts || {};
    if (!_valid(backup)) return { ok: false, reason: 'invalid' };
    var serialize = opts.serialize || (typeof global.serializeTrip === 'function' ? global.serializeTrip : function (t) { return t; });
    var deletedSet = new Set((opts.deletedIds || []).filter(function (v) { return v != null; }));

    // 深拷貝本機 days（不動原物件），逐日以 id 合併
    var merged = {};
    var src = currentRaw || {};
    Object.keys(src).forEach(function (d) { merged[d] = (src[d] || []).slice(); });

    var addedIds = [], affected = {}, totalInBackup = 0, restoredCount = 0;
    var bdays = backup.days;
    Object.keys(bdays).forEach(function (day) {
      var list = bdays[day] || [];
      if (!Array.isArray(list)) return;
      var have = merged[day] || (merged[day] = []);
      var haveIds = new Set(have.map(function (t) { return t && t.id; }));
      list.forEach(function (t) {
        if (!t || t.id == null) return;
        totalInBackup++;
        if (haveIds.has(t.id)) return;         // 同 id 已存在 → 不覆蓋本機
        var norm;
        try { norm = serialize(t); } catch (_) { norm = t; }
        have.push(norm);
        haveIds.add(t.id);
        addedIds.push(t.id);
        affected[day] = true;
        if (deletedSet.has(t.id)) restoredCount++;   // 這 id 本來被刪 → 這次是「救回」
      });
    });

    var backupUid = backup.uid || '';
    var crossAccount = !!(backupUid && currentUid && backupUid !== currentUid);
    return {
      ok: true, merged: merged,
      addedIds: addedIds, addedCount: addedIds.length,
      affectedDays: Object.keys(affected),
      restoredCount: restoredCount,
      totalInBackup: totalInBackup,
      crossAccount: crossAccount, backupUid: backupUid
    };
  }

  function _lsDeletedIds() {
    try { return JSON.parse(localStorage.getItem(DELETED_KEY) || '[]').map(function (d) { return d && d.id; }).filter(function (v) { return v != null; }); }
    catch (_) { return []; }
  }

  // 執行匯入（會寫本機/雲端）。回傳 summary；失敗丟例外或回 {ok:false}。
  //   跳過跨帳號確認：預設 confirm；opts.force=true 免問（測試用）。
  function runImport(backup, opts) {
    opts = opts || {};
    if (!_valid(backup)) { _toast('這不是有效的備份檔'); return { ok: false, reason: 'invalid' }; }

    var currentRaw = (global.loadTrips ? global.loadTrips() : {}) || {};
    var currentUid = null;
    try { currentUid = (global.MaptripSync && MaptripSync.myUid && MaptripSync.myUid()) || null; } catch (_) {}
    var serialize = (typeof global.serializeTrip === 'function') ? global.serializeTrip : null;

    var plan = planImport(backup, currentRaw, currentUid, { serialize: serialize, deletedIds: _lsDeletedIds() });
    if (!plan.ok) { _toast('這不是有效的備份檔'); return plan; }

    // 跨帳號攔截：不同 uid 需確認，避免把別帳號資料灌進雲端（§10 帳號隔離）
    if (plan.crossAccount && !opts.force) {
      var proceed = false;
      try { proceed = (typeof confirm === 'function') && confirm('這份備份屬於其他帳號，仍要匯入嗎？（可能把別帳號的行程灌進目前帳號的雲端）'); } catch (_) {}
      if (!proceed) return { ok: false, reason: 'cross-account-cancel' };
    }

    if (plan.addedCount === 0) {
      _toast('備份裡沒有本機缺少的行程（' + plan.totalInBackup + ' 趟都已存在）');
      return { ok: true, addedCount: 0, restoredCount: 0 };
    }

    // 1) 存檔（合併結果）；存不下先壓實再試一次
    _saveWithCompact(plan.merged);

    // 2) 解墓碑：實際補回的 id 從本機墓碑移除，最後推一次雲端墓碑
    try {
      var addedSet = new Set(plan.addedIds);
      var kept = _lsDeletedIds().filter(function (id) { return !addedSet.has(id); }).map(function (id) { return { id: id, at: Date.now() }; });
      localStorage.setItem(DELETED_KEY, JSON.stringify(kept));
    } catch (_) {}
    try { if (global.MaptripSync && MaptripSync.pushDeleted) MaptripSync.pushDeleted(); } catch (_) {}

    // 3) 上雲（只推受影響的日子）
    try { if (global.MaptripSync && MaptripSync.syncDays) MaptripSync.syncDays(plan.affectedDays); } catch (_) {}

    // 4) 重畫
    try { if (global.refreshAfterSync) global.refreshAfterSync(); } catch (_) {}

    _toast('已匯入 ' + plan.addedCount + ' 筆行程' + (plan.restoredCount ? '，還原 ' + plan.restoredCount + ' 筆先前刪除的' : ''));
    return { ok: true, addedCount: plan.addedCount, restoredCount: plan.restoredCount, affectedDays: plan.affectedDays };
  }

  function _saveWithCompact(merged) {
    try {
      if (global.saveTrips) global.saveTrips(merged);
      else if (global.TripStore && TripStore.setAll) TripStore.setAll(merged);
    } catch (e) {
      // localStorage/IndexedDB 撐爆 → 壓實再試一次
      try { if (global.compactStorage) global.compactStorage(true); } catch (_) {}
      try {
        if (global.saveTrips) global.saveTrips(merged);
        else if (global.TripStore && TripStore.setAll) TripStore.setAll(merged);
      } catch (_) { _toast('儲存空間不足，匯入未完成'); throw e; }
    }
  }

  function _toast(m) { try { if (global.toast) global.toast(m); } catch (_) {} }

  // 從文字（檔案內容）匯入：parse + runImport，壞檔給 toast。
  function importFromText(text, opts) {
    var obj;
    try { obj = JSON.parse(text); } catch (_) { _toast('備份檔讀取失敗（不是有效的 JSON）'); return { ok: false, reason: 'parse' }; }
    return runImport(obj, opts);
  }

  // UI：觸發隱藏 file input 選 .json → 讀檔 → importFromText。
  function pickFile() {
    var input = document.getElementById('import-backup-file');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.id = 'import-backup-file';
      input.style.display = 'none';
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) return;
        var r = new FileReader();
        r.onload = function () { try { importFromText(String(r.result || '')); } catch (_) { _toast('備份檔讀取失敗'); } input.value = ''; };
        r.onerror = function () { _toast('備份檔讀取失敗'); input.value = ''; };
        r.readAsText(f);
      });
      document.body.appendChild(input);
    }
    try { input.value = ''; } catch (_) {}
    input.click();
  }

  global.MaptripImport = {
    planImport: planImport,
    runImport: runImport,
    importFromText: importFromText,
    pickFile: pickFile,
    _valid: _valid
  };

})(typeof window !== 'undefined' ? window : globalThis);
