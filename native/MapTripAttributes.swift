// ⚠️ 此檔案必須同時加入「主 App target」和「Widget Extension target」
// File → Add Files，在 Target Membership 勾選兩個 target

import ActivityKit
import Foundation

struct MapTripAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var isRecording: Bool
        var elapsedSeconds: Int
        var distanceMeters: Int
    }
}
