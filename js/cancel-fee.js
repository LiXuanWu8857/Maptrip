// cancel-fee.js — 「客人取消」快速收款：一鍵記錄一筆 $40 刷卡收款。
// 情境：客人取消行程仍需收 $40 車資。按下按鈕即以「當下時間、無路線」記一筆完成紀錄，
// 直接落盤＋上雲＋顯示在今日清單，不必手動開始/結束一趟。
// 沿用 app.js 已測試的 saveTripFinal（對無座標行程安全：drawTripLine 會略過畫線、
// 清單與金額照常；saveTodayToStorage 內含雲端同步）。
(function () {
  'use strict';

  var FEE = 40;            // 取消收款金額（元）
  var PAY = 'card';        // 刷卡
  var LABEL = '客人取消';   // 備註（識別此筆為取消收款）

  // 建立取消收款的紀錄物件（純函式，供測試）；now＝時間戳，可注入
  function _build(now) {
    return {
      id: now, startTime: now, endTime: now,
      coords: [], totalDist: 0,
      fare: FEE, paymentMethod: PAY, label: LABEL, cancelFee: true
    };
  }

  function record() {
    if (typeof window.saveTripFinal !== 'function') {
      if (window.toast) window.toast('尚未就緒，稍後再試');
      return;
    }
    var now = Date.now();
    var trip = _build(now);
    trip.id = now + Math.floor(Math.random() * 1000);   // 避免與其他紀錄撞號
    window.saveTripFinal(trip);                          // 落盤＋畫（無座標略過）＋同步
    if (window.toast) window.toast('✓ 已記錄取消收款 NT$' + FEE + '（刷卡）');   // 覆蓋 saveTripFinal 的預設提示
  }

  window.MaptripCancelFee = { record: record, FEE: FEE, PAY: PAY, LABEL: LABEL, _build: _build };
})();
