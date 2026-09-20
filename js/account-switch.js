/* =============================================================
 * account-switch.js — 記住登入過的帳號、免密碼一鍵切換（MaptripAccounts）
 * -------------------------------------------------------------
 * 目標：記住登入過的帳號清單，之後可直接切換（例如司機本人帳號 ↔ 另一個帳號），
 *   不必每次重打 email/密碼。
 *
 * 資料面已解決（v265 帳號隔離）：只要成功切換 Firebase 登入身分，既有機制
 *   （onAuth → _switchDecision → _clearLocalForSwitch）會自動清上一個帳號的本機
 *   資料、重抓新帳號雲端。本模組只做兩件事：
 *     1. 記住帳號清單（給選帳號 UI）。
 *     2. 切換時免重打密碼（方案 B）。
 *
 * 【方案 B（老闆拍板）】帳號清單連密碼一起存本機、切換直接 signIn。**但必須把關**：
 *   - 「記住這個帳號（免密碼切換）」checkbox 預設不勾；**只有勾了才把密碼寫進本機**，
 *     沒勾＝退回方案 A（只記 email/name，下次切換要補打密碼）。
 *   - 附免責聲明；每筆提供「移除此帳號」清掉（含密碼）。
 *   - 密碼只做 base64 混淆（**非加密**，免責聲明明說），避免肉眼直接看到。
 *
 * 沿用：MaptripSync.switchTo(email, password)（sync.js 新增的薄方法＝signOut 再 signIn）。
 * 清本機時（_clearLocalForSwitch）**不清 maptrip_accounts**，清單要跨帳號留著才切得回去。
 * ============================================================= */
(function (global) {
  'use strict';

  var KEY = 'maptrip_accounts';
  // 由登入 submit 暫存的憑證，onLogin（sync.js onAuth 成功分支）時落定成清單一筆。
  //   { email, pw, consent }。consent=false → 只記 email/name，不存 pw（方案 A 行為）。
  var _pending = null;

  // ── base64 混淆（非加密！免責聲明已明說「未加密」）──
  function _obf(s) { try { return btoa(unescape(encodeURIComponent(s || ''))); } catch (_) { return ''; } }
  function _deobf(s) { try { return decodeURIComponent(escape(atob(s || ''))); } catch (_) { return ''; } }

  // 讀清單（pw 讀出時解混淆成明碼；純函式操作的都是明碼記錄）。
  function _read() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (_) { raw = []; }
    if (!Array.isArray(raw)) raw = [];
    return raw.map(function (r) {
      var o = { uid: (r && r.uid) || '', email: (r && r.email) || '', name: (r && r.name) || '' };
      if (r && r.pw) o.pw = _deobf(r.pw);
      return o;
    });
  }
  // 寫清單（pw 落地前混淆）。
  function _write(list) {
    var enc = (list || []).map(function (r) {
      var o = { uid: r.uid || '', email: r.email || '', name: r.name || '' };
      if (r.pw) o.pw = _obf(r.pw);
      return o;
    });
    try { localStorage.setItem(KEY, JSON.stringify(enc)); } catch (_) {}
  }

  // ── 純函式（供測試，操作明碼記錄）──
  // 把一筆帳號併進清單（email 小寫去重、後者取代前者）。
  //   consent && rec.pw → 保留 pw；否則移除 pw 欄位（＝方案 A，只記 email/name）。
  function _add(list, rec, consent) {
    rec = rec || {};
    var email = (rec.email || '').trim();
    var lc = email.toLowerCase();
    var out = (list || []).filter(function (r) { return (r.email || '').toLowerCase() !== lc; });
    var keep = { uid: rec.uid || '', email: email, name: rec.name || '' };
    if (consent && rec.pw) keep.pw = rec.pw;
    // 換帳號時名字可能還沒載到 → 若新記錄沒名字，沿用舊清單同帳號的名字
    if (!keep.name) {
      var old = _find(list, email);
      if (old && old.name) keep.name = old.name;
    }
    out.push(keep);
    return out;
  }
  // 移除某 email 的帳號（含其密碼）。
  function _remove(list, email) {
    var lc = (email || '').toLowerCase();
    return (list || []).filter(function (r) { return (r.email || '').toLowerCase() !== lc; });
  }
  // 找某 email 的記錄。
  function _find(list, email) {
    var lc = (email || '').toLowerCase();
    var hit = (list || []).filter(function (r) { return (r.email || '').toLowerCase() === lc; });
    return hit[0] || null;
  }

  // ── 對外 ──
  // 記住的帳號清單（不外洩明碼密碼，只回 hasPw 旗標；current＝目前登入的 email 用來標「使用中」）。
  function list() {
    var cur = '';
    try { var st = window.MaptripSync && MaptripSync.status(); if (st && st.email) cur = st.email; } catch (_) {}
    var curLc = (cur || '').toLowerCase();
    return _read().map(function (r) {
      return { uid: r.uid, email: r.email, name: r.name, hasPw: !!r.pw, current: r.email.toLowerCase() === curLc };
    });
  }
  // 登入 submit 前暫存憑證（含是否勾同意）。
  function notePending(email, pw, consent) {
    _pending = { email: (email || '').trim(), pw: pw || '', consent: !!consent };
  }
  // sync.js onAuth 成功分支呼叫：把這次登入落定成清單一筆。
  //   若有 pending 且 email 相符 → 依 consent 決定要不要存 pw；否則只記 email/name。
  function onLogin(uid, email, name) {
    email = (email || '').trim();
    if (!email) { _pending = null; return; }
    var p = _pending; _pending = null;
    var matched = p && (p.email || '').toLowerCase() === email.toLowerCase();
    var rec = { uid: uid || '', email: email, name: name || '' };
    var consent = false;
    if (matched && p.consent && p.pw) { rec.pw = p.pw; consent = true; }
    _write(_add(_read(), rec, consent));
    _renderAll();
  }
  // 是否已存密碼（可免密碼切換）。
  function hasPw(email) { var r = _find(_read(), email); return !!(r && r.pw); }
  // 移除某帳號（含密碼）。
  function remove(email) { _write(_remove(_read(), email)); _renderAll(); }

  // 切換到某帳號。pwArg 有帶就用它、否則用已存的；都沒有 → 回 {needPw:true} 讓 UI 補打。
  //   有存密碼者切換＝consent 續存（true）；臨時補打密碼者不自動存（consent=false）。
  function switchTo(email, pwArg) {
    email = (email || '').trim();
    var rec = _find(_read(), email);
    var stored = rec && rec.pw;
    var pw = pwArg || stored || '';
    if (!pw) return { needPw: true };
    notePending(email, pw, !!stored);
    try { if (window.MaptripSync && MaptripSync.switchTo) MaptripSync.switchTo(email, pw); } catch (_) {}
    return { switching: true };
  }

  // ── UI 片段（sync-ui.js 的登入閘 / 同步面板呼叫）──
  function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  // 記住的帳號清單 HTML（沒有就回空字串）。excludeCurrent＝略過目前登入帳號。
  function accountsHtml(excludeCurrent) {
    var arr = list();
    if (excludeCurrent) arr = arr.filter(function (a) { return !a.current; });
    if (!arr.length) return '';
    var rows = arr.map(function (a) {
      var label = _esc(a.name ? (a.name + '（' + a.email + '）') : a.email);
      var e = encodeURIComponent(a.email);
      var badge = a.current ? '<span class="acc-cur">使用中</span>'
        : (a.hasPw ? '' : '<span class="acc-nopw">需密碼</span>');
      var sw = a.current ? ''
        : '<button class="acc-switch" onclick="MaptripAccounts.uiSwitch(decodeURIComponent(\'' + e + '\'))">切換</button>';
      return '<div class="acc-row"><span class="acc-name">' + label + badge + '</span>' +
        sw + '<button class="acc-del" title="移除此帳號" ' +
        'onclick="MaptripAccounts.uiRemove(decodeURIComponent(\'' + e + '\'))">✕</button></div>';
    }).join('');
    return '<div class="acc-list"><div class="acc-list-t">已記住的帳號</div>' + rows + '</div>';
  }
  // 「記住這個帳號」同意欄 + 免責聲明。id＝checkbox 的 id（gate/panel 各一）。
  function consentHtml(id) {
    return '<label class="acc-consent"><input type="checkbox" id="' + id + '" ' +
      'onchange="MaptripAccounts.onConsentToggle(this)"> 記住這個帳號（免密碼快速切換）</label>' +
      '<div class="acc-disc">⚠️ 勾選後，此帳號的密碼會以<b>未加密</b>方式儲存在這台裝置上，' +
      '方便免密碼快速切換。請<b>只在你個人、不會給別人使用的裝置</b>上開啟。' +
      '裝置遺失、借人或被他人取得，對方可能直接登入此帳號。可隨時「移除此帳號」清除。' +
      '因此功能導致的帳號外洩，本 App 不負責。</div>';
  }

  // 勾選時彈一次完整免責（避免使用者沒看內文就勾）。
  var _discShown = false;
  function onConsentToggle(cb) {
    if (cb && cb.checked && !_discShown) {
      _discShown = true;
      try {
        var ok = confirm('⚠️ 免責聲明\n\n勾選後，此帳號的密碼會「未加密」儲存在這台裝置上，方便免密碼快速切換。\n' +
          '請只在你個人、不會給別人使用的裝置上開啟此功能。\n' +
          '若裝置遺失、借給他人或被他人取得，對方可能直接登入此帳號。\n' +
          '你可隨時用「移除此帳號」清除已儲存的密碼。\n\n確定要記住密碼嗎？');
        if (!ok) cb.checked = false;
      } catch (_) {}
    }
  }

  // UI 事件：切換帳號（沒存密碼就 prompt 補打）。
  function uiSwitch(email) {
    var r = switchTo(email);
    if (r && r.needPw) {
      var pw = '';
      try { pw = prompt('請輸入 ' + email + ' 的密碼', '') || ''; } catch (_) {}
      pw = pw.trim();
      if (pw) switchTo(email, pw);
    }
  }
  // UI 事件：移除帳號（確認後）。
  function uiRemove(email) {
    var ok = true;
    try { ok = confirm('移除已記住的帳號「' + email + '」？（含已儲存的密碼）'); } catch (_) {}
    if (ok) remove(email);
  }

  // 清單有變動 → 若面板開著就重繪（讓移除/新增即時反映）。
  function _renderAll() {
    try { if (window.renderSyncPanel) window.renderSyncPanel(); } catch (_) {}
    try {
      var el = document.getElementById('gate-accounts');
      if (el) el.innerHTML = accountsHtml(true);
    } catch (_) {}
  }

  global.MaptripAccounts = {
    list: list, notePending: notePending, onLogin: onLogin,
    hasPw: hasPw, remove: remove, switchTo: switchTo,
    accountsHtml: accountsHtml, consentHtml: consentHtml,
    onConsentToggle: onConsentToggle, uiSwitch: uiSwitch, uiRemove: uiRemove,
    // 純函式（供測試）
    _add: _add, _remove: _remove, _find: _find, _obf: _obf, _deobf: _deobf,
    _read: _read, _write: _write
  };

})(typeof window !== 'undefined' ? window : globalThis);
