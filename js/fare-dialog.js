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
  let _tipMethod = 'cash';   // 小費/加收的付款方式（預設現金）

  function updateTipToggle() {
    const btn = document.getElementById('fare-tip-method');
    if (!btn) return;
    btn.classList.toggle('on', _tipMethod === 'cash');   // 現金亮起
    btn.querySelector('.fare-toggle-val').textContent = _tipMethod === 'cash' ? '現金' : '刷卡';
  }
  function toggleTipMethod() { _tipMethod = _tipMethod === 'cash' ? 'card' : 'cash'; updateTipToggle(); }
  function _readTip() {
    return { tip: parseInt((document.getElementById('fare-tip') || {}).value) || 0, tipMethod: _tipMethod };
  }
  function _setTip(tip, method) {
    const el = document.getElementById('fare-tip'); if (el) el.value = tip || '';
    _tipMethod = (method === 'card') ? 'card' : 'cash';
    updateTipToggle();
  }

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

  // ---- 現金鈕「長按」切換紙本簽單（v1.1.440）----
  // 單擊＝立即用目前模式存檔（現金或紙本簽單）；長按 LONG_MS＝切換 現金 ⇄ 紙本簽單、不存檔。
  // 紙本簽單＝paymentMethod 'voucher'，與現金/刷卡分開統計。
  const LONG_MS = 500;
  let _cashMode = 'cash';     // 'cash' | 'voucher'
  let _lpTimer = null, _lpFired = false, _lpAt = 0;   // _lpAt＝長按切換的時間（之後 700ms 內的 click 全忽略）
  function _updateCashBtn(btn) {
    btn = btn || document.getElementById('fare-cash');
    if (!btn) return;
    const v = _cashMode === 'voucher';
    btn.textContent = v ? '紙本簽單' : '現金';
    btn.classList.toggle('voucher', v);
    btn.title = '長按切換 現金／紙本簽單';
  }
  function _cashModeOf() { return _cashMode; }
  function _lpCancel() { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } }
  // 長按事件只綁一次（同一顆 DOM 鈕），存檔動作每次開對話框換新 → 存在 btn._mtOnSave
  function _wireLongPress(btn) {
    if (btn._mtLpWired) return;
    btn._mtLpWired = true;
    const start = () => {
      _lpFired = false; _lpCancel();
      _lpTimer = setTimeout(() => {
        _lpTimer = null; _lpFired = true; _lpAt = Date.now();
        _cashMode = _cashMode === 'voucher' ? 'cash' : 'voucher';
        _updateCashBtn(btn);
        try { if (navigator.vibrate) navigator.vibrate(30); } catch (_) {}
      }, LONG_MS);
    };
    let sx = 0, sy = 0, lastTouch = 0;
    btn.addEventListener('touchstart', (e) => { lastTouch = Date.now(); const t = e.touches[0]; sx = t.clientX; sy = t.clientY; start(); }, { passive: true });
    btn.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) _lpCancel(); }, { passive: true });
    btn.addEventListener('touchend', () => { lastTouch = Date.now(); _lpCancel(); });
    btn.addEventListener('touchcancel', _lpCancel);
    // 電腦滑鼠；觸控後瀏覽器補發的模擬 mousedown 要忽略（否則會把「已長按」旗標清掉→放手時誤存檔）
    btn.addEventListener('mousedown', (e) => { if (e.button === 0 && Date.now() - lastTouch > 1000) start(); });
    btn.addEventListener('mouseup', _lpCancel);
    btn.addEventListener('mouseleave', _lpCancel);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());   // 長按不跳系統選單
    btn.addEventListener('click', () => {
      _lpCancel();
      // 長按切換後放手產生的 click（瀏覽器可能補發不只一次）→ 不存檔
      if (_lpFired || Date.now() - _lpAt < 700) { _lpFired = false; return; }
      if (btn._mtOnSave) btn._mtOnSave(_cashMode);
    });
  }
  // 綁定現金鈕：onSave(paymentMethod) 由呼叫端提供（完成對話框或編輯對話框）
  function bindCashButton(btn, initialMode, onSave) {
    if (!btn) return;
    _cashMode = initialMode === 'voucher' ? 'voucher' : 'cash';
    _lpCancel(); _lpFired = false; _lpAt = 0;
    btn.onclick = null;
    btn._mtOnSave = onSave;
    _wireLongPress(btn);
    _updateCashBtn(btn);
  }

  function showFareDialog(trip) {
    document.getElementById('fs-start').textContent  = fmtTime(trip.startTime);
    document.getElementById('fs-end').textContent    = fmtTime(trip.endTime);
    document.getElementById('fs-dur').textContent    = fmtDur(trip.endTime - trip.startTime);
    document.getElementById('fs-dist').textContent   = fmtDist(trip.totalDist);
    document.getElementById('fare-input').value = '';
    _setFareExtra(0, DISPATCH_FEE);   // 叫車費預設「有」10 元；沒叫車費再點一下關掉
    _setTip(0, 'cash');            // 小費/加收預設 0、現金
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
      const tp = _readTip();
      document.getElementById('fare-overlay').style.display = 'none';
      document.getElementById('fare-dialog').classList.remove('show');
      finalizeSavedTrip(trip, fare, paymentMethod, label || '', ex.commission, ex.dispatch, tp.tip, tp.tipMethod);
    };

    bindCashButton(cashBtn, 'cash', (pm) => save(parseInt(document.getElementById('fare-input').value) || 0, pm));
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
    toggleTipMethod: toggleTipMethod,
    _readFareExtra: _readFareExtra,
    _setFareExtra: _setFareExtra,
    _readTip: _readTip,
    _setTip: _setTip,
    _showCommissionField: _showCommissionField,
    showFareDialog: showFareDialog,
    bindCashButton: bindCashButton,
    _cashModeOf: _cashModeOf,
    LONG_MS: LONG_MS
  };

})(typeof window !== 'undefined' ? window : globalThis);
