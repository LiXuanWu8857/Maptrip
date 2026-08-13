/* =============================================================
 * sync-ui.js — 雲端登入閘門 / 同步設定面板（UI 層）
 * -------------------------------------------------------------
 * 從 app.js v1.1.259 逐字抽出（body 與原版相同）。這是 sync.js（MaptripSync／Firebase
 * Auth+Firestore 資料層）之上的「UI 層」：登入閘門、同步面板、要求輸入名字。
 * 只碰 DOM 與全域 MaptripSync/TripStore/toast，不碰 map。APP_VERSION 經 init 注入（const 不在 window）。
 * 掛 window.MaptripSyncUI；app.js 留同名薄包裝轉呼叫，呼叫端（含 HTML onclick、sync.js 的
 * window.renderSyncPanel 回呼）零改動。
 * 【留在 app.js】refreshAfterSync——它重繪地圖圖層並重指派 todayTrips/allMapLayers，是清單/地圖
 * 刷新協調，不屬 UI 面板，故不搬。
 * ============================================================= */
(function (global) {
  'use strict';

  var ctx = {};
  var _allowFareEdit = null;   // 授權記帳者改車資開關的狀態快取（null＝未抓、undefined＝抓取中）
  function APPVER() { return ctx.appVersion || ''; }

  function openSyncDialog() {
    renderSyncPanel();
    document.getElementById('sync-overlay').style.display = 'block';
    document.getElementById('sync-dialog').style.display = 'block';
  }

  function closeSyncDialog() {
    document.getElementById('sync-overlay').style.display = 'none';
    document.getElementById('sync-dialog').style.display = 'none';
  }

  function applyLoginGate(state) {
    const gate = document.getElementById('login-gate');
    if (!gate) return;
    // 只有「Firebase 已就緒且未登入」才強制擋；未設定/離線時不擋，避免 App 無法使用
    if (state === 'signedout') {
      gate.style.display = 'flex';
      const ver = document.getElementById('gate-version');
      if (ver) ver.textContent = 'v' + APPVER();
      // logo 帶版本參數防快取（避免 WKWebView 用到舊的含標語版本）
      const logoImg = document.getElementById('gate-logo-img');
      if (logoImg && !logoImg.src.includes('?v=' + APPVER())) logoImg.src = 'icons/logo.svg?v=' + APPVER();
      const btn = document.getElementById('gate-btn');
      if (btn) {
        const busy = window.MaptripSync && MaptripSync.isBusy && MaptripSync.isBusy();
        btn.disabled = !!busy;
        btn.textContent = busy ? '登入中…' : '登入 / 註冊';
      }
    } else {
      gate.style.display = 'none';
    }
  }

  function submitGateLogin() {
    const email = (document.getElementById('gate-email') || {}).value || '';
    const pw = (document.getElementById('gate-pw') || {}).value || '';
    MaptripSync.signIn(email, pw);
  }

  let _nameAsking = false;
  // 登入後若沒設定名字 → 要求輸入（取消/留空直接登出）。記帳者辨識用。
  function maybeAskName(st) {
    if (!st || !st.needsName || _nameAsking) return;
    _nameAsking = true;
    setTimeout(() => {
      const name = (prompt('請輸入你的名字\n（讓記帳者辨識，例如：阿明）', '') || '').trim();
      if (!name) { MaptripSync.signOut(); toast('未輸入名字，已登出'); }
      else { MaptripSync.setName(name); toast('名字已設定：' + name); }
      _nameAsking = false;
    }, 150);
  }

  function renderSyncPanel() {
    if (!window.MaptripSync) return;
    const st = MaptripSync.status();
    applyLoginGate(st.state);
    maybeAskName(st);
    const statusEl = document.getElementById('sync-status');
    const actEl = document.getElementById('sync-actions');
    if (!statusEl) return;
    const busy = MaptripSync.isBusy && MaptripSync.isBusy();
    if (st.state === 'unconfigured') {
      statusEl.innerHTML = '雲端同步尚未設定完成，請稍後再試。';
      actEl.innerHTML = '';
    } else if (st.state === 'signedout') {
      _allowFareEdit = null;   // 登出 → 清掉開關快取
      // 保留已輸入的值（重繪時不清空）
      const prevEmail = (document.getElementById('sync-email') || {}).value || '';
      const prevPw = (document.getElementById('sync-pw') || {}).value || '';
      statusEl.innerHTML = '登入後行程會自動備份到雲端。<br>換手機或重裝 App，登入同一帳號即可還原。<br><span class="sync-hint">第一次輸入即自動建立帳號。</span>';
      actEl.innerHTML =
        '<input id="sync-email" class="sync-input" type="email" inputmode="email" ' +
        'autocomplete="username" placeholder="電子郵件" value="' + prevEmail + '">' +
        '<input id="sync-pw" class="sync-input" type="password" ' +
        'autocomplete="current-password" placeholder="密碼（至少 6 碼）" value="' + prevPw + '">' +
        '<button class="sync-google" ' + (busy ? 'disabled' : '') + ' onclick="submitSyncLogin()">' +
        (busy ? '登入中…' : '登入 / 註冊') + '</button>';
    } else {
      const c = st.cloud || { days: 0, trips: 0 };
      statusEl.innerHTML = '已登入　<b>' + (st.email || '') + '</b><br><span class="sync-ok">✓ 行程自動同步中</span>'
        + '<br><span class="sync-hint">雲端：' + c.days + ' 天　' + c.trips + ' 趟'
        + '　本機：' + (TripStore.bytes() / 1048576).toFixed(1) + ' MB（' + TripStore.mode() + '）</span>';
      // 授權記帳者改車資開關：狀態快取，第一次登入態渲染時抓一次（避免每次重繪都打雲端）
      if (_allowFareEdit === null && MaptripSync.getAccess) {
        _allowFareEdit = undefined;   // 抓取中，避免重複發起
        MaptripSync.getAccess().then(function (a) { _allowFareEdit = !!a.allowFareEdit; renderSyncPanel(); })
          .catch(function () { _allowFareEdit = false; renderSyncPanel(); });
      }
      var fareBtn = '';
      if (_allowFareEdit === undefined) {
        fareBtn = '<button class="sync-out" style="margin-top:6px" disabled>車資授權：載入中…</button>';
      } else {
        var on = !!_allowFareEdit;
        fareBtn = '<button class="sync-out" style="margin-top:6px' + (on ? ';color:#188038;border-color:rgba(24,128,56,.4)' : '') + '" ' +
          (busy ? 'disabled' : '') + ' onclick="MaptripSyncUI.toggleAllowFareEdit()">' +
          (on ? '✓ 記帳者可改車資（點一下關閉）' : '🔒 允許記帳者修改車資') + '</button>' +
          '<div class="sync-hint" style="margin-top:4px">開啟後，記帳者才能修改你的每趟車資（改動會同步回你的紀錄）。</div>';
      }
      actEl.innerHTML = '<button class="sync-out" onclick="MaptripSync.signOut()">登出</button>' +
        fareBtn +
        '<button class="sync-out" style="margin-top:6px" ' +
        'onclick="if(confirm(\'清除這台裝置的本機行程，改從雲端重新下載？（用於：換帳號後仍看到別帳號的行程）\'))MaptripSync.resetLocal()">' +
        '🧹 清除本機並重抓雲端</button>';
    }
  }

  // 司機切換「允許記帳者修改車資」：樂觀更新 + 寫雲端；失敗還原。
  function toggleAllowFareEdit() {
    if (!(window.MaptripSync && MaptripSync.setAllowFareEdit)) return;
    var next = !_allowFareEdit;
    _allowFareEdit = next; renderSyncPanel();
    MaptripSync.setAllowFareEdit(next).then(function () {
      if (window.toast) toast(next ? '已允許記帳者修改車資' : '已關閉記帳者改車資');
    }).catch(function (e) {
      _allowFareEdit = !next; renderSyncPanel();
      if (window.toast) toast('設定失敗：' + ((e && e.code) || '未知'));
    });
  }

  function submitSyncLogin() {
    const email = (document.getElementById('sync-email') || {}).value || '';
    const pw = (document.getElementById('sync-pw') || {}).value || '';
    MaptripSync.signIn(email, pw);
  }

  function init(context) { ctx = context || {}; }

  global.MaptripSyncUI = {
    init: init,
    openSyncDialog: openSyncDialog,
    closeSyncDialog: closeSyncDialog,
    applyLoginGate: applyLoginGate,
    submitGateLogin: submitGateLogin,
    maybeAskName: maybeAskName,
    renderSyncPanel: renderSyncPanel,
    submitSyncLogin: submitSyncLogin,
    toggleAllowFareEdit: toggleAllowFareEdit
  };

})(typeof window !== 'undefined' ? window : globalThis);
