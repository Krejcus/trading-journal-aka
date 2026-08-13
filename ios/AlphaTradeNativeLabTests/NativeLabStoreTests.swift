import Foundation
import CoreSpotlight
import Testing
@testable import AlphaTradeNativeLab

@MainActor
struct NativeLabStoreTests {
    init() {
        UserDefaults.standard.removeObject(forKey: "nativeLab.pendingAction")
    }

    @Test("Rychlý zápis přidá obchod a přepočítá dnešní souhrn")
    func addTradeUpdatesJournal() {
        let store = NativeLabStore(journalPersistence: MemoryJournalPersistence(), coachPersistence: MemoryCoachPersistence())
        let before = store.trades.count
        let beforePnL = store.dayPnL

        store.addTrade(symbol: "MNQ", side: "LONG", result: 125.5, setup: "Test setup", note: "Lokální test")

        #expect(store.trades.count == before + 1)
        #expect(store.trades.first?.symbol == "MNQ")
        #expect(store.dayPnL == beforePnL + 125.5)
        #expect(store.todayTradeCount >= 1)
    }

    @Test("Persistovaný obchod se načte v novém store")
    func journalPersistsLocally() {
        let persistence = MemoryJournalPersistence()
        let first = NativeLabStore(journalPersistence: persistence, coachPersistence: MemoryCoachPersistence())
        first.addTrade(symbol: "NQ", side: "SHORT", result: -50, setup: "Persistence", note: "Sandbox")

        let second = NativeLabStore(journalPersistence: persistence, coachPersistence: MemoryCoachPersistence())

        #expect(second.trades.first?.setup == "Persistence")
        #expect(second.trades.first?.result == -50)
    }

    @Test("Replay nikdy neodhalí svíčku za koncem datasetu")
    func replayStopsAtBoundary() {
        let store = NativeLabStore(journalPersistence: MemoryJournalPersistence(), coachPersistence: MemoryCoachPersistence())
        for _ in 0..<(store.candles.count + 10) { store.advanceReplay() }

        #expect(store.replayIndex == store.candles.count)
        #expect(store.visibleCandles.count == store.candles.count)
    }

    @Test("Systémová akce otevře replay a spotřebuje pending route")
    func shortcutRoutesSafely() {
        let store = NativeLabStore(journalPersistence: MemoryJournalPersistence(), coachPersistence: MemoryCoachPersistence())
        UserDefaults.standard.set("replay", forKey: "nativeLab.pendingAction")

        store.handlePendingSystemAction()

        #expect(store.selectedTab == .replay)
        #expect(UserDefaults.standard.string(forKey: "nativeLab.pendingAction") == nil)
    }

    @Test("Systémová akce capture pouze otevře lokální formulář")
    func shortcutOpensCapture() {
        let store = NativeLabStore(journalPersistence: MemoryJournalPersistence(), coachPersistence: MemoryCoachPersistence())
        UserDefaults.standard.set("capture", forKey: "nativeLab.pendingAction")

        store.handlePendingSystemAction()

        #expect(store.isQuickCapturePresented)
    }

    @Test("Hlavní mobilní navigace odpovídá AlphaTrade informační architektuře")
    func primaryNavigationMatchesAlphaTrade() {
        let store = NativeLabStore(journalPersistence: MemoryJournalPersistence(), coachPersistence: MemoryCoachPersistence())
        #expect(AppTab.today.title == "Dashboard")
        #expect(AppTab.history.title == "Historie")
        #expect(AppTab.journal.title == "Deník")
        #expect(AppTab.coach.title == "AI")

        store.navigate(to: .history)
        #expect(store.selectedTab == .history)
    }

    @Test("Dashboard filtr omezuje skutečný dataset podle období")
    func dashboardRangeFiltersTrades() {
        let store = NativeLabStore(journalPersistence: MemoryJournalPersistence(), coachPersistence: MemoryCoachPersistence())
        let all = store.dashboardTrades.count
        store.dashboardRange = .sevenDays
        #expect(store.dashboardTrades.count <= all)
        #expect(store.dashboardTrades.allSatisfy { $0.timestamp >= DashboardRange.sevenDays.cutoff! })
    }

    @Test("Notifikační route otevře správnou bezpečnou sekci")
    func notificationRoutesToJournal() {
        let store = NativeLabStore(journalPersistence: MemoryJournalPersistence(), coachPersistence: MemoryCoachPersistence())
        UserDefaults.standard.set("journal", forKey: "nativeLab.pendingAction")

        store.handlePendingSystemAction()

        #expect(store.selectedTab == .journal)
        #expect(UserDefaults.standard.string(forKey: "nativeLab.pendingAction") == nil)
    }

    @Test("Akční tlačítka notifikace mají deterministické routování")
    func notificationActionsResolveRoutes() {
        #expect(NativeLabRoute.resolve(
            actionIdentifier: NativeNotificationService.openPreparationAction,
            userInfo: ["route": "journal"]
        ) == .today)
        #expect(NativeLabRoute.resolve(
            actionIdentifier: NativeNotificationService.quickCaptureAction,
            userInfo: [:]
        ) == .capture)
        #expect(NativeLabRoute.resolve(
            actionIdentifier: NativeNotificationService.openJournalAction,
            userInfo: [:]
        ) == .journal)
        #expect(NativeLabRoute.resolve(
            actionIdentifier: NativeNotificationService.addNoteAction,
            userInfo: [:]
        ) == .capture)
        #expect(NativeLabRoute.resolve(
            actionIdentifier: NativeNotificationService.openCoachAction,
            userInfo: [:]
        ) == .coach)
        #expect(NativeLabRoute.resolve(
            actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier",
            userInfo: ["route": "coach"]
        ) == .coach)
    }

    @Test("Widget deep link přijme pouze vlastní scheme a všechny bezpečné routy")
    func widgetDeepLinksResolveSafely() {
        #expect(NativeLabRoute.from(url: URL(string: "alphatrade-lab://capture")!) == .capture)
        #expect(NativeLabRoute.from(url: URL(string: "alphatrade-lab://live")!) == .live)
        #expect(NativeLabRoute.from(url: URL(string: "https://example.com/capture")!) == nil)
        #expect(NativeLabRoute.from(url: URL(string: "alphatrade-lab://unknown")!) == nil)
    }

    @Test("Widget snapshot respektuje režim soukromí a obsahuje čerstvá lokální data")
    func widgetSnapshotPublishesLocalData() throws {
        let store = NativeLabStore(
            journalPersistence: MemoryJournalPersistence(),
            coachPersistence: MemoryCoachPersistence()
        )
        store.setWidgetPrivacyMode(.hidden)
        store.addTrade(symbol: "MNQ", side: "LONG", result: 99, setup: "Widget test", note: "Local")

        let defaults = UserDefaults(suiteName: WidgetSnapshotPublisher.appGroupIdentifier) ?? .standard
        let data = try #require(defaults.data(forKey: WidgetSnapshotPublisher.snapshotKey))
        let snapshot = try JSONDecoder().decode(NativeWidgetSnapshot.self, from: data)

        #expect(snapshot.privacyMode == WidgetPrivacyMode.hidden.rawValue)
        #expect(snapshot.recentTrades.first?.result == 99)
        #expect(snapshot.tradeCount >= 1)
        #expect(!snapshot.equity.isEmpty)
    }

    @Test("Notification Gallery obsahuje dvanáct scénářů a dvě rich přílohy")
    func notificationGalleryCoverage() {
        #expect(NativeNotificationService.Demo.allCases.count == 12)
        #expect(NativeNotificationService.Demo.allCases.filter(\.hasRichAttachment).count == 2)
        #expect(NativeNotificationService.Demo.tradeScreenshot.route == .journal)
        #expect(NativeNotificationService.Demo.connectionLost.route == .live)
        #expect(NativeNotificationService.Demo.riskWarning.defaultDelay < 30)
    }

    @Test("Obrázková notifikace vytvoří skutečnou PNG přílohu")
    func richNotificationCreatesAttachment() throws {
        let attachment = try NotificationAttachmentRenderer.attachment(for: .tradeScreenshot)
        #expect(attachment.identifier == NativeNotificationService.Demo.tradeScreenshot.rawValue)
        #expect(attachment.url.pathExtension.lowercased() == "png")
        #expect(FileManager.default.fileExists(atPath: attachment.url.path))
    }

    @Test("Notifikační route neobejde Privacy Mode")
    func notificationRouteWaitsForUnlock() {
        let store = NativeLabStore(journalPersistence: MemoryJournalPersistence(), coachPersistence: MemoryCoachPersistence())
        store.privacyMode = true
        UserDefaults.standard.set("capture", forKey: "nativeLab.pendingAction")

        store.handlePendingSystemAction()
        #expect(!store.isQuickCapturePresented)
        #expect(UserDefaults.standard.string(forKey: "nativeLab.pendingAction") == "capture")

        store.privacyMode = false
        store.handlePendingSystemAction()
        #expect(store.isQuickCapturePresented)
        #expect(UserDefaults.standard.string(forKey: "nativeLab.pendingAction") == nil)
    }

    @Test("Spotlight identifikátor otevře přesný obchod")
    func spotlightIdentifierRoutesToTrade() {
        let id = UUID()
        let activity = NSUserActivity(activityType: CSSearchableItemActionType)
        activity.addUserInfoEntries(from: [
            CSSearchableItemActivityIdentifier: "\(SearchableIndexService.tradeIdentifierPrefix)\(id.uuidString)"
        ])

        #expect(SearchableIndexService.tradeID(from: activity) == id)

        let store = NativeLabStore(
            journalPersistence: MemoryJournalPersistence(),
            coachPersistence: MemoryCoachPersistence()
        )
        store.handleSpotlightTrade(id)
        #expect(store.selectedTab == .journal)
        #expect(store.focusedTradeID == id)
    }

    @Test("Spotlight záznam neobejde Privacy Mode")
    func spotlightWaitsForPrivacyUnlock() {
        let store = NativeLabStore(
            journalPersistence: MemoryJournalPersistence(),
            coachPersistence: MemoryCoachPersistence()
        )
        let id = UUID()
        store.privacyMode = true

        store.handleSpotlightTrade(id)

        #expect(store.selectedTab == .today)
        #expect(store.focusedTradeID == id)
        #expect(UserDefaults.standard.string(forKey: "nativeLab.pendingAction") == "journal")
    }

    @Test("Spotlight odmítne poškozený nebo cizí identifikátor")
    func spotlightRejectsInvalidIdentifier() {
        let activity = NSUserActivity(activityType: CSSearchableItemActionType)
        activity.addUserInfoEntries(from: [CSSearchableItemActivityIdentifier: "account:not-a-trade"])

        #expect(SearchableIndexService.tradeID(from: activity) == nil)
    }

    @Test("Coach konverzace a uložený závěr přežijí nové vytvoření store")
    func coachMemoryPersistsEncryptedState() {
        let persistence = MemoryCoachPersistence()
        let first = NativeLabStore(
            journalPersistence: MemoryJournalPersistence(),
            coachPersistence: persistence
        )

        first.sendCoachMessage("Dodržel jsem čekání na potvrzení.")
        let savedMessageID = first.coachMessages.last?.id
        #expect(first.toggleLatestCoachConclusion())

        let second = NativeLabStore(
            journalPersistence: MemoryJournalPersistence(),
            coachPersistence: persistence
        )

        #expect(second.coachMessages.contains { $0.text == "Dodržel jsem čekání na potvrzení." })
        #expect(second.latestCoachConclusionSaved)
        #expect(savedMessageID.map { second.savedCoachConclusionIDs.contains($0) } == true)
    }

    @Test("Read-only vzdálený snapshot nahradí demo data bez zápisové operace")
    func remoteSnapshotHydratesStore() async {
        let trade = TradeRecord(id: UUID(), symbol: "MNQ", side: "LONG", result: 420, rMultiple: 2.1, setup: "Remote", note: "RLS", timestamp: .now)
        let account = TradingAccount(name: "Funded 50K", firm: "AlphaTrade", balance: 50_000, dayPnL: 420, connected: true)
        let session = JournalSession(id: "prep-1", date: .now, session: "New York", bias: "Long", playbook: "NQ", preNote: "čekat", postNote: "trpělivost", screenshotCount: 1)
        let focus = WeeklyFocusItem(id: "goal-1", text: "Neobchodovat první reakci", emoji: "🎯")
        let stub = RemoteServiceStub(snapshot: .init(email: "native@example.com", trades: [trade], accounts: [account], journalSessions: [session], weeklyFocus: [focus]))
        let store = NativeLabStore(
            journalPersistence: MemoryJournalPersistence(),
            coachPersistence: MemoryCoachPersistence(),
            publishesWidgetSnapshots: false,
            remoteService: stub
        )

        await store.restoreRemoteSession()

        #expect(store.trades == [trade])
        #expect(store.accounts == [account])
        #expect(store.remoteConnection == .connected(email: "native@example.com"))
        #expect(store.journalSessions == [session])
        #expect(store.weeklyFocus == [focus])
    }

    @Test("Odpojení vzdálených dat obnoví lokální deník")
    func remoteSignOutRestoresLocalTrades() async {
        let remoteTrade = TradeRecord(id: UUID(), symbol: "NQ", side: "SHORT", result: -50, rMultiple: -0.5, setup: "Remote", note: "", timestamp: .now)
        let stub = RemoteServiceStub(snapshot: .init(email: "native@example.com", trades: [remoteTrade], accounts: []))
        let store = NativeLabStore(
            journalPersistence: MemoryJournalPersistence(),
            coachPersistence: MemoryCoachPersistence(),
            publishesWidgetSnapshots: false,
            remoteService: stub
        )
        let localIDs = Set(store.trades.map(\.id))
        await store.restoreRemoteSession()
        #expect(store.trades == [remoteTrade])

        await store.signOutRemote()
        #expect(Set(store.trades.map(\.id)) == localIDs)
        #expect(store.remoteConnection == .local)
    }
}

private actor RemoteServiceStub: AlphaTradeRemoteServing {
    let snapshot: AlphaTradeRemoteSnapshot?
    init(snapshot: AlphaTradeRemoteSnapshot?) { self.snapshot = snapshot }
    func restore() async throws -> AlphaTradeRemoteSnapshot? { snapshot }
    func signIn(email: String, password: String) async throws -> AlphaTradeRemoteSnapshot {
        snapshot ?? .init(email: email, trades: [], accounts: [])
    }
    func signOut() async {}
}
