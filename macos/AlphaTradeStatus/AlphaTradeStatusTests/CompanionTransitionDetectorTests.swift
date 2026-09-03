import XCTest
@testable import AlphaTradeStatus

final class CompanionTransitionDetectorTests: XCTestCase {
    private let reference = Date(timeIntervalSince1970: 1_800_000_000)

    func testWorseningTriggerMatrix() throws {
        let clean = reduced(makeStatus(revision: 1, copierState: .live))

        let reconciliation = reduced(makeStatus(
            revision: 2,
            copierState: .live,
            reconciliation: .review,
            problems: [.init(kind: .reconciliation, text: "review")]
        ))
        assertTransition(clean, reconciliation, .worsening, "safety", "reconciliation")

        let divergence = reduced(makeStatus(
            revision: 2,
            divergences: [.init(symbol: "MNQ", account: "hidden", detail: "qty")],
            problems: [.init(kind: .divergence, text: "divergence")]
        ))
        assertTransition(clean, divergence, .worsening, "safety", "divergence-0")

        let stuckOutbox = reduced(makeStatus(
            revision: 2,
            stuckOutboxCount: 1,
            problems: [.init(kind: .stuckOutbox, text: "stuck")]
        ))
        assertTransition(clean, stuckOutbox, .worsening, "safety", "outbox")

        let disconnected = reduced(makeStatus(revision: 2, brokerConnected: false))
        assertTransition(clean, disconnected, .worsening, "runtime", "broker-connection")

        let intervention = reduced(makeStatus(revision: 2, killSwitchTripped: true))
        assertTransition(clean, intervention, .worsening, "safety", "kill-switch")

        let offline = reduced(makeStatus(revision: 2), now: reference.addingTimeInterval(91))
        assertTransition(clean, offline, .worsening, "runtime", "heartbeat", now: reference.addingTimeInterval(91))

        let expiry = reference.addingTimeInterval(301)
        let liveStatus = makeStatus(revision: 3, copierState: .live, sessionExpiresAt: expiry)
        let liveBeforeThreshold = reduced(liveStatus, now: reference)
        let liveUrgent = reduced(liveStatus, now: reference.addingTimeInterval(2))
        assertTransition(
            liveBeforeThreshold,
            liveUrgent,
            .worsening,
            "copying",
            nil,
            now: reference.addingTimeInterval(2)
        )

        let expiringStatus = makeStatus(
            revision: 4,
            copierState: .live,
            sessionExpiresAt: reference.addingTimeInterval(2)
        )
        assertTransition(
            reduced(expiringStatus, now: reference),
            reduced(expiringStatus, now: reference.addingTimeInterval(3)),
            .worsening,
            "copying",
            nil,
            now: reference.addingTimeInterval(3)
        )
    }

    func testImprovementTriggerMatrix() throws {
        let clean = reduced(makeStatus(revision: 2, copierState: .live))

        let divergence = reduced(makeStatus(
            revision: 1,
            divergences: [.init(symbol: "MNQ", account: "hidden", detail: "qty")],
            problems: [.init(kind: .divergence, text: "divergence")]
        ))
        assertTransition(divergence, clean, .improvement, "safety", "reconciliation")

        let stuck = reduced(makeStatus(
            revision: 1,
            stuckOutboxCount: 1,
            problems: [.init(kind: .stuckOutbox, text: "stuck")]
        ))
        assertTransition(stuck, clean, .improvement, "safety", "outbox")

        let review = reduced(makeStatus(
            revision: 1,
            copierState: .live,
            reconciliation: .review,
            problems: [.init(kind: .reconciliation, text: "review")]
        ))
        assertTransition(review, clean, .improvement, "safety", "reconciliation")

        let disconnected = reduced(makeStatus(revision: 1, brokerConnected: false))
        assertTransition(disconnected, clean, .improvement, "runtime", "broker-connection")

        let oldStatus = makeStatus(revision: 1)
        let offline = reduced(oldStatus, now: reference.addingTimeInterval(91))
        let recovered = reduced(makeStatus(
            revision: 2,
            observedAt: reference.addingTimeInterval(92)
        ), now: reference.addingTimeInterval(92))
        assertTransition(
            offline,
            recovered,
            .improvement,
            "runtime",
            "heartbeat",
            now: reference.addingTimeInterval(92)
        )
    }

    func testModeTriggerMatrixUsesVypnutoForBothDisabledPresentations() throws {
        let disarmed = reduced(makeStatus(revision: 1, copierState: .disarmed))
        let disarmedUnverified = reduced(makeStatus(
            revision: 2,
            copierState: .disarmed,
            exposureVerified: false
        ))
        let shadow = reduced(makeStatus(revision: 2, copierState: .shadow))
        let live = reduced(makeStatus(revision: 3, copierState: .live))

        assertTransition(disarmed, live, .mode, "copying", "follower-ack")
        assertTransition(disarmedUnverified, live, .mode, "copying", "follower-ack")
        assertTransition(shadow, live, .mode, "copying", "follower-ack")
        assertTransition(live, disarmed, .mode, "safety", "reconciliation")
        assertTransition(live, disarmedUnverified, .mode, "safety", "reconciliation")
        assertTransition(live, shadow, .mode, "leader-tracking", "shadow-mode")
        assertTransition(disarmedUnverified, shadow, .mode, "leader-tracking", "shadow-mode")
        assertTransition(shadow, disarmedUnverified, .mode, "safety", "reconciliation")
        assertTransition(disarmed, shadow, .mode, "leader-tracking", "shadow-mode")
        assertTransition(shadow, disarmed, .mode, "safety", "reconciliation")
        XCTAssertFalse(
            CompanionTransitionDetector.detect(previous: live, next: disarmed, now: reference)?
                .reason.localizedCaseInsensitiveContains("disarm") ?? true
        )
        XCTAssertNil(CompanionTransitionDetector.detect(
            previous: disarmed,
            next: disarmedUnverified,
            now: reference
        ), "Losing only flat evidence must not be classified as worsening")
    }

    func testDeferredPreflightReconciliationDoesNotAutoOpenOrNotify() {
        let clean = reduced(makeStatus(revision: 1, copierState: .disarmed))
        let review = reduced(makeStatus(
            revision: 2,
            copierState: .disarmed,
            reconciliation: .review,
            problems: [.init(kind: .reconciliation, text: "preflight")]
        ))

        XCTAssertNil(CompanionTransitionDetector.detect(previous: clean, next: review, now: reference))
        XCTAssertNil(CompanionTransitionDetector.detect(previous: review, next: clean, now: reference))
    }

    func testUnknownFreshnessBridgeNeverTriggersAndStaleDataNeverImproves() {
        let status = makeStatus(revision: 1)
        let verified = reduced(status, now: reference)
        let unknown = reduced(status, now: reference.addingTimeInterval(11))
        XCTAssertNil(CompanionTransitionDetector.detect(
            previous: verified,
            next: unknown,
            now: reference.addingTimeInterval(11)
        ))

        let freshAgain = reduced(makeStatus(
            revision: 2,
            observedAt: reference.addingTimeInterval(12)
        ), now: reference.addingTimeInterval(12))
        XCTAssertNil(CompanionTransitionDetector.detect(
            previous: unknown,
            next: freshAgain,
            now: reference.addingTimeInterval(12)
        ))

        let currentProblem = reduced(makeStatus(
            revision: 3,
            divergences: [.init(symbol: nil, account: "hidden", detail: "qty")]
        ))
        let staleClean = reduced(makeStatus(revision: 4), now: reference.addingTimeInterval(11))
        XCTAssertNil(CompanionTransitionDetector.detect(
            previous: currentProblem,
            next: staleClean,
            now: reference.addingTimeInterval(11)
        ))
    }

    func testGateRequiresThreeStableSecondsAndCancelsFlaps() throws {
        var gate = CompanionTransitionGate()
        let connected = reduced(makeStatus(revision: 1))
        let disconnected = reduced(makeStatus(revision: 2, brokerConnected: false))

        XCTAssertNil(observe(&gate, connected, monotonic: 0, source: .startup))
        XCTAssertNil(observe(&gate, disconnected, monotonic: 1))
        XCTAssertNil(observe(&gate, disconnected, monotonic: 3.99))
        let settled = try XCTUnwrap(observe(&gate, disconnected, monotonic: 4))
        XCTAssertEqual(settled.transition.category, .worsening)
        XCTAssertTrue(settled.allowsAutoOpen)

        var flappingGate = CompanionTransitionGate()
        XCTAssertNil(observe(&flappingGate, connected, monotonic: 0))
        XCTAssertNil(observe(&flappingGate, disconnected, monotonic: 1))
        XCTAssertNil(observe(&flappingGate, connected, monotonic: 2))
        XCTAssertNil(observe(&flappingGate, connected, monotonic: 5))
    }

    func testGateRateLimitsAutoOpenButStillEmitsTheTransition() throws {
        var gate = CompanionTransitionGate()
        let connected = reduced(makeStatus(revision: 1))
        let disconnected = reduced(makeStatus(revision: 2, brokerConnected: false))
        XCTAssertNil(observe(&gate, connected, monotonic: 0))
        XCTAssertNil(observe(&gate, disconnected, monotonic: 1))
        XCTAssertTrue(try XCTUnwrap(observe(&gate, disconnected, monotonic: 4)).allowsAutoOpen)

        let reconnected = reduced(makeStatus(revision: 3))
        XCTAssertNil(observe(&gate, reconnected, monotonic: 5, improvements: true))
        let limited = try XCTUnwrap(observe(&gate, reconnected, monotonic: 8, improvements: true))
        XCTAssertEqual(limited.transition.category, .improvement)
        XCTAssertFalse(limited.allowsAutoOpen)

        let disconnectedAgain = reduced(makeStatus(revision: 4, brokerConnected: false))
        XCTAssertNil(observe(&gate, disconnectedAgain, monotonic: 35))
        XCTAssertTrue(try XCTUnwrap(observe(&gate, disconnectedAgain, monotonic: 38)).allowsAutoOpen)
    }

    func testWakeRateLimitResetPreservesAntiFlapCandidate() throws {
        var gate = CompanionTransitionGate()
        let connected = reduced(makeStatus(revision: 1))
        let disconnected = reduced(makeStatus(revision: 2, brokerConnected: false))
        XCTAssertNil(observe(&gate, connected, monotonic: 0))
        XCTAssertNil(observe(&gate, disconnected, monotonic: 1))
        XCTAssertTrue(try XCTUnwrap(observe(&gate, disconnected, monotonic: 4)).allowsAutoOpen)

        let reconnected = reduced(makeStatus(revision: 3))
        XCTAssertNil(observe(&gate, reconnected, monotonic: 5, improvements: true))
        gate.resetAutoOpenRateLimit()

        let afterWake = try XCTUnwrap(observe(
            &gate,
            reconnected,
            monotonic: 8,
            improvements: true
        ))
        XCTAssertEqual(afterWake.transition.category, .improvement)
        XCTAssertTrue(afterWake.allowsAutoOpen)
    }

    func testNotificationsHaveAnIndependentThirtySecondRateLimit() {
        var limiter = CompanionNotificationRateLimiter()
        let start = Date(timeIntervalSinceReferenceDate: 100)

        XCTAssertTrue(limiter.allowsNotification(at: start))
        XCTAssertFalse(limiter.allowsNotification(at: start.addingTimeInterval(29.999)))
        XCTAssertTrue(limiter.allowsNotification(at: start.addingTimeInterval(30)))
        XCTAssertFalse(limiter.allowsNotification(at: start.addingTimeInterval(30.001)))
    }

    func testGateRejectsLowerRevisionAndSuppressesStartWakeManualAndDisabledSettings() throws {
        let connectedRevisionTwo = reduced(makeStatus(revision: 2))
        let disconnectedRevisionOne = reduced(makeStatus(revision: 1, brokerConnected: false))
        var rollbackGate = CompanionTransitionGate()
        XCTAssertNil(observe(&rollbackGate, connectedRevisionTwo, monotonic: 0))
        XCTAssertNil(observe(&rollbackGate, disconnectedRevisionOne, monotonic: 1))
        XCTAssertNil(observe(&rollbackGate, disconnectedRevisionOne, monotonic: 5))

        for source in [CompanionTransitionObservationSource.startup, .wake, .manualRefresh] {
            var gate = CompanionTransitionGate()
            XCTAssertNil(observe(&gate, connectedRevisionTwo, monotonic: 0))
            let disconnected = reduced(makeStatus(revision: 3, brokerConnected: false))
            XCTAssertNil(observe(&gate, disconnected, monotonic: 1, source: source))
            XCTAssertNil(observe(&gate, disconnected, monotonic: 5))
        }

        var disabledGate = CompanionTransitionGate()
        XCTAssertNil(observe(&disabledGate, connectedRevisionTwo, monotonic: 0))
        let disconnected = reduced(makeStatus(revision: 3, brokerConnected: false))
        XCTAssertNil(observe(&disabledGate, disconnected, monotonic: 1, autoOpen: false))
        let disabled = try XCTUnwrap(observe(
            &disabledGate,
            disconnected,
            monotonic: 4,
            autoOpen: false
        ))
        XCTAssertFalse(disabled.allowsAutoOpen)

        var improvementDisabledGate = CompanionTransitionGate()
        XCTAssertNil(observe(&improvementDisabledGate, disconnected, monotonic: 0))
        let recovered = reduced(makeStatus(revision: 4))
        XCTAssertNil(observe(&improvementDisabledGate, recovered, monotonic: 1))
        XCTAssertFalse(try XCTUnwrap(observe(
            &improvementDisabledGate,
            recovered,
            monotonic: 4
        )).allowsAutoOpen)
    }

    func testReduceMotionDisablesPulseAndHighlight() {
        XCTAssertEqual(CompanionTransitionMotionPolicy.pulseCount(reduceMotion: false), 3)
        XCTAssertTrue(CompanionTransitionMotionPolicy.highlightsChangedRow(reduceMotion: false))
        XCTAssertEqual(CompanionTransitionMotionPolicy.pulseCount(reduceMotion: true), 0)
        XCTAssertFalse(CompanionTransitionMotionPolicy.highlightsChangedRow(reduceMotion: true))
    }

    private func assertTransition(
        _ previous: ReducedCompanionStatus,
        _ next: ReducedCompanionStatus,
        _ category: CompanionTransitionCategory,
        _ sectionID: String,
        _ rowID: String?,
        now: Date? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let transition = CompanionTransitionDetector.detect(
            previous: previous,
            next: next,
            now: now ?? reference
        )
        XCTAssertEqual(transition?.category, category, file: file, line: line)
        XCTAssertEqual(transition?.sectionID, sectionID, file: file, line: line)
        XCTAssertEqual(transition?.rowID, rowID, file: file, line: line)
    }

    private func observe(
        _ gate: inout CompanionTransitionGate,
        _ status: ReducedCompanionStatus,
        monotonic: TimeInterval,
        source: CompanionTransitionObservationSource = .automatic,
        autoOpen: Bool = true,
        improvements: Bool = false
    ) -> CompanionTransitionGateResult? {
        gate.observe(
            status,
            now: reference,
            monotonicNow: monotonic,
            source: source,
            autoOpenEnabled: autoOpen,
            improvementsEnabled: improvements
        )
    }

    private func reduced(
        _ status: MacCompanionStatusDTO,
        now: Date? = nil
    ) -> ReducedCompanionStatus {
        CompanionFreshnessReducer.reduce(status, now: now ?? reference)
    }

    private func makeStatus(
        revision: UInt64,
        observedAt: Date? = nil,
        copierState: MacCompanionStatusDTO.CopierState = .disarmed,
        sessionExpiresAt: Date? = nil,
        brokerConnected: Bool? = true,
        reconciliation: MacCompanionStatusDTO.ReconciliationDTO.Status = .clean,
        divergences: [MacCompanionStatusDTO.DivergenceDTO] = [],
        stuckOutboxCount: Int = 0,
        killSwitchTripped: Bool = false,
        exposureVerified: Bool = true,
        problems: [MacCompanionStatusDTO.ProblemDTO] = []
    ) -> MacCompanionStatusDTO {
        let observedAt = observedAt ?? reference
        return .init(
            contractVersion: 1,
            serverTime: observedAt,
            revision: revision,
            observedAt: observedAt,
            validUntil: observedAt.addingTimeInterval(10),
            freshness: .init(verifiedMaxAgeSeconds: 10, offlineAfterSeconds: 90),
            copierState: copierState,
            sessionExpiresAt: copierState == .live
                ? (sessionExpiresAt ?? observedAt.addingTimeInterval(42 * 60))
                : nil,
            worker: .init(lastHeartbeatAt: observedAt, location: .mac),
            brokerConnected: brokerConnected,
            safety: .init(
                reconciliation: .init(status: reconciliation, at: observedAt),
                divergences: divergences,
                outbox: .init(stuckCount: stuckOutboxCount, oldestStuckMinutes: nil),
                cooldownActive: false,
                dayLockActive: false,
                killSwitchTripped: killSwitchTripped
            ),
            exposure: .init(
                verifiedAt: exposureVerified ? observedAt : nil,
                positions: [],
                followerAck: copierState == .live
                    ? .init(confirmed: 1, total: 1, failing: [])
                    : nil,
                accountsWithWorkingOrders: exposureVerified ? 0 : nil
            ),
            snapshots: .init(cdpReady: true, lastEntryAt: nil, lastExitAt: nil),
            problems: problems
        )
    }
}

@MainActor
final class CompanionSettingsTests: XCTestCase {
    func testDefaultsAndPersistence() throws {
        let suite = "CompanionSettingsTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let settings = CompanionSettings(defaults: defaults)
        XCTAssertTrue(settings.autoOpen)
        XCTAssertFalse(settings.includeImprovements)
        XCTAssertTrue(settings.nativeNotifications)
        XCTAssertFalse(settings.worseningSound)

        settings.autoOpen = false
        settings.includeImprovements = true
        settings.nativeNotifications = false
        settings.worseningSound = true

        let reloaded = CompanionSettings(defaults: defaults)
        XCTAssertFalse(reloaded.autoOpen)
        XCTAssertTrue(reloaded.includeImprovements)
        XCTAssertFalse(reloaded.nativeNotifications)
        XCTAssertTrue(reloaded.worseningSound)
    }
}
