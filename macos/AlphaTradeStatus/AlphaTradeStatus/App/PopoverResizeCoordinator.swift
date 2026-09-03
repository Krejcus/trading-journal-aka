import CoreGraphics
import Foundation

struct PopoverSectionResizeRequest: Equatable {
    let heightDelta: CGFloat
    let reduceMotion: Bool
}

/// Pure state machine between SwiftUI geometry and `NSPopover`.
///
/// A section reports its final height delta before SwiftUI starts animating.
/// The coordinator emits exactly one AppKit target for that transition and
/// coalesces the intermediate geometry samples produced during the animation.
struct PopoverResizeCoordinator {
    static let sectionAnimationDuration: TimeInterval = 0.25

    enum Mutation: Equatable {
        case setImmediately(CGSize)
        case animate(CGSize, duration: TimeInterval)

        var size: CGSize {
            switch self {
            case .setImmediately(let size), .animate(let size, _):
                return size
            }
        }
    }

    private(set) var targetSize: CGSize?
    private(set) var isCoalescingSectionMeasurements = false
    private var latestCoalescedMeasurement: CGSize?

    mutating func reset(initialSize: CGSize) -> Mutation {
        let size = normalized(initialSize)
        targetSize = size
        isCoalescingSectionMeasurements = false
        latestCoalescedMeasurement = nil
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
        if isPopoverVisible && !reduceMotion {
            return .animate(size, duration: Self.sectionAnimationDuration)
        }
        return .setImmediately(size)
    }

    mutating func beginSectionTransition(
        _ request: PopoverSectionResizeRequest,
        isPopoverVisible: Bool
    ) -> Mutation? {
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

        guard isPopoverVisible, !request.reduceMotion else {
            isCoalescingSectionMeasurements = false
            return .setImmediately(nextSize)
        }

        isCoalescingSectionMeasurements = true
        return .animate(nextSize, duration: Self.sectionAnimationDuration)
    }

    /// Called just after the shared 0.25 s content/window animation. Normally
    /// the final measurement equals the predicted target and no mutation is
    /// emitted. A genuine concurrent content change is reconciled once here.
    mutating func completeSectionTransition(
        isPopoverVisible: Bool,
        reduceMotion: Bool
    ) -> Mutation? {
        guard isCoalescingSectionMeasurements else { return nil }
        isCoalescingSectionMeasurements = false

        guard let measuredSize = latestCoalescedMeasurement else { return nil }
        latestCoalescedMeasurement = nil
        guard let targetSize,
              !approximatelyEqual(measuredSize, targetSize) else {
            return nil
        }

        self.targetSize = measuredSize
        if isPopoverVisible && !reduceMotion {
            return .animate(measuredSize, duration: Self.sectionAnimationDuration)
        }
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
