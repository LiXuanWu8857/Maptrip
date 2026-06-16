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
    }
}
