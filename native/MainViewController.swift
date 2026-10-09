// ⚠️ 此檔案只加入「主 App target（App）」
// Capacitor 6：app 內建插件不會自動註冊，需在此明確註冊。
// 主視窗由 SceneDelegate 以程式碼建立（無 Main.storyboard）。

import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {

    private var hasBeenBackgrounded = false // 真的離開過背景才做死活檢查

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
    }

    // 鎖定直向保險（與 AppDelegate 的全域鎖一起）
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var shouldAutorotate: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        // 關閉自動內距，改由網頁 CSS 的 env(safe-area-inset-*) 處理頂/底留白。
        // 頂/底 safe-area 由網頁端量測式修正（index.html）處理，這裡不做冷啟動重載。
        webView?.scrollView.contentInsetAdjustmentBehavior = .never

        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(reloadWebViewIfDead),
            name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc private func appDidEnterBackground() { hasBeenBackgrounded = true }

    // 只在「離開過背景又回來」時檢查網頁是否被系統砍掉；冷啟動／載入中一律不碰。
    @objc private func reloadWebViewIfDead() {
        guard hasBeenBackgrounded else { return }
        hasBeenBackgrounded = false
        guard let wv = webView else { return }
        if wv.isLoading { return }
        wv.evaluateJavaScript("typeof window.INDEX_VERSION") { result, error in
            if error != nil || (result as? String) != "string" {
                wv.reload()
            }
        }
    }
}
