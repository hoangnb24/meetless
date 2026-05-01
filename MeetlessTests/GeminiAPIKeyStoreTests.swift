import Security
import XCTest
@testable import Meetless

final class GeminiAPIKeyStoreTests: XCTestCase {
    func testLoadAPIKeyReturnsNilWhenKeyIsMissing() throws {
        let keychain = FakeKeychainItemAccessor()
        let store = KeychainGeminiAPIKeyStore(keychain: keychain)

        let apiKey = try store.loadAPIKey()

        XCTAssertNil(apiKey)
    }

    func testSaveAPIKeyStoresValueForLaterReads() throws {
        let keychain = FakeKeychainItemAccessor()
        let store = KeychainGeminiAPIKeyStore(keychain: keychain)

        try store.saveAPIKey("gemini-secret")

        XCTAssertEqual(try store.loadAPIKey(), "gemini-secret")
        XCTAssertEqual(keychain.recordedValues, ["gemini-secret"])
    }

    func testSaveAPIKeyUpdatesExistingValue() throws {
        let keychain = FakeKeychainItemAccessor()
        let store = KeychainGeminiAPIKeyStore(keychain: keychain)

        try store.saveAPIKey("old-secret")
        try store.saveAPIKey("new-secret")

        XCTAssertEqual(try store.loadAPIKey(), "new-secret")
        XCTAssertEqual(keychain.recordedValues, ["old-secret", "new-secret"])
    }

    func testDeleteAPIKeyRemovesValueForLaterReads() throws {
        let keychain = FakeKeychainItemAccessor()
        let store = KeychainGeminiAPIKeyStore(keychain: keychain)

        try store.saveAPIKey("gemini-secret")
        try store.deleteAPIKey()

        XCTAssertNil(try store.loadAPIKey())
    }

    func testLoadMapsKeychainFailure() {
        let keychain = FakeKeychainItemAccessor(copyMatchingStatusOverride: errSecAuthFailed)
        let store = KeychainGeminiAPIKeyStore(keychain: keychain)

        XCTAssertThrowsError(try store.loadAPIKey()) { error in
            XCTAssertEqual(
                error as? GeminiAPIKeyStoreError,
                .keychainFailure(operation: .copyMatching, status: errSecAuthFailed)
            )
        }
    }

    func testSaveMapsAddFailure() {
        let keychain = FakeKeychainItemAccessor(addStatusOverride: errSecNotAvailable)
        let store = KeychainGeminiAPIKeyStore(keychain: keychain)

        XCTAssertThrowsError(try store.saveAPIKey("gemini-secret")) { error in
            XCTAssertEqual(
                error as? GeminiAPIKeyStoreError,
                .keychainFailure(operation: .add, status: errSecNotAvailable)
            )
        }
    }

    func testSaveMapsUpdateFailure() {
        let keychain = FakeKeychainItemAccessor(updateStatusOverride: errSecInteractionNotAllowed)
        let store = KeychainGeminiAPIKeyStore(keychain: keychain)

        XCTAssertNoThrow(try store.saveAPIKey("old-secret"))
        XCTAssertThrowsError(try store.saveAPIKey("new-secret")) { error in
            XCTAssertEqual(
                error as? GeminiAPIKeyStoreError,
                .keychainFailure(operation: .update, status: errSecInteractionNotAllowed)
            )
        }
    }

    func testDeleteMapsFailure() {
        let keychain = FakeKeychainItemAccessor(deleteStatusOverride: errSecAuthFailed)
        let store = KeychainGeminiAPIKeyStore(keychain: keychain)

        XCTAssertThrowsError(try store.deleteAPIKey()) { error in
            XCTAssertEqual(
                error as? GeminiAPIKeyStoreError,
                .keychainFailure(operation: .delete, status: errSecAuthFailed)
            )
        }
    }

    func testLoadMapsInvalidStoredData() {
        let keychain = FakeKeychainItemAccessor(copyMatchingItemOverride: "not-data")
        let store = KeychainGeminiAPIKeyStore(keychain: keychain)

        XCTAssertThrowsError(try store.loadAPIKey()) { error in
            XCTAssertEqual(error as? GeminiAPIKeyStoreError, .invalidStoredData)
        }
    }
}

private final class FakeKeychainItemAccessor: KeychainItemAccessing {
    private var storedData: Data?
    private let addStatusOverride: OSStatus?
    private let copyMatchingStatusOverride: OSStatus?
    private let copyMatchingItemOverride: Any?
    private let updateStatusOverride: OSStatus?
    private let deleteStatusOverride: OSStatus?

    private(set) var recordedValues: [String] = []

    init(
        addStatusOverride: OSStatus? = nil,
        copyMatchingStatusOverride: OSStatus? = nil,
        copyMatchingItemOverride: Any? = nil,
        updateStatusOverride: OSStatus? = nil,
        deleteStatusOverride: OSStatus? = nil
    ) {
        self.addStatusOverride = addStatusOverride
        self.copyMatchingStatusOverride = copyMatchingStatusOverride
        self.copyMatchingItemOverride = copyMatchingItemOverride
        self.updateStatusOverride = updateStatusOverride
        self.deleteStatusOverride = deleteStatusOverride
    }

    func add(_ query: [String: Any]) -> OSStatus {
        if let addStatusOverride {
            return addStatusOverride
        }

        guard storedData == nil else {
            return errSecDuplicateItem
        }

        storedData = query[kSecValueData as String] as? Data
        recordStoredValue()
        return errSecSuccess
    }

    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, item: Any?) {
        if let copyMatchingStatusOverride {
            return (copyMatchingStatusOverride, nil)
        }

        if let copyMatchingItemOverride {
            return (errSecSuccess, copyMatchingItemOverride)
        }

        guard let storedData else {
            return (errSecItemNotFound, nil)
        }

        return (errSecSuccess, storedData)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        if let updateStatusOverride {
            return updateStatusOverride
        }

        guard storedData != nil else {
            return errSecItemNotFound
        }

        storedData = attributes[kSecValueData as String] as? Data
        recordStoredValue()
        return errSecSuccess
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        if let deleteStatusOverride {
            return deleteStatusOverride
        }

        guard storedData != nil else {
            return errSecItemNotFound
        }

        storedData = nil
        return errSecSuccess
    }

    private func recordStoredValue() {
        guard let storedData, let value = String(data: storedData, encoding: .utf8) else {
            return
        }

        recordedValues.append(value)
    }
}
