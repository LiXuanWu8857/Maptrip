/* trip-recorder.js — 行程記錄核心(背景 GPS 生命週期)*/
(function (global) {
  'use strict';

  var ACTIVE_KEY = 'maptrip_lab_active_trip';

  /**
   * @param {object} deps 注入依賴,方便測試替換:
   *   { store, gate, clean, geo, now, dayKeyOf }
   */
  function TripRecorder(deps) {
    this.store = deps.store;
    this.gate = deps.gate || global.MaptripGeoGate;
    this.clean = deps.clean || global.MaptripGeoClean;
    this.geo = deps.geo;
    this.now = deps.now || function () { return Date.now(); };
    this.dayKeyOf = deps.dayKeyOf || function (ts) {
      return new Date(ts).toISOString().slice(0, 10);
    };
    this.active = null;      // 進行中的行程物件,null = 沒在記
    this._lastAccepted = null;
  }

  // 行程物件結構(對應文件):coords[0] = 上車點
  function newTrip(id, startTime) {
    return {
      id: id, startTime: startTime, endTime: null,
      coords: [], totalDist: 0, fare: 0,
      paymentMethod: null, commission: 0, dispatch: 0,
      label: '', roadCoords: null
    };
  }

  TripRecorder.prototype.startTrip = function () {
    var t = this.now();
    this.active = newTrip('t' + t, t);
    this._lastAccepted = null;
    this._persistActive();
    var self = this;
    this.geo.start(function (pt) { self._onPoint(pt); });   // 開始收背景 GPS
    return this.active;
  };

  TripRecorder.prototype._onPoint = function (pt) {
    if (!this.active) return;
    var res = this.gate.accept(pt, this._lastAccepted);
    if (!res.accept) return;                       // 髒點,源頭丟棄
    this.active.coords.push({ lat: pt.lat, lng: pt.lng, t: pt.t });
    if (this._lastAccepted) {
      this.active.totalDist += this.gate.distM(this._lastAccepted, pt);
    }
    this._lastAccepted = pt;
    this._persistActive();                         // 邊收邊存,被砍也接得回
  };

  /** 結束行程。先落盤(fare=0),回傳這趟,讓 UI 再去問車資。 */
  TripRecorder.prototype.endTrip = function () {
    if (!this.active) return null;
    this.geo.stop();
    var trip = this.active;
    trip.endTime = this.now();
    trip.coords = this.clean.cleanTrace(trip.coords);   // 落盤前清理原始軌跡
    this._saveFinal(trip);                              // ★ 先存,從此安全
    this.active = null;
    this._clearActive();
    return trip;                                        // UI 拿去問車資,再 updateTrip
  };

  // 事後更新(車資、付款、抽成、貼路結果…)。找到同 id 覆蓋。
  TripRecorder.prototype.updateTrip = function (trip) {
    var dk = this.dayKeyOf(trip.startTime);
    var list = this.store.loadTrips(dk);
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === trip.id) { list[i] = trip; found = true; break; }
    }
    if (!found) list.push(trip);
    this.store.saveTrips(dk, list);
  };

  TripRecorder.prototype._saveFinal = function (trip) {
    var dk = this.dayKeyOf(trip.startTime);
    var list = this.store.loadTrips(dk);
    list.push(trip);
    this.store.saveTrips(dk, list);
  };

  // ---- 被砍自動接回 ----
  TripRecorder.prototype._persistActive = function () {
    try { global.localStorage.setItem(ACTIVE_KEY, JSON.stringify(this.active)); }
    catch (e) { }
  };
  TripRecorder.prototype._clearActive = function () {
    try { global.localStorage.removeItem(ACTIVE_KEY); } catch (e) { }
  };

  /** App 重開時呼叫:若有暫存的進行中行程,接回繼續記。 */
  TripRecorder.prototype.restoreActiveTrip = function () {
    try {
      var raw = global.localStorage.getItem(ACTIVE_KEY);
      if (!raw) return false;
      this.active = JSON.parse(raw);
      var c = this.active.coords;
      this._lastAccepted = c.length ? c[c.length - 1] : null;
      var self = this;
      this.geo.start(function (pt) { self._onPoint(pt); });
      return true;
    } catch (e) { return false; }
  };

  global.TripRecorder = TripRecorder;

})(typeof window !== 'undefined' ? window : globalThis);
