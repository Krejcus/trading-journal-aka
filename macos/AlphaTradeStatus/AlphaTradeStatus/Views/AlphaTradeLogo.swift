import AppKit
import SwiftUI

struct AlphaTradeLogo: View {
    let height: CGFloat

    var body: some View {
        Group {
            if let logoImage = Self.logoImage {
                Image(nsImage: logoImage)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Text("AT")
                    .font(.system(size: height * 0.72, weight: .black))
            }
        }
        .frame(width: height * Self.logoAspectRatio, height: height)
        .fixedSize()
        .accessibilityHidden(true)
    }

    static let menuBarHeight: CGFloat = 17

    static var menuBarLogicalSize: NSSize {
        NSSize(
            width: menuBarHeight * logoAspectRatio,
            height: menuBarHeight
        )
    }

    static let logoImage: NSImage? = {
        let bundles = [Bundle.main, Bundle(for: BundleToken.self)]
        for bundle in bundles {
            if let url = bundle.url(forResource: "at-logo", withExtension: "png"),
               let image = NSImage(contentsOf: url) {
                return image
            }
        }
        return nil
    }()

    static let menuBarImage: NSImage? = {
        guard let source = logoImage else {
            return nil
        }

        let image = NSImage(size: menuBarLogicalSize, flipped: false) { destination in
            NSGraphicsContext.current?.imageInterpolation = .high
            source.draw(
                in: destination,
                from: NSRect(origin: .zero, size: source.size),
                operation: .sourceOver,
                fraction: 1
            )
            return true
        }
        // The user explicitly chose the original colored glass mark. A template
        // image would flatten it into the system menu-bar tint.
        image.isTemplate = false
        return image
    }()

    private static var logoAspectRatio: CGFloat {
        guard let logoImage, logoImage.size.height > 0 else {
            return 1
        }
        return logoImage.size.width / logoImage.size.height
    }
}

struct AlphaTradeMenuBarLogo: View {
    var body: some View {
        Group {
            if let image = AlphaTradeLogo.menuBarImage {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Text("AT")
                    .font(.system(size: 12, weight: .black))
            }
        }
        .frame(
            width: AlphaTradeLogo.menuBarLogicalSize.width,
            height: AlphaTradeLogo.menuBarLogicalSize.height
        )
        .fixedSize()
        .accessibilityHidden(true)
    }
}

private final class BundleToken: NSObject {}
