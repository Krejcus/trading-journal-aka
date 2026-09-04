import AppKit
import SwiftUI
import XCTest
@testable import AlphaTradeStatus

@MainActor
final class StatusPopoverViewRenderTests: XCTestCase {
    func testTransitionExpansionKeepsRequiredAndManuallyExpandedSections() {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .intervention)
        let transition = CompanionTransition(
            category: .worsening,
            sectionID: "runtime",
            rowID: "broker-connection",
            reason: "Brokerové spojení bylo přerušeno."
        )

        let initial = CompanionSectionExpansionPolicy.initialSectionIDs(
            in: presentation,
            transition: transition
        )
        XCTAssertEqual(initial, ["safety", "exposure", "runtime"])

        let updated = CompanionSectionExpansionPolicy.applying(
            transition,
            to: ["snapshots"],
            in: presentation
        )
        XCTAssertEqual(updated, ["safety", "exposure", "runtime", "snapshots"])
    }

    func testBundledLogoIsAvailableToTheNativeView() {
        XCTAssertNotNil(AlphaTradeLogo.logoImage)
    }

    func testMenuBarLogoHasBoundedNativePointSize() throws {
        let image = try XCTUnwrap(AlphaTradeLogo.menuBarImage)

        XCTAssertEqual(image.size.height, 17, accuracy: 0.01)
        XCTAssertGreaterThan(image.size.width, 17)
        XCTAssertLessThan(image.size.width, 23)
        XCTAssertFalse(image.isTemplate)

        let button = NSStatusBarButton(frame: .zero)
        button.image = image
        button.sizeToFit()
        XCTAssertLessThanOrEqual(button.fittingSize.height, 24)
        XCTAssertLessThan(button.fittingSize.width, 36)
    }

    func testNativeStatusButtonOwnsOneDynamicSystemSizedPill() throws {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .live)
        let lightButton = NSStatusBarButton(frame: .zero)
        let lightSize = MenuBarStatusButtonStyle.apply(
            to: lightButton,
            presentation: presentation.menuBar,
            appearance: .light
        )
        XCTAssertEqual(lightSize.height, 28, accuracy: 0.01)
        XCTAssertGreaterThan(lightSize.width, 60)
        XCTAssertLessThan(lightSize.width, 120)
        XCTAssertEqual(lightButton.frame.size, lightSize)
        let lightImage = try XCTUnwrap(lightButton.image)
        XCTAssertFalse(lightImage.isTemplate)
        XCTAssertEqual(lightImage.size.height, 22, accuracy: 0.01)
        XCTAssertFalse(lightButton.isBordered)
        let lightCell = try XCTUnwrap(lightButton.cell as? NSButtonCell)
        XCTAssertTrue(lightCell.highlightsBy.isEmpty)
        XCTAssertTrue(lightCell.showsStateBy.isEmpty)

        let lightBackground = try XCTUnwrap(lightButton.layer?.backgroundColor)
        let lightColor = try XCTUnwrap(
            NSColor(cgColor: lightBackground)?.usingColorSpace(.sRGB)
        )
        XCTAssertGreaterThan(lightColor.redComponent, 0.80)
        XCTAssertGreaterThan(lightColor.greenComponent, 0.92)
        XCTAssertGreaterThan(lightColor.blueComponent, 0.88)
        XCTAssertGreaterThan(lightColor.greenComponent, lightColor.redComponent)

        let darkButton = NSStatusBarButton(frame: .zero)
        let darkSize = MenuBarStatusButtonStyle.apply(
            to: darkButton,
            presentation: presentation.menuBar,
            appearance: .dark
        )
        XCTAssertEqual(darkSize, lightSize)
        let darkBackground = try XCTUnwrap(darkButton.layer?.backgroundColor)
        let darkColor = try XCTUnwrap(
            NSColor(cgColor: darkBackground)?.usingColorSpace(.sRGB)
        )
        XCTAssertLessThan(darkColor.redComponent, 0.20)
        XCTAssertLessThan(darkColor.greenComponent, 0.35)
        XCTAssertLessThan(darkColor.blueComponent, 0.35)
        XCTAssertGreaterThan(
            lightColor.brightnessComponent,
            darkColor.brightnessComponent + 0.40
        )

        lightButton.layoutSubtreeIfNeeded()
        lightButton.displayIfNeeded()
        let bitmap = try XCTUnwrap(
            lightButton.bitmapImageRepForCachingDisplay(in: lightButton.bounds)
        )
        lightButton.cacheDisplay(in: lightButton.bounds, to: bitmap)

        var paleGreenPixels = 0
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else {
                    continue
                }
                if color.greenComponent - color.redComponent > 0.05,
                   color.greenComponent - color.blueComponent > 0.02,
                   color.redComponent > 0.65,
                   color.alphaComponent > 0.9 {
                    paleGreenPixels += 1
                }
            }
        }

        XCTAssertGreaterThan(
            paleGreenPixels,
            500,
            "LIVE status item must visibly render its green rounded container"
        )

        let outputDirectory = try snapshotDirectory(named: "AlphaTradeStatusMenuBarSnapshots")
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )
        let pngData = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try pngData.write(
            to: outputDirectory.appendingPathComponent("live-light.png"),
            options: .atomic
        )
    }

    func testVypnutoMenuBarPillRendersRosePowerSymbolAndText() throws {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .disarmedUnverified)
        XCTAssertEqual(presentation.menuBar.symbolName, "power")

        let button = NSStatusBarButton(frame: .zero)
        let size = MenuBarStatusButtonStyle.apply(
            to: button,
            presentation: presentation.menuBar,
            appearance: .light
        )
        XCTAssertEqual(size.height, 28, accuracy: 0.01)
        XCTAssertGreaterThan(size.width, 85)
        XCTAssertLessThan(size.width, 160)

        let withoutSymbol = MenuBarStatusPresentation(
            pillText: "VYPNUTO",
            tone: .danger,
            accessibilityLabel: "test"
        )
        let imageWithSymbol = try XCTUnwrap(button.image)
        let imageWithoutSymbol = try XCTUnwrap(MenuBarStatusArtwork.contentImage(
            for: withoutSymbol,
            appearance: .light
        ))
        XCTAssertGreaterThan(imageWithSymbol.size.width, imageWithoutSymbol.size.width)

        let background = try XCTUnwrap(button.layer?.backgroundColor)
        let color = try XCTUnwrap(NSColor(cgColor: background)?.usingColorSpace(.sRGB))
        XCTAssertGreaterThan(color.redComponent, color.greenComponent + 0.05)
        XCTAssertGreaterThan(color.redComponent, color.blueComponent + 0.04)
    }

    func testZamcenoMenuBarPillRendersRoseLockSymbolAndText() throws {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .locked)
        XCTAssertEqual(presentation.menuBar.symbolName, "lock.fill")
        XCTAssertEqual(presentation.menuBar.pillText, "ZAMČENO")

        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let button = NSStatusBarButton(frame: .zero)
            let size = MenuBarStatusButtonStyle.apply(
                to: button,
                presentation: presentation.menuBar,
                appearance: appearance == .darkAqua ? .dark : .light
            )
            XCTAssertEqual(size.height, 28, accuracy: 0.01)
            XCTAssertGreaterThan(size.width, 95)
            XCTAssertNotNil(button.image)

            let background = try XCTUnwrap(button.layer?.backgroundColor)
            let color = try XCTUnwrap(NSColor(cgColor: background)?.usingColorSpace(.sRGB))
            XCTAssertGreaterThan(color.redComponent, color.greenComponent)
            XCTAssertGreaterThan(color.redComponent, color.blueComponent)
        }
    }

    func testStatusPopoverCompletesLayoutInLightAndDarkModes() {
        let fixtures: [CompanionFixtureID] = [.live, .disarmedUnverified, .locked, .intervention]
        let schemes: [(name: String, value: ColorScheme)] = [
            ("light", .light),
            ("dark", .dark)
        ]

        for fixtureID in fixtures {
            for scheme in schemes {
                assertLayoutCompletes(
                    presentation: CompanionMockFixtureCatalog.presentation(for: fixtureID),
                    colorScheme: scheme.value,
                    context: "\(fixtureID.rawValue)-\(scheme.name)"
                )
            }
        }
    }

    func testVypnutoPopoverRendersInLightAndDarkModes() throws {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .disarmedUnverified)
        for scheme in [ColorScheme.light, .dark] {
            let data = try renderPNG(presentation: presentation, colorScheme: scheme)
            XCTAssertGreaterThan(data.count, 15_000)
        }
    }

    func testZamcenoPopoverRendersInLightAndDarkModes() throws {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .locked)
        for scheme in [ColorScheme.light, .dark] {
            let data = try renderPNG(presentation: presentation, colorScheme: scheme)
            XCTAssertGreaterThan(data.count, 15_000)
        }
    }

    func testCollapsedSectionsExposeTheirTargetDetailHeights() {
        let presentation = CompanionMockFixtureCatalog.presentation(for: .disarmed)
        var measuredHeights: [String: CGFloat] = [:]
        let rootView = StatusPopoverView(presentation: presentation)
            .environment(\.alphaTradeTheme, AlphaTradeTheme.light)
            .onPreferenceChange(StatusSectionDetailsHeightPreferenceKey.self) {
                measuredHeights = $0
            }

        let hostingView = NSHostingView(rootView: rootView)
        hostingView.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
        hostingView.layoutSubtreeIfNeeded()

        XCTAssertEqual(Set(measuredHeights.keys), Set(presentation.sections.map(\.id)))
        XCTAssertTrue(measuredHeights.values.allSatisfy { $0 > 10 })
    }

    func testRendersEveryFixtureToInspectableLightAndDarkPNGs() throws {
        let outputDirectory = try snapshotDirectory(named: "AlphaTradeStatusSnapshots")
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: outputDirectory.path) {
            try fileManager.removeItem(at: outputDirectory)
        }
        try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

        for fixtureID in CompanionMockFixtureCatalog.orderedIDs {
            for scheme in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
                let destination = outputDirectory
                    .appendingPathComponent("\(fixtureID.rawValue)-\(scheme.0).png")
                let data = try renderPNG(
                    presentation: CompanionMockFixtureCatalog.presentation(for: fixtureID),
                    colorScheme: scheme.1
                )
                try data.write(to: destination, options: .atomic)
                XCTAssertGreaterThan(data.count, 15_000, destination.lastPathComponent)
            }
        }

        let renderedNames = try fileManager.contentsOfDirectory(atPath: outputDirectory.path)
        XCTAssertEqual(renderedNames.filter { $0.hasSuffix(".png") }.count, 20)
    }

    private func assertLayoutCompletes(
        presentation: CompanionPresentation,
        colorScheme: ColorScheme,
        context: String
    ) {
        let rootView = StatusPopoverEntranceView(
            presentation: presentation,
            onAction: { _ in }
        )
            .environment(\.colorScheme, colorScheme)
            .environment(\.alphaTradeTheme, AlphaTradeTheme.palette(for: colorScheme))
            .transaction { transaction in
                transaction.disablesAnimations = true
            }

        let hostingView = NSHostingView(rootView: rootView)
        let window = NSWindow(
            contentRect: NSRect(
                x: -10_000,
                y: -10_000,
                width: AlphaTradeMetrics.popoverWidth,
                height: 720
            ),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hostingView
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.contentView = nil
            window.close()
        }

        hostingView.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
        hostingView.layoutSubtreeIfNeeded()

        let fittingSize = hostingView.fittingSize
        XCTAssertEqual(
            fittingSize.width,
            AlphaTradeMetrics.popoverWidth,
            accuracy: 0.5,
            context
        )
        XCTAssertGreaterThan(fittingSize.height, 100, context)
        XCTAssertLessThanOrEqual(fittingSize.height, 720.5, context)
        XCTAssertFalse(hostingView.needsLayout, context)
        XCTAssertFalse(hostingView.hasAmbiguousLayout, context)
    }

    private func snapshotDirectory(named name: String) throws -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(name, isDirectory: true)
    }

    private func renderPNG(
        presentation: CompanionPresentation,
        colorScheme: ColorScheme
    ) throws -> Data {
        let canvasColor = colorScheme == .dark
            ? Color(hex: 0x020617)
            : Color(hex: 0xF1F5F9)
        let rootView = StatusPopoverView(presentation: presentation)
        .environment(\.colorScheme, colorScheme)
        .environment(\.alphaTradeTheme, AlphaTradeTheme.palette(for: colorScheme))
        .padding(20)
        .frame(width: 400, height: 760, alignment: .top)
        .background(canvasColor)
        .transaction { transaction in
            transaction.disablesAnimations = true
        }

        let hostingView = NSHostingView(rootView: rootView)
        hostingView.frame = NSRect(x: 0, y: 0, width: 400, height: 760)
        hostingView.appearance = NSAppearance(
            named: colorScheme == .dark ? .darkAqua : .aqua
        )
        hostingView.wantsLayer = true
        hostingView.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()

        guard let bitmap = hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds) else {
            throw RenderError.bitmapCreationFailed
        }
        hostingView.cacheDisplay(in: hostingView.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw RenderError.pngEncodingFailed
        }
        return data
    }

    private enum RenderError: Error {
        case bitmapCreationFailed
        case pngEncodingFailed
    }
}
