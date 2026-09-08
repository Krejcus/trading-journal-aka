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
        var balanceAvailable: Bool? = nil
        var pnlAvailable: Bool? = nil
        var openPnlAvailable: Bool? = nil
        var lockStatusAvailable: Bool? = nil
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
        var dayKey: String? = nil
        var updatedAt: Double? = nil
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
        let dailyRealizedPnl: Double?
        var dailyRealizedPnlLabel: String? = nil
        var accountsRealizedPnl: Double? = nil
        var accountsRealizedPnlLabel: String? = nil
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
        var workerObservedAt: Double? = nil
        var workerValidUntil: Double? = nil
        var brokerUpdatedAt: Double? = nil
        var brokerValidUntil: Double? = nil
        var realizedPnlAvailable: Bool? = nil
        var openPnlAvailable: Bool? = nil
        var totalPnlAvailable: Bool? = nil
        var positionsAvailable: Bool? = nil
        var ordersAvailable: Bool? = nil
    }

    let version: Int
    let updatedAt: Double
    let journal: Journal?
    let live: Live?
    var evaluationTime: Double? = nil
    private enum CodingKeys: String, CodingKey { case version, updatedAt, journal, live }
    private var now: Double { evaluationTime ?? Date().timeIntervalSince1970 * 1_000 }
    var hasCurrentJournal: Bool {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return journal?.dayKey == formatter.string(from: Date(timeIntervalSince1970: now / 1_000))
    }
    var hasCurrentBroker: Bool { (live?.brokerValidUntil ?? 0) > now }
    var dayPnlAvailable: Bool { live != nil ? hasCurrentBroker && live?.totalPnlAvailable == true : hasCurrentJournal }
    var dayPnlText: String { dayPnlAvailable ? money(dayPnL) : "—" }
    var dayRText: String { hasCurrentJournal ? String(format: "%+.2fR", dayR) : "R —" }
    var tradeCountText: String { hasCurrentJournal ? String(tradeCount) : "—" }
    var riskText: String { hasCurrentJournal ? "\(riskPercent)%" : "—" }
    var positionCountText: String { hasCurrentBroker && live?.positionsAvailable == true ? String(live?.openPositionCount ?? 0) : "—" }
    var displayStatus: String {
        guard let live else { return "ČEKÁ NA DATA" }
        if live.status == "WORKER OFFLINE" || live.status == "BROKER OFFLINE" { return live.status }
        guard (live.workerValidUntil ?? 0) > now else { return "STAV NEOVĚŘEN" }
        if live.killSwitch { return "KILL SWITCH" }
        if ["DIVERGENCE", "STUCK OUTBOX"].contains(live.status) { return live.status }
        if live.dayLockUntil > now { return "DAY-LOCK" }
        if live.cooldownUntil > now { return "COOLDOWN" }
        guard live.connected else { return "BROKER OFFLINE" }
        if live.armed && live.armExpiresAt > 0 && live.armExpiresAt <= now { return "STAV NEOVĚŘEN" }
        if live.armed { return live.shadowMode ? "SHADOW" : "ARM LIVE" }
        return "DISARMED"
    }

    var dayPnL: Double { live?.totalPnl ?? journal?.dayPnl ?? 0 }
    var dayR: Double { journal?.dayR ?? 0 }
    var tradeCount: Int { journal?.tradeCount ?? live?.recentTrades.count ?? 0 }
    var riskPercent: Int { journal?.riskPercent ?? 0 }
    var discipline: Int { journal?.discipline ?? 100 }
    var equity: [Double] {
        if let live { return hasCurrentBroker ? live.equity ?? [] : [] }
        return journal?.equity ?? []
    }
    var accounts: [Account] { live?.accounts ?? journal?.accounts ?? [] }
    var recentTrades: [Trade] { live?.recentTrades ?? journal?.recentTrades ?? [] }
    var isPlaceholder: Bool { updatedAt <= 0 }
    var isLiveStale: Bool {
        guard let live else { return false }
        return (live.workerValidUntil ?? 0) <= now || !hasCurrentBroker
    }
    func evaluated(at date: Date) -> AlphaTradeSnapshot {
        var copy = self
        copy.evaluationTime = date.timeIntervalSince1970 * 1_000
        return copy
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
            dailyRealizedPnl: 320,
            dailyRealizedPnlLabel: "Leader · jen obchody přes kopírku · bez poplatků",
            accountsRealizedPnl: 640,
            accountsRealizedPnlLabel: "Účty (broker, vč. poplatků)",
            losingTrades: 1, followerCount: 5,
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
        AlphaTradeWidgetStore.withDefaults { current(from: $0) } ?? .empty
    }

    static func current(from defaults: UserDefaults) -> AlphaTradeSnapshot {
        guard let json = defaults.string(forKey: "AlphaTradeWidgetSnapshotV2"),
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
        guard let captured = AlphaTradeWidgetStore.withDefaults({ defaults in
            (AlphaTradeSnapshot.current(from: defaults), defaults.string(forKey: tokenKey), defaults.string(forKey: AlphaTradeWidgetStore.generationKey))
        }) else {
            completion(timeline(.empty))
            return
        }
        let current = captured.0
        guard let token = captured.1,
              token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            completion(timeline(current))
            return
        }
        AlphaTradeWidgetPushRegistration.registerIfNeeded()
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 12
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("Widget \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let remote: AlphaTradeSnapshot? = {
                guard let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let data,
                  let remote = try? JSONDecoder().decode(AlphaTradeSnapshot.self, from: data),
                  remote.version == 2 else { return nil }
                return remote
            }()
            let snapshot = AlphaTradeWidgetStore.withDefaults { defaults in
                let latest = AlphaTradeSnapshot.current(from: defaults)
                guard defaults.string(forKey: tokenKey) == token,
                      defaults.string(forKey: AlphaTradeWidgetStore.generationKey) == captured.2 else { return latest }
                guard let remote else { return latest }
                let merged = latest.mergingRemote(remote)
                if let encoded = try? JSONEncoder().encode(merged), let json = String(data: encoded, encoding: .utf8) {
                    defaults.set(json, forKey: snapshotKey)
                }
                return merged
            } ?? .empty
            completion(timeline(snapshot))
        }.resume()
    }

    private func timeline(_ snapshot: AlphaTradeSnapshot) -> Timeline<AlphaTradeEntry> {
        // WidgetKit owns the actual budget. Five minutes is a request, not a
        // promise; urgent ARM/position changes continue through ActivityKit.
        let now = Date()
        let expiries = [snapshot.live?.workerValidUntil, snapshot.live?.brokerValidUntil, snapshot.live?.armExpiresAt]
            .compactMap { $0 }.map { Date(timeIntervalSince1970: $0 / 1_000 + 1) }.filter { $0 > now }
        let midnight = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now))
        let dates = Array(Set([now] + expiries + [midnight].compactMap { $0 })).sorted()
        return Timeline(entries: dates.map { .init(date: $0, snapshot: snapshot.evaluated(at: $0)) },
                        policy: .after(now.addingTimeInterval(5 * 60)))
    }
}

@available(iOS 26.0, *)
private enum AlphaTradeWidgetPushRegistration {
    private static let pushTokenKey = "AlphaTradeWidgetPushTokenV1"
    private static let kindsKey = "AlphaTradeWidgetPushKindsV1"
    private static let registeredSignatureKey = "AlphaTradeWidgetPushRegisteredSignatureV1"
    private static let endpoint = URL(string: "https://alphatrade-mentor-15.vercel.app/api/native-widget-push-subscription")!

    static func receive(pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        let deviceToken = pushInfo.token.map { String(format: "%02x", $0) }.joined()
        let kinds = Array(Set(widgets.map(\.kind))).sorted()
        AlphaTradeWidgetStore.withDefaults { defaults in
            defaults.set(deviceToken, forKey: pushTokenKey)
            defaults.set(kinds, forKey: kindsKey)
        }
        registerIfNeeded()
    }

    static func registerIfNeeded() {
        guard let values = AlphaTradeWidgetStore.withDefaults({ defaults in
            (defaults.string(forKey: AlphaTradeWidgetStore.tokenKey), defaults.string(forKey: pushTokenKey),
             defaults.stringArray(forKey: kindsKey) ?? [], defaults.string(forKey: AlphaTradeWidgetStore.generationKey) ?? "",
             defaults.string(forKey: registeredSignatureKey))
        }), let accessToken = values.0, let deviceToken = values.1,
              accessToken.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              deviceToken.range(of: "^[0-9a-f]{64,512}$", options: .regularExpression) != nil else { return }
        let kinds = values.2
#if DEBUG
        let environment = "development"
#else
        let environment = "production"
#endif
        let signature = "\(values.3):\(environment):\(deviceToken):\(kinds.joined(separator: ","))"
        guard values.4 != signature else { return }
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
            AlphaTradeWidgetStore.withDefaults { defaults in
                guard defaults.string(forKey: AlphaTradeWidgetStore.tokenKey) == accessToken,
                      (defaults.string(forKey: AlphaTradeWidgetStore.generationKey) ?? "") == values.3,
                      defaults.string(forKey: pushTokenKey) == deviceToken,
                      defaults.stringArray(forKey: kindsKey) == kinds else { return }
                defaults.set(signature, forKey: registeredSignatureKey)
            }
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

private func money(_ value: Double, available: Bool = true) -> String {
    available ? value.formatted(.currency(code: "USD").precision(.fractionLength(0...2))) : "—"
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
            Text(entry.snapshot.isPlaceholder ? "Otevři AlphaTrade" : entry.snapshot.live != nil ? entry.snapshot.displayStatus : "Dnešní deník")
                .font(.headline)
            Text(entry.snapshot.isPlaceholder
                 ? "Po prvním načtení se zobrazí skutečná data."
                 : entry.snapshot.isLiveStale ? "Poslední stav nelze ověřit. Obnov data." : entry.snapshot.live?.statusDetail ?? "\(entry.snapshot.tradeCountText) obchodů · \(entry.snapshot.dayPnlText)")
                .font(.caption).foregroundStyle(ATStyle.muted).lineLimit(2)
            Spacer()
            HStack { Text("Risk \(entry.snapshot.riskText)"); Spacer(); Text("\(entry.snapshot.tradeCountText) obchodů v deníku") }
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
                Text(entry.snapshot.dayPnlText).font(.title2.bold().monospacedDigit())
                    .foregroundStyle(entry.snapshot.dayPnL >= 0 ? ATStyle.green : ATStyle.red).privacySensitive()
                Text("Deník · \(entry.snapshot.dayRText)").font(.headline.monospacedDigit()).foregroundStyle(ATStyle.blue)
                Spacer()
                Text("\(entry.snapshot.tradeCountText) obchody · Risk \(entry.snapshot.riskText)").font(.caption2.bold()).foregroundStyle(ATStyle.muted)
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
            ATHeader(title: "EQUITY CURVE", icon: "chart.xyaxis.line", stale: entry.snapshot.isLiveStale)
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
                Text(entry.snapshot.equity.last.map { money($0) } ?? "—").privacySensitive()
            }
                .font(.caption.bold().monospacedDigit()).foregroundStyle(ATStyle.muted)
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://dashboard"))
    }
}

private struct AccountsView: View {
    let entry: AlphaTradeEntry
    @Environment(\.widgetFamily) private var family
    private var visibleAccounts: [AlphaTradeSnapshot.Account] { Array(entry.snapshot.accounts.prefix(family == .systemLarge ? 6 : 2)) }
    private var financialDataFresh: Bool { entry.snapshot.live == nil ? entry.snapshot.hasCurrentJournal : entry.snapshot.hasCurrentBroker }
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ATHeader(title: "ÚČTY", icon: "wallet.bifold.fill", stale: entry.snapshot.isLiveStale)
            if entry.snapshot.accounts.isEmpty {
                Spacer()
                ATNoDataView()
                Spacer()
            }
            ForEach(visibleAccounts, id: \.id) { account in
                HStack {
                    VStack(alignment: .leading) {
                        HStack(spacing: 3) {
                            Text(account.name).font(.caption.bold()).lineLimit(1)
                            if account.locked { Image(systemName: "lock.fill").foregroundStyle(ATStyle.red) }
                            else if (entry.snapshot.live != nil && account.lockStatusAvailable != true) || !financialDataFresh {
                                Image(systemName: "questionmark.shield").foregroundStyle(ATStyle.muted).accessibilityLabel("Zámek účtu není ověřen")
                            }
                        }
                        Text(money(account.balance, available: financialDataFresh && (entry.snapshot.live == nil || account.balanceAvailable == true))).privacySensitive()
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(money(account.pnl, available: financialDataFresh && (entry.snapshot.live == nil || account.pnlAvailable == true))).foregroundStyle(account.pnl >= 0 ? ATStyle.green : ATStyle.red).privacySensitive()
                        if account.openPnl != 0 || account.openPnlAvailable == false { Text("open \(money(account.openPnl, available: financialDataFresh && (entry.snapshot.live == nil || account.openPnlAvailable == true)))").foregroundStyle(ATStyle.muted).privacySensitive() }
                    }
                }.font(.caption2.monospacedDigit())
                if account.id != visibleAccounts.last?.id { Divider() }
            }
            if entry.snapshot.accounts.count > visibleAccounts.count { Text("+\(entry.snapshot.accounts.count - visibleAccounts.count) účtů v aplikaci").font(.caption2).foregroundStyle(ATStyle.muted) }
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://accounts"))
    }
}

private struct DisciplineView: View {
    let entry: AlphaTradeEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "DISCIPLÍNA", icon: "shield.checkered")
            Spacer()
            if !entry.snapshot.hasCurrentJournal {
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
        switch entry.snapshot.displayStatus {
        case "ARM LIVE": return ATStyle.green
        case "SHADOW": return ATStyle.blue
        case "KILL SWITCH", "DIVERGENCE", "STUCK OUTBOX": return ATStyle.red
        case "WORKER OFFLINE", "BROKER OFFLINE", "STAV NEOVĚŘEN", "DAY-LOCK", "COOLDOWN": return .orange
        default: return ATStyle.muted
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ATHeader(title: "COPIER LIVE", icon: "bolt.shield.fill", stale: entry.snapshot.isLiveStale)
            HStack(alignment: .firstTextBaseline) {
                Circle().fill(statusColor).frame(width: 8, height: 8)
                Text(entry.snapshot.displayStatus)
                    .font(.headline).foregroundStyle(statusColor).lineLimit(1).minimumScaleFactor(0.7)
                Spacer()
            }
            Text(entry.snapshot.isLiveStale
                 ? "Stav není čerstvě ověřen. Obnov data."
                 : live?.statusDetail ?? "Otevři AlphaTrade LIVE pro první snapshot.")
                .font(.caption2).foregroundStyle(ATStyle.muted).lineLimit(2)
            Spacer(minLength: 0)
            if let live {
                HStack {
                    Label("\(live.followerCount)", systemImage: "person.2.fill")
                    Spacer()
                    Label(entry.snapshot.positionCountText, systemImage: "chart.bar.fill")
                    Spacer()
                    Text(entry.snapshot.dayPnlText)
                        .foregroundStyle(live.totalPnl >= 0 ? ATStyle.green : ATStyle.red)
                        .privacySensitive()
                }.font(.caption2.bold().monospacedDigit())
                HStack(alignment: .top, spacing: 8) {
                    if let leaderPnl = live.dailyRealizedPnl {
                        copierDailyMetric(
                            label: live.dailyRealizedPnlLabel
                                ?? "Leader · jen obchody přes kopírku · bez poplatků",
                            value: leaderPnl
                        )
                    }
                    copierDailyMetric(
                        label: live.accountsRealizedPnlLabel ?? "Účty (broker, vč. poplatků)",
                        value: live.accountsRealizedPnl ?? live.realizedPnl
                    )
                }
            } else {
                ATNoDataView(compact: true)
            }
            if ["ARM LIVE", "SHADOW"].contains(entry.snapshot.displayStatus),
               let expires = live?.armExpiresAt, expires > Date().timeIntervalSince1970 * 1_000 {
                HStack(spacing: 4) {
                    Text("ARM zbývá").foregroundStyle(ATStyle.muted)
                    Text(timerInterval: Date()...Date(timeIntervalSince1970: expires / 1_000), countsDown: true)
                        .monospacedDigit().foregroundStyle(statusColor)
                }.font(.caption2.bold())
            }
        }.padding().alphaTradeSurface().widgetURL(URL(string: "alphatrade-native://live"))
    }

    private func copierDailyMetric(label: String, value: Double) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 7, weight: .bold))
                .foregroundStyle(ATStyle.muted)
                .lineLimit(2)
                .minimumScaleFactor(0.65)
            Text(money(value))
                .font(.caption2.bold().monospacedDigit())
                .foregroundStyle(value >= 0 ? ATStyle.green : ATStyle.red)
                .privacySensitive()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PositionsView: View {
    let entry: AlphaTradeEntry
    private var live: AlphaTradeSnapshot.Live? { entry.snapshot.live }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ATHeader(title: "OTEVŘENÉ POZICE", icon: "chart.bar.doc.horizontal.fill", stale: entry.snapshot.isLiveStale)
            if !entry.snapshot.hasCurrentBroker || live?.positionsAvailable != true {
                Spacer()
                Text("Pozice nejsou aktuálně ověřené").font(.caption.bold()).foregroundStyle(ATStyle.muted)
                Spacer()
            } else if live?.positions.isEmpty != false {
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
                    Text(money(live.openPnl, available: entry.snapshot.hasCurrentBroker && live.openPnlAvailable == true))
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
    var body: some WidgetConfiguration { StaticConfiguration(kind: "AlphaTradeAccounts", provider: AlphaTradeProvider()) { AccountsView(entry: $0) }.configurationDisplayName("Přehled účtů").description("Zůstatky a denní výsledky.").supportedFamilies([.systemMedium, .systemLarge]).pushHandler(AlphaTradeWidgetPushHandler.self) }
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
            Label("P&L \(entry.snapshot.dayPnlText) · deník \(entry.snapshot.dayRText)", systemImage: "chart.line.uptrend.xyaxis")
                .privacySensitive()
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text("P&L").font(.caption2.bold()).widgetAccentable()
                    Text(entry.snapshot.dayPnlAvailable ? entry.snapshot.dayPnL.formatted(.number.sign(strategy: .always()).precision(.fractionLength(0))) : "—")
                        .font(.caption.bold().monospacedDigit())
                        .minimumScaleFactor(0.65)
                        .privacySensitive()
                }
            }
        default:
            VStack(alignment: .leading, spacing: 3) {
                Label("DAILY P&L", systemImage: "dollarsign.circle.fill")
                    .font(.caption2.bold()).widgetAccentable()
                Text(entry.snapshot.dayPnlText)
                    .font(.headline.bold().monospacedDigit()).privacySensitive()
                Text("Deník \(entry.snapshot.dayRText) · \(entry.snapshot.tradeCountText) obchody")
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
        if !entry.snapshot.hasCurrentJournal {
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
        switch entry.snapshot.displayStatus {
        case "ARM LIVE": return "bolt.shield.fill"
        case "SHADOW": return "eye.fill"
        case "KILL SWITCH", "DIVERGENCE", "STUCK OUTBOX": return "exclamationmark.octagon.fill"
        case "DAY-LOCK", "COOLDOWN": return "lock.fill"
        case "DISARMED": return "pause.circle.fill"
        default: return "clock.badge.exclamationmark.fill"
        }
    }

    /// Text musí vycházet ze stejného fail-safe stavu jako ikona. Dřív se bral
    /// jen z `live.armed`, takže vedle varovné ikony mohlo svítit „ARM“
    /// i při zastaralých datech, kill switchi nebo odpojeném workeru.
    private var compactLabel: String {
        switch entry.snapshot.displayStatus {
        case "ARM LIVE": return "ARM"
        case "SHADOW": return "SHDW"
        case "KILL SWITCH", "DIVERGENCE", "STUCK OUTBOX": return "STOP"
        case "DAY-LOCK", "COOLDOWN": return "LOCK"
        case "DISARMED": return "OFF"
        default: return "?"
        }
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
            if live != nil {
                Label("\(entry.snapshot.displayStatus) · \(entry.snapshot.dayPnlText)", systemImage: icon)
                    .privacySensitive()
            } else {
                Label("LIVE čeká na data", systemImage: "icloud.and.arrow.down")
            }
        } else {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.title2).widgetAccentable()
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.snapshot.displayStatus).font(.caption.bold())
                    Text(live == nil
                         ? "Otevři appku pro první snapshot"
                         : "\(entry.snapshot.positionCountText) pozic · \(entry.snapshot.dayPnlText)")
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
                    Text(context.isStale ? "STAV NEOVĚŘEN" : liveActivityPositionLabel(context.state, fallback: context.attributes.symbol))
                        .font(.caption.bold().monospacedDigit())
                        .foregroundStyle(context.isStale ? Color.orange : LiveActivityPalette.indigo)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(context.isStale ? "—" : context.state.pnlText)
                            .font(.caption.bold().monospacedDigit())
                            .foregroundStyle(context.isStale ? Color.orange : context.state.isPositive ? Color.green : Color.red)
                            .privacySensitive()
                        if let label = context.state.pnlLabel {
                            Text(label).font(.system(size: 7, weight: .semibold)).lineLimit(2)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 7) {
                        if context.isStale {
                            Text("Data jsou zastaralá. Otevři LIVE pro ověření.").font(.caption)
                        } else if context.state.mode == "position", context.state.slTpProgress != nil {
                            LiveActivityLevelBar(state: context.state, compact: true)
                        } else {
                            Text(context.state.headline).font(.caption.bold()).lineLimit(1)
                        }
                    }
                }
            } compactLeading: {
                Text(context.isStale ? "?" : liveActivityPositionLabel(context.state, fallback: context.attributes.symbol))
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(context.isStale ? Color.orange : LiveActivityPalette.indigo)
                    .lineLimit(1)
            } compactTrailing: {
                Text(context.isStale ? "—" : context.state.pnlText)
                    .font(.caption2.bold().monospacedDigit())
                    .foregroundStyle(context.isStale ? Color.orange : context.state.isPositive ? Color.green : Color.red)
                    .privacySensitive()
            } minimal: {
                Image(systemName: context.isStale ? "clock.badge.exclamationmark" : context.state.isPositive ? "chart.line.uptrend.xyaxis" : "exclamationmark.triangle.fill")
                    .foregroundStyle(context.isStale ? Color.orange : context.state.isPositive ? Color.green : Color.orange)
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

    /// Které rozvržení karta dostane. Pořadí je důležité: zastaralá data a
    /// kritické stavy přebíjejí všechno, pozice má přednost před zámkem.
    private enum Layout { case stale, critical, position, summary, locked, cooldown, pending, dayTrades, armedIdle, legacy }

    private var state: AlphaTradeLiveActivityAttributes.ContentState { context.state }
    private var nowSeconds: TimeInterval { Date().timeIntervalSince1970 }

    private var layout: Layout {
        if context.isStale { return .stale }
        if ["DIVERGENCE", "KILL SWITCH", "STUCK OUTBOX"].contains(state.status) { return .critical }
        if state.mode == "position" { return .position }
        if state.mode == "summary" { return .summary }
        if let until = state.dayLockUntil, until > nowSeconds { return .locked }
        if let until = state.cooldownUntil, until > nowSeconds { return .cooldown }
        if state.mode == "pending" { return .pending }
        if state.mode == "idle" { return (state.tradesToday ?? 0) > 0 ? .dayTrades : .armedIdle }
        return .legacy
    }

    private var isCritical: Bool { layout == .critical }

    private var background: Color {
        isCritical ? LiveActivityPalette.critical : (colorScheme == .dark ? LiveActivityPalette.navy : LiveActivityPalette.paper)
    }

    private var ink: Color {
        isCritical || colorScheme == .dark ? .white : LiveActivityPalette.slate
    }

    private var muted: Color {
        isCritical ? Color.white.opacity(0.75) : (colorScheme == .dark ? Color.white.opacity(0.58) : LiveActivityPalette.muted)
    }

    private var pnlColor: Color {
        state.isPositive ? LiveActivityPalette.profit : LiveActivityPalette.loss(colorScheme)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            // Levý sloupec dostane celou zbývající šířku explicitně; s layoutPriority
            // se na zamčeném zámku (redakce citlivého textu) smrskl na nulu.
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    hero
                    subtitle
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                // Text(timerInterval:) si rezervuje šířku pro nejdelší možný čas a
                // bral by půl karty; pravý sloupec proto dostane pevný strop.
                VStack(alignment: .trailing, spacing: 6) {
                    pill
                    freshness
                }
                .frame(maxWidth: 132, alignment: .trailing)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .foregroundStyle(ink)
        .activityBackgroundTint(background)
        .activitySystemActionForegroundColor(ink)
    }

    // MARK: hlavička

    private func heroText(_ text: String, color: Color, size: CGFloat = 34, sensitive: Bool = true) -> some View {
        Text(text)
            .font(.system(size: size, weight: .heavy, design: .rounded).monospacedDigit())
            .tracking(-0.5)
            .foregroundStyle(color)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            // Jen peníze jsou citlivé; „LIVE" nebo název stavu musí být vidět i na zamčeném zámku.
            .privacySensitive(sensitive)
    }

    @ViewBuilder private var hero: some View {
        switch layout {
        case .stale:
            heroText("—", color: .orange, sensitive: false)
        case .critical:
            heroText(state.status, color: .white, size: 26, sensitive: false)
        case .position, .legacy:
            heroText(liveActivityCompactPnl(state), color: pnlColor)
        case .summary, .dayTrades:
            let text = state.dayPnlText ?? liveActivityCompactPnl(state)
            heroText(text, color: text.hasPrefix("−") || text.hasPrefix("-") ? LiveActivityPalette.loss(colorScheme) : LiveActivityPalette.profit)
        case .armedIdle:
            heroText("LIVE", color: LiveActivityPalette.profit, sensitive: false)
        case .locked:
            // Odpočet tiká lokálně; po vypršení se karta sama přepne na další stav.
            Text(timerInterval: Date()...Date(timeIntervalSince1970: state.dayLockUntil ?? nowSeconds), countsDown: true)
                .font(.system(size: 34, weight: .heavy, design: .rounded).monospacedDigit())
                .foregroundStyle(LiveActivityPalette.loss(colorScheme))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        case .cooldown:
            Text(timerInterval: Date()...Date(timeIntervalSince1970: state.cooldownUntil ?? nowSeconds), countsDown: true)
                .font(.system(size: 34, weight: .heavy, design: .rounded).monospacedDigit())
                .foregroundStyle(LiveActivityPalette.warning)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        case .pending:
            heroText("LIMIT \(state.side == "Short" ? "SELL" : "BUY")", color: LiveActivityPalette.indigo(colorScheme), size: 26, sensitive: false)
        }
    }

    private var copyingSuffix: String {
        guard let total = state.followersTotal, total > 0, let ok = state.followersOk else { return "" }
        return " · kopíruje se \(min(max(ok, 0), total))/\(total)"
    }

    private func dayCountsText(prefix: String) -> String {
        var parts: [String] = [prefix]
        if let trades = state.tradesToday { parts.append(liveActivityPlural(trades, "obchod", "obchody", "obchodů")) }
        if let losing = state.losingTrades, losing > 0 { parts.append(losing == 1 ? "1 ztrátový" : "\(losing) ztrátových") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var subtitle: some View {
        HStack(spacing: 0) {
            switch layout {
            case .stale:
                Text("Data jsou zastaralá").font(.system(size: 13, weight: .bold))
            case .critical:
                Text(state.detail).font(.system(size: 13, weight: .bold)).lineLimit(2)
            case .position:
                Text(liveActivityPositionLabel(state, fallback: context.attributes.symbol)).font(.system(size: 13, weight: .bold))
                Text(copyingSuffix).font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(muted)
            case .dayTrades:
                Text("Dnes").font(.system(size: 13, weight: .bold))
                Text(" · " + dayCountsText(prefix: "").trimmingCharacters(in: CharacterSet(charactersIn: " ·")) + copyingSuffix)
                    .font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(muted)
            case .armedIdle:
                Text(copyingSuffix.isEmpty ? "Kopírka je zapnutá" : String(copyingSuffix.dropFirst(3)).prefix(1).uppercased() + String(copyingSuffix.dropFirst(4)))
                    .font(.system(size: 13, weight: .bold).monospacedDigit())
                if let armedAt = state.armedAt {
                    Text(" · zapnuto \(liveActivityClock(armedAt))").font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(muted)
                }
            case .summary:
                Text("Den uzavřen").font(.system(size: 13, weight: .bold))
                Text(" · " + dayCountsText(prefix: "").trimmingCharacters(in: CharacterSet(charactersIn: " ·")))
                    .font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(muted)
            case .locked:
                Text("Zamčeno do \(liveActivityClock(state.dayLockUntil ?? nowSeconds))").font(.system(size: 13, weight: .bold).monospacedDigit())
                if let reason = state.dayLockReason, !reason.isEmpty {
                    Text(" · \(reason)").font(.system(size: 13, weight: .semibold)).foregroundStyle(muted)
                }
            case .cooldown:
                Text("Cooldown po obchodu").font(.system(size: 13, weight: .bold))
                Text(" · do \(liveActivityClock(state.cooldownUntil ?? nowSeconds))").font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(muted)
            case .pending:
                Text("\(liveActivityQuantity(state.quantity)) \(state.symbol ?? context.attributes.symbol) @ \(liveActivityPrice(state.entryPrice ?? state.currentPrice))")
                    .font(.system(size: 13, weight: .bold).monospacedDigit())
                Text(copyingSuffix).font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(muted)
            case .legacy:
                Text(state.headline).font(.system(size: 13, weight: .bold))
            }
        }
        .lineLimit(1)
    }

    @ViewBuilder private var pill: some View {
        switch layout {
        case .stale:
            LiveActivityStatusPill(status: "STAV NEOVĚŘEN")
        case .critical:
            Text("VYPNUTO")
                .font(.system(size: 11, weight: .black)).tracking(0.8)
                .foregroundStyle(.white)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Color.white.opacity(0.22), in: Capsule())
        case .armedIdle:
            EmptyView() // hero už říká LIVE
        case .summary:
            LiveActivityStatusPill(status: "DISARMED")
        default:
            LiveActivityStatusPill(status: state.status)
        }
    }

    /// „před X s" tiká lokálně bez pushe; s 5s tikem serveru hned prozradí,
    /// když aktualizace stojí, ještě před 30s stale-date. Shrnutí dne ukazuje
    /// čas vypnutí místo stárnoucího „před".
    @ViewBuilder private var freshness: some View {
        if layout == .summary {
            Text(liveActivityClock(state.updatedAt))
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundStyle(muted)
        } else if !context.isStale {
            let updated = Date(timeIntervalSince1970: state.updatedAt)
            HStack(spacing: 3) {
                Text("před")
                Text(timerInterval: updated...updated.addingTimeInterval(24 * 3_600), countsDown: false, showsHours: false)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 44, alignment: .trailing)
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(muted)
            .lineLimit(1)
        }
    }

    // MARK: obsah

    @ViewBuilder private var content: some View {
        switch layout {
        case .stale:
            Text("Data jsou zastaralá. Otevři LIVE pro ověření.")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(muted)
        case .critical:
            criticalContent
        case .position:
            positionContent
        case .summary:
            summaryContent
        case .locked, .cooldown:
            VStack(alignment: .leading, spacing: 8) {
                if let last = state.dayTrades?.last {
                    LiveActivityLastTradeRow(trade: last, dayPnlText: state.dayPnlText, colorScheme: colorScheme, muted: muted)
                }
                LiveActivityLimitsLine(state: state, muted: muted, colorScheme: colorScheme)
            }
        case .pending:
            Text("Čeká na fill · \(state.detail)")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(muted)
                .lineLimit(1)
        case .dayTrades:
            VStack(alignment: .leading, spacing: 8) {
                if let trades = state.dayTrades, !trades.isEmpty {
                    LiveActivityTradeChips(trades: trades, colorScheme: colorScheme)
                }
                LiveActivityLimitsLine(state: state, muted: muted, colorScheme: colorScheme)
            }
        case .armedIdle:
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 0) {
                    Text("Čeká na první obchod")
                    if let end = state.sessionEndAt {
                        Text(" · session končí ").foregroundStyle(muted)
                        Text(liveActivityClock(end)).monospacedDigit()
                    }
                }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(muted)
                .lineLimit(1)
                LiveActivityLimitsLine(state: state, muted: muted, colorScheme: colorScheme)
            }
        case .legacy:
            Text(state.detail)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(muted)
                .lineLimit(2)
        }
    }

    private var criticalContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Kopírka se odzbrojila a nic neposílá. Otevři LIVE a srovnej účty ručně.")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.white.opacity(0.85))
                .lineLimit(2)
            if state.side != nil, state.quantity != nil {
                HStack {
                    Text("\(liveActivityPositionLabel(state, fallback: context.attributes.symbol)) · otevřeno")
                    Spacer(minLength: 8)
                    Text(liveActivityCompactPnl(state)).privacySensitive()
                }
                .font(.system(size: 11, weight: .bold).monospacedDigit())
                .foregroundStyle(Color.white.opacity(0.85))
                .padding(.top, 8)
                .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.15)).frame(height: 1) }
            }
        }
    }

    private var summaryContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let trades = state.dayTrades, !trades.isEmpty {
                LiveActivityTradeChips(trades: trades, colorScheme: colorScheme)
                let best = trades.map(\.pnl).max() ?? 0
                let worst = trades.map(\.pnl).min() ?? 0
                let planned = trades.filter { $0.exit == "SL" || $0.exit == "TP" }.count
                Text("Nejlepší \(liveActivitySignedWhole(best)) · nejhorší \(liveActivitySignedWhole(worst)) · \(planned)/\(trades.count) podle plánu")
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(muted)
                    .lineLimit(1)
                    .privacySensitive()
            } else {
                Text("Dnes bez obchodu přes kopírku.")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(muted)
            }
        }
    }

    private var positionContent: some View {
        let distances = liveActivityLevelDistances(state)
        return VStack(alignment: .leading, spacing: 8) {
            LiveActivityLevelBar(state: state, compact: false)
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(distances.toStop.map { "\(liveActivityPoints($0)) b k SL" } ?? "SL —")
                        .font(.system(size: 10, weight: .heavy).monospacedDigit())
                        .tracking(0.4)
                    Text(state.stopPnlText ?? "—")
                        .font(.system(size: 13, weight: .heavy).monospacedDigit())
                        .privacySensitive()
                }
                .foregroundStyle(LiveActivityPalette.loss(colorScheme))
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(distances.toTarget.map { "\(liveActivityPoints($0)) b k TP" } ?? "TP —")
                        .font(.system(size: 10, weight: .heavy).monospacedDigit())
                        .tracking(0.4)
                    Text(state.targetPnlText ?? "—")
                        .font(.system(size: 13, weight: .heavy).monospacedDigit())
                        .privacySensitive()
                }
                .foregroundStyle(LiveActivityPalette.profit)
            }
        }
    }
}

/// Obchody dne jako čipy (L2 / L5): posledních pět, v pořadí, jak přišly.
private struct LiveActivityTradeChips: View {
    let trades: [AlphaTradeLiveActivityAttributes.ContentState.DayTrade]
    let colorScheme: ColorScheme

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(trades.suffix(5).enumerated()), id: \.offset) { _, trade in
                let positive = trade.pnl >= 0
                Text("\(trade.exit == "M" ? "M" : trade.exit) \(liveActivitySignedWhole(trade.pnl))")
                    .font(.system(size: 11, weight: .heavy).monospacedDigit())
                    .foregroundStyle(positive ? LiveActivityPalette.profit : LiveActivityPalette.loss(colorScheme))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background((positive ? LiveActivityPalette.profit : LiveActivityPalette.loss).opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
                    .lineLimit(1)
                    .privacySensitive()
            }
        }
    }
}

/// Poslední obchod v jednom řádku (K3): značka výstupu, výsledek, denní P&L.
private struct LiveActivityLastTradeRow: View {
    let trade: AlphaTradeLiveActivityAttributes.ContentState.DayTrade
    let dayPnlText: String?
    let colorScheme: ColorScheme
    let muted: Color

    var body: some View {
        let positive = trade.pnl >= 0
        HStack(spacing: 8) {
            Text(trade.exit == "M" ? "M" : trade.exit)
                .font(.system(size: 9, weight: .black)).tracking(0.6)
                .foregroundStyle(positive ? LiveActivityPalette.profit : LiveActivityPalette.loss(colorScheme))
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background((positive ? LiveActivityPalette.profit : LiveActivityPalette.loss).opacity(0.14), in: Capsule())
            Text(liveActivitySignedWhole(trade.pnl))
                .font(.system(size: 15, weight: .heavy).monospacedDigit())
                .foregroundStyle(positive ? LiveActivityPalette.profit : LiveActivityPalette.loss(colorScheme))
                .privacySensitive()
            Text(liveActivityClock(trade.closedAt))
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundStyle(muted)
            Spacer(minLength: 4)
            if let day = dayPnlText {
                Text("dnes \(day)")
                    .font(.system(size: 13, weight: .heavy).monospacedDigit())
                    .foregroundStyle(day.hasPrefix("−") || day.hasPrefix("-") ? LiveActivityPalette.loss(colorScheme) : LiveActivityPalette.profit)
                    .privacySensitive()
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Limity dne v jednom řádku (L2 / L4 / K3); pravidlo blízko limitu oranžově,
/// spuštěné červeně. Vypnutá pravidla (bez limitu) se nezobrazují.
private struct LiveActivityLimitsLine: View {
    let state: AlphaTradeLiveActivityAttributes.ContentState
    let muted: Color
    let colorScheme: ColorScheme

    private func tone(current: Double, limit: Double) -> Color {
        if current >= limit { return LiveActivityPalette.loss(colorScheme) }
        if limit > 1 && current >= limit - 1 || current >= limit * 0.8 { return LiveActivityPalette.warning }
        return .white
    }

    var body: some View {
        HStack(spacing: 10) {
            if let max = state.maxLosingTrades {
                let losing = state.losingTrades ?? 0
                item("Ztrátové", "\(losing)/\(max)", tone(current: Double(losing), limit: Double(max)))
            }
            if let limit = state.dailyLossLimitUsd {
                let loss = state.dayLossUsd ?? 0
                item("Ztráta", "$\(Int(loss.rounded())) / \(Int(limit.rounded()))", tone(current: loss, limit: limit))
            }
            if let max = state.maxTrades {
                let trades = state.tradesToday ?? 0
                item("Obchody", "\(trades) / \(max)", tone(current: Double(trades), limit: Double(max)))
            }
        }
        .font(.system(size: 11, weight: .semibold).monospacedDigit())
        .lineLimit(1)
        .minimumScaleFactor(0.85)
    }

    private func item(_ label: String, _ value: String, _ color: Color) -> some View {
        HStack(spacing: 3) {
            Text(label).foregroundStyle(muted)
            Text(value).font(.system(size: 11, weight: .heavy).monospacedDigit()).foregroundStyle(color)
        }
    }
}

private func liveActivityClock(_ seconds: Double) -> String {
    Date(timeIntervalSince1970: seconds).formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
}

private func liveActivitySignedWhole(_ value: Double) -> String {
    "\(value < 0 ? "−" : "+")$\(Int(abs(value).rounded()))"
}

private func liveActivityPlural(_ count: Int, _ one: String, _ few: String, _ many: String) -> String {
    switch count {
    case 1: return "1 \(one)"
    case 2...4: return "\(count) \(few)"
    default: return "\(count) \(many)"
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
    /// Celá karta při DIVERGENCE / KILL SWITCH / STUCK OUTBOX.
    static let critical = Color(red: 127 / 255, green: 29 / 255, blue: 29 / 255)

    /// Na tmavém pozadí (zamčená obrazovka je skoro vždy tmavá) mají tyhle
    /// akcenty kontrast pod 4 : 1 a drobný text je špatně čitelný. Světlejší
    /// varianty jsou určené jen pro tmavý režim.
    static let indigoOnDark = Color(red: 165 / 255, green: 160 / 255, blue: 250 / 255)
    static let lossOnDark = Color(red: 248 / 255, green: 113 / 255, blue: 113 / 255)

    static func indigo(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? indigoOnDark : indigo
    }

    static func loss(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? lossOnDark : loss
    }
}

private struct LiveActivityStatusPill: View {
    let status: String

    private var color: Color {
        switch status {
        case "ARM LIVE": return LiveActivityPalette.profit
        case "KILL SWITCH", "DAY-LOCK", "DIVERGENCE": return LiveActivityPalette.loss
        case "WORKER OFFLINE", "BROKER OFFLINE", "STUCK OUTBOX", "ARM NEOVĚŘEN", "STAV NEOVĚŘEN", "COOLDOWN": return LiveActivityPalette.warning
        case "SHADOW": return Color.blue
        default: return LiveActivityPalette.muted
        }
    }

    /// Na zámku stačí „LIVE"; význam „armed" nese barva a to, že aktivita existuje.
    private var label: String {
        switch status {
        case "ARM LIVE": return "LIVE"
        case "DISARMED": return "VYPNUTO"
        default: return status
        }
    }

    var body: some View {
        Text(label)
            .font(.system(size: 11, weight: .black))
            .tracking(0.8)
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(color.opacity(0.13), in: Capsule())
    }
}

/// Přechodová lišta SL→TP (J5D): svítí jen od SL po aktuální cenu, zbytek
/// k TP je zhasnutý; bílá čárka jen přes lištu, bílá cena nad ní, zářez na
/// vstupu a ceny SL / vstup / TP pod lištou.
private struct LiveActivityLevelBar: View {
    let state: AlphaTradeLiveActivityAttributes.ContentState
    let compact: Bool

    private var progress: CGFloat {
        if let value = state.slTpProgress { return CGFloat(min(max(value, 0), 1)) }
        guard let stop = state.stopPrice, let target = state.targetPrice, let current = state.currentPrice,
              stop != target else { return 0.5 }
        return CGFloat(min(max((current - stop) / (target - stop), 0), 1))
    }

    private var entryProgress: CGFloat? {
        guard let stop = state.stopPrice, let target = state.targetPrice, let entry = state.entryPrice,
              stop != target else { return nil }
        return CGFloat(min(max((entry - stop) / (target - stop), 0), 1))
    }

    private var barHeight: CGFloat { compact ? 7 : 10 }
    private var labelSize: CGFloat { compact ? 9 : 10 }
    private let priceLabelHalfWidth: CGFloat = 34

    var body: some View {
        VStack(spacing: compact ? 2 : 4) {
            // Aktuální cena nad čárkou, u krajů přitažená dovnitř.
            GeometryReader { geometry in
                let x = min(max(progress * geometry.size.width, priceLabelHalfWidth), geometry.size.width - priceLabelHalfWidth)
                Text(liveActivityPrice(state.currentPrice))
                    .font(.system(size: compact ? 10 : 12, weight: .heavy).monospacedDigit())
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .position(x: x, y: geometry.size.height / 2)
            }
            .frame(height: compact ? 12 : 14)

            GeometryReader { geometry in
                let width = geometry.size.width
                let gradient = LinearGradient(
                    colors: [LiveActivityPalette.loss, LiveActivityPalette.warning, LiveActivityPalette.profit],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.10))
                    Capsule()
                        .fill(gradient)
                        .mask(alignment: .leading) {
                            Rectangle().frame(width: max(0, width * progress))
                        }
                    if let entry = entryProgress {
                        Rectangle()
                            .fill(Color.white.opacity(0.85))
                            .frame(width: 2, height: barHeight + 8)
                            .offset(x: entry * width - 1)
                    }
                    Rectangle()
                        .fill(Color.white)
                        .frame(width: 2, height: barHeight)
                        .offset(x: min(max(progress * width - 1, 0), width - 2))
                }
            }
            .frame(height: barHeight)

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    HStack {
                        Text("SL \(liveActivityPrice(state.stopPrice))")
                            .foregroundStyle(LiveActivityPalette.lossOnDark)
                        Spacer(minLength: 4)
                        Text("TP \(liveActivityPrice(state.targetPrice))")
                            .foregroundStyle(LiveActivityPalette.profit)
                    }
                    if !compact, let entry = entryProgress, let entryPrice = state.entryPrice {
                        Text("vstup \(liveActivityPrice(entryPrice))")
                            .foregroundStyle(Color.white.opacity(0.58))
                            .position(x: min(max(entry * geometry.size.width, 46), geometry.size.width - 46), y: geometry.size.height / 2)
                    }
                }
                .font(.system(size: labelSize, weight: .bold).monospacedDigit())
                .lineLimit(1)
            }
            .frame(height: compact ? 11 : 12)
        }
    }
}

/// Hero číslo bez centů; server posílá `pnlCompactText`, starší payload se ořízne.
private func liveActivityCompactPnl(_ state: AlphaTradeLiveActivityAttributes.ContentState) -> String {
    if let compact = state.pnlCompactText, !compact.isEmpty { return compact }
    let text = state.pnlText
    return text.hasSuffix(".00") ? String(text.dropLast(3)) : text
}

/// Body k SL / TP ve směru P&L: k SL vždy záporné, k TP kladné (long i short).
private func liveActivityLevelDistances(
    _ state: AlphaTradeLiveActivityAttributes.ContentState
) -> (toStop: Double?, toTarget: Double?) {
    guard let current = state.currentPrice else { return (nil, nil) }
    let direction: Double = (state.side ?? "Long") == "Short" ? -1 : 1
    return (state.stopPrice.map { ($0 - current) * direction }, state.targetPrice.map { ($0 - current) * direction })
}

private func liveActivityPoints(_ value: Double) -> String {
    let magnitude = abs(value).formatted(.number.precision(.fractionLength(0...2)))
    return "\(value < 0 ? "−" : "+")\(magnitude)"
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
