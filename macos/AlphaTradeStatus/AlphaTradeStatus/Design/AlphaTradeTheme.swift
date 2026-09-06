import SwiftUI

struct AlphaTradeTheme: Equatable {
    let panel: Color
    let card: Color
    let cardElevated: Color
    let stroke: Color
    let primaryText: Color
    let secondaryText: Color
    let sectionText: Color
    let emerald: Color
    let emeraldSoft: Color
    let emeraldText: Color
    let amber: Color
    let amberSoft: Color
    let amberText: Color
    let rose: Color
    let roseSoft: Color
    let roseText: Color
    let indigo: Color
    let indigoSoft: Color
    let indigoText: Color
    let neutralSoft: Color
    let buttonText: Color
    let quietButton: Color
    let quietButtonPressed: Color

    static let dark = AlphaTradeTheme(
        panel: Color(hex: 0x050811),
        card: Color(hex: 0x0A0F1D),
        cardElevated: Color(hex: 0x0F172A),
        stroke: Color.white.opacity(0.09),
        primaryText: Color(hex: 0xF8FAFC),
        secondaryText: Color(hex: 0x94A3B8),
        sectionText: Color(hex: 0x718096),
        emerald: Color(hex: 0x10B981),
        emeraldSoft: Color(hex: 0x10B981).opacity(0.16),
        emeraldText: Color(hex: 0x34D399),
        amber: Color(hex: 0xF59E0B),
        amberSoft: Color(hex: 0xF59E0B).opacity(0.16),
        amberText: Color(hex: 0xFBBF24),
        rose: Color(hex: 0xF43F5E),
        roseSoft: Color(hex: 0xF43F5E).opacity(0.16),
        roseText: Color(hex: 0xFB7185),
        indigo: Color(hex: 0x818CF8),
        indigoSoft: Color(hex: 0x6366F1).opacity(0.16),
        indigoText: Color(hex: 0xA5B4FC),
        neutralSoft: Color.white.opacity(0.07),
        buttonText: .white,
        quietButton: Color.white.opacity(0.07),
        quietButtonPressed: Color.white.opacity(0.12)
    )

    static let light = AlphaTradeTheme(
        panel: .white,
        card: Color(hex: 0xF8FAFC),
        cardElevated: .white,
        stroke: Color(hex: 0xE2E8F0),
        primaryText: Color(hex: 0x0F172A),
        secondaryText: Color(hex: 0x475569),
        sectionText: Color(hex: 0x64748B),
        emerald: Color(hex: 0x059669),
        emeraldSoft: Color(hex: 0x10B981).opacity(0.11),
        emeraldText: Color(hex: 0x047857),
        amber: Color(hex: 0xD97706),
        amberSoft: Color(hex: 0xF59E0B).opacity(0.12),
        amberText: Color(hex: 0x92400E),
        rose: Color(hex: 0xE11D48),
        roseSoft: Color(hex: 0xF43F5E).opacity(0.10),
        roseText: Color(hex: 0xBE123C),
        indigo: Color(hex: 0x4F46E5),
        indigoSoft: Color(hex: 0x6366F1).opacity(0.10),
        indigoText: Color(hex: 0x4338CA),
        neutralSoft: Color(hex: 0xE2E8F0).opacity(0.66),
        buttonText: .white,
        quietButton: Color(hex: 0xF1F5F9),
        quietButtonPressed: Color(hex: 0xE2E8F0)
    )

    static func palette(for colorScheme: ColorScheme) -> AlphaTradeTheme {
        colorScheme == .dark ? .dark : .light
    }

    func accent(for tone: StatusTone) -> Color {
        switch tone {
        case .success:
            return emerald
        case .warning:
            return amber
        case .danger:
            return rose
        case .neutral:
            return indigo
        case .muted:
            return secondaryText
        }
    }

    func text(for tone: StatusTone) -> Color {
        switch tone {
        case .success:
            return emeraldText
        case .warning:
            return amberText
        case .danger:
            return roseText
        case .neutral:
            return primaryText
        case .muted:
            return secondaryText
        }
    }

    func softBackground(for tone: StatusTone) -> Color {
        switch tone {
        case .success:
            return emeraldSoft
        case .warning:
            return amberSoft
        case .danger:
            return roseSoft
        case .neutral:
            return indigoSoft
        case .muted:
            return neutralSoft
        }
    }

    func primaryGradient(for tone: StatusTone) -> (top: Color, bottom: Color) {
        switch tone {
        case .danger:
            return (Color(hex: 0xBE123C), Color(hex: 0x9F1239))
        case .warning:
            return (Color(hex: 0xB45309), Color(hex: 0x92400E))
        case .neutral:
            return (Color(hex: 0x4F46E5), Color(hex: 0x4338CA))
        case .success, .muted:
            return (Color(hex: 0x047857), Color(hex: 0x065F46))
        }
    }
}

private struct AlphaTradeThemeKey: EnvironmentKey {
    static let defaultValue = AlphaTradeTheme.light
}

extension EnvironmentValues {
    var alphaTradeTheme: AlphaTradeTheme {
        get { self[AlphaTradeThemeKey.self] }
        set { self[AlphaTradeThemeKey.self] = newValue }
    }
}

private struct AlphaTradeThemeModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content.environment(\.alphaTradeTheme, .palette(for: colorScheme))
    }
}

extension View {
    func alphaTradeTheme() -> some View {
        modifier(AlphaTradeThemeModifier())
    }
}

enum AlphaTradeMetrics {
    static let popoverWidth: CGFloat = 360
    static let panelPadding: CGFloat = 14
    static let sectionSpacing: CGFloat = 10
    static let panelRadius: CGFloat = 12
    static let cardRadius: CGFloat = 8
    static let buttonHeight: CGFloat = 34
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
