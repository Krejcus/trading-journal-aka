import Foundation

/// A process-local server clock. The anchor is never persisted; every accepted
/// status response replaces it. Using monotonic elapsed time prevents a later
/// wall-clock correction on the Mac from making expired data look fresh again.
struct CompanionServerClockAnchor: Equatable, Sendable {
    let serverTimeAtReceipt: Date
    let monotonicReceiptSeconds: TimeInterval
    let wallClockOffsetSeconds: TimeInterval

    func adjustedNow(monotonicNowSeconds: TimeInterval) -> Date {
        let elapsed = max(0, monotonicNowSeconds - monotonicReceiptSeconds)
        return serverTimeAtReceipt.addingTimeInterval(elapsed)
    }
}

enum CompanionServerClock {
    /// A larger offset almost certainly means a broken system clock or invalid
    /// server response. Fail closed instead of applying an unbounded value.
    static let maximumWallClockOffset: TimeInterval = 7 * 24 * 60 * 60
    static let maximumRoundTrip: TimeInterval = 30

    static func makeAnchor(
        serverTime: Date,
        localReceiptTime: Date,
        monotonicRequestStartedSeconds: TimeInterval,
        monotonicReceiptSeconds: TimeInterval
    ) -> CompanionServerClockAnchor? {
        let wallClockOffset = serverTime.timeIntervalSince(localReceiptTime)
        let roundTrip = monotonicReceiptSeconds - monotonicRequestStartedSeconds

        guard wallClockOffset.isFinite,
              roundTrip.isFinite,
              abs(wallClockOffset) <= maximumWallClockOffset,
              roundTrip >= 0,
              roundTrip <= maximumRoundTrip else {
            return nil
        }

        // The exact instant at which serverTime was captured is not part of the
        // wire contract. Adding the full round trip is deliberately conservative:
        // network time can shorten a verified window, but can never extend it.
        return CompanionServerClockAnchor(
            serverTimeAtReceipt: serverTime.addingTimeInterval(roundTrip),
            monotonicReceiptSeconds: monotonicReceiptSeconds,
            wallClockOffsetSeconds: wallClockOffset
        )
    }
}
