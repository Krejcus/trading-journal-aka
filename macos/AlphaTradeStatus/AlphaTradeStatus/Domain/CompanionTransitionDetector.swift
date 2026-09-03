import Foundation

enum CompanionTransitionCategory: String, Equatable, Sendable {
    case worsening
    case improvement
    case mode
}

struct CompanionTransition: Equatable, Sendable {
    let category: CompanionTransitionCategory
    let sectionID: String
    let rowID: String?
    let reason: String
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
        now: Date
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

        if let mode = modeTransition(previous.status.copierState, next.status.copierState) {
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

    mutating func reset() {
        settled = nil
        settledSignature = nil
        candidate = nil
        highestRevision = nil
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
            return nil
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
            now: now
        ) else {
            return nil
        }

        let settingAllowsAutoOpen = autoOpenEnabled
            && (transition.category != .improvement || improvementsEnabled)
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
        } else {
            previousWasUrgent = false
        }

        if let expiry = next.status.sessionExpiresAt, expiry <= now {
            return previous.status.copierState == .live && !isIntervention(previous.displayState)
        }
        if case .live(let minutes) = next.displayState {
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
           next.safety.reconciliation.status == .review {
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
            transitionProblemKinds.contains($0.kind) && !nextKinds.contains($0.kind)
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
        _ previous: MacCompanionStatusDTO.CopierState,
        _ next: MacCompanionStatusDTO.CopierState
    ) -> CompanionTransition? {
        guard previous != next else { return nil }
        switch (previous, next) {
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
                reason: "Copier přešel do režimu DISARMED."
            )
        case (.live, .shadow):
            return .init(
                category: .mode,
                sectionID: "leader-tracking",
                rowID: "shadow-mode",
                reason: "Copier přešel do režimu SHADOW."
            )
        case (.disarmed, .shadow), (.shadow, .disarmed):
            return nil
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
        case .shadow: return "shadow"
        case .disarmed: return "disarmed"
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
