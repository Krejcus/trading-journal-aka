import AppKit
import Combine
import SwiftUI
@preconcurrency import UserNotifications

@MainActor
final class AlphaTradeStatusAppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate,
    UNUserNotificationCenterDelegate {
    private enum Runtime {
        case fixture(CompanionPresentation)
        case cloud(CompanionStore)
    }

    private let runtime: Runtime
    private let settings: CompanionSettings
    private let popover = NSPopover()

    private var statusItem: NSStatusItem?
    private var appearanceObservation: NSKeyValueObservation?
    private var menuBarCancellable: AnyCancellable?
    private var transitionCancellable: AnyCancellable?
    private var wakeObserver: NSObjectProtocol?
    private var autoCloseTimer: Timer?
    private var autoCloseDeadline: Date?
    private var autoCloseRemaining: TimeInterval?
    private var isPointerInsidePopover = false
    private var isAutoPresented = false
    private var notificationRateLimiter = CompanionNotificationRateLimiter()
    private var popoverResizeCoordinator = PopoverResizeCoordinator()
    private var sectionResizeCompletion: DispatchWorkItem?

    override init() {
        let settings = CompanionSettings()
        self.settings = settings
#if DEBUG
        if let fixtureValue = ProcessInfo.processInfo.environment["ALPHATRADE_STATUS_FIXTURE"] {
            let fixtureID = CompanionFixtureID(environmentValue: fixtureValue)
            runtime = .fixture(CompanionMockFixtureCatalog.presentation(for: fixtureID))
        } else {
            runtime = .cloud(CompanionStore(settings: settings))
        }
#else
        // Release builds always use the read-only cloud client. Environment
        // fixtures are intentionally ignored so an old LaunchAgent cannot pin
        // a production installation to illustrative LIVE data.
        runtime = .cloud(CompanionStore(settings: settings))
#endif
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else {
            return
        }

        self.statusItem = statusItem
        button.target = self
        button.action = #selector(togglePopover(_:))
        button.sendAction(on: [.leftMouseUp])
        button.identifier = NSUserInterfaceItemIdentifier("alphaTrade.status.menuBar")

        popover.behavior = .transient
        popover.delegate = self
        UNUserNotificationCenter.current().delegate = self

        if case .cloud(let store) = runtime {
            // `@Published` emits from `willSet`, so inside this sink
            // `store.menuBarPresentation` still holds the PREVIOUS value.
            // Render from the emitted value, never by re-reading the store,
            // otherwise the menu bar pill lags one state behind.
            menuBarCancellable = store.$menuBarPresentation
                .removeDuplicates()
                .sink { [weak self] presentation in
                    guard let self else { return }
                    self.applyAppearance(NSApp.effectiveAppearance, menuBar: presentation)
                }
            transitionCancellable = store.$transitionEvent
                .compactMap { $0 }
                .removeDuplicates(by: { $0.sequence == $1.sequence })
                .sink { [weak self] event in
                    DispatchQueue.main.async {
                        self?.presentTransition(event)
                    }
                }
            store.start()

            wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification,
                object: NSWorkspace.shared,
                queue: .main
            ) { [weak store] _ in
                Task { @MainActor in
                    store?.handleWake()
                }
            }
        }

        appearanceObservation = NSApp.observe(
            \.effectiveAppearance,
            options: [.initial, .new]
        ) { [weak self] application, _ in
            DispatchQueue.main.async {
                self?.applyAppearance(application.effectiveAppearance)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        appearanceObservation?.invalidate()
        menuBarCancellable?.cancel()
        transitionCancellable?.cancel()
        cancelAutoCloseTimer()
        sectionResizeCompletion?.cancel()
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
        if case .cloud(let store) = runtime {
            store.stop()
        }
        if let statusItem {
            NSStatusBar.system.removeStatusItem(statusItem)
        }
    }

    func popoverWillShow(_ notification: Notification) {
        if case .cloud(let store) = runtime {
            store.popoverWillOpen()
        }
    }

    func popoverDidClose(_ notification: Notification) {
        cancelAutoCloseTimer()
        isAutoPresented = false
        isPointerInsidePopover = false
        if case .cloud(let store) = runtime {
            store.clearTransitionPresentation()
        }
    }

    @objc
    private func togglePopover(_ sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(sender)
            return
        }
        isAutoPresented = false
        cancelAutoCloseTimer()
        showPopover(relativeTo: sender)
    }

    private func applyAppearance(
        _ effectiveAppearance: NSAppearance,
        menuBar override: MenuBarStatusPresentation? = nil
    ) {
        guard let statusItem, let button = statusItem.button else {
            return
        }

        let menuBarPresentation = override ?? currentMenuBarPresentation
        button.toolTip = menuBarPresentation.accessibilityLabel
        button.setAccessibilityLabel(menuBarPresentation.accessibilityLabel)

        let appearance = MenuBarStatusArtwork.Appearance(
            effectiveAppearance: effectiveAppearance
        )
        let fittingSize = MenuBarStatusButtonStyle.apply(
            to: button,
            presentation: menuBarPresentation,
            appearance: appearance
        )
        statusItem.length = fittingSize.width
        popover.appearance = effectiveAppearance
        button.needsLayout = true
        button.needsDisplay = true
    }

    private func installPopoverContent() {
        let controller: NSViewController
        switch runtime {
        case .fixture(let presentation):
            let rootView = StatusPopoverEntranceView(
                presentation: presentation,
                settings: settings,
                onAction: perform,
                onHoverChanged: handlePopoverHover,
                onSectionResize: handleSectionResize
            )
            .alphaTradeTheme()
            .alphaTradeFocusEffectDisabled()
            .onPopoverContentSizeChange(handleMeasuredPopoverSize)
            let hostingController = NSHostingController(rootView: rootView)
            hostingController.sizingOptions = []
            controller = hostingController
        case .cloud(let store):
            let rootView = CompanionRootEntranceView(
                store: store,
                settings: settings,
                onAction: perform,
                onOpenPairing: openPairingPage,
                onCopyPairingCode: copyPairingCode,
                onHoverChanged: handlePopoverHover,
                onSectionResize: handleSectionResize
            )
            .alphaTradeTheme()
            .alphaTradeFocusEffectDisabled()
            .onPopoverContentSizeChange(handleMeasuredPopoverSize)
            let hostingController = NSHostingController(rootView: rootView)
            hostingController.sizingOptions = []
            controller = hostingController
        }
        controller.view.layoutSubtreeIfNeeded()
        let fittingSize = controller.view.fittingSize
        popover.contentViewController = controller
        applyPopoverResize(popoverResizeCoordinator.reset(initialSize: fittingSize))
    }

    private func handleMeasuredPopoverSize(_ size: CGSize) {
        guard let mutation = popoverResizeCoordinator.observeMeasuredSize(
            size,
            isPopoverVisible: popover.isShown,
            reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        ) else { return }
        applyPopoverResize(mutation)
    }

    private func handleSectionResize(_ request: PopoverSectionResizeRequest) {
        sectionResizeCompletion?.cancel()
        guard let mutation = popoverResizeCoordinator.beginSectionTransition(
            request,
            isPopoverVisible: popover.isShown
        ) else { return }
        applyPopoverResize(mutation)

        guard case .animate(_, let duration) = mutation else { return }
        let completion = DispatchWorkItem { [weak self] in
            guard let self,
                  let correction = self.popoverResizeCoordinator.completeSectionTransition(
                    isPopoverVisible: self.popover.isShown,
                    reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
                  ) else { return }
            self.applyPopoverResize(correction)
        }
        sectionResizeCompletion = completion
        DispatchQueue.main.asyncAfter(
            deadline: .now() + duration + 0.02,
            execute: completion
        )
    }

    private func applyPopoverResize(_ mutation: PopoverResizeCoordinator.Mutation) {
        switch mutation {
        case .setImmediately(let size):
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                context.allowsImplicitAnimation = false
                popover.contentSize = size
            }
        case .animate(let size, let duration):
            animatePopoverWindow(to: size, duration: duration)
        }
    }

    /// Animates the popover's own window frame with the TOP edge pinned.
    ///
    /// Letting AppKit implicitly animate `popover.contentSize` grows the window
    /// around its bottom-left origin, so the top edge visibly rises above the
    /// status item and NSPopover snaps it back under the anchor when the
    /// animation ends ("vytáhne a zase zajede"). Driving the window frame
    /// directly keeps `maxY` constant, so growth only extends downward and
    /// the popover never detaches from the menu bar. `contentSize` is
    /// synchronised afterwards without animation so NSPopover's bookkeeping
    /// matches the frame it already has.
    private func animatePopoverWindow(to size: CGSize, duration: TimeInterval) {
        guard popover.isShown,
              let window = popover.contentViewController?.view.window else {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                context.allowsImplicitAnimation = false
                popover.contentSize = size
            }
            return
        }

        let currentContent = popover.contentSize
        let heightDelta = size.height - currentContent.height
        let widthDelta = size.width - currentContent.width
        var target = window.frame
        target.size.height += heightDelta
        target.size.width += widthDelta
        target.origin.y -= heightDelta

        // NSPopover only resizes its content view when `contentSize` changes.
        // While the window frame animates, the hosting view would otherwise
        // keep its old size anchored at the bottom-left corner of the growing
        // content area, slide downward with it and jump back on the final
        // `contentSize` sync. Make it track the window frame for the whole
        // animation instead.
        if let contentView = popover.contentViewController?.view,
           let container = contentView.superview {
            container.autoresizesSubviews = true
            contentView.autoresizingMask = [.width, .height]
            contentView.frame = container.bounds
        }

        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            context.allowsImplicitAnimation = true
            window.animator().setFrame(target, display: true)
        }, completionHandler: { [weak self] in
            guard let self else { return }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                context.allowsImplicitAnimation = false
                self.popover.contentSize = size
            }
        })
    }

    func presentTransition(_ event: CompanionTransitionEvent) {
        deliverNotificationIfEnabled(for: event.transition)

        if popover.isShown {
            // CompanionRootView observes the store, so the existing SwiftUI
            // tree receives this event in place. Replacing its hosting
            // controller here would discard manual section state and replay
            // the entrance animation.
            if isAutoPresented {
                scheduleAutoClose(for: event.transition.category)
            }
            return
        }

        guard event.allowsAutoOpen,
              let button = statusItem?.button else {
            if case .cloud(let store) = runtime {
                store.clearTransitionPresentation()
            }
            return
        }
        isAutoPresented = true
        installPopoverContent()
        showPopover(relativeTo: button, installContent: false)
        pulseStatusPill()
        scheduleAutoClose(for: event.transition.category)
    }

    private func showPopover(
        relativeTo button: NSStatusBarButton,
        installContent: Bool = true
    ) {
        if installContent {
            installPopoverContent()
        }
        popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        // Deliberately do not call NSApp.activate: focus remains in the user's
        // current TradingView/terminal window.
        popover.show(
            relativeTo: button.bounds,
            of: button,
            preferredEdge: .minY
        )
    }

    private func pulseStatusPill() {
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let pulseCount = CompanionTransitionMotionPolicy.pulseCount(
            reduceMotion: reduceMotion
        )
        guard pulseCount > 0,
              let layer = statusItem?.button?.layer else { return }

        let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
        pulse.values = [1.0, 1.07, 1.0]
        pulse.keyTimes = [0, 0.5, 1]
        pulse.duration = 0.42
        pulse.repeatCount = Float(pulseCount)
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(pulse, forKey: "alphaTrade.transitionPulse")
    }

    private func scheduleAutoClose(for category: CompanionTransitionCategory) {
        let duration: TimeInterval = category == .worsening ? 60 : 8
        cancelAutoCloseTimer()
        autoCloseRemaining = duration
        guard !isPointerInsidePopover else { return }
        resumeAutoCloseTimer()
    }

    private func handlePopoverHover(_ isInside: Bool) {
        guard isAutoPresented else { return }
        isPointerInsidePopover = isInside
        if isInside {
            pauseAutoCloseTimer()
        } else {
            resumeAutoCloseTimer()
        }
    }

    private func pauseAutoCloseTimer() {
        // Auto-close intentionally uses wall time: unlike the uptime clock
        // used by the anti-flap gate, sleep must not extend a visible
        // popover's remaining lifetime after wake.
        if let deadline = autoCloseDeadline {
            autoCloseRemaining = max(0, deadline.timeIntervalSinceNow)
        }
        autoCloseTimer?.invalidate()
        autoCloseTimer = nil
        autoCloseDeadline = nil
    }

    private func resumeAutoCloseTimer() {
        guard isAutoPresented,
              popover.isShown,
              !isPointerInsidePopover,
              let remaining = autoCloseRemaining,
              remaining > 0 else { return }
        autoCloseDeadline = Date().addingTimeInterval(remaining)
        autoCloseTimer?.invalidate()
        autoCloseTimer = Timer.scheduledTimer(withTimeInterval: remaining, repeats: false) {
            [weak self] _ in
            Task { @MainActor in
                guard let self, self.isAutoPresented else { return }
                self.popover.performClose(nil)
            }
        }
    }

    private func cancelAutoCloseTimer() {
        autoCloseTimer?.invalidate()
        autoCloseTimer = nil
        autoCloseDeadline = nil
        autoCloseRemaining = nil
    }

    private func deliverNotificationIfEnabled(for transition: CompanionTransition) {
        guard settings.nativeNotifications,
              (transition.category == .worsening || transition.category == .mode),
              notificationRateLimiter.allowsNotification(
                  at: Date()
              ) else {
            return
        }

        // Wall time includes sleep on macOS, so a legitimate post-wake
        // notification is not suppressed by a pre-sleep delivery.

        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { [weak self] notificationSettings in
            guard let self else { return }
            switch notificationSettings.authorizationStatus {
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    guard granted else { return }
                    self.enqueueNotification(transition)
                }
            case .authorized, .provisional, .ephemeral:
                self.enqueueNotification(transition)
            case .denied:
                break
            @unknown default:
                break
            }
        }
    }

    nonisolated private func enqueueNotification(
        _ transition: CompanionTransition
    ) {
        Task { @MainActor [weak self] in
            guard let self, self.settings.nativeNotifications else { return }
            let content = UNMutableNotificationContent()
            content.title = "AlphaTrade Status · \(self.currentStatusHeadline)"
            content.body = transition.reason
            if transition.category == .worsening, self.settings.worseningSound {
                content.sound = .default
            }
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(
                    identifier: "companion-transition-\(UUID().uuidString)",
                    content: content,
                    trigger: nil
                )
            )
        }
    }

    private var currentStatusHeadline: String {
        switch runtime {
        case .fixture(let presentation):
            return presentation.displayState.stateName
        case .cloud(let store):
            if case .connected(let presentation) = store.state {
                return presentation.displayState.stateName
            }
            return "STAV NEZNÁMÝ"
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor [weak self] in
            defer { completionHandler() }
            guard let self, let button = self.statusItem?.button else { return }
            self.isAutoPresented = false
            self.cancelAutoCloseTimer()
            self.showPopover(relativeTo: button)
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    private func perform(_ action: FooterActionPresentation) {
        if let destination = action.destination?.url {
            NSWorkspace.shared.open(destination)
            return
        }

        switch action.id {
        case .copyDiagnostics:
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(currentSafeDiagnosticText, forType: .string)
        case .refresh:
            if case .cloud(let store) = runtime {
                store.requestManualRefresh()
            }
        case .openLive, .openJournal:
            break
        }
    }

    private var currentMenuBarPresentation: MenuBarStatusPresentation {
        switch runtime {
        case .fixture(let presentation):
            return presentation.menuBar
        case .cloud(let store):
            return store.menuBarPresentation
        }
    }

    private var currentSafeDiagnosticText: String {
        switch runtime {
        case .fixture(let presentation):
            return presentation.safeDiagnosticText
        case .cloud(let store):
            return store.safeDiagnosticText
        }
    }

    private func openPairingPage() {
        NSWorkspace.shared.open(AppLinks.companionPairing)
    }

    private func copyPairingCode(_ code: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(code, forType: .string)
    }
}
