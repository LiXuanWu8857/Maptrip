// ⚠️ 此檔案只加入「主 App target（App）」
// Capacitor 6：app 內建插件不會自動註冊，需在此明確註冊。
// 還要把 Main.storyboard 的 View Controller「Custom Class」改成 MainViewController。

import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
    }
}
