// ===== 雲端同步（Firebase + Google 登入 + Firestore）=====
// 設計：
//   - 資料仍以 localStorage 為「主來源」，雲端只是備份/同步副本。
//   - 登入後：監聽雲端 → 合併進本地 → 重繪；本地每次儲存 → 推上雲端。
//   - 合併以「日期」為單位，同一天內以每趟 id 去重，多裝置不會互相覆蓋。
//   - 未設定 Firebase 或未登入時，整個功能安靜停用，App 照常運作。
(function () {
  'use strict';

  let auth = null, db = null, user = null, unsub = null, unsubDel = null, unsubComm = null, ready = false;
  let cloudInfo = { days: 0, trips: 0, at: 0 };   // 雲端資料摘要（診斷用）
  const warnedDays = new Set();                    // 已提示過備份失敗的日期（避免重複跳提示）

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
    if (u) { pullAndListen(); loadProfile(); setTimeout(processInviteClaims, 1500); }
    else {
      profileName = ''; needsName = false;
      if (unsub) { unsub(); unsub = null; }
      if (unsubDel) { unsubDel(); unsubDel = null; }
      if (unsubComm) { unsubComm(); unsubComm = null; }
    }
  }

  // ===== 使用者顯示名稱（記帳者/司機互相辨識用）=====
  let profileName = '', needsName = false;
  function profileDoc() { return db.collection('users').doc(user.uid).collection('meta').doc('profile'); }
  async function loadProfile() {
    needsName = false; profileName = '';
    try {
      const snap = await profileDoc().get();
      const nm = snap.exists && snap.data() && snap.data().name;
      if (nm) profileName = nm;
      else needsName = true;                 // 成功讀到、但沒名字 → 要求輸入
    } catch (_) {
      needsName = false;                      // 讀取失敗（網路）→ 不強制，避免把人鎖在外面
    }
    updateUI();
  }
  function setName(name) {
    name = (name || '').trim();
    if (!ready || !user || !name) return;
    profileName = name; needsName = false;
    try { profileDoc().set({ name: name, updatedAt: Date.now() }, { merge: true }).catch(function () {}); } catch (_) {}
    try { if (user.updateProfile) user.updateProfile({ displayName: name }).catch(function () {}); } catch (_) {}
    updateUI();
  }

  // ===== 記帳者模式（設計 X：記帳者只能讀行程、讀寫抽成）=====
  function myUid() { return user ? user.uid : null; }
  function myName() { return profileName || (user && user.displayName) || ''; }
  function _randCode() {
    var s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', c = '';
    for (var i = 0; i < 6; i++) c += s[Math.floor(Math.random() * s.length)];
    return c;
  }
  // 司機：產生邀請碼
  async function createInvite() {
    if (!ready || !user) throw new Error('尚未登入');
    for (var t = 0; t < 6; t++) {
      var code = _randCode();
      var ref = db.collection('invites').doc(code);
      var snap = await ref.get();
      if (snap.exists) continue;
      await ref.set({ driverUid: user.uid, driverName: myName(), createdAt: Date.now(), exp: Date.now() + 30 * 864e5 });
      return code;
    }
    throw new Error('請再試一次');
  }
  // 記帳者：輸入邀請碼綁定
  async function redeemInvite(code) {
    if (!ready || !user) throw new Error('尚未登入');
    code = (code || '').trim().toUpperCase();
    if (!code) throw new Error('請輸入邀請碼');
    var ref = db.collection('invites').doc(code);
    var snap = await ref.get();
    if (!snap.exists) throw new Error('邀請碼不存在');
    var d = snap.data();
    if (d.exp && d.exp < Date.now()) throw new Error('邀請碼已過期');
    if (d.driverUid === user.uid) throw new Error('不能加入自己');
    await ref.set({ claimedBy: user.uid, claimedName: myName() }, { merge: true });   // 回填 → 司機端自動授權
    await db.collection('users').doc(user.uid).collection('linkedDrivers').doc(d.driverUid)
      .set({ name: d.driverName || '', since: Date.now() }, { merge: true });
    return { driverUid: d.driverUid, driverName: d.driverName || '' };
  }
  // 司機：把已被兌換的邀請 → 加進授權清單（自己產生的碼＝已同意，自動處理）
  async function processInviteClaims() {
    if (!ready || !user) return;
    try {
      var q = await db.collection('invites').where('driverUid', '==', user.uid).get();
      var accessRef = db.collection('users').doc(user.uid).collection('meta').doc('access');
      var accSnap = await accessRef.get();
      var bk = (accSnap.exists && accSnap.data().bookkeepers) || {};
      var changed = false;
      q.forEach(function (doc) {
        var d = doc.data();
        if (d.claimedBy && bk[d.claimedBy] === undefined) { bk[d.claimedBy] = d.claimedName || ''; changed = true; }
      });
      if (changed) { await accessRef.set({ bookkeepers: bk }, { merge: true }); updateUI(); }
    } catch (_) {}
  }
  // 司機：目前授權的記帳者清單
  async function listBookkeepers() {
    if (!ready || !user) return [];
    try {
      var snap = await db.collection('users').doc(user.uid).collection('meta').doc('access').get();
      var bk = (snap.exists && snap.data().bookkeepers) || {};
      return Object.keys(bk).map(function (uid) { return { uid: uid, name: bk[uid] || '' }; });
    } catch (_) { return []; }
  }
  // 司機：移除某記帳者授權
  async function removeBookkeeper(uid) {
    if (!ready || !user) return;
    var ref = db.collection('users').doc(user.uid).collection('meta').doc('access');
    var snap = await ref.get();
    var bk = (snap.exists && snap.data().bookkeepers) || {};
    delete bk[uid];
    await ref.set({ bookkeepers: bk }, { merge: true });
    updateUI();
  }
  // 記帳者：我協助記帳的司機清單
  async function listLinkedDrivers() {
    if (!ready || !user) return [];
    var out = [];
    try {
      var q = await db.collection('users').doc(user.uid).collection('linkedDrivers').get();
      q.forEach(function (doc) { out.push({ driverUid: doc.id, name: (doc.data() || {}).name || '' }); });
    } catch (_) {}
    return out;
  }
  // 記帳者：取消一位司機（只移除自己這邊的清單；司機端可自行撤銷授權）
  async function unlinkDriver(driverUid) {
    if (!ready || !user) return;
    try { await db.collection('users').doc(user.uid).collection('linkedDrivers').doc(driverUid).delete(); } catch (_) {}
  }
  // 記帳者：讀某司機的行程 + 抽成 + 名稱
  async function readDriverData(driverUid) {
    var res = { days: {}, commissions: {}, name: '' };
    if (!ready || !user) return res;
    try {
      var p = await db.collection('users').doc(driverUid).collection('meta').doc('profile').get();
      res.name = (p.exists && p.data().name) || '';
    } catch (_) {}
    try {
      var q = await db.collection('users').doc(driverUid).collection('days').get();
      q.forEach(function (doc) { res.days[doc.id] = (doc.data() || {}).trips || []; });
    } catch (e) { throw e; }   // 讀行程失敗（多半是還沒授權）→ 讓上層提示
    try {
      var cq = await db.collection('users').doc(driverUid).collection('commissions').get();
      cq.forEach(function (doc) { res.commissions[doc.id] = doc.data() || {}; });
    } catch (_) {}
    return res;
  }
  // 司機本人或記帳者：寫某司機某趟的抽成
  async function writeCommission(driverUid, tripId, commission, dispatch) {
    if (!ready || !user) throw new Error('尚未登入');
    await db.collection('users').doc(driverUid).collection('commissions').doc(String(tripId))
      .set({ commission: commission || 0, dispatch: dispatch || 0, updatedAt: Date.now(), by: user.uid }, { merge: true });
  }

  // Email + 密碼登入：純 API、不靠彈窗/轉址，在 App 內嵌瀏覽器 100% 可用。
  // 沒帳號就自動註冊，有帳號就登入；密碼錯誤才提示。
  function signIn(email, password) {
    if (!ready) { toastMsg('雲端尚未設定'); return; }
    email = (email || '').trim();
    if (!email || !password) { toastMsg('請輸入電子郵件與密碼'); return; }
    if (password.length < 6) { toastMsg('密碼至少 6 碼'); return; }
    setBusy(true);
    // 新版 Firebase 開啟「Email 列舉保護」後，查無帳號與密碼錯誤會回同一個
    // auth/invalid-credential，無法靠登入錯誤碼判斷是不是新帳號。
    // 改成「先嘗試註冊」：成功＝新帳號；已存在＝email-already-in-use→改登入。
    auth.createUserWithEmailAndPassword(email, password)
      .then(() => { setBusy(false); toastMsg('已建立帳號並登入'); })
      .catch(err => {
        const code = err && err.code;
        if (code === 'auth/email-already-in-use') {
          // 已有帳號 → 用密碼登入
          auth.signInWithEmailAndPassword(email, password)
            .then(() => { setBusy(false); })
            .catch(e => {
              setBusy(false);
              const c = e && e.code;
              if (c === 'auth/wrong-password' || c === 'auth/invalid-credential') toastMsg('密碼錯誤');
              else toastMsg(authErrMsg(c));
            });
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

  // 雲端刪除名單（墓碑）：讓「刪除」跨裝置生效，任何裝置都不會把刪掉的趟推回來
  function deletedDoc() {
    return db.collection('users').doc(user.uid).collection('meta').doc('deleted');
  }

  // 讀本機墓碑
  function localTombstones() {
    try { return JSON.parse(localStorage.getItem('maptrip_deleted') || '[]'); }
    catch (_) { return []; }
  }

  // 雲端墓碑併入本機，並把該刪的趟從本機清掉；本機有新墓碑則推上雲端
  function mergeCloudTombstones(cloudArr) {
    const local = localTombstones();
    const byId = new Map();
    [...local, ...(cloudArr || [])].forEach(d => {
      if (!d || d.id == null) return;
      const ex = byId.get(d.id);
      if (!ex || (d.at || 0) > (ex.at || 0)) byId.set(d.id, d);
    });
    const cutoff = Date.now() - 90 * 864e5;
    const merged = [...byId.values()].filter(d => (d.at || 0) > cutoff);
    localStorage.setItem('maptrip_deleted', JSON.stringify(merged));

    // 本機若還留著已刪除的趟 → 清掉並刷新畫面
    const dead = new Set(merged.map(d => d.id));
    const localDays = getLocal();
    let changed = false;
    Object.keys(localDays).forEach(day => {
      const before = (localDays[day] || []).length;
      localDays[day] = (localDays[day] || []).filter(t => !dead.has(t.id));
      if (localDays[day].length !== before) changed = true;
      if (!localDays[day].length) delete localDays[day];
    });
    if (changed) {
      TripStore.setAll(localDays);
      if (window.refreshAfterSync) window.refreshAfterSync();
    }

    // 本機墓碑比雲端多 → 推上去（推完雲端一致，不會無限循環）
    const cloudIds = new Set((cloudArr || []).map(d => d && d.id));
    if (merged.some(d => !cloudIds.has(d.id))) pushDeleted(merged);
  }

  async function pushDeleted(list) {
    if (!ready || !user) return;
    try {
      const ids = list || localTombstones();
      await deletedDoc().set({ ids, updatedAt: Date.now() });
    } catch (e) { log('pushDel fail ' + (e && e.code)); }
  }

  // 監聽雲端（首次也會收到一次完整快照 → 等同初次下載）
  function pullAndListen() {
    if (unsub) unsub();
    if (unsubDel) unsubDel();
    if (unsubComm) unsubComm();
    try {
      // 監聽自己的「抽成」集合：記帳者改的抽成會即時同步回司機本機
      unsubComm = db.collection('users').doc(user.uid).collection('commissions').onSnapshot(snap => {
        let changed = false;
        snap.forEach(doc => {
          const c = doc.data() || {};
          if (window.applyCommission && window.applyCommission(doc.id, c.commission || 0, c.dispatch || 0)) changed = true;
        });
        if (changed && window.refreshAfterSync) window.refreshAfterSync();
      }, err => log('comm snapshot err ' + (err && err.code)));
    } catch (_) {}
    try {
      // 先訂閱刪除名單（墓碑），確保天資料抵達前就知道哪些趟已刪除
      unsubDel = deletedDoc().onSnapshot(snap => {
        mergeCloudTombstones((snap.exists && snap.data().ids) || []);
      }, err => log('del snapshot err ' + (err && err.code)));

      unsub = daysCol().onSnapshot(snap => {
        const cloud = {};
        let tripCount = 0;
        snap.forEach(doc => {
          const trips = doc.data().trips || [];
          cloud[doc.id] = trips;
          tripCount += trips.length;
        });
        cloudInfo = { days: snap.size, trips: tripCount, at: Date.now() };
        updateUI();
        mergeCloudIntoLocal(cloud);
      }, err => log('snapshot err ' + (err && err.code)));
    } catch (e) { log('listen failed'); }
  }

  function getLocal() { return TripStore.getAll(); }   // 行程儲存改走 IndexedDB（js/store.js）

  // 已刪除的趟 id（墓碑）：合併時要排除，避免刪掉的又被同步加回來
  function deletedIdSet() {
    try {
      const arr = JSON.parse(localStorage.getItem('maptrip_deleted') || '[]');
      return new Set(arr.map(d => d && d.id).filter(v => v != null));
    } catch (_) { return new Set(); }
  }

  function mergeTrips(a, b) {
    const map = new Map();
    const dead = deletedIdSet();
    // 每筆先過瘦身（app.js 提供）：雲端殘留的胖資料不會再把本機灌肥
    const slim = (typeof window.slimTripForStorage === 'function')
      ? window.slimTripForStorage : (t => t);
    const score = x => (x.fare ? 1 : 0) + (x.roadCoords ? 2 : 0);
    [...(a || []), ...(b || [])].forEach(t => {
      if (!t || t.id == null || dead.has(t.id)) return;   // 排除墓碑
      t = slim(t);
      const ex = map.get(t.id);
      if (!ex || score(t) > score(ex)) map.set(t.id, t);
    });
    return [...map.values()].sort((x, y) => x.startTime - y.startTime);
  }

  // 從雲端移除某趟（使用者明確刪除時）
  async function deleteTripFromCloud(day, id) {
    if (!ready || !user) return;
    try {
      const ref = daysCol().doc(day);
      const snap = await ref.get();
      if (!snap.exists) return;
      const trips = JSON.parse(JSON.stringify((snap.data().trips || []).filter(t => t.id !== id)));
      if (trips.length) await ref.set({ trips, updatedAt: Date.now() });
      else await ref.delete();
    } catch (e) { log('delTrip fail ' + day + ' ' + (e && e.code)); }
  }

  function mergeCloudIntoLocal(cloud) {
    const local = getLocal();
    let changed = false;
    const toPush = [];
    const days = new Set([...Object.keys(local), ...Object.keys(cloud)]);
    days.forEach(day => {
      const merged = mergeTrips(local[day], cloud[day]);
      // 雲端與瘦身後的合併結果不同（缺趟或仍是胖資料）→ 回推，雲端也跟著瘦身
      if (JSON.stringify(merged) !== JSON.stringify(cloud[day] || [])) toPush.push(day);
      if (JSON.stringify(merged) !== JSON.stringify(local[day] || [])) {
        if (merged.length) local[day] = merged; else delete local[day];
        changed = true;
      }
    });
    if (changed) {
      TripStore.setAll(local);
      if (window.refreshAfterSync) window.refreshAfterSync();
    }
    toPush.forEach(syncDay);
  }

  async function syncDay(day) {
    if (!ready || !user) return;
    const local = getLocal()[day] || [];
    try {
      const ref = daysCol().doc(day);
      // 先讀雲端現有資料，與本機「合併」（依 id 聯集、保留較完整那筆），再寫回。
      // 這樣即使本機一時異常少了幾趟，也絕不會把雲端已有的資料覆蓋掉／刪掉。
      let cloud = [];
      try { const snap = await ref.get(); if (snap.exists) cloud = snap.data().trips || []; } catch (_) {}
      const merged = mergeTrips(local, cloud);
      // JSON 往返去掉 undefined 欄位（Firestore 會以 invalid-argument 拒收 undefined）
      const clean = JSON.parse(JSON.stringify(merged));
      if (clean.length) await ref.set({ trips: clean, updatedAt: Date.now() });
      // 不再自動刪除雲端整天資料，避免本機異常把雲端清空（資料安全優先）
      warnedDays.delete(day);
    } catch (e) {
      log('syncDay fail ' + day + ' ' + (e && e.code));
      // 備份失敗要讓使用者知道（例如單日資料超過 Firestore 1MB 上限）
      if (!warnedDays.has(day)) {
        warnedDays.add(day);
        toastMsg('⚠ 雲端備份失敗：' + day + '（' + ((e && e.code) || '未知錯誤') + '）');
      }
    }
  }

  function syncDays(keys) { if (ready && user && keys) keys.forEach(syncDay); }

  function status() {
    if (!cfgValid(window.FIREBASE_CONFIG) || typeof firebase === 'undefined') return { state: 'unconfigured' };
    if (!user) return { state: 'signedout' };
    return { state: 'signedin', email: user.email, name: profileName || user.displayName || '', needsName: needsName, cloud: cloudInfo };
  }

  function updateUI() { if (window.renderSyncPanel) window.renderSyncPanel(); }

  window.MaptripSync = { init, signIn, signOut, syncDays, status, isBusy, deleteTripFromCloud, pushDeleted, setName: setName,
    myUid: myUid, myName: myName,
    createInvite: createInvite, redeemInvite: redeemInvite, processInviteClaims: processInviteClaims,
    listBookkeepers: listBookkeepers, removeBookkeeper: removeBookkeeper,
    listLinkedDrivers: listLinkedDrivers, unlinkDriver: unlinkDriver,
    readDriverData: readDriverData, writeCommission: writeCommission };
})();
