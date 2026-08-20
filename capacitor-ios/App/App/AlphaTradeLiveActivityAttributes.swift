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
        let isPositive: Bool
        let progress: Double
        let updatedAt: Double
    }

    let sessionID: String
    let symbol: String
}
