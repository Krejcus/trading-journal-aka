import CoreGraphics
import XCTest
@testable import AlphaTradeStatus

final class PopoverResizeCoordinatorTests: XCTestCase {
    func testExpansionUsesCurrentHostedHeightInsteadOfColdFittingSize() {
        var coordinator = PopoverResizeCoordinator()
        _ = coordinator.reset(initialSize: CGSize(width: 360, height: 1))

        XCTAssertEqual(
            coordinator.beginSectionTransition(
                .init(heightDelta: 130, reduceMotion: false),
                currentContentSize: CGSize(width: 360, height: 487),
                isPopoverVisible: true
            ),
            .expandImmediately(
                CGSize(width: 360, height: 617),
                duration: 0.25
            )
        )
    }

    func testRapidReversalKeepsThePendingTargetAsItsBase() {
        var coordinator = PopoverResizeCoordinator()
        _ = coordinator.reset(initialSize: CGSize(width: 360, height: 487))

        _ = coordinator.beginSectionTransition(
            .init(heightDelta: -130, reduceMotion: false),
            currentContentSize: CGSize(width: 360, height: 617),
            isPopoverVisible: true
        )
        XCTAssertEqual(
            coordinator.beginSectionTransition(
                .init(heightDelta: 130, reduceMotion: false),
                currentContentSize: CGSize(width: 360, height: 617),
                isPopoverVisible: true
            ),
            .expandImmediately(
                CGSize(width: 360, height: 617),
                duration: 0.25
            )
        )
    }

    func testExpansionReservesFinalHeightBeforeContentAnimation() {
        var coordinator = PopoverResizeCoordinator()
        XCTAssertEqual(
            coordinator.reset(initialSize: CGSize(width: 360, height: 300)),
            .setImmediately(CGSize(width: 360, height: 300))
        )

        let target = coordinator.beginSectionTransition(
            .init(heightDelta: 100, reduceMotion: false),
            isPopoverVisible: true
        )
        XCTAssertEqual(target, .expandImmediately(
            CGSize(width: 360, height: 400),
            duration: 0.25
        ))

        for height in [318.0, 351.5, 383.0, 399.5] {
            XCTAssertNil(coordinator.observeMeasuredSize(
                CGSize(width: 360, height: height),
                isPopoverVisible: true,
                reduceMotion: false
            ))
        }
        XCTAssertNil(coordinator.completeSectionTransition(
            isPopoverVisible: true,
            reduceMotion: false
        ))
        XCTAssertEqual(coordinator.targetSize, CGSize(width: 360, height: 400))
    }

    func testCollapseNeverIssuesAnImmediateClippingResizeDuringAnimation() {
        var coordinator = PopoverResizeCoordinator()
        _ = coordinator.reset(initialSize: CGSize(width: 360, height: 400))

        let target = coordinator.beginSectionTransition(
            .init(heightDelta: -100, reduceMotion: false),
            isPopoverVisible: true
        )
        XCTAssertEqual(target, .collapseAfterContentAnimation(
            CGSize(width: 360, height: 300),
            duration: 0.25
        ))

        for height in [389.0, 366.0, 332.0, 300.4] {
            let mutation = coordinator.observeMeasuredSize(
                CGSize(width: 360, height: height),
                isPopoverVisible: true,
                reduceMotion: false
            )
            XCTAssertNil(mutation, "Intermediate collapse geometry must not clip the content")
        }
        XCTAssertTrue(coordinator.isCoalescingSectionMeasurements)
        XCTAssertEqual(
            coordinator.completeSectionTransition(
                isPopoverVisible: true,
                reduceMotion: false
            ),
            .setImmediately(CGSize(width: 360, height: 300))
        )
        XCTAssertFalse(coordinator.isCoalescingSectionMeasurements)
    }

    func testReduceMotionChangesSizeImmediatelyWithoutCoalescing() {
        var coordinator = PopoverResizeCoordinator()
        _ = coordinator.reset(initialSize: CGSize(width: 512, height: 300.2))

        XCTAssertEqual(
            coordinator.beginSectionTransition(
                .init(heightDelta: 99.2, reduceMotion: true),
                isPopoverVisible: true
            ),
            .setImmediately(CGSize(width: 360, height: 401))
        )
        XCTAssertFalse(coordinator.isCoalescingSectionMeasurements)
    }
}
