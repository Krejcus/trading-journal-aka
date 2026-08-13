import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

private let widgetGroup = "group.app.alphatrade.nativelab"
private let widgetSnapshotKey = "nativeLab.widgetSnapshot.v1"

private struct WidgetLabSnapshot: Codable, Equatable {
    struct Account: Codable, Equatable {
        let name: String
        let balance: Double
        let dayPnL: Double
    }

    struct RecentTrade: Codable, Equatable {
        let symbol: String
        let side: String
        let result: Double
        let rMultiple: Double
    }

    let updatedAt: Date
    let dayPnL: Double
    let dayR: Double
    let tradeCount: Int
    let riskUsedPercent: Int
    let disciplinePercent: Int
    let preparationComplete: Bool
    let equity: [Double]
    let accounts: [Account]
    let recentTrades: [RecentTrade]
    let privacyMode: String

    static let demo = WidgetLabSnapshot(
        updatedAt: .now,
        dayPnL: 184.50,
        dayR: 1.42,
        tradeCount: 1,
        riskUsedPercent: 24,
        disciplinePercent: 92,
        preparationComplete: false,
        equity: [50_000, 50_312, 50_238, 50_422, 50_606],
        accounts: [
            .init(name: "Apex 50K · 01", balance: 51_284, dayPnL: 184.5),
            .init(name: "Topstep 50K · 02", balance: 50_936, dayPnL: 184.5),
            .init(name: "Demo Safety", balance: 100_000, dayPnL: 0)
        ],
        recentTrades: [
            .init(symbol: "MNQ", side: "LONG", result: 184.5, rMultiple: 1.42),
            .init(symbol: "MNQ", side: "SHORT", result: -74, rMultiple: -0.58),
            .init(symbol: "NQ", side: "LONG", result: 312, rMultiple: 2.08)
        ],
        privacyMode: "relative"
    )

    static func load() -> WidgetLabSnapshot {
        guard
            let data = (UserDefaults(suiteName: widgetGroup) ?? .standard).data(forKey: widgetSnapshotKey),
            let snapshot = try? JSONDecoder().decode(WidgetLabSnapshot.self, from: data)
        else { return .demo }
        return snapshot
    }

    var hidesMoney: Bool { privacyMode != "full" }
    var hidesAllFinance: Bool { privacyMode == "hidden" }
}

private struct LabEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetLabSnapshot
}

private struct LabProvider: TimelineProvider {
    func placeholder(in context: Context) -> LabEntry { .init(date: .now, snapshot: .demo) }
    func getSnapshot(in context: Context, completion: @escaping (LabEntry) -> Void) {
        completion(.init(date: .now, snapshot: .load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LabEntry>) -> Void) {
        completion(Timeline(
            entries: [.init(date: .now, snapshot: .load())],
            policy: .after(.now.addingTimeInterval(900))
        ))
    }
}

private enum WidgetStyle {
    static let background = Color(red: 248 / 255, green: 250 / 255, blue: 252 / 255)
    static let card = Color.white
    static let primary = Color(red: 15 / 255, green: 23 / 255, blue: 42 / 255)
    static let blue = Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255)
    static let green = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)
    static let red = Color(red: 225 / 255, green: 29 / 255, blue: 72 / 255)
    static let orange = Color(red: 217 / 255, green: 119 / 255, blue: 6 / 255)
    static let muted = Color(red: 100 / 255, green: 116 / 255, blue: 139 / 255)
    static let border = Color(red: 226 / 255, green: 232 / 255, blue: 240 / 255)
}

private struct WidgetHeader: View {
    let title: String
    let symbol: String
    var detail = "DEMO"
    var compact = false

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).foregroundStyle(WidgetStyle.blue)
            Text(title)
                .font(.caption2.bold())
                .tracking(compact ? 0 : 0.5)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
                .layoutPriority(1)
            Spacer()
            if !compact {
                Text(detail).font(.caption2.bold()).foregroundStyle(WidgetStyle.muted)
            }
        }
        .foregroundStyle(WidgetStyle.primary)
    }
}

private extension View {
    func labWidgetBackground() -> some View {
        foregroundStyle(WidgetStyle.primary)
            .containerBackground(WidgetStyle.background, for: .widget)
    }
}

private func money(_ value: Double, snapshot: WidgetLabSnapshot) -> String {
    guard !snapshot.hidesMoney, !snapshot.hidesAllFinance else { return "••••" }
    return value.formatted(.currency(code: "USD").precision(.fractionLength(0...2)))
}

private func signedR(_ value: Double) -> String { String(format: "%+.2fR", value) }

// MARK: - Today plan

private struct TodayPlanView: View {
    let entry: LabEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(title: "ALPHATRADE", symbol: "checklist", detail: entry.snapshot.preparationComplete ? "HOTOVO" : "3 / 4")
            Text("Dnešní plán").font(.headline)
            Text("Sweep → MSS → návrat do FVG")
                .font(.caption).foregroundStyle(.secondary).lineLimit(family == .systemSmall ? 3 : 2)
            Spacer()
            HStack {
                Label("Risk \(entry.snapshot.riskUsedPercent) %", systemImage: "gauge.with.dots.needle.33percent")
                Spacer()
                Text("\(entry.snapshot.tradeCount) / 3").foregroundStyle(WidgetStyle.blue)
            }.font(.caption2.bold())
        }
        .padding()
        .labWidgetBackground()
        .widgetURL(URL(string: "alphatrade-lab://today"))
    }
}

struct AlphaTradeTodayWidget: Widget {
    let kind = "AlphaTradeTodayWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LabProvider()) { TodayPlanView(entry: $0) }
            .configurationDisplayName("Dnešní plán")
            .description("Bias, checklist, risk a počet obchodů.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Daily P&L

private struct DailyPnLView: View {
    let entry: LabEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(
                title: "DAILY P&L",
                symbol: "dollarsign.circle.fill",
                detail: "DNES",
                compact: family == .systemSmall
            )
            if entry.snapshot.hidesAllFinance {
                Label("Finance skryté", systemImage: "eye.slash.fill")
                    .font(.headline).foregroundStyle(WidgetStyle.muted)
            } else {
                Text(money(entry.snapshot.dayPnL, snapshot: entry.snapshot))
                    .font(family == .systemSmall ? .title2.bold() : .title.bold())
                    .monospacedDigit()
                    .foregroundStyle(entry.snapshot.dayPnL >= 0 ? WidgetStyle.green : WidgetStyle.red)
                    .privacySensitive()
                Text(signedR(entry.snapshot.dayR))
                    .font(.headline.monospacedDigit()).foregroundStyle(WidgetStyle.blue)
            }
            Spacer()
            if family == .systemSmall {
                Text("\(entry.snapshot.tradeCount) obchod · Risk \(entry.snapshot.riskUsedPercent) %")
                .font(.caption2.bold().monospacedDigit())
                .foregroundStyle(WidgetStyle.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            } else {
                HStack {
                    Label("\(entry.snapshot.tradeCount) obchody", systemImage: "list.number")
                    Spacer()
                    Text("Risk \(entry.snapshot.riskUsedPercent) %")
                }.font(.caption2).foregroundStyle(WidgetStyle.muted)
            }
        }
        .padding().labWidgetBackground()
        .widgetURL(URL(string: "alphatrade-lab://journal"))
    }
}

struct DailyPnLWidget: Widget {
    let kind = "AlphaTradeDailyPnLWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LabProvider()) { DailyPnLView(entry: $0) }
            .configurationDisplayName("Daily P&L")
            .description("Výsledek dne v USD, R a využití risku.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Equity curve

private struct EquityCurveView: View {
    let entry: LabEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(title: "EQUITY CURVE", symbol: "chart.xyaxis.line", detail: "30 DNÍ")
            if entry.snapshot.hidesAllFinance {
                Spacer()
                Label("Křivka je skrytá", systemImage: "eye.slash.fill")
                    .font(.headline).foregroundStyle(WidgetStyle.muted)
                Spacer()
            } else {
                GeometryReader { proxy in
                    EquityPath(values: entry.snapshot.equity)
                        .stroke(
                            LinearGradient(colors: [WidgetStyle.blue, WidgetStyle.green], startPoint: .leading, endPoint: .trailing),
                            style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round)
                        )
                        .frame(width: proxy.size.width, height: proxy.size.height)
                }
                HStack {
                    Text("START").font(.caption2).foregroundStyle(WidgetStyle.muted)
                    Spacer()
                    Text(money(entry.snapshot.equity.last ?? 0, snapshot: entry.snapshot))
                        .font(.caption.bold().monospacedDigit()).privacySensitive()
                }
            }
        }
        .padding().labWidgetBackground()
        .widgetURL(URL(string: "alphatrade-lab://journal"))
    }
}

private struct EquityPath: Shape {
    let values: [Double]
    func path(in rect: CGRect) -> Path {
        guard values.count > 1, let minimum = values.min(), let maximum = values.max() else { return Path() }
        let spread = max(maximum - minimum, 1)
        var path = Path()
        for (index, value) in values.enumerated() {
            let x = rect.minX + rect.width * CGFloat(index) / CGFloat(values.count - 1)
            let y = rect.maxY - rect.height * CGFloat((value - minimum) / spread)
            if index == 0 { path.move(to: CGPoint(x: x, y: y)) }
            else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        return path
    }
}

struct EquityCurveWidget: Widget {
    let kind = "AlphaTradeEquityCurveWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LabProvider()) { EquityCurveView(entry: $0) }
            .configurationDisplayName("Equity Curve")
            .description("Lokální křivka vývoje účtu.")
            .supportedFamilies([.systemMedium, .systemLarge])
    }
}

// MARK: - Accounts

private struct AccountsView: View {
    let entry: LabEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(title: "ÚČTY", symbol: "wallet.bifold.fill", detail: "READ ONLY")
            if entry.snapshot.hidesAllFinance {
                Spacer(); Label("Zůstatky skryté", systemImage: "lock.fill").foregroundStyle(WidgetStyle.muted); Spacer()
            } else {
                ForEach(Array(entry.snapshot.accounts.prefix(family == .systemSmall ? 2 : 3).enumerated()), id: \.offset) { _, account in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(account.name).font(.caption.bold()).lineLimit(1)
                        HStack {
                            Text(money(account.balance, snapshot: entry.snapshot)).privacySensitive()
                            Spacer()
                            Text(money(account.dayPnL, snapshot: entry.snapshot))
                                .foregroundStyle(account.dayPnL >= 0 ? WidgetStyle.green : WidgetStyle.red)
                                .privacySensitive()
                        }.font(.caption2.monospacedDigit()).foregroundStyle(WidgetStyle.muted)
                    }
                    if account.name != entry.snapshot.accounts.prefix(family == .systemSmall ? 2 : 3).last?.name { Divider().opacity(0.25) }
                }
            }
        }
        .padding().labWidgetBackground()
        .widgetURL(URL(string: "alphatrade-lab://live"))
    }
}

struct AccountsWidget: Widget {
    let kind = "AlphaTradeAccountsWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LabProvider()) { AccountsView(entry: $0) }
            .configurationDisplayName("Přehled účtů")
            .description("Testovací zůstatky a denní výsledky.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Discipline

private struct DisciplineView: View {
    let entry: LabEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(title: "DISCIPLÍNA", symbol: "shield.checkered", detail: "DNES")
            Spacer()
            ZStack {
                Circle().stroke(WidgetStyle.border, lineWidth: 10)
                Circle().trim(from: 0, to: Double(entry.snapshot.disciplinePercent) / 100)
                    .stroke(WidgetStyle.green, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(entry.snapshot.disciplinePercent)%").font(.title3.bold().monospacedDigit())
            }
            Spacer()
            Text("Checklist · cooldown · max 3 obchody").font(.caption2).foregroundStyle(WidgetStyle.muted).lineLimit(2)
        }
        .padding().labWidgetBackground()
        .widgetURL(URL(string: "alphatrade-lab://coach"))
    }
}

struct DisciplineWidget: Widget {
    let kind = "AlphaTradeDisciplineWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LabProvider()) { DisciplineView(entry: $0) }
            .configurationDisplayName("Disciplína")
            .description("Dodržení bezpečnostních pravidel dne.")
            .supportedFamilies([.systemSmall])
    }
}

// MARK: - Recent trades

private struct RecentTradesView: View {
    let entry: LabEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(title: "POSLEDNÍ OBCHODY", symbol: "list.bullet.rectangle", detail: "LOCAL")
            ForEach(Array(entry.snapshot.recentTrades.prefix(4).enumerated()), id: \.offset) { _, trade in
                HStack {
                    Text(trade.symbol).font(.caption.bold())
                    Text(trade.side).font(.caption2.bold()).foregroundStyle(trade.side == "LONG" ? WidgetStyle.green : WidgetStyle.red)
                    Spacer()
                    Text(entry.snapshot.hidesAllFinance ? "••••" : signedR(trade.rMultiple))
                        .font(.caption.bold().monospacedDigit()).foregroundStyle(trade.rMultiple >= 0 ? WidgetStyle.green : WidgetStyle.red)
                    Text(money(trade.result, snapshot: entry.snapshot))
                        .font(.caption2.monospacedDigit()).foregroundStyle(WidgetStyle.muted).privacySensitive()
                }
                if trade.symbol != entry.snapshot.recentTrades.prefix(4).last?.symbol { Divider().opacity(0.25) }
            }
            Spacer(minLength: 0)
        }
        .padding().labWidgetBackground()
        .widgetURL(URL(string: "alphatrade-lab://journal"))
    }
}

struct RecentTradesWidget: Widget {
    let kind = "AlphaTradeRecentTradesWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LabProvider()) { RecentTradesView(entry: $0) }
            .configurationDisplayName("Poslední obchody")
            .description("Výsledky posledních lokálních záznamů.")
            .supportedFamilies([.systemMedium, .systemLarge])
    }
}

// MARK: - Quick actions

private struct QuickActionsView: View {
    let entry: LabEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            WidgetHeader(title: "RYCHLÉ AKCE", symbol: "bolt.fill", detail: "NATIVE")
            HStack(spacing: 8) {
                action("Zapsat", symbol: "square.and.pencil", route: "capture")
                action("Coach", symbol: "brain.head.profile", route: "coach")
                action("Replay", symbol: "chart.xyaxis.line", route: "replay")
                action("Plán", symbol: "checklist", route: "today")
            }
            Spacer(minLength: 0)
            Text("Akce otevřou bezpečný lokální workflow; nikdy neodesílají obchod.")
                .font(.caption2).foregroundStyle(WidgetStyle.muted)
        }
        .padding().labWidgetBackground()
    }

    private func action(_ title: String, symbol: String, route: String) -> some View {
        Link(destination: URL(string: "alphatrade-lab://\(route)")!) {
            VStack(spacing: 5) {
                Image(systemName: symbol).font(.headline).foregroundStyle(WidgetStyle.blue)
                Text(title).font(.caption2.bold()).foregroundStyle(WidgetStyle.primary)
            }
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(WidgetStyle.card, in: RoundedRectangle(cornerRadius: 9))
            .overlay { RoundedRectangle(cornerRadius: 9).stroke(WidgetStyle.border) }
        }
    }
}

struct QuickActionsWidget: Widget {
    let kind = "AlphaTradeQuickActionsWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LabProvider()) { QuickActionsView(entry: $0) }
            .configurationDisplayName("Rychlé akce")
            .description("Zápis, Coach, Replay a příprava bez hledání v aplikaci.")
            .supportedFamilies([.systemMedium])
    }
}

// MARK: - Live Activity

struct TradingSessionAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var startedAt: Date
        var riskUsedPercent: Int
        var noteCount: Int
    }
    var symbol: String
    var sessionName: String
}

struct TradingSessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TradingSessionAttributes.self) { context in
            HStack(spacing: 12) {
                Image(systemName: "chart.xyaxis.line").foregroundStyle(.blue)
                VStack(alignment: .leading) {
                    Text("\(context.attributes.symbol) · \(context.attributes.sessionName)").font(.headline)
                    Text("Risk \(context.state.riskUsedPercent) % · \(context.state.noteCount) poznámky").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(); Text(context.state.startedAt, style: .timer).font(.headline.monospacedDigit())
            }
            .padding()
            .activityBackgroundTint(WidgetStyle.background)
            .activitySystemActionForegroundColor(WidgetStyle.primary)
            .widgetURL(URL(string: "alphatrade-lab://today"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Label(context.attributes.symbol, systemImage: "chart.xyaxis.line").foregroundStyle(.blue) }
                DynamicIslandExpandedRegion(.trailing) { Text(context.state.startedAt, style: .timer).font(.caption.monospacedDigit()) }
                DynamicIslandExpandedRegion(.bottom) { Text("Lokální demo session · žádné živé příkazy").font(.caption) }
            } compactLeading: { Image(systemName: "chart.xyaxis.line").foregroundStyle(.blue) }
              compactTrailing: { Text("\(context.state.riskUsedPercent)%").foregroundStyle(.orange) }
              minimal: { Image(systemName: "chart.xyaxis.line").foregroundStyle(.blue) }
              .widgetURL(URL(string: "alphatrade-lab://today"))
        }
    }
}

@main
struct AlphaTradeWidgetBundle: WidgetBundle {
    var body: some Widget {
        AlphaTradeTodayWidget()
        DailyPnLWidget()
        EquityCurveWidget()
        AccountsWidget()
        DisciplineWidget()
        RecentTradesWidget()
        QuickActionsWidget()
        TradingSessionLiveActivity()
    }
}
