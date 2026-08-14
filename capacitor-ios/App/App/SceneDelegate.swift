import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        if let activity = connectionOptions.userActivities.first,
           let route = AlphaTradeSpotlight.route(from: activity) {
            AlphaTradeSystemRouter.shared.request(route)
        }
        if let shortcutItem = connectionOptions.shortcutItem {
            AlphaTradeQuickAction.handle(shortcutItem)
        }
        for context in connectionOptions.urlContexts {
            AlphaTradeSystemRouter.shared.request(url: context.url)
        }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AlphaTradeShellViewController()
        window?.makeKeyAndVisible()
        AlphaTradePrivacyShield.shared.startScreenCaptureProtection()
        AlphaTradeKeepAwake.shared.applicationDidBecomeActive()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            AlphaTradeSystemRouter.shared.request(url: context.url)
        }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        if let route = AlphaTradeSpotlight.route(from: userActivity) {
            AlphaTradeSystemRouter.shared.request(route)
        }
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func windowScene(_ windowScene: UIWindowScene,
                     performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        completionHandler(AlphaTradeQuickAction.handle(shortcutItem))
    }

    func sceneWillResignActive(_ scene: UIScene) {
        AlphaTradeKeepAwake.shared.applicationWillResignActive()
        AlphaTradePrivacyShield.shared.showIfEnabled()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        AlphaTradeKeepAwake.shared.applicationDidBecomeActive()
        AlphaTradePrivacyShield.shared.refreshScreenCaptureState()
    }
}

final class AlphaTradeKeepAwake {
    static let shared = AlphaTradeKeepAwake()

    private let defaultsKey = "alphatrade.keepAwake.enabled"
    private var isApplicationActive = false
    private var activeWorld = "live"

    var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: defaultsKey)
    }

    func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: defaultsKey)
        apply()
    }

    func applicationDidBecomeActive() {
        isApplicationActive = true
        apply()
    }

    func applicationWillResignActive() {
        isApplicationActive = false
        apply()
    }

    func setWorld(_ world: String) {
        guard world == "live" || world == "backtest" else { return }
        activeWorld = world
        apply()
    }

    private func apply() {
        precondition(Thread.isMainThread)
        UIApplication.shared.isIdleTimerDisabled = isEnabled && isApplicationActive && activeWorld == "live"
    }
}
