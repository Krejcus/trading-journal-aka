import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

private struct AlphaTradeSnapshot: Codable, Equatable {
    struct Account: Codable, Equatable {
        let id: String
        let name: String
        let balance: Double
        let pnl: Double
        let openPnl: Double
        let locked: Bool
        let lockReason: String?
    }

    struct Trade: Codable, Equatable {
        let id: String
        let symbol: String
        let side: String
        let pnl: Double
        let quantity: Double?
        let timestamp: Double
    }

    struct Position: Codable, Equatable {
        let accountName: String
        let symbol: String
        let side: String
        let quantity: Double
        let averagePrice: Double?
    }

    struct Journal: Codable, Equatable {
        let dayPnl: Double
        let dayR: Double
        let tradeCount: Int
        let riskPercent: Int
        let discipline: Int
        let equity: [Double]
        let accounts: [Account]
        let recentTrades: [Trade]
    }

    struct Live: Codable, Equatable {
        let connected: Bool
        let armed: Bool
        let shadowMode: Bool
        let killSwitch: Bool
        let status: String
        let statusDetail: String
        let armExpiresAt: Double
        let cooldownUntil: Double
        let dayLockUntil: Double
        let dayLockReason: String?
        let dailyRealizedPnl: Double
        let losingTrades: Int
        let followerCount: Int
        let openPositionCount: Int
        let workingOrderCount: Int
        let realizedPnl: Double
        let openPnl: Double
        let totalPnl: Double
        let accounts: [Account]
        let positions: [Position]
        let recentTrades: [Trade]
        let equity: [Double]?
    }

    let version: Int
    let updatedAt: Double
    let journal: Journal?
    let live: Live?

    var dayPnL: Double { live?.totalPnl ?? journal?.dayPnl ?? 0 }
    var dayR: Double { journal?.dayR ?? 0 }
    var tradeCount: Int { journal?.tradeCount ?? live?.recentTrades.count ?? 0 }
    var riskPercent: Int { journal?.riskPercent ?? 0 }
    var discipline: Int { journal?.discipline ?? 100 }
    var equity: [Double] {
        if let liveEquity = live?.equity, liveEquity.count > 1 { return liveEquity }
        return journal?.equity ?? []
    }
    var accounts: [Account] { live?.accounts.isEmpty == false ? live?.accounts ?? [] : journal?.accounts ?? [] }
    var recentTrades: [Trade] { live?.recentTrades.isEmpty == false ? live?.recentTrades ?? [] : journal?.recentTrades ?? [] }
    var isPlaceholder: Bool { updatedAt <= 0 }
    var isLiveStale: Bool {
        guard live != nil, updatedAt > 0 else { return false }
        return Date().timeIntervalSince1970 * 1_000 - updatedAt > 30 * 60_000
    }

    static let test = AlphaTradeSnapshot(
        version: 2,
        updatedAt: 0,
        journal: .init(
            dayPnl: 428.50, dayR: 2.14, tradeCount: 3, riskPercent: 38,
            discipline: 92, equity: [50_000, 50_120, 50_040, 50_310, 50_428],
            accounts: [
                .init(id: "preview-1", name: "Alpha 50K", balance: 50_428.50, pnl: 428.50, openPnl: 0, locked: false, lockReason: nil),
                .init(id: "preview-2", name: "Tradeify 50K", balance: 50_214.25, pnl: 214.25, openPnl: 0, locked: false, lockReason: nil),
            ],
            recentTrades: [.init(id: "preview", symbol: "MNQ", side: "Long", pnl: 428.50, quantity: 2, timestamp: 0)]
        ),
        live: .init(
            connected: true, armed: true, shadowMode: false, killSwitch: false,
            status: "ARM LIVE", statusDetail: "Kopírování je aktivní.",
            armExpiresAt: 0, cooldownUntil: 0, dayLockUntil: 0, dayLockReason: nil,
            dailyRealizedPnl: 320, losingTrades: 1, followerCount: 5,
            openPositionCount: 1, workingOrderCount: 2, realizedPnl: 320,
            openPnl: 108.50, totalPnl: 428.50,
            accounts: [], positions: [.init(accountName: "Alpha 50K", symbol: "MNQ", side: "Long", quantity: 2, averagePrice: 22_450.25)],
            recentTrades: [], equity: [50_000, 50_120, 50_040, 50_310, 50_428]
        )
    )

    static let empty = AlphaTradeSnapshot(
        version: 2,
        updatedAt: 0,
        journal: .init(
            dayPnl: 0, dayR: 0, tradeCount: 0, riskPercent: 0,
            discipline: 100, equity: [], accounts: [], recentTrades: []
        ),
        live: nil
    )

    static func current() -> AlphaTradeSnapshot {
        guard let defaults = UserDefaults(suiteName: "group.app.alphatrade.native"),
              let json = defaults.string(forKey: "AlphaTradeWidgetSnapshotV2"),
              let data = json.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(AlphaTradeSnapshot.self, from: data),
              decoded.version == 2 else { return .empty }
        return decoded
    }

    func mergingRemote(_ remote: AlphaTradeSnapshot) -> AlphaTradeSnapshot {
        AlphaTradeSnapshot(
            version: 2,
            updatedAt: remote.updatedAt,
            journal: journal ?? remote.journal,
            live: remote.live ?? live
        )
    }
}

private struct AlphaTradeEntry: TimelineEntry {
    let date: Date
    let snapshot: AlphaTradeSnapshot
}

private struct AlphaTradeProvider: TimelineProvider {
    private let suiteName = "group.app.alphatrade.native"
    private let tokenKey = "AlphaTradeWidgetAccessTokenV1"
    private let snapshotKey = "AlphaTradeWidgetSnapshotV2"
    private let endpoint = URL(string: "https://alphatrade-mentor-15.vercel.app/api/native-widget-snapshot")!

    func placeholder(in context: Context) -> AlphaTradeEntry { .init(date: .now, snapshot: .test) }
    func getSnapshot(in context: Context, completion: @escaping (AlphaTradeEntry) -> Void) {
        completion(.init(date: .now, snapshot: context.isPreview ? .test : .current()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<AlphaTradeEntry>) -> Void) {
        let current = AlphaTradeSnapshot.current()
        guard let defaults = UserDefaults(suiteName: suiteName),
              let token = defaults.string(forKey: tokenKey),
              token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            completion(timeline(current))
            return
        }
        AlphaTradeWidgetPushRegistration.registerIfNeeded(defaults: defaults, accessToken: token)
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 12
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("Widget \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let data,
                  let remote = try? JSONDecoder().decode(AlphaTradeSnapshot.self, from: data),
                  remote.version == 2 else {
                completion(timeline(current))
                return
            }
            let merged = current.mergingRemote(remote)
            if let encoded = try? JSONEncoder().encode(merged),
               let json = String(data: encoded, encoding: .utf8) {
                defaults.set(json, forKey: snapshotKey)
            }
            completion(timeline(merged))
        }.resume()
    }

    private func timeline(_ snapshot: AlphaTradeSnapshot) -> Timeline<AlphaTradeEntry> {
        // WidgetKit owns the actual budget. Five minutes is a request, not a
        // promise; urgent ARM/position changes continue through ActivityKit.
        Timeline(entries: [.init(date: .now, snapshot: snapshot)], policy: .after(.now.addingTimeInterval(5 * 60)))
    }
}

@available(iOS 26.0, *)
private enum AlphaTradeWidgetPushRegistration {
    private static let pushTokenKey = "AlphaTradeWidgetPushTokenV1"
    private static let kindsKey = "AlphaTradeWidgetPushKindsV1"
    private static let registeredSignatureKey = "AlphaTradeWidgetPushRegisteredSignatureV1"
    private static let endpoint = URL(string: "https://alphatrade-mentor-15.vercel.app/api/native-widget-push-subscription")!

    static func receive(pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        guard let defaults = UserDefaults(suiteName: "group.app.alphatrade.native") else { return }
        let deviceToken = pushInfo.token.map { String(format: "%02x", $0) }.joined()
        let kinds = Array(Set(widgets.map(\.kind))).sorted()
        defaults.set(deviceToken, forKey: pushTokenKey)
        defaults.set(kinds, forKey: kindsKey)
        guard let accessToken = defaults.string(forKey: "AlphaTradeWidgetAccessTokenV1") else { return }
        registerIfNeeded(defaults: defaults, accessToken: accessToken)
    }

    static func registerIfNeeded(defaults: UserDefaults, accessToken: String) {
        guard accessToken.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let deviceToken = defaults.string(forKey: pushTokenKey),
              deviceToken.range(of: "^[0-9a-f]{64,512}$", options: .regularExpression) != nil else { return }
        let kinds = defaults.stringArray(forKey: kindsKey) ?? []
#if DEBUG
        let environment = "development"
#else
        let environment = "production"
#endif
        let signature = "\(environment):\(deviceToken):\(kinds.joined(separator: ","))"
        guard defaults.string(forKey: registeredSignatureKey) != signature else { return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("Widget \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "deviceToken": deviceToken,
            "environment": environment,
            "bundleId": "app.alphatrade.native",
            "enabled": !kinds.isEmpty,
            "widgetKinds": kinds,
        ])
        URLSession.shared.dataTask(with: request) { _, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            defaults.set(signature, forKey: registeredSignatureKey)
        }.resume()
    }
}

@available(iOS 26.0, *)
private struct AlphaTradeWidgetPushHandler: WidgetPushHandler {
    init() {}

    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        AlphaTradeWidgetPushRegistration.receive(pushInfo: pushInfo, widgets: widgets)
    }
}

private enum ATStyle {
    static let background = Color(uiColor: .secondarySystemBackground)
    static let card = Color(uiColor: .systemBackground)
    static let ink = Color.primary
    static let muted = Color.secondary
    static let blue = Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255)
    static let green = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)
    static let red = Color(red: 225 / 255, green: 29 / 255, blue: 72 / 255)
    static let border = Color(uiColor: .separator).opacity(0.35)
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
    var stale = false
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon).foregroundStyle(ATStyle.blue)
            Text(title).font(.caption2.bold()).lineLimit(1).minimumScaleFactor(0.7)
            Spacer()
            if stale {
                Image(systemName: "clock.badge.exclamationmark.fill")
                    .font(.caption2).foregroundStyle(ATStyle.red)
                    .accessibilityLabel("Data jsou zastaralá")
            }
            Button(intent: RefreshAlphaTradeWidgetsIntent()) {
                Image(systemName: "arrow.clockwise")
                    .font(.caption2.bold())
                    .foregroundStyle(ATStyle.blue)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Obnovit data")
        }
    }
}

private func money(_ value: Double) -> String {
    value.formatted(.currency(code: "USD").precision(.fractionLength(0...2)))
}

private struct ATNoDataView: View {
    var compact = false
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "icloud.and.arrow.down")
            Text("Čekám na skutečná data")
        }
        .font(compact ? .caption2.bold() : .caption.bold())
        .foregroundStyle(ATStyle.muted)
    }
}

private struct TodayView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "ALPHATRADE", icon: "checklist", stale: entry.snapshot.isLiveStale)
            Text(entry.snapshot.isPlaceholder ? "Otevři AlphaTrade" : entry.snapshot.live?.status ?? "Dnešní deník")
                .font(.headline)
            Text(entry.snapshot.isPlaceholder
                 ? "Po prvním načtení se zobrazí skutečná data."
                 : entry.snapshot.live?.statusDetail ?? "\(entry.snapshot.tradeCount) obchodů · \(money(entry.snapshot.dayPnL))")
                .font(.caption).foregroundStyle(ATStyle.muted).lineLimit(2)
            Spacer()
            HStack { Text("Risk \(entry.snapshot.riskPercent)%"); Spacer(); Text("\(entry.snapshot.tradeCount) obchodů") }
                .font(.caption2.bold()).foregroundStyle(ATStyle.blue)
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://dashboard"))
    }
}

private struct PnLView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "DAILY P&L", icon: "dollarsign.circle.fill", stale: entry.snapshot.isLiveStale)
            if entry.snapshot.isPlaceholder {
                Spacer()
                ATNoDataView()
                Text("Otevři AlphaTrade nebo klepni na obnovu.")
                    .font(.caption2).foregroundStyle(ATStyle.muted)
                Spacer()
            } else {
                Text(money(entry.snapshot.dayPnL)).font(.title2.bold().monospacedDigit())
                    .foregroundStyle(entry.snapshot.dayPnL >= 0 ? ATStyle.green : ATStyle.red).privacySensitive()
                Text(String(format: "%+.2fR", entry.snapshot.dayR)).font(.headline.monospacedDigit()).foregroundStyle(ATStyle.blue)
                Spacer()
                Text("\(entry.snapshot.tradeCount) obchody · Risk \(entry.snapshot.riskPercent)%").font(.caption2.bold()).foregroundStyle(ATStyle.muted)
            }
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
                    if entry.snapshot.equity.count < 2 {
                        Text("Zatím bez equity dat").font(.caption2).foregroundStyle(ATStyle.muted)
                    }
                }
            }
            HStack {
                Text("START")
                Spacer()
                Text(entry.snapshot.equity.last.map(money) ?? "—").privacySensitive()
            }
                .font(.caption.bold().monospacedDigit()).foregroundStyle(ATStyle.muted)
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://dashboard"))
    }
}

private struct AccountsView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ATHeader(title: "ÚČTY", icon: "wallet.bifold.fill", stale: entry.snapshot.isLiveStale)
            if entry.snapshot.accounts.isEmpty {
                Spacer()
                ATNoDataView()
                Spacer()
            }
            ForEach(entry.snapshot.accounts, id: \.id) { account in
                HStack {
                    VStack(alignment: .leading) {
                        HStack(spacing: 3) {
                            Text(account.name).font(.caption.bold()).lineLimit(1)
                            if account.locked { Image(systemName: "lock.fill").foregroundStyle(ATStyle.red) }
                        }
                        Text(money(account.balance)).privacySensitive()
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(money(account.pnl)).foregroundStyle(account.pnl >= 0 ? ATStyle.green : ATStyle.red).privacySensitive()
                        if account.openPnl != 0 { Text("open \(money(account.openPnl))").foregroundStyle(ATStyle.muted).privacySensitive() }
                    }
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
            if entry.snapshot.isPlaceholder {
                ATNoDataView()
            } else {
                ZStack {
                    Circle().stroke(ATStyle.border, lineWidth: 10)
                    Circle().trim(from: 0, to: Double(entry.snapshot.discipline) / 100)
                        .stroke(ATStyle.green, style: .init(lineWidth: 10, lineCap: .round)).rotationEffect(.degrees(-90))
                    Text("\(entry.snapshot.discipline)%").font(.title3.bold().monospacedDigit())
                }
            }
            Spacer()
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://ai"))
    }
}

private struct TradesView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "POSLEDNÍ OBCHODY", icon: "list.bullet.rectangle", stale: entry.snapshot.isLiveStale)
            if entry.snapshot.recentTrades.isEmpty {
                Text("Zatím bez potvrzených obchodů").font(.caption).foregroundStyle(ATStyle.muted)
            }
            ForEach(entry.snapshot.recentTrades.prefix(3), id: \.id) { trade in
                HStack {
                    Text(trade.symbol).bold()
                    Text(trade.side.uppercased()).foregroundStyle(trade.side.lowercased() == "long" ? ATStyle.green : ATStyle.red)
                    Spacer()
                    Text(money(trade.pnl)).bold().foregroundStyle(trade.pnl >= 0 ? ATStyle.green : ATStyle.red).privacySensitive()
                }
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

private struct CopierStatusView: View {
    let entry: AlphaTradeEntry
    private var live: AlphaTradeSnapshot.Live? { entry.snapshot.live }
    private var statusColor: Color {
        guard let live else { return ATStyle.muted }
        if entry.snapshot.isLiveStale { return ATStyle.red }
        if live.killSwitch || !live.connected { return ATStyle.red }
        if live.dayLockUntil > Date().timeIntervalSince1970 * 1_000 { return .orange }
        return live.armed ? ATStyle.green : ATStyle.muted
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "COPIER LIVE", icon: "bolt.shield.fill", stale: entry.snapshot.isLiveStale)
            HStack(alignment: .firstTextBaseline) {
                Circle().fill(statusColor).frame(width: 8, height: 8)
                Text(entry.snapshot.isLiveStale ? "DATA ZASTARALÁ" : live?.status ?? "ČEKÁ NA DATA")
                    .font(.headline).foregroundStyle(statusColor).lineLimit(1).minimumScaleFactor(0.7)
                Spacer()
            }
            Text(entry.snapshot.isLiveStale
                 ? "Widget se déle než 30 minut nepodařilo obnovit."
                 : live?.statusDetail ?? "Otevři AlphaTrade LIVE pro první snapshot.")
                .font(.caption2).foregroundStyle(ATStyle.muted).lineLimit(2)
            Spacer(minLength: 0)
            if let live {
                HStack {
                    Label("\(live.followerCount)", systemImage: "person.2.fill")
                    Spacer()
                    Label("\(live.openPositionCount)", systemImage: "chart.bar.fill")
                    Spacer()
                    Text(money(live.totalPnl))
                        .foregroundStyle(live.totalPnl >= 0 ? ATStyle.green : ATStyle.red)
                        .privacySensitive()
                }.font(.caption2.bold().monospacedDigit())
            } else {
                ATNoDataView(compact: true)
            }
            if let expires = live?.armExpiresAt, expires > Date().timeIntervalSince1970 * 1_000 {
                HStack(spacing: 4) {
                    Text("ARM zbývá").foregroundStyle(ATStyle.muted)
                    Text(timerInterval: Date()...Date(timeIntervalSince1970: expires / 1_000), countsDown: true)
                        .monospacedDigit().foregroundStyle(statusColor)
                }.font(.caption2.bold())
            }
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://live"))
    }
}

private struct PositionsView: View {
    let entry: AlphaTradeEntry
    private var live: AlphaTradeSnapshot.Live? { entry.snapshot.live }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ATHeader(title: "OTEVŘENÉ POZICE", icon: "chart.bar.doc.horizontal.fill", stale: entry.snapshot.isLiveStale)
            if live?.positions.isEmpty != false {
                Spacer()
                Label(live == nil ? "Čeká na LIVE snapshot" : "Všechny účty jsou flat", systemImage: "checkmark.shield.fill")
                    .font(.caption.bold()).foregroundStyle(live == nil ? ATStyle.muted : ATStyle.green)
                Spacer()
            } else {
                ForEach(Array((live?.positions ?? []).prefix(4).enumerated()), id: \.offset) { _, position in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(position.accountName).font(.caption2.bold()).lineLimit(1)
                            Text(position.symbol).font(.caption2).foregroundStyle(ATStyle.muted)
                        }
                        Spacer()
                        Text(position.side.uppercased())
                            .font(.caption2.bold()).foregroundStyle(position.side.lowercased() == "long" ? ATStyle.green : ATStyle.red)
                        Text("×\(position.quantity.formatted(.number.precision(.fractionLength(0...2))))")
                            .font(.caption.bold().monospacedDigit())
                    }
                }
            }
            if let live {
                HStack {
                    Text("Open P&L").foregroundStyle(ATStyle.muted)
                    Spacer()
                    Text(money(live.openPnl))
                        .foregroundStyle(live.openPnl >= 0 ? ATStyle.green : ATStyle.red)
                        .privacySensitive()
                }.font(.caption.bold().monospacedDigit())
            }
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://live"))
    }
}

struct TodayWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeToday", provider: AlphaTradeProvider()) { TodayView(entry: $0) }.configurationDisplayName("Dnešní plán").description("Plán, risk a počet obchodů.").supportedFamilies([.systemSmall, .systemMedium]).pushHandler(AlphaTradeWidgetPushHandler.self) }
}
struct DailyPnLWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeDailyPnL", provider: AlphaTradeProvider()) { PnLView(entry: $0) }.configurationDisplayName("Daily P&L").description("Výsledek dne v USD a R.").supportedFamilies([.systemSmall, .systemMedium]).pushHandler(AlphaTradeWidgetPushHandler.self) }
}
struct EquityWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeEquity", provider: AlphaTradeProvider()) { EquityView(entry: $0) }.configurationDisplayName("Equity Curve").description("Vývoj účtu za poslední období.").supportedFamilies([.systemMedium, .systemLarge]).pushHandler(AlphaTradeWidgetPushHandler.self) }
}
struct AccountsWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeAccounts", provider: AlphaTradeProvider()) { AccountsView(entry: $0) }.configurationDisplayName("Přehled účtů").description("Zůstatky a denní výsledky.").supportedFamilies([.systemMedium]).pushHandler(AlphaTradeWidgetPushHandler.self) }
}
struct DisciplineWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeDiscipline", provider: AlphaTradeProvider()) { DisciplineView(entry: $0) }.configurationDisplayName("Disciplína").description("Dodržení plánu a pravidel.").supportedFamilies([.systemSmall]).pushHandler(AlphaTradeWidgetPushHandler.self) }
}
struct RecentTradesWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeTrades", provider: AlphaTradeProvider()) { TradesView(entry: $0) }.configurationDisplayName("Poslední obchody").description("Rychlý přehled výsledků.").supportedFamilies([.systemMedium]).pushHandler(AlphaTradeWidgetPushHandler.self) }
}
struct QuickActionsWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeActions", provider: AlphaTradeProvider()) { ActionsView(entry: $0) }.configurationDisplayName("Rychlé akce").description("Zápis, Coach, LIVE a Deník.").supportedFamilies([.systemMedium]).pushHandler(AlphaTradeWidgetPushHandler.self) }
}
struct CopierStatusWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeCopier", provider: AlphaTradeProvider()) { CopierStatusView(entry: $0) }.configurationDisplayName("Copier LIVE").description("ARM, spojení, locky, pozice a P&L kopírky.").supportedFamilies([.systemSmall, .systemMedium]).pushHandler(AlphaTradeWidgetPushHandler.self) }
}
struct PositionsWidget: Widget {
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradePositions", provider: AlphaTradeProvider()) { PositionsView(entry: $0) }.configurationDisplayName("Otevřené pozice").description("Poslední potvrzené pozice a open P&L ze všech účtů.").supportedFamilies([.systemMedium, .systemLarge]).pushHandler(AlphaTradeWidgetPushHandler.self) }
}

private struct LockPnLView: View {
    let entry: AlphaTradeEntry
    @Environment(\.widgetFamily) private var family

    @ViewBuilder
    var body: some View {
        if entry.snapshot.isPlaceholder {
            switch family {
            case .accessoryInline:
                Label("P&L čeká na data", systemImage: "icloud.and.arrow.down")
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "icloud.and.arrow.down").widgetAccentable()
                }
            default:
                ATNoDataView(compact: true)
            }
        } else {
        switch family {
        case .accessoryInline:
            Label("P&L \(money(entry.snapshot.dayPnL)) · \(String(format: "%+.2fR", entry.snapshot.dayR))", systemImage: "chart.line.uptrend.xyaxis")
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
                Label("DAILY P&L", systemImage: "dollarsign.circle.fill")
                    .font(.caption2.bold()).widgetAccentable()
                Text(money(entry.snapshot.dayPnL))
                    .font(.headline.bold().monospacedDigit()).privacySensitive()
                Text("\(String(format: "%+.2fR", entry.snapshot.dayR)) · \(entry.snapshot.tradeCount) obchody")
                    .font(.caption2).privacySensitive()
            }
        }
        }
    }
}

private struct LockDisciplineView: View {
    let entry: AlphaTradeEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if entry.snapshot.isPlaceholder {
            ATNoDataView(compact: true)
        } else if family == .accessoryCircular {
            Gauge(value: Double(entry.snapshot.discipline), in: 0...100) {
                Image(systemName: "shield.checkered")
            } currentValueLabel: {
                Text("\(entry.snapshot.discipline)").font(.caption.bold().monospacedDigit())
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .widgetAccentable()
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Label("DISCIPLÍNA", systemImage: "shield.checkered")
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
    let entry: AlphaTradeEntry
    @Environment(\.widgetFamily) private var family

    private var live: AlphaTradeSnapshot.Live? { entry.snapshot.live }

    private var icon: String {
        if entry.snapshot.isLiveStale { return "clock.badge.exclamationmark.fill" }
        if live?.killSwitch == true { return "exclamationmark.octagon.fill" }
        if (live?.dayLockUntil ?? 0) > Date().timeIntervalSince1970 * 1_000 { return "lock.fill" }
        if live?.armed == true { return "bolt.shield.fill" }
        return live?.connected == true ? "pause.circle.fill" : "wifi.slash"
    }

    /// Text musí vycházet ze stejného fail-safe stavu jako ikona. Dřív se bral
    /// jen z `live.armed`, takže vedle varovné ikony mohlo svítit „ARM“
    /// i při zastaralých datech, kill switchi nebo odpojeném workeru.
    private var compactLabel: String {
        if entry.snapshot.isLiveStale { return "?" }
        if live?.killSwitch == true { return "STOP" }
        if (live?.dayLockUntil ?? 0) > Date().timeIntervalSince1970 * 1_000 { return "LOCK" }
        if live?.connected != true { return "OFF" }
        return live?.armed == true ? "ARM" : "LIVE"
    }

    @ViewBuilder
    var body: some View {
        if family == .accessoryCircular {
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 2) {
                    Image(systemName: icon).font(.headline).widgetAccentable()
                    Text(compactLabel).font(.caption2.bold())
                }
            }
        } else if family == .accessoryInline {
            if let live {
                Label("\(live.status) · \(money(live.totalPnl))", systemImage: icon)
                    .privacySensitive()
            } else {
                Label("LIVE čeká na data", systemImage: "icloud.and.arrow.down")
            }
        } else {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.title2).widgetAccentable()
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.snapshot.isLiveStale ? "DATA ZASTARALÁ" : live?.status ?? "ALPHATRADE LIVE").font(.caption.bold())
                    Text(live == nil
                         ? "Otevři appku pro první snapshot"
                         : "\(live?.openPositionCount ?? 0) pozic · \(money(live?.totalPnl ?? 0))")
                        .font(.caption2).privacySensitive()
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
            .pushHandler(AlphaTradeWidgetPushHandler.self)
            .configurationDisplayName("Lock Screen P&L")
            .description("Poslední potvrzené denní P&L a R na zamčené obrazovce.")
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
            .pushHandler(AlphaTradeWidgetPushHandler.self)
            .configurationDisplayName("Lock Screen disciplína")
            .description("Aktuální skóre disciplíny na zamčené obrazovce.")
            .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    }
}

struct LockLiveWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AlphaTradeLockLive", provider: AlphaTradeProvider()) {
            LockLiveView(entry: $0)
                .alphaTradeLockSurface()
                .widgetURL(URL(string: "alphatrade-native://live"))
        }
            .pushHandler(AlphaTradeWidgetPushHandler.self)
            .configurationDisplayName("Lock Screen LIVE")
            .description("Rychle otevře AlphaTrade LIVE bez provedení broker akce.")
            .supportedFamilies([.accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

struct AlphaTradeLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AlphaTradeLiveActivityAttributes.self) { context in
            AlphaTradeLiveActivityLockScreen(context: context)
                .widgetURL(URL(string: "alphatrade-native://live"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(liveActivityPositionLabel(context.state, fallback: context.attributes.symbol))
                        .font(.caption.bold().monospacedDigit())
                        .foregroundStyle(LiveActivityPalette.indigo)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.pnlText)
                        .font(.caption.bold().monospacedDigit())
                        .foregroundStyle(context.state.isPositive ? Color.green : Color.red)
                        .privacySensitive()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 7) {
                        if context.state.mode == "position", context.state.slTpProgress != nil {
                            LiveActivitySlTpBar(state: context.state, compact: true)
                        } else {
                            Text(context.state.headline).font(.caption.bold()).lineLimit(1)
                        }
                    }
                }
            } compactLeading: {
                Text(liveActivityPositionLabel(context.state, fallback: context.attributes.symbol))
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(LiveActivityPalette.indigo)
                    .lineLimit(1)
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
            .keylineTint(LiveActivityPalette.indigo)
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
    @Environment(\.colorScheme) private var colorScheme

    private var background: Color {
        colorScheme == .dark ? LiveActivityPalette.navy : LiveActivityPalette.paper
    }

    private var ink: Color {
        colorScheme == .dark ? .white : LiveActivityPalette.slate
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Image(systemName: "waveform.path.ecg")
                    .foregroundStyle(LiveActivityPalette.indigo)
                Text("ALPHATRADE")
                    .font(.caption.weight(.black))
                    .tracking(0.7)
                Spacer()
                // Po vypršení stale-date už nemáme čerstvá data. Zelené
                // „ARM LIVE" by pak tvrdilo, že se kopíruje, i když je worker
                // dávno mrtvý — fail-closed proto přepíše stav na neověřený.
                LiveActivityStatusPill(status: context.isStale ? "ARM NEOVĚŘEN" : context.state.status)
            }

            switch context.state.mode {
            case "position":
                positionContent
            case "pending":
                pendingContent
            case "idle":
                idleContent
            default:
                legacyContent
            }

            HStack(alignment: .center, spacing: 12) {
                // Bez followersOk (neúplné čtení účtů) řádek schovat — „0/5"
                // by vypadalo jako výpadek followerů, ne jako chybějící data.
                if let total = context.state.followersTotal, total > 0,
                   let ok = context.state.followersOk {
                    LiveActivityFollowersRow(total: total, ok: ok)
                }
                Spacer(minLength: 4)
                armCountdown
            }

            Text("Read-only monitoring · žádná broker akce")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.55) : LiveActivityPalette.muted)
        }
        .padding(16)
        .foregroundStyle(ink)
        .activityBackgroundTint(background)
        .activitySystemActionForegroundColor(ink)
    }

    private var positionContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(liveActivityPositionLabel(context.state, fallback: context.attributes.symbol))
                    .font(.title3.weight(.black))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(context.state.pnlText)
                    .font(.title2.bold().monospacedDigit())
                    .foregroundStyle(context.state.isPositive ? LiveActivityPalette.profit : LiveActivityPalette.loss)
                    .privacySensitive()
            }
            if context.state.stopPrice != nil && context.state.targetPrice != nil
                && context.state.slTpProgress != nil {
                LiveActivitySlTpBar(state: context.state, compact: false)
            } else {
                LiveActivityAvailableLevels(state: context.state)
            }
        }
    }

    private var pendingContent: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("LIMIT \(context.state.side == "Short" ? "SELL" : "BUY") \(liveActivityQuantity(context.state.quantity)) \(context.state.symbol ?? context.attributes.symbol) @ \(liveActivityPrice(context.state.entryPrice ?? context.state.currentPrice))")
                .font(.headline.weight(.black).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text("Čeká na fill · \(context.state.detail)")
                .font(.caption2.weight(.medium))
                .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.65) : LiveActivityPalette.muted)
                .lineLimit(1)
        }
    }

    private var idleContent: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Čeká na obchod")
                .font(.headline.weight(.black))
            Text(context.state.detail)
                .font(.caption2.weight(.medium))
                .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.65) : LiveActivityPalette.muted)
                .lineLimit(1)
        }
    }

    private var legacyContent: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(context.state.headline).font(.headline).lineLimit(1)
                Text(context.state.detail)
                    .font(.caption2)
                    .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.65) : LiveActivityPalette.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(context.state.pnlText)
                .font(.title3.bold().monospacedDigit())
                .foregroundStyle(context.state.isPositive ? LiveActivityPalette.profit : LiveActivityPalette.loss)
                .privacySensitive()
        }
    }

    @ViewBuilder private var armCountdown: some View {
        // Bez čerstvých dat neodpočítáváme — ARM mohl mezitím skončit.
        if let seconds = context.state.armExpiresAt, !context.isStale {
            let expiry = Date(timeIntervalSince1970: seconds)
            if expiry > Date() {
                HStack(spacing: 4) {
                    Text("ARM končí za")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.55) : LiveActivityPalette.muted)
                    Text(timerInterval: Date()...expiry, countsDown: true)
                        .font(.caption2.bold().monospacedDigit())
                        .foregroundStyle(LiveActivityPalette.indigo)
                }
            }
        }
    }
}

private enum LiveActivityPalette {
    static let paper = Color(red: 248 / 255, green: 250 / 255, blue: 252 / 255)
    static let navy = Color(red: 2 / 255, green: 6 / 255, blue: 23 / 255)
    static let slate = Color(red: 15 / 255, green: 23 / 255, blue: 42 / 255)
    static let muted = Color(red: 100 / 255, green: 116 / 255, blue: 139 / 255)
    static let indigo = Color(red: 79 / 255, green: 70 / 255, blue: 229 / 255)
    static let profit = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)
    static let loss = Color(red: 220 / 255, green: 38 / 255, blue: 38 / 255)
    static let warning = Color(red: 217 / 255, green: 119 / 255, blue: 6 / 255)
}

private struct LiveActivityStatusPill: View {
    let status: String

    private var color: Color {
        switch status {
        case "ARM LIVE": return LiveActivityPalette.profit
        case "KILL SWITCH", "DAY-LOCK": return LiveActivityPalette.loss
        case "WORKER OFFLINE", "BROKER OFFLINE", "STUCK OUTBOX", "ARM NEOVĚŘEN": return LiveActivityPalette.warning
        case "SHADOW": return Color.blue
        default: return LiveActivityPalette.muted
        }
    }

    var body: some View {
        Text(status)
            .font(.system(size: 9, weight: .black))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.13), in: Capsule())
    }
}

private struct LiveActivityFollowersRow: View {
    let total: Int
    let ok: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<max(0, total), id: \.self) { index in
                Circle()
                    .fill(index < ok ? LiveActivityPalette.profit : LiveActivityPalette.muted.opacity(0.35))
                    .frame(width: 6, height: 6)
            }
            Text("\(min(max(ok, 0), max(total, 0)))/\(max(total, 0))")
                .font(.caption2.bold().monospacedDigit())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Followeři \(ok) z \(total) připraveni")
    }
}

private struct LiveActivitySlTpBar: View {
    let state: AlphaTradeLiveActivityAttributes.ContentState
    let compact: Bool

    var body: some View {
        VStack(spacing: compact ? 3 : 4) {
            GeometryReader { geometry in
                let progress = min(max(state.slTpProgress ?? 0, 0), 1)
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(LinearGradient(
                            colors: [LiveActivityPalette.loss, LiveActivityPalette.warning, LiveActivityPalette.profit],
                            startPoint: .leading,
                            endPoint: .trailing
                        ))
                    Circle()
                        .fill(Color.white)
                        .overlay(Circle().stroke(LiveActivityPalette.slate.opacity(0.75), lineWidth: 1))
                        .shadow(color: .black.opacity(0.2), radius: 2)
                        .frame(width: compact ? 9 : 12, height: compact ? 9 : 12)
                        .offset(x: max(0, min(geometry.size.width - (compact ? 9 : 12),
                            progress * geometry.size.width - (compact ? 4.5 : 6))))
                }
            }
            .frame(height: compact ? 7 : 9)
            HStack {
                Text("SL \(liveActivityPrice(state.stopPrice))")
                Spacer()
                Text("TP \(liveActivityPrice(state.targetPrice))")
            }
            .font(.system(size: compact ? 8 : 9, weight: .bold, design: .monospaced))
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Vzdálenost mezi stop loss a take profit")
    }
}

private struct LiveActivityAvailableLevels: View {
    let state: AlphaTradeLiveActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 12) {
            if let stop = state.stopPrice {
                Text("SL \(liveActivityPrice(stop))").foregroundStyle(LiveActivityPalette.loss)
            }
            if let target = state.targetPrice {
                Text("TP \(liveActivityPrice(target))").foregroundStyle(LiveActivityPalette.profit)
            }
        }
        .font(.caption2.bold().monospacedDigit())
    }
}

private func liveActivityPositionLabel(
    _ state: AlphaTradeLiveActivityAttributes.ContentState,
    fallback: String
) -> String {
    let side = (state.side ?? "").uppercased()
    let quantity = liveActivityQuantity(state.quantity)
    let symbol = state.symbol ?? fallback
    return [side, quantity, symbol].filter { !$0.isEmpty }.joined(separator: " ")
}

private func liveActivityQuantity(_ value: Double?) -> String {
    guard let value else { return "" }
    return value.rounded() == value ? String(format: "%.0f", value) : String(format: "%.2f", value)
}

private func liveActivityPrice(_ value: Double?) -> String {
    guard let value else { return "—" }
    return value.formatted(.number.precision(.fractionLength(0...2)))
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
        CopierStatusWidget()
        PositionsWidget()
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
