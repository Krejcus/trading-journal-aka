import Foundation

enum AppTab: String, CaseIterable, Identifiable {
    case today, history, journal, coach, replay, live, lab, settings
    var id: Self { self }
    var title: String {
        switch self {
        case .today: "Dashboard"
        case .history: "Historie"
        case .journal: "Deník"
        case .coach: "AI"
        case .replay: "Backtest"
        case .live: "LIVE"
        case .lab: "Lab"
        case .settings: "Nastavení"
        }
    }
    var symbol: String {
        switch self {
        case .today: "square.grid.2x2"
        case .history: "clock.arrow.circlepath"
        case .journal: "book.closed"
        case .coach: "brain.head.profile"
        case .replay: "flask"
        case .live: "dot.radiowaves.left.and.right"
        case .lab: "scope"
        case .settings: "gearshape"
        }
    }
}

enum DashboardRange: String, CaseIterable, Identifiable {
    case sevenDays, thirtyDays, all
    var id: Self { self }
    var title: String {
        switch self {
        case .sevenDays: "7 dní"
        case .thirtyDays: "30 dní"
        case .all: "Vše"
        }
    }
    var cutoff: Date? {
        switch self {
        case .sevenDays: Calendar.current.date(byAdding: .day, value: -7, to: .now)
        case .thirtyDays: Calendar.current.date(byAdding: .day, value: -30, to: .now)
        case .all: nil
        }
    }
}

struct TradeRecord: Identifiable, Hashable, Codable {
    let id: UUID
    var accountID: UUID? = nil
    var symbol: String
    var side: String
    var result: Double
    var rMultiple: Double
    var setup: String
    var note: String
    var timestamp: Date
    var session: String = "Mimo session"
    var confluenceCount: Int = 0
}

struct CoachMessage: Identifiable, Hashable, Codable {
    let id: UUID
    let role: Role
    let text: String
    enum Role: String, Codable { case coach, trader }

    init(id: UUID = UUID(), role: Role, text: String) {
        self.id = id
        self.role = role
        self.text = text
    }
}

struct CoachState: Codable, Equatable {
    var messages: [CoachMessage]
    var savedConclusionIDs: Set<UUID>
}

struct Candle: Identifiable, Hashable {
    let id = UUID()
    let open: Double
    let high: Double
    let low: Double
    let close: Double
}

struct TradingAccount: Identifiable, Hashable {
    let id: UUID
    let name: String
    let firm: String
    let balance: Double
    let dayPnL: Double
    let connected: Bool

    init(id: UUID = UUID(), name: String, firm: String, balance: Double, dayPnL: Double, connected: Bool) {
        self.id = id
        self.name = name
        self.firm = firm
        self.balance = balance
        self.dayPnL = dayPnL
        self.connected = connected
    }
}

struct JournalSession: Identifiable, Hashable {
    let id: String
    let date: Date
    let session: String
    let bias: String
    let playbook: String
    let preNote: String
    let postNote: String
    let screenshotCount: Int
}

struct WeeklyFocusItem: Identifiable, Hashable {
    let id: String
    let text: String
    let emoji: String
}
