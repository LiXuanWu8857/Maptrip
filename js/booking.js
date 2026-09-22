/* =============================================================
 * booking.js — 預約功能 Phase 1（MaptripBooking）
 * -------------------------------------------------------------
 * 地圖常駐鈕開滿版清單/表單，記錄預約時間/地點/客人/多個提醒；
 * 依日期分組可收合（今天鎖定展開）、狀態顏色（待確認琥珀→已確認綠）；
 * 一鍵多站導航（目前位置→出發地→目的地，Google Maps waypoints）、tel 撥號、
 * 截圖/分享確認卡＋手動標記已確認、12h 內紅點；App 開著時輪詢提醒。
 * 本機 localStorage maptrip_bookings ＋雲端 users/{uid}/bookings onSnapshot 同步。
 *
 * Phase 1 不做：背景原生通知（Phase 2）、客戶連結自動回填（Phase 3）。
 * 全部滿版 overlay（position:fixed;inset:0），非底部 sheet。
 * ============================================================= */
(function (global) {
  'use strict';

  var KEY = 'maptrip_bookings';
  var _list = [];
  var _alerted = {};     // 已提醒 key 集合（id:lead），避免重複跳
  var _tickTimer = null;
  var _editId = null;    // 表單目前編輯中的 id（null=新增）
  var _formReminders = [];   // 表單暫存的提醒分鐘陣列

  // ---------- 純函式（供測試） ----------
  function _pad(n) { return (n < 10 ? '0' : '') + n; }
  function _dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()); }

  // 依日期分組、每組依時間排序、日期升冪（近的在前），標記今天
  function _byDay(list, now) {
    var groups = {};
    (list || []).forEach(function (b) {
      if (!b || !b.pickupTime) return;
      var k = _dayKey(b.pickupTime);
      (groups[k] = groups[k] || []).push(b);
    });
    var todayK = _dayKey(now || Date.now());
    return Object.keys(groups).sort().map(function (k) {
      var items = groups[k].slice().sort(function (a, b) { return a.pickupTime - b.pickupTime; });
      return { day: k, items: items, isToday: k === todayK, count: items.length };
    });
  }

  // hours 內、狀態為 pending/confirmed 的預約筆數（剛好 hours 算、已過期不算）
  function _upcomingCount(list, hours, now) {
    now = now || Date.now();
    var end = now + hours * 3600000, n = 0;
    (list || []).forEach(function (b) {
      if (!b || !b.pickupTime) return;
      if ((b.status === 'pending' || b.status === 'confirmed') && b.pickupTime >= now && b.pickupTime <= end) n++;
    });
    return n;
  }

  // 該觸發的提醒（跨過提前點、尚在 pickup 前、未提醒過）；done/cancelled 不提醒
  function _dueReminders(list, now, alerted) {
    alerted = alerted || {};
    var out = [];
    (list || []).forEach(function (b) {
      if (!b || !b.pickupTime || !b.reminders || !b.reminders.length) return;
      if (b.status === 'done' || b.status === 'cancelled') return;
      b.reminders.forEach(function (lead) {
        var fire = b.pickupTime - lead * 60000;
        var key = b.id + ':' + lead;
        if (now >= fire && now <= b.pickupTime && !alerted[key]) out.push({ id: b.id, lead: lead, b: b, key: key });
      });
    });
    return out;
  }

  // 多站 Google 導航 URL：目的地優先，出發地當途經點；只有出發地時退成單點。
  // 座標優先、否則地址文字。cur＝目前位置（可省，Google 會自動用目前位置當起點）。
  function _navUrl(b, cur) {
    function enc(pt) {
      if (pt && pt.lat != null && pt.lng != null) return encodeURIComponent(pt.lat + ',' + pt.lng);
      return encodeURIComponent((pt && pt.text) || '');
    }
    function has(pt) { return !!(pt && (pt.text || pt.lat != null)); }
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving';
    if (cur && cur.lat != null && cur.lng != null) url += '&origin=' + encodeURIComponent(cur.lat + ',' + cur.lng);
    if (has(b.dest)) {
      url += '&destination=' + enc(b.dest);
      if (has(b.pickup)) url += '&waypoints=' + enc(b.pickup);
    } else {
      url += '&destination=' + enc(b.pickup);
    }
    return url;
  }

  function _statusMeta(s) {
    return ({
      pending:   { label: '待客戶確認', cls: 'pending' },
      confirmed: { label: '客戶已確認', cls: 'confirmed' },
      done:      { label: '已完成',     cls: 'done' },
      cancelled: { label: '已取消',     cls: 'cancelled' }
    })[s] || { label: s || '待客戶確認', cls: 'pending' };
  }

  // ---------- 儲存（本機＋雲端） ----------
  function _persist() { try { localStorage.setItem(KEY, JSON.stringify(_list)); } catch (_) {} }
  function _loadLocal() { try { _list = JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (_) { _list = []; } }
  function all() { return _list.slice(); }
  function get(id) { return _list.filter(function (b) { return b.id === id; })[0] || null; }
  function byDay() { return _byDay(_list, Date.now()); }
  function upcomingCount(hours) { return _upcomingCount(_list, hours || 12, Date.now()); }

  // 雲端 onSnapshot 回來 → 用雲端覆蓋本機快取（自己的資料，雲端為準）
  function set(list) {
    _list = (list || []).slice();
    _persist(); _updateBadge();
    if (_isListOpen()) _renderList();
  }

  function save(b) {
    b = b || {}; var now = Date.now();
    if (!b.id) { b.id = String(now); b.createdAt = now; }
    if (!b.status) b.status = 'pending';
    b.updatedAt = now;
    var i = -1;
    for (var k = 0; k < _list.length; k++) { if (_list[k].id === b.id) { i = k; break; } }
    if (i >= 0) _list[i] = b; else _list.push(b);
    _persist(); _updateBadge();
    try { if (global.MaptripSync && MaptripSync.writeBooking) MaptripSync.writeBooking(b); } catch (_) {}
    return b;
  }
  function remove(id) {
    _list = _list.filter(function (b) { return b.id !== id; });
    _persist(); _updateBadge();
    try { if (global.MaptripSync && MaptripSync.deleteBooking) MaptripSync.deleteBooking(id); } catch (_) {}
  }
  function markConfirmed(id) {
    var b = get(id); if (!b) return;
    b.status = 'confirmed'; b.confirmedAt = Date.now();
    save(b);
    if (_isListOpen()) _renderList();
  }
  function clear() { _list = []; try { localStorage.removeItem(KEY); } catch (_) {} _updateBadge(); if (_isListOpen()) _renderList(); }

  // ---------- 動作 ----------
  function navigate(id) {
    var b = get(id); if (!b) return;
    var cur = (global.__mtLive && __mtLive.pos) ? { lat: __mtLive.pos.lat, lng: __mtLive.pos.lng } : null;
    try { global.open(_navUrl(b, cur), '_blank'); } catch (_) {}
  }
  function call(id) {
    var b = get(id); if (!b || !b.phone) { _toast('沒有電話號碼'); return; }
    try { global.open('tel:' + b.phone, '_blank'); } catch (_) { try { location.href = 'tel:' + b.phone; } catch (__) {} }
  }
  function _toast(m) { try { if (global.toast) global.toast(m); } catch (_) {} }

  // ---------- App 內提醒輪詢（Phase 1；背景通知是 Phase 2） ----------
  function _tickReminders() {
    var due = _dueReminders(_list, Date.now(), _alerted);
    due.forEach(function (d) {
      _alerted[d.key] = 1;
      var b = d.b;
      var t = new Date(b.pickupTime), hhmm = _pad(t.getHours()) + ':' + _pad(t.getMinutes());
      var who = b.name || b.lineName || '';
      var where = (b.pickup && b.pickup.text) || '';
      _toast('⏰ ' + d.lead + ' 分後有預約：' + hhmm + ' ' + who + ' ' + where);
    });
  }

  // ---------- 12h 紅點 ----------
  function _updateBadge() {
    var btn = document.getElementById('booking-btn');
    if (!btn) return;
    var badge = btn.querySelector('.bk-badge');
    var n = _upcomingCount(_list, 12, Date.now());
    if (!badge) { badge = document.createElement('span'); badge.className = 'bk-badge'; btn.appendChild(badge); }
    if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = 'block'; }
    else { badge.style.display = 'none'; }
  }

  // ---------- UI：滿版清單 ----------
  function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function _isListOpen() { var el = document.getElementById('bk-list'); return !!el && el.style.display !== 'none'; }
  function _fmtDayLabel(k, isToday) {
    var p = k.split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return (isToday ? '📌 今天　' : '') + (+p[1]) + '/' + (+p[2]) + '（' + wd + '）';
  }
  function _fmtTime(ms) { var d = new Date(ms); return _pad(d.getHours()) + ':' + _pad(d.getMinutes()); }

  var _collapsed = {};   // 非今天日期組的收合狀態（true=收起）

  function _ensureListDom() {
    if (document.getElementById('bk-list')) return;
    var ov = document.createElement('div');
    ov.id = 'bk-list'; ov.className = 'bk-overlay'; ov.style.display = 'none';
    ov.innerHTML =
      '<div class="bk-head"><span class="bk-title">📋 預約</span>' +
      '<button class="bk-x" onclick="MaptripBooking.close()">✕</button></div>' +
      '<div class="bk-body" id="bk-list-body"></div>' +
      '<button class="bk-fab-add" onclick="MaptripBooking.openForm()">＋ 新增預約</button>';
    document.body.appendChild(ov);
  }
  function open() { _ensureListDom(); _renderList(); document.getElementById('bk-list').style.display = 'flex'; }
  function close() { var el = document.getElementById('bk-list'); if (el) el.style.display = 'none'; }

  function toggleDay(k) { _collapsed[k] = !_collapsed[k]; _renderList(); }

  function _cardHtml(b) {
    var sm = _statusMeta(b.status);
    var who = [b.name, b.lineName ? ('LINE:' + b.lineName) : ''].filter(Boolean).join('　');
    var route = _esc((b.pickup && b.pickup.text) || '—') + (b.dest && b.dest.text ? ' → ' + _esc(b.dest.text) : '');
    var reminders = (b.reminders && b.reminders.length) ? b.reminders.map(function (m) { return '<span class="bk-chip">⏰' + m + '分</span>'; }).join('') : '';
    var confirmLine = (b.status === 'confirmed' && b.confirmedAt)
      ? '<div class="bk-confirmed">✓ 客戶已確認 ' + _fmtTime(b.confirmedAt) + '</div>' : '';
    var btns = '<div class="bk-acts">' +
      '<button onclick="MaptripBooking.navigate(\'' + b.id + '\')">🧭 導航</button>' +
      (b.phone ? '<button onclick="MaptripBooking.call(\'' + b.id + '\')">📞 撥號</button>' : '') +
      (b.status === 'pending' ? '<button onclick="MaptripBooking.shareConfirm(\'' + b.id + '\')">📤 傳確認</button>' : '') +
      '<button onclick="MaptripBooking.openForm(\'' + b.id + '\')">✏️ 編輯</button>' +
      (b.status === 'pending' ? '<button class="bk-ok" onclick="MaptripBooking.markConfirmed(\'' + b.id + '\')">✓ 標記已確認</button>' : '') +
      '</div>';
    return '<div class="bk-card ' + sm.cls + '">' +
      '<div class="bk-crow"><span class="bk-time">' + _fmtTime(b.pickupTime) + '</span>' +
      '<span class="bk-pill ' + sm.cls + '">' + sm.label + '</span></div>' +
      (who ? '<div class="bk-who">' + _esc(who) + '</div>' : '') +
      '<div class="bk-route">' + route + '</div>' +
      (reminders ? '<div class="bk-chips">' + reminders + '</div>' : '') +
      confirmLine + btns + '</div>';
  }

  function _renderList() {
    _ensureListDom();
    var body = document.getElementById('bk-list-body');
    var groups = _byDay(_list, Date.now());
    if (!groups.length) { body.innerHTML = '<div class="bk-empty">目前沒有預約<br>點右下角「＋ 新增預約」開始</div>'; return; }
    body.innerHTML = groups.map(function (g) {
      var collapsed = !g.isToday && _collapsed[g.day];
      var arrow = g.isToday ? '' : '<span class="bk-arrow">' + (collapsed ? '▸' : '▾') + '</span>';
      var head = '<div class="bk-dhead"' + (g.isToday ? '' : ' onclick="MaptripBooking.toggleDay(\'' + g.day + '\')"') + '>' +
        '<span>' + _fmtDayLabel(g.day, g.isToday) + '　' + g.count + ' 筆</span>' + arrow + '</div>';
      var cards = collapsed ? '' : g.items.map(_cardHtml).join('');
      return '<div class="bk-group">' + head + cards + '</div>';
    }).join('');
  }

  // ---------- UI：滿版表單 ----------
  function _ensureFormDom() {
    if (document.getElementById('bk-form')) return;
    var ov = document.createElement('div');
    ov.id = 'bk-form'; ov.className = 'bk-overlay'; ov.style.display = 'none';
    ov.innerHTML =
      '<div class="bk-head"><span class="bk-title" id="bk-form-title">新增預約</span>' +
      '<button class="bk-x" onclick="MaptripBooking.closeForm()">✕</button></div>' +
      '<div class="bk-body" id="bk-form-body"></div>';
    document.body.appendChild(ov);
  }
  function openForm(id) {
    _ensureFormDom();
    _editId = id || null;
    var b = id ? get(id) : null;
    _formReminders = b && b.reminders ? b.reminders.slice() : [30];
    document.getElementById('bk-form-title').textContent = id ? '編輯預約' : '新增預約';
    _renderForm(b);
    document.getElementById('bk-form').style.display = 'flex';
  }
  function closeForm() { var el = document.getElementById('bk-form'); if (el) el.style.display = 'none'; _editId = null; }

  function _dtLocalValue(ms) {
    var d = ms ? new Date(ms) : new Date(Math.ceil(Date.now() / 900000) * 900000); // 預設取最近 15 分
    return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()) + 'T' + _pad(d.getHours()) + ':' + _pad(d.getMinutes());
  }
  function _renderForm(b) {
    b = b || {};
    var body = document.getElementById('bk-form-body');
    body.innerHTML =
      '<label class="bk-lbl">預約時間 <span class="bk-req">＊</span></label>' +
      '<input id="bk-f-time" class="bk-in" type="datetime-local" value="' + _dtLocalValue(b.pickupTime) + '">' +
      '<label class="bk-lbl">出發地 <span class="bk-req">＊</span></label>' +
      '<input id="bk-f-pickup" class="bk-in" type="text" placeholder="上車地點" value="' + _esc(b.pickup && b.pickup.text) + '">' +
      '<label class="bk-lbl">目的地</label>' +
      '<input id="bk-f-dest" class="bk-in" type="text" placeholder="下車地點（可留空）" value="' + _esc(b.dest && b.dest.text) + '">' +
      '<label class="bk-lbl">客人稱呼</label>' +
      '<input id="bk-f-name" class="bk-in" type="text" placeholder="例：林小姐" value="' + _esc(b.name) + '">' +
      '<label class="bk-lbl">電話</label>' +
      '<input id="bk-f-phone" class="bk-in" type="tel" inputmode="tel" placeholder="可撥號" value="' + _esc(b.phone) + '">' +
      '<label class="bk-lbl">LINE 名稱</label>' +
      '<input id="bk-f-line" class="bk-in" type="text" value="' + _esc(b.lineName) + '">' +
      '<label class="bk-lbl">備註</label>' +
      '<textarea id="bk-f-note" class="bk-in" rows="2">' + _esc(b.note) + '</textarea>' +
      '<label class="bk-lbl">提醒</label><div id="bk-f-reminders" class="bk-rem"></div>' +
      '<div class="bk-form-acts">' +
      '<button class="bk-save" onclick="MaptripBooking._saveForm()">儲存</button>' +
      (b.id ? '<button class="bk-del" onclick="MaptripBooking._deleteForm(\'' + b.id + '\')">刪除這筆</button>' : '') +
      '</div>';
    _renderReminderChips();
  }
  function _renderReminderChips() {
    var el = document.getElementById('bk-f-reminders'); if (!el) return;
    var chips = _formReminders.map(function (m, i) {
      return '<span class="bk-chip on">' + (m === 0 ? '準時' : m + '分') +
        '<button onclick="MaptripBooking._rmReminder(' + i + ')">✕</button></span>';
    }).join('');
    el.innerHTML = chips +
      '<select id="bk-f-addrem" class="bk-addrem" onchange="MaptripBooking._addReminder(this.value)">' +
      '<option value="">＋ 新增提醒</option><option value="0">準時</option><option value="15">15 分前</option>' +
      '<option value="30">30 分前</option><option value="60">60 分前</option></select>';
  }
  function _addReminder(v) {
    v = parseInt(v, 10); if (isNaN(v)) return;
    if (_formReminders.indexOf(v) < 0) { _formReminders.push(v); _formReminders.sort(function (a, b) { return a - b; }); }
    _renderReminderChips();
  }
  function _rmReminder(i) { _formReminders.splice(i, 1); _renderReminderChips(); }

  function _saveForm() {
    var timeV = (document.getElementById('bk-f-time') || {}).value;
    var pickup = ((document.getElementById('bk-f-pickup') || {}).value || '').trim();
    if (!timeV) { _toast('請填預約時間'); return; }
    if (!pickup) { _toast('請填出發地'); return; }
    var ms = new Date(timeV).getTime();
    if (isNaN(ms)) { _toast('時間格式有誤'); return; }
    var b = _editId ? (get(_editId) || {}) : {};
    b.id = _editId || undefined;
    b.pickupTime = ms;
    b.pickup = { text: pickup, lat: (b.pickup && b.pickup.lat), lng: (b.pickup && b.pickup.lng) };
    var destT = ((document.getElementById('bk-f-dest') || {}).value || '').trim();
    b.dest = destT ? { text: destT, lat: (b.dest && b.dest.lat), lng: (b.dest && b.dest.lng) } : null;
    b.name = ((document.getElementById('bk-f-name') || {}).value || '').trim();
    b.phone = ((document.getElementById('bk-f-phone') || {}).value || '').trim();
    b.lineName = ((document.getElementById('bk-f-line') || {}).value || '').trim();
    b.note = ((document.getElementById('bk-f-note') || {}).value || '').trim();
    b.reminders = _formReminders.slice();
    save(b);
    closeForm();
    if (_isListOpen()) _renderList(); else open();
    _toast('預約已儲存');
  }
  function _deleteForm(id) {
    var ok = true; try { ok = confirm('刪除這筆預約？'); } catch (_) {}
    if (!ok) return;
    remove(id); closeForm(); _renderList();
    _toast('已刪除');
  }

  // ---------- 傳確認（截圖分享，簡版：分享文字卡） ----------
  function shareConfirm(id) {
    var b = get(id); if (!b) return;
    var t = new Date(b.pickupTime);
    var txt = '【預約確認】\n' +
      '時間：' + (t.getMonth() + 1) + '/' + t.getDate() + ' ' + _fmtTime(b.pickupTime) + '\n' +
      '上車：' + ((b.pickup && b.pickup.text) || '') + '\n' +
      (b.dest && b.dest.text ? '目的地：' + b.dest.text + '\n' : '') +
      (b.name ? '稱呼：' + b.name + '\n' : '') +
      (b.note ? '備註：' + b.note + '\n' : '') +
      '請回覆確認，謝謝！';
    try {
      if (navigator.share) { navigator.share({ text: txt, title: '預約確認' }).catch(function () {}); }
      else if (navigator.clipboard) { navigator.clipboard.writeText(txt); _toast('已複製確認訊息，貼給客戶'); }
      else { _toast('此裝置不支援分享'); }
    } catch (_) { _toast('分享失敗'); }
  }

  // ---------- init ----------
  function init(ctx) {
    ctx = ctx || {};
    if (ctx.testMode) KEY = 'maptrip_bookings_test';
    _loadLocal();
    _updateBadge();
    if (_tickTimer) clearInterval(_tickTimer);
    _tickReminders();
    _tickTimer = setInterval(_tickReminders, 30000);
  }

  global.MaptripBooking = {
    init: init, open: open, close: close, openForm: openForm, closeForm: closeForm,
    save: save, remove: remove, markConfirmed: markConfirmed, clear: clear, set: set,
    all: all, get: get, byDay: byDay, upcomingCount: upcomingCount,
    navigate: navigate, call: call, shareConfirm: shareConfirm, toggleDay: toggleDay,
    _saveForm: _saveForm, _deleteForm: _deleteForm, _addReminder: _addReminder, _rmReminder: _rmReminder,
    _tickReminders: _tickReminders, _updateBadge: _updateBadge,
    // 純函式（測試）
    _byDay: _byDay, _upcomingCount: _upcomingCount, _dueReminders: _dueReminders,
    _navUrl: _navUrl, _statusMeta: _statusMeta, _dayKey: _dayKey
  };

})(typeof window !== 'undefined' ? window : globalThis);
