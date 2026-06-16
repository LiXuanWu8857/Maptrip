// ⚠️ 此檔案必須同時加入「主 App target」和「Widget Extension target」
// （Widget 需要它來建立按鈕；App 需要它讓 perform() 在 App 程序內執行 + 廣播指令）

import AppIntents
import Foundation

extension Notification.Name {
    static let mapTripCommand = Notification.Name("MapTripCommand")
}

// LiveActivityIntent：按下鎖屏按鈕時在「App 程序」內背景執行，不會跳轉開 App。
// 因為 App 啟動後有背景定位讓程序持續存活，這裡發出的通知能被執行中的 JS 收到。
@available(iOS 17.0, *)
struct MapTripStartIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "開始行程"
    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: .mapTripCommand, object: nil,
                                        userInfo: ["action": "start"])
        return .result()
    }
}

@available(iOS 17.0, *)
struct MapTripEndIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "結束行程"
    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: .mapTripCommand, object: nil,
                                        userInfo: ["action": "end"])
        return .result()
    }
}
