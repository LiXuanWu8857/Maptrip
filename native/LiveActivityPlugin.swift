// ⚠️ 此檔案只加入「主 App target（App）」，不要加入 Widget Extension
// Capacitor 6：用 CAPBridgedPlugin 協定自我註冊，不需要 .m 檔

import Foundation
import UIKit
import Photos
import Capacitor
import ActivityKit

// Darwin 跨行程通知橋接：C 回呼無法捕獲 Swift 值，用模組層級全域轉接。
// widget extension 的 perform() 發出 Darwin 通知 → 這裡接住 → notifyListeners 到 JS。
private var _darwinPlugin: LiveActivityPlugin?
private let _darwinStartCb: CFNotificationCallback = { _, _, _, _, _ in
    DispatchQueue.main.async {
        _darwinPlugin?.notifyListeners("liveActivityCommand", data: ["action": "start"])
    }
}
private let _darwinEndCb: CFNotificationCallback = { _, _, _, _, _ in
    DispatchQueue.main.async {
        _darwinPlugin?.notifyListeners("liveActivityCommand", data: ["action": "end"])
    }
}

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
        CAPPluginMethod(name: "consumePendingCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "savePhotoBase64",       returnType: CAPPluginReturnPromise)
    ]

    // 方塊過期時間：App 活著時 GPS 回呼持續往後推；App 一死沒人推，過期後鎖屏畫面收成空白。
    // 設短一點讓「殺掉 App → 方塊消失」更快；需搭配 JS 端每 2-3 秒續命一次，避免存活時誤消失。
    private let staleWindow: TimeInterval = 6

    // 用 Any? 儲存，避免 @available 標記汙染整個 class
    private var currentActivity: Any?

    // 最後一次的狀態，供 heartbeat 重新推送（刷新 staleDate 用）
    private var lastIsRecording = false
    private var lastElapsed = 0
    private var lastDistance = 0

    // 插件載入時：掛 Darwin 跨行程監聽（widget→main app）和一般事件
    override public func load() {
        // Darwin 通知：widget extension 的 Button(intent:) 觸發 perform()，
        // 發出系統全域的 Darwin 通知，這裡接住後轉給 JS。
        // 不需要 App Group；任何 process 都能收，app 在背景也能收（iOS 保證送達）。
        _darwinPlugin = self
        let darwin = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterAddObserver(darwin, nil, _darwinStartCb,
            "com.maptrip.widget.start" as CFString, nil, .deliverImmediately)
        CFNotificationCenterAddObserver(darwin, nil, _darwinEndCb,
            "com.maptrip.widget.end" as CFString, nil, .deliverImmediately)
        // 同行程通知（若 perform() 在 main app process 執行時也發這個）
        NotificationCenter.default.addObserver(
            self, selector: #selector(onMapTripCommand(_:)),
            name: .mapTripCommand, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(onWillTerminate),
            name: UIApplication.willTerminateNotification, object: nil)
        // AppDelegate 收到 maptrip:// URL 時的備援路徑（.widgetURL 無法送 URL，但仍保留）
        NotificationCenter.default.addObserver(
            self, selector: #selector(onMapTripUrlNotification(_:)),
            name: .mapTripUrl, object: nil)
    }

    // 收到鎖屏 App Intent 指令 → 立即轉給 JS（App 已在前景、JS 醒著時可即時反應）。
    // 注意：這裡「不清除」暫存指令。App 從背景被喚醒時 JS 還在睡、收不到這個即時通知，
    // 必須留著讓「回到前景」時的 consumePendingCommand 可靠地補做（由它負責清除）。
    @objc private func onMapTripCommand(_ note: Notification) {
        let action = (note.userInfo?["action"] as? String) ?? ""
        DispatchQueue.main.async {
            self.notifyListeners("liveActivityCommand", data: ["action": action])
        }
    }

    // AppDelegate 收到 maptrip:// 時的備援（目前 Live Activity 的 widgetURL 不會觸發，保留以備日後）
    @objc private func onMapTripUrlNotification(_ note: Notification) {
        guard let url = (note.userInfo?["url"] as? String),
              url.hasPrefix("maptrip://") else { return }
        DispatchQueue.main.async {
            self.notifyListeners("mapTripUrl", data: ["url": url])
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

    /// 開機/回前景補做：讀「標準」與「App Group」兩個 store，回報每一個的內容，
    /// 一次測出 perform() 有沒有跑、跑在哪個 process、哪個 store 真的同步得到。
    @objc func consumePendingCommand(_ call: CAPPluginCall) {
        let now = Date().timeIntervalSince1970
        let std = UserDefaults.standard
        let grp = UserDefaults(suiteName: kAppGroup)

        let stdCmd  = std.string(forKey: kMapTripPendingCommand) ?? ""
        let stdTs   = std.double(forKey: kMapTripPendingCommandTime)
        let stdProc = std.string(forKey: kMapTripPerformProcess) ?? ""

        let grpCmd  = grp?.string(forKey: kMapTripPendingCommand) ?? ""
        let grpTs   = grp?.double(forKey: kMapTripPendingCommandTime) ?? 0
        let grpProc = grp?.string(forKey: kMapTripPerformProcess) ?? ""

        // 選一個「新鮮（2 分鐘內）且非空」的指令來執行，App Group 優先
        var action = ""
        if grpTs > 0 && (now - grpTs) < 120 && !grpCmd.isEmpty {
            action = grpCmd
            grp?.removeObject(forKey: kMapTripPendingCommand)
            grp?.removeObject(forKey: kMapTripPendingCommandTime)
        } else if stdTs > 0 && (now - stdTs) < 120 && !stdCmd.isEmpty {
            action = stdCmd
            std.removeObject(forKey: kMapTripPendingCommand)
            std.removeObject(forKey: kMapTripPendingCommandTime)
        }

        call.resolve([
            "action": action,
            // 完整診斷：哪個 store 有資料、perform() 跑在哪個 process、主程序又是哪個
            "stdRaw":  stdCmd,
            "stdAge":  stdTs > 0 ? Int(now - stdTs) : -1,
            "stdProc": stdProc,
            "grpRaw":  grpCmd,
            "grpAge":  grpTs > 0 ? Int(now - grpTs) : -1,
            "grpProc": grpProc,
            "grpNil":  grp == nil,
            "appProc": ProcessInfo.processInfo.processName
        ])
    }

    /// 將 base64 PNG 存入系統相片庫
    @objc func savePhotoBase64(_ call: CAPPluginCall) {
        guard let b64 = call.getString("base64"),
              let data = Data(base64Encoded: b64),
              let image = UIImage(data: data) else {
            call.reject("invalid image data"); return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                call.reject("permission denied"); return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }) { success, error in
                if success { call.resolve() }
                else { call.reject(error?.localizedDescription ?? "save failed") }
            }
        }
    }

    // MARK: - 私有實作

    /// 建立或更新 Live Activity；每次都帶新的 staleDate。回傳 nil 表示成功。
    @available(iOS 16.2, *)
    @discardableResult
    private func upsertActivity(isRecording: Bool, elapsed: Int, distance: Int) async -> String? {
        lastIsRecording = isRecording
        lastElapsed = elapsed
        lastDistance = distance

        // 廣播狀態給 CarPlay（若已連線）即時更新按鈕與里程顯示
        NotificationCenter.default.post(name: .mapTripStateChanged, object: nil, userInfo: [
            "isRecording": isRecording, "elapsed": elapsed, "distance": distance
        ])

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
