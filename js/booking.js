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
  var _formDests = [''];      // 表單暫存的下車點文字（可多個，最多 4）
  var MAX_DESTS = 4;

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

  function _has(pt) { return !!(pt && (pt.text || pt.lat != null)); }
  // 下車點陣列（新 dests；相容舊 dest）
  function _destsOf(b) {
    if (b && b.dests && b.dests.length) return b.dests.filter(_has);
    if (b && _has(b.dest)) return [b.dest];
    return [];
  }
  // 多站 Google 導航 URL：目前位置 → 出發地 → 下車點1..N。最後一站當 destination、其餘當 waypoints。
  // 座標優先、否則地址文字。cur＝目前位置（可省，Google 會自動用目前位置當起點）。
  function _navUrl(b, cur) {
    function enc(pt) {
      if (pt && pt.lat != null && pt.lng != null) return encodeURIComponent(pt.lat + ',' + pt.lng);
      return encodeURIComponent((pt && pt.text) || '');
    }
    var stops = [];
    if (_has(b.pickup)) stops.push(b.pickup);
    _destsOf(b).forEach(function (d) { stops.push(d); });
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving';
    if (cur && cur.lat != null && cur.lng != null) url += '&origin=' + encodeURIComponent(cur.lat + ',' + cur.lng);
    if (!stops.length) return url;
    url += '&destination=' + enc(stops[stops.length - 1]);
    var mids = stops.slice(0, -1);
    if (mids.length) url += '&waypoints=' + mids.map(enc).join('%7C');   // %7C = |
    return url;
  }

  // 提前量分鐘 → 好讀文字
  function _fmtLead(m) {
    m = +m || 0;
    if (m === 0) return '準時';
    if (m < 60) return m + '分前';
    if (m % 1440 === 0) return (m / 1440) + '天前';
    if (m % 60 === 0) return (m / 60) + '小時前';
    return Math.floor(m / 60) + '小時' + (m % 60) + '分前';
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

  // 卡片時間帶用：日期標籤（今天/明天/日期 · 週X）
  function _dayLabelShort(ms, now) {
    var d = new Date(ms); now = now || Date.now();
    var wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    var dk = _dayKey(ms), tk = _dayKey(now), tmr = _dayKey(now + 86400000);
    var rel = dk === tk ? '今天' : (dk === tmr ? '明天' : ((d.getMonth() + 1) + '/' + d.getDate()));
    return rel + ' · 週' + wd;
  }
  // 倒數副標：24 小時內才顯示「還有 N 小時 M 分」
  function _relSub(ms, now) {
    now = now || Date.now();
    var diff = ms - now;
    if (diff < 0) return '已過時間';
    if (diff > 86400000) return '';
    var mins = Math.round(diff / 60000), h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? ('還有 ' + h + ' 小時' + (m ? ' ' + m + ' 分' : '')) : ('還有 ' + m + ' 分');
  }

  function _cardHtml(b) {
    var sm = _statusMeta(b.status);
    var who = [b.name, b.lineName ? ('LINE:' + b.lineName) : ''].filter(Boolean).join('　');
    // 路線：出發 →（下車點 1..N），每站一列＋圓點
    var stops = [];
    if (b.pickup && b.pickup.text) stops.push({ lead: '出發', cls: 'a', text: b.pickup.text });
    _destsOf(b).forEach(function (d, i) { stops.push({ lead: (i === _destsOf(b).length - 1 ? '目的' : '下車'), cls: 'b', text: d.text }); });
    var route = stops.length ? '<div class="bk-route">' + stops.map(function (s) {
      return '<div class="bk-stop"><span class="bk-dot ' + s.cls + '"></span><span class="bk-slead">' + s.lead + '</span><span class="bk-saddr">' + _esc(s.text) + '</span></div>';
    }).join('') + '</div>' : '';
    var noteBox = b.note ? '<div class="bk-note">📝 ' + _esc(b.note) + '</div>' : '';
    var reminders = (b.reminders && b.reminders.length) ? '<div class="bk-chips">' + b.reminders.map(function (m) { return '<span class="bk-chip rem">🔔' + _fmtLead(m) + '</span>'; }).join('') + '</div>' : '';
    var confirmLine = (b.status === 'confirmed' && b.confirmedAt)
      ? '<div class="bk-confirmed">✓ 客戶已確認 ' + _fmtTime(b.confirmedAt) + '</div>' : '';
    var navBtn = '<button class="bk-nav" onclick="MaptripBooking.navigate(\'' + b.id + '\')">🧭 導航　<small>出發地 → 目的地</small></button>';
    var btns = '<div class="bk-acts">' +
      (b.phone ? '<button onclick="MaptripBooking.call(\'' + b.id + '\')">📞 撥號</button>' : '') +
      (b.status === 'pending' ? '<button onclick="MaptripBooking.shareConfirm(\'' + b.id + '\')">📤 傳確認</button>' : '') +
      '<button onclick="MaptripBooking.openForm(\'' + b.id + '\')">✏️ 編輯</button>' +
      (b.status === 'pending' ? '<button class="bk-ok" onclick="MaptripBooking.markConfirmed(\'' + b.id + '\')">✓ 標記已確認</button>' : '') +
      '</div>';
    var now = Date.now();
    var soon = (b.status === 'pending' && b.pickupTime > now && b.pickupTime - now <= 12 * 3600000);
    var sub = _relSub(b.pickupTime, now);
    return '<div class="bk-card ' + sm.cls + (soon ? ' soon' : '') + '">' +
      '<div class="bk-dt">' +
        '<span class="bk-time">' + _fmtTime(b.pickupTime) + '</span>' +
        '<div class="bk-dtmid"><span class="bk-day">' + _dayLabelShort(b.pickupTime, now) + '</span>' +
        (sub ? '<span class="bk-sub">' + sub + '</span>' : '') + '</div>' +
        '<span class="bk-pill ' + sm.cls + '">' + sm.label + '</span>' +
      '</div>' +
      '<div class="bk-body2">' +
      (who ? '<div class="bk-who">' + _esc(who) + '</div>' : '') +
      route + noteBox + reminders + confirmLine + navBtn + btns +
      '</div></div>';
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
    var ds = b ? _destsOf(b).map(function (d) { return d.text || ''; }) : [];
    _formDests = ds.length ? ds : [''];
    document.getElementById('bk-form-title').textContent = id ? '編輯預約' : '新增預約';
    _renderForm(b);
    document.getElementById('bk-form').style.display = 'flex';
  }
  function closeForm() { var el = document.getElementById('bk-form'); if (el) el.style.display = 'none'; _editId = null; }

  function _dtStr(d) {
    return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()) + 'T' + _pad(d.getHours()) + ':' + _pad(d.getMinutes());
  }
  // 表單預設值：新的取「下一個 5 分整」；編輯取原值
  function _dtLocalValue(ms) {
    return _dtStr(ms ? new Date(ms) : new Date(Math.ceil(Date.now() / 300000) * 300000));
  }
  // datetime-local 的 min＝現在（不得早於現在）
  function _dtLocalMin() { return _dtStr(new Date(Date.now() - 60000)); }   // 留 1 分鐘寬容
  function _renderForm(b) {
    b = b || {};
    var body = document.getElementById('bk-form-body');
    body.innerHTML =
      '<label class="bk-lbl">預約時間 <span class="bk-req">＊</span></label>' +
      '<input id="bk-f-time" class="bk-in bk-in-dt" type="datetime-local" step="300"' +
      ' min="' + _dtLocalMin() + '" value="' + _dtLocalValue(b.pickupTime) + '">' +
      '<label class="bk-lbl">出發地（上車） <span class="bk-req">＊</span></label>' +
      '<input id="bk-f-pickup" class="bk-in" type="text" placeholder="上車地點" value="' + _esc(b.pickup && b.pickup.text) + '">' +
      '<label class="bk-lbl">下車點</label><div id="bk-f-dests"></div>' +
      '<label class="bk-lbl">客人稱呼</label>' +
      '<input id="bk-f-name" class="bk-in" type="text" placeholder="例：林小姐" value="' + _esc(b.name) + '">' +
      '<label class="bk-lbl">電話</label>' +
      '<input id="bk-f-phone" class="bk-in" type="tel" inputmode="tel" placeholder="可撥號" value="' + _esc(b.phone) + '">' +
      '<label class="bk-lbl">LINE 名稱</label>' +
      '<input id="bk-f-line" class="bk-in" type="text" value="' + _esc(b.lineName) + '">' +
      '<label class="bk-lbl">備註</label>' +
      '<textarea id="bk-f-note" class="bk-in" rows="2" placeholder="例：大件行李兩件、需協助搬運">' + _esc(b.note) + '</textarea>' +
      '<label class="bk-lbl">提醒（可多個）</label><div id="bk-f-reminders" class="bk-rem"></div>' +
      '<div class="bk-form-acts">' +
      '<button class="bk-save" onclick="MaptripBooking._saveForm()">儲存</button>' +
      (b.id ? '<button class="bk-del" onclick="MaptripBooking._deleteForm(\'' + b.id + '\')">刪除這筆</button>' : '') +
      '</div>';
    _renderDests();
    _renderReminderChips();
  }
  // 下車點動態列（最多 MAX_DESTS，可＋可✕）
  function _readDestInputs() {
    var arr = [];
    for (var i = 0; i < _formDests.length; i++) {
      var el = document.getElementById('bk-f-dest-' + i);
      arr.push(el ? el.value : _formDests[i]);
    }
    _formDests = arr;
  }
  function _renderDests() {
    var el = document.getElementById('bk-f-dests'); if (!el) return;
    if (!_formDests.length) _formDests = [''];
    var rows = _formDests.map(function (t, i) {
      var ph = (i === 0 ? '下車地點（可留空）' : '下車點 ' + (i + 1));
      var rm = _formDests.length > 1 ? '<button class="bk-dest-x" onclick="MaptripBooking._rmDest(' + i + ')">✕</button>' : '';
      return '<div class="bk-dest-row"><input id="bk-f-dest-' + i + '" class="bk-in" type="text" placeholder="' + ph + '" value="' + _esc(t) + '">' + rm + '</div>';
    }).join('');
    var addBtn = _formDests.length < MAX_DESTS
      ? '<button class="bk-adddest" onclick="MaptripBooking._addDest()">＋ 新增下車點</button>' : '';
    el.innerHTML = rows + addBtn;
  }
  function _addDest() { _readDestInputs(); if (_formDests.length < MAX_DESTS) _formDests.push(''); _renderDests(); }
  function _rmDest(i) { _readDestInputs(); _formDests.splice(i, 1); if (!_formDests.length) _formDests = ['']; _renderDests(); }
  function _renderReminderChips() {
    var el = document.getElementById('bk-f-reminders'); if (!el) return;
    var chips = _formReminders.map(function (m, i) {
      return '<span class="bk-chip on">🔔' + _fmtLead(m) +
        '<button onclick="MaptripBooking._rmReminder(' + i + ')">✕</button></span>';
    }).join('');
    el.innerHTML = chips +
      '<select id="bk-f-addrem" class="bk-addrem" onchange="MaptripBooking._addReminder(this.value); this.value=\'\';">' +
      '<option value="">＋ 新增提醒</option>' +
      '<option value="0">準時</option><option value="15">15 分前</option>' +
      '<option value="30">30 分前</option><option value="60">1 小時前</option>' +
      '<option value="360">6 小時前</option><option value="720">12 小時前</option>' +
      '<option value="1440">1 天前</option><option value="custom">自定義…</option></select>';
  }
  function _addReminder(v) {
    var m;
    if (v === 'custom') {
      var ans = null; try { ans = prompt('自定義提醒：提前幾分鐘？（例：90＝1.5小時、180＝3小時）'); } catch (_) {}
      if (ans == null) return;
      m = parseInt(ans, 10);
      if (isNaN(m) || m < 0) { _toast('請輸入 0 以上的分鐘數'); return; }
    } else {
      m = parseInt(v, 10);
      if (isNaN(m)) return;
    }
    if (_formReminders.indexOf(m) < 0) { _formReminders.push(m); _formReminders.sort(function (a, b) { return a - b; }); }
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
    ms = Math.round(ms / 300000) * 300000;                 // 分鐘 5 進位
    if (ms < Date.now() - 60000) { _toast('預約時間不能早於現在'); return; }
    var b = _editId ? (get(_editId) || {}) : {};
    var oldDests = _destsOf(b);                             // 保留原有座標（依序對應）
    b.id = _editId || undefined;
    b.pickupTime = ms;
    b.pickup = { text: pickup, lat: (b.pickup && b.pickup.lat), lng: (b.pickup && b.pickup.lng) };
    _readDestInputs();
    b.dests = _formDests.map(function (t) { return (t || '').trim(); }).filter(Boolean)
      .map(function (t, i) { var o = oldDests[i]; return { text: t, lat: (o && o.text === t ? o.lat : undefined), lng: (o && o.text === t ? o.lng : undefined) }; });
    delete b.dest;                                         // 改用 dests 陣列
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
      _destsOf(b).map(function (d, i) { return '下車' + (_destsOf(b).length > 1 ? (i + 1) : '') + '：' + d.text + '\n'; }).join('') +
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
    _addDest: _addDest, _rmDest: _rmDest,
    _tickReminders: _tickReminders, _updateBadge: _updateBadge,
    // 純函式（測試）
    _byDay: _byDay, _upcomingCount: _upcomingCount, _dueReminders: _dueReminders,
    _navUrl: _navUrl, _statusMeta: _statusMeta, _dayKey: _dayKey, _fmtLead: _fmtLead, _destsOf: _destsOf
  };

})(typeof window !== 'undefined' ? window : globalThis);
