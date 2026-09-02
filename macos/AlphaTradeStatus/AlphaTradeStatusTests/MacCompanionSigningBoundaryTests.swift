import Foundation
import XCTest

final class MacCompanionSigningBoundaryTests: XCTestCase {
    func testAppEntitlementsAreExplicitAndReadOnlyNetworkClientOnly() throws {
        let projectRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let entitlementsURL = projectRoot
            .appendingPathComponent("AlphaTradeStatus/AlphaTradeStatus.entitlements")
        let data = try Data(contentsOf: entitlementsURL)
        let decoded = try PropertyListSerialization.propertyList(from: data, format: nil)
        let entitlements = try XCTUnwrap(decoded as? [String: Any])

        XCTAssertEqual(
            Set(entitlements.keys),
            Set([
                "com.apple.security.app-sandbox",
                "com.apple.security.network.client",
            ])
        )
        XCTAssertEqual(entitlements["com.apple.security.app-sandbox"] as? Bool, true)
        XCTAssertEqual(entitlements["com.apple.security.network.client"] as? Bool, true)
        XCTAssertNil(entitlements["com.apple.security.network.server"])
        XCTAssertNil(entitlements["com.apple.security.get-task-allow"])
    }

    func testBothAppConfigurationsUseTheExplicitEntitlementsFile() throws {
        let projectRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let projectFile = projectRoot
            .appendingPathComponent("AlphaTradeStatus.xcodeproj/project.pbxproj")
        let source = try String(contentsOf: projectFile, encoding: .utf8)
        let setting = "CODE_SIGN_ENTITLEMENTS = AlphaTradeStatus/AlphaTradeStatus.entitlements;"

        XCTAssertEqual(
            source.components(separatedBy: setting).count - 1,
            2,
            "Only the Debug and Release app configurations should carry this entitlement file"
        )
        XCTAssertFalse(source.contains("com.apple.security.network.server"))
    }

    func testCredentialStoreTargetsTheLoginKeychainWithoutExtraEntitlements() throws {
        let projectRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceFile = projectRoot.appendingPathComponent(
            "AlphaTradeStatus/Infrastructure/CompanionCredentialStore.swift"
        )
        let source = try String(contentsOf: sourceFile, encoding: .utf8)

        XCTAssertTrue(source.contains("kSecClassGenericPassword"))
        XCTAssertTrue(source.contains("kSecAttrService"))
        XCTAssertTrue(source.contains("kSecAttrAccount"))
        XCTAssertFalse(source.contains("kSecAttrSynchronizable"))
        XCTAssertFalse(source.contains("kSecUseDataProtectionKeychain"))
        XCTAssertTrue(source.contains("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly"))
    }
}
