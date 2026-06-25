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

  // Email + 密碼登入：純 API、不靠彈窗/轉址，在 App 內嵌瀏覽器 100% 可用。
  // 沒帳號就自動註冊，有帳號就登入；密碼錯誤才提示。
  function signIn(email, password) {
    if (!ready) { toastMsg('雲端尚未設定'); return; }
    email = (email || '').trim();
    if (!email || !password) { toastMsg('請輸入電子郵件與密碼'); return; }
    if (password.length < 6) { toastMsg('密碼至少 6 碼'); return; }
    setBusy(true);
    auth.signInWithEmailAndPassword(email, password)
      .then(() => { setBusy(false); })
      .catch(err => {
        const code = err && err.code;
        if (code === 'auth/user-not-found') {
          // 新帳號 → 自動註冊
          auth.createUserWithEmailAndPassword(email, password)
            .then(() => { setBusy(false); toastMsg('已建立帳號並登入'); })
            .catch(e => { setBusy(false); toastMsg(authErrMsg(e && e.code)); });
        } else if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
          setBusy(false); toastMsg('密碼錯誤');
        } else {
          setBusy(false); toastMsg(authErrMsg(code));
        }
      });
  }

  function authErrMsg(code) {
    switch (code) {
      case 'auth/invalid-email': return '電子郵件格式不正確';
      case 'auth/email-already-in-use': return '此信箱已註冊，請直接登入';
      case 'auth/weak-password': return '密碼太弱（至少 6 碼）';
      case 'auth/network-request-failed': return '網路連線失敗';
      case 'auth/too-many-requests': return '嘗試太多次，請稍後再試';
      default: return '登入失敗：' + (code || '未知錯誤');
    }
  }

  let busy = false;
  function setBusy(b) { busy = b; updateUI(); }
  function isBusy() { return busy; }

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

  window.MaptripSync = { init, signIn, signOut, syncDays, status, isBusy };
})();
