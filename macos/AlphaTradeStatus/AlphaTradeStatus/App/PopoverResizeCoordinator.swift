import CoreGraphics
import Foundation

struct PopoverSectionResizeRequest: Equatable {
    let heightDelta: CGFloat
    let reduceMotion: Bool
}

/// Pure state machine between SwiftUI geometry and `NSPopover`.
///
/// A section reports its final height delta before SwiftUI starts animating.
/// Expansion reserves the final popover height immediately, then SwiftUI
/// reveals the details into that space. Collapse keeps the old height while
/// SwiftUI hides the details and shrinks the popover only at completion.
/// Intermediate SwiftUI measurements are coalesced in both directions.
struct PopoverResizeCoordinator {
    static let sectionAnimationDuration: TimeInterval = 0.25

    enum Mutation: Equatable {
        case setImmediately(CGSize)
        case expandImmediately(CGSize, duration: TimeInterval)
        case collapseAfterContentAnimation(CGSize, duration: TimeInterval)

        var size: CGSize {
            switch self {
            case .setImmediately(let size),
                 .expandImmediately(let size, _),
                 .collapseAfterContentAnimation(let size, _):
                return size
            }
        }

        var transitionDuration: TimeInterval? {
            switch self {
            case .setImmediately:
                return nil
            case .expandImmediately(_, let duration),
                 .collapseAfterContentAnimation(_, let duration):
                return duration
            }
        }
    }

    private(set) var targetSize: CGSize?
    private(set) var isCoalescingSectionMeasurements = false
    private var latestCoalescedMeasurement: CGSize?
    private var isWaitingToCollapse = false

    mutating func reset(initialSize: CGSize) -> Mutation {
        let size = normalized(initialSize)
        targetSize = size
        isCoalescingSectionMeasurements = false
        latestCoalescedMeasurement = nil
        isWaitingToCollapse = false
        return .setImmediately(size)
    }

    mutating func observeMeasuredSize(
        _ measuredSize: CGSize,
        isPopoverVisible: Bool,
        reduceMotion: Bool
    ) -> Mutation? {
        let size = normalized(measuredSize)

        guard let targetSize else {
            return reset(initialSize: size)
        }

        guard !isCoalescingSectionMeasurements else {
            latestCoalescedMeasurement = size
            return nil
        }

        guard !approximatelyEqual(size, targetSize) else {
            return nil
        }

        self.targetSize = size
        return .setImmediately(size)
    }

    mutating func beginSectionTransition(
        _ request: PopoverSectionResizeRequest,
        currentContentSize: CGSize? = nil,
        isPopoverVisible: Bool
    ) -> Mutation? {
        // NSHostingController can report a 1 pt fitting height before its first
        // displayed layout even though the real hosted view already has its
        // full height. Always prefer that current frame at interaction time so
        // the first expansion cannot target `1 + detailsHeight` for one frame.
        if let currentContentSize, !isCoalescingSectionMeasurements {
            targetSize = normalized(currentContentSize)
            isCoalescingSectionMeasurements = false
            latestCoalescedMeasurement = nil
            isWaitingToCollapse = false
        }

        guard let targetSize,
              abs(request.heightDelta) > Self.measurementTolerance else {
            return nil
        }

        let nextSize = normalized(CGSize(
            width: AlphaTradeMetrics.popoverWidth,
            height: targetSize.height + request.heightDelta
        ))
        self.targetSize = nextSize
        latestCoalescedMeasurement = nil
        isWaitingToCollapse = false

        guard isPopoverVisible, !request.reduceMotion else {
            isCoalescingSectionMeasurements = false
            return .setImmediately(nextSize)
        }

        isCoalescingSectionMeasurements = true
        if request.heightDelta > 0 {
            return .expandImmediately(
                nextSize,
                duration: Self.sectionAnimationDuration
            )
        }
        isWaitingToCollapse = true
        return .collapseAfterContentAnimation(
            nextSize,
            duration: Self.sectionAnimationDuration
        )
    }

    /// Called just after the 0.25 s SwiftUI content animation. Expansion has
    /// already reserved its window height; collapse applies its smaller target
    /// here. A genuine concurrent content change is reconciled once.
    mutating func completeSectionTransition(
        isPopoverVisible _: Bool,
        reduceMotion _: Bool
    ) -> Mutation? {
        guard isCoalescingSectionMeasurements else { return nil }
        isCoalescingSectionMeasurements = false

        let wasWaitingToCollapse = isWaitingToCollapse
        isWaitingToCollapse = false

        let measuredSize = latestCoalescedMeasurement
        latestCoalescedMeasurement = nil

        if wasWaitingToCollapse, let targetSize {
            if let measuredSize, !approximatelyEqual(measuredSize, targetSize) {
                self.targetSize = measuredSize
                return .setImmediately(measuredSize)
            }
            return .setImmediately(targetSize)
        }

        guard let measuredSize else { return nil }
        guard let targetSize,
              !approximatelyEqual(measuredSize, targetSize) else {
            return nil
        }

        self.targetSize = measuredSize
        return .setImmediately(measuredSize)
    }

    private static let measurementTolerance: CGFloat = 1

    private func normalized(_ size: CGSize) -> CGSize {
        CGSize(
            width: AlphaTradeMetrics.popoverWidth,
            height: max(1, ceil(size.height))
        )
    }

    private func approximatelyEqual(_ lhs: CGSize, _ rhs: CGSize) -> Bool {
        abs(lhs.width - rhs.width) <= Self.measurementTolerance
            && abs(lhs.height - rhs.height) <= Self.measurementTolerance
    }
}
