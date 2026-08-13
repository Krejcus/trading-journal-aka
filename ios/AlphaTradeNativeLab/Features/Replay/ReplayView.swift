import SwiftUI

struct ReplayView: View {
    @Environment(NativeLabStore.self) private var store
    @State private var speed = "1×"

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                sessionHeader
                chart
                controls
                orderTicket
                guardrails
            }.padding(16)
        }
        .tradeScreen().navigationTitle("Replay")
        .task(id: store.replayIsPlaying) {
            while store.replayIsPlaying && store.replayIndex < store.candles.count {
                try? await Task.sleep(for: .milliseconds(speed == "4×" ? 180 : speed == "2×" ? 360 : 700))
                if !Task.isCancelled { store.advanceReplay() }
            }
            store.replayIsPlaying = false
        }
    }

    private var sessionHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) { Text("MNQ · NEW YORK AM").font(.subheadline.bold()); Text("12. srpna 2026 · 1m execution").font(.caption).foregroundStyle(TradeTheme.secondary) }
            Spacer(); StatusPill(text: store.replayIndex == store.candles.count ? "KONEC" : "SKRYTÁ BUDOUCNOST", color: store.replayIndex == store.candles.count ? TradeTheme.success : TradeTheme.warning)
        }
    }

    private var chart: some View {
        TradeCard(padding: 10) {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Text("MNQ 1m").font(.caption.bold()); Spacer(); Text(store.visibleCandles.last?.close.formatted(.number.precision(.fractionLength(2))) ?? "—").font(.caption.monospacedDigit()).foregroundStyle(TradeTheme.secondary) }
                GeometryReader { geo in
                    let candles = Array(store.visibleCandles)
                    let maxP = candles.map(\.high).max() ?? 1
                    let minP = candles.map(\.low).min() ?? 0
                    let range = max(maxP - minP, 1)
                    Canvas { context, size in
                        let step = size.width / CGFloat(max(candles.count, 1))
                        for (index, candle) in candles.enumerated() {
                            let x = CGFloat(index) * step + step / 2
                            let yHigh = size.height * CGFloat((maxP - candle.high) / range)
                            let yLow = size.height * CGFloat((maxP - candle.low) / range)
                            let yOpen = size.height * CGFloat((maxP - candle.open) / range)
                            let yClose = size.height * CGFloat((maxP - candle.close) / range)
                            let color = candle.close >= candle.open ? TradeTheme.success : TradeTheme.danger
                            context.stroke(Path { $0.move(to: CGPoint(x: x, y: yHigh)); $0.addLine(to: CGPoint(x: x, y: yLow)) }, with: .color(color.opacity(0.8)), lineWidth: 1)
                            context.fill(Path(CGRect(x: x - max(1.5, step * 0.24), y: min(yOpen, yClose), width: max(3, step * 0.48), height: max(2, abs(yClose-yOpen)))), with: .color(color))
                        }
                    }
                }.frame(height: 260).background(TradeTheme.page.opacity(0.45)).clipShape(RoundedRectangle(cornerRadius: 5))
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 8) {
            Button { store.resetReplay() } label: { Image(systemName: "backward.end.fill") }.buttonStyle(.bordered).accessibilityLabel("Resetovat replay")
            Button { store.replayIsPlaying.toggle() } label: { Image(systemName: store.replayIsPlaying ? "pause.fill" : "play.fill").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).tint(TradeTheme.blue).accessibilityIdentifier("replay.play")
            Button { store.advanceReplay() } label: { Image(systemName: "forward.frame.fill") }.buttonStyle(.bordered).disabled(store.replayIndex >= store.candles.count).accessibilityIdentifier("replay.next")
            Menu(speed) { ForEach(["1×", "2×", "4×"], id: \.self) { item in Button(item) { speed = item } } }.buttonStyle(.bordered)
        }
    }

    private var orderTicket: some View {
        TradeCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(title: "Simulovaný vstup", detail: "RISK $130")
                HStack(spacing: 8) {
                    ticketButton("LONG", color: TradeTheme.success)
                    ticketButton("SHORT", color: TradeTheme.danger)
                }
                if let side = store.selectedReplaySide {
                    HStack { Image(systemName: "checkmark.shield.fill").foregroundStyle(TradeTheme.success); Text("\(side) označen pouze v lokálním replayi.").font(.caption).foregroundStyle(TradeTheme.secondary) }
                }
            }
        }
    }

    private func ticketButton(_ side: String, color: Color) -> some View {
        Button(side) { store.selectedReplaySide = side }
            .font(.subheadline.bold()).frame(maxWidth: .infinity).padding(.vertical, 10)
            .background(store.selectedReplaySide == side ? color.opacity(0.22) : TradeTheme.raised, in: RoundedRectangle(cornerRadius: 6))
            .overlay { RoundedRectangle(cornerRadius: 6).stroke(store.selectedReplaySide == side ? color : TradeTheme.border).allowsHitTesting(false) }
            .foregroundStyle(color).buttonStyle(.plain).accessibilityIdentifier("replay.\(side.lowercased())")
    }

    private var guardrails: some View {
        TradeCard(padding: 12) {
            VStack(alignment: .leading, spacing: 7) {
                Label("No-lookahead guard aktivní", systemImage: "eye.slash.fill").foregroundStyle(TradeTheme.success).font(.subheadline.bold())
                Text("Graf zpřístupňuje jen svíčky do aktuálního cursoru. Tlačítka nevytvářejí brokerové příkazy.").font(.caption).foregroundStyle(TradeTheme.secondary)
            }
        }
    }
}
