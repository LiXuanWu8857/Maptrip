// ⚠️ 此檔案必須同時加入「主 App target」和「Widget Extension target」
// （Widget 需要它來建立按鈕；App 需要它讓 perform() 在 App 程序內執行 + 廣播指令）

import AppIntents
import Foundation

extension Notification.Name {
    static let mapTripCommand = Notification.Name("MapTripCommand")
}

// 鎖屏指令的暫存 key：LiveActivityIntent 的 perform() 會在「主 App 程序」內執行，
// 所以這裡寫進 UserDefaults.standard，App（含 LiveActivityPlugin）讀得到，
// 且即使 App 被完全關閉、冷啟動也不會遺失。
let kMapTripPendingCommand = "MapTripPendingCommand"

private func dispatchCommand(_ action: String) {
    // 1) 暫存指令：保證冷啟動 / JS 還沒就緒時不會漏掉
    UserDefaults.standard.set(action, forKey: kMapTripPendingCommand)
    // 2) 即時廣播：App 已在背景執行時，JS 立刻收到
    NotificationCenter.default.post(name: .mapTripCommand, object: nil,
                                    userInfo: ["action": action])
}

// 開始行程：不開啟 App，在背景執行（背景定位讓 App 程序持續存活）
@available(iOS 17.0, *)
struct MapTripStartIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "開始行程"
    static var openAppWhenRun: Bool = false
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
