import AppKit
import XCTest

final class AlphaTradeStatusUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false

        app = XCUIApplication()
        if app.state != .notRunning {
            app.terminate()
        }
        app.launchEnvironment["ALPHATRADE_STATUS_FIXTURE"] = "live"
        app.launch()
    }

    override func tearDownWithError() throws {
        if app.state != .notRunning {
            app.terminate()
        }
        app = nil
    }

    func testNativeStatusItemOpensAndReopensWithVisibleLiveContent() throws {
        let statusItem = try requireStatusItem()
        assertSaneStatusItemFrame(statusItem.frame)
        attachScreen(named: "01-menu-bar-status-item")

        statusItem.click()
        let popover = try requirePopover()
        assertSanePopoverFrame(popover.frame)
        assertLiveContentIsVisible()
        attachScreen(named: "02-live-popover-open")

        let safetySection = requireElement(
            in: app.buttons,
            labelContaining: "Bezpečnost",
            description: "collapsed safety section"
        )
        safetySection.click()

        let reconciliationRow = requireElement(
            in: app.descendants(matching: .any),
            labelContaining: "Reconciliation",
            description: "expanded safety row"
        )
        XCTAssertTrue(
            reconciliationRow.isHittable,
            "The expanded safety row exists in Accessibility but is not visibly hittable."
        )
        attachScreen(named: "03-safety-section-expanded")

        popover.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(
            waitUntil(timeout: 3) { !popover.exists || !popover.isHittable },
            "The native status-item popover did not close after Escape."
        )

        statusItem.click()
        _ = try requirePopover()
        assertLiveContentIsVisible()
        attachScreen(named: "04-live-popover-reopened")
    }

    private func requireStatusItem() throws -> XCUIElement {
        let systemUIServer = XCUIApplication(bundleIdentifier: "com.apple.systemuiserver")
        let predicate = NSPredicate(
            format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@",
            "AlphaTrade",
            "LIVE"
        )

        let candidates = [
            app.statusItems.matching(predicate).firstMatch,
            app.menuBarItems.matching(predicate).firstMatch,
            app.menuBars.statusItems.matching(predicate).firstMatch,
            systemUIServer.statusItems.matching(predicate).firstMatch,
            systemUIServer.menuBarItems.matching(predicate).firstMatch,
            systemUIServer.menuBars.statusItems.matching(predicate).firstMatch
        ]

        if let statusItem = firstExistingElement(in: candidates, timeout: 5) {
            return statusItem
        }

        attachScreen(named: "failure-status-item-not-found")
        XCTFail(
            "Could not locate the real AlphaTrade status item through the app or SystemUIServer Accessibility trees.\n" +
            "App tree:\n\(app.debugDescription)\n\n" +
            "SystemUIServer tree:\n\(systemUIServer.debugDescription)"
        )
        throw RuntimeGateError.statusItemNotFound
    }

    private func requirePopover() throws -> XCUIElement {
        let candidates = [
            app.windows.firstMatch,
            app.popovers.firstMatch
        ]

        if let popover = firstExistingElement(in: candidates, timeout: 4) {
            return popover
        }

        attachScreen(named: "failure-popover-not-found")
        XCTFail(
            "The status item was clicked, but no native app window or popover appeared.\n" +
            "App tree:\n\(app.debugDescription)"
        )
        throw RuntimeGateError.popoverNotFound
    }

    private func assertLiveContentIsVisible() {
        let expectedLabels = [
            "AlphaTrade Status",
            "LIVE",
            "Kopírování · 2 pozice"
        ]

        for label in expectedLabels {
            let element = requireElement(
                in: app.descendants(matching: .any),
                labelContaining: label,
                description: "visible popover content \(label)"
            )
            XCTAssertFalse(element.frame.isEmpty, "\(label) has an empty native frame.")
        }

        let primaryAction = requireElement(
            in: app.buttons,
            labelContaining: "Otevřít AlphaTrade LIVE",
            description: "primary LIVE action"
        )
        XCTAssertTrue(
            primaryAction.isHittable,
            "The primary action exists in Accessibility but is not visibly hittable; the popover may be transparent."
        )
    }

    private func requireElement(
        in query: XCUIElementQuery,
        labelContaining text: String,
        description: String
    ) -> XCUIElement {
        let element = query
            .matching(NSPredicate(format: "label CONTAINS[c] %@", text))
            .firstMatch

        if !element.waitForExistence(timeout: 3) {
            attachScreen(named: "failure-\(sanitizedFilename(description))")
            XCTFail("Missing \(description) containing accessibility label: \(text)")
        }
        return element
    }

    private func assertSaneStatusItemFrame(_ frame: CGRect) {
        let maximumHeight = NSStatusBar.system.thickness + 4

        XCTAssertGreaterThan(frame.width, 12, "The status item is unexpectedly narrow: \(frame)")
        XCTAssertLessThanOrEqual(
            frame.width,
            120,
            "The status item is wider than a compact logo plus LIVE pill: \(frame)"
        )
        XCTAssertGreaterThan(frame.height, 12, "The status item is unexpectedly short: \(frame)")
        XCTAssertLessThanOrEqual(
            frame.height,
            maximumHeight,
            "The status item exceeds the native menu-bar height: \(frame), maximum \(maximumHeight)"
        )
    }

    private func assertSanePopoverFrame(_ frame: CGRect) {
        XCTAssertGreaterThanOrEqual(frame.width, 320, "Popover is too narrow: \(frame)")
        XCTAssertLessThanOrEqual(frame.width, 430, "Popover is unexpectedly wide: \(frame)")
        XCTAssertGreaterThan(frame.height, 200, "Popover has no meaningful content height: \(frame)")
    }

    private func firstExistingElement(
        in candidates: [XCUIElement],
        timeout: TimeInterval
    ) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let element = candidates.first(where: \.exists) {
                return element
            }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline

        return candidates.first(where: \.exists)
    }

    private func waitUntil(
        timeout: TimeInterval,
        condition: () -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() {
                return true
            }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline

        return condition()
    }

    private func attachScreen(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func sanitizedFilename(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .replacingOccurrences(of: "·", with: "-")
    }

    private enum RuntimeGateError: Error {
        case statusItemNotFound
        case popoverNotFound
    }
}
