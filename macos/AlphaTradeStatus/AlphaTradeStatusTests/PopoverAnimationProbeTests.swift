import AppKit
import QuartzCore
import SwiftUI
import XCTest
@testable import AlphaTradeStatus

@MainActor
final class PopoverAnimationProbeTests: XCTestCase {
    private let sampleInterval: TimeInterval = 0.008
    private let sampleDuration: TimeInterval = 0.4

    func testLiveSectionExpansionAndCollapseKeepTopEdgeAndHeaderFixed() throws {
        let probe = PopoverAnimationProbe(
            presentation: CompanionMockFixtureCatalog.presentation(for: .live)
        )
        try probe.show()
        defer { probe.close() }

        print(probe.geometrySummary(label: "before-expand"))
        try probe.toggle(sectionID: "safety")
        let expansion = probe.sample(
            phase: "expand",
            duration: sampleDuration,
            interval: sampleInterval
        )

        try probe.toggle(sectionID: "safety")
        let collapse = probe.sample(
            phase: "collapse",
            duration: sampleDuration,
            interval: sampleInterval
        )

        print(expansion.table)
        print(collapse.table)

        XCTAssertLessThanOrEqual(expansion.windowMaxYSpan, 0.5)
        XCTAssertLessThanOrEqual(expansion.headerMaxYSpan, 0.5)
        XCTAssertLessThanOrEqual(collapse.windowMaxYSpan, 0.5)
        XCTAssertLessThanOrEqual(collapse.headerMaxYSpan, 0.5)
    }
}

@MainActor
private final class PopoverAnimationProbe {
    private let presentation: CompanionPresentation
    private let anchorWindow: NSWindow
    private let anchorView: NSView
    private let popover = NSPopover()
    private var resizeCoordinator = PopoverResizeCoordinator()
    private var completion: DispatchWorkItem?
    private var sectionToggle: ((String) -> Void)?
    private weak var headerAnchor: NSView?

    init(presentation: CompanionPresentation) {
        self.presentation = presentation
        anchorView = NSView(frame: NSRect(x: 0, y: 0, width: 28, height: 22))
        anchorWindow = NSWindow(
            contentRect: NSRect(x: 500, y: 700, width: 28, height: 22),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        anchorWindow.isReleasedWhenClosed = false
        anchorWindow.contentView = anchorView
        popover.behavior = .applicationDefined
        popover.animates = false
    }

    func show() throws {
        let root = StatusPopoverEntranceView(
            presentation: presentation,
            onAction: { _ in },
            onSectionResize: { [weak self] request in
                self?.handleSectionResize(request)
            },
            animationProbeHooks: PopoverAnimationProbeHooks(
                registerSectionToggle: { [weak self] toggle in
                    self?.sectionToggle = toggle
                },
                registerHeaderAnchor: { [weak self] view in
                    self?.headerAnchor = view
                }
            )
        )
        .environment(\.alphaTradeTheme, AlphaTradeTheme.light)
        .onPopoverContentSizeChange { [weak self] size in
            self?.handleMeasuredSize(size)
        }
        let controller = NSHostingController(rootView: root)
        controller.sizingOptions = []
        controller.view.layoutSubtreeIfNeeded()
        popover.contentViewController = controller
        setContentSizeImmediately(
            resizeCoordinator.reset(initialSize: controller.view.fittingSize).size
        )

        anchorWindow.orderFrontRegardless()
        popover.show(relativeTo: anchorView.bounds, of: anchorView, preferredEdge: .minY)
        runLoop(for: 0.32)
        controller.view.layoutSubtreeIfNeeded()

        guard popover.isShown, controller.view.window != nil else {
            throw ProbeError.popoverDidNotOpen
        }
        guard sectionToggle != nil else { throw ProbeError.sectionToggleUnavailable }
        guard headerAnchor?.window != nil else { throw ProbeError.headerAnchorUnavailable }
    }

    func close() {
        completion?.cancel()
        popover.close()
        anchorWindow.orderOut(nil)
        anchorWindow.contentView = nil
        anchorWindow.close()
    }

    func toggle(sectionID: String) throws {
        guard let sectionToggle else { throw ProbeError.sectionToggleUnavailable }
        sectionToggle(sectionID)
    }

    func geometrySummary(label: String) -> String {
        guard let view = popover.contentViewController?.view,
              let window = view.window else {
            return "POPOVER_STATE \(label) unavailable"
        }
        return String(
            format: "POPOVER_STATE %@ contentSize=%.3f view.h=%.3f fitting.h=%.3f window.h=%.3f target.h=%.3f",
            label,
            popover.contentSize.height,
            view.frame.height,
            view.fittingSize.height,
            window.frame.height,
            resizeCoordinator.targetSize?.height ?? -1
        )
    }

    func sample(phase: String, duration: TimeInterval, interval: TimeInterval) -> ProbeResult {
        let start = CACurrentMediaTime()
        var samples: [ProbeSample] = []
        repeat {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: interval))
            guard let view = popover.contentViewController?.view,
                  let window = view.window,
                  let headerAnchor,
                  let headerWindow = headerAnchor.window,
                  headerWindow === window else {
                continue
            }
            let viewFrame = view.convert(view.bounds, to: window.contentView)
            let headerInWindow = headerAnchor.convert(headerAnchor.bounds, to: nil)
            let headerOnScreen = headerWindow.convertToScreen(headerInWindow)
            samples.append(ProbeSample(
                elapsed: CACurrentMediaTime() - start,
                windowMaxY: window.frame.maxY,
                contentMinY: viewFrame.minY,
                contentMaxY: viewFrame.maxY,
                contentHeight: viewFrame.height,
                headerMinY: headerOnScreen.minY,
                headerMaxY: headerOnScreen.maxY
            ))
        } while CACurrentMediaTime() - start < duration
        return ProbeResult(phase: phase, samples: samples)
    }

    private func handleMeasuredSize(_ size: CGSize) {
        guard let mutation = resizeCoordinator.observeMeasuredSize(
            size,
            isPopoverVisible: popover.isShown,
            reduceMotion: false
        ) else { return }
        apply(mutation)
    }

    private func handleSectionResize(_ request: PopoverSectionResizeRequest) {
        completion?.cancel()
        guard let mutation = resizeCoordinator.beginSectionTransition(
            request,
            currentContentSize: popover.contentViewController?.view.bounds.size,
            isPopoverVisible: popover.isShown
        ) else { return }
        apply(mutation)

        guard let duration = mutation.transitionDuration else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  let correction = self.resizeCoordinator.completeSectionTransition(
                    isPopoverVisible: self.popover.isShown,
                    reduceMotion: false
                  ) else { return }
            self.apply(correction)
        }
        completion = work
        DispatchQueue.main.asyncAfter(deadline: .now() + duration + 0.02, execute: work)
    }

    private func apply(_ mutation: PopoverResizeCoordinator.Mutation) {
        switch mutation {
        case .setImmediately(let size):
            setContentSizeImmediately(size)
        case .expandImmediately(let size, _):
            setContentSizeImmediately(size)
        case .collapseAfterContentAnimation:
            break
        }
    }

    private func setContentSizeImmediately(_ size: CGSize) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            context.allowsImplicitAnimation = false
            popover.contentSize = size
        }
    }

    private func runLoop(for duration: TimeInterval) {
        let deadline = CACurrentMediaTime() + duration
        repeat {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: min(0.008, duration)))
        } while CACurrentMediaTime() < deadline
    }

    private enum ProbeError: Error {
        case popoverDidNotOpen
        case sectionToggleUnavailable
        case headerAnchorUnavailable
    }
}

private struct ProbeSample {
    let elapsed: TimeInterval
    let windowMaxY: CGFloat
    let contentMinY: CGFloat
    let contentMaxY: CGFloat
    let contentHeight: CGFloat
    let headerMinY: CGFloat
    let headerMaxY: CGFloat
}

private struct ProbeResult {
    let phase: String
    let samples: [ProbeSample]

    var windowMaxYSpan: CGFloat { span(\.windowMaxY) }
    var headerMaxYSpan: CGFloat { span(\.headerMaxY) }

    var table: String {
        var lines = [
            "POPOVER_PROBE \(phase)",
            "ms\twindow.maxY\tcontent.minY\tcontent.maxY\tcontent.h\theader.minY\theader.maxY"
        ]
        lines.append(contentsOf: samples.map {
            String(
                format: "%.1f\t%.3f\t%.3f\t%.3f\t%.3f\t%.3f\t%.3f",
                $0.elapsed * 1_000,
                $0.windowMaxY,
                $0.contentMinY,
                $0.contentMaxY,
                $0.contentHeight,
                $0.headerMinY,
                $0.headerMaxY
            )
        })
        lines.append(String(
            format: "SPAN\twindow.maxY=%.3f\theader.maxY=%.3f",
            windowMaxYSpan,
            headerMaxYSpan
        ))
        return lines.joined(separator: "\n")
    }

    private func span(_ keyPath: KeyPath<ProbeSample, CGFloat>) -> CGFloat {
        guard let minimum = samples.map({ $0[keyPath: keyPath] }).min(),
              let maximum = samples.map({ $0[keyPath: keyPath] }).max() else {
            return .infinity
        }
        return maximum - minimum
    }
}
