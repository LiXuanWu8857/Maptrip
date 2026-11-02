// ⚠️ 此檔案必須同時加入「主 App target」和「Widget Extension target」

import AppIntents
import Foundation

extension Notification.Name {
    static let mapTripCommand = Notification.Name("MapTripCommand")
    static let mapTripUrl     = Notification.Name("MapTripUrl")
    // JS 端行程狀態變化（開始/更新/結束）→ 廣播給 CarPlay 更新畫面
    static let mapTripStateChanged = Notification.Name("MapTripStateChanged")
}

let kAppGroup                  = "group.com.maptrip.app"
let kMapTripPendingCommand     = "MapTripPendingCommand"
let kMapTripPendingCommandTime = "MapTripPendingCommandTime"
let kMapTripPerformProcess     = "MapTripPerformProcess"   // 診斷：perform() 跑在哪個 process

private let kDarwinStart = "com.maptrip.widget.start"
private let kDarwinEnd   = "com.maptrip.widget.end"

// 對外共用：CarPlay 按鈕也走這條，與鎖屏 widget 完全相同的指令派送路徑。
func mapTripDispatchCommand(_ action: String) {
    dispatchCommand(action)
}

// 診斷版：perform() 同時往「四個地方」寫/送，App 啟動時逐一回報哪個有效。
private func dispatchCommand(_ action: String) {
    let now  = Date().timeIntervalSince1970
    let proc = ProcessInfo.processInfo.processName   // 判斷 perform() 在 widget 還是 app 程序

    // 1) 標準 UserDefaults（只有 perform() 在「主 App 程序」執行時，主程序才讀得到）
    let std = UserDefaults.standard
    std.set(action, forKey: kMapTripPendingCommand)
    std.set(now,    forKey: kMapTripPendingCommandTime)
    std.set(proc,   forKey: kMapTripPerformProcess)

    // 2) App Group 共享容器（若免費帳號真的能用，主程序就讀得到 —— 這次要驗證清楚）
    if let grp = UserDefaults(suiteName: kAppGroup) {
        grp.set(action, forKey: kMapTripPendingCommand)
        grp.set(now,    forKey: kMapTripPendingCommandTime)
        grp.set(proc,   forKey: kMapTripPerformProcess)
    }

    // 3) Darwin 跨行程通知（App 還活著時即時送達）
    let darwinName = (action == "end") ? kDarwinEnd : kDarwinStart
    CFNotificationCenterPostNotification(
        CFNotificationCenterGetDarwinNotifyCenter(),
        CFNotificationName(darwinName as CFString),
        nil, nil, true
    )

    // 4) 同行程廣播（perform() 恰在主程序時即時送達）
    NotificationCenter.default.post(name: .mapTripCommand, object: nil,
                                    userInfo: ["action": action])
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
