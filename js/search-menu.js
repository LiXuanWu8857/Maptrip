// search-menu.js — 右下角「🔍 搜尋」FAB 的彈出選單（speed-dial）：
// 點 FAB 展開選項（找客熱區／加油站／停車場／便利商店／醫院／搜尋地址），點外面或選一項即收起。
//   找客熱區 → window.openHotspots()
//   加油站/停車場/便利商店/醫院 → MaptripNearby.run(kind)
//   搜尋地址 → MaptripAddr.open()
(function () {
  'use strict';

  var ITEMS = [
    { k: 'hotspot',  icon: '🔥', label: '找客熱區' },
    { k: 'fuel',     icon: '⛽', label: '加油站' },
    { k: 'parking',  icon: '🅿️', label: '停車場' },
    { k: 'store',    icon: '🏪', label: '便利商店' },
    { k: 'hospital', icon: '🏥', label: '醫院' },
    { k: 'address',  icon: '📍', label: '搜尋地址' }
  ];

  // 選單從「我的位置」FAB（bottom:64）那格起，最下面那顆（找客熱區）從該處長出、往上疊。
  var CSS =
    // z-index 提到底部列(20)之上：否則最下面那顆 pill 會被底部列蓋住、按不到／按到底部列。
    '#mt-sm-bd{position:fixed;inset:0;z-index:21;background:transparent;display:none;-webkit-tap-highlight-color:transparent;}' +
    '#mt-sm-bd.on{display:block;}' +
    // 容器寬＝最寬那顆 pill（width:max-content），子項 align-items:stretch → 全部撐到同寬。
    // bottom:64 讓最下面那顆貼齊底部列上緣（與底部列同一基準、不加 safe-area）；
    // z-index:22 提到底部列(20)之上 → 就算貼著底部列也永遠在上、按得到（修好觸控後可放回底部）。
    '#mt-sm{position:fixed;right:14px;bottom:64px;z-index:22;' +
      'display:flex;flex-direction:column-reverse;gap:10px;align-items:stretch;width:max-content;pointer-events:none;}' +
    // 收起狀態＝縮回底部（我的位置那）：變形原點在更下方、往下位移多一點＋縮很小、透明。展開時歸零。
    // 所有 pill 等寬（以文字最寬者為基準）、內容置中
    // pointer-events 只在展開(.on)時開啟：收合中 pill 不吃觸控 → 手指還按著時，
    // 下面那顆不會在收合位移中滑到手指下被標成 :active（修「按停車場卻加油站變深色」）。
    '#mt-sm .pill{pointer-events:none;display:flex;align-items:center;justify-content:center;gap:8px;' +
      'height:42px;padding:0 18px;box-sizing:border-box;' +
      // iOS 原生點擊高亮（-webkit-tap-highlight-color）在「變形/動畫中的堆疊按鈕」上會把那塊深色
      // 畫到相鄰的下一顆（＝按停車場卻加油站變深色）。關掉它，只留自訂的 .picked 藍色高亮。
      '-webkit-tap-highlight-color:transparent;' +
      'border:none;border-radius:21px;background:#fff;color:#1a1a1a;font:inherit;font-size:14px;font-weight:600;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.22),0 0 0 .5px rgba(0,0,0,.06);cursor:pointer;' +
      // 變形原點鎖在右下角＝右緣固定不動（消除彈出時右邊超出／回縮的橫向錯位），往上長出。
      'transform-origin:100% 100%;opacity:0;transform:translateY(24px) scale(.4);' +
      // 收合（基底）：平順的減速曲線、透明與位移同步（.26s），收起來順不突兀。
      'transition:opacity .26s cubic-bezier(.4,0,.2,1),transform .26s cubic-bezier(.4,0,.2,1);}' +
    // 展開（.on）：帶一點回彈的長出感（transform 較長＋overshoot 曲線）；此時才可點。
    '#mt-sm.on .pill{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;' +
      'transition:opacity .2s ease,transform .34s cubic-bezier(.2,.9,.25,1.06);}' +
    // 搜尋選單開啟時淡出右側三顆 FAB：我的位置📍／指北針🧭／搜尋🔍本身（選單像從我的位置長出、畫面乾淨）
    '#locate-btn,#compass-btn,#hotspot-btn{transition:opacity .18s ease,transform .18s ease;}' +
    'body.mt-search-open #locate-btn,body.mt-search-open #compass-btn,body.mt-search-open #hotspot-btn' +
      '{opacity:0;transform:scale(.5);pointer-events:none;}' +
    // 展開（.on）：由下（最靠近 FAB）往上依序長出 nth-child 1→5 延遲遞增。
    '#mt-sm.on .pill:nth-child(1){transition-delay:0s;}' +
    '#mt-sm.on .pill:nth-child(2){transition-delay:.045s;}' +
    '#mt-sm.on .pill:nth-child(3){transition-delay:.09s;}' +
    '#mt-sm.on .pill:nth-child(4){transition-delay:.135s;}' +
    '#mt-sm.on .pill:nth-child(5){transition-delay:.18s;}' +
    '#mt-sm.on .pill:nth-child(6){transition-delay:.225s;}' +
    // 收起（移除 .on → 套用這組基底延遲，被上面 .on 那組覆蓋）：反過來，
    // 最上面那顆先縮、最下面（最靠 FAB）最後縮＝跟長出動畫完全相反、像倒帶收回 FAB。
    '#mt-sm .pill:nth-child(1){transition-delay:.225s;}' +
    '#mt-sm .pill:nth-child(2){transition-delay:.18s;}' +
    '#mt-sm .pill:nth-child(3){transition-delay:.135s;}' +
    '#mt-sm .pill:nth-child(4){transition-delay:.09s;}' +
    '#mt-sm .pill:nth-child(5){transition-delay:.045s;}' +
    '#mt-sm .pill:nth-child(6){transition-delay:0s;}' +
    '#mt-sm .pill .i{font-size:18px;line-height:1;}' +
    // 不用 :active（觸控按下態）：動畫期間 :active 會落在「手指按下當下」的那顆，可能與最後
    // click 到的那顆不同（iOS 座標/時序差）→ 高亮跑到相鄰按鈕。改成只用 .picked（由 click
    // handler 標在「真正被點到」的那顆，永遠正確）。
    // 被按的那顆：藍色高亮，且收合時「原地淡出」（不套用往下位移的收合變形、無延遲）
    '#mt-sm .pill.picked{background:#e8f0fe;color:#1a73e8;box-shadow:0 2px 12px rgba(26,115,232,.4);}' +
    '#mt-sm:not(.on) .pill.picked{transform:translateY(0) scale(1);opacity:0;transition-delay:0s;}' +
    '@media (prefers-color-scheme: dark){#mt-sm .pill{background:#2d2d2d;color:#e8eaed;box-shadow:0 2px 10px rgba(0,0,0,.5);}' +
      '#mt-sm .pill.picked{background:#1e3a5f;color:#8ab4f8;}}';

  var _built = false, _open = false, _bd = null, _menu = null, _fabTimer = null;
  // 收合動畫總長：transform .26s ＋ 反向 stagger 最大延遲 .18s ≈ 0.44s，抓 0.46s 保險。
  var COLLAPSE_MS = 460;
  function build() {
    if (_built) return;
    _built = true;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    _bd = document.createElement('div'); _bd.id = 'mt-sm-bd';
    _menu = document.createElement('div'); _menu.id = 'mt-sm';
    ITEMS.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'pill'; b.setAttribute('data-k', it.k);
      b.innerHTML = '<span>' + it.label + '</span><span class="i">' + it.icon + '</span>';
      b.addEventListener('click', function () { pick(it.k, b); });
      b.addEventListener('touchstart', function (ev) { _diag(it.k, ev); }, { passive: true });
      _menu.appendChild(b);
    });
    _bd.addEventListener('click', close);
    document.body.appendChild(_bd); document.body.appendChild(_menu);
  }

  // 真機黑盒子診斷：比對「touchstart 路由到的那顆(target)」vs「手指座標實際覆蓋的那顆(under)」。
  // 兩者不同＝座標空間錯位（例如 WKWebView safe-area viewport 位移）＝高亮跑到相鄰按鈕的真凶。
  // 只在有 __mtLog（App 黑盒子）時記錄；純函式部分不受影響。
  function _diag(targetK, ev) {
    try {
      if (!window.__mtLog) return;
      var t = ev && ev.touches && ev.touches[0]; if (!t) return;
      var under = document.elementFromPoint(t.clientX, t.clientY);
      var up = under && under.closest ? under.closest('#mt-sm .pill') : null;
      var uk = up ? up.getAttribute('data-k') : (under ? (under.id || under.className || '?') : 'none');
      window.__mtLog('sm target=' + targetK + ' under=' + uk + ' y=' + Math.round(t.clientY) + (targetK !== uk ? ' MISMATCH' : ''));
    } catch (_) {}
  }

  function open() {
    build();
    if (_fabTimer) { clearTimeout(_fabTimer); _fabTimer = null; }   // 取消上次「收合後顯示 FAB」的排程
    // 清掉上次「被按」標記，重新一輪乾淨的展開
    Array.prototype.forEach.call(_menu.querySelectorAll('.pill.picked'), function (p) { p.classList.remove('picked'); });
    document.body.classList.add('mt-search-open');   // 淡出 我的位置/指北針/搜尋 FAB
    // 強制 reflow：確保 pill 先以「收合態」上版，再加 on 才會播放展開動畫（首次開也會動）
    void _menu.offsetWidth;
    _bd.classList.add('on'); _menu.classList.add('on'); _open = true;
  }
  function close() {
    if (!_built) return;
    _bd.classList.remove('on'); _menu.classList.remove('on'); _open = false;
    // 右下角三顆 FAB「等 pill 完全收回後」才淡回（不要收合中就冒出來搶畫面）。
    if (_fabTimer) clearTimeout(_fabTimer);
    _fabTimer = setTimeout(function () {
      document.body.classList.remove('mt-search-open');
      _fabTimer = null;
    }, COLLAPSE_MS);
  }
  function toggle() {
    // 有搜尋結果時，右下角這顆已變成 ✕（清除鈕）→ 點它＝清除結果、還原放大鏡，不開選單。
    if (!_open && window.MaptripNearby && MaptripNearby.hasResults && MaptripNearby.hasResults()) {
      MaptripNearby.close();
      return;
    }
    _open ? close() : open();
  }

  function pick(kind, btn) {
    // 標記「被按的那顆」：收合時它原地淡出（不隨其他顆往下位移），使用者一眼看到自己按的是哪個，
    // 不會被收合動畫的下移錯覺誤導成「按到下面那顆」。
    if (btn && _menu) {
      Array.prototype.forEach.call(_menu.querySelectorAll('.pill.picked'), function (p) { p.classList.remove('picked'); });
      btn.classList.add('picked');
    }
    close();
    if (kind === 'hotspot') { if (window.openHotspots) window.openHotspots(); }
    else if (kind === 'address') { if (window.MaptripAddr) window.MaptripAddr.open(); }
    else if (window.MaptripNearby) window.MaptripNearby.run(kind);
  }

  window.MaptripSearchMenu = { toggle: toggle, open: open, close: close, _pick: pick, _items: ITEMS, _diag: _diag };
})();
