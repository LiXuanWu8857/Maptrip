// ===== 雲端同步（Firebase + Google 登入 + Firestore）=====
// 設計：
//   - 資料仍以 localStorage 為「主來源」，雲端只是備份/同步副本。
//   - 登入後：監聽雲端 → 合併進本地 → 重繪；本地每次儲存 → 推上雲端。
//   - 合併以「日期」為單位，同一天內以每趟 id 去重，多裝置不會互相覆蓋。
//   - 未設定 Firebase 或未登入時，整個功能安靜停用，App 照常運作。
(function () {
  'use strict';

  let auth = null, db = null, user = null, unsub = null, unsubDel = null, unsubComm = null, unsubManual = null, ready = false;
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
    if (u) {
      // 帳號隔離：本機（IndexedDB/localStorage）不是照帳號分開的。換帳號時若不清，
      // 會① 顯示到上一個帳號的行程 ② 首快照把上一個帳號的「本機獨有日子」回推進新帳號雲端（污染）。
      var prev = _getDataUid();
      var dec = _switchDecision(prev, u.uid);
      _pushLocalOK = dec.pushLocalOK;          // 只有「延續同帳號」才可回推本機獨有日子
      if (dec.clear) _clearLocalForSwitch();   // 換帳號 → 先清本機
      _setDataUid(u.uid);
      pullAndListen(); loadProfile(); loadPrefs(); setTimeout(processInviteClaims, 1500);
    }
    else {
      profileName = ''; needsName = false;
      if (unsub) { unsub(); unsub = null; }
      if (unsubDel) { unsubDel(); unsubDel = null; }
      if (unsubComm) { unsubComm(); unsubComm = null; }
      if (unsubManual) { unsubManual(); unsubManual = null; }
    }
  }

  // ===== 帳號隔離（換帳號不再看到/回推上一個帳號的行程）=====
  var DATAUID_KEY = 'maptrip_data_uid';
  var _pushLocalOK = false;   // 是否可把「本機有、雲端沒有」的日子回推雲端（延續同帳號才安全）
  function _getDataUid() { try { return localStorage.getItem(DATAUID_KEY) || ''; } catch (_) { return ''; } }
  function _setDataUid(uid) { try { localStorage.setItem(DATAUID_KEY, uid || ''); } catch (_) {} }
  // 純函式（供測試）：prev＝上一個擁有本機資料的帳號；uid＝現在登入的帳號。
  //   clear＝是否清本機（換帳號才清）；pushLocalOK＝是否可回推本機獨有日子（延續同帳號才可）。
  function _switchDecision(prev, uid) {
    return { clear: !!(prev && prev !== uid), pushLocalOK: prev === uid };
  }
  function _clearLocalForSwitch() {
    try { if (window.TripStore && TripStore.clearAll) TripStore.clearAll(); } catch (_) {}
    try { localStorage.removeItem('maptrip_deleted'); } catch (_) {}
    try { localStorage.removeItem('maptrip_active'); } catch (_) {}
    // 換帳號一併重置支出雲端同步（取消舊訂閱、清支出快取、下次開報表重新綁新帳號），
    // 否則會顯示上一個帳號的支出、舊訂閱還在跑（與 v265 行程隔離同一類坑）。
    try { if (window.MaptripFinance && MaptripFinance.resetExpenseSync) MaptripFinance.resetExpenseSync(); } catch (_) {}
    try { if (window.MaptripManual && MaptripManual.clear) MaptripManual.clear(); } catch (_) {}   // 換帳號清手動紀錄快取
    // 換帳號清共享熱點偏好快取（groupId 屬於帳號；貢獻計數/去重也重來）
    _prefs = null;
    try { localStorage.removeItem('mt_hs_prefs'); localStorage.removeItem('mt_hs_contrib'); localStorage.removeItem('mt_hs_done'); } catch (_) {}
    try { if (window.refreshAfterSync) window.refreshAfterSync(); } catch (_) {}
    log('account switch → local cleared');
  }
  // 手動：清本機並重新從雲端下載（換帳號後、或本機顯示到別帳號資料時修復）
  function resetLocal() {
    if (!ready || !user) { toastMsg('請先登入雲端'); return; }
    _clearLocalForSwitch();
    _pushLocalOK = false;                     // 剛清完、未驗證延續 → 這次不回推（避免污染雲端）
    if (unsub) { unsub(); unsub = null; }
    if (unsubDel) { unsubDel(); unsubDel = null; }
    if (unsubComm) { unsubComm(); unsubComm = null; }
    if (unsubManual) { unsubManual(); unsubManual = null; }
    pullAndListen();
    toastMsg('已清除本機並重新從雲端下載');
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
  // 純函式（供測試）：邀請碼是否可被 myUid 兌換 → 回傳阻擋原因字串，null=可兌換。
  // 一碼一用：已被別人兌換就擋（先兌換者贏）；同一人重複兌換視為冪等（放行）。
  function _claimBlock(d, myUid) {
    if (!d) return '邀請碼不存在';
    if (d.exp && d.exp < Date.now()) return '邀請碼已過期';
    if (d.driverUid === myUid) return '不能加入自己';
    if (d.claimedBy && d.claimedBy !== myUid) return '此邀請碼已被使用，請向司機索取新的一組';
    return null;
  }
  // 純函式（供測試）：司機端 processInviteClaims 是否該把此邀請的兌換者加進授權清單。
  // 跳過 revoked（撤銷後標記）→ 撤銷才不會被下一次自動處理又加回來。
  function _shouldAuthorize(d, bk) {
    return !!(d && d.claimedBy && !d.revoked && bk[d.claimedBy] === undefined);
  }
  // 記帳者：輸入邀請碼綁定
  async function redeemInvite(code) {
    if (!ready || !user) throw new Error('尚未登入');
    code = (code || '').trim().toUpperCase();
    if (!code) throw new Error('請輸入邀請碼');
    var ref = db.collection('invites').doc(code);
    var snap = await ref.get();
    var d = snap.exists ? snap.data() : null;
    var block = _claimBlock(d, user.uid);
    if (block) throw new Error(block);
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
        if (_shouldAuthorize(d, bk)) { bk[d.claimedBy] = d.claimedName || ''; changed = true; }
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
  // 司機：移除某記帳者授權（並把他兌換過的邀請碼標記 revoked，
  // 否則下次 processInviteClaims 會看到舊 claimedBy 又把他加回來＝撤銷無效）
  async function removeBookkeeper(uid) {
    if (!ready || !user) return;
    var ref = db.collection('users').doc(user.uid).collection('meta').doc('access');
    var snap = await ref.get();
    var bk = (snap.exists && snap.data().bookkeepers) || {};
    delete bk[uid];
    await ref.set({ bookkeepers: bk }, { merge: true });
    // 撤銷持久化：把此記帳者兌換過的邀請碼標記 revoked
    try {
      var q = await db.collection('invites').where('driverUid', '==', user.uid).get();
      var ps = [];
      q.forEach(function (doc) {
        if ((doc.data() || {}).claimedBy === uid) ps.push(doc.ref.set({ revoked: true }, { merge: true }));
      });
      await Promise.all(ps);
    } catch (_) {}
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
    var res = { days: {}, commissions: {}, expenses: [], manualTrips: [], name: '', allowFareEdit: false };
    if (!ready || !user) return res;
    var base = db.collection('users').doc(driverUid);
    // 五個子集合原本逐一 await（序列 5 趟 round-trip，記帳者選司機後常等很久）。
    // 改成 Promise.all 一次併發送出，總延遲≈最慢的那一個 → 明顯加快（v271）。
    // days 是授權關鍵：讀不到多半＝未授權/規則未部署 → 必須讓錯誤往上拋出提示；
    // 其餘（profile/commissions/expenses/manualTrips）讀不到不擋，各自吞掉。
    var soft = function (p) { return p.then(function (s) { return s; }, function () { return null; }); };
    var r = await Promise.all([
      soft(base.collection('meta').doc('profile').get()),
      base.collection('days').get(),                 // 不吞：失敗要拋
      soft(base.collection('commissions').get()),
      soft(base.collection('expenses').get()),
      soft(base.collection('manualTrips').get()),
      soft(base.collection('meta').doc('access').get())   // 授權改車資開關（#3）
    ]);
    var p = r[0], q = r[1], cq = r[2], eq = r[3], mq = r[4], ac = r[5];
    if (p && p.exists) res.name = (p.data().name) || '';
    q.forEach(function (doc) { res.days[doc.id] = (doc.data() || {}).trips || []; });
    if (cq) cq.forEach(function (doc) { res.commissions[doc.id] = doc.data() || {}; });
    if (eq) eq.forEach(function (doc) { var e = doc.data() || {}; e.id = doc.id; res.expenses.push(e); });
    if (mq) mq.forEach(function (doc) { var m = doc.data() || {}; m.id = doc.id; res.manualTrips.push(m); });
    if (ac && ac.exists) res.allowFareEdit = !!(ac.data() || {}).allowFareEdit;
    return res;
  }
  // 司機本人或記帳者：寫某司機某趟的抽成（extra 可帶 {fareOverride, payOverride}＝記帳者改車資，#3）。
  // fareOverride/payOverride 傳 undefined 就不動該欄位（merge:true）；傳 null 代表清除覆蓋。
  async function writeCommission(driverUid, tripId, commission, dispatch, extra) {
    if (!ready || !user) throw new Error('尚未登入');
    var payload = { commission: commission || 0, dispatch: dispatch || 0, updatedAt: Date.now(), by: user.uid };
    if (extra && 'fareOverride' in extra) payload.fareOverride = extra.fareOverride;   // 可為數字或 null（清除）
    if (extra && 'payOverride' in extra) payload.payOverride = extra.payOverride;
    await db.collection('users').doc(driverUid).collection('commissions').doc(String(tripId))
      .set(payload, { merge: true });
  }
  // 司機本人：主動抓一次自己的抽成集合（記帳者填的抽成/車資覆蓋），套進本機各趟。
  // 平常有 onSnapshot 即時同步，這支供「收支」手動更新鈕：登入即抓、不必等監聽。回傳套用筆數。
  async function pullCommissions() {
    if (!ready || !user) throw new Error('尚未登入');
    var snap = await db.collection('users').doc(user.uid).collection('commissions').get();
    var applied = 0;
    snap.forEach(function (doc) {
      var c = doc.data() || {};
      if (window.applyCommission && window.applyCommission(doc.id, c.commission || 0, c.dispatch || 0, c.fareOverride, c.payOverride)) applied++;
    });
    return applied;
  }
  // ── 授權記帳者改車資的開關（meta/access.allowFareEdit）──
  // 讀司機的 access 文件（bookkeepers + allowFareEdit）。記帳者讀某司機、司機讀自己皆可。
  async function getAccess(driverUid) {
    if (!ready || !user) return { bookkeepers: {}, allowFareEdit: false };
    var uid = driverUid || user.uid;
    var snap = await db.collection('users').doc(uid).collection('meta').doc('access').get();
    var d = (snap.exists && snap.data()) || {};
    return { bookkeepers: d.bookkeepers || {}, allowFareEdit: !!d.allowFareEdit };
  }
  // 司機本人：設定「允許記帳者修改車資」開關。
  async function setAllowFareEdit(on) {
    if (!ready || !user) throw new Error('尚未登入');
    await db.collection('users').doc(user.uid).collection('meta').doc('access')
      .set({ allowFareEdit: !!on }, { merge: true });
  }

  // ── 支出（expenses）：司機本人或記帳者皆可讀寫某司機的支出集合 ──
  // 文件 id 用 <寫入者uid>_<ts>，避免司機/記帳者同毫秒雙寫撞號。
  // 讀取某司機全部支出（回傳陣列，每筆帶 id）。
  async function readExpenses(driverUid) {
    var out = [];
    if (!ready || !user) return out;
    var eq = await db.collection('users').doc(driverUid).collection('expenses').get();
    eq.forEach(function (doc) { var e = doc.data() || {}; e.id = doc.id; out.push(e); });
    return out;
  }
  // 寫一筆支出。傳入的 e = { id?, cat, amount, note, day, ts }；回傳最終 id。
  async function writeExpense(driverUid, e) {
    if (!ready || !user) throw new Error('尚未登入');
    var id = (e && e.id) ? String(e.id) : (user.uid + '_' + Date.now());
    await db.collection('users').doc(driverUid).collection('expenses').doc(id)
      .set({ cat: (e && e.cat) || 'other', amount: (e && e.amount) || 0,
             note: (e && e.note) || '', day: (e && e.day) || '',
             ts: (e && e.ts) || Date.now(), by: user.uid }, { merge: true });
    return id;
  }
  // 刪一筆支出。
  async function deleteExpense(driverUid, id) {
    if (!ready || !user) throw new Error('尚未登入');
    await db.collection('users').doc(driverUid).collection('expenses').doc(String(id)).delete();
  }
  // ── 手動紀錄（manualTrips）：記帳者代司機補登當日路程（司機忘記按/現金單）──
  // 獨立子集合 users/{driverUid}/manualTrips/{id}，id＝<寫入者uid>_<ts>，
  // 刻意「不寫進司機的 days 文件」以免蓋掉司機 App 的 GPS 行程；記帳者端讀取時再併進當日顯示。
  // 抽成/叫車沿用既有 commissions 集合（key＝此 id），機制單一。
  async function writeManualTrip(driverUid, t) {
    if (!ready || !user) throw new Error('尚未登入');
    var id = (t && t.id) ? String(t.id) : (user.uid + '_' + Date.now());
    await db.collection('users').doc(driverUid).collection('manualTrips').doc(id)
      .set({ fare: (t && t.fare) || 0, paymentMethod: (t && t.paymentMethod) || 'cash',
             startTime: (t && t.startTime) || Date.now(), day: (t && t.day) || '',
             label: (t && t.label) || '', manual: true, by: user.uid }, { merge: true });
    return id;
  }
  async function deleteManualTrip(driverUid, id) {
    if (!ready || !user) throw new Error('尚未登入');
    await db.collection('users').doc(driverUid).collection('manualTrips').doc(String(id)).delete();
  }

  // 訂閱某司機支出的即時變動（司機端本機用，記帳者改的支出即時回讀）。
  // cb 收到完整陣列；回傳 unsubscribe 函式。
  function listenExpenses(driverUid, cb) {
    if (!ready || !user) return function () {};
    return db.collection('users').doc(driverUid).collection('expenses').onSnapshot(function (snap) {
      var out = []; snap.forEach(function (doc) { var e = doc.data() || {}; e.id = doc.id; out.push(e); });
      try { cb(out); } catch (_) {}
    }, function () {});
  }

  // ===== 共享找客熱點 / 車隊（Phase 1，私人小圈）=====
  // 池子只存去識別化格子次數：groups/{gid}/grid/{cellId} = {gLat,gLng,dayType,bucket,count,updatedAt}
  //   —— 無 uid、無精確座標、無車資、無實際時間點。k-匿名（讀取時 count<2 丟）在 hotspot-share.js。
  // prefs（users/{uid}/meta/prefs）記 { shareHotspots, groupId, groupName }；本機鏡像一份 mt_hs_prefs
  //   供 contribute 快讀（完成一趟就寫，不宜每趟再 round-trip 讀雲端）。
  var PREFS_KEY = 'mt_hs_prefs';         // 本機鏡像 { shareHotspots, groupId, groupName }
  var CONTRIB_KEY = 'mt_hs_contrib';     // 每日貢獻計數 { day:'YYYY-MM-DD', n }
  var DONE_KEY = 'mt_hs_done';           // 已貢獻的 tripId 陣列（前端去重，一趟一次）
  var DAILY_CAP = 300, BACKFILL_CAP = 500, BATCH = 400;
  var _prefs = null;

  function prefsDoc() { return db.collection('users').doc(user.uid).collection('meta').doc('prefs'); }
  function _readPrefsLocal() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch (_) { return null; } }
  function _writePrefsLocal(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p || {})); } catch (_) {} }
  // 登入後載入偏好（先用本機鏡像秒回、再以雲端校正）。
  async function loadPrefs() {
    _prefs = _readPrefsLocal() || { shareHotspots: false, groupId: null, groupName: '' };
    try {
      var snap = await prefsDoc().get();
      if (snap.exists) {
        var d = snap.data() || {};
        _prefs = { shareHotspots: !!d.shareHotspots, groupId: d.groupId || null, groupName: d.groupName || '' };
        _writePrefsLocal(_prefs);
      }
    } catch (_) {}
    updateUI();
  }
  // 目前車隊狀態（面板/貢獻用；優先記憶體快取、否則本機鏡像）。
  function myTeam() {
    var p = _prefs || _readPrefsLocal() || {};
    return { groupId: p.groupId || null, shareHotspots: !!p.shareHotspots, name: p.groupName || '' };
  }
  function _saveTeamPrefs(p) { _prefs = p; _writePrefsLocal(p); return prefsDoc().set(p, { merge: true }); }
  // 開/關「貢獻＋看隊友熱點」（沒退隊，只切分享）。
  async function setShareHotspots(on) {
    if (!ready || !user) throw new Error('尚未登入');
    var t = myTeam();
    await _saveTeamPrefs({ shareHotspots: !!on, groupId: t.groupId, groupName: t.name });
    updateUI();
  }
  // 建立車隊（自己當隊長，自動加入並開分享）。回傳 { groupId, name }。
  async function createCarTeam(name) {
    if (!ready || !user) throw new Error('尚未登入');
    name = (name || '').trim() || '我的車隊';
    var ref = db.collection('groups').doc();
    var gid = ref.id;
    await ref.set({ name: name, ownerUid: user.uid, createdAt: Date.now(), memberCount: 1 });
    await ref.collection('members').doc(user.uid).set({ name: myName(), joinedAt: Date.now() });
    await _saveTeamPrefs({ shareHotspots: true, groupId: gid, groupName: name });
    updateUI();
    return { groupId: gid, name: name };
  }
  // 產生車隊邀請碼（比照記帳者邀請碼；30 天效期）。
  async function createTeamInvite() {
    if (!ready || !user) throw new Error('尚未登入');
    var t = myTeam();
    if (!t.groupId) throw new Error('請先建立或加入車隊');
    for (var i = 0; i < 6; i++) {
      var code = _randCode();
      var ref = db.collection('groupInvites').doc(code);
      var snap = await ref.get();
      if (snap.exists) continue;
      await ref.set({ groupId: t.groupId, groupName: t.name || '', by: user.uid, createdAt: Date.now(), exp: Date.now() + 30 * 864e5 });
      return code;
    }
    throw new Error('請再試一次');
  }
  // 純函式（供測試）：車隊邀請碼是否可被 myUid 加入 → 阻擋原因字串，null=可加入。
  function _teamClaimBlock(d, myUid, myGroupId) {
    if (!d) return '邀請碼不存在';
    if (d.exp && d.exp < Date.now()) return '邀請碼已過期';
    if (d.groupId && d.groupId === myGroupId) return '你已經在這個車隊了';
    return null;
  }
  // 用邀請碼加入車隊（加入 members、memberCount +1、寫 prefs 並開分享）。
  async function joinCarTeam(code) {
    if (!ready || !user) throw new Error('尚未登入');
    code = (code || '').trim().toUpperCase();
    if (!code) throw new Error('請輸入邀請碼');
    var ref = db.collection('groupInvites').doc(code);
    var snap = await ref.get();
    var d = snap.exists ? snap.data() : null;
    var block = _teamClaimBlock(d, user.uid, myTeam().groupId);
    if (block) throw new Error(block);
    var gref = db.collection('groups').doc(d.groupId);
    await gref.collection('members').doc(user.uid).set({ name: myName(), joinedAt: Date.now() });
    try { await gref.set({ memberCount: firebase.firestore.FieldValue.increment(1) }, { merge: true }); } catch (_) {}
    await _saveTeamPrefs({ shareHotspots: true, groupId: d.groupId, groupName: d.groupName || '' });
    updateUI();
    return { groupId: d.groupId, name: d.groupName || '' };
  }
  // 退出車隊（移除 members、memberCount −1、清 prefs.groupId 並關分享）。
  async function leaveCarTeam() {
    if (!ready || !user) return;
    var t = myTeam();
    if (t.groupId) {
      try { await db.collection('groups').doc(t.groupId).collection('members').doc(user.uid).delete(); } catch (_) {}
      try { await db.collection('groups').doc(t.groupId).set({ memberCount: firebase.firestore.FieldValue.increment(-1) }, { merge: true }); } catch (_) {}
    }
    await _saveTeamPrefs({ shareHotspots: false, groupId: null, groupName: '' });
    updateUI();
  }
  // 純函式（供測試）：每日貢獻上限。state＝已存 {day,n}、today＝'YYYY-MM-DD'、want＝要加幾次。
  //   回 { take:實際可加, next:更新後 {day,n} }。跨日自動歸零。
  function _capTake(state, today, want) {
    want = (want == null) ? 1 : want;
    var cur = (state && state.day === today) ? (state.n || 0) : 0;
    var take = Math.max(0, Math.min(DAILY_CAP - cur, want));
    return { take: take, next: { day: today, n: cur + take } };
  }
  function _todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function _capRead() { try { return JSON.parse(localStorage.getItem(CONTRIB_KEY) || 'null'); } catch (_) { return null; } }
  function _capWrite(s) { try { localStorage.setItem(CONTRIB_KEY, JSON.stringify(s)); } catch (_) {} }
  function _doneList() { try { return JSON.parse(localStorage.getItem(DONE_KEY) || '[]'); } catch (_) { return []; } }
  function _doneHas(id) { return _doneList().indexOf(String(id)) >= 0; }
  function _doneAdd(id) { try { var s = _doneList(); s.push(String(id)); if (s.length > 2000) s = s.slice(-2000); localStorage.setItem(DONE_KEY, JSON.stringify(s)); } catch (_) {} }
  // 完成一趟載客 → 對該去識別化格子 count +1（有開分享＋在車隊、前端去重、每日上限）。回傳有無寫入。
  async function contributeHotspot(lat, lng, date, tripId) {
    if (!ready || !user) return false;
    var t = myTeam();
    if (!t.shareHotspots || !t.groupId) return false;
    if (typeof lat !== 'number' || typeof lng !== 'number') return false;
    if (tripId != null && _doneHas(tripId)) return false;         // 一趟一次
    var cap = _capTake(_capRead(), _todayStr(), 1);
    if (cap.take < 1) return false;                               // 超過每日上限
    var S = window.MaptripHotspotShare;
    if (!S) return false;
    var f = S.cellFields(lat, lng, date || new Date());
    try {
      await db.collection('groups').doc(t.groupId).collection('grid').doc(f.cellId)
        .set({ gLat: f.gLat, gLng: f.gLng, dayType: f.dayType, bucket: f.bucket,
               count: firebase.firestore.FieldValue.increment(1), updatedAt: Date.now() }, { merge: true });
      _capWrite(cap.next);
      if (tripId != null) _doneAdd(tripId);
      return true;
    } catch (_) { return false; }
  }
  // 讀「當前時段＋附近緯度帶」的隊 grid（複合查詢，需建索引 dayType+bucket+gLat）。經度在前端過濾。
  // 回傳 [{gLat,gLng,count,updatedAt}]（k-匿名/半徑過濾由 hotspot-share.teamCells 做）。
  async function readGroupGrid(lat, ctx, radiusM) {
    var out = [];
    if (!ready || !user) return out;
    var t = myTeam();
    if (!t.groupId) return out;
    var S = window.MaptripHotspotShare;
    if (!S) return out;
    ctx = ctx || S.nowContext();
    var band = S.latBand(lat, radiusM);
    try {
      var q = await db.collection('groups').doc(t.groupId).collection('grid')
        .where('dayType', '==', ctx.dayType).where('bucket', '==', ctx.bucket)
        .where('gLat', '>=', band.min).where('gLat', '<=', band.max).get();
      q.forEach(function (doc) { var d = doc.data() || {}; out.push({ gLat: d.gLat, gLng: d.gLng, count: d.count || 0, updatedAt: d.updatedAt || 0 }); });
    } catch (e) { log('readGroupGrid ' + (e && e.code)); }
    return out;
  }
  // 回填：把「自己的歷史上車點」聚成去識別化格子、分批寫進隊 grid（單次上限 500 格）。回傳寫入格數。
  async function backfillTeamGrid(pickups) {
    if (!ready || !user) throw new Error('尚未登入');
    var t = myTeam();
    if (!t.groupId) throw new Error('請先建立或加入車隊');
    var S = window.MaptripHotspotShare;
    if (!S) return 0;
    var cells = S.aggregateHistoryCells(pickups, BACKFILL_CAP);
    var gridCol = db.collection('groups').doc(t.groupId).collection('grid');
    var written = 0, i = 0;
    while (i < cells.length) {
      var batch = db.batch();
      var chunk = cells.slice(i, i + BATCH);
      chunk.forEach(function (c) {
        batch.set(gridCol.doc(c.cellId), { gLat: c.gLat, gLng: c.gLng, dayType: c.dayType, bucket: c.bucket,
          count: firebase.firestore.FieldValue.increment(c.delta), updatedAt: Date.now() }, { merge: true });
      });
      await batch.commit();
      written += chunk.length; i += BATCH;
    }
    return written;
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
    if (unsubManual) unsubManual();
    try {
      // 監聽自己的「抽成」集合：記帳者改的抽成/車資覆蓋會即時同步回司機本機
      unsubComm = db.collection('users').doc(user.uid).collection('commissions').onSnapshot(snap => {
        let changed = false;
        snap.forEach(doc => {
          const c = doc.data() || {};
          if (window.applyCommission && window.applyCommission(doc.id, c.commission || 0, c.dispatch || 0, c.fareOverride, c.payOverride)) changed = true;
        });
        if (changed && window.refreshAfterSync) window.refreshAfterSync();
      }, err => log('comm snapshot err ' + (err && err.code)));
    } catch (_) {}
    try {
      // 監聽自己的「手動補登」集合：記帳者代補的紀錄 → 顯示層合併（不進 days）
      unsubManual = db.collection('users').doc(user.uid).collection('manualTrips').onSnapshot(snap => {
        var list = []; snap.forEach(doc => { var m = doc.data() || {}; m.id = doc.id; list.push(m); });
        if (window.MaptripManual) { MaptripManual.set(list); if (window.refreshAfterSync) window.refreshAfterSync(); }
      }, err => log('manual snapshot err ' + (err && err.code)));
    } catch (_) {}
    try {
      // 先訂閱刪除名單（墓碑），確保天資料抵達前就知道哪些趟已刪除
      unsubDel = deletedDoc().onSnapshot(snap => {
        mergeCloudTombstones((snap.exists && snap.data().ids) || []);
      }, err => log('del snapshot err ' + (err && err.code)));

      let firstSnap = true;
      unsub = daysCol().onSnapshot(snap => {
        // 只處理「有變動的日子」（首個快照全部視為變動）：合併成本與變動量成正比。
        // 之前每個快照都全量解析＋全量合併＋逐日 stringify 整個資料集，
        // 而自己的回推寫入又觸發下一個快照 —— 資料量成長後（數 MB）
        // 這條鏈就是每次同步數十 MB 暫存配置的記憶體風暴
        const cloud = {};
        snap.docChanges().forEach(ch => {
          if (ch.type === 'removed') return;   // 雲端整天消失交由墓碑機制處理，不動本機
          cloud[ch.doc.id] = ch.doc.data().trips || [];
        });
        let tripCount = cloudInfo ? cloudInfo.trips : 0;
        if (firstSnap) {
          tripCount = 0;
          snap.forEach(doc => { tripCount += (doc.data().trips || []).length; });
        }
        cloudInfo = { days: snap.size, trips: tripCount, at: Date.now() };
        updateUI();
        if (Object.keys(cloud).length || firstSnap) mergeCloudIntoLocal(cloud, firstSnap);
        firstSnap = false;
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

  function mergeCloudIntoLocal(cloud, includeLocalOnly) {
    const local = getLocal();
    let changed = false;
    const toPush = [];
    // 首個快照才需要把「本機有、雲端沒有」的日子納入（推上雲端補齊）；
    // 之後的快照只合併雲端有變動的日子，成本與變動量成正比
    const days = new Set(includeLocalOnly
      ? [...Object.keys(local), ...Object.keys(cloud)]
      : Object.keys(cloud));
    days.forEach(day => {
      const merged = mergeTrips(local[day], cloud[day]);
      // 雲端與瘦身後的合併結果不同（缺趟或仍是胖資料）→ 回推，雲端也跟著瘦身。
      // 但「本機獨有日子」只在延續同帳號（_pushLocalOK）時才回推——否則會把上一個帳號
      // 殘留在本機的行程灌進現在這個帳號的雲端（跨帳號污染）。
      if (_pushLocalOK && JSON.stringify(merged) !== JSON.stringify(cloud[day] || [])) toPush.push(day);
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
    readDriverData: readDriverData, writeCommission: writeCommission, pullCommissions: pullCommissions,
    getAccess: getAccess, setAllowFareEdit: setAllowFareEdit,
    readExpenses: readExpenses, writeExpense: writeExpense, deleteExpense: deleteExpense, listenExpenses: listenExpenses,
    writeManualTrip: writeManualTrip, deleteManualTrip: deleteManualTrip,
    resetLocal: resetLocal,
    // 共享熱點/車隊（Phase 1）
    myTeam: myTeam, setShareHotspots: setShareHotspots,
    createCarTeam: createCarTeam, createTeamInvite: createTeamInvite, joinCarTeam: joinCarTeam, leaveCarTeam: leaveCarTeam,
    contributeHotspot: contributeHotspot, readGroupGrid: readGroupGrid, backfillTeamGrid: backfillTeamGrid,
    _claimBlock: _claimBlock, _shouldAuthorize: _shouldAuthorize, _switchDecision: _switchDecision,
    _teamClaimBlock: _teamClaimBlock, _capTake: _capTake };
})();
