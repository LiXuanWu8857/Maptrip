# 開始行程後自動跳轉 Google 地圖 — 交接

**版本：v1.1.454 導入**（2026-11-22）。使用者需求：「按『開始行程』後,自動跳到 Google Maps app
方便直接用它的導航」。做成**設定開關（預設關）**,開了之後每次在**前景**按開始,行程開始後就自動
開 Google Maps app。

---

## 一句話總結

設定裡一個開關 → 開了之後,`recorder.js` 的 `beginRecording()` 在行程開始後、**僅前景**時,
`setTimeout 350ms` 後 `window.open('comgooglemaps://','_blank')` 把 Google Maps app 叫起來。
MapTrip 在背景照常記錄 GPS。純網頁、**不需改 Info.plist、不需重簽 Xcode**。

---

## 使用者決定的規格（問過才做）

- **觸發方式**：做成**設定裡的開關**（不是每次都跳、也不是獨立按鈕）。預設**關**。
- **開起來的內容**：只要「**打開 Google Maps app 本身**」就好（空白、它自己的畫面）,
  導航使用者自己用——不帶目的地（計程車上車當下通常還不知道去哪）。

---

## 檔案與實作

### 1. 設定開關 UI — `index.html`
選單 ⚙️設定 群組（`#top-menu` 的 `menu-settings-group`）裡加一顆：
```html
<button data-menu="autonav" id="autonav-menu-btn">🧭 開始後自動開 Google 地圖：關</button>
```
文字「開/關」會隨狀態更新。

### 2. 開關邏輯 — `js/app.js`
- `_dispatchMenu` 加一條：`else if (action === 'autonav') toggleAutoNav();`
- `toggleAutoNav()`：翻轉 localStorage 旗標 `maptrip_autonav`（'1'/'0'）、更新鈕文字、toast。
- `_syncAutoNavLabel()`：依旗標設定鈕文字（開＝「…：開」／關＝「…：關」）。
- 開機還原文字：在 `initMap` 後更新 glmap 鈕文字處旁邊呼叫 `_syncAutoNavLabel()`
  （找 `glmap-menu-btn` 那段附近）。

### 3. 實際跳轉 — `js/recorder.js`（`beginRecording()`）
行程開始流程的尾端、`saveActiveTrip()` 之後、`requestWakeLock()` 之前,加：
```js
// 「開始後自動開 Google 地圖」設定開（預設關）→ 前景按開始時自動跳 Google Maps app（v1.1.454）。
// 僅前景（visible）才跳,避免鎖屏/背景（widget）啟動時誤跳；MapTrip 在背景照常記錄 GPS。
// 用 comgooglemaps:// scheme（同 tel:/導航,Capacitor WKWebView 交系統開 App,不需改 Info.plist）。
try {
  if (global.localStorage && localStorage.getItem('maptrip_autonav') === '1'
      && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
    setTimeout(function () { try { global.open('comgooglemaps://', '_blank'); } catch (_) {} }, 350);
  }
} catch (_) {}
```
- `beginRecording()` 是所有開始路徑的共同點（一般按鈕 `startTrip`、預約 `booking`、鎖屏 widget
  `widgetStart`）都會走到。用 `document.visibilityState === 'visible'` 擋掉鎖屏/背景啟動,只有
  **前景使用者主動按開始**才跳。
- `setTimeout 350ms`：讓「行程開始！」toast、存檔、原生方塊切換先跑完,再跳 App（跳走就背景了）。

---

## 為什麼這樣可行（iOS / Capacitor）

- **不需改 Info.plist**：`UIApplication.open`（開啟 scheme）不需要 `LSApplicationQueriesSchemes`
  白名單（那只有 `canOpenURL` 查詢才要）。我們是「開啟」不是「查詢」。
- **不需重簽 Xcode**：純 web 改動,隨 gh-pages 部署生效。
- **Capacitor WKWebView 會把外部 scheme 交給系統**：跟 `js/booking.js` 的撥號
  `global.open('tel:...','_blank')`、`js/nav.js` 的導航 `window.open(url,'_blank')` 同一套機制。
  `_blank` 的非 http(s) scheme 會被交給 iOS 開對應 App。

---

## 已知狀態 / 待辦

- **需實機測試**：沙箱測不了「真的跳 App」。自動測試只驗了開關邏輯＋跳轉決策（見下）。
- **萬一 `comgooglemaps://` 在某裝置沒反應**（極少數被 WKWebView 攔）：改用通用網址
  `https://www.google.com/maps`（有裝 Google Maps 就開 App、沒裝開網頁,比照 `nav.js` 的做法）。
  一行就能換（`recorder.js` 那個 `global.open(...)`）。
- **只做了 Google Maps**。若之後要「問要 Google 還是 Apple」,可比照 `js/nav.js` 的選單
  （`MaptripNav.open`）做,但那是點地圖站點才跳的選單,跟「開始就跳」情境不同。

---

## 測試

`autonav.js`（scratchpad,容器重啟會消失需重建）10 項,用**實 app.js 函式**（從源碼抽出
`toggleAutoNav`/`_syncAutoNavLabel` eval 進頁面測）：
- 預設顯示「關」、toggle 翻旗標＋文字＋toast、再 toggle 翻回。
- 跳轉決策：旗標='1' 且前景 → `open('comgooglemaps://','_blank')`；關或背景 → 不跳。
- 零 pageerror。
- 跑法：`env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy NODE_PATH=/opt/node22/lib/node_modules /opt/node22/bin/node autonav.js`
  （Chromium 路徑會隨容器更新改版號,目前 `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`；
  localStorage 要從 http origin 讀,不能用 about:blank → 起 `python3 -m http.server` 再 goto）。

---

## 相關慣例

- 存旗標：localStorage `maptrip_autonav`（裝置級,不分帳號）。
- 與其他「選單開關」同一套：`data-menu` → `_dispatchMenu` → toggle 函式 → 更新鈕文字
  （可參考 `glmap`/單行道 `maptrip_oneway_on` 的做法）。

---

## v1.1.459 改版：跳出選單選 App（取代上面「直接跳 Google」）

使用者需求：「改成跳出選項讓我選擇要跳轉到哪個 app，預設是 55688 和 Google map，讓我在開關設定」。

- **新模組 `js/autonav.js`（`MaptripAutoNav`）**：所有邏輯在這；app.js `toggleAutoNav/_syncAutoNavLabel` 只剩薄包裝，
  recorder.js `beginRecording()` 改呼叫 `MaptripAutoNav.onTripStart()`。
- **設定面板**（選單 ⚙️設定 →「🧭 開始後跳轉 App：開/關」）：總開關（沿用 `maptrip_autonav`）＋每個 App 開關
  （`maptrip_autonav_apps` = `{on:{id:bool}}`）。預設：55688 司機版 開、Google 地圖 開、Apple 地圖 關。
- **行程開始**（前景＋總開關開）：開 ≥2 個 App → 底部選單（各 App＋「不用，留在 MapTrip」）；只開 1 個 → 直接跳不問；0 個 → 不動。
- **開啟＋後備**：`window.open(scheme)`；1.5 秒內沒有 blur/hidden（＝沒跳走）就開 fallback 網址。
  - Google：`comgooglemaps://` → 後備 `https://www.google.com/maps`
  - **55688 司機版：`taiwantaxidriver://` 是猜的（查不到官方 scheme）** → 後備 App Store 頁 `https://apps.apple.com/tw/app/id1190486682`
    （已安裝時頁上是「開啟」鈕＝多點一下）。若實機確認真正的 scheme，改 `autonav.js` APPS 的 `url` 一行即可。
  - Apple 地圖：`maps://`
- 黑盒子：`autonav:open <id>`／`autonav:fallback <id>`（用來判讀 55688 scheme 有沒有成功）。
- 測試 `autonav2.js`（scratchpad，完整 App 實跑）25 項全過零 pageerror。

### v1.1.460 修：按 55688 完全沒反應（血淚）
- 實機回報：點「55688 司機版」停在原畫面，連 App Store 後備都沒開。
- 根因：WKWebView 的 `window.open` 只在「點擊當下」放行。`taiwantaxidriver://` 猜錯→ iOS 靜默失敗；
  1.5 秒後的後備 `window.open` 已不是點擊當下 → 被擋 → 什麼都沒發生。（v1.1.454 只開 Google 時用 setTimeout 350ms 也有同樣風險。）
- 修法：`_openUrl` 在 App 殼（`Capacitor.isNativePlatform()`）改用 `location.href`：Capacitor 導覽委派把非本站網址／
  非 http scheme 一律交 `UIApplication.open`、並 cancel 導覽（頁面不離開），**不需點擊手勢**。瀏覽器仍用 window.open。
- 55688 實際 scheme 仍未知 → 目前實機行為預期是「開到 App Store 頁再按開啟」。替代方案：iOS 捷徑
  `shortcuts://run-shortcut?name=...`（使用者自建「打開 App」捷徑，可直接開任何 App）。
- 測試 `autonav2.js` 擴到 30 項（native 走 location.href、後備非點擊當下也能開、不用 window.open）全過。

### v1.1.461：55688 仍沒跳（Google 有跳）
- 實機：Google 地圖有跳，55688 仍停在原畫面（無法確認當時是否已更新到 v1.1.460，故這版補黑盒子數據）。
- 已讀 Capacitor 6.2.3 原始碼 `WebViewDelegationHandler.swift`：主框架導覽到非本站網址 → `UIApplication.shared.open(navURL)` 並 cancel
  ＝ location.href 路徑確實會交給 iOS；window.open 走 `createWebViewWith`（需點擊手勢）。
- 改：
  1. 55688 依序試候選 scheme（`twtaxidriver://`、`tw.com.masterhand.twtaxidriver://`、`taiwantaxidriver://`、`masterhand://`，
     依 Android 套件名 `tw.com.masterhand.twtaxidriver` 推測），每個 1.2 秒看有沒有 blur/hidden。
  2. 後備改 `itms-apps://apps.apple.com/app/id1190486682`（App Store 專屬 scheme）。
  3. 設定面板 55688 下方「用 iPhone 捷徑開啟」輸入框（`maptrip_autonav_apps.sc.taxi55688`）→ 最先試
     `shortcuts://run-shortcut?name=<名稱>`。使用者在「捷徑」App 建「打開 App → 55688司機版」即可保證直接跳（會閃一下捷徑）。
  4. 黑盒子：`autonav:try <id> <url>`、`autonav:ok blur|hidden <id> #<第幾個>`、`autonav:fallback`、`autonav:fail`。
     **若某候選成功（ok … #n），就把那個 scheme 固定到第一個**。
- 測試 `autonav2.js` 35 項全過。

### v1.1.462：結束收款後跳 55688
- 使用者需求：「結束行程如果是現金/刷卡/簽單的話，幫我跳轉到 55688，一樣要開關」。
- 設定面板（選單改名「🧭 跳轉 App」）分兩段：「開始行程後」（原功能）＋「結束收款後」開關 `maptrip_autonav_end`（預設關）。
- `recorder.finalizeSavedTrip` 存完車資後呼叫 `MaptripAutoNav.onTripEnd(paymentMethod)`：`decideEnd(on, visible, pm)`＝
  開關開＋前景＋pm∈{cash, card, voucher} 才跳；「其他」（skip 鈕）不跳；Android 浮窗背景存檔不跳（visible 擋）。
  延遲 500ms（存檔/toast 先跑）後 `launch('taxi55688')`，開法同開始（捷徑→候選 scheme→App Store）。
- 測試 `autonav2.js` 51 項（真車資對話框：現金/刷卡跳、開關關不跳、車資照存；其他/背景不跳；設定開關）全過。

### v1.1.463：結束段設計改成跟開始一樣
- 使用者：「跟開始一樣，結束行程後是否要開啟跳轉一個開關、跳轉到哪一個 App 一個開關」。
- 設定面板：「開始行程後」＝總開關＋各 App 開關；「結束收款後（現金／刷卡／簽單）」＝總開關（`maptrip_autonav_end`）＋
  各 App 開關（`maptrip_autonav_apps.end`，**預設只開 55688**）；最下方「55688 開啟方式」捷徑名稱（兩段共用）。
- `appOn/setAppOn/enabledApps/openPicker` 加 `phase` 參數（'start' 預設／'end'）；`decideEnd(on,visible,pm,n)` 回
  'none'|'direct'|'pick'（沿用 decide）；結束開 ≥2 個 App → 「收款完成！」選單。
- 測試 `autonav2.js` 61 項全過（含結束 2 個 App 走真車資對話框→選單→選 Google、兩段開關互不影響）。
  注意 `?test` 模式的 probe 除錯浮層會擋 Playwright 點擊，測試裡用 addStyleTag 藏起來。

### v1.1.464：主頁右上角快捷鈕＋Uber＋自訂 App
- 使用者：「在主頁的右上角幫我加上跳轉 Google map 和我指定的 App（如 55688、Uber 等等）」。
- `autonav.js renderBar()`：在 `#top-actions`（🔄☰）最前面插 `#an-bar`，每個開著的 App 一顆 `.icon-btn` 色塊字標
  （55688＝黃底 55、Google＝藍底 G、Uber＝黑底 U、Apple＝綠底 A、自訂＝灰底首字），點一下 `launch(id)`（點擊當下開）。
  開關 `maptrip_autonav_apps.bar`，預設 55688／Google／Uber 開。
- **Uber 司機版**：`uberdriver://`（常見 scheme、非官方文件）→ 後備 App Store 搜尋「Uber Driver」；可填捷徑名稱。
- **自訂 App**：設定面板最下方「＋ 新增其他 App」＝顯示名稱＋iPhone 捷徑名稱（`prefs.custom` + `prefs.sc`），新增後預設上右上角，
  也會出現在開始/結束清單（預設關）；可刪除（連帶清 on/end/bar/sc）。
- **版面**：`_fitBar` 放不下先 `an-tight` 縮小按鈕/間距，還不行就從尾端藏；`#top-date/#top-tripcount` nowrap。
  390 寬實測放 3 顆、430 寬放 4 顆、375 寬 3 顆。日期/趟數開機後才填 → MutationObserver 盯 `#top-left` 重量＋開機後 1.5s/4s 再量。
- 測試 `autonavbar.js` 32 項（預設 3 顆、點擊開對的 App、設定即時增減、自訂 App 新增/捷徑/重開仍在/刪除、375/390/430 不溢出、
  趟數變 12 仍不溢出、全關不顯示）＋`autonav2.js` 61 項回歸全過，零 pageerror。
