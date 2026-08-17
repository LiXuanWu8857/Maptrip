/* =============================================================
 * hotspot-share.js — 共享找客熱點的「去識別化網格」純函式核心（MaptripHotspotShare）
 * -------------------------------------------------------------
 * Phase 1（私人小圈/車隊）：跨司機共享上車熱點，但池子裡**只存去識別化的格子次數**
 * （300m 網格 × 8 時段 × 平日/假日，只有 count，沒有身分/精確座標/車資/實際時間）。
 *
 * 本檔只放**純函式**（cellId/dayType/bucket、附近格子過濾、k-匿名、混合排名、回填聚合），
 * 不碰 Firestore、不碰 DOM → 好測、與 sync.js（雲端 I/O）和 hotspots.js（面板）解耦。
 *
 * 設計定案（見 docs/共享熱點-設計草稿.md）：私人小圈、混合顯示（自己 ×2、隊友 ×1 當背景）、
 * k-匿名 N=2（隊友格子要 ≥2 才顯示；自己的 ≥1 就顯示）、附近半徑 2.5km、近期加權
 * （近 30 天 ×1、更舊 ×0.5）、回填單次上限 500 格。
 * ============================================================= */
(function (global) {
  'use strict';

  var GRID_DEG   = 0.003;    // 網格邊長（度）≈ 330m（緯度）
  var RADIUS_M   = 2500;     // 附近半徑（公尺）
  var MIN_COUNT  = 2;        // 隊友格子 k-匿名門檻（≥2 才顯示）
  var BACKFILL_CAP = 500;    // 回填單次最多寫幾格
  var OWN_W = 2, TEAM_W = 1; // 混合權重：自己的上車點加重、隊友當背景
  var DAY = 86400000;

  // ---- 時段（8 段，與 hotspots.js / finance.js 一致；深夜跨午夜）----
  var BUCKETS = [
    { s: 5, e: 7 }, { s: 7, e: 9 }, { s: 9, e: 11 }, { s: 11, e: 14 },
    { s: 14, e: 17 }, { s: 17, e: 19 }, { s: 19, e: 22 }, { s: 22, e: 5 }
  ];
  function bucket(h) {
    for (var i = 0; i < BUCKETS.length; i++) {
      var b = BUCKETS[i];
      if (b.s < b.e) { if (h >= b.s && h < b.e) return i; }
      else { if (h >= b.s || h < b.e) return i; }
    }
    return -1;
  }

  // ---- 平日/假日（假日需求型態≈週末；表僅 2026，與 hotspots.js 同步、每年需更新）----
  var HOLIDAYS = {
    2026: new Set([
      '2026-01-01',
      '2026-02-14','2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22',
      '2026-02-28','2026-03-02','2026-04-04','2026-04-05','2026-04-06',
      '2026-05-01','2026-05-02','2026-05-03','2026-06-19','2026-06-20','2026-06-21',
      '2026-09-25','2026-09-26','2026-09-27','2026-09-28','2026-10-10','2026-10-11','2026-10-12',
      '2026-10-25','2026-10-26','2026-12-25'
    ])
  };
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function isOffDay(d) { var wd = d.getDay(); if (wd === 0 || wd === 6) return true; var s = HOLIDAYS[d.getFullYear()]; return !!(s && s.has(ymd(d))); }
  function dayType(d) { return isOffDay(d) ? 'we' : 'wk'; }

  // ---- 網格 ----
  function snap(v) { return Math.round(v / GRID_DEG) * GRID_DEG; }         // 吸到網格中心
  function g3(v) { return snap(v).toFixed(3); }
  function gridKey(gLat, gLng) { return (+gLat).toFixed(3) + '_' + (+gLng).toFixed(3); }
  // 一個上車點在「某時刻」對應的去識別化格子欄位（cellId＝寫入雲端的 doc id）
  function cellFields(lat, lng, date) {
    var d = (date instanceof Date) ? date : new Date(date);
    var dt = dayType(d), b = bucket(d.getHours());
    var gLat = snap(lat), gLng = snap(lng);
    return { gLat: +gLat.toFixed(6), gLng: +gLng.toFixed(6), dayType: dt, bucket: b,
      cellId: g3(lat) + '_' + g3(lng) + '_' + dt + '_' + b };
  }
  function cellId(lat, lng, date) { return cellFields(lat, lng, date).cellId; }

  // 目前時間的情境（給讀取用）
  function nowContext(date) {
    var d = date || new Date();
    return { date: d, dayType: dayType(d), bucket: bucket(d.getHours()) };
  }

  // 讀取用：某緯度中心 + 半徑 → 要查的緯度帶（Firestore 用 gLat 範圍查，再前端過濾經度）
  function latBand(lat, radiusM) {
    var dLat = ((radiusM || RADIUS_M) / 111320) + GRID_DEG;   // 多帶一格邊界
    return { min: +(lat - dLat).toFixed(6), max: +(lat + dLat).toFixed(6) };
  }

  function haversine(a, b) {
    var R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function bearing(a, b) {
    var y = Math.sin((b.lng - a.lng) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
    var x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) -
      Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lng - a.lng) * Math.PI / 180);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function recency(updatedAt, now) {
    if (!updatedAt) return 0.5;
    var age = ((now || Date.now()) - updatedAt) / DAY;
    return age <= 30 ? 1 : 0.5;                    // 近 30 天 ×1、更舊 ×0.5
  }

  // ---- 回填：把「自己的歷史上車點」聚成去識別化格子（依各點自己的時間算 dayType/bucket）----
  // pickups: [{lat,lng,t}]（t＝上車毫秒時間）。回傳 [{cellId,gLat,gLng,dayType,bucket,delta}]，
  // 依 delta（次數）由多到少、上限 cap 格（預設 500）。
  function aggregateHistoryCells(pickups, cap) {
    var m = {};
    (pickups || []).forEach(function (p) {
      if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number' || !p.t) return;
      var f = cellFields(p.lat, p.lng, p.t);
      var c = m[f.cellId] || (m[f.cellId] = { cellId: f.cellId, gLat: f.gLat, gLng: f.gLng, dayType: f.dayType, bucket: f.bucket, delta: 0 });
      c.delta++;
    });
    var arr = Object.keys(m).map(function (k) { return m[k]; });
    arr.sort(function (a, b) { return b.delta - a.delta; });
    return arr.slice(0, cap || BACKFILL_CAP);
  }

  // ---- 讀取端：自己的「當前時段」上車點聚成格子（供混合；不做 k-匿名，自己的 ≥1 就算）----
  // pickups:[{lat,lng,t}]、me:{lat,lng}、ctx=nowContext()。回傳 {gridKey:{gLat,gLng,count}}。
  function ownCellsNow(pickups, me, ctx, radiusM) {
    var out = {}, R = radiusM || RADIUS_M;
    ctx = ctx || nowContext();
    (pickups || []).forEach(function (p) {
      if (!p || !p.t) return;
      var d = new Date(p.t);
      if (dayType(d) !== ctx.dayType || bucket(d.getHours()) !== ctx.bucket) return;
      if (haversine(me, { lat: p.lat, lng: p.lng }) > R) return;
      var gLat = snap(p.lat), gLng = snap(p.lng), k = gridKey(gLat, gLng);
      var c = out[k] || (out[k] = { gLat: gLat, gLng: gLng, count: 0 });
      c.count++;
    });
    return out;
  }

  // ---- 讀取端：隊友 grid 文件 → 過濾半徑 + k-匿名(≥MIN_COUNT) → {gridKey:{gLat,gLng,count,score}} ----
  // gridDocs:[{gLat,gLng,count,updatedAt}]（已由 sync 依 dayType+bucket 查回本時段），me、now。
  function teamCells(gridDocs, me, opts) {
    opts = opts || {};
    var R = opts.radiusM || RADIUS_M, minCount = opts.minCount != null ? opts.minCount : MIN_COUNT, now = opts.now || Date.now();
    var out = {};
    (gridDocs || []).forEach(function (c) {
      if (!c || (c.count || 0) < minCount) return;                          // k-匿名
      var center = { lat: c.gLat, lng: c.gLng };
      if (haversine(me, center) > R) return;
      var k = gridKey(c.gLat, c.gLng);
      out[k] = { gLat: c.gLat, gLng: c.gLng, count: c.count, score: c.count * recency(c.updatedAt, now) };
    });
    return out;
  }

  // ---- 混合排名：自己 ×OWN_W、隊友 ×TEAM_W，同格子合併；回傳排名 zones ----
  // 顯示條件：自己有(≥1) 或 隊友過了 k-匿名 的格子。
  function mix(ownMap, teamMap, me, topN) {
    var keys = {};
    Object.keys(ownMap || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(teamMap || {}).forEach(function (k) { keys[k] = 1; });
    var zones = Object.keys(keys).map(function (k) {
      var o = (ownMap && ownMap[k]) || null, t = (teamMap && teamMap[k]) || null;
      var gLat = (o && o.gLat) != null ? o.gLat : t.gLat, gLng = (o && o.gLng) != null ? o.gLng : t.gLng;
      var ownCount = o ? o.count : 0, teamScore = t ? t.score : 0, teamCount = t ? t.count : 0;
      var center = { lat: gLat, lng: gLng };
      return {
        center: center, score: ownCount * OWN_W + teamScore * TEAM_W,
        ownCount: ownCount, teamCount: teamCount,
        source: ownCount && teamCount ? 'both' : (ownCount ? 'own' : 'team'),
        dist: haversine(me, center), brg: bearing(me, center)
      };
    });
    zones.sort(function (a, b) { return b.score - a.score; });
    return zones.slice(0, topN || 6);
  }

  global.MaptripHotspotShare = {
    // 常數（供 sync/panel 對齊）
    GRID_DEG: GRID_DEG, RADIUS_M: RADIUS_M, MIN_COUNT: MIN_COUNT, BACKFILL_CAP: BACKFILL_CAP,
    // 純函式
    dayType: dayType, bucket: bucket, isOffDay: isOffDay,
    cellFields: cellFields, cellId: cellId, gridKey: gridKey, nowContext: nowContext, latBand: latBand,
    aggregateHistoryCells: aggregateHistoryCells, ownCellsNow: ownCellsNow, teamCells: teamCells, mix: mix,
    haversine: haversine, bearing: bearing
  };
})(typeof window !== 'undefined' ? window : globalThis);
