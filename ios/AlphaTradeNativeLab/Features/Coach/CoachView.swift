import SwiftUI

struct CoachView: View {
    @Environment(NativeLabStore.self) private var store
    @State private var scope = "LIVE"
    @State private var query = ""
    @State private var activeConversation = false
    @State private var draft = ""
    @State private var speech = SpeechCaptureService()
    @State private var localSummary: String?
    @State private var isSummarizing = false

    var body: some View {
        VStack(spacing: 0) {
            workspaceHeader
            if activeConversation { conversation }
            else { conversationLibrary }
        }
        .tradeScreen()
        .onChange(of: speech.transcript) { _, value in if !value.isEmpty { draft = value } }
    }

    private var workspaceHeader: some View {
        VStack(spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) { Text("AI COACH").font(.headline.bold()); Text(scope == "BT" ? "Backtest kontext" : "Live trading kontext").font(.caption).foregroundStyle(TradeTheme.secondary) }
                Spacer()
                Picker("Coach režim", selection: $scope) { Text("LIVE").tag("LIVE"); Text("BT").tag("BT") }.pickerStyle(.segmented).frame(width: 122)
            }
            if activeConversation {
                HStack { Button { activeConversation = false } label: { Label("Konverzace", systemImage: "chevron.left") }; Spacer(); Button { beginNewConversation() } label: { Label("Nová", systemImage: "square.and.pencil") } }.font(.caption.bold())
            }
        }.padding(.horizontal, 16).padding(.vertical, 10).background(TradeTheme.card).overlay(alignment: .bottom) { Divider() }
    }

    private var conversationLibrary: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                Button { beginNewConversation() } label: { Label("Nová konverzace", systemImage: "plus").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 11) }.buttonStyle(.borderedProminent).tint(TradeTheme.primary)
                TradeCard(padding: 11) { HStack { Image(systemName: "magnifyingglass").foregroundStyle(TradeTheme.muted); TextField("Hledat konverzaci…", text: $query) } }
                contextOverview
                if matchesCurrentConversation { conversationRow }
                if scope == "BT" && !matchesCurrentConversation {
                    ContentUnavailableView("Žádné backtest konverzace", systemImage: "bubble.left.and.bubble.right", description: Text("Začni novou a Coach načte aktuální replay kontext."))
                    Button("Začít novou") { beginNewConversation() }.buttonStyle(.bordered)
                }
            }.padding(16)
        }
    }

    private var contextOverview: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 11) {
                HStack { Label("Načtený kontext", systemImage: "checkmark.circle.fill").font(.subheadline.bold()).foregroundStyle(TradeTheme.success); Spacer(); Text(store.remoteConnection.title.uppercased()).font(.caption2.bold()).foregroundStyle(TradeTheme.muted) }
                HStack { contextMetric("OBCHODY", "\(store.trades.count)"); contextMetric("ÚČTY", "\(store.accounts.count)"); contextMetric("SESSIONS", "\(store.journalSessions.count)"); contextMetric("PAMĚŤ", "\(store.savedCoachConclusionCount)") }
                if let focus = store.weeklyFocus.first { Label("\(focus.emoji) \(focus.text)", systemImage: "target").font(.caption).foregroundStyle(TradeTheme.secondary).lineLimit(2) }
            }
        }
    }

    private func contextMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) { Text(title).font(.system(size: 8, weight: .bold)).foregroundStyle(TradeTheme.muted); Text(value).font(.headline.monospacedDigit()) }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var matchesCurrentConversation: Bool {
        scope == "LIVE" && (query.isEmpty || "Dnešní trading plán".localizedCaseInsensitiveContains(query))
    }

    private var conversationRow: some View {
        Button { activeConversation = true } label: {
            TradeCard(padding: 13) {
                HStack(spacing: 11) {
                    RoundedRectangle(cornerRadius: 7).fill(TradeTheme.indigo.opacity(0.12)).frame(width: 40, height: 40).overlay { Image(systemName: "brain.head.profile").foregroundStyle(TradeTheme.indigo) }
                    VStack(alignment: .leading, spacing: 4) { Text("Dnešní trading plán").font(.subheadline.bold()); Text(store.coachMessages.last?.text ?? "Konverzace je připravena").font(.caption).foregroundStyle(TradeTheme.secondary).lineLimit(2); Text("LIVE · \(store.coachMessages.count) zpráv").font(.caption2.bold()).foregroundStyle(TradeTheme.muted) }
                    Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(TradeTheme.muted)
                }
            }
        }.buttonStyle(.plain)
    }

    private var conversation: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 11) {
                        localAI
                        ForEach(store.coachMessages) { message in messageBubble(message).id(message.id) }
                    }.padding(16)
                }
                .onChange(of: store.coachMessages.count) { _, _ in if let id = store.coachMessages.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } } }
            }
            composer
        }
    }

    private var localAI: some View {
        TradeCard(padding: 12) {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Label("Shrnutí na zařízení", systemImage: "apple.intelligence").font(.subheadline.bold()); Spacer(); StatusPill(text: "ON DEVICE", color: TradeTheme.indigo) }
                Text(localSummary ?? "Soukromé shrnutí deníku bez tradingových signálů.").font(.caption).foregroundStyle(TradeTheme.secondary)
                Button { isSummarizing = true; Task { localSummary = await OnDeviceCoachService.summarize(trades: store.trades); isSummarizing = false } } label: { Label(isSummarizing ? "Shrnuji…" : "Vytvořit shrnutí", systemImage: "sparkles") }.buttonStyle(.bordered).disabled(isSummarizing).accessibilityIdentifier("coach.localSummary")
            }
        }
    }

    private func messageBubble(_ message: CoachMessage) -> some View {
        HStack { if message.role == .trader { Spacer(minLength: 38) }; VStack(alignment: .leading, spacing: 6) { Text(message.role == .coach ? "COACH" : "TY").font(.caption2.bold()).foregroundStyle(message.role == .coach ? TradeTheme.indigo : TradeTheme.blue); Text(message.text).font(.subheadline).lineSpacing(3); if message.role == .coach && message.id == store.coachMessages.last(where: { $0.role == .coach })?.id { Button { store.toggleLatestCoachConclusion() } label: { Label(store.savedCoachConclusionIDs.contains(message.id) ? "Uloženo" : "Uložit závěr", systemImage: store.savedCoachConclusionIDs.contains(message.id) ? "bookmark.fill" : "bookmark") }.font(.caption2).accessibilityIdentifier("coach.memory") } }.padding(12).background(message.role == .coach ? TradeTheme.card : TradeTheme.blue.opacity(0.11), in: RoundedRectangle(cornerRadius: 8)).overlay { RoundedRectangle(cornerRadius: 8).stroke(message.role == .coach ? TradeTheme.border : TradeTheme.blue.opacity(0.22)) }; if message.role == .coach { Spacer(minLength: 22) } }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 9) { Button { Task { await speech.toggle() } } label: { Image(systemName: speech.isRecording ? "stop.fill" : "waveform") }.buttonStyle(.bordered).tint(speech.isRecording ? TradeTheme.danger : TradeTheme.blue).accessibilityIdentifier("coach.dictation"); TextField("Napiš Coachovi…", text: $draft, axis: .vertical).lineLimit(1...4).padding(10).background(TradeTheme.raised, in: RoundedRectangle(cornerRadius: 8)).accessibilityIdentifier("coach.input"); Button { let message = draft; draft = ""; store.sendCoachMessage(message) } label: { Image(systemName: "arrow.up").frame(width: 28, height: 28) }.buttonStyle(.borderedProminent).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty).accessibilityIdentifier("coach.send") }.padding(11).background(TradeTheme.card).overlay(alignment: .top) { Divider() }
    }

    private func beginNewConversation() {
        activeConversation = true
        draft = ""
    }
}
