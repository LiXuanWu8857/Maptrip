// ⚠️ 此檔案只加入「主 App target（App）」
// Capacitor 6：app 內建插件不會自動註冊，需在此明確註冊。
// 還要把 Main.storyboard 的 View Controller「Custom Class」改成 MainViewController。

import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // WKWebView 在 reload 後會重複套用安全區內距，導致頂端出現空白、
        // 首次載入時容器尺寸也算錯。關閉自動內距，改由 CSS 的 env() 處理。
        webView?.scrollView.contentInsetAdjustmentBehavior = .never

        // 背景時 iOS 可能把網頁行程砍掉（記憶體壓力）→ 回前景只剩白畫面，
        // 且網頁端 JS 已死、無法自救。回前景時檢查網頁是否還活著，死了就重載。
        NotificationCenter.default.addObserver(
            self, selector: #selector(reloadWebViewIfDead),
            name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc private func reloadWebViewIfDead() {
        guard let wv = webView else { return }
        // 行程被砍後 URL 可能歸 nil → 直接重載
        if wv.url == nil {
            wv.reload()
            return
        }
        // 用「App 一定會設定的全域變數」探測 JS 環境：
        // 網頁行程被砍後 WKWebView 會給一個空白的新環境，INDEX_VERSION 不存在 → 重載
        wv.evaluateJavaScript("typeof window.INDEX_VERSION") { result, error in
            if error != nil || (result as? String) != "string" {
                wv.reload()
            }
        }
    }
}
