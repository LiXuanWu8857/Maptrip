/* =============================================================
 * flight.js — 航班查詢（桃園 TPE 航廈/時刻）MaptripFlight
 * -------------------------------------------------------------
 * 給預約用：輸入航班編號 + 送機/接機 → 回航空公司/航廈/時刻/狀態。
 * 資料源＝TDX Air FIDS（桃園機場），沿用「火車到站提醒」那把共用 Cloudflare
 * Worker（金鑰藏 Worker，前端不帶 key）；使用者自填 TDX 金鑰時走直連。
 * Phase 1 只做查詢（不做延誤提醒）。只桃園 TPE。
 *
 * 注意（沙箱測不到、需實機驗）：①Worker 若只白名單放行 Rail 路徑，Air 會被擋
 *   →要在 Cloudflare 端讓 Worker 放行 /v1/Air/*。②TDX Air FIDS 欄位以官方文件為準，
 *   實機跑一次確認欄位名對得上。
 * ============================================================= */
(function (global) {
  'use strict';

  var TOK_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
  var API = 'https://tdx.transportdata.tw/api/basic';       // 直連（進階：自填金鑰）
  var PROXY = 'https://maptrip-tdx.tumblestudio.workers.dev'; // 共用代理（金鑰在 Worker）
  var AIRPORT = 'TPE';                                       // 桃園
  var _cache = {};          // path → {t,data}，60 秒快取省額度
  var _cooldownUntil = 0;

  function creds() { try { return JSON.parse(localStorage.getItem('maptrip_tdx') || 'null'); } catch (_) { return null; } }
  function useProxy() { var c = creds(); return !!PROXY && !(c && c.id && c.secret); }

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
  function handleResp(r) {
    if (r.status === 429) { _cooldownUntil = Date.now() + 120000; throw new Error('限流，請稍後'); }
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  }
  function apiGet(path) {
    if (Date.now() < _cooldownUntil) return Promise.reject(new Error('限流中'));
    var c = _cache[path];
    if (c && Date.now() - c.t < 60000) return Promise.resolve(c.data);
    var p = useProxy()
      ? fetch(PROXY + path, { headers: { accept: 'application/json' } }).then(handleResp)
      : getToken().then(function (tok) { return fetch(API + path, { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } }).then(handleResp); });
    return p.then(function (d) { _cache[path] = { t: Date.now(), data: d }; return d; });
  }

  // ---------- 純函式（供測試） ----------
  function _pad(n) { return (n < 10 ? '0' : '') + n; }
  function _norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  // 去掉航空代碼後數字的前導零，寬鬆比對 BR0225 == BR225
  function _key(s) { var n = _norm(s); var m = n.match(/^([A-Z]+)0*([0-9]+)$/); return m ? (m[1] + m[2]) : n; }
  function _fullNo(rec) { return _norm((rec.AirlineID || '') + (rec.FlightNumber || '')); }
  function _match(input, rec) {
    var a = _key(input);
    if (_key(_fullNo(rec)) === a) return true;
    if (rec.CodeShare && _key(rec.CodeShare) === a) return true;
    // 使用者可能只打數字（少見）→ 尾數比對
    var m = a.match(/^[A-Z]*0*([0-9]+)$/), rm = _norm(rec.FlightNumber).replace(/^0+/, '');
    return !!(m && m[1] === rm && !/[A-Z]/.test(a));
  }
  function terminalText(t) {
    t = String(t == null ? '' : t).trim();
    if (!t) return '桃園機場';
    var zh = { '1': '一', '2': '二', '3': '三' }[t] || t;
    return '桃園機場 第' + zh + '航廈';
  }
  var _airZh = {
    BR: '長榮航空', CI: '中華航空', JX: '星宇航空', B7: '立榮航空', AE: '華信航空',
    IT: '台灣虎航', CX: '國泰航空', KA: '國泰港龍', HX: '香港航空', JL: '日本航空',
    NH: '全日空', MM: '樂桃航空', KE: '大韓航空', OZ: '韓亞航空', TG: '泰國航空',
    SQ: '新加坡航空', EK: '阿聯酋航空', UA: '聯合航空', DL: '達美航空', AA: '美國航空',
    VN: '越南航空', PR: '菲律賓航空', CZ: '中國南方', MU: '中國東方', CA: '中國國際',
    MH: '馬來西亞航空', GA: '印尼航空', QR: '卡達航空', TR: '酷航', '5J': '宿霧太平洋'
  };
  function airlineName(rec) {
    var an = rec.AirlineName;
    if (an && typeof an === 'object') return an.Zh_tw || an.Zh_TW || an.Zh || an.En || _airZh[rec.AirlineID] || rec.AirlineID || '';
    return _airZh[rec.AirlineID] || rec.AirlineID || '';
  }
  function _hhmm(iso) {
    if (!iso) return '';
    var m = String(iso).match(/T(\d{2}):(\d{2})/);
    if (m) return m[1] + ':' + m[2];
    var d = new Date(iso); if (isNaN(d)) return '';
    return _pad(d.getHours()) + ':' + _pad(d.getMinutes());
  }
  function _statusZh(s) {
    if (!s) return '';
    var k = String(s).trim().toLowerCase();
    var map = {
      'on time': '準時', 'scheduled': '準時', 'delayed': '延誤', 'cancelled': '取消', 'canceled': '取消',
      'boarding': '登機中', 'gate closed': '停止登機', 'departed': '已起飛', 'arrived': '已抵達',
      'landed': '已降落', 'final call': '最後登機', 'gate open': '開始登機', 'check in': '報到中',
      'estimated': '預計', 'now boarding': '登機中', 'closed': '關艙'
    };
    return map[k] || s;
  }

  // 從一批 FIDS 記錄挑符合航班的（多筆取時刻最早者），回正規化物件
  function _pick(list, flightNo, dir) {
    var recs = (list || []).filter(function (r) { return _match(flightNo, r); });
    if (!recs.length) return null;
    var isArr = dir === 'arrival';
    var tk = isArr ? 'ScheduleArrivalTime' : 'ScheduleDepartureTime';
    recs.sort(function (a, b) { return (new Date(a[tk] || 0)) - (new Date(b[tk] || 0)); });
    var r = recs[0];
    var sched = isArr ? r.ScheduleArrivalTime : r.ScheduleDepartureTime;
    var actual = isArr ? (r.ActualArrivalTime || r.EstimatedArrivalTime) : (r.ActualDepartureTime || r.EstimatedDepartureTime);
    var remark = isArr ? r.ArrivalRemark : r.DepartureRemark;
    return {
      flight: _fullNo(r), airline: airlineName(r), airlineId: r.AirlineID,
      terminal: r.Terminal, terminalText: terminalText(r.Terminal), gate: r.Gate || '',
      sched: _hhmm(sched), actual: _hhmm(actual), schedIso: sched || '',
      status: _statusZh(remark), rawRemark: remark || '',
      counterpart: isArr ? (r.DepartureAirportID || '') : (r.ArrivalAirportID || ''),
      dir: isArr ? 'arrival' : 'departure'
    };
  }

  // 對外查詢：dir ∈ 'departure'(送機) | 'arrival'(接機) → Promise<物件|null>
  function lookup(flightNo, dir) {
    var isArr = dir === 'arrival';
    var path = '/v1/Air/FIDS/Airport/' + (isArr ? 'Arrival' : 'Departure') + '/' + AIRPORT + '?$format=JSON';
    return apiGet(path).then(function (list) { return _pick(list, flightNo, isArr ? 'arrival' : 'departure'); });
  }

  global.MaptripFlight = {
    lookup: lookup, terminalText: terminalText, airlineName: airlineName,
    // 純函式（測試）
    _norm: _norm, _key: _key, _match: _match, _pick: _pick, _statusZh: _statusZh, _hhmm: _hhmm, _fullNo: _fullNo
  };
})(typeof window !== 'undefined' ? window : globalThis);
