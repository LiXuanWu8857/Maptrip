// ⚠️ 此檔案只加入「Widget Extension target」，不要加入主 App

import WidgetKit
import SwiftUI

@main
struct MapTripWidgetBundle: WidgetBundle {
    var body: some Widget {
        MapTripLiveActivity()
    }
}
