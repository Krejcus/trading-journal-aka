import Foundation

enum CompanionTransitionCategory: String, Equatable, Sendable {
    case worsening
    case improvement
    case mode
    case pause
    case lock
    case ruleWarning
    case lockExpired
}

struct CompanionTransition: Equatable, Sendable {
    let category: CompanionTransitionCategory
    let sectionID: String
    let rowID: String?
    let reason: String
    let notificationTitle: String?
    let notificationBody: String?
    let ruleWarningKey: String?

    init(
        category: CompanionTransitionCategory,
        sectionID: String,
        rowID: String?,
        reason: String,
        notificationTitle: String? = nil,
        notificationBody: String? = nil,
        ruleWarningKey: String? = nil
    ) {
        self.category = category
        self.sectionID = sectionID
        self.rowID = rowID
        self.reason = reason
        self.notificationTitle = notificationTitle
        self.notificationBody = notificationBody
        self.ruleWarningKey = ruleWarningKey
    }
}

extension CompanionTransitionCategory {
    var shouldNotify: Bool {
        switch self {
        case .worsening, .mode, .pause, .lock, .ruleWarning, .lockExpired:
            return true
        case .improvement:
            return false
        }
    }

    var allowsSound: Bool {
        self == .worsening || self == .lock
    }

    var autoCloseDuration: TimeInterval? {
        switch self {
        case .worsening, .lock:
            return 60
        case .improvement, .mode, .pause, .lockExpired:
            return 8
        case .ruleWarning:
            return nil
        }
    }
}

struct CompanionTransitionEvent: Equatable, Sendable {
    let sequence: UInt64
    let transition: CompanionTransition
    let allowsAutoOpen: Bool
}

enum CompanionTransitionObservationSource: Equatable, Sendable {
    case automatic
    case startup
    case wake
    case manualRefresh
}

enum CompanionTransitionDetector {
    static func detect(
        previous: ReducedCompanionStatus,
        next: ReducedCompanionStatus,
        now: Date,
        excludingRuleWarningKeys: Set<String> = []
    ) -> CompanionTransition? {
        if becameOffline(previous, next) {
            return .init(
                category: .worsening,
                sectionID: "runtime",
                rowID: "heartbeat",
                reason: "Worker přestal posílat čerstvý heartbeat."
            )
        }

        // A LIVE expiry is an explicit safety transition, not the ordinary
        // 10-90 second freshness UNKNOWN bridge. It still requires a verified
        // next presentation so stale data can never manufacture an alert.
        if isVerified(next), liveSessionBecameUrgentOrExpired(previous, next, now: now) {
            let expired = next.status.sessionExpiresAt.map { $0 <= now } ?? true
            return .init(
                category: .worsening,
                sectionID: "copying",
                rowID: nil,
                reason: expired
                    ? "LIVE session právě vypršela."
                    : "LIVE session vyprší nejpozději za pět minut."
            )
        }

        // Every remaining positive transition requires current verified data.
        // In particular, no improvement may be inferred from stale snapshots.
        guard isVerified(next) else { return nil }

        if !isLocked(previous.displayState), isLocked(next.displayState),
           let lock = next.status.dayLock {
            let until = CompanionDisplayFormatting.shortTime(lock.until)
            let rule = notificationRuleText(lock.trigger, rules: next.status.dailyRules)
            return .init(
                category: .lock,
                sectionID: next.status.dailyRules == nil ? "safety" : "daily-rules",
                rowID: rowID(for: lock.trigger),
                reason: "Den byl zamčen do \(until) pravidlem \(rule).",
                notificationTitle: "Den zamčen do \(until)",
                notificationBody: lockNotificationBody(lock: lock, rules: next.status.dailyRules)
            )
        }

        if isLocked(previous.displayState),
           isDisabled(next.displayState),
           sessionChanged(previous.status.dailyRules, next.status.dailyRules) {
            return .init(
                category: .lockExpired,
                sectionID: next.status.dailyRules == nil ? "safety" : "daily-rules",
                rowID: nil,
                reason: "Nová session — zámek vypršel.",
                notificationTitle: "Nová session — zámek vypršel",
                notificationBody: "Copier je vypnutý. Pravidla dne začínají od nuly; zapnout v LIVE."
            )
        }

        if let problem = newlyWorsenedProblem(previous.status, next.status) {
            return problem
        }

        if previous.status.brokerConnected == true,
           next.status.brokerConnected == false {
            return .init(
                category: .worsening,
                sectionID: "runtime",
                rowID: "broker-connection",
                reason: "Broker spojení se odpojilo."
            )
        }

        if !isIntervention(previous.displayState), isIntervention(next.displayState) {
            let target = interventionTarget(next.status)
            return .init(
                category: .worsening,
                sectionID: target.sectionID,
                rowID: target.rowID,
                reason: "Stav copieru nově vyžaduje kontrolu."
            )
        }

        if !isPaused(previous.displayState), isPaused(next.displayState),
           previous.status.pause != next.status.pause,
           let pause = next.status.pause, pause.until > now {
            let until = CompanionDisplayFormatting.shortTime(pause.until)
            let rule = pauseRuleText(pause.rule)
            return .init(
                category: .pause,
                sectionID: next.status.dailyRules == nil ? "safety" : "daily-rules",
                rowID: rowID(for: pause.rule),
                reason: "Pauza do \(until) · \(rule).",
                notificationTitle: "Pauza do \(until)",
                notificationBody: "Pravidlo: \(rule). Nové vstupy se nekopírují; exity pokračují."
            )
        }

        if isOffline(previous.displayState) {
            return .init(
                category: .improvement,
                sectionID: "runtime",
                rowID: "heartbeat",
                reason: "Worker znovu poskytuje ověřený stav."
            )
        }

        if let improvement = resolvedProblem(previous.status, next.status) {
            return improvement
        }

        if previous.status.brokerConnected == false,
           next.status.brokerConnected == true {
            return .init(
                category: .improvement,
                sectionID: "runtime",
                rowID: "broker-connection",
                reason: "Broker spojení je znovu připojeno."
            )
        }

        if isIntervention(previous.displayState), !isIntervention(next.displayState) {
            return .init(
                category: .improvement,
                sectionID: "safety",
                rowID: "reconciliation",
                reason: "Problém vyžadující zásah zmizel."
            )
        }

        if let warning = newlyAddedRuleWarning(
            previous: previous.status,
            next: next.status,
            excluding: excludingRuleWarningKeys
        ) {
            return warning
        }

        if let mode = modeTransition(previous, next) {
            return mode
        }

        return nil
    }
}

struct CompanionTransitionGate {
    static let settlingInterval: TimeInterval = 3
    static let autoOpenRateLimit: TimeInterval = 30

    private struct Candidate {
        var status: ReducedCompanionStatus
        let signature: StableSignature
        let since: TimeInterval
    }

    private var settled: ReducedCompanionStatus?
    private var settledSignature: StableSignature?
    private var candidate: Candidate?
    private var highestRevision: UInt64?
    private var lastAutoOpenAt: TimeInterval?
    private var seenRuleWarningKeys = Set<String>()

    mutating func reset() {
        settled = nil
        settledSignature = nil
        candidate = nil
        highestRevision = nil
        lastAutoOpenAt = nil
        seenRuleWarningKeys = []
    }

    mutating func resetAutoOpenRateLimit() {
        // A wake may follow far more than 30 seconds of wall time even though
        // ProcessInfo.systemUptime barely advanced. Preserve the settled
        // state, revision guard, and any anti-flap candidate; only the
        // delivery window is no longer trustworthy after sleep.
        lastAutoOpenAt = nil
    }

    mutating func observe(
        _ next: ReducedCompanionStatus,
        now: Date,
        monotonicNow: TimeInterval,
        source: CompanionTransitionObservationSource,
        autoOpenEnabled: Bool,
        improvementsEnabled: Bool
    ) -> CompanionTransitionGateResult? {
        if let highestRevision, next.status.revision < highestRevision {
            return nil
        }
        highestRevision = max(highestRevision ?? 0, next.status.revision)

        let signature = StableSignature(status: next, now: now)
        guard source == .automatic else {
            settleImmediately(next, signature: signature)
            return nil
        }

        guard let previous = settled, let previousSignature = settledSignature else {
            settleImmediately(next, signature: signature)
            return nil
        }

        if signature == previousSignature {
            settled = next
            candidate = nil
            guard let warning = CompanionTransitionDetector.currentRuleWarning(
                in: next.status,
                excluding: seenRuleWarningKeys
            ) else { return nil }
            return result(
                for: warning,
                monotonicNow: monotonicNow,
                autoOpenEnabled: autoOpenEnabled,
                improvementsEnabled: improvementsEnabled
            )
        }

        if candidate?.signature != signature {
            candidate = Candidate(status: next, signature: signature, since: monotonicNow)
            return nil
        }

        candidate?.status = next
        guard let candidate,
              monotonicNow - candidate.since >= Self.settlingInterval else {
            return nil
        }

        settled = candidate.status
        settledSignature = candidate.signature
        self.candidate = nil

        guard let transition = CompanionTransitionDetector.detect(
            previous: previous,
            next: candidate.status,
            now: now,
            excludingRuleWarningKeys: seenRuleWarningKeys
        ) else {
            return nil
        }

        if transition.category == .lock {
            seenRuleWarningKeys.formUnion(
                CompanionTransitionDetector.ruleWarningKeys(in: candidate.status.status)
            )
        }

        return result(
            for: transition,
            monotonicNow: monotonicNow,
            autoOpenEnabled: autoOpenEnabled,
            improvementsEnabled: improvementsEnabled
        )
    }

    private mutating func result(
        for transition: CompanionTransition,
        monotonicNow: TimeInterval,
        autoOpenEnabled: Bool,
        improvementsEnabled: Bool
    ) -> CompanionTransitionGateResult {
        if let warningKey = transition.ruleWarningKey {
            seenRuleWarningKeys.insert(warningKey)
        }
        let settingAllowsAutoOpen = autoOpenEnabled
            && (transition.category != .improvement || improvementsEnabled)
            && transition.category.autoCloseDuration != nil
        let outsideRateLimit = lastAutoOpenAt.map {
            monotonicNow - $0 >= Self.autoOpenRateLimit
        } ?? true
        let allowsAutoOpen = settingAllowsAutoOpen && outsideRateLimit
        if allowsAutoOpen {
            lastAutoOpenAt = monotonicNow
        }

        return .init(transition: transition, allowsAutoOpen: allowsAutoOpen)
    }

    private mutating func settleImmediately(
        _ status: ReducedCompanionStatus,
        signature: StableSignature
    ) {
        settled = status
        settledSignature = signature
        candidate = nil
        seenRuleWarningKeys.formUnion(CompanionTransitionDetector.ruleWarningKeys(in: status.status))
    }
}

struct CompanionNotificationRateLimiter {
    static let interval = CompanionTransitionGate.autoOpenRateLimit

    private var lastNotificationAt: Date?

    mutating func allowsNotification(at wallClockTime: Date) -> Bool {
        let outsideRateLimit = lastNotificationAt.map {
            wallClockTime.timeIntervalSince($0) >= Self.interval
        } ?? true
        guard outsideRateLimit else { return false }
        lastNotificationAt = wallClockTime
        return true
    }
}

struct CompanionTransitionGateResult: Equatable, Sendable {
    let transition: CompanionTransition
    let allowsAutoOpen: Bool
}

enum CompanionTransitionMotionPolicy {
    static func pulseCount(reduceMotion: Bool) -> Int {
        reduceMotion ? 0 : 3
    }

    static func highlightsChangedRow(reduceMotion: Bool) -> Bool {
        !reduceMotion
    }
}

private struct StableSignature: Equatable {
    let freshness: String
    let displayState: String
    let copierState: String
    let brokerConnected: Bool?
    let reconciliation: String
    let divergences: [String]
    let stuckOutboxCount: Int
    let killSwitchTripped: Bool
    let followerAcknowledgementProblem: Bool
    let disarmedExposure: Bool
    let problems: [String]
    let dayLock: String
    let pause: String
    let ruleWarnings: [String]
    let sessionEndsAt: Date?

    init(status reduced: ReducedCompanionStatus, now _: Date) {
        let status = reduced.status
        freshness = CompanionTransitionDetector.freshnessKey(reduced.freshness)
        displayState = CompanionTransitionDetector.displayKey(reduced.displayState)
        copierState = status.copierState.rawValue
        brokerConnected = status.brokerConnected
        reconciliation = status.safety.reconciliation.status.rawValue
        divergences = status.safety.divergences.map {
            "\($0.symbol ?? "")|\($0.account)|\($0.detail)"
        }.sorted()
        stuckOutboxCount = status.safety.outbox.stuckCount
        killSwitchTripped = status.safety.killSwitchTripped
        followerAcknowledgementProblem = CompanionTransitionDetector.hasFollowerProblem(status)
        disarmedExposure = CompanionTransitionDetector.hasDisarmedExposure(status)
        problems = status.problems.map { "\($0.kind.rawValue)|\($0.text)" }.sorted()
        dayLock = status.dayLock.map {
            "\($0.active)|\($0.trigger.rawValue)|\(CompanionISO8601.string(from: $0.until))|\(CompanionISO8601.string(from: $0.at))"
        } ?? "none"
        pause = status.pause.map {
            "\($0.rule.rawValue)|\(CompanionISO8601.string(from: $0.until))"
        } ?? "none"
        ruleWarnings = CompanionTransitionDetector.ruleWarningKeys(in: status).sorted()
        sessionEndsAt = status.dailyRules?.sessionEndsAt
    }
}

private extension CompanionTransitionDetector {
    struct Target {
        let sectionID: String
        let rowID: String?
    }

    static func isVerified(_ status: ReducedCompanionStatus) -> Bool {
        if case .verified = status.freshness { return true }
        return false
    }

    static func isOffline(_ state: CompanionDisplayState) -> Bool {
        if case .offline = state { return true }
        return false
    }

    static func isIntervention(_ state: CompanionDisplayState) -> Bool {
        if case .intervention = state { return true }
        return false
    }

    static func isLocked(_ state: CompanionDisplayState) -> Bool {
        state == .locked
    }

    static func isPaused(_ state: CompanionDisplayState) -> Bool {
        if case .paused = state { return true }
        return false
    }

    static func isDisabled(_ state: CompanionDisplayState) -> Bool {
        state == .disarmed || state == .disarmedUnverified
    }

    static func sessionChanged(
        _ previous: MacCompanionStatusDTO.DailyRulesDTO?,
        _ next: MacCompanionStatusDTO.DailyRulesDTO?
    ) -> Bool {
        guard let previous, let next else { return false }
        return previous.sessionEndsAt != next.sessionEndsAt
    }

    static func rowID(for trigger: MacCompanionStatusDTO.DayLockTrigger) -> String? {
        switch trigger {
        case .manual: return nil
        case .dailyLoss: return "rule-daily-loss"
        case .losingTrades: return "rule-losing-trades"
        case .maxTrades: return "rule-max-trades"
        case .windowEnd: return "rule-window"
        }
    }

    static func rowID(for rule: MacCompanionStatusDTO.DailyRule) -> String {
        switch rule {
        case .dailyLoss: return "rule-daily-loss"
        case .losingTrades: return "rule-losing-trades"
        case .maxTrades: return "rule-max-trades"
        case .windowEnd: return "rule-window"
        }
    }

    static func pauseRuleText(_ rule: MacCompanionStatusDTO.DailyRule) -> String {
        switch rule {
        case .dailyLoss: return "denní ztráta"
        case .losingTrades: return "ztrátové obchody"
        case .maxTrades: return "počet obchodů"
        case .windowEnd: return "konec obchodního okna"
        }
    }

    static func notificationRuleText(
        _ trigger: MacCompanionStatusDTO.DayLockTrigger,
        rules: MacCompanionStatusDTO.DailyRulesDTO?
    ) -> String {
        switch trigger {
        case .manual:
            return "ruční zámek"
        case .dailyLoss:
            return "denní ztrátový limit"
        case .losingTrades:
            if let current = rules?.losingTrades, let limit = rules?.maxLosingTrades {
                return "\(current) ztrátové obchody z \(limit)"
            }
            return "limit ztrátových obchodů"
        case .maxTrades:
            if let current = rules?.tradesToday, let limit = rules?.maxTrades {
                return "\(current) obchodů z \(limit)"
            }
            return "maximální počet obchodů"
        case .windowEnd:
            if let window = rules?.window, window.enabled {
                return "konec obchodního okna \(window.to)"
            }
            return "konec obchodního okna"
        }
    }

    static func lockNotificationBody(
        lock: MacCompanionStatusDTO.DayLockDTO,
        rules: MacCompanionStatusDTO.DailyRulesDTO?
    ) -> String {
        let prefix = lock.trigger == .manual
            ? "Den byl zamčen ručně."
            : "Pravidlo: \(notificationRuleText(lock.trigger, rules: rules))."
        return "\(prefix) Copier vypnutý, zapnutí blokované do konce session."
    }

    static func ruleWarningKeys(in status: MacCompanionStatusDTO) -> Set<String> {
        guard let rules = status.dailyRules else { return [] }
        return Set(rules.warnings.map {
            ruleWarningKey(rule: $0.rule, sessionEndsAt: rules.sessionEndsAt)
        })
    }

    static func currentRuleWarning(
        in status: MacCompanionStatusDTO,
        excluding excludedKeys: Set<String>
    ) -> CompanionTransition? {
        guard let rules = status.dailyRules else { return nil }
        guard let warning = rules.warnings.first(where: {
            !excludedKeys.contains(ruleWarningKey(rule: $0.rule, sessionEndsAt: rules.sessionEndsAt))
        }) else { return nil }
        return ruleWarningTransition(warning, rules: rules)
    }

    static func newlyAddedRuleWarning(
        previous: MacCompanionStatusDTO,
        next: MacCompanionStatusDTO,
        excluding excludedKeys: Set<String>
    ) -> CompanionTransition? {
        let excluded = excludedKeys.union(ruleWarningKeys(in: previous))
        return currentRuleWarning(in: next, excluding: excluded)
    }

    static func ruleWarningTransition(
        _ warning: MacCompanionStatusDTO.RuleWarningDTO,
        rules: MacCompanionStatusDTO.DailyRulesDTO
    ) -> CompanionTransition {
        let key = ruleWarningKey(rule: warning.rule, sessionEndsAt: rules.sessionEndsAt)
        let title: String
        let body: String
        switch warning.rule {
        case .losingTrades:
            title = "Blíží se limit: ztrátové obchody \(wholeNumber(warning.current)) / \(wholeNumber(warning.limit))"
            body = "Ještě jedna ztráta dnes zamkne den."
        case .maxTrades:
            title = "Blíží se limit: obchody dnes \(wholeNumber(warning.current)) / \(wholeNumber(warning.limit))"
            body = "Další uzavřený obchod může zamknout den."
        case .dailyLoss:
            let percent = warning.limit > 0
                ? min(100, Int((abs(warning.current) / warning.limit * 100).rounded()))
                : 0
            title = "Blíží se limit: denní ztráta \(percent) % limitu"
            body = "Denní ztrátový limit je blízko."
        case .windowEnd:
            title = "Blíží se limit: obchodní okno"
            body = "Do konce obchodního okna zbývá 10 min."
        case .manual:
            title = "Blíží se limit: pravidlo dne"
            body = "Zkontroluj pravidla dne v LIVE."
        }
        return .init(
            category: .ruleWarning,
            sectionID: "daily-rules",
            rowID: rowID(for: warning.rule),
            reason: title,
            notificationTitle: title,
            notificationBody: body,
            ruleWarningKey: key
        )
    }

    static func ruleWarningKey(
        rule: MacCompanionStatusDTO.DayLockTrigger,
        sessionEndsAt: Date
    ) -> String {
        "\(rule.rawValue)|\(CompanionISO8601.string(from: sessionEndsAt))"
    }

    static func wholeNumber(_ value: Double) -> String {
        String(Int(value.rounded()))
    }

    static func becameOffline(
        _ previous: ReducedCompanionStatus,
        _ next: ReducedCompanionStatus
    ) -> Bool {
        !isOffline(previous.displayState) && isOffline(next.displayState)
    }

    static func liveSessionBecameUrgentOrExpired(
        _ previous: ReducedCompanionStatus,
        _ next: ReducedCompanionStatus,
        now: Date
    ) -> Bool {
        guard next.status.copierState == .live else { return false }

        let previousWasUrgent: Bool
        if case .live(let minutes) = previous.displayState {
            previousWasUrgent = minutes <= 5
        } else if case .paused(let minutes) = previous.displayState {
            previousWasUrgent = minutes <= 5
        } else {
            previousWasUrgent = false
        }

        if let expiry = next.status.sessionExpiresAt, expiry <= now {
            return previous.status.copierState == .live && !isIntervention(previous.displayState)
        }
        if case .live(let minutes) = next.displayState {
            return minutes <= 5 && !previousWasUrgent
        }
        if case .paused(let minutes) = next.displayState {
            return minutes <= 5 && !previousWasUrgent
        }
        return false
    }

    static func newlyWorsenedProblem(
        _ previous: MacCompanionStatusDTO,
        _ next: MacCompanionStatusDTO
    ) -> CompanionTransition? {
        if let index = next.safety.divergences.firstIndex(where: { divergence in
            !previous.safety.divergences.contains(divergence)
        }) {
            return .init(
                category: .worsening,
                sectionID: "safety",
                rowID: "divergence-\(index)",
                reason: "Byla zjištěna nová divergence."
            )
        }

        if next.safety.outbox.stuckCount > previous.safety.outbox.stuckCount {
            return .init(
                category: .worsening,
                sectionID: "safety",
                rowID: "outbox",
                reason: "Outbox obsahuje nový zaklesnutý příkaz."
            )
        }

        if previous.safety.reconciliation.status != .review,
           next.safety.reconciliation.status == .review,
           !CompanionSafetyPolicy.isDeferredPreflightReconciliation(next) {
            return .init(
                category: .worsening,
                sectionID: "safety",
                rowID: "reconciliation",
                reason: "Reconciliation nově vyžaduje kontrolu."
            )
        }

        let previousProblems = Set(previous.problems.map { "\($0.kind.rawValue)|\($0.text)" })
        if let newProblem = next.problems.first(where: {
            Self.transitionProblemKinds.contains($0.kind)
                && !previousProblems.contains("\($0.kind.rawValue)|\($0.text)")
                && !($0.kind == .reconciliation
                    && CompanionSafetyPolicy.isDeferredPreflightReconciliation(next))
        }) {
            let target = target(for: newProblem.kind, status: next)
            return .init(
                category: .worsening,
                sectionID: target.sectionID,
                rowID: target.rowID,
                reason: safeReason(for: newProblem.kind, improvement: false)
            )
        }

        return nil
    }

    static func resolvedProblem(
        _ previous: MacCompanionStatusDTO,
        _ next: MacCompanionStatusDTO
    ) -> CompanionTransition? {
        if previous.safety.divergences.count > next.safety.divergences.count {
            return .init(
                category: .improvement,
                sectionID: "safety",
                rowID: next.safety.divergences.isEmpty ? "reconciliation" : "divergence-0",
                reason: "Divergence už není hlášena."
            )
        }
        if previous.safety.outbox.stuckCount > 0,
           next.safety.outbox.stuckCount == 0 {
            return .init(
                category: .improvement,
                sectionID: "safety",
                rowID: "outbox",
                reason: "Zaklesnutý outbox byl vyřešen."
            )
        }
        if previous.safety.reconciliation.status == .review,
           !CompanionSafetyPolicy.isDeferredPreflightReconciliation(previous),
           next.safety.reconciliation.status == .clean {
            return .init(
                category: .improvement,
                sectionID: "safety",
                rowID: "reconciliation",
                reason: "Reconciliation je znovu čistá."
            )
        }

        let nextKinds = Set(next.problems.map(\.kind))
        if let removed = previous.problems.first(where: {
            transitionProblemKinds.contains($0.kind)
                && !nextKinds.contains($0.kind)
                && !($0.kind == .reconciliation
                    && CompanionSafetyPolicy.isDeferredPreflightReconciliation(previous))
        }) {
            let target = target(for: removed.kind, status: next)
            return .init(
                category: .improvement,
                sectionID: target.sectionID,
                rowID: target.rowID,
                reason: safeReason(for: removed.kind, improvement: true)
            )
        }
        return nil
    }

    static func modeTransition(
        _ previous: ReducedCompanionStatus,
        _ next: ReducedCompanionStatus
    ) -> CompanionTransition? {
        let previousMode = previous.status.copierState
        let nextMode = next.status.copierState
        guard previousMode != nextMode else { return nil }
        switch (previousMode, nextMode) {
        case (.disarmed, .live), (.shadow, .live):
            return .init(
                category: .mode,
                sectionID: "copying",
                rowID: "follower-ack",
                reason: "Copier přešel do režimu LIVE."
            )
        case (.live, .disarmed):
            return .init(
                category: .mode,
                sectionID: "safety",
                rowID: "reconciliation",
                reason: "Copier přešel do režimu VYPNUTO."
            )
        case (.live, .shadow):
            return .init(
                category: .mode,
                sectionID: "leader-tracking",
                rowID: "shadow-mode",
                reason: "Copier přešel do režimu SHADOW."
            )
        case (.disarmed, .shadow):
            return .init(
                category: .mode,
                sectionID: "leader-tracking",
                rowID: "shadow-mode",
                reason: "Copier přešel z VYPNUTO do režimu SHADOW."
            )
        case (.shadow, .disarmed):
            return .init(
                category: .mode,
                sectionID: "safety",
                rowID: "reconciliation",
                reason: "Copier přešel do režimu VYPNUTO."
            )
        default:
            return nil
        }
    }

    static func interventionTarget(_ status: MacCompanionStatusDTO) -> Target {
        if status.safety.reconciliation.status == .review {
            return .init(sectionID: "safety", rowID: "reconciliation")
        }
        if !status.safety.divergences.isEmpty {
            return .init(sectionID: "safety", rowID: "divergence-0")
        }
        if status.safety.outbox.stuckCount > 0 {
            return .init(sectionID: "safety", rowID: "outbox")
        }
        if status.safety.killSwitchTripped {
            return .init(sectionID: "safety", rowID: "kill-switch")
        }
        if status.brokerConnected == false {
            return .init(sectionID: "runtime", rowID: "broker-connection")
        }
        if hasFollowerProblem(status) {
            return .init(sectionID: "safety", rowID: "follower-ack")
        }
        if hasDisarmedExposure(status) {
            return .init(
                sectionID: "exposure",
                rowID: status.exposure.positions.isEmpty ? "working-orders" : "position-0"
            )
        }
        return .init(sectionID: "safety", rowID: nil)
    }

    static func target(
        for kind: MacCompanionStatusDTO.ProblemDTO.Kind,
        status: MacCompanionStatusDTO
    ) -> Target {
        switch kind {
        case .divergence:
            return .init(sectionID: "safety", rowID: status.safety.divergences.isEmpty ? nil : "divergence-0")
        case .stuckOutbox:
            return .init(sectionID: "safety", rowID: "outbox")
        case .reconciliation:
            return .init(sectionID: "safety", rowID: "reconciliation")
        case .workerOffline:
            return .init(sectionID: "runtime", rowID: "heartbeat")
        }
    }

    static func safeReason(
        for kind: MacCompanionStatusDTO.ProblemDTO.Kind,
        improvement: Bool
    ) -> String {
        switch (kind, improvement) {
        case (.divergence, false): return "Byla zjištěna nová divergence."
        case (.divergence, true): return "Divergence už není hlášena."
        case (.stuckOutbox, false): return "Outbox obsahuje nový zaklesnutý příkaz."
        case (.stuckOutbox, true): return "Zaklesnutý outbox byl vyřešen."
        case (.reconciliation, false): return "Reconciliation nově vyžaduje kontrolu."
        case (.reconciliation, true): return "Reconciliation je znovu čistá."
        case (.workerOffline, false): return "Worker přestal posílat čerstvý heartbeat."
        case (.workerOffline, true): return "Worker znovu poskytuje ověřený stav."
        }
    }

    static func hasFollowerProblem(_ status: MacCompanionStatusDTO) -> Bool {
        guard status.copierState == .live,
              let acknowledgement = status.exposure.followerAck else { return false }
        return acknowledgement.confirmed < acknowledgement.total
            || !acknowledgement.failing.isEmpty
    }

    static func hasDisarmedExposure(_ status: MacCompanionStatusDTO) -> Bool {
        status.copierState == .disarmed
            && status.exposure.verifiedAt != nil
            && (!status.exposure.positions.isEmpty
                || (status.exposure.accountsWithWorkingOrders ?? 0) > 0)
    }

    static func freshnessKey(_ freshness: CompanionFreshness) -> String {
        switch freshness {
        case .verified: return "verified"
        case .unknown: return "unknown"
        case .offline: return "offline"
        }
    }

    static func displayKey(_ state: CompanionDisplayState) -> String {
        switch state {
        case .live(let minutes): return minutes <= 5 ? "live-urgent" : "live"
        case .paused(let minutes): return minutes <= 5 ? "paused-urgent" : "paused"
        case .shadow: return "shadow"
        case .disarmed: return "disarmed"
        case .disarmedUnverified: return "disarmed-unverified"
        case .locked: return "locked"
        case .intervention: return "intervention"
        case .unknown: return "unknown"
        case .offline: return "offline"
        }
    }

    static let transitionProblemKinds: Set<MacCompanionStatusDTO.ProblemDTO.Kind> = [
        .divergence,
        .stuckOutbox,
        .reconciliation
    ]
}
