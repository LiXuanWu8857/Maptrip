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

// MARK: - 互動按鈕
// iOS 17+：Button(intent:) → perform() → Darwin 通知 → main app → JS（不需 App Group）
// iOS 16：純視覺，僅靠整個方塊的 widgetURL 開 App（但 URL 不會被傳入，使用者要手動按 App 內的開始）

@ViewBuilder
private func startButton(fullWidth: Bool = false) -> some View {
    let label = Label("開始行程", systemImage: "play.fill")
        .font(.callout.bold())
        .padding(.vertical, 8)
        .padding(.horizontal, fullWidth ? 0 : 14)
        .frame(maxWidth: fullWidth ? .infinity : nil)
        .background(Color.blue).foregroundStyle(.white).clipShape(Capsule())
    if #available(iOS 17.0, *) {
        Button(intent: MapTripStartIntent()) { label }
    } else {
        label
    }
}

@ViewBuilder
private func endButton(fullWidth: Bool = false) -> some View {
    let label = Label("結束行程", systemImage: "checkmark.circle.fill")
        .font(.callout.bold())
        .padding(.vertical, 8)
        .padding(.horizontal, fullWidth ? 0 : 14)
        .frame(maxWidth: fullWidth ? .infinity : nil)
        .background(Color.red).foregroundStyle(.white).clipShape(Capsule())
    if #available(iOS 17.0, *) {
        Button(intent: MapTripEndIntent()) { label }
    } else {
        label
    }
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
        }
    }
}
