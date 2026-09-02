import SwiftUI

struct StatusDot: View {
    @Environment(\.alphaTradeTheme) private var theme

    let tone: StatusTone

    var body: some View {
        Circle()
            .fill(theme.accent(for: tone))
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
    }
}

struct StatusHeader: View {
    @Environment(\.alphaTradeTheme) private var theme

    let freshness: FreshnessPresentation

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                AlphaTradeLogo(height: 20)
                Text("AlphaTrade Status")
                    .font(.system(size: 13, weight: .black))
                    .foregroundStyle(theme.primaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                    .accessibilityIdentifier("alphaTrade.status.title")
            }

            Spacer(minLength: 8)

            HStack(spacing: 6) {
                StatusDot(tone: freshness.tone)
                Text(freshness.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
            }
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(theme.text(for: freshness.tone))
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(
                theme.softBackground(for: freshness.tone),
                in: Capsule(style: .continuous)
            )
            .overlay {
                Capsule(style: .continuous)
                    .stroke(theme.accent(for: freshness.tone).opacity(0.30), lineWidth: 1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(freshness.accessibilityLabel)
        }
    }
}

struct HeroStatusCard: View {
    @Environment(\.alphaTradeTheme) private var theme

    let hero: HeroPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if !hero.symbolName.isEmpty {
                    Image(systemName: hero.symbolName)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(theme.text(for: hero.tone))
                        .accessibilityHidden(true)
                }

                Text(hero.title)
                    .font(.system(size: 17, weight: .black))
                    .tracking(0.51)
                    .foregroundStyle(theme.text(for: hero.tone))

                if let badge = hero.badge {
                    Text(badge)
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundStyle(theme.text(for: hero.tone))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(
                            theme.softBackground(for: hero.tone),
                            in: RoundedRectangle(cornerRadius: 5, style: .continuous)
                        )
                }
            }

            Text(hero.detail)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(
                    hero.tone == .warning || hero.tone == .danger
                        ? theme.text(for: hero.tone)
                        : theme.secondaryText
                )
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            hero.tone == .muted ? theme.neutralSoft : theme.softBackground(for: hero.tone),
            in: RoundedRectangle(cornerRadius: AlphaTradeMetrics.cardRadius, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: AlphaTradeMetrics.cardRadius, style: .continuous)
                .stroke(cardStroke, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }

    private var cardStroke: Color {
        switch hero.tone {
        case .warning, .danger, .success:
            return theme.accent(for: hero.tone).opacity(0.28)
        case .neutral, .muted:
            return theme.stroke
        }
    }
}

struct StatusBanner: View {
    @Environment(\.alphaTradeTheme) private var theme

    let banner: BannerPresentation

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if !banner.symbolName.isEmpty {
                Image(systemName: banner.symbolName)
                    .font(.system(size: 12, weight: .bold))
                    .padding(.top, 1)
                    .accessibilityHidden(true)
            }
            Text(banner.text)
                .font(.system(size: 11, weight: .semibold))
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(theme.text(for: banner.tone))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
            theme.softBackground(for: banner.tone).opacity(0.78),
            in: RoundedRectangle(cornerRadius: 6, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(theme.accent(for: banner.tone).opacity(0.25), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

struct CollapsibleStatusSection: View {
    @Environment(\.alphaTradeTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let section: StatusSectionPresentation
    @Binding var isExpanded: Bool

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(reduceMotion ? .linear(duration: 0.01) : .easeInOut(duration: 0.25)) {
                    isExpanded.toggle()
                }
            } label: {
                sectionHeader
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .alphaTradeFocusEffectDisabled()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(section.title), \(section.summary)")
            .accessibilityValue(isExpanded ? "rozbaleno" : "sbaleno")
            .accessibilityHint(isExpanded ? "Sbalí podrobnosti" : "Rozbalí podrobnosti")
            .accessibilityIdentifier("alphaTrade.status.section.\(section.id)")

            if isExpanded {
                Divider()
                    .overlay(theme.stroke)
                    .padding(.top, 9)

                VStack(spacing: 9) {
                    ForEach(section.rows) { row in
                        switch row {
                        case .keyValue(let presentation):
                            KeyValueStatusRow(row: presentation)
                        case .position(let presentation):
                            PositionStatusRow(row: presentation)
                        }
                    }
                }
                .padding(.top, 9)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            theme.card,
            in: RoundedRectangle(cornerRadius: AlphaTradeMetrics.cardRadius, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: AlphaTradeMetrics.cardRadius, style: .continuous)
                .stroke(sectionStroke, lineWidth: 1)
        }
        .clipped()
    }

    @ViewBuilder
    private var sectionHeader: some View {
        if usesStackedHeader {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    sectionTitle
                    Spacer(minLength: 8)
                    chevron
                }
                sectionSummary
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        } else {
            HStack(spacing: 8) {
                sectionTitle
                Spacer(minLength: 8)
                sectionSummary
                chevron
            }
        }
    }

    private var sectionTitle: some View {
        Text(section.title.uppercased())
            .font(.system(size: 10, weight: .heavy))
            .tracking(0.8)
            .foregroundStyle(sectionTitleColor)
            .lineLimit(1)
            .minimumScaleFactor(0.70)
    }

    private var sectionSummary: some View {
        HStack(spacing: 6) {
            StatusDot(tone: section.summaryTone)
            Text(section.summary)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(summaryColor)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.down")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(theme.sectionText)
            .rotationEffect(.degrees(isExpanded ? 180 : 0))
            .animation(
                reduceMotion ? nil : .easeInOut(duration: 0.22),
                value: isExpanded
            )
            .accessibilityHidden(true)
    }

    private var usesStackedHeader: Bool {
        section.title.localizedCaseInsensitiveContains("naposledy")
    }

    private var sectionTitleColor: Color {
        if section.hasProblem || section.id == "copying" {
            return theme.text(for: section.summaryTone)
        }
        return theme.sectionText
    }

    private var summaryColor: Color {
        section.summaryTone == .muted
            ? theme.secondaryText
            : theme.text(for: section.summaryTone)
    }

    private var sectionStroke: Color {
        if section.hasProblem || section.id == "copying" {
            return theme.accent(for: section.summaryTone).opacity(0.25)
        }
        return theme.stroke
    }
}

extension View {
    @ViewBuilder
    func alphaTradeFocusEffectDisabled() -> some View {
        if #available(macOS 14.0, *) {
            self.focusEffectDisabled()
        } else {
            self
        }
    }
}

private struct KeyValueStatusRow: View {
    @Environment(\.alphaTradeTheme) private var theme

    let row: KeyValueRowPresentation

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(row.label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 8)

            HStack(spacing: 6) {
                if row.tone != .muted && row.tone != .neutral {
                    StatusDot(tone: row.tone)
                }
                Text(valueText)
                    .font(valueFont)
                    .foregroundStyle(valueColor)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([row.label, row.value, row.detail].compactMap { $0 }.joined(separator: ", "))
    }

    private var valueText: String {
        [row.value, row.detail].compactMap { $0 }.joined(separator: " · ")
    }

    private var valueFont: Font {
        row.usesMonospacedValue
            ? .system(size: 12, weight: .bold, design: .monospaced)
            : .system(size: 12, weight: .bold)
    }

    private var valueColor: Color {
        row.tone == .muted ? theme.secondaryText : theme.text(for: row.tone)
    }
}

private struct PositionStatusRow: View {
    @Environment(\.alphaTradeTheme) private var theme

    let row: PositionRowPresentation

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            HStack(spacing: 6) {
                Text(row.symbol)
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundStyle(theme.primaryText)
                Text(row.side.rawValue)
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(sideColor)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(sideFill, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                Text("×\(row.quantity)")
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundStyle(theme.primaryText)
            }

            Spacer(minLength: 8)

            HStack(spacing: 6) {
                if row.detailTone != .muted {
                    StatusDot(tone: row.detailTone)
                }
                Text(row.detail)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(
                        row.detailTone == .muted
                            ? theme.secondaryText
                            : theme.text(for: row.detailTone)
                    )
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.symbol), \(row.side.rawValue), \(row.quantity) kontraktů, \(row.detail)")
    }

    private var sideColor: Color {
        row.side == .long ? theme.emeraldText : theme.roseText
    }

    private var sideFill: Color {
        row.side == .long ? theme.emeraldSoft : theme.roseSoft
    }
}
