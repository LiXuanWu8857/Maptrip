// ⚠️ 此檔案只加入「主 App target（App）」，不要加入 Widget Extension

import Foundation
import Capacitor
import ActivityKit

@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin {

    // 用 Any? 儲存，避免 @available 標記汙染整個 class
    private var currentActivity: Any?

    // MARK: - 公開 Plugin 方法

    /// App 啟動時呼叫：顯示閒置狀態的 Live Activity（「開始行程」按鈕）
    @objc func initActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(); return }
        Task {
            await self.upsertActivity(isRecording: false, elapsed: 0, distance: 0)
            call.resolve()
        }
    }

    /// 行程開始時呼叫：切換到記錄中狀態
    @objc func startTrip(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(); return }
        Task {
            await self.upsertActivity(isRecording: true, elapsed: 0, distance: 0)
            call.resolve()
        }
    }

    /// 每秒由計時器呼叫：更新已過時間和里程
    @objc func updateTrip(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(); return }
        let elapsed  = call.getInt("elapsed")  ?? 0
        let distance = call.getInt("distance") ?? 0
        Task {
            await self.pushUpdate(elapsed: elapsed, distance: distance)
            call.resolve()
        }
    }

    /// 行程結束時呼叫：切回閒置狀態
    @objc func endTrip(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(); return }
        Task {
            await self.upsertActivity(isRecording: false, elapsed: 0, distance: 0)
            call.resolve()
        }
    }

    // MARK: - 私有實作

    @available(iOS 16.2, *)
    private func upsertActivity(isRecording: Bool, elapsed: Int, distance: Int) async {
        let state = MapTripAttributes.ContentState(
            isRecording: isRecording,
            elapsedSeconds: elapsed,
            distanceMeters: distance
        )
        let content = ActivityContent(state: state, staleDate: nil)

        if let act = currentActivity as? Activity<MapTripAttributes> {
            await act.update(content)
        } else {
            do {
                let act = try Activity.request(
                    attributes: MapTripAttributes(),
                    content: content,
                    pushType: nil
                )
                currentActivity = act
            } catch {
                print("[LiveActivity] request failed: \(error.localizedDescription)")
            }
        }
    }

    @available(iOS 16.2, *)
    private func pushUpdate(elapsed: Int, distance: Int) async {
        guard let act = currentActivity as? Activity<MapTripAttributes> else { return }
        let state = MapTripAttributes.ContentState(
            isRecording: true,
            elapsedSeconds: elapsed,
            distanceMeters: distance
        )
        let content = ActivityContent(state: state, staleDate: nil)
        await act.update(content)
    }
}
