# Maptrip 交接文件 — 功能新增 × 模組化拆分（本次 session）

> 對象：下一個接手的 session。
> 涵蓋版本：**v1.1.247 → v1.1.258**。
> 三分支（`gh-pages`／`claude/mobile-website-version-Sl6cq`／`claude/taxi-continuation-24rh08`）
> 皆停在 commit `bd84e20`，Pages deploy 已驗證 `conclusion=success`。
> 此檔為交接紀錄，**本身不需升版號**（純 docs）。

---

## 1. 這個 session 做了什麼（一句話）

先幫使用者**加了 6 個功能**（上車熱點×時段分析、找客熱區即時化、叫車費切換鈕、
抽成延後批次填、叫車費預設有），再把肥大的 `js/app.js` **逐塊模組化拆出 6 個模組**
（util／geo-gate／geo-clean／snap／screenshot／replay），`app.js` 從 **3909 行 → 3060 行**。

---

## 2. 版本進程

| 版本 | 內容 | 誰做的 |
|---|---|---|
| v1.1.248 | 上車熱點 × 時段分析（`js/finance.js`，「分析」分頁） | 本 session |
| v1.1.249 | 找客熱區改即時（歷史優先）＋叫車費切換鈕＋抽成延後批次填 | 本 session |
| v1.1.250 | 行程完成對話框叫車費**預設有 10 元** | 本 session |
| v1.1.251 | 抽出 `js/geo-gate.js`（品質閘門）＋`js/geo-clean.js`（飄移清理） | 本 session |
| v1.1.252 | 抽出 `js/snap.js`（OSRM 貼路） | 本 session |
| v1.1.253 | 找客熱區崩潰修復 | **另一 session（並行）** |
| v1.1.254 | 每小時收入 `$X/hr`（`_fareLineHtml` 加第二參數 `workMsVal`） | **另一 session（並行）** |
| v1.1.255 | 抽出 `js/util.js`（工具函式）；並把 v254 的 `$X/hr` 一併搬進 util | 本 session（cherry-pick 到對方之上） |
| v1.1.256 | 刪除已停用的「出發/到達偵測」死碼（DOM＋CSS＋JS） | 本 session |
| v1.1.257 | 抽出 `js/screenshot.js`（截圖 canvas 繪製） | 本 session |
| v1.1.258 | 抽出 `js/replay.js`（回放，第一個用依賴注入的模組） | 本 session |

> **並行事故紀錄**：v255 push 時撞到另一 session 已推的 v253/v254 → 用 cherry-pick 疊到對方 head，
> 版本衝突解到 1.1.255，把對方新的 `_fareLineHtml(trips, workMsVal)` 簽章一併搬進 util.js，
> 兩邊成果都保住。force-with-lease 只用來替換自己被跳過的孤兒 commit。

---

## 3. 新功能細節（給不熟的人看）

### 3.1 上車熱點 × 時段（v248，`js/finance.js`，「分析」分頁）
- 每趟 `coords[0]`（上車點）聚成 **300m 網格**，跨全部歷史（不受月份篩選，熱點需要量）。
- 一天切 **8 段**：清晨／早尖峰／上午／中午／下午／晚尖峰／晚間／深夜（深夜跨午夜）。
- 呈現「各時段最熱上車點」＋「上車熱點排行」（趟數／均車資／尖峰時段）。
- 地名用 **Nominatim reverse**（`zoom=16&accept-language=zh-TW`）非同步補，快取
  `localStorage maptrip_geocache`（key＝小數 3 位；空字串也快取），每筆間隔 1.1 秒。
- 純函式 `MaptripFinance._analyzePickups/_bucketIndexOf/_pickName` 供測試。

### 3.2 找客熱區即時化（v249，`js/hotspots.js`）
- **優先即時**：直接讀當下位置＋時間，用 `buildHistoryNow` 只取「當前時段（同 8 段桶）＋附近 2km」
  的歷史上車點，就地 350m 聚類、近期加權排名，**秒出免等網路**（使用者要的即時感）。
- 只有這個時段沒歷史時，才退回 Overpass 附近場所估算（舊行為）。
- 純函式 `MaptripHotspots._buildHistoryNow/_bucketOf` 供測試。

### 3.3 叫車費切換鈕 + 抽成延後批次填（v249/v250）
- 叫車費改成**單一切換鈕** `toggleDispatch`：開＝`DISPATCH_FEE`（10 元）、關＝0；
  載入舊趟若 dispatch>0 則沿用該趟金額。
- **v250 起行程完成對話框預設「有」10 元**（`showFareDialog` 用 `_setFareExtra(0, DISPATCH_FEE)`），
  沒叫車費再點一下關掉；編輯舊趟仍照該趟原值。
- **行程完成當下不再問抽成**（抽成兩天後才知道，`_showCommissionField(false)` 隱藏）。
- **批次編輯抽成**（`openCommissionBatch/saveCommissionBatch`）：歷史每日標題列「抽成」鈕，
  開底部 sheet 列出當日各趟，各填不同抽成、一次「全部儲存」，逐筆 `_pushCommission` 上雲並 `syncDays`。
  純 DOM 面板 `#commission-sheet`（樣式在 style.css `.cb-*`）。

---

## 4. 模組化拆分（本 session 核心）

### 4.1 拆分心法（沿用 CLAUDE.md 慣例，血淚）
1. `window.MaptripXxx` 命名空間、**零 build**、`<script>` 依序載（被依賴者先載，app.js 最後）。
2. **用 app.js 真實邏輯逐字搬**（不是骨架/重寫）；app.js 留**同名薄包裝**轉呼叫 → 呼叫端（含 HTML onclick）**零改動**。
3. 每塊配**兩種測試**：①回歸（模組 vs 原版逐字相同）②瀏覽器接線（實載入驗薄包裝委派、無 pageerror）。
4. 動工前先 `git fetch` 對齊；push 被拒＝有人先推 → rebase/cherry-pick，絕不覆蓋。
5. 部署走完整流程（升版 4 處、三分支、驗 Pages success）。

### 4.2 已拆出的模組

| 模組 | 檔案 | 內容 | 特別注意 |
|---|---|---|---|
| `MaptripUtil` | `js/util.js` (114行) | 距離/格式化/費用標籤/休息時間 14 函式 | `init({testMode})` 設 REST_KEY；`_fareLineHtml` 含 v254 `$X/hr` |
| `MaptripGeoGate` | `js/geo-gate.js` (35行) | `accept()` 品質閘門（精度>40m、瞬移>50m/s） | 自帶內部 haversine |
| `MaptripGeoClean` | `js/geo-clean.js` (75行) | `_perpM/_dropSpikes/_cleanTrace`（v246 飄移清理） | 自帶內部 haversine |
| `MaptripSnap` | `js/snap.js` (123行) | `snapToRoads/sampleTrack/snapSane`（OSRM /match 降階＋/route 後備） | 寫 `window._snapErr` 供診斷 |
| `MaptripShot` | `js/screenshot.js` (449行) | canvas 截圖全套（單趟/全日/今日/歷史/分享/存相簿） | **不碰 leaflet map**；`todayTrips` 用 `init({todayTrips:()=>todayTrips})` 注入 |
| `MaptripReplay` | `js/replay.js` (324行) | 回放動畫（**第一個用依賴注入**） | 見 4.3 |

### 4.3 replay.js 依賴注入（重點，最難拆的一塊）
回放有**活狀態＋操作地圖鏡頭＋被外部反向引用**，所以是第一個需要注入的模組。

```js
MaptripReplay.init({
  getMap:            () => map,
  getTodayTrips:     () => todayTrips,
  getActivePolyline: () => activePolyline,
  getCurrentPos:     () => currentPos,
  getSoloSet:        () => soloSet,
  getDayPreviewKey:  () => dayPreviewKey,
  resumeFollow:      () => { _wantFollowResume = true; scheduleFollowResume(); }
});
```
- **注入用 getter（呼叫時才讀）**，不是快照 → app.js 的 `map`/狀態變了模組也拿得到最新。
- 模組內 `function M(){ return ctx.getMap(); }`；把 `map.` → `M().`、`addTo(map)` → `addTo(M())`
  （**注意別動到 `.map(` 陣列呼叫**）。
- 對外反向引用開 2 個存取器，app.js **改了 2 處**：
  - `redrawAllLines`（~1029 行）：`replayTempLayers.forEach(...)` → `if (window.MaptripReplay) MaptripReplay.tempLayers().forEach(redraw)`。
  - `refreshAfterSync`（~2305 行）「動畫進行中」旗標：`|| (window.MaptripReplay && MaptripReplay.isAnimating())`。
  - `isAnimating() = !!replayRAF`（主迴圈與 glideGap 共用同一 handle，一個就夠）。
- 8 個薄包裝：`isReplaying/openReplay/replayDay/startReplay/closeReplay/toggleReplayPause/initSpeedSlider/clearReplayTempLayers`。
- `_replayable` 過濾（趟至少一個座標）已移進模組。
- 瀏覽器生命週期測試 **13/13 過**。
- 詳細藍圖見 `docs/回放功能與運作邏輯.md`。

### 4.4 死碼清理（v256）
「出發/到達偵測」早已停用（`AUTO_PROMPTS=false`），本 session 追完相依後**整組刪除**：
DOM（`#arrival-banner`/`#autostart-banner`）＋CSS＋JS。
**保留** `lastKnownPos`（原本跟 autoStart 變數同行宣告，但 `onGpsUpdate` 465–469 行用它算速度）→ 移到自己一行。

---

## 5. 尚未拆、風險最高：錄製狀態機（下一步建議）

`app.js` 唯一還沒拆的大塊＝**錄製狀態機**：`onGpsUpdate` / `startTrip` / `endTrip`。
- **為何最難**：GPS 熱路徑、與地圖／Live Activity（原生外掛）／存檔副作用**耦合最深**，不是純函式。
- **建議做法**：比照 replay 用**依賴注入**分離地圖／UI／原生副作用（getter 注入 + 寫入用 callback）。
- **務必**：先寫一份「功能與運作邏輯」md（像 `docs/回放功能與運作邏輯.md` 那樣先攤開耦合），
  再逐字搬＋薄包裝＋回歸/接線測試。**單獨一批做，別跟別的混。**

---

## 6. 部署 & 測試備忘（照抄即可）

- **升版 4 處**：`js/app.js` APP_VERSION、`index.html` INDEX_VERSION、`version.json`、`sw.js`（註解＋`VER`）。
- **三分支**都要 push 同一 commit：`Sl6cq`、`HEAD:gh-pages`、`claude/taxi-continuation-24rh08`。
- **驗 Pages** deploy `conclusion=success`（常暫時失敗；失敗就空 commit 重觸發）。
  `actions_list` 回應超 token 上限 → 存 JSON 用 python 解析。
- `sw.js` **無 precache 清單**（按需快取 `?v=` 資源），只需升版號。
- **測試環境**：Chromium `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`；
  `env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy NODE_PATH=/opt/node22/lib/node_modules /opt/node22/bin/node`；
  本機 server `python3 -m http.server 8123 --directory /home/user/Maptrip`（沙箱背景會死，測前重啟）。
- **載 app.js 進瀏覽器測**：stub `TripStore={init:()=>new Promise(()=>{})}` 與 `L`；
  `goto('.../version.json')`（不是 app 根，避免雙載）；app.js 的 function 宣告會蓋 `window.*`，
  所以 `loadTrips/saveTrips/toast/...` 要在載入 app.js **之後**再指回。
- 測試 context 一律 `serviceWorkers:'block'`（SW 有專屬測試）；瀏覽器 GL 要明確 `maptrip_gl='1'`。

---

## 7. 相關文件

- `CLAUDE.md`：專案總交接（已更新到 v1.1.255 標頭、慣例含並行開發＋模組化）。
- `docs/功能與思考邏輯.md`：全功能＋設計邏輯參考（17 節）。
- `docs/回放功能與運作邏輯.md`：回放功能＋運作邏輯＋拆模組藍圖。
- **本檔** `docs/session-交接-模組化.md`：本 session 功能新增＋模組化總紀錄。
