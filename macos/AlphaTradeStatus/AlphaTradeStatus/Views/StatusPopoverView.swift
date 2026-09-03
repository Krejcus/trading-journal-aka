import SwiftUI

enum CompanionSectionExpansionPolicy {
    static func initialSectionIDs(
        in presentation: CompanionPresentation,
        transition: CompanionTransition?
    ) -> Set<String> {
        var sectionIDs = requiredSectionIDs(in: presentation)
        if let transition {
            sectionIDs.insert(transition.sectionID)
        }
        return sectionIDs
    }

    static func applying(
        _ transition: CompanionTransition,
        to currentSectionIDs: Set<String>,
        in presentation: CompanionPresentation
    ) -> Set<String> {
        currentSectionIDs
            .union(requiredSectionIDs(in: presentation))
            .union([transition.sectionID])
    }

    private static func requiredSectionIDs(
        in presentation: CompanionPresentation
    ) -> Set<String> {
        Set(presentation.sections.filter(\.isInitiallyExpanded).map(\.id))
    }
}

struct StatusPopoverView: View {
    @Environment(\.alphaTradeTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let presentation: CompanionPresentation
    let settings: CompanionSettings?
    let transitionEvent: CompanionTransitionEvent?
    let onAction: (FooterActionPresentation) -> Void
    let onHoverChanged: (Bool) -> Void

    @State private var expandedSectionIDs: Set<String>
    @State private var highlightedRowID: String?
    @State private var highlightCategory: CompanionTransitionCategory?

    init(
        presentation: CompanionPresentation,
        settings: CompanionSettings? = nil,
        transitionEvent: CompanionTransitionEvent? = nil,
        onAction: @escaping (FooterActionPresentation) -> Void = { _ in },
        onHoverChanged: @escaping (Bool) -> Void = { _ in }
    ) {
        self.presentation = presentation
        self.settings = settings
        self.transitionEvent = transitionEvent
        self.onAction = onAction
        self.onHoverChanged = onHoverChanged
        _expandedSectionIDs = State(
            initialValue: CompanionSectionExpansionPolicy.initialSectionIDs(
                in: presentation,
                transition: transitionEvent?.transition
            )
        )
        _highlightedRowID = State(initialValue: nil)
        _highlightCategory = State(initialValue: nil)
    }

    var body: some View {
        VStack(spacing: AlphaTradeMetrics.sectionSpacing) {
            StatusHeader(freshness: presentation.freshness, settings: settings)
            HeroStatusCard(hero: presentation.hero)

            if let banner = presentation.banner,
               presentation.displayState == .unknown || presentation.displayState == .offline {
                StatusBanner(banner: banner)
            }

            ForEach(presentation.sections) { section in
                CollapsibleStatusSection(
                    section: section,
                    isExpanded: binding(for: section.id),
                    highlightedRowID: transitionEvent?.transition.sectionID == section.id
                        ? highlightedRowID
                        : nil,
                    highlightCategory: transitionEvent?.transition.sectionID == section.id
                        ? highlightCategory
                        : nil
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
        .onHover(perform: onHoverChanged)
        .onAppear(perform: applyTransition)
        .onChange(of: presentation.fixtureID) { _ in
            guard transitionEvent == nil else { return }
            expandedSectionIDs = Set(presentation.sections.filter(\.isInitiallyExpanded).map(\.id))
        }
        .onChange(of: transitionEvent?.sequence) { _ in
            applyTransition()
        }
        .task(id: transitionEvent?.sequence) {
            guard transitionEvent != nil,
                  CompanionTransitionMotionPolicy.highlightsChangedRow(
                      reduceMotion: reduceMotion
                  ) else { return }
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard !Task.isCancelled else { return }
            highlightedRowID = nil
            highlightCategory = nil
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

    private func applyTransition() {
        guard let transition = transitionEvent?.transition else { return }
        expandedSectionIDs = CompanionSectionExpansionPolicy.applying(
            transition,
            to: expandedSectionIDs,
            in: presentation
        )
        guard CompanionTransitionMotionPolicy.highlightsChangedRow(
            reduceMotion: reduceMotion
        ) else {
            highlightedRowID = nil
            highlightCategory = nil
            return
        }
        highlightedRowID = transition.rowID
        highlightCategory = transition.category
    }
}

struct StatusPopoverEntranceView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let presentation: CompanionPresentation
    let settings: CompanionSettings?
    let transitionEvent: CompanionTransitionEvent?
    let onAction: (FooterActionPresentation) -> Void
    let onHoverChanged: (Bool) -> Void

    init(
        presentation: CompanionPresentation,
        settings: CompanionSettings? = nil,
        transitionEvent: CompanionTransitionEvent? = nil,
        onAction: @escaping (FooterActionPresentation) -> Void,
        onHoverChanged: @escaping (Bool) -> Void = { _ in }
    ) {
        self.presentation = presentation
        self.settings = settings
        self.transitionEvent = transitionEvent
        self.onAction = onAction
        self.onHoverChanged = onHoverChanged
    }

    @State private var isSettled = false

    var body: some View {
        StatusPopoverView(
            presentation: presentation,
            settings: settings,
            transitionEvent: transitionEvent,
            onAction: onAction,
            onHoverChanged: onHoverChanged
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
