import CryptoKit
import Foundation
import Security

protocol JournalPersisting {
    func load() -> [TradeRecord]?
    func save(_ trades: [TradeRecord])
}

protocol CoachPersisting {
    func load() -> CoachState?
    func save(_ state: CoachState)
}

private final class SecureCodableFile<Value: Codable> {
    private let service: String
    private let account: String
    private let fileURL: URL

    init(service: String, account: String = "encryption-key-v1", fileURL: URL) {
        self.service = service
        self.account = account
        self.fileURL = fileURL
    }

    func load() -> Value? {
        guard let encrypted = try? Data(contentsOf: fileURL),
              let key = loadOrCreateKey(),
              let box = try? AES.GCM.SealedBox(combined: encrypted),
              let clear = try? AES.GCM.open(box, using: key)
        else { return nil }
        return try? JSONDecoder().decode(Value.self, from: clear)
    }

    func save(_ value: Value) {
        guard let clear = try? JSONEncoder().encode(value),
              let key = loadOrCreateKey(),
              let combined = try? AES.GCM.seal(clear, using: key).combined
        else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try combined.write(to: fileURL, options: [.atomic, .completeFileProtection])
        } catch {
            assertionFailure("Secure persistence failed: \(error.localizedDescription)")
        }
    }

    private func loadOrCreateKey() -> SymmetricKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data { return SymmetricKey(data: data) }
        guard status == errSecItemNotFound else { return nil }

        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data
        ]
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? key : nil
    }
}

final class SecureJournalPersistence: JournalPersisting {
    private let vault: SecureCodableFile<[TradeRecord]>

    init(fileURL: URL? = nil) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let resolvedURL = fileURL ?? base.appending(path: "AlphaTradeNativeLab/journal-v1.aesgcm")
        vault = SecureCodableFile(service: "app.alphatrade.nativelab.journal", fileURL: resolvedURL)
    }

    func load() -> [TradeRecord]? { vault.load() }
    func save(_ trades: [TradeRecord]) { vault.save(trades) }
}

final class SecureCoachPersistence: CoachPersisting {
    private let vault: SecureCodableFile<CoachState>

    init(fileURL: URL? = nil) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let resolvedURL = fileURL ?? base.appending(path: "AlphaTradeNativeLab/coach-v1.aesgcm")
        vault = SecureCodableFile(service: "app.alphatrade.nativelab.coach", fileURL: resolvedURL)
    }

    func load() -> CoachState? { vault.load() }
    func save(_ state: CoachState) { vault.save(state) }
}

final class MemoryJournalPersistence: JournalPersisting {
    var records: [TradeRecord]?
    init(records: [TradeRecord]? = nil) { self.records = records }
    func load() -> [TradeRecord]? { records }
    func save(_ trades: [TradeRecord]) { records = trades }
}

final class MemoryCoachPersistence: CoachPersisting {
    var state: CoachState?
    init(state: CoachState? = nil) { self.state = state }
    func load() -> CoachState? { state }
    func save(_ state: CoachState) { self.state = state }
}
