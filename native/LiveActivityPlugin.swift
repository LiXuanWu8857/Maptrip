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
        CAPPluginMethod(name: "endTrip",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "heartbeat",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePendingCommand", returnType: CAPPluginReturnPromise)
    ]

    // 方塊過期時間：App 活著時持續往後推；App 一死沒人推，過期後鎖屏畫面收成空白
    private let staleWindow: TimeInterval = 30

    // 用 Any? 儲存，避免 @available 標記汙染整個 class
    private var currentActivity: Any?

    // 最後一次的狀態，供 heartbeat 重新推送（刷新 staleDate 用）
    private var lastIsRecording = false
    private var lastElapsed = 0
    private var lastDistance = 0

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
        // 已即時處理，清掉暫存避免下次開機重複觸發
        UserDefaults.standard.removeObject(forKey: kMapTripPendingCommand)
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
    /// 每次都先清除所有舊方塊，確保鎖屏顯示的是這次 build 的版本（含最新 AppIntent 按鈕）
    @objc func initActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve(["enabled": false, "started": false, "error": "iOS < 16.2"])
            return
        }
        let enabled = ActivityAuthorizationInfo().areActivitiesEnabled
        Task {
            for old in Activity<MapTripAttributes>.activities {
                await old.end(nil, dismissalPolicy: .immediate)
            }
            currentActivity = nil
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
            await self.upsertActivity(isRecording: true, elapsed: elapsed, distance: distance)
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

    /// 由 JS 定期呼叫（前景計時器 + 背景 GPS 回呼）：重推最後狀態以刷新 staleDate，
    /// 讓方塊在 App 活著時持續續命；App 一死即停止續命，過期後自動消失。
    @objc func heartbeat(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(); return }
        Task {
            await self.upsertActivity(isRecording: lastIsRecording,
                                      elapsed: lastElapsed, distance: lastDistance)
            call.resolve()
        }
    }

    /// 開機補做：App 曾被完全關閉時按下的鎖屏指令，存在 UserDefaults，這裡取出並清除
    @objc func consumePendingCommand(_ call: CAPPluginCall) {
        let cmd = UserDefaults.standard.string(forKey: kMapTripPendingCommand) ?? ""
        UserDefaults.standard.removeObject(forKey: kMapTripPendingCommand)
        call.resolve(["action": cmd])
    }

    // MARK: - 私有實作

    /// 建立或更新 Live Activity；每次都帶新的 staleDate。回傳 nil 表示成功。
    @available(iOS 16.2, *)
    @discardableResult
    private func upsertActivity(isRecording: Bool, elapsed: Int, distance: Int) async -> String? {
        lastIsRecording = isRecording
        lastElapsed = elapsed
        lastDistance = distance

        let state = MapTripAttributes.ContentState(
            isRecording: isRecording,
            elapsedSeconds: elapsed,
            distanceMeters: distance
        )
        let content = ActivityContent(state: state,
                                      staleDate: Date().addingTimeInterval(staleWindow))

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
}
