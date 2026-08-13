import Foundation
import Observation

@MainActor @Observable
final class NativeLabStore {
    private let journalPersistence: any JournalPersisting
    private let coachPersistence: any CoachPersisting
    private let publishesWidgetSnapshots: Bool
    private let remoteService: any AlphaTradeRemoteServing
    var selectedTab: AppTab = .today
    var privacyMode = false
    var isQuickCapturePresented = false
    var dailyPrepComplete = false
    var replayIndex = 18
    var replayIsPlaying = false
    var selectedReplaySide: String?
    var focusedTradeID: UUID?
    var widgetPrivacyMode = WidgetSnapshotPublisher.savedPrivacyMode()
    var draftCount = 1
    var remoteConnection: RemoteConnectionState = .local
    var remoteAccounts: [TradingAccount]?
    var journalSessions: [JournalSession] = []
    var weeklyFocus: [WeeklyFocusItem] = []
    var dashboardRange: DashboardRange = .all
    private var localTrades: [TradeRecord] = []

    var trades: [TradeRecord] = [
        .init(id: UUID(), symbol: "MNQ", side: "LONG", result: 184.50, rMultiple: 1.42, setup: "Sweep → MSS → FVG", note: "Trpělivý návrat do FVG, výstup podle plánu.", timestamp: .now.addingTimeInterval(-3600 * 3)),
        .init(id: UUID(), symbol: "MNQ", side: "SHORT", result: -74.00, rMultiple: -0.58, setup: "VWAP rejection", note: "Vstup byl příliš brzy, bez potvrzení struktury.", timestamp: .now.addingTimeInterval(-86400)),
        .init(id: UUID(), symbol: "NQ", side: "LONG", result: 312.00, rMultiple: 2.08, setup: "pdVWAP reclaim", note: "Čisté potvrzení a strukturální invalidace.", timestamp: .now.addingTimeInterval(-172800))
    ]

    var coachMessages: [CoachMessage] = [
        .init(role: .coach, text: "Dnešní priorita: neobchodovat první reakci. Počkej na sweep, změnu struktury a návrat do oblasti vstupu."),
        .init(role: .trader, text: "Chci dnes hlídat hlavně trpělivost a nepřidávat risk po ztrátě."),
        .init(role: .coach, text: "Dobře. Po první ztrátě vlož povinnou dvouminutovou pauzu a další vstup dovol jen s kompletním checklistem.")
    ]
    var savedCoachConclusionIDs: Set<UUID> = []

    private let demoAccounts: [TradingAccount] = [
        .init(name: "Apex 50K · 01", firm: "Apex", balance: 51_284, dayPnL: 184.50, connected: true),
        .init(name: "Topstep 50K · 02", firm: "Topstep", balance: 50_936, dayPnL: 184.50, connected: true),
        .init(name: "Testovací účet", firm: "Lokální režim", balance: 100_000, dayPnL: 0, connected: true)
    ]

    var accounts: [TradingAccount] { remoteAccounts ?? demoAccounts }

    let candles: [Candle] = (0..<42).map { index in
        let base = 21_420.0 + sin(Double(index) / 3.2) * 28 + Double(index) * 1.8
        let close = base + sin(Double(index) * 1.7) * 11
        return Candle(open: base, high: max(base, close) + 7 + Double(index % 4), low: min(base, close) - 6 - Double(index % 3), close: close)
    }

    var dayPnL: Double { trades.filter { Calendar.current.isDateInToday($0.timestamp) }.reduce(0) { $0 + $1.result } }
    var todayTradeCount: Int { trades.filter { Calendar.current.isDateInToday($0.timestamp) }.count }
    var visibleCandles: ArraySlice<Candle> { candles.prefix(max(1, min(replayIndex, candles.count))) }

    var latestCoachConclusionSaved: Bool {
        guard let id = coachMessages.last(where: { $0.role == .coach })?.id else { return false }
        return savedCoachConclusionIDs.contains(id)
    }

    var savedCoachConclusionCount: Int { savedCoachConclusionIDs.count }

    init(
        journalPersistence: any JournalPersisting = SecureJournalPersistence(),
        coachPersistence: any CoachPersisting = SecureCoachPersistence(),
        publishesWidgetSnapshots: Bool = true,
        remoteService: any AlphaTradeRemoteServing = AlphaTradeRemoteService()
    ) {
        self.journalPersistence = journalPersistence
        self.coachPersistence = coachPersistence
        self.publishesWidgetSnapshots = publishesWidgetSnapshots
        self.remoteService = remoteService
        if let saved = journalPersistence.load(), !saved.isEmpty { trades = saved }
        localTrades = trades
        if let savedCoach = coachPersistence.load(), !savedCoach.messages.isEmpty {
            coachMessages = savedCoach.messages
            savedCoachConclusionIDs = savedCoach.savedConclusionIDs
                .intersection(Set(savedCoach.messages.map(\.id)))
        }
        publishWidgetSnapshot()
    }

    func restoreRemoteSession() async {
        do {
            guard let snapshot = try await remoteService.restore() else { return }
            apply(snapshot)
        } catch {
            remoteConnection = .error(error.localizedDescription)
        }
    }

    func signIn(email: String, password: String) async {
        remoteConnection = .connecting
        do {
            apply(try await remoteService.signIn(email: email, password: password))
        } catch {
            remoteConnection = .error(error.localizedDescription)
        }
    }

    func signOutRemote() async {
        await remoteService.signOut()
        remoteAccounts = nil
        trades = localTrades
        remoteConnection = .local
        publishWidgetSnapshot()
    }

    private func apply(_ snapshot: AlphaTradeRemoteSnapshot) {
        trades = snapshot.trades
        remoteAccounts = snapshot.accounts
        journalSessions = snapshot.journalSessions
        weeklyFocus = snapshot.weeklyFocus
        remoteConnection = .connected(email: snapshot.email)
        publishWidgetSnapshot()
    }

    func addTrade(symbol: String, side: String, result: Double, setup: String, note: String) {
        let trade = TradeRecord(id: UUID(), symbol: symbol, side: side, result: result, rMultiple: result / 130, setup: setup, note: note, timestamp: .now)
        localTrades.insert(trade, at: 0)
        if case .connected = remoteConnection { trades.insert(trade, at: 0) }
        else { trades = localTrades }
        draftCount = max(0, draftCount - 1)
        journalPersistence.save(localTrades)
        publishWidgetSnapshot()
    }

    var dashboardTrades: [TradeRecord] {
        guard let cutoff = dashboardRange.cutoff else { return trades }
        return trades.filter { $0.timestamp >= cutoff }
    }

    func sendCoachMessage(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        coachMessages.append(.init(role: .trader, text: text))
        coachMessages.append(.init(role: .coach, text: "Zapsáno do lokální konverzace. Před dalším vstupem ověř: kontext, potvrzení, invalidaci a maximální risk."))
        persistCoachState()
    }

    @discardableResult
    func toggleLatestCoachConclusion() -> Bool {
        guard let id = coachMessages.last(where: { $0.role == .coach })?.id else { return false }
        if savedCoachConclusionIDs.contains(id) { savedCoachConclusionIDs.remove(id) }
        else { savedCoachConclusionIDs.insert(id) }
        persistCoachState()
        return savedCoachConclusionIDs.contains(id)
    }

    private func persistCoachState() {
        coachPersistence.save(.init(messages: coachMessages, savedConclusionIDs: savedCoachConclusionIDs))
    }

    func advanceReplay() { replayIndex = min(candles.count, replayIndex + 1) }
    func resetReplay() { replayIndex = 18; replayIsPlaying = false; selectedReplaySide = nil }

    func handlePendingSystemAction() {
        guard !privacyMode else { return }
        guard let action = UserDefaults.standard.string(forKey: "nativeLab.pendingAction") else { return }
        UserDefaults.standard.removeObject(forKey: "nativeLab.pendingAction")
        handle(route: NativeLabRoute(rawValue: action) ?? .today)
    }

    func handle(route: NativeLabRoute) {
        switch route {
        case .capture: isQuickCapturePresented = true
        case .journal: selectedTab = .journal
        case .coach: selectedTab = .coach
        case .replay: selectedTab = .replay
        case .live: selectedTab = .live
        case .today: selectedTab = .today
        }
    }

    func navigate(to tab: AppTab) {
        selectedTab = tab
    }

    func handleSpotlightTrade(_ id: UUID?) {
        focusedTradeID = id
        if privacyMode {
            NativeLabRoute.journal.persist()
        } else {
            selectedTab = .journal
        }
    }

    func setWidgetPrivacyMode(_ mode: WidgetPrivacyMode) {
        widgetPrivacyMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: WidgetSnapshotPublisher.privacyKey)
        publishWidgetSnapshot()
    }

    func publishWidgetSnapshot() {
        guard publishesWidgetSnapshots else { return }
        WidgetSnapshotPublisher.publish(from: self)
    }

}
