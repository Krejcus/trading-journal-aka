import SwiftUI

enum TradeTheme {
    // Matches AlphaTrade's light-theme CSS tokens, not a separate iOS visual language.
    static let page = Color(red: 248/255, green: 250/255, blue: 252/255)
    static let card = Color.white
    static let raised = Color(red: 241/255, green: 245/255, blue: 249/255)
    static let primary = Color(red: 15/255, green: 23/255, blue: 42/255)
    static let secondary = Color(red: 71/255, green: 85/255, blue: 105/255)
    static let muted = Color(red: 148/255, green: 163/255, blue: 184/255)
    static let blue = Color(red: 59/255, green: 130/255, blue: 246/255)
    static let indigo = Color(red: 99/255, green: 102/255, blue: 241/255)
    static let success = Color(red: 16/255, green: 185/255, blue: 129/255)
    static let danger = Color(red: 244/255, green: 63/255, blue: 94/255)
    static let warning = Color(red: 245/255, green: 158/255, blue: 11/255)
    static let border = Color(red: 226/255, green: 232/255, blue: 240/255)
}

struct TradeCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(padding)
            .background(TradeTheme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(TradeTheme.border)
                    .allowsHitTesting(false)
            }
            .shadow(color: Color.black.opacity(0.035), radius: 10, y: 4)
    }
}

struct SectionHeading: View {
    let title: String
    var detail: String? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased()).font(.caption.weight(.bold)).tracking(1.1).foregroundStyle(TradeTheme.secondary)
            Spacer()
            if let detail { Text(detail).font(.caption.monospacedDigit()).foregroundStyle(TradeTheme.muted) }
        }
    }
}

struct StatusPill: View {
    let text: String
    let color: Color
    var body: some View {
        HStack(spacing: 5) { Circle().fill(color).frame(width: 6, height: 6); Text(text).font(.caption2.weight(.semibold)) }
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(color.opacity(0.1), in: Capsule())
            .overlay { Capsule().stroke(color.opacity(0.22)).allowsHitTesting(false) }
    }
}

extension View {
    func tradeScreen() -> some View { self.background(TradeTheme.page.ignoresSafeArea()).foregroundStyle(TradeTheme.primary) }
}

extension Double {
    var usd: String { formatted(.currency(code: "USD").precision(.fractionLength(0...2))) }
}
