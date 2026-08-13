import SwiftUI

struct TodayView: View {
    @Environment(NativeLabStore.self) private var store

    private var isRemote: Bool { if case .connected = store.remoteConnection { true } else { false } }
    private var dashboardTrades: [TradeRecord] { store.dashboardTrades }
    private var sampleCount: Int { dashboardTrades.count }
    private var wins: [TradeRecord] { dashboardTrades.filter { $0.result > 0 } }
    private var losses: [TradeRecord] { dashboardTrades.filter { $0.result < 0 } }
    private var netPnL: Double { dashboardTrades.reduce(0) { $0 + $1.result } }
    private var winRate: Double { dashboardTrades.isEmpty ? 0 : Double(wins.count) / Double(dashboardTrades.count) * 100 }
    private var profitFactor: Double {
        let loss = abs(losses.reduce(0) { $0 + $1.result })
        return loss == 0 ? 0 : wins.reduce(0) { $0 + $1.result } / loss
    }
    private var averageR: Double { dashboardTrades.isEmpty ? 0 : dashboardTrades.reduce(0) { $0 + $1.rMultiple } / Double(dashboardTrades.count) }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                sampleSize
                pnlCard
                calendar
                kpiGrid
                streaks
                equity
                monteCarlo
                averageWinLoss
                sessionPerformance
                confluencePerformance
                recentTrades
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 18)
        }
        .tradeScreen()
    }

    private var sampleSize: some View {
        TradeCard(padding: 13) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("SAMPLE-SIZE").font(.caption.bold()).foregroundStyle(TradeTheme.secondary)
                    Text("\(sampleCount)").font(.system(size: 28, weight: .black, design: .rounded).monospacedDigit())
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 3) {
                    StatusPill(text: "SOLIDNÍ VZOREK", color: TradeTheme.success)
                    Text("\(wins.count)V · \(losses.count)P").font(.caption.monospacedDigit()).foregroundStyle(TradeTheme.secondary)
                }
            }
        }
    }

    private var pnlCard: some View {
        TradeCard(padding: 14) {
            VStack(spacing: 13) {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("NET P&L").font(.caption2.bold()).tracking(0.8).foregroundStyle(TradeTheme.muted)
                        Text(netPnL.usd).font(.system(size: 28, weight: .black, design: .rounded).monospacedDigit()).foregroundStyle(netPnL >= 0 ? TradeTheme.success : TradeTheme.danger)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text("DAY WIN %").font(.caption2.bold()).foregroundStyle(TradeTheme.muted)
                        Text(String(format: "%.1f%%", winRate)).font(.headline.monospacedDigit()).foregroundStyle(TradeTheme.blue)
                    }
                }
                GeometryReader { geo in
                    let values = chartValues
                    Canvas { context, size in
                        let step = size.width / CGFloat(values.count - 1)
                        var path = Path()
                        for (index, value) in values.enumerated() {
                            let point = CGPoint(x: CGFloat(index) * step, y: size.height - value / 80 * size.height)
                            index == 0 ? path.move(to: point) : path.addLine(to: point)
                        }
                        context.stroke(path, with: .linearGradient(Gradient(colors: [TradeTheme.blue, TradeTheme.success]), startPoint: .zero, endPoint: CGPoint(x: size.width, y: 0)), lineWidth: 2.2)
                    }
                }.frame(height: 62)
            }
        }
    }

    private var calendar: some View {
        TradeCard(padding: 13) {
            VStack(spacing: 10) {
                HStack { SectionHeading(title: monthTitle, detail: "MĚSÍČNÍ P&L \(monthPnL.usd)"); Spacer(minLength: 0) }
                HStack { ForEach(["PO", "ÚT", "ST", "ČT", "PÁ"], id: \.self) { Text($0).font(.caption2.bold()).foregroundStyle(TradeTheme.muted).frame(maxWidth: .infinity) } }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 5), spacing: 4) {
                    ForEach(1...15, id: \.self) { day in
                        VStack(spacing: 3) {
                            Text("\(day)").font(.caption2.bold())
                            Text(dayLabel(day))
                                .font(.system(size: 7, weight: .bold)).foregroundStyle(dayPnL(day) < 0 ? TradeTheme.danger : TradeTheme.success)
                        }
                        .frame(maxWidth: .infinity, minHeight: 36)
                        .background(dayPnL(day) == 0 ? TradeTheme.raised : (dayPnL(day) > 0 ? TradeTheme.success : TradeTheme.danger).opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
                    }
                }
            }
        }
    }

    private var kpiGrid: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                metric("TRADE WIN %", String(format: "%.0f%%", winRate), TradeTheme.blue)
                metric("PROFIT FACTOR", String(format: "%.2f", profitFactor), TradeTheme.success)
            }
            HStack(spacing: 8) {
                metric("AVG R", String(format: "%+.2fR", averageR), averageR >= 0 ? TradeTheme.success : TradeTheme.danger)
                metric("MAX DRAWDOWN", maxDrawdown.usd, TradeTheme.danger)
            }
        }
    }

    private func metric(_ title: String, _ value: String, _ color: Color) -> some View {
        TradeCard(padding: 13) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.caption2.bold()).foregroundStyle(TradeTheme.muted)
                Text(value).font(.title3.bold().monospacedDigit()).foregroundStyle(color)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var equity: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "Equity křivka", detail: netPnL.usd)
                GeometryReader { geo in
                    let values = chartValues
                    Canvas { context, size in
                        for line in 0...3 {
                            let y = size.height * CGFloat(line) / 3
                            context.stroke(Path { $0.move(to: CGPoint(x: 0, y: y)); $0.addLine(to: CGPoint(x: size.width, y: y)) }, with: .color(TradeTheme.border), lineWidth: 1)
                        }
                        var path = Path()
                        for (index, value) in values.enumerated() {
                            let p = CGPoint(x: CGFloat(index) * size.width / CGFloat(values.count - 1), y: size.height - value / 90 * size.height)
                            index == 0 ? path.move(to: p) : path.addLine(to: p)
                        }
                        context.stroke(path, with: .color(TradeTheme.blue), lineWidth: 2.4)
                    }
                }.frame(height: 150)
            }
        }
    }

    private var discipline: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "Disciplína", detail: "92 %")
                ProgressView(value: 0.92).tint(TradeTheme.success)
                HStack { label("PLÁN", "96 %"); label("RISK", "100 %"); label("TRPĚLIVOST", "81 %") }
            }
        }
    }

    private var streaks: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "Current streak", detail: "AKTUÁLNÍ")
                HStack(spacing: 8) {
                    compactMetric("DAYS", "\(currentDayStreak)", "best \(longestDayStreak)", TradeTheme.blue)
                    compactMetric("TRADES", "\(currentTradeStreak)", "best \(longestTradeStreak)", currentTradeStreak >= 0 ? TradeTheme.success : TradeTheme.danger)
                }
            }
        }
    }

    private func compactMetric(_ title: String, _ value: String, _ detail: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption2.bold()).foregroundStyle(TradeTheme.muted)
            Text(value).font(.title2.bold().monospacedDigit()).foregroundStyle(color)
            Text(detail).font(.caption2).foregroundStyle(TradeTheme.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(10).background(TradeTheme.raised, in: RoundedRectangle(cornerRadius: 6))
    }

    private var monteCarlo: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack { SectionHeading(title: "Monte Carlo", detail: "600 SIM. · \(dashboardTrades.count) OBCHODŮ"); Spacer(); Image(systemName: "arrow.up.right.square").foregroundStyle(TradeTheme.muted) }
                Text("Kam až se může equity reálně rozejít při stejné edge.").font(.caption).foregroundStyle(TradeTheme.secondary)
                GeometryReader { geo in
                    Canvas { context, size in
                        for index in 0..<9 {
                            var path = Path(); let offset = CGFloat(index - 4) * 4
                            path.move(to: CGPoint(x: 0, y: size.height * 0.62))
                            path.addCurve(to: CGPoint(x: size.width, y: size.height * 0.35 + offset), control1: CGPoint(x: size.width * 0.35, y: size.height * (0.72 - CGFloat(index) * 0.025)), control2: CGPoint(x: size.width * 0.72, y: size.height * (0.24 + CGFloat(index) * 0.02)))
                            context.stroke(path, with: .color(index == 4 ? TradeTheme.blue : TradeTheme.blue.opacity(0.13)), lineWidth: index == 4 ? 2 : 1)
                        }
                    }
                }.frame(height: 96)
                HStack { compactMetric("P5", monteCarloStats.p5.usd, "nepříznivý", TradeTheme.danger); compactMetric("P50", monteCarloStats.p50.usd, "medián", TradeTheme.blue); compactMetric("P95", monteCarloStats.p95.usd, "příznivý", TradeTheme.success) }
                HStack { label("RIZIKO ZTRÁTY", String(format: "%.0f %%", monteCarloStats.lossRisk * 100)); label("MAX DRAWDOWN", maxDrawdown.usd); label("RIZIKO RUINU", String(format: "%.1f %%", monteCarloStats.ruinRisk * 100)) }
            }
        }
    }

    private var averageWinLoss: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "Avg win/loss trade", detail: "USD")
                HStack {
                    compactMetric("AVG WIN", averageWin.usd, "\(wins.count) obchodů", TradeTheme.success)
                    compactMetric("AVG LOSS", averageLoss.usd, "\(losses.count) obchodů", TradeTheme.danger)
                }
            }
        }
    }

    private var sessionPerformance: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "Výkon sessions", detail: "NET P&L")
                ForEach(sessionRows, id: \.0) { row in
                    HStack { Text(row.0).font(.subheadline.bold()); Spacer(); Text("\(row.2) trades").font(.caption).foregroundStyle(TradeTheme.muted); Text(row.1.usd).font(.subheadline.bold().monospacedDigit()).foregroundStyle(row.1 >= 0 ? TradeTheme.success : TradeTheme.danger) }
                    if row.0 != sessionRows.last?.0 { Divider() }
                }
            }
        }
    }

    private var confluencePerformance: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "WR dle počtu confluencí", detail: "EDGE")
                ForEach(confluenceRows, id: \.0) { row in performanceBar(row.0, value: row.1, detail: "\(row.2)×") }
            }
        }
    }

    private func performanceBar(_ title: String, value: Double, detail: String) -> some View {
        VStack(spacing: 5) {
            HStack { Text(title).font(.caption.bold()); Spacer(); Text(detail).font(.caption2).foregroundStyle(TradeTheme.muted); Text(String(format: "%.0f%% WR", value * 100)).font(.caption.bold().monospacedDigit()) }
            ProgressView(value: value).tint(value >= 0.5 ? TradeTheme.success : TradeTheme.blue)
        }
    }

    private func label(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) { Text(title).font(.caption2.bold()).foregroundStyle(TradeTheme.muted); Text(value).font(.subheadline.bold().monospacedDigit()) }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var recentTrades: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "Poslední obchody", detail: "VŠECHNY")
                ForEach(store.trades.prefix(3)) { trade in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) { Text(trade.symbol).font(.subheadline.bold()); Text(trade.setup).font(.caption).foregroundStyle(TradeTheme.secondary).lineLimit(1) }
                        Spacer()
                        Text(trade.result.usd).font(.subheadline.bold().monospacedDigit()).foregroundStyle(trade.result >= 0 ? TradeTheme.success : TradeTheme.danger)
                    }
                }
            }
        }
    }

    private var maxDrawdown: Double {
        var equity = 0.0
        var peak = 0.0
        var drawdown = 0.0
        for trade in dashboardTrades.sorted(by: { $0.timestamp < $1.timestamp }) {
            equity += trade.result
            peak = max(peak, equity)
            drawdown = max(drawdown, peak - equity)
        }
        return drawdown
    }

    private var averageWin: Double { wins.isEmpty ? 0 : wins.reduce(0) { $0 + $1.result } / Double(wins.count) }
    private var averageLoss: Double { losses.isEmpty ? 0 : losses.reduce(0) { $0 + $1.result } / Double(losses.count) }
    private var currentTradeStreak: Int {
        guard let first = dashboardTrades.first, first.result != 0 else { return 0 }
        return dashboardTrades.prefix { ($0.result >= 0) == (first.result >= 0) }.count * (first.result >= 0 ? 1 : -1)
    }
    private var longestTradeStreak: Int {
        var best = 0, current = 0, lastSign: Bool?
        for trade in dashboardTrades.sorted(by: { $0.timestamp < $1.timestamp }) where trade.result != 0 {
            let sign = trade.result > 0; current = sign == lastSign ? current + 1 : 1; best = max(best, current); lastSign = sign
        }
        return best
    }
    private var dayResults: [Double] {
        Dictionary(grouping: dashboardTrades, by: { Calendar.current.startOfDay(for: $0.timestamp) })
            .map { ($0.key, $0.value.reduce(0) { $0 + $1.result }) }.sorted { $0.0 > $1.0 }.map(\.1)
    }
    private var currentDayStreak: Int { dayResults.first.map { result in dayResults.prefix { ($0 >= 0) == (result >= 0) }.count } ?? 0 }
    private var longestDayStreak: Int { max(currentDayStreak, 1) }
    private var sessionRows: [(String, Double, Int)] {
        Dictionary(grouping: dashboardTrades, by: { $0.session.isEmpty ? "Mimo session" : $0.session })
            .map { ($0.key, $0.value.reduce(0) { $0 + $1.result }, $0.value.count) }
            .sorted { $0.1 > $1.1 }
    }
    private var confluenceRows: [(String, Double, Int)] {
        let buckets: [(String, (TradeRecord) -> Bool)] = [
            ("0–1 confluence", { $0.confluenceCount <= 1 }),
            ("2–3 confluence", { (2...3).contains($0.confluenceCount) }),
            ("4+ confluencí", { $0.confluenceCount >= 4 })
        ]
        return buckets.map { name, predicate in
            let rows = dashboardTrades.filter(predicate)
            let rate = rows.isEmpty ? 0 : Double(rows.filter { $0.result > 0 }.count) / Double(rows.count)
            return (name, rate, rows.count)
        }
    }
    private var monteCarloStats: (p5: Double, p50: Double, p95: Double, lossRisk: Double, ruinRisk: Double) {
        let values = dashboardTrades.map(\.result)
        guard !values.isEmpty else { return (0, 0, 0, 0, 0) }
        var seed: UInt64 = 0xA17A_7ADE
        var finals: [Double] = []
        var losses = 0, ruins = 0
        let ruinThreshold = -(store.accounts.map(\.balance).max() ?? 50_000)
        for _ in 0..<600 {
            var total = 0.0
            for _ in values.indices {
                seed = seed &* 6_364_136_223_846_793_005 &+ 1
                total += values[Int(seed % UInt64(values.count))]
            }
            finals.append(total)
            if total < 0 { losses += 1 }
            if total <= ruinThreshold { ruins += 1 }
        }
        finals.sort()
        func percentile(_ p: Double) -> Double { finals[min(finals.count - 1, Int(Double(finals.count - 1) * p))] }
        return (percentile(0.05), percentile(0.50), percentile(0.95), Double(losses) / 600, Double(ruins) / 600)
    }

    private var chartValues: [CGFloat] {
        let chronological = dashboardTrades.sorted { $0.timestamp < $1.timestamp }
        guard !chronological.isEmpty else { return [0, 0] }
        var running = 0.0
        let raw = chronological.map { trade -> Double in running += trade.result; return running }
        let low = raw.min() ?? 0, high = raw.max() ?? 0, span = max(high - low, 1)
        let normalized = raw.map { CGFloat(10 + (($0 - low) / span) * 70) }
        return normalized.count == 1 ? [normalized[0], normalized[0]] : normalized
    }

    private var monthTitle: String {
        Date.now.formatted(.dateTime.locale(Locale(identifier: "cs_CZ")).month(.wide).year()).capitalized
    }
    private var monthPnL: Double {
        dashboardTrades.filter { Calendar.current.isDate($0.timestamp, equalTo: .now, toGranularity: .month) }.reduce(0) { $0 + $1.result }
    }
    private func dayPnL(_ day: Int) -> Double {
        dashboardTrades.filter {
            Calendar.current.isDate($0.timestamp, equalTo: .now, toGranularity: .month) && Calendar.current.component(.day, from: $0.timestamp) == day
        }.reduce(0) { $0 + $1.result }
    }
    private func dayLabel(_ day: Int) -> String {
        let value = dayPnL(day)
        guard value != 0 else { return "" }
        return value.usd.replacingOccurrences(of: ".00", with: "")
    }
}
