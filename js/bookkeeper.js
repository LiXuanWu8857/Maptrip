// bookkeeper.js — 記帳者模式（設計 X：記帳者只能讀行程、讀寫抽成）
// 司機端：產生邀請碼、看/撤銷授權的記帳者。
// 記帳者端：輸入邀請碼綁定、看多位司機、檢視某司機行程並編輯抽成。
// 全部靠 MaptripSync 提供的 Firestore 操作；本檔自帶樣式與面板 DOM。
(function () {
  'use strict';
  var WD = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  var _view = null;        // null=清單首頁；{driverUid,name}=某司機檢視
  var _editId = null;      // 正在編輯抽成的趟 id
  var _expEdit = null;     // 支出編輯狀態：null=無／'__new__'=新增中／<id>=編輯該筆
  var _cache = null;       // 某司機的 { days, commissions, name }
  var _bks = [];           // 目前清單：授權我的記帳者（供 onclick 只傳 uid、名字改用查表，杜絕名字注入）
  var _drivers = [];       // 目前清單：我協助記帳的司機

  function S() { return window.MaptripSync; }
  function nf(n) { return (Math.round(n) || 0).toLocaleString(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (m) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m]; }); }
  function fmtT(ts) { try { return new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } }
  function fmtKm(m) { return ((m || 0) / 1000).toFixed(1) + ' km'; }

  function injectCss() {
    if (document.getElementById('bk-css')) return;
    var s = document.createElement('style'); s.id = 'bk-css';
    s.textContent =
      '#bk-sheet{position:fixed;bottom:0;left:0;right:0;max-height:84vh;background:#fff;border-radius:20px 20px 0 0;' +
      'border-top:1px solid rgba(0,0,0,.08);z-index:31;display:none;flex-direction:column;box-shadow:0 -4px 24px rgba(0,0,0,.1);' +
      'padding-bottom:env(safe-area-inset-bottom,0);animation:slideUp .25s ease}' +
      '#bk-sheet.show{display:flex}' +
      '#bk-body{overflow-y:auto;flex:1;padding:4px 16px 18px}' +
      '.bk-sec{font-size:.82rem;color:#5f6368;font-weight:700;margin:16px 2px 8px}' +
      '.bk-btn{width:100%;background:rgba(26,115,232,.08);color:#1a73e8;border:1px solid rgba(26,115,232,.25);' +
      'border-radius:12px;padding:12px;font-size:.9rem;font-weight:600;font-family:inherit;cursor:pointer;margin-bottom:6px}' +
      '.bk-code{background:#1a73e8;color:#fff;border-radius:14px;padding:14px 16px;text-align:center;margin:6px 0 4px}' +
      '.bk-code .c{font-size:2rem;font-weight:800;letter-spacing:5px}' +
      '.bk-code .h{font-size:.76rem;opacity:.9;margin-top:4px}' +
      '.bk-row{display:flex;align-items:center;gap:10px;padding:11px 4px;border-bottom:1px solid rgba(0,0,0,.05)}' +
      '.bk-row .nm{flex:1;font-size:.9rem;color:#202124}.bk-row .sub{font-size:.72rem;color:#9aa0a6}' +
      '.bk-row .op{background:none;border:none;color:#c5221f;font-size:.8rem;font-family:inherit;cursor:pointer;padding:4px 6px}' +
      '.bk-row .go{color:#9aa0a6;font-size:1rem}' +
      '.bk-empty{text-align:center;color:#9aa0a6;font-size:.85rem;padding:18px 0}' +
      '.bk-sum{background:#e8f0fe;border-radius:14px;padding:12px 14px;margin:8px 0 4px}' +
      '.bk-sum .r{display:flex;align-items:baseline;justify-content:space-between}' +
      '.bk-sum .k{font-size:.8rem;color:#5f6368;font-weight:600}' +
      '.bk-sum .v{font-size:1.5rem;font-weight:800;color:#1a73e8}' +
      '.bk-sum .sub{font-size:.72rem;color:#5f6368;margin-top:2px}' +
      '.bk-sum .r2{display:flex;align-items:baseline;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,.07)}' +
      '.bk-sum .r2 .v{font-size:1rem}.bk-sum .sub2{font-size:.72rem;color:#9aa0a6;margin-left:auto}' +
      '.bk-day{font-size:.8rem;font-weight:700;color:#3c4043;margin:14px 2px 4px;background:#f1f3f4;border-radius:8px;padding:6px 10px}' +
      '.bk-trip{padding:9px 4px;border-bottom:1px solid rgba(0,0,0,.05)}' +
      '.bk-trip .l1{display:flex;align-items:center;gap:8px;font-size:.86rem;color:#202124}' +
      '.bk-trip .l1 .far{color:#1a73e8;font-weight:600}.bk-trip .l1 .cm{color:#c5221f;font-weight:600;margin-left:auto}' +
      '.bk-trip .l2{font-size:.72rem;color:#9aa0a6;margin-top:2px}' +
      '.bk-editrow{display:flex;gap:8px;margin-top:8px}' +
      '.bk-editrow input{flex:1;min-width:0;box-sizing:border-box;padding:9px 10px;border:1px solid rgba(0,0,0,.15);border-radius:8px;font-size:1rem;font-family:inherit;background:#fff;text-align:right}' +
      '.bk-editrow .lb{align-self:center;font-size:.78rem;color:#5f6368}' +
      '.bk-editrow button{padding:9px 12px;border:none;border-radius:8px;background:#1a73e8;color:#fff;font-weight:600;font-family:inherit;cursor:pointer}' +
      '.bk-back{background:none;border:none;color:#1a73e8;font-size:.9rem;font-family:inherit;cursor:pointer;padding:6px 0}' +
      '.bk-note{font-size:.74rem;color:#9aa0a6;margin:2px 2px 8px}' +
      '.bk-exprow{display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid rgba(0,0,0,.05)}' +
      '.bk-exprow .ic{font-size:1.1rem}.bk-exprow .mid{flex:1;min-width:0}' +
      '.bk-exprow .t1{font-size:.86rem;color:#202124}.bk-exprow .t2{font-size:.72rem;color:#9aa0a6}' +
      '.bk-exprow .am{color:#c5221f;font-weight:600;font-size:.86rem}' +
      '.bk-mini{background:none;border:1px solid rgba(0,0,0,.15);border-radius:8px;padding:4px 9px;font-size:.78rem;font-family:inherit;color:#3c4043;cursor:pointer}' +
      '.bk-mini.del{color:#c5221f;border-color:rgba(197,34,31,.3)}' +
      '.bk-explink{background:none;border:none;color:#1a73e8;font-size:.82rem;font-family:inherit;cursor:pointer;font-weight:600;margin-left:8px}' +
      '.bk-expform{background:#f8f9fa;border-radius:12px;padding:10px;margin:8px 0}' +
      '.bk-expform select,.bk-expform>input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid rgba(0,0,0,.15);' +
      'border-radius:8px;font-size:1rem;font-family:inherit;background:#fff;color:#202124;margin-top:8px}' +
      '.bk-expform select{margin-top:0}' +
      '.bk-erow{display:flex;gap:8px;margin-top:8px}.bk-erow input{flex:1;min-width:0;box-sizing:border-box;' +
      'padding:9px 10px;border:1px solid rgba(0,0,0,.15);border-radius:8px;font-size:1rem;font-family:inherit;background:#fff;color:#202124}' +
      '.bk-erow button{flex:1;padding:9px;border:none;border-radius:8px;background:#1a73e8;color:#fff;font-weight:600;font-family:inherit;cursor:pointer}' +
      '.bk-erow .bk-cancel{background:#e8eaed;color:#3c4043}' +
      '@media (prefers-color-scheme: dark){#bk-sheet{background:#1a1a1a;border-top-color:rgba(255,255,255,.07)}' +
      '.bk-sec{color:#9aa0a6}.bk-row .nm,.bk-trip .l1{color:#e8eaed}.bk-day{background:#242424;color:#c8ccd2}' +
      '.bk-sum{background:#1f2a3a}.bk-sum .k,.bk-sum .sub{color:#aab4c0}.bk-sum .v{color:#8ab4f8}' +
      '.bk-editrow input{background:#242424;border-color:rgba(255,255,255,.15);color:#e8eaed}' +
      '.bk-exprow .t1{color:#e8eaed}.bk-mini{color:#c8ccd2;border-color:rgba(255,255,255,.18)}' +
      '.bk-expform{background:#242424}' +
      '.bk-expform select,.bk-expform>input,.bk-erow input{background:#1a1a1a;border-color:rgba(255,255,255,.15);color:#e8eaed}' +
      '.bk-erow .bk-cancel{background:#333;color:#e8eaed}}';
    document.head.appendChild(s);
  }

  function ensureSheet() {
    injectCss();
    var el = document.getElementById('bk-sheet');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'bk-sheet';
    el.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-header"><span id="bk-title">記帳者</span>' +
      '<button class="sheet-close" onclick="closeBookkeeper()">✕</button></div>' +
      '<div id="bk-body"></div>';
    document.body.appendChild(el);
    return el;
  }

  function setBody(html) { var b = document.getElementById('bk-body'); if (b) b.innerHTML = html; }
  function setTitle(t) { var el = document.getElementById('bk-title'); if (el) el.textContent = t; }

  // ---------- 首頁（清單） ----------
  async function renderHome() {
    setTitle('記帳者');
    setBody('<div class="bk-empty">載入中…</div>');
    var s = S();
    var bks = [], drivers = [];
    try { if (s.processInviteClaims) await s.processInviteClaims(); } catch (_) {}
    try { bks = await s.listBookkeepers(); } catch (_) {}
    try { drivers = await s.listLinkedDrivers(); } catch (_) {}
    _bks = bks || []; _drivers = drivers || [];   // 存起來供 onclick 查名字（onclick 只傳安全的 uid）

    var h = '';
    // A. 授權我的記帳者（司機視角）
    h += '<div class="bk-sec">授權我的記帳者</div>';
    h += '<button class="bk-btn" onclick="MaptripBookkeeper.invite()">＋ 產生邀請碼給記帳者</button>';
    h += '<div class="bk-note">把碼給記帳者輸入即可授權；對方只能看你的行程與編輯抽成。</div>';
    if (!bks.length) h += '<div class="bk-empty">尚未授權任何記帳者</div>';
    // 名字只以 esc() 輸出到 HTML 文字節點；onclick 一律只帶 uid（Firebase uid 為英數，安全），
    // 名字改用 _bks/_drivers 查表 → 徹底杜絕名字含單引號時的 onclick 注入。
    else bks.forEach(function (b) {
      h += '<div class="bk-row"><div class="nm">' + esc(b.name || '（未命名）') + '</div>' +
        '<button class="op" onclick="MaptripBookkeeper.removeBk(\'' + esc(b.uid) + '\')">撤銷</button></div>';
    });

    // B. 我協助記帳的司機（記帳者視角）
    h += '<div class="bk-sec">我協助記帳的司機</div>';
    h += '<button class="bk-btn" onclick="MaptripBookkeeper.join()">輸入邀請碼加入一位司機</button>';
    if (!drivers.length) h += '<div class="bk-empty">尚未加入任何司機</div>';
    else drivers.forEach(function (d) {
      h += '<div class="bk-row" onclick="MaptripBookkeeper.openDriver(\'' + esc(d.driverUid) + '\')">' +
        '<div class="nm">' + esc(d.name || '（未命名司機）') + '</div>' +
        '<button class="op" onclick="event.stopPropagation();MaptripBookkeeper.unlink(\'' + esc(d.driverUid) + '\')">移除</button>' +
        '<span class="go">›</span></div>';
    });
    setBody(h);
  }

  // ---------- 某司機檢視（記帳者） ----------
  async function renderDriver() {
    setTitle('司機：' + (_view.name || ''));
    setBody('<button class="bk-back" onclick="MaptripBookkeeper.back()">‹ 返回</button><div class="bk-empty">載入中…</div>');
    var data;
    try { data = await S().readDriverData(_view.driverUid); }
    catch (e) {
      // 顯示真正的 Firestore 錯誤碼 → 精準判斷是「權限（規則/授權）」還是別的
      var code = (e && (e.code || e.message)) || '未知錯誤';
      var perm = /permission|denied|insufficient|missing/i.test(String(code));
      var msg = perm
        ? '沒有讀取權限（' + esc(code) + '）。<br>常見兩個原因：<br>① 司機還沒「打開一次 App」完成授權（授權要司機端 App 開一次才寫入雲端）。<br>② 雲端還沒部署「記帳者」的 Firestore 安全規則（見 docs/記帳者-firestore規則參考.md）。'
        : '讀取失敗（' + esc(code) + '）。<br>請司機打開一次 App 再試。';
      setBody('<button class="bk-back" onclick="MaptripBookkeeper.back()">‹ 返回</button>' +
        '<div class="bk-empty" style="text-align:left;line-height:1.7">' + msg + '</div>');
      return;
    }
    _cache = data;
    if (data.name && data.name !== _view.name) { _view.name = data.name; setTitle('司機：' + data.name); }

    var days = Object.keys(data.days).sort().reverse();
    var h = '<button class="bk-back" onclick="MaptripBookkeeper.back()">‹ 返回</button>';
    // 抽成累計小計：記帳者最想看的數字（這個月/全部幫這位司機記了多少）
    var sm = _summary(data.days, data.commissions);
    h += '<div class="bk-sum">' +
      '<div class="r"><span class="k">本月抽成（' + sm.ym + '）</span><span class="v">NT$ ' + nf(sm.month.comm) + '</span></div>' +
      '<div class="sub">' + sm.month.n + ' 趟' + (sm.month.disp ? '　叫車 NT$ ' + nf(sm.month.disp) : '') + '</div>' +
      '<div class="r2"><span class="k">全部抽成</span><span class="v">NT$ ' + nf(sm.all.comm) + '</span>' +
      '<span class="sub2">' + sm.all.n + ' 趟' + (sm.all.disp ? '　叫車 ' + nf(sm.all.disp) : '') + '</span></div>' +
      '</div>';
    h += '<div class="bk-note">你可以編輯每趟的「抽成／叫車費」；行程本身唯讀。</div>';
    h += _expensesSection(data.expenses || []);
    var any = false;
    days.forEach(function (day) {
      var trips = (data.days[day] || []).slice().sort(function (a, b) { return a.startTime - b.startTime; });
      if (!trips.length) return;
      any = true;
      h += '<div class="bk-day">' + day + '　' + trips.length + ' 趟</div>';
      trips.forEach(function (t) {
        var c = data.commissions[String(t.id)] || {};
        var comm = c.commission != null ? c.commission : (t.commission || 0);
        var disp = c.dispatch != null ? c.dispatch : (t.dispatch || 0);
        var pay = t.paymentMethod === 'card' ? '刷卡' : (t.paymentMethod === 'cash' ? '現金' : (t.paymentMethod === 'other' ? (t.label || '其他') : ''));
        h += '<div class="bk-trip">' +
          '<div class="l1"><span>' + fmtT(t.startTime) + '</span>' +
          (t.fare ? '<span class="far">NT$ ' + nf(t.fare) + '</span>' : '') +
          '<span>' + esc(pay) + '</span>' +
          '<span class="cm">抽成 ' + nf(comm) + (disp ? '／叫車 ' + nf(disp) : '') + '</span></div>' +
          '<div class="l2">' + fmtKm(t.totalDist) + '</div>';
        if (_editId === t.id) {
          h += '<div class="bk-editrow">' +
            '<span class="lb">抽成</span><input id="bk-c" type="number" inputmode="numeric" value="' + comm + '">' +
            '<span class="lb">叫車</span><input id="bk-d" type="number" inputmode="numeric" value="' + disp + '">' +
            '<button onclick="MaptripBookkeeper.saveComm(' + t.id + ')">存</button></div>';
        } else {
          h += '<button class="bk-btn" style="margin:6px 0 0;padding:7px" onclick="MaptripBookkeeper.edit(' + t.id + ')">編輯抽成</button>';
        }
        h += '</div>';
      });
    });
    if (!any) h += '<div class="bk-empty">這位司機還沒有行程紀錄</div>';
    setBody(h);
  }

  // 抽成累計小計（純函式，供測試）：跨所有日子加總「本月」與「全部」的抽成/叫車/趟數。
  // comm/disp 解析與逐趟顯示一致：記帳者填的 commissions 優先，否則沿用行程自帶值。
  function _summary(days, commissions, now) {
    var d = now ? new Date(now) : new Date();
    var ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    var all = { n: 0, comm: 0, disp: 0 }, month = { n: 0, comm: 0, disp: 0 };
    Object.keys(days || {}).forEach(function (day) {
      (days[day] || []).forEach(function (t) {
        var c = (commissions && commissions[String(t.id)]) || {};
        var comm = c.commission != null ? c.commission : (t.commission || 0);
        var disp = c.dispatch != null ? c.dispatch : (t.dispatch || 0);
        all.n++; all.comm += comm; all.disp += disp;
        if (String(day).slice(0, 7) === ym) { month.n++; month.comm += comm; month.disp += disp; }
      });
    });
    return { ym: ym, all: all, month: month };
  }

  // ---------- 司機支出（記帳者可讀寫刪；沿用 finance 的分類清單） ----------
  function _cats() { return (window.MaptripFinance && MaptripFinance.CATS) || [{ k: 'other', label: '其他', icon: '📦' }]; }
  function _catOf(k) { var m = (window.MaptripFinance && MaptripFinance.CAT_MAP) || {}; return m[k] || { label: k || '其他', icon: '📦' }; }
  function _today() { try { return (window.todayKey && todayKey()) || new Date().toISOString().slice(0, 10); } catch (_) { return new Date().toISOString().slice(0, 10); } }
  function _monthNow() { return _today().slice(0, 7); }

  function _expForm(e) {
    var cat = e ? (e.cat || 'other') : 'fuel';
    var opts = _cats().map(function (c) {
      return '<option value="' + c.k + '"' + (c.k === cat ? ' selected' : '') + '>' + c.icon + ' ' + esc(c.label) + '</option>';
    }).join('');
    var amt = e ? e.amount : '';
    var day = e ? (e.day || _today()) : _today();
    var note = e ? (e.note || '') : '';
    var idAttr = e ? esc(String(e.id)) : '';   // 空＝新增
    return '<div class="bk-expform">' +
      '<select id="bk-ecat">' + opts + '</select>' +
      '<div class="bk-erow">' +
        '<input id="bk-eamt" type="number" inputmode="numeric" placeholder="金額" value="' + (amt === '' ? '' : amt) + '">' +
        '<input id="bk-eday" type="date" value="' + esc(day) + '">' +
      '</div>' +
      '<input id="bk-enote" type="text" placeholder="備註（可空）" value="' + esc(note) + '">' +
      '<div class="bk-erow">' +
        '<button onclick="MaptripBookkeeper.expSave(\'' + idAttr + '\')">存</button>' +
        '<button class="bk-cancel" onclick="MaptripBookkeeper.expCancel()">取消</button>' +
      '</div></div>';
  }

  function _expensesSection(exps) {
    var list = (exps || []).slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var ym = _monthNow();
    var mSum = 0; list.forEach(function (e) { if (String(e.day || '').slice(0, 7) === ym) mSum += (e.amount || 0); });
    var h = '<div class="bk-sec">司機支出（' + list.length + '）　本月 NT$ ' + nf(mSum) +
      '<button class="bk-explink" onclick="MaptripBookkeeper.expAdd()">＋ 記一筆</button></div>';
    if (_expEdit === '__new__') h += _expForm(null);
    if (!list.length && _expEdit !== '__new__') h += '<div class="bk-empty">尚無支出</div>';
    list.forEach(function (e) {
      var c = _catOf(e.cat);
      h += '<div class="bk-exprow"><span class="ic">' + c.icon + '</span>' +
        '<div class="mid"><div class="t1">' + esc(c.label) + (e.note ? '：' + esc(e.note) : '') + '</div>' +
        '<div class="t2">' + esc(e.day || '') + '</div></div>' +
        '<span class="am">-' + nf(e.amount) + '</span>' +
        '<button class="bk-mini" onclick="MaptripBookkeeper.expEdit(\'' + esc(String(e.id)) + '\')">改</button>' +
        '<button class="bk-mini del" onclick="MaptripBookkeeper.expDel(\'' + esc(String(e.id)) + '\')">刪</button></div>';
      if (_expEdit === e.id) h += _expForm(e);   // 在該筆底下展開編輯表單
    });
    return h;
  }

  function expAdd() { _expEdit = '__new__'; renderDriver(); }
  function expEdit(id) { _expEdit = id; renderDriver(); }
  function expCancel() { _expEdit = null; renderDriver(); }
  async function expSave(id) {
    var cat = (document.getElementById('bk-ecat') || {}).value || 'other';
    var amt = parseInt((document.getElementById('bk-eamt') || {}).value, 10) || 0;
    var day = (document.getElementById('bk-eday') || {}).value || _today();
    var note = ((document.getElementById('bk-enote') || {}).value || '').trim();
    if (!amt || amt <= 0) { if (window.toast) toast('請輸入金額'); return; }
    var editing = !!(id && id !== '__new__');
    if (!_cache.expenses) _cache.expenses = [];
    var old = editing ? _cache.expenses.filter(function (x) { return String(x.id) === String(id); })[0] : null;
    var rec = { cat: cat, amount: amt, note: note, day: day, ts: (old && old.ts) || Date.now() };
    if (editing) rec.id = id;
    try {
      var finalId = await S().writeExpense(_view.driverUid, rec);
      var merged = { cat: cat, amount: amt, note: note, day: day, ts: rec.ts, id: editing ? id : finalId };
      var i = -1;
      for (var k = 0; k < _cache.expenses.length; k++) { if (String(_cache.expenses[k].id) === String(merged.id)) { i = k; break; } }
      if (i >= 0) _cache.expenses[i] = merged; else _cache.expenses.push(merged);
      _expEdit = null;
      renderDriver();
      if (window.toast) toast('已儲存支出');
    } catch (e) { if (window.toast) toast('儲存失敗：' + ((e && (e.code || e.message)) || e)); }
  }
  async function expDel(id) {
    if (!confirm('刪除這筆支出？')) return;
    try {
      await S().deleteExpense(_view.driverUid, id);
      if (_cache && _cache.expenses) _cache.expenses = _cache.expenses.filter(function (x) { return String(x.id) !== String(id); });
      renderDriver();
      if (window.toast) toast('已刪除');
    } catch (e) { if (window.toast) toast('刪除失敗：' + ((e && (e.code || e.message)) || e)); }
  }

  function render() { if (_view) renderDriver(); else renderHome(); }

  // ---------- 動作 ----------
  function open() {
    if (!S() || !(S().myUid && S().myUid())) { if (window.toast) toast('請先登入雲端'); return; }
    ensureSheet();
    _view = null; _editId = null; _expEdit = null;
    document.getElementById('bk-sheet').classList.add('show');
    var ov = document.getElementById('sheet-overlay');
    if (ov) { ov.style.display = 'block'; ov.onclick = close; }
    render();
  }
  function close() {
    var s = document.getElementById('bk-sheet'); if (s) s.classList.remove('show');
    var ov = document.getElementById('sheet-overlay');
    if (ov) { ov.style.display = 'none'; ov.onclick = window.closeActiveSheet || null; }
    _view = null; _editId = null; _expEdit = null;
  }
  async function invite() {
    try {
      var code = await S().createInvite();
      setBody('<div class="bk-code"><div class="c">' + code + '</div><div class="h">把這組碼給記帳者輸入即可授權</div></div>' +
        '<button class="bk-btn" onclick="MaptripBookkeeper.copy(\'' + code + '\')">複製邀請碼</button>' +
        '<button class="bk-btn" onclick="MaptripBookkeeper.render()">‹ 回列表</button>');
    } catch (e) { if (window.toast) toast('產生失敗：' + ((e && e.message) || e)); }
  }
  function copy(code) {
    try { navigator.clipboard && navigator.clipboard.writeText(code); if (window.toast) toast('已複製：' + code); }
    catch (_) { if (window.toast) toast('邀請碼：' + code); }
  }
  async function join() {
    var code = (prompt('輸入司機給你的邀請碼') || '').trim();
    if (!code) return;
    try {
      var r = await S().redeemInvite(code);
      if (window.toast) toast('已加入司機：' + (r.driverName || ''));
      render();
    } catch (e) { if (window.toast) toast(((e && e.message) || '加入失敗')); }
  }
  function _bkName(uid) { var b = _bks.find(function (x) { return x.uid === uid; }); return (b && b.name) || ''; }
  function _drvName(uid) { var d = _drivers.find(function (x) { return x.driverUid === uid; }); return (d && d.name) || ''; }
  async function removeBk(uid) {
    if (!confirm('撤銷「' + _bkName(uid) + '」的記帳者授權？\n（對方將無法再看你的行程）')) return;
    try { await S().removeBookkeeper(uid); render(); if (window.toast) toast('已撤銷'); } catch (_) {}
  }
  async function unlink(driverUid) {
    if (!confirm('從你的清單移除司機「' + _drvName(driverUid) + '」？\n（注意：這只移除你這邊的清單，司機端對你的授權仍在，需請司機自行撤銷）')) return;
    try { await S().unlinkDriver(driverUid); render(); } catch (_) {}
  }
  function openDriver(driverUid, name) { _view = { driverUid: driverUid, name: name || _drvName(driverUid) }; _editId = null; _expEdit = null; renderDriver(); }
  function back() { _view = null; _editId = null; _expEdit = null; renderHome(); }
  function edit(tripId) { _editId = tripId; renderDriver(); }
  async function saveComm(tripId) {
    var comm = parseInt((document.getElementById('bk-c') || {}).value) || 0;
    var disp = parseInt((document.getElementById('bk-d') || {}).value) || 0;
    try {
      await S().writeCommission(_view.driverUid, tripId, comm, disp);
      // 更新快取即時反映
      if (_cache) _cache.commissions[String(tripId)] = { commission: comm, dispatch: disp };
      _editId = null;
      renderDriver();
      if (window.toast) toast('已更新抽成');
    } catch (e) { if (window.toast) toast('更新失敗：' + ((e && e.message) || e)); }
  }

  window.MaptripBookkeeper = {
    open: open, close: close, render: render, invite: invite, copy: copy, join: join,
    removeBk: removeBk, unlink: unlink, openDriver: openDriver, back: back, edit: edit, saveComm: saveComm,
    expAdd: expAdd, expEdit: expEdit, expCancel: expCancel, expSave: expSave, expDel: expDel,
    _summary: _summary
  };
  window.openBookkeeper = open;
  window.closeBookkeeper = close;
})();
