# 歷史與今日列表 UI 改版（卡片化＋左滑露出）— 交接

**涵蓋版本：v1.1.444 → v1.1.453**（2026-11）。
本文件整理「今日行程 / 歷史（月份、每日、每趟）清單」這一輪 UI 改版的做法、檔案、CSS、
血淚坑與測試方式。接手請先看完「核心概念」與「血淚坑」再動手。

---

## 這輪做了什麼（版本流水）

| 版本 | 內容 |
|---|---|
| v1.1.444 | **行程列（每趟）左滑露出動作**（iPhone 式）：新增 `js/row-swipe.js`（MaptripRowSwipe）；行程列左滑露出 編輯/截圖/刪除 |
| v1.1.445 | 左滑細修：平常隱藏動作（杜絕上下拖時底部露色塊）、圖文間距、圓角卡片 |
| v1.1.446–447 | 每趟號碼改「極簡大灰數字」、資訊固定欄位對齊（不隨字長跑位） |
| v1.1.448 | 每趟兩排版面：**金額當主體、用字色分付款**（現金黑/刷卡藍/簽單紅/其他灰）；上排金額→距離→標籤、下排時長＋起訖時間 |
| v1.1.449 | 每趟標籤順序 叫車 → 小費 → 抽成 |
| **v1.1.450** | **歷史「每日」列卡片化＋左滑露出 地圖/抽成/回放**；日期只顯示「日」藍色大數字（下小「日」字，與趟數號碼區分） |
| **v1.1.451** | **歷史「月份」列＋今日摘要卡片化**：總計＋每小時當主角、刷卡/現金色分；截圖/月結改左滑露出 |
| v1.1.452 | 展開某日後的「工作/休息」那行（`.dr-rest`）改置中 |
| **v1.1.453** | 今日摘要＋月份：刷卡/現金搬到「總計＋每小時」右側（今日＝和休息置中成右欄；月份＝直排靠右）；**修深色下今日總計 dark-on-dark**（自 v1.1.451 既有） |

---

## 核心概念

### 1. 左滑露出（MaptripRowSwipe，`js/row-swipe.js`）
iPhone 式「向左滑露出動作鈕」。**同一支模組被四種列共用**：每趟行程列、歷史每日列、
歷史月份列、今日摘要。

- **DOM 結構契約**（任何想左滑的列都要長這樣）：
  ```html
  <div class="... swipeable">          <!-- 外層卡片：position:relative; overflow:hidden -->
    <div class="trip-actions"> …動作鈕… </div>   <!-- 絕對定位在右、藏在內容後面 -->
    <div class="trip-swipe" onclick="主要動作"> …內容… </div>  <!-- 不透明、蓋住動作、可左滑 -->
  </div>
  ```
- **選擇器 `ROW_SEL = '.swipeable'`**（v1.1.450 由 `.trip-row.swipeable` 通用化）。
  只要外層有 `swipeable`＋內有 `.trip-swipe`/`.trip-actions` 就自動吃左滑。
- 動作鈕統一用 `.swa`（74px 全高彩色鈕），顏色 class：`edit/shot/del`（每趟）、
  `d-map/d-comm/d-replay`（每日：綠/橘/藍）、`a-shot`（截圖，藍）、`a-month`（月結，粉）。
- 參數：`DIR_THRESHOLD=8`（判方向）、`OPEN_RATIO=0.4`（放手過 40% 就吸附打開）。
- **與既有手勢共存（血淚）**：綁 **document capture 階段**、`touchmove {passive:false}`；
  一旦判定水平左滑 → `preventDefault()+stopPropagation()`，先於 sheet-drag（底部 sheet 上下拖）
  跑、擋掉它，也擋原生捲動；**垂直手勢完全不碰**（交給 sheet-drag / 捲動）。
  因此 `.trip-swipe` 的 `touch-action` 必須是 `manipulation`（**不能 pan-y**，否則擋掉垂直 preventDefault）。
- **桌面（細指標 `@media (hover:hover) and (pointer:fine)`）**：沒有左滑手勢 → 動作鈕直接內嵌右側。
  **此 media 的選擇器要用 2 類別**（`.trip-row.swipeable, .history-day.swipeable`）
  不能用單一 `.swipeable`，否則特異度輸給卡片基底規則、桌面版面會壞（見血淚坑）。
- 對外 API：`init/reset/close/closeAll/open`；測試用 `_onStart/_onMove/_onEnd/_state`。
  列表每次重畫（renderTripSheet/renderHistorySheet 開頭）都呼叫 `MaptripRowSwipe.reset()`。

### 2. 卡片化＋ Hero 排版（總計＋每小時當主角）
今日摘要、月份、每日、每趟都改成「圓角白卡＋卡間留白」。數字排版共用心法：
- **Hero**：總計 `NT$X`（粗大）＋ `$Y/hr`（橘 `#e8710a`）。
- **刷卡/現金色分**：刷卡藍 `#1a73e8`、現金綠 `#34a853`（深色 `#8ab4f8`/`#81c995`）。
- **金額字色＝付款別**（每趟）：現金 `#202124`/刷卡 `#1a73e8`/簽單 `#d93025`/其他 `#5f6368`
  （深色：`#e8eaed`/`#8ab4f8`/`#f28b82`）。
- 數字一律 `font-variant-numeric: tabular-nums`（等寬數字、不跳動）。

---

## 各列的結構與 CSS（檔案：`js/app.js` + `css/style.css`）

### 今日摘要（`renderTripSheet`，約 app.js:1090+）
```
.day-summary.swipeable（卡片，position:sticky top:8px 恆置頂）
  .trip-actions > .swa.a-shot（截圖，左滑露出）
  .trip-swipe.tsum
    .ts-hero
      .ts-left：總計 ts-lbl + ts-tot(1.5rem) + ts-rate(橘)
      .ts-pay：刷卡/現金 直排、置中、width:118px   ← v1.1.453
    .ts-meta
      .ts-meta-l：N 趟 · 里程 · 工作X（可換行）
      .rest-wrap：休息 [input] 小時、width:118px 置中（和 .ts-pay 對齊成右欄）
```

### 歷史 月份（`renderHistorySheet` 月份層，約 app.js:1790+）
```
.history-month.swipeable（卡片）
  .trip-actions > .swa.a-month（月結，左滑露出）
  .trip-swipe.mrow（onclick=toggleMonth）
    .month-body
      .month-title（2026年11月）
      .month-hero
        .m-left：m-tot(1.3rem) + m-rate(橘)
        .m-pay：刷卡/現金 直排靠右   ← v1.1.453
      .month-meta：N 天 · N 趟 · 里程 · 工作X（單行、ellipsis）
    .month-caret ▼/▶（最右，展開狀態；toggleMonth 用 .month-caret 更新）
```

### 歷史 每日（同函式 每日層，約 app.js:1767+）
```
.history-day.swipeable（卡片）
  .trip-actions > .swa.d-map/.d-comm/.d-replay（地圖/抽成/回放，左滑露出）
  .trip-swipe（onclick=toggleDay）
    .hday-num：b=日數字(藍) + small「日」
    .hday-body：.hday-hero(總計+每小時) + .hday-sub(刷卡/現金)
    .hday-right：b=N 趟 + small 里程
    .day-caret ▼/▶（最右，展開狀態；toggleDay 用 .day-caret 更新）
.day-rows（展開內容）
  .dr-rest：工作 <b id="work-日期"> · 休息 [input] 小時（v1.1.452 置中）
  …每趟 .trip-row.swipeable…
```
- 日數字 `dNum = +day.slice(8,10)`（'2026-11-20' → 20）。
- `setHistoryRest(day, 小時)` 用 `#work-${day}`、`#mwork-${mk}` 就地更新工時，不整頁重畫。

### 每趟（`renderTripSheet`/`renderHistorySheet` 趟層＋`_manualRowHtml`）
```
.trip-row.swipeable（.voucher-row 簽單紅框 / .manual-row 手動橘）
  .trip-actions > .swa.edit/.shot/.del
  .trip-swipe（onclick=開啟單趟）
    .trip-num（極簡大灰數字，固定寬 26px）
    .trip-meta = _tripMetaInner(t)：
      .trip-top：trip-amt(金額，字色=付款) + trip-dist + trip-tags(叫車/小費/抽成)
      .trip-bot：trip-dur + trip-trange(起→訖)
    .trip-go ‹
```

### app.js 共用 helper（約 app.js:1067+）
- `_payClass(pm)` → amt-cash/amt-card/amt-voucher/amt-other
- `_rowTags(t)` → 叫車→小費→抽成 標籤（順序固定，v1.1.449）
- `_amtHtml(t)`、`_tripMetaInner(t)`
- 數字一律 `_fareStats(trips)`（回 {card, cash, total}，含小費/手動趟；util.js 匯出，app.js:2149 有薄包裝）；
  每小時 = `Math.round(total / (workMs/3600000))`。

---

## 血淚坑（務必記住）

1. **CSS 特異度 ×「後者勝」**：卡片基底用 2 類別（`.trip-row.swipeable`、`.history-day.swipeable`
   = 0,2,0）。桌面 `@media (hover:hover)` 若用單一 `.swipeable`（0,1,0）會**輸**給基底、桌面版面壞
   （連既有行程列）。→ media 內要寫 `.trip-row.swipeable, .history-day.swipeable`。

2. **深色覆寫的「源碼順序」**（v1.1.453 修的 bug，自 v1.1.451 就有）：
   `@media (prefers-color-scheme:dark)` 內的覆寫，和同特異度的基底規則比，是**後者勝**。
   今日摘要 `.ts-tot` 的深色覆寫原本寫在今日基底樣式「之前」→ 被後面的基底 `#202124` 蓋回
   → 深色下總計 dark-on-dark 幾乎看不到。**修法：深色覆寫要放在對應基底樣式「之後」**。
   （月份 `.m-*` 剛好基底在前、覆寫在後，所以沒事。）

3. **五位數不換行**：卡片右側刷卡/現金要保證「破萬（5 位數）」不換行/不溢出。
   單行 inline 放不下（實測 390px 會重疊）→ 採**直排**（今日固定 118px 置中、月份直排靠右）。
   左側長字串（趟數·里程·工作）用 `.ts-meta-l`／`.month-meta` 允許換行或 ellipsis 吸收。

4. **GL/MapLibre marker 透明度**：隱藏 marker 要用 `display:none`（非 opacity），見主 CLAUDE.md。
   （本輪清單 UI 沒碰地圖 marker，但同檔案要小心。）

5. **sticky + overflow:hidden + 左滑**：今日摘要是 `position:sticky` 卡片，`overflow:hidden`
   不影響 sticky（sticky 相對捲動容器 sheet-body）。左滑 transform 作用在內層 `.trip-swipe`、OK。

---

## 測試方式（Playwright，沙箱）

- **Chromium 路徑**：`/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`
  （會隨容器更新改版號，若「executable doesn't exist」先 `ls /opt/pw-browsers/` 找新版）。
- node 指令前綴：`env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy NODE_PATH=/opt/node22/lib/node_modules /opt/node22/bin/node <test>.js`
- **左滑回歸**：用模組匯出的 `_onStart/_onMove/_onEnd/_state` 合成手勢（deterministic）。
  本輪測試檔（scratchpad，容器重啟會消失，需照下法重建）：
  - `hdayswipe.js`（每日列左滑 12 項）、`mtswipe.js`（月份＋今日摘要左滑 6 項）。
  - 要點：`hasTouch:true`；`_state().mode` 要在 `_onEnd` **之前**讀（onEnd 會清空 mode）；
    每次手勢前 `el.classList.remove('swipe-open','swiping')`＋清 transform（reset 不清 DOM class）。
- **版面自我驗證（手機版，真實 CSS）**：headless Chromium 會 match 桌面 media `(hover:hover)`，
  要預覽手機版面需**把 `@media (hover:hover) and (pointer:fine){…}` 整塊從 CSS 文字剝掉**再 inline
  進預覽 HTML（跨 origin 的 `file://` link 無法用 JS deleteRule）。剝除用大括號配對掃描。
  渲染淺/深色各一（context `colorScheme`），並量 `document.documentElement.scrollWidth>clientWidth`
  確認無水平溢出；用「總計/刷卡/現金＝99,999、時薪 1,850」做五位數壓力測試。
- **預覽給使用者**：本輪一律「先做示意圖 → SendUserFile（display:render）→ 使用者挑/確認 → 才實作 → 部署前再給真實 CSS 樣張」。

---

## 部署（每次完整走完，見主 CLAUDE.md）

1. 升版號 **4 處**：`js/app.js` APP_VERSION、`index.html` INDEX_VERSION、`version.json`、
   `sw.js`（註解 + `var VER`）。
2. `git fetch origin gh-pages` 對齊（並行開發，避免覆蓋別人）。
3. commit → push `gh-pages`、`claude/mobile-website-version-Sl6cq`、工作分支 `row-swipe`。
4. **驗證 Pages deploy `conclusion=success`**：
   `gh api '/repos/LiXuanWu8857/Maptrip/actions/runs?branch=gh-pages&per_page=1'` 用 python 解析。
5. 使用者更新：**完全關閉 App 再開兩次**（SW 第一次裝、第二次生效）。

---

## 待辦 / 可再調

- 每日卡片目前**沒有**顯示工時/休息（只在展開後的 `.dr-rest`）；曾做過「補到卡片上」的預覽，
  使用者最後選擇維持在展開處（見 v1.1.452）。若日後要補到卡片，注意休息 input 與左滑/點展開的
  事件衝突（input 要 `stopPropagation`）。
- 月份卡片的刷卡/現金是「直排靠右」，今日是「直排置中對齊休息」；若要兩者一致可再統一。
- 相關檔案若再抽模組，延續 `window.MaptripXxx` 命名空間＋薄包裝慣例（見 `docs/模組化-邏輯與做法.md`）。
