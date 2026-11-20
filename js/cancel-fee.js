// cancel-fee.js — 「取消費用」快速收款：客人取消行程仍收 $40 車資。
// 按下底部列「🚫 取消費用」→ 跳確認框「是否確認乘客已取消？」→ 確認後才記一筆
// $40 刷卡完成紀錄（當下時間、無路線），直接落盤＋上雲＋顯示在今日清單。
// 沿用 app.js 已測試的 saveTripFinal（無座標安全：drawTripLine 略過畫線、清單/金額照常、
// saveTodayToStorage 內含雲端同步）。
(function () {
  'use strict';

  var FEE = 40;             // 取消費用金額（元）
  var PAY = 'card';         // 刷卡
  var LABEL = '取消費用';    // 備註（識別此筆為取消費用）

  var CSS =
    '#cf-ov{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.45);display:flex;' +
      'align-items:center;justify-content:center;padding:24px;}' +
    '#cf-ov .cf-box{background:#fff;color:#1a1a1a;border-radius:16px;padding:22px 20px 16px;' +
      'width:100%;max-width:320px;box-shadow:0 8px 30px rgba(0,0,0,.3);text-align:center;}' +
    '#cf-ov .cf-msg{font-size:17px;font-weight:700;}' +
    '#cf-ov .cf-sub{font-size:13px;color:#5f6368;margin-top:8px;}' +
    '#cf-ov .cf-btns{display:flex;gap:10px;margin-top:20px;}' +
    '#cf-ov .cf-btns button{flex:1;height:44px;border:none;border-radius:12px;font:inherit;' +
      'font-size:15px;font-weight:600;cursor:pointer;}' +
    '#cf-ov .cf-no{background:#f1f3f4;color:#3c4043;}' +
    '#cf-ov .cf-yes{background:#1a73e8;color:#fff;}' +
    '@media (prefers-color-scheme: dark){#cf-ov .cf-box{background:#2a2a2a;color:#e8eaed;}' +
      '#cf-ov .cf-sub{color:#9aa0a6;}#cf-ov .cf-no{background:#3a3a3a;color:#e8eaed;}}';

  var _cssAdded = false, _ov = null;
  function _ensureCss() {
    if (_cssAdded) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); _cssAdded = true;
  }
  function _close() { if (_ov) { _ov.remove(); _ov = null; } }

  // 建立取消費用的紀錄物件（純函式，供測試）；now＝時間戳
  function _build(now) {
    return {
      id: now, startTime: now, endTime: now,
      coords: [], totalDist: 0,
      fare: FEE, paymentMethod: PAY, label: LABEL, cancelFee: true
    };
  }

  // 實際寫入（確認後才呼叫）
  function _commit() {
    if (typeof window.saveTripFinal !== 'function') {
      if (window.toast) window.toast('尚未就緒，稍後再試');
      return;
    }
    var now = Date.now();
    var trip = _build(now);
    trip.id = now + Math.floor(Math.random() * 1000);   // 避免與其他紀錄撞號
    window.saveTripFinal(trip);                          // 落盤＋畫（無座標略過）＋同步
    if (window.toast) window.toast('✓ 已記錄取消費用 NT$' + FEE + '（刷卡）');
  }

  // 按鈕入口：先跳確認框「是否確認乘客已取消？」
  function record() {
    _ensureCss();
    if (_ov) return;   // 已開著就不重複開
    _ov = document.createElement('div'); _ov.id = 'cf-ov';
    _ov.innerHTML =
      '<div class="cf-box">' +
        '<div class="cf-msg">是否確認乘客已取消？</div>' +
        '<div class="cf-sub">確認後將記錄一筆 NT$' + FEE + '（刷卡）</div>' +
        '<div class="cf-btns"><button class="cf-no">取消</button><button class="cf-yes">確認</button></div>' +
      '</div>';
    _ov.querySelector('.cf-no').addEventListener('click', _close);
    _ov.querySelector('.cf-yes').addEventListener('click', function () { _close(); _commit(); });
    _ov.addEventListener('click', function (e) { if (e.target === _ov) _close(); });   // 點框外關閉
    document.body.appendChild(_ov);
  }

  window.MaptripCancelFee = {
    record: record, FEE: FEE, PAY: PAY, LABEL: LABEL,
    _build: _build, _commit: _commit, _close: _close
  };
})();
