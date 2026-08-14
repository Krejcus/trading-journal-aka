import ActivityKit
import Foundation

/// Shared schema compiled into both the app and its WidgetKit extension.
/// The current lab uses explicit test values only; no auth token or broker
/// command is ever copied into ActivityKit state.
struct AlphaTradeLiveActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let status: String
        let headline: String
        let detail: String
        let pnlText: String
        let isPositive: Bool
        let progress: Double
        let updatedAt: Date
    }

    let sessionID: String
    let symbol: String
}
