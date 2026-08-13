import Foundation
import WidgetKit

enum WidgetPrivacyMode: String, CaseIterable, Identifiable {
    case full, relative, hidden

    var id: Self { self }
    var title: String {
        switch self {
        case .full: "Částky"
        case .relative: "Pouze R / %"
        case .hidden: "Skrýt finance"
        }
    }
}

struct NativeWidgetSnapshot: Codable, Equatable {
    struct Account: Codable, Equatable {
        let name: String
        let balance: Double
        let dayPnL: Double
    }

    struct RecentTrade: Codable, Equatable {
        let symbol: String
        let side: String
        let result: Double
        let rMultiple: Double
    }

    let updatedAt: Date
    let dayPnL: Double
    let dayR: Double
    let tradeCount: Int
    let riskUsedPercent: Int
    let disciplinePercent: Int
    let preparationComplete: Bool
    let equity: [Double]
    let accounts: [Account]
    let recentTrades: [RecentTrade]
    let privacyMode: String
}

@MainActor
enum WidgetSnapshotPublisher {
    static let appGroupIdentifier = "group.app.alphatrade.nativelab"
    static let snapshotKey = "nativeLab.widgetSnapshot.v1"
    static let privacyKey = "nativeLab.widgetPrivacy"

    static func savedPrivacyMode() -> WidgetPrivacyMode {
        UserDefaults.standard.string(forKey: privacyKey)
            .flatMap(WidgetPrivacyMode.init(rawValue:)) ?? .relative
    }

    static func publish(from store: NativeLabStore) {
        let recent = Array(store.trades.prefix(4))
        let chronologicalResults = store.trades.reversed().map(\.result)
        var running = 50_000.0
        var equity = [running]
        for result in chronologicalResults {
            running += result
            equity.append(running)
        }

        let snapshot = NativeWidgetSnapshot(
            updatedAt: .now,
            dayPnL: store.dayPnL,
            dayR: store.trades.filter { Calendar.current.isDateInToday($0.timestamp) }
                .reduce(0) { $0 + $1.rMultiple },
            tradeCount: store.todayTradeCount,
            riskUsedPercent: 24,
            disciplinePercent: 92,
            preparationComplete: store.dailyPrepComplete,
            equity: equity,
            accounts: store.accounts.prefix(3).map {
                .init(name: $0.name, balance: $0.balance, dayPnL: $0.dayPnL)
            },
            recentTrades: recent.map {
                .init(symbol: $0.symbol, side: $0.side, result: $0.result, rMultiple: $0.rMultiple)
            },
            privacyMode: store.widgetPrivacyMode.rawValue
        )

        if let data = try? JSONEncoder().encode(snapshot) {
            let defaults = UserDefaults(suiteName: appGroupIdentifier) ?? .standard
            defaults.set(data, forKey: snapshotKey)
            defaults.synchronize()
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}
