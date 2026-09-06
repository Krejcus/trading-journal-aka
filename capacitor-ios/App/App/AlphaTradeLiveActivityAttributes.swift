import ActivityKit
import Foundation
import Darwin

/// Serializes app/extension mutations across processes. Identity validation and
/// snapshot persistence must share a lock so logout cannot be followed by a
/// late response restoring the previous user's data.
enum AlphaTradeWidgetStore {
    static let suite = "group.app.alphatrade.native"
    static let generationKey = "AlphaTradeWidgetSessionGenerationV1"
    static let tokenKey = "AlphaTradeWidgetAccessTokenV1"
    static let snapshotKey = "AlphaTradeWidgetSnapshotV2"
    static let signatureKey = "AlphaTradeWidgetPushRegisteredSignatureV1"

    static func withDefaults<T>(_ body: (UserDefaults) -> T) -> T? {
        guard let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suite),
              let defaults = UserDefaults(suiteName: suite) else { return nil }
        let descriptor = open(directory.appendingPathComponent("widget-store.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { return nil }
        defer { flock(descriptor, LOCK_UN) }
        defaults.synchronize()
        let result = body(defaults)
        defaults.synchronize()
        return result
    }

    static func invalidate(_ defaults: UserDefaults) {
        defaults.set(UUID().uuidString, forKey: generationKey)
        defaults.removeObject(forKey: snapshotKey)
        defaults.removeObject(forKey: signatureKey)
    }
}

/// Shared schema compiled into both the app and its WidgetKit extension.
/// State is a redacted read-only monitoring snapshot. No auth token or broker
/// command is ever copied into ActivityKit.
struct AlphaTradeLiveActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let status: String
        let headline: String
        let detail: String
        let pnlText: String
        var pnlLabel: String? = nil
        let isPositive: Bool
        let progress: Double
        let updatedAt: Double
        var mode: String? = nil
        var symbol: String? = nil
        var side: String? = nil
        var quantity: Double? = nil
        var entryPrice: Double? = nil
        var currentPrice: Double? = nil
        var stopPrice: Double? = nil
        var targetPrice: Double? = nil
        var slTpProgress: Double? = nil
        var armExpiresAt: Double? = nil
        var followersTotal: Int? = nil
        var followersOk: Int? = nil
        /// Kolik stojí zásah stopu napříč všemi účty skupiny. Server ho počítá
        /// z hodnoty bodu kontraktu, kterou widget nezná.
        var riskAtStopText: String? = nil
    }

    let sessionID: String
    let symbol: String
}
