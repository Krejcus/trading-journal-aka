import Foundation
import Security

enum RemoteConnectionState: Equatable {
    case local
    case connecting
    case connected(email: String)
    case error(String)

    var title: String {
        switch self {
        case .local: "Lokální ukázka"
        case .connecting: "Připojuji…"
        case .connected: "Připojeno"
        case .error: "Nepřipojeno"
        }
    }
}

struct AlphaTradeRemoteSnapshot {
    let email: String
    let trades: [TradeRecord]
    let accounts: [TradingAccount]
    var journalSessions: [JournalSession] = []
    var weeklyFocus: [WeeklyFocusItem] = []
}

protocol AlphaTradeRemoteServing: Sendable {
    func restore() async throws -> AlphaTradeRemoteSnapshot?
    func signIn(email: String, password: String) async throws -> AlphaTradeRemoteSnapshot
    func signOut() async
}

actor AlphaTradeRemoteService: AlphaTradeRemoteServing {
    private struct Session: Codable {
        let accessToken: String
        let refreshToken: String
        let email: String
    }

    private let session = URLSession.shared
    private let keychain = AlphaTradeKeychain()

    private var baseURL: URL? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "AlphaTradeSupabaseURL") as? String,
              !raw.isEmpty, !raw.hasPrefix("$("), let url = URL(string: raw) else { return nil }
        return url
    }

    private var publicKey: String? {
        guard let key = Bundle.main.object(forInfoDictionaryKey: "AlphaTradeSupabasePublicKey") as? String,
              !key.isEmpty, !key.hasPrefix("$(") else { return nil }
        return key
    }

    func restore() async throws -> AlphaTradeRemoteSnapshot? {
        guard let stored: Session = keychain.load() else { return nil }
        do {
            return try await fetchDashboard(using: stored)
        } catch RemoteError.unauthorized {
            let refreshed = try await refresh(stored)
            return try await fetchDashboard(using: refreshed)
        }
    }

    func signIn(email: String, password: String) async throws -> AlphaTradeRemoteSnapshot {
        guard let baseURL, let publicKey else { throw RemoteError.missingConfiguration }
        var request = URLRequest(url: baseURL.appending(path: "auth/v1/token").appending(queryItems: [.init(name: "grant_type", value: "password")]))
        request.httpMethod = "POST"
        request.setValue(publicKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode >= 200, http.statusCode < 300 else {
            throw RemoteError.auth(message(from: data) ?? "Přihlášení se nepodařilo.")
        }
        let json = try object(data)
        guard let access = json["access_token"] as? String, let refresh = json["refresh_token"] as? String else { throw RemoteError.invalidResponse }
        let current = Session(accessToken: access, refreshToken: refresh, email: email)
        let snapshot = try await fetchDashboard(using: current)
        keychain.save(current)
        return snapshot
    }

    func signOut() async { keychain.delete() }

    private func refresh(_ stored: Session) async throws -> Session {
        guard let baseURL, let publicKey else { throw RemoteError.missingConfiguration }
        var request = URLRequest(url: baseURL.appending(path: "auth/v1/token").appending(queryItems: [.init(name: "grant_type", value: "refresh_token")]))
        request.httpMethod = "POST"
        request.setValue(publicKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": stored.refreshToken])
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode >= 200, http.statusCode < 300 else { keychain.delete(); throw RemoteError.unauthorized }
        let json = try object(data)
        guard let access = json["access_token"] as? String, let refresh = json["refresh_token"] as? String else { throw RemoteError.invalidResponse }
        let updated = Session(accessToken: access, refreshToken: refresh, email: stored.email)
        keychain.save(updated)
        return updated
    }

    private func fetchDashboard(using credentials: Session) async throws -> AlphaTradeRemoteSnapshot {
        guard let baseURL, let publicKey else { throw RemoteError.missingConfiguration }
        var request = URLRequest(url: baseURL.appending(path: "rest/v1/rpc/get_dashboard_data"))
        request.httpMethod = "POST"
        request.setValue(publicKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(credentials.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw RemoteError.invalidResponse }
        if http.statusCode == 401 { throw RemoteError.unauthorized }
        guard http.statusCode >= 200, http.statusCode < 300 else { throw RemoteError.server(message(from: data) ?? "Data se nepodařilo načíst.") }
        let root = try object(data)
        let trades = mapTrades(root["trades"])
        return AlphaTradeRemoteSnapshot(
            email: credentials.email,
            trades: trades,
            accounts: mapAccounts(root["accounts"], trades: trades),
            journalSessions: mapJournalSessions(preps: root["daily_preps"], reviews: root["daily_reviews"]),
            weeklyFocus: mapWeeklyFocus(root["weekly_focus"])
        )
    }

    private func mapTrades(_ raw: Any?) -> [TradeRecord] {
        (raw as? [[String: Any]] ?? []).compactMap { item in
            let data = item["data"] as? [String: Any] ?? [:]
            guard let idText = item["id"] as? String, let id = UUID(uuidString: idText) else { return nil }
            let pnl = number(item["pnl"])
            let risk = number(data["riskAmount"])
            let r = risk == 0 ? number(data["rr"]) : pnl / abs(risk)
            return TradeRecord(
                id: id,
                accountID: UUID(uuidString: item["account_id"] as? String ?? ""),
                symbol: item["instrument"] as? String ?? "—",
                side: (item["direction"] as? String ?? "—").uppercased(),
                result: pnl,
                rMultiple: r,
                setup: data["setup"] as? String ?? data["signal"] as? String ?? "Bez setupu",
                note: data["notes"] as? String ?? "",
                timestamp: date(item["timestamp"]) ?? date(item["date"]) ?? .now,
                session: data["session"] as? String ?? "Mimo session",
                confluenceCount: stringArrayCount(data["htfConfluence"]) + stringArrayCount(data["ltfConfluence"])
            )
        }.sorted { $0.timestamp > $1.timestamp }
    }

    private func mapAccounts(_ raw: Any?, trades: [TradeRecord]) -> [TradingAccount] {
        (raw as? [[String: Any]] ?? []).compactMap { item in
            let meta = item["meta"] as? [String: Any] ?? [:]
            if meta["isArchived"] as? Bool == true { return nil }
            let id = UUID(uuidString: item["id"] as? String ?? "") ?? UUID()
            let accountTrades = trades.filter { $0.accountID == id }
            let initialBalance = number(item["initial_balance"])
            return TradingAccount(
                id: id,
                name: item["name"] as? String ?? "Účet",
                firm: meta["firmOverride"] as? String ?? meta["firm"] as? String ?? meta["provider"] as? String ?? "AlphaTrade",
                balance: initialBalance + accountTrades.reduce(0) { $0 + $1.result },
                dayPnL: accountTrades.filter { Calendar.current.isDateInToday($0.timestamp) }.reduce(0) { $0 + $1.result },
                connected: true
            )
        }
    }

    private func mapJournalSessions(preps: Any?, reviews: Any?) -> [JournalSession] {
        let reviewRows = reviews as? [[String: Any]] ?? []
        let reviewsByDate = Dictionary(uniqueKeysWithValues: reviewRows.compactMap { row -> (String, [String: Any])? in
            guard let day = row["date"] as? String else { return nil }
            return (String(day.prefix(10)), row["data"] as? [String: Any] ?? [:])
        })
        return (preps as? [[String: Any]] ?? []).compactMap { row in
            guard let dayText = row["date"] as? String, let day = date(dayText) else { return nil }
            let data = row["data"] as? [String: Any] ?? [:]
            let review = reviewsByDate[String(dayText.prefix(10))] ?? [:]
            let scenarios = data["scenarios"] as? [String: Any] ?? [:]
            let sessions = scenarios["sessions"] as? [[String: Any]] ?? []
            let firstSession = sessions.first ?? [:]
            let reviewBreakdowns = review["sessionBreakdowns"] as? [[String: Any]] ?? []
            let screenshots = [firstSession["image"] as? String, reviewBreakdowns.first?["screenshot"] as? String].compactMap { $0 }.count
            return JournalSession(
                id: row["id"] as? String ?? String(dayText.prefix(10)),
                date: day,
                session: firstSession["label"] as? String ?? "Mimo session",
                bias: (data["bias"] as? String ?? firstSession["bias"] as? String ?? "Neutral").capitalized,
                playbook: firstSession["plan"] as? String ?? data["dailyFocus"] as? String ?? "NQ s pravidly",
                preNote: firstSession["plan"] as? String ?? data["dailyFocus"] as? String ?? "bez poznámky",
                postNote: review["mainTakeaway"] as? String ?? review["lessons"] as? String ?? "bez poznámky",
                screenshotCount: screenshots
            )
        }.sorted { $0.date > $1.date }
    }

    private func mapWeeklyFocus(_ raw: Any?) -> [WeeklyFocusItem] {
        let rows = raw as? [[String: Any]] ?? []
        guard let newest = rows.sorted(by: { ($0["week_iso"] as? String ?? "") > ($1["week_iso"] as? String ?? "") }).first else { return [] }
        return (newest["goals"] as? [Any] ?? []).enumerated().compactMap { index, goal in
            if let text = goal as? String { return .init(id: "goal-\(index)", text: text, emoji: "🎯") }
            guard let object = goal as? [String: Any], let text = object["text"] as? String else { return nil }
            return .init(id: object["id"] as? String ?? "goal-\(index)", text: text, emoji: object["emoji"] as? String ?? "🎯")
        }
    }

    private func object(_ data: Data) throws -> [String: Any] {
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw RemoteError.invalidResponse }
        return result
    }

    private func message(from data: Data) -> String? {
        guard let json = try? object(data) else { return nil }
        return json["msg"] as? String ?? json["message"] as? String
    }

    private func number(_ value: Any?) -> Double {
        if let value = value as? Double { return value }
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String { return Double(value) ?? 0 }
        return 0
    }

    private func stringArrayCount(_ value: Any?) -> Int {
        if let values = value as? [String] { return values.count }
        if let value = value as? String, !value.isEmpty { return 1 }
        return 0
    }

    private func date(_ value: Any?) -> Date? {
        guard let value = value as? String else { return nil }
        if let date = ISO8601DateFormatter().date(from: value) { return date }
        return DateFormatter.alphaTradeDay.date(from: String(value.prefix(10)))
    }
}

private enum RemoteError: LocalizedError {
    case missingConfiguration, invalidResponse, unauthorized, auth(String), server(String)
    var errorDescription: String? {
        switch self {
        case .missingConfiguration: "Chybí veřejná Supabase konfigurace pro nativní build."
        case .invalidResponse: "Server vrátil neplatnou odpověď."
        case .unauthorized: "Přihlášení vypršelo. Přihlas se znovu."
        case .auth(let message), .server(let message): message
        }
    }
}

private struct AlphaTradeKeychain: Sendable {
    private let service = "app.alphatrade.native.session"
    private let account = "supabase"

    func save<T: Encodable>(_ value: T) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        delete()
        SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account, kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary, nil)
    }

    func load<T: Decodable>() -> T? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne] as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    func delete() { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account] as CFDictionary) }
}

private extension DateFormatter {
    static let alphaTradeDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}
