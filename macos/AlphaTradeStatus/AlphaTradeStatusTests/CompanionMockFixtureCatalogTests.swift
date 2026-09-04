import Foundation
import XCTest
@testable import AlphaTradeStatus

final class CompanionMockFixtureCatalogTests: XCTestCase {
    func testCatalogContainsAllTenFixturesInStableOrder() {
        XCTAssertEqual(CompanionMockFixtureCatalog.orderedIDs, [
            .live,
            .liveAckUnavailable,
            .shadow,
            .disarmed,
            .disarmedExposure,
            .disarmedUnverified,
            .locked,
            .intervention,
            .unknown,
            .offline
        ])
        XCTAssertEqual(CompanionMockFixtureCatalog.all.map(\.fixtureID), CompanionMockFixtureCatalog.orderedIDs)
        XCTAssertEqual(Set(CompanionMockFixtureCatalog.orderedIDs.map(\.rawValue)).count, 10)
    }

    func testEveryFixtureHasTheExpectedStateAndMenuBarPill() {
        XCTAssertEqual(CompanionDisplayState.disarmed.stateName, "VYPNUTO")
        XCTAssertFalse(
            CompanionMockFixtureCatalog.presentation(for: .disarmed)
                .safeDiagnosticText.localizedCaseInsensitiveContains("disarm")
        )

        let expectations: [(
            id: CompanionFixtureID,
            state: CompanionDisplayState,
            pill: String?,
            symbol: String?,
            tone: StatusTone,
            heroTitle: String
        )] = [
            (.live, .live(minutesRemaining: 42), "LIVE", nil, .success, "LIVE"),
            (.liveAckUnavailable, .live(minutesRemaining: 42), "LIVE", nil, .success, "LIVE"),
            (.shadow, .shadow, "SHADOW", nil, .muted, "SHADOW"),
            (.disarmed, .disarmed, "VYPNUTO", "power", .neutral, "VYPNUTO"),
            (.disarmedExposure, .intervention(issueCount: 1), "!1", nil, .danger, "ZÁSAH NUTNÝ"),
            (.disarmedUnverified, .disarmedUnverified, "VYPNUTO", "power", .danger, "VYPNUTO"),
            (.locked, .locked, "ZAMČENO", "lock.fill", .danger, "DEN ZAMČENÝ"),
            (.intervention, .intervention(issueCount: 2), "!2", nil, .danger, "ZÁSAH NUTNÝ"),
            (.unknown, .unknown, "?", nil, .warning, "STAV NEZNÁMÝ"),
            (.offline, .offline, "!1", nil, .danger, "WORKER OFFLINE")
        ]

        for expectation in expectations {
            let presentation = CompanionMockFixtureCatalog.presentation(for: expectation.id)
            XCTAssertEqual(presentation.displayState, expectation.state, expectation.id.rawValue)
            XCTAssertEqual(presentation.menuBar.pillText, expectation.pill, expectation.id.rawValue)
            XCTAssertEqual(presentation.menuBar.symbolName, expectation.symbol, expectation.id.rawValue)
            XCTAssertEqual(presentation.menuBar.tone, expectation.tone, expectation.id.rawValue)
            XCTAssertEqual(presentation.hero.title, expectation.heroTitle, expectation.id.rawValue)
        }
    }

    func testLockedFixtureKeepsDailyRulesOpenAndNeverOffersUnlock() throws {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .locked)
        let rules = try XCTUnwrap(presentation.sections.first { $0.id == "daily-rules" })

        XCTAssertTrue(rules.isInitiallyExpanded)
        XCTAssertTrue(rules.hasProblem)
        XCTAssertEqual(rules.summary, "1 pravidlo spuštěno")
        XCTAssertTrue(rules.rows.contains { row in
            guard case .progress(let progress) = row else { return false }
            return progress.id == "rule-losing-trades"
                && progress.progress == 1
                && progress.tone == .danger
        })
        XCTAssertEqual(presentation.footer.actions.map(\.id), [
            .openLive, .openJournal, .refresh, .copyDiagnostics
        ])
        XCTAssertEqual(presentation.footer.actions.first?.title, "Otevřít LIVE")
        XCTAssertFalse(
            presentation.allVisibleText.joined(separator: "\n")
                .localizedCaseInsensitiveContains("odemknout…")
        )
    }

    func testEveryProblemSectionIsInitiallyExpanded() {
        let problemSections = CompanionMockFixtureCatalog.all.flatMap { presentation in
            presentation.sections
                .filter(\.hasProblem)
                .map { (fixture: presentation.fixtureID, section: $0) }
        }

        XCTAssertFalse(problemSections.isEmpty)
        for entry in problemSections {
            XCTAssertTrue(
                entry.section.isInitiallyExpanded,
                "\(entry.fixture.rawValue)/\(entry.section.id) hides a problem by default"
            )
        }
    }

    func testUnavailableFollowerAcknowledgementsNeverRenderANumericRatio() throws {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .liveAckUnavailable)
        XCTAssertEqual(presentation.followerAcknowledgementEvidence, .unavailable)

        let visibleText = presentation.allVisibleText.joined(separator: "\n")
        let numericRatio = try NSRegularExpression(pattern: #"\b\d+\s*/\s*\d+\b"#)
        let match = numericRatio.firstMatch(
            in: visibleText,
            range: NSRange(visibleText.startIndex..<visibleText.endIndex, in: visibleText)
        )

        XCTAssertNil(match, "Ack-unavailable UI must not manufacture an N/N confirmation")
        XCTAssertTrue(visibleText.localizedCaseInsensitiveContains("potvrzení followerů nedostupné"))
    }

    func testOnlyVerifiedFlatEvidenceMakesAPositiveFlatClaim() {
        let flatFixtureIDs = CompanionMockFixtureCatalog.all.compactMap { presentation in
            presentation.exposureEvidence.mayClaimFlat ? presentation.fixtureID : nil
        }
        XCTAssertEqual(flatFixtureIDs, [.shadow, .disarmed])

        let positiveFlatPhrases = [
            "flat ověřen",
            "ověřil nulové pozice i working orders"
        ]
        for presentation in CompanionMockFixtureCatalog.all {
            let visibleText = presentation.allVisibleText.joined(separator: "\n").lowercased()
            let hasPositiveFlatClaim = positiveFlatPhrases.contains { visibleText.contains($0) }
            XCTAssertEqual(
                hasPositiveFlatClaim,
                presentation.exposureEvidence.mayClaimFlat,
                presentation.fixtureID.rawValue
            )
        }
    }

    func testDisarmedExposureIsAnInterventionRatherThanAFlatDisarmedState() {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .disarmedExposure)

        XCTAssertEqual(presentation.displayState, .intervention(issueCount: 1))
        XCTAssertEqual(presentation.menuBar.pillText, "!1")
        XCTAssertEqual(presentation.menuBar.tone, .danger)
        XCTAssertEqual(presentation.exposureEvidence, .verifiedExposure(verifiedAt: "12:52:12"))
        XCTAssertFalse(presentation.exposureEvidence.mayClaimFlat)
        XCTAssertTrue(presentation.hero.detail.localizedCaseInsensitiveContains("vypnutý"))
        XCTAssertTrue(presentation.hero.detail.localizedCaseInsensitiveContains("otevřenou expozici"))
    }

    func testDisarmedWithoutExposureVerificationIsVypnutoRatherThanFlat() {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .disarmedUnverified)

        XCTAssertEqual(presentation.displayState, .disarmedUnverified)
        XCTAssertEqual(presentation.menuBar.pillText, "VYPNUTO")
        XCTAssertEqual(presentation.menuBar.symbolName, "power")
        XCTAssertEqual(presentation.menuBar.tone, .danger)
        XCTAssertEqual(presentation.exposureEvidence, .unverified)
        XCTAssertFalse(presentation.exposureEvidence.mayClaimFlat)
        XCTAssertEqual(presentation.hero.title, "VYPNUTO")
        XCTAssertTrue(presentation.hero.detail.localizedCaseInsensitiveContains("neposílá příkazy"))
        XCTAssertEqual(
            presentation.hero.supportingText,
            "Expozice není brokerem ověřena — flat nelze tvrdit"
        )
        XCTAssertNil(presentation.banner)
        XCTAssertTrue(presentation.sections.allSatisfy { !$0.isInitiallyExpanded })
        XCTAssertEqual(presentation.footer.actions.map(\.id), [
            .openLive, .openJournal, .refresh, .copyDiagnostics
        ])
        XCTAssertEqual(presentation.footer.actions.first?.title, "Zapnout v LIVE")
        XCTAssertEqual(presentation.footer.actions.first?.symbolName, nil)
        XCTAssertEqual(presentation.footer.actions.first?.destination, .liveOverview)
    }

    func testUnknownAndOfflineOverrideTheLastKnownLiveState() {
        let unknown = CompanionMockFixtureCatalog.presentation(for: .unknown)
        XCTAssertEqual(unknown.displayState, .unknown)
        XCTAssertEqual(unknown.menuBar.pillText, "?")
        XCTAssertEqual(unknown.freshness.tone, .warning)
        XCTAssertEqual(unknown.exposureEvidence, .unverified)
        XCTAssertEqual(unknown.followerAcknowledgementEvidence, .unavailable)

        let offline = CompanionMockFixtureCatalog.presentation(for: .offline)
        XCTAssertEqual(offline.displayState, .offline)
        XCTAssertEqual(offline.menuBar.pillText, "!1")
        XCTAssertEqual(offline.freshness.tone, .danger)
        XCTAssertEqual(offline.exposureEvidence, .unverified)
        XCTAssertEqual(offline.followerAcknowledgementEvidence, .unavailable)

        for presentation in [unknown, offline] {
            XCTAssertNotEqual(presentation.menuBar.pillText, "LIVE")
            XCTAssertFalse(presentation.exposureEvidence.mayClaimFlat)
            XCTAssertTrue(presentation.hero.detail.localizedCaseInsensitiveContains("naposledy potvrzeno live"))
        }
    }

    func testDiagnosticsUseTheSafeAllowlistForEveryFixture() {
        let forbiddenFragments = [
            "APEX-2",
            "MNQ",
            "MES",
            "20/20",
            "accountId",
            "connectionId",
            "Bearer ",
            "Device ",
            "token=",
            "secret",
            "https://"
        ]

        for presentation in CompanionMockFixtureCatalog.all {
            let diagnostic = presentation.safeDiagnosticText
            let lines = diagnostic.split(separator: "\n", omittingEmptySubsequences: false)
            XCTAssertEqual(lines.count, 4, presentation.fixtureID.rawValue)
            XCTAssertEqual(lines.first, "AlphaTrade Status", presentation.fixtureID.rawValue)
            XCTAssertTrue(lines[1].hasPrefix("state="), presentation.fixtureID.rawValue)
            XCTAssertEqual(lines[2], "source=phase-1-mock", presentation.fixtureID.rawValue)
            XCTAssertTrue(lines[3].hasPrefix("freshness="), presentation.fixtureID.rawValue)

            for forbidden in forbiddenFragments {
                XCTAssertFalse(
                    diagnostic.localizedCaseInsensitiveContains(forbidden),
                    "\(presentation.fixtureID.rawValue) diagnostic leaked \(forbidden)"
                )
            }
        }
    }

    func testFooterDestinationsUseTheCanonicalHTTPSLinks() {
        XCTAssertEqual(CompanionDestination.live.url, AppLinks.live)
        XCTAssertEqual(CompanionDestination.liveOverview.url, AppLinks.liveOverview)
        XCTAssertEqual(CompanionDestination.journal.url, AppLinks.journal)
        XCTAssertEqual(AppLinks.live.scheme, "https")
        XCTAssertEqual(AppLinks.live.host, "alphatrade-mentor-15.vercel.app")
        XCTAssertEqual(AppLinks.live.query, "page=live")
        XCTAssertEqual(AppLinks.liveOverview.scheme, "https")
        XCTAssertEqual(AppLinks.liveOverview.host, "alphatrade-mentor-15.vercel.app")
        XCTAssertEqual(AppLinks.liveOverview.query, "page=live&tab=overview")
        XCTAssertEqual(AppLinks.journal.scheme, "https")
        XCTAssertEqual(AppLinks.journal.host, "alphatrade-mentor-15.vercel.app")
        XCTAssertEqual(AppLinks.companionPairing.scheme, "https")
        XCTAssertEqual(AppLinks.companionPairing.host, "alphatrade-mentor-15.vercel.app")
        XCTAssertEqual(AppLinks.companionPairing.query, "open=mac-companion-pairing")

        for presentation in CompanionMockFixtureCatalog.all {
            for action in presentation.footer.actions {
                switch action.id {
                case .openLive:
                    let expected: CompanionDestination = presentation.fixtureID == .disarmedUnverified
                        ? .liveOverview
                        : .live
                    XCTAssertEqual(action.destination, expected, presentation.fixtureID.rawValue)
                case .openJournal:
                    XCTAssertEqual(action.destination, .journal, presentation.fixtureID.rawValue)
                case .refresh, .copyDiagnostics:
                    XCTAssertNil(action.destination, presentation.fixtureID.rawValue)
                }
            }
        }
    }

    func testNoFixtureContainsStandaloneARMUserInterfaceText() throws {
        let standaloneARM = try NSRegularExpression(pattern: #"(?i)\bARM\b"#)

        for presentation in CompanionMockFixtureCatalog.all {
            let accessibilityText = [
                presentation.menuBar.accessibilityLabel,
                presentation.freshness.accessibilityLabel
            ] + presentation.footer.actions.map(\.accessibilityLabel)
            let allUserInterfaceText = (presentation.allVisibleText + accessibilityText)
                .joined(separator: "\n")
            let match = standaloneARM.firstMatch(
                in: allUserInterfaceText,
                range: NSRange(
                    allUserInterfaceText.startIndex..<allUserInterfaceText.endIndex,
                    in: allUserInterfaceText
                )
            )

            XCTAssertNil(match, "\(presentation.fixtureID.rawValue) exposes standalone ARM text")
        }
    }

    func testNoFixtureExposesDisarmTerminology() throws {
        let forbidden = try NSRegularExpression(pattern: #"(?i)\bdisarm"#)

        for presentation in CompanionMockFixtureCatalog.all {
            let visibleText = presentation.allVisibleText.joined(separator: "\n")
            let match = forbidden.firstMatch(
                in: visibleText,
                range: NSRange(visibleText.startIndex..<visibleText.endIndex, in: visibleText)
            )

            XCTAssertNil(match, "\(presentation.fixtureID.rawValue) exposes DISARM terminology")
        }
    }
}
