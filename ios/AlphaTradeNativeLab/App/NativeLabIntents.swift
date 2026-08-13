import AppIntents

struct QuickCaptureIntent: AppIntent {
    static let title: LocalizedStringResource = "Zapsat obchod"
    static let description = IntentDescription("Otevře bezpečný rychlý zápis v AlphaTrade.")
    static var supportedModes: IntentModes { .foreground(.immediate) }

    func perform() async throws -> some IntentResult {
        NativeLabRoute.capture.queue()
        return .result(dialog: "Otevírám bezpečný rychlý zápis.")
    }
}

struct OpenTodayPlanIntent: AppIntent {
    static let title: LocalizedStringResource = "Otevřít dnešní přípravu"
    static let description = IntentDescription("Otevře dnešní plán bez provedení obchodní akce.")
    static var supportedModes: IntentModes { .foreground(.immediate) }

    func perform() async throws -> some IntentResult {
        NativeLabRoute.today.queue()
        return .result(dialog: "Otevírám dnešní přípravu.")
    }
}

struct ContinueReplayIntent: AppIntent {
    static let title: LocalizedStringResource = "Pokračovat v replayi"
    static let description = IntentDescription("Otevře lokální simulovaný replay se skrytou budoucností.")
    static var supportedModes: IntentModes { .foreground(.immediate) }

    func perform() async throws -> some IntentResult {
        NativeLabRoute.replay.queue()
        return .result(dialog: "Otevírám lokální replay bez odhalení budoucích svíček.")
    }
}

struct NativeLabShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: QuickCaptureIntent(), phrases: ["Zapsat obchod v \(.applicationName)"], shortTitle: "Zapsat obchod", systemImageName: "square.and.pencil")
        AppShortcut(intent: OpenTodayPlanIntent(), phrases: ["Otevřít přípravu v \(.applicationName)"], shortTitle: "Dnešní příprava", systemImageName: "checklist")
        AppShortcut(intent: ContinueReplayIntent(), phrases: ["Pokračovat v replayi v \(.applicationName)"], shortTitle: "Pokračovat v replayi", systemImageName: "chart.xyaxis.line")
    }
}
