import SwiftUI
import WebKit

/// Nativní iOS shell nad webovou AlphaTrade aplikací.
///
/// Tab bar je systémový `TabView`, takže na iOS 26 dostane Liquid Glass zdarma
/// — včetně morphingu, scroll efektů a haptiky. Obsah každého tabu je jedna
/// sdílená `WKWebView` instance; přepnutí tabu jen zavolá navigační most
/// ve webové aplikaci, takže nedochází k reloadu ani ke ztrátě session.
enum ShellTab: String, CaseIterable, Identifiable {
    case dashboard, history, capture, journal, more

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dashboard: "Dashboard"
        case .history: "Historie"
        case .capture: "Zapsat"
        case .journal: "Deník"
        case .more: "Více"
        }
    }

    var symbol: String {
        switch self {
        case .dashboard: "square.grid.2x2"
        case .history: "clock.arrow.circlepath"
        case .capture: "plus.circle.fill"
        case .journal: "book"
        case .more: "ellipsis"
        }
    }

    /// Odpovídá `activePage` ve webové aplikaci. `capture` ani `more` nejsou
    /// stránky — otevírají modál zápisu, resp. nabídku dalších sekcí.
    var page: String? {
        switch self {
        case .dashboard: "dashboard"
        case .history: "history"
        case .journal: "journal"
        case .capture, .more: nil
        }
    }
}

/// Sekce dostupné z nabídky „Více". Web jich má víc, než se vejde do tab baru,
/// který iPhone omezuje na pět položek.
enum ShellDestination: String, CaseIterable, Identifiable {
    case ai, lab, live, business, network, accounts, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .ai: "AI Coach"
        case .lab: "Lab"
        case .live: "LIVE"
        case .business: "Byznys"
        case .network: "Síť"
        case .accounts: "Účty"
        case .settings: "Nastavení"
        }
    }

    var symbol: String {
        switch self {
        case .ai: "brain.head.profile"
        case .lab: "flask"
        case .live: "dot.radiowaves.left.and.right"
        case .business: "briefcase"
        case .network: "globe"
        case .accounts: "wallet.bifold"
        case .settings: "gearshape"
        }
    }

    /// `activePage` ve webové aplikaci.
    var page: String { rawValue }
}

/// Drží jedinou `WKWebView` sdílenou všemi taby a most do webové aplikace.
@MainActor
@Observable
final class WebShellEngine: NSObject {
    /// Výchozí cíl. Lokální dev server umožní testovat most bez deploye;
    /// produkci lze zapnout přepnutím konstanty.
    nonisolated static let productionURL = URL(string: "https://alphatrade-mentor-15.vercel.app/?native=1")!

    let webView: WKWebView
    var isLoading = true
    var loadError: String?

    /// Nabídka „Více" a nativní Lab — otevírá je tab bar, zobrazuje SwiftUI.
    var showsMoreMenu = false
    var showsNativeLab = false

    /// Téma hlášené webem. Drží tab bar i status bar v souladu s obsahem.
    var colorScheme: ColorScheme?

    private let startURL: URL
    /// Vlastní instance, ne `webView.configuration.userContentController`.
    /// WKWebView si konfiguraci při inicializaci zkopíruje a její getter vrací
    /// kopii, takže zápis do ní by se zahodil — tenhle referenční typ ale kopie
    /// sdílí, takže registrace po `super.init()` platí.
    private let contentController = WKUserContentController()

    init(url: URL) {
        startURL = url

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.websiteDataStore = .default()
        configuration.userContentController = contentController

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        contentController.add(self, name: "alphaTradeShell")

        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Web má vlastní pozadí; průhlednost by pod Liquid Glass blikala.
        webView.isOpaque = true

        webView.load(URLRequest(url: startURL))
    }

    /// Přepne sekci ve webové aplikaci bez reloadu.
    ///
    /// Preferuje navigační most (`window.__alphaTradeNative`). Když ho web
    /// nevystavuje — typicky starší nasazená verze — spadne zpět na reload
    /// s `?page=`, který web čte při inicializaci.
    func select(_ tab: ShellTab) {
        switch tab {
        case .capture:
            run(bridgeCall: "addTrade()", fallbackPage: nil)
        case .more:
            showsMoreMenu = true
        default:
            guard let page = tab.page else { return }
            open(page: page)
        }
    }

    func open(_ destination: ShellDestination) {
        open(page: destination.page)
    }

    private func open(page: String) {
        run(bridgeCall: "navigate('\(page)')", fallbackPage: page)
    }

    private func run(bridgeCall: String, fallbackPage: String?) {
        let script = """
        (() => {
          const bridge = window.__alphaTradeNative;
          if (!bridge) return 'fallback';
          bridge.\(bridgeCall);
          return 'bridge';
        })()
        """

        webView.evaluateJavaScript(script) { [weak self] result, _ in
            guard let self, (result as? String) == "fallback", let fallbackPage else { return }
            self.reload(page: fallbackPage)
        }
    }

    private func reload(page: String) {
        guard var components = URLComponents(url: startURL, resolvingAgainstBaseURL: false) else { return }
        components.queryItems = [
            URLQueryItem(name: "native", value: "1"),
            URLQueryItem(name: "page", value: page)
        ]
        guard let url = components.url else { return }
        webView.load(URLRequest(url: url))
    }

    func retry() {
        loadError = nil
        isLoading = true
        webView.load(URLRequest(url: startURL))
    }
}

extension WebShellEngine: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any],
              payload["type"] as? String == "theme",
              let theme = payload["value"] as? String else { return }

        // `oled` je tmavá varianta webu, jen s hlubší černou.
        let isLight = theme == "light"
        colorScheme = isLight ? .light : .dark

        // Liquid Glass tab bar prosvítá to, co je pod ním — a tam je pozadí
        // hostitelského view, ne web. Bez přebarvení by nad světlým webem
        // zůstal tmavý bez ohledu na barevné schéma.
        webView.superview?.backgroundColor = isLight ? .white : .black
        webView.window?.overrideUserInterfaceStyle = isLight ? .light : .dark
    }
}

extension WebShellEngine: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
        loadError = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        loadError = error.localizedDescription
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        loadError = error.localizedDescription
    }
}

/// `UITabBarController`, který drží web přímo ve své hierarchii — pod tab
/// barem, nad prázdnými taby.
///
/// Web tak nikdy nemění rodiče. Kdyby ho vlastnily jednotlivé taby, SwiftUI by
/// ho při každém přepnutí přesouval mezi kontejnery a při rychlé změně výběru
/// by se odpojil a zůstal černý.
final class ShellTabBarController: UITabBarController, UITabBarControllerDelegate {
    private let webView: WKWebView
    private let onSelect: (ShellTab) -> Void

    init(webView: WKWebView, onSelect: @escaping (ShellTab) -> Void) {
        self.webView = webView
        self.onSelect = onSelect
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) není podporován") }

    override func viewDidLoad() {
        super.viewDidLoad()
        delegate = self
        view.backgroundColor = .black

        // iOS 26 staví Liquid Glass tab bar nad `tabs`; starší `viewControllers`
        // vykreslí prázdnou lištu bez položek.
        tabs = ShellTab.allCases.map { tab in
            UITab(title: tab.title, image: UIImage(systemName: tab.symbol), identifier: tab.rawValue) { _ in
                let placeholder = UIViewController()
                placeholder.view.backgroundColor = .clear
                return placeholder
            }
        }

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            // Kotvíme přímo na tab bar. Safe area tu nepomůže — SwiftUI hosting
            // její insety vynuluje, takže by se web roztáhl i přes lištu, a
            // z-order taky ne: Liquid Glass tab bar není přímý subview `view`.
            webView.bottomAnchor.constraint(equalTo: tabBar.topAnchor)
        ])
    }

    func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        guard let shellTab = ShellTab(rawValue: tab.identifier) else { return true }

        onSelect(shellTab)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        // `capture` a `more` jsou akce, ne sekce — otevřou modál zápisu, resp.
        // nabídku, a výběr nechají být, aby tab bar neuvázl na prázdném tabu.
        return shellTab != .capture && shellTab != .more
    }
}

private struct ShellSurface: UIViewControllerRepresentable {
    let engine: WebShellEngine

    func makeUIViewController(context: Context) -> ShellTabBarController {
        ShellTabBarController(webView: engine.webView) { engine.select($0) }
    }

    func updateUIViewController(_ controller: ShellTabBarController, context: Context) {
        // SwiftUI `preferredColorScheme` na hostovaný UIKit controller nedosáhne,
        // takže tab baru předáváme styl napřímo.
        controller.overrideUserInterfaceStyle =
            switch engine.colorScheme {
            case .light: .light
            case .dark: .dark
            default: .unspecified
            }
    }
}

/// Nabídka sekcí, které se nevešly do tab baru, plus nativní testovací konzole.
private struct MoreMenuView: View {
    @Environment(\.dismiss) private var dismiss
    let onOpen: (ShellDestination) -> Void
    let onOpenNativeLab: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section("Sekce") {
                    ForEach(ShellDestination.allCases.filter { $0 != .settings }) { destination in
                        row(destination.title, destination.symbol) {
                            onOpen(destination)
                            dismiss()
                        }
                    }
                }

                Section("Nastavení") {
                    row(ShellDestination.settings.title, ShellDestination.settings.symbol) {
                        onOpen(.settings)
                        dismiss()
                    }
                    row("iOS Lab", "hammer") {
                        onOpenNativeLab()
                        dismiss()
                    }
                }
            }
            .navigationTitle("Více")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Hotovo") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .foregroundStyle(.primary)
        }
    }
}

struct WebShellView: View {
    @State private var engine: WebShellEngine

    init(url: URL = WebShellEngine.productionURL) {
        _engine = State(initialValue: WebShellEngine(url: url))
    }

    var body: some View {
        @Bindable var engine = engine

        // Bez `ignoresSafeArea`: SwiftUI by rám controlleru roztáhl přes celou
        // obrazovku a Liquid Glass tab bar by spadl pod její spodní hranu.
        ShellSurface(engine: engine)
            .overlay {
                if let error = engine.loadError {
                    failure(error)
                } else if engine.isLoading {
                    ProgressView().controlSize(.large)
                }
            }
            .sheet(isPresented: $engine.showsMoreMenu) {
                MoreMenuView(
                    onOpen: { engine.open($0) },
                    onOpenNativeLab: { engine.showsNativeLab = true }
                )
            }
            .sheet(isPresented: $engine.showsNativeLab) {
                NavigationStack {
                    NativeCapabilityLabView()
                        .navigationTitle("iOS Lab")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Hotovo") { engine.showsNativeLab = false }
                            }
                        }
                }
            }
            // Téma hlásí web přes most, takže tab bar nesvítí proti obsahu.
            .preferredColorScheme(engine.colorScheme)
    }

    private func failure(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Nelze načíst AlphaTrade", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("Zkusit znovu") { engine.retry() }.buttonStyle(.borderedProminent)
        }
        .background(.background)
    }
}
