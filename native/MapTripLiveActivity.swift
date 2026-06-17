// ⚠️ 此檔案只加入「Widget Extension target」，不要加入主 App

import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - 格式化輔助

private func fmtTime(_ s: Int) -> String {
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0
        ? String(format: "%d:%02d:%02d", h, m, sec)
        : String(format: "%02d:%02d", m, sec)
}

private func fmtDist(_ m: Int) -> String {
    m >= 1000
        ? String(format: "%.1f km", Double(m) / 1000.0)
        : "\(m) m"
}

// MARK: - 按鈕外觀（純視覺 Label，不包 Link/Button）
// 點擊由整個方塊的 .widgetURL() 處理：鎖屏 Live Activity 會把整塊當成一個點擊區，
// Link 在這裡常收不到 tap，故改用 widgetURL —— 點任何地方都帶 maptrip:// 開 App。

private let startURL = URL(string: "maptrip://start")
private let endURL   = URL(string: "maptrip://end")

@ViewBuilder
private func startButton(fullWidth: Bool = false) -> some View {
    Label("開始行程", systemImage: "play.fill")
        .font(.callout.bold())
        .padding(.vertical, 8)
        .padding(.horizontal, fullWidth ? 0 : 14)
        .frame(maxWidth: fullWidth ? .infinity : nil)
        .background(Color.blue).foregroundStyle(.white).clipShape(Capsule())
}

@ViewBuilder
private func endButton(fullWidth: Bool = false) -> some View {
    Label("結束行程", systemImage: "checkmark.circle.fill")
        .font(.callout.bold())
        .padding(.vertical, 8)
        .padding(.horizontal, fullWidth ? 0 : 14)
        .frame(maxWidth: fullWidth ? .infinity : nil)
        .background(Color.red).foregroundStyle(.white).clipShape(Capsule())
}

// MARK: - 鎖屏 Banner 畫面

struct MapTripLockScreen: View {
    let state: MapTripAttributes.ContentState

    var body: some View {
        HStack(spacing: 16) {
            if state.isRecording {
                VStack(alignment: .leading, spacing: 2) {
                    Label("記錄中", systemImage: "record.circle.fill")
                        .font(.caption).foregroundStyle(.red)
                    Text(fmtTime(state.elapsedSeconds))
                        .font(.system(.title2, design: .monospaced).bold())
                        .monospacedDigit()
                    Text(fmtDist(state.distanceMeters))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                endButton()
            } else {
                Label("Maptrip", systemImage: "car.fill").font(.headline)
                Spacer()
                startButton()
            }
        }
        .padding()
        .activityBackgroundTint(Color(.systemBackground))
        // 點整個方塊任何地方 → 帶對應 URL 開 App（記錄中→end、閒置→start）
        .widgetURL(state.isRecording ? endURL : startURL)
    }
}

// MARK: - Widget 設定（含 Dynamic Island）

struct MapTripLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MapTripAttributes.self) { context in
            // 內容過期（App 已完全關閉、無人續命）→ 收成空白，鎖屏方塊自然消失
            if context.isStale {
                EmptyView()
            } else {
                MapTripLockScreen(state: context.state)
            }
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    if context.state.isRecording {
                        Label(fmtTime(context.state.elapsedSeconds),
                              systemImage: "record.circle.fill")
                            .foregroundStyle(.red)
                            .font(.system(.body, design: .monospaced))
                            .monospacedDigit()
                    } else {
                        Label("Maptrip", systemImage: "car.fill")
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.isRecording {
                        Text(fmtDist(context.state.distanceMeters)).font(.headline)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if context.state.isRecording {
                        endButton(fullWidth: true)
                    } else {
                        startButton(fullWidth: true)
                    }
                }
            } compactLeading: {
                Image(systemName: context.state.isRecording
                      ? "record.circle.fill" : "car.fill")
                    .foregroundStyle(context.state.isRecording ? .red : .blue)
            } compactTrailing: {
                if context.state.isRecording {
                    Text(fmtTime(context.state.elapsedSeconds))
                        .font(.system(.caption2, design: .monospaced))
                        .monospacedDigit()
                }
            } minimal: {
                Image(systemName: context.state.isRecording
                      ? "record.circle.fill" : "car.fill")
                    .foregroundStyle(context.state.isRecording ? .red : .blue)
            }
            // 點 Dynamic Island（精簡/展開/最小）任何地方 → 帶對應 URL 開 App
            .widgetURL(context.state.isRecording ? endURL : startURL)
        }
    }
}
