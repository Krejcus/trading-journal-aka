import ActivityKit
import Foundation

struct TradingSessionAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var startedAt: Date
        var riskUsedPercent: Int
        var noteCount: Int
    }
    var symbol: String
    var sessionName: String
}

@MainActor
enum TradingSessionActivity {
    static var isRunning: Bool { !Activity<TradingSessionAttributes>.activities.isEmpty }

    static func toggle() async -> Bool {
        if let activity = Activity<TradingSessionAttributes>.activities.first {
            await activity.end(nil, dismissalPolicy: .immediate)
            return false
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
        do {
            let attributes = TradingSessionAttributes(symbol: "MNQ", sessionName: "NY AM")
            let state = TradingSessionAttributes.ContentState(startedAt: .now, riskUsedPercent: 24, noteCount: 0)
            _ = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil
            )
            return true
        } catch { return false }
    }
}
