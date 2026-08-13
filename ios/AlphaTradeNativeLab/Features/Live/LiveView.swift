import SwiftUI

struct LiveView: View {
    @Environment(NativeLabStore.self) private var store
    @State private var section = "Connections"
    @State private var expandedAccount: UUID?
    private let sections = ["Connections", "Live Dashboard", "Účty", "Pozice a příkazy", "Události"]

    var body: some View {
        VStack(spacing: 0) {
            sectionBar
            ScrollView {
                LazyVStack(spacing: 10) {
                    safety
                    switch section {
                    case "Connections": connections
                    case "Live Dashboard": liveDashboard
                    case "Účty": accounts
                    case "Pozice a příkazy": positions
                    default: events
                    }
                }.padding(16)
            }
        }.tradeScreen()
    }

    private var sectionBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(sections, id: \.self) { item in
                    Button(item) { section = item }
                        .font(.caption.bold()).foregroundStyle(section == item ? Color.white : TradeTheme.secondary)
                        .padding(.horizontal, 11).frame(height: 30)
                        .background(section == item ? TradeTheme.primary : TradeTheme.raised, in: RoundedRectangle(cornerRadius: 6))
                }
            }.padding(.horizontal, 16).padding(.vertical, 9)
        }.background(TradeTheme.card).overlay(alignment: .bottom) { Divider() }
    }

    private var safety: some View {
        TradeCard(padding: 11) {
            HStack(spacing: 9) {
                Image(systemName: "lock.shield.fill").foregroundStyle(TradeTheme.success)
                VStack(alignment: .leading, spacing: 2) { Text(store.remoteConnection == .local ? "Bezpečný lokální režim" : "AlphaTrade data připojena").font(.subheadline.bold()); Text("Read-only přehled · žádné brokerové příkazy").font(.caption).foregroundStyle(TradeTheme.secondary) }
                Spacer(); StatusPill(text: "READ ONLY", color: TradeTheme.warning)
            }
        }
    }

    private var connections: some View {
        VStack(spacing: 8) {
            connectionRow("AlphaTrade účet", detail: connectionEmail, accounts: store.accounts.count, connected: isRemote)
            connectionRow("Tradovate", detail: "OAuth není v tomto testovacím buildu", accounts: 0, connected: false)
            TradeCard(padding: 12) { VStack(alignment: .leading, spacing: 7) { Text("Datový tok").font(.subheadline.bold()); flow("Supabase Auth", active: isRemote); flow("Dashboard RPC", active: isRemote); flow("Broker execution", active: false) } }
        }
    }

    private func connectionRow(_ name: String, detail: String, accounts: Int, connected: Bool) -> some View {
        TradeCard(padding: 11) {
            HStack(spacing: 10) {
                Circle().fill(connected ? TradeTheme.success : TradeTheme.muted).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) { Text(name).font(.subheadline.bold()); Text(detail).font(.caption).foregroundStyle(TradeTheme.secondary).lineLimit(1) }
                Spacer(); VStack(alignment: .trailing, spacing: 2) { Text("\(accounts)").font(.headline.monospacedDigit()); Text("ÚČTŮ").font(.system(size: 8, weight: .bold)).foregroundStyle(TradeTheme.muted) }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(TradeTheme.muted)
            }
        }
    }

    private func flow(_ name: String, active: Bool) -> some View {
        HStack { Image(systemName: active ? "checkmark.circle.fill" : "minus.circle").foregroundStyle(active ? TradeTheme.success : TradeTheme.muted); Text(name).font(.caption); Spacer(); Text(active ? "AKTIVNÍ" : "VYPNUTO").font(.caption2.bold()).foregroundStyle(active ? TradeTheme.success : TradeTheme.muted) }
    }

    private var liveDashboard: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) { metric("DNES", store.dayPnL.usd, store.dayPnL >= 0 ? TradeTheme.success : TradeTheme.danger); metric("OBCHODY", "\(store.todayTradeCount)", TradeTheme.blue) }
            HStack(spacing: 8) { metric("ÚČTY", "\(store.accounts.count)", TradeTheme.primary); metric("CELKEM", store.trades.reduce(0) { $0 + $1.result }.usd, TradeTheme.success) }
            TradeCard { VStack(alignment: .leading, spacing: 11) { SectionHeading(title: "Dnešní P&L", detail: "READ ONLY"); GeometryReader { geo in Canvas { context, size in var path = Path(); let values = store.trades.prefix(12).reversed().map(\.result); var total = 0.0; let sums = values.map { total += $0; return total }; let maxAbs = max(sums.map(abs).max() ?? 1, 1); for (index, value) in sums.enumerated() { let p = CGPoint(x: CGFloat(index) * size.width / CGFloat(max(sums.count - 1, 1)), y: size.height / 2 - CGFloat(value / maxAbs) * size.height * 0.42); index == 0 ? path.move(to: p) : path.addLine(to: p) }; context.stroke(path, with: .color(TradeTheme.blue), lineWidth: 2.2) } }.frame(height: 130) } }
        }
    }

    private func metric(_ title: String, _ value: String, _ color: Color) -> some View { TradeCard(padding: 12) { VStack(alignment: .leading, spacing: 5) { Text(title).font(.caption2.bold()).foregroundStyle(TradeTheme.muted); Text(value).font(.title3.bold().monospacedDigit()).foregroundStyle(color) }.frame(maxWidth: .infinity, alignment: .leading) } }

    private var accounts: some View {
        VStack(spacing: 7) {
            ForEach(store.accounts) { account in
                TradeCard(padding: 11) {
                    VStack(spacing: 9) {
                        HStack { Circle().fill(account.connected ? TradeTheme.success : TradeTheme.danger).frame(width: 7, height: 7); VStack(alignment: .leading, spacing: 2) { Text(account.name).font(.subheadline.bold()); Text(account.firm).font(.caption).foregroundStyle(TradeTheme.secondary) }; Spacer(); VStack(alignment: .trailing, spacing: 2) { Text(account.balance.usd).font(.subheadline.bold().monospacedDigit()); Text(account.dayPnL.usd).font(.caption.monospacedDigit()).foregroundStyle(account.dayPnL >= 0 ? TradeTheme.success : TradeTheme.danger) }; Button { withAnimation(.snappy) { expandedAccount = expandedAccount == account.id ? nil : account.id } } label: { Image(systemName: expandedAccount == account.id ? "chevron.up" : "chevron.down") }.buttonStyle(.plain).accessibilityIdentifier("account.expand.\(account.id)") }
                        if expandedAccount == account.id { Divider(); HStack { mini("ZDROJ", isRemote ? "AlphaTrade" : "Lokální"); mini("REŽIM", "READ ONLY"); mini("SYNC", "právě teď") } }
                    }
                }
            }
        }
    }

    private var positions: some View {
        VStack(spacing: 8) {
            TradeCard { VStack(alignment: .leading, spacing: 10) { SectionHeading(title: "Otevřené pozice", detail: "0"); empty("Žádné otevřené pozice", "rectangle.stack.badge.minus") } }
            TradeCard { VStack(alignment: .leading, spacing: 10) { SectionHeading(title: "Pracovní příkazy", detail: "0"); empty("Žádné aktivní příkazy", "list.bullet.clipboard") } }
            Label("Tato obrazovka je záměrně pouze pro čtení.", systemImage: "lock.fill").font(.caption).foregroundStyle(TradeTheme.secondary)
        }
    }

    private func empty(_ title: String, _ symbol: String) -> some View { HStack { Image(systemName: symbol).foregroundStyle(TradeTheme.muted); Text(title).font(.subheadline).foregroundStyle(TradeTheme.secondary); Spacer() }.padding(10).background(TradeTheme.raised, in: RoundedRectangle(cornerRadius: 6)) }

    private var events: some View {
        TradeCard { VStack(alignment: .leading, spacing: 13) { SectionHeading(title: "Systémové události", detail: "LOCAL"); event(isRemote ? "AlphaTrade data synchronizována" : "Lokální režim připraven", "TEĎ", TradeTheme.success); event("Read-only ochrana aktivní", "TEĎ", TradeTheme.blue); event("Brokerové příkazy jsou vypnuté", "—", TradeTheme.warning) } }
    }

    private func event(_ title: String, _ time: String, _ color: Color) -> some View { HStack { Circle().fill(color).frame(width: 7, height: 7); Text(title).font(.subheadline); Spacer(); Text(time).font(.caption.monospacedDigit()).foregroundStyle(TradeTheme.muted) } }
    private func mini(_ title: String, _ value: String) -> some View { VStack(alignment: .leading, spacing: 2) { Text(title).font(.system(size: 8, weight: .bold)).foregroundStyle(TradeTheme.muted); Text(value).font(.caption).foregroundStyle(TradeTheme.secondary) }.frame(maxWidth: .infinity, alignment: .leading) }
    private var isRemote: Bool { if case .connected = store.remoteConnection { true } else { false } }
    private var connectionEmail: String { if case .connected(let email) = store.remoteConnection { email } else { "Připojení nastavíš v Nastavení" } }
}
