/* restrictions.js — 手動標注「限時禁轉路口」（禁左轉/右轉/迴轉/禁行）＋地圖標記＋接近時段提醒。
 *
 * 使用者要的：在有「時間限制」的禁轉路口標上時間，接近時＋正好在限制時段內就提醒。
 * Phase 1（本檔）：手動標注（存本機 localStorage）。Phase 2（未來）：OSM 自動抓當補充來源。
 *
 * 放置方式＝「地圖中心」：把路口移到畫面中央十字，按「就是這裡」→ 填類型/時段 → 存。
 *   （向量地圖的 gl-compat map click 不帶 latlng，改用 getCenter 兩引擎都正確。）
 * 依賴：window.__mtLive.map / .pos、window.L、window.toast。純函式（時段解析/判定）供測試。
 */
(function (global) {
  'use strict';

  var KEY = 'maptrip_restrict';
  var ALERT_M = 180;            // 接近提醒半徑（公尺）
  var ALERT_COOLDOWN = 120000;  // 同一路口最短提醒間隔（毫秒）
  var TYPES = {
    noleft:  { short: '禁左', label: '禁止左轉', glyph: '↰' },
    noright: { short: '禁右', label: '禁止右轉', glyph: '↱' },
    nouturn: { short: '禁迴', label: '禁止迴轉', glyph: '⤾' },
    noentry: { short: '禁行', label: '禁止進入', glyph: '⊘' }
  };
  var DAYS = { all: '每天', wk: '平日', we: '假日' };

  // ---------- 資料 ----------
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (_) { return []; } }
  function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list || [])); } catch (_) {} }
  function all() { return load(); }
  function _id() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function add(rec) { var l = load(); l.push(rec); save(l); return rec; }
  function update(id, patch) { var l = load(), i = l.findIndex(function (r) { return r.id === id; }); if (i >= 0) { l[i] = Object.assign({}, l[i], patch); save(l); } return l[i]; }
  function remove(id) { save(load().filter(function (r) { return r.id !== id; })); }

  // ---------- 純函式：時段解析/判定/格式化（供測試）----------
  function _pad(n) { return (n < 10 ? '0' : '') + n; }
  // 解析 "07-09,17-19" / "07:00-09:00" / "7-9 17-19" → [{from,to}]（分鐘）。留空＝[]＝全天。
  function _parseWindows(str) {
    if (!str) return [];
    return String(str).split(/[,，、;；\s]+/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (seg) {
      var m = seg.match(/^(\d{1,2})(?::(\d{2}))?\s*[-~到–]\s*(\d{1,2})(?::(\d{2}))?$/);
      if (!m) return null;
      var f = (+m[1]) * 60 + (+(m[2] || 0)), t = (+m[3]) * 60 + (+(m[4] || 0));
      if (f > 1440 || t > 1440) return null;
      return { from: f, to: t };
    }).filter(Boolean);
  }
  function _hhmm(mins) { return _pad(Math.floor(mins / 60)) + ':' + _pad(mins % 60); }
  // 顯示：整點省略分（07-09），有分才顯示（07:30-09:00）
  function _fmtWin(w) {
    var a = (w.from % 60 === 0) ? _pad(w.from / 60) : _hhmm(w.from);
    var b = (w.to % 60 === 0) ? _pad(w.to / 60) : _hhmm(w.to);
    return a + '-' + b;
  }
  function _fmtWindows(rec) {
    var ws = (rec && rec.windows) || [];
    if (!ws.length) return '全天';
    return ws.map(_fmtWin).join(' ');
  }
  function _isWeekend(d) { var w = d.getDay(); return w === 0 || w === 6; }
  function _dayScopeOk(scope, date) {
    if (!scope || scope === 'all') return true;
    var we = _isWeekend(date);
    return scope === 'we' ? we : !we;   // wk＝平日
  }
  function _inWindow(w, mins) {
    return (w.from <= w.to) ? (mins >= w.from && mins < w.to) : (mins >= w.from || mins < w.to);   // 跨午夜
  }
  // 此路口此刻是否正在「禁止」中（無 windows＝全天禁止；只看日型＋時段）
  function _isActiveAt(rec, date) {
    date = date || new Date();
    if (!_dayScopeOk(rec.day, date)) return false;
    var ws = rec.windows || [];
    if (!ws.length) return true;
    var mins = date.getHours() * 60 + date.getMinutes();
    return ws.some(function (w) { return _inWindow(w, mins); });
  }
  function _haversine(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var la1 = a.lat * toR, la2 = b.lat * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // 純函式：給定清單/位置/時間/上次提醒紀錄 → 回「這次該提醒的路口」＋更新後的紀錄。
  function _dueAlerts(list, pos, now, lastMap, radiusM, cooldownMs) {
    radiusM = radiusM || ALERT_M; cooldownMs = cooldownMs || ALERT_COOLDOWN;
    var due = [], next = Object.assign({}, lastMap || {});
    (list || []).forEach(function (r) {
      if (typeof r.lat !== 'number' || typeof r.lng !== 'number') return;
      var near = _haversine(pos, { lat: r.lat, lng: r.lng }) <= radiusM;
      var active = _isActiveAt(r, new Date(now));
      var last = next[r.id] || 0;
      if (near && active && (now - last) >= cooldownMs) { due.push(r); next[r.id] = now; }
      else if (!near && next[r.id]) { delete next[r.id]; }   // 離開 → 清紀錄，下次接近可再提醒
    });
    return { due: due, last: next };
  }

  // ---------- 地圖 ----------
  function gmap() { return window.__mtLive && window.__mtLive.map; }
  function say(m) { if (window.toast) window.toast(m); }
  var _markers = [];
  function clearMap() { var m = gmap(); _markers.forEach(function (k) { try { m && m.removeLayer(k); } catch (_) {} }); _markers = []; }
  function _iconHtml(rec) {
    var t = TYPES[rec.type] || TYPES.noleft;
    var tw = _fmtWindows(rec);
    var dtag = (rec.day && rec.day !== 'all') ? ('<span class="mt-rx-d">' + DAYS[rec.day] + '</span>') : '';
    return '<div class="mt-rx"><div class="mt-rx-ic">' + t.glyph + '</div>' +
      '<div class="mt-rx-t">' + dtag + tw + '</div></div>';
  }
  function drawAll() {
    var m = gmap(); if (!m || !window.L) return;
    _ensureCss();
    clearMap();
    load().forEach(function (rec) {
      try {
        var icon = L.divIcon({ className: 'mt-rx-wrap', html: _iconHtml(rec), iconSize: [1, 1], iconAnchor: [0, 0] });
        var mk = L.marker([rec.lat, rec.lng], { icon: icon });
        mk.addTo(m);
        (function (id) {
          var open = function () { var r = load().find(function (x) { return x.id === id; }); if (r) openForm(r); };
          if (typeof mk.on === 'function') mk.on('click', open);
          else if (mk.getElement) { var el = mk.getElement(); if (el) el.addEventListener('click', open); }
        })(rec.id);
        _markers.push(mk);
      } catch (_) {}
    });
  }

  // ---------- CSS ----------
  var _cssAdded = false;
  function _ensureCss() {
    if (_cssAdded) return; _cssAdded = true;
    var css =
      '.mt-rx{transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;pointer-events:auto;}' +
      '.mt-rx-ic{width:28px;height:28px;border-radius:50%;background:#fff;border:2.5px solid #d93025;color:#d93025;' +
        'font-size:17px;font-weight:700;line-height:24px;text-align:center;box-shadow:0 1px 5px rgba(0,0,0,.4);}' +
      '.mt-rx-t{margin-top:1px;background:#d93025;color:#fff;font-size:10px;font-weight:700;line-height:1;' +
        'padding:2px 5px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.35);}' +
      '.mt-rx-d{background:rgba(255,255,255,.25);border-radius:4px;padding:0 3px;margin-right:3px;}' +
      // 中央十字（瞄準）
      '#mt-rx-cross{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:30;pointer-events:none;' +
        'font-size:30px;color:#d93025;text-shadow:0 0 3px #fff,0 0 3px #fff;display:none;}' +
      '#mt-rx-cross.on{display:block;}' +
      // 瞄準列（底部）
      '#mt-rx-aim{position:fixed;left:12px;right:12px;bottom:calc(70px + env(safe-area-inset-bottom));z-index:31;' +
        'background:#fff;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,.22);padding:12px 14px;display:none;' +
        'align-items:center;gap:10px;}' +
      '#mt-rx-aim.on{display:flex;}' +
      '#mt-rx-aim .t{flex:1;font-size:13px;color:#3c4043;line-height:1.4;}' +
      '#mt-rx-aim button{border:none;border-radius:10px;padding:9px 14px;font-size:14px;font-weight:700;cursor:pointer;}' +
      '#mt-rx-aim .go{background:#d93025;color:#fff;}#mt-rx-aim .cx{background:#f1f3f4;color:#5f6368;}' +
      // 表單
      '#mt-rx-form{position:fixed;inset:0;z-index:41;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;}' +
      '#mt-rx-form.on{display:flex;}' +
      '#mt-rx-form .card{background:#fff;border-radius:16px;width:min(92vw,360px);max-height:86vh;overflow:auto;padding:18px;box-sizing:border-box;}' +
      '#mt-rx-form h3{margin:0 0 4px;font-size:1.05rem;color:#202124;}' +
      '#mt-rx-form .sub{font-size:.76rem;color:#80868b;margin-bottom:12px;}' +
      '#mt-rx-form .lbl{font-size:.8rem;color:#5f6368;margin:12px 0 6px;font-weight:600;}' +
      '#mt-rx-form .row{display:flex;flex-wrap:wrap;gap:8px;}' +
      '#mt-rx-form .chip{flex:1 1 auto;min-width:70px;text-align:center;border:1px solid #dadce0;border-radius:10px;' +
        'padding:10px 8px;font-size:.9rem;cursor:pointer;background:#fff;color:#202124;}' +
      '#mt-rx-form .chip.on{background:#fce8e6;border-color:#d93025;color:#c5221f;font-weight:700;}' +
      '#mt-rx-form input[type=text]{width:100%;box-sizing:border-box;border:1px solid #dadce0;border-radius:10px;padding:10px;font-size:.95rem;}' +
      '#mt-rx-form .hint{font-size:.72rem;color:#9aa0a6;margin-top:5px;}' +
      '#mt-rx-form .acts{display:flex;gap:8px;margin-top:18px;}' +
      '#mt-rx-form .acts button{flex:1;border:none;border-radius:10px;padding:12px;font-size:.95rem;font-weight:700;cursor:pointer;}' +
      '#mt-rx-form .save{background:#d93025;color:#fff;}#mt-rx-form .cancel{background:#f1f3f4;color:#5f6368;}' +
      '#mt-rx-form .del{background:#fff;color:#c5221f;border:1px solid #f3c1bd !important;flex:0 0 auto !important;padding:12px 14px;}' +
      '@media (prefers-color-scheme:dark){' +
      '#mt-rx-aim,#mt-rx-form .card{background:#1f1f1f;}#mt-rx-aim .t{color:#e8eaed;}' +
      '#mt-rx-aim .cx{background:#2d2d2d;color:#9aa0a6;}' +
      '#mt-rx-form h3{color:#e8eaed;}#mt-rx-form .chip{background:#2d2d2d;border-color:#3c4043;color:#e8eaed;}' +
      '#mt-rx-form .chip.on{background:#3a2020;border-color:#d93025;color:#f28b82;}' +
      '#mt-rx-form input[type=text]{background:#2d2d2d;border-color:#3c4043;color:#e8eaed;}' +
      '#mt-rx-form .cancel{background:#2d2d2d;color:#9aa0a6;}}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }

  // ---------- 瞄準（兩步：先對準中央、再填時段）----------
  var _cross = null, _aim = null;
  function _ensureAim() {
    if (_aim) return;
    _ensureCss();
    _cross = document.createElement('div'); _cross.id = 'mt-rx-cross'; _cross.textContent = '✛';
    _aim = document.createElement('div'); _aim.id = 'mt-rx-aim';
    _aim.innerHTML = '<div class="t">移動地圖，把要標注的路口對準中央十字</div>' +
      '<button class="cx">取消</button><button class="go">就是這裡</button>';
    document.body.appendChild(_cross); document.body.appendChild(_aim);
    _aim.querySelector('.cx').addEventListener('click', _cancelAim);
    _aim.querySelector('.go').addEventListener('click', function () {
      var m = gmap(); if (!m) { say('地圖尚未就緒'); return; }
      var c = m.getCenter(); _cancelAim(); openForm(null, { lat: c.lat, lng: c.lng });
    });
  }
  function startAdd() { _ensureAim(); _cross.classList.add('on'); _aim.classList.add('on'); }
  function _cancelAim() { if (_cross) _cross.classList.remove('on'); if (_aim) _aim.classList.remove('on'); }

  // ---------- 表單（新增/編輯）----------
  var _form = null, _editing = null, _pos = null, _pickType = 'noleft', _pickDay = 'all';
  function _ensureForm() {
    if (_form) return;
    _ensureCss();
    _form = document.createElement('div'); _form.id = 'mt-rx-form';
    var typeRow = Object.keys(TYPES).map(function (k) {
      return '<div class="chip" data-t="' + k + '">' + TYPES[k].glyph + ' ' + TYPES[k].label + '</div>';
    }).join('');
    var dayRow = Object.keys(DAYS).map(function (k) {
      return '<div class="chip" data-d="' + k + '">' + DAYS[k] + '</div>';
    }).join('');
    _form.innerHTML = '<div class="card">' +
      '<h3>標注禁轉路口</h3><div class="sub">位置＝地圖中央十字處</div>' +
      '<div class="lbl">類型</div><div class="row" id="mt-rx-types">' + typeRow + '</div>' +
      '<div class="lbl">適用日</div><div class="row" id="mt-rx-days">' + dayRow + '</div>' +
      '<div class="lbl">時段（留空＝全天禁止）</div>' +
      '<input type="text" id="mt-rx-time" placeholder="例：07-09 17-19" inputmode="text">' +
      '<div class="hint">可填多段，用空白或逗號隔開。支援 07-09 或 07:30-09:00。</div>' +
      '<div class="acts"><button class="cancel" id="mt-rx-cancel">取消</button>' +
      '<button class="del" id="mt-rx-del" style="display:none">刪除</button>' +
      '<button class="save" id="mt-rx-save">儲存</button></div></div>';
    document.body.appendChild(_form);
    _form.addEventListener('click', function (e) { if (e.target === _form) closeForm(); });
    _form.querySelector('#mt-rx-types').addEventListener('click', function (e) {
      var c = e.target.closest('.chip'); if (!c) return; _pickType = c.getAttribute('data-t'); _syncChips();
    });
    _form.querySelector('#mt-rx-days').addEventListener('click', function (e) {
      var c = e.target.closest('.chip'); if (!c) return; _pickDay = c.getAttribute('data-d'); _syncChips();
    });
    _form.querySelector('#mt-rx-cancel').addEventListener('click', closeForm);
    _form.querySelector('#mt-rx-del').addEventListener('click', function () {
      if (_editing && confirm('刪除這個標注？')) { remove(_editing.id); closeForm(); drawAll(); say('已刪除'); }
    });
    _form.querySelector('#mt-rx-save').addEventListener('click', _saveForm);
  }
  function _syncChips() {
    _form.querySelectorAll('#mt-rx-types .chip').forEach(function (c) { c.classList.toggle('on', c.getAttribute('data-t') === _pickType); });
    _form.querySelectorAll('#mt-rx-days .chip').forEach(function (c) { c.classList.toggle('on', c.getAttribute('data-d') === _pickDay); });
  }
  function openForm(rec, latlng) {
    _ensureForm();
    _editing = rec || null;
    _pos = rec ? { lat: rec.lat, lng: rec.lng } : latlng;
    _pickType = rec ? (rec.type || 'noleft') : 'noleft';
    _pickDay = rec ? (rec.day || 'all') : 'all';
    _form.querySelector('#mt-rx-time').value = rec ? _fmtWindows(rec).replace('全天', '') : '';
    _form.querySelector('#mt-rx-del').style.display = rec ? '' : 'none';
    _syncChips();
    _form.classList.add('on');
  }
  function closeForm() { if (_form) _form.classList.remove('on'); _editing = null; }
  function _saveForm() {
    if (!_pos) { say('沒有位置'); return; }
    var windows = _parseWindows(_form.querySelector('#mt-rx-time').value);
    var data = { type: _pickType, day: _pickDay, windows: windows, lat: _pos.lat, lng: _pos.lng, updatedAt: Date.now() };
    if (_editing) update(_editing.id, data);
    else add(Object.assign({ id: _id(), ts: Date.now() }, data));
    closeForm(); drawAll(); startAlerts();
    say('已標注 ' + (TYPES[_pickType] || {}).label + (windows.length ? '（' + windows.map(_fmtWin).join(' ') + '）' : '（全天）'));
  }

  // ---------- 接近＋時段提醒 ----------
  var _timer = null, _last = {};
  function _tick() {
    var pos = window.__mtLive && window.__mtLive.pos; if (!pos) return;
    var list = load(); if (!list.length) return;
    var res = _dueAlerts(list, pos, Date.now(), _last, ALERT_M, ALERT_COOLDOWN);
    _last = res.last;
    res.due.forEach(function (r) {
      var t = TYPES[r.type] || {}; var d = new Date();
      say('⚠️ 前方路口「' + t.label + '」現在（' + _hhmm(d.getHours() * 60 + d.getMinutes()) + '）' +
        (r.windows && r.windows.length ? '禁行 · ' + r.windows.map(_fmtWin).join(' ') : '全天禁行'));
    });
  }
  function startAlerts() {
    if (_timer) return;
    if (!load().length) return;             // 沒標注就不啟動計時器
    _timer = setInterval(_tick, 5000);
  }
  function stopAlerts() { if (_timer) { clearInterval(_timer); _timer = null; } }

  // ---------- 生命週期 ----------
  function init() { try { drawAll(); startAlerts(); } catch (_) {} }

  global.MaptripRestrict = {
    init: init, startAdd: startAdd, drawAll: drawAll, openForm: openForm,
    all: all, add: add, remove: remove, startAlerts: startAlerts, stopAlerts: stopAlerts, TYPES: TYPES,
    // 純函式（測試）
    _parseWindows: _parseWindows, _isActiveAt: _isActiveAt, _dayScopeOk: _dayScopeOk,
    _inWindow: _inWindow, _fmtWindows: _fmtWindows, _fmtWin: _fmtWin, _dueAlerts: _dueAlerts, _haversine: _haversine
  };
})(typeof window !== 'undefined' ? window : globalThis);
