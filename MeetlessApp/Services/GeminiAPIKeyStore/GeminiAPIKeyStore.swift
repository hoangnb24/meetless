import Foundation
import Security

protocol GeminiAPIKeyStoring {
    func loadAPIKey() throws -> String?
    func saveAPIKey(_ apiKey: String) throws
    func deleteAPIKey() throws
}

enum GeminiAPIKeyStoreError: Error, Equatable {
    case invalidStoredData
    case keychainFailure(operation: KeychainOperation, status: OSStatus)
}

enum KeychainOperation: String, Equatable {
    case add
    case copyMatching
    case update
    case delete
}

protocol KeychainItemAccessing {
    func add(_ query: [String: Any]) -> OSStatus
    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, item: Any?)
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

struct SystemKeychainItemAccessor: KeychainItemAccessing {
    func add(_ query: [String: Any]) -> OSStatus {
        SecItemAdd(query as CFDictionary, nil)
    }

    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, item: Any?) {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        return (status, item)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

final class KeychainGeminiAPIKeyStore: GeminiAPIKeyStoring {
    private let keychain: KeychainItemAccessing
    private let service: String
    private let account: String

    init(
        keychain: KeychainItemAccessing = SystemKeychainItemAccessor(),
        service: String = "com.themrb.meetless.gemini-api-key",
        account: String = "gemini-api-key"
    ) {
        self.keychain = keychain
        self.service = service
        self.account = account
    }

    func loadAPIKey() throws -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        let result = keychain.copyMatching(query)
        switch result.status {
        case errSecSuccess:
            guard let data = result.item as? Data, let apiKey = String(data: data, encoding: .utf8) else {
                throw GeminiAPIKeyStoreError.invalidStoredData
            }
            return apiKey
        case errSecItemNotFound:
            return nil
        default:
            throw GeminiAPIKeyStoreError.keychainFailure(
                operation: .copyMatching,
                status: result.status
            )
        }
    }

    func saveAPIKey(_ apiKey: String) throws {
        let data = Data(apiKey.utf8)
        var query = baseQuery()
        query[kSecValueData as String] = data

        let addStatus = keychain.add(query)
        switch addStatus {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            try updateAPIKeyData(data)
        default:
            throw GeminiAPIKeyStoreError.keychainFailure(operation: .add, status: addStatus)
        }
    }

    func deleteAPIKey() throws {
        let status = keychain.delete(baseQuery())
        switch status {
        case errSecSuccess, errSecItemNotFound:
            return
        default:
            throw GeminiAPIKeyStoreError.keychainFailure(operation: .delete, status: status)
        }
    }

    private func updateAPIKeyData(_ data: Data) throws {
        let status = keychain.update(
            baseQuery(),
            attributes: [kSecValueData as String: data]
        )

        guard status == errSecSuccess else {
            throw GeminiAPIKeyStoreError.keychainFailure(operation: .update, status: status)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
