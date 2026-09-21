/* =============================================================
 * day-boundary.js — 換日分段（MaptripDayBoundary）
 * -------------------------------------------------------------
 * 換日規則：不再只看單筆時間，而是「這趟 startTime 距前一趟 endTime ≥ 6 小時
 *   → 起算新的一天」。可被每趟的 t.newDay 手動覆蓋（true 強制起新日 / false 強制併回）。
 *
 * 【範圍 A（老闆拍板）】只用在「跑車天數 / 月報表天數 / 歷史顯示分段」這層；
 *   本機/雲端仍以 07:00 businessDayKey 當儲存主鍵，完全不動、不遷移雲端 → 可回退。
 *
 * 全純函式（不碰 DOM/網路），好測：
 *   - sessionize(trips, gapHours)     ：一串趟 → 依規則切成多段（每段＝一「天」）
 *   - sessionKey(firstTrip, seqInDay) ：段的 key，仍以 YYYY-MM-DD 起頭（同日多段加後綴）
 *   - countSessions(tripArrays, gap)  ：多個「日桶趟陣列」→ 有載客的段數合計（＝跑車天數）
 *   - countWorkDays(daysObj, gap)     ：{day:trips} → 同上（物件版）
 * ============================================================= */
(function (global) {
  'use strict';

  var GAP_HOURS = 6;
  var DAY_SPLIT_HOUR = 7;   // 與 storage.js businessDayKey 一致（後綴 fallback 用）
  // 觸發條件收窄（使用者定案）：只有「這趟在 07:00 前開始（＝凌晨、跨日）且距前一趟結束
  // 超過 6 小時」才自動切新的一天。白天的長休息（兩趟都在 07:00 後）不再被切成兩天。
  var SPLIT_BEFORE_HOUR = DAY_SPLIT_HOUR;   // 07:00

  function _endOf(t) {
    // gap 用「本趟 startTime − 前一趟 endTime」；缺 endTime 用 startTime 保底
    var e = (t && typeof t.endTime === 'number') ? t.endTime : (t && t.startTime);
    return (typeof e === 'number') ? e : 0;
  }

  // 純函式：trips 已含 startTime/endTime、可含 newDay 覆蓋旗標。回傳每段（＝一「天」）的趟陣列。
  //   1) 第一趟 → 一定開新段。
  //   2) t.newDay === true  → 強制開新段（手動覆蓋）。
  //   3) t.newDay === false → 強制不開新段、併回目前這段（手動覆蓋）。
  //   4) 否則（undefined）→ 自動：本趟 startTime − 前一趟 endTime ≥ gapMs 就開新段。
  function sessionize(trips, gapHours) {
    var gapMs = (gapHours == null ? GAP_HOURS : gapHours) * 3600 * 1000;
    var arr = (trips || []).filter(function (t) { return t && typeof t.startTime === 'number'; })
      .slice().sort(function (a, b) { return a.startTime - b.startTime; });
    var segs = [], cur = null, prevEnd = null;
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i], open;
      if (i === 0) open = true;
      else if (t.newDay === true) open = true;
      else if (t.newDay === false) open = false;
      else {
        // 自動：只在「凌晨（07:00 前開始）＋距前一趟結束超過 6 小時」才切新的一天
        var hr = new Date(t.startTime).getHours();
        open = (hr < SPLIT_BEFORE_HOUR) && ((t.startTime - prevEnd) > gapMs);
      }
      if (open) { cur = []; segs.push(cur); }
      cur.push(t);
      prevEnd = _endOf(t);
    }
    return segs;
  }

  // 段的 key：以段第一趟的 07:00 businessDayKey 為底；同日第 2 段起加後綴 #2/#3…
  // 保證前 10 碼仍是 YYYY-MM-DD（finance slice(0,7) 分月不受影響）。
  function _bdk(ts) {
    if (global.MaptripStorage && global.MaptripStorage.businessDayKey) return global.MaptripStorage.businessDayKey(ts);
    var d = new Date(ts - DAY_SPLIT_HOUR * 3600 * 1000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function sessionKey(firstTrip, seqInDay) {
    var base = _bdk(firstTrip && firstTrip.startTime);
    return (seqInDay && seqInDay > 0) ? (base + '#' + (seqInDay + 1)) : base;
  }

  // 一段是否算「跑車」：至少一趟非「其他」（自用/非載客）。
  function _isWorkSeg(seg) {
    return (seg || []).some(function (t) { return t && t.paymentMethod !== 'other'; });
  }

  // 多個「日桶趟陣列」→ 有載客的段數合計（＝跑車天數）。每個日桶各自 sessionize。
  function countSessions(tripArrays, gapHours) {
    var n = 0;
    (tripArrays || []).forEach(function (arr) {
      sessionize(arr, gapHours).forEach(function (seg) { if (_isWorkSeg(seg)) n++; });
    });
    return n;
  }
  // 物件版：{ 'YYYY-MM-DD': trips[] } → 跑車天數。
  function countWorkDays(daysObj, gapHours) {
    return countSessions(Object.keys(daysObj || {}).map(function (d) { return daysObj[d]; }), gapHours);
  }

  // ===== 換日「遷移」重算（範圍 B）：把 07:00 主鍵改成 gap-aware 真實日曆日 =====
  // 真實日曆日（不做 07:00 位移）。
  function _calDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // 單趟的「新日 key」（gap-aware）：prevEnd/prevKey＝時間排序後前一趟的結束時間與其新 key。
  //   規則：凌晨（07:00 前）延續前一段（gap≤6h，或 newDay===false）→ 沿用前一段的 key；
  //         否則為新的一天：07:00 前用真實日曆日（隔天）、07:00 後用 businessDayKey（＝當日）。
  function dayKeyFor(t, prevEnd, prevKey, gapHours) {
    var gapMs = (gapHours == null ? GAP_HOURS : gapHours) * 3600 * 1000;
    var hr = new Date(t.startTime).getHours();
    var cont;
    if (t.newDay === true) cont = false;                       // 手動強制起新日
    else if (t.newDay === false) cont = (prevKey != null);     // 手動強制併回前一段
    else cont = (prevKey != null) && (hr < SPLIT_BEFORE_HOUR) && ((t.startTime - prevEnd) <= gapMs);
    if (cont) return prevKey;
    return (hr < SPLIT_BEFORE_HOUR) ? _calDate(t.startTime) : _bdk(t.startTime);
  }
  // 純函式：把整份 days（07:00 主鍵）依新規則重算分桶。
  //   回 { newDays, moves:[{id,from,to}], changedKeys:[受影響的舊/新桶] }。
  //   無 startTime 的趟原桶保留（不丟資料、不移動）。
  function remap(daysObj, gapHours) {
    var valid = [], newDays = {};
    Object.keys(daysObj || {}).forEach(function (k) {
      (daysObj[k] || []).forEach(function (t) {
        if (t && typeof t.startTime === 'number') valid.push({ t: t, from: k });
        else { (newDays[k] = newDays[k] || []).push(t); }   // 無時間戳：留原桶
      });
    });
    valid.sort(function (a, b) { return a.t.startTime - b.t.startTime; });
    var prevEnd = null, prevKey = null, moves = [], changed = {};
    valid.forEach(function (x) {
      var to = dayKeyFor(x.t, prevEnd, prevKey, gapHours);
      (newDays[to] = newDays[to] || []).push(x.t);
      if (to !== x.from) { moves.push({ id: x.t.id, from: x.from, to: to }); changed[x.from] = 1; changed[to] = 1; }
      prevEnd = _endOf(x.t); prevKey = to;
    });
    Object.keys(newDays).forEach(function (k) {
      newDays[k].sort(function (a, b) { return (a && a.startTime || 0) - (b && b.startTime || 0); });
    });
    return { newDays: newDays, moves: moves, changedKeys: Object.keys(changed) };
  }

  global.MaptripDayBoundary = {
    GAP_HOURS: GAP_HOURS,
    sessionize: sessionize,
    sessionKey: sessionKey,
    countSessions: countSessions,
    countWorkDays: countWorkDays,
    dayKeyFor: dayKeyFor,
    remap: remap,
    _calDate: _calDate,
    _isWorkSeg: _isWorkSeg
  };

})(typeof window !== 'undefined' ? window : globalThis);
