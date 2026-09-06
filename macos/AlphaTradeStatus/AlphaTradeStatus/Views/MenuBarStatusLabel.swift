import AppKit

enum MenuBarStatusArtwork {
    enum Appearance: Equatable {
        case light
        case dark

        init(effectiveAppearance: NSAppearance) {
            self = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? .dark
                : .light
        }
    }

    static let systemContentInset: CGFloat = 3
    static let buttonCornerRadius: CGFloat = 7

    private static let contentHeight: CGFloat = 22
    private static let outerHorizontalPadding: CGFloat = 7
    private static let logoTextSpacing: CGFloat = 6
    private static let textTracking: CGFloat = 0.12

    static func contentImage(
        for presentation: MenuBarStatusPresentation,
        appearance: Appearance
    ) -> NSImage? {
        guard let logo = AlphaTradeLogo.menuBarImage else {
            return nil
        }

        let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let textColor = token(for: presentation.tone, appearance: appearance).text
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: textColor,
            .kern: textTracking
        ]
        let pillText = presentation.pillText
        let textSize = pillText.map {
            ($0 as NSString).size(withAttributes: attributes)
        } ?? .zero
        let innerHorizontalPadding = outerHorizontalPadding - systemContentInset
        let artworkSize = NSSize(
            width: ceil(
                innerHorizontalPadding
                    + logo.size.width
                    + (pillText == nil ? 0 : logoTextSpacing + textSize.width)
                    + innerHorizontalPadding
            ),
            height: contentHeight
        )

        let image = NSImage(size: artworkSize, flipped: true) { _ in
            NSGraphicsContext.current?.imageInterpolation = .high

            let logoRect = NSRect(
                x: innerHorizontalPadding,
                y: floor((contentHeight - logo.size.height) / 2),
                width: logo.size.width,
                height: logo.size.height
            )
            logo.draw(
                in: logoRect,
                from: NSRect(origin: .zero, size: logo.size),
                operation: .sourceOver,
                fraction: 1,
                respectFlipped: true,
                hints: [.interpolation: NSImageInterpolation.high]
            )

            if let pillText {
                let textRect = NSRect(
                    x: logoRect.maxX + logoTextSpacing,
                    y: floor((contentHeight - textSize.height) / 2),
                    width: ceil(textSize.width),
                    height: ceil(textSize.height)
                )
                (pillText as NSString).draw(in: textRect, withAttributes: attributes)
            }
            return true
        }
        image.isTemplate = false
        return image
    }

    static func buttonBackground(
        for presentation: MenuBarStatusPresentation,
        appearance: Appearance
    ) -> NSColor? {
        guard presentation.pillText != nil else {
            return nil
        }
        let token = token(for: presentation.tone, appearance: appearance)
        return opaqueBlend(
            token.fill,
            fraction: token.opacity,
            over: appearance.menuBarSurface
        )
    }

    private struct Token {
        let fill: NSColor
        let opacity: CGFloat
        let text: NSColor
    }

    private static func token(
        for tone: StatusTone,
        appearance: Appearance
    ) -> Token {
        switch (appearance, tone) {
        case (.light, .success):
            return Token(
                fill: NSColor(srgbRed: 16 / 255, green: 185 / 255, blue: 129 / 255, alpha: 1),
                opacity: 0.16,
                text: NSColor(srgbRed: 4 / 255, green: 120 / 255, blue: 87 / 255, alpha: 1)
            )
        case (.light, .danger):
            return Token(
                fill: NSColor(srgbRed: 244 / 255, green: 63 / 255, blue: 94 / 255, alpha: 1),
                opacity: 0.14,
                text: NSColor(srgbRed: 190 / 255, green: 18 / 255, blue: 60 / 255, alpha: 1)
            )
        case (.light, .warning):
            return Token(
                fill: NSColor(srgbRed: 217 / 255, green: 119 / 255, blue: 6 / 255, alpha: 1),
                opacity: 0.14,
                text: NSColor(srgbRed: 146 / 255, green: 64 / 255, blue: 14 / 255, alpha: 1)
            )
        case (.light, .neutral), (.light, .muted):
            return Token(
                fill: .black,
                opacity: 0.07,
                text: NSColor(white: 0, alpha: 0.82)
            )
        case (.dark, .success):
            return Token(
                fill: NSColor(srgbRed: 16 / 255, green: 185 / 255, blue: 129 / 255, alpha: 1),
                opacity: 0.22,
                text: NSColor(srgbRed: 167 / 255, green: 243 / 255, blue: 208 / 255, alpha: 1)
            )
        case (.dark, .danger):
            return Token(
                fill: NSColor(srgbRed: 244 / 255, green: 63 / 255, blue: 94 / 255, alpha: 1),
                opacity: 0.26,
                text: NSColor(srgbRed: 254 / 255, green: 205 / 255, blue: 211 / 255, alpha: 1)
            )
        case (.dark, .warning):
            return Token(
                fill: NSColor(srgbRed: 245 / 255, green: 158 / 255, blue: 11 / 255, alpha: 1),
                opacity: 0.22,
                text: NSColor(srgbRed: 253 / 255, green: 230 / 255, blue: 138 / 255, alpha: 1)
            )
        case (.dark, .neutral), (.dark, .muted):
            return Token(
                fill: .white,
                opacity: 0.10,
                text: NSColor(white: 1, alpha: 0.88)
            )
        }
    }

    private static func opaqueBlend(
        _ foreground: NSColor,
        fraction: CGFloat,
        over background: NSColor
    ) -> NSColor {
        let foreground = foreground.usingColorSpace(.sRGB) ?? foreground
        let background = background.usingColorSpace(.sRGB) ?? background
        let inverse = 1 - fraction

        return NSColor(
            srgbRed: foreground.redComponent * fraction + background.redComponent * inverse,
            green: foreground.greenComponent * fraction + background.greenComponent * inverse,
            blue: foreground.blueComponent * fraction + background.blueComponent * inverse,
            alpha: 1
        )
    }
}

enum MenuBarStatusButtonStyle {
    @discardableResult
    static func apply(
        to button: NSStatusBarButton,
        presentation: MenuBarStatusPresentation,
        appearance: MenuBarStatusArtwork.Appearance
    ) -> NSSize {
        button.title = ""
        button.image = MenuBarStatusArtwork.contentImage(
            for: presentation,
            appearance: appearance
        )
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleNone
        button.isBordered = false
        button.focusRingType = .none
        button.wantsLayer = true
        button.layer?.backgroundColor = MenuBarStatusArtwork.buttonBackground(
            for: presentation,
            appearance: appearance
        )?.cgColor
        button.layer?.cornerRadius = MenuBarStatusArtwork.buttonCornerRadius
        button.layer?.masksToBounds = true

        if let cell = button.cell as? NSButtonCell {
            cell.highlightsBy = []
            cell.showsStateBy = []
        }

        let contentSize = button.image?.size ?? .zero
        let buttonSize = NSSize(
            width: ceil(contentSize.width + (2 * MenuBarStatusArtwork.systemContentInset)),
            height: ceil(contentSize.height + (2 * MenuBarStatusArtwork.systemContentInset))
        )
        button.frame.size = buttonSize
        return buttonSize
    }
}

private extension MenuBarStatusArtwork.Appearance {
    var menuBarSurface: NSColor {
        switch self {
        case .light:
            return NSColor(
                srgbRed: 250 / 255,
                green: 250 / 255,
                blue: 252 / 255,
                alpha: 1
            )
        case .dark:
            return NSColor(
                srgbRed: 18 / 255,
                green: 22 / 255,
                blue: 36 / 255,
                alpha: 1
            )
        }
    }
}
