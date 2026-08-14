import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

private struct AlphaTradeSnapshot: Codable, Equatable {
    struct Account: Codable, Equatable {
        let name: String
        let balance: Double
        let pnl: Double
    }

    let dayPnL: Double
    let dayR: Double
    let tradeCount: Int
    let riskPercent: Int
    let discipline: Int
    let equity: [Double]
    let accounts: [Account]

    static let test = AlphaTradeSnapshot(
        dayPnL: 428.50,
        dayR: 2.14,
        tradeCount: 3,
        riskPercent: 38,
        discipline: 92,
        equity: [50_000, 50_120, 50_040, 50_310, 50_260, 50_510, 50_428],
        accounts: [
            .init(name: "Alpha 50K", balance: 50_428.50, pnl: 428.50),
            .init(name: "Tradeify 50K", balance: 50_214.25, pnl: 214.25),
            .init(name: "Lucid 50K", balance: 49_942.00, pnl: -58.00),
        ]
    )
}

private struct AlphaTradeEntry: TimelineEntry {
    let date: Date
    let snapshot: AlphaTradeSnapshot
}

private struct AlphaTradeProvider: TimelineProvider {
    func placeholder(in context: Context) -> AlphaTradeEntry { .init(date: .now, snapshot: .test) }
    func getSnapshot(in context: Context, completion: @escaping (AlphaTradeEntry) -> Void) {
        completion(.init(date: .now, snapshot: .test))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<AlphaTradeEntry>) -> Void) {
        completion(.init(entries: [.init(date: .now, snapshot: .test)], policy: .after(.now.addingTimeInterval(900))))
    }
}

private enum ATStyle {
    static let background = Color(red: 248 / 255, green: 250 / 255, blue: 252 / 255)
    static let card = Color.white
    static let ink = Color(red: 15 / 255, green: 23 / 255, blue: 42 / 255)
    static let muted = Color(red: 100 / 255, green: 116 / 255, blue: 139 / 255)
    static let blue = Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255)
    static let green = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)
    static let red = Color(red: 225 / 255, green: 29 / 255, blue: 72 / 255)
    static let border = Color(red: 226 / 255, green: 232 / 255, blue: 240 / 255)
}

private extension View {
    func alphaTradeSurface() -> some View {
        foregroundStyle(ATStyle.ink).containerBackground(ATStyle.background, for: .widget)
    }

    func alphaTradeLockSurface() -> some View {
        containerBackground(Color.clear, for: .widget)
    }
}

private struct ATHeader: View {
    let title: String
    let icon: String
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon).foregroundStyle(ATStyle.blue)
            Text(title).font(.caption2.bold()).lineLimit(1).minimumScaleFactor(0.7)
            Spacer()
            Text("TEST DATA").font(.system(size: 7, weight: .bold)).foregroundStyle(ATStyle.muted)
        }
    }
}

private func money(_ value: Double) -> String {
    value.formatted(.currency(code: "USD").precision(.fractionLength(0...2)))
}

private struct TodayView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "ALPHATRADE", icon: "checklist")
            Text("Dnešní plán").font(.headline)
            Text("Sweep → MSS → návrat do FVG").font(.caption).foregroundStyle(ATStyle.muted)
            Spacer()
            HStack { Text("Risk \(entry.snapshot.riskPercent)%"); Spacer(); Text("\(entry.snapshot.tradeCount) / 3") }
                .font(.caption2.bold()).foregroundStyle(ATStyle.blue)
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://dashboard"))
    }
}

private struct PnLView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "DAILY P&L", icon: "dollarsign.circle.fill")
            Text(money(entry.snapshot.dayPnL)).font(.title2.bold().monospacedDigit()).foregroundStyle(ATStyle.green).privacySensitive()
            Text(String(format: "%+.2fR", entry.snapshot.dayR)).font(.headline.monospacedDigit()).foregroundStyle(ATStyle.blue)
            Spacer()
            Text("\(entry.snapshot.tradeCount) obchody · Risk \(entry.snapshot.riskPercent)%").font(.caption2.bold()).foregroundStyle(ATStyle.muted)
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://journal"))
    }
}

private struct EquityLine: Shape {
    let values: [Double]
    func path(in rect: CGRect) -> Path {
        guard values.count > 1, let low = values.min(), let high = values.max() else { return Path() }
        let spread = max(high - low, 1)
        var result = Path()
        for (index, value) in values.enumerated() {
            let x = rect.minX + rect.width * CGFloat(index) / CGFloat(values.count - 1)
            let y = rect.maxY - rect.height * CGFloat((value - low) / spread)
            index == 0 ? result.move(to: .init(x: x, y: y)) : result.addLine(to: .init(x: x, y: y))
        }
        return result
    }
}

private struct EquityView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "EQUITY CURVE", icon: "chart.xyaxis.line")
            GeometryReader { proxy in
                ZStack {
                    Path { path in
                        for row in 0...3 {
                            let y = proxy.size.height * CGFloat(row) / 3
                            path.move(to: .init(x: 0, y: y)); path.addLine(to: .init(x: proxy.size.width, y: y))
                        }
                    }.stroke(ATStyle.border, lineWidth: 1)
                    EquityLine(values: entry.snapshot.equity)
                        .stroke(LinearGradient(colors: [ATStyle.blue, ATStyle.green], startPoint: .leading, endPoint: .trailing), style: .init(lineWidth: 4, lineCap: .round, lineJoin: .round))
                }
            }
            HStack { Text("START"); Spacer(); Text(money(entry.snapshot.equity.last ?? 0)).privacySensitive() }
                .font(.caption.bold().monospacedDigit()).foregroundStyle(ATStyle.muted)
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://dashboard"))
    }
}

private struct AccountsView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ATHeader(title: "ÚČTY", icon: "wallet.bifold.fill")
            ForEach(entry.snapshot.accounts, id: \.name) { account in
                HStack {
                    VStack(alignment: .leading) { Text(account.name).font(.caption.bold()); Text(money(account.balance)).privacySensitive() }
                    Spacer(); Text(money(account.pnl)).foregroundStyle(account.pnl >= 0 ? ATStyle.green : ATStyle.red).privacySensitive()
                }.font(.caption2.monospacedDigit())
                if account.name != entry.snapshot.accounts.last?.name { Divider() }
            }
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://accounts"))
    }
}

private struct DisciplineView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "DISCIPLÍNA", icon: "shield.checkered")
            Spacer()
            ZStack {
                Circle().stroke(ATStyle.border, lineWidth: 10)
                Circle().trim(from: 0, to: Double(entry.snapshot.discipline) / 100)
                    .stroke(ATStyle.green, style: .init(lineWidth: 10, lineCap: .round)).rotationEffect(.degrees(-90))
                Text("\(entry.snapshot.discipline)%").font(.title3.bold().monospacedDigit())
            }
            Spacer()
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://ai"))
    }
}

private struct TradesView: View {
    let entry: AlphaTradeEntry
    private let trades = [("MNQ", "LONG", "+1.42R"), ("MNQ", "SHORT", "-0.50R"), ("NQ", "LONG", "+1.22R")]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "POSLEDNÍ OBCHODY", icon: "list.bullet.rectangle")
            ForEach(Array(trades.enumerated()), id: \.offset) { _, trade in
                HStack { Text(trade.0).bold(); Text(trade.1).foregroundStyle(trade.1 == "LONG" ? ATStyle.green : ATStyle.red); Spacer(); Text(trade.2).bold() }
                    .font(.caption.monospacedDigit())
                Divider()
            }
            Spacer(minLength: 0)
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://history"))
    }
}

private struct ActionsView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ATHeader(title: "RYCHLÉ AKCE", icon: "bolt.fill")
            HStack(spacing: 8) {
                action("Zapsat", "square.and.pencil", "capture")
                action("Coach", "brain.head.profile", "ai")
                action("LIVE", "waveform.path.ecg", "live")
                action("Deník", "book", "journal")
            }
            Text("Akce pouze otevřou appku; nikdy samy neodesílají obchod.").font(.caption2).foregroundStyle(ATStyle.muted)
        }.padding().alphaTradeSurface()
    }
    private func action(_ title: String, _ icon: String, _ route: String) -> some View {
        Link(destination: URL(string: "alphatrade-native://\(route)")!) {
            VStack(spacing: 5) { Image(systemName: icon).font(.headline).foregroundStyle(ATStyle.blue); Text(title).font(.caption2.bold()).foregroundStyle(ATStyle.ink) }
                .frame(maxWidth: .infinity, minHeight: 48).background(ATStyle.card, in: RoundedRectangle(cornerRadius: 10))
                .overlay { RoundedRectangle(cornerRadius: 10).stroke(ATStyle.border) }
        }
    }
}

struct TodayWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeToday", provider: AlphaTradeProvider()) { TodayView(entry: $0) }.configurationDisplayName("Dnešní plán").description("Plán, risk a počet obchodů.").supportedFamilies([.systemSmall, .systemMedium]) }
}
struct DailyPnLWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeDailyPnL", provider: AlphaTradeProvider()) { PnLView(entry: $0) }.configurationDisplayName("Daily P&L").description("Výsledek dne v USD a R.").supportedFamilies([.systemSmall, .systemMedium]) }
}
struct EquityWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeEquity", provider: AlphaTradeProvider()) { EquityView(entry: $0) }.configurationDisplayName("Equity Curve").description("Vývoj účtu za poslední období.").supportedFamilies([.systemMedium, .systemLarge]) }
}
struct AccountsWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeAccounts", provider: AlphaTradeProvider()) { AccountsView(entry: $0) }.configurationDisplayName("Přehled účtů").description("Zůstatky a denní výsledky.").supportedFamilies([.systemMedium]) }
}
struct DisciplineWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeDiscipline", provider: AlphaTradeProvider()) { DisciplineView(entry: $0) }.configurationDisplayName("Disciplína").description("Dodržení plánu a pravidel.").supportedFamilies([.systemSmall]) }
}
struct RecentTradesWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeTrades", provider: AlphaTradeProvider()) { TradesView(entry: $0) }.configurationDisplayName("Poslední obchody").description("Rychlý přehled výsledků.").supportedFamilies([.systemMedium]) }
}
struct QuickActionsWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeActions", provider: AlphaTradeProvider()) { ActionsView(entry: $0) }.configurationDisplayName("Rychlé akce").description("Zápis, Coach, LIVE a Deník.").supportedFamilies([.systemMedium]) }
}

private struct LockPnLView: View {
    let entry: AlphaTradeEntry
    @Environment(\.widgetFamily) private var family

    @ViewBuilder
    var body: some View {
        switch family {
        case .accessoryInline:
            Label("TEST P&L \(money(entry.snapshot.dayPnL)) · \(String(format: "%+.2fR", entry.snapshot.dayR))", systemImage: "chart.line.uptrend.xyaxis")
                .privacySensitive()
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text("P&L").font(.caption2.bold()).widgetAccentable()
                    Text(entry.snapshot.dayPnL.formatted(.number.sign(strategy: .always()).precision(.fractionLength(0))))
                        .font(.caption.bold().monospacedDigit())
                        .minimumScaleFactor(0.65)
                        .privacySensitive()
                }
            }
        default:
            VStack(alignment: .leading, spacing: 3) {
                Label("DAILY P&L · TEST", systemImage: "dollarsign.circle.fill")
                    .font(.caption2.bold()).widgetAccentable()
                Text(money(entry.snapshot.dayPnL))
                    .font(.headline.bold().monospacedDigit()).privacySensitive()
                Text("\(String(format: "%+.2fR", entry.snapshot.dayR)) · \(entry.snapshot.tradeCount) obchody")
                    .font(.caption2).privacySensitive()
            }
        }
    }
}

private struct LockDisciplineView: View {
    let entry: AlphaTradeEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if family == .accessoryCircular {
            Gauge(value: Double(entry.snapshot.discipline), in: 0...100) {
                Image(systemName: "shield.checkered")
            } currentValueLabel: {
                Text("\(entry.snapshot.discipline)").font(.caption.bold().monospacedDigit())
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .widgetAccentable()
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Label("DISCIPLÍNA · TEST", systemImage: "shield.checkered")
                    .font(.caption2.bold()).widgetAccentable()
                HStack(alignment: .firstTextBaseline) {
                    Text("\(entry.snapshot.discipline)%").font(.title3.bold().monospacedDigit())
                    Text("plán dodržen").font(.caption2)
                }
                ProgressView(value: Double(entry.snapshot.discipline), total: 100)
                    .widgetAccentable()
            }
        }
    }
}

private struct LockLiveView: View {
    @Environment(\.widgetFamily) private var family

    @ViewBuilder
    var body: some View {
        if family == .accessoryCircular {
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 2) {
                    Image(systemName: "waveform.path.ecg").font(.headline).widgetAccentable()
                    Text("LIVE").font(.caption2.bold())
                }
            }
        } else if family == .accessoryInline {
            Label("Otevřít AlphaTrade LIVE", systemImage: "waveform.path.ecg")
        } else {
            HStack(spacing: 8) {
                Image(systemName: "waveform.path.ecg").font(.title2).widgetAccentable()
                VStack(alignment: .leading, spacing: 2) {
                    Text("ALPHATRADE LIVE").font(.caption.bold())
                    Text("Otevřít živý přehled").font(.caption2)
                }
            }
        }
    }
}

struct LockPnLWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AlphaTradeLockPnL", provider: AlphaTradeProvider()) {
            LockPnLView(entry: $0)
                .alphaTradeLockSurface()
                .widgetURL(URL(string: "alphatrade-native://journal"))
        }
            .configurationDisplayName("Lock Screen P&L")
            .description("Testovací denní P&L a R na zamčené obrazovce.")
            .supportedFamilies([.accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

struct LockDisciplineWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AlphaTradeLockDiscipline", provider: AlphaTradeProvider()) {
            LockDisciplineView(entry: $0)
                .alphaTradeLockSurface()
                .widgetURL(URL(string: "alphatrade-native://ai"))
        }
            .configurationDisplayName("Lock Screen disciplína")
            .description("Testovací skóre disciplíny na zamčené obrazovce.")
            .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    }
}

struct LockLiveWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AlphaTradeLockLive", provider: AlphaTradeProvider()) { _ in
            LockLiveView()
                .alphaTradeLockSurface()
                .widgetURL(URL(string: "alphatrade-native://live"))
        }
            .configurationDisplayName("Lock Screen LIVE")
            .description("Rychle otevře AlphaTrade LIVE bez provedení broker akce.")
            .supportedFamilies([.accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

struct AlphaTradeLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AlphaTradeLiveActivityAttributes.self) { context in
            AlphaTradeLiveActivityLockScreen(context: context)
                .activityBackgroundTint(Color(red: 2 / 255, green: 6 / 255, blue: 23 / 255))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "alphatrade-native://live"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.attributes.symbol, systemImage: "waveform.path.ecg")
                        .font(.caption.bold())
                        .foregroundStyle(.cyan)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.pnlText)
                        .font(.caption.bold().monospacedDigit())
                        .foregroundStyle(context.state.isPositive ? Color.green : Color.red)
                        .privacySensitive()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(context.state.headline).font(.caption.bold()).lineLimit(1)
                        ProgressView(value: context.state.progress)
                            .tint(context.state.isPositive ? .green : .orange)
                    }
                }
            } compactLeading: {
                Image(systemName: "waveform.path.ecg").foregroundStyle(.cyan)
            } compactTrailing: {
                Text(context.state.pnlText)
                    .font(.caption2.bold().monospacedDigit())
                    .foregroundStyle(context.state.isPositive ? Color.green : Color.red)
                    .privacySensitive()
            } minimal: {
                Image(systemName: context.state.isPositive ? "chart.line.uptrend.xyaxis" : "exclamationmark.triangle.fill")
                    .foregroundStyle(context.state.isPositive ? Color.green : Color.orange)
            }
            .widgetURL(URL(string: "alphatrade-native://live"))
            .keylineTint(.cyan)
        }
    }
}

@available(iOS 18.0, *)
struct AlphaTradeLiveControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "AlphaTradeControlLive") {
            ControlWidgetButton(action: OpenAlphaTradeLiveControlIntent()) {
                Label("AlphaTrade LIVE", systemImage: "waveform.path.ecg")
            }
        }
        .displayName("AlphaTrade LIVE")
        .description("Otevře živý přehled; neprovádí žádnou broker akci.")
    }
}

@available(iOS 18.0, *)
struct AlphaTradeCaptureControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "AlphaTradeControlCapture") {
            ControlWidgetButton(action: OpenAlphaTradeCaptureControlIntent()) {
                Label("Zapsat obchod", systemImage: "square.and.pencil")
            }
        }
        .displayName("Zapsat obchod")
        .description("Otevře kontrolovaný formulář; obchod nikdy automaticky neuloží.")
    }
}

private struct AlphaTradeLiveActivityLockScreen: View {
    let context: ActivityViewContext<AlphaTradeLiveActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "waveform.path.ecg").foregroundStyle(.cyan)
                Text("ALPHATRADE · \(context.attributes.symbol)")
                    .font(.caption.bold())
                Spacer()
                Text("TEST")
                    .font(.system(size: 9, weight: .black))
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(context.state.status).font(.caption2.bold()).foregroundStyle(.cyan)
                    Text(context.state.headline).font(.headline).lineLimit(1)
                    Text(context.state.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 12)
                Text(context.state.pnlText)
                    .font(.title3.bold().monospacedDigit())
                    .foregroundStyle(context.state.isPositive ? Color.green : Color.red)
                    .privacySensitive()
            }
            ProgressView(value: context.state.progress)
                .tint(context.state.isPositive ? .green : .orange)
            Text("Pouze test zobrazení · žádná broker akce")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .foregroundStyle(.white)
    }
}

@main
struct AlphaTradeWidgetBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        DailyPnLWidget()
        EquityWidget()
        AccountsWidget()
        DisciplineWidget()
        RecentTradesWidget()
        QuickActionsWidget()
        LockPnLWidget()
        LockDisciplineWidget()
        LockLiveWidget()
        AlphaTradeLiveActivityWidget()
        if #available(iOS 18.0, *) {
            AlphaTradeLiveControl()
            AlphaTradeCaptureControl()
        }
    }
}
