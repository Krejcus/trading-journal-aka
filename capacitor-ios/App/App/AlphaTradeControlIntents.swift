import AppIntents
import WidgetKit

@available(iOS 17.0, *)
struct RefreshAlphaTradeWidgetsIntent: AppIntent {
    static let title: LocalizedStringResource = "Obnovit AlphaTrade widgety"
    static let description = IntentDescription("Načte nejnovější read-only stav bez otevření aplikace.")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

/// Shared with the widget extension so WidgetKit can discover the controls.
/// When `openAppWhenRun` is true, iOS executes the app-target copy in the main
/// process; only that copy writes into the existing cold-safe system router.
@available(iOS 18.0, *)
struct OpenAlphaTradeLiveControlIntent: AppIntent {
    static let title: LocalizedStringResource = "Otevřít AlphaTrade LIVE"
    static let description = IntentDescription("Otevře živý přehled v AlphaTrade.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
#if ALPHATRADE_APP
        await MainActor.run { AlphaTradeSystemRouter.shared.request("live") }
#endif
        return .result()
    }
}

@available(iOS 18.0, *)
struct OpenAlphaTradeCaptureControlIntent: AppIntent {
    static let title: LocalizedStringResource = "Zapsat obchod v AlphaTrade"
    static let description = IntentDescription("Otevře formulář nového obchodu bez automatického uložení.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
#if ALPHATRADE_APP
        await MainActor.run { AlphaTradeSystemRouter.shared.request("capture") }
#endif
        return .result()
    }
}
