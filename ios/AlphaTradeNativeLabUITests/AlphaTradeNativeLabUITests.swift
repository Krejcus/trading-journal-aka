import XCTest

final class AlphaTradeNativeLabUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()
    }

    func testPrimaryNavigationExposesNativeCapabilities() {
        app.buttons["nav.more"].tap()
        app.buttons["more.lab"].tap()
        XCTAssertTrue(app.buttons["notifications.schedule.gallery"].waitForExistence(timeout: 3))
        let gallery = app.buttons["notifications.gallery.expand"]
        XCTAssertTrue(gallery.exists)
        gallery.tap()
        XCTAssertTrue(app.buttons["notifications.schedule.instant"].waitForExistence(timeout: 3))
        gallery.tap()
        app.swipeUp()
        XCTAssertTrue(app.buttons["widgets.refresh"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.segmentedControls["widgets.privacy"].exists)
        app.swipeUp()
        XCTAssertTrue(app.buttons["native.test.activity"].exists)
        XCTAssertTrue(app.buttons["native.test.ocr"].exists)
        XCTAssertTrue(app.buttons["native.test.privacy"].exists)
        app.swipeUp()
        XCTAssertTrue(app.buttons["native.test.speech"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["native.haptic.success"].exists)
        app.buttons["native.haptic.success"].tap()
        XCTAssertTrue(app.staticTexts["Přehráno: úspěch."].exists)
        XCTAssertTrue(app.buttons["quick.capture"].waitForExistence(timeout: 3))

        app.buttons["nav.coach"].tap()
        XCTAssertTrue(app.buttons["Nová konverzace"].waitForExistence(timeout: 3))
        app.buttons["Nová konverzace"].tap()
        XCTAssertTrue(app.buttons["coach.localSummary"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["coach.dictation"].exists)
        XCTAssertTrue(app.buttons["coach.memory"].exists)

        app.buttons["nav.more"].tap()
        app.buttons["more.replay"].tap()
        XCTAssertTrue(app.buttons["replay.play"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["replay.next"].exists)
        XCTAssertTrue(app.buttons["replay.long"].exists)
        XCTAssertTrue(app.buttons["replay.short"].exists)
        XCTAssertTrue(app.staticTexts["No-lookahead guard aktivní"].exists)

        app.buttons["nav.more"].tap()
        app.buttons["more.live"].tap()
        XCTAssertTrue(app.staticTexts["Connections"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Bezpečný lokální režim"].exists)
        XCTAssertTrue(app.staticTexts["READ ONLY"].exists)
    }

    func testQuickCaptureCanSaveLocalTrade() {
        let capture = app.buttons["quick.capture"]
        capture.tap()
        let result = app.textFields["capture.result"]
        if !result.waitForExistence(timeout: 3) {
            // iOS Simulator occasionally acknowledges the first synthesized
            // toolbar tap without dispatching it after a cloned test launch.
            capture.tap()
        }
        XCTAssertTrue(result.waitForExistence(timeout: 5))

        let save = app.buttons["capture.save"]
        XCTAssertTrue(save.exists)
        save.tap()

        XCTAssertTrue(app.buttons["quick.capture"].waitForExistence(timeout: 3))
        XCTAssertFalse(save.isHittable)
        app.buttons["nav.journal"].tap()
        let newestTrade = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "trade.expand.")
        ).firstMatch
        XCTAssertTrue(newestTrade.waitForExistence(timeout: 3))
        let tradeIdentifier = newestTrade.identifier.replacingOccurrences(of: "trade.expand.", with: "")
        newestTrade.tap()
        XCTAssertTrue(app.staticTexts["trade.note.\(tradeIdentifier)"].waitForExistence(timeout: 3))
    }

    func testPrivacyModeRemovesFinancialUIFromAccessibilityTree() {
        app.buttons["privacy.toggle"].tap()
        XCTAssertTrue(app.buttons["privacy.unlock"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["quick.capture"].exists)
        XCTAssertFalse(app.buttons["quick.capture"].exists)
    }

    func testSpotlightHandoffOpensAndExpandsExactTrade() {
        app.terminate()
        app.launchArguments = ["-ui-testing", "-ui-testing-spotlight-first"]
        app.launch()

        XCTAssertTrue(app.staticTexts["DENÍK"].waitForExistence(timeout: 5))
        let focusedNote = app.staticTexts.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "trade.note.")
        ).firstMatch
        XCTAssertTrue(focusedNote.waitForExistence(timeout: 5))
    }
}
