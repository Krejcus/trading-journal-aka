import Capacitor
import UIKit
import UserNotifications
import WebKit

/// One destination the shell can show as a bottom tab or inside the More menu.
struct AlphaTradeTabDestination: Equatable {
    let id: String
    let title: String
    let symbol: String
    /// LIVE-only surfaces have no meaning in the Backtest world and stay disabled there.
    let liveOnly: Bool
}

/// The user picks three destinations for the bottom bar; „Zapsat" and „Více"
/// are fixed. The choice lives in UserDefaults so it survives relaunches and
/// is mirrored to the web app through the AlphaTradeNative plugin.
enum AlphaTradeTabCatalog {
    static let destinations: [AlphaTradeTabDestination] = [
        .init(id: "dashboard", title: "Dashboard", symbol: "square.grid.2x2", liveOnly: false),
        .init(id: "history", title: "Historie", symbol: "clock.arrow.circlepath", liveOnly: false),
        .init(id: "journal", title: "Deník", symbol: "book", liveOnly: false),
        .init(id: "live", title: "LIVE", symbol: "dot.radiowaves.left.and.right", liveOnly: true),
        .init(id: "ai", title: "AI Coach", symbol: "brain.head.profile", liveOnly: false),
        .init(id: "lab", title: "Lab", symbol: "flask", liveOnly: false),
        .init(id: "business", title: "Byznys", symbol: "briefcase", liveOnly: true),
        .init(id: "network", title: "Síť", symbol: "globe", liveOnly: true),
        .init(id: "accounts", title: "Účty", symbol: "wallet.pass", liveOnly: false),
        .init(id: "settings", title: "Nastavení", symbol: "gearshape", liveOnly: false),
    ]
    static let capture = AlphaTradeTabDestination(id: "capture", title: "Zapsat", symbol: "plus.circle.fill", liveOnly: false)
    static let more = AlphaTradeTabDestination(id: "more", title: "Více", symbol: "ellipsis", liveOnly: false)
    static let defaultSlots = ["dashboard", "history", "journal"]
    static let slotCount = 3
    static let barItemCount = slotCount + 2
    static let storageKey = "AlphaTradeShellTabSlots"

    static func destination(_ id: String) -> AlphaTradeTabDestination? {
        destinations.first { $0.id == id }
    }

    /// Exactly three distinct known destinations; anything else is the default.
    static func normalizedSlots(_ candidate: [String]?) -> [String] {
        guard let candidate,
              candidate.count == slotCount,
              Set(candidate).count == slotCount,
              candidate.allSatisfy({ destination($0) != nil }) else { return defaultSlots }
        return candidate
    }

    static func loadSlots() -> [String] {
        normalizedSlots(UserDefaults.standard.stringArray(forKey: storageKey))
    }

    static func saveSlots(_ slots: [String]) {
        UserDefaults.standard.set(slots, forKey: storageKey)
    }

    /// Bar order keeps the capture action in the middle: slot, slot, Zapsat, slot, Více.
    static func barLayout(for slots: [String]) -> [AlphaTradeTabDestination] {
        let resolved = normalizedSlots(slots).compactMap(destination)
        return [resolved[0], resolved[1], capture, resolved[2], more]
    }
}

/// Capacitor owns this controller and its WKWebView. We subclass it instead of
/// creating a second web view so plugins, session state and local assets remain
/// attached to the same bridge for the whole app lifetime.
final class AlphaTradeBridgeViewController: CAPBridgeViewController {
    private var didInstallRefreshControl = false

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(AlphaTradeNativePlugin())
        webView?.isOpaque = false
        webView?.backgroundColor = .clear
        webView?.scrollView.backgroundColor = .clear
        // Web content owns its safe-area padding. Keeping automatic UIKit
        // adjustment off lets fullscreen portals paint under the status bar.
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 15.0, *) {
            webView?.underPageBackgroundColor = .clear
        }
        installRefreshControl()
    }

    private func installRefreshControl() {
        guard !didInstallRefreshControl, let webView else { return }
        let control = UIRefreshControl()
        control.tintColor = .systemBlue
        control.addTarget(self, action: #selector(refreshRequested(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = control
        webView.scrollView.alwaysBounceVertical = true
        didInstallRefreshControl = true
    }

    @objc private func refreshRequested(_ sender: UIRefreshControl) {
        let script = "window.__alphaTradeNative?.refresh(); Boolean(window.__alphaTradeNative)"
        webView?.evaluateJavaScript(script) { [weak sender] result, error in
            if error != nil || result as? Bool != true {
                sender?.endRefreshing()
            }
        }
    }

}

/// A persistent system tab bar remains the visual/navigation shell; Capacitor
/// is embedded as one stable child controller underneath it. We intentionally
/// do not use UITabBarController: its private transition container can reorder
/// or detach a manually embedded WebView when iOS rebuilds the tab hierarchy.
final class AlphaTradeShellViewController: UIViewController, UITabBarDelegate {
    private let bridgeController = AlphaTradeBridgeViewController()
    private let shellTabBar = UITabBar()
    private var shellTabBarHeight: NSLayoutConstraint?
    private var tabSlots = AlphaTradeTabCatalog.loadSlots()
    private var activePage = "dashboard"
    private var activeTheme = "dark"
    private var activeWorld = "live"
    private var systemRouteObserver: NSObjectProtocol?
#if DEBUG
    private var lastTabBarDiagnostic: String?
#endif

    override func viewDidLoad() {
        super.viewDidLoad()
        applyTheme("dark")

        embedBridge()
        configureTabs()

        systemRouteObserver = NotificationCenter.default.addObserver(
            forName: AlphaTradeSystemRouter.routeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.deliverSystemRoute()
        }
        deliverSystemRoute()
        synchronizeThemeFromWeb()

        #if DEBUG
        scheduleRuntimeDiagnostics()
        scheduleThemeAppearanceSmokeIfRequested()
        scheduleRichNotificationSmokeIfRequested()
        scheduleHapticSmokeIfRequested()
        scheduleWorldMenuSmokeIfRequested()
        scheduleWorldShiftSmokeIfRequested()
        scheduleShareSheetSmokeIfRequested()
        #endif
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        shellTabBar.isHidden = false
        shellTabBar.layer.zPosition = 1_000
        view.bringSubviewToFront(shellTabBar)
#if DEBUG
        let diagnostic = "hidden=\(shellTabBar.isHidden) window=\(shellTabBar.window != nil) frame=\(NSCoder.string(for: shellTabBar.frame)) items=\(shellTabBar.items?.count ?? 0) selected=\(shellTabBar.selectedItem?.title ?? "none")"
        if diagnostic != lastTabBarDiagnostic {
            lastTabBarDiagnostic = diagnostic
            NSLog("[AlphaTradeTabBar] %@", diagnostic)
        }
#endif
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        shellTabBarHeight?.constant = 49 + view.safeAreaInsets.bottom
    }

    deinit {
        if let systemRouteObserver { NotificationCenter.default.removeObserver(systemRouteObserver) }
    }

    private func configureTabs() {
        shellTabBar.isTranslucent = true
        shellTabBar.delegate = self
        shellTabBar.translatesAutoresizingMaskIntoConstraints = false
        shellTabBar.items = makeTabItems()
        shellTabBar.selectedItem = tabItem(for: activePage)
        configureTabBarAppearance(for: activeTheme)
        view.addSubview(shellTabBar)
        let height = shellTabBar.heightAnchor.constraint(equalToConstant: 49 + view.safeAreaInsets.bottom)
        shellTabBarHeight = height
        NSLayoutConstraint.activate([
            shellTabBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            shellTabBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            shellTabBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            height,
        ])
        shellTabBar.layer.zPosition = 1_000
        view.bringSubviewToFront(shellTabBar)
    }

    private func configureTabBarAppearance(for theme: String) {
        let isLight = theme == "light"
        let selectedColor = isLight
            ? UIColor(red: 2 / 255, green: 80 / 255, blue: 140 / 255, alpha: 1)
            : UIColor(red: 103 / 255, green: 232 / 255, blue: 249 / 255, alpha: 1)
        let normalColor = isLight
            ? UIColor(red: 51 / 255, green: 65 / 255, blue: 85 / 255, alpha: 0.82)
            : UIColor(white: 1, alpha: 0.72)

        let itemAppearance = UITabBarItemAppearance()
        itemAppearance.normal.iconColor = normalColor
        itemAppearance.normal.titleTextAttributes = [.foregroundColor: normalColor]
        itemAppearance.selected.iconColor = selectedColor
        itemAppearance.selected.titleTextAttributes = [.foregroundColor: selectedColor]

        let appearance = UITabBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.backgroundEffect = UIBlurEffect(style: .systemUltraThinMaterial)
        appearance.backgroundColor = isLight
            ? UIColor.white.withAlphaComponent(0.08)
            : UIColor.black.withAlphaComponent(theme == "oled" ? 0.08 : 0.04)
        appearance.shadowColor = .clear
        appearance.stackedLayoutAppearance = itemAppearance
        appearance.inlineLayoutAppearance = itemAppearance
        appearance.compactInlineLayoutAppearance = itemAppearance

        shellTabBar.standardAppearance = appearance
        shellTabBar.scrollEdgeAppearance = appearance
        shellTabBar.tintColor = selectedColor
        shellTabBar.unselectedItemTintColor = normalColor
        shellTabBar.backgroundColor = .clear
        shellTabBar.isHidden = false
        shellTabBar.setNeedsDisplay()
        shellTabBar.setNeedsLayout()
    }

    private func applyTheme(_ theme: String) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.applyTheme(theme) }
            return
        }
        let isLight = theme == "light"
        activeTheme = theme
        let color: UIColor
        switch theme {
        case "light": color = UIColor(red: 248 / 255, green: 250 / 255, blue: 252 / 255, alpha: 1)
        case "oled": color = .black
        default: color = UIColor(red: 2 / 255, green: 6 / 255, blue: 23 / 255, alpha: 1)
        }

        UIView.performWithoutAnimation {
            overrideUserInterfaceStyle = isLight ? .light : .dark
            bridgeController.overrideUserInterfaceStyle = isLight ? .light : .dark
            view.window?.backgroundColor = color
            view.backgroundColor = color
            bridgeController.view.backgroundColor = color
            bridgeController.webView?.backgroundColor = color
            bridgeController.webView?.scrollView.backgroundColor = color
            if #available(iOS 15.0, *) {
                bridgeController.webView?.underPageBackgroundColor = color
            }
            configureTabBarAppearance(for: theme)
            view.superview?.backgroundColor = color
            view.window?.rootViewController?.view.backgroundColor = color
            setNeedsStatusBarAppearanceUpdate()
            view.setNeedsLayout()
            view.layoutIfNeeded()
        }
        NSLog(
            "[AlphaTradeShell] theme=%@ color=%@ safeTop=%.1f safeBottom=%.1f tabHeight=%.1f",
            theme,
            color.description,
            view.safeAreaInsets.top,
            view.safeAreaInsets.bottom,
            shellTabBar.bounds.height
        )
    }

    func applyThemeFromWeb(_ theme: String) {
#if DEBUG
        NSLog("[AlphaTradeThemeBridge] received=%@ main=%d", theme, Thread.isMainThread)
#endif
        applyTheme(theme)
    }

    func completeNativeRefresh(success: Bool) {
        bridgeController.webView?.scrollView.refreshControl?.endRefreshing()
        let feedback = UINotificationFeedbackGenerator()
        feedback.notificationOccurred(success ? .success : .error)
    }

    private func synchronizeThemeFromWeb(attempt: Int = 0) {
        guard attempt < 12 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + (attempt == 0 ? 0.75 : 0.4)) { [weak self] in
            guard let self, let webView = self.bridgeController.webView else {
                self?.synchronizeThemeFromWeb(attempt: attempt + 1)
                return
            }
            webView.evaluateJavaScript("localStorage.getItem('alphatrade_theme')") { [weak self] result, error in
                guard error == nil, let theme = result as? String,
                      ["light", "dark", "oled"].contains(theme) else {
                    self?.synchronizeThemeFromWeb(attempt: attempt + 1)
                    return
                }
                self?.applyTheme(theme)
            }
        }
    }

    #if DEBUG
    /// Read back the state from the physical device. This intentionally lives
    /// only in Debug builds: it proves that React reported its persisted theme
    /// and that iOS retained the recurring reminders after scheduling.
    private func scheduleRuntimeDiagnostics(attempt: Int = 0) {
        guard attempt < 12 else {
            NSLog("[AlphaTradeDiagnostic] web bridge did not become ready")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (attempt == 0 ? 1.5 : 0.5)) { [weak self] in
            guard let self, let webView = self.bridgeController.webView else {
                self?.scheduleRuntimeDiagnostics(attempt: attempt + 1)
                return
            }
            let script = "JSON.stringify({ready:Boolean(window.__alphaTradeNative),theme:localStorage.getItem('alphatrade_theme'),protocol:window.location.protocol})"
            webView.evaluateJavaScript(script) { [weak self] result, error in
                guard error == nil, let value = result as? String, value.contains("\"ready\":true") else {
                    self?.scheduleRuntimeDiagnostics(attempt: attempt + 1)
                    return
                }
                NSLog("[AlphaTradeDiagnostic] web=%@", value)
                self?.logPendingNotifications()
            }
        }
    }

    private func logPendingNotifications() {
        UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
            let recurring = requests.filter { request in
                guard let extra = request.content.userInfo["cap_extra"] as? [String: Any] else { return false }
                return extra["source"] as? String == "sessionReminder"
            }
            let ids = recurring.compactMap { Int($0.identifier) }.sorted()
            let calendarCount = recurring.filter { $0.trigger is UNCalendarNotificationTrigger }.count
            NSLog(
                "[AlphaTradeDiagnostic] pendingTotal=%ld sessionReminders=%ld calendar=%ld ids=%@",
                requests.count,
                recurring.count,
                calendarCount,
                ids.map(String.init).joined(separator: ",")
            )
        }
        UNUserNotificationCenter.current().getNotificationCategories { categories in
            let summary = categories
                .sorted { $0.identifier < $1.identifier }
                .map { "\($0.identifier):\($0.actions.count)" }
                .joined(separator: ",")
            NSLog("[AlphaTradeDiagnostic] notificationCategories=%@", summary)
        }
        UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
            let rich = notifications.filter { !$0.request.content.attachments.isEmpty }
            let summary = rich.map { notification in
                "\(notification.request.identifier):\(notification.request.content.attachments.count):\(notification.request.content.categoryIdentifier)"
            }.joined(separator: ",")
            NSLog(
                "[AlphaTradeDiagnostic] deliveredTotal=%ld richDelivered=%ld rich=%@",
                notifications.count,
                rich.count,
                summary
            )
        }
    }

    /// Opt-in end-to-end smoke: JavaScript posts through the same WK message
    /// handler as React's theme button, then UIKit state is inspected. Ordinary
    /// Debug launches never flash and the user's persisted theme is untouched.
    private func scheduleThemeAppearanceSmokeIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("--alphatrade-theme-appearance-smoke") else { return }
        let originalTheme = activeTheme
        waitForThemeSmokeBridge(originalTheme: originalTheme)
    }

    private func waitForThemeSmokeBridge(originalTheme: String, attempt: Int = 0) {
        guard attempt < 20 else {
            NSLog("[AlphaTradeDiagnostic] themeSmoke=bootstrap passed=0 bridge=0")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self, let webView = self.bridgeController.webView else { return }
            let script = "Boolean(window.__alphaTradeNative && window.Capacitor?.Plugins?.AlphaTradeNative?.setShellTheme)"
            webView.evaluateJavaScript(script) { [weak self] result, _ in
                guard let self else { return }
                if result as? Bool == true {
                    self.runThemeAppearanceSmoke(themes: ["light", "dark", "oled"], index: 0, originalTheme: originalTheme)
                } else {
                    self.waitForThemeSmokeBridge(originalTheme: originalTheme, attempt: attempt + 1)
                }
            }
        }
    }

    private func runThemeAppearanceSmoke(themes: [String], index: Int, originalTheme: String) {
        guard index < themes.count else {
            postThemeFromWeb(originalTheme)
            return
        }
        let theme = themes[index]
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            self.postThemeFromWeb(theme) { [weak self] delivered in
                guard let self else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    let expectedStyle: UIUserInterfaceStyle = theme == "light" ? .light : .dark
                    let hasItems = self.shellTabBar.items?.count == AlphaTradeTabCatalog.barItemCount
                    let isVisible = !self.shellTabBar.isHidden && self.shellTabBar.window != nil
                    let appearanceReady = self.shellTabBar.standardAppearance.stackedLayoutAppearance.selected.iconColor != nil
                    let passed = delivered && self.activeTheme == theme
                        && self.overrideUserInterfaceStyle == expectedStyle
                        && hasItems && isVisible && appearanceReady
                    NSLog(
                        "[AlphaTradeDiagnostic] themeSmoke=%@ passed=%d bridge=%d active=%@ style=%ld items=%ld visible=%d appearance=%d",
                        theme,
                        passed,
                        delivered,
                        self.activeTheme,
                        self.overrideUserInterfaceStyle.rawValue,
                        self.shellTabBar.items?.count ?? 0,
                        isVisible,
                        appearanceReady
                    )
                    self.runThemeAppearanceSmoke(themes: themes, index: index + 1, originalTheme: originalTheme)
                }
            }
        }
    }

    private func postThemeFromWeb(_ theme: String, completion: ((Bool) -> Void)? = nil) {
        let script = "window.Capacitor?.Plugins?.AlphaTradeNative?.setShellTheme({theme:'\(theme)'}); true"
        bridgeController.webView?.evaluateJavaScript(script) { result, error in
            completion?(error == nil && result as? Bool == true)
        }
    }

    private func scheduleRichNotificationSmokeIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("--alphatrade-rich-notification-smoke") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 675))
            let image = renderer.image { context in
                let bounds = CGRect(x: 0, y: 0, width: 1200, height: 675)
                UIColor(red: 2 / 255, green: 6 / 255, blue: 23 / 255, alpha: 1).setFill()
                context.fill(bounds)

                let title = "MNQ · LONG" as NSString
                title.draw(at: CGPoint(x: 52, y: 45), withAttributes: [
                    .font: UIFont.monospacedSystemFont(ofSize: 42, weight: .bold),
                    .foregroundColor: UIColor.white,
                ])
                let pnl = "+$428.50" as NSString
                pnl.draw(at: CGPoint(x: 905, y: 45), withAttributes: [
                    .font: UIFont.monospacedSystemFont(ofSize: 42, weight: .bold),
                    .foregroundColor: UIColor.systemGreen,
                ])
                ("ALPHATRADE · NATIVE TRADE PREVIEW" as NSString).draw(
                    at: CGPoint(x: 52, y: 105),
                    withAttributes: [
                        .font: UIFont.monospacedSystemFont(ofSize: 22, weight: .semibold),
                        .foregroundColor: UIColor.systemBlue,
                    ]
                )

                UIColor(red: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 1).setFill()
                UIBezierPath(roundedRect: CGRect(x: 40, y: 155, width: 1120, height: 410), cornerRadius: 26).fill()
                let points = [490, 455, 470, 410, 425, 365, 390, 330, 348, 275, 300, 235, 250, 190]
                let path = UIBezierPath()
                for (index, y) in points.enumerated() {
                    let point = CGPoint(x: 78 + index * 78, y: y)
                    index == 0 ? path.move(to: point) : path.addLine(to: point)
                }
                UIColor.systemGreen.setStroke()
                path.lineWidth = 8
                path.lineJoinStyle = .round
                path.stroke()
                ("PRICE 21858.75   ·   ACCOUNTS 13/13   ·   TEST" as NSString).draw(
                    at: CGPoint(x: 52, y: 610),
                    withAttributes: [
                        .font: UIFont.monospacedSystemFont(ofSize: 24, weight: .semibold),
                        .foregroundColor: UIColor.lightGray,
                    ]
                )
            }

            guard let data = image.pngData() else {
                NSLog("[AlphaTradeDiagnostic] richSmoke=png-failed")
                return
            }
            let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("alphatrade-notifications", isDirectory: true)
            let fileURL = directory.appendingPathComponent("rich-smoke.png")
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: fileURL, options: .atomic)
                let attachment = try UNNotificationAttachment(identifier: "trade-preview", url: fileURL)
                let content = UNMutableNotificationContent()
                content.title = "MNQ obchod uzavřen · +$428.50"
                content.body = "13/13 účtů · Podrž notifikaci pro náhled a akce."
                content.sound = .default
                content.categoryIdentifier = "ALPHATRADE_TRADE"
                content.threadIdentifier = "alphatrade-rich-smoke"
                content.attachments = [attachment]
                content.userInfo = ["cap_extra": [
                    "route": "journal", "kind": "trade", "source": "test",
                    "scheduledAt": Date().timeIntervalSince1970 * 1000,
                ]]
                let request = UNNotificationRequest(
                    identifier: "1999999901",
                    content: content,
                    trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
                )
                UNUserNotificationCenter.current().add(request) { error in
                    if let error {
                        NSLog("[AlphaTradeDiagnostic] richSmoke=failed:%@", error.localizedDescription)
                    } else {
                        NSLog("[AlphaTradeDiagnostic] richSmoke=scheduled attachmentBytes=%ld", data.count)
                    }
                }
            } catch {
                NSLog("[AlphaTradeDiagnostic] richSmoke=failed:%@", error.localizedDescription)
            }
        }
    }

    private func scheduleHapticSmokeIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("--alphatrade-haptic-smoke") else { return }
        let impact = UIImpactFeedbackGenerator(style: .medium)
        let notification = UINotificationFeedbackGenerator()
        impact.prepare()
        notification.prepare()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            impact.impactOccurred()
            NSLog("[AlphaTradeDiagnostic] hapticSmoke=medium")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            notification.notificationOccurred(.success)
            notification.prepare()
            NSLog("[AlphaTradeDiagnostic] hapticSmoke=success")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.5) {
            notification.notificationOccurred(.warning)
            NSLog("[AlphaTradeDiagnostic] hapticSmoke=warning")
        }
    }
    #endif

    private static func placeholder() -> UIViewController {
        let controller = UIViewController()
        controller.view.backgroundColor = .clear
        return controller
    }

    private func embedBridge() {
        addChild(bridgeController)
        bridgeController.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bridgeController.view)
        bridgeController.didMove(toParent: self)

        // The WebView spans the full screen so fullscreen React portals can
        // paint behind the status bar. Normal web UI applies env(safe-area-*)
        // padding itself; the bottom continues beneath the translucent native
        // tab bar to preserve real iOS Liquid Glass depth.
        NSLayoutConstraint.activate([
            bridgeController.view.topAnchor.constraint(equalTo: view.topAnchor),
            bridgeController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bridgeController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bridgeController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        view.bringSubviewToFront(shellTabBar)
    }

    private var barLayout: [AlphaTradeTabDestination] {
        AlphaTradeTabCatalog.barLayout(for: tabSlots)
    }

    private func makeTabItems() -> [UITabBarItem] {
        barLayout.enumerated().map { index, destination in
            let image = UIImage(systemName: destination.symbol) ?? UIImage(systemName: "circle")
            let item = UITabBarItem(title: destination.title, image: image, selectedImage: image)
            item.tag = index
            item.accessibilityIdentifier = "alphatrade.tab.\(destination.id)"
            item.isEnabled = activeWorld == "live" || !destination.liveOnly
            return item
        }
    }

    /// The bar item that represents a web page, or nil when the page lives in More.
    private func tabItem(for page: String) -> UITabBarItem? {
        guard let index = barLayout.firstIndex(where: { $0.id == page }),
              let items = shellTabBar.items,
              items.indices.contains(index) else { return nil }
        return items[index]
    }

    private func refreshTabAvailability() {
        let layout = barLayout
        shellTabBar.items?.enumerated().forEach { index, item in
            guard layout.indices.contains(index) else { return }
            item.isEnabled = activeWorld == "live" || !layout[index].liveOnly
        }
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        let layout = barLayout
        guard layout.indices.contains(item.tag) else { return }
        if !handle(layout[item.tag]) {
            // UIKit commits the tapped selection after this delegate callback.
            // Action-only tabs (capture/more) therefore restore the real page
            // on the next main-loop turn instead of appearing as destinations.
            // A page that only lives in More keeps the bar without selection.
            let restore = tabItem(for: activePage)
            DispatchQueue.main.async { [weak tabBar] in
                tabBar?.selectedItem = restore
            }
        }
    }

    private func handle(_ destination: AlphaTradeTabDestination) -> Bool {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()

        switch destination.id {
        case AlphaTradeTabCatalog.capture.id:
            evaluate("window.__alphaTradeNative?.addTrade()")
            return false
        case AlphaTradeTabCatalog.more.id:
            presentMoreMenu()
            return false
        default:
            activePage = destination.id
            evaluate("window.__alphaTradeNative?.navigate('\(destination.id)')")
            return true
        }
    }

    private func evaluate(_ script: String) {
        bridgeController.webView?.evaluateJavaScript(script) { _, error in
            if let error {
                // A tab can be tapped during boot before React registers its bridge.
                // The selected page remains the web app's default and the next tap works.
                NSLog("[AlphaTradeShell] JavaScript bridge is not ready yet: %@", error.localizedDescription)
            }
        }
    }

    private func deliverSystemRoute() {
        guard let route = AlphaTradeSystemRouter.shared.pendingRoute() else { return }
        let action = route == "capture"
            ? "window.__alphaTradeNative.addTrade()"
            : "window.__alphaTradeNative.navigate('\(route)')"
        let script = """
            (() => {
              if (window.location.protocol !== 'capacitor:') return false;
              if (window.__alphaTradeNative) { \(action); return true; }
              window.__alphaTradePendingRoute = '\(route)';
              return true;
            })()
            """

        guard let webView = bridgeController.webView else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.deliverSystemRoute()
            }
            return
        }
        webView.evaluateJavaScript(script) { [weak self] result, error in
            if error == nil, result as? Bool == true {
                AlphaTradeSystemRouter.shared.acknowledge(route)
                return
            }
            // On a cold launch Capacitor may still be creating the page. Keep
            // the persisted route and retry instead of silently losing it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self?.deliverSystemRoute()
            }
        }
    }

    private func presentMoreMenu() {
        let sheet = UIAlertController(title: "Více", message: nil, preferredStyle: .actionSheet)
        let isBacktest = activeWorld == "backtest"
        let worldTitle = isBacktest ? "Zpět na LIVE" : "Přejít do Backtestu"
        sheet.addAction(UIAlertAction(title: worldTitle, style: .default) { [weak self] _ in
            self?.evaluate("window.__alphaTradeNative?.toggleWorld()")
        })

        // Everything the bar does not show. Backtest hides LIVE-only surfaces
        // and, like the web sidebar, presents Účty as the backtest Session.
        let inBar = Set(tabSlots)
        var destinations: [(String, String)] = AlphaTradeTabCatalog.destinations
            .filter { !inBar.contains($0.id) && (!isBacktest || !$0.liveOnly) }
            .map { ($0.id == "accounts" && isBacktest ? "Session" : $0.title, $0.id) }
        let settingsIndex = destinations.firstIndex { $0.1 == "settings" } ?? destinations.endIndex
        destinations.insert(("iOS funkce", "native-system"), at: settingsIndex)
        for (title, page) in destinations {
            sheet.addAction(UIAlertAction(title: title, style: .default) { [weak self] _ in
                self?.evaluate("window.__alphaTradeNative?.navigate('\(page)')")
            })
        }
        sheet.addAction(UIAlertAction(title: "Zrušit", style: .cancel))
        sheet.popoverPresentationController?.sourceView = shellTabBar
        sheet.popoverPresentationController?.sourceRect = shellTabBar.bounds
        present(sheet, animated: true)
    }

    #if DEBUG
    private func scheduleWorldMenuSmokeIfRequested() {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains("--alphatrade-world-menu-smoke") else { return }
        activeWorld = arguments.contains("--alphatrade-world-backtest") ? "backtest" : "live"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.presentMoreMenu()
        }
    }

    private func scheduleWorldShiftSmokeIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("--alphatrade-world-shift-smoke") else { return }
        // Wait until the bundled React app has installed its native bridge,
        // then exercise the real transition used by the More menu.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.evaluate("window.__alphaTradeNative?.toggleWorld()")
        }
    }

    private func scheduleShareSheetSmokeIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("--alphatrade-share-sheet-smoke") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.evaluate("""
                window.Capacitor?.Plugins?.AlphaTradeNative?.shareText({
                  text: 'AlphaTrade iOS · automatický test sdílení',
                  url: 'https://alphatrade-mentor-15.vercel.app'
                })
            """)
        }
    }
    #endif

    func applyWorldFromWeb(_ world: String) {
        guard world == "live" || world == "backtest" else { return }
        activeWorld = world
        AlphaTradeKeepAwake.shared.setWorld(world)
        refreshTabAvailability()
    }

    func currentTabSlots() -> [String] { tabSlots }

    /// Replaces the three configurable bar slots. Rejects anything that is not
    /// three distinct known destinations so a broken web payload cannot leave
    /// the bar empty.
    @discardableResult
    func applyTabSlots(_ candidate: [String]) -> Bool {
        let normalized = AlphaTradeTabCatalog.normalizedSlots(candidate)
        guard normalized == candidate else { return false }
        tabSlots = normalized
        AlphaTradeTabCatalog.saveSlots(normalized)
        shellTabBar.items = makeTabItems()
        shellTabBar.selectedItem = tabItem(for: activePage)
        return true
    }

    /// The web app reports every page change (deep links, More menu, in-app
    /// links) so the bar highlights the real page or nothing at all.
    func applyPageFromWeb(_ page: String) {
        activePage = page
        shellTabBar.selectedItem = tabItem(for: page)
    }
}
