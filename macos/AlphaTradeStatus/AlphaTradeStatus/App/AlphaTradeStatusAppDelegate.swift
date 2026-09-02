import AppKit
import Combine
import SwiftUI

@MainActor
final class AlphaTradeStatusAppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private enum Runtime {
        case fixture(CompanionPresentation)
        case cloud(CompanionStore)
    }

    private let runtime: Runtime
    private let popover = NSPopover()

    private var statusItem: NSStatusItem?
    private var appearanceObservation: NSKeyValueObservation?
    private var menuBarCancellable: AnyCancellable?
    private var wakeObserver: NSObjectProtocol?

    override init() {
#if DEBUG
        if let fixtureValue = ProcessInfo.processInfo.environment["ALPHATRADE_STATUS_FIXTURE"] {
            let fixtureID = CompanionFixtureID(environmentValue: fixtureValue)
            runtime = .fixture(CompanionMockFixtureCatalog.presentation(for: fixtureID))
        } else {
            runtime = .cloud(CompanionStore())
        }
#else
        // Release builds always use the read-only cloud client. Environment
        // fixtures are intentionally ignored so an old LaunchAgent cannot pin
        // a production installation to illustrative LIVE data.
        runtime = .cloud(CompanionStore())
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

        if case .cloud(let store) = runtime {
            menuBarCancellable = store.$menuBarPresentation
                .removeDuplicates()
                .sink { [weak self] _ in
                    guard let self else { return }
                    self.applyAppearance(NSApp.effectiveAppearance)
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

    @objc
    private func togglePopover(_ sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(sender)
            return
        }

        installPopoverContent()
        popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        popover.show(
            relativeTo: sender.bounds,
            of: sender,
            preferredEdge: .minY
        )
    }

    private func applyAppearance(_ effectiveAppearance: NSAppearance) {
        guard let statusItem, let button = statusItem.button else {
            return
        }

        let menuBarPresentation = currentMenuBarPresentation
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
                onAction: perform
            )
            .alphaTradeTheme()
            .alphaTradeFocusEffectDisabled()
            let hostingController = NSHostingController(rootView: rootView)
            hostingController.sizingOptions = [.preferredContentSize]
            controller = hostingController
        case .cloud(let store):
            let rootView = CompanionRootEntranceView(
                store: store,
                onAction: perform,
                onOpenPairing: openPairingPage,
                onCopyPairingCode: copyPairingCode
            )
            .alphaTradeTheme()
            .alphaTradeFocusEffectDisabled()
            let hostingController = NSHostingController(rootView: rootView)
            hostingController.sizingOptions = [.preferredContentSize]
            controller = hostingController
        }
        controller.view.layoutSubtreeIfNeeded()
        let fittingSize = controller.view.fittingSize
        controller.preferredContentSize = fittingSize
        popover.contentViewController = controller
        popover.contentSize = fittingSize
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
