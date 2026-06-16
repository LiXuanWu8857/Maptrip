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

// MARK: - 鎖屏 Banner 畫面

struct MapTripLockScreen: View {
    let state: MapTripAttributes.ContentState

    var body: some View {
        HStack(spacing: 16) {
            if state.isRecording {
                // 行程記錄中：左側顯示時間里程，右側顯示結束按鈕
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
                Link(destination: URL(string: "maptrip://end")!) {
                    Label("結束行程", systemImage: "checkmark.circle.fill")
                        .font(.callout.bold())
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Color.red)
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }
            } else {
                // 閒置：顯示開始行程按鈕
                Label("Maptrip", systemImage: "car.fill")
                    .font(.headline)
                Spacer()
                Link(destination: URL(string: "maptrip://start")!) {
                    Label("開始行程", systemImage: "play.fill")
                        .font(.callout.bold())
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Color.blue)
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }
            }
        }
        .padding()
        .activityBackgroundTint(Color(.systemBackground))
    }
}

// MARK: - Widget 設定（含 Dynamic Island）

struct MapTripLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MapTripAttributes.self) { context in
            MapTripLockScreen(state: context.state)
        } dynamicIsland: { context in
            DynamicIsland {
                // 展開狀態（長按動態島）
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
                        Text(fmtDist(context.state.distanceMeters))
                            .font(.headline)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if context.state.isRecording {
                        Link(destination: URL(string: "maptrip://end")!) {
                            Label("結束行程", systemImage: "checkmark.circle.fill")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(Color.red)
                                .foregroundStyle(.white)
                                .clipShape(Capsule())
                        }
                    } else {
                        Link(destination: URL(string: "maptrip://start")!) {
                            Label("開始行程", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(Color.blue)
                                .foregroundStyle(.white)
                                .clipShape(Capsule())
                        }
                    }
                }
            } compactLeading: {
                // 動態島壓縮左側
                Image(systemName: context.state.isRecording
                      ? "record.circle.fill" : "car.fill")
                    .foregroundStyle(context.state.isRecording ? .red : .blue)
            } compactTrailing: {
                // 動態島壓縮右側：記錄中顯示計時器
                if context.state.isRecording {
                    Text(fmtTime(context.state.elapsedSeconds))
                        .font(.system(.caption2, design: .monospaced))
                        .monospacedDigit()
                }
            } minimal: {
                // 動態島最小狀態（和另一個 App 共存時）
                Image(systemName: context.state.isRecording
                      ? "record.circle.fill" : "car.fill")
                    .foregroundStyle(context.state.isRecording ? .red : .blue)
            }
        }
    }
}
