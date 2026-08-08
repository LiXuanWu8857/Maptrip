// search-menu.js — 右下角「🔍 搜尋」FAB 的彈出選單（speed-dial）：
// 點 FAB 展開三個選項（找客熱區／加油站／停車場），點外面或選一項即收起。
//   找客熱區 → window.openHotspots()
//   加油站   → MaptripNearby.run('fuel')
//   停車場   → MaptripNearby.run('parking')
(function () {
  'use strict';

  var ITEMS = [
    { k: 'hotspot', icon: '🔥', label: '找客熱區' },
    { k: 'fuel',    icon: '⛽', label: '加油站' },
    { k: 'parking', icon: '🅿️', label: '停車場' },
    { k: 'store',   icon: '🏪', label: '便利商店' },
    { k: 'address', icon: '📍', label: '搜尋地址' }
  ];

  // 選單從「我的位置」FAB（bottom:64）那格起，最下面那顆（找客熱區）從該處長出、往上疊。
  var CSS =
    '#mt-sm-bd{position:fixed;inset:0;z-index:16;background:transparent;display:none;}' +
    '#mt-sm-bd.on{display:block;}' +
    // 容器寬＝最寬那顆 pill（width:max-content），子項 align-items:stretch → 全部撐到同寬。
    '#mt-sm{position:fixed;right:14px;bottom:64px;z-index:17;display:flex;flex-direction:column-reverse;gap:10px;' +
      'align-items:stretch;width:max-content;pointer-events:none;}' +
    // 收起狀態＝縮回底部（我的位置那）：變形原點在更下方、往下位移多一點＋縮很小、透明。展開時歸零。
    // 所有 pill 等寬（以文字最寬者為基準）、內容置中
    '#mt-sm .pill{pointer-events:auto;display:flex;align-items:center;justify-content:center;gap:8px;' +
      'height:42px;padding:0 18px;box-sizing:border-box;' +
      'border:none;border-radius:21px;background:#fff;color:#1a1a1a;font:inherit;font-size:14px;font-weight:600;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.22),0 0 0 .5px rgba(0,0,0,.06);cursor:pointer;' +
      'transform-origin:calc(100% - 12px) 380%;opacity:0;transform:translateY(48px) scale(.3);' +
      'transition:opacity .18s ease,transform .28s cubic-bezier(.2,.9,.25,1.06);}' +
    '#mt-sm.on .pill{opacity:1;transform:translateY(0) scale(1);}' +
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
    // 收起（移除 .on → 套用這組基底延遲，被上面 .on 那組覆蓋）：反過來，
    // 最上面那顆先縮、最下面（最靠 FAB）最後縮＝跟長出動畫完全相反、像倒帶收回 FAB。
    '#mt-sm .pill:nth-child(1){transition-delay:.18s;}' +
    '#mt-sm .pill:nth-child(2){transition-delay:.135s;}' +
    '#mt-sm .pill:nth-child(3){transition-delay:.09s;}' +
    '#mt-sm .pill:nth-child(4){transition-delay:.045s;}' +
    '#mt-sm .pill:nth-child(5){transition-delay:0s;}' +
    '#mt-sm .pill .i{font-size:18px;line-height:1;}' +
    '#mt-sm .pill:active{background:#f1f3f4;}' +
    // 被按的那顆：藍色高亮，且收合時「原地淡出」（不套用往下位移的收合變形、無延遲）
    '#mt-sm .pill.picked{background:#e8f0fe;color:#1a73e8;box-shadow:0 2px 12px rgba(26,115,232,.4);}' +
    '#mt-sm:not(.on) .pill.picked{transform:translateY(0) scale(1);opacity:0;transition-delay:0s;}' +
    '@media (prefers-color-scheme: dark){#mt-sm .pill{background:#2d2d2d;color:#e8eaed;box-shadow:0 2px 10px rgba(0,0,0,.5);}' +
      '#mt-sm .pill:active{background:#3a3a3a;}' +
      '#mt-sm .pill.picked{background:#1e3a5f;color:#8ab4f8;}}';

  var _built = false, _open = false, _bd = null, _menu = null;
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
      _menu.appendChild(b);
    });
    _bd.addEventListener('click', close);
    document.body.appendChild(_bd); document.body.appendChild(_menu);
  }

  function open() {
    build();
    // 清掉上次「被按」標記，重新一輪乾淨的展開
    Array.prototype.forEach.call(_menu.querySelectorAll('.pill.picked'), function (p) { p.classList.remove('picked'); });
    document.body.classList.add('mt-search-open');   // 淡出 我的位置/指北針 FAB
    // 強制 reflow：確保 pill 先以「收合態」上版，再加 on 才會播放展開動畫（首次開也會動）
    void _menu.offsetWidth;
    _bd.classList.add('on'); _menu.classList.add('on'); _open = true;
  }
  function close() {
    if (!_built) return;
    _bd.classList.remove('on'); _menu.classList.remove('on'); _open = false;
    document.body.classList.remove('mt-search-open');   // 我的位置/指北針 FAB 淡回
  }
  function toggle() { _open ? close() : open(); }

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

  window.MaptripSearchMenu = { toggle: toggle, open: open, close: close, _pick: pick, _items: ITEMS };
})();
