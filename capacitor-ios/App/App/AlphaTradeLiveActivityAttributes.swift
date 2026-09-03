import ActivityKit
import Foundation

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
