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

  // FAB 在 bottom:176、高 48 → 選單從 FAB 上方往上疊。
  var CSS =
    '#mt-sm-bd{position:fixed;inset:0;z-index:16;background:transparent;display:none;}' +
    '#mt-sm-bd.on{display:block;}' +
    '#mt-sm{position:fixed;right:14px;bottom:232px;z-index:17;display:flex;flex-direction:column-reverse;gap:10px;' +
      'align-items:flex-end;pointer-events:none;}' +
    // 收起狀態＝縮回 FAB（右下）：變形原點在右下角、往下位移＋縮小、透明。展開時歸零。
    '#mt-sm .pill{pointer-events:auto;display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 14px;' +
      'border:none;border-radius:21px;background:#fff;color:#1a1a1a;font:inherit;font-size:14px;font-weight:600;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.22),0 0 0 .5px rgba(0,0,0,.06);cursor:pointer;' +
      'transform-origin:calc(100% - 12px) 140%;opacity:0;transform:translateY(30px) scale(.4);' +
      'transition:opacity .18s ease,transform .26s cubic-bezier(.2,.9,.25,1.08);}' +
    '#mt-sm.on .pill{opacity:1;transform:translateY(0) scale(1);}' +
    // 展開時由下（最靠近 FAB）往上依序長出；收起時無延遲一起縮回 FAB。
    '#mt-sm.on .pill:nth-child(1){transition-delay:0s;}' +
    '#mt-sm.on .pill:nth-child(2){transition-delay:.045s;}' +
    '#mt-sm.on .pill:nth-child(3){transition-delay:.09s;}' +
    '#mt-sm.on .pill:nth-child(4){transition-delay:.135s;}' +
    '#mt-sm.on .pill:nth-child(5){transition-delay:.18s;}' +
    '#mt-sm .pill .i{font-size:18px;line-height:1;}' +
    '#mt-sm .pill:active{background:#f1f3f4;}' +
    '@media (prefers-color-scheme: dark){#mt-sm .pill{background:#2d2d2d;color:#e8eaed;box-shadow:0 2px 10px rgba(0,0,0,.5);}' +
      '#mt-sm .pill:active{background:#3a3a3a;}}';

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
      b.addEventListener('click', function () { pick(it.k); });
      _menu.appendChild(b);
    });
    _bd.addEventListener('click', close);
    document.body.appendChild(_bd); document.body.appendChild(_menu);
  }

  function open() {
    build();
    // 強制 reflow：確保 pill 先以「收合態」上版，再加 on 才會播放展開動畫（首次開也會動）
    void _menu.offsetWidth;
    _bd.classList.add('on'); _menu.classList.add('on'); _open = true;
  }
  function close() { if (!_built) return; _bd.classList.remove('on'); _menu.classList.remove('on'); _open = false; }
  function toggle() { _open ? close() : open(); }

  function pick(kind) {
    close();
    if (kind === 'hotspot') { if (window.openHotspots) window.openHotspots(); }
    else if (kind === 'address') { if (window.MaptripAddr) window.MaptripAddr.open(); }
    else if (window.MaptripNearby) window.MaptripNearby.run(kind);
  }

  window.MaptripSearchMenu = { toggle: toggle, open: open, close: close, _pick: pick, _items: ITEMS };
})();
