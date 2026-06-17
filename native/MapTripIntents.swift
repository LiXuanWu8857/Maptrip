// ⚠️ 此檔案必須同時加入「主 App target」和「Widget Extension target」

import AppIntents
import Foundation

extension Notification.Name {
    static let mapTripCommand = Notification.Name("MapTripCommand")
    static let mapTripUrl     = Notification.Name("MapTripUrl")
}

let kMapTripPendingCommand     = "MapTripPendingCommand"
let kMapTripPendingCommandTime = "MapTripPendingCommandTime"

// Darwin 跨行程通知名稱（不需要 App Group；系統全域，widget extension → main app 直達）
private let kDarwinStart = "com.maptrip.widget.start"
private let kDarwinEnd   = "com.maptrip.widget.end"

private func dispatchCommand(_ action: String) {
    // 1) Darwin 跨行程通知（主路徑：無論 perform() 在哪個 process 執行都能送到 main app）
    let darwinName = (action == "end") ? kDarwinEnd : kDarwinStart
    CFNotificationCenterPostNotification(
        CFNotificationCenterGetDarwinNotifyCenter(),
        CFNotificationName(darwinName as CFString),
        nil, nil, true
    )
    // 2) 同行程廣播（若 perform() 恰好在 main app process 執行也能即時收到）
    NotificationCenter.default.post(name: .mapTripCommand, object: nil,
                                    userInfo: ["action": action])
    // 3) UserDefaults 備份（冷啟動補做；僅在 perform() 於主程序執行時有效）
    UserDefaults.standard.set(action, forKey: kMapTripPendingCommand)
    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: kMapTripPendingCommandTime)
}

@available(iOS 17.0, *)
struct MapTripStartIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "開始行程"
    static var openAppWhenRun: Bool = true
    func perform() async throws -> some IntentResult {
        dispatchCommand("start")
        return .result()
    }
}

@available(iOS 17.0, *)
struct MapTripEndIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "結束行程"
    static var openAppWhenRun: Bool = true
    func perform() async throws -> some IntentResult {
        dispatchCommand("end")
        return .result()
    }
}
