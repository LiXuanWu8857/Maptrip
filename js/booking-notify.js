/* =============================================================
 * booking-notify.js — 預約「原生本地通知」（MaptripBookingNotify）
 * -------------------------------------------------------------
 * 用 @capacitor/local-notifications 在手機上「預先排程」每筆預約的提醒，
 * App 關著/背景也會由 iOS 自己跳（免伺服器、免網路）。
 *
 * 觸發點：booking.js 在 save/remove/clear/set 後呼叫 resync(_list) 全量重排；
 *   init() 加點通知監聽（點通知開預約清單）＋ ensurePermission() 要權限。
 *
 * 安全：未裝外掛 / 非原生（瀏覽器）時所有方法 no-op（_ln() 回 null）。
 * 純函式 _buildNotifications/_nid/_leadSuffix 供測試（不碰外掛）。
 * ============================================================= */
(function (global) {
  'use strict';

  var _inited = false;

  function _ln() {
    try {
      var cap = global.Capacitor;
      if (cap && cap.isNativePlatform && cap.isNativePlatform() &&
          cap.Plugins && cap.Plugins.LocalNotifications) {
        return cap.Plugins.LocalNotifications;
      }
    } catch (_) {}
    return null;
  }

  function _pad(n) { return (n < 10 ? '0' : '') + n; }

  // 由 (預約 id, 提醒分鐘) 產生穩定正整數通知 id（djb2 hash）→ 重排時可對應/取消
  function _nid(id, lead) {
    var s = String(id) + ':' + lead, h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return (h & 0x7fffffff) % 2000000000 + 1;
  }

  function _leadSuffix(lead) {
    lead = +lead || 0;
    if (!lead) return '（準時）';
    if (lead < 60) return '（還有 ' + lead + ' 分）';
    if (lead % 60 === 0) return '（還有 ' + (lead / 60) + ' 小時）';
    return '（還有 ' + Math.floor(lead / 60) + ' 小時 ' + (lead % 60) + ' 分）';
  }

  // 由預約清單算出「要排的通知」：未完成/未取消、各提醒點在未來者才排
  function _buildNotifications(list, now) {
    now = now || Date.now();
    var out = [];
    (list || []).forEach(function (b) {
      if (!b || !b.pickupTime || !b.reminders || !b.reminders.length) return;
      if (b.status === 'done' || b.status === 'cancelled') return;
      var t = new Date(b.pickupTime);
      var hhmm = _pad(t.getHours()) + ':' + _pad(t.getMinutes());
      var name = b.name || b.lineName || '預約';
      var where = (b.pickup && b.pickup.text) ? (' · ' + b.pickup.text) : '';
      b.reminders.forEach(function (lead) {
        var at = b.pickupTime - (+lead || 0) * 60000;
        if (at <= now + 500) return;   // 過去或太近的排不了
        out.push({ id: _nid(b.id, lead), title: '🚕 預約提醒', body: hhmm + ' ' + name + where + _leadSuffix(lead), at: at });
      });
    });
    return out;
  }

  // 全量重排：取消所有既有排程 → 依現況重新排（簡單且不會有殘留/重複）
  function resync(list) {
    var LN = _ln();
    if (!LN) return Promise.resolve();
    var notifs = _buildNotifications(list, Date.now());
    return Promise.resolve(LN.getPending()).then(function (res) {
      var pending = (res && res.notifications) || [];
      if (!pending.length) return;
      return LN.cancel({ notifications: pending.map(function (n) { return { id: n.id }; }) });
    }).catch(function () {}).then(function () {
      if (!notifs.length) return;
      return LN.schedule({
        notifications: notifs.map(function (n) {
          return { id: n.id, title: n.title, body: n.body, schedule: { at: new Date(n.at), allowWhileIdle: true } };
        })
      });
    }).catch(function () {});
  }

  function ensurePermission() {
    var LN = _ln();
    if (!LN) return Promise.resolve(false);
    return Promise.resolve(LN.checkPermissions()).then(function (r) {
      if (r && r.display === 'granted') return true;
      return Promise.resolve(LN.requestPermissions()).then(function (rr) { return !!(rr && rr.display === 'granted'); });
    }).catch(function () { return false; });
  }

  function init() {
    var LN = _ln();
    if (!LN || _inited) return;
    _inited = true;
    try {
      LN.addListener('localNotificationActionPerformed', function () {
        try { if (global.MaptripBooking && MaptripBooking.open) MaptripBooking.open(); } catch (_) {}
      });
    } catch (_) {}
  }

  global.MaptripBookingNotify = {
    resync: resync, ensurePermission: ensurePermission, init: init,
    // 純函式（測試）
    _buildNotifications: _buildNotifications, _nid: _nid, _leadSuffix: _leadSuffix
  };
})(typeof window !== 'undefined' ? window : globalThis);
