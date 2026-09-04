import Foundation

struct CompanionPairingViewState: Equatable, Sendable {
    let code: String
    let expiresAt: Date?
    let message: String?
    let isStarting: Bool
    let isExpired: Bool
}

enum CompanionRootState: Equatable, Sendable {
    case starting
    case pairing(CompanionPairingViewState)
    case connected(CompanionPresentation)
    case revoked
    case localFailure(message: String)
}

@MainActor
final class CompanionStore: ObservableObject {
    @Published private(set) var state: CompanionRootState = .starting
    @Published private(set) var menuBarPresentation = MenuBarStatusPresentation(
        pillText: "?",
        tone: .warning,
        accessibilityLabel: "AlphaTrade, načítám stav"
    )
    @Published private(set) var isRefreshing = false
    @Published private(set) var transitionEvent: CompanionTransitionEvent?

    private let api: any MacCompanionAPIServing
    private let credentialStore: any CompanionCredentialStoring
    private let settings: CompanionSettings
    private let now: @Sendable () -> Date
    private let monotonicNow: @Sendable () -> TimeInterval
    private let deviceName: String
    private let appVersion: String?

    private var credential: CompanionCredentialRecord?
    private var latestStatus: MacCompanionStatusDTO?
    private var highestRevision: UInt64?
    private var serverClockAnchor: CompanionServerClockAnchor?
    private var lastTransportState = "idle"
    private var started = false
    private var isFetching = false
    private var statusPollTask: Task<Void, Never>?
    private var pairingPollTask: Task<Void, Never>?
    private var localTickTask: Task<Void, Never>?
    private var transitionGate = CompanionTransitionGate()
    private var transitionSequence: UInt64 = 0

    init(
        api: any MacCompanionAPIServing = MacCompanionAPI(),
        credentialStore: any CompanionCredentialStoring = CompanionKeychainCredentialStore(),
        settings: CompanionSettings? = nil,
        now: @escaping @Sendable () -> Date = { Date() },
        monotonicNow: @escaping @Sendable () -> TimeInterval = {
            ProcessInfo.processInfo.systemUptime
        },
        deviceName: String? = nil,
        appVersion: String? = nil
    ) {
        self.api = api
        self.credentialStore = credentialStore
        self.settings = settings ?? CompanionSettings()
        self.now = now
        self.monotonicNow = monotonicNow
        self.deviceName = String((deviceName ?? Self.defaultDeviceName).prefix(120))
        self.appVersion = appVersion ?? Self.defaultAppVersion
    }

    func start() {
        guard !started else { return }
        started = true
        startLocalTick()
        Task { [weak self] in
            await self?.bootstrap()
        }
    }

    func stop() {
        started = false
        statusPollTask?.cancel()
        statusPollTask = nil
        pairingPollTask?.cancel()
        pairingPollTask = nil
        localTickTask?.cancel()
        localTickTask = nil
    }

    func popoverWillOpen() {
        guard credential?.phase == .active else { return }
        // This is an observational refresh, not the explicit refresh-button
        // action. Keeping `.automatic` lets a transition discovered while the
        // already-open popover is visible update and highlight in place.
        requestImmediateStatusRefresh(origin: .automatic)
    }

    func handleWake() {
        guard started else { return }
        transitionGate.resetAutoOpenRateLimit()
        if credential?.phase == .active {
            invalidateActiveSnapshotForWake()
            restartStatusPolling(firstOrigin: .wake)
        } else if credential?.phase == .pending {
            restartPairingPolling()
        }
    }

    func requestManualRefresh() {
        switch credential?.phase {
        case .active:
            requestImmediateStatusRefresh(origin: .manualRefresh)
        case .pending:
            restartPairingPolling()
        case nil:
            Task { [weak self] in
                await self?.beginNewPairing(deleteExisting: false)
            }
        }
    }

    func pairAgain() {
        Task { [weak self] in
            await self?.beginNewPairing(deleteExisting: true)
        }
    }

    var safeDiagnosticText: String {
        let stateName: String
        switch state {
        case .starting: stateName = "starting"
        case .pairing: stateName = "pairing"
        case .connected(let presentation): stateName = presentation.displayState.stateName.lowercased()
        case .revoked: stateName = "revoked"
        case .localFailure: stateName = "local-failure"
        }

        let revision = highestRevision.map(String.init) ?? "none"
        return [
            "AlphaTrade Status",
            "app=\(appVersion ?? "unknown")",
            "paired=\(credential?.phase == .active ? "yes" : "no")",
            "state=\(stateName)",
            "contract=1",
            "revision=\(revision)",
            "transport=\(lastTransportState)",
            "scope=\(MacCompanionAPI.requiredScope)"
        ].joined(separator: "\n")
    }
}

extension CompanionStore {
    static var defaultDeviceName: String {
        let name = Host.current().localizedName?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Mac" : name
    }

    static var defaultAppVersion: String? {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        switch (version, build) {
        case let (.some(version), .some(build)):
            return "\(version) (\(build))"
        case let (.some(version), nil):
            return version
        default:
            return nil
        }
    }

    func bootstrap() async {
        do {
            guard let stored = try credentialStore.load() else {
                await beginNewPairing(deleteExisting: false)
                return
            }

            credential = stored
            switch stored.phase {
            case .active:
                updateMenuBar(for: .starting)
                restartStatusPolling(firstOrigin: .startup)
            case .pending:
                // Pairing responses do not carry serverTime. Let the server's
                // authoritative 410 response expire a pending code instead of
                // comparing its timestamp with a potentially skewed Mac clock.
                showPairing(stored, message: nil, isStarting: stored.pairingExpiresAt == nil)
                restartPairingPolling()
            }
        } catch {
            setLocalFailure(error.localizedDescription)
        }
    }

    func beginNewPairing(deleteExisting: Bool) async {
        statusPollTask?.cancel()
        statusPollTask = nil
        pairingPollTask?.cancel()
        pairingPollTask = nil
        latestStatus = nil
        highestRevision = nil
        serverClockAnchor = nil
        transitionGate.reset()
        transitionEvent = nil

        do {
            if deleteExisting {
                try credentialStore.delete()
            }
            var pending = try CompanionPairingMaterial.makePendingCredential()
            try credentialStore.save(pending)
            credential = pending
            showPairing(pending, message: nil, isStarting: true)

            let response = try await api.startPairing(
                credential: pending,
                deviceName: deviceName,
                appVersion: appVersion
            )
            pending = pending.withPairingExpiry(response.expiresAt)
            try credentialStore.save(pending)
            credential = pending
            lastTransportState = "ok"
            showPairing(pending, message: nil, isStarting: false)
            restartPairingPolling(initialDelay: TimeInterval(response.pollAfterSeconds))
        } catch is CancellationError {
            return
        } catch {
            lastTransportState = transportLabel(error)
            if let credential {
                showPairing(
                    credential,
                    message: safeMessage(error),
                    isStarting: false
                )
            } else {
                setLocalFailure(safeMessage(error))
            }
        }
    }

    func restartPairingPolling(initialDelay: TimeInterval = 0) {
        pairingPollTask?.cancel()
        pairingPollTask = Task { [weak self] in
            if initialDelay > 0 {
                try? await Task.sleep(nanoseconds: Self.nanoseconds(initialDelay))
            }
            while !Task.isCancelled {
                guard let self else { return }
                let nextDelay = await self.pollPairingOnce()
                guard !Task.isCancelled, nextDelay != nil else { return }
                try? await Task.sleep(nanoseconds: Self.nanoseconds(nextDelay ?? 2))
            }
        }
    }

    func pollPairingOnce() async -> TimeInterval? {
        guard let credential, credential.phase == .pending else { return nil }
        do {
            let response = try await api.pairingStatus(credential: credential)
            lastTransportState = "ok"
            if response.paired {
                let active = credential.activated()
                try credentialStore.save(active)
                self.credential = active
                state = .starting
                updateMenuBar(for: state)
                restartStatusPolling(firstOrigin: .startup)
                return nil
            }

            let expiresAt = response.expiresAt ?? credential.pairingExpiresAt
            var updated = credential
            if credential.pairingExpiresAt != expiresAt, let expiresAt {
                updated = credential.withPairingExpiry(expiresAt)
                try credentialStore.save(updated)
                self.credential = updated
            }
            showPairing(updated, message: nil, isStarting: false)
            return TimeInterval(response.pollAfterSeconds ?? 2)
        } catch is CancellationError {
            return nil
        } catch MacCompanionAPIError.pairingExpired {
            showExpiredPairing(credential)
            return nil
        } catch MacCompanionAPIError.invalidAuthentication {
            discardPendingPairing(
                message: "Párovací žádost už není platná. Vygeneruj nový kód."
            )
            return nil
        } catch MacCompanionAPIError.invalidScope {
            discardPendingPairing(
                message: "Server nepotvrdil oprávnění pouze pro čtení. Vygeneruj nový kód."
            )
            return nil
        } catch {
            lastTransportState = transportLabel(error)
            showPairing(credential, message: safeMessage(error), isStarting: false)
            return 5
        }
    }

    func restartStatusPolling(
        firstOrigin: CompanionTransitionObservationSource = .automatic
    ) {
        statusPollTask?.cancel()
        statusPollTask = Task { [weak self] in
            var origin = firstOrigin
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshStatus(origin: origin)
                origin = .automatic
                guard !Task.isCancelled else { return }
                let delay = self.nextStatusPollDelay()
                try? await Task.sleep(nanoseconds: Self.nanoseconds(delay))
            }
        }
    }

    func requestImmediateStatusRefresh(
        origin: CompanionTransitionObservationSource = .automatic
    ) {
        Task { [weak self] in
            await self?.refreshStatus(origin: origin)
        }
    }

    func refreshStatus(
        origin: CompanionTransitionObservationSource = .automatic
    ) async {
        guard !isFetching,
              let credential,
              credential.phase == .active else { return }
        isFetching = true
        isRefreshing = true
        defer {
            isFetching = false
            isRefreshing = false
        }

        do {
            let monotonicRequestStarted = monotonicNow()
            let response = try await api.status(credential: credential)
            let localReceiptTime = now()
            let monotonicReceipt = monotonicNow()
            if let highestRevision, response.revision < highestRevision {
                lastTransportState = "rollback-rejected"
                renderLatestStatus(evaluateTransition: false)
                return
            }
            guard let clockAnchor = CompanionServerClock.makeAnchor(
                serverTime: response.serverTime,
                localReceiptTime: localReceiptTime,
                monotonicRequestStartedSeconds: monotonicRequestStarted,
                monotonicReceiptSeconds: monotonicReceipt
            ) else {
                throw MacCompanionAPIError.invalidResponse
            }
            latestStatus = response
            highestRevision = max(highestRevision ?? 0, response.revision)
            serverClockAnchor = clockAnchor
            lastTransportState = "ok"
            renderLatestStatus(observationSource: origin)
        } catch is CancellationError {
            return
        } catch MacCompanionAPIError.invalidAuthentication {
            await handleRevocation()
        } catch {
            lastTransportState = transportLabel(error)
            if latestStatus == nil {
                setLocalFailure("Cloudový stav zatím není dostupný. Aplikace bude zkoušet obnovení dál.")
            } else {
                renderLatestStatus(observationSource: origin)
            }
        }
    }

    func nextStatusPollDelay() -> TimeInterval {
        guard let latestStatus,
              let adjustedNow = adjustedNow() else { return 5 }
        let reduced = CompanionFreshnessReducer.reduce(latestStatus, now: adjustedNow)
        let baseInterval: TimeInterval
        switch reduced.displayState {
        case .live, .locked, .intervention, .unknown, .offline:
            baseInterval = 5
        case .shadow, .disarmed, .disarmedUnverified:
            baseInterval = 8
        }

        let untilRefresh = reduced.verifiedUntil.timeIntervalSince(adjustedNow) - 1
        guard untilRefresh > 0 else { return min(baseInterval, 2) }
        return max(1, min(baseInterval, untilRefresh))
    }

    func startLocalTick() {
        localTickTask?.cancel()
        localTickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.nanoseconds(1))
                guard !Task.isCancelled, let self else { return }
                self.tick()
            }
        }
    }

    func tick() {
        renderLatestStatus()
    }

    func renderLatestStatus(
        observationSource: CompanionTransitionObservationSource = .automatic,
        evaluateTransition: Bool = true
    ) {
        guard let latestStatus,
              credential?.phase == .active,
              let adjustedNow = adjustedNow() else { return }
        let reduced = CompanionFreshnessReducer.reduce(latestStatus, now: adjustedNow)
        let presentation = CompanionRemotePresentationFactory.make(from: reduced, now: adjustedNow)
        state = .connected(presentation)
        updateMenuBar(for: state)
        if evaluateTransition,
           let result = transitionGate.observe(
               reduced,
               now: adjustedNow,
               monotonicNow: monotonicNow(),
               source: observationSource,
               autoOpenEnabled: settings.autoOpen,
               improvementsEnabled: settings.includeImprovements
           ) {
            transitionSequence &+= 1
            transitionEvent = .init(
                sequence: transitionSequence,
                transition: result.transition,
                allowsAutoOpen: result.allowsAutoOpen
            )
        }
    }

    func invalidateActiveSnapshotForWake() {
        // systemUptime does not include time spent asleep. Drop the old clock
        // anchor before any network work so a failed wake refresh cannot make
        // a pre-sleep LIVE snapshot green again. Keep the snapshot and highest
        // revision to preserve rollback protection and honest last-known rows.
        serverClockAnchor = nil
        lastTransportState = "wake-refresh-required"

        guard let latestStatus else {
            state = .starting
            updateMenuBar(for: state)
            return
        }

        let invalidatedNow = latestStatus.observedAt.addingTimeInterval(
            CompanionFreshnessReducer.maximumVerifiedAge + 0.001
        )
        let reduced = CompanionFreshnessReducer.reduce(latestStatus, now: invalidatedNow)
        let presentation = CompanionRemotePresentationFactory.make(
            from: reduced,
            now: invalidatedNow
        )
        state = .connected(presentation)
        updateMenuBar(for: state)
        _ = transitionGate.observe(
            reduced,
            now: invalidatedNow,
            monotonicNow: monotonicNow(),
            source: .wake,
            autoOpenEnabled: settings.autoOpen,
            improvementsEnabled: settings.includeImprovements
        )
    }

    func handleRevocation() async {
        statusPollTask?.cancel()
        statusPollTask = nil
        latestStatus = nil
        highestRevision = nil
        serverClockAnchor = nil
        transitionGate.reset()
        transitionEvent = nil
        lastTransportState = "revoked"
        do {
            try credentialStore.delete()
            credential = nil
        } catch {
            // The server-side revocation remains authoritative. Keeping the
            // rejected credential in Keychain cannot restore its read scope;
            // deletion will be retried the next time it is rejected.
        }
        state = .revoked
        updateMenuBar(for: state)
    }

    func showPairing(
        _ credential: CompanionCredentialRecord,
        message: String?,
        isStarting: Bool
    ) {
        guard let pairingCode = credential.pairingCode else {
            setLocalFailure("Párovací údaje nejsou úplné.")
            return
        }
        state = .pairing(.init(
            code: CompanionPairingMaterial.formattedPairingCode(pairingCode),
            expiresAt: credential.pairingExpiresAt,
            message: message,
            isStarting: isStarting,
            isExpired: false
        ))
        updateMenuBar(for: state)
    }

    func showExpiredPairing(_ credential: CompanionCredentialRecord) {
        guard let pairingCode = credential.pairingCode else {
            setLocalFailure("Párovací kód vypršel.")
            return
        }
        state = .pairing(.init(
            code: CompanionPairingMaterial.formattedPairingCode(pairingCode),
            expiresAt: credential.pairingExpiresAt,
            message: "Párovací kód vypršel. Vygeneruj nový kód.",
            isStarting: false,
            isExpired: true
        ))
        updateMenuBar(for: state)
    }

    func setLocalFailure(_ message: String) {
        state = .localFailure(message: message)
        updateMenuBar(for: state)
    }

    func discardPendingPairing(message: String) {
        pairingPollTask?.cancel()
        pairingPollTask = nil
        do {
            try credentialStore.delete()
        } catch {
            // The in-memory credential is discarded regardless. A subsequent
            // save replaces a stale local item without exposing its secret.
        }
        credential = nil
        lastTransportState = "pairing-rejected"
        setLocalFailure(message)
    }

    func clearTransitionPresentation() {
        transitionEvent = nil
    }

    func updateMenuBar(for state: CompanionRootState) {
        switch state {
        case .connected(let presentation):
            menuBarPresentation = presentation.menuBar
        case .revoked:
            menuBarPresentation = .init(
                pillText: "?",
                tone: .warning,
                accessibilityLabel: "AlphaTrade, přístup tohoto Macu byl zrušen"
            )
        case .pairing:
            menuBarPresentation = .init(
                pillText: "?",
                tone: .warning,
                accessibilityLabel: "AlphaTrade, čeká na spárování"
            )
        case .starting:
            menuBarPresentation = .init(
                pillText: "?",
                tone: .warning,
                accessibilityLabel: "AlphaTrade, načítám stav"
            )
        case .localFailure:
            menuBarPresentation = .init(
                pillText: "?",
                tone: .warning,
                accessibilityLabel: "AlphaTrade, cloudový stav není dostupný"
            )
        }
    }

    func safeMessage(_ error: Error) -> String {
        if let localized = error as? LocalizedError,
           let description = localized.errorDescription {
            return description
        }
        return "Cloudový stav je dočasně nedostupný."
    }

    func transportLabel(_ error: Error) -> String {
        guard let error = error as? MacCompanionAPIError else {
            return "local-error"
        }
        switch error {
        case .transport: return "offline"
        case .temporarilyUnavailable: return "unavailable"
        case .invalidAuthentication: return "revoked"
        case .rateLimited: return "rate-limited"
        case .unsupportedContract: return "unsupported-contract"
        case .invalidResponse, .responseTooLarge: return "invalid-response"
        default: return "request-failed"
        }
    }

    static func nanoseconds(_ seconds: TimeInterval) -> UInt64 {
        UInt64(max(0, seconds) * 1_000_000_000)
    }

    func adjustedNow() -> Date? {
        serverClockAnchor?.adjustedNow(monotonicNowSeconds: monotonicNow())
    }
}
