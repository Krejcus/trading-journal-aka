import CoreGraphics
import Foundation

@main
struct CompanionTransitionDetectorProbe {
    static let reference = Date(timeIntervalSince1970: 1_800_000_000)

    static func main() {
        var checks = 0
        func expect(
            _ condition: @autoclosure () -> Bool,
            _ message: String,
            file: StaticString = #filePath,
            line: UInt = #line
        ) {
            guard condition() else {
                fatalError("\(file):\(line): \(message)")
            }
            checks += 1
        }

        let clean = reduced(status(revision: 1))
        let disarmedUnverified = reduced(status(revision: 2, exposureVerified: false))
        expect(
            disarmedUnverified.displayState == .disarmedUnverified,
            "fresh clean DISARMED without exposure evidence must be VYPNUTO"
        )
        expect(!disarmedUnverified.exposureEvidence.mayClaimFlat, "VYPNUTO must never claim flat")
        let disarmedPresentation = CompanionRemotePresentationFactory.make(
            from: disarmedUnverified,
            now: reference
        )
        expect(disarmedPresentation.menuBar.pillText == "VYPNUTO", "VYPNUTO pill text")
        expect(disarmedPresentation.menuBar.symbolName == "power", "VYPNUTO power symbol")
        expect(disarmedPresentation.hero.title == "VYPNUTO", "VYPNUTO hero title")
        expect(
            disarmedPresentation.hero.supportingText == "Expozice není brokerem ověřena — flat nelze tvrdit",
            "VYPNUTO must disclose missing exposure evidence"
        )
        expect(disarmedPresentation.banner == nil, "VYPNUTO must not use a large warning banner")
        expect(
            disarmedPresentation.sections.allSatisfy { !$0.isInitiallyExpanded },
            "VYPNUTO sections must start collapsed"
        )
        expect(
            disarmedPresentation.footer.actions.map(\.id)
                == [.openLive, .openJournal, .refresh, .copyDiagnostics],
            "VYPNUTO footer actions"
        )
        expect(
            disarmedPresentation.footer.actions.first?.title == "Zapnout v LIVE",
            "VYPNUTO primary action must navigate to LIVE"
        )
        expect(
            disarmedPresentation.footer.actions.first?.symbolName == nil,
            "VYPNUTO primary action must not show an ARM icon"
        )
        expect(
            CompanionDestination.liveOverview.url?.query == "page=live&tab=overview",
            "LIVE destination must target the overview copier controls"
        )

        let staleDisarmed = reduced(
            status(revision: 2, exposureVerified: false),
            now: reference.addingTimeInterval(11)
        )
        expect(staleDisarmed.displayState == .unknown, "stale DISARMED must remain UNKNOWN")

        let rules = dailyRules()
        let lock = dayLock(trigger: .losingTrades)
        let locked = reduced(status(revision: 3, dayLock: lock, dailyRules: rules))
        expect(locked.displayState == .locked, "verified DISARMED day lock must be ZAMČENO")
        let lockedPresentation = CompanionRemotePresentationFactory.make(from: locked, now: reference)
        expect(lockedPresentation.menuBar.pillText == "ZAMČENO", "ZAMČENO pill text")
        expect(lockedPresentation.menuBar.symbolName == "lock.fill", "ZAMČENO lock symbol")
        expect(lockedPresentation.hero.title == "DEN ZAMČENÝ", "ZAMČENO hero title")
        expect(
            lockedPresentation.sections.first { $0.id == "daily-rules" }?.isInitiallyExpanded == true,
            "locked daily rules must start expanded"
        )
        expect(
            lockedPresentation.footer.actions.first?.title == "Otevřít LIVE",
            "locked primary action must only open LIVE"
        )
        let staleLocked = reduced(
            status(revision: 3, dayLock: lock, dailyRules: rules),
            now: reference.addingTimeInterval(11)
        )
        expect(staleLocked.displayState == .unknown, "stale lock must be UNKNOWN")
        let lockTransition = CompanionTransitionDetector.detect(
            previous: clean,
            next: locked,
            now: reference
        )
        expect(lockTransition?.category == .lock, "entering ZAMČENO must be a lock transition")
        expect(lockTransition?.category.autoCloseDuration == 60, "lock transition must stay open for 60 seconds")
        expect(lockTransition?.category.allowsSound == true, "lock transition may use optional sound")
        let lockNotification = [lockTransition?.notificationTitle, lockTransition?.notificationBody]
            .compactMap { $0 }
            .joined(separator: "\n")
        expect(!lockNotification.contains("620"), "lock notification must omit dollar amounts")
        expect(!lockNotification.localizedCaseInsensitiveContains("account"), "lock notification must omit accounts")
        expect(
            CompanionTransitionDetector.detect(
                previous: clean,
                next: disarmedUnverified,
                now: reference
            ) == nil,
            "verified DISARMED to VYPNUTO must not worsen"
        )
        let divergence = reduced(status(
            revision: 2,
            divergences: [.init(symbol: "MNQ", account: "redacted", detail: "qty")]
        ))
        let divergenceTransition = CompanionTransitionDetector.detect(
            previous: clean,
            next: divergence,
            now: reference
        )
        expect(divergenceTransition?.category == .worsening, "new divergence must worsen")
        expect(divergenceTransition?.rowID == "divergence-0", "divergence row must be targeted")

        let deferredReconciliation = reduced(status(revision: 2, reconciliation: .review))
        expect(deferredReconciliation.issueCount == 0, "disabled clean review must not be an issue")
        expect(deferredReconciliation.displayState == .disarmed, "disabled clean review must remain VYPNUTO")
        let deferredPresentation = CompanionRemotePresentationFactory.make(
            from: deferredReconciliation,
            now: reference
        )
        expect(deferredPresentation.menuBar.pillText == "VYPNUTO", "disabled review must keep VYPNUTO pill")
        let deferredSafety = deferredPresentation.sections.first { $0.id == "safety" }
        expect(deferredSafety?.summary == "Kontrola před zapnutím", "disabled review safety summary")
        expect(deferredSafety?.summaryTone == .warning, "disabled review summary must be amber")
        expect(deferredSafety?.hasProblem == false, "disabled review must not mark safety as a problem")
        expect(deferredSafety?.isInitiallyExpanded == false, "disabled review must stay collapsed")
        expect(
            deferredSafety?.rows.contains { row in
                guard case .keyValue(let value) = row else { return false }
                return value.id == "reconciliation"
                    && value.value == "Proběhne před zapnutím"
                    && value.tone == .warning
            } == true,
            "disabled review row must describe deferred preflight"
        )
        expect(
            CompanionTransitionDetector.detect(
                previous: clean,
                next: deferredReconciliation,
                now: reference
            ) == nil,
            "disabled clean review must not auto-open"
        )

        let reconciliation = reduced(status(
            revision: 2,
            copierState: .live,
            reconciliation: .review
        ))
        expect(reconciliation.displayState == .intervention(issueCount: 1), "LIVE review must require intervention")
        expect(
            CompanionTransitionDetector.detect(previous: clean, next: reconciliation, now: reference)?.rowID == "reconciliation",
            "LIVE reconciliation review must target its row"
        )

        let disabledReviewWithDivergence = reduced(status(
            revision: 2,
            reconciliation: .review,
            divergences: [.init(symbol: "MNQ", account: "redacted", detail: "qty")]
        ))
        expect(
            disabledReviewWithDivergence.displayState == .intervention(issueCount: 2),
            "disabled review with divergence must require intervention"
        )

        let shadowReview = reduced(status(
            revision: 2,
            copierState: .shadow,
            reconciliation: .review
        ))
        expect(shadowReview.displayState == .shadow, "SHADOW clean review must remain SHADOW")
        let shadowReviewPresentation = CompanionRemotePresentationFactory.make(
            from: shadowReview,
            now: reference
        )
        expect(shadowReviewPresentation.menuBar.pillText == "SHADOW", "SHADOW review must keep SHADOW pill")
        expect(
            shadowReviewPresentation.sections.first { $0.id == "safety" }?.isInitiallyExpanded == false,
            "SHADOW clean review safety must stay collapsed"
        )

        let stuck = reduced(status(revision: 2, stuckOutboxCount: 1))
        expect(
            CompanionTransitionDetector.detect(previous: clean, next: stuck, now: reference)?.rowID == "outbox",
            "new stuck outbox must target its row"
        )

        let intervention = reduced(status(revision: 2, killSwitchTripped: true))
        expect(
            CompanionTransitionDetector.detect(previous: clean, next: intervention, now: reference)?.category == .worsening,
            "verified intervention must worsen"
        )

        let disconnected = reduced(status(revision: 2, brokerConnected: false))
        expect(
            CompanionTransitionDetector.detect(previous: clean, next: disconnected, now: reference)?.category == .worsening,
            "broker disconnect must worsen"
        )
        expect(
            CompanionTransitionDetector.detect(previous: disconnected, next: clean, now: reference)?.category == .improvement,
            "broker reconnect must improve"
        )

        let live = reduced(status(revision: 3, copierState: .live))
        expect(
            CompanionTransitionDetector.detect(previous: clean, next: live, now: reference)?.category == .mode,
            "DISARMED to LIVE must be a mode transition"
        )
        expect(
            CompanionTransitionDetector.detect(previous: disarmedUnverified, next: live, now: reference)?.category == .mode,
            "VYPNUTO to LIVE must be a mode transition"
        )
        let shadow = reduced(status(revision: 4, copierState: .shadow))
        expect(
            CompanionTransitionDetector.detect(previous: shadow, next: live, now: reference)?.category == .mode,
            "SHADOW to LIVE must be a mode transition"
        )
        expect(
            CompanionTransitionDetector.detect(previous: live, next: clean, now: reference)?.category == .mode,
            "LIVE to DISARMED must be a mode transition"
        )
        expect(
            CompanionTransitionDetector.detect(previous: live, next: disarmedUnverified, now: reference)?.category == .mode,
            "LIVE to VYPNUTO must be a mode transition"
        )
        expect(
            CompanionTransitionDetector.detect(previous: live, next: shadow, now: reference)?.category == .mode,
            "LIVE to SHADOW must be a mode transition"
        )
        expect(
            CompanionTransitionDetector.detect(previous: clean, next: shadow, now: reference)?.category == .mode,
            "VYPNUTO to SHADOW must be a mode transition"
        )
        expect(
            CompanionTransitionDetector.detect(previous: disarmedUnverified, next: shadow, now: reference)?.category == .mode,
            "VYPNUTO to SHADOW must be a mode transition"
        )
        expect(
            CompanionTransitionDetector.detect(previous: shadow, next: disarmedUnverified, now: reference)?.category == .mode,
            "SHADOW to VYPNUTO must be a mode transition"
        )

        let expiry = reference.addingTimeInterval(301)
        let expiringStatus = status(
            revision: 5,
            copierState: .live,
            sessionExpiresAt: expiry
        )
        expect(
            CompanionTransitionDetector.detect(
                previous: reduced(expiringStatus, now: reference),
                next: reduced(expiringStatus, now: reference.addingTimeInterval(2)),
                now: reference.addingTimeInterval(2)
            )?.category == .worsening,
            "entering the final five LIVE minutes must worsen"
        )

        let expiredStatus = status(
            revision: 6,
            copierState: .live,
            sessionExpiresAt: reference.addingTimeInterval(2)
        )
        expect(
            CompanionTransitionDetector.detect(
                previous: reduced(expiredStatus, now: reference),
                next: reduced(expiredStatus, now: reference.addingTimeInterval(3)),
                now: reference.addingTimeInterval(3)
            )?.category == .worsening,
            "expired LIVE session must worsen"
        )

        let unknown = reduced(status(revision: 3), now: reference.addingTimeInterval(11))
        expect(
            CompanionTransitionDetector.detect(
                previous: clean,
                next: unknown,
                now: reference.addingTimeInterval(11)
            ) == nil,
            "10-90 second UNKNOWN must be silent"
        )
        expect(
            CompanionTransitionDetector.detect(
                previous: unknown,
                next: clean,
                now: reference
            ) == nil,
            "UNKNOWN back to the same verified state must be silent"
        )

        let staleResolved = reduced(status(revision: 4), now: reference.addingTimeInterval(11))
        expect(
            CompanionTransitionDetector.detect(
                previous: divergence,
                next: staleResolved,
                now: reference.addingTimeInterval(11)
            ) == nil,
            "stale data must never report improvement"
        )

        let offline = reduced(status(revision: 3), now: reference.addingTimeInterval(91))
        expect(
            CompanionTransitionDetector.detect(
                previous: clean,
                next: offline,
                now: reference.addingTimeInterval(91)
            )?.category == .worsening,
            "WORKER OFFLINE must worsen"
        )

        var gate = CompanionTransitionGate()
        expect(observe(&gate, clean, monotonic: 0, source: .startup) == nil, "startup must baseline")
        expect(observe(&gate, disconnected, monotonic: 1) == nil, "anti-flap must wait")
        expect(observe(&gate, disconnected, monotonic: 3.9) == nil, "anti-flap must wait full 3 seconds")
        expect(observe(&gate, disconnected, monotonic: 4)?.allowsAutoOpen == true, "settled worsening must open")

        var flapGate = CompanionTransitionGate()
        expect(observe(&flapGate, clean, monotonic: 0) == nil, "flap baseline setup")
        expect(observe(&flapGate, disconnected, monotonic: 1) == nil, "flap candidate setup")
        expect(observe(&flapGate, clean, monotonic: 2) == nil, "return before three seconds cancels candidate")
        expect(observe(&flapGate, clean, monotonic: 5) == nil, "canceled flap must never emit")

        let reconnected = reduced(status(revision: 3))
        expect(observe(&gate, reconnected, monotonic: 5, improvements: true) == nil, "second transition must settle")
        expect(
            observe(&gate, reconnected, monotonic: 8, improvements: true)?.allowsAutoOpen == false,
            "30 second rate limit must suppress the second auto-open"
        )

        var wakeRateLimitGate = CompanionTransitionGate()
        expect(observe(&wakeRateLimitGate, clean, monotonic: 0) == nil, "wake rate-limit baseline setup")
        expect(observe(&wakeRateLimitGate, disconnected, monotonic: 1) == nil, "wake rate-limit first candidate")
        expect(
            observe(&wakeRateLimitGate, disconnected, monotonic: 4)?.allowsAutoOpen == true,
            "wake rate-limit first transition must open"
        )
        expect(
            observe(&wakeRateLimitGate, reconnected, monotonic: 5, improvements: true) == nil,
            "wake rate-limit second candidate must begin settling"
        )
        wakeRateLimitGate.resetAutoOpenRateLimit()
        expect(
            observe(&wakeRateLimitGate, reconnected, monotonic: 8, improvements: true)?.allowsAutoOpen == true,
            "wake must release only the rate limit and preserve the candidate"
        )

        var notificationLimiter = CompanionNotificationRateLimiter()
        let notificationStart = Date(timeIntervalSinceReferenceDate: 100)
        expect(notificationLimiter.allowsNotification(at: notificationStart), "first notification must be allowed")
        expect(!notificationLimiter.allowsNotification(at: notificationStart.addingTimeInterval(29.999)), "notification must be limited inside 30 seconds")
        expect(notificationLimiter.allowsNotification(at: notificationStart.addingTimeInterval(30)), "notification must be allowed at 30 seconds")
        expect(!notificationLimiter.allowsNotification(at: notificationStart.addingTimeInterval(30.001)), "notification limiter must use its own window")

        let warning = MacCompanionStatusDTO.RuleWarningDTO(
            rule: .losingTrades,
            current: 1,
            limit: 2,
            at: reference
        )
        let withoutWarning = reduced(status(
            revision: 10,
            exposureVerified: false,
            dailyRules: dailyRules(warnings: [])
        ))
        let withWarning = reduced(status(
            revision: 11,
            exposureVerified: false,
            dailyRules: dailyRules(warnings: [warning])
        ))
        var warningGate = CompanionTransitionGate()
        expect(observe(&warningGate, withoutWarning, monotonic: 0) == nil, "warning baseline")
        expect(observe(&warningGate, withWarning, monotonic: 1) == nil, "warning anti-flap")
        let warningEvent = observe(&warningGate, withWarning, monotonic: 4)
        expect(warningEvent?.transition.category == .ruleWarning, "new warning must notify")
        expect(warningEvent?.transition.category.allowsSound == false, "warning must be silent")
        expect(warningEvent?.allowsAutoOpen == false, "warning must not auto-open")
        expect(observe(&warningGate, withWarning, monotonic: 5) == nil, "warning must emit only once in session")

        let expiredLock = reduced(status(
            revision: 12,
            exposureVerified: false,
            dailyRules: dailyRules(sessionEndsAt: reference.addingTimeInterval(24 * 60 * 60))
        ))
        let expiryTransition = CompanionTransitionDetector.detect(
            previous: locked,
            next: expiredLock,
            now: reference
        )
        expect(expiryTransition?.category == .lockExpired, "new session must expire the lock")
        expect(expiryTransition?.category.allowsSound == false, "lock expiry must be silent")
        expect(expiredLock.status.copierState == .disarmed, "lock expiry must never enable copier")

        var rollbackGate = CompanionTransitionGate()
        let revisionTwo = reduced(status(revision: 2))
        let revisionOneDisconnected = reduced(status(revision: 1, brokerConnected: false))
        expect(observe(&rollbackGate, revisionTwo, monotonic: 0) == nil, "first snapshot must baseline")
        expect(observe(&rollbackGate, revisionOneDisconnected, monotonic: 1) == nil, "rollback must be ignored")
        expect(observe(&rollbackGate, revisionOneDisconnected, monotonic: 5) == nil, "rollback must never mature")

        var wakeGate = CompanionTransitionGate()
        expect(observe(&wakeGate, clean, monotonic: 0) == nil, "wake baseline setup")
        expect(observe(&wakeGate, disconnected, monotonic: 1, source: .wake) == nil, "wake must suppress")
        expect(observe(&wakeGate, disconnected, monotonic: 5) == nil, "wake state stays baseline")

        for source in [CompanionTransitionObservationSource.startup, .manualRefresh] {
            var suppressedGate = CompanionTransitionGate()
            expect(observe(&suppressedGate, clean, monotonic: 0) == nil, "suppressed baseline setup")
            expect(
                observe(&suppressedGate, disconnected, monotonic: 1, source: source) == nil,
                "startup/manual refresh must suppress"
            )
            expect(observe(&suppressedGate, disconnected, monotonic: 5) == nil, "suppressed state stays baseline")
        }

        var disabledGate = CompanionTransitionGate()
        expect(observe(&disabledGate, clean, monotonic: 0) == nil, "disabled baseline setup")
        expect(observe(&disabledGate, disconnected, monotonic: 1, autoOpen: false) == nil, "disabled still settles")
        expect(
            observe(&disabledGate, disconnected, monotonic: 4, autoOpen: false)?.allowsAutoOpen == false,
            "disabled setting must not auto-open"
        )

        var improvementDisabledGate = CompanionTransitionGate()
        expect(observe(&improvementDisabledGate, disconnected, monotonic: 0) == nil, "improvement baseline setup")
        let newerClean = reduced(status(revision: 3))
        expect(observe(&improvementDisabledGate, newerClean, monotonic: 1) == nil, "improvement candidate setup")
        expect(
            observe(&improvementDisabledGate, newerClean, monotonic: 4)?.allowsAutoOpen == false,
            "improvements setting defaults to off"
        )

        expect(CompanionTransitionMotionPolicy.pulseCount(reduceMotion: false) == 3, "normal motion must pulse three times")
        expect(CompanionTransitionMotionPolicy.pulseCount(reduceMotion: true) == 0, "Reduce Motion must not pulse")
        expect(!CompanionTransitionMotionPolicy.highlightsChangedRow(reduceMotion: true), "Reduce Motion must not highlight")

        var expansionResize = PopoverResizeCoordinator()
        expect(
            expansionResize.reset(initialSize: CGSize(width: 500, height: 300))
                == .setImmediately(CGSize(width: 360, height: 300)),
            "initial popover width must normalize to 360"
        )
        expect(
            expansionResize.beginSectionTransition(
                .init(heightDelta: 100, reduceMotion: false),
                isPopoverVisible: true
            ) == .expandImmediately(CGSize(width: 360, height: 400), duration: 0.25),
            "section expansion must reserve its final height immediately"
        )
        for height in [318.0, 351.5, 383.0, 399.5] {
            expect(
                expansionResize.observeMeasuredSize(
                    CGSize(width: 360, height: height),
                    isPopoverVisible: true,
                    reduceMotion: false
                ) == nil,
                "intermediate expansion measurements must be coalesced"
            )
        }
        expect(
            expansionResize.completeSectionTransition(
                isPopoverVisible: true,
                reduceMotion: false
            ) == nil,
            "final expansion measurement must not cause a second resize"
        )

        var collapseResize = PopoverResizeCoordinator()
        _ = collapseResize.reset(initialSize: CGSize(width: 360, height: 400))
        expect(
            collapseResize.beginSectionTransition(
                .init(heightDelta: -100, reduceMotion: false),
                isPopoverVisible: true
            ) == .collapseAfterContentAnimation(CGSize(width: 360, height: 300), duration: 0.25),
            "collapse must defer the smaller height until content is hidden"
        )
        for height in [389.0, 366.0, 332.0, 300.4] {
            expect(
                collapseResize.observeMeasuredSize(
                    CGSize(width: 360, height: height),
                    isPopoverVisible: true,
                    reduceMotion: false
                ) == nil,
                "intermediate collapse measurements must never resize immediately"
            )
        }
        expect(collapseResize.isCoalescingSectionMeasurements, "collapse must stay coalesced until animation completion")
        expect(
            collapseResize.completeSectionTransition(
                isPopoverVisible: true,
                reduceMotion: false
            ) == .setImmediately(CGSize(width: 360, height: 300)),
            "completed collapse must apply its smaller height once"
        )

        var reducedMotionResize = PopoverResizeCoordinator()
        _ = reducedMotionResize.reset(initialSize: CGSize(width: 360, height: 300.2))
        expect(
            reducedMotionResize.beginSectionTransition(
                .init(heightDelta: 99.2, reduceMotion: true),
                isPopoverVisible: true
            ) == .setImmediately(CGSize(width: 360, height: 401)),
            "Reduce Motion must resize immediately"
        )

        print("CompanionTransitionDetectorProbe PASS (\(checks) checks)")
    }

    static func observe(
        _ gate: inout CompanionTransitionGate,
        _ value: ReducedCompanionStatus,
        monotonic: TimeInterval,
        source: CompanionTransitionObservationSource = .automatic,
        autoOpen: Bool = true,
        improvements: Bool = false
    ) -> CompanionTransitionGateResult? {
        gate.observe(
            value,
            now: reference,
            monotonicNow: monotonic,
            source: source,
            autoOpenEnabled: autoOpen,
            improvementsEnabled: improvements
        )
    }

    static func reduced(
        _ value: MacCompanionStatusDTO,
        now: Date? = nil
    ) -> ReducedCompanionStatus {
        CompanionFreshnessReducer.reduce(value, now: now ?? reference)
    }

    static func status(
        revision: UInt64,
        copierState: MacCompanionStatusDTO.CopierState = .disarmed,
        sessionExpiresAt: Date? = nil,
        brokerConnected: Bool? = true,
        reconciliation: MacCompanionStatusDTO.ReconciliationDTO.Status = .clean,
        divergences: [MacCompanionStatusDTO.DivergenceDTO] = [],
        stuckOutboxCount: Int = 0,
        killSwitchTripped: Bool = false,
        exposureVerified: Bool = true,
        dayLock: MacCompanionStatusDTO.DayLockDTO? = nil,
        dailyRules: MacCompanionStatusDTO.DailyRulesDTO? = nil
    ) -> MacCompanionStatusDTO {
        .init(
            contractVersion: 1,
            serverTime: reference,
            revision: revision,
            observedAt: reference,
            validUntil: reference.addingTimeInterval(10),
            freshness: .init(verifiedMaxAgeSeconds: 10, offlineAfterSeconds: 90),
            copierState: copierState,
            sessionExpiresAt: copierState == .live
                ? (sessionExpiresAt ?? reference.addingTimeInterval(42 * 60))
                : nil,
            worker: .init(lastHeartbeatAt: reference, location: .mac),
            brokerConnected: brokerConnected,
            dayLock: dayLock,
            dailyRules: dailyRules,
            safety: .init(
                reconciliation: .init(status: reconciliation, at: reference),
                divergences: divergences,
                outbox: .init(stuckCount: stuckOutboxCount, oldestStuckMinutes: nil),
                cooldownActive: false,
                dayLockActive: dayLock?.active ?? false,
                killSwitchTripped: killSwitchTripped
            ),
            exposure: .init(
                verifiedAt: exposureVerified ? reference : nil,
                positions: [],
                followerAck: copierState == .live
                    ? .init(confirmed: 1, total: 1, failing: [])
                    : nil,
                accountsWithWorkingOrders: exposureVerified ? 0 : nil
            ),
            snapshots: .init(cdpReady: true, lastEntryAt: nil, lastExitAt: nil),
            problems: []
        )
    }

    static func dayLock(
        trigger: MacCompanionStatusDTO.DayLockTrigger
    ) -> MacCompanionStatusDTO.DayLockDTO {
        .init(
            active: true,
            until: reference.addingTimeInterval(60 * 60),
            at: reference.addingTimeInterval(-60),
            trigger: trigger,
            reason: "Limit dosažen",
            unlocked: nil
        )
    }

    static func dailyRules(
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
