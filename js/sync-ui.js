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
      // 記住的帳號清單（免密碼快速切換）
      const accEl = document.getElementById('gate-accounts');
      if (accEl && window.MaptripAccounts) accEl.innerHTML = MaptripAccounts.accountsHtml(true);
    } else {
      gate.style.display = 'none';
    }
  }

  function submitGateLogin() {
    const email = (document.getElementById('gate-email') || {}).value || '';
    const pw = (document.getElementById('gate-pw') || {}).value || '';
    // 先暫存憑證＋是否勾同意 → 登入成功後（sync onAuth）依同意決定要不要存密碼
    const consent = !!(document.getElementById('gate-remember') || {}).checked;
    try { if (window.MaptripAccounts) MaptripAccounts.notePending(email, pw, consent); } catch (_) {}
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
      // 保留已輸入的值（重繪時不清空）
      const prevEmail = (document.getElementById('sync-email') || {}).value || '';
      const prevPw = (document.getElementById('sync-pw') || {}).value || '';
      statusEl.innerHTML = '登入後行程會自動備份到雲端。<br>換手機或重裝 App，登入同一帳號即可還原。<br><span class="sync-hint">第一次輸入即自動建立帳號。</span>';
      const accHtml = (window.MaptripAccounts) ? MaptripAccounts.accountsHtml(true) : '';
      const consentHtml = (window.MaptripAccounts) ? MaptripAccounts.consentHtml('sync-remember') : '';
      actEl.innerHTML = accHtml +
        '<input id="sync-email" class="sync-input" type="email" inputmode="email" ' +
        'autocomplete="username" placeholder="電子郵件" value="' + prevEmail + '">' +
        '<input id="sync-pw" class="sync-input" type="password" ' +
        'autocomplete="current-password" placeholder="密碼（至少 6 碼）" value="' + prevPw + '">' +
        consentHtml +
        '<button class="sync-google" ' + (busy ? 'disabled' : '') + ' onclick="submitSyncLogin()">' +
        (busy ? '登入中…' : '登入 / 註冊') + '</button>';
    } else {
      const c = st.cloud || { days: 0, trips: 0 };
      statusEl.innerHTML = '已登入　<b>' + (st.email || '') + '</b><br><span class="sync-ok">✓ 行程自動同步中</span>'
        + '<br><span class="sync-hint">雲端：' + c.days + ' 天　' + c.trips + ' 趟'
        + '　本機：' + (TripStore.bytes() / 1048576).toFixed(1) + ' MB（' + TripStore.mode() + '）</span>';
      // 「允許記帳者修改車資」開關已移到「記帳者」面板的『授權我的記帳者』區（語意相符處），此處不再放。
      // 面板改成三個可收合區塊（使用者指定）：切換帳號 / 資料 / 登出。
      //   ① 切換帳號：顯示目前登入帳號 + 已記住的其他帳號（一鍵切換）
      //   ② 資料：匯出 / 匯入 / 換日整理 / 清除本機並重抓雲端
      //   ③ 登出：直接動作，不收合
      const accHtml = (window.MaptripAccounts) ? MaptripAccounts.accountsHtml(true) : '';
      const backupBtn = (window.MaptripBackup)
        ? '<button class="sync-out" style="border-color:rgba(26,115,232,0.3);background:rgba(26,115,232,0.06);color:#1a73e8" ' +
          'onclick="MaptripBackup.exportFile()">⬇️ 匯出備份（存成 JSON 檔）</button>'
        : '';
      // 匯入備份：選 .json → 依趟 id 合併回本機/雲端，救回被刪的行程（含路線）
      const importBtn = (window.MaptripImport)
        ? '<button class="sync-out" style="border-color:rgba(52,168,83,0.3);background:rgba(52,168,83,0.06);color:#188038" ' +
          'onclick="MaptripImport.pickFile()">📥 匯入備份（救回被刪的行程）</button>'
        : '';
      // 換日整理（可重複、自動偵測）：只要還有凌晨趟卡在前一天就顯示按鈕（含待搬趟數）；
      // 整理乾淨(0 趟)才隱藏。做過(有快照)則另給還原逃生鈕。
      let migrateBtn = '';
      if (window.MaptripMigrateDay) {
        let mc = 0;
        try { mc = (MaptripMigrateDay.preview() || {}).moveCount || 0; } catch (_) {}
        if (mc > 0) {
          migrateBtn = '<button class="sync-out" style="border-color:rgba(232,113,10,0.35);background:rgba(232,113,10,0.07);color:#e8710a" ' +
            'onclick="MaptripMigrateDay.confirmAndRun()">🔄 換日整理（' + mc + ' 趟凌晨行程移到隔天）</button>';
        } else if (MaptripMigrateDay.hasSnapshot && MaptripMigrateDay.hasSnapshot()) {
          migrateBtn = '<button class="sync-out" ' +
            'onclick="if(confirm(\'還原到換日整理「之前」的資料？（會覆寫雲端變動的日子）\'))MaptripMigrateDay.restorePremigrate().then(function(){renderSyncPanel()})">' +
            '↩︎ 還原換日整理前</button>';
        }
      }
      const resetBtn = '<button class="sync-out" ' +
        'onclick="if(confirm(\'清除這台裝置的本機行程，改從雲端重新下載？（用於：換帳號後仍看到別帳號的行程）\'))MaptripSync.resetLocal()">' +
        '🧹 清除本機並重抓雲端</button>';

      // ① 切換帳號區：目前帳號 + 其他已記住帳號
      const accBody =
        '<div class="sync-sec-cur">目前登入：<b>' + _esc(st.email || '') + '</b></div>' +
        (accHtml || '<div class="sync-hint" style="padding:2px">沒有其他已記住的帳號（在登入頁勾「記住這個帳號」即可加入）</div>');
      // ② 資料區
      const dataBody = backupBtn + importBtn + migrateBtn + resetBtn;

      actEl.innerHTML =
        _section('acc', '👤 切換帳號', accBody) +
        _section('data', '🗂 資料', dataBody) +
        '<button class="sync-out" onclick="MaptripSync.signOut()">🚪 登出</button>';
    }
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 可收合區塊：標題列（點擊展開/收合）+ 內容。開合狀態記在 _openSec，重繪後保留。
  var _openSec = { acc: false, data: false };
  function _section(key, title, bodyHtml) {
    var open = !!_openSec[key];
    return '<div class="sync-sec">' +
      '<button class="sync-sec-h" onclick="MaptripSyncUI.toggleSyncSection(\'' + key + '\')">' +
        '<span>' + title + '</span>' +
        '<span class="sync-sec-chev" id="syncchev-' + key + '">' + (open ? '▾' : '▸') + '</span>' +
      '</button>' +
      '<div class="sync-sec-b" id="syncsec-' + key + '"' + (open ? '' : ' style="display:none"') + '>' + bodyHtml + '</div>' +
      '</div>';
  }
  function toggleSyncSection(key) {
    _openSec[key] = !_openSec[key];
    var b = document.getElementById('syncsec-' + key);
    var c = document.getElementById('syncchev-' + key);
    if (b) b.style.display = _openSec[key] ? '' : 'none';
    if (c) c.textContent = _openSec[key] ? '▾' : '▸';
  }

  function submitSyncLogin() {
    const email = (document.getElementById('sync-email') || {}).value || '';
    const pw = (document.getElementById('sync-pw') || {}).value || '';
    const consent = !!(document.getElementById('sync-remember') || {}).checked;
    try { if (window.MaptripAccounts) MaptripAccounts.notePending(email, pw, consent); } catch (_) {}
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
    toggleSyncSection: toggleSyncSection
  };

})(typeof window !== 'undefined' ? window : globalThis);
