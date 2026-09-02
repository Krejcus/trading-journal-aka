import SwiftUI

struct PrimaryActionButtonStyle: ButtonStyle {
    let topColor: Color
    let bottomColor: Color
    let shadowColor: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .black))
            .tracking(0.24)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: AlphaTradeMetrics.buttonHeight)
            .background(
                LinearGradient(
                    colors: [topColor, bottomColor],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Color.white.opacity(0.16), lineWidth: 1)
                    .mask(
                        LinearGradient(
                            colors: [.white, .clear],
                            startPoint: .top,
                            endPoint: .center
                        )
                    )
            }
            .shadow(color: shadowColor.opacity(0.32), radius: 7, y: 4)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.93 : 1)
    }
}

struct SecondaryActionButtonStyle: ButtonStyle {
    @Environment(\.alphaTradeTheme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(theme.primaryText)
            .frame(maxWidth: .infinity)
            .frame(height: AlphaTradeMetrics.buttonHeight)
            .background(
                configuration.isPressed ? theme.quietButtonPressed : theme.cardElevated,
                in: RoundedRectangle(cornerRadius: 6, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(theme.stroke, lineWidth: 1)
            }
    }
}

struct IconActionButtonStyle: ButtonStyle {
    @Environment(\.alphaTradeTheme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(theme.secondaryText)
            .frame(width: AlphaTradeMetrics.buttonHeight, height: AlphaTradeMetrics.buttonHeight)
            .background(
                configuration.isPressed ? theme.quietButtonPressed : theme.cardElevated,
                in: RoundedRectangle(cornerRadius: 6, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(theme.stroke, lineWidth: 1)
            }
    }
}
