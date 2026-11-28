// ⚠️ 此檔案只加入「主 App target（App）」
// 手機視窗與 CarPlay 都走 scene 生命週期；scene→delegate 的對應由 Info.plist
// 的 UIApplicationSceneManifest 指定（Default→SceneDelegate、CarPlay→CarPlaySceneDelegate）。
// AppDelegate 本身不再持有/建立 window。

import UIKit
import Capacitor
import CarPlay   // .carTemplateApplication 由此框架提供

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    // 鎖定直向（禁止橫置）；CarPlay 車機不鎖
    func application(_ application: UIApplication,
                     supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        if window?.windowScene?.session.role == .carTemplateApplication { return .all }
        return .portrait
    }

    // 鎖屏 widget 的 maptrip:// 一鍵開始/結束
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        handleMapTripURL(url)
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    private func handleMapTripURL(_ url: URL) {
        guard url.scheme == "maptrip" else { return }
        let action = (url.host == "end") ? "end" : "start"
        let d = UserDefaults.standard
        d.set(action, forKey: "MapTripPendingCommand")
        d.set(Date().timeIntervalSince1970, forKey: "MapTripPendingCommandTime")
        NotificationCenter.default.post(
            name: NSNotification.Name("MapTripUrl"),
            object: nil,
            userInfo: ["url": url.absoluteString]
        )
    }
}
