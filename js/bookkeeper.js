// bookkeeper.js — 記帳者模式（設計 X：記帳者只能讀行程、讀寫抽成/支出）
// 司機端：產生邀請碼、看/撤銷授權的記帳者。
// 記帳者端：輸入邀請碼綁定、看多位司機、檢視某司機行程並編輯抽成/支出。
// 報表導向 UI（tabular-nums、grid 對齊、未填黃底、月份 chip、司機切換下拉）。
// 全部靠 MaptripSync 提供的 Firestore 操作；本檔自帶樣式與面板 DOM。
(function () {
  'use strict';
  var WD = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  var _view = null;        // null=清單首頁；{driverUid,name}=某司機檢視
  var _editId = null;      // 正在編輯抽成的趟 id（點列 inline 展開；一律存成字串，相容手動紀錄字串 id）
  var _expEdit = null;     // 支出編輯狀態：null=無／'__new__'=新增中／<id>=編輯該筆
  var _addDay = null;      // 正在新增手動紀錄的日期 'YYYY-MM-DD'（null=無）
  var _month = null;       // 司機檢視目前選的月份 'YYYY-MM'（null=用最近月份）
  var _cache = null;       // 某司機的 { days, commissions, expenses, name }
  var _bks = [];           // 目前清單：授權我的記帳者（onclick 只傳 uid、名字查表，杜絕注入）
  var _drivers = [];       // 目前清單：我協助記帳的司機
  var _docClickWired = false;
  var _mount = 'bk-body';  // 內容寫進哪個容器 id：sheet 模式='bk-body'；電腦滿版='bk-home-body'

  function S() { return window.MaptripSync; }
  function nf(n) { return (Math.round(n) || 0).toLocaleString(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (m) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[m]; }); }
  function fmtT(ts) { try { return new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } }
  function fmtKm(m) { return ((m || 0) / 1000).toFixed(1) + ' km'; }
  function wdOf(day) { try { return WD[new Date(day + 'T00:00:00').getDay()] || ''; } catch (_) { return ''; } }

  function injectCss() {
    if (document.getElementById('bk-css')) return;
    var s = document.createElement('style'); s.id = 'bk-css';
    s.textContent =
      // ---- 設計 token（對接視覺稿；深色自適應）----
      '#bk-sheet,#bk-body,#bk-home{--bk-text:#202124;--bk-t2:#5f6368;--bk-muted:#9aa0a6;--bk-acc-t:#1a4b8c;' +
      '--bk-warn-t:#8a5a00;--bk-danger:#d93025;--bk-s1:#f1f3f4;--bk-s2:#fff;--bk-bd:#e0e2e6;--bk-bd2:#c8ccd2;' +
      '--bk-acc-bg:#e8f0fe;--bk-acc-bd:#a8c7fa;--bk-acc-fill:#1a73e8;--bk-on-acc:#fff;--bk-warn-bg:#fef7e0;--bk-warn-fill:#f9ab00}' +
      '@media (prefers-color-scheme:dark){#bk-sheet,#bk-body,#bk-home{--bk-text:#e8eaed;--bk-t2:#c8ccd2;--bk-muted:#9aa0a6;' +
      '--bk-acc-t:#a8c7fa;--bk-warn-t:#fdd663;--bk-danger:#f28b82;--bk-s1:#242424;--bk-s2:#1a1a1a;' +
      '--bk-bd:rgba(255,255,255,.1);--bk-bd2:rgba(255,255,255,.22);--bk-acc-bg:#1e3a5f;--bk-acc-bd:#2f5a9c;' +
      '--bk-acc-fill:#4285f4;--bk-warn-bg:#3a3000;--bk-warn-fill:#fdd663}}' +
      // ---- sheet 外殼（手機版：直接全螢幕，不再是半截彈出視窗）----
      // 安全區只放在標題列的 padding-top（單一來源，避免 sheet 再加一次造成標題上方留白）；
      // 標題列比照 #top-bar 貼在動態島下方，「記帳者」置頂不留白。
      '#bk-sheet{position:fixed;inset:0;background:var(--bk-s2,#fff);border-radius:0;z-index:31;display:none;' +
      'flex-direction:column;padding-bottom:env(safe-area-inset-bottom,0);animation:slideUp .2s ease}' +
      '#bk-sheet.show{display:flex}#bk-sheet .sheet-handle{display:none}' +
      '#bk-sheet .sheet-header{padding:6px 16px;padding-top:calc(env(safe-area-inset-top,0px) + 6px);border-bottom:.5px solid var(--bk-bd)}' +
      '#bk-body{overflow-y:auto;overflow-x:hidden;flex:1;padding:6px 16px 18px;font-variant-numeric:tabular-nums}' +
      // ---- 電腦滿版容器（純覆蓋層，鋪在地圖上、頂列之下；z 低於 sheet 的 31，地圖不被碰、不重 init）----
      '#bk-home{position:fixed;left:0;right:0;bottom:0;top:calc(48px + env(safe-area-inset-top,0px));z-index:15;' +
      'background:var(--bk-s2);display:none;flex-direction:column}#bk-home.show{display:flex}' +
      '#bk-home-hdr{display:flex;align-items:center;gap:8px;padding:12px 16px 8px;border-bottom:.5px solid var(--bk-bd)}' +
      '#bk-home-hdr .ti{font-size:1rem;font-weight:600;color:var(--bk-text)}' +
      '#bk-home-hdr .sw{margin-left:auto;display:flex;align-items:center;gap:5px;border:.5px solid var(--bk-bd);' +
      'background:var(--bk-s1);border-radius:16px;padding:5px 12px;font-size:.82rem;color:var(--bk-text);font-family:inherit;cursor:pointer}' +
      '#bk-home-body{flex:1;overflow-y:auto;overflow-x:hidden;padding:8px 16px 24px;font-variant-numeric:tabular-nums}' +
      // ---- 首頁 ----
      '.bk-h2{font-size:.86rem;font-weight:600;color:var(--bk-t2);margin:14px 2px 8px;display:flex;align-items:center;gap:6px}' +
      '.bk-dcard{display:flex;align-items:center;gap:10px;padding:14px;background:var(--bk-s2);border:.5px solid var(--bk-bd);' +
      'border-radius:12px;margin-bottom:8px;cursor:pointer}' +
      '.bk-dcard .nm{flex:1;font-size:.95rem;color:var(--bk-text)}.bk-dcard .go{color:var(--bk-muted);font-size:1.05rem}' +
      '.bk-dashed{width:100%;margin-top:2px;display:flex;align-items:center;justify-content:center;gap:6px;padding:11px;' +
      'border:.5px dashed var(--bk-bd2);background:transparent;border-radius:12px;font-size:.9rem;color:var(--bk-t2);font-family:inherit;cursor:pointer}' +
      '.bk-solid{width:100%;margin-top:8px;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px;' +
      'border:none;background:var(--bk-acc-fill);border-radius:12px;font-size:.92rem;color:var(--bk-on-acc);font-weight:600;font-family:inherit;cursor:pointer}' +
      '.bk-div{height:1px;background:var(--bk-bd);margin:20px 0}' +
      '.bk-note{font-size:.74rem;color:var(--bk-muted);margin:0 2px 10px;line-height:1.6}' +
      '.bk-hrow{display:flex;align-items:center;gap:10px;padding:11px 4px;border-bottom:.5px solid var(--bk-bd)}' +
      '.bk-hrow .nm{flex:1;font-size:.9rem;color:var(--bk-text)}' +
      '.bk-hrow .op{background:none;border:none;color:var(--bk-danger);font-size:.8rem;font-family:inherit;cursor:pointer;padding:4px 6px}' +
      '.bk-empty{text-align:center;color:var(--bk-muted);font-size:.85rem;padding:16px 0}' +
      // ---- 司機檢視 header + 下拉 ----
      '.bk-dhdr{display:flex;align-items:center;gap:8px;padding:0 2px 12px;position:relative}' +
      '.bk-back{border:none;background:none;color:var(--bk-acc-t);font-size:.9rem;font-family:inherit;cursor:pointer;padding:4px 0}' +
      '.bk-drvbtn{margin-left:auto;display:flex;align-items:center;gap:5px;border:.5px solid var(--bk-bd);background:var(--bk-s1);' +
      'border-radius:16px;padding:5px 12px;font-size:.82rem;color:var(--bk-text);font-family:inherit;cursor:pointer}' +
      '.bk-drvmenu{position:absolute;top:36px;right:2px;z-index:5;background:var(--bk-s2);border:.5px solid var(--bk-bd);' +
      'border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.18);min-width:180px;overflow:hidden;display:none}' +
      '.bk-drvmenu.show{display:block}' +
      '.bk-dmi{display:flex;align-items:center;gap:8px;padding:11px 12px;font-size:.88rem;color:var(--bk-text);cursor:pointer;border-top:.5px solid var(--bk-bd)}' +
      '.bk-dmi:first-child{border-top:none}.bk-dmi.on{background:var(--bk-acc-bg);color:var(--bk-acc-t);font-weight:600}' +
      '.bk-dmi.rm{color:var(--bk-danger)}' +
      // ---- 月份 chip ----
      '.bk-chips{display:flex;gap:6px;overflow-x:auto;padding:0 2px 10px}' +
      '.bk-chip{flex:none;padding:6px 12px;border-radius:16px;font-size:.82rem;font-family:inherit;cursor:pointer;' +
      'border:.5px solid var(--bk-bd);background:transparent;color:var(--bk-t2)}' +
      '.bk-chip.on{border-color:var(--bk-acc-bd);background:var(--bk-acc-bg);color:var(--bk-acc-t);font-weight:600}' +
      // ---- 小計卡 ----
      '.bk-cards{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-bottom:12px}' +
      '.bk-card{background:var(--bk-s1);border-radius:12px;padding:12px 14px}' +
      '.bk-card.acc{background:var(--bk-acc-bg)}' +
      '.bk-card .lbl{font-size:.72rem;color:var(--bk-t2);margin-bottom:4px}.bk-card.acc .lbl{color:var(--bk-acc-t)}' +
      '.bk-card .val{font-size:1.5rem;font-weight:600;color:var(--bk-text);font-variant-numeric:tabular-nums}.bk-card.acc .val{color:var(--bk-acc-t)}' +
      '.bk-card .sub{font-size:.72rem;color:var(--bk-t2);margin-top:2px}.bk-card.acc .sub{color:var(--bk-acc-t);opacity:.85}' +
      // 淨利卡：大數字（左）＋趟數/工時小字（右側疊放）
      '.bk-netrow{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:2px 6px;margin-top:2px}' +
      '.bk-netrow .val{margin:0;font-size:1.35rem;min-width:0;overflow:hidden;text-overflow:ellipsis}' +
      '.bk-ministat{display:flex;flex-direction:column;align-items:flex-end;gap:1px;font-size:.7rem;line-height:1.35;' +
      'color:var(--bk-t2);white-space:nowrap;font-variant-numeric:tabular-nums}' +
      '.bk-card.acc .bk-ministat{color:var(--bk-acc-t);opacity:.85}' +
      // ---- 月報表（淨利）----
      '.bk-report{background:var(--bk-s1);border-radius:12px;padding:10px 14px;margin-bottom:12px}' +
      '.bk-rrow{display:flex;justify-content:space-between;font-size:.82rem;color:var(--bk-t2);padding:4px 0}' +
      '.bk-rrow .rv{font-variant-numeric:tabular-nums;color:var(--bk-text)}' +
      '.bk-rrow.net{border-top:.5px solid var(--bk-bd2);margin-top:4px;padding-top:8px;font-weight:600;color:var(--bk-text)}' +
      '.bk-rrow.net .rv{font-size:1.05rem;color:var(--bk-acc-t)}' +
      // ---- 每趟報表列 ----
      // 日標題列：左＝收折鈕/日期/新增紀錄/已完成，右＝趟數＋當日抽成/叫車總計
      '.bk-daygrp{background:var(--bk-s1);color:var(--bk-t2);font-size:.76rem;font-weight:600;border-radius:8px;' +
      'padding:7px 10px;margin:10px 0 2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.bk-daygrp .dg-l{display:flex;align-items:center;gap:7px;min-width:0}' +
      '.bk-daygrp .dg-r{display:flex;align-items:center;gap:10px;margin-left:auto;white-space:nowrap}' +
      '.bk-daygrp .dg-x{border:none;background:none;color:var(--bk-t2);cursor:pointer;font-size:.9rem;padding:0;line-height:1}' +
      '.bk-daygrp .dg-d{font-weight:600;color:var(--bk-text)}' +
      '.bk-daygrp .dg-add{border:.5px solid var(--bk-acc-bd);background:var(--bk-acc-bg);color:var(--bk-acc-t);' +
      'border-radius:12px;padding:3px 9px;font-size:.72rem;font-weight:600;cursor:pointer;font-family:inherit}' +
      '.bk-daygrp .dg-done{border:.5px solid var(--bk-bd2);background:transparent;color:var(--bk-t2);' +
      'border-radius:12px;padding:3px 9px;font-size:.72rem;cursor:pointer;font-family:inherit}' +
      '.bk-daygrp .dg-done.on{color:var(--bk-muted)}' +
      '.bk-daygrp .dg-n{color:var(--bk-t2)}.bk-daygrp .dg-t{color:var(--bk-text);font-variant-numeric:tabular-nums}' +
      // 當日總結第二列（整寬）：現金/刷卡/抽成/叫車/總計
      '.bk-daygrp .dg-sum{flex-basis:100%;display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:5px;padding-top:6px;' +
      'border-top:.5px solid var(--bk-bd);font-weight:400;color:var(--bk-t2);font-variant-numeric:tabular-nums}' +
      '.bk-daygrp .dg-sum b{color:var(--bk-text);font-weight:600}' +
      '.bk-daygrp .dg-sum .dg-total{margin-left:auto}.bk-daygrp .dg-sum .dg-total b{color:var(--bk-acc-t)}' +
      // 手動新增紀錄的表單
      '.bk-tripform{background:var(--bk-s1);border-radius:10px;padding:10px;margin:2px 0 8px}' +
      '.bk-tripform .tf-row{display:flex;gap:8px;margin-top:8px}.bk-tripform .tf-row:first-child{margin-top:0}' +
      '.bk-tripform input,.bk-tripform select{flex:1;min-width:0;box-sizing:border-box;padding:9px 10px;' +
      'border:.5px solid var(--bk-bd2);border-radius:8px;font-size:1rem;font-family:inherit;background:var(--bk-s2);color:var(--bk-text)}' +
      '.bk-tripform button{flex:1;padding:9px;border:none;border-radius:8px;background:var(--bk-acc-fill);color:#fff;font-weight:600;font-family:inherit;cursor:pointer}' +
      '.bk-tripform button.gh{background:var(--bk-s2);color:var(--bk-t2);border:.5px solid var(--bk-bd2)}' +
      // 手動小標＋現金反灰輸入
      '.bk-trow .man{font-size:.6rem;color:var(--bk-acc-t);background:var(--bk-acc-bg);border-radius:4px;padding:0 4px;margin-left:3px}' +
      '.bk-tedit input:disabled{opacity:.45;background:var(--bk-s1);cursor:not-allowed}' +
      '.bk-tedit .del{background:var(--bk-s1);color:var(--bk-danger)}' +
      // 字級調整（放頂列，不隨內文縮放）
      '.bk-fontctl{display:inline-flex;align-items:center;gap:4px;margin-left:auto}' +
      '.bk-fsbtn{border:.5px solid var(--bk-bd2);background:var(--bk-s1);color:var(--bk-text);border-radius:8px;' +
      'width:30px;height:30px;font-size:.72rem;line-height:1;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center}' +
      '.bk-fspct{font-size:.72rem;color:var(--bk-t2);min-width:38px;text-align:center;font-variant-numeric:tabular-nums}' +
      // 表頭（欄名置頂，sticky）＋每列（5 欄，只放數值）共用同一組 grid
      '.bk-thead{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:52px 38px 1fr auto auto;' +
      'align-items:center;gap:8px;padding:8px;font-size:.72rem;font-weight:600;color:var(--bk-t2);' +
      'background:var(--bk-s2);border-bottom:.5px solid var(--bk-bd2)}' +
      '.bk-thead .f{text-align:left}.bk-thead .rc{text-align:right;min-width:44px}' +
      '.bk-trow{border-bottom:.5px solid var(--bk-bd);padding:10px 8px;cursor:pointer;display:grid;' +
      'grid-template-columns:52px 38px 1fr auto auto;align-items:center;gap:8px;font-size:.86rem;font-variant-numeric:tabular-nums}' +
      '.bk-trow.warn{background:var(--bk-warn-bg);border-radius:8px}' +
      '.bk-trow .t{color:var(--bk-t2)}.bk-trow .p{color:var(--bk-muted);font-size:.74rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.bk-trow .f{text-align:left;color:var(--bk-t2)}' +
      '.bk-trow .rc{text-align:right;font-weight:600;min-width:44px;color:var(--bk-text);white-space:nowrap}.bk-trow .rc.todo{color:var(--bk-warn-t)}' +
      '.bk-tedit{display:flex;gap:8px;padding:8px 4px 12px;align-items:center}' +
      '.bk-tedit .lb{font-size:.76rem;color:var(--bk-t2)}' +
      '.bk-tedit input{flex:1;min-width:0;box-sizing:border-box;padding:9px 10px;border:.5px solid var(--bk-bd2);border-radius:8px;' +
      'font-size:1rem;font-family:inherit;background:var(--bk-s2);color:var(--bk-text);text-align:right}' +
      '.bk-tedit button{padding:9px 12px;border:none;border-radius:8px;background:var(--bk-acc-fill);color:#fff;font-weight:600;font-family:inherit;cursor:pointer}' +
      '.bk-tedit button.gh{background:var(--bk-s1);color:var(--bk-t2)}' +
      // ---- 邀請碼 ----
      '.bk-inv{background:var(--bk-acc-bg);border-radius:16px;padding:24px 20px;text-align:center;margin-bottom:14px}' +
      '.bk-inv .h{font-size:.75rem;color:var(--bk-acc-t);opacity:.85;margin-bottom:10px}' +
      '.bk-inv .c{font-size:2.3rem;font-weight:600;letter-spacing:8px;color:var(--bk-acc-t);font-variant-numeric:tabular-nums;' +
      'font-family:"SF Mono",ui-monospace,Menlo,monospace}' +
      '.bk-inv .x{font-size:.74rem;color:var(--bk-acc-t);opacity:.7;margin-top:12px}' +
      '.bk-copy{width:100%;display:flex;align-items:center;justify-content:center;gap:7px;padding:13px;border:none;' +
      'background:var(--bk-acc-fill);border-radius:12px;font-size:.95rem;color:#fff;font-weight:600;font-family:inherit;cursor:pointer;margin-bottom:14px}' +
      '.bk-steps{background:var(--bk-s1);border-radius:12px;padding:14px 16px;counter-reset:s}' +
      '.bk-steps .sh{font-size:.76rem;font-weight:600;color:var(--bk-t2);margin-bottom:10px}' +
      '.bk-step{display:flex;gap:10px;margin-bottom:10px;font-size:.84rem;color:var(--bk-t2);line-height:1.5}' +
      '.bk-step:last-child{margin-bottom:0}.bk-step b{color:var(--bk-text)}' +
      '.bk-step::before{content:counter(s);counter-increment:s;flex:none;width:20px;height:20px;border-radius:50%;' +
      'background:var(--bk-acc-bg);color:var(--bk-acc-t);font-size:.72rem;display:flex;align-items:center;justify-content:center;font-weight:600}' +
      '.bk-tip{display:flex;gap:7px;margin-top:12px;padding:0 4px;font-size:.74rem;color:var(--bk-muted);line-height:1.6}' +
      // ---- 支出 ----
      '.bk-sec{font-size:.8rem;color:var(--bk-t2);font-weight:600;margin:14px 2px 8px;display:flex;align-items:center}' +
      '.bk-explink{background:none;border:none;color:var(--bk-acc-fill);font-size:.82rem;font-family:inherit;cursor:pointer;font-weight:600;margin-left:auto}' +
      '.bk-exprow{display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:.5px solid var(--bk-bd)}' +
      '.bk-exprow .ic{font-size:1.1rem}.bk-exprow .mid{flex:1;min-width:0}' +
      '.bk-exprow .t1{font-size:.86rem;color:var(--bk-text)}.bk-exprow .t2{font-size:.72rem;color:var(--bk-muted)}' +
      '.bk-exprow .am{color:var(--bk-danger);font-weight:600;font-size:.86rem;font-variant-numeric:tabular-nums}' +
      '.bk-mini{background:none;border:.5px solid var(--bk-bd2);border-radius:8px;padding:4px 9px;font-size:.78rem;font-family:inherit;color:var(--bk-t2);cursor:pointer}' +
      '.bk-mini.del{color:var(--bk-danger);border-color:var(--bk-danger)}' +
      '.bk-expform{background:var(--bk-s1);border-radius:12px;padding:10px;margin:8px 0}' +
      '.bk-expform select,.bk-expform>input{width:100%;box-sizing:border-box;padding:9px 10px;border:.5px solid var(--bk-bd2);' +
      'border-radius:8px;font-size:1rem;font-family:inherit;background:var(--bk-s2);color:var(--bk-text);margin-top:8px}' +
      '.bk-expform select{margin-top:0}' +
      '.bk-erow{display:flex;gap:8px;margin-top:8px}.bk-erow input{flex:1;min-width:0;box-sizing:border-box;padding:9px 10px;' +
      'border:.5px solid var(--bk-bd2);border-radius:8px;font-size:1rem;font-family:inherit;background:var(--bk-s2);color:var(--bk-text)}' +
      '.bk-erow button{flex:1;padding:9px;border:none;border-radius:8px;background:var(--bk-acc-fill);color:#fff;font-weight:600;font-family:inherit;cursor:pointer}' +
      '.bk-erow .bk-cancel{background:var(--bk-s1);color:var(--bk-t2)}';
    document.head.appendChild(s);
  }

  function ensureSheet() {
    injectCss();
    var el = document.getElementById('bk-sheet');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'bk-sheet';
    el.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-header"><span id="bk-title">記帳者</span>' + _fontCtlHtml() +
      '<button class="sheet-close" onclick="closeBookkeeper()">✕</button></div>' +
      '<div id="bk-body"></div>';
    document.body.appendChild(el);
    return el;
  }

  function setBody(html) { var b = document.getElementById(_mount); if (b) { b.innerHTML = html; try { b.style.zoom = _fontScale(); } catch (_) {} } }
  function setTitle(t) { var el = document.getElementById('bk-title'); if (el) el.textContent = t; }

  // 字級：整個內文容器用 zoom 縮放（rem/em 都跟著變）；控制鈕放頂列不受縮放。存本機。
  var FS_KEY = 'bk_fontscale';
  function _fontScale() { var v = parseFloat(localStorage.getItem(FS_KEY)); return (v >= 0.7 && v <= 2) ? v : 1; }
  function _fontCtlHtml() {
    var pct = Math.round(_fontScale() * 100);
    return '<div class="bk-fontctl"><button class="bk-fsbtn" title="縮小字級" onclick="MaptripBookkeeper.fontDown()">▼</button>' +
      '<span class="bk-fspct">' + pct + '%</span>' +
      '<button class="bk-fsbtn" title="放大字級" onclick="MaptripBookkeeper.fontUp()">▲</button></div>';
  }
  function bumpFont(dir) {
    var sc = Math.round((_fontScale() + dir * 0.1) * 100) / 100;
    if (sc < 0.8) sc = 0.8; if (sc > 1.6) sc = 1.6;
    try { localStorage.setItem(FS_KEY, String(sc)); } catch (_) {}
    var b = document.getElementById(_mount); if (b) b.style.zoom = sc;
    Array.prototype.forEach.call(document.querySelectorAll('.bk-fspct'), function (el) { el.textContent = Math.round(sc * 100) + '%'; });
  }
  function fontUp() { bumpFont(1); }
  function fontDown() { bumpFont(-1); }

  // 電腦滿版「記帳者模式」進入點：把同一套渲染塞進主容器（非 sheet）。
  // 由 desktop-mode.js 建好容器後呼叫；不碰 sheet 顯隱（原生/司機臨時叫 sheet 仍走 open()）。
  function mountAsHome(el) {
    if (!el) return;
    injectCss();
    if (!el.id) el.id = 'bk-home-body';
    _mount = el.id;
    _view = null; _editId = null; _expEdit = null; _addDay = null; _month = null;
    render();
  }

  // 收起司機切換下拉（點外面時）
  function wireDocClose() {
    if (_docClickWired) return; _docClickWired = true;
    document.addEventListener('click', function () {
      var m = document.getElementById('bk-drvmenu'); if (m) m.classList.remove('show');
    });
  }

  // ---------- 首頁（清單） ----------
  async function renderHome() {
    setTitle('記帳者');
    setBody('<div class="bk-empty">載入中…</div>');
    var s = S();
    var bks = [], drivers = [];
    try { if (s.processInviteClaims) await s.processInviteClaims(); } catch (_) {}
    try { bks = await s.listBookkeepers(); } catch (_) {}
    try { drivers = await s.listLinkedDrivers(); } catch (_) {}
    _bks = bks || []; _drivers = drivers || [];   // onclick 只傳安全的 uid，名字查表

    var h = '';
    // A. 記帳者視角優先：我協助記帳的司機（卡片，較重＝使用頻率高）
    h += '<div class="bk-h2">🧾 我協助記帳的司機</div>';
    if (!drivers.length) h += '<div class="bk-empty">尚未加入任何司機</div>';
    else drivers.forEach(function (d) {
      h += '<div class="bk-dcard" onclick="MaptripBookkeeper.openDriver(\'' + esc(d.driverUid) + '\')">' +
        '<span class="nm">' + esc(d.name || '（未命名司機）') + '</span><span class="go">›</span></div>';
    });
    h += '<button class="bk-dashed" onclick="MaptripBookkeeper.join()">＋ 輸入邀請碼加入一位司機</button>';

    h += '<div class="bk-div"></div>';

    // B. 司機視角：授權我的記帳者（緊湊 hairline 列）
    h += '<div class="bk-h2">👤 授權我的記帳者</div>';
    h += '<div class="bk-note">把碼給記帳者輸入即可授權，對方只能看你的行程與編輯抽成。</div>';
    if (!bks.length) h += '<div class="bk-empty">尚未授權任何記帳者</div>';
    else bks.forEach(function (b) {
      h += '<div class="bk-hrow"><span class="nm">' + esc(b.name || '（未命名）') + '</span>' +
        '<button class="op" onclick="MaptripBookkeeper.removeBk(\'' + esc(b.uid) + '\')">撤銷</button></div>';
    });
    h += '<button class="bk-solid" onclick="MaptripBookkeeper.invite()">＋ 產生邀請碼給記帳者</button>';
    setBody(h);
  }

  // ---------- 某司機檢視（記帳者）：載入 + 繪製分離（月份切換/編輯免重抓） ----------
  async function loadDriver() {
    setTitle('司機：' + (_view.name || ''));
    setBody('<button class="bk-back" onclick="MaptripBookkeeper.back()">‹ 返回</button><div class="bk-empty">載入中…</div>');
    var data;
    try { data = await S().readDriverData(_view.driverUid); }
    catch (e) {
      var code = (e && (e.code || e.message)) || '未知錯誤';
      var perm = /permission|denied|insufficient|missing/i.test(String(code));
      var msg = perm
        ? '沒有讀取權限（' + esc(code) + '）。<br>常見兩個原因：<br>① 司機還沒「打開一次 App」完成授權（授權要司機端 App 開一次才寫入雲端）。<br>② 雲端還沒部署「記帳者」的 Firestore 安全規則（見 docs/記帳者-firestore規則參考.md）。'
        : '讀取失敗（' + esc(code) + '）。<br>請司機打開一次 App 再試。';
      setBody('<button class="bk-back" onclick="MaptripBookkeeper.back()">‹ 返回</button>' +
        '<div class="bk-empty" style="text-align:left;line-height:1.7">' + msg + '</div>');
      return;
    }
    _cache = data;
    if (data.name && data.name !== _view.name) { _view.name = data.name; }
    if (!_drivers.length) { try { _drivers = (await S().listLinkedDrivers()) || []; } catch (_) {} }
    // 預設月份＝資料裡最近的月份（沒有就用當月）
    var months = _monthsOf(data.days);
    if (!_month || months.indexOf(_month) < 0) _month = months[0] || _monthNow();
    paintDriver();
  }

  function _monthsOf(days) {
    var set = {};
    Object.keys(days || {}).forEach(function (d) { var m = String(d).slice(0, 7); if (m) set[m] = 1; });
    return Object.keys(set).sort().reverse();
  }

  // 純繪製（讀 _cache，不打 API）
  function paintDriver() {
    if (!_cache) return;
    setTitle('司機：' + (_view.name || ''));
    var data = _cache;
    var days = _mergeManual(data.days, data.manualTrips);   // 併入手動紀錄後統一顯示/計算
    var months = _monthsOf(days);
    var sm = _summary(days, data.commissions, _month);

    var h = '';
    // header：返回 + 司機切換下拉
    h += '<div class="bk-dhdr">' +
      '<button class="bk-back" onclick="MaptripBookkeeper.back()">‹ 返回</button>' +
      '<button class="bk-drvbtn" onclick="event.stopPropagation();MaptripBookkeeper.toggleDrvMenu()">👤 ' +
      esc(_view.name || '司機') + ' <span style="color:var(--bk-t2)">⌄</span></button>' +
      '<div class="bk-drvmenu" id="bk-drvmenu">' + _drvMenuHtml() + '</div></div>';

    // 月份 chip
    if (months.length) {
      h += '<div class="bk-chips">' + months.map(function (m) {
        return '<button class="bk-chip' + (m === _month ? ' on' : '') + '" onclick="MaptripBookkeeper.setMonth(\'' + m + '\')">' +
          m.slice(5) + ' 月</button>';
      }).join('') + '</div>';
    }

    // 上方兩張卡：左＝當月淨利、右＝全部淨利；大數字右側疊放「趟數 / 工時」小字
    var mNet = _netStats(days, data.commissions, data.expenses, _month);
    var aNet = _netStats(days, data.commissions, data.expenses, null);
    h += '<div class="bk-cards">' +
      _netCard(true, '當月淨利 · ' + sm.ym, mNet) +
      _netCard(false, '全部淨利', aNet) +
      '</div>';

    // 月報表（淨利，含支出）
    h += _reportSection({ days: days, commissions: data.commissions, expenses: data.expenses }, _month);

    // 支出
    h += _expensesSection(data.expenses || []);

    // 每趟（依選定月份過濾）＋日期分組。欄名置頂一列（時間/付款/車資/抽成/叫車），列內只放數值。
    var dayKeys = Object.keys(days).filter(function (d) { return String(d).slice(0, 7) === _month; }).sort().reverse();
    if (dayKeys.some(function (d) { return (days[d] || []).length; })) h += _thead();
    var any = false;
    dayKeys.forEach(function (day) {
      var trips = (days[day] || []).slice().sort(function (a, b) { return (a.startTime || 0) - (b.startTime || 0); });
      if (!trips.length) return;
      any = true;
      var sm2 = _daySummary(trips, data.commissions);
      var done = _isDone(day);
      // 日標題列：收折鈕／日期／＋新增紀錄／已完成 + 趟數；第二列＝當日總結
      // （現金／刷卡／抽成／叫車／總計；總計＝現金＋刷卡−抽成−叫車）
      h += '<div class="bk-daygrp">' +
        '<div class="dg-l">' +
          '<button class="dg-x" onclick="MaptripBookkeeper.toggleDay(\'' + day + '\')">' + (done ? '▸' : '▾') + '</button>' +
          '<span class="dg-d">' + day + ' ' + wdOf(day) + '</span>' +
          '<button class="dg-add" onclick="event.stopPropagation();MaptripBookkeeper.addTrip(\'' + day + '\')">＋ 新增紀錄</button>' +
          '<button class="dg-done' + (done ? ' on' : '') + '" onclick="event.stopPropagation();MaptripBookkeeper.toggleDay(\'' + day + '\')">' +
            (done ? '↺ 展開' : '✓ 已完成紀錄') + '</button>' +
        '</div>' +
        '<div class="dg-r"><span class="dg-n">' + trips.length + ' 趟</span></div>' +
        '<div class="dg-sum">' +
          '<span>現金 <b>' + nf(sm2.cash) + '</b></span>' +
          '<span>刷卡 <b>' + nf(sm2.card) + '</b></span>' +
          '<span>抽成 <b>' + nf(sm2.comm) + '</b></span>' +
          '<span>叫車 <b>' + nf(sm2.disp) + '</b></span>' +
          '<span class="dg-total">總計 <b>NT$ ' + nf(sm2.total) + '</b></span>' +
        '</div>' +
        '</div>';
      // 新增紀錄表單（不受收折影響，方便補登）
      if (_addDay === day) h += _tripForm(day);
      if (done) return;   // 已完成＝收折：不畫每趟
      trips.forEach(function (t) {
        var idS = String(t.id);
        var c = data.commissions[idS] || {};
        var touched = c.commission != null;
        var cashLock = t.paymentMethod === 'cash';   // 現金：抽成鎖 0、不可輸入
        var comm = cashLock ? 0 : (touched ? c.commission : (t.commission || 0));
        var disp = c.dispatch != null ? c.dispatch : (t.dispatch || 0);
        // 「其他（自用）」與「現金」不需填抽成 → 不標待填
        var filled = touched || comm > 0 || t.paymentMethod === 'other' || cashLock;
        var pay = t.paymentMethod === 'card' ? '刷卡' : (t.paymentMethod === 'cash' ? '現金' : (t.paymentMethod === 'other' ? (t.label || '其他') : ''));
        var cells = _cells(cashLock, filled, comm, disp);
        h += '<div class="bk-trow' + (filled ? '' : ' warn') + '" onclick="MaptripBookkeeper.edit(\'' + esc(idS) + '\')">' +
          '<span class="t">' + fmtT(t.startTime) + (t._manual ? '<br><span class="man">手動</span>' : '') + '</span>' +
          '<span class="p">' + esc(pay) + '</span>' +
          '<span class="f">' + nf(t.fare) + '</span>' +
          '<span class="rc' + (filled ? '' : ' todo') + '">' + cells.comm + '</span>' +
          '<span class="rc">' + cells.disp + '</span></div>';
        if (String(_editId) === idS) {
          h += '<div class="bk-tedit">' +
            '<span class="lb">抽成</span><input id="bk-c" type="number" inputmode="numeric" value="' + comm + '"' + (cashLock ? ' disabled' : '') + '>' +
            '<span class="lb">叫車</span><input id="bk-d" type="number" inputmode="numeric" value="' + disp + '">' +
            '<button onclick="MaptripBookkeeper.saveComm(\'' + esc(idS) + '\')">存</button>' +
            '<button class="gh" onclick="MaptripBookkeeper.edit(\'' + esc(idS) + '\')">取消</button>' +
            (t._manual ? '<button class="del" onclick="MaptripBookkeeper.delTrip(\'' + day + '\',\'' + esc(idS) + '\')">刪</button>' : '') +
            '</div>';
        }
      });
    });
    if (!any) h += '<div class="bk-empty">' + sm.ym + ' 沒有行程紀錄</div>';
    setBody(h);
    wireDocClose();
  }

  function _drvMenuHtml() {
    var h = '';
    _drivers.forEach(function (d) {
      var on = d.driverUid === _view.driverUid;
      h += '<div class="bk-dmi' + (on ? ' on' : '') + '" onclick="event.stopPropagation();MaptripBookkeeper.switchDriver(\'' + esc(d.driverUid) + '\')">' +
        '<span>' + (on ? '✓' : '👤') + '</span><span>' + esc(d.name || '（未命名司機）') + '</span></div>';
    });
    h += '<div class="bk-dmi rm" onclick="event.stopPropagation();MaptripBookkeeper.removeCurrentDriver()">✕ 從清單移除此司機</div>';
    return h;
  }

  // 抽成累計小計（純函式，供測試）：ym 可傳 'YYYY-MM' 或含日期的字串/Date；不傳＝當月。
  // comm/disp 解析與逐趟顯示一致：記帳者填的 commissions 優先，否則沿用行程自帶值。
  function _ymOf(arg) {
    if (!arg) { var d0 = new Date(); return d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0'); }
    var sArg = String(arg);
    if (/^\d{4}-\d{2}/.test(sArg)) return sArg.slice(0, 7);
    var d = new Date(arg); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function _summary(days, commissions, ym) {
    var target = _ymOf(ym);
    var all = { n: 0, comm: 0, disp: 0 }, month = { n: 0, comm: 0, disp: 0 };
    Object.keys(days || {}).forEach(function (day) {
      (days[day] || []).forEach(function (t) {
        var c = (commissions && commissions[String(t.id)]) || {};
        var comm = c.commission != null ? c.commission : (t.commission || 0);
        var disp = c.dispatch != null ? c.dispatch : (t.dispatch || 0);
        all.n++; all.comm += comm; all.disp += disp;
        if (String(day).slice(0, 7) === target) { month.n++; month.comm += comm; month.disp += disp; }
      });
    });
    return { ym: target, all: all, month: month };
  }

  // 淨利＋趟數＋工時（供上方兩張卡）。ym='YYYY-MM' 只算該月；null=全部。
  //   net＝營收(排除「其他」)−抽成−叫車−支出（與 finance.monthReport 同口徑）。
  //   trips＝載客趟數（排除「其他」，含手動補登）。
  //   workMs＝工作時間；用每日「有 endTime 的載客趟」頭尾估（手動趟無 endTime 不計；
  //           休息分鐘存在司機裝置本機、記帳者拿不到 → 一律 restMin=0，即營業時間毛估）。
  function _netStats(days, commissions, expenses, ym) {
    var U = window.MaptripUtil;
    var fare = 0, comm = 0, disp = 0, trips = 0, work = 0;
    Object.keys(days || {}).forEach(function (day) {
      if (ym && String(day).slice(0, 7) !== ym) return;
      var arr = days[day] || [];
      arr.forEach(function (t) {
        if (t.paymentMethod === 'other') return;
        fare += t.fare || 0;
        var c = commissions && commissions[String(t.id)];
        comm += (c && c.commission != null) ? c.commission : (t.commission || 0);
        disp += (c && c.dispatch != null) ? c.dispatch : (t.dispatch || 0);
        trips++;
      });
      var timed = arr.filter(function (t) { return t.endTime && t.paymentMethod !== 'other'; })
        .sort(function (a, b) { return a.startTime - b.startTime; });
      if (U && U.workMs && timed.length) work += U.workMs(timed, 0);
    });
    var exp = 0;
    (expenses || []).forEach(function (e) { if (!ym || String(e.day || '').slice(0, 7) === ym) exp += e.amount || 0; });
    return { net: fare - comm - disp - exp, trips: trips, workMs: work };
  }
  function _fmtWork(ms) {
    var U = window.MaptripUtil;
    if (U && U.fmtWork) { try { return U.fmtWork(ms); } catch (_) {} }
    var min = Math.max(0, Math.round(ms / 60000)), h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? h + '小時' + m + '分' : m + '分';
  }
  function _netCard(acc, label, st) {
    return '<div class="bk-card' + (acc ? ' acc' : '') + '">' +
      '<div class="lbl">' + esc(label) + '</div>' +
      '<div class="bk-netrow"><div class="val">' + nf(st.net) + '</div>' +
      '<div class="bk-ministat"><span>' + st.trips + ' 趟</span><span>' + _fmtWork(st.workMs) + '</span></div>' +
      '</div></div>';
  }

  // ---------- 手動紀錄 / 當日總計 / 收折（純函式，供測試） ----------
  function _localDay(ts) {
    try { var d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    catch (_) { return ''; }
  }
  // 併入手動紀錄：回傳「新的 days map」（不改原物件），手動趟標 _manual=true。
  // 手動紀錄放進 m.day（沒有就用 startTime 推當地日期）對應的那天，之後由 paint 依 startTime 排序插入。
  function _mergeManual(days, manualTrips) {
    var out = {};
    Object.keys(days || {}).forEach(function (d) { out[d] = (days[d] || []).slice(); });
    (manualTrips || []).forEach(function (m) {
      var day = m.day || (m.startTime ? _localDay(m.startTime) : '');
      if (!day) return;
      if (!out[day]) out[day] = [];
      out[day].push({ id: m.id, fare: (m.fare != null ? m.fare : 0), paymentMethod: m.paymentMethod || 'cash',
        startTime: m.startTime || 0, label: m.label || '', commission: m.commission, dispatch: m.dispatch, _manual: true });
    });
    return out;
  }
  // 表格化：欄名置頂（時間/付款/車資/抽成/叫車），每列只放數值、不重複欄名。
  // 抽成／叫車兩欄的「值」：現金抽成不適用→「-」；刷卡未填→「待填」；0→「-」；否則數字。
  function _cells(cashLock, filled, comm, disp) {
    var c;
    if (cashLock) c = '-';            // 現金抽成不適用
    else if (!filled) c = '待填';      // 刷卡未填抽成
    else c = comm > 0 ? nf(comm) : '-';
    return { comm: c, disp: disp > 0 ? nf(disp) : '-' };
  }
  function _thead() {
    return '<div class="bk-thead"><span>時間</span><span>付款</span>' +
      '<span class="f">車資</span><span class="rc">抽成</span><span class="rc">叫車</span></div>';
  }
  // 當日抽成/叫車總計（與逐趟顯示一致：commissions 優先，否則行程自帶）。
  function _dayTotals(trips, commissions) {
    var comm = 0, disp = 0;
    (trips || []).forEach(function (t) {
      var c = (commissions && commissions[String(t.id)]) || {};
      comm += c.commission != null ? c.commission : (t.commission || 0);
      disp += c.dispatch != null ? c.dispatch : (t.dispatch || 0);
    });
    return { comm: comm, disp: disp };
  }
  // 當日總結（供每日標題）：現金/刷卡各自加總、抽成/叫車、總計＝現金＋刷卡−抽成−叫車。
  // 現金/刷卡只算各自付款方式的車資（「其他/自用」不計）；抽成/叫車與逐趟顯示同口徑（commissions 優先）。
  function _daySummary(trips, commissions) {
    var cash = 0, card = 0, comm = 0, disp = 0;
    (trips || []).forEach(function (t) {
      var c = (commissions && commissions[String(t.id)]) || {};
      var f = t.fare || 0;
      if (t.paymentMethod === 'cash') cash += f;
      else if (t.paymentMethod === 'card') card += f;
      comm += c.commission != null ? c.commission : (t.commission || 0);
      disp += c.dispatch != null ? c.dispatch : (t.dispatch || 0);
    });
    return { cash: cash, card: card, comm: comm, disp: disp, total: cash + card - comm - disp };
  }
  // 「已完成紀錄」收折狀態：記在本機（依司機分開）。回傳/切換某日是否已完成（＝收折）。
  function _doneKey() { return 'bk_done_' + ((_view && _view.driverUid) || ''); }
  function _doneList() { try { return JSON.parse(localStorage.getItem(_doneKey()) || '[]') || []; } catch (_) { return []; } }
  function _isDone(day) { return _doneList().indexOf(day) >= 0; }
  function _setDone(day, on) {
    var l = _doneList().filter(function (d) { return d !== day; });
    if (on) l.push(day);
    try { localStorage.setItem(_doneKey(), JSON.stringify(l)); } catch (_) {}
  }

  // 新增手動紀錄表單：車資／時間／付款方式
  function _tripForm(day) {
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
    return '<div class="bk-tripform">' +
      '<div class="tf-row">' +
        '<input id="bk-nf" type="number" inputmode="numeric" placeholder="車資">' +
        '<input id="bk-nt" type="time" value="' + hh + ':' + mm + '">' +
      '</div>' +
      '<div class="tf-row">' +
        '<select id="bk-np"><option value="cash">現金</option><option value="card">刷卡</option></select>' +
        '<button onclick="MaptripBookkeeper.saveTrip(\'' + day + '\')">新增</button>' +
        '<button class="gh" onclick="MaptripBookkeeper.addTrip(\'' + day + '\')">取消</button>' +
      '</div></div>';
  }

  // 從併入手動後的 days 找某趟（給 saveComm 判斷是否現金）
  function _findTrip(id) {
    if (!_cache) return null;
    var days = _mergeManual(_cache.days, _cache.manualTrips), found = null;
    Object.keys(days).forEach(function (d) {
      (days[d] || []).forEach(function (t) { if (String(t.id) === String(id)) found = t; });
    });
    return found;
  }

  function toggleDay(day) { _setDone(day, !_isDone(day)); paintDriver(); }
  function addTrip(day) { _addDay = (_addDay === day ? null : day); _editId = null; paintDriver(); }
  async function saveTrip(day) {
    var fare = parseInt((document.getElementById('bk-nf') || {}).value, 10) || 0;
    var time = (document.getElementById('bk-nt') || {}).value || '';
    var pay = (document.getElementById('bk-np') || {}).value || 'cash';
    if (!fare || fare <= 0) { if (window.toast) toast('請輸入車資'); return; }
    if (!/^\d{2}:\d{2}$/.test(time)) { if (window.toast) toast('請輸入時間'); return; }
    var startTime = new Date(day + 'T' + time + ':00').getTime();
    try {
      var rec = { fare: fare, paymentMethod: pay, startTime: startTime, day: day };
      var id = await S().writeManualTrip(_view.driverUid, rec);
      if (!_cache.manualTrips) _cache.manualTrips = [];
      _cache.manualTrips.push({ id: id, fare: fare, paymentMethod: pay, startTime: startTime, day: day, manual: true });
      _addDay = null;
      paintDriver();
      if (window.toast) toast('已新增紀錄');
    } catch (e) { if (window.toast) toast('新增失敗：' + ((e && (e.code || e.message)) || e)); }
  }
  async function delTrip(day, id) {
    if (!confirm('刪除這筆手動紀錄？')) return;
    try {
      await S().deleteManualTrip(_view.driverUid, id);
      if (_cache && _cache.manualTrips) _cache.manualTrips = _cache.manualTrips.filter(function (m) { return String(m.id) !== String(id); });
      if (_cache && _cache.commissions) delete _cache.commissions[String(id)];
      _editId = null;
      paintDriver();
      if (window.toast) toast('已刪除');
    } catch (e) { if (window.toast) toast('刪除失敗：' + ((e && (e.code || e.message)) || e)); }
  }

  // 月報表（淨利）：重用 finance 的共用純函式 monthReport（單一算錢來源）
  function _reportSection(data, ym) {
    var F = window.MaptripFinance;
    if (!F || !F.monthReport) return '';
    var r = F.monthReport(data.days, data.commissions, data.expenses, ym);
    return '<div class="bk-report">' +
      '<div class="bk-rrow"><span>營收（載客車資）</span><span class="rv">' + nf(r.fare) + '</span></div>' +
      '<div class="bk-rrow"><span>− 抽成</span><span class="rv">' + nf(r.comm) + '</span></div>' +
      '<div class="bk-rrow"><span>− 叫車費</span><span class="rv">' + nf(r.disp) + '</span></div>' +
      '<div class="bk-rrow"><span>− 支出</span><span class="rv">' + nf(r.expTotal) + '</span></div>' +
      '<div class="bk-rrow net"><span>淨利 · ' + r.month + '</span><span class="rv">NT$ ' + nf(r.net) + '</span></div>' +
      '</div>';
  }

  // ---------- 司機支出（記帳者可讀寫刪；沿用 finance 的分類清單） ----------
  function _cats() { return (window.MaptripFinance && MaptripFinance.CATS) || [{ k: 'other', label: '其他', icon: '📦' }]; }
  function _catOf(k) { var m = (window.MaptripFinance && MaptripFinance.CAT_MAP) || {}; return m[k] || { label: k || '其他', icon: '📦' }; }
  function _today() { try { return (window.todayKey && todayKey()) || new Date().toISOString().slice(0, 10); } catch (_) { return new Date().toISOString().slice(0, 10); } }
  function _monthNow() { return _today().slice(0, 7); }

  function _expForm(e) {
    var cat = e ? (e.cat || 'other') : 'fuel';
    var opts = _cats().map(function (c) {
      return '<option value="' + c.k + '"' + (c.k === cat ? ' selected' : '') + '>' + c.icon + ' ' + esc(c.label) + '</option>';
    }).join('');
    var amt = e ? e.amount : '';
    var day = e ? (e.day || _today()) : _today();
    var note = e ? (e.note || '') : '';
    var idAttr = e ? esc(String(e.id)) : '';   // 空＝新增
    return '<div class="bk-expform">' +
      '<select id="bk-ecat">' + opts + '</select>' +
      '<div class="bk-erow">' +
        '<input id="bk-eamt" type="number" inputmode="numeric" placeholder="金額" value="' + (amt === '' ? '' : amt) + '">' +
        '<input id="bk-eday" type="date" value="' + esc(day) + '">' +
      '</div>' +
      '<input id="bk-enote" type="text" placeholder="備註（可空）" value="' + esc(note) + '">' +
      '<div class="bk-erow">' +
        '<button onclick="MaptripBookkeeper.expSave(\'' + idAttr + '\')">存</button>' +
        '<button class="bk-cancel" onclick="MaptripBookkeeper.expCancel()">取消</button>' +
      '</div></div>';
  }

  function _expensesSection(exps) {
    var list = (exps || []).slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var mSum = 0; list.forEach(function (e) { if (String(e.day || '').slice(0, 7) === _month) mSum += (e.amount || 0); });
    var shown = list.filter(function (e) { return String(e.day || '').slice(0, 7) === _month; });
    var h = '<div class="bk-sec">司機支出 · ' + _month + '（' + shown.length + '）　本月 NT$ ' + nf(mSum) +
      '<button class="bk-explink" onclick="MaptripBookkeeper.expAdd()">＋ 記一筆</button></div>';
    if (_expEdit === '__new__') h += _expForm(null);
    if (!shown.length && _expEdit !== '__new__') h += '<div class="bk-empty">本月尚無支出</div>';
    shown.forEach(function (e) {
      var c = _catOf(e.cat);
      h += '<div class="bk-exprow"><span class="ic">' + c.icon + '</span>' +
        '<div class="mid"><div class="t1">' + esc(c.label) + (e.note ? '：' + esc(e.note) : '') + '</div>' +
        '<div class="t2">' + esc(e.day || '') + '</div></div>' +
        '<span class="am">-' + nf(e.amount) + '</span>' +
        '<button class="bk-mini" onclick="MaptripBookkeeper.expEdit(\'' + esc(String(e.id)) + '\')">改</button>' +
        '<button class="bk-mini del" onclick="MaptripBookkeeper.expDel(\'' + esc(String(e.id)) + '\')">刪</button></div>';
      if (_expEdit === e.id) h += _expForm(e);
    });
    return h;
  }

  function expAdd() { _expEdit = '__new__'; paintDriver(); }
  function expEdit(id) { _expEdit = id; paintDriver(); }
  function expCancel() { _expEdit = null; paintDriver(); }
  async function expSave(id) {
    var cat = (document.getElementById('bk-ecat') || {}).value || 'other';
    var amt = parseInt((document.getElementById('bk-eamt') || {}).value, 10) || 0;
    var day = (document.getElementById('bk-eday') || {}).value || _today();
    var note = ((document.getElementById('bk-enote') || {}).value || '').trim();
    if (!amt || amt <= 0) { if (window.toast) toast('請輸入金額'); return; }
    var editing = !!(id && id !== '__new__');
    if (!_cache.expenses) _cache.expenses = [];
    var old = editing ? _cache.expenses.filter(function (x) { return String(x.id) === String(id); })[0] : null;
    var rec = { cat: cat, amount: amt, note: note, day: day, ts: (old && old.ts) || Date.now() };
    if (editing) rec.id = id;
    try {
      var finalId = await S().writeExpense(_view.driverUid, rec);
      var merged = { cat: cat, amount: amt, note: note, day: day, ts: rec.ts, id: editing ? id : finalId };
      var i = -1;
      for (var k = 0; k < _cache.expenses.length; k++) { if (String(_cache.expenses[k].id) === String(merged.id)) { i = k; break; } }
      if (i >= 0) _cache.expenses[i] = merged; else _cache.expenses.push(merged);
      _expEdit = null;
      paintDriver();
      if (window.toast) toast('已儲存支出');
    } catch (e) { if (window.toast) toast('儲存失敗：' + ((e && (e.code || e.message)) || e)); }
  }
  async function expDel(id) {
    if (!confirm('刪除這筆支出？')) return;
    try {
      await S().deleteExpense(_view.driverUid, id);
      if (_cache && _cache.expenses) _cache.expenses = _cache.expenses.filter(function (x) { return String(x.id) !== String(id); });
      paintDriver();
      if (window.toast) toast('已刪除');
    } catch (e) { if (window.toast) toast('刪除失敗：' + ((e && (e.code || e.message)) || e)); }
  }

  function render() { if (_view) loadDriver(); else renderHome(); }

  // ---------- 動作 ----------
  function open() {
    if (!S() || !(S().myUid && S().myUid())) { if (window.toast) toast('請先登入雲端'); return; }
    ensureSheet();
    _mount = 'bk-body';   // sheet 模式一律寫回 sheet body（可能被滿版改過）
    _view = null; _editId = null; _expEdit = null; _addDay = null; _month = null;
    document.getElementById('bk-sheet').classList.add('show');
    var ov = document.getElementById('sheet-overlay');
    if (ov) { ov.style.display = 'block'; ov.onclick = close; }
    render();
  }
  function close() {
    var s = document.getElementById('bk-sheet'); if (s) s.classList.remove('show');
    var ov = document.getElementById('sheet-overlay');
    if (ov) { ov.style.display = 'none'; ov.onclick = window.closeActiveSheet || null; }
    _view = null; _editId = null; _expEdit = null; _addDay = null; _month = null;
  }
  async function invite() {
    try {
      var code = await S().createInvite();
      setTitle('記帳者');
      setBody('<button class="bk-back" onclick="MaptripBookkeeper.render()">‹ 回列表</button>' +
        '<div class="bk-inv"><div class="h">記帳者邀請碼</div><div class="c">' + esc(code) + '</div><div class="x">⏱ 30 天後失效</div></div>' +
        '<button class="bk-copy" onclick="MaptripBookkeeper.copy(\'' + esc(code) + '\');this.textContent=\'✓ 已複製\';var b=this;setTimeout(function(){b.textContent=\'複製邀請碼\';},1500)">複製邀請碼</button>' +
        '<div class="bk-steps"><div class="sh">給記帳者的步驟</div>' +
        '<div class="bk-step">對方開 App → 記帳者 → 輸入邀請碼加入一位司機</div>' +
        '<div class="bk-step">貼上這組碼，即完成綁定</div>' +
        '<div class="bk-step"><b>你這邊打開一次 App，授權才會生效</b></div></div>' +
        '<div class="bk-tip">ℹ️ 對方只能看你的行程與編輯抽成，改不到行程本身。</div>');
    } catch (e) { if (window.toast) toast('產生失敗：' + ((e && e.message) || e)); }
  }
  function copy(code) {
    try { navigator.clipboard && navigator.clipboard.writeText(code); }
    catch (_) { if (window.toast) toast('邀請碼：' + code); }
  }
  async function join() {
    var code = (prompt('輸入司機給你的邀請碼') || '').trim();
    if (!code) return;
    try {
      var r = await S().redeemInvite(code);
      if (window.toast) toast('已加入司機：' + (r.driverName || ''));
      render();
    } catch (e) { if (window.toast) toast(((e && e.message) || '加入失敗')); }
  }
  function _bkName(uid) { var b = _bks.find(function (x) { return x.uid === uid; }); return (b && b.name) || ''; }
  function _drvName(uid) { var d = _drivers.find(function (x) { return x.driverUid === uid; }); return (d && d.name) || ''; }
  async function removeBk(uid) {
    if (!confirm('撤銷「' + _bkName(uid) + '」的記帳者授權？\n（對方將無法再看你的行程）')) return;
    try { await S().removeBookkeeper(uid); render(); if (window.toast) toast('已撤銷'); } catch (_) {}
  }
  async function unlink(driverUid) {
    if (!confirm('從你的清單移除司機「' + _drvName(driverUid) + '」？\n（注意：這只移除你這邊的清單，司機端對你的授權仍在，需請司機自行撤銷）')) return;
    try { await S().unlinkDriver(driverUid); _drivers = _drivers.filter(function (d) { return d.driverUid !== driverUid; }); } catch (_) {}
  }
  // 從司機檢視的下拉移除目前司機 → 移除後回首頁
  async function removeCurrentDriver() {
    if (!_view) return;
    var uid = _view.driverUid;
    await unlink(uid);
    _view = null; _editId = null; _expEdit = null; _addDay = null; _month = null;
    renderHome();
  }
  function openDriver(driverUid, name) { _view = { driverUid: driverUid, name: name || _drvName(driverUid) }; _editId = null; _expEdit = null; _addDay = null; _month = null; loadDriver(); }
  function switchDriver(driverUid) {
    var m = document.getElementById('bk-drvmenu'); if (m) m.classList.remove('show');
    if (_view && driverUid === _view.driverUid) return;
    openDriver(driverUid);
  }
  function toggleDrvMenu() { var m = document.getElementById('bk-drvmenu'); if (m) m.classList.toggle('show'); }
  function setMonth(ym) { _month = ym; _editId = null; _expEdit = null; _addDay = null; paintDriver(); }
  function back() { _view = null; _editId = null; _expEdit = null; _addDay = null; _month = null; renderHome(); }
  function edit(tripId) { var s = String(tripId); _editId = (String(_editId) === s ? null : s); paintDriver(); }
  async function saveComm(tripId) {
    var t = _findTrip(tripId);
    var cashLock = !!(t && t.paymentMethod === 'cash');   // 現金：抽成強制 0
    var comm = cashLock ? 0 : (parseInt((document.getElementById('bk-c') || {}).value) || 0);
    var disp = parseInt((document.getElementById('bk-d') || {}).value) || 0;
    try {
      await S().writeCommission(_view.driverUid, tripId, comm, disp);
      if (_cache) _cache.commissions[String(tripId)] = { commission: comm, dispatch: disp };
      _editId = null;
      paintDriver();
      if (window.toast) toast('已更新抽成');
    } catch (e) { if (window.toast) toast('更新失敗：' + ((e && e.message) || e)); }
  }

  window.MaptripBookkeeper = {
    open: open, close: close, render: render, mountAsHome: mountAsHome, invite: invite, copy: copy, join: join,
    removeBk: removeBk, unlink: unlink, removeCurrentDriver: removeCurrentDriver,
    openDriver: openDriver, switchDriver: switchDriver, toggleDrvMenu: toggleDrvMenu, setMonth: setMonth,
    back: back, edit: edit, saveComm: saveComm,
    expAdd: expAdd, expEdit: expEdit, expCancel: expCancel, expSave: expSave, expDel: expDel,
    toggleDay: toggleDay, addTrip: addTrip, saveTrip: saveTrip, delTrip: delTrip,
    fontUp: fontUp, fontDown: fontDown, _fontCtlHtml: _fontCtlHtml,
    _summary: _summary, _mergeManual: _mergeManual, _dayTotals: _dayTotals, _daySummary: _daySummary, _localDay: _localDay, _cells: _cells
  };
  window.openBookkeeper = open;
  window.closeBookkeeper = close;
})();
