// ⚠️ 此檔案只加入「主 App target（App）」，不要加入 Widget Extension
// Capacitor 6：用 CAPBridgedPlugin 協定自我註冊，不需要 .m 檔

import Foundation
import UIKit
import Capacitor
import ActivityKit

@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {

    // CAPBridgedPlugin 必要屬性：向 Capacitor 註冊外掛名稱與方法
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTrip",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateTrip",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endTrip",      returnType: CAPPluginReturnPromise)
    ]

    // 用 Any? 儲存，避免 @available 標記汙染整個 class
    private var currentActivity: Any?

    // 插件載入時：監聽鎖屏按鈕的指令、以及 App 終止事件
    override public func load() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(onMapTripCommand(_:)),
            name: .mapTripCommand, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(onWillTerminate),
            name: UIApplication.willTerminateNotification, object: nil)
    }

    // 收到鎖屏 App Intent 指令 → 轉給 JS（JS 因背景定位仍在執行）
    @objc private func onMapTripCommand(_ note: Notification) {
        let action = (note.userInfo?["action"] as? String) ?? ""
        DispatchQueue.main.async {
            self.notifyListeners("liveActivityCommand", data: ["action": action])
        }
    }

    // App 被完全關閉時，結束 Live Activity，避免鎖屏方塊殘留
    @objc private func onWillTerminate() {
        guard #available(iOS 16.2, *),
              let act = currentActivity as? Activity<MapTripAttributes> else { return }
        let sem = DispatchSemaphore(value: 0)
        Task { await act.end(nil, dismissalPolicy: .immediate); sem.signal() }
        _ = sem.wait(timeout: .now() + 1.0)
    }

    // MARK: - 公開 Plugin 方法

    /// App 啟動時呼叫：顯示閒置狀態的 Live Activity（「開始行程」按鈕）
    @objc func initActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve(["enabled": false, "started": false, "error": "iOS < 16.2"])
            return
        }
        let enabled = ActivityAuthorizationInfo().areActivitiesEnabled
        Task {
            let err = await self.upsertActivity(isRecording: false, elapsed: 0, distance: 0)
            call.resolve([
                "enabled": enabled,
                "started": err == nil,
                "error": err ?? ""
            ])
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

    /// 回傳 nil 表示成功，否則回傳錯誤字串（供診斷用）
    @available(iOS 16.2, *)
    @discardableResult
    private func upsertActivity(isRecording: Bool, elapsed: Int, distance: Int) async -> String? {
        let state = MapTripAttributes.ContentState(
            isRecording: isRecording,
            elapsedSeconds: elapsed,
            distanceMeters: distance
        )
        let content = ActivityContent(state: state, staleDate: nil)

        if let act = currentActivity as? Activity<MapTripAttributes> {
            await act.update(content)
            return nil
        } else {
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                return "Live Activities 未啟用"
            }
            do {
                let act = try Activity.request(
                    attributes: MapTripAttributes(),
                    content: content,
                    pushType: nil
                )
                currentActivity = act
                return nil
            } catch {
                print("[LiveActivity] request failed: \(error.localizedDescription)")
                return error.localizedDescription
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
