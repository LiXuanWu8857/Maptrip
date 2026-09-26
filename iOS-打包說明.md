# Maptrip iOS App 打包說明

把 Maptrip 包成 iPhone 原生 App，**仍然從 GitHub Pages 遠端載入網頁**。
所以你之後改 code、push 到 `gh-pages`，App 一打開就是最新版，**不用重新打包**。

背景定位由原生外掛處理：鎖屏、切到 55688 導航時，仍能持續記錄路線。

---

## 一次性設定（在 Mac 上做，約 20 分鐘）

### 1. 安裝工具
- **Xcode**（App Store 下載，免費）
- **Node.js**（https://nodejs.org，下載 LTS 版）
- 開啟「終端機」(Terminal)

### 2. 取得專案並安裝套件
```bash
git clone https://github.com/lixuanwu8857/Maptrip.git
cd Maptrip
git checkout gh-pages
npm install
```

### 3. 產生 iOS 專案
```bash
npx cap add ios
npx cap sync ios
```

### 4. 在 Xcode 設定權限（重要）
```bash
npx cap open ios
```
Xcode 開啟後：

**(a) 加入定位權限說明** — 點左側 `App` → `Info` 分頁，新增三筆：

| Key | 值（說明文字，會顯示給使用者看）|
|-----|------|
| `Privacy - Location When In Use Usage Description` | Maptrip 需要定位來記錄你的行程路線 |
| `Privacy - Location Always and When In Use Usage Description` | Maptrip 需要在背景持續記錄你的行程路線 |
| `Privacy - Location Always Usage Description` | Maptrip 需要在背景持續記錄你的行程路線 |

**(b) 開啟背景模式** — 點 `Signing & Capabilities` 分頁 →
左上 `+ Capability` → 加入 **Background Modes** →
勾選 **Location updates**。

**(c) 設定簽署** — 一樣在 `Signing & Capabilities`：
- `Team` 選你的 Apple ID（沒有的話點 `Add an Account` 用你的 Apple ID 登入，免費）
- `Bundle Identifier` 改成獨一無二的，例如 `com.你的名字.maptrip`

### 5. 裝到 iPhone
- iPhone 用線接上 Mac（第一次要在 iPhone 上點「信任這台電腦」）
- Xcode 左上選擇你的 iPhone 當目標裝置
- 按 ▶ (Run)
- 第一次裝完，到 iPhone：設定 → 一般 → VPN 與裝置管理 → 信任你的開發者憑證
- App 開啟後，定位權限請選 **「永遠允許」**（背景記錄才有效）

---

## 之後要更新 App 內容

**完全不用碰 Mac**。照舊在這邊改 code、push 到 `gh-pages`，
App 下次開啟就是最新版（因為它是遠端載入 GitHub Pages）。

只有以下情況才需要回到 Mac 重跑 `npx cap sync ios` 並重新 Run：
- 換了原生外掛 / 改了 `capacitor.config.json`
- 改了權限設定

---

## 免費 Apple ID 的限制
- 用免費 Apple ID 簽署，App **每 7 天會過期**，要重接 Mac 按一次 Run 重簽。
- 想免除這限制（一年免重簽、或日後上架 App Store），需 Apple 開發者帳號（每年 US$99）。

---

## 常見問題
- **開啟 App 一直停在「正在載入」** → 檢查手機網路；server.url 指向 GitHub Pages。
- **沒跳出定位權限 / 背景沒記錄** → 確認步驟 4 的權限與背景模式都設好，且權限選了「永遠允許」。
- **要改載入的網址** → 編輯 `capacitor.config.json` 的 `server.url`，再 `npx cap sync ios`。
