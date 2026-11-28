// ⚠️ 此檔案只加入「主 App target（App）」
//
// CarPlay 介面：車機螢幕顯示「開始 / 結束行程」的資訊卡（CPInformationTemplate）。
// CarPlay 不能放 WebView，只能用 Apple 的原生版型，故樣式無法做成靈動島藥丸外觀，
// 但功能與鎖屏 widget 一致：按下按鈕 → 走 mapTripDispatchCommand() → 通知 JS 開始/結束。
//
// 需求（在 Xcode 設定，見專案說明）：
//   1. App target 加入 CarPlay entitlement：com.apple.developer.carplay-driving-task = YES
//   2. Info.plist 加入 UIApplicationSceneManifest，註冊 CarPlay 場景指向本類別
//   3. 本檔加入 App target
//
// 狀態同步：LiveActivityPlugin 每次 upsertActivity 會發 .mapTripStateChanged，
// 這裡接住後更新車機畫面（按鈕文字、里程/時間）。

import Foundation
import CarPlay

@available(iOS 14.0, *)
class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {

    private var interfaceController: CPInterfaceController?
    private var infoTemplate: CPInformationTemplate?

    // 目前行程狀態（由 .mapTripStateChanged 更新）
    private var isRecording = false
    private var elapsed = 0
    private var distance = 0

    // MARK: - 場景連線/中斷

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController
        let template = buildTemplate()
        self.infoTemplate = template
        interfaceController.setRootTemplate(template, animated: false, completion: nil)

        // 監聽 JS 端狀態變化
        NotificationCenter.default.addObserver(
            self, selector: #selector(onStateChanged(_:)),
            name: .mapTripStateChanged, object: nil)
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        NotificationCenter.default.removeObserver(self, name: .mapTripStateChanged, object: nil)
        self.interfaceController = nil
        self.infoTemplate = nil
    }

    // MARK: - 狀態更新

    @objc private func onStateChanged(_ note: Notification) {
        guard let info = note.userInfo else { return }
        isRecording = (info["isRecording"] as? Bool) ?? isRecording
        elapsed     = (info["elapsed"] as? Int) ?? elapsed
        distance    = (info["distance"] as? Int) ?? distance
        DispatchQueue.main.async { [weak self] in self?.refresh() }
    }

    private func refresh() {
        guard let t = infoTemplate else { return }
        t.items = buildItems()
        t.actions = buildActions()
    }

    // MARK: - 版型建構

    private func buildTemplate() -> CPInformationTemplate {
        return CPInformationTemplate(
            title: "Maptrip",
            layout: .leading,
            items: buildItems(),
            actions: buildActions()
        )
    }

    private func buildItems() -> [CPInformationItem] {
        if isRecording {
            return [
                CPInformationItem(title: "狀態", detail: "記錄中"),
                CPInformationItem(title: "時間", detail: fmtElapsed(elapsed)),
                CPInformationItem(title: "里程", detail: fmtDist(distance))
            ]
        } else {
            return [
                CPInformationItem(title: "狀態", detail: "尚未開始"),
                CPInformationItem(title: "提示", detail: "點下方按鈕開始記錄行程")
            ]
        }
    }

    private func buildActions() -> [CPTextButton] {
        if isRecording {
            let end = CPTextButton(title: "結束行程", textStyle: .cancel) { [weak self] _ in
                self?.handleTap("end")
            }
            return [end]
        } else {
            let start = CPTextButton(title: "開始行程", textStyle: .confirm) { [weak self] _ in
                self?.handleTap("start")
            }
            return [start]
        }
    }

    private func handleTap(_ action: String) {
        // 與鎖屏 widget 相同的派送路徑：寫 UserDefaults + 廣播通知，
        // App 在前景時 JS 立即反應；在背景時下次回前景由 consumePendingCommand 補做。
        mapTripDispatchCommand(action)
        // 樂觀更新車機畫面（JS 確認後 .mapTripStateChanged 會再校正一次）
        isRecording = (action == "start")
        if action == "start" { elapsed = 0; distance = 0 }
        refresh()
    }

    // MARK: - 格式化

    private func fmtElapsed(_ sec: Int) -> String {
        String(format: "%02d:%02d", sec / 60, sec % 60)
    }

    private func fmtDist(_ m: Int) -> String {
        m >= 1000 ? String(format: "%.1f 公里", Double(m) / 1000.0) : "\(m) 公尺"
    }
}
