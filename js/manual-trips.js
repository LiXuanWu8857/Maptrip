/* =============================================================
 * manual-trips.js — 記帳者補登紀錄（manualTrips）在司機端的顯示層合併（MaptripManual）
 * -------------------------------------------------------------
 * 需求（#1）：記帳者代司機補登的紀錄（司機忘按/現金單）存在雲端 users/{uid}/manualTrips，
 * 司機 App 訂閱後**用顯示層合併**併進今日/歷史（標「手動」、司機可刪），
 * **但絕不寫進司機的 days**（避免污染雲端、避免被司機存檔蓋掉）。
 *
 * 儲存：記憶體 + 裝置級 localStorage 快取（冷啟動先看得到；不進 IndexedDB days）。
 * 換帳號時由 sync.js `_clearLocalForSwitch` 呼叫 clear()。
 *
 * 手動趟正規化欄位：{ id, fare, paymentMethod, startTime, day, label, by }
 * 合併後標 `_manual:true`；GPS 趟原物件一律不改（回傳新陣列/新 map）。
 * ============================================================= */
(function (global) {
  'use strict';
  var KEY = 'maptrip_manual';
  var _list = load();

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (_) { return []; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(_list)); } catch (_) {} }

  function _localDay(ts) {
    try { var d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    catch (_) { return ''; }
  }
  function dayOf(m) { return m.day || (m.startTime ? _localDay(m.startTime) : ''); }
  function norm(m) {
    return { id: String(m.id), fare: (m.fare != null ? m.fare : 0), paymentMethod: m.paymentMethod || 'cash',
      startTime: m.startTime || 0, day: dayOf(m), label: m.label || '', by: m.by || '' };
  }

  // 從雲端快照設定全部（取代）。
  function set(list) { _list = (list || []).map(norm).filter(function (m) { return m.day; }); save(); }
  function clear() { _list = []; save(); }
  function remove(id) { _list = _list.filter(function (m) { return m.id !== String(id); }); save(); }   // 樂觀移除（刪除後即時消失）
  function all() { return _list.slice(); }
  // 有手動紀錄的所有日子（去重）。
  function days() {
    var s = {}; _list.forEach(function (m) { if (m.day) s[m.day] = 1; });
    return Object.keys(s);
  }

  // 某天的手動趟（含 _manual:true，依 startTime 排序）。回傳的是複本（可安全渲染/刪除）。
  function forDay(dayKey) {
    return _list.filter(function (m) { return m.day === dayKey; })
      .map(function (m) { return { id: m.id, fare: m.fare, paymentMethod: m.paymentMethod, startTime: m.startTime, label: m.label, _manual: true }; })
      .sort(function (a, b) { return (a.startTime || 0) - (b.startTime || 0); });
  }

  // 併入某天的 GPS 趟：回傳依 startTime 排序的合併陣列（GPS 趟原物件不改）。
  function mergeDay(dayTrips, dayKey) {
    var arr = (dayTrips || []).slice();
    forDay(dayKey).forEach(function (m) { arr.push(m); });
    arr.sort(function (a, b) { return (a.startTime || 0) - (b.startTime || 0); });
    return arr;
  }

  // 併入整個 days map（給收支報表算營收）：回傳新 map（不改原物件）。
  function mergeInto(daysMap) {
    var out = {};
    Object.keys(daysMap || {}).forEach(function (d) { out[d] = (daysMap[d] || []).slice(); });
    forDay0().forEach(function (item) {
      if (!out[item.day]) out[item.day] = [];
      out[item.day].push(item.t);
    });
    return out;
  }
  // 內部：所有手動趟攤平成 {day, t(_manual)}，供 mergeInto。
  function forDay0() {
    return _list.map(function (m) {
      return { day: m.day, t: { id: m.id, fare: m.fare, paymentMethod: m.paymentMethod, startTime: m.startTime, label: m.label, _manual: true } };
    });
  }

  global.MaptripManual = {
    set: set, clear: clear, remove: remove, all: all, days: days,
    forDay: forDay, mergeDay: mergeDay, mergeInto: mergeInto, _localDay: _localDay
  };
})(typeof window !== 'undefined' ? window : globalThis);
