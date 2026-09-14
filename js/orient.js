/* =============================================================
 * orient.js — 地圖朝向 / 羅盤 / 方向光束（朝車頭旋轉）
 * -------------------------------------------------------------
 * 從 app.js v1.1.259 逐字抽出（body 與原版相同，僅把共用活狀態改為經 init 注入）。
 * 內容：指北針針頭、我的位置方向光束、平滑旋轉動畫（rAF 緩動）、羅盤事件、
 * 記錄中依 GPS/羅盤讓地圖朝車頭。
 *
 * 依賴注入（init）：map 與共用活狀態（myHeading/headingUp/lastHeading 由 app.js 與
 * onGpsUpdate/scheduleFollowResume/boot 共用 → getter/setter；autoFollow/_mapTouching/
 * soloSet/dayPreviewKey 為 app.js 擁有 → getter）。模組私有：動畫角度/RAF handle、
 * headingRefPos/deviceCompassOn/lastMoveSpeed（只有本模組用到）。
 * 呼叫的全域函式（toast/isReplaying/inBrowsingMode）執行期由 window 取用。
 * 掛 window.MaptripOrient；app.js 留同名薄包裝轉呼叫，呼叫端零改動。
 * 對外另開 cancelBearingAnim()：地圖手勢開始（app.js trackTouch）時停掉旋轉動畫。
 * ============================================================= */
(function (global) {
  'use strict';

  var ctx = {};
  function M() { return ctx.getMap(); }

  // 模組私有狀態
  var _needleAnim = 0;
  var _beamAnim = null;
  var _targetBearing = 0, _animBearing = 0, _bearingRAF = null;
  var _lastOrientT = 0;
  var headingRefPos = null;       // 上一個「有前進」的位置，估算行進方向用
  var deviceCompassOn = false;    // 手機羅盤是否已啟用
  var lastMoveSpeed = 0;          // 上一筆有效速度（判斷停/行駛）

  function bearingBetween(a, b) {
    const toR = d => d * Math.PI / 180, toD = r => r * 180 / Math.PI;
    const dLon = toR(b.lng - a.lng);
    const y = Math.sin(dLon) * Math.cos(toR(b.lat));
    const x = Math.cos(toR(a.lat)) * Math.sin(toR(b.lat)) -
              Math.sin(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.cos(dLon);
    return (toD(Math.atan2(y, x)) + 360) % 360;
  }

  // 角度累積器：讓 CSS transition 永遠走最短路徑，
  // 跨 0°/360° 時不會反向繞一整圈（例：350°→10° 只轉 +20°，不轉 -340°）
  function _accumAngle(prev, targetDeg) {
    const diff = ((targetDeg - prev) % 360 + 540) % 360 - 180;
    return prev + diff;
  }

  // 指北針針頭旋轉，永遠指向真北（= 地圖 bearing 的反向）
  function updateCompassNeedle() {
    const n = document.getElementById('compass-needle');
    if (!n || !M().getBearing) return;
    _needleAnim = _accumAngle(_needleAnim, -M().getBearing());
    n.style.transform = `rotate(${_needleAnim}deg)`;
  }

  // 我的位置方向光束：指向 myHeading（考慮地圖旋轉，畫面上永遠指對方向）
  function updateMyHeadingArrow() {
    const mk = ctx.getMyDotMarker();
    if (!mk || !mk.getElement) return;
    const el = mk.getElement();
    if (!el) return;
    const rot = el.querySelector('.myloc-rot');
    if (!rot) return;
    if (ctx.getMyHeading() == null) return;   // 尚無方向資料，維持現狀（一旦顯示就不再隱藏）
    const mapB = (M().getBearing && M().getBearing()) || 0;
    const target = ctx.getMyHeading() + mapB;
    rot.style.display = '';
    if (_beamAnim == null) {
      // 第一次顯示：直接定位、不做動畫（避免從 0 度掃一圈過去）
      rot.style.transition = 'none';
      _beamAnim = target;
      rot.style.transform = `rotate(${_beamAnim}deg)`;
      void rot.offsetWidth;
      rot.style.transition = '';
      return;
    }
    _beamAnim = _accumAngle(_beamAnim, target);
    rot.style.transform = `rotate(${_beamAnim}deg)`;
  }

  // 平滑旋轉：以 rAF 緩動到目標角度（走最短角度差），避免硬切造成卡頓
  function setTargetBearing(deg) {
    if (!M().setBearing) return;
    _targetBearing = ((deg % 360) + 360) % 360;
    if (_bearingRAF == null) _bearingRAF = requestAnimationFrame(_stepBearing);
  }
  function _stepBearing() {
    let diff = ((_targetBearing - _animBearing + 540) % 360) - 180;   // -180..180 最短路徑
    if (Math.abs(diff) < 0.4) {
      _animBearing = _targetBearing;
      M().setBearing(_animBearing);
      _bearingRAF = null;
      return;
    }
    _animBearing = (_animBearing + diff * 0.2 + 360) % 360;            // 每幀補 20%
    M().setBearing(_animBearing);
    _bearingRAF = requestAnimationFrame(_stepBearing);
  }
  // 立即歸位指北（切換到預覽/單趟時用，不做動畫）
  function resetBearingNow() {
    if (!M().setBearing) return;
    if (_bearingRAF != null) { cancelAnimationFrame(_bearingRAF); _bearingRAF = null; }
    _targetBearing = _animBearing = 0;
    M().setBearing(0);
  }

  // 地圖手勢開始時停掉旋轉動畫、把角度對齊目前地圖 bearing（app.js trackTouch 呼叫）
  function cancelBearingAnim() {
    if (_bearingRAF != null) {
      cancelAnimationFrame(_bearingRAF); _bearingRAF = null;
      _animBearing = _targetBearing = ((M().getBearing() % 360) + 360) % 360;
    }
  }

  // 手動雙指旋轉時，同步平滑旋轉器的內部角度（動畫中則不干預）（app.js map 'rotate' 呼叫）
  function syncBearingFromMap() {
    if (_bearingRAF == null) {
      _animBearing = _targetBearing = ((M().getBearing() % 360) + 360) % 360;
    }
  }

  // 按指北針：在「朝車頭」與「鎖定指北」間切換
  function toggleCompass() {
    if (!M().setBearing) return;
    const hu = !ctx.getHeadingUp();
    ctx.setHeadingUp(hu);
    try { localStorage.setItem('maptrip_headup', hu ? '1' : '0'); } catch (_) {}
    const btn = document.getElementById('compass-btn');
    if (hu) {
      btn.classList.add('heading-on');
      enableDeviceCompass();                            // 啟用手機羅盤（停著也能轉）
      if (ctx.getLastHeading()) setTargetBearing(-ctx.getLastHeading());
      toast('地圖朝行進方向');
    } else {
      btn.classList.remove('heading-on');
      setTargetBearing(0);                              // 平滑轉回指北
      toast('地圖已鎖定指北');
    }
  }

  // 啟用手機羅盤：iOS 需經使用者手勢請求權限（指北針點擊即手勢）。
  // silent=true 用於開機自動嘗試：先前授權過就直接生效（不會跳視窗），
  // 尚未授權則安靜略過，等使用者按指北針/定位鈕時再正式請求。
  function enableDeviceCompass(silent) {
    if (deviceCompassOn) return;
    const start = () => {
      window.addEventListener('deviceorientationabsolute', onDeviceOrient, true);
      window.addEventListener('deviceorientation', onDeviceOrient, true);
      deviceCompassOn = true;
    };
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
          .then(res => {
            if (res === 'granted') start();
            else if (!silent) toast('未授權羅盤，移動時仍會依 GPS 轉向');
          })
          .catch(() => {});
      } else { start(); }
    } catch (_) {}
  }

  // 羅盤回呼：停著或低速時用手機朝向轉地圖；高速行駛時交給 GPS 方向。
  // 節流＋死區（關鍵）：iOS 羅盤每秒回報 ~60 次且靜止時恆抖 ±1-2°，
  // 若全量餵進旋轉動畫，目標角永遠在變、動畫迴圈永不停 → 地圖 60fps 無限重繪
  // → GPU/CPU 滿載、手機發燙、記憶體+熱壓力 → WKWebView 行程每隔幾秒被 iOS 砍掉。
  // 節流到最多 ~7 次/秒；並與「目前已套用的方向」比較，差 <2.5° 一律不動
  // （比「與上一筆比」強：抖動繞著錨點慢慢晃也擋得住）。靜止零重繪，真轉向瞬間通過。
  function onDeviceOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading;                  // iOS：0=北、順時針
    } else if (e.alpha != null && (e.absolute || e.absolute === undefined)) {
      h = (360 - e.alpha) % 360;                   // Android
    }
    if (h == null || isNaN(h)) return;
    const _now = Date.now();
    if (_now - _lastOrientT < 150) return;
    _lastOrientT = _now;
    const mh = ctx.getMyHeading();
    if (mh != null &&
        Math.abs(((h - mh + 540) % 360) - 180) < 2.5) return;
    // 只要在移動就優先用 GPS 行進方向（不限記錄中）：
    // 手機架在車上時羅盤指的是「手機面向」而非行進方向，行進中會與實際方向不符
    const driving = lastMoveSpeed > 1.2;
    if (!driving) {
      ctx.setMyHeading(h);                          // 停/慢速：羅盤朝向 = 我的朝向
      updateMyHeadingArrow();
      ctx.setLastHeading(h);
      if (ctx.getHeadingUp() && M().setBearing && ctx.getAutoFollow() && !ctx.getMapTouching() && !inBrowsingMode()) setTargetBearing(-h);   // 拖動/手勢/歷史檢視中不搶地圖
    }
  }

  // 記錄中每筆 GPS：若開啟朝車頭，讓地圖旋轉到行進方向。
  // 使用者拖動地圖（autoFollow 關閉）時暫停自動旋轉，地圖可自由移動；
  // 按「我的位置」恢復跟隨後旋轉才繼續（同 Google 地圖行為）。
  function applyHeadingUp(lat, lng, effectiveSpeed, gpsHeading) {
    lastMoveSpeed = effectiveSpeed || 0;
    if (!ctx.getHeadingUp() || !M().setBearing) return;
    if (ctx.getSoloSet().length || ctx.getDayPreviewKey() || isReplaying()) return;   // 預覽/單趟/回放模式不旋轉
    let heading = gpsHeading;
    if (heading == null || isNaN(heading) || heading < 0) {
      if (headingRefPos && effectiveSpeed > 1) heading = bearingBetween(headingRefPos, { lat, lng });
      else heading = ctx.getLastHeading();
    }
    if (effectiveSpeed > 1) { ctx.setLastHeading(heading); headingRefPos = { lat, lng }; }
    if (!ctx.getAutoFollow() || ctx.getMapTouching()) return;        // 使用者正在自由瀏覽/操作手勢 → 不搶地圖
    if (effectiveSpeed > 0.8) {
      // 死區：直線行駛時 GPS 方向每秒恆抖 ±2~5°，全量餵進旋轉動畫會讓記錄中的地圖
      // 近乎連續重繪（發燙/卡頓主因之一）。與目前地圖方向差 <3° 不轉；
      // 真正轉彎遠超過 3°，瞬間通過、跟隨體感不變。
      const tgt = (((-ctx.getLastHeading()) % 360) + 360) % 360;
      const diff = Math.abs(((tgt - _targetBearing + 540) % 360) - 180);
      if (diff >= 3) setTargetBearing(-ctx.getLastHeading());
    }
  }

  function init(context) { ctx = context || {}; }

  global.MaptripOrient = {
    init: init,
    bearingBetween: bearingBetween,
    updateCompassNeedle: updateCompassNeedle,
    updateMyHeadingArrow: updateMyHeadingArrow,
    setTargetBearing: setTargetBearing,
    resetBearingNow: resetBearingNow,
    cancelBearingAnim: cancelBearingAnim,
    syncBearingFromMap: syncBearingFromMap,
    toggleCompass: toggleCompass,
    enableDeviceCompass: enableDeviceCompass,
    applyHeadingUp: applyHeadingUp
  };

})(typeof window !== 'undefined' ? window : globalThis);
