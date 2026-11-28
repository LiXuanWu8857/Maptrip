// cancel-fee.js — 底部列「🚫 取消費用」鈕：兩種情況（長按切換手感同車資對話框 v1.1.440）。
//   單擊 = 「乘客取消、你收 $40」→ 記一筆 $40 刷卡『收入』（cancelFee，原功能）。
//   長按 = 「代收取消費（v1.1.455）」→ 你幫公司代收：客人給現金 $40、但公司會從刷卡扣回 →
//          記一筆『淨 0』紀錄（cancelCollect）：現金 +40、刷卡 −40、總計不變。
// 兩者都無路線、沿用 app.js 已測試的 saveTripFinal（無座標安全：drawTripLine 略過、
//   清單/金額照常、saveTodayToStorage 內含雲端同步）。
(function () {
  'use strict';

  var FEE = 40;             // 金額（元），兩種情況同額
  var PAY = 'card';         // 單擊情況：刷卡收入
  var LABEL = '取消費用';    // 單擊備註
  var CLABEL = '代收取消費';  // 長按（代收）備註
  var LONG_MS = 500;

  var CSS =
    '#cf-ov{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.45);display:flex;' +
      'align-items:center;justify-content:center;padding:24px;}' +
    '#cf-ov .cf-box{background:#fff;color:#1a1a1a;border-radius:16px;padding:22px 20px 16px;' +
      'width:100%;max-width:320px;box-shadow:0 8px 30px rgba(0,0,0,.3);text-align:center;}' +
    '#cf-ov .cf-msg{font-size:17px;font-weight:700;}' +
    '#cf-ov .cf-sub{font-size:13px;color:#5f6368;margin-top:8px;line-height:1.55;}' +
    '#cf-ov .cf-btns{display:flex;gap:10px;margin-top:20px;}' +
    '#cf-ov .cf-btns button{flex:1;height:44px;border:none;border-radius:12px;font:inherit;' +
      'font-size:15px;font-weight:600;cursor:pointer;}' +
    '#cf-ov .cf-no{background:#f1f3f4;color:#3c4043;}' +
    '#cf-ov .cf-yes{background:#1a73e8;color:#fff;}' +
    '#cf-ov .cf-yes.collect{background:#8e5b2a;}' +
    '@media (prefers-color-scheme: dark){#cf-ov .cf-box{background:#2a2a2a;color:#e8eaed;}' +
      '#cf-ov .cf-sub{color:#9aa0a6;}#cf-ov .cf-no{background:#3a3a3a;color:#e8eaed;}}';

  var _cssAdded = false, _ov = null;
  function _ensureCss() {
    if (_cssAdded) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); _cssAdded = true;
  }
  function _close() { if (_ov) { _ov.remove(); _ov = null; } }

  // 單擊：$40 刷卡『收入』紀錄（純函式，供測試）
  function _build(now) {
    return { id: now, startTime: now, endTime: now, coords: [], totalDist: 0,
      fare: FEE, paymentMethod: PAY, label: LABEL, cancelFee: true };
  }
  // 長按：代收取消費『淨 0』紀錄（cancelCollect＝各統計處理成 現金+a、刷卡−a、不計營收/趟數）
  function _buildCollect(now) {
    return { id: now, startTime: now, endTime: now, coords: [], totalDist: 0,
      fare: FEE, paymentMethod: 'cash', label: CLABEL, cancelCollect: true };
  }

  function _commitWith(builder, okMsg) {
    if (typeof window.saveTripFinal !== 'function') {
      if (window.toast) window.toast('尚未就緒，稍後再試'); return;
    }
    var now = Date.now();
    var trip = builder(now);
    trip.id = now + Math.floor(Math.random() * 1000);   // 避免撞號
    window.saveTripFinal(trip);                          // 落盤＋畫（無座標略過）＋同步
    if (window.toast) window.toast(okMsg);
  }
  function _commit() { _commitWith(_build, '✓ 已記錄取消費用 NT$' + FEE + '（刷卡收入）'); }
  function _commitCollect() { _commitWith(_buildCollect, '✓ 已記錄代收取消費 NT$' + FEE + '（現金+、刷卡−、淨0）'); }

  // 共用確認框
  function _confirm(msg, sub, yesClass, onYes) {
    _ensureCss();
    if (_ov) return;
    _ov = document.createElement('div'); _ov.id = 'cf-ov';
    _ov.innerHTML =
      '<div class="cf-box"><div class="cf-msg">' + msg + '</div>' +
        '<div class="cf-sub">' + sub + '</div>' +
        '<div class="cf-btns"><button class="cf-no">取消</button>' +
          '<button class="cf-yes ' + (yesClass || '') + '">確認</button></div></div>';
    _ov.querySelector('.cf-no').addEventListener('click', _close);
    _ov.querySelector('.cf-yes').addEventListener('click', function () { _close(); onYes(); });
    _ov.addEventListener('click', function (e) { if (e.target === _ov) _close(); });
    document.body.appendChild(_ov);
  }

  // 單擊入口：乘客取消、你收 $40 刷卡（原功能）
  function record() {
    _confirm('是否確認乘客已取消？', '確認後記一筆 NT$' + FEE + '（刷卡收入）', '', _commit);
  }
  // 長按入口：代收取消費（淨 0）
  function collect() {
    _confirm('代收取消費 NT$' + FEE + '？',
      '你幫公司代收：客人給現金 ' + FEE + '、公司會從刷卡扣回。<br>記一筆淨 0：現金 +' + FEE + '、刷卡 −' + FEE + '。',
      'collect', _commitCollect);
  }

  // 綁底部鈕：單擊 record()、長按 collect()（手感同車資對話框現金↔簽單長按）
  function bindButton(btn) {
    btn = btn || document.getElementById('cancelfee-btn');
    if (!btn || btn._mtCfWired) return;
    btn._mtCfWired = true;
    var lpTimer = null, lpFired = false, lpAt = 0, sx = 0, sy = 0, lastTouch = 0;
    function cancelLp() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
    function start() {
      lpFired = false; cancelLp();
      lpTimer = setTimeout(function () {
        lpTimer = null; lpFired = true; lpAt = Date.now();
        try { if (navigator.vibrate) navigator.vibrate(30); } catch (_) {}
        collect();
      }, LONG_MS);
    }
    btn.addEventListener('touchstart', function (e) { lastTouch = Date.now(); var t = e.touches[0]; sx = t.clientX; sy = t.clientY; start(); }, { passive: true });
    btn.addEventListener('touchmove', function (e) { var t = e.touches[0]; if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancelLp(); }, { passive: true });
    btn.addEventListener('touchend', function () { lastTouch = Date.now(); cancelLp(); });
    btn.addEventListener('touchcancel', cancelLp);
    btn.addEventListener('mousedown', function (e) { if (e.button === 0 && Date.now() - lastTouch > 1000) start(); });
    btn.addEventListener('mouseup', cancelLp);
    btn.addEventListener('mouseleave', cancelLp);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function () {
      cancelLp();
      if (lpFired || Date.now() - lpAt < 700) { lpFired = false; return; }   // 長按剛觸發的 click 忽略
      record();
    });
  }

  function _init() { bindButton(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();

  window.MaptripCancelFee = {
    record: record, collect: collect, bindButton: bindButton,
    FEE: FEE, PAY: PAY, LABEL: LABEL, CLABEL: CLABEL,
    _build: _build, _buildCollect: _buildCollect, _commit: _commit, _commitCollect: _commitCollect, _close: _close
  };
})();
