// metro-alert.js — 捷運到站提醒（自適應：稀疏才彈窗、密集自動閉嘴、末班車強提醒）。
//
// 【為什麼跟火車分開做】捷運沒有「即時到站」——TDX 上所有捷運（台北/新北/桃園/高雄）
//   都只有「時刻表」，沒有逐車即時車況（台北捷運的即時只留在它自己 App 裡）。但捷運非常
//   準點，所以「預定發車/到站時刻」幾乎等於實際到站，用時刻表就夠。
//
// 【核心設計：自適應，讓它自己知道何時該閉嘴】（與使用者討論定案）
//   一班捷運到站 = 一批人湧出車站 = 一個機會。但這個機會有沒有鑑別度，取決於班距：
//     - 離峰/深夜（班距 8~12 分）：一班車是離散事件，錯過要等很久 → 值得先去卡位 → ✅ 主動彈窗。
//     - 尖峰/白天（班距 2~4 分）：隨時都有車、隨時都有人 → 「即將到站」每 3 分鐘跳一次沒鑑別度、
//       只會變開車干擾 → 🔇 不彈窗（尖峰請靠「找客熱區」，人潮價值在區域整體需求）。
//   判斷不用「幾點」硬分尖離峰，直接用資料：數「前後 5 分鐘」窗內有幾班車——
//     ≤2 班＝稀疏→彈窗；>2 班＝密集→安靜。
//   命中末班車（收班前）＝搭不到的人要叫車＝最強訊號 → 🔴 一律強提醒＋標「末班車」。
//
// 【資料源】TDX v2 Rail/Metro（捷運仍在 v2，不是 v3）。走與火車共用的 Cloudflare Worker
//   代理（金鑰藏伺服器＋邊快取），全體使用者免申請金鑰、預設即可用。
//     站點（含 GPS）：/v2/Rail/Metro/Station/{Operator}
//     時刻表         ：/v2/Rail/Metro/StationTimeTable/{Operator}
//   欄位（實測）：時刻表每筆＝{StationID, Direction, DestinationStationName{Zh_tw},
//     Timetables:[{Sequence, DepartureTime:"HH:MM", TrainType}]}（注意 DepartureTime 不是 ArrivalTime）。
//
// 依賴 app.js 全域：window.__mtLive（即時 pos）、haversine、toast。
(function () {
  'use strict';

  var RADIUS = 1500;        // 靠近捷運站門檻（公尺；捷運站密、比火車近一點）
  var WINDOW_MIN = 5;       // 前後幾分鐘（±5 分＝10 分窗）
  var DENSE_N = 2;          // 窗內 >DENSE_N 班＝密集（尖峰）→ 不彈窗
  var PROXY = 'https://maptrip-tdx.tumblestudio.workers.dev';
  // 大台北捷運營運商：台北捷運 TRTC、新北捷運（環狀線）NTMC、桃園機捷 TYMC。
  var OPERATORS = ['TRTC', 'NTMC', 'TYMC'];
  var TEST_STATION = '台北車站';   // 測試查詢用（TRTC）
  var STA_TTL = 30 * 86400000;    // 站點清單快取 30 天
  var TT_TTL  = 6 * 3600000;      // 時刻表快取 6 小時（當日靜態）

  function diag(m) { if (window.__mtLog) try { window.__mtLog('metro:' + m); } catch (_) {} }
  var alerted = {};         // 已提醒過的 key（避免重複跳）
  var ttCache = {};         // operator -> { at, index }
  var poller = null;
  var cooldownUntil = 0;    // 被限流（429）後退避截止
  var testing = false;

  function pos()  { return window.__mtLive && window.__mtLive.pos; }
  function say(m) { if (window.toast) window.toast(m); }
  function mode() {
    var m = localStorage.getItem('maptrip_metro_mode');
    if (m) return m;
    return PROXY ? 'live' : 'off';   // 有內建共用代理→預設開啟給所有人（可到設定關閉）
  }
  function H(a, b) {
    if (window.haversine) return window.haversine(a, b);
    var R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  // 台北捷運各線代表色（LineID → 色）；桃園機捷/未知走灰。純為 UI 小色塊。
  var LINE_COLOR = {
    BL: '#0070bd', BR: '#c48c31', G: '#008659', O: '#f8b61c', R: '#e3002c',
    Y: '#ffdb00', A: '#8246af'
  };
  function lineColor(id) { return LINE_COLOR[(id || '').toUpperCase()] || '#9aa0a6'; }

  // ---------- 純邏輯（可測） ----------
  // "HH:MM" 或 "HH:MM:SS" → 今天的時間毫秒（相對 now 當天）
  function parseHM(str, now) {
    if (!str || typeof str !== 'string') return NaN;
    var m = str.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return NaN;
    var d = new Date(now || Date.now());
    d.setHours(+m[1], +m[2], 0, 0);
    return d.getTime();
  }
  function minsUntil(arrMs, now) { return Math.round((arrMs - (now || Date.now())) / 60000); }

  // ServiceDay 過濾：若時刻表有分平日/假日（ServiceDay 物件），只留符合今天者；沒有此欄→全收。
  function serviceToday(sv, now) {
    if (!sv || typeof sv !== 'object') return true;
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var k = days[new Date(now || Date.now()).getDay()];
    if (k in sv) return !!sv[k];
    return true;   // 欄位存在但沒這個 key（怪資料）→ 不誤刪
  }

  // StationTimeTable 原始列 → 索引 { StationID: { line, dirs:[{dir,dest,times:[HH:MM..],last}] } }
  //   times 已排序；last＝該方向最後一班發車時刻（末班車偵測用）。
  function buildIndex(rows, now) {
    var idx = {};
    (rows || []).forEach(function (g) {
      if (!serviceToday(g.ServiceDay, now)) return;
      var sid = g.StationID;
      if (!sid) return;
      var dn = g.DestinationStationName && (g.DestinationStationName.Zh_tw || g.DestinationStationName);
      var dir = (typeof g.Direction === 'number') ? g.Direction : 0;
      var times = (g.Timetables || g.TimeTables || []).map(function (t) {
        return t.DepartureTime || t.ArrivalTime;
      }).filter(function (x) { return typeof x === 'string' && /^\d{1,2}:\d{2}/.test(x); })
        .sort();
      if (!times.length) return;
      var e = idx[sid] || (idx[sid] = { line: g.LineID || '', dirs: [] });
      // 同站同方向可能出現多筆（不同 ServiceDay 已濾）→ 合併時刻聯集
      var slot = null;
      for (var i = 0; i < e.dirs.length; i++) { if (e.dirs[i].dir === dir && e.dirs[i].dest === dn) { slot = e.dirs[i]; break; } }
      if (!slot) { slot = { dir: dir, dest: (dn || '') + '', times: [] }; e.dirs.push(slot); }
      slot.times = slot.times.concat(times).sort().filter(function (v, i, a) { return i === 0 || v !== a[i - 1]; });
      slot.last = slot.times[slot.times.length - 1];
      if (!e.line && g.LineID) e.line = g.LineID;
    });
    return idx;
  }

  // 某站索引 → 前後 windowMin 內的所有列車（含末班車旗標），各筆帶 mins。
  function stationTrains(entry, now, windowMin) {
    if (!entry) return [];
    var w = windowMin || WINDOW_MIN;
    var out = [];
    (entry.dirs || []).forEach(function (d) {
      d.times.forEach(function (t) {
        var mins = minsUntil(parseHM(t, now), now);
        if (isNaN(mins) || mins > w || mins < -w) return;
        out.push({ arr: t, dest: d.dest, dir: d.dir, line: entry.line, mins: mins, isLast: t === d.last });
      });
    });
    return out.sort(function (a, b) { return a.mins - b.mins; });
  }

  // 自適應決策：window 內的車 → 要不要彈窗、是否密集、是否命中末班車。
  function decide(trains, windowMin) {
    var w = windowMin || WINDOW_MIN;
    var win = (trains || []).filter(function (t) { return t.mins <= w && t.mins >= -w; })
      .sort(function (a, b) { return a.mins - b.mins; });
    var hasLast = win.some(function (t) { return t.isLast; });
    var dense = win.length > DENSE_N;
    // 主動彈窗：命中末班車（一律提醒），或（稀疏且窗內有車）。密集且非末班→安靜。
    var alert = hasLast || (!dense && win.length > 0);
    return { win: win, dense: dense, hasLast: hasLast, alert: alert };
  }

  // 站點清單中，距離 me 在 radius 內者，由近到遠
  function nearbyStations(stations, me, radius) {
    return (stations || []).map(function (s) { return { s: s, d: H(me, { lat: s.lat, lng: s.lng }) }; })
      .filter(function (x) { return x.d <= (radius || RADIUS); })
      .sort(function (a, b) { return a.d - b.d; })
      .map(function (x) { x.s._dist = x.d; return x.s; });
  }

  // ---------- 代理存取 ----------
  function handleResp(r) {
    if (r.status === 429) { cooldownUntil = Date.now() + 120000; throw new Error('api 429'); }
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  }
  function apiGet(path) {
    return fetch(PROXY + path, { headers: { accept: 'application/json' } }).then(handleResp);
  }

  // 站點清單（多營運商合併 + 快取）
  function loadStations() {
    if (mode() === 'demo') {
      var me = pos() || { lat: 25.0478, lng: 121.5170 };
      return Promise.resolve([{ id: 'DEMO', op: 'TRTC', line: 'BL', name: '示範捷運站', lat: me.lat, lng: me.lng }]);
    }
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem('maptrip_metro_stations') || 'null'); } catch (_) {}
    if (cached && cached.at > Date.now() - STA_TTL && cached.list && cached.list.length) return Promise.resolve(cached.list);
    var jobs = OPERATORS.map(function (op) {
      return apiGet('/v2/Rail/Metro/Station/' + op + '?%24format=JSON').then(function (data) {
        var arr = data.Stations || data || [];
        if (!Array.isArray(arr)) arr = [];
        return arr.map(function (s) {
          var p = s.StationPosition || {};
          var nm = s.StationName || {};
          return { id: s.StationID || s.StationUID, op: op, line: s.LineID || '',
            name: (nm.Zh_tw || nm.zh_tw || nm) + '', lat: p.PositionLat, lng: p.PositionLon };
        }).filter(function (s) { return s.id && typeof s.lat === 'number' && typeof s.lng === 'number'; });
      }).catch(function (e) { diag('sta err ' + op + ' ' + (e && e.message)); return []; });
    });
    return Promise.all(jobs).then(function (parts) {
      var list = [];
      parts.forEach(function (p) { list = list.concat(p); });
      diag('stations n=' + list.length);
      if (list.length) { try { localStorage.setItem('maptrip_metro_stations', JSON.stringify({ at: Date.now(), list: list })); } catch (_) {} }
      return list;
    });
  }

  // 某營運商當日時刻索引（快取 6 小時；memory + localStorage 精簡索引）
  function loadTimetable(op) {
    var now = Date.now();
    if (mode() === 'demo') {
      function hm(off) { var d = new Date(now + off * 60000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
      var rows = [{ StationID: 'DEMO', LineID: 'BL', Direction: 0, DestinationStationName: { Zh_tw: '南港展覽館' },
        Timetables: [{ DepartureTime: hm(2) }, { DepartureTime: hm(9) }, { DepartureTime: hm(-1) }] }];
      return Promise.resolve(buildIndex(rows, now));
    }
    var c = ttCache[op];
    if (c && c.at > now - TT_TTL && c.index) return Promise.resolve(c.index);
    if (!c) {   // 冷啟動：試 localStorage 精簡索引
      try {
        var pc = JSON.parse(localStorage.getItem('maptrip_metro_tt_' + op) || 'null');
        if (pc && pc.at > now - TT_TTL && pc.index) { ttCache[op] = { at: pc.at, index: pc.index }; return Promise.resolve(pc.index); }
      } catch (_) {}
    }
    if (now < cooldownUntil) return Promise.resolve((c && c.index) || {});
    return apiGet('/v2/Rail/Metro/StationTimeTable/' + op + '?%24format=JSON').then(function (data) {
      var rows = data.StationTimeTables || data.StationTimeTable || data || [];
      if (!Array.isArray(rows)) rows = [rows];
      var index = buildIndex(rows, Date.now());
      ttCache[op] = { at: Date.now(), index: index };
      diag('tt ' + op + ' rows=' + rows.length + ' stations=' + Object.keys(index).length);
      try { localStorage.setItem('maptrip_metro_tt_' + op, JSON.stringify({ at: Date.now(), index: index })); } catch (_) {}
      return index;
    }).catch(function (e) {
      diag('tt err ' + op + ' ' + (e && e.message));
      ttCache[op] = { at: Date.now(), index: (c && c.index) || {} };   // 短負快取（用舊值或空）
      ttCache[op].at = Date.now() - TT_TTL + 300000;                   // 5 分鐘後可重試
      return ttCache[op].index;
    });
  }

  // ---------- UI ----------
  function ensurePopup() {
    var el = document.getElementById('metro-alert');
    if (!el) { el = document.createElement('div'); el.id = 'metro-alert'; el.style.display = 'none'; document.body.appendChild(el); }
    return el;
  }
  var hideTimer = null;
  function showPopup(title, trains, stationName, last) {
    var el = ensurePopup();
    el.classList.toggle('metro-last', !!last);
    var rows = trains.slice(0, 5).map(function (t) {
      var when = t.mins > 0 ? ('約 ' + t.mins + ' 分後') : (t.mins === 0 ? '進站中' : (-t.mins) + ' 分前到站');
      var lastTag = t.isLast ? '<span class="ta-late">末班車</span>' : '';
      var chip = '<span class="mt-chip" style="background:' + lineColor(t.line) + '"></span>';
      return '<div class="ta-row"><span class="ta-when">' + when + '</span>' +
        chip + '<span class="ta-dest">往 ' + (t.dest || '—') + '</span>' +
        '<span class="ta-time">' + (t.arr || '') + lastTag + '</span></div>';
    }).join('');
    el.innerHTML = '<div class="ta-head"><span class="ta-title">' + title + '</span>' +
      '<button class="ta-close" onclick="MaptripMetro.dismiss()">✕</button></div>' +
      '<div class="ta-sta">📍 ' + (stationName || '附近捷運站') + '</div>' +
      '<div class="ta-list">' + rows + '</div>';
    el.style.display = 'block';
    el.classList.add('show');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(dismiss, 20000);
  }
  function dismiss() {
    var el = document.getElementById('metro-alert');
    if (el) { el.classList.remove('show'); el.style.display = 'none'; }
  }

  // ---------- 主流程 ----------
  function check() {
    if (mode() === 'off') return;
    var me = pos();
    if (!me) return;
    loadStations().then(function (stations) {
      var near = nearbyStations(stations, me, RADIUS);
      if (!near.length) return;
      var st = near[0];
      return loadTimetable(st.op).then(function (index) {
        var now = Date.now();
        var trains = stationTrains(index[st.id], now, WINDOW_MIN);
        var d = decide(trains, WINDOW_MIN);
        if (!d.alert) return;   // 沒車、或密集（尖峰）自動閉嘴
        // 去重：以「最接近的那班車」＋是否末班為 key，避免每 30 秒重跳
        var head = d.win[0];
        var key = st.id + '_' + (head ? head.arr : '') + '_' + (d.hasLast ? 'last' : 'n');
        if (alerted[key]) return;
        alerted[key] = 1;
        var arrivedNow = d.win.some(function (t) { return t.mins <= 0 && t.mins >= -2; });
        var title = d.hasLast ? '🔴 末班車即將到站！' : (arrivedNow ? '🚇 捷運進站中' : '🚇 捷運即將到站');
        showPopup(title, d.win, st.name, d.hasLast);
        return d.win;
      });
    }).catch(function (e) {
      diag('check err ' + (e && e.message));
    });
  }

  function start() {
    if (poller) clearInterval(poller);
    if (mode() === 'off') return;
    check();
    poller = setInterval(check, 30000);
  }

  // ---------- 設定面板 ----------
  function openSettings() {
    var el = document.getElementById('metro-set');
    if (!el) { el = document.createElement('div'); el.id = 'metro-set'; document.body.appendChild(el); }
    var md = mode();
    el.innerHTML =
      '<div class="ts-card"><div class="ts-head">🚇 捷運到站提醒<button class="ta-close" onclick="MaptripMetro.closeSettings()">✕</button></div>' +
      '<div class="ts-mode">' +
        '<button class="ts-mbtn ' + (md === 'off' ? 'on' : '') + '" onclick="MaptripMetro.setMode(\'off\')">關閉</button>' +
        '<button class="ts-mbtn ' + (md === 'demo' ? 'on' : '') + '" onclick="MaptripMetro.setMode(\'demo\')">示範</button>' +
        '<button class="ts-mbtn ' + (md === 'live' ? 'on' : '') + '" onclick="MaptripMetro.setMode(\'live\')">真實資料</button>' +
      '</div>' +
      '<div class="ts-hint">靠近捷運站 1.5km 時，用時刻表提醒「即將到站」的班次（一批下車的人＝一個機會）。<br>' +
      '<b>會自己判斷該不該提醒</b>：離峰/深夜班次稀疏才主動彈窗；尖峰班次密集自動安靜（尖峰請靠「找客熱區」）；' +
      '<b>命中末班車一律強提醒</b>（搭不到的人要叫車＝最強訊號）。<br>' +
      '已內建共用資料，<b>直接就能用、免申請金鑰</b>。</div>' +
      '<button class="ts-test" onclick="MaptripMetro.test()">🔎 測試查詢（台北車站）</button></div>';
    el.style.display = 'flex';
  }
  // 一鍵驗證：查台北車站時刻，確認串接正確（不必真的開到站旁）
  function test() {
    if (testing) return;
    if (Date.now() < cooldownUntil) { say('剛剛查太多次被限流，請等 1-2 分鐘再試'); return; }
    testing = true;
    say('測試查詢台北車站中…');
    delete ttCache.TRTC;
    Promise.all([loadStations(), loadTimetable('TRTC')]).then(function (r) {
      var stations = r[0], index = r[1];
      var st = null;
      for (var i = 0; i < stations.length; i++) { if (stations[i].op === 'TRTC' && stations[i].name === TEST_STATION) { st = stations[i]; break; } }
      var nStations = Object.keys(index).length;
      if (!nStations) { say('連線正常，但目前沒有班表（可能末班車後，已記黑盒子）'); return; }
      var now = Date.now();
      // 測試放寬到前後 60 分鐘，讓使用者確定看得到車
      var trains = st ? stationTrains(index[st.id], now, 60) : [];
      if (!trains.length) {
        // 台北車站在 TRTC 有兩個站碼（BL/R）；退而找任一有近班的站
        var anyId = Object.keys(index)[0];
        trains = stationTrains(index[anyId], now, 60);
      }
      if (!trains.length) { say('連線正常，共 ' + nStations + ' 站有班表（此刻無鄰近班次）'); return; }
      showPopup('✅ 連線成功（台北車站）', trains, TEST_STATION + '（測試）', false);
      say('成功！共 ' + nStations + ' 站有班表，串接正常');
    }).catch(function (e) {
      diag('test err ' + (e && e.message));
      var msg = /429/.test(e && e.message) ? '被限流，請等 1-2 分鐘再試' : (e && e.message || '未知');
      say('失敗：' + msg + '（已記黑盒子）');
    }).then(function () { testing = false; });
  }
  function closeSettings() { var el = document.getElementById('metro-set'); if (el) el.style.display = 'none'; }
  function setMode(m) {
    localStorage.setItem('maptrip_metro_mode', m);
    alerted = {}; ttCache = {};
    start();
    openSettings();
    say(m === 'off' ? '捷運提醒已關閉' : (m === 'demo' ? '示範模式：稍候會跳出假班次' : '已切換真實資料'));
  }

  window.MaptripMetro = {
    start: start, check: check, dismiss: dismiss,
    openSettings: openSettings, closeSettings: closeSettings, setMode: setMode, test: test,
    // 測試用純函式
    _parseHM: parseHM, _minsUntil: minsUntil, _serviceToday: serviceToday,
    _buildIndex: buildIndex, _stationTrains: stationTrains, _decide: decide,
    _nearbyStations: nearbyStations, _lineColor: lineColor
  };
  window.openMetroSettings = openSettings;

  if (typeof document !== 'undefined') {
    setTimeout(function () { try { start(); } catch (_) {} }, 4500);
  }
})();
