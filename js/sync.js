// ===== 雲端同步（Firebase + Google 登入 + Firestore）=====
// 設計：
//   - 資料仍以 localStorage 為「主來源」，雲端只是備份/同步副本。
//   - 登入後：監聽雲端 → 合併進本地 → 重繪；本地每次儲存 → 推上雲端。
//   - 合併以「日期」為單位，同一天內以每趟 id 去重，多裝置不會互相覆蓋。
//   - 未設定 Firebase 或未登入時，整個功能安靜停用，App 照常運作。
(function () {
  'use strict';

  let auth = null, db = null, user = null, unsub = null, ready = false;

  function log(...a) { try { if (window.dbg) window.dbg('[sync] ' + a.join(' ')); } catch (_) {} }
  function toastMsg(m) { try { if (window.toast) window.toast(m); } catch (_) {} }

  function cfgValid(c) {
    return c && typeof c.apiKey === 'string' && c.apiKey.length > 10 && !c.apiKey.includes('PASTE');
  }

  function init() {
    const cfg = window.FIREBASE_CONFIG;
    if (typeof firebase === 'undefined' || !cfgValid(cfg)) { updateUI(); return; }
    try {
      firebase.initializeApp(cfg);
      auth = firebase.auth();
      db = firebase.firestore();
      ready = true;
      // 持久化登入狀態（即使關 App 也保持登入）
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
      auth.onAuthStateChanged(u => { user = u; onAuth(u); });
      // 用 redirect 方式登入時，回來後取結果
      auth.getRedirectResult().catch(() => {});
    } catch (e) {
      log('init failed ' + (e && e.code));
    }
    updateUI();
  }

  function onAuth(u) {
    updateUI();
    if (u) { pullAndListen(); }
    else if (unsub) { unsub(); unsub = null; }
  }

  function signIn() {
    if (!ready) { toastMsg('雲端尚未設定'); return; }
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(err => {
      const code = err && err.code;
      if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request' ||
          code === 'auth/operation-not-supported-in-this-environment' || code === 'auth/popup-closed-by-user') {
        // webview 常擋彈窗，改用轉址登入
        auth.signInWithRedirect(provider).catch(e => toastMsg('登入失敗：' + (e.code || e.message)));
      } else {
        toastMsg('登入失敗：' + (code || err.message));
      }
    });
  }

  function signOut() { if (auth) auth.signOut().then(updateUI); }

  function daysCol() {
    return db.collection('users').doc(user.uid).collection('days');
  }

  // 監聽雲端（首次也會收到一次完整快照 → 等同初次下載）
  function pullAndListen() {
    if (unsub) unsub();
    try {
      unsub = daysCol().onSnapshot(snap => {
        const cloud = {};
        snap.forEach(doc => { cloud[doc.id] = doc.data().trips || []; });
        mergeCloudIntoLocal(cloud);
      }, err => log('snapshot err ' + (err && err.code)));
    } catch (e) { log('listen failed'); }
  }

  function getLocal() { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }

  function mergeTrips(a, b) {
    const map = new Map();
    const score = x => (x.fare ? 1 : 0) + (x.roadCoords ? 2 : 0) + ((x.coords || []).length / 1e6);
    [...(a || []), ...(b || [])].forEach(t => {
      if (!t || t.id == null) return;
      const ex = map.get(t.id);
      if (!ex || score(t) > score(ex)) map.set(t.id, t);
    });
    return [...map.values()].sort((x, y) => x.startTime - y.startTime);
  }

  function mergeCloudIntoLocal(cloud) {
    const local = getLocal();
    let changed = false;
    const toPush = [];
    const days = new Set([...Object.keys(local), ...Object.keys(cloud)]);
    days.forEach(day => {
      const merged = mergeTrips(local[day], cloud[day]);
      // 本地有、雲端沒有的趟 → 之後推上去
      const cloudIds = new Set((cloud[day] || []).map(t => t.id));
      if ((local[day] || []).some(t => !cloudIds.has(t.id))) toPush.push(day);
      if (JSON.stringify(merged) !== JSON.stringify(local[day] || [])) {
        if (merged.length) local[day] = merged; else delete local[day];
        changed = true;
      }
    });
    if (changed) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
      if (window.refreshAfterSync) window.refreshAfterSync();
    }
    toPush.forEach(syncDay);
  }

  async function syncDay(day) {
    if (!ready || !user) return;
    const trips = getLocal()[day];
    try {
      if (trips && trips.length) await daysCol().doc(day).set({ trips, updatedAt: Date.now() });
      else await daysCol().doc(day).delete();
    } catch (e) { log('syncDay fail ' + day + ' ' + (e && e.code)); }
  }

  function syncDays(keys) { if (ready && user && keys) keys.forEach(syncDay); }

  function status() {
    if (!cfgValid(window.FIREBASE_CONFIG) || typeof firebase === 'undefined') return { state: 'unconfigured' };
    if (!user) return { state: 'signedout' };
    return { state: 'signedin', email: user.email, name: user.displayName };
  }

  function updateUI() { if (window.renderSyncPanel) window.renderSyncPanel(); }

  window.MaptripSync = { init, signIn, signOut, syncDays, status };
})();
