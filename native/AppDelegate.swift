// ⚠️ 此檔案只加入「主 App target（App）」
// 標準 Capacitor 模板 + 鎖屏 widget 的 maptrip:// URL 處理。

import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // 鎖屏 widget 的 maptrip:// （由 .widgetURL 觸發）在這裡接手。
        // 此 method 在「主 App 程序」執行 → 寫進 UserDefaults.standard，
        // 與 LiveActivityPlugin 同程序，consumePendingCommand 一定讀得到（免 App Group）。
        handleMapTripURL(url)
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: - 場景設定（僅為 CarPlay 提供場景；手機本體仍用上方 window 生命週期）
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if connectingSceneSession.role == .carTemplateApplication {
            let config = UISceneConfiguration(name: "CarPlay", sessionRole: connectingSceneSession.role)
            if #available(iOS 14.0, *) {
                config.delegateClass = CarPlaySceneDelegate.self
            }
            return config
        }
        // 其他（手機）場景：回傳預設設定，維持既有 AppDelegate window 行為
        return UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
    }

    // 把 widget 指令寫進主程序 UserDefaults，並即時廣播給 plugin（App 已在前景時用）
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
