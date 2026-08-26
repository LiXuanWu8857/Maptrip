/* screenshot.js — 行程截圖（Canvas 繪圖，自成一體）
 * 從 app.js v1.1.256 的截圖整段（_latlngToWorldPx…_fullDateLabel）逐字搬出。
 * 不碰 Leaflet 地圖物件：自行載入 CartoDB 圖磚畫在 canvas 上。
 * 相依：全域函式（loadTrips/dayKeyToLabel/todayKey/toast/getRestMin/fmtWork/workMs/
 *   fmtDist/fmtDur/fmtTime，執行期由 window 取用）＋ todayTrips（以 init 注入）。
 * app.js 留同名薄包裝，HTML onclick 等呼叫端零改動。
 */
(function (global) {
  'use strict';

  // todayTrips 是 app.js 模組私有 let，跨檔看不到 → 由 init 注入存取器
  var ctx = { todayTrips: function () { return []; } };
  var _shotDayKey = null;   // 目前預覽的日截圖是哪一天（勾選「其他」重畫用；今日＝undefined）
  function init(o) { if (o && typeof o.todayTrips === 'function') ctx.todayTrips = o.todayTrips; }

function _latlngToWorldPx(lat, lng, z) {
  const s = 256 * Math.pow(2, z);
  const t = Math.sin(lat * Math.PI / 180);
  return { x: (lng + 180) / 360 * s, y: (0.5 - Math.log((1 + t) / (1 - t)) / (4 * Math.PI)) * s };
}

// 載入一張圖磚。**必帶逾時**：CartoDB 圖磚伺服器過載/掛住時，Image 不會觸發 onload/onerror，
// 沒逾時的話 Promise 永遠不 resolve → 上層 Promise.all 卡死 → 整張截圖出不來（全日尤甚，圖磚多）。
// 逾時就當這張圖磚「跳過」（回 null，繪圖層 if(!img)return 略過），截圖照樣完成（底圖缺幾塊而已）。
function _loadTile(url, timeoutMs) {
  return new Promise(r => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    let done = false;
    const finish = v => { if (done) return; done = true; clearTimeout(timer); r(v); };
    const timer = setTimeout(() => { try { img.src = ''; } catch (_) {} finish(null); }, timeoutMs || 6000);
    img.onload = () => finish(img); img.onerror = () => finish(null); img.src = url;
  });
}

async function captureTripsScreenshot(dayKey, includeOther) {
  let trips, dateLabel;
  if (dayKey) {
    const raw = loadTrips();
    trips = raw[dayKey] || [];
    dateLabel = dayKeyToLabel(dayKey);
  } else {
    trips = ctx.todayTrips();
    dateLabel = dayKeyToLabel(todayKey());
  }
  if (!trips.length) { toast('無行程可截圖'); return; }
  // 「其他」行程（自用/非載客）預設不放進截圖；預覽上有勾選框可加回（v290）。
  const hasOther = trips.some(t => t.paymentMethod === 'other');
  if (includeOther === undefined) includeOther = false;      // 預設：不含「其他」
  _shotDayKey = dayKey;                                      // 記住這張是哪天（勾選框重畫用；今日＝undefined）
  if (includeOther === false) {
    const only = trips.filter(t => t.paymentMethod !== 'other');
    if (only.length) trips = only; else includeOther = true; // 整天都是「其他」→ 無法排除，只好包含
  }
  if (!trips.length) { toast('無行程可截圖'); return; }

  const W = 390, H = 485;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2; canvas.height = H * 2;
  const c = canvas.getContext('2d');
  c.scale(2, 2);

  // 卡片背景
  c.fillStyle = '#141414';
  _rrect(c, 0, 0, W, H, 24); c.fill();

  // 左：去背 LOGO（右上角日期+時間範圍待地圖畫完後再繪）
  _drawBrand(c, 20, 28, 42);

  // 路線區（先算時間範圍，待地圖畫完後再繪右上角，避免被蓋掉）
  const firstStart = trips[0].startTime;
  const lastEnd = trips[trips.length - 1].endTime;

  // 路線區
  const rX = 16, rY = 88, rW = W - 32, rH = 310;
  const allPts = trips.flatMap(t => (t.roadCoords || t.coords || []).map(p => [p.lat, p.lng]));

  if (allPts.length > 1) {
    // 選擇最佳縮放等級（最多載入 16 tiles）
    let z = 12, sc, viewX0, viewY0;
    for (let zz = 16; zz >= 9; zz--) {
      const wps = allPts.map(([la, ln]) => _latlngToWorldPx(la, ln, zz));
      const wxs = wps.map(p => p.x), wys = wps.map(p => p.y);
      const sX = (Math.max(...wxs) - Math.min(...wxs)) || 1;
      const sY = (Math.max(...wys) - Math.min(...wys)) || 1;
      const _sc = Math.min(rW / sX, rH / sY) * 0.7;
      if ((Math.ceil(rW / _sc / 256) + 1) * (Math.ceil(rH / _sc / 256) + 1) <= 16) {
        z = zz; sc = _sc;
        const wcX = (Math.min(...wxs) + Math.max(...wxs)) / 2;
        const wcY = (Math.min(...wys) + Math.max(...wys)) / 2;
        viewX0 = wcX - rW / (2 * sc);
        viewY0 = wcY - rH / (2 * sc);
        break;
      }
    }

    // 載入 CartoDB Dark 底圖 tiles
    const TS = 256, maxT = Math.pow(2, z) - 1;
    const tx0 = Math.floor(viewX0 / TS), ty0 = Math.floor(viewY0 / TS);
    const tx1 = Math.ceil((viewX0 + rW / sc) / TS), ty1 = Math.ceil((viewY0 + rH / sc) / TS);
    const subs = ['a', 'b', 'c', 'd'], jobs = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      if (tx < 0 || ty < 0 || tx > maxT || ty > maxT) continue;
      jobs.push(_loadTile(`https://${subs[(tx + ty) % 4]}.basemaps.cartocdn.com/dark_all/${z}/${tx}/${ty}.png`).then(img => ({ img, tx, ty })));
    }
    const tiles = await Promise.all(jobs);

    // 裁剪並繪製底圖
    c.save();
    c.beginPath(); _rrect(c, rX, rY, rW, rH, 14); c.clip();
    c.fillStyle = '#1a2035'; c.fillRect(rX, rY, rW, rH);
    tiles.forEach(({ img, tx, ty }) => {
      if (!img) return;
      c.drawImage(img, rX + (tx * TS - viewX0) * sc, rY + (ty * TS - viewY0) * sc, TS * sc, TS * sc);
    });

    // 繪製路線（先畫所有線，編號之後另一輪畫在最上層）
    const wp2c = (la, ln) => { const wp = _latlngToWorldPx(la, ln, z); return [rX + (wp.x - viewX0) * sc, rY + (wp.y - viewY0) * sc]; };
    const COLS = ['#4fc3f7','#81c784','#ffb74d','#f06292','#ce93d8','#80cbc4','#a5d6a7','#fff176'];
    const starts = [];
    trips.forEach((t, i) => {
      const pts = (t.roadCoords || t.coords || []).map(p => [p.lat, p.lng]);
      if (pts.length < 2) return;
      const [sx, sy] = wp2c(pts[0][0], pts[0][1]);
      starts.push([sx, sy, i + 1]);
      c.beginPath(); c.moveTo(sx, sy);
      pts.slice(1).forEach(p => { const [px, py] = wp2c(p[0], p[1]); c.lineTo(px, py); });
      c.strokeStyle = COLS[i % COLS.length]; c.lineWidth = 2.5; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke();
    });
    // 編號標記（白底深字圓，疊在所有路線之上）
    starts.forEach(([sx, sy, num]) => {
      const r = 9;
      c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2);
      c.fillStyle = '#1a1a1a'; c.fill();
      c.lineWidth = 1.5; c.strokeStyle = '#ffffff'; c.stroke();
      c.fillStyle = '#ffffff';
      c.font = `bold ${num > 9 ? 9 : 11}px system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'alphabetic';
      const m = c.measureText(String(num));
      const textH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      c.fillText(String(num), sx, sy + m.actualBoundingBoxAscent - textH / 2);
    });
    c.restore();
  } else {
    c.fillStyle = '#1a2035'; _rrect(c, rX, rY, rW, rH, 14); c.fill();
  }

  // 右上角：日期（上）+ 工作時長（已扣休息）（下）
  const restMin = getRestMin(dayKey || todayKey());
  const spanLabel = fmtWork(workMs(trips, restMin));
  _drawRightTwoLines(c, W - 20,
    _fullDateLabel(firstStart), '13px system-ui, sans-serif', '#e8eaed', 46,
    spanLabel, '12px system-ui, sans-serif', '#9aa0a6', 66);

  // 統計
  const totalDist = trips.reduce((s, t) => s + (t.totalDist || 0), 0);
  const totalFare = trips.reduce((s, t) => s + (t.fare || 0), 0);
  const sY = rY + rH + 18;
  c.strokeStyle = '#2a2a2a'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(24, sY - 4); c.lineTo(W - 24, sY - 4); c.stroke();

  // 趟數 / 里程 / 收入
  const statCols = totalFare ? [W * 0.2, W * 0.5, W * 0.8] : [W * 0.3, W * 0.7];
  const vals = totalFare
    ? [`${trips.length} 趟`, fmtDist(totalDist), `NT$ ${totalFare.toLocaleString()}`]
    : [`${trips.length} 趟`, fmtDist(totalDist)];
  const lbls = totalFare ? ['行程', '里程', '收入'] : ['行程', '里程'];
  c.textAlign = 'center';
  statCols.forEach((x, i) => {
    c.fillStyle = '#ffffff'; c.font = 'bold 17px system-ui, sans-serif'; c.fillText(vals[i], x, sY + 23);
    c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif'; c.fillText(lbls[i], x, sY + 39);
  });
  c.fillStyle = '#3c4043'; c.font = '10px system-ui, sans-serif'; c.textAlign = 'center';
  c.fillText('Maptrip · 行程紀錄', W / 2, H - 14);

  await new Promise(resolve => {
    canvas.toBlob(blob => {
      _screenshotBlob = blob; _screenshotLabel = dateLabel;
      const url = URL.createObjectURL(blob);
      document.getElementById('screenshot-img').src = url;
      document.getElementById('screenshot-preview').style.display = 'flex';
      _showOtherToggle(hasOther, includeOther);    // 有「其他」才顯示勾選框
      resolve();
    }, 'image/png');
  });
}

// 預覽上的「包含『其他』紀錄」勾選框：僅日截圖且當天有「其他」時顯示；勾選/取消即重畫該張截圖。
function _showOtherToggle(hasOther, includeOther) {
  var wrap = document.getElementById('shot-other-wrap');
  var cb = document.getElementById('shot-other-cb');
  if (!wrap || !cb) return;
  if (!hasOther) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  cb.checked = !!includeOther;
  if (!cb._bound) {
    cb._bound = true;
    cb.addEventListener('change', function () { captureTripsScreenshot(_shotDayKey, cb.checked); });
  }
}

// 當月月結截圖（歷史「每月」標題的截圖鈕）：畫當月所有行程路線 + 總金額/總工時/出車天數/平均時薪，
// 右上角顯示「XXXX年X月」。統計走 MaptripFinance.revenueOfMonth（與收支報表同一份真相：排除「其他」、
// 含記帳者手動趟車資、工時內建排除手動）；路線只畫有 GPS 的載客趟（手動趟無座標）。
async function captureMonthScreenshot(ym, stats) {
  ym = String(ym || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) { toast('月份格式錯誤'); return; }
  const raw = loadTrips();
  const monthTrips = [];   // 只畫有 GPS 的載客路線（手動趟無座標；「其他」不畫）
  Object.keys(raw).forEach(d => {
    if (d.slice(0, 7) !== ym) return;
    (raw[d] || []).forEach(t => { if (t.paymentMethod !== 'other') monthTrips.push(t); });
  });

  // 統計優先用呼叫端（app.js captureMonthShot）算好的 stats：與歷史「每月」列表逐一相同
  // （同一份 merged 資料 + _fareStats + workMs + _workDaysCount）→ 月結數字＝列表數字。
  // 沒帶 stats 才退回 revenueOfMonth，再退回粗估（確保任何情況都出得了圖）。
  const rev = stats || (global.MaptripFinance && MaptripFinance.revenueOfMonth
    ? MaptripFinance.revenueOfMonth(ym)
    : { fare: monthTrips.reduce((s, t) => s + (t.fare || 0), 0), workMs: 0,
        trips: monthTrips.length, dist: monthTrips.reduce((s, t) => s + (t.totalDist || 0), 0) });
  const workDays = (rev.workDays != null) ? rev.workDays : _monthWorkDays(raw, ym);
  if (!(rev.trips || monthTrips.length)) { toast('當月無行程可截圖'); return; }
  const workH = rev.workMs / 3600000;
  const perHour = workH > 0.05 ? rev.fare / workH : 0;
  const monthLabel = ym.slice(0, 4) + '年' + parseInt(ym.slice(5, 7), 10) + '月';

  const W = 390, H = 520;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2; canvas.height = H * 2;
  const c = canvas.getContext('2d');
  c.scale(2, 2);

  c.fillStyle = '#141414'; _rrect(c, 0, 0, W, H, 24); c.fill();
  _drawBrand(c, 20, 26, 40);

  // 右上角：月份（大）＋「月報表」小字放在月份右手邊、同一行（整組右對齊到 W-20）；
  // 整排下移，讓字底與左邊 Logo 下緣（y=26+40=66）貼齊。
  c.save();
  c.textAlign = 'right'; c.textBaseline = 'alphabetic';
  c.font = '10px system-ui, sans-serif'; c.fillStyle = '#9aa0a6';
  c.fillText('月報表', W - 20, 60);                      // 最右：小字，略上移對齊月份視覺中線
  const _tagW = c.measureText('月報表').width;
  c.font = 'bold 18px system-ui, sans-serif'; c.fillStyle = '#e8eaed';
  c.fillText(monthLabel, W - 20 - _tagW - 6, 64);        // 月份大字接在小字左邊（留 6px 間距）；字底≈66＝Logo 下緣
  c.restore();

  // 路線區
  const rX = 16, rY = 88, rW = W - 32, rH = 286;
  const allPts = [];
  monthTrips.forEach(t => (t.roadCoords || t.coords || []).forEach(p => allPts.push([p.lat, p.lng])));

  if (allPts.length > 1) {
    let z = 9, sc, viewX0, viewY0;   // 預設 z=9 後備（極分散時）
    for (let zz = 16; zz >= 9; zz--) {
      const wxs = [], wys = [];
      for (let pi = 0; pi < allPts.length; pi++) { const wp = _latlngToWorldPx(allPts[pi][0], allPts[pi][1], zz); wxs.push(wp.x); wys.push(wp.y); }
      const bx = _bounds(wxs), by = _bounds(wys);
      const sX = (bx[1] - bx[0]) || 1, sY0 = (by[1] - by[0]) || 1;
      const _sc = Math.min(rW / sX, rH / sY0) * 0.72;
      if (zz === 9 || (Math.ceil(rW / _sc / 256) + 1) * (Math.ceil(rH / _sc / 256) + 1) <= 16) {
        z = zz; sc = _sc;
        viewX0 = (bx[0] + bx[1]) / 2 - rW / (2 * sc);
        viewY0 = (by[0] + by[1]) / 2 - rH / (2 * sc);
        break;
      }
    }

    const TS = 256, maxT = Math.pow(2, z) - 1;
    const tx0 = Math.floor(viewX0 / TS), ty0 = Math.floor(viewY0 / TS);
    const tx1 = Math.ceil((viewX0 + rW / sc) / TS), ty1 = Math.ceil((viewY0 + rH / sc) / TS);
    const subs = ['a', 'b', 'c', 'd'], jobs = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      if (tx < 0 || ty < 0 || tx > maxT || ty > maxT) continue;
      jobs.push(_loadTile(`https://${subs[(tx + ty) % 4]}.basemaps.cartocdn.com/dark_all/${z}/${tx}/${ty}.png`).then(img => ({ img, tx, ty })));
    }
    const tiles = await Promise.all(jobs);

    c.save();
    c.beginPath(); _rrect(c, rX, rY, rW, rH, 14); c.clip();
    c.fillStyle = '#1a2035'; c.fillRect(rX, rY, rW, rH);
    tiles.forEach(({ img, tx, ty }) => { if (!img) return; c.drawImage(img, rX + (tx * TS - viewX0) * sc, rY + (ty * TS - viewY0) * sc, TS * sc, TS * sc); });

    // 當月所有路線：單色半透明疊加（重疊處自然變密＝跑車熱度感），趟數多故不編號
    const wp2c = (la, ln) => { const w = _latlngToWorldPx(la, ln, z); return [rX + (w.x - viewX0) * sc, rY + (w.y - viewY0) * sc]; };
    c.globalAlpha = 0.55; c.strokeStyle = '#4fc3f7'; c.lineWidth = 1.6; c.lineCap = 'round'; c.lineJoin = 'round';
    monthTrips.forEach(t => {
      const pts = (t.roadCoords || t.coords || []);
      if (pts.length < 2) return;
      c.beginPath();
      const p0 = wp2c(pts[0].lat, pts[0].lng); c.moveTo(p0[0], p0[1]);
      for (let i = 1; i < pts.length; i++) { const pc = wp2c(pts[i].lat, pts[i].lng); c.lineTo(pc[0], pc[1]); }
      c.stroke();
    });
    c.globalAlpha = 1;
    c.restore();
  } else {
    c.fillStyle = '#1a2035'; _rrect(c, rX, rY, rW, rH, 14); c.fill();
    c.fillStyle = '#5f6368'; c.font = '13px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText('本月無 GPS 路線', rX + rW / 2, rY + rH / 2);
  }

  // 統計區（字級一律對齊每日截圖：數值 bold 17px、標籤 11px、footer 10px）
  const sY = rY + rH + 20;
  c.strokeStyle = '#2a2a2a'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(24, sY - 6); c.lineTo(W - 24, sY - 6); c.stroke();

  // Hero：當月總金額（值＝每日截圖同款 bold 17px，綠色作強調）
  c.textAlign = 'center';
  c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif';
  c.fillText('當月總金額', W / 2, sY + 6);
  c.fillStyle = '#34A853'; c.font = 'bold 17px system-ui, sans-serif';
  c.fillText('NT$ ' + Math.round(rev.fare).toLocaleString(), W / 2, sY + 27);

  // 三欄：總工時 / 出車天數 / 平均時薪
  const cols = [W * 0.2, W * 0.5, W * 0.8];
  const vals = [fmtWork(rev.workMs), workDays + ' 天', 'NT$ ' + Math.round(perHour).toLocaleString()];
  const lbls = ['總工時', '出車天數', '平均時薪'];
  cols.forEach((x, i) => {
    c.fillStyle = '#ffffff'; c.font = 'bold 17px system-ui, sans-serif'; c.fillText(vals[i], x, sY + 60);
    c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif'; c.fillText(lbls[i], x, sY + 76);
  });

  // 趟數 · 里程
  c.fillStyle = '#9aa0a6'; c.font = '11px system-ui, sans-serif';
  c.fillText((rev.trips || monthTrips.length) + ' 趟　·　' + fmtDist(rev.dist || 0), W / 2, sY + 98);

  c.fillStyle = '#3c4043'; c.font = '10px system-ui, sans-serif';
  c.fillText('Maptrip · 月報表', W / 2, H - 14);

  await new Promise(resolve => {
    canvas.toBlob(blob => {
      _screenshotBlob = blob; _screenshotLabel = ym;
      const url = URL.createObjectURL(blob);
      document.getElementById('screenshot-img').src = url;
      document.getElementById('screenshot-preview').style.display = 'flex';
      _showOtherToggle(false);   // 月截圖不適用「其他」勾選框
      resolve();
    }, 'image/png');
  });
}

// 當月「出車天數」：整天只有「其他」（自用/非載客）的日子不算；併入記帳者手動趟（與月標題一致）。純函式供測試。
function _monthWorkDays(raw, ym) {
  ym = String(ym || '').slice(0, 7);
  const merged = (global.MaptripManual && MaptripManual.mergeInto) ? MaptripManual.mergeInto(raw) : (raw || {});
  let n = 0;
  Object.keys(merged).forEach(d => {
    if (d.slice(0, 7) !== ym) return;
    if ((merged[d] || []).some(t => t.paymentMethod !== 'other')) n++;
  });
  return n;
}

// 陣列 min/max（避免 Math.max(...大陣列) 在整月上千點時爆 call stack）
function _bounds(nums) { let mn = Infinity, mx = -Infinity; for (let i = 0; i < nums.length; i++) { const v = nums[i]; if (v < mn) mn = v; if (v > mx) mx = v; } return [mn, mx]; }

// 單趟截圖
async function captureSingleTripScreenshot(trip) {
  if (!trip) return;
  const d = new Date(trip.startTime);
  const weekDays = ['週日','週一','週二','週三','週四','週五','週六'];
  const dateLabel = `${d.getMonth()+1}月${d.getDate()}日${weekDays[d.getDay()]}`;
  const fileLabel = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;

  const W = 390, H = 485;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2; canvas.height = H * 2;
  const c = canvas.getContext('2d');
  c.scale(2, 2);

  c.fillStyle = '#141414';
  _rrect(c, 0, 0, W, H, 24); c.fill();

  // 左：去背 LOGO
  _drawBrand(c, 20, 28, 42);
  // 右上：一般行程 → 日期（上）+ 行程時間（下）；
  //       「其他」行程（有備注）→ 日期（上）/ 開始-結束時間（中）/ 備注（下）
  const _note = (trip.label || '').trim();
  if (trip.paymentMethod === 'other' && _note) {
    _drawRightThreeLines(c, W - 20, [
      { t: dateLabel, f: '13px system-ui, sans-serif', c: '#e8eaed', y: 38 },
      { t: `${fmtTime(trip.startTime)}-${fmtTime(trip.endTime)}`, f: '12px system-ui, sans-serif', c: '#c8ccd2', y: 56 },
      { t: _note, f: '12px system-ui, sans-serif', c: '#9aa0a6', y: 74 }
    ]);
  } else {
    _drawRightTwoLines(c, W - 20,
      _fullDateLabel(trip.startTime), '13px system-ui, sans-serif', '#e8eaed', 46,
      fmtWork(trip.endTime - trip.startTime), '12px system-ui, sans-serif', '#9aa0a6', 66);
  }

  const rX = 16, rY = 88, rW = W - 32, rH = 310;
  const pts = (trip.roadCoords || trip.coords || []).map(p => [p.lat, p.lng]);

  if (pts.length > 1) {
    let z = 12, sc, viewX0, viewY0;
    for (let zz = 16; zz >= 9; zz--) {
      const wps = pts.map(([la, ln]) => _latlngToWorldPx(la, ln, zz));
      const wxs = wps.map(p => p.x), wys = wps.map(p => p.y);
      const sX = (Math.max(...wxs) - Math.min(...wxs)) || 1;
      const sY2 = (Math.max(...wys) - Math.min(...wys)) || 1;
      const _sc = Math.min(rW / sX, rH / sY2) * 0.7;
      if ((Math.ceil(rW / _sc / 256) + 1) * (Math.ceil(rH / _sc / 256) + 1) <= 16) {
        z = zz; sc = _sc;
        const wcX = (Math.min(...wxs) + Math.max(...wxs)) / 2;
        const wcY = (Math.min(...wys) + Math.max(...wys)) / 2;
        viewX0 = wcX - rW / (2 * sc);
        viewY0 = wcY - rH / (2 * sc);
        break;
      }
    }
    const TS = 256, maxT = Math.pow(2, z) - 1;
    const tx0 = Math.floor(viewX0 / TS), ty0 = Math.floor(viewY0 / TS);
    const tx1 = Math.ceil((viewX0 + rW / sc) / TS), ty1 = Math.ceil((viewY0 + rH / sc) / TS);
    const subs = ['a','b','c','d'], jobs = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      if (tx < 0 || ty < 0 || tx > maxT || ty > maxT) continue;
      jobs.push(_loadTile(`https://${subs[(tx+ty)%4]}.basemaps.cartocdn.com/dark_all/${z}/${tx}/${ty}.png`).then(img => ({ img, tx, ty })));
    }
    const tiles = await Promise.all(jobs);

    c.save();
    c.beginPath(); _rrect(c, rX, rY, rW, rH, 14); c.clip();
    c.fillStyle = '#1a2035'; c.fillRect(rX, rY, rW, rH);
    tiles.forEach(({ img, tx, ty }) => {
      if (!img) return;
      c.drawImage(img, rX + (tx * TS - viewX0) * sc, rY + (ty * TS - viewY0) * sc, TS * sc, TS * sc);
    });

    const wp2c = (la, ln) => { const wp = _latlngToWorldPx(la, ln, z); return [rX + (wp.x - viewX0) * sc, rY + (wp.y - viewY0) * sc]; };
    c.beginPath();
    const [sx0, sy0] = wp2c(pts[0][0], pts[0][1]);
    c.moveTo(sx0, sy0);
    pts.slice(1).forEach(p => { const [px, py] = wp2c(p[0], p[1]); c.lineTo(px, py); });
    c.strokeStyle = '#4fc3f7'; c.lineWidth = 2.5; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke();
    c.beginPath(); c.arc(sx0, sy0, 5, 0, Math.PI * 2);
    c.fillStyle = '#4fc3f7'; c.fill();
    c.restore();
  } else {
    c.fillStyle = '#1a2035'; _rrect(c, rX, rY, rW, rH, 14); c.fill();
  }

  // 統計：行程時間 + 里程 + 車資(選填)；時間已移到右上角
  const hasFare = !!trip.fare;
  const sY = rY + rH + 18;
  c.strokeStyle = '#2a2a2a'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(24, sY - 4); c.lineTo(W - 24, sY - 4); c.stroke();

  const cols = hasFare ? [W*0.25, W*0.5, W*0.75] : [W*0.33, W*0.67];
  c.textAlign = 'center';

  // 行程時間
  c.fillStyle = '#ffffff'; c.font = 'bold 17px system-ui, sans-serif';
  c.fillText(fmtDur(trip.endTime - trip.startTime), cols[0], sY + 20);
  c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif';
  c.fillText('行程', cols[0], sY + 35);

  // 里程
  c.fillStyle = '#ffffff'; c.font = 'bold 17px system-ui, sans-serif';
  c.fillText(fmtDist(trip.totalDist), cols[1], sY + 20);
  c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif';
  c.fillText('里程', cols[1], sY + 35);

  // 車資（選填）
  if (hasFare) {
    c.fillStyle = '#ffffff'; c.font = 'bold 17px system-ui, sans-serif';
    c.fillText('NT$ ' + trip.fare, cols[2], sY + 20);
    c.fillStyle = '#5f6368'; c.font = '11px system-ui, sans-serif';
    c.fillText('車資', cols[2], sY + 35);
  }

  c.fillStyle = '#3c4043'; c.font = '10px system-ui, sans-serif'; c.textAlign = 'center';
  c.fillText('Maptrip · 行程紀錄', W / 2, H - 14);

  await new Promise(resolve => {
    canvas.toBlob(blob => {
      _screenshotBlob = blob; _screenshotLabel = fileLabel;
      const url = URL.createObjectURL(blob);
      document.getElementById('screenshot-img').src = url;
      document.getElementById('screenshot-preview').style.display = 'flex';
      _showOtherToggle(false);    // 單趟截圖不適用「其他」勾選框
      resolve();
    }, 'image/png');
  });
}

function captureTodayTripShot(e, i) {
  e.stopPropagation();
  captureSingleTripScreenshot(ctx.todayTrips()[i]);
}

function captureHistoryTripShot(e, dayKey, i) {
  e.stopPropagation();
  const raw = loadTrips();
  const trip = (raw[dayKey] || [])[i];
  if (trip) captureSingleTripScreenshot(trip);
}

let _screenshotBlob = null, _screenshotLabel = '';

function _shareImageFile(withTitle) {
  if (!_screenshotBlob) return;
  const file = new File([_screenshotBlob], `maptrip-${_screenshotLabel}.png`, { type: 'image/png' });
  const opts = withTitle ? { files: [file], title: `Maptrip ${_screenshotLabel}` } : { files: [file] };
  if (navigator.share) {
    navigator.share(opts).catch(() => _fallbackDownload());
  } else {
    _fallbackDownload();
  }
}

function _fallbackDownload() {
  if (!_screenshotBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(_screenshotBlob);
  a.download = `maptrip-${_screenshotLabel}.png`;
  a.click();
}

function shareScreenshot() { _shareImageFile(true); }

function saveImageToPhotos() {
  if (!_screenshotBlob) return;
  // 優先走原生 PHPhotoLibrary（iOS Capacitor）
  const plugin = window.Capacitor?.Plugins?.LiveActivity;
  if (plugin?.savePhotoBase64) {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.replace(/^data:[^;]+;base64,/, '');
      plugin.savePhotoBase64({ base64 })
        .then(() => toast('已儲存到相片庫'))
        .catch(() => _shareImageFile(false));
    };
    reader.readAsDataURL(_screenshotBlob);
  } else {
    _shareImageFile(false);
  }
}

function closeScreenshotPreview() {
  document.getElementById('screenshot-preview').style.display = 'none';
}

function _rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// 在截圖上畫去背的雙 X LOGO（半透明藍 X 偏右上 + 實心粉紅 X 偏左下）
// x,y=左上角；s=尺寸。座標取自原始 logo SVG，等比縮放置中。
function _drawLogoX(c, x, y, s) {
  // SVG icon 兩個 X 的整體邊界框：x 123..389 (266)、y 136..376 (240)
  const sc = s / 280, ox = x + (s - 266 * sc) / 2 - 123 * sc, oy = y + (s - 240 * sc) / 2 - 136 * sc;
  const P = (ix, iy) => [ox + ix * sc, oy + iy * sc];
  c.save();
  c.lineCap = 'round';
  c.lineWidth = 46 * sc;
  const line = (p1, p2) => { const a = P(...p1), b = P(...p2); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); };
  // 半透明藍 X（偏右上）
  let g = c.createLinearGradient(...P(216, 159), ...P(366, 309));
  g.addColorStop(0, '#7CD8FF'); g.addColorStop(1, '#46B0FF');
  c.strokeStyle = g; c.globalAlpha = 0.5;
  line([216, 159], [366, 309]); line([366, 159], [216, 309]);
  // 實心粉紅 X（偏左下）
  g = c.createLinearGradient(...P(146, 203), ...P(296, 353));
  g.addColorStop(0, '#FF7AC6'); g.addColorStop(1, '#FF5E62');
  c.strokeStyle = g; c.globalAlpha = 1.0;
  line([146, 203], [296, 353]); line([296, 203], [146, 353]);
  c.restore();
}

// 截圖左上角品牌組合：雙 X LOGO + 「Maptrip」
function _drawBrand(c, x, y, s) {
  _drawLogoX(c, x, y, s);
  c.save();
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillStyle = '#FF5E8A';
  c.font = 'bold 19px system-ui, sans-serif';
  c.fillText('Maptrip', x + s + 8, y + s * 0.52);
  c.restore();
}

// 右上角兩行（日期 + 時間）互相置中，整體靠右邊界 rightX 對齊
function _drawRightTwoLines(c, rightX, l1, f1, c1, y1, l2, f2, c2, y2) {
  c.save();
  c.textAlign = 'center';
  c.font = f1; const w1 = c.measureText(l1).width;
  c.font = f2; const w2 = c.measureText(l2).width;
  const cx = rightX - Math.max(w1, w2) / 2;
  c.fillStyle = c1; c.font = f1; c.fillText(l1, cx, y1);
  c.fillStyle = c2; c.font = f2; c.fillText(l2, cx, y2);
  c.restore();
}

// 右上角三行（共用相同水平中心，右對齊）
function _drawRightThreeLines(c, rightX, rows) {
  c.save();
  c.textAlign = 'center';
  let maxW = 0;
  rows.forEach(r => { c.font = r.f; maxW = Math.max(maxW, c.measureText(r.t).width); });
  const cx = rightX - maxW / 2;
  rows.forEach(r => { c.fillStyle = r.c; c.font = r.f; c.fillText(r.t, cx, r.y); });
  c.restore();
}

// 截圖用完整日期：2026年6月24日 星期三
function _fullDateLabel(ts) {
  const d = new Date(ts);
  const wd = '日一二三四五六'[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${wd}`;
}

  global.MaptripShot = {
    init: init,
    captureTripsScreenshot: captureTripsScreenshot,
    captureMonthScreenshot: captureMonthScreenshot,
    captureSingleTripScreenshot: captureSingleTripScreenshot,
    _monthWorkDays: _monthWorkDays,
    captureTodayTripShot: captureTodayTripShot,
    captureHistoryTripShot: captureHistoryTripShot,
    shareScreenshot: shareScreenshot,
    saveImageToPhotos: saveImageToPhotos,
    closeScreenshotPreview: closeScreenshotPreview,
    _latlngToWorldPx: _latlngToWorldPx
  };

})(typeof window !== 'undefined' ? window : globalThis);
