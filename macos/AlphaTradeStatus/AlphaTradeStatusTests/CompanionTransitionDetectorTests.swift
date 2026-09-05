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

    func testLockTransitionBehavesLikeWorseningWithoutAmountsOrAccounts() throws {
        let unlocked = reduced(makeStatus(revision: 1))
        let locked = reduced(makeStatus(
            revision: 2,
            dayLock: makeDayLock(trigger: .losingTrades),
            dailyRules: makeDailyRules()
        ))

        let transition = try XCTUnwrap(CompanionTransitionDetector.detect(
            previous: unlocked,
            next: locked,
            now: reference
        ))
        XCTAssertEqual(transition.category, .lock)
        XCTAssertEqual(transition.sectionID, "daily-rules")
        XCTAssertEqual(transition.rowID, "rule-losing-trades")
        XCTAssertEqual(transition.category.autoCloseDuration, 60)
        XCTAssertTrue(transition.category.allowsSound)
        XCTAssertEqual(
            transition.notificationTitle,
            "Den zamčen do \(CompanionDisplayFormatting.shortTime(try XCTUnwrap(locked.status.dayLock).until))"
        )
        XCTAssertTrue(transition.notificationBody?.contains("2 ztrátové obchody z 2") == true)

        let notification = [transition.notificationTitle, transition.notificationBody]
            .compactMap { $0 }
            .joined(separator: "\n")
        XCTAssertFalse(notification.contains("620"))
        XCTAssertFalse(notification.contains("1 000"))
        XCTAssertFalse(notification.localizedCaseInsensitiveContains("account"))

        var gate = CompanionTransitionGate()
        XCTAssertNil(observe(&gate, unlocked, monotonic: 0))
        XCTAssertNil(observe(&gate, locked, monotonic: 1))
        let event = try XCTUnwrap(observe(&gate, locked, monotonic: 4))
        XCTAssertEqual(event.transition.category, .lock)
        XCTAssertTrue(event.allowsAutoOpen)
    }

    func testPauseTransitionAutoOpensAfterSettlingAndYieldsToCriticalProblems() throws {
        let live = reduced(makeStatus(revision: 1, copierState: .live))
        let pause = makePause(rule: .dailyLoss)
        let paused = reduced(makeStatus(
            revision: 2,
            copierState: .live,
            dailyRules: makeDailyRules(),
            pause: pause
        ))

        let transition = try XCTUnwrap(CompanionTransitionDetector.detect(
            previous: live,
            next: paused,
            now: reference
        ))
        XCTAssertEqual(transition.category, .pause)
        XCTAssertEqual(transition.sectionID, "daily-rules")
        XCTAssertEqual(transition.rowID, "rule-daily-loss")
        XCTAssertEqual(transition.category.autoCloseDuration, 8)
        XCTAssertFalse(transition.category.allowsSound)
        XCTAssertEqual(
            transition.notificationTitle,
            "Pauza do \(CompanionDisplayFormatting.shortTime(pause.until))"
        )
        XCTAssertTrue(transition.notificationBody?.contains("denní ztráta") == true)

        var gate = CompanionTransitionGate()
        XCTAssertNil(observe(&gate, live, monotonic: 0, source: .startup))
        XCTAssertNil(observe(&gate, paused, monotonic: 1))
        let event = try XCTUnwrap(observe(&gate, paused, monotonic: 4))
        XCTAssertEqual(event.transition.category, .pause)
        XCTAssertTrue(event.allowsAutoOpen)

        let extendedPause = reduced(makeStatus(
            revision: 3,
            copierState: .live,
            dailyRules: makeDailyRules(),
            pause: .init(until: pause.until.addingTimeInterval(5 * 60), rule: .dailyLoss)
        ))
        XCTAssertNil(CompanionTransitionDetector.detect(
            previous: paused,
            next: extendedPause,
            now: reference
        ), "Extending an active pause must not be treated as a new transition into pause")

        let critical = reduced(makeStatus(
            revision: 4,
            copierState: .live,
            divergences: [.init(symbol: "MNQ", account: "hidden", detail: "qty")],
            pause: pause,
            problems: [.init(kind: .divergence, text: "divergence")]
        ))
        let criticalTransition = try XCTUnwrap(CompanionTransitionDetector.detect(
            previous: live,
            next: critical,
            now: reference
        ))
        XCTAssertEqual(critical.displayState, .intervention(issueCount: 1))
        XCTAssertEqual(criticalTransition.category, .worsening)
        XCTAssertEqual(criticalTransition.rowID, "divergence-0")

        let recoveredFromCritical = reduced(makeStatus(
            revision: 5,
            copierState: .live,
            pause: pause
        ))
        XCTAssertEqual(
            CompanionTransitionDetector.detect(
                previous: critical,
                next: recoveredFromCritical,
                now: reference
            )?.category,
            .improvement,
            "Resolving a problem that masked an existing pause must not re-announce the pause"
        )

        let unknownWithSamePause = reduced(makeStatus(
            revision: 6,
            copierState: .live,
            brokerConnected: nil,
            pause: pause
        ))
        let recoveredFromUnknown = reduced(makeStatus(
            revision: 7,
            copierState: .live,
            pause: pause
        ))
        XCTAssertNil(
            CompanionTransitionDetector.detect(
                previous: unknownWithSamePause,
                next: recoveredFromUnknown,
                now: reference
            ),
            "UNKNOWN to the same active pause is only freshness recovery, not a new pause"
        )

        let offlineWithSamePause = reduced(
            makeStatus(revision: 8, copierState: .live, pause: pause),
            now: reference.addingTimeInterval(91)
        )
        let recoveredAt = reference.addingTimeInterval(92)
        let recoveredFromOffline = reduced(
            makeStatus(
                revision: 9,
                observedAt: recoveredAt,
                copierState: .live,
                pause: pause
            ),
            now: recoveredAt
        )
        XCTAssertEqual(
            CompanionTransitionDetector.detect(
                previous: offlineWithSamePause,
                next: recoveredFromOffline,
                now: recoveredAt
            )?.category,
            .improvement,
            "OFFLINE recovery must keep its existing category instead of re-announcing PAUZA"
        )

        let stalePaused = reduced(
            makeStatus(revision: 10, copierState: .live, pause: pause),
            now: reference.addingTimeInterval(11)
        )
        XCTAssertNil(CompanionTransitionDetector.detect(
            previous: live,
            next: stalePaused,
            now: reference.addingTimeInterval(11)
        ))
    }

    func testRuleWarningIsSilentAndEmittedOncePerRuleAndSession() throws {
        let initial = reduced(makeStatus(
            revision: 1,
            dailyRules: makeDailyRules(warnings: [])
        ))
        let warning = MacCompanionStatusDTO.RuleWarningDTO(
            rule: .losingTrades,
            current: 1,
            limit: 2,
            at: reference
        )
        let warned = reduced(makeStatus(
            revision: 2,
            dailyRules: makeDailyRules(warnings: [warning])
        ))

        var gate = CompanionTransitionGate()
        XCTAssertNil(observe(&gate, initial, monotonic: 0))
        XCTAssertNil(observe(&gate, warned, monotonic: 1))
        let first = try XCTUnwrap(observe(&gate, warned, monotonic: 4))
        XCTAssertEqual(first.transition.category, .ruleWarning)
        XCTAssertFalse(first.transition.category.allowsSound)
        XCTAssertNil(first.transition.category.autoCloseDuration)
        XCTAssertFalse(first.allowsAutoOpen)
        XCTAssertEqual(
            first.transition.notificationTitle,
            "Blíží se limit: ztrátové obchody 1 / 2"
        )
        XCTAssertNil(observe(&gate, warned, monotonic: 5))

        let laterRevision = reduced(makeStatus(
            revision: 3,
            dailyRules: makeDailyRules(warnings: [warning])
        ))
        XCTAssertNil(observe(&gate, laterRevision, monotonic: 6))

        let nextSession = reference.addingTimeInterval(24 * 60 * 60)
        let warningNextSession = reduced(makeStatus(
            revision: 4,
            dailyRules: makeDailyRules(sessionEndsAt: nextSession, warnings: [warning])
        ))
        XCTAssertNil(observe(&gate, warningNextSession, monotonic: 7))
        let second = try XCTUnwrap(observe(&gate, warningNextSession, monotonic: 10))
        XCTAssertEqual(second.transition.category, .ruleWarning)
    }

    func testNewSessionExpiresLockAsSilentToastWithoutEnablingCopier() throws {
        let locked = reduced(makeStatus(
            revision: 1,
            dayLock: makeDayLock(trigger: .manual),
            dailyRules: makeDailyRules()
        ))
        let newSessionEnd = reference.addingTimeInterval(24 * 60 * 60)
        let expired = reduced(makeStatus(
            revision: 2,
            copierState: .disarmed,
            dailyRules: makeDailyRules(sessionEndsAt: newSessionEnd)
        ))

        let transition = try XCTUnwrap(CompanionTransitionDetector.detect(
            previous: locked,
            next: expired,
            now: reference
        ))
        XCTAssertEqual(transition.category, .lockExpired)
        XCTAssertEqual(transition.notificationTitle, "Nová session — zámek vypršel")
        XCTAssertFalse(transition.category.allowsSound)
        XCTAssertEqual(transition.category.autoCloseDuration, 8)
        XCTAssertEqual(expired.status.copierState, .disarmed)
        XCTAssertEqual(expired.displayState, .disarmed)
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
        dayLock: MacCompanionStatusDTO.DayLockDTO? = nil,
        dailyRules: MacCompanionStatusDTO.DailyRulesDTO? = nil,
        pause: MacCompanionStatusDTO.PauseDTO? = nil,
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
            dayLock: dayLock,
            dailyRules: dailyRules,
            pause: pause,
            safety: .init(
                reconciliation: .init(status: reconciliation, at: observedAt),
                divergences: divergences,
                outbox: .init(stuckCount: stuckOutboxCount, oldestStuckMinutes: nil),
                cooldownActive: false,
                dayLockActive: dayLock?.active ?? false,
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

    private func makeDayLock(
        trigger: MacCompanionStatusDTO.DayLockTrigger
    ) -> MacCompanionStatusDTO.DayLockDTO {
        .init(
            active: true,
            until: reference.addingTimeInterval(60 * 60),
            at: reference.addingTimeInterval(-60),
            trigger: trigger,
            reason: trigger == .manual ? "Dnes končím" : "Limit dosažen",
            unlocked: nil
        )
    }

    private func makePause(
        rule: MacCompanionStatusDTO.DailyRule
    ) -> MacCompanionStatusDTO.PauseDTO {
        .init(
            until: reference.addingTimeInterval(20 * 60),
            rule: rule
        )
    }

    private func makeDailyRules(
        sessionEndsAt: Date? = nil,
        warnings: [MacCompanionStatusDTO.RuleWarningDTO] = []
    ) -> MacCompanionStatusDTO.DailyRulesDTO {
        .init(
            lossLimitUsd: 1_000,
            realizedLossUsd: -620,
            maxLosingTrades: 2,
            losingTrades: 2,
            maxTrades: 10,
            tradesToday: 4,
            window: .init(enabled: true, from: "15:30", to: "22:00", state: .inside),
            cooldownMinutes: 15,
            cooldownUntil: reference.addingTimeInterval(15 * 60),
            sessionEndsAt: sessionEndsAt ?? reference.addingTimeInterval(60 * 60),
            warnings: warnings
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
