import Foundation
import XCTest
@testable import AlphaTradeStatus

final class MacCompanionFunctionalTests: XCTestCase {
    private let referenceDate = Date(timeIntervalSince1970: 2_000_000_000)

    func testStatusDecoderAcceptsV1AndRejectsAnyFreshnessPolicyDrift() throws {
        let validData = Data(validStatusJSON().utf8)
        let decoded = try MacCompanionStatusDecoder.decode(validData)

        XCTAssertEqual(decoded.contractVersion, 1)
        XCTAssertEqual(decoded.freshness.verifiedMaxAgeSeconds, 10)
        XCTAssertEqual(decoded.freshness.offlineAfterSeconds, 90)
        XCTAssertEqual(decoded.exposure.verifiedAt, nil)
        XCTAssertEqual(decoded.exposure.followerAck, nil)
        XCTAssertEqual(decoded.dailyStats?.label, "Leader · jen obchody přes kopírku · bez poplatků")

        let wrongVerified = validStatusJSON()
            .replacingOccurrences(of: "\"verifiedMaxAgeSeconds\":10", with: "\"verifiedMaxAgeSeconds\":9")
        XCTAssertThrowsError(try MacCompanionStatusDecoder.decode(Data(wrongVerified.utf8))) { error in
            XCTAssertEqual(error as? MacCompanionStatusDecodingError, .invalidFreshnessPolicy)
        }

        let wrongOffline = validStatusJSON()
            .replacingOccurrences(of: "\"offlineAfterSeconds\":90", with: "\"offlineAfterSeconds\":91")
        XCTAssertThrowsError(try MacCompanionStatusDecoder.decode(Data(wrongOffline.utf8))) { error in
            XCTAssertEqual(error as? MacCompanionStatusDecodingError, .invalidFreshnessPolicy)
        }
    }

    func testFreshnessUsesExactTenAndNinetySecondBoundaries() {
        let status = makeStatus(observedAt: referenceDate)

        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(status, now: referenceDate.addingTimeInterval(10)).freshness,
            .verified(ageSeconds: 10)
        )
        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(status, now: referenceDate.addingTimeInterval(10.001)).freshness,
            .unknown(ageSeconds: 10)
        )
        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(status, now: referenceDate.addingTimeInterval(90)).freshness,
            .unknown(ageSeconds: 90)
        )
        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(status, now: referenceDate.addingTimeInterval(90.001)).freshness,
            .offline(ageSeconds: 90)
        )
        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(status, now: referenceDate.addingTimeInterval(-0.001)).freshness,
            .unknown(ageSeconds: 0)
        )
    }

    func testServerClockCorrectsWallClockSkewAndAdvancesMonotonically() throws {
        let localReceipt = referenceDate.addingTimeInterval(-2 * 60 * 60)
        let anchor = try XCTUnwrap(CompanionServerClock.makeAnchor(
            serverTime: referenceDate,
            localReceiptTime: localReceipt,
            monotonicRequestStartedSeconds: 100,
            monotonicReceiptSeconds: 100.5
        ))

        XCTAssertEqual(anchor.wallClockOffsetSeconds, 2 * 60 * 60, accuracy: 0.001)
        XCTAssertEqual(
            anchor.adjustedNow(monotonicNowSeconds: 103.5),
            referenceDate.addingTimeInterval(3.5)
        )
        XCTAssertEqual(
            anchor.adjustedNow(monotonicNowSeconds: 90),
            referenceDate.addingTimeInterval(0.5),
            "A wall-clock rollback must never move accepted server time backwards"
        )

        XCTAssertNil(CompanionServerClock.makeAnchor(
            serverTime: referenceDate,
            localReceiptTime: referenceDate.addingTimeInterval(
                -(CompanionServerClock.maximumWallClockOffset + 1)
            ),
            monotonicRequestStartedSeconds: 100,
            monotonicReceiptSeconds: 101
        ))
    }

    func testUnknownBrokerConnectionOverridesFreshShadow() {
        let status = makeStatus(copierState: .shadow, brokerConnected: nil)
        let reduced = CompanionFreshnessReducer.reduce(status, now: referenceDate)

        XCTAssertEqual(reduced.freshness, .verified(ageSeconds: 0))
        XCTAssertEqual(reduced.displayState, .unknown)

        let presentation = CompanionRemotePresentationFactory.make(from: reduced, now: referenceDate)
        let safety = presentation.sections.first { $0.id == "safety" }
        XCTAssertEqual(safety?.summary, "Neověřeno")
        XCTAssertEqual(safety?.summaryTone, .warning)
    }

    func testConfirmedCriticalSignalsOverrideUnknownFieldsOnlyWhileFresh() {
        let divergence = MacCompanionStatusDTO.DivergenceDTO(
            symbol: nil,
            account: "Follower 1",
            detail: "Pozice se liší od leadera."
        )
        let fresh = makeStatus(brokerConnected: nil, divergences: [divergence])
        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(fresh, now: referenceDate).displayState,
            .intervention(issueCount: 1)
        )

        let killSwitch = makeStatus(killSwitchTripped: true)
        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(killSwitch, now: referenceDate).displayState,
            .intervention(issueCount: 1)
        )

        let reconciliationUnknown = makeStatus(reconciliation: .unknown, problems: [
            .init(kind: .reconciliation, text: "Stav reconciliation není potvrzený.")
        ])
        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(reconciliationUnknown, now: referenceDate).displayState,
            .unknown
        )

        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(
                fresh,
                now: referenceDate.addingTimeInterval(11)
            ).displayState,
            .unknown
        )
        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(
                fresh,
                now: referenceDate.addingTimeInterval(91)
            ).displayState,
            .offline
        )
    }

    func testFreshDisarmedWithoutBrokerExposureIsUnknownButNotStale() {
        let status = makeStatus(copierState: .disarmed)
        let reduced = CompanionFreshnessReducer.reduce(status, now: referenceDate)
        let presentation = CompanionRemotePresentationFactory.make(from: reduced, now: referenceDate)
        let visibleText = presentation.allVisibleText.joined(separator: "\n").lowercased()

        XCTAssertEqual(reduced.freshness, .verified(ageSeconds: 0))
        XCTAssertEqual(reduced.displayState, .unknown)
        XCTAssertEqual(presentation.fixtureID, .disarmedUnverified)
        XCTAssertTrue(presentation.hero.detail.localizedCaseInsensitiveContains("DISARMED"))
        XCTAssertTrue(presentation.hero.detail.localizedCaseInsensitiveContains("nejsou brokerem ověřeny"))
        XCTAssertFalse(visibleText.contains("poslední znám"))
        XCTAssertFalse(visibleText.contains("neaktuáln"))
        XCTAssertFalse(presentation.exposureEvidence.mayClaimFlat)
    }

    func testProblemProjectionDoesNotDoubleCountStructuredDivergence() {
        let divergence = MacCompanionStatusDTO.DivergenceDTO(
            symbol: nil,
            account: "Follower 1",
            detail: "Pozice se liší od leadera."
        )
        let problem = MacCompanionStatusDTO.ProblemDTO(
            kind: .divergence,
            text: "Jeden účet má rozdílnou pozici."
        )
        let status = makeStatus(divergences: [divergence], problems: [problem])
        let reduced = CompanionFreshnessReducer.reduce(status, now: referenceDate)

        XCTAssertEqual(reduced.displayState, .intervention(issueCount: 1))
        XCTAssertEqual(reduced.issueCount, 1)
    }

    func testVerifiedPositionsWithoutWorkingOrderCountNeverClaimsFlat() throws {
        let exposure = MacCompanionStatusDTO.ExposureDTO(
            verifiedAt: referenceDate,
            positions: [],
            followerAck: nil,
            accountsWithWorkingOrders: nil
        )
        let status = makeStatus(copierState: .disarmed, exposure: exposure)
        let reduced = CompanionFreshnessReducer.reduce(status, now: referenceDate)
        let presentation = CompanionRemotePresentationFactory.make(from: reduced, now: referenceDate)
        let exposureSection = try XCTUnwrap(presentation.sections.first { $0.id == "exposure" })
        let visibleText = presentation.allVisibleText.joined(separator: "\n").lowercased()

        XCTAssertEqual(reduced.displayState, .unknown)
        XCTAssertFalse(reduced.exposureEvidence.mayClaimFlat)
        XCTAssertEqual(exposureSection.summary, "Neověřeno · working orders")
        XCTAssertEqual(exposureSection.summaryTone, .warning)
        XCTAssertFalse(exposureSection.hasProblem)
        XCTAssertFalse(visibleText.contains("flat ověřen"))
    }

    func testLiveFollowerAcknowledgementMustBeCompleteAndFailureFree() throws {
        let incomplete = makeStatus(exposure: .init(
            verifiedAt: nil,
            positions: [],
            followerAck: .init(confirmed: 19, total: 20, failing: []),
            accountsWithWorkingOrders: nil
        ))
        let incompleteReduced = CompanionFreshnessReducer.reduce(incomplete, now: referenceDate)
        let incompletePresentation = CompanionRemotePresentationFactory.make(
            from: incompleteReduced,
            now: referenceDate
        )
        let incompleteSafety = try XCTUnwrap(
            incompletePresentation.sections.first { $0.id == "safety" }
        )

        XCTAssertEqual(incompleteReduced.issueCount, 1)
        XCTAssertEqual(incompleteReduced.displayState, .intervention(issueCount: 1))
        XCTAssertTrue(incompleteSafety.hasProblem)
        XCTAssertTrue(incompleteSafety.isInitiallyExpanded)
        XCTAssertEqual(incompleteSafety.summaryTone, .danger)
        XCTAssertTrue(incompleteSafety.rows.contains { row in
            guard case .keyValue(let value) = row else { return false }
            return value.id == "follower-ack"
                && value.value == "19/20 followerů"
                && value.tone == .danger
        })

        let failing = makeStatus(exposure: .init(
            verifiedAt: nil,
            positions: [],
            followerAck: .init(
                confirmed: 20,
                total: 20,
                failing: [.init(
                    account: "APEX-2",
                    detail: "ENTRY nepotvrzeno",
                    sinceMinutes: 4
                )]
            ),
            accountsWithWorkingOrders: nil
        ))
        let failingReduced = CompanionFreshnessReducer.reduce(failing, now: referenceDate)
        let failingPresentation = CompanionRemotePresentationFactory.make(
            from: failingReduced,
            now: referenceDate
        )
        let failingSafety = try XCTUnwrap(
            failingPresentation.sections.first { $0.id == "safety" }
        )

        XCTAssertEqual(failingReduced.issueCount, 1)
        XCTAssertEqual(failingReduced.displayState, .intervention(issueCount: 1))
        XCTAssertTrue(failingSafety.rows.contains { row in
            guard case .keyValue(let value) = row else { return false }
            return value.label == "APEX-2"
                && value.value == "ENTRY nepotvrzeno · 4 min"
                && value.tone == .danger
        })

        let complete = makeStatus(exposure: .init(
            verifiedAt: nil,
            positions: [],
            followerAck: .init(confirmed: 20, total: 20, failing: []),
            accountsWithWorkingOrders: nil
        ))
        let completeReduced = CompanionFreshnessReducer.reduce(complete, now: referenceDate)
        let completePresentation = CompanionRemotePresentationFactory.make(
            from: completeReduced,
            now: referenceDate
        )
        let copying = try XCTUnwrap(completePresentation.sections.first { $0.id == "copying" })

        XCTAssertEqual(completeReduced.issueCount, 0)
        XCTAssertEqual(completeReduced.displayState, .live(minutesRemaining: 42))
        XCTAssertEqual(copying.summary, "20/20 followerů")
        XCTAssertEqual(copying.summaryTone, .success)
        XCTAssertFalse(copying.hasProblem)
        XCTAssertFalse(
            completePresentation.banner?.text.contains("per-follower potvrzení není dostupné") ?? false
        )

        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(
                incomplete,
                now: referenceDate.addingTimeInterval(11)
            ).displayState,
            .unknown
        )
        XCTAssertEqual(
            CompanionFreshnessReducer.reduce(
                incomplete,
                now: referenceDate.addingTimeInterval(91)
            ).displayState,
            .offline
        )
    }

    func testPairingMaterialMatchesWireContractAndKeepsRawValuesLocal() throws {
        let pending = try CompanionPairingMaterial.makePendingCredential()
        let code = try XCTUnwrap(pending.pairingCode)
        let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

        XCTAssertEqual(pending.deviceSecret.count, 43)
        XCTAssertFalse(pending.deviceSecret.contains("="))
        XCTAssertEqual(code.count, 12)
        XCTAssertTrue(code.allSatisfy(alphabet.contains))
        XCTAssertEqual(pending.deviceSecretHash.count, 64)
        XCTAssertEqual(pending.pairingCodeHash?.count, 64)
        XCTAssertTrue(pending.deviceSecretHash.allSatisfy { $0.isHexDigit && !$0.isUppercase })
        XCTAssertEqual(
            pending.authorizationHeader,
            "AlphaTradeCompanion \(pending.deviceID.uuidString.lowercased()).\(pending.deviceSecret)"
        )

        let request = MacCompanionPairingStartRequest(
            contractVersion: 1,
            deviceId: pending.deviceID.uuidString.lowercased(),
            deviceName: "Test Mac",
            deviceSecretHash: pending.deviceSecretHash,
            pairingCodeHash: try XCTUnwrap(pending.pairingCodeHash),
            appVersion: "0.2.0 (2)"
        )
        let body = try XCTUnwrap(String(data: JSONEncoder().encode(request), encoding: .utf8))
        XCTAssertTrue(body.contains(pending.deviceSecretHash))
        XCTAssertTrue(body.contains(try XCTUnwrap(pending.pairingCodeHash)))
        XCTAssertFalse(body.contains(pending.deviceSecret))
        XCTAssertFalse(body.contains(code))
    }

    func testPairingStartRateLimitIsMappedAndClampedWithoutAutomaticRetry() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PairingRateLimitURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }

        let api = MacCompanionAPI(session: session)
        let pending = try CompanionPairingMaterial.makePendingCredential()

        do {
            _ = try await api.startPairing(
                credential: pending,
                deviceName: "Test Mac",
                appVersion: "0.2.0 (2)"
            )
            XCTFail("A 429 response must not be accepted")
        } catch let error as MacCompanionAPIError {
            XCTAssertEqual(error, .rateLimited(retryAfterSeconds: 600))
            XCTAssertTrue(error.localizedDescription.contains("600 s"))
        }
    }

    func testRemotePresentationUsesRuntimeLocationAndSafeDiagnostics() {
        let status = makeStatus(copierState: .live)
        let reduced = CompanionFreshnessReducer.reduce(status, now: referenceDate)
        let presentation = CompanionRemotePresentationFactory.make(from: reduced, now: referenceDate)
        let visibleText = presentation.allVisibleText.joined(separator: "\n")

        XCTAssertTrue(visibleText.contains("Mac worker"))
        XCTAssertFalse(visibleText.contains("Tento Mac"))
        XCTAssertTrue(visibleText.localizedCaseInsensitiveContains("potvrzení followerů nedostupné"))
        XCTAssertFalse(visibleText.contains("0/0"))
        XCTAssertFalse(presentation.safeDiagnosticText.contains("Follower"))
        XCTAssertFalse(presentation.safeDiagnosticText.contains("https://"))
        XCTAssertTrue(presentation.safeDiagnosticText.contains("source=cloud-read-only"))
    }

    @MainActor
    func testWakeInvalidatesPreSleepLiveBeforeFailedRefresh() async throws {
        let status = makeStatus(copierState: .live)
        let api = WakeFailureMacCompanionAPI(firstStatus: status)
        let activeCredential = try CompanionPairingMaterial.makePendingCredential().activated()
        let fixedNow = referenceDate
        let store = CompanionStore(
            api: api,
            credentialStore: FixedCompanionCredentialStore(credential: activeCredential),
            now: { fixedNow },
            monotonicNow: { 100 },
            deviceName: "Test Mac",
            appVersion: "0.2.0 (2)"
        )
        store.start()
        defer { store.stop() }

        var displayedLive = false
        for _ in 0..<200 {
            if case .connected(let presentation) = store.state,
               case .live = presentation.displayState {
                displayedLive = true
                break
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(displayedLive, "The first accepted status should establish LIVE")

        store.handleWake()

        guard case .connected(let wakePresentation) = store.state else {
            XCTFail("Wake must synchronously retain last-known rows in an invalidated state")
            return
        }
        XCTAssertEqual(wakePresentation.displayState, .unknown)
        XCTAssertEqual(store.menuBarPresentation.pillText, "?")
        XCTAssertEqual(store.menuBarPresentation.tone, .warning)
        XCTAssertTrue(store.safeDiagnosticText.contains("revision=1"))
        XCTAssertTrue(store.safeDiagnosticText.contains("paired=yes"))

        var callCount = await api.statusCallCount
        for _ in 0..<200 where callCount < 2 {
            try await Task.sleep(nanoseconds: 10_000_000)
            callCount = await api.statusCallCount
        }
        XCTAssertGreaterThanOrEqual(callCount, 2, "Wake should request an immediate refresh")
        try await Task.sleep(nanoseconds: 20_000_000)

        guard case .connected(let failedRefreshPresentation) = store.state else {
            XCTFail("A wake transport failure must retain the invalidated presentation")
            return
        }
        XCTAssertEqual(failedRefreshPresentation.displayState, .unknown)
        XCTAssertEqual(store.menuBarPresentation.pillText, "?")
        XCTAssertFalse(store.safeDiagnosticText.contains("state=live"))
        XCTAssertTrue(store.safeDiagnosticText.contains("revision=1"))
        XCTAssertTrue(store.safeDiagnosticText.contains("paired=yes"))
    }
}

private struct FixedCompanionCredentialStore: CompanionCredentialStoring {
    let credential: CompanionCredentialRecord

    func load() throws -> CompanionCredentialRecord? { credential }
    func save(_ credential: CompanionCredentialRecord) throws {}
    func delete() throws {}
}

private actor WakeFailureMacCompanionAPI: MacCompanionAPIServing {
    let firstStatus: MacCompanionStatusDTO
    private(set) var statusCallCount = 0

    init(firstStatus: MacCompanionStatusDTO) {
        self.firstStatus = firstStatus
    }

    func startPairing(
        credential: CompanionCredentialRecord,
        deviceName: String,
        appVersion: String?
    ) async throws -> MacCompanionPairingStartResponse {
        throw MacCompanionAPIError.invalidRequest
    }

    func pairingStatus(
        credential: CompanionCredentialRecord
    ) async throws -> MacCompanionPairingStatusResponse {
        throw MacCompanionAPIError.invalidRequest
    }

    func status(
        credential: CompanionCredentialRecord
    ) async throws -> MacCompanionStatusDTO {
        statusCallCount += 1
        guard statusCallCount == 1 else {
            throw MacCompanionAPIError.transport
        }
        return firstStatus
    }
}

private final class PairingRateLimitURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 429,
            httpVersion: "HTTP/1.1",
            headerFields: ["Retry-After": "99999"]
        )!
        let body = Data(
            #"{"error":"pairing-start-rate-limited","retryAfterSeconds":99999}"#.utf8
        )
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private extension MacCompanionFunctionalTests {
    func makeStatus(
        copierState: MacCompanionStatusDTO.CopierState = .live,
        observedAt: Date? = nil,
        brokerConnected: Bool? = true,
        reconciliation: MacCompanionStatusDTO.ReconciliationDTO.Status = .clean,
        divergences: [MacCompanionStatusDTO.DivergenceDTO] = [],
        killSwitchTripped: Bool = false,
        exposure: MacCompanionStatusDTO.ExposureDTO? = nil,
        problems: [MacCompanionStatusDTO.ProblemDTO] = []
    ) -> MacCompanionStatusDTO {
        let observedAt = observedAt ?? referenceDate
        return MacCompanionStatusDTO(
            contractVersion: 1,
            serverTime: referenceDate,
            revision: 1,
            observedAt: observedAt,
            validUntil: observedAt.addingTimeInterval(10),
            freshness: .init(verifiedMaxAgeSeconds: 10, offlineAfterSeconds: 90),
            copierState: copierState,
            sessionExpiresAt: copierState == .live
                ? referenceDate.addingTimeInterval(42 * 60)
                : nil,
            worker: .init(lastHeartbeatAt: observedAt, location: .mac),
            brokerConnected: brokerConnected,
            safety: .init(
                reconciliation: .init(status: reconciliation, at: nil),
                divergences: divergences,
                outbox: .init(stuckCount: 0, oldestStuckMinutes: nil),
                cooldownActive: false,
                dayLockActive: false,
                killSwitchTripped: killSwitchTripped
            ),
            exposure: exposure ?? .init(
                verifiedAt: nil,
                positions: [],
                followerAck: nil,
                accountsWithWorkingOrders: nil
            ),
            snapshots: .init(cdpReady: true, lastEntryAt: nil, lastExitAt: nil),
            problems: problems
        )
    }

    func validStatusJSON() -> String {
        let observed = CompanionISO8601.string(from: referenceDate)
        let validUntil = CompanionISO8601.string(from: referenceDate.addingTimeInterval(10))
        let sessionExpiry = CompanionISO8601.string(from: referenceDate.addingTimeInterval(42 * 60))
        return """
        {
          "contractVersion":1,
          "serverTime":"\(observed)",
          "revision":123,
          "observedAt":"\(observed)",
          "validUntil":"\(validUntil)",
          "freshness":{"verifiedMaxAgeSeconds":10,"offlineAfterSeconds":90},
          "copierState":"live",
          "sessionExpiresAt":"\(sessionExpiry)",
          "worker":{"lastHeartbeatAt":"\(observed)","location":"mac"},
          "brokerConnected":true,
          "dailyStats":{"label":"Leader · jen obchody přes kopírku · bez poplatků","realizedPnlUsd":-120,"losingTrades":2},
          "safety":{
            "reconciliation":{"status":"clean","at":null},
            "divergences":[],
            "outbox":{"stuckCount":0,"oldestStuckMinutes":null},
            "cooldownActive":false,
            "dayLockActive":false,
            "killSwitchTripped":false
          },
          "exposure":{
            "verifiedAt":null,
            "positions":[],
            "followerAck":null,
            "accountsWithWorkingOrders":null
          },
          "snapshots":{"cdpReady":true,"lastEntryAt":null,"lastExitAt":null},
          "problems":[],
          "ignoredFutureField":"allowed"
        }
        """
    }
}
