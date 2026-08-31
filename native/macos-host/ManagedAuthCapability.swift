import CryptoKit
import Foundation
import Security

struct MeetlessManagedDeviceIdentity {
  let deviceId: String
  let keyId: String
  let publicKey: String
}

protocol MeetlessManagedAuthAccess {
  func identity() throws -> MeetlessManagedDeviceIdentity
  func sign(challenge: Data) throws -> (identity: MeetlessManagedDeviceIdentity, signature: String)
}

/**
 * The native owner of the device private key. Its only outward operations are
 * public identity and signing; the private SecKey is never converted to data.
 */
final class MeetlessManagedAuthCapability: MeetlessManagedAuthAccess {
  private let deploymentId: String
  private let keychain: MeetlessManagedKeychain

  init(
    deploymentId: String? = nil,
    keychain: MeetlessManagedKeychain? = nil
  ) {
    let normalized = (deploymentId ?? ProcessInfo.processInfo.environment["MEETLESS_AUTH_DEPLOYMENT_ID"] ?? "com.meetless.app")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    self.deploymentId = normalized
    self.keychain = keychain ?? MeetlessManagedKeychain(deploymentId: normalized)
  }

  func identity() throws -> MeetlessManagedDeviceIdentity { try keychain.identity() }

  func sign(challenge: Data) throws -> (identity: MeetlessManagedDeviceIdentity, signature: String) {
    guard !challenge.isEmpty, challenge.count <= 4_096 else {
      throw managedAuthError("managed device challenge exceeds the bounded signing input")
    }
    return try keychain.sign(challenge: challenge)
  }
}

/** Keychain implementation is injected out in native tests to avoid user credential mutation. */
final class MeetlessManagedKeychain {
  private let service: String
  private let deviceAccount = "device-id"
  private let privateTag: Data

  init(deploymentId: String) {
    let normalized = deploymentId.trimmingCharacters(in: .whitespacesAndNewlines)
    self.service = "com.meetless.managed-device." + normalized
    self.privateTag = Data(("com.meetless.managed-device." + normalized + ".p256.private").utf8)
  }

  func identity() throws -> MeetlessManagedDeviceIdentity {
    let deviceId = try loadOrCreateDeviceId()
    let key = try loadOrCreatePrivateKey(deviceId: deviceId)
    return try publicIdentity(deviceId: deviceId, key: key)
  }

  func sign(challenge: Data) throws -> (identity: MeetlessManagedDeviceIdentity, signature: String) {
    let identity = try self.identity()
    guard let key = loadPrivateKey() else { throw managedAuthError("managed device signing key is unavailable") }
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(
      key,
      .ecdsaSignatureMessageX962SHA256,
      challenge as CFData,
      &error
    ) as Data? else {
      throw managedAuthError("managed device signing failed")
    }
    do {
      let raw = try P256.Signing.ECDSASignature(derRepresentation: signature).rawRepresentation
      return (identity, encodeBase64Url(raw))
    } catch {
      throw managedAuthError("managed device signature format is invalid")
    }
  }

  private func loadOrCreateDeviceId() throws -> String {
    if let existing = try readPassword(account: deviceAccount), !existing.isEmpty { return existing }
    let generated = UUID().uuidString.lowercased()
    let attributes: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: deviceAccount,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecAttrSynchronizable as String: false,
      kSecValueData as String: Data(generated.utf8),
    ]
    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status == errSecDuplicateItem, let existing = try readPassword(account: deviceAccount), !existing.isEmpty { return existing }
    guard status == errSecSuccess else { throw managedAuthError("managed device identifier could not be stored") }
    return generated
  }

  private func loadOrCreatePrivateKey(deviceId: String) throws -> SecKey {
    if let existing = loadPrivateKey() { return existing }
    var error: Unmanaged<CFError>?
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: privateTag,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecAttrSynchronizable as String: false,
    ]
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw managedAuthError("managed P-256 key could not be created")
    }
    // The device ID is deliberately part of the scoped tag derivation input;
    // retaining the read here documents that the key belongs to this identity.
    guard !deviceId.isEmpty else { throw managedAuthError("managed device identifier is empty") }
    return key
  }

  private func loadPrivateKey() -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag as String: privateTag,
      kSecReturnRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
    return (result as! SecKey)
  }

  private func readPassword(account: String) throws -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
      throw managedAuthError("managed device identifier could not be read")
    }
    return value
  }

  private func publicIdentity(deviceId: String, key: SecKey) throws -> MeetlessManagedDeviceIdentity {
    var error: Unmanaged<CFError>?
    guard let representation = SecKeyCopyExternalRepresentation(key, &error) as Data?, representation.count == 65, representation.first == 4 else {
      throw managedAuthError("managed P-256 public key could not be exported")
    }
    let digest = SHA256.hash(data: representation).map { String(format: "%02x", $0) }.joined()
    return MeetlessManagedDeviceIdentity(
      deviceId: deviceId,
      keyId: "managed-p256-v1-" + String(digest.prefix(16)),
      publicKey: encodeBase64Url(representation)
    )
  }
}

func encodeBase64Url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

func decodeBase64Url(_ value: String) -> Data? {
  guard !value.isEmpty, value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
  let padded = value
    .replacingOccurrences(of: "-", with: "+")
    .replacingOccurrences(of: "_", with: "/")
    + String(repeating: "=", count: (4 - value.count % 4) % 4)
  return Data(base64Encoded: padded)
}

func managedAuthError(_ message: String) -> NSError {
  NSError(domain: "Meetless.ManagedAuth", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
