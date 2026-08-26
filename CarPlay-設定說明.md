# CarPlay 設定說明

CarPlay 在車機螢幕顯示「開始 / 結束行程」按鈕（Apple 原生版型，非 WebView）。
功能與鎖屏 widget 一致：按下 → 通知 App 開始/結束記錄。

> ⚠️ 樣式限制：CarPlay 只能用 Apple 提供的固定版型（`CPInformationTemplate`），
> **無法**做成 iPhone 靈動島那種自訂藥丸外觀。iPhone 螢幕上的靈動島 Live Activity
> 接 CarPlay 時仍正常顯示，那部分不受影響。

---

## 已加入的程式碼（native/）

| 檔案 | 變更 |
|------|------|
| `CarPlaySceneDelegate.swift` | **新檔**：CarPlay 介面（資訊卡 + 開始/結束按鈕） |
| `AppDelegate.swift` | 新增 `configurationForConnecting`，把 CarPlay 場景指向上面的 delegate |
| `MapTripIntents.swift` | 新增 `mapTripDispatchCommand()` 共用派送、`.mapTripStateChanged` 通知 |
| `LiveActivityPlugin.swift` | `upsertActivity` 廣播狀態 → CarPlay 即時更新里程/按鈕 |

把這些檔案複製到 Xcode 專案（覆蓋同名檔），`CarPlaySceneDelegate.swift` 記得加入
**App target**（File Inspector → Target Membership 勾 App）。

---

## Xcode 需要做的三件事

### 1. 加入 CarPlay Entitlement

`App/App.entitlements` 加入（用「適合行車的任務」類別，可放開始/結束按鈕）：

```xml
<key>com.apple.developer.carplay-driving-task</key>
<true/>
```

> ❗ **重要**：CarPlay entitlement 需要先向 Apple 申請核可
> （https://developer.apple.com/contact/carplay/）。
> 免費／一般開發者帳號預設沒有這個權限，沒核可前 CarPlay 場景不會連上。
> 申請通過後，到 developer.apple.com 重新產生含此權限的 Provisioning Profile。

### 2. Info.plist 註冊 CarPlay 場景

`App/Info.plist` 加入（只註冊 CarPlay 場景；手機本體不放 window 場景，
維持原本 AppDelegate 的行為）：

```xml
<key>UIApplicationSceneManifest</key>
<dict>
    <key>UIApplicationSupportsMultipleScenes</key>
    <true/>
    <key>UISceneConfigurations</key>
    <dict>
        <key>CPTemplateApplicationSceneSessionRoleApplication</key>
        <array>
            <dict>
                <key>UISceneConfigurationName</key>
                <string>CarPlay</string>
                <key>UISceneDelegateClassName</key>
                <string>$(PRODUCT_MODULE_NAME).CarPlaySceneDelegate</string>
            </dict>
        </array>
    </dict>
</dict>
```

### 3. 重新 Build 安裝

接好線後在 Xcode 選你的 iPhone → ▶ Run。

---

## 測試（不用真的上車）

Xcode 內建 CarPlay 模擬器：
1. 跑模擬器後，選單 **I/O → External Displays → CarPlay**
2. 會跳出一個 CarPlay 畫面，可看到 Maptrip 的資訊卡與按鈕

---

## 若 CarPlay 沒出現

- entitlement 未核可 → 場景不會連線（最常見）
- Info.plist 的 `UISceneDelegateClassName` 模組名稱要對（`$(PRODUCT_MODULE_NAME)` 通常即可）
- `CarPlaySceneDelegate.swift` 沒加入 App target
