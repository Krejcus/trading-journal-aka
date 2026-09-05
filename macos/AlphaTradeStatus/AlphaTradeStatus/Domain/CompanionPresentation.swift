import Foundation

enum CompanionFixtureID: String, CaseIterable, Identifiable, Sendable {
    case live
    case liveAckUnavailable = "live-ack-unavailable"
    case paused
    case shadow
    case disarmed
    case disarmedExposure = "disarmed-exposure"
    case disarmedUnverified = "disarmed-unverified"
    case locked
    case intervention
    case unknown
    case offline

    var id: String { rawValue }

    init(environmentValue: String?) {
        let normalizedValue = environmentValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        self = normalizedValue.flatMap(Self.init(rawValue:)) ?? .disarmed
    }
}

enum StatusTone: String, Equatable, Sendable {
    case neutral
    case success
    case warning
    case danger
    case muted
}

enum CompanionDisplayState: Equatable, Sendable {
    case live(minutesRemaining: Int)
    case paused(minutesRemaining: Int)
    case shadow
    case disarmed
    case disarmedUnverified
    case locked
    case intervention(issueCount: Int)
    case unknown
    case offline

    var stateName: String {
        switch self {
        case .live:
            return "LIVE"
        case .paused:
            return "PAUZA"
        case .shadow:
            return "SHADOW"
        case .disarmed:
            return "VYPNUTO"
        case .disarmedUnverified:
            return "VYPNUTO"
        case .locked:
            return "ZAMČENO"
        case .intervention:
            return "ZÁSAH NUTNÝ"
        case .unknown:
            return "STAV NEZNÁMÝ"
        case .offline:
            return "WORKER OFFLINE"
        }
    }
}

struct MenuBarStatusPresentation: Equatable, Sendable {
    let pillText: String?
    let symbolName: String?
    let tone: StatusTone
    let accessibilityLabel: String

    init(
        pillText: String?,
        symbolName: String? = nil,
        tone: StatusTone,
        accessibilityLabel: String
    ) {
        self.pillText = pillText
        self.symbolName = symbolName
        self.tone = tone
        self.accessibilityLabel = accessibilityLabel
    }
}

struct FreshnessPresentation: Equatable, Sendable {
    let text: String
    let tone: StatusTone
    let accessibilityLabel: String
}

struct HeroPresentation: Equatable, Sendable {
    let symbolName: String
    let title: String
    let badge: String?
    let detail: String
    let supportingText: String?
    let tone: StatusTone

    init(
        symbolName: String,
        title: String,
        badge: String?,
        detail: String,
        supportingText: String? = nil,
        tone: StatusTone
    ) {
        self.symbolName = symbolName
        self.title = title
        self.badge = badge
        self.detail = detail
        self.supportingText = supportingText
        self.tone = tone
    }
}

struct BannerPresentation: Equatable, Sendable {
    let symbolName: String
    let text: String
    let tone: StatusTone
}

struct KeyValueRowPresentation: Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let value: String
    let detail: String?
    let tone: StatusTone
    let usesMonospacedValue: Bool

    init(
        id: String,
        label: String,
        value: String,
        detail: String? = nil,
        tone: StatusTone = .neutral,
        usesMonospacedValue: Bool = false
    ) {
        self.id = id
        self.label = label
        self.value = value
        self.detail = detail
        self.tone = tone
        self.usesMonospacedValue = usesMonospacedValue
    }
}

enum PositionSide: String, Equatable, Sendable {
    case long = "LONG"
    case short = "SHORT"
}

struct PositionRowPresentation: Equatable, Sendable, Identifiable {
    let id: String
    let symbol: String
    let side: PositionSide
    let quantity: Int
    let detail: String
    let detailTone: StatusTone
}

struct ProgressRowPresentation: Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let value: String
    let progress: Double
    let tone: StatusTone
}

enum SectionRowPresentation: Equatable, Sendable, Identifiable {
    case keyValue(KeyValueRowPresentation)
    case position(PositionRowPresentation)
    case progress(ProgressRowPresentation)

    var id: String {
        switch self {
        case .keyValue(let row):
            return row.id
        case .position(let row):
            return row.id
        case .progress(let row):
            return row.id
        }
    }

    var visibleText: [String] {
        switch self {
        case .keyValue(let row):
            return [row.label, row.value, row.detail].compactMap { $0 }
        case .position(let row):
            return [row.symbol, row.side.rawValue, "×\(row.quantity)", row.detail]
        case .progress(let row):
            return [row.label, row.value]
        }
    }
}

struct StatusSectionPresentation: Equatable, Sendable, Identifiable {
    let id: String
    let title: String
    let summary: String
    let summaryTone: StatusTone
    let isInitiallyExpanded: Bool
    let hasProblem: Bool
    let rows: [SectionRowPresentation]
}

enum CompanionDestination: String, Equatable, Sendable {
    case live = "https://alphatrade-mentor-15.vercel.app/?page=live"
    case liveOverview = "https://alphatrade-mentor-15.vercel.app/?page=live&tab=overview"
    case journal = "https://alphatrade-mentor-15.vercel.app/?page=journal"

    var url: URL? { URL(string: rawValue) }
}

enum FooterActionID: String, Equatable, Sendable {
    case openLive
    case openJournal
    case refresh
    case copyDiagnostics
}

enum FooterActionStyle: String, Equatable, Sendable {
    case primary
    case secondary
    case icon
}

struct FooterActionPresentation: Equatable, Sendable, Identifiable {
    let id: FooterActionID
    let title: String
    let symbolName: String?
    let style: FooterActionStyle
    let tone: StatusTone
    let destination: CompanionDestination?
    let accessibilityLabel: String
}

struct FooterPresentation: Equatable, Sendable {
    let actions: [FooterActionPresentation]
    let sourceNote: String
}

enum ExposureEvidence: Equatable, Sendable {
    case verifiedFlat(verifiedAt: String)
    case verifiedExposure(verifiedAt: String)
    case unverified

    var mayClaimFlat: Bool {
        if case .verifiedFlat = self {
            return true
        }
        return false
    }
}

enum FollowerAcknowledgementEvidence: Equatable, Sendable {
    case verified(confirmed: Int, total: Int, verifiedAt: String)
    case unavailable
    case notApplicable
}

struct CompanionPresentation: Equatable, Sendable, Identifiable {
    let fixtureID: CompanionFixtureID
    let displayState: CompanionDisplayState
    let menuBar: MenuBarStatusPresentation
    let freshness: FreshnessPresentation
    let hero: HeroPresentation
    let banner: BannerPresentation?
    let sections: [StatusSectionPresentation]
    let footer: FooterPresentation
    let exposureEvidence: ExposureEvidence
    let followerAcknowledgementEvidence: FollowerAcknowledgementEvidence
    var diagnosticSource: String = "phase-1-mock"

    var id: CompanionFixtureID { fixtureID }

    /// Intentionally excludes account aliases, section rows, credentials and tokens.
    /// Phase 1 diagnostics can therefore never copy the illustrative APEX account name.
    var safeDiagnosticText: String {
        [
            "AlphaTrade Status",
            "state=\(displayState.stateName)",
            "source=\(diagnosticSource)",
            "freshness=\(freshness.text)"
        ].joined(separator: "\n")
    }

    var allVisibleText: [String] {
        var text = [
            menuBar.pillText,
            menuBar.accessibilityLabel,
            freshness.text,
            freshness.accessibilityLabel,
            hero.title,
            hero.badge,
            hero.detail,
            hero.supportingText,
            banner?.text
        ].compactMap { $0 }

        for section in sections {
            text.append(section.title)
            text.append(section.summary)
            text.append(contentsOf: section.rows.flatMap(\.visibleText))
        }
        text.append(contentsOf: footer.actions.flatMap { [$0.title, $0.accessibilityLabel] })
        text.append(footer.sourceNote)
        return text
    }
}
