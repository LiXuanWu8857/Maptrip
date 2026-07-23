# Maptrip — 專案交接文件

**目前版本：v1.1.246**（2026-07-23）。使用者是台灣的計程車司機（繁體中文、台灣用語，例如「動態島」不是「靈動島」、「螢幕鎖定」不是「鎖屏」）。溝通原則：「科學一點」——先重現、量測、用測試驗證，不要用猜的。
注意：這支專案可能有多個 session 並行開發，push 前務必 `git fetch` 並 fast-forward/rebase 到最新（v245 找客熱區、v246 GPS 飄移群清理都由不同 session 加入）。

## 架構

- **Capacitor 6 hybrid App**：iOS 原生殼（WKWebView）遠端載入 GitHub Pages 網頁
  `https://lixuanwu8857.github.io/Maptrip/`。改網頁 code 不用重新打包 App。
- **iOS 簽署**：免費開發者帳號，7 天憑證，每週日晚上 8 點有自動提醒（Routine）
  要接電腦用 Xcode 重新 Run。原生檔案在 `native/`（使用者的 Xcode 專案裡是複本，
  改了 `native/*.swift` 要提醒使用者換進 Xcode）。
- **雙地圖引擎**：
  - 標準＝Leaflet 1.9.4 + leaflet-rotate（Google 圖磚，`keepBuffer:0`）
  - 向量（Beta）＝MapLibre GL 4.7.1，經 `js/gl-compat.js` Leaflet 相容層，app.js 不分引擎
  - 引擎選擇（index.html loader）：**App 內預設向量**（`maptrip_gl='0'` 才關）、
    **瀏覽器（Safari 後備）預設標準**（`'1'` 才開，Safari 分頁記憶體上限低，向量會崩）
  - `mt_glfail`（時間戳）＝GL 失敗後 3 小時走標準；`mt_glfail_reason`
    ∈ {crashloop, reloadloop, loadfail, jsfail}，開機時 toast 告知使用者
- **儲存**：`js/store.js` TripStore（IndexedDB，記憶體快取＋同步門面 loadTrips/saveTrips、
  逐日髒檢查非同步落盤、開機聯集合併自 localStorage 備份、墓碑過濾）
- **雲端**：`js/sync.js` Firebase Auth + Firestore。`users/{uid}/days`（行程）、
  `commissions/{tripId}`（抽成，記帳者可寫）、`meta/access.bookkeepers`、`invites/{code}`

## 部署流程（每次都要完整走完）

1. 升版號 **4 個地方**：`js/app.js` APP_VERSION、`index.html` INDEX_VERSION、
   `version.json`、`sw.js`（版本註解＋`VER` 快取名）
2. commit 到 `claude/mobile-website-version-Sl6cq` 分支並 push
3. **同一個 commit 也要 push 到 `gh-pages`**：`git push origin HEAD:gh-pages`
4. **必須驗證 Pages deploy conclusion=success**（常有暫時性失敗；失敗就空 commit 重觸發）。
   GitHub MCP `actions_list` 回應超過 token 上限 → 用 python 解析存檔的 JSON
5. 使用者更新方式：完全關閉 App 再開兩次（SW 換版：第一次安裝、第二次生效）

## 功能總覽（最新狀態）

- **行程記錄**：手動開始/結束（自動彈窗已停用 AUTO_PROMPTS=false）；背景 GPS
  （@capacitor-community/background-geolocation）；GPS 品質閘門（精度>40m、瞬移>50m/s 不記錄）
- **鎖定畫面/動態島**：Live Activity（native/LiveActivityPlugin）即時顯示時間/里程，
  `maptrip://start|end` URL 一鍵開始/結束；Android 浮動視窗對應
- **貼路（snap）**：OSRM 公開伺服器。`/match` 自適應降階取樣 95→60→40→25
  （TooBig 時逐級縮小；**2026-07 起連 25 點也常被拒＝伺服器收緊**）→ 後備 `/route`
  以取樣點當途經點。**三重防假路線**：`_dropSpikes` 孤立飄點剔除（繞行比>2.5 且多繞 60m）、
  `_snapSane` 長度檢查（match 1.4×+500m；route 更嚴 1.2×+200m）、`tripPath()` 顯示層防線
  （roadCoords 超長不顯示）。`healBogusRoads` 每次開機掃描修復＋`slimTripForStorage`
  在同步入口剝除假路線（否則合併評分讓假路線永遠贏、造成同步無限來回）。
  貼路成功後 coords 壓縮成頭尾（原始軌跡不可復原）。失敗重試上限 `_snapN` 15 次。
  失敗 toast 已隱藏（僅診斷模式顯示，記進黑盒子）
- **GPS 飄移群清理（v246）**：都市峽谷反射／停等紅燈會產生「來回鋸齒／小圈」飄移群。
  `_dropSpikes` 視窗式（往前看 4 點）收掉整叢飄點，判準＝繞行>2.5×且多繞60m，
  且（端點<35m＝甩回原地 或 垂距apex>端距2× ＝尖刺），並要求「第一個中間點自己就偏離>15m」
  避免連坐正常直行點。`_cleanTrace` 迭代 4 趟（安全閥：≥25 點才防過度清理）＋垂距 `_perpM`。
  真實繞街廓/轉彎（有前進、apex≈端距）不誤刪。貼路失敗時（OSRM 現況常拒）在
  finalizeSavedTrip/retrySnapBacklog 失敗分支就清理原始軌跡並重畫；`healZigzagTraces`
  開機一次性清既有未貼路趟（`maptrip_zigfix` 版本旗標，不受 _snapN 上限限制）
- **單趟預覽（今日與歷史）**：一律切白色無標示底圖（CartoDB nolabels，深色模式深色版），
  退出還原。今日路線藍色、歷史黑色。左右滑切趟。截圖鈕
- **今日圖層三態 `_todayMode`**：normal／hidden（歷史檢視整組隱藏）／solo（今日單趟：
  線 0.12 淡化、**點整組隱藏**）。任何狀態下的重畫（drawTripLine/drawGapLine）都套用當前狀態。
  **GL 陷阱**：MapLibre 每次 render 重寫 marker 元素 style.opacity → 隱藏 marker 必須用
  display:none（shim `Marker.setOpacity(0)` 已改為 display）
- **記帳**：每趟車資、現金/刷卡/其他（其他可填備註 label；改回現金/刷卡會清 label）、
  抽成 commission、叫車費 dispatch（綁在編輯車資對話框）
- **收支報表** `js/finance.js`：月營收（排除「其他」）、淨收入＝營收−抽成/叫車−支出、
  時段/星期分析、支出 CRUD（localStorage maptrip_expenses）
- **記帳者模式** `js/bookkeeper.js`：邀請碼授權；記帳者唯讀行程、可編抽成；
  雙向即時同步（司機端訂閱 commissions → applyCommission 合併）
- **歷史行程**：月/日收合清單、日預覽（白底黑線＋編號）、回放、刪除、休息時間設定
- **回放**：今日或歷史日，鏡頭跟隨、速度調整；回放中所有自動運鏡讓路
- **截圖**：單趟/全日，含日期時間、金額、「其他」顯示備註；分享／儲存合一
- **台灣道路標誌**：gl-compat 內建（國道梅花、省道盾、縣道、快速道路），
  校準工具 `MaptripTwShields.sample`
- **地圖朝車頭**：預設開；羅盤（靜止）＋GPS 方向（行駛）雙來源

## 穩定性機制（血淚史，勿隨意刪除）

背景：WKWebView 網頁行程會被 iOS 因記憶體壓力砍掉（司機同時跑導航 App 時最兇），
歷經 v223–v239 多輪修復。**發燙三元兇已修**：羅盤 60Hz 抖動驅動旋轉動畫（節流+死區 2.5°/3°）、
紅燈怠速跟隨動畫（3m 移動門檻）、精度圈每秒重畫（3m/3m 門檻）。
**同步記憶體風暴已拆**：onSnapshot 只合併 `docChanges()` 變動的日子（首快照全量）。

- `index.html` 開頭腳本（順序重要）：
  1. `__mtLog` 黑盒子（mt_bootlog 環狀 80 筆：page navigate/reload、bg/fg、crash-restart、
     boot ok、watchdog、safeReload）。**檢視器：歷史行程底部版本號連點 3 下**；5 下＝診斷模式
  2. `__mtSafeReload` 防迴圈重載（180 秒窗 >4 次 → reloadloop → 停止＋轉標準）
  3. 開機看門狗：25 秒未 `__mtBooted` → safeReload
  4. **崩潰偵測 v3（心跳式）**：app.js 每 5 秒寫 `mt_alive`；載入時「導覽型態=navigate
     且 mt_alive <45 秒」＝被系統砍掉 → `mt_crash` 30 分鐘窗累積 4 次 → crashloop → 標準 3 小時。
     （v2 靠 sessionStorage 消失判斷 → 被砍後 sessionStorage 常還在，25 次只抓到 3 次，勿走回頭路）
  5. **冷啟動自動 reload（App 殼限定，v244 恢復）**：使用者指定要的行為，
     reload 狀態下頂列 safe-area 必定正確；`__mtReloadPending` 讓 app.js 跳過拋棄頁
- `sw.js`：導覽網路優先（no-store）＋4 秒逾時/離線退快取（隧道白屏救星）；
  自家 ?v= 資源與鎖定版本函式庫（leaflet/maplibre/openfreemap styles|sprites|fonts）快取優先；
  Google 圖磚與向量圖磚不攔截；快取名帶版本、activate 汰舊
- `js/gl-compat.js` GL 全路徑保險：maplibregl 缺失→默默 return（index 驗 `MAPTRIP_GL`
  未設就走標準）；WebGL 探測失敗→return；Map 建構 throw→記 jsfail＋safeReload；
  webglcontextlost 5 秒未復原→safeReload；3D 建築（fill-extrusion）隱藏省記憶體；
  pixelRatio≤2、maxTileCacheSize 24
- `js/app.js`：startApp 接住 boot() 例外（GL→jsfail+mt_glerr+safeReload；標準→照拋）；
  背景時卸 Google 圖磚（visibilitychange）；行程被砍自動接回（ACTIVE_KEY 暫存）
- `native/MainViewController.swift`：didBecomeActive 探測 JS 環境
  （typeof INDEX_VERSION），死了 webView.reload()——**背景被砍回來全白的原生解**。
  已寫好，**待使用者下次接 Xcode 重簽時換入生效**

## 測試環境（Playwright，沙箱）

- Chromium：`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`；
  playwright 用全域 `NODE_PATH=/opt/node22/lib/node_modules`；
  node 指令都要 `env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy`
- 本機伺服器：`python3 -m http.server 8123 --directory /home/user/Maptrip`
  （沙箱背景行程會死，跑測試前重啟）
- 外部網路全擋（npm registry 可用）：leaflet/leaflet-rotate/maplibre 從 npm 裝到
  scratchpad 後以 `page.route` 供應；OSRM/Firebase 用 mock route
- 既有測試（scratchpad，容器重啟會消失需重建）：`failsafe.js`（GL 故障保險 14 項）、
  `swtest.js`（SW 快取 6 項，自架可控 server 含 hang 模式）、`heatfix.js`（發燙/重繪計數）、
  `snaptest.js`（貼路降階/後備/假路線 10 項）、`memfix.js`（崩潰偵測）、`glhide.js`（圖層隱藏）
- 要點：測試 context 一律 `serviceWorkers:'block'`（SW 有專屬測試）；
  瀏覽器環境 GL 要明確 `maptrip_gl='1'`；`?test` 網址＝模擬 GPS；
  evaluate 內可直接取用 app.js 頂層 let/function

## 已知狀態與待辦

- OSRM 公開 `/match` 幾乎全被 TooBig 拒 → 依賴 `/route` 後備；長期可考慮自架 OSRM 或換服務
- 向量地圖英文字仍是 Noto Sans（全套系統字型需自架 glyphs）
- 記帳者模式跨帳號實測未完整驗證（規則已部署、邀請碼流程已上線）
- 導航（一鍵導航）功能討論過尚未做；建議升級付費 Apple Developer（US$99/年）
  換一年憑證＋TestFlight（已向使用者建議）
- 品牌：logo＝雙 X（`icons/logo.svg`，粉紅 #FF5E8A 字標）；介紹海報產生器在
  scratchpad `poster.html`（Noto Sans TC）

## 慣例

- commit 訊息：英文標題＋繁中內文說明根因與修法，結尾附 Playwright 驗證結果
- 每個修復都要有對應的 Playwright 測試與回歸
- 回報使用者：先講結論、白話解釋根因、明確告訴他要做什麼（開兩次 App 等）
- 出問題先要黑盒子截圖（版本號連點 3 下），用數據說話
