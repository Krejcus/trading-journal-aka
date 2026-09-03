import SwiftUI

struct CompanionRootView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var settings: CompanionSettings

    let onAction: (FooterActionPresentation) -> Void
    let onOpenPairing: () -> Void
    let onCopyPairingCode: (String) -> Void
    let onHoverChanged: (Bool) -> Void

    var body: some View {
        switch store.state {
        case .connected(let presentation):
            StatusPopoverView(
                presentation: presentation,
                settings: settings,
                transitionEvent: store.transitionEvent,
                onAction: onAction,
                onHoverChanged: onHoverChanged
            )
        case .starting:
            CompanionMessagePanel(
                freshness: .init(
                    text: "Připojuji…",
                    tone: .warning,
                    accessibilityLabel: "Připojuji cloudový stav"
                ),
                symbolName: "arrow.triangle.2.circlepath",
                title: "NAČÍTÁM STAV",
                detail: "Ověřuji read-only spojení s AlphaTrade cloudem.",
                tone: .warning,
                primaryTitle: nil,
                primaryAction: nil,
                secondaryTitle: nil,
                secondaryAction: nil,
                settings: settings
            )
        case .pairing(let pairing):
            CompanionPairingView(
                pairing: pairing,
                onOpenPairing: onOpenPairing,
                onCopyPairingCode: onCopyPairingCode,
                onRetry: store.pairAgain,
                settings: settings
            )
        case .revoked:
            CompanionMessagePanel(
                freshness: .init(
                    text: "Přístup zrušen",
                    tone: .warning,
                    accessibilityLabel: "Přístup tohoto Macu byl zrušen"
                ),
                symbolName: "key.slash",
                title: "PŘÍSTUP ZRUŠEN",
                detail: "Tento Mac už nemá oprávnění číst stav copieru. Starý stav se nezobrazuje.",
                tone: .warning,
                primaryTitle: "Spárovat znovu",
                primaryAction: store.pairAgain,
                secondaryTitle: "Otevřít AlphaTrade",
                secondaryAction: onOpenPairing,
                settings: settings
            )
        case .localFailure(let message):
            CompanionMessagePanel(
                freshness: .init(
                    text: "Stav nedostupný",
                    tone: .warning,
                    accessibilityLabel: "Cloudový stav je nedostupný"
                ),
                symbolName: "exclamationmark.triangle.fill",
                title: "STAV NEDOSTUPNÝ",
                detail: message,
                tone: .warning,
                primaryTitle: "Zkusit znovu",
                primaryAction: store.requestManualRefresh,
                secondaryTitle: "Otevřít AlphaTrade",
                secondaryAction: onOpenPairing,
                settings: settings
            )
        }
    }
}

struct CompanionRootEntranceView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @ObservedObject var store: CompanionStore
    @ObservedObject var settings: CompanionSettings
    let onAction: (FooterActionPresentation) -> Void
    let onOpenPairing: () -> Void
    let onCopyPairingCode: (String) -> Void
    let onHoverChanged: (Bool) -> Void

    @State private var isSettled = false

    var body: some View {
        CompanionRootView(
            store: store,
            settings: settings,
            onAction: onAction,
            onOpenPairing: onOpenPairing,
            onCopyPairingCode: onCopyPairingCode,
            onHoverChanged: onHoverChanged
        )
        .scaleEffect(isVisible ? 1 : 0.985, anchor: .top)
        .opacity(isVisible ? 1 : 0.94)
        .offset(y: isVisible ? 0 : -4)
        .onAppear(perform: animateEntrance)
    }

    private var isVisible: Bool { reduceMotion || isSettled }

    private func animateEntrance() {
        guard !reduceMotion else {
            isSettled = true
            return
        }
        DispatchQueue.main.async {
            withAnimation(.timingCurve(0.20, 0.78, 0.28, 1, duration: 0.18)) {
                isSettled = true
            }
        }
    }
}

private struct CompanionPairingView: View {
    @Environment(\.alphaTradeTheme) private var theme

    let pairing: CompanionPairingViewState
    let onOpenPairing: () -> Void
    let onCopyPairingCode: (String) -> Void
    let onRetry: () -> Void
    @ObservedObject var settings: CompanionSettings

    var body: some View {
        VStack(spacing: AlphaTradeMetrics.sectionSpacing) {
            StatusHeader(freshness: .init(
                text: pairingHeaderText,
                tone: .warning,
                accessibilityLabel: pairingHeaderAccessibilityLabel
            ), settings: settings)

            HeroStatusCard(hero: .init(
                symbolName: "key.fill",
                title: "SPÁROVAT MAC",
                badge: nil,
                detail: pairingStartFailed
                    ? "Kód se nepodařilo zaregistrovat v cloudu. Vygeneruj nový bezpečný kód."
                    : "Potvrď jednorázový kód v přihlášené AlphaTrade PWA. Companion získá pouze čtení stavu.",
                tone: .warning
            ))

            VStack(spacing: 8) {
                if pairingStartFailed {
                    Text("KÓD NEBYL VYTVOŘEN")
                        .font(.system(size: 13, weight: .black, design: .monospaced))
                        .tracking(0.7)
                        .foregroundStyle(theme.amberText)
                } else {
                    Text(pairing.code)
                        .font(.system(size: 24, weight: .black, design: .monospaced))
                        .tracking(1.2)
                        .foregroundStyle(theme.primaryText)
                        .textSelection(.enabled)
                        .accessibilityLabel("Párovací kód \(pairing.code)")
                }

                if let expiresAt = pairing.expiresAt, !pairing.isExpired {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let seconds = max(0, Int(expiresAt.timeIntervalSince(context.date)))
                        Text("Platí ještě \(CompanionDisplayFormatting.duration(seconds))")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(theme.secondaryText)
                    }
                }

                if let message = pairing.message {
                    Text(message)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(theme.amberText)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(14)
            .background(theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(theme.stroke, lineWidth: 1)
            }

            if pairing.isExpired || pairingStartFailed {
                Button(pairing.isExpired ? "Vygenerovat nový kód" : "Zkusit znovu", action: onRetry)
                    .buttonStyle(PrimaryActionButtonStyle(
                        topColor: theme.amber,
                        bottomColor: theme.amberText,
                        shadowColor: theme.amber
                    ))
            } else {
                HStack(spacing: 8) {
                    Button("Otevřít AlphaTrade", action: onOpenPairing)
                        .buttonStyle(PrimaryActionButtonStyle(
                            topColor: theme.emerald,
                            bottomColor: Color(hex: 0x047857),
                            shadowColor: theme.emerald
                        ))
                    Button {
                        onCopyPairingCode(pairing.code)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(IconActionButtonStyle())
                    .help("Zkopírovat párovací kód")
                    .accessibilityLabel("Zkopírovat párovací kód")
                }
            }

        }
        .companionPanelFrame(theme: theme)
    }

    private var pairingStartFailed: Bool {
        !pairing.isStarting && pairing.expiresAt == nil && pairing.message != nil
    }

    private var pairingHeaderText: String {
        if pairing.isExpired { return "Kód vypršel" }
        if pairingStartFailed { return "Kód nebyl vytvořen" }
        return pairing.isStarting ? "Vytvářím kód…" : "Čeká na potvrzení"
    }

    private var pairingHeaderAccessibilityLabel: String {
        if pairing.isExpired { return "Párovací kód vypršel" }
        if pairingStartFailed { return "Párovací kód se nepodařilo vytvořit" }
        return "Čeká na potvrzení párování"
    }

}

private struct CompanionMessagePanel: View {
    @Environment(\.alphaTradeTheme) private var theme

    let freshness: FreshnessPresentation
    let symbolName: String
    let title: String
    let detail: String
    let tone: StatusTone
    let primaryTitle: String?
    let primaryAction: (() -> Void)?
    let secondaryTitle: String?
    let secondaryAction: (() -> Void)?
    @ObservedObject var settings: CompanionSettings

    var body: some View {
        VStack(spacing: AlphaTradeMetrics.sectionSpacing) {
            StatusHeader(freshness: freshness, settings: settings)
            HeroStatusCard(hero: .init(
                symbolName: symbolName,
                title: title,
                badge: nil,
                detail: detail,
                tone: tone
            ))

            if let primaryTitle, let primaryAction {
                Button(primaryTitle, action: primaryAction)
                    .buttonStyle(PrimaryActionButtonStyle(
                        topColor: theme.amber,
                        bottomColor: theme.amberText,
                        shadowColor: theme.amber
                    ))
            }
            if let secondaryTitle, let secondaryAction {
                Button(secondaryTitle, action: secondaryAction)
                    .buttonStyle(SecondaryActionButtonStyle())
            }

        }
        .companionPanelFrame(theme: theme)
    }
}

private extension View {
    func companionPanelFrame(theme: AlphaTradeTheme) -> some View {
        padding(AlphaTradeMetrics.panelPadding)
            .frame(width: AlphaTradeMetrics.popoverWidth)
            .fixedSize(horizontal: false, vertical: true)
            .background(theme.panel)
            .overlay {
                RoundedRectangle(cornerRadius: AlphaTradeMetrics.panelRadius, style: .continuous)
                    .stroke(theme.stroke, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlphaTradeMetrics.panelRadius, style: .continuous))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("alphaTrade.status.popover")
    }
}
