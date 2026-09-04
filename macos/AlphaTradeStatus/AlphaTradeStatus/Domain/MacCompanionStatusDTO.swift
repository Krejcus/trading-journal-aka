import Foundation

struct MacCompanionStatusDTO: Decodable, Equatable, Sendable {
    static let supportedContractVersion = 1

    let contractVersion: Int
    let serverTime: Date
    let revision: UInt64
    let observedAt: Date
    let validUntil: Date
    let freshness: FreshnessPolicyDTO
    let copierState: CopierState
    let sessionExpiresAt: Date?
    let worker: WorkerDTO
    let brokerConnected: Bool?
    var dailyStats: DailyStatsDTO? = nil
    var dayLock: DayLockDTO? = nil
    var dailyRules: DailyRulesDTO? = nil
    let safety: SafetyDTO
    let exposure: ExposureDTO
    let snapshots: SnapshotsDTO
    let problems: [ProblemDTO]

    enum CopierState: String, Decodable, Equatable, Sendable {
        case live
        case shadow
        case disarmed
    }

    struct FreshnessPolicyDTO: Decodable, Equatable, Sendable {
        let verifiedMaxAgeSeconds: TimeInterval
        let offlineAfterSeconds: TimeInterval
    }

    struct WorkerDTO: Decodable, Equatable, Sendable {
        let lastHeartbeatAt: Date
        let location: Location

        enum Location: String, Decodable, Equatable, Sendable {
            case mac
            case vps
        }
    }

    struct DailyStatsDTO: Decodable, Equatable, Sendable {
        let label: String
        let realizedPnlUsd: Double
        let losingTrades: Int
    }

    enum DayLockTrigger: String, Decodable, Equatable, Hashable, Sendable {
        case manual
        case dailyLoss = "daily-loss"
        case losingTrades = "losing-trades"
        case maxTrades = "max-trades"
        case windowEnd = "window-end"
    }

    struct DayLockDTO: Decodable, Equatable, Sendable {
        let active: Bool
        let until: Date
        let at: Date
        let trigger: DayLockTrigger
        let reason: String
        let unlocked: DayUnlockDTO?
    }

    struct DayUnlockDTO: Decodable, Equatable, Sendable {
        let at: Date
    }

    struct DailyRulesDTO: Decodable, Equatable, Sendable {
        let lossLimitUsd: Double?
        let realizedLossUsd: Double?
        let maxLosingTrades: Int?
        let losingTrades: Int
        let maxTrades: Int?
        let tradesToday: Int
        let window: TradingWindowDTO?
        let cooldownMinutes: Int
        let cooldownUntil: Date?
        let sessionEndsAt: Date
        let warnings: [RuleWarningDTO]
    }

    struct TradingWindowDTO: Decodable, Equatable, Sendable {
        let enabled: Bool
        let from: String
        let to: String
        let state: State

        enum State: String, Decodable, Equatable, Sendable {
            case inside
            case outside
            case off
        }
    }

    struct RuleWarningDTO: Decodable, Equatable, Sendable {
        let rule: DayLockTrigger
        let current: Double
        let limit: Double
        let at: Date
    }

    struct SafetyDTO: Decodable, Equatable, Sendable {
        let reconciliation: ReconciliationDTO
        let divergences: [DivergenceDTO]
        let outbox: OutboxDTO
        let cooldownActive: Bool
        let dayLockActive: Bool
        let killSwitchTripped: Bool
    }

    struct ReconciliationDTO: Decodable, Equatable, Sendable {
        let status: Status
        let at: Date?

        enum Status: String, Decodable, Equatable, Sendable {
            case clean
            case review
            case unknown
        }
    }

    struct DivergenceDTO: Decodable, Equatable, Sendable {
        let symbol: String?
        let account: String
        let detail: String
    }

    struct OutboxDTO: Decodable, Equatable, Sendable {
        let stuckCount: Int
        let oldestStuckMinutes: Int?
    }

    struct ExposureDTO: Decodable, Equatable, Sendable {
        let verifiedAt: Date?
        let positions: [PositionDTO]
        let followerAck: FollowerAcknowledgementDTO?
        let accountsWithWorkingOrders: Int?
    }

    struct PositionDTO: Decodable, Equatable, Sendable {
        let symbol: String
        let side: Side
        let qty: Int
        let at: Date

        enum Side: String, Decodable, Equatable, Sendable {
            case long
            case short
        }
    }

    struct FollowerAcknowledgementDTO: Decodable, Equatable, Sendable {
        let confirmed: Int
        let total: Int
        let failing: [FailingFollowerDTO]
    }

    struct FailingFollowerDTO: Decodable, Equatable, Sendable {
        let account: String
        let detail: String
        let sinceMinutes: Int
    }

    struct SnapshotsDTO: Decodable, Equatable, Sendable {
        let cdpReady: Bool
        let lastEntryAt: Date?
        let lastExitAt: Date?
    }

    struct ProblemDTO: Decodable, Equatable, Sendable {
        let kind: Kind
        let text: String

        enum Kind: String, Decodable, Equatable, Hashable, Sendable {
            case divergence
            case stuckOutbox = "stuck-outbox"
            case reconciliation
            case workerOffline = "worker-offline"
        }
    }
}

enum MacCompanionStatusDecodingError: Error, Equatable {
    case unsupportedContractVersion(Int)
    case invalidFreshnessPolicy
    case invalidTimeline
    case invalidCounts
}

enum MacCompanionStatusDecoder {
    static func decode(_ data: Data) throws -> MacCompanionStatusDTO {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = CompanionISO8601.date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected an ISO-8601 timestamp"
                )
            }
            return date
        }

        let status = try decoder.decode(MacCompanionStatusDTO.self, from: data)
        guard status.contractVersion == MacCompanionStatusDTO.supportedContractVersion else {
            throw MacCompanionStatusDecodingError.unsupportedContractVersion(status.contractVersion)
        }
        guard status.freshness.verifiedMaxAgeSeconds == 10,
              status.freshness.offlineAfterSeconds == 90 else {
            throw MacCompanionStatusDecodingError.invalidFreshnessPolicy
        }
        guard status.validUntil >= status.observedAt,
              status.worker.lastHeartbeatAt <= status.serverTime.addingTimeInterval(30) else {
            throw MacCompanionStatusDecodingError.invalidTimeline
        }
        guard status.safety.outbox.stuckCount >= 0,
              status.exposure.positions.allSatisfy({ $0.qty > 0 }),
              status.exposure.followerAck.map({ ack in
                  ack.confirmed >= 0 && ack.total >= 0 && ack.confirmed <= ack.total
                      && ack.failing.allSatisfy { $0.sinceMinutes >= 0 }
              }) ?? true else {
            throw MacCompanionStatusDecodingError.invalidCounts
        }
        if let rules = status.dailyRules {
            guard rules.losingTrades >= 0,
                  rules.tradesToday >= 0,
                  rules.cooldownMinutes >= 0,
                  rules.maxLosingTrades.map({ $0 > 0 }) ?? true,
                  rules.maxTrades.map({ $0 > 0 }) ?? true,
                  rules.lossLimitUsd.map({ $0 > 0 }) ?? true,
                  rules.warnings.allSatisfy({ $0.limit > 0 }) else {
                throw MacCompanionStatusDecodingError.invalidCounts
            }
        }
        return status
    }
}

enum CompanionISO8601 {
    static func date(from value: String) -> Date? {
        fractional.date(from: value) ?? standard.date(from: value)
    }

    static func string(from date: Date) -> String {
        fractional.string(from: date)
    }

    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
