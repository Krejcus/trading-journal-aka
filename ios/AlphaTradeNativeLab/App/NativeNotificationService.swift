import Foundation
import Observation
import UIKit
import UserNotifications

extension Notification.Name {
    static let nativeLabRouteQueued = Notification.Name("nativeLabRouteQueued")
}

enum NativeLabRoute: String, CaseIterable {
    case today, capture, journal, coach, replay, live

    static func fromNotification(response: UNNotificationResponse) -> NativeLabRoute {
        resolve(
            actionIdentifier: response.actionIdentifier,
            userInfo: response.notification.request.content.userInfo
        )
    }

    static func from(url: URL) -> NativeLabRoute? {
        guard url.scheme == "alphatrade-lab", let host = url.host else { return nil }
        return NativeLabRoute(rawValue: host)
    }

    static func resolve(actionIdentifier: String, userInfo: [AnyHashable: Any]) -> NativeLabRoute {
        switch actionIdentifier {
        case NativeNotificationService.openPreparationAction: .today
        case NativeNotificationService.quickCaptureAction,
             NativeNotificationService.addNoteAction: .capture
        case NativeNotificationService.openJournalAction: .journal
        case NativeNotificationService.openCoachAction: .coach
        default:
            (userInfo["route"] as? String)
                .flatMap(NativeLabRoute.init(rawValue:)) ?? .today
        }
    }

    var title: String {
        switch self {
        case .today: "Dnešní příprava"
        case .capture: "Rychlý zápis"
        case .journal: "Deník"
        case .coach: "Coach"
        case .replay: "Replay"
        case .live: "LIVE"
        }
    }

    func queue() {
        persist()
        NotificationCenter.default.post(name: .nativeLabRouteQueued, object: nil)
    }

    func persist() {
        UserDefaults.standard.set(rawValue, forKey: "nativeLab.pendingAction")
    }
}

final class NativeNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        NativeNotificationService.registerCategories(on: center)
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        switch response.actionIdentifier {
        case UNNotificationDismissActionIdentifier:
            try? await center.setBadgeCount(0)
            return
        case NativeNotificationService.snoozeAction:
            await NativeNotificationService.scheduleSnooze(on: center)
            return
        case NativeNotificationService.addNoteAction:
            if let textResponse = response as? UNTextInputNotificationResponse {
                UserDefaults.standard.set(textResponse.userText, forKey: "nativeLab.pendingCaptureNote")
            }
        default:
            break
        }
        NativeLabRoute.fromNotification(response: response).queue()
    }
}

@MainActor @Observable
final class NativeNotificationService {
    static let generalCategory = "ALPHATRADE_GENERAL"
    static let tradeCategory = "ALPHATRADE_TRADE"
    static let riskCategory = "ALPHATRADE_RISK"
    static let openPreparationAction = "OPEN_PREPARATION"
    static let quickCaptureAction = "QUICK_CAPTURE"
    static let openJournalAction = "OPEN_JOURNAL"
    static let openCoachAction = "OPEN_COACH"
    static let addNoteAction = "ADD_NOTE"
    static let snoozeAction = "SNOOZE_TWO_MINUTES"

    enum Permission: Equatable {
        case unknown, denied, authorized, provisional

        var title: String {
            switch self {
            case .unknown: "Nezjištěno"
            case .denied: "Zakázáno"
            case .authorized: "Povoleno"
            case .provisional: "Tiché doručování"
            }
        }

        var isEnabled: Bool { self == .authorized || self == .provisional }
    }

    enum Demo: String, CaseIterable, Identifiable {
        case instant
        case tradeScreenshot
        case targetHit
        case stopLoss
        case dailyPnL
        case riskWarning
        case cooldown
        case preparation
        case review
        case discipline
        case connectionLost
        case weeklySummary

        var id: Self { self }

        var title: String {
            switch self {
            case .instant: "Základní systémový test"
            case .tradeScreenshot: "Obchod se screenshotem"
            case .targetHit: "Profit target dosažen"
            case .stopLoss: "Stop-loss zaznamenán"
            case .dailyPnL: "Denní P&L souhrn"
            case .riskWarning: "Varování risk limitu"
            case .cooldown: "Povinný cooldown"
            case .preparation: "Předobchodní příprava"
            case .review: "Uzavření session"
            case .discipline: "Disciplína a pravidla"
            case .connectionLost: "Výpadek mock připojení"
            case .weeklySummary: "Týdenní equity report"
            }
        }

        var detail: String {
            switch self {
            case .instant: "Banner, zvuk, badge a tři rychlé akce"
            case .tradeScreenshot: "Rozbalitelný obrázek MNQ obchodu přímo v notifikaci"
            case .targetHit: "Pozitivní výsledek a otevření konkrétního Deníku"
            case .stopLoss: "Ztráta s možností nadiktovat poznámku bez otevření formuláře"
            case .dailyPnL: "Souhrn USD, R, počtu obchodů a disciplíny"
            case .riskWarning: "Time-sensitive upozornění bez critical-alert oprávnění"
            case .cooldown: "Odložení o dvě minuty a otevření Coach"
            case .preparation: "Checklist před session"
            case .review: "Otevření Deníku pro závěrečnou reflexi"
            case .discipline: "Pochvala za dodržení limitu a cooldownu"
            case .connectionLost: "Pouze izolovaný LIVE mock, žádný broker"
            case .weeklySummary: "Obrázková equity křivka za týden"
            }
        }

        var symbol: String {
            switch self {
            case .instant: "bell.and.waves.left.and.right.fill"
            case .tradeScreenshot: "photo.on.rectangle.angled"
            case .targetHit: "target"
            case .stopLoss: "shield.slash.fill"
            case .dailyPnL: "dollarsign.circle.fill"
            case .riskWarning: "exclamationmark.triangle.fill"
            case .cooldown: "timer"
            case .preparation: "checklist"
            case .review: "book.closed.fill"
            case .discipline: "shield.checkered"
            case .connectionLost: "wifi.slash"
            case .weeklySummary: "chart.xyaxis.line"
            }
        }

        var defaultDelay: TimeInterval {
            switch self {
            case .instant: 8
            case .tradeScreenshot: 10
            case .targetHit: 12
            case .stopLoss: 14
            case .dailyPnL: 16
            case .riskWarning: 18
            case .cooldown: 120
            case .preparation: 22
            case .review: 300
            case .discipline: 26
            case .connectionLost: 28
            case .weeklySummary: 30
            }
        }

        var route: NativeLabRoute {
            switch self {
            case .instant, .preparation: .today
            case .tradeScreenshot, .targetHit, .stopLoss, .dailyPnL, .review, .weeklySummary: .journal
            case .riskWarning, .cooldown, .discipline: .coach
            case .connectionLost: .live
            }
        }

        var hasRichAttachment: Bool { self == .tradeScreenshot || self == .weeklySummary }
    }

    struct Pending: Identifiable, Equatable {
        let id: String
        let title: String
        let route: NativeLabRoute
        let scheduledAt: Date?
        let hasAttachment: Bool
    }

    private let center: UNUserNotificationCenter
    var permission: Permission = .unknown
    var pending: [Pending] = []
    var lastMessage: String?
    var isSchedulingGallery = false

    var pendingCount: Int { pending.count }

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    static func registerCategories(on center: UNUserNotificationCenter = .current()) {
        let preparation = UNNotificationAction(
            identifier: openPreparationAction,
            title: "Otevřít přípravu",
            options: [.foreground],
            icon: UNNotificationActionIcon(systemImageName: "checklist")
        )
        let capture = UNNotificationAction(
            identifier: quickCaptureAction,
            title: "Zapsat obchod",
            options: [.foreground],
            icon: UNNotificationActionIcon(systemImageName: "square.and.pencil")
        )
        let journal = UNNotificationAction(
            identifier: openJournalAction,
            title: "Otevřít Deník",
            options: [.foreground],
            icon: UNNotificationActionIcon(systemImageName: "book.closed")
        )
        let coach = UNNotificationAction(
            identifier: openCoachAction,
            title: "Otevřít Coach",
            options: [.foreground],
            icon: UNNotificationActionIcon(systemImageName: "brain.head.profile")
        )
        let addNote = UNTextInputNotificationAction(
            identifier: addNoteAction,
            title: "Přidat poznámku",
            options: [.foreground],
            textInputButtonTitle: "Otevřít zápis",
            textInputPlaceholder: "Co se stalo?"
        )
        let snooze = UNNotificationAction(
            identifier: snoozeAction,
            title: "Odložit o 2 minuty",
            options: [],
            icon: UNNotificationActionIcon(systemImageName: "clock.arrow.circlepath")
        )

        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: generalCategory,
                actions: [preparation, capture, journal],
                intentIdentifiers: [],
                options: [.customDismissAction]
            ),
            UNNotificationCategory(
                identifier: tradeCategory,
                actions: [journal, addNote, coach],
                intentIdentifiers: [],
                options: [.customDismissAction]
            ),
            UNNotificationCategory(
                identifier: riskCategory,
                actions: [coach, snooze, capture],
                intentIdentifiers: [],
                options: [.customDismissAction]
            )
        ])
    }

    func refresh() async {
        let settings = await center.notificationSettings()
        permission = switch settings.authorizationStatus {
        case .authorized, .ephemeral: .authorized
        case .provisional: .provisional
        case .denied: .denied
        default: .unknown
        }
        pending = await center.pendingNotificationRequests()
            .map { request in
                Pending(
                    id: request.identifier,
                    title: request.content.title,
                    route: (request.content.userInfo["route"] as? String)
                        .flatMap(NativeLabRoute.init(rawValue:)) ?? .today,
                    scheduledAt: (request.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate(),
                    hasAttachment: !request.content.attachments.isEmpty
                )
            }
            .sorted { ($0.scheduledAt ?? .distantFuture) < ($1.scheduledAt ?? .distantFuture) }
    }

    func requestPermission() async {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            lastMessage = granted ? "Notifikace jsou povolené." : "Notifikace nebyly povolené."
        } catch {
            lastMessage = "Oprávnění se nepodařilo načíst."
        }
        await refresh()
    }

    func schedule(_ demo: Demo) async {
        guard permission.isEnabled else {
            lastMessage = "Nejdřív povol notifikace."
            return
        }
        do {
            try await add(demo, delay: demo.defaultDelay, galleryIndex: nil)
            lastMessage = "Naplánováno: \(demo.title.lowercased())."
        } catch {
            lastMessage = "Notifikaci se nepodařilo naplánovat: \(error.localizedDescription)"
        }
        await refresh()
    }

    func scheduleFullGallery() async {
        guard permission.isEnabled else {
            lastMessage = "Nejdřív povol notifikace."
            return
        }
        isSchedulingGallery = true
        defer { isSchedulingGallery = false }
        Self.registerCategories(on: center)
        center.removePendingNotificationRequests(withIdentifiers: Demo.allCases.map { "native-lab.gallery.\($0.rawValue)" })

        var scheduled = 0
        for (index, demo) in Demo.allCases.enumerated() {
            do {
                try await add(demo, delay: 8 + Double(index * 12), galleryIndex: index)
                scheduled += 1
            } catch {
                continue
            }
        }
        lastMessage = "Galerie naplánována: \(scheduled) z \(Demo.allCases.count) scénářů během přibližně 2,5 minuty."
        await refresh()
    }

    private func add(_ demo: Demo, delay: TimeInterval, galleryIndex: Int?) async throws {
        Self.registerCategories(on: center)
        let content = makeContent(for: demo, badge: galleryIndex.map { $0 + 1 } ?? 1)
        if demo.hasRichAttachment, let attachment = try? NotificationAttachmentRenderer.attachment(for: demo) {
            content.attachments = [attachment]
        }
        let prefix = galleryIndex == nil ? "native-lab" : "native-lab.gallery"
        try await center.add(UNNotificationRequest(
            identifier: "\(prefix).\(demo.rawValue)",
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(delay, 1), repeats: false)
        ))
    }

    private func makeContent(for demo: Demo, badge: Int) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.sound = .default
        content.badge = NSNumber(value: badge)
        content.threadIdentifier = "native-lab.\(demo.route.rawValue)"
        content.targetContentIdentifier = demo.rawValue
        content.userInfo = ["route": demo.route.rawValue, "demo": demo.rawValue]
        content.relevanceScore = demo == .riskWarning ? 1 : 0.5

        switch demo {
        case .instant:
            content.title = "AlphaTrade Native Lab"
            content.subtitle = "Základní nativní test"
            content.body = "Podrž notifikaci a vyzkoušej přípravu, rychlý zápis nebo Deník."
            content.categoryIdentifier = Self.generalCategory
        case .tradeScreenshot:
            content.title = "MNQ LONG · +1,42R"
            content.subtitle = "Screenshot obchodu je připraven"
            content.body = "Sweep → MSS → FVG · rozbal notifikaci pro náhled grafu."
            content.categoryIdentifier = Self.tradeCategory
        case .targetHit:
            content.title = "Profit target dosažen"
            content.subtitle = "MNQ · +184,50 USD"
            content.body = "Plánovaný výstup byl zaznamenán. Otevři Deník a doplň reflexi."
            content.categoryIdentifier = Self.tradeCategory
        case .stopLoss:
            content.title = "Stop-loss zaznamenán"
            content.subtitle = "MNQ SHORT · −0,58R"
            content.body = "Přidej příčinu přímo z notifikace nebo spusť Coach reflexi."
            content.categoryIdentifier = Self.tradeCategory
        case .dailyPnL:
            content.title = "Denní souhrn · +184,50 USD"
            content.subtitle = "+1,42R · 1 ze 3 obchodů"
            content.body = "Disciplína 92 % · risk využit 24 %."
            content.categoryIdentifier = Self.generalCategory
        case .riskWarning:
            content.title = "Blížíš se dennímu risk limitu"
            content.subtitle = "Bezpečnostní test · 80 % limitu"
            content.body = "Další vstup až po Coach checklistu nebo povinném cooldownu."
            content.categoryIdentifier = Self.riskCategory
            content.interruptionLevel = .timeSensitive
        case .cooldown:
            content.title = "Povinná pauza dokončena"
            content.body = "Než budeš pokračovat, ověř kontext, invalidaci a maximální risk."
            content.categoryIdentifier = Self.riskCategory
        case .preparation:
            content.title = "NY session začíná za 15 minut"
            content.body = "Doplň mentální stav a potvrď maximální risk před prvním vstupem."
            content.categoryIdentifier = Self.generalCategory
        case .review:
            content.title = "Uzavři dnešní session"
            content.body = "Doplň poznámku, screenshot a jednu věc, kterou chceš zopakovat."
            content.categoryIdentifier = Self.tradeCategory
        case .discipline:
            content.title = "Pravidla dodržena · 92 %"
            content.body = "Po první ztrátě proběhl cooldown a nepřekročil jsi 3 obchody."
            content.categoryIdentifier = Self.generalCategory
        case .connectionLost:
            content.title = "Mock LIVE spojení přerušeno"
            content.body = "Toto je pouze lokální test stavu. Žádný broker ani účet nebyl ovlivněn."
            content.categoryIdentifier = Self.generalCategory
        case .weeklySummary:
            content.title = "Týdenní equity report"
            content.subtitle = "+606 USD · 4,34R"
            content.body = "Rozbal notifikaci pro lokálně vygenerovanou equity křivku."
            content.categoryIdentifier = Self.tradeCategory
        }
        return content
    }

    nonisolated static func scheduleSnooze(on center: UNUserNotificationCenter) async {
        let content = UNMutableNotificationContent()
        content.title = "Cooldown připomínka"
        content.body = "Dvě minuty uplynuly. Otevři Coach a znovu projdi checklist."
        content.sound = .default
        content.badge = 1
        content.categoryIdentifier = "ALPHATRADE_RISK"
        content.userInfo = ["route": NativeLabRoute.coach.rawValue]
        try? await center.add(UNNotificationRequest(
            identifier: "native-lab.snoozed.\(UUID().uuidString)",
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 120, repeats: false)
        ))
    }

    func cancelAll() async {
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
        try? await center.setBadgeCount(0)
        lastMessage = "Naplánované i doručené testy byly odstraněny."
        await refresh()
    }

    func cancel(_ request: Pending) async {
        center.removePendingNotificationRequests(withIdentifiers: [request.id])
        lastMessage = "Zrušeno: \(request.title)."
        await refresh()
    }

    func clearBadge() async { try? await center.setBadgeCount(0) }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

@MainActor
enum NotificationAttachmentRenderer {
    static func attachment(for demo: NativeNotificationService.Demo) throws -> UNNotificationAttachment {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AlphaTradeNotificationAttachments", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("\(demo.rawValue)-\(UUID().uuidString).png")
        let image = render(demo: demo)
        guard let data = image.pngData() else { throw CocoaError(.fileWriteUnknown) }
        try data.write(to: url, options: .atomic)
        return try UNNotificationAttachment(identifier: demo.rawValue, url: url)
    }

    static func render(demo: NativeNotificationService.Demo) -> UIImage {
        let size = CGSize(width: 1200, height: 675)
        return UIGraphicsImageRenderer(size: size).image { context in
            let cg = context.cgContext
            UIColor(red: 2 / 255, green: 6 / 255, blue: 23 / 255, alpha: 1).setFill()
            cg.fill(CGRect(origin: .zero, size: size))

            let title = demo == .weeklySummary ? "WEEKLY EQUITY · +606 USD" : "MNQ · LONG · +1,42R"
            title.draw(
                at: CGPoint(x: 52, y: 38),
                withAttributes: [
                    .font: UIFont.monospacedSystemFont(ofSize: 34, weight: .bold),
                    .foregroundColor: UIColor.white
                ]
            )
            "ALPHATRADE NATIVE LAB · LOCAL DEMO".draw(
                at: CGPoint(x: 52, y: 90),
                withAttributes: [
                    .font: UIFont.systemFont(ofSize: 20, weight: .semibold),
                    .foregroundColor: UIColor.systemBlue
                ]
            )

            let chartRect = CGRect(x: 52, y: 145, width: 1096, height: 420)
            UIColor(red: 11 / 255, green: 18 / 255, blue: 38 / 255, alpha: 1).setFill()
            UIBezierPath(roundedRect: chartRect, cornerRadius: 18).fill()

            cg.setStrokeColor(UIColor.white.withAlphaComponent(0.08).cgColor)
            cg.setLineWidth(1)
            for line in 1..<5 {
                let y = chartRect.minY + chartRect.height * CGFloat(line) / 5
                cg.move(to: CGPoint(x: chartRect.minX, y: y))
                cg.addLine(to: CGPoint(x: chartRect.maxX, y: y))
            }
            cg.strokePath()

            if demo == .weeklySummary { drawEquity(in: chartRect, context: cg) }
            else { drawCandles(in: chartRect, context: cg) }

            let footer = demo == .weeklySummary
                ? "7 DNÍ · DISCIPLÍNA 92 % · MAX DD −0,58R"
                : "SWEEP → MSS → FVG · RISK 130 USD · SCREENSHOT DEMO"
            footer.draw(
                at: CGPoint(x: 52, y: 600),
                withAttributes: [
                    .font: UIFont.monospacedSystemFont(ofSize: 22, weight: .semibold),
                    .foregroundColor: UIColor.white.withAlphaComponent(0.72)
                ]
            )
        }
    }

    private static func drawEquity(in rect: CGRect, context: CGContext) {
        let values: [CGFloat] = [0.18, 0.26, 0.22, 0.41, 0.35, 0.58, 0.53, 0.76, 0.71, 0.88]
        context.setStrokeColor(UIColor.systemBlue.cgColor)
        context.setLineWidth(8)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        for (index, value) in values.enumerated() {
            let point = CGPoint(
                x: rect.minX + 30 + (rect.width - 60) * CGFloat(index) / CGFloat(values.count - 1),
                y: rect.maxY - 30 - (rect.height - 60) * value
            )
            if index == 0 { context.move(to: point) } else { context.addLine(to: point) }
        }
        context.strokePath()
    }

    private static func drawCandles(in rect: CGRect, context: CGContext) {
        for index in 0..<18 {
            let x = rect.minX + 40 + CGFloat(index) * (rect.width - 80) / 18
            let center = rect.midY + sin(CGFloat(index) * 0.7) * 90 - CGFloat(index) * 5
            let rising = index % 3 != 0
            let color = rising ? UIColor.systemGreen : UIColor.systemRed
            context.setStrokeColor(color.cgColor)
            context.setFillColor(color.cgColor)
            context.setLineWidth(4)
            context.move(to: CGPoint(x: x, y: center - 55))
            context.addLine(to: CGPoint(x: x, y: center + 55))
            context.strokePath()
            context.fill(CGRect(x: x - 10, y: rising ? center - 28 : center - 5, width: 20, height: 35))
        }
        context.setStrokeColor(UIColor.systemBlue.cgColor)
        context.setLineWidth(3)
        context.setLineDash(phase: 0, lengths: [10, 8])
        context.move(to: CGPoint(x: rect.minX + 20, y: rect.midY + 70))
        context.addLine(to: CGPoint(x: rect.maxX - 20, y: rect.midY + 70))
        context.strokePath()
    }
}
