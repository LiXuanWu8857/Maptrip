# Maptrip — 專案交接文件

**目前版本：v1.1.268**（2026-07-31）。使用者是台灣的計程車司機（繁體中文、台灣用語，例如「動態島」不是「靈動島」、「螢幕鎖定」不是「鎖屏」）。溝通原則：「科學一點」——先重現、量測、用測試驗證，不要用猜的。
注意：這支專案可能有多個 session 並行開發，push 前務必 `git fetch` 並 fast-forward/rebase 到最新（v245 找客熱區、v246 GPS 飄移群清理、v253 找客熱區崩潰修復、v254 每小時收入都由不同 session 加入）。**詳細並行開發規則見文末「慣例」。**

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
  - **帳號隔離（v265，血淚）**：本機（IndexedDB `maptrip_v1`）**不照帳號分開**。原本換帳號登入只
    「合併」雲端進本機、從不清 → ① 顯示到上一個帳號行程 ② 首快照把上一個帳號「本機獨有日子」
    **回推進新帳號雲端（跨帳號污染！）**。修法：`maptrip_data_uid` 記「本機資料屬於誰」；
    `_switchDecision(prev,uid)`＝換帳號才清（`TripStore.clearAll` 清記憶體＋IndexedDB＋localStorage
    備份＋墓碑），且**只有延續同帳號 `_pushLocalOK` 才回推本機獨有日子**（杜絕污染）。
    手動修復鈕 `MaptripSync.resetLocal`（同步面板「🧹 清除本機並重抓雲端」）。自檢 9 項全過。
    **注意：既有裝置 data_uid 未設 → 首次登入不自動清（保護離線 backlog），需手動按修復鈕一次**

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
- **折線脫鉤修正（v247，標準地圖）**：leaflet-rotate 手勢式「縮小＋旋轉」後 SVG 折線幾何
  有時沒重算、整條飄離底圖（點/標記正常，只有線脫鉤；投影本身正確）。`redrawAllLines()`
  在 zoomend/moveend/去抖 rotate 後強制以目前投影重畫所有折線（allMapLayers/soloLayers/
  dayPreviewLayers/replayTempLayers/activePolyline）。GL 模式 redraw 不存在自動略過
- **記帳**：每趟車資、現金/刷卡/其他（其他可填備註 label；改回現金/刷卡會清 label）、
  抽成 commission、叫車費 dispatch
- **叫車費切換 + 抽成延後填（v249；v250 預設有）**：叫車費改成單一切換按鈕（`toggleDispatch`），
  開＝`DISPATCH_FEE`（10 元）、關＝0；載入舊趟若 dispatch>0 則沿用該趟金額。
  **v250 起行程完成對話框預設「有」10 元**（`showFareDialog` 用 `_setFareExtra(0, DISPATCH_FEE)`），
  沒叫車費再點一下關掉；編輯舊趟仍照該趟原值。
  行程完成當下**不再問抽成**（抽成兩天後才知道；`_showCommissionField(false)` 隱藏該欄），
  改在歷史批次補。編輯對話框仍顯示抽成欄。
- **批次編輯抽成（v249）** `app.js openCommissionBatch/saveCommissionBatch`：歷史每日標題列
  新增「抽成」鈕，開底部 sheet 列出當日各趟（時間／車資），各自填不同抽成、一次「全部儲存」，
  逐筆 `_pushCommission` 上雲並 `syncDays`。純 DOM 面板（`#commission-sheet`，樣式在 style.css）
- **收支報表** `js/finance.js`：月營收（排除「其他」）、淨收入＝營收−抽成/叫車−支出、
  時段/星期分析、支出 CRUD（localStorage maptrip_expenses）
- **上車熱點 × 時段（v248，在「分析」分頁）** `js/finance.js`：把每趟 `coords[0]`
  上車點聚成 300m 網格，跨全部歷史（不受月份篩選，因熱點需要量）＋一天切 8 段
  （清晨/早尖峰/上午/中午/下午/晚尖峰/晚間/深夜，深夜跨午夜）。呈現「各時段最熱上車點」
  （回答哪個時段在哪個地點人最多）與「上車熱點排行」（趟數／均車資／尖峰時段）。
  地名用 Nominatim reverse（`zoom=16&accept-language=zh-TW`）非同步補上，快取在
  localStorage `maptrip_geocache`（key＝小數 3 位；空字串也快取避免重打），依用量規範
  每筆間隔 1.1 秒、已快取者不等待；離線／失敗顯示「未命名地點」但趟數統計照常。
  排除「其他」付款。純函式 `MaptripFinance._analyzePickups/_bucketIndexOf/_pickName` 供測試
- **找客熱區（v245，v249 改即時）** `js/hotspots.js`：FAB 開啟。**v249 起優先即時**：
  直接讀當下位置與時間，用 `buildHistoryNow` 只取「當前時段（同 8 段桶）＋附近 2km」的
  歷史上車點，就地 350m 聚類、近期加權排名，**秒出免等網路**（這才是使用者要的即時感）。
  只有這個時段還沒有歷史時，才退回 Overpass 附近場所估算（原行為）。面板依 `meta.mode`
  切文案／顯示趟數。純函式 `MaptripHotspots._buildHistoryNow/_bucketOf` 供測試。
  **v261 精進（研究背書：day-of-week 為需求預測前三大特徵）**：①**星期幾/假日加權** `dayFactor`
  ——同星期幾 ×1.4、同日型（都休或都上班）×1.0、日型不同 ×0.65；②**軟時段窗**取代硬分桶
  （±2h，1h 內滿權，修「差幾分鐘就整筆漏掉」）；③**最少 2 趟門檻**去單筆雜訊（全單筆才放寬）；
  ④**2026 國定假日表** `isOffDay`（假日需求型態≈週末，**表僅 2026、每年需更新**）。
  `_isOffDay/_dayFactor` 供測試（自檢 22 項全過）。天氣（下雨，Open-Meteo 免金鑰）暫緩
- **記帳者模式** `js/bookkeeper.js`：邀請碼授權；記帳者唯讀行程、可編抽成；
  雙向即時同步（司機端訂閱 commissions → applyCommission 合併）。
  **v263 修 4 個自檢問題**：①**撤銷持久化**——`removeBookkeeper` 撤銷時把該記帳者兌換過的邀請碼標
  `revoked`，`processInviteClaims` 用 `_shouldAuthorize` 跳過（否則舊 claimedBy 會被自動加回＝撤銷無效）；
  ②**一碼一用** `_claimBlock`——已被別人兌換的碼擋下（同人重複兌換冪等放行）；③**名字注入**——
  bookkeeper.js 的 onclick 改「只帶 uid、名字用 `_bks/_drivers` 查表」（`esc()` 不跳脫單引號，
  名字含 `'` 原本可從 onclick 字串跳出）；④移除司機的提示講清楚「授權仍在，需司機自撤」。
  `_claimBlock/_shouldAuthorize` 純函式供測試（自檢 18 項全過）。
  **安全根仍在 Firestore 規則（不在 repo，我無法實測）**——見 `docs/記帳者-firestore規則參考.md`，
  **務必用第二帳號＋Rules Playground 實測**。待辦：readDriverData 無分頁（重度司機慢/吃額度）、記帳者
  看到的是一次性快照（非即時）。
  **v267 抽成累計小計**：記帳者打開某司機時，`renderDriver` 頂端加「本月抽成／全部抽成（趟數＋叫車）」
  小計卡，答「這個月幫這位司機記了多少」。純函式 `_summary(days,commissions,now)`（commissions 優先、
  0 也優先於行程自帶，`day.slice(0,7)` 切當月）供測試（11 項全過）。B 模式（記帳者模式）取捨底定＝
  記帳者面板＋歷史唯讀＋回放＋雲端同步＋收支報表（含熱點分析），藏 GPS/找客/定位；desktop-mode.js 現況即 B。
  **v268 支出上雲＋記帳者可讀寫刪支出**：支出（加油等）原本只存 localStorage、綁單一裝置 → 電腦看不到手機記的支出、
  收支報表淨利算錯。改**雲端為主＋localStorage 快取**：`sync.js` 新增 `readExpenses/writeExpense/deleteExpense/
  listenExpenses`（`users/{driverUid}/expenses/{expId}`，id＝`<uid>_<ts>` 防撞號）、`readDriverData` 一併回傳 expenses；
  `finance.js` `bindExpenseSync`（開報表時：一次性遷移舊本機支出上雲＋onSnapshot 回填快取，`maptrip_exp_migrated` 旗標）、
  saveAdd/delExp 樂觀更新＋推雲。**兩個必修**（血淚）：①刪除鈕 id 從數字改字串**必須加引號**（`delExp(\'...\')`，
  否則 onclick 把字串當變數→ReferenceError 刪不掉；delExp 改 `String()` 比對相容舊數字 id）；②**換帳號 `resetExpenseSync`**
  （取消訂閱＋清支出快取＋放開 `_expBound`，由 sync `_clearLocalForSwitch` 呼叫，與 v265 行程隔離同類坑，
  不清 `maptrip_exp_migrated`＝裝置級旗標與帳號無關）。**安全根仍在 Firestore 規則**：expenses 開 read+write 給記帳者
  ＝把「看帳全貌＋可刪」給記帳者（使用者「自己人」確認要可讀可刪可改），規則沒部署則新子集合被預設 deny、
  司機連自己支出都同步不上（UI 樂觀更新仍看得到、靜默沒上雲）。務必第二帳號實測規則第 6–8 項。
  純函式測試 `expsync.js` 13 項（遷移/訂閱/saveAdd 字串 id/**刪除鈕真的點得下去**/String 比對刪舊 id/reset/換帳號重綁）全過，零 pageerror。
  **v266：記帳者讀不到司機資料**——renderDriver 改顯示真正的 Firestore 錯誤碼（permission-denied 等）＋
  指出兩大主因（①司機沒開一次 App 完成授權；②規則沒部署）。**幾乎確定是 Firestore 規則未部署/未允許
  記帳者讀取**（程式鏈已驗證正確）。連 processInviteClaims 的 invites 查詢、readDriverData 的 days 讀取
  都靠規則放行——規則沒到位，整條授權+讀取都會 permission-denied
- **歷史行程**：月/日收合清單、日預覽（白底黑線＋編號）、回放、刪除、休息時間設定
- **回放**：今日或歷史日，鏡頭跟隨、速度調整；回放中所有自動運鏡讓路
- **截圖**：單趟/全日，含日期時間、金額、「其他」顯示備註；分享／儲存合一
- **台灣道路標誌**：gl-compat 內建（國道梅花、省道盾、縣道、快速道路），
  校準工具 `MaptripTwShields.sample`
- **地圖朝車頭**：預設開；羅盤（靜止）＋GPS 方向（行駛）雙來源
- **電腦版記帳者模式（v264；v266 更名，原叫「檢視台版」）** `js/desktop-mode.js`（MaptripDesktop）：電腦（瀏覽器）當「記帳者＋回放
  檢視台」，藏掉並停用 GPS/記錄相關（開始記錄、找客熱區、定位、指北針、GPS 標記、底部列、
  選單今日/找客熱區），保留記帳者/回放/歷史/雲端同步/收支。**判定＝手動切換鈕**（選單「切換
  檢視台版/司機版」，data-menu=reviewtoggle，旗標 `maptrip_review` 記在裝置）；**原生 App 永遠司機版**
  （apply 直接 return、不顯示切換鈕）。附帶修好「選單只綁 touch、電腦滑鼠點不動」——app.js 抽出
  `window._dispatchMenu`（touch＋滑鼠共用、400ms 防重派發），模組在瀏覽器補選單 click。boot 依
  `isReview()` 跳過 startGpsWatch。自檢 19 項全過（原生 no-op／瀏覽器 wire＋toggle／review 藏 GPS）
- **GPS 高度黑盒子（v262，橋上/橋下量測第一步）** `js/altlog.js`：外掛回傳的 `altitude`/
  `altitudeAccuracy` 之前被丟棄，現在收進獨立 localStorage ring `mt_altlog`（cap 2000），
  **不塞進行程座標**（不影響貼路/壓實/同步）。版本號連點 3 下開黑盒子→「📈 高度診斷」看
  高度曲線＋±精度帶＋統計，可「複製數據」貼回判讀。目的：先量真實資料，判斷 GPS 垂直精度
  （常 ±10-30m）能否分辨高架的 5-15m 高差；若不行再考慮氣壓計原生外掛。`MaptripAlt.record/
  report/copyText/draw/showPanel`，自檢 16 項全過

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

- **更新一律走模組化（使用者指定的核心規則）**：
  1. **新增功能** → 開一個新的 `window.MaptripXxx` 模組（`js/xxx.js`），不要把新邏輯堆回肥大的 app.js。
  2. **修改舊功能** → 先找到它**已經模組化出來的檔案**（見下方「已抽」清單），**在那個模組裡改**；
     不要改 app.js 的薄包裝（薄包裝只轉呼叫）。若該功能還沒模組化，優先「先抽成模組、再改」。
  3. **改完一定測**：跑對應的 Playwright 測試（模組回歸＋瀏覽器接線/行為），零 pageerror 才算完成，再部署。
- commit 訊息：英文標題＋繁中內文說明根因與修法，結尾附 Playwright 驗證結果
- 每個修復都要有對應的 Playwright 測試與回歸
- 回報使用者：先講結論、白話解釋根因、明確告訴他要做什麼（開兩次 App 等）
- 出問題先要黑盒子截圖（版本號連點 3 下），用數據說話
- **並行開發（多 session，血淚規則）**：這支專案常有多個 session 同時改。
  1. **每次動工前、每批模組化拆分前，先 `git fetch`** 對齊 `gh-pages`/`Sl6cq` 最新，別在舊基礎上做。
  2. push 被拒（non-fast-forward）＝有人先推了 → **rebase / cherry-pick 到對方最新之上，絕不覆蓋對方成果**。
  3. **先看清楚對方改了什麼**（`git diff <對方commit>`），衝突處**兩邊功能都要保留**。
     例：v255 拆 util 時撞到對方 v254 把 `_fareLineHtml` 加了第二參數 `workMsVal`（$X/hr），
     解法是把那個新簽章一併搬進 util.js、薄包裝轉傳第二參數 → 兩個 session 成果都在。
  4. 版本號取「對方最新 ＋1」；force-with-lease 只用在替換自己被跳過的孤兒 commit。
- **模組化拆分慣例**：`window.MaptripXxx` 命名空間、零 build、`<script>` 依序載（被依賴者先載）。
  抽出時**用 app.js 真實邏輯逐字搬**（不是骨架/重寫），app.js 留同名薄包裝轉呼叫 → 呼叫端零改動；
  每塊配「回歸測試（模組 vs 原版逐字相同）＋瀏覽器接線測試」。
  已抽：`util.js`（工具）、`geo-gate.js`（品質閘門）、`geo-clean.js`（飄移清理）、`snap.js`（OSRM 貼路）、
  `screenshot.js`（截圖）、`replay.js`（回放，第一個依賴注入）、`recorder.js`（錄製狀態機，v259，
  生命週期/復原/鎖屏方塊/GPS 監看；共用活狀態 activeTrip/activePolyline 留 app.js 經注入，
  onGpsUpdate 逐點收錄刻意留 app.js＝GPS 熱路徑零改動；見 `docs/錄製狀態機-功能與運作邏輯.md`）、
  **v260 一批再抽 5 個**：`icons.js`（地圖圖示工廠，純函式）、`fare-dialog.js`（車資對話框，只碰 DOM）、
  `storage.js`（序列化/合併存檔/壓實/墓碑/營業日，store.js 之上的高階持久化；注入 getTodayTrips；
  retrySnapBacklog/loadTodayFromStorage 因重畫地圖留 app.js）、`sync-ui.js`（登入閘門/同步面板 UI，
  sync.js 之上；refreshAfterSync 留 app.js）、`orient.js`（羅盤/朝車頭/方向光束，依賴注入 map 與
  heading 狀態；對外開 cancelBearingAnim/syncBearingFromMap 供 initMap 手勢/rotate 呼叫）。
  **app.js 3909→2225 行**。剩多為歷史清單/單趟預覽 UI（重耦合 map/圖層/DOM，逐一小抽即可）。
