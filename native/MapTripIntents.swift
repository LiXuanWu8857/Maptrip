// ⚠️ 此檔案必須同時加入「主 App target」和「Widget Extension target」
// （Widget 需要它來建立按鈕；App 需要它讓 perform() 在 App 程序內執行 + 廣播指令）

import AppIntents
import Foundation

extension Notification.Name {
    static let mapTripCommand = Notification.Name("MapTripCommand")
}

// 開始行程：在 App 背景執行（不開啟 App），因為背景定位讓 JS 持續執行
@available(iOS 17.0, *)
struct MapTripStartIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "開始行程"
    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: .mapTripCommand, object: nil,
                                        userInfo: ["action": "start"])
        return .result()
    }
}

// 結束行程：先把 App 帶到前景，再廣播指令，讓使用者能輸入金額
@available(iOS 17.0, *)
struct MapTripEndIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "結束行程"
    static var openAppWhenRun: Bool = true
    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: .mapTripCommand, object: nil,
                                        userInfo: ["action": "end"])
        return .result()
    }
}
