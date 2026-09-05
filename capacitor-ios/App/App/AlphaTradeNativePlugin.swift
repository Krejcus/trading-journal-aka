import Capacitor
import ActivityKit
import AVFoundation
import EventKit
import EventKitUI
import LocalAuthentication
import Security
import Speech
import UIKit
import UserNotifications
import WidgetKit

@objc(AlphaTradeNativePlugin)
public final class AlphaTradeNativePlugin: CAPPlugin, CAPBridgedPlugin, EKEventEditViewDelegate {
    public let identifier = "AlphaTradeNativePlugin"
    public let jsName = "AlphaTradeNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBadgeCount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadgeCount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearBadgeCount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestSpeechPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPermissionStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getKeepAwakeState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwakeEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDictation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDictation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPrivacyState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPrivacyEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lockPrivacy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLiveActivityState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startLiveActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateLiveActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endLiveActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentCalendarEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setShellTheme", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setShellWorld", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setShellPage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getShellTabs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setShellTabs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportRefreshComplete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPushEnvironment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateWidgetSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearWidgetSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWidgetAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearWidgetAccessToken", returnType: CAPPluginReturnPromise),
    ]

    private let audioEngine = AVAudioEngine()
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechTask: SFSpeechRecognitionTask?
    private var dictationCall: CAPPluginCall?
    private var latestTranscript = ""
    private var dictationTimeout: DispatchWorkItem?
    private var hasAudioTap = false
    private var calendarEventCall: CAPPluginCall?
    private let keychainService = "app.alphatrade.native.auth"
    private let widgetSuiteName = "group.app.alphatrade.native"
    private let widgetSnapshotKey = "AlphaTradeWidgetSnapshotV2"
    private let widgetAccessTokenKey = "AlphaTradeWidgetAccessTokenV1"
    private var liveActivityTokenTasks: [String: Task<Void, Never>] = [:]
    private var liveActivityStateTasks: [String: Task<Void, Never>] = [:]
    private var liveActivityDiscoveryTask: Task<Void, Never>?
    private var liveActivityPushToStartTask: Task<Void, Never>?

    override public func load() {
        super.load()
        guard #available(iOS 16.2, *) else { return }
        Task { @MainActor [weak self] in
            for activity in Activity<AlphaTradeLiveActivityAttributes>.activities {
                self?.observeLiveActivityPushToken(activity)
            }
        }
        liveActivityDiscoveryTask = Task { @MainActor [weak self] in
            for await activity in Activity<AlphaTradeLiveActivityAttributes>.activityUpdates {
                guard !Task.isCancelled else { return }
                self?.observeLiveActivityPushToken(activity)
            }
        }
        if #available(iOS 17.2, *) {
            liveActivityPushToStartTask = Task { [weak self] in
                if let tokenData = Activity<AlphaTradeLiveActivityAttributes>.pushToStartToken {
                    self?.emitLiveActivityPushToStartToken(tokenData)
                }
                for await tokenData in Activity<AlphaTradeLiveActivityAttributes>.pushToStartTokenUpdates {
                    guard !Task.isCancelled else { return }
                    self?.emitLiveActivityPushToStartToken(tokenData)
                }
            }
        }
    }

    private var shellController: AlphaTradeShellViewController? {
        if let shell = bridge?.viewController as? AlphaTradeShellViewController { return shell }
        return bridge?.viewController?.parent as? AlphaTradeShellViewController
    }

    @objc public func getPushEnvironment(_ call: CAPPluginCall) {
#if DEBUG
        call.resolve(["environment": "development"])
#else
        call.resolve(["environment": "production"])
#endif
    }

    @objc public func updateWidgetSnapshot(_ call: CAPPluginCall) {
        guard let snapshotJSON = call.getString("snapshotJson"),
              !snapshotJSON.isEmpty,
              snapshotJSON.utf8.count <= 256_000,
              let data = snapshotJSON.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) != nil else {
            call.reject("Neplatný nebo příliš velký widget snapshot.")
            return
        }
        guard let defaults = UserDefaults(suiteName: widgetSuiteName) else {
            call.reject("Sdílené úložiště widgetů není dostupné.")
            return
        }
        defaults.set(snapshotJSON, forKey: widgetSnapshotKey)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve(["bytes": snapshotJSON.utf8.count])
    }

    @objc public func clearWidgetSnapshot(_ call: CAPPluginCall) {
        UserDefaults(suiteName: widgetSuiteName)?.removeObject(forKey: widgetSnapshotKey)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc public func setWidgetAccessToken(_ call: CAPPluginCall) {
        guard let token = call.getString("widgetToken"),
              token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let defaults = UserDefaults(suiteName: widgetSuiteName) else {
            call.reject("Neplatný widgetový token nebo nedostupné sdílené úložiště.")
            return
        }
        defaults.set(token, forKey: widgetAccessTokenKey)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc public func clearWidgetAccessToken(_ call: CAPPluginCall) {
        UserDefaults(suiteName: widgetSuiteName)?.removeObject(forKey: widgetAccessTokenKey)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc public func setShellTheme(_ call: CAPPluginCall) {
        guard let theme = call.getString("theme"), ["light", "dark", "oled"].contains(theme) else {
            call.reject("Neplatný barevný režim.")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let shell = self?.shellController else {
                call.reject("Nativní shell není připravený.")
                return
            }
            shell.applyThemeFromWeb(theme)
            call.resolve(["theme": theme])
        }
    }

    @objc public func reportRefreshComplete(_ call: CAPPluginCall) {
        let success = call.getBool("success") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let shell = self?.shellController else {
                call.reject("Nativní shell není připravený.")
                return
            }
            shell.completeNativeRefresh(success: success)
            call.resolve()
        }
    }

    @objc public func setShellWorld(_ call: CAPPluginCall) {
        guard let world = call.getString("world"), ["live", "backtest"].contains(world) else {
            call.reject("Neplatný svět aplikace.")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let shell = self?.shellController else {
                call.reject("Nativní shell není připravený.")
                return
            }
            shell.applyWorldFromWeb(world)
            call.resolve(["world": world])
        }
    }

    @objc public func setShellPage(_ call: CAPPluginCall) {
        guard let page = call.getString("page"), !page.isEmpty else {
            call.reject("Chybí název stránky.")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let shell = self?.shellController else {
                call.reject("Nativní shell není připravený.")
                return
            }
            shell.applyPageFromWeb(page)
            call.resolve(["page": page])
        }
    }

    @objc public func getShellTabs(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let slots = self?.shellController?.currentTabSlots() ?? AlphaTradeTabCatalog.loadSlots()
            call.resolve([
                "slots": slots,
                "destinations": AlphaTradeTabCatalog.destinations.map { ["id": $0.id, "title": $0.title] },
            ])
        }
    }

    @objc public func setShellTabs(_ call: CAPPluginCall) {
        guard let slots = call.getArray("slots", String.self) else {
            call.reject("Chybí pole slots.")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let shell = self?.shellController else {
                call.reject("Nativní shell není připravený.")
                return
            }
            guard shell.applyTabSlots(slots) else {
                call.reject("Neplatná volba karet: potřebuji tři různé známé cíle.")
                return
            }
            call.resolve(["slots": slots])
        }
    }

    @objc public func getLiveActivityState(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve(["supported": false, "enabled": false, "activeCount": 0])
            return
        }
        call.resolve([
            "supported": true,
            "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
            "activeCount": Activity<AlphaTradeLiveActivityAttributes>.activities.count,
        ])
    }

    @objc public func startLiveActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities vyžadují iOS 16.2 nebo novější.")
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Live Activities jsou pro AlphaTrade v Nastavení iOS vypnuté.")
            return
        }

        Task { @MainActor in
            let state = self.liveActivityContentState(from: call)
            let content = ActivityContent(state: state, staleDate: .now.addingTimeInterval(15 * 60), relevanceScore: 50)
            do {
                let activity: Activity<AlphaTradeLiveActivityAttributes>
                if let current = Activity<AlphaTradeLiveActivityAttributes>.activities.first {
                    await current.update(content)
                    activity = current
                } else {
                    let attributes = AlphaTradeLiveActivityAttributes(
                        sessionID: UUID().uuidString,
                        symbol: call.getString("symbol") ?? "MNQ"
                    )
                    activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
                }
                self.observeLiveActivityPushToken(activity)
                call.resolve(["supported": true, "enabled": true, "activeCount": 1, "activityID": activity.id])
            } catch {
                call.reject("Live Activity se nepodařilo spustit.", nil, error)
            }
        }
    }

    @objc public func updateLiveActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities vyžadují iOS 16.2 nebo novější.")
            return
        }
        Task { @MainActor in
            guard let activity = Activity<AlphaTradeLiveActivityAttributes>.activities.first else {
                call.reject("Žádná testovací Live Activity není aktivní.")
                return
            }
            let content = ActivityContent(
                state: self.liveActivityContentState(from: call),
                staleDate: .now.addingTimeInterval(15 * 60),
                relevanceScore: call.getBool("alert") == true ? 100 : 50
            )
            if call.getBool("alert") == true {
                let alert = AlertConfiguration(
                    title: "AlphaTrade test",
                    body: "Live Activity byla aktualizována.",
                    sound: .default
                )
                await activity.update(content, alertConfiguration: alert)
            } else {
                await activity.update(content)
            }
            call.resolve(["supported": true, "enabled": true, "activeCount": 1, "activityID": activity.id])
        }
    }

    @objc public func endLiveActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve(["supported": false, "enabled": false, "activeCount": 0])
            return
        }
        Task { @MainActor in
            let activities = Activity<AlphaTradeLiveActivityAttributes>.activities
            for activity in activities {
                await activity.end(nil, dismissalPolicy: .immediate)
                self.notifyListeners(
                    "liveActivityEnded",
                    data: ["activityId": activity.id],
                    retainUntilConsumed: true
                )
                self.liveActivityTokenTasks.removeValue(forKey: activity.id)?.cancel()
                self.liveActivityStateTasks.removeValue(forKey: activity.id)?.cancel()
            }
            call.resolve([
                "supported": true,
                "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
                "activeCount": 0,
            ])
        }
    }

    @available(iOS 16.2, *)
    private func liveActivityContentState(from call: CAPPluginCall) -> AlphaTradeLiveActivityAttributes.ContentState {
        AlphaTradeLiveActivityAttributes.ContentState(
            status: call.getString("status") ?? "NEW YORK · LIVE TEST",
            headline: call.getString("headline") ?? "Seance pod kontrolou",
            detail: call.getString("detail") ?? "Risk 38 % · 3 / 3 obchody",
            pnlText: call.getString("pnlText") ?? "+$428.50",
            pnlLabel: call.getString("pnlLabel"),
            isPositive: call.getBool("isPositive") ?? true,
            progress: min(max(call.getDouble("progress") ?? 0.62, 0), 1),
            updatedAt: Date().timeIntervalSince1970
        )
    }

    /// Veškerá správa observerů je izolovaná na hlavní vlákno. Dřív do stejných
    /// slovníků sahal discovery task, state-update task i start/end cesta bez
    /// synchronizace — souběh serverem vytvořené aktivity s jejím ukončením byl
    /// datový závod nad `Dictionary`, který může shodit celý proces.
    @available(iOS 16.2, *)
    @MainActor
    private func observeLiveActivityPushToken(_ activity: Activity<AlphaTradeLiveActivityAttributes>) {
        if liveActivityTokenTasks[activity.id] == nil {
            liveActivityTokenTasks[activity.id] = Task { @MainActor [weak self] in
                for await tokenData in activity.pushTokenUpdates {
                    guard !Task.isCancelled else { return }
                    let token = tokenData.map { String(format: "%02x", $0) }.joined()
                    self?.notifyListeners(
                        "liveActivityPushToken",
                        data: ["activityId": activity.id, "pushToken": token],
                        retainUntilConsumed: true
                    )
                }
            }
        }
        if liveActivityStateTasks[activity.id] == nil {
            liveActivityStateTasks[activity.id] = Task { @MainActor [weak self] in
                for await state in activity.activityStateUpdates {
                    guard !Task.isCancelled else { return }
                    guard state == .ended || state == .dismissed else { continue }
                    self?.notifyListeners(
                        "liveActivityEnded",
                        data: ["activityId": activity.id],
                        retainUntilConsumed: true
                    )
                    self?.liveActivityTokenTasks.removeValue(forKey: activity.id)?.cancel()
                    self?.liveActivityStateTasks.removeValue(forKey: activity.id)?.cancel()
                    return
                }
            }
        }
    }

    @available(iOS 17.2, *)
    private func emitLiveActivityPushToStartToken(_ tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        notifyListeners(
            "liveActivityPushToStartToken",
            data: ["pushToken": token],
            retainUntilConsumed: true
        )
    }

    @objc public func presentCalendarEvent(_ call: CAPPluginCall) {
        guard #available(iOS 17.0, *) else {
            call.reject("Systémový editor Kalendáře vyžaduje iOS 17 nebo novější.")
            return
        }
        guard calendarEventCall == nil else {
            call.reject("Editor Kalendáře už je otevřený.")
            return
        }

        let title = call.getString("title")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let startTimestampMs = call.getDouble("startTimestampMs") ?? 0
        let durationMinutes = min(max(call.getInt("durationMinutes") ?? 90, 15), 12 * 60)
        guard !title.isEmpty, startTimestampMs > 0 else {
            call.reject("Chybí název nebo začátek kalendářní události.")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else {
                call.reject("Systémový editor Kalendáře se nepodařilo otevřít.")
                return
            }

            let eventStore = EKEventStore()
            let event = EKEvent(eventStore: eventStore)
            event.title = String(title.prefix(120))
            event.startDate = Date(timeIntervalSince1970: startTimestampMs / 1_000)
            event.endDate = event.startDate.addingTimeInterval(TimeInterval(durationMinutes * 60))
            event.location = call.getString("location")?.trimmingCharacters(in: .whitespacesAndNewlines)
            event.notes = call.getString("notes")?.trimmingCharacters(in: .whitespacesAndNewlines)

            let editor = EKEventEditViewController()
            editor.eventStore = eventStore
            editor.event = event
            editor.editViewDelegate = self
            self.calendarEventCall = call
            presenter.present(editor, animated: true)
        }
    }

    public func eventEditViewController(_ controller: EKEventEditViewController,
                                        didCompleteWith action: EKEventEditViewAction) {
        let result: String
        switch action {
        case .saved: result = "saved"
        case .deleted: result = "deleted"
        case .canceled: result = "cancelled"
        @unknown default: result = "cancelled"
        }
        let call = calendarEventCall
        calendarEventCall = nil
        controller.dismiss(animated: true) {
            call?.resolve(["action": result])
        }
    }

    @objc public func shareFile(_ call: CAPPluginCall) {
        guard let encoded = call.getString("base64"),
              let data = Data(base64Encoded: encoded) else {
            call.reject("Obrázek ke sdílení se nepodařilo načíst.")
            return
        }
        let requestedName = call.getString("fileName") ?? "alphatrade-trade.png"
        let safeName = requestedName
            .components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.")).inverted)
            .joined(separator: "_")
        let fileName = safeName.lowercased().hasSuffix(".png") ? safeName : "\(safeName).png"
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("alphatrade-share-\(UUID().uuidString)", isDirectory: true)
        let fileURL = folder.appendingPathComponent(fileName)

        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            call.reject("Dočasný soubor ke sdílení se nepodařilo vytvořit.", nil, error)
            return
        }

        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                try? FileManager.default.removeItem(at: folder)
                call.reject("Systémové sdílení se nepodařilo otevřít.")
                return
            }

            var items: [Any] = [fileURL]
            if let text = call.getString("text"), !text.isEmpty { items.append(text) }
            if let urlString = call.getString("url"), let url = URL(string: urlString) { items.append(url) }
            let activity = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let popover = activity.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX,
                                            y: presenter.view.bounds.maxY - 1,
                                            width: 1,
                                            height: 1)
                popover.permittedArrowDirections = []
            }
            activity.completionWithItemsHandler = { activityType, completed, _, error in
                try? FileManager.default.removeItem(at: folder)
                if let error {
                    call.reject("Sdílení selhalo.", nil, error)
                } else {
                    var result: JSObject = ["completed": completed]
                    if let activityType { result["activityType"] = activityType.rawValue }
                    call.resolve(result)
                }
            }
            presenter.present(activity, animated: true)
        }
    }

    @objc public func shareText(_ call: CAPPluginCall) {
        let text = call.getString("text")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let url = call.getString("url").flatMap(URL.init(string:))
        guard !text.isEmpty || url != nil else {
            call.reject("Není co sdílet.")
            return
        }

        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("Systémové sdílení se nepodařilo otevřít.")
                return
            }
            var items: [Any] = []
            if !text.isEmpty { items.append(text) }
            if let url { items.append(url) }
            let activity = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let popover = activity.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX,
                                            y: presenter.view.bounds.maxY - 1,
                                            width: 1,
                                            height: 1)
                popover.permittedArrowDirections = []
            }
            activity.completionWithItemsHandler = { activityType, completed, _, error in
                if let error {
                    call.reject("Sdílení selhalo.", nil, error)
                } else {
                    var result: JSObject = ["completed": completed]
                    if let activityType { result["activityType"] = activityType.rawValue }
                    call.resolve(result)
                }
            }
            presenter.present(activity, animated: true)
        }
    }

    private func keychainQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
        ]
    }

    @objc public func secureGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Chybí klíč zabezpečeného úložiště.")
            return
        }
        var query = keychainQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Keychain položku se nepodařilo načíst (\(status)).")
            return
        }
        call.resolve(["value": value])
    }

    @objc public func secureSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty,
              let value = call.getString("value"),
              let data = value.data(using: .utf8) else {
            call.reject("Chybí klíč nebo hodnota zabezpečeného úložiště.")
            return
        }
        let query = keychainQuery(for: key)
        let attributes: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            call.reject("Keychain položku se nepodařilo uložit (\(status)).")
            return
        }
        call.resolve()
    }

    @objc public func secureRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Chybí klíč zabezpečeného úložiště.")
            return
        }
        let status = SecItemDelete(keychainQuery(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Keychain položku se nepodařilo odstranit (\(status)).")
            return
        }
        call.resolve()
    }

    @objc public func getBadgeCount(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["count": UIApplication.shared.applicationIconBadgeNumber])
        }
    }

    @objc public func setBadgeCount(_ call: CAPPluginCall) {
        let count = min(max(call.getInt("count") ?? 0, 0), 999)
        updateBadgeCount(count, call: call)
    }

    @objc public func clearBadgeCount(_ call: CAPPluginCall) {
        updateBadgeCount(0, call: call)
    }

    private func updateBadgeCount(_ count: Int, call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(count) { error in
                DispatchQueue.main.async {
                    if let error {
                        call.reject("Badge ikony se nepodařilo změnit.", nil, error)
                    } else {
                        call.resolve(["count": count])
                    }
                }
            }
        } else {
            DispatchQueue.main.async {
                UIApplication.shared.applicationIconBadgeNumber = count
                call.resolve(["count": count])
            }
        }
    }

    @objc public func authenticate(_ call: CAPPluginCall) {
        let context = LAContext()
        context.localizedCancelTitle = "Zrušit"
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            call.resolve(["success": false, "available": false])
            return
        }

        let reason = call.getString("reason") ?? "Odemknout finanční data v AlphaTrade"
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
            DispatchQueue.main.async {
                // Po zrušení/neúspěchu zůstává citlivý obsah zakrytý React
                // privacy gate, ale jeho tlačítko pro opakování musí být
                // dostupné. hide() odstraní jen privacyLock; ochranu při
                // screen recordingu ponechá beze změny.
                AlphaTradePrivacyShield.shared.hide()
                var result: JSObject = [
                    "success": success,
                    "available": true,
                ]
                if let error { result["error"] = error.localizedDescription }
                call.resolve(result)
            }
        }
    }

    @objc public func haptic(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            switch call.getString("style") ?? "selection" {
            case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
            case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
            case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
            default: UISelectionFeedbackGenerator().selectionChanged()
            }
            call.resolve()
        }
    }

    @objc public func requestSpeechPermissions(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { speechStatus in
            AVAudioSession.sharedInstance().requestRecordPermission { microphoneGranted in
                DispatchQueue.main.async {
                    call.resolve([
                        "speech": speechStatus == .authorized,
                        "microphone": microphoneGranted,
                    ])
                }
            }
        }
    }

    @objc public func getPermissionStatus(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let notificationStatus: String
            switch settings.authorizationStatus {
            case .notDetermined: notificationStatus = "notDetermined"
            case .denied: notificationStatus = "denied"
            case .authorized: notificationStatus = "authorized"
            case .provisional: notificationStatus = "provisional"
            case .ephemeral: notificationStatus = "ephemeral"
            @unknown default: notificationStatus = "unknown"
            }

            let microphoneStatus: String
            switch AVAudioSession.sharedInstance().recordPermission {
            case .undetermined: microphoneStatus = "notDetermined"
            case .denied: microphoneStatus = "denied"
            case .granted: microphoneStatus = "authorized"
            @unknown default: microphoneStatus = "unknown"
            }

            let speechStatus: String
            switch SFSpeechRecognizer.authorizationStatus() {
            case .notDetermined: speechStatus = "notDetermined"
            case .denied: speechStatus = "denied"
            case .restricted: speechStatus = "restricted"
            case .authorized: speechStatus = "authorized"
            @unknown default: speechStatus = "unknown"
            }

            call.resolve([
                "notifications": notificationStatus,
                "microphone": microphoneStatus,
                "speech": speechStatus,
            ])
        }
    }

    @objc public func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString),
                  UIApplication.shared.canOpenURL(url) else {
                call.reject("Nastavení iOS se nepodařilo otevřít.")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                call.resolve(["opened": opened])
            }
        }
    }

    @objc public func getKeepAwakeState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve([
                "enabled": AlphaTradeKeepAwake.shared.isEnabled,
                "effective": UIApplication.shared.isIdleTimerDisabled,
            ])
        }
    }

    @objc public func setKeepAwakeEnabled(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("Chybí stav LIVE režimu.")
            return
        }
        DispatchQueue.main.async {
            AlphaTradeKeepAwake.shared.setEnabled(enabled)
            call.resolve([
                "enabled": AlphaTradeKeepAwake.shared.isEnabled,
                "effective": UIApplication.shared.isIdleTimerDisabled,
            ])
        }
    }

    @objc public func startDictation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.dictationCall == nil else {
                call.reject("Diktování už probíhá.")
                return
            }
            guard SFSpeechRecognizer.authorizationStatus() == .authorized,
                  AVAudioSession.sharedInstance().recordPermission == .granted else {
                call.reject("Diktování nemá povolený mikrofon nebo rozpoznávání řeči.")
                return
            }
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "cs-CZ")),
                  recognizer.isAvailable else {
                call.reject("České rozpoznávání řeči teď není dostupné.")
                return
            }

            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
                try session.setActive(true, options: .notifyOthersOnDeactivation)

                let request = SFSpeechAudioBufferRecognitionRequest()
                request.shouldReportPartialResults = true
                request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
                request.contextualStrings = ["AlphaTrade", "MNQ", "NQ", "MES", "ES", "VWAP", "FVG", "long", "short"]
                self.speechRequest = request
                self.dictationCall = call
                self.latestTranscript = ""

                let input = self.audioEngine.inputNode
                let format = input.outputFormat(forBus: 0)
                input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                    request.append(buffer)
                }
                self.hasAudioTap = true
                self.audioEngine.prepare()
                try self.audioEngine.start()

                self.speechTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                    guard let self else { return }
                    if let result { self.latestTranscript = result.bestTranscription.formattedString }
                    if result?.isFinal == true || error != nil {
                        DispatchQueue.main.async { self.finishDictation(error: error) }
                    }
                }

                let timeout = DispatchWorkItem { [weak self] in self?.finishDictation() }
                self.dictationTimeout = timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
            } catch {
                self.cleanupDictationAudio()
                self.dictationCall = nil
                call.reject("Diktování se nepodařilo spustit.", nil, error)
            }
        }
    }

    @objc public func stopDictation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.dictationCall != nil else {
                call.resolve(["recording": false])
                return
            }
            self.audioEngine.stop()
            self.removeAudioTapIfNeeded()
            self.speechRequest?.endAudio()
            call.resolve(["recording": false])

            // The recognizer normally emits a final result after endAudio.
            // Resolve defensively if it does not do so within a short grace period.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.finishDictation()
            }
        }
    }

    private func finishDictation(error: Error? = nil) {
        guard let call = dictationCall else { return }
        dictationCall = nil
        cleanupDictationAudio()
        if let error, latestTranscript.isEmpty {
            call.reject("Řeč se nepodařilo rozpoznat.", nil, error)
        } else {
            call.resolve(["text": latestTranscript])
        }
    }

    private func cleanupDictationAudio() {
        dictationTimeout?.cancel()
        dictationTimeout = nil
        if audioEngine.isRunning { audioEngine.stop() }
        removeAudioTapIfNeeded()
        speechRequest?.endAudio()
        speechTask?.cancel()
        speechRequest = nil
        speechTask = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func removeAudioTapIfNeeded() {
        guard hasAudioTap else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        hasAudioTap = false
    }

    @objc public func getPrivacyState(_ call: CAPPluginCall) {
        call.resolve(["enabled": AlphaTradePrivacyShield.shared.isEnabled])
    }

    @objc public func setPrivacyEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        AlphaTradePrivacyShield.shared.setEnabled(enabled)
        call.resolve(["enabled": enabled])
    }

    @objc public func lockPrivacy(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            AlphaTradePrivacyShield.shared.showIfEnabled()
            call.resolve()
        }
    }
}

final class AlphaTradePrivacyShield: NSObject {
    static let shared = AlphaTradePrivacyShield()
    private let defaultsKey = "AlphaTradePrivacyModeEnabled"
    private var shield: UIVisualEffectView?
    private var titleLabel: UILabel?
    private var detailLabel: UILabel?
    private var reasons = Set<ShieldReason>()
    private var captureObserver: NSObjectProtocol?

    private enum ShieldReason: Hashable {
        case privacyLock
        case screenCapture
    }

    var isEnabled: Bool { UserDefaults.standard.bool(forKey: defaultsKey) }

    func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: defaultsKey)
        if !enabled {
            DispatchQueue.main.async {
                self.reasons.remove(.privacyLock)
                self.reconcileShield()
            }
        }
    }

    func showIfEnabled() {
        guard isEnabled else { return }
        DispatchQueue.main.async {
            self.reasons.insert(.privacyLock)
            self.reconcileShield()
        }
    }

    func startScreenCaptureProtection() {
        guard captureObserver == nil else {
            refreshScreenCaptureState()
            return
        }
        captureObserver = NotificationCenter.default.addObserver(
            forName: UIScreen.capturedDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.refreshScreenCaptureState()
        }
        refreshScreenCaptureState()
    }

    func refreshScreenCaptureState() {
        DispatchQueue.main.async {
            let isCaptured = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .contains { $0.screen.isCaptured }
            if isCaptured { self.reasons.insert(.screenCapture) }
            else { self.reasons.remove(.screenCapture) }
            self.reconcileShield()
        }
    }

    private func reconcileShield() {
        guard !reasons.isEmpty else {
            shield?.removeFromSuperview()
            shield = nil
            titleLabel = nil
            detailLabel = nil
            return
        }

        if shield == nil { createShield() }
        let recording = reasons.contains(.screenCapture)
        titleLabel?.text = recording ? "Obsah je chráněný" : "AlphaTrade je uzamčený"
        detailLabel?.text = recording
            ? "Nahrávání nebo zrcadlení obrazovky právě probíhá."
            : "Otevři aplikaci a ověř vlastníka zařízení."
    }

    private func createShield() {
        guard shield == nil,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return }

        let effect = UIBlurEffect(style: .systemUltraThinMaterialDark)
        let overlay = UIVisualEffectView(effect: effect)
        overlay.frame = window.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        let icon = UIImageView(image: UIImage(systemName: "lock.shield.fill"))
        icon.tintColor = .systemBlue
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 52, weight: .semibold)
        let title = UILabel()
        title.text = "AlphaTrade je uzamčený"
        title.textColor = .white
        title.font = .systemFont(ofSize: 20, weight: .bold)
        let detail = UILabel()
        detail.text = "Otevři aplikaci a ověř vlastníka zařízení."
        detail.textColor = .secondaryLabel
        detail.font = .systemFont(ofSize: 13, weight: .semibold)
        detail.textAlignment = .center

        let stack = UIStackView(arrangedSubviews: [icon, title, detail])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        overlay.contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: overlay.contentView.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.contentView.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: overlay.contentView.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: overlay.contentView.trailingAnchor, constant: -24),
        ])
        window.addSubview(overlay)
        shield = overlay
        titleLabel = title
        detailLabel = detail
    }

    func hide() {
        DispatchQueue.main.async {
            self.reasons.remove(.privacyLock)
            self.reconcileShield()
        }
    }
}
