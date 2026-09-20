import ActivityKit
import Foundation
import Security
import UIKit

/// Owns only the ActivityKit update-token registration. No login credentials,
/// broker data reads, or trading operations are available to this service.
/// Created by AppDelegate before Capacitor/WebKit needs to load.
@available(iOS 16.2, *)
@MainActor
final class AlphaTradeLiveActivityRegistration {
    static let shared = AlphaTradeLiveActivityRegistration()

    private struct Registration: Codable, Equatable {
        let activityId: String
        let sessionId: String
        let grant: String
        let pushToken: String
        var ended: Bool

        // Only used to discard expired local retry records. Authorization is
        // always checked by the server, never trusted from this decoded body.
        var expiresAt: TimeInterval? {
            guard let part = grant.split(separator: ".").first else { return nil }
            var encoded = String(part).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
            guard let data = Data(base64Encoded: encoded),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
            return (object["expiresAt"] as? NSNumber)?.doubleValue
        }
    }
    private let endpoint = URL(string: "https://alphatrade-mentor-15.vercel.app/api/native-live-activity-subscription")!
    private var records: [String: Registration] = [:]
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    private var stateTasks: [String: Task<Void, Never>] = [:]
    private var requests: [String: Task<Void, Never>] = [:]
    private var discovery: Task<Void, Never>?
    private var lastSent: [String: Registration] = [:]
    private let redirectBlocker = LiveActivityRegistrationRedirectBlocker()
    private lazy var session = URLSession(configuration: .ephemeral, delegate: redirectBlocker, delegateQueue: nil)
    private let keychainQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.alphatrade.native.live-activity-registration",
        kSecAttrAccount as String: "pending-v1",
    ]

    func start() {
        guard discovery == nil else { return }
        load()
        discovery = Task { @MainActor [weak self] in
            for await activity in Activity<AlphaTradeLiveActivityAttributes>.activityUpdates {
                guard !Task.isCancelled else { return }
                self?.observe(activity)
            }
        }
        resume()
    }

    func resume() {
        let activities = Activity<AlphaTradeLiveActivityAttributes>.activities
        let activeIDs = Set(activities.filter { $0.activityState == .active || $0.activityState == .stale }.map { $0.id })
        // A missed end while suspended must never become another POST on launch.
        for var record in Array(records.values) {
            if !activeIDs.contains(record.activityId) { record.ended = true }
            enqueue(record)
        }
        for activity in activities { observe(activity) }
    }

    private func observe(_ activity: Activity<AlphaTradeLiveActivityAttributes>) {
        guard let grant = activity.attributes.registrationToken, !grant.isEmpty else { return }
        if activity.activityState == .ended || activity.activityState == .dismissed {
            Task { await unregister(activity) }
            return
        }
        if let token = activity.pushToken { register(activity, token: token) }
        if tokenTasks[activity.id] == nil {
            tokenTasks[activity.id] = Task { @MainActor [weak self] in
                for await token in activity.pushTokenUpdates {
                    guard !Task.isCancelled else { return }
                    self?.register(activity, token: token)
                }
            }
        }
        if stateTasks[activity.id] == nil {
            stateTasks[activity.id] = Task { @MainActor [weak self] in
                for await state in activity.activityStateUpdates {
                    guard !Task.isCancelled else { return }
                    if state == .ended || state == .dismissed {
                        await self?.unregister(activity)
                        self?.tokenTasks.removeValue(forKey: activity.id)?.cancel()
                        self?.stateTasks.removeValue(forKey: activity.id)
                        return
                    }
                }
            }
        }
    }

    private func register(_ activity: Activity<AlphaTradeLiveActivityAttributes>, token: Data) {
        guard activity.activityState == .active || activity.activityState == .stale,
              let grant = activity.attributes.registrationToken, !grant.isEmpty,
              records[activity.id]?.ended != true else { return }
        enqueue(Registration(activityId: activity.id, sessionId: activity.attributes.sessionID,
                             grant: grant, pushToken: token.map { String(format: "%02x", $0) }.joined(), ended: false))
    }

    func unregister(_ activity: Activity<AlphaTradeLiveActivityAttributes>) async {
        guard let grant = activity.attributes.registrationToken, !grant.isEmpty else { return }
        var record = records[activity.id]
        if record == nil, let token = activity.pushToken {
            record = Registration(activityId: activity.id, sessionId: activity.attributes.sessionID,
                                  grant: grant, pushToken: token.map { String(format: "%02x", $0) }.joined(), ended: true)
        }
        guard var ending = record else { return }
        ending.ended = true
        enqueue(ending)
        await requests[activity.id]?.value
    }

    private func enqueue(_ incoming: Registration) {
        guard let deadline = incoming.expiresAt, deadline > Date().timeIntervalSince1970 else {
            records.removeValue(forKey: incoming.activityId)
            lastSent.removeValue(forKey: incoming.activityId)
            persist()
            return
        }
        var record = incoming
        if records[record.activityId]?.ended == true { record.ended = true }
        records[record.activityId] = record
        persist()
        guard requests[record.activityId] == nil else { return }
        if lastSent[record.activityId] == record { return }
        let id = record.activityId
        requests[id] = Task { @MainActor [weak self] in
            guard let self else { return }
            let background = UIApplication.shared.beginBackgroundTask(withName: "LiveActivityRegistration") { [weak self] in
                Task { @MainActor in self?.requests[id]?.cancel() }
            }
            defer {
                if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
                self.requests.removeValue(forKey: id)
            }
            // Newer token/end replaces pending state. Requests for one activity
            // run serially, so an in-flight POST cannot win after its DELETE.
            while !Task.isCancelled, let pending = self.records[id] {
                var sent = false
                for attempt in 0..<2 {
                    if Task.isCancelled { return }
                    sent = await self.send(pending)
                    if sent || self.records[id] != pending { break }
                    if attempt == 0 { try? await Task.sleep(nanoseconds: 1_000_000_000) }
                }
                if self.records[id] != pending { continue }
                guard sent else { return } // persisted; retry on next OS wake
                if pending.ended { self.records.removeValue(forKey: id); self.lastSent.removeValue(forKey: id) }
                else { self.lastSent[id] = pending }
                self.persist()
                return
            }
        }
    }

    private func send(_ record: Registration) async -> Bool {
        var request = URLRequest(url: endpoint)
        request.httpMethod = record.ended ? "DELETE" : "POST"
        request.timeoutInterval = 8
        request.setValue("LiveActivity \(record.grant)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
#if DEBUG
        let environment = "development"
#else
        let environment = "production"
#endif
        // The server grant is bound to this opaque session ID. Actual iOS IDs
        // stay local and cannot be substituted to mutate another registration.
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "activityId": record.sessionId, "pushToken": record.pushToken,
            "environment": environment, "bundleId": "app.alphatrade.native",
        ])
        do {
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if !(200..<300).contains(status) {
                NSLog("[LiveActivityRegistration] HTTP %d", status)
            }
            return (200..<300).contains(status)
        } catch {
            // Never log the request, grant, push token or response body.
            NSLog("[LiveActivityRegistration] Network request incomplete")
            return false
        }
    }

    private func load() {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data,
           let stored = try? JSONDecoder().decode([String: Registration].self, from: data) {
            records = stored
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(records) else { return }
        let values = [kSecValueData as String: data]
        let status = SecItemUpdate(keychainQuery as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var insert = keychainQuery
            insert[kSecValueData as String] = data
            // This short-lived, session-only registration grant is usable while
            // locked. The full Supabase auth keychain remains WhenUnlocked.
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(insert as CFDictionary, nil)
        }
    }
}

private final class LiveActivityRegistrationRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
