import SwiftUI

struct FooterActionBar: View {
    @Environment(\.alphaTradeTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let footer: FooterPresentation
    let onAction: (FooterActionPresentation) -> Void

    @State private var refreshTurns = 0
    @State private var diagnosticsCopied = false

    var body: some View {
        HStack(spacing: 8) {
            ForEach(footer.actions) { action in
                actionButton(for: action)
            }
        }
    }

    @ViewBuilder
    private func actionButton(for action: FooterActionPresentation) -> some View {
        switch action.style {
        case .primary:
            let gradient = theme.primaryGradient(for: action.tone)
            baseButton(for: action)
                .buttonStyle(
                    PrimaryActionButtonStyle(
                        topColor: gradient.top,
                        bottomColor: gradient.bottom,
                        shadowColor: theme.accent(for: action.tone)
                    )
                )
        case .secondary:
            baseButton(for: action)
                .buttonStyle(SecondaryActionButtonStyle())
        case .icon:
            baseButton(for: action)
                .buttonStyle(IconActionButtonStyle())
        }
    }

    private func baseButton(for action: FooterActionPresentation) -> some View {
        Button {
            perform(action)
        } label: {
            actionLabel(for: action)
        }
        .help(action.accessibilityLabel)
        .accessibilityLabel(action.accessibilityLabel)
        .accessibilityIdentifier("alphaTrade.status.action.\(action.id.rawValue)")
    }

    private func perform(_ action: FooterActionPresentation) {
        if action.id == .refresh {
            refreshTurns += 1
        }
        if action.id == .copyDiagnostics {
            diagnosticsCopied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.25) {
                diagnosticsCopied = false
            }
        }
        onAction(action)
    }

    @ViewBuilder
    private func actionLabel(for action: FooterActionPresentation) -> some View {
        if action.style == .icon {
            Image(systemName: iconName(for: action))
                .rotationEffect(
                    action.id == .refresh
                        ? .degrees(Double(refreshTurns) * 360)
                        : .zero
                )
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: 0.48),
                    value: refreshTurns
                )
        } else {
            HStack(spacing: 7) {
                if let symbolName = visibleSymbolName(for: action) {
                    Image(systemName: symbolName)
                        .font(.system(size: 12, weight: .bold))
                }
                Text(action.title)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
            }
        }
    }

    private func iconName(for action: FooterActionPresentation) -> String {
        if action.id == .copyDiagnostics, diagnosticsCopied {
            return "checkmark"
        }
        return action.symbolName ?? "circle"
    }

    private func visibleSymbolName(for action: FooterActionPresentation) -> String? {
        if action.id == .openJournal {
            return "book.closed"
        }
        return action.symbolName
    }

}
