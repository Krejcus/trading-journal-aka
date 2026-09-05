import Foundation

enum CompanionFreshness: Equatable, Sendable {
    case verified(ageSeconds: Int)
    case unknown(ageSeconds: Int)
    case offline(ageSeconds: Int)

    var ageSeconds: Int {
        switch self {
        case .verified(let ageSeconds), .unknown(let ageSeconds), .offline(let ageSeconds):
            return ageSeconds
        }
    }
}

struct ReducedCompanionStatus: Equatable, Sendable {
    let status: MacCompanionStatusDTO
    let freshness: CompanionFreshness
    let displayState: CompanionDisplayState
    let issueCount: Int
    let verifiedUntil: Date
    let exposureEvidence: ExposureEvidence
    let followerAcknowledgementEvidence: FollowerAcknowledgementEvidence
}

enum CompanionSafetyPolicy {
    static func isDeferredPreflightReconciliation(
        _ status: MacCompanionStatusDTO
    ) -> Bool {
        guard status.copierState == .disarmed || status.copierState == .shadow,
              status.safety.reconciliation.status == .review,
              status.safety.divergences.isEmpty,
              status.safety.outbox.stuckCount == 0,
              !status.safety.killSwitchTripped else {
            return false
        }

        return status.problems.allSatisfy { $0.kind == .reconciliation }
    }
}

enum CompanionFreshnessReducer {
    static let maximumVerifiedAge: TimeInterval = 10
    static let offlineAfter: TimeInterval = 90

    static func reduce(
        _ status: MacCompanionStatusDTO,
        now: Date
    ) -> ReducedCompanionStatus {
        let serverVerifiedAge = min(
            max(status.freshness.verifiedMaxAgeSeconds, 0),
            maximumVerifiedAge
        )
        let verifiedUntil = min(
            status.validUntil,
            status.observedAt.addingTimeInterval(serverVerifiedAge)
        )
        let rawAge = now.timeIntervalSince(status.observedAt)
        let ageSeconds = max(0, Int(floor(rawAge)))

        let freshness: CompanionFreshness
        if rawAge < 0 {
            freshness = .unknown(ageSeconds: 0)
        } else if rawAge > offlineAfter {
            freshness = .offline(ageSeconds: ageSeconds)
        } else if rawAge > maximumVerifiedAge || now > verifiedUntil {
            freshness = .unknown(ageSeconds: ageSeconds)
        } else {
            freshness = .verified(ageSeconds: ageSeconds)
        }

        let evidence = exposureEvidence(for: status.exposure)
        let acknowledgement = followerEvidence(for: status.exposure.followerAck)
        let derivedIssueCount = issueCount(for: status)
        let displayState = displayState(
            for: status,
            freshness: freshness,
            issueCount: derivedIssueCount,
            exposureEvidence: evidence,
            now: now
        )

        return ReducedCompanionStatus(
            status: status,
            freshness: freshness,
            displayState: displayState,
            issueCount: derivedIssueCount,
            verifiedUntil: verifiedUntil,
            exposureEvidence: evidence,
            followerAcknowledgementEvidence: acknowledgement
        )
    }
}

private extension CompanionFreshnessReducer {
    static func displayState(
        for status: MacCompanionStatusDTO,
        freshness: CompanionFreshness,
        issueCount: Int,
        exposureEvidence: ExposureEvidence,
        now: Date
    ) -> CompanionDisplayState {
        switch freshness {
        case .offline:
            return .offline
        case .unknown:
            return .unknown
        case .verified:
            break
        }

        // Confirmed critical signals stay red even when another field is
        // unknown. Freshness still wins above, so stale critical data can
        // never masquerade as a current intervention.
        if issueCount > 0 {
            return .intervention(issueCount: issueCount)
        }

        if status.safety.reconciliation.status == .unknown
            || status.brokerConnected == nil {
            return .unknown
        }

        switch status.copierState {
        case .live:
            guard status.brokerConnected == true,
                  let expiresAt = status.sessionExpiresAt,
                  expiresAt > now else {
                return .unknown
            }
            let minutesRemaining = max(0, Int(ceil(expiresAt.timeIntervalSince(now) / 60)))
            if let pause = status.pause, pause.until > now {
                return .paused(minutesRemaining: minutesRemaining)
            }
            return .live(minutesRemaining: minutesRemaining)
        case .shadow:
            return .shadow
        case .disarmed:
            // DISARMED is a command state, not proof that every account is flat.
            // A missing snapshot gets its own explicit command-state presentation;
            // it says only that no commands are sent and never manufactures flat.
            if status.dayLock?.active == true {
                return .locked
            }
            if status.exposure.verifiedAt == nil {
                return .disarmedUnverified
            }
            guard exposureEvidence.mayClaimFlat else {
                return .unknown
            }
            return .disarmed
        }
    }

    static func issueCount(for status: MacCompanionStatusDTO) -> Int {
        // `problems` is a human-readable projection. Red state is derived only
        // from the corresponding structured, confirmed safety signals.
        var issueKeys = Set<String>()

        if status.safety.reconciliation.status == .review,
           !CompanionSafetyPolicy.isDeferredPreflightReconciliation(status) {
            issueKeys.insert(MacCompanionStatusDTO.ProblemDTO.Kind.reconciliation.rawValue)
        }
        if !status.safety.divergences.isEmpty {
            issueKeys.insert(MacCompanionStatusDTO.ProblemDTO.Kind.divergence.rawValue)
        }
        if status.safety.outbox.stuckCount > 0 {
            issueKeys.insert(MacCompanionStatusDTO.ProblemDTO.Kind.stuckOutbox.rawValue)
        }
        if status.safety.killSwitchTripped {
            issueKeys.insert("kill-switch")
        }
        if status.brokerConnected == false {
            issueKeys.insert("broker-disconnected")
        }
        if status.copierState == .live,
           let acknowledgement = status.exposure.followerAck,
           acknowledgement.confirmed < acknowledgement.total
               || !acknowledgement.failing.isEmpty {
            issueKeys.insert("follower-ack")
        }

        if status.copierState == .disarmed,
           status.exposure.verifiedAt != nil,
           (!status.exposure.positions.isEmpty
               || (status.exposure.accountsWithWorkingOrders ?? 0) > 0) {
            issueKeys.insert("disarmed-exposure")
        }

        return issueKeys.count
    }

    static func exposureEvidence(
        for exposure: MacCompanionStatusDTO.ExposureDTO
    ) -> ExposureEvidence {
        guard let verifiedAt = exposure.verifiedAt else {
            return .unverified
        }
        let timestamp = CompanionDisplayFormatting.time(verifiedAt)
        if exposure.positions.isEmpty,
           exposure.accountsWithWorkingOrders == 0 {
            return .verifiedFlat(verifiedAt: timestamp)
        }
        return .verifiedExposure(verifiedAt: timestamp)
    }

    static func followerEvidence(
        for acknowledgement: MacCompanionStatusDTO.FollowerAcknowledgementDTO?
    ) -> FollowerAcknowledgementEvidence {
        guard let acknowledgement else {
            return .unavailable
        }
        return .verified(
            confirmed: acknowledgement.confirmed,
            total: acknowledgement.total,
            verifiedAt: "server"
        )
    }
}

enum CompanionDisplayFormatting {
    static func time(_ date: Date) -> String {
        timeFormatter.string(from: date)
    }

    static func shortTime(_ date: Date) -> String {
        shortTimeFormatter.string(from: date)
    }

    static func duration(_ seconds: Int) -> String {
        if seconds < 60 {
            return "\(seconds) s"
        }
        let minutes = seconds / 60
        let remainder = seconds % 60
        return remainder == 0 ? "\(minutes) min" : "\(minutes) min \(remainder) s"
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "cs_CZ")
        formatter.timeZone = .current
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    private static let shortTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "cs_CZ")
        formatter.timeZone = .current
        formatter.dateFormat = "HH:mm"
        return formatter
    }()
}
