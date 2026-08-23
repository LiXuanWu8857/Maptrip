// MaptripSheetSync — 記帳者確認完某日金額（按「✓ 已完成紀錄」）後，把「當日總結」自動上傳到
// 使用者自己的 Google Sheets（透過 Apps Script 網頁應用，App 端零 OAuth、不存密碼）。
// 結構：司機分活頁簿（workbook）、每月分工作表（tab）、每日一列；同一天重傳＝更新該列（不重複）。
// 上傳目標網址與密鑰存在「記帳者這台裝置」的 localStorage（確認動作都在記帳者端）。
// 算錢一律沿用 bookkeeper 傳進來的 _daySummary 結果（單一來源，不在此重算）。
window.MaptripSheetSync = (function () {
  'use strict';

  var URL_KEY = 'mt_sheet_url';      // Apps Script 部署後的 /exec 網址
  var SEC_KEY = 'mt_sheet_secret';   // 與 Apps Script 內設定一致的簡易密鑰（擋亂打）
  var AUTO_KEY = 'mt_sheet_auto';    // '1'=按「已完成紀錄」自動上傳；預設關

  function getConfig() {
    return {
      url: (localStorage.getItem(URL_KEY) || '').trim(),
      secret: (localStorage.getItem(SEC_KEY) || '').trim(),
      auto: localStorage.getItem(AUTO_KEY) === '1'
    };
  }
  function setConfig(url, secret, auto) {
    try {
      localStorage.setItem(URL_KEY, (url || '').trim());
      localStorage.setItem(SEC_KEY, (secret || '').trim());
      localStorage.setItem(AUTO_KEY, auto ? '1' : '0');
    } catch (_) {}
  }
  function isConfigured() { return !!getConfig().url; }
  function autoOn() { var c = getConfig(); return !!c.url && c.auto; }

  // 組裝「當日一列」的 payload（純函式）。summary＝bookkeeper._daySummary 結果
  // （cash/card/comm/disp/total，total＝cash+card−comm−disp）；expense＝當日營業成本支出
  // （加油/洗車/保養，由 bookkeeper 依 BK_EXP_CATS 過濾加總後傳入）。
  function buildDaily(o) {
    o = o || {};
    var s = o.summary || {};
    var cash = s.cash || 0, card = s.card || 0, comm = s.comm || 0, disp = s.disp || 0;
    var total = (s.total != null) ? s.total : (cash + card - comm - disp);
    var expense = o.expense || 0;
    return {
      type: 'daily',
      driverUid: String(o.driverUid || ''),
      driverName: String(o.driverName || '司機'),
      day: String(o.day || ''),
      month: String(o.day || '').slice(0, 7),
      trips: o.trips || 0,
      cash: cash,
      card: card,
      revenue: cash + card,
      commission: comm,
      dispatch: disp,
      expense: expense,
      net: total - expense   // 當日淨利＝現金＋刷卡−抽成−叫車−營業成本支出
    };
  }

  // 送出到 Apps Script。用 text/plain 避開 CORS preflight（Apps Script 對 simple request 才穩）。
  function push(payload) {
    var cfg = getConfig();
    if (!cfg.url) return Promise.resolve({ ok: false, error: '尚未設定 Google Sheets 網址' });
    var body = JSON.stringify(_assign({ secret: cfg.secret }, payload));
    return fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow'
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (_) {}
        if (j && typeof j.ok === 'boolean') return { ok: j.ok, error: j.error, data: j };
        // 讀不到 JSON（例如 CORS 擋回應內容）→ 視為已送出、但無法確認
        return { ok: r.ok, error: r.ok ? null : ('HTTP ' + r.status), uncertain: true };
      });
    }).catch(function (e) {
      // 多半是 CORS 擋「讀取回應」，但 POST 其實已送達；回報不確定而非失敗
      return { ok: false, uncertain: true, error: String((e && e.message) || e) };
    });
  }

  // 便利：組當日總結並上傳。
  function pushDay(o) { return push(buildDaily(o)); }

  // 測試連線：送一筆 ping，Apps Script 回 {ok:true,pong:true}。
  function ping() {
    var cfg = getConfig();
    if (!cfg.url) return Promise.resolve({ ok: false, error: '尚未設定網址' });
    return push({ type: 'ping' });
  }

  function _assign(a, b) { for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k]; return a; }

  return {
    getConfig: getConfig, setConfig: setConfig, isConfigured: isConfigured, autoOn: autoOn,
    buildDaily: buildDaily, push: push, pushDay: pushDay, ping: ping,
    URL_KEY: URL_KEY, SEC_KEY: SEC_KEY, AUTO_KEY: AUTO_KEY
  };
})();
