# Maptrip — App 總覽與交接（下一個 session 先讀這份）

**目前版本：v1.1.348**。使用者是**台灣的計程車司機**（繁體中文、台灣用語：「動態島」不是「靈動島」、「螢幕鎖定」不是「鎖屏」）。
溝通原則：**科學一點**——先重現、量測、用測試驗證，不要用猜的。回報先講結論、白話講根因、明確告訴他要做什麼（例如「完全關 App 再開兩次」）。

> 這份是「先讀我」的地圖。**權威細節仍以 repo 根目錄 `CLAUDE.md` 為準**（最完整、每版都在補）。
> 專題細節見 `docs/` 各檔（文末有索引）。

---

## 0. 最重要的三件事（先記這個）

1. **部署流程一定要完整走完**（見 §2）。漏一步＝使用者拿不到更新，或 Pages 沒生效。
2. **多 session 並行開發**（見 §3）。動工前先 `git fetch`；push 被拒＝有人先推了，**rebase/cherry-pick 到對方之上、絕不覆蓋對方成果**；版號取「對方最新 +1」。
3. **安全根在 Firestore 規則**（見 §7）。記帳者、共享熱點的權限界線只由規則保證，規則我們**無法在沙箱實測**——附範本、請使用者用第二帳號 + Rules Playground 跑過再發佈。

---

## 1. 架構

- **Capacitor 6 hybrid App**：iOS 原生殼（WKWebView）**遠端載入 GitHub Pages 網頁** `https://lixuanwu8857.github.io/Maptrip/`。
  **改網頁 code（js/css/html）不用重新打包 App**，走部署流程即可。改 `native/*` 才要接 Xcode 重編。
- **iOS 簽署**：免費開發者帳號，**7 天憑證**，每週日晚上 8 點有自動提醒（Routine）要接電腦用 Xcode 重新 Run。
  原生檔在 `native/`（使用者 Xcode 專案裡是複本，改了要提醒他換進去）。長期建議升級付費 Apple Developer（US$99/年）換一年憑證＋TestFlight。
- **雙地圖引擎**（`js/gl-compat.js` 讓 app.js 不分引擎）：
  - 標準＝Leaflet 1.9.4 + leaflet-rotate（Google 圖磚）
  - 向量（Beta）＝MapLibre GL 4.7.1
  - **App 內預設向量**（`maptrip_gl='0'` 才關）；**瀏覽器預設標準**（Safari 記憶體上限低，向量會崩）
  - **GL 相容層的陷阱**：`map.on('click')` **不帶 latlng**（要位置改用 `getCenter`）；marker opacity 每次 render 被重寫（隱藏要用 `display:none`）
- **儲存**：`js/store.js` TripStore（IndexedDB，記憶體快取＋同步門面）。高階持久化在 `js/storage.js`。
- **雲端**：`js/sync.js` Firebase Auth + Firestore。設定在 `js/firebase-config.js`。

---

## 2. 部署流程（每次改網頁都要完整走完）

1. **升版號 4 個地方**：`js/app.js` 的 `APP_VERSION`、`index.html` 的 `INDEX_VERSION`、`version.json`、`sw.js`（開頭註解 + `var VER`）。
2. commit（英文標題＋繁中內文講根因與修法，結尾附 Playwright 驗證結果）。
3. **push 到 3 個分支**：`claude/taxi-continuation-24rh08`（本 session 指定）、`claude/mobile-website-version-Sl6cq`、**`gh-pages`（實際部署分支）**。
4. **驗證 Pages 部署 `conclusion=success`**：GitHub Actions workflow_id `291051013`。
   - `actions_list` 回應常超過 token 上限 → 存檔後用 python 解析，或用 `list_workflow_jobs` 看 deploy job 的 conclusion。
   - deploy step conclusion=success 就是成功；偶有暫時性失敗，空 commit 重觸發即可。
5. **告訴使用者更新方式：完全關閉 App 再開兩次**（SW 換版：第一次安裝、第二次生效）。
   - 為什麼升版能讓舊使用者也拿到修復：SW 快取名帶版號，升版 → 舊快取失效 → 重抓。**所以就算只改一支 js，也要升版**，否則 SW 不換、使用者拿不到。

> **沙箱網路**：外部大多被擋，只有 npm registry 可用；OSRM/Overpass/Firebase 從沙箱連不到（curl 回 `http=000` 是 proxy 擋的、**不是**外部伺服器掛了，別誤判）。

---

## 3. 並行開發規則（多 session，血淚）

這支專案**常有多個 session 同時改**（本 session 期間就撞了好幾次：v340 記帳者 TSV 匯出、v345 支出分類、v346 單月跑車天數、v347 Google Sheets 同步、v348 收緊貼路偏離閘，都是別的 session）。

1. **每次動工前、每批拆分前先 `git fetch`** 對齊 `gh-pages`/`Sl6cq` 最新，別在舊基礎上做。
2. **push 被拒（non-fast-forward）＝有人先推了** → `git fetch` 後 **rebase / cherry-pick 到對方最新之上**，**絕不覆蓋對方成果**。
3. **版號取「對方最新 +1」**。若對方版號與你撞了（例：兩邊都做了 v340），把你的疊在對方之上、版號進到 +1，兩功能都保留。
4. `force-with-lease` **只用來**把「自己被跳過的孤兒 commit」換成 rebase 後的版本（收斂三分支時）；**絕不** force 蓋掉別人的 commit。
5. **容器會被回收重 clone**：回來可能發現工作目錄只剩 README（預設分支 main 只有 README，App 在功能分支）。
   救法：`git fetch origin claude/taxi-continuation-24rh08 && git reset --hard origin/claude/taxi-continuation-24rh08`（或 reset 到 origin/gh-pages 拿最新）。

---

## 4. 功能地圖（模組一句話；細節見 CLAUDE.md）

**核心行程**
- `recorder.js` 錄製狀態機（開始/結束、復原、鎖屏方塊、GPS 監看）；`app.js` 保留 GPS 熱路徑逐點收錄。
- `geo-gate.js` GPS 品質閘門（精度>40m / 瞬移>50m/s 丟棄）。
- `geo-clean.js` 飄移群清理（紅燈原地圈 collapseStalls＋鋸齒 dropSpikes＋40% 安全閥）。
- `snap.js` OSRM 貼路（自適應取樣＋/route 後備＋長度閘/偏離閘；失效安全退回 GPS）。**詳見 `docs/GPS路線貼合-運作與心法.md`**。
- `storage.js` 序列化/合併/壓實/墓碑；`store.js` IndexedDB。
- `replay.js` 回放；`screenshot.js` 單趟/全日截圖（Canvas 自載 CartoDB 圖磚，`_loadTile` **必帶逾時**否則卡死）。

**記帳/報表**
- `fare-dialog.js` 車資對話框（現金/刷卡/其他、抽成、叫車費、小費分開付款）。
- `finance.js` 收支報表（月營收/淨利、時段星期分析、上車熱點分析、支出 CRUD 上雲）。`monthReport` 是**單一算錢來源**。
- `cancel-fee.js` 客人取消一鍵記 $40 刷卡。
- `export-excel.js` 記帳資料複製成 TSV（貼進 Excel）。
- `sheet-sync.js`（v347）記帳者確認時自動上傳每日總結到 Google Sheets（設定見 `docs/google-sheets-同步設定.md`）。

**記帳者模式（B 模式）**
- `bookkeeper.js` 邀請碼授權、唯讀行程、可編抽成/車資覆蓋/支出/手動補登；雙向即時同步。
- `desktop-mode.js` 電腦當「記帳者＋回放檢視台」（藏 GPS/找客/定位）。
- `manual-trips.js` 記帳者代補登（顯示層合併、**絕不寫進 days**）。
- **安全根在 Firestore 規則**（見 §7）。細節 `docs/記帳者-功能與交接.md`、`docs/記帳者-功能與運作邏輯.md`。

**地圖工具/搜尋**
- `search-menu.js` 右下角 🔍 FAB speed-dial（找客熱區/加油/停車/超商/**醫院**/搜尋地址）。
- `nearby.js` 找附近加油/停車/超商/醫院（Overpass，**4 個鏡像平行競速**）。
- `addr-search.js` 搜尋地址（Nominatim）；`nav.js` 一鍵導航；`transit.js`。
- `hotspots.js` + `hotspot-share.js` 找客熱區＋**共享熱點（車隊 Phase 1／全體 Phase 2）**（去識別化網格、k-匿名）。設計/規則見 `docs/共享熱點-*.md`。
- `restrictions.js`（v343/344）**限時禁轉路口標注**（手動 + OSM 自動抓）＋接近時段提醒。存本機 `maptrip_restrict`（未上雲＝待辦）。
- `train-alert.js` 火車到站提醒（金鑰共用 Cloudflare Worker，見 `docs/火車提醒-*.md`）；`metro-alert.js` 捷運。

**UI/系統**
- `sheet-drag.js` 底部 sheet 可拖曳展開（iOS 觸控用 touch 事件 `{passive:false}`，血淚三代）。
- `row-tap.js` 清單列點按路由（iOS 合成 click 位移修正）。
- `orient.js` 羅盤/朝車頭；`icons.js` 圖示工廠；`util.js` 工具；`altlog.js` GPS 高度黑盒子。
- `sync-ui.js` 登入閘門/同步面板。

---

## 5. 穩定性機制（血淚史，勿隨意刪）

背景：**WKWebView 網頁行程會被 iOS 因記憶體壓力砍掉**（司機同時跑導航時最兇）。歷經 v223–v239 多輪修復。
- `index.html` 開頭腳本（順序重要）：黑盒子 `__mtLog`、防迴圈重載 `__mtSafeReload`、開機看門狗（25s）、崩潰偵測 v3（心跳 `mt_alive`）、冷啟動自動 reload 一次、WKWebView safe-area 修正。
- **黑盒子檢視器**：歷史行程底部**版本號連點 3 下**（5 下＝診斷模式）。出問題先要這個截圖，用數據說話。
- `sw.js`：導覽網路優先（no-store）＋4 秒逾時退快取（隧道白屏救星）；自家 `?v=` 資源與鎖定版函式庫快取優先；Google/向量圖磚不攔截。
- `gl-compat.js`：GL 全路徑保險（缺失/WebGL 失敗/建構 throw/context lost 都有退路）。
- 發燙三元兇已修（羅盤抖動、紅燈怠速跟隨、精度圈重畫都加了門檻）。
- `native/MainViewController.swift`：`didBecomeActive` 探測 JS 死了就 reload（背景被砍回來全白的原生解）。

---

## 6. 慣例（務必遵守）

- **更新一律走模組化**（使用者核心規則）：新功能開新 `window.MaptripXxx` 模組（`js/xxx.js`）；改舊功能先找**已模組化的檔案**在那裡改，**別改 app.js 的薄包裝**（薄包裝只轉呼叫）。
- **改完一定測**：跑對應 Playwright 測試（模組回歸＋瀏覽器接線/行為），**零 pageerror** 才算完成，再部署。
- 每個修復都要有對應測試與回歸。commit 訊息：英文標題＋繁中內文（根因＋修法）＋結尾 Playwright 結果。
- app.js 已從 3900→2200 行，大量抽成模組（見 §4）。剩多為歷史清單/單趟預覽 UI（重耦合 map/DOM，逐一小抽即可）。

---

## 7. 安全根在 Firestore 規則（記帳者＋共享熱點）

- **整理好、可整份貼上的完整規則在 repo 根 `firestore.rules`**（記帳者＋共享熱點 Phase1＋Phase2 一次貼上）。
- **待辦（使用者要做，我們無法代做）**：
  1. 貼上 `firestore.rules` 到 Firebase 主控台發佈。
  2. **建兩個複合索引**（各 `dayType ASC + bucket ASC + gLat ASC`）：`groups/{gid}/grid`（車隊）、`hotspotGrid`（全體）。第一次查詢失敗時主控台會給建立連結。
  3. 第二帳號實測（清單見 `docs/共享熱點-firestore規則參考.md`、`docs/記帳者-firestore規則參考.md`）。
- 規則沒部署前：共享熱點/記帳者的雲端讀寫會被預設拒絕（UI 不會壞，只是讀不到）。

---

## 8. 測試環境（Playwright，沙箱）

- Chromium：`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`；`NODE_PATH=/opt/node22/lib/node_modules`；node 指令都要 `env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy`。
- 本機伺服器：`python3 -m http.server 8123 --directory /home/user/Maptrip`（**沙箱背景行程會死，跑測試前重啟**）。
- 外部網路全擋（npm registry 可用）：leaflet/maplibre 從 npm 裝到 scratchpad 後 `page.route` 供應；OSRM/Firebase/Overpass 用 mock route。
- **測試檔在 scratchpad，容器重啟會消失**——需要時重建。context 一律 `serviceWorkers:'block'`（SW 有專屬測試）。
- 常用招式：`page.route('**/*', …)` mock Overpass/tile；stub `window.__mtLive/L/toast`；純函式直接 `page.evaluate` 呼叫模組 `_xxx`。

---

## 9. 已知狀態與待辦

- **OSRM 公開 `/match` 幾乎全被 TooBig 拒** → 依賴 `/route` 後備；長期可考慮自架 OSRM 或換服務。
- **Overpass 公共伺服器會限流/逾時** → 已用 4 鏡像平行競速吸收；全網塞車時仍可能暫時搜不到（等幾分鐘，不是 bug）。
- **限時禁轉路口（restrictions.js）Phase 1 手動＋Phase 2 OSM 都做了，但未上雲**（存本機 localStorage）→ **待辦：上雲同步**。台灣 OSM 這類資料稀疏，自動抓常抓不到，主力靠手動。
- 共享熱點：程式與規則都到位，**待使用者部署規則＋建索引＋第二帳號實測**。
- 記帳者跨帳號實測未完整驗證；readDriverData 無分頁（重度司機慢/吃額度）。
- 向量地圖英文字仍是 Noto Sans（全套系統字型需自架 glyphs）。
- 導航（一鍵導航）討論過部分做了（nav.js）；可再擴。

---

## 10. 血淚地雷清單（改到相關處先看這個）

- **里程/金額只認原始 GPS 實測 `totalDist`，永不用貼路長度**（貼路只負責好看）。
- **貼路前一定先 `cleanTrace`**，否則髒點被 OSRM 當必經點繞路 → 假路線；貼路結果過不了長度閘/偏離閘就丟、退回 GPS。
- **GL 相容層**：`map.on('click')` 不帶 latlng（用 getCenter）；隱藏 marker 用 `display:none` 不用 opacity。
- **iOS 觸控**：`touchmove` 要 `{passive:false}` 才能 `preventDefault`；別在 `pointerdown` 內 `setPointerCapture`（WKWebView 會壓掉 pointermove）；清單列點按有合成 click 位移（row-tap.js 處理）。
- **CSS animation 還原會重播進場動畫**（sheet 放手「閃一下」的元兇）——拖曳全程別碰 `animation`。
- **換帳號要清本機**（帳號隔離 v265）：`maptrip_data_uid` 記本機資料屬於誰；換帳號才清、只有延續同帳號才回推本機獨有日子（杜絕跨帳號污染）。支出/手動趟/熱點 prefs 也各有換帳號清理。
- **截圖 `_loadTile` 必帶逾時**（圖磚 hang 會讓 Promise.all 卡死、全日截圖出不來）。
- **升版才會讓 SW 換快取**：只改 js 沒升版＝舊使用者拿不到。
- **2026 國定假日表**（hotspots.js / restrictions 日型判斷）**只到 2026，每年要更新**。

---

## 11. docs/ 索引（要深入哪塊看哪份）

| 檔 | 主題 |
|---|---|
| `CLAUDE.md`（repo 根） | **最完整的逐版交接**，權威來源 |
| `firestore.rules`（repo 根） | 整理好可整份貼上的完整規則 |
| `GPS路線貼合-運作與心法.md` | 貼路 pipeline、必要/重要標註 |
| `地圖系統-原理與功能.md` | 地圖引擎/圖層/繪製 |
| `錄製狀態機-功能與運作邏輯.md` | recorder.js 生命週期 |
| `回放功能與運作邏輯.md` | replay.js |
| `記帳者-功能與交接.md`／`記帳者-功能與運作邏輯.md` | 記帳者模式 |
| `記帳者-firestore規則參考.md` | 記帳者規則＋測試清單 |
| `共享熱點-設計草稿.md`／`共享熱點-firestore規則參考.md` | 車隊/全體熱點設計與規則 |
| `google-sheets-同步設定.md` | 每日總結上傳 Google Sheets 設定 |
| `火車提醒-金鑰共用-Cloudflare-Worker.md` | 火車/捷運提醒金鑰 |
| `功能與思考邏輯.md`／`session-交接-模組化.md` | 早期思考與模組化拆分 |

---

*本檔為「先讀我」總覽，隨大版本可再更新。細節永遠以 `CLAUDE.md` 為準。*
