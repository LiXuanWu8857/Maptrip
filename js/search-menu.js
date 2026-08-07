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
    { k: 'parking', icon: '🅿️', label: '停車場' }
  ];

  // FAB 在 bottom:176、高 48 → 選單從 FAB 上方往上疊。
  var CSS =
    '#mt-sm-bd{position:fixed;inset:0;z-index:16;background:transparent;display:none;}' +
    '#mt-sm-bd.on{display:block;}' +
    '#mt-sm{position:fixed;right:14px;bottom:232px;z-index:17;display:flex;flex-direction:column-reverse;gap:10px;' +
      'align-items:flex-end;pointer-events:none;}' +
    '#mt-sm .pill{pointer-events:auto;display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 14px;' +
      'border:none;border-radius:21px;background:#fff;color:#1a1a1a;font:inherit;font-size:14px;font-weight:600;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.22),0 0 0 .5px rgba(0,0,0,.06);cursor:pointer;' +
      'opacity:0;transform:translateY(8px) scale(.96);transition:opacity .16s ease,transform .16s ease;}' +
    '#mt-sm.on .pill{opacity:1;transform:none;}' +
    '#mt-sm.on .pill:nth-child(1){transition-delay:.05s;}' +
    '#mt-sm.on .pill:nth-child(2){transition-delay:.025s;}' +
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

  function open() { build(); _bd.classList.add('on'); _menu.classList.add('on'); _open = true; }
  function close() { if (!_built) return; _bd.classList.remove('on'); _menu.classList.remove('on'); _open = false; }
  function toggle() { _open ? close() : open(); }

  function pick(kind) {
    close();
    if (kind === 'hotspot') { if (window.openHotspots) window.openHotspots(); }
    else if (window.MaptripNearby) window.MaptripNearby.run(kind);
  }

  window.MaptripSearchMenu = { toggle: toggle, open: open, close: close, _pick: pick, _items: ITEMS };
})();
