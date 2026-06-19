# Maptrip Android App 打包說明

把 Maptrip 包成 Android 原生 App，**和 iOS 一樣從 GitHub Pages 遠端載入網頁**。
之後改 code、push 到 `gh-pages`，App 一打開就是最新版，**不用重新打包**。

背景定位由原生外掛（`@capacitor-community/background-geolocation`）處理：
鎖屏、切到導航 App 時，仍能持續記錄路線。

> 注意：iOS 的「鎖屏即時動態（Live Activity）」是 iOS 獨有功能，Android 沒有，
> 程式碼已自動略過，不影響 Android 其他功能。

---

## 一次性設定（約 30 分鐘）

可在 Windows / Mac / Linux 上做（Android 不限 Mac）。

### 1. 安裝工具
- **Android Studio**（https://developer.android.com/studio，免費，內含 Android SDK）
- **Node.js**（https://nodejs.org，下載 LTS 版）
- 第一次開 Android Studio 時，照精靈把預設 SDK、Platform-Tools 裝起來

### 2. 取得專案並安裝套件
```bash
git clone https://github.com/lixuanwu8857/Maptrip.git
cd Maptrip
git checkout gh-pages
npm install
```

### 3. 產生 Android 專案
```bash
npx cap add android
npx cap sync android
```

### 4. 加入權限（重要）
編輯 `android/app/src/main/AndroidManifest.xml`，在 `<manifest>` 標籤內、
`<application>` 之前加入：

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

背景定位外掛需要一個前景服務。在 `<application>` 標籤內加入：

```xml
<service
  android:name="com.equimaps.capacitor_background_geolocation.BackgroundGeolocationService"
  android:foregroundServiceType="location" />
```

### 4.5 鎖定文字縮放（重要，否則字會跟系統字體放大）

Android WebView 預設會跟著手機「設定 → 顯示 → 字體大小」放大網頁文字，
導致版面爆大、換行（iPhone 不會這樣）。在 `MainActivity` 鎖死 100%，
讓 App 字級固定、與 iPhone 一致。

開啟 `android/app/src/main/java/com/maptrip/app/MainActivity.java`，
整檔內容改成：

```java
package com.maptrip.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onStart() {
        super.onStart();
        // 鎖定網頁文字縮放為 100%，不跟隨系統字體大小（與 iPhone 一致）
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setTextZoom(100);
        }
    }
}
```

改完按綠色 ▶ 重新 Run 一次即生效。此為一次性原生設定，之後改網頁不用再動。

### 5. 在手機上開啟開發者模式
- 手機：設定 → 關於手機 → 連點「版本號碼」7 下 → 開啟「開發人員選項」
- 開發人員選項裡 → 開啟「USB 偵錯」

### 6. 裝到手機
```bash
npx cap open android
```
Android Studio 開啟後：
- 手機用線接上電腦（第一次會跳「允許 USB 偵錯」，按允許）
- 上方裝置下拉選你的手機
- 按綠色 ▶ (Run)
- App 開啟後，定位權限請選 **「一律允許」**（背景記錄才有效；
  Android 11+ 會分兩段問，第二段要手動到設定改成「一律允許」）

---

## 之後要更新 App 內容

**完全不用碰 Android Studio**。照舊在這邊改 code、push 到 `gh-pages`，
App 下次開啟就是最新版（因為它是遠端載入 GitHub Pages）。

只有以下情況才需要回到 Android Studio 重跑 `npx cap sync android` 並重新 Run：
- 換了原生外掛 / 改了 `capacitor.config.json`
- 改了 `AndroidManifest.xml` 權限設定

---

## 產生可分享的 APK（不用每次接電腦）

在 Android Studio：`Build` → `Build Bundle(s) / APK(s)` → `Build APK(s)`。
完成後產生的 `app-debug.apk` 可直接傳到別的 Android 手機安裝
（對方需先在設定允許「安裝未知來源 App」）。

想上架 Google Play，需 Google Play 開發者帳號（一次性 US$25）並改用簽署過的
AAB（`Build` → `Generate Signed Bundle / APK`）。

---

## 常見問題
- **開啟 App 一直停在白畫面 / 載入中** → 檢查手機網路；`capacitor.config.json`
  的 `server.url` 要指向 GitHub Pages 且為 https。
- **沒跳定位權限 / 背景沒記錄** → 確認步驟 4 權限都加了，且權限選「一律允許」。
- **Gradle 第一次 build 很久** → 正常，會下載依賴，掛著等即可。
- **要改載入的網址** → 編輯 `capacitor.config.json` 的 `server.url`，
  再 `npx cap sync android`。
