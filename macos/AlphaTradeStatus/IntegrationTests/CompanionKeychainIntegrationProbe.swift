import Foundation
import Security

@main
struct CompanionKeychainIntegrationProbe {
    static func main() throws {
        let nonce = UUID().uuidString.lowercased()
        let service = "app.alphatrade.status.integration.\(nonce)"
        let account = "credential-\(nonce)"
        let store = CompanionKeychainCredentialStore(service: service, account: account)

        defer {
            try? store.delete()
        }

        print("probe-stage=initial-cleanup")
        try store.delete()
        let credential = try CompanionPairingMaterial.makePendingCredential()
        print("probe-stage=save")
        try store.save(credential)
        print("probe-stage=load")
        guard try store.load() == credential else {
            throw ProbeError.roundTripFailed
        }

        print("probe-stage=attributes")
        let accessibility = try storedAccessibility(service: service, account: account)
        if let accessibility,
           accessibility != kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String {
            throw ProbeError.unexpectedAccessibility(accessibility)
        }

        print("probe-stage=final-cleanup")
        try store.delete()
        guard try store.load() == nil else {
            throw ProbeError.cleanupFailed
        }

        print(
            "PASS disposable login-Keychain round trip; cleanup=verified; "
                + "accessibility=\(accessibility == nil ? "login-keychain-managed" : "this-device-only")"
        )
    }

    private static func storedAccessibility(
        service: String,
        account: String
    ) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let attributes = result as? [String: Any] else {
            throw CompanionCredentialError.keychain(status)
        }
        return attributes[kSecAttrAccessible as String] as? String
    }
}

private enum ProbeError: LocalizedError {
    case roundTripFailed
    case cleanupFailed
    case unexpectedAccessibility(String)

    var errorDescription: String? {
        switch self {
        case .roundTripFailed:
            return "Disposable Keychain credential did not round-trip."
        case .cleanupFailed:
            return "Disposable Keychain credential was not deleted."
        case .unexpectedAccessibility(let value):
            return "Unexpected Keychain accessibility class: \(value)"
        }
    }
}
