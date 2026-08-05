// train-alert.js — 火車站列車到站提醒。
//
// 需求：當司機靠近火車站 2km 內，跳出「前後 10 分鐘」內的預定到站列車，
//   並以彈出視窗提醒「🚆 火車即將抵達！」（到站前）或「🚆 火車已抵達！」（到站當下）。
//
// 【資料來源】台鐵時刻靠 TDX（交通部運輸資料流通服務平臺，免費，需 client_id/secret）。
//   Google 沒有火車到站的公開 API；TDX 是台灣唯一穩定免費來源，但一定要金鑰。
//   認證＝OAuth2 client_credentials 換 bearer token（一天有效，快取）。
//   站點清單與每日時刻表都可快取，一天只需少量呼叫，免費額度綽綽有餘。
//
// 【模式】maptrip_train_mode ∈ off（預設，不動作）/ demo（假資料預覽）/ live（真 TDX）。
//   未設金鑰時不會亂跳；使用者到「🚆 火車到站提醒」設定裡開啟或貼金鑰。
//
// 依賴 app.js 全域：window.__mtLive（即時 pos）、haversine、toast。
(function () {
  'use strict';

  var RADIUS = 2000;        // 靠近門檻（公尺）
  var WINDOW_MIN = 10;      // 顯示前後幾分鐘
  var TOK_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
  var API = 'https://tdx.transportdata.tw/api/basic';   // 版本＋路徑由呼叫端帶（v3 為主、v2 後備）
  var TAIPEI = '1000';        // 台北車站 StationID（測試查詢用）
  function diag(m) { if (window.__mtLog) try { window.__mtLog('train:' + m); } catch (_) {} }
  var STA_TTL = 30 * 86400000;   // 站點清單快取 30 天
  var TT_TTL  = 6 * 3600000;     // 時刻表快取 6 小時（當日靜態）

  var alerted = {};         // 已提醒過的 key（避免重複跳）
  var timetables = {};      // stationId -> { at, arrivals }
  var poller = null;

  function pos()  { return window.__mtLive && window.__mtLive.pos; }
  function say(m) { if (window.toast) window.toast(m); }
  function mode() { return localStorage.getItem('maptrip_train_mode') || 'off'; }
  function creds() { try { return JSON.parse(localStorage.getItem('maptrip_tdx') || 'null'); } catch (_) { return null; } }
  function H(a, b) {
    if (window.haversine) return window.haversine(a, b);
    var R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

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

  // 站點清單中，距離 me 在 radius 內者，由近到遠
  function nearbyStations(stations, me, radius) {
    return (stations || []).map(function (s) { return { s: s, d: H(me, { lat: s.lat, lng: s.lng }) }; })
      .filter(function (x) { return x.d <= (radius || RADIUS); })
      .sort(function (a, b) { return a.d - b.d; })
      .map(function (x) { x.s._dist = x.d; return x.s; });
  }

  // 時刻表 → 前後 windowMin 分鐘內的列車，標上 mins 與 phase
  function windowTrains(arrivals, now, windowMin) {
    var w = windowMin || WINDOW_MIN;
    return (arrivals || []).map(function (a) {
      var arrMs = parseHM(a.arr, now), mins = minsUntil(arrMs, now);
      return { arr: a.arr, trainNo: a.trainNo, type: a.type, dest: a.dest, mins: mins, phase: phaseOf(mins) };
    }).filter(function (a) { return !isNaN(a.mins) && a.mins <= w && a.mins >= -w; })
      .sort(function (a, b) { return a.mins - b.mins; });
  }
  // 提醒階段：即將抵達（到站前 0<mins<=3）/ 已抵達（-2<=mins<=0）/ 其他不主動跳
  function phaseOf(mins) {
    if (mins > 0 && mins <= 3) return 'soon';
    if (mins <= 0 && mins >= -2) return 'arrived';
    return null;
  }

  // ---------- TDX 存取 ----------
  function getToken() {
    var c = creds();
    if (!c || !c.id || !c.secret) return Promise.reject(new Error('no creds'));
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem('maptrip_tdx_tok') || 'null'); } catch (_) {}
    if (cached && cached.exp > Date.now() + 60000) return Promise.resolve(cached.tok);
    var body = 'grant_type=client_credentials&client_id=' + encodeURIComponent(c.id) +
               '&client_secret=' + encodeURIComponent(c.secret);
    return fetch(TOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body })
      .then(function (r) { if (!r.ok) throw new Error('token ' + r.status); return r.json(); })
      .then(function (j) {
        var tok = j.access_token, exp = Date.now() + (j.expires_in || 86400) * 1000;
        try { localStorage.setItem('maptrip_tdx_tok', JSON.stringify({ tok: tok, exp: exp })); } catch (_) {}
        return tok;
      });
  }
  function apiGet(path) {
    return getToken().then(function (tok) {
      return fetch(API + path, { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('api ' + r.status); return r.json(); });
    });
  }

  // 站點清單（正規化 + 快取）；容錯 v3 包裝（Stations）與裸陣列
  function loadStations() {
    if (mode() === 'demo') {
      var me = pos() || { lat: 25.0478, lng: 121.5170 };
      return Promise.resolve([{ id: 'DEMO', name: '示範車站', lat: me.lat, lng: me.lng }]);
    }
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem('maptrip_tra_stations') || 'null'); } catch (_) {}
    if (cached && cached.at > Date.now() - STA_TTL && cached.list) return Promise.resolve(cached.list);
    return apiGet('/v3/Rail/TRA/Station?%24format=JSON').then(function (data) {
      var arr = data.Stations || data.stations || data || [];
      diag('stations n=' + (arr && arr.length));
      var list = arr.map(function (s) {
        var p = s.StationPosition || {};
        var nm = s.StationName || {};
        return { id: s.StationID || s.StationUID, name: (nm.Zh_tw || nm.zh_tw || nm) + '',
          lat: p.PositionLat, lng: p.PositionLon };
      }).filter(function (s) { return s.id && typeof s.lat === 'number' && typeof s.lng === 'number'; });
      try { localStorage.setItem('maptrip_tra_stations', JSON.stringify({ at: Date.now(), list: list })); } catch (_) {}
      return list;
    });
  }

  // 某站當日時刻（正規化 + 快取）；demo 產生 now 附近假班次
  function loadTimetable(station) {
    var sid = station.id;
    var c = timetables[sid];
    if (c && c.at > Date.now() - TT_TTL) return Promise.resolve(c.arrivals);
    if (mode() === 'demo') {
      var now = Date.now();
      function hm(off) { var d = new Date(now + off * 60000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
      var arrivals = [
        { trainNo: '1234', type: '自強', dest: '高雄', arr: hm(2) },
        { trainNo: '2156', type: '區間', dest: '基隆', arr: hm(9) },
        { trainNo: '3088', type: '莒光', dest: '花蓮', arr: hm(-1) }
      ];
      timetables[sid] = { at: now, arrivals: arrivals };
      return Promise.resolve(arrivals);
    }
    // 先試 v3，抓不到（版本差異）再退 v2；都失敗記黑盒子方便除錯
    return fetchTimetable('v3', sid).then(function (a) {
      if (a && a.length) return a;
      diag('tt v3 empty, try v2 ' + sid);
      return fetchTimetable('v2', sid).catch(function () { return a || []; });
    }).catch(function (e) {
      diag('tt v3 err ' + (e && e.message) + ', try v2');
      return fetchTimetable('v2', sid);
    }).then(function (arrivals) {
      timetables[sid] = { at: Date.now(), arrivals: arrivals };
      return arrivals;
    });
  }
  // 抓某版本的每站當日時刻表並正規化；容錯多種 v3/v2 包裝與欄位名
  function fetchTimetable(ver, sid) {
    return apiGet('/' + ver + '/Rail/TRA/DailyStationTimetable/TodayStation/' + encodeURIComponent(sid) + '?%24format=JSON')
      .then(function (data) {
        var groups = data.StationTimetables || data.TimeTables || data.TrainTimetables || data || [];
        if (!Array.isArray(groups)) groups = [groups];
        var arrivals = [];
        groups.forEach(function (g) {
          var tts = g.TimeTables || g.Timetables || (g.TrainNo ? [g] : []);
          var gDest = g.EndingStationName && (g.EndingStationName.Zh_tw || g.EndingStationName);
          tts.forEach(function (tt) {
            var dn = tt.EndingStationName && (tt.EndingStationName.Zh_tw || tt.EndingStationName);
            var ty = tt.TrainTypeName && (tt.TrainTypeName.Zh_tw || tt.TrainTypeName);
            arrivals.push({ trainNo: tt.TrainNo, type: (ty || '') + '', dest: (dn || gDest || '') + '',
              arr: tt.ArrivalTime || tt.ScheduledArrivalTime || tt.DepartureTime });
          });
        });
        diag('tt ' + ver + ' ' + sid + ' keys=' + Object.keys(data || {}).join(',') + ' n=' + arrivals.length);
        return arrivals;
      });
  }

  // ---------- UI ----------
  function ensurePopup() {
    var el = document.getElementById('train-alert');
    if (!el) {
      el = document.createElement('div');
      el.id = 'train-alert';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    return el;
  }
  var hideTimer = null;
  function showPopup(title, trains, stationName) {
    var el = ensurePopup();
    var rows = trains.slice(0, 4).map(function (t) {
      var when = t.mins > 0 ? ('約 ' + t.mins + ' 分後') : (t.mins === 0 ? '進站中' : (-t.mins) + ' 分前抵達');
      return '<div class="ta-row"><span class="ta-when">' + when + '</span>' +
        '<span class="ta-train">' + (t.type || '') + ' ' + (t.trainNo || '') + '</span>' +
        '<span class="ta-dest">往 ' + (t.dest || '—') + '</span>' +
        '<span class="ta-time">' + (t.arr || '') + '</span></div>';
    }).join('');
    el.innerHTML = '<div class="ta-head"><span class="ta-title">' + title + '</span>' +
      '<button class="ta-close" onclick="MaptripTrain.dismiss()">✕</button></div>' +
      '<div class="ta-sta">📍 ' + (stationName || '附近車站') + '</div>' +
      '<div class="ta-list">' + rows + '</div>';
    el.style.display = 'block';
    el.classList.add('show');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(dismiss, 20000);
  }
  function dismiss() {
    var el = document.getElementById('train-alert');
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
      return loadTimetable(st).then(function (arrivals) {
        var now = Date.now();
        var win = windowTrains(arrivals, now, WINDOW_MIN);
        if (!win.length) return;
        // 主動提醒：挑最接近提醒階段者，每班每階段只跳一次
        var toAlert = win.filter(function (t) { return t.phase; });
        var fired = false;
        toAlert.forEach(function (t) {
          var key = st.id + '_' + t.trainNo + '_' + t.arr + '_' + t.phase;
          if (alerted[key]) return;
          alerted[key] = 1; fired = true;
        });
        if (fired) {
          var arrivedNow = toAlert.some(function (t) { return t.phase === 'arrived'; });
          var title = arrivedNow ? '🚆 火車已抵達！' : '🚆 火車即將抵達！';
          showPopup(title, win, st.name);
        }
        return win;
      });
    }).catch(function (e) {
      if (mode() === 'live') say('火車資料讀取失敗（檢查 TDX 金鑰或網路）');
    });
  }

  function start() {
    if (poller) clearInterval(poller);
    if (mode() === 'off') return;
    check();
    poller = setInterval(check, 30000);
  }

  // 設定面板：模式切換 + TDX 金鑰輸入
  function openSettings() {
    var el = document.getElementById('train-set');
    if (!el) { el = document.createElement('div'); el.id = 'train-set'; document.body.appendChild(el); }
    var c = creds() || {}, md = mode();
    el.innerHTML =
      '<div class="ts-card"><div class="ts-head">🚆 火車到站提醒<button class="ta-close" onclick="MaptripTrain.closeSettings()">✕</button></div>' +
      '<div class="ts-mode">' +
        '<button class="ts-mbtn ' + (md === 'off' ? 'on' : '') + '" onclick="MaptripTrain.setMode(\'off\')">關閉</button>' +
        '<button class="ts-mbtn ' + (md === 'demo' ? 'on' : '') + '" onclick="MaptripTrain.setMode(\'demo\')">示範</button>' +
        '<button class="ts-mbtn ' + (md === 'live' ? 'on' : '') + '" onclick="MaptripTrain.setMode(\'live\')">真實資料</button>' +
      '</div>' +
      '<div class="ts-hint">靠近火車站 2km 時，跳出前後 10 分鐘的預定到站列車。<br>' +
      '「真實資料」需 <b>TDX 免費金鑰</b>（tdx.transportdata.tw 註冊 → 會員中心取得 Client Id / Secret）。</div>' +
      '<input id="ts-id" class="ts-in" placeholder="TDX Client Id" value="' + (c.id || '') + '">' +
      '<input id="ts-secret" class="ts-in" placeholder="TDX Client Secret" value="' + (c.secret || '') + '">' +
      '<button class="ts-save" onclick="MaptripTrain.saveCreds()">儲存金鑰並啟用</button>' +
      '<button class="ts-test" onclick="MaptripTrain.test()">🔎 測試查詢（台北車站）</button></div>';
    el.style.display = 'flex';
  }
  // 一鍵驗證：直接查台北車站，確認金鑰有效＋串接正確（不必真的開到車站旁）
  function test() {
    var c = creds();
    if (!c || !c.id || !c.secret) { say('請先輸入並儲存 TDX 金鑰'); return; }
    say('測試查詢台北車站中…');
    timetables[TAIPEI] = null;   // 不吃快取
    fetchTimetable('v3', TAIPEI).then(function (a) {
      if (a && a.length) return a;
      return fetchTimetable('v2', TAIPEI);
    }).then(function (arrivals) {
      if (!arrivals || !arrivals.length) { say('金鑰可用，但沒解析到班次（已記黑盒子，請截圖給我）'); return; }
      var now = Date.now();
      var next = arrivals.map(function (x) {
        return { arr: x.arr, trainNo: x.trainNo, type: x.type, dest: x.dest, mins: minsUntil(parseHM(x.arr, now), now) };
      }).filter(function (x) { return !isNaN(x.mins) && x.mins >= -5; })
        .sort(function (a, b) { return a.mins - b.mins; });
      if (!next.length) next = arrivals.slice(0, 4).map(function (x) { return { arr: x.arr, trainNo: x.trainNo, type: x.type, dest: x.dest, mins: 999 }; });
      showPopup('✅ 金鑰有效（台北車站）', next, '台北車站（測試）');
      say('成功！共 ' + arrivals.length + ' 班，金鑰與串接正常');
    }).catch(function (e) {
      diag('test err ' + (e && e.message));
      say('失敗：' + (e && e.message || '未知') + '（可能金鑰錯或網路，已記黑盒子）');
    });
  }
  function closeSettings() { var el = document.getElementById('train-set'); if (el) el.style.display = 'none'; }
  function setMode(m) {
    localStorage.setItem('maptrip_train_mode', m);
    alerted = {}; timetables = {};
    start();
    openSettings();
    say(m === 'off' ? '火車提醒已關閉' : (m === 'demo' ? '示範模式：稍候會跳出假班次' : '已切換真實資料'));
  }
  function saveCreds() {
    var id = (document.getElementById('ts-id') || {}).value || '';
    var secret = (document.getElementById('ts-secret') || {}).value || '';
    if (!id.trim() || !secret.trim()) { say('請輸入 Client Id 與 Secret'); return; }
    localStorage.setItem('maptrip_tdx', JSON.stringify({ id: id.trim(), secret: secret.trim() }));
    localStorage.removeItem('maptrip_tdx_tok');
    localStorage.setItem('maptrip_train_mode', 'live');
    alerted = {}; timetables = {};
    closeSettings(); start();
    say('已儲存，靠近車站時會提醒');
  }

  window.MaptripTrain = {
    start: start, check: check, dismiss: dismiss,
    openSettings: openSettings, closeSettings: closeSettings, setMode: setMode, saveCreds: saveCreds, test: test,
    // 測試用純函式
    _parseHM: parseHM, _minsUntil: minsUntil, _nearbyStations: nearbyStations,
    _windowTrains: windowTrains, _phaseOf: phaseOf
  };
  window.openTrainSettings = openSettings;

  // 開機後啟動輪詢（僅在非 off 模式實際動作）
  if (typeof document !== 'undefined') {
    setTimeout(function () { try { start(); } catch (_) {} }, 4000);
  }
})();
