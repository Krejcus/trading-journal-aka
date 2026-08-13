import SwiftUI

struct JournalView: View {
    @Environment(NativeLabStore.self) private var store

    private var sessions: [JournalSession] {
        if !store.journalSessions.isEmpty { return store.journalSessions }
        return Dictionary(grouping: store.trades) { Calendar.current.startOfDay(for: $0.timestamp) }.map { day, trades in
            JournalSession(id: day.ISO8601Format(), date: day, session: "New York", bias: "Neutral", playbook: trades.first?.setup ?? "NQ s pravidly", preNote: trades.first?.note.isEmpty == false ? trades.first!.note : "bez poznámky", postNote: "bez poznámky", screenshotCount: 0)
        }.sorted { $0.date > $1.date }
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                TradeCard {
                    HStack { VStack(alignment: .leading, spacing: 3) { Text("BACKTEST DENÍK").font(.headline.bold()); Text("\(sessions.count) sessions · pre/post poznámky").font(.caption).foregroundStyle(TradeTheme.secondary) }; Spacer(); Button { } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.bordered) }
                }
                ForEach(sessions) { session in SessionJournalCard(session: session, trades: store.trades.filter { Calendar.current.isDate($0.timestamp, inSameDayAs: session.date) }) }
            }.padding(.horizontal, 16).padding(.bottom, 18)
        }.tradeScreen()
    }
}

private struct SessionJournalCard: View {
    let session: JournalSession
    let trades: [TradeRecord]
    private var pnl: Double { trades.reduce(0) { $0 + $1.result } }
    private var wins: Int { trades.filter { $0.result > 0 }.count }
    var body: some View {
        TradeCard(padding: 13) {
            VStack(alignment: .leading, spacing: 11) {
                HStack { Text(session.date.formatted(.dateTime.year().month().day())).font(.subheadline.bold().monospacedDigit()); StatusPill(text: session.session.uppercased(), color: TradeTheme.blue); Spacer(); StatusPill(text: session.bias.uppercased(), color: biasColor) }
                HStack { Label(session.playbook, systemImage: "scope").font(.caption.bold()); Spacer(); if !trades.isEmpty { Text(pnl.usd).font(.subheadline.bold().monospacedDigit()).foregroundStyle(pnl >= 0 ? TradeTheme.success : TradeTheme.danger) } }
                if !trades.isEmpty { Text("\(trades.count) obchody · \(wins)W / \(trades.count - wins)L").font(.caption2).foregroundStyle(TradeTheme.muted) }
                note("PRE — NA CO KOUKÁM", session.preNote)
                note("POST — ČEHO JSEM SI VŠIML / CO DOLADIT", session.postNote)
                if session.screenshotCount > 0 { ScrollView(.horizontal, showsIndicators: false) { HStack { ForEach(1...session.screenshotCount, id: \.self) { index in RoundedRectangle(cornerRadius: 6).fill(TradeTheme.raised).frame(width: 100, height: 62).overlay { VStack { Image(systemName: "photo"); Text("screenshot \(index)").font(.caption2) }.foregroundStyle(TradeTheme.secondary) } } } } }
            }
        }
    }
    private var biasColor: Color { session.bias.lowercased().contains("long") || session.bias.lowercased().contains("bull") ? TradeTheme.success : session.bias.lowercased().contains("short") || session.bias.lowercased().contains("bear") ? TradeTheme.danger : TradeTheme.warning }
    private func note(_ title: String, _ text: String) -> some View { VStack(alignment: .leading, spacing: 4) { Text(title).font(.caption2.bold()).foregroundStyle(TradeTheme.muted); Text(text).font(.subheadline).foregroundStyle(text == "bez poznámky" ? TradeTheme.muted : TradeTheme.primary).frame(maxWidth: .infinity, alignment: .leading) }.padding(9).background(TradeTheme.raised, in: RoundedRectangle(cornerRadius: 6)) }
}
