/* =============================================================
 * migrate-day.js — 換日規則一次性遷移（MaptripMigrateDay）
 * -------------------------------------------------------------
 * 把既有資料的儲存主鍵從「07:00 businessDayKey」改成 gap-aware 真實日曆日
 * （凌晨 07:00 前開始且距前一趟超過 6h ＝ 移到隔天的真實日期）。範圍 B、動雲端。
 *
 * 安全設計（血淚，務必保留）：
 *   - 一次性旗標 maptrip_daymigrate_v1，跑過就不再跑。
 *   - 動手前自動快照（MaptripBackup.snapshot），使用者事前也已手動匯出 JSON。
 *   - 本機先換桶（TripStore.setAll），雲端用 MaptripSync.overwriteDays（停監聽→覆寫，
 *     不 merge）把「變動的日子」改成新內容、清空的桶刪除 → 舊桶那筆真的搬走、不會被同步併回。
 *   - 雲端失敗 → 用快照就地還原本機，避免本機/雲端不一致。
 *   - 提供 restorePremigrate()：還原本機＋把變動日子覆寫回遷移前內容，並清旗標可重跑。
 *   - UI：confirmAndRun() 先預覽（搬幾趟、是否跨月）＋確認才執行。
 * ============================================================= */
(function (global) {
  'use strict';

  var FLAG = 'maptrip_daymigrate_v1';
  var CHANGED_KEY = 'maptrip_daymigrate_changed';   // 記這次動到哪些桶，供還原精準覆寫

  function _toast(m) { try { if (global.toast) global.toast(m); } catch (_) {} }
  function isDone() { try { return localStorage.getItem(FLAG) === '1'; } catch (_) { return false; } }
  function _markDone() { try { localStorage.setItem(FLAG, '1'); } catch (_) {} }
  function _loggedIn() { try { return !!(global.MaptripSync && MaptripSync.myUid && MaptripSync.myUid()); } catch (_) { return false; } }
  function hasSnapshot() { try { return !!(global.MaptripBackup && MaptripBackup.readSnapshot && MaptripBackup.readSnapshot('premigrate')); } catch (_) { return false; } }

  function _compute() {
    var days = (global.loadTrips ? loadTrips() : {}) || {};
    return global.MaptripDayBoundary.remap(days);
  }

  // 預覽：回 { moveCount, byPair:{'from → to':n}, crossMonth, changedKeys }
  function preview() {
    var r = _compute(), byPair = {}, crossMonth = 0;
    r.moves.forEach(function (m) {
      var k = m.from + ' → ' + m.to; byPair[k] = (byPair[k] || 0) + 1;
      if (String(m.from).slice(0, 7) !== String(m.to).slice(0, 7)) crossMonth++;
    });
    return { moveCount: r.moves.length, byPair: byPair, crossMonth: crossMonth, changedKeys: r.changedKeys };
  }

  // 執行遷移（async）。回 { moved } / { skipped } / { error }。
  // 累積「動過的桶」union（可重複執行 → 還原要能覆蓋歷次動過的所有桶）。
  function _mergeChanged(keys) {
    var set = {};
    try { (JSON.parse(localStorage.getItem(CHANGED_KEY) || '[]') || []).forEach(function (k) { set[k] = 1; }); } catch (_) {}
    (keys || []).forEach(function (k) { set[k] = 1; });
    return Object.keys(set);
  }
  // 可重複執行、自動修復：把「凌晨隔 >6h」還卡在前一天的趟搬到隔天。無論舊資料殘留、
  // 或遷移後~gap-aware 存檔上線前的過渡趟，都能再按一次整理乾淨（idempotent，沒東西可搬＝no-op）。
  async function run() {
    if (!_loggedIn()) { _toast('請先登入雲端再整理'); return { error: 'no-user' }; }
    var r = _compute();
    if (!r.moves.length) { _markDone(); _toast('沒有需要搬到隔天的凌晨行程'); return { moved: 0 }; }
    // 只在「第一次」存快照，保留最初（未整理前）的原始資料，供還原
    try { if (global.MaptripBackup && !hasSnapshot()) MaptripBackup.snapshot('premigrate'); } catch (_) {}
    try { localStorage.setItem(CHANGED_KEY, JSON.stringify(_mergeChanged(r.changedKeys))); } catch (_) {}
    try { if (global.TripStore && TripStore.setAll) TripStore.setAll(r.newDays); } catch (_) {}   // 本機先換桶
    try {
      await MaptripSync.overwriteDays(r.changedKeys, r.newDays);                                   // 雲端覆寫變動的日子
    } catch (e) {
      try { if (global.MaptripBackup) MaptripBackup.restoreSnapshot('premigrate'); } catch (_) {}
      _toast('整理失敗，已還原本機：' + ((e && e.message) || '雲端寫入錯誤'));
      return { error: (e && e.message) || 'overwrite-failed' };
    }
    _markDone();
    try { if (global.refreshAfterSync) refreshAfterSync(); } catch (_) {}
    _toast('已把 ' + r.moves.length + ' 趟凌晨行程搬到隔天');
    return { moved: r.moves.length };
  }

  // UI：預覽 + 確認才執行。
  function confirmAndRun() {
    if (!_loggedIn()) { _toast('請先登入雲端再整理'); return; }
    var p = preview();
    if (!p.moveCount) { _markDone(); _toast('目前沒有需要搬到隔天的凌晨行程'); if (global.renderSyncPanel) renderSyncPanel(); return; }
    var lines = Object.keys(p.byPair).slice(0, 8).map(function (k) { return '　' + k + '：' + p.byPair[k] + ' 趟'; }).join('\n');
    var extra = Object.keys(p.byPair).length > 8 ? '\n　…' : '';
    var cross = p.crossMonth ? ('\n（其中 ' + p.crossMonth + ' 趟跨月，該月報表數字會變動）') : '';
    var msg = '換日整理\n\n將把 ' + p.moveCount + ' 趟凌晨(隔超過 6h)的行程從「前一天」搬到「隔天」，' +
      '前後兩天的工時才正確：\n' + lines + extra + cross + '\n\n確定執行？';
    var okGo = true; try { okGo = confirm(msg); } catch (_) {}
    if (okGo) run().then(function () { if (global.renderSyncPanel) renderSyncPanel(); });
  }

  // 還原遷移前（本機 + 把當初動過的桶覆寫回遷移前內容），並清旗標可重跑。
  async function restorePremigrate() {
    if (!hasSnapshot()) { _toast('找不到遷移前快照'); return { error: 'no-snapshot' }; }
    var snap = MaptripBackup.readSnapshot('premigrate');
    var changed = [];
    try { changed = JSON.parse(localStorage.getItem(CHANGED_KEY) || '[]'); } catch (_) {}
    try { if (global.TripStore && TripStore.setAll) TripStore.setAll(snap.days || {}); } catch (_) {}
    if (_loggedIn() && changed.length) {
      try { await MaptripSync.overwriteDays(changed, snap.days || {}); }
      catch (e) { _toast('還原雲端失敗：' + ((e && e.message) || '')); return { error: 'cloud' }; }
    }
    try { localStorage.removeItem(FLAG); } catch (_) {}
    try { if (global.refreshAfterSync) refreshAfterSync(); } catch (_) {}
    _toast('已還原整理前資料');
    return { restored: true };
  }

  global.MaptripMigrateDay = {
    isDone: isDone, hasSnapshot: hasSnapshot, preview: preview,
    run: run, confirmAndRun: confirmAndRun, restorePremigrate: restorePremigrate, _compute: _compute
  };

})(typeof window !== 'undefined' ? window : globalThis);
