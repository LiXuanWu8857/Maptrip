// ⚠️ 此檔案只加入「主 App target（App）」
// 手機主視窗用 scene 生命週期建立：window 一定附著在 UIWindowScene 上，
// WKWebView 才拿得到正確的繪圖/裝置 context（否則 CARenderServer 失敗＝黑畫面）。
// 不依賴 Main.storyboard（已遺失），root VC 直接程式碼建立。

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = MainViewController()
        self.window = window
        window.makeKeyAndVisible()
    }
}
