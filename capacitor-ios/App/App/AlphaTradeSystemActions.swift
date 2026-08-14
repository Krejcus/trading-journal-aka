import AppIntents
import CoreSpotlight
import UniformTypeIdentifiers
import UIKit

/// One handoff queue for every iOS system surface. The route is persisted so a
/// Siri/Shortcuts or Spotlight invocation survives a cold launch before the
/// Capacitor bridge and React router are ready.
final class AlphaTradeSystemRouter {
    static let shared = AlphaTradeSystemRouter()
    static let routeNotification = Notification.Name("AlphaTradeSystemRouteRequested")

    private let pendingRouteKey = "AlphaTradePendingSystemRoute"
    private let supportedRoutes: Set<String> = [
        "dashboard", "history", "capture", "journal", "ai", "live",
        "business", "network", "accounts", "settings", "lab",
    ]

    private init() {}

    func request(_ route: String) {
        guard supportedRoutes.contains(route) else { return }
        UserDefaults.standard.set(route, forKey: pendingRouteKey)
        NotificationCenter.default.post(name: Self.routeNotification, object: nil)
    }

    /// Accepts only AlphaTrade destination links. OAuth callbacks deliberately
    /// fall through to Capacitor because `auth` is not a product route.
    @discardableResult
    func request(url: URL) -> Bool {
        guard url.scheme == "alphatrade-native",
              let route = url.host,
              supportedRoutes.contains(route) else { return false }
#if DEBUG
        NSLog("[AlphaTradeSystemRouter] Accepted deep link route: %@", route)
#endif
        request(route)
        return true
    }

    func pendingRoute() -> String? {
        guard let route = UserDefaults.standard.string(forKey: pendingRouteKey),
              supportedRoutes.contains(route) else {
            UserDefaults.standard.removeObject(forKey: pendingRouteKey)
            return nil
        }
        return route
    }

    func acknowledge(_ route: String) {
        guard UserDefaults.standard.string(forKey: pendingRouteKey) == route else { return }
        UserDefaults.standard.removeObject(forKey: pendingRouteKey)
    }
}

enum AlphaTradeQuickAction {
    private static let prefix = "app.alphatrade.native.quick."

    static func route(from shortcutItem: UIApplicationShortcutItem) -> String? {
        switch shortcutItem.type {
        case "\(prefix)live": return "live"
        case "\(prefix)capture": return "capture"
        case "\(prefix)coach": return "ai"
        default: return nil
        }
    }

    @discardableResult
    static func handle(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
        guard let route = route(from: shortcutItem) else { return false }
        AlphaTradeSystemRouter.shared.request(route)
        return true
    }
}

@available(iOS 16.0, *)
struct OpenAlphaTradeLiveIntent: AppIntent {
    static let title: LocalizedStringResource = "Otevřít AlphaTrade LIVE"
    static let description = IntentDescription("Otevře živý obchodní přehled v AlphaTrade.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult & ProvidesDialog {
        await MainActor.run { AlphaTradeSystemRouter.shared.request("live") }
        return .result(dialog: "Otevírám AlphaTrade LIVE.")
    }
}

@available(iOS 16.0, *)
struct CaptureAlphaTradeTradeIntent: AppIntent {
    static let title: LocalizedStringResource = "Zapsat obchod v AlphaTrade"
    static let description = IntentDescription("Otevře rychlý zápis nového obchodu.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult & ProvidesDialog {
        await MainActor.run { AlphaTradeSystemRouter.shared.request("capture") }
        return .result(dialog: "Otevírám zápis obchodu.")
    }
}

@available(iOS 16.0, *)
struct OpenAlphaTradeCoachIntent: AppIntent {
    static let title: LocalizedStringResource = "Otevřít AlphaTrade Coach"
    static let description = IntentDescription("Otevře AI Coach v AlphaTrade.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult & ProvidesDialog {
        await MainActor.run { AlphaTradeSystemRouter.shared.request("ai") }
        return .result(dialog: "Otevírám AlphaTrade Coach.")
    }
}

@available(iOS 16.0, *)
struct AlphaTradeAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenAlphaTradeLiveIntent(),
            phrases: [
                "Otevři LIVE v \(.applicationName)",
                "Ukaž LIVE v \(.applicationName)",
            ],
            shortTitle: "AlphaTrade LIVE",
            systemImageName: "waveform.path.ecg"
        )
        AppShortcut(
            intent: CaptureAlphaTradeTradeIntent(),
            phrases: [
                "Zapiš obchod v \(.applicationName)",
                "Přidej obchod do \(.applicationName)",
            ],
            shortTitle: "Zapsat obchod",
            systemImageName: "plus.circle.fill"
        )
        AppShortcut(
            intent: OpenAlphaTradeCoachIntent(),
            phrases: [
                "Otevři Coach v \(.applicationName)",
                "Spusť Coach v \(.applicationName)",
            ],
            shortTitle: "AlphaTrade Coach",
            systemImageName: "sparkles"
        )
    }
}

enum AlphaTradeSpotlight {
    private static let domain = "app.alphatrade.native.destinations"

    static func indexDestinations() {
        let definitions: [(id: String, title: String, description: String, keywords: [String])] = [
            ("live", "AlphaTrade LIVE", "Živý obchodní přehled a řízení relace", ["trading", "live", "NQ", "MNQ"]),
            ("capture", "Zapsat obchod", "Rychle přidat nový obchod do deníku", ["obchod", "trade", "zapsat"]),
            ("journal", "Obchodní deník", "Denní příprava, review a obchodní poznámky", ["deník", "journal", "review"]),
            ("ai", "AlphaTrade Coach", "Otevřít AI Coach pro analýzu obchodování", ["coach", "kouč", "AI"]),
            ("dashboard", "AlphaTrade Dashboard", "Výsledky, equity a denní P&L", ["dashboard", "equity", "P&L"]),
        ]

        let items = definitions.map { definition -> CSSearchableItem in
            let attributes = CSSearchableItemAttributeSet(contentType: .item)
            attributes.title = definition.title
            attributes.displayName = definition.title
            attributes.contentDescription = definition.description
            attributes.keywords = definition.keywords
            let item = CSSearchableItem(
                uniqueIdentifier: definition.id,
                domainIdentifier: domain,
                attributeSet: attributes
            )
            item.expirationDate = .distantFuture
            return item
        }

        CSSearchableIndex.default().indexSearchableItems(items) { error in
            if let error { NSLog("[AlphaTradeSpotlight] Indexing failed: %@", error.localizedDescription) }
        }
    }

    static func route(from activity: NSUserActivity) -> String? {
        guard activity.activityType == CSSearchableItemActionType,
              let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return nil }
        return identifier
    }
}
