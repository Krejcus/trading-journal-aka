import SwiftUI

@main
struct AlphaTradeNativeLabApp: App {
    @UIApplicationDelegateAdaptor(NativeNotificationDelegate.self) private var notificationDelegate
    @State private var store: NativeLabStore

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let initialStore: NativeLabStore
        if arguments.contains("-ui-testing") {
            initialStore = NativeLabStore(
                journalPersistence: MemoryJournalPersistence(),
                coachPersistence: MemoryCoachPersistence(),
                publishesWidgetSnapshots: false
            )
        } else {
            initialStore = NativeLabStore()
        }
        if arguments.contains("-ui-testing-spotlight-first"), let id = initialStore.trades.first?.id {
            initialStore.handleSpotlightTrade(id)
        }
        _store = State(initialValue: initialStore)
    }

    /// Cíl web shellu. Dev server přes LAN adresu Macu, aby na něj dosáhl
    /// i telefon — `localhost` by na zařízení mířil sám na sebe. Pro produkci
    /// stačí `WebShellEngine.productionURL`.
    private static let shellURL = URL(string: "http://192.168.68.102:5273/?native=1")!

    var body: some Scene {
        WindowGroup {
            // Nativní shell nad webovou aplikací. Původní demo `RootView()`
            // zůstává v projektu — návrat je změna tohoto jednoho řádku.
            // Barevné schéma neurčuje shell — hlásí ho web přes most, aby tab
            // bar sledoval jeho přepínač témat.
            WebShellView(url: Self.shellURL)
                .environment(store)
        }
    }
}
