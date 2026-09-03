import AppKit
import SwiftUI

struct PopoverAnimationProbeHooks {
    let registerSectionToggle: (@escaping (String) -> Void) -> Void
    let registerHeaderAnchor: (NSView) -> Void
}

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
    let onSectionResize: (PopoverSectionResizeRequest) -> Void
    let animationProbeHooks: PopoverAnimationProbeHooks?

    @State private var expandedSectionIDs: Set<String>
    @State private var revealedSectionIDs: Set<String>
    @State private var highlightedRowID: String?
    @State private var highlightCategory: CompanionTransitionCategory?
    @State private var sectionDetailsHeights: [String: CGFloat] = [:]
    @State private var sectionAnimationGeneration = 0

    init(
        presentation: CompanionPresentation,
        settings: CompanionSettings? = nil,
        transitionEvent: CompanionTransitionEvent? = nil,
        onAction: @escaping (FooterActionPresentation) -> Void = { _ in },
        onHoverChanged: @escaping (Bool) -> Void = { _ in },
        onSectionResize: @escaping (PopoverSectionResizeRequest) -> Void = { _ in },
        animationProbeHooks: PopoverAnimationProbeHooks? = nil
    ) {
        self.presentation = presentation
        self.settings = settings
        self.transitionEvent = transitionEvent
        self.onAction = onAction
        self.onHoverChanged = onHoverChanged
        self.onSectionResize = onSectionResize
        self.animationProbeHooks = animationProbeHooks
        let initialSectionIDs = CompanionSectionExpansionPolicy.initialSectionIDs(
            in: presentation,
            transition: transitionEvent?.transition
        )
        _expandedSectionIDs = State(initialValue: initialSectionIDs)
        _revealedSectionIDs = State(initialValue: initialSectionIDs)
        _highlightedRowID = State(initialValue: nil)
        _highlightCategory = State(initialValue: nil)
    }

    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: AlphaTradeMetrics.sectionSpacing) {
                Color.clear
                    .frame(height: 22)
                    .accessibilityHidden(true)

                HeroStatusCard(hero: presentation.hero)

                if let supportingText = presentation.hero.supportingText {
                    Text(supportingText)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(theme.secondaryText)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 2)
                        .accessibilityIdentifier("alphaTrade.status.hero.supportingText")
                }

                if let banner = presentation.banner,
                   presentation.displayState == .unknown || presentation.displayState == .offline {
                    StatusBanner(banner: banner)
                }

                ForEach(presentation.sections) { section in
                    CollapsibleStatusSection(
                        section: section,
                        isExpanded: expandedSectionIDs.contains(section.id),
                        isDetailsVisible: revealedSectionIDs.contains(section.id),
                        highlightedRowID: transitionEvent?.transition.sectionID == section.id
                            ? highlightedRowID
                            : nil,
                        highlightCategory: transitionEvent?.transition.sectionID == section.id
                            ? highlightCategory
                            : nil,
                        onToggle: { toggle(section.id) }
                    )
                }

                if let banner = presentation.banner,
                   presentation.displayState != .unknown && presentation.displayState != .offline {
                    StatusBanner(banner: banner)
                }

                FooterActionBar(footer: presentation.footer, onAction: onAction)
            }

            StatusHeader(
                freshness: presentation.freshness,
                settings: settings,
                onHeaderAnchorResolved: animationProbeHooks?.registerHeaderAnchor
            )
                .frame(height: 22, alignment: .top)
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
        .onPreferenceChange(StatusSectionDetailsHeightPreferenceKey.self) {
            sectionDetailsHeights = $0
        }
        .onAppear {
            animationProbeHooks?.registerSectionToggle { sectionID in
                toggle(sectionID)
            }
            applyTransition()
        }
        .onChange(of: presentation.fixtureID) { _ in
            guard transitionEvent == nil else { return }
            updateExpandedSections(
                Set(presentation.sections.filter(\.isInitiallyExpanded).map(\.id)),
                animated: false
            )
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
        if presentation.displayState == .disarmedUnverified {
            return theme.stroke
        }
        switch presentation.hero.tone {
        case .danger, .warning:
            return theme.accent(for: presentation.hero.tone).opacity(0.34)
        case .success, .neutral, .muted:
            return theme.stroke
        }
    }

    private func toggle(_ sectionID: String) {
        var next = revealedSectionIDs
        if next.contains(sectionID) {
            next.remove(sectionID)
        } else {
            next.insert(sectionID)
        }
        updateExpandedSections(next, animated: true)
    }

    private func updateExpandedSections(_ next: Set<String>, animated: Bool) {
        guard next != revealedSectionIDs else { return }

        let opening = next.subtracting(revealedSectionIDs)
        let closing = revealedSectionIDs.subtracting(next)
        let delta = opening.reduce(CGFloat.zero) {
            $0 + (sectionDetailsHeights[$1] ?? 0)
        } - closing.reduce(CGFloat.zero) {
            $0 + (sectionDetailsHeights[$1] ?? 0)
        }

        if abs(delta) > 0.5 {
            onSectionResize(.init(
                heightDelta: delta,
                reduceMotion: reduceMotion || !animated
            ))
        }

        if animated && !reduceMotion {
            sectionAnimationGeneration += 1
            let generation = sectionAnimationGeneration
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                expandedSectionIDs.formUnion(opening)
            }
            DispatchQueue.main.async {
                guard sectionAnimationGeneration == generation else { return }
                withAnimation(.easeInOut(duration: PopoverResizeCoordinator.sectionAnimationDuration)) {
                    revealedSectionIDs = next
                }
            }
            guard !closing.isEmpty else { return }
            DispatchQueue.main.asyncAfter(
                deadline: .now() + PopoverResizeCoordinator.sectionAnimationDuration
            ) {
                guard sectionAnimationGeneration == generation else { return }
                var completionTransaction = Transaction()
                completionTransaction.disablesAnimations = true
                withTransaction(completionTransaction) {
                    expandedSectionIDs.subtract(closing)
                }
            }
        } else {
            sectionAnimationGeneration += 1
            expandedSectionIDs = next
            revealedSectionIDs = next
        }
    }

    private func applyTransition() {
        guard let transition = transitionEvent?.transition else { return }
        let next = CompanionSectionExpansionPolicy.applying(
            transition,
            to: revealedSectionIDs,
            in: presentation
        )
        updateExpandedSections(next, animated: true)
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
    @Environment(\.alphaTradeTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let presentation: CompanionPresentation
    let settings: CompanionSettings?
    let transitionEvent: CompanionTransitionEvent?
    let onAction: (FooterActionPresentation) -> Void
    let onHoverChanged: (Bool) -> Void
    let onSectionResize: (PopoverSectionResizeRequest) -> Void
    let animationProbeHooks: PopoverAnimationProbeHooks?

    init(
        presentation: CompanionPresentation,
        settings: CompanionSettings? = nil,
        transitionEvent: CompanionTransitionEvent? = nil,
        onAction: @escaping (FooterActionPresentation) -> Void,
        onHoverChanged: @escaping (Bool) -> Void = { _ in },
        onSectionResize: @escaping (PopoverSectionResizeRequest) -> Void = { _ in },
        animationProbeHooks: PopoverAnimationProbeHooks? = nil
    ) {
        self.presentation = presentation
        self.settings = settings
        self.transitionEvent = transitionEvent
        self.onAction = onAction
        self.onHoverChanged = onHoverChanged
        self.onSectionResize = onSectionResize
        self.animationProbeHooks = animationProbeHooks
    }

    @State private var isSettled = false

    var body: some View {
        StatusPopoverView(
            presentation: presentation,
            settings: settings,
            transitionEvent: transitionEvent,
            onAction: onAction,
            onHoverChanged: onHoverChanged,
            onSectionResize: onSectionResize,
            animationProbeHooks: animationProbeHooks
        )
        .scaleEffect(isVisible ? 1 : 0.985, anchor: .top)
        .opacity(isVisible ? 1 : 0.94)
        .offset(y: isVisible ? 0 : -4)
        // Expansion reserves the final host height before the details animate.
        // Keep the old-height content pinned to the top and paint the entire
        // reserved area so the native popover never exposes a bare container.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(theme.panel)
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
