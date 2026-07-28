/* =============================================================
 * fare-dialog.js — 行程完成後的車資對話框（叫車費切換 / 抽成欄 / 付款）
 * -------------------------------------------------------------
 * 從 app.js v1.1.259 逐字抽出（body 與原版相同）。只碰 DOM 與全域工具/落盤函式
 * （fmtTime/fmtDur/fmtDist/finalizeSavedTrip，執行期由 window 取用），不碰 map、無需注入。
 * 掛 window.MaptripFareDialog；app.js 留同名薄包裝轉呼叫，呼叫端（含 HTML onclick）零改動。
 * 叫車費開關狀態 _dispatchOn/_dispatchAmt 為模組私有（只有本對話框用到）。
 * ============================================================= */
(function (global) {
  'use strict';

  // 叫車費：固定 10 元，用切換按鈕決定「有／無」（司機不必每趟打字）
  const DISPATCH_FEE = 10;
  let _dispatchOn = false;   // 車資對話框目前叫車費開關
  let _dispatchAmt = DISPATCH_FEE;  // 目前金額（載入舊趟時沿用該趟的值）

  function updateDispatchToggle() {
    const btn = document.getElementById('fare-dispatch-toggle');
    if (!btn) return;
    btn.classList.toggle('on', _dispatchOn);
    btn.querySelector('.fare-toggle-val').textContent = _dispatchOn ? ('$' + _dispatchAmt) : '無';
  }
  function toggleDispatch() {
    _dispatchOn = !_dispatchOn;
    if (_dispatchOn && (!_dispatchAmt || _dispatchAmt <= 0)) _dispatchAmt = DISPATCH_FEE;
    updateDispatchToggle();
  }

  // 讀 / 寫車資對話框的「抽成 / 叫車費」欄位
  function _readFareExtra() {
    return {
      commission: parseInt(document.getElementById('fare-commission').value) || 0,
      dispatch: _dispatchOn ? (_dispatchAmt || DISPATCH_FEE) : 0
    };
  }
  function _setFareExtra(commission, dispatch) {
    document.getElementById('fare-commission').value = commission || '';
    _dispatchOn = (dispatch || 0) > 0;
    _dispatchAmt = _dispatchOn ? dispatch : DISPATCH_FEE;
    updateDispatchToggle();
  }
  // 控制抽成欄位顯示：完成當下隱藏（抽成兩天後才知道，改在歷史批次補），編輯時顯示
  function _showCommissionField(show) {
    const wrap = document.getElementById('fare-commission-wrap');
    if (wrap) wrap.style.display = show ? '' : 'none';
  }

  function showFareDialog(trip) {
    document.getElementById('fs-start').textContent  = fmtTime(trip.startTime);
    document.getElementById('fs-end').textContent    = fmtTime(trip.endTime);
    document.getElementById('fs-dur').textContent    = fmtDur(trip.endTime - trip.startTime);
    document.getElementById('fs-dist').textContent   = fmtDist(trip.totalDist);
    document.getElementById('fare-input').value = '';
    _setFareExtra(0, DISPATCH_FEE);   // 叫車費預設「有」10 元；沒叫車費再點一下關掉
    _showCommissionField(false);   // 完成當下不問抽成（兩天後才知道）

    document.getElementById('fare-overlay').style.display = 'block';
    document.getElementById('fare-dialog').classList.add('show');
    setTimeout(() => document.getElementById('fare-input').focus(), 300);

    const cashBtn = document.getElementById('fare-cash');
    const cardBtn = document.getElementById('fare-card');
    const skipBtn = document.getElementById('fare-skip');

    const save = (fare, paymentMethod, label) => {
      // 行程在 endTrip 時已落盤；這裡立即關閉對話框，車資與貼路在背景補上
      const ex = _readFareExtra();
      document.getElementById('fare-overlay').style.display = 'none';
      document.getElementById('fare-dialog').classList.remove('show');
      finalizeSavedTrip(trip, fare, paymentMethod, label || '', ex.commission, ex.dispatch);
    };

    cashBtn.onclick = () => save(parseInt(document.getElementById('fare-input').value) || 0, 'cash');
    cardBtn.onclick = () => save(parseInt(document.getElementById('fare-input').value) || 0, 'card');
    // 其他：輸入名稱（如「騎腳踏車」），不需金額，時間照算進工作時間
    skipBtn.onclick = () => {
      const name = (prompt('輸入名稱（例如：騎腳踏車）', '') || '').trim();
      save(0, 'other', name);
    };
  }

  global.MaptripFareDialog = {
    DISPATCH_FEE: DISPATCH_FEE,
    updateDispatchToggle: updateDispatchToggle,
    toggleDispatch: toggleDispatch,
    _readFareExtra: _readFareExtra,
    _setFareExtra: _setFareExtra,
    _showCommissionField: _showCommissionField,
    showFareDialog: showFareDialog
  };

})(typeof window !== 'undefined' ? window : globalThis);
