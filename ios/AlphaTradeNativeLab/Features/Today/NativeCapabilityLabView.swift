import SwiftUI
import UIKit

struct NativeCapabilityLabView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(NativeLabStore.self) private var store
    @State private var notifications = NativeNotificationService()
    @State private var speech = SpeechCaptureService()
    @State private var showCapture = false
    @State private var liveActivityRunning = false
    @State private var hapticMessage: String?
    @State private var showNotificationScenarios = false

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                intro
                notificationLab
                widgetLab
                directTests
                speechLab
                hapticLab
                capabilityMatrix
                safety
            }
            .padding(16)
        }
        .tradeScreen()
        .task {
            await notifications.refresh()
            liveActivityRunning = TradingSessionActivity.isRunning
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await notifications.refresh()
                    liveActivityRunning = TradingSessionActivity.isRunning
                }
            }
        }
        .onDisappear { speech.stop() }
        .sheet(isPresented: $showCapture) { QuickCaptureView() }
        .preferredColorScheme(.light)
    }

    private var intro: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Label("Native Capability Lab", systemImage: "iphone.gen3")
                        .font(.headline)
                    Spacer()
                    StatusPill(text: "LOCAL", color: TradeTheme.success)
                }

                Text("Tady vyzkoušíš systémové funkce iPhonu, ne další kopii webové stránky.")
                    .font(.subheadline).foregroundStyle(TradeTheme.secondary)
            }
        }
    }

    private var directTests: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "Přímé testy", detail: "SPUSTIT TEĎ")

                nativeAction(
                    title: liveActivityRunning ? "Ukončit Live Activity" : "Spustit Live Activity",
                    detail: "Ověř časovač na zamčené obrazovce a Dynamic Island",
                    symbol: "platter.filled.bottom.iphone",
                    identifier: "native.test.activity"
                ) {
                    Task { liveActivityRunning = await TradingSessionActivity.toggle() }
                }

                Divider().overlay(TradeTheme.border)
                nativeAction(
                    title: "Otevřít fotoaparát a OCR",
                    detail: "Vyfoť nebo vyber screenshot; Vision ho zpracuje lokálně",
                    symbol: "text.viewfinder",
                    identifier: "native.test.ocr"
                ) { showCapture = true }

                Divider().overlay(TradeTheme.border)
                nativeAction(
                    title: "Vyzkoušet Privacy Mode",
                    detail: "Okamžitě skryje všechny finanční údaje a vyžádá odemknutí",
                    symbol: "faceid",
                    identifier: "native.test.privacy"
                ) {
                    Task { await Task.yield(); store.privacyMode = true }
                }

                Divider().overlay(TradeTheme.border)
                nativeAction(
                    title: "Přejít do Coach paměti",
                    detail: "Otevře diktování, lokální AI shrnutí a šifrované závěry",
                    symbol: "brain.head.profile",
                    identifier: "native.test.coach"
                ) {
                    store.handle(route: .coach)
                }
            }
        }
    }

    private var speechLab: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("České diktování", systemImage: "waveform")
                        .font(.headline)
                    Spacer()
                    StatusPill(
                        text: speech.isRecording ? "POSLOUCHÁM" : "PŘIPRAVENO",
                        color: speech.isRecording ? TradeTheme.danger : TradeTheme.success
                    )
                }
                Text("Rozpoznávání cs-CZ může běžet přímo na podporovaném zařízení. Zvuk se v prototypu neukládá.")
                    .font(.caption).foregroundStyle(TradeTheme.secondary)

                Button {
                    Task { await speech.toggle() }
                } label: {
                    Label(
                        speech.isRecording ? "Zastavit diktování" : "Spustit diktování",
                        systemImage: speech.isRecording ? "stop.fill" : "mic.fill"
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(speech.isRecording ? TradeTheme.danger : TradeTheme.blue)
                .accessibilityIdentifier("native.test.speech")

                if !speech.transcript.isEmpty {
                    Text(speech.transcript)
                        .font(.subheadline)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(TradeTheme.raised, in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityIdentifier("native.speech.transcript")
                }
                if let error = speech.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(TradeTheme.warning)
                }
            }
        }
    }

    private var hapticLab: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Label("Haptická odezva", systemImage: "hand.tap.fill").font(.headline)
                    Spacer()
                    StatusPill(text: "IPHONE", color: TradeTheme.indigo)
                }
                Text("Porovnej jemný výběr, potvrzení, varování a chybu. V simulátoru vibraci necítíš.")
                    .font(.caption).foregroundStyle(TradeTheme.secondary)
                HStack(spacing: 8) {
                    hapticButton("Výběr", symbol: "hand.point.up.left", id: "selection") {
                        UISelectionFeedbackGenerator().selectionChanged()
                    }
                    hapticButton("Úspěch", symbol: "checkmark", id: "success") {
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    }
                    hapticButton("Varování", symbol: "exclamationmark", id: "warning") {
                        UINotificationFeedbackGenerator().notificationOccurred(.warning)
                    }
                    hapticButton("Chyba", symbol: "xmark", id: "error") {
                        UINotificationFeedbackGenerator().notificationOccurred(.error)
                    }
                }
                if let hapticMessage {
                    Text(hapticMessage).font(.caption).foregroundStyle(TradeTheme.secondary)
                }
            }
        }
    }

    private var notificationLab: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 13) {
                HStack {
                    Label("Notifikace a akce", systemImage: "bell.badge.fill")
                        .font(.headline)
                    Spacer()
                    StatusPill(
                        text: notifications.permission.title.uppercased(),
                        color: notifications.permission.isEnabled ? TradeTheme.success : TradeTheme.warning
                    )
                }

                Text("Dvanáct lokálních scénářů ověří banner, zvuk, badge, seskupení, time-sensitive doručení, textovou odpověď i obrázkové přílohy.")
                    .font(.caption).foregroundStyle(TradeTheme.secondary)

                if !notifications.permission.isEnabled {
                    Button {
                        Task { await notifications.requestPermission() }
                    } label: {
                        Label("Povolit nativní notifikace", systemImage: "checkmark.shield")
                    }
                    .buttonStyle(.borderedProminent).tint(TradeTheme.blue)
                    .accessibilityIdentifier("notifications.permission")
                }

                Button {
                    Task { await notifications.scheduleFullGallery() }
                } label: {
                    Label(
                        notifications.isSchedulingGallery ? "Připravuji galerii…" : "Naplánovat všech 12 testů",
                        systemImage: "bell.badge.waveform.fill"
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(TradeTheme.indigo)
                .disabled(!notifications.permission.isEnabled || notifications.isSchedulingGallery)
                .accessibilityIdentifier("notifications.schedule.gallery")

                Button {
                    withAnimation(.snappy) { showNotificationScenarios.toggle() }
                } label: {
                    HStack {
                        Text("Jednotlivé scénáře (\(NativeNotificationService.Demo.allCases.count))")
                            .font(.subheadline.bold())
                        Spacer()
                        Image(systemName: showNotificationScenarios ? "chevron.up" : "chevron.down")
                            .font(.caption).foregroundStyle(TradeTheme.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("notifications.gallery.expand")

                if showNotificationScenarios {
                    VStack(spacing: 0) {
                        ForEach(NativeNotificationService.Demo.allCases) { demo in
                            Button {
                                Task { await notifications.schedule(demo) }
                            } label: {
                                HStack(spacing: 11) {
                                    Image(systemName: demo.symbol)
                                        .frame(width: 26).foregroundStyle(TradeTheme.blue)
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack {
                                            Text(demo.title).font(.subheadline.bold())
                                            if demo.hasRichAttachment {
                                                Image(systemName: "paperclip").font(.caption2).foregroundStyle(TradeTheme.success)
                                            }
                                        }
                                        Text(demo.detail).font(.caption).foregroundStyle(TradeTheme.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "plus.circle.fill").font(.caption).foregroundStyle(TradeTheme.muted)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(!notifications.permission.isEnabled)
                            .accessibilityIdentifier("notifications.schedule.\(demo.rawValue)")
                            if demo != NativeNotificationService.Demo.allCases.last {
                                Divider().overlay(TradeTheme.border).padding(.vertical, 9)
                            }
                        }
                    }
                    .padding(.top, 10)
                }

                HStack {
                    Label("Naplánováno: \(notifications.pendingCount)", systemImage: "clock.badge")
                        .font(.caption).foregroundStyle(TradeTheme.secondary)
                    Spacer()
                    if notifications.pendingCount > 0 {
                        Button("Zrušit vše") { Task { await notifications.cancelAll() } }
                            .font(.caption.bold()).foregroundStyle(TradeTheme.danger)
                    }
                }

                if !notifications.pending.isEmpty {
                    VStack(spacing: 8) {
                        ForEach(notifications.pending) { request in
                            pendingNotification(request)
                        }
                    }
                }

                if let message = notifications.lastMessage {
                    Label(message, systemImage: "info.circle")
                        .font(.caption).foregroundStyle(TradeTheme.secondary)
                }

                if notifications.permission == .denied {
                    Button("Otevřít nastavení iOS") { notifications.openSystemSettings() }
                        .buttonStyle(.bordered).accessibilityIdentifier("notifications.settings")
                }
            }
        }
    }

    private var widgetLab: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Widget Gallery", systemImage: "widget.large").font(.headline)
                    Spacer()
                    StatusPill(text: "7 WIDGETŮ", color: TradeTheme.indigo)
                }
                Text("Dnešní plán, Daily P&L, Equity Curve, účty, disciplína, poslední obchody a rychlé akce sdílejí pouze omezený lokální snapshot.")
                    .font(.caption).foregroundStyle(TradeTheme.secondary)

                Picker(
                    "Soukromí widgetů",
                    selection: Binding(
                        get: { store.widgetPrivacyMode },
                        set: { store.setWidgetPrivacyMode($0) }
                    )
                ) {
                    ForEach(WidgetPrivacyMode.allCases) { mode in Text(mode.title).tag(mode) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("widgets.privacy")

                Button {
                    store.publishWidgetSnapshot()
                } label: {
                    Label("Aktualizovat všechny widgety", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .tint(TradeTheme.blue)
                .accessibilityIdentifier("widgets.refresh")

                Label(
                    "Po instalaci spusť aplikaci alespoň jednou a widgety přidej dlouhým podržením plochy.",
                    systemImage: "info.circle"
                )
                .font(.caption2).foregroundStyle(TradeTheme.secondary)
                Label(
                    "Personal Team podpis neumí App Group. Widgety proto ověří vzhled, velikosti a deeplinky, ale používají testovací data; živá synchronizace vyžaduje placený Apple Developer účet.",
                    systemImage: "person.crop.circle.badge.exclamationmark"
                )
                .font(.caption2).foregroundStyle(TradeTheme.warning)
            }
        }
    }

    private var capabilityMatrix: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "Co otestujeme na iPhonu", detail: "NATIVE")
                capability("Live Activity + Dynamic Island", "Živý čas session mimo otevřenou aplikaci", "platter.filled.bottom.iphone")
                capability("Face ID Privacy Mode", "Finanční data zmizí při odchodu do pozadí", "faceid")
                capability("Fotoaparát + Vision OCR", "Screenshot se rozpozná lokálně na zařízení", "text.viewfinder")
                capability("České diktování", "Hlasová poznámka přímo v Coach composeru", "waveform")
                capability("Widget na ploše", "Dnešní plán bez otevírání aplikace", "widget.small")
                capability("Siri, Shortcuts a Spotlight", "Otevření konkrétní akce nebo záznamu", "sparkles")
                capability("Haptika a badge", "Fyzická odezva při uložení a stav na ikoně", "hand.tap")
            }
        }
    }

    private var safety: some View {
        TradeCard(padding: 12) {
            Label(
                "Všechny testovací notifikace jsou lokální. Nepoužívají server, produkční data ani brokerové připojení.",
                systemImage: "lock.shield.fill"
            )
            .font(.caption).foregroundStyle(TradeTheme.success)
        }
    }

    private func capability(_ title: String, _ detail: String, _ symbol: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: symbol).foregroundStyle(TradeTheme.indigo).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.bold())
                Text(detail).font(.caption).foregroundStyle(TradeTheme.secondary)
            }
            Spacer()
            Image(systemName: "checkmark.circle.fill").foregroundStyle(TradeTheme.success)
        }
    }

    private func pendingNotification(_ request: NativeNotificationService.Pending) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "clock.fill").foregroundStyle(TradeTheme.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text(request.title).font(.caption.bold())
                Text("\(request.route.title) · \(request.scheduledAt?.formatted(date: .omitted, time: .shortened) ?? "čeká")\(request.hasAttachment ? " · obrázek" : "")")
                    .font(.caption2).foregroundStyle(TradeTheme.secondary)
            }
            Spacer()
            Button {
                Task { await notifications.cancel(request) }
            } label: {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(TradeTheme.danger)
            .accessibilityLabel("Zrušit \(request.title)")
            .accessibilityIdentifier("notifications.cancel.\(request.id)")
        }
        .padding(9)
        .background(TradeTheme.raised, in: RoundedRectangle(cornerRadius: 8))
    }

    private func nativeAction(
        title: String,
        detail: String,
        symbol: String,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Image(systemName: symbol).foregroundStyle(TradeTheme.indigo).frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.bold())
                    Text(detail).font(.caption).foregroundStyle(TradeTheme.secondary)
                }
                Spacer()
                Image(systemName: "play.circle.fill").foregroundStyle(TradeTheme.blue)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }

    private func hapticButton(
        _ title: String,
        symbol: String,
        id: String,
        play: @escaping () -> Void
    ) -> some View {
        Button {
            play()
            hapticMessage = "Přehráno: \(title.lowercased())."
        } label: {
            VStack(spacing: 5) {
                Image(systemName: symbol)
                Text(title).font(.caption2.bold())
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("native.haptic.\(id)")
    }

}
