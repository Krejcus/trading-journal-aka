import SwiftUI

struct StatusPopoverView: View {
    @Environment(\.alphaTradeTheme) private var theme

    let presentation: CompanionPresentation
    let onAction: (FooterActionPresentation) -> Void

    @State private var expandedSectionIDs: Set<String>

    init(
        presentation: CompanionPresentation,
        onAction: @escaping (FooterActionPresentation) -> Void = { _ in }
    ) {
        self.presentation = presentation
        self.onAction = onAction
        _expandedSectionIDs = State(
            initialValue: Set(
                presentation.sections
                    .filter(\.isInitiallyExpanded)
                    .map(\.id)
            )
        )
    }

    var body: some View {
        VStack(spacing: AlphaTradeMetrics.sectionSpacing) {
            StatusHeader(freshness: presentation.freshness)
            HeroStatusCard(hero: presentation.hero)

            if let banner = presentation.banner,
               presentation.displayState == .unknown || presentation.displayState == .offline {
                StatusBanner(banner: banner)
            }

            ForEach(presentation.sections) { section in
                CollapsibleStatusSection(
                    section: section,
                    isExpanded: binding(for: section.id)
                )
            }

            if let banner = presentation.banner,
               presentation.displayState != .unknown && presentation.displayState != .offline {
                StatusBanner(banner: banner)
            }

            FooterActionBar(footer: presentation.footer, onAction: onAction)
        }
        .padding(AlphaTradeMetrics.panelPadding)
        .frame(width: AlphaTradeMetrics.popoverWidth)
        .fixedSize(horizontal: false, vertical: true)
        .background(theme.panel)
        .overlay {
            RoundedRectangle(cornerRadius: AlphaTradeMetrics.panelRadius, style: .continuous)
                .stroke(panelStroke, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: AlphaTradeMetrics.panelRadius, style: .continuous))
        // Keep the core view fully visible in its first frame. The optional
        // entrance wrapper below never starts from a blank state either.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("alphaTrade.status.popover")
        .onChange(of: presentation.fixtureID) { _ in
            expandedSectionIDs = Set(
                presentation.sections
                    .filter(\.isInitiallyExpanded)
                    .map(\.id)
            )
        }
    }

    private var panelStroke: Color {
        switch presentation.hero.tone {
        case .danger, .warning:
            return theme.accent(for: presentation.hero.tone).opacity(0.34)
        case .success, .neutral, .muted:
            return theme.stroke
        }
    }

    private func binding(for sectionID: String) -> Binding<Bool> {
        Binding(
            get: { expandedSectionIDs.contains(sectionID) },
            set: { isExpanded in
                if isExpanded {
                    expandedSectionIDs.insert(sectionID)
                } else {
                    expandedSectionIDs.remove(sectionID)
                }
            }
        )
    }
}

struct StatusPopoverEntranceView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let presentation: CompanionPresentation
    let onAction: (FooterActionPresentation) -> Void

    @State private var isSettled = false

    var body: some View {
        StatusPopoverView(
            presentation: presentation,
            onAction: onAction
        )
        .scaleEffect(isVisible ? 1 : 0.985, anchor: .top)
        .opacity(isVisible ? 1 : 0.94)
        .offset(y: isVisible ? 0 : -4)
        .onAppear(perform: animateEntrance)
    }

    private var isVisible: Bool {
        reduceMotion || isSettled
    }

    private func animateEntrance() {
        guard !reduceMotion else {
            isSettled = true
            return
        }

        DispatchQueue.main.async {
            withAnimation(
                .timingCurve(0.20, 0.78, 0.28, 1, duration: 0.18)
            ) {
                isSettled = true
            }
        }
    }
}

struct StatusPopoverPreviewCanvas: View {
    let presentation: CompanionPresentation
    let scheme: ColorScheme

    var body: some View {
        StatusPopoverView(presentation: presentation)
            .alphaTradeTheme()
            .preferredColorScheme(scheme)
            .padding(20)
            .background(scheme == .dark ? Color(hex: 0x020617) : Color(hex: 0xF1F5F9))
    }
}

struct StatusPopoverView_Previews: PreviewProvider {
    static var previews: some View {
        Group {
            StatusPopoverPreviewCanvas(
                presentation: CompanionMockFixtureCatalog.presentation(for: .live),
                scheme: .light
            )
            StatusPopoverPreviewCanvas(
                presentation: CompanionMockFixtureCatalog.presentation(for: .intervention),
                scheme: .dark
            )
            StatusPopoverPreviewCanvas(
                presentation: CompanionMockFixtureCatalog.presentation(for: .offline),
                scheme: .light
            )
        }
    }
}
