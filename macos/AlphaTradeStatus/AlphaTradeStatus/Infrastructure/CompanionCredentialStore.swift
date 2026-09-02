import CryptoKit
import Foundation
import Security

struct CompanionCredentialRecord: Codable, Equatable, Sendable {
    static let schemaVersion = 1

    enum Phase: String, Codable, Equatable, Sendable {
        case pending
        case active
    }

    let schemaVersion: Int
    let phase: Phase
    let deviceID: UUID
    let deviceSecret: String
    let pairingCode: String?
    let pairingExpiresAt: Date?

    var authorizationHeader: String {
        "AlphaTradeCompanion \(deviceID.uuidString.lowercased()).\(deviceSecret)"
    }

    var deviceSecretHash: String {
        CompanionPairingMaterial.sha256Hex(deviceSecret)
    }

    var pairingCodeHash: String? {
        pairingCode.map(CompanionPairingMaterial.sha256Hex)
    }

    func activated() -> CompanionCredentialRecord {
        CompanionCredentialRecord(
            schemaVersion: Self.schemaVersion,
            phase: .active,
            deviceID: deviceID,
            deviceSecret: deviceSecret,
            pairingCode: nil,
            pairingExpiresAt: nil
        )
    }

    func withPairingExpiry(_ expiresAt: Date) -> CompanionCredentialRecord {
        CompanionCredentialRecord(
            schemaVersion: schemaVersion,
            phase: phase,
            deviceID: deviceID,
            deviceSecret: deviceSecret,
            pairingCode: pairingCode,
            pairingExpiresAt: expiresAt
        )
    }
}

enum CompanionPairingMaterial {
    private static let codeAlphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func makePendingCredential() throws -> CompanionCredentialRecord {
        let secretData = try secureRandomData(count: 32)
        let secret = secretData
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        guard secret.count == 43 else {
            throw CompanionCredentialError.randomGenerationFailed
        }

        let codeBytes = try secureRandomData(count: 12)
        let code = String(codeBytes.map { codeAlphabet[Int($0) & 31] })

        return CompanionCredentialRecord(
            schemaVersion: CompanionCredentialRecord.schemaVersion,
            phase: .pending,
            deviceID: UUID(),
            deviceSecret: secret,
            pairingCode: code,
            pairingExpiresAt: nil
        )
    }

    static func sha256Hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    static func formattedPairingCode(_ code: String) -> String {
        let normalized = code.uppercased().filter { $0.isLetter || $0.isNumber }
        guard normalized.count == 12 else { return normalized }
        let first = normalized.prefix(4)
        let secondStart = normalized.index(normalized.startIndex, offsetBy: 4)
        let secondEnd = normalized.index(secondStart, offsetBy: 4)
        let second = normalized[secondStart..<secondEnd]
        let third = normalized.suffix(4)
        return "\(first)-\(second)-\(third)"
    }

    private static func secureRandomData(count: Int) throws -> Data {
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { buffer in
            guard let address = buffer.baseAddress else {
                return errSecAllocate
            }
            return SecRandomCopyBytes(kSecRandomDefault, count, address)
        }
        guard status == errSecSuccess else {
            throw CompanionCredentialError.keychain(status)
        }
        return data
    }
}

protocol CompanionCredentialStoring: Sendable {
    func load() throws -> CompanionCredentialRecord?
    func save(_ credential: CompanionCredentialRecord) throws
    func delete() throws
}

struct CompanionKeychainCredentialStore: CompanionCredentialStoring, Sendable {
    private let service: String
    private let account: String

    init(
        service: String = "app.alphatrade.status.companion",
        account: String = "credential-v1"
    ) {
        precondition(!service.isEmpty && !account.isEmpty)
        self.service = service
        self.account = account
    }

    func load() throws -> CompanionCredentialRecord? {
        var query = try baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw CompanionCredentialError.keychain(status)
        }
        guard let data = result as? Data,
              let credential = try? JSONDecoder().decode(CompanionCredentialRecord.self, from: data),
              credential.schemaVersion == CompanionCredentialRecord.schemaVersion,
              isValid(credential) else {
            throw CompanionCredentialError.invalidStoredCredential
        }
        return credential
    }

    func save(_ credential: CompanionCredentialRecord) throws {
        guard credential.schemaVersion == CompanionCredentialRecord.schemaVersion,
              isValid(credential) else {
            throw CompanionCredentialError.invalidStoredCredential
        }
        let data = try JSONEncoder().encode(credential)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let query = try baseQuery()
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
            if status == errSecParam || status == errSecUnimplemented {
                // The legacy login Keychain does not expose data-protection
                // accessibility classes on every supported macOS release.
                // Keep the strongest local-only class where supported, and
                // otherwise rely on the login Keychain's own encrypted ACL.
                insert.removeValue(forKey: kSecAttrAccessible as String)
                status = SecItemAdd(insert as CFDictionary, nil)
            }
        }
        guard status == errSecSuccess else {
            throw CompanionCredentialError.keychain(status)
        }
    }

    func delete() throws {
        let status = SecItemDelete(try baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CompanionCredentialError.keychain(status)
        }
    }

    private func baseQuery() throws -> [String: Any] {
        // Without opting into the data-protection keychain, SecItem uses the
        // standard macOS keychain search list and SecItemAdd writes to the
        // default login keychain. This works with a local ad-hoc signature and
        // keeps the credential outside application files and UserDefaults.
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    private func isValid(_ credential: CompanionCredentialRecord) -> Bool {
        let secretCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_")).inverted
        guard credential.deviceSecret.count == 43,
              credential.deviceSecret.rangeOfCharacter(from: secretCharacters) == nil else {
            return false
        }

        switch credential.phase {
        case .active:
            return credential.pairingCode == nil && credential.pairingExpiresAt == nil
        case .pending:
            guard let code = credential.pairingCode else { return false }
            return code.count == 12 && code.allSatisfy(Self.validPairingCharacters.contains)
        }
    }

    private static let validPairingCharacters = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
}

enum CompanionCredentialError: LocalizedError, Equatable {
    case randomGenerationFailed
    case invalidStoredCredential
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .randomGenerationFailed:
            return "Nepodařilo se vytvořit bezpečné párovací údaje."
        case .invalidStoredCredential:
            return "Uložené párování je poškozené."
        case .keychain(let status):
            return "Keychain není dostupný (kód \(status))."
        }
    }
}
