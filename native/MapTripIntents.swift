// ⚠️ 此檔案必須同時加入「主 App target」和「Widget Extension target」
// （Widget 需要它來建立按鈕；App 需要它讓 perform() 在 App 程序內執行 + 廣播指令）

import AppIntents
import Foundation

extension Notification.Name {
    static let mapTripCommand = Notification.Name("MapTripCommand")
    static let mapTripUrl     = Notification.Name("MapTripUrl")
}

// 鎖屏指令的暫存 key。⚠️ perform() 實際在「Widget Extension 程序」執行，
// 它的 UserDefaults.standard 與主 App 不同步，所以必須用 App Group 共享容器，
// 主 App（含 LiveActivityPlugin）才讀得到，且冷啟動也不會遺失。
let kAppGroup = "group.com.maptrip.app"
let kMapTripPendingCommand = "MapTripPendingCommand"
// 指令時間戳：避免卡住的舊指令在很久後正常開 App 時被誤觸發
let kMapTripPendingCommandTime = "MapTripPendingCommandTime"

private func dispatchCommand(_ action: String) {
    // 1) 寫進 App Group 共享容器（跨行程、冷啟動都讀得到）；取不到時退回 standard
    let defaults = UserDefaults(suiteName: kAppGroup) ?? .standard
    defaults.set(action, forKey: kMapTripPendingCommand)
    defaults.set(Date().timeIntervalSince1970, forKey: kMapTripPendingCommandTime)
    // 2) 即時廣播：App 已在背景執行時、同行程的 JS 立刻收到
    NotificationCenter.default.post(name: .mapTripCommand, object: nil,
                                    userInfo: ["action": action])
}

// 開始行程：開啟 App 並自動開始記錄（記錄邏輯在 WebView/JS，需 App 前景才能可靠執行）
@available(iOS 17.0, *)
struct MapTripStartIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "開始行程"
    static var openAppWhenRun: Bool = true
    func perform() async throws -> some IntentResult {
        dispatchCommand("start")
        return .result()
    }
}

// 結束行程：先把 App 帶到前景，再廣播指令，讓使用者能輸入金額
@available(iOS 17.0, *)
struct MapTripEndIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "結束行程"
    static var openAppWhenRun: Bool = true
    func perform() async throws -> some IntentResult {
        dispatchCommand("end")
        return .result()
    }
}
