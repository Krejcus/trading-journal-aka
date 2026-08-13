import SwiftUI

struct HistoryView: View {
    @Environment(NativeLabStore.self) private var store
    @State private var query = ""
    @State private var resultFilter = "Vše"
    @State private var expandedDay: Date?

    private var groups: [(Date, [TradeRecord])] {
        let filtered = store.trades.filter { trade in
            let queryMatch = query.isEmpty || trade.symbol.localizedCaseInsensitiveContains(query) || trade.setup.localizedCaseInsensitiveContains(query)
            let resultMatch = resultFilter == "Vše" || (resultFilter == "Zisk" ? trade.result >= 0 : trade.result < 0)
            return queryMatch && resultMatch
        }
        return Dictionary(grouping: filtered) { Calendar.current.startOfDay(for: $0.timestamp) }
            .map { ($0.key, $0.value.sorted { $0.timestamp > $1.timestamp }) }
            .sorted { $0.0 > $1.0 }
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                controls
                ForEach(groups, id: \.0) { day, trades in dayGroup(day, trades: trades) }
                if groups.isEmpty { ContentUnavailableView("Žádné obchody", systemImage: "line.3.horizontal.decrease.circle", description: Text("Změň filtr nebo hledaný výraz.")) }
            }.padding(.horizontal, 16).padding(.bottom, 18)
        }.tradeScreen()
    }

    private var controls: some View {
        VStack(spacing: 8) {
            TradeCard(padding: 11) { HStack { Image(systemName: "magnifyingglass").foregroundStyle(TradeTheme.muted); TextField("Hledat instrument nebo setup", text: $query) } }
            Picker("Výsledek", selection: $resultFilter) { ForEach(["Vše", "Zisk", "Ztráta"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
        }
    }

    private func dayGroup(_ day: Date, trades: [TradeRecord]) -> some View {
        let pnl = trades.reduce(0) { $0 + $1.result }
        let expanded = expandedDay == day
        return TradeCard(padding: 0) {
            VStack(spacing: 0) {
                Button { withAnimation(.snappy) { expandedDay = expanded ? nil : day } } label: {
                    HStack(spacing: 11) {
                        RoundedRectangle(cornerRadius: 6).fill((pnl >= 0 ? TradeTheme.success : TradeTheme.danger).opacity(0.1)).frame(width: 38, height: 38).overlay { Image(systemName: pnl >= 0 ? "arrow.up.right" : "arrow.down.right").foregroundStyle(pnl >= 0 ? TradeTheme.success : TradeTheme.danger) }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(trades.allSatisfy { !$0.setup.isEmpty } ? "Obchodní rozhodnutí" : "Neplatné / mimo plán").font(.subheadline.bold())
                            Text("\(day.formatted(.dateTime.day().month().year())) · \(trades.count) \(trades.count == 1 ? "obchod" : "obchody")").font(.caption).foregroundStyle(TradeTheme.secondary)
                        }
                        Spacer()
                        Text(pnl.usd).font(.headline.monospacedDigit()).foregroundStyle(pnl >= 0 ? TradeTheme.success : TradeTheme.danger)
                        Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(TradeTheme.muted)
                    }.padding(12)
                }.buttonStyle(.plain)
                if expanded {
                    Divider()
                    ForEach(trades) { trade in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) { HStack { Text(trade.symbol).font(.subheadline.bold()); StatusPill(text: trade.side, color: trade.side.uppercased() == "LONG" ? TradeTheme.success : TradeTheme.danger) }; Text(trade.setup).font(.caption).foregroundStyle(TradeTheme.secondary).lineLimit(1) }
                            Spacer(); Text(trade.result.usd).font(.subheadline.bold().monospacedDigit()).foregroundStyle(trade.result >= 0 ? TradeTheme.success : TradeTheme.danger)
                        }.padding(.horizontal, 12).padding(.vertical, 9)
                        if trade.id != trades.last?.id { Divider().padding(.leading, 12) }
                    }
                }
            }
        }
    }
}
