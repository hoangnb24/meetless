import Darwin
import CryptoKit
import Foundation
import Security
@testable import MeetlessHostCore

private var failures = 0

private final class RecordingRegistrationDiagnosticSink: MeetlessProcessRegistrationDiagnosticSink {
  private let lock = NSLock()
  private var recordedEvents: [MeetlessProcessRegistrationRemovalEvent] = []

  func record(_ event: MeetlessProcessRegistrationRemovalEvent) {
    lock.lock()
    recordedEvents.append(event)
    lock.unlock()
  }

  func snapshot() -> [MeetlessProcessRegistrationRemovalEvent] {
    lock.lock()
    defer { lock.unlock() }
    return recordedEvents
  }

  func removeAll() {
    lock.lock()
    recordedEvents.removeAll()
    lock.unlock()
  }
}

private final class CancellationOrderingDiagnosticSink: MeetlessProcessRegistrationDiagnosticSink {
  private let cancellation: NativeRequestCancellation
  private let entered = DispatchSemaphore(value: 0)
  private let release = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var blockNextRecord = true
  private var recordedEventCount = 0
  private var cancellationObserved = false

  init(cancellation: NativeRequestCancellation) {
    self.cancellation = cancellation
  }

  func record(_ event: MeetlessProcessRegistrationRemovalEvent) {
    lock.lock()
    recordedEventCount += 1
    cancellationObserved = cancellation.isCancelled()
    let shouldBlock = blockNextRecord
    blockNextRecord = false
    lock.unlock()
    entered.signal()
    if shouldBlock {
      _ = release.wait(timeout: .now() + .seconds(5))
    }
  }

  func waitUntilRecording() -> Bool {
    entered.wait(timeout: .now() + .seconds(2)) == .success
  }

  func unblock() {
    release.signal()
  }

  var didObserveCancellation: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancellationObserved
  }

  var eventCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return recordedEventCount
  }
}

private struct RuntimeEndpointGoldenPolicy: Decodable {
  let schema: String
  let workingDirectory: String
  let recordingEndpointName: String
  let transcriptionEndpointName: String
}

private struct RuntimeEndpointGoldenVector: Decodable {
  let id: String
  let policy: RuntimeEndpointGoldenPolicy
  let composition: MeetlessRuntimeEndpointComposition
}

private struct FoundationJSONGoldenConfiguration: Encodable {
  let repositoryRoot: String
  let runtimeRoot: String
  let listen: String
  let rendererOrigin: String
  let transcriptionSocket: String
  let transcriptionStaging: String
  let nodePath: String
  let runtimeCliPath: String
  let captureHelperPath: String?
  let identityPath: String
  let endpointPolicy: String?
  let endpointWorkingDirectory: String?
  let recordingEndpointName: String?
  let transcriptionEndpointName: String?
}

private struct FoundationJSONGoldenIdentity: Encodable {
  let version: Int
  let bundleIdentifier: String
  let bundlePath: String
  let bundleRealPath: String
  let executablePath: String
  let designatedRequirement: String
  let cdHash: String
  let binarySha256: String
  let binaryDevice: Int
  let binaryInode: Int
  let binarySize: Int
  let configuration: FoundationJSONGoldenConfiguration
}

private enum FoundationJSONGoldenArrayValue: Encodable {
  case string(String)
  case integer(Int)

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .integer(let value): try container.encode(value)
    }
  }
}

private struct FoundationJSONGoldenNested: Encodable {
  let z: String
  let a: String
}

private struct FoundationJSONGoldenProfile: Encodable {
  let array: [FoundationJSONGoldenArrayValue]
  let emptyArray: [String]
  let emptyObject: [String: String]
  let escaped: String
  let nested: FoundationJSONGoldenNested
  let optionalOmitted: String?

  private enum CodingKeys: String, CodingKey {
    case array
    case emptyArray
    case emptyObject
    case escaped
    case nested
    case nullValue
    case optionalOmitted
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(array, forKey: .array)
    try container.encode(emptyArray, forKey: .emptyArray)
    try container.encode(emptyObject, forKey: .emptyObject)
    try container.encode(escaped, forKey: .escaped)
    try container.encode(nested, forKey: .nested)
    try container.encodeNil(forKey: .nullValue)
    try container.encodeIfPresent(optionalOmitted, forKey: .optionalOmitted)
  }
}

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    failures += 1
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
  }
}

private func diagnosticFailure(_ decision: MeetlessChildRegistrationDecision) -> MeetlessProcessRegistrationFailure? {
  if case .rejected(let failure) = decision { return failure }
  return nil
}

private func expectThrow(_ message: String, _ action: () throws -> Void) {
  do {
    try action()
    check(false, message)
  } catch {}
}

private func testLaunchCoordinatorLifecycle() {
  let fixtures: [(String, String, String, Bool)] = [
    ("mounted", "/Volumes/Meetless/Meetless.app", "/Volumes/Meetless/Meetless.app", true),
    ("alternate", "/Users/example/Desktop/Meetless.app", "/Users/example/Desktop/Meetless.app", true),
    ("symlinked", "/Applications/Meetless.app", "/Volumes/Meetless/Meetless.app", true),
    ("canonical", "/Applications/Meetless.app", "/Applications/Meetless.app", false),
  ]
  for (label, lexicalPath, resolvedPath, rejected) in fixtures {
    var events: [String] = []
    var guidanceMessage: String?
    let coordinator = MeetlessLaunchCoordinator<String>(
      locationCheck: {
        events.append("location")
        try MeetlessInstallLocation.validate(lexicalPath: lexicalPath, resolvedPath: resolvedPath)
      },
      processCheck: { events.append("process") },
      guidance: { message in
        events.append("guidance")
        guidanceMessage = message
      },
      configurationCheck: {
        events.append("configuration")
        return "fixture-configuration"
      },
      resourceCheck: { configuration in
        events.append("resources")
        check(configuration == "fixture-configuration", "\(label) resource check must receive the loaded configuration")
      },
      identity: { configuration in
        events.append("identity")
        check(configuration == "fixture-configuration", "\(label) identity check must receive the loaded configuration")
      },
      configurationReady: { configuration in
        events.append("configuration-ready")
        check(configuration == "fixture-configuration", "\(label) configuration publication must receive the loaded configuration")
      },
      lock: { configuration in
        events.append("lock")
        check(configuration == "fixture-configuration", "\(label) lock must receive the loaded configuration")
      },
      capability: { configuration in
        events.append("capability")
        check(configuration == "fixture-configuration", "\(label) capability must receive the loaded configuration")
      },
      runtime: { configuration in
        events.append("runtime")
        check(configuration == "fixture-configuration", "\(label) runtime must receive the loaded configuration")
      }
    )

    if rejected {
      expectThrow("\(label) launch must stop at location guidance") { _ = try coordinator.run() }
      check(events == ["location", "guidance"], "\(label) launch must have zero process, configuration, identity, lock, capability, or runtime effects")
      check(guidanceMessage?.contains("/Applications/Meetless.app") == true, "\(label) launch guidance must name the exact install path")
    } else {
      do {
        let configuration = try coordinator.run()
        check(configuration == "fixture-configuration", "canonical launch must return its configuration")
      } catch {
        check(false, "canonical launch must complete the coordinator: \(error)")
      }
      check(
        events == ["location", "process", "configuration", "resources", "configuration-ready", "lock", "identity", "capability", "runtime"],
        "canonical launch must acquire the shared lock before identity publication, capability, and runtime startup"
      )
      check(guidanceMessage == nil, "canonical launch must not show alternate-path guidance")
    }
  }
}

private func testHostExecutableUsesPOSIXIdentity() throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("meetless-host-identity-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let executable = root.appendingPathComponent("MeetlessHost")
  try Data("fixture executable".utf8).write(to: executable)

  let identity = try inspectMeetlessExecutableIdentity(executable.path)
  check(identity.device > 0, "POSIX executable identity must include the device")
  check(identity.inode > 0, "POSIX executable identity must include the inode")
  check(identity.size == 18, "POSIX executable identity must include the byte size")

  let link = root.appendingPathComponent("MeetlessHost-link")
  try FileManager.default.createSymbolicLink(at: link, withDestinationURL: executable)
  expectThrow("POSIX executable identity must reject symlinks") {
    _ = try inspectMeetlessExecutableIdentity(link.path)
  }
}

private func testAppStoreContainerRuntimeResolutionBoundary() {
  let containerSupport = "/Users/example/Library/Containers/com.meetless.app/Data/Library/Application Support"
  let runtimeRoot = "\(containerSupport)/Meetless"
  check(
    meetlessAppStoreContainerSupportRoot(for: runtimeRoot) == containerSupport,
    "MAS runtime state must derive its container Application Support root from the app-container runtime path"
  )
  check(
    meetlessAppStoreContainerSupportRoot(for: "/Users/example/Library/Application Support/Meetless") == nil,
    "direct-DMG support state must not be classified as MAS app-container state"
  )
  check(
    meetlessAppStoreContainerSupportRoot(for: "\(containerSupport)/Meetless/recordings") == nil,
    "MAS recording export state must not be classified as the runtime root"
  )
}

private func testPackagedSignaturePolicyBoundary() {
  let directRuntimeRoot = "Library/Application Support/Meetless"
  let appStoreRuntimeRoot = "Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless"
  let directPolicy = meetlessSignaturePolicy(forRuntimeRootRelativePath: directRuntimeRoot)
  let appStorePolicy = meetlessSignaturePolicy(forRuntimeRootRelativePath: appStoreRuntimeRoot)
  let directResolvedRuntimeRoot = "/Users/example/Library/Application Support/Meetless"
  let appStoreResolvedRuntimeRoot = "/Users/example/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless"
  check(
    directPolicy == MeetlessPackagedSignaturePolicy.directDeveloperID,
    "direct packaged state must select the Developer ID signature policy"
  )
  check(
    appStorePolicy == MeetlessPackagedSignaturePolicy.appStoreDevelopment,
    "MAS app-container state must select the Apple Development signature policy"
  )
  check(
    meetlessSignaturePolicy(forRuntimeRoot: directResolvedRuntimeRoot) == .directDeveloperID,
    "resolved direct-DMG runtime state must select the Developer ID signature policy"
  )
  check(
    meetlessSignaturePolicy(forRuntimeRoot: appStoreResolvedRuntimeRoot) == .appStoreDevelopment,
    "resolved MAS app-container runtime state must select the Apple Development signature policy"
  )
  check(
    meetlessSignaturePolicy(forRuntimeRootRelativePath: "Library/Application Support/Other") == nil,
    "an unknown packaged target must not inherit either signature policy"
  )

  let directRequirement = meetlessPackagedSignatureRequirement(for: .directDeveloperID)
  let appStoreRequirement = meetlessPackagedSignatureRequirement(for: .appStoreDevelopment)
  check(
    directRequirement.contains("certificate 1[field.1.2.840.113635.100.6.2.6] exists") &&
      directRequirement.contains("certificate leaf[field.1.2.840.113635.100.6.1.13] exists") &&
      !directRequirement.contains("Apple Development"),
    "direct packaging must retain the exact Developer ID certificate requirement"
  )
  check(
    appStoreRequirement.contains("certificate leaf[subject.CN] = \"Apple Development: Long Le (335C7MY4H4)\"") &&
      appStoreRequirement.contains("certificate leaf[subject.OU] = \"63M98WD275\"") &&
      !appStoreRequirement.contains("field.1.2.840.113635.100.6.1.13"),
    "MAS packaging must require only the exact Apple Development identity and Team ID"
  )
}

private func fixtureIdentity(_ data: Data) -> StagedRangeIdentity {
  StagedRangeIdentity(
    byteLength: Int64(data.count),
    sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  )
}

private final class FakeUploadTask: MeetlessUploadTask {
  private let lock = NSLock()
  private var didResume = false
  private var didCancel = false
  var resumed: Bool { lock.lock(); defer { lock.unlock() }; return didResume }
  var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return didCancel }
  func resume() { lock.lock(); didResume = true; lock.unlock() }
  func cancel() { lock.lock(); didCancel = true; lock.unlock() }
}

private func authorizedRuntimeState() -> RuntimeAuthorizationState {
  let state = RuntimeAuthorizationState()
  state.publish(getpid())
  return state
}

private final class LockedCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func increment() { lock.lock(); value += 1; lock.unlock() }
  func snapshot() -> Int { lock.lock(); defer { lock.unlock() }; return value }
}

private final class FakeKeychain: MeetlessKeychainAccess {
  var readCount = 0
  func status() -> String { "configured" }
  func readForTranscription() -> MeetlessCredentialRead {
    readCount += 1
    return .configured("fixture-key-not-real-credential")
  }
}

/** Nonpersistent test key: this deliberately never touches the user's Keychain. */
private final class FakeManagedAuth: MeetlessManagedAuthAccess {
  private let privateKey = P256.Signing.PrivateKey()
  private lazy var value: MeetlessManagedDeviceIdentity = {
    let publicKey = privateKey.publicKey.rawRepresentation
    let digest = SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined()
    return MeetlessManagedDeviceIdentity(
      deviceId: "fixture-device",
      keyId: "managed-p256-v1-\(digest.prefix(16))",
      publicKey: encodeBase64Url(publicKey)
    )
  }()

  func identity() throws -> MeetlessManagedDeviceIdentity { value }

  func sign(challenge: Data) throws -> (identity: MeetlessManagedDeviceIdentity, signature: String) {
    let signature = try privateKey.signature(for: challenge)
    return (value, encodeBase64Url(signature.rawRepresentation))
  }
}

private func testManagedAuthUsesOnlyPublicIdentityAndNonpersistentTestKeys() throws {
  let access = FakeManagedAuth()
  let identity = try access.identity()
  let signed = try access.sign(challenge: Data("challenge-bytes".utf8))
  check(identity.deviceId == "fixture-device", "managed auth identity must expose a stable device ID")
  check(identity.publicKey.count > 60 && !identity.publicKey.contains("PRIVATE"), "managed auth identity must expose only the public key")
  guard let publicBytes = decodeBase64Url(identity.publicKey), let signatureBytes = decodeBase64Url(signed.signature) else {
    check(false, "managed auth fixture identity and signature must be base64url")
    return
  }
  do {
    let publicKey = try P256.Signing.PublicKey(rawRepresentation: publicBytes)
    let signature = try P256.Signing.ECDSASignature(rawRepresentation: signatureBytes)
    check(publicKey.isValidSignature(signature, for: Data("challenge-bytes".utf8)), "managed auth signature must prove the challenge bytes")
  } catch {
    check(false, "managed auth fixture key must be a valid P-256 key")
  }
}

private final class FakePremiumAccess: MeetlessPremiumPurchaseAccess {
  var purchasedPackage: String?
  var restoreCount = 0
  let inactive = MeetlessPremiumAccessResult(
    status: "inactive",
    packages: [MeetlessPremiumPackage(
      packageId: "monthly",
      productId: meetlessPremiumMonthlyProduct,
      localizedPrice: "799.000 ₫",
      trialEligible: true
    )],
    reason: nil
  )
  let active = MeetlessPremiumAccessResult(status: "active", packages: [], reason: nil)

  func status() -> MeetlessPremiumAccessResult { inactive }
  func purchase(packageId: String) -> MeetlessPremiumMutationResult {
    purchasedPackage = packageId
    return MeetlessPremiumMutationResult(outcome: "active", access: active, appleSignedTransaction: "eyJhbGciOiJFUzI1NiJ9.synthetic.signature")
  }
  func restore() -> MeetlessPremiumMutationResult {
    restoreCount += 1
    return MeetlessPremiumMutationResult(outcome: "active", access: active, appleSignedTransaction: "eyJhbGciOiJFUzI1NiJ9.synthetic.signature")
  }
}

private final class BlockingPremiumAccess: MeetlessPremiumPurchaseAccess {
  let started = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
  let active = MeetlessPremiumAccessResult(status: "active", packages: [], reason: nil)

  func status() -> MeetlessPremiumAccessResult {
    MeetlessPremiumAccessResult(status: "inactive", packages: [], reason: nil)
  }

  func purchase(packageId: String) -> MeetlessPremiumMutationResult {
    started.signal()
    _ = release.wait(timeout: .now() + .seconds(5))
    return MeetlessPremiumMutationResult(outcome: "active", access: active)
  }

  func restore() -> MeetlessPremiumMutationResult {
    MeetlessPremiumMutationResult(outcome: "failed", access: .unavailable("store_unavailable"))
  }
}

private final class FakeUploadSession: MeetlessUploadSession {
  let task = FakeUploadTask()
  var responseCode: Int?
  var responseBody: Data?
  var request: URLRequest?
  var body: Data?

  func uploadTask(
    request: URLRequest,
    body: Data,
    completion: @escaping @Sendable (Data?, URLResponse?, Error?) -> Void
  ) -> MeetlessUploadTask {
    self.request = request
    self.body = body
    if let responseCode {
      let response = HTTPURLResponse(url: request.url!, statusCode: responseCode, httpVersion: nil, headerFields: ["X-Secret": "must-not-escape"])
      completion(responseBody, response, nil)
    }
    return task
  }
}

private func testPeerAncestry() {
  let parents: [pid_t: pid_t] = [40: 30, 30: 20, 20: 1]
  let authorizer = RuntimePeerAuthorizer(parentPID: { parents[$0] })
  check(authorizer.isAuthorized(peerPID: 40, expectedRuntimePID: { 20 }), "descendant peer must reach exact runtime PID")
  check(!authorizer.isAuthorized(peerPID: 40, expectedRuntimePID: { 21 }), "unrelated peer ancestry must be rejected")
  var calls = 0
  check(!authorizer.isAuthorized(peerPID: 40, expectedRuntimePID: {
    calls += 1
    return calls == 1 ? 20 : 21
  }), "runtime PID identity substitution must be rejected")
}

private func testBoundedRequestLine() {
  var descriptors: [Int32] = [0, 0]
  check(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0, "socketpair must open")
  defer { close(descriptors[0]); close(descriptors[1]) }
  let oversized = Data((String(repeating: "x", count: 33) + "\n").utf8)
  oversized.withUnsafeBytes { buffer in _ = Darwin.write(descriptors[0], buffer.baseAddress, buffer.count) }
  check(readBoundedLine(descriptors[1], maximumBytes: 32) == nil, "oversized request line must be rejected")
}

private func foundationJSONGoldenData<T: Encodable>(_ value: T) throws -> Data {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  return try encoder.encode(value) + Data([10])
}

private func testFoundationJSONIdentityGoldenVector() throws {
  let configuration = FoundationJSONGoldenConfiguration(
    repositoryRoot: "/Users/example/Meetless / source",
    runtimeRoot: "/Users/example/Library/Application Support/Meetless",
    listen: "127.0.0.1:16777",
    rendererOrigin: "http://127.0.0.1:18082/path/a/b",
    transcriptionSocket: "/Users/example/Library/Application Support/Meetless/transcription.sock",
    transcriptionStaging: "/Users/example/Library/Application Support/Meetless/meeting-store/transcription-ranges",
    nodePath: "/Users/example/Meetless / source/runtime/node",
    runtimeCliPath: "/Users/example/Meetless / source/packages/runtime/dist/cli.js",
    captureHelperPath: nil,
    identityPath: "/Users/example/Library/Application Support/Meetless/paseo-home/server-id",
    endpointPolicy: nil,
    endpointWorkingDirectory: nil,
    recordingEndpointName: nil,
    transcriptionEndpointName: nil
  )
  let identity = FoundationJSONGoldenIdentity(
    version: 1,
    bundleIdentifier: "com.meetless.app",
    bundlePath: "/Applications/Meetless.app",
    bundleRealPath: "/Applications/Meetless.app",
    executablePath: "/Applications/Meetless.app/Contents/MacOS/MeetlessHost",
    designatedRequirement: "identifier \"com.meetless.app\": path \"https://example.test/a/b\" literal marker",
    cdHash: String(repeating: "a", count: 40),
    binarySha256: String(repeating: "b", count: 64),
    binaryDevice: 42,
    binaryInode: 987654321,
    binarySize: 123456,
    configuration: configuration
  )
  let profile = FoundationJSONGoldenProfile(
    array: [.string("a/b"), .string("quote\": / and \\\\backslash"), .integer(17)],
    emptyArray: [],
    emptyObject: [:],
    escaped: "</script> \"quoted\": value \\\\ newline\n separator\u{2028}",
    nested: FoundationJSONGoldenNested(z: "last", a: "first"),
    optionalOmitted: nil
  )
  let identityData = try foundationJSONGoldenData(identity)
  let profileData = try foundationJSONGoldenData(profile)
  check(
    identityData == Data(base64Encoded: "ewogICJiaW5hcnlEZXZpY2UiIDogNDIsCiAgImJpbmFyeUlub2RlIiA6IDk4NzY1NDMyMSwKICAiYmluYXJ5U2hhMjU2IiA6ICJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIiwKICAiYmluYXJ5U2l6ZSIgOiAxMjM0NTYsCiAgImJ1bmRsZUlkZW50aWZpZXIiIDogImNvbS5tZWV0bGVzcy5hcHAiLAogICJidW5kbGVQYXRoIiA6ICJcL0FwcGxpY2F0aW9uc1wvTWVldGxlc3MuYXBwIiwKICAiYnVuZGxlUmVhbFBhdGgiIDogIlwvQXBwbGljYXRpb25zXC9NZWV0bGVzcy5hcHAiLAogICJjZEhhc2giIDogImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLAogICJjb25maWd1cmF0aW9uIiA6IHsKICAgICJpZGVudGl0eVBhdGgiIDogIlwvVXNlcnNcL2V4YW1wbGVcL0xpYnJhcnlcL0FwcGxpY2F0aW9uIFN1cHBvcnRcL01lZXRsZXNzXC9wYXNlby1ob21lXC9zZXJ2ZXItaWQiLAogICAgImxpc3RlbiIgOiAiMTI3LjAuMC4xOjE2Nzc3IiwKICAgICJub2RlUGF0aCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTWVldGxlc3MgXC8gc291cmNlXC9ydW50aW1lXC9ub2RlIiwKICAgICJyZW5kZXJlck9yaWdpbiIgOiAiaHR0cDpcL1wvMTI3LjAuMC4xOjE4MDgyXC9wYXRoXC9hXC9iIiwKICAgICJyZXBvc2l0b3J5Um9vdCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTWVldGxlc3MgXC8gc291cmNlIiwKICAgICJydW50aW1lQ2xpUGF0aCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTWVldGxlc3MgXC8gc291cmNlXC9wYWNrYWdlc1wvcnVudGltZVwvZGlzdFwvY2xpLmpzIiwKICAgICJydW50aW1lUm9vdCIgOiAiXC9Vc2Vyc1wvZXhhbXBsZVwvTGlicmFyeVwvQXBwbGljYXRpb24gU3VwcG9ydFwvTWVldGxlc3MiLAogICAgInRyYW5zY3JpcHRpb25Tb2NrZXQiIDogIlwvVXNlcnNcL2V4YW1wbGVcL0xpYnJhcnlcL0FwcGxpY2F0aW9uIFN1cHBvcnRcL01lZXRsZXNzXC90cmFuc2NyaXB0aW9uLnNvY2siLAogICAgInRyYW5zY3JpcHRpb25TdGFnaW5nIiA6ICJcL1VzZXJzXC9leGFtcGxlXC9MaWJyYXJ5XC9BcHBsaWNhdGlvbiBTdXBwb3J0XC9NZWV0bGVzc1wvbWVldGluZy1zdG9yZVwvdHJhbnNjcmlwdGlvbi1yYW5nZXMiCiAgfSwKICAiZGVzaWduYXRlZFJlcXVpcmVtZW50IiA6ICJpZGVudGlmaWVyIFwiY29tLm1lZXRsZXNzLmFwcFwiOiBwYXRoIFwiaHR0cHM6XC9cL2V4YW1wbGUudGVzdFwvYVwvYlwiIGxpdGVyYWwgbWFya2VyIiwKICAiZXhlY3V0YWJsZVBhdGgiIDogIlwvQXBwbGljYXRpb25zXC9NZWV0bGVzcy5hcHBcL0NvbnRlbnRzXC9NYWNPU1wvTWVldGxlc3NIb3N0IiwKICAidmVyc2lvbiIgOiAxCn0K"),
    "Swift Foundation JSONEncoder identity bytes must match the Node golden vector"
  )
  check(
    profileData == Data(base64Encoded: "ewogICJhcnJheSIgOiBbCiAgICAiYVwvYiIsCiAgICAicXVvdGVcIjogXC8gYW5kIFxcXFxiYWNrc2xhc2giLAogICAgMTcKICBdLAogICJlbXB0eUFycmF5IiA6IFsKCiAgXSwKICAiZW1wdHlPYmplY3QiIDogewoKICB9LAogICJlc2NhcGVkIiA6ICI8XC9zY3JpcHQ+IFwicXVvdGVkXCI6IHZhbHVlIFxcXFwgbmV3bGluZVxuIHNlcGFyYXRvcuKAqCIsCiAgIm5lc3RlZCIgOiB7CiAgICAiYSIgOiAiZmlyc3QiLAogICAgInoiIDogImxhc3QiCiAgfSwKICAibnVsbFZhbHVlIiA6IG51bGwKfQo="),
    "Swift Foundation JSONEncoder recursive bytes must match the Node golden vector"
  )
}

private func testStrictMasGateHostHandoffDecoding() throws {
  let root: [String: Any] = [
    "type": "directory", "mode": 448, "uid": 501, "gid": 20,
    "dev": 1, "ino": 2, "nlink": 2, "size": 0,
  ]
  let handoff: [String: Any] = [
    "schema": "MAS_GATE_HOST_HANDOFF v1", "version": 1,
    "ownerToken": "owner-token-abcdefghijklmnopqrstuvwxyz-0123456789", "runId": "run-1",
    "state": "available", "phase": "ready", "canonicalRuntimeRoot": "/runtime",
    "parentPath": "/parent", "activePath": "/active", "freshRootIdentity": root,
    "identityRelativePath": "server-id", "identityPath": "/runtime/server-id",
    "bundlePath": "/Applications/Meetless.app", "bundleRealPath": "/Applications/Meetless.app",
    "executablePath": "/Applications/Meetless.app/Contents/MacOS/MeetlessHost",
    "bundleIdentifier": "com.meetless.app", "designatedRequirement": "identifier com.meetless.app",
    "cdHash": String(repeating: "a", count: 40), "binarySha256": String(repeating: "b", count: 64),
    "binaryDevice": 1, "binaryInode": 3, "binarySize": 10,
    "claimedByPid": NSNull(), "claimedAt": NSNull(),
  ]
  let insertionOrder = try JSONSerialization.data(withJSONObject: handoff)
  let sorted = try JSONSerialization.data(withJSONObject: handoff, options: [.sortedKeys])
  let insertionDecoded = try decodeStrictMasGateHostHandoff(insertionOrder)
  let sortedDecoded = try decodeStrictMasGateHostHandoff(sorted)
  check(insertionDecoded.runId == "run-1", "native handoff decoder accepts insertion-order JSON")
  check(sortedDecoded.runId == "run-1", "native handoff decoder accepts sorted-key JSON")

  var extra = handoff
  extra["extra"] = true
  expectThrow("native handoff decoder rejects an extra outer key") {
    _ = try decodeStrictMasGateHostHandoff(JSONSerialization.data(withJSONObject: extra))
  }
  var missing = handoff
  missing.removeValue(forKey: "binarySize")
  expectThrow("native handoff decoder rejects a missing outer key") {
    _ = try decodeStrictMasGateHostHandoff(JSONSerialization.data(withJSONObject: missing))
  }
  var wrongType = handoff
  wrongType["binarySize"] = "10"
  expectThrow("native handoff decoder rejects a wrong field type") {
    _ = try decodeStrictMasGateHostHandoff(JSONSerialization.data(withJSONObject: wrongType))
  }
  var nestedExtra = root
  nestedExtra["extra"] = 1
  var invalidNested = handoff
  invalidNested["freshRootIdentity"] = nestedExtra
  expectThrow("native handoff decoder rejects an extra fresh-root identity key") {
    _ = try decodeStrictMasGateHostHandoff(JSONSerialization.data(withJSONObject: invalidNested))
  }
}

private func makeMasGateRootIdentity(
  type: String = "directory",
  mode: Int64 = 448,
  uid: Int64 = 501,
  gid: Int64 = 20,
  dev: Int64 = 1,
  ino: Int64 = 2,
  nlink: Int64 = 2,
  size: Int64 = 0
) -> MasGateRootIdentity {
  MasGateRootIdentity(type: type, mode: mode, uid: uid, gid: gid, dev: dev, ino: ino, nlink: nlink, size: size)
}

private func testMasGateArchivedRetainedRootDeviceAssurance() {
  let recorded = makeMasGateRootIdentity()
  let sameDevice = makeMasGateRootIdentity()
  let differentDevice = makeMasGateRootIdentity(dev: 2)

  check(
    sameMasGateArchivedRetainedRootIdentity(recorded, sameDevice),
    "archived retained-root comparison must accept the exact recorded root"
  )
  check(
    sameMasGateArchivedRetainedRootIdentity(recorded, differentDevice),
    "archived retained-root comparison must accept only a numeric device difference"
  )
  check(
    !sameMasGateStableRootIdentity(recorded, differentDevice),
    "active, ready, and handoff root comparison must retain exact device identity"
  )

  let nonDeviceDifferences: [(String, MasGateRootIdentity)] = [
    ("type", makeMasGateRootIdentity(type: "regular-file")),
    ("mode", makeMasGateRootIdentity(mode: 384)),
    ("owner", makeMasGateRootIdentity(uid: 502)),
    ("group", makeMasGateRootIdentity(gid: 21)),
    ("inode", makeMasGateRootIdentity(ino: 3)),
  ]
  for (label, changed) in nonDeviceDifferences {
    check(
      !sameMasGateArchivedRetainedRootIdentity(recorded, changed),
      "archived retained-root comparison must reject \(label) changes"
    )
  }
}

private func nativeProcessFixtureExecutable() throws -> String {
  try inspectMeetlessProcessIdentity(getpid()).configuredPath
}

private func fixtureHostIdentity() throws -> MeetlessHostIdentityAttestation {
  let identity = try inspectMeetlessProcessIdentity(getpid())
  return MeetlessHostIdentityAttestation(
    bundleIdentifier: "com.meetless.app",
    bundlePath: "/Applications/Meetless.app",
    bundleRealPath: "/Applications/Meetless.app",
    executablePath: identity.configuredPath,
    designatedRequirement: "fixture",
    cdHash: String(repeating: "a", count: 40),
    binarySha256: identity.sha256,
    binaryDevice: identity.device,
    binaryInode: identity.inode,
    binarySize: identity.byteLength
  )
}

private func requestNativeHostProcessProtocol(
  socketPath: String,
  request: [String: Any]
) throws -> [String: Any] {
  guard let data = try? JSONSerialization.data(withJSONObject: request),
        data.count < meetlessMaximumRequestLineBytes else {
    throw NSError(domain: "MeetlessHostTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "request exceeds the bounded frame"])
  }
  let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
  defer {
    shutdown(descriptor, SHUT_RDWR)
    close(descriptor)
  }
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(socketPath.utf8) + [0]
  guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
    throw NSError(domain: "MeetlessHostTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "socket path exceeds the Darwin limit"])
  }
  withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: pathBytes) }
  let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
  let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, addressLength) }
  }
  guard connected == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
  var framed = data
  framed.append(0x0a)
  try framed.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let written = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), raw.count - offset)
      guard written > 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
      offset += written
    }
  }
  guard let line = readBoundedLine(descriptor, maximumBytes: meetlessMaximumRequestLineBytes),
        let responseData = line.data(using: .utf8),
        let response = try JSONSerialization.jsonObject(with: responseData) as? [String: Any] else {
    throw NSError(domain: "MeetlessHostTests", code: 3, userInfo: [NSLocalizedDescriptionKey: "host process response is invalid"])
  }
  return response
}

private func writeNativeProcessFixturePID(_ root: String, role: String, pid: pid_t) {
  let path = URL(fileURLWithPath: root).appendingPathComponent("\(role).pid")
  try? Data(String(pid).utf8).write(to: path, options: .atomic)
}

private func runNativeProcessFixture(_ role: String) {
  let environment = ProcessInfo.processInfo.environment
  if role == "desktop",
     environment["MEETLESS_NATIVE_PROCESS_PROTOCOL_ONLY"] == "1",
     let socketPath = environment["MEETLESS_NATIVE_PROCESS_PROTOCOL_SOCKET"],
     let responsePath = environment["MEETLESS_NATIVE_PROCESS_PROTOCOL_RESPONSE"] {
    let request: [String: Any] = [
      "version": meetlessHostProcessProtocolVersion,
      "requestId": "transport-desktop-request",
      "operation": "desktopAttestation",
      "challenge": "transport-desktop-challenge",
    ]
    var response: [String: Any]?
    for attempt in 0..<200 {
      if let candidate = try? requestNativeHostProcessProtocol(socketPath: socketPath, request: request),
         candidate["ok"] as? Bool == true {
        response = candidate
        break
      }
      if attempt < 199 { usleep(25_000) }
    }
    if let response,
       let data = try? JSONSerialization.data(withJSONObject: response) {
      try? data.write(to: URL(fileURLWithPath: responsePath), options: .atomic)
    }
    if let diagnosticResponsePath = environment["MEETLESS_NATIVE_PROCESS_DIAGNOSTIC_RESPONSE"],
       let response,
       let generation = (response["generation"] as? NSNumber)?.uint64Value,
       var expectedIdentity = response["identity"] as? [String: Any],
       let childPID = (response["processPid"] as? NSNumber)?.int32Value {
      expectedIdentity["configuredPath"] = "/private/tmp/MEETLESS_SECRET_SENTINEL"
      expectedIdentity["realPath"] = "/private/tmp/MEETLESS_SECRET_SENTINEL"
      expectedIdentity["argv"] = ["/private/tmp/MEETLESS_SECRET_SENTINEL"]
      let diagnosticRequest: [String: Any] = [
        "version": meetlessHostProcessProtocolVersion,
        "requestId": "transport-diagnostic-registration",
        "operation": "registerChild",
        "generation": NSNumber(value: generation + 1),
        "ownerToken": "MEETLESS_SECRET_OWNER_SENTINEL",
        "registrationToken": "MEETLESS_SECRET_REGISTRATION_SENTINEL",
        "role": "daemon",
        "childPid": childPID,
        "expectedIdentity": expectedIdentity,
        "policy": [
          "runtimeRoot": "/private/tmp/MEETLESS_SECRET_RUNTIME_SENTINEL",
          "endpointPolicy": "MEETLESS_SECRET_POLICY_SENTINEL",
          "endpointWorkingDirectory": "runtime-root",
          "recordingEndpointName": "recording.sock",
          "transcriptionEndpointName": "transcription.sock",
        ],
      ]
      if let diagnosticResponse = try? requestNativeHostProcessProtocol(socketPath: socketPath, request: diagnosticRequest),
         let data = try? JSONSerialization.data(withJSONObject: diagnosticResponse) {
        try? data.write(to: URL(fileURLWithPath: diagnosticResponsePath), options: .atomic)
      }
    }
    while true { sleep(1) }
  }
  if role != "capture-helper",
     let root = environment["MEETLESS_NATIVE_FIXTURE_PID_ROOT"],
     let executable = try? nativeProcessFixtureExecutable(),
     let runtimeCli = environment["MEETLESS_NATIVE_FIXTURE_RUNTIME_CLI"],
     let workerPath = environment["MEETLESS_NATIVE_FIXTURE_WORKER_PATH"],
     let pluginPath = environment["MEETLESS_NATIVE_FIXTURE_PLUGIN_PATH"] {
    let childRole = role == "desktop"
      ? "daemon"
      : role == "daemon"
      ? "daemon-worker"
      : role == "daemon-worker"
      ? "plugin"
      : "capture-helper"
    let childArguments = childRole == "plugin"
      ? [pluginPath]
      : childRole == "daemon-worker"
      ? [workerPath, "daemon"]
      : childRole == "capture-helper"
      ? []
      : [runtimeCli, childRole]
    let child = Process()
    child.executableURL = URL(fileURLWithPath: executable)
    child.arguments = childArguments
    var childEnvironment = environment
    childEnvironment["MEETLESS_NATIVE_PROCESS_FIXTURE"] = childRole
    child.environment = childEnvironment
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    do {
      try child.run()
      writeNativeProcessFixturePID(root, role: childRole, pid: child.processIdentifier)
      child.waitUntilExit()
    } catch {
      exit(2)
    }
  }
  while true { sleep(1) }
}

private func readNativeProcessFixturePID(_ root: String, role: String) -> pid_t? {
  let path = URL(fileURLWithPath: root).appendingPathComponent("\(role).pid")
  guard let value = try? String(contentsOf: path).trimmingCharacters(in: .whitespacesAndNewlines),
        let pid = Int32(value),
        pid > 1 else { return nil }
  return pid
}

private func replacingProcessIdentity(
  _ identity: MeetlessProcessIdentity,
  configuredPath: String? = nil,
  realPath: String? = nil,
  device: Int? = nil,
  inode: Int? = nil,
  byteLength: Int? = nil,
  sha256: String? = nil,
  argv: [String]? = nil
) -> MeetlessProcessIdentity {
  MeetlessProcessIdentity(
    configuredPath: configuredPath ?? identity.configuredPath,
    realPath: realPath ?? identity.realPath,
    device: device ?? identity.device,
    inode: inode ?? identity.inode,
    byteLength: byteLength ?? identity.byteLength,
    sha256: sha256 ?? identity.sha256,
    argv: argv ?? identity.argv
  )
}

private func waitForNativeProcessFixturePID(_ root: String, role: String) -> pid_t? {
  let deadline = Date().addingTimeInterval(3)
  while Date() < deadline {
    if let pid = readNativeProcessFixturePID(root, role: role) { return pid }
    usleep(10_000)
  }
  return nil
}

private func terminateNativeProcessFixture(_ pid: pid_t?) {
  guard let pid, pid > 1 else { return }
  _ = kill(pid, SIGTERM)
  usleep(50_000)
  _ = kill(pid, SIGKILL)
}

private func waitForNativeProcessFixtureExit(_ pid: pid_t) {
  let deadline = Date().addingTimeInterval(2)
  while nativeProcessIsAlive(pid) && Date() < deadline { usleep(10_000) }
}

private func nativeProcessIsAlive(_ pid: pid_t) -> Bool {
  guard pid > 1 else { return false }
  if kill(pid, 0) == 0 { return true }
  return errno == EPERM
}

private func testNativeProcessProtocolTransport() throws {
  let root = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("meetless-process-transport-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let executable = try nativeProcessFixtureExecutable()
  let socketPath = root.appendingPathComponent("transcription.sock").path
  let runtimeCli = root.appendingPathComponent("runtime-cli.js").path
  let workerPath = root.appendingPathComponent("daemon-worker.js").path
  let pluginPath = root.appendingPathComponent("plugins/plugin-process.js").path
  let policy = MeetlessProcessRegistrationPolicy(
    runtimeRoot: root.path,
    endpointPolicy: meetlessRuntimeEndpointSchema,
    endpointWorkingDirectory: meetlessRuntimeEndpointWorkingDirectory,
    recordingEndpointName: "recording.sock",
    transcriptionEndpointName: "transcription.sock",
    nodePath: executable,
    runtimeCliPath: runtimeCli,
    daemonWorkerPath: workerPath,
    daemonWorkerArguments: [executable, workerPath, "daemon"],
    pluginPath: pluginPath,
    pluginArguments: [executable, pluginPath],
    captureHelperPath: executable
  )
  let hostIdentity = try fixtureHostIdentity()
  let state = RuntimeAuthorizationState()
  let capability = MeetlessTranscriptionCapability(
    socketPath: socketPath,
    stagingDirectory: root.appendingPathComponent("ranges").path,
    runtimeAuthorization: state,
    keychain: FakeKeychain(),
    processPolicy: policy,
    hostIdentity: hostIdentity,
    hostPID: getpid()
  )
  try capability.start()
  defer { capability.stop() }
  let responsePath = root.appendingPathComponent("desktop-attestation.json").path
  let diagnosticResponsePath = root.appendingPathComponent("registration-diagnostic.json").path
  var environment = ProcessInfo.processInfo.environment
  environment["MEETLESS_NATIVE_PROCESS_FIXTURE"] = "desktop"
  environment["MEETLESS_NATIVE_PROCESS_PROTOCOL_ONLY"] = "1"
  environment["MEETLESS_NATIVE_PROCESS_PROTOCOL_SOCKET"] = socketPath
  environment["MEETLESS_NATIVE_PROCESS_PROTOCOL_RESPONSE"] = responsePath
  environment["MEETLESS_NATIVE_PROCESS_DIAGNOSTIC_RESPONSE"] = diagnosticResponsePath
  let desktop = Process()
  desktop.executableURL = URL(fileURLWithPath: executable)
  desktop.arguments = [runtimeCli, "desktop"]
  desktop.environment = environment
  desktop.standardInput = FileHandle.nullDevice
  desktop.standardOutput = FileHandle.nullDevice
  desktop.standardError = FileHandle.nullDevice
  try desktop.run()
  defer { terminateNativeProcessFixture(desktop.processIdentifier) }
  state.publish(desktop.processIdentifier)
  let deadline = Date().addingTimeInterval(5)
  var response: [String: Any]?
  while Date() < deadline {
    if let data = try? Data(contentsOf: URL(fileURLWithPath: responsePath)),
       let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      response = decoded
      break
    }
    usleep(10_000)
  }
  guard let response else {
    check(false, "desktop attestation must cross the authenticated native capability socket")
    return
  }
  check(response["type"] as? String == "host.process.attestation", "transport desktop response must be a typed attestation")
  check(response["ok"] as? Bool == true, "transport desktop response must be successful")
  check((response["processPid"] as? NSNumber)?.int32Value == desktop.processIdentifier, "transport attestation must bind the socket peer PID")
  check(response["challenge"] as? String == "transport-desktop-challenge", "transport attestation must echo the exact challenge")
  check((response["ownerToken"] as? String)?.isEmpty == false, "transport attestation must issue a bounded owner token")
  let diagnosticDeadline = Date().addingTimeInterval(5)
  var diagnosticResponse: [String: Any]?
  while Date() < diagnosticDeadline {
    if let data = try? Data(contentsOf: URL(fileURLWithPath: diagnosticResponsePath)),
       let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      diagnosticResponse = decoded
      break
    }
    usleep(10_000)
  }
  check(
    diagnosticResponse?["ok"] as? Bool == false &&
      diagnosticResponse?["error"] as? String == "role=daemon;stage=authorization;check=stale-generation;os=none",
    "transport registration rejection must expose only its bounded categorical diagnostic"
  )
  if let diagnosticData = try? JSONSerialization.data(withJSONObject: diagnosticResponse ?? [:]),
     let diagnosticText = String(data: diagnosticData, encoding: .utf8) {
    for sentinel in ["MEETLESS_SECRET_SENTINEL", "MEETLESS_SECRET_OWNER_SENTINEL", "MEETLESS_SECRET_REGISTRATION_SENTINEL", "MEETLESS_SECRET_RUNTIME_SENTINEL", "MEETLESS_SECRET_POLICY_SENTINEL"] {
      check(!diagnosticText.contains(sentinel), "transport diagnostic must not expose sentinel \(sentinel)")
    }
  }
  let wrongPeer = try requestNativeHostProcessProtocol(
    socketPath: socketPath,
    request: [
      "version": meetlessHostProcessProtocolVersion,
      "requestId": "transport-wrong-peer",
      "operation": "desktopAttestation",
      "challenge": "transport-wrong-peer-challenge",
    ]
  )
  check(wrongPeer["ok"] as? Bool == false, "a different socket peer must be rejected before desktop attestation")
  capability.stop()
  waitForNativeProcessFixtureExit(desktop.processIdentifier)
  check(state.snapshot() == nil, "capability shutdown must release the launch generation")
}

private func nativeCaptureHelperExecutable() -> String {
  URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("macos-capture/.build/release/meetless-capture")
    .standardizedFileURL
    .path
}

private let packageBuilderNodeSourceEnvironment = "MEETLESS_TEST_PACKAGE_NODE_SOURCE"

private struct PackageBuilderNodeIdentity: Equatable {
  let path: String
  let device: UInt64
  let inode: UInt64
  let byteLength: Int
  let sha256: String
}

private func packageBuilderNodeError(_ message: String) -> NSError {
  NSError(
    domain: "MeetlessHostTests",
    code: 60,
    userInfo: [NSLocalizedDescriptionKey: "package-builder Node source \(message); run npm run build:native so scripts/build-native.mjs binds its process.execPath"]
  )
}

private func executableRegularFileIdentity(atPath path: String) throws -> PackageBuilderNodeIdentity {
  guard path.hasPrefix("/") else {
    throw packageBuilderNodeError("must be an absolute path")
  }
  let lexical = URL(fileURLWithPath: path).standardizedFileURL.path
  let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
  guard path == lexical, path == canonical else {
    throw packageBuilderNodeError("must be one canonical path without traversal or symlink indirection")
  }
  var information = stat()
  guard lstat(path, &information) == 0,
        (information.st_mode & S_IFMT) == S_IFREG,
        information.st_size > 0 else {
    throw packageBuilderNodeError("must identify one non-empty regular file")
  }
  guard access(path, X_OK) == 0 else {
    throw packageBuilderNodeError("must identify an executable regular file")
  }
  let bytes = try Data(contentsOf: URL(fileURLWithPath: path))
  return PackageBuilderNodeIdentity(
    path: path,
    device: UInt64(information.st_dev),
    inode: UInt64(information.st_ino),
    byteLength: bytes.count,
    sha256: fixtureSHA256(bytes)
  )
}

private func packageBuilderNodeSource(
  environment: [String: String],
  expectedIdentity: PackageBuilderNodeIdentity
) throws -> (URL, PackageBuilderNodeIdentity) {
  guard let path = environment[packageBuilderNodeSourceEnvironment], !path.isEmpty else {
    throw packageBuilderNodeError("is absent from \(packageBuilderNodeSourceEnvironment)")
  }
  let identity = try executableRegularFileIdentity(atPath: path)
  guard identity == expectedIdentity else {
    throw packageBuilderNodeError("does not match the Node process executing scripts/build-native.mjs")
  }
  return (URL(fileURLWithPath: identity.path), identity)
}

private func runningPackageBuilderNodeIdentity() throws -> PackageBuilderNodeIdentity {
  let parentIdentity = try inspectMeetlessProcessIdentity(getppid())
  let identity = try executableRegularFileIdentity(atPath: parentIdentity.realPath)
  guard identity.device == UInt64(parentIdentity.device),
        identity.inode == UInt64(parentIdentity.inode),
        identity.byteLength == parentIdentity.byteLength,
        identity.sha256 == parentIdentity.sha256 else {
    throw packageBuilderNodeError("does not match the live parent process executable identity")
  }
  return identity
}

private func expectPackageBuilderNodeFailure(
  _ expectedMessage: String,
  environment: [String: String],
  expectedIdentity: PackageBuilderNodeIdentity
) {
  do {
    _ = try packageBuilderNodeSource(environment: environment, expectedIdentity: expectedIdentity)
    check(false, "package-builder Node validation must reject \(expectedMessage)")
  } catch {
    check(
      error.localizedDescription.contains(expectedMessage),
      "package-builder Node validation must diagnose \(expectedMessage), got: \(error.localizedDescription)"
    )
  }
}

private func testPackageBuilderNodeSourceValidation(expectedIdentity: PackageBuilderNodeIdentity) throws {
  let fileManager = FileManager.default
  let root = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("meetless-package-node-validation-" + UUID().uuidString)
  try fileManager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  defer { try? fileManager.removeItem(at: root) }
  let nonExecutable = root.appendingPathComponent("node")
  try writeFixtureData(Data("not executable\n".utf8), to: nonExecutable, permissions: 0o600)
  let sourceURL = URL(fileURLWithPath: expectedIdentity.path)
  let sourceDirectory = sourceURL.deletingLastPathComponent()
  let nonCanonical = sourceDirectory.path + "/../" + sourceDirectory.lastPathComponent + "/" + sourceURL.lastPathComponent

  let valid = try packageBuilderNodeSource(
    environment: [packageBuilderNodeSourceEnvironment: expectedIdentity.path],
    expectedIdentity: expectedIdentity
  )
  check(valid.1 == expectedIdentity, "package-builder Node validation must accept the exact bound process.execPath identity")
  expectPackageBuilderNodeFailure("is absent", environment: [:], expectedIdentity: expectedIdentity)
  expectPackageBuilderNodeFailure(
    "must be an absolute path",
    environment: [packageBuilderNodeSourceEnvironment: "node"],
    expectedIdentity: expectedIdentity
  )
  expectPackageBuilderNodeFailure(
    "must be one canonical path",
    environment: [packageBuilderNodeSourceEnvironment: nonCanonical],
    expectedIdentity: expectedIdentity
  )
  expectPackageBuilderNodeFailure(
    "must identify an executable regular file",
    environment: [packageBuilderNodeSourceEnvironment: nonExecutable.path],
    expectedIdentity: expectedIdentity
  )
  expectPackageBuilderNodeFailure(
    "does not match the Node process",
    environment: [packageBuilderNodeSourceEnvironment: "/usr/bin/true"],
    expectedIdentity: expectedIdentity
  )
}

private func copyResolvedFixtureItem(from source: URL, to destination: URL) throws {
  let fileManager = FileManager.default
  try fileManager.createDirectory(
    at: destination.deletingLastPathComponent(),
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o755]
  )
  try fileManager.copyItem(at: source.resolvingSymlinksInPath(), to: destination)
}

private func linkFixtureItem(from source: URL, to destination: URL) throws {
  let fileManager = FileManager.default
  try fileManager.createDirectory(
    at: destination.deletingLastPathComponent(),
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o755]
  )
  try fileManager.createSymbolicLink(atPath: destination.path, withDestinationPath: source.path)
}

private func writeFixtureData(_ data: Data, to destination: URL, permissions: NSNumber = 0o600) throws {
  let fileManager = FileManager.default
  try fileManager.createDirectory(
    at: destination.deletingLastPathComponent(),
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o700]
  )
  try data.write(to: destination, options: .atomic)
  try fileManager.setAttributes([.posixPermissions: permissions], ofItemAtPath: destination.path)
}

private func fixtureSHA256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func waitForRealNodeDaemonRegistration(
  state: RuntimeAuthorizationState,
  timeout: TimeInterval = 10
) -> MeetlessProcessRegistrationStatus? {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    let snapshot = state.processRegistrationSnapshotForTesting()
    if let registeredDaemon = snapshot.first(where: { $0.role == "daemon" && $0.attested }),
       let identity = try? inspectMeetlessProcessIdentity(registeredDaemon.pid) {
      return MeetlessProcessRegistrationStatus(
        role: registeredDaemon.role,
        pid: registeredDaemon.pid,
        attested: registeredDaemon.attested,
        identity: MeetlessProcessIdentityWire(
          configuredPath: identity.configuredPath,
          realPath: identity.realPath,
          device: identity.device,
          inode: identity.inode,
          byteLength: identity.byteLength,
          sha256: identity.sha256,
          argv: identity.argv
        )
      )
    }
    usleep(25_000)
  }
  return nil
}

private func terminateDetachedNativeProcessFixture(_ pid: pid_t?) {
  guard let pid, pid > 1 else { return }
  _ = kill(-pid, SIGTERM)
  usleep(50_000)
  _ = kill(-pid, SIGKILL)
  terminateNativeProcessFixture(pid)
}

private func testRealNodeDetachedDaemonRegistration() throws {
  let fileManager = FileManager.default
  let expectedNodeIdentity = try runningPackageBuilderNodeIdentity()
  let (nodeSource, nodeSourceIdentity) = try packageBuilderNodeSource(
    environment: ProcessInfo.processInfo.environment,
    expectedIdentity: expectedNodeIdentity
  )
  let root = fileManager.homeDirectoryForCurrentUser
    .appendingPathComponent(".meetless-real-node-" + UUID().uuidString)
    .appendingPathComponent("meetless-real-node-" + UUID().uuidString)
  try fileManager.createDirectory(
    at: root,
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o700]
  )
  var desktop: Process?
  var daemonPID: pid_t?
  var capability: MeetlessTranscriptionCapability?
  defer {
    terminateDetachedNativeProcessFixture(daemonPID)
    if let desktop {
      terminateNativeProcessFixture(desktop.processIdentifier)
      if desktop.isRunning { desktop.waitUntilExit() }
    }
    capability?.stop()
    try? fileManager.removeItem(at: root)
  }

  let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .standardizedFileURL
  let packageRoot = root.appendingPathComponent("package")
  let home = root.appendingPathComponent("home")
  let runtimeRoot = home.appendingPathComponent("Library/Application Support/Meetless")
  let temporaryDirectory = root.appendingPathComponent("tmp")
  try fileManager.createDirectory(at: packageRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
  try fileManager.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  try fileManager.createDirectory(at: runtimeRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  try fileManager.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])

  let runtimeDist = packageRoot.appendingPathComponent("packages/runtime/dist")
  try copyResolvedFixtureItem(
    from: repositoryRoot.appendingPathComponent("packages/runtime/dist"),
    to: runtimeDist
  )
  try linkFixtureItem(
    from: repositoryRoot.appendingPathComponent("packages/meetless-plugin"),
    to: packageRoot.appendingPathComponent("packages/meetless-plugin")
  )
  try linkFixtureItem(
    from: repositoryRoot.appendingPathComponent("vendor/paseo"),
    to: packageRoot.appendingPathComponent("vendor/paseo")
  )
  try linkFixtureItem(
    from: repositoryRoot.appendingPathComponent("node_modules"),
    to: packageRoot.appendingPathComponent("node_modules")
  )

  let contractSource = repositoryRoot.appendingPathComponent("scripts/lib/macos-package-contract.json")
  let contractData = try Data(contentsOf: contractSource)
  guard let contract = try JSONSerialization.jsonObject(with: contractData) as? [String: Any],
        let packageContract = contract["package"] as? [String: Any],
        let contractResources = packageContract["resources"] as? [String: String] else {
    throw NSError(domain: "MeetlessHostTests", code: 62, userInfo: [NSLocalizedDescriptionKey: "the package contract resources are not a JSON object"])
  }
  let rendererRelative = contractResources["rendererRoot"]!
  let electronRelative = contractResources["electronBinary"]!
  let nodeRelative = contractResources["nodeBinary"]!
  let captureHelperRelative = contractResources["captureHelper"]!
  let ffmpegRelative = contractResources["ffmpeg"]!
  let ffprobeRelative = contractResources["ffprobe"]!
  try writeFixtureData(
    contractData,
    to: packageRoot.appendingPathComponent("installation-contract.json"),
    permissions: 0o644
  )

  let nodePath = packageRoot.appendingPathComponent(nodeRelative)
  try fileManager.createDirectory(
    at: nodePath.deletingLastPathComponent(),
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o755]
  )
  try fileManager.copyItem(at: nodeSource, to: nodePath)
  let copiedNodeIdentity = try executableRegularFileIdentity(atPath: nodePath.path)
  let stableNodeSourceIdentity = try executableRegularFileIdentity(atPath: nodeSource.path)
  guard stableNodeSourceIdentity == nodeSourceIdentity,
        copiedNodeIdentity.byteLength == nodeSourceIdentity.byteLength,
        copiedNodeIdentity.sha256 == nodeSourceIdentity.sha256 else {
    throw packageBuilderNodeError("bytes, size, or digest changed while copying to the package contract runtime/node destination")
  }
  let electronSource = repositoryRoot.appendingPathComponent("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
  let electronPath = packageRoot.appendingPathComponent(electronRelative)
  var electronIsDirectory = ObjCBool(false)
  let electronAvailable = fileManager.fileExists(atPath: electronSource.path, isDirectory: &electronIsDirectory) && !electronIsDirectory.boolValue
  try copyResolvedFixtureItem(
    from: electronAvailable ? electronSource : nodeSource,
    to: electronPath
  )
  let captureHelperSource = URL(fileURLWithPath: nativeCaptureHelperExecutable())
  let captureHelperPath = packageRoot.appendingPathComponent(captureHelperRelative)
  try copyResolvedFixtureItem(from: captureHelperSource, to: captureHelperPath)
  let rendererRoot = packageRoot.appendingPathComponent(rendererRelative)
  try fileManager.createDirectory(at: rendererRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
  try Data("<!doctype html><title>Meetless fixture</title>".utf8).write(to: rendererRoot.appendingPathComponent("index.html"))
  let mediaRoot = packageRoot.appendingPathComponent("runtime/media")
  try fileManager.createDirectory(at: mediaRoot.appendingPathComponent("bin"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
  try fileManager.createDirectory(at: mediaRoot.appendingPathComponent("lib"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
  try copyResolvedFixtureItem(
    from: URL(fileURLWithPath: "/usr/bin/true"),
    to: packageRoot.appendingPathComponent(ffmpegRelative)
  )
  try copyResolvedFixtureItem(
    from: URL(fileURLWithPath: "/usr/bin/true"),
    to: packageRoot.appendingPathComponent(ffprobeRelative)
  )

  let markerJSON = "{\"schema\":\"MEETLESS_MACOS_PACKAGE v2\",\"target\":\"macos-arm64\",\"bundleIdentifier\":\"com.meetless.app\",\"paseoCommit\":\"7618cda71e2836f9ba7e821286504841203cb745\",\"listen\":\"127.0.0.1:16777\",\"rendererOrigin\":\"http://127.0.0.1:18082\",\"installationContract\":\"installation-contract.json\",\"installationContractSha256\":\"" + fixtureSHA256(contractData) + "\",\"hostBundlePath\":\"/Applications/Meetless.app\",\"resources\":{\"rendererRoot\":\"" + rendererRelative + "\",\"electronBinary\":\"" + electronRelative + "\",\"nodeBinary\":\"" + nodeRelative + "\",\"captureHelper\":\"" + captureHelperRelative + "\",\"ffmpeg\":\"" + ffmpegRelative + "\",\"ffprobe\":\"" + ffprobeRelative + "\"}}\n"
  try writeFixtureData(
    Data(markerJSON.utf8),
    to: packageRoot.appendingPathComponent("meetless-package.json"),
    permissions: 0o644
  )

  let runtimeCliPath = packageRoot.appendingPathComponent("packages/runtime/dist/cli.js")
  let identityPath = runtimeRoot.appendingPathComponent("host-identity.json")
  let transcriptionSocket = runtimeRoot.appendingPathComponent("transcription.sock")
  let transcriptionStaging = runtimeRoot.appendingPathComponent("meeting-store/transcription-ranges")
  let daemonWorkerPath = packageRoot.appendingPathComponent("vendor/paseo/packages/server/dist/server/server/daemon-worker.js")
  let pluginPath = packageRoot.appendingPathComponent("vendor/paseo/packages/server/dist/server/server/plugins/plugin-process.js")
  let configuration: [String: Any] = [
    "repositoryRoot": packageRoot.path,
    "runtimeRoot": runtimeRoot.path,
    "listen": "127.0.0.1:16777",
    "rendererOrigin": "http://127.0.0.1:18082",
    "transcriptionSocket": transcriptionSocket.path,
    "transcriptionStaging": transcriptionStaging.path,
    "nodePath": nodePath.path,
    "runtimeCliPath": runtimeCliPath.path,
    "captureHelperPath": captureHelperPath.path,
    "identityPath": identityPath.path,
    "endpointPolicy": meetlessRuntimeEndpointSchema,
    "endpointWorkingDirectory": meetlessRuntimeEndpointWorkingDirectory,
    "recordingEndpointName": "paseo-home/recording-control.sock",
    "transcriptionEndpointName": "transcription.sock",
  ]
  let hostIdentity = try fixtureHostIdentity()
  let identityDocument: [String: Any] = [
    "version": 1,
    "bundleIdentifier": hostIdentity.bundleIdentifier,
    "bundlePath": hostIdentity.bundlePath,
    "bundleRealPath": hostIdentity.bundleRealPath,
    "executablePath": hostIdentity.executablePath,
    "designatedRequirement": hostIdentity.designatedRequirement,
    "cdHash": hostIdentity.cdHash,
    "binarySha256": hostIdentity.binarySha256,
    "binaryDevice": hostIdentity.binaryDevice,
    "binaryInode": hostIdentity.binaryInode,
    "binarySize": hostIdentity.binarySize,
    "configuration": configuration,
  ]
  try writeFixtureData(
    JSONSerialization.data(withJSONObject: identityDocument, options: [.prettyPrinted, .sortedKeys]),
    to: identityPath
  )

  let policy = MeetlessProcessRegistrationPolicy(
    runtimeRoot: runtimeRoot.path,
    endpointPolicy: meetlessRuntimeEndpointSchema,
    endpointWorkingDirectory: meetlessRuntimeEndpointWorkingDirectory,
    recordingEndpointName: "paseo-home/recording-control.sock",
    transcriptionEndpointName: "transcription.sock",
    nodePath: nodePath.path,
    runtimeCliPath: runtimeCliPath.path,
    daemonWorkerPath: daemonWorkerPath.path,
    daemonWorkerArguments: [nodePath.path, daemonWorkerPath.path, "daemon"],
    pluginPath: pluginPath.path,
    pluginArguments: [nodePath.path, pluginPath.path],
    captureHelperPath: captureHelperPath.path
  )
  let endpoint = try meetlessPackagedEndpoint(
    role: "transcription",
    name: "transcription.sock",
    runtimeRoot: runtimeRoot.path
  )
  let state = RuntimeAuthorizationState()
  let nativeCapability = MeetlessTranscriptionCapability(
    endpoint: endpoint,
    workingDirectory: runtimeRoot.path,
    stagingDirectory: transcriptionStaging.path,
    runtimeAuthorization: state,
    processPolicy: policy,
    hostIdentity: hostIdentity,
    hostPID: getpid()
  )
  capability = nativeCapability
  let previousDirectory = fileManager.currentDirectoryPath
  guard fileManager.changeCurrentDirectoryPath(runtimeRoot.path) else {
    throw NSError(domain: "MeetlessHostTests", code: 63, userInfo: [NSLocalizedDescriptionKey: "the real-node fixture could not enter its runtime root"])
  }
  defer { _ = fileManager.changeCurrentDirectoryPath(previousDirectory) }
  try nativeCapability.start()

  var childEnvironment: [String: String] = [
    "HOME": home.path,
    "TMPDIR": temporaryDirectory.path,
    "MEETLESS_LISTEN": "127.0.0.1:16777",
  ]
  for name in ["PATH", "LANG", "LC_ALL", "USER", "LOGNAME"] {
    if let value = ProcessInfo.processInfo.environment[name] { childEnvironment[name] = value }
  }
  let process = Process()
  process.executableURL = nodePath
  process.arguments = [runtimeCliPath.path, "desktop"]
  process.currentDirectoryURL = URL(fileURLWithPath: runtimeRoot.path)
  process.environment = childEnvironment
  process.standardInput = FileHandle.nullDevice
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  try process.run()
  desktop = process
  let desktopPID = process.processIdentifier
  state.publish(desktopPID)

  guard let daemonRegistration = waitForRealNodeDaemonRegistration(state: state) else {
    check(false, "actual packaged Node desktop must register and attest its detached daemon through native host protocol")
    return
  }
  daemonPID = daemonRegistration.pid
  let daemonIdentity = daemonRegistration.identity.identity
  check(daemonRegistration.attested, "actual packaged daemon registration must be native-attested")
  check(nativeProcessIsAlive(desktopPID), "actual packaged desktop must remain alive while its detached daemon is registered")
  check(liveParentPID(daemonRegistration.pid) == desktopPID, "actual packaged daemon must remain a direct child of the desktop despite detached process-group ownership")
  check(daemonIdentity.configuredPath == nodePath.path, "actual packaged daemon must use the package-contained Node executable")
  check(daemonIdentity.realPath == nodePath.path, "actual packaged daemon real path must remain the package-contained Node executable")
  check(daemonIdentity.argv == [nodePath.path, runtimeCliPath.path, "daemon"], "actual packaged daemon argv must match the exact packaged CLI identity")
  check(daemonIdentity.byteLength == copiedNodeIdentity.byteLength, "actual packaged daemon size must match the exact copied process.execPath bytes")
  check(daemonIdentity.sha256 == copiedNodeIdentity.sha256, "actual packaged daemon digest must match the exact copied process.execPath bytes")
  check(daemonIdentity.device > 0, "actual packaged daemon identity must report its device")
  check(daemonIdentity.inode > 0, "actual packaged daemon identity must report its inode")
  check(daemonIdentity.byteLength > 0, "actual packaged daemon identity must report its byte length")
  check(!daemonIdentity.sha256.isEmpty, "actual packaged daemon identity must report its binary digest")
}

private func captureHelperEnvironment(
  runtimeRoot: String,
  endpointName: String,
  generation: UInt64,
  registrationToken: String
) -> [String: String] {
  var environment = ProcessInfo.processInfo.environment
  environment["MEETLESS_RUNTIME_PACKAGED"] = "1"
  environment["MEETLESS_RUNTIME_ROOT"] = runtimeRoot
  environment["MEETLESS_HOST_PROCESS_ENDPOINT"] = endpointName
  environment["MEETLESS_HOST_PROCESS_GENERATION"] = String(generation)
  environment["MEETLESS_HOST_PROCESS_TOKEN"] = registrationToken
  environment["MEETLESS_HOST_PROCESS_ROLE"] = "capture-helper"
  environment.removeValue(forKey: "MEETLESS_CAPTURE_MODE")
  return environment
}

private func acceptCaptureProtocolClient(_ listener: Int32, timeoutMilliseconds: Int32) throws -> Int32 {
  var descriptor = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
  guard Darwin.poll(&descriptor, 1, timeoutMilliseconds) > 0 else {
    throw NSError(domain: "MeetlessHostTests", code: 40, userInfo: [NSLocalizedDescriptionKey: "capture helper did not reach the relative endpoint within the test bound"])
  }
  let client = Darwin.accept(listener, nil, nil)
  guard client >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
  var timeout = timeval(tv_sec: 2, tv_usec: 0)
  _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  _ = setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  return client
}

private func writeCaptureProtocolResponse(_ descriptor: Int32, object: [String: Any]) throws {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        data.count < meetlessMaximumRequestLineBytes else {
    throw NSError(domain: "MeetlessHostTests", code: 41, userInfo: [NSLocalizedDescriptionKey: "capture helper test response exceeds the bounded frame"])
  }
  var framed = data
  framed.append(0x0a)
  try framed.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let written = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), raw.count - offset)
      guard written > 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
      offset += written
    }
  }
}

private func runPackagedCaptureHelperExpectingFailure(
  executable: String,
  runtimeRoot: String,
  workingDirectory: String,
  endpointName: String
) throws -> Int32 {
  let helper = Process()
  helper.executableURL = URL(fileURLWithPath: executable)
  helper.arguments = []
  helper.currentDirectoryURL = URL(fileURLWithPath: workingDirectory)
  helper.environment = captureHelperEnvironment(
    runtimeRoot: runtimeRoot,
    endpointName: endpointName,
    generation: 1,
    registrationToken: "capture-helper-test-token"
  )
  helper.standardInput = FileHandle.nullDevice
  helper.standardOutput = FileHandle.nullDevice
  helper.standardError = FileHandle.nullDevice
  try helper.run()
  let deadline = Date().addingTimeInterval(3)
  while helper.isRunning && Date() < deadline { usleep(10_000) }
  guard !helper.isRunning else {
    terminateNativeProcessFixture(helper.processIdentifier)
    waitForNativeProcessFixtureExit(helper.processIdentifier)
    throw NSError(domain: "MeetlessHostTests", code: 42, userInfo: [NSLocalizedDescriptionKey: "invalid packaged capture helper context did not fail within the test bound"])
  }
  helper.waitUntilExit()
  return helper.terminationStatus
}

private func testPackagedCaptureHelperRelativeConnectAndRetryIDs() throws {
  let fileManager = FileManager.default
  let root = URL(fileURLWithPath: "/private/var/tmp").appendingPathComponent(
    "meetless-capture-relative-\(String(repeating: "long-root-segment-", count: 8))\(UUID().uuidString)"
  )
  let endpointName = "transcription.sock"
  let socketPath = root.appendingPathComponent(endpointName).path
  let executable = nativeCaptureHelperExecutable()
  guard fileManager.isExecutableFile(atPath: executable) else {
    throw NSError(domain: "MeetlessHostTests", code: 43, userInfo: [NSLocalizedDescriptionKey: "release meetless-capture executable is required for relative endpoint proof"])
  }
  try fileManager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  let previousDirectory = fileManager.currentDirectoryPath
  var listener: Int32 = -1
  var clients: [Int32] = []
  var helper: Process?
  defer {
    if let helper {
      terminateNativeProcessFixture(helper.processIdentifier)
      waitForNativeProcessFixtureExit(helper.processIdentifier)
    }
    clients.forEach {
      shutdown($0, SHUT_RDWR)
      close($0)
    }
    if listener >= 0 {
      shutdown(listener, SHUT_RDWR)
      close(listener)
    }
    unlink(socketPath)
    _ = fileManager.changeCurrentDirectoryPath(previousDirectory)
    try? fileManager.removeItem(at: root)
  }
  check(socketPath.utf8.count > meetlessDarwinUnixSocketPathBytes, "capture helper proof must use a canonical socket path beyond Darwin AF_UNIX")
  check(endpointName.utf8.count <= meetlessDarwinUnixSocketPathBytes, "capture helper proof must use a short relative endpoint name")
  guard fileManager.changeCurrentDirectoryPath(root.path) else {
    throw NSError(domain: "MeetlessHostTests", code: 44, userInfo: [NSLocalizedDescriptionKey: "capture helper test could not enter its long runtime root"])
  }
  listener = try openUnixListener(socketPath, bindPath: endpointName)
  guard fileManager.changeCurrentDirectoryPath(previousDirectory) else {
    throw NSError(domain: "MeetlessHostTests", code: 45, userInfo: [NSLocalizedDescriptionKey: "capture helper test could not restore its parent working directory"])
  }

  let process = Process()
  process.executableURL = URL(fileURLWithPath: executable)
  process.arguments = []
  process.currentDirectoryURL = URL(fileURLWithPath: root.path)
  process.environment = captureHelperEnvironment(
    runtimeRoot: root.path,
    endpointName: endpointName,
    generation: 27,
    registrationToken: "capture-helper-test-token"
  )
  let input = Pipe()
  process.standardInput = input
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  try process.run()
  helper = process

  let firstClient = try acceptCaptureProtocolClient(listener, timeoutMilliseconds: 5_000)
  clients.append(firstClient)
  guard let firstLine = readBoundedLine(firstClient, maximumBytes: meetlessMaximumRequestLineBytes),
        let firstData = firstLine.data(using: .utf8),
        let firstRequest = try JSONSerialization.jsonObject(with: firstData) as? [String: Any],
        let firstRequestId = firstRequest["requestId"] as? String else {
    throw NSError(domain: "MeetlessHostTests", code: 46, userInfo: [NSLocalizedDescriptionKey: "capture helper pre-registration request was not a bounded JSON object"])
  }
  check(firstRequest["operation"] as? String == "processAttestation", "capture helper must request process attestation over the relative endpoint")
  check(firstRequest["role"] as? String == "capture-helper", "capture helper must preserve its typed process role")
  check((firstRequest["generation"] as? NSNumber)?.uint64Value == 27, "capture helper must preserve its launch generation on retry")
  check(!firstRequestId.isEmpty && firstRequestId.utf8.count <= 4_096, "capture helper pre-registration request ID must be fresh and bounded")
  // This disposable listener models the native capability's pre-registration
  // rejection; the state-chain test separately proves native ID consumption.
  try writeCaptureProtocolResponse(firstClient, object: [
    "version": meetlessHostProcessProtocolVersion,
    "type": "host.process.attestation",
    "requestId": firstRequestId,
    "ok": false,
    "role": "capture-helper",
    "processPid": process.processIdentifier,
    "generation": 27,
    "error": "registered process attestation failed closed",
  ])

  let secondClient = try acceptCaptureProtocolClient(listener, timeoutMilliseconds: 5_000)
  clients.append(secondClient)
  guard let secondLine = readBoundedLine(secondClient, maximumBytes: meetlessMaximumRequestLineBytes),
        let secondData = secondLine.data(using: .utf8),
        let secondRequest = try JSONSerialization.jsonObject(with: secondData) as? [String: Any],
        let secondRequestId = secondRequest["requestId"] as? String else {
    throw NSError(domain: "MeetlessHostTests", code: 47, userInfo: [NSLocalizedDescriptionKey: "capture helper retry request was not a bounded JSON object"])
  }
  check(secondRequestId != firstRequestId, "capture helper retry must use a fresh request ID after pre-registration rejection")
  check(secondRequest["operation"] as? String == "processAttestation", "capture helper retry must remain process attestation")
  check((secondRequest["generation"] as? NSNumber)?.uint64Value == 27, "capture helper retry must preserve its launch generation")
  try writeCaptureProtocolResponse(secondClient, object: [
    "version": meetlessHostProcessProtocolVersion,
    "type": "host.process.attestation",
    "requestId": secondRequestId,
    "ok": true,
    "role": "capture-helper",
    "processPid": process.processIdentifier,
    "generation": 27,
    "identity": [
      "configuredPath": executable,
      "realPath": executable,
      "sha256": String(repeating: "a", count: 64),
      "argv": [executable],
    ],
    "host": ["bundleIdentifier": "com.meetless.app"],
  ])
  usleep(50_000)
  check(process.isRunning, "capture helper must remain alive after successful native attestation")
  _ = input

  let wrongCWDStatus = try runPackagedCaptureHelperExpectingFailure(
    executable: executable,
    runtimeRoot: root.path,
    workingDirectory: root.deletingLastPathComponent().path,
    endpointName: endpointName
  )
  check(wrongCWDStatus != 0, "capture helper must reject a working directory different from runtimeRoot")
  for malformedEndpoint in ["", "/private/var/tmp/absolute.sock", "../transcription.sock", "nested/../../transcription.sock"] {
    let status = try runPackagedCaptureHelperExpectingFailure(
      executable: executable,
      runtimeRoot: root.path,
      workingDirectory: root.path,
      endpointName: malformedEndpoint
    )
    check(status != 0, "capture helper must reject malformed endpoint \(malformedEndpoint.debugDescription)")
  }
}

private final class NativeRegistrationDiagnosticFixture {
  let root: URL
  let executable: URL
  let desktop: Process
  let state: RuntimeAuthorizationState
  let desktopAttestation: MeetlessDesktopAttestationResult
  let daemonPID: pid_t
  let workerPID: pid_t
  let pluginPID: pid_t
  let helperPID: pid_t

  private init(
    root: URL,
    executable: URL,
    desktop: Process,
    state: RuntimeAuthorizationState,
    desktopAttestation: MeetlessDesktopAttestationResult,
    daemonPID: pid_t,
    workerPID: pid_t,
    pluginPID: pid_t,
    helperPID: pid_t
  ) {
    self.root = root
    self.executable = executable
    self.desktop = desktop
    self.state = state
    self.desktopAttestation = desktopAttestation
    self.daemonPID = daemonPID
    self.workerPID = workerPID
    self.pluginPID = pluginPID
    self.helperPID = helperPID
  }

  static func make() throws -> NativeRegistrationDiagnosticFixture {
    let fileManager = FileManager.default
    let source = try nativeProcessFixtureExecutable()
    let root = URL(fileURLWithPath: source)
      .deletingLastPathComponent()
      .appendingPathComponent("meetless-registration-diagnostic-\(UUID().uuidString)")
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let executable = root.appendingPathComponent("fixture-host")
    var desktop: Process?
    var completed = false
    defer {
      if !completed {
        let helperPID = readNativeProcessFixturePID(root.path, role: "capture-helper")
        let pluginPID = readNativeProcessFixturePID(root.path, role: "plugin")
        let workerPID = readNativeProcessFixturePID(root.path, role: "daemon-worker")
        let daemonPID = readNativeProcessFixturePID(root.path, role: "daemon")
        terminateNativeProcessFixture(helperPID)
        terminateNativeProcessFixture(pluginPID)
        terminateNativeProcessFixture(workerPID)
        terminateNativeProcessFixture(daemonPID)
        if let desktop {
          terminateNativeProcessFixture(desktop.processIdentifier)
          if desktop.isRunning { desktop.waitUntilExit() }
        }
        try? fileManager.removeItem(at: root)
      }
    }

    try fileManager.copyItem(at: URL(fileURLWithPath: source), to: executable)
    let runtimeCli = root.appendingPathComponent("runtime-cli.js").path
    let workerPath = root.appendingPathComponent("daemon-worker.js").path
    let pluginPath = root.appendingPathComponent("plugins/plugin-process.js").path
    let policy = MeetlessProcessRegistrationPolicy(
      runtimeRoot: root.path,
      endpointPolicy: meetlessRuntimeEndpointSchema,
      endpointWorkingDirectory: meetlessRuntimeEndpointWorkingDirectory,
      recordingEndpointName: "recording.sock",
      transcriptionEndpointName: "transcription.sock",
      nodePath: executable.path,
      runtimeCliPath: runtimeCli,
      daemonWorkerPath: workerPath,
      daemonWorkerArguments: [executable.path, workerPath, "daemon"],
      pluginPath: pluginPath,
      pluginArguments: [executable.path, pluginPath],
      captureHelperPath: executable.path
    )
    let wirePolicy = MeetlessHostProcessPolicyWire(
      runtimeRoot: policy.runtimeRoot,
      endpointPolicy: policy.endpointPolicy,
      endpointWorkingDirectory: policy.endpointWorkingDirectory,
      recordingEndpointName: policy.recordingEndpointName,
      transcriptionEndpointName: policy.transcriptionEndpointName
    )
    var environment = ProcessInfo.processInfo.environment
    environment["MEETLESS_NATIVE_PROCESS_FIXTURE"] = "desktop"
    environment["MEETLESS_NATIVE_FIXTURE_PID_ROOT"] = root.path
    environment["MEETLESS_NATIVE_FIXTURE_RUNTIME_CLI"] = runtimeCli
    environment["MEETLESS_NATIVE_FIXTURE_WORKER_PATH"] = workerPath
    environment["MEETLESS_NATIVE_FIXTURE_PLUGIN_PATH"] = pluginPath
    let process = Process()
    process.executableURL = executable
    process.arguments = [runtimeCli, "desktop"]
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    desktop = process

    let state = RuntimeAuthorizationState()
    state.configure(processPolicy: policy, hostIdentity: try fixtureHostIdentity(), hostPID: getpid())
    state.publish(process.processIdentifier)
    guard let desktopAttestation = state.attestDesktop(
      peerPID: process.processIdentifier,
      requestId: "diagnostic-fixture-desktop",
      challenge: "diagnostic-fixture-challenge"
    ) else {
      throw NSError(
        domain: "MeetlessHostTests",
        code: 70,
        userInfo: [NSLocalizedDescriptionKey: "diagnostic fixture desktop attestation failed"]
      )
    }
    guard let daemonPID = waitForNativeProcessFixturePID(root.path, role: "daemon"),
          let daemonIdentity = try? inspectMeetlessProcessIdentity(daemonPID),
          let workerPID = waitForNativeProcessFixturePID(root.path, role: "daemon-worker"),
          let pluginPID = waitForNativeProcessFixturePID(root.path, role: "plugin"),
          let helperPID = waitForNativeProcessFixturePID(root.path, role: "capture-helper"),
          let pluginIdentity = try? inspectMeetlessProcessIdentity(pluginPID),
          let helperIdentity = try? inspectMeetlessProcessIdentity(helperPID) else {
      throw NSError(domain: "MeetlessHostTests", code: 71, userInfo: [NSLocalizedDescriptionKey: "diagnostic fixture process chain was not inspectable"])
    }
    let daemonToken = "diagnostic-fixture-daemon-token"
    guard state.registerChild(
      peerPID: process.processIdentifier,
      requestId: "diagnostic-fixture-daemon-registration",
      generation: desktopAttestation.generation,
      ownerToken: desktopAttestation.ownerToken,
      registrationToken: daemonToken,
      role: "daemon",
      childPID: daemonPID,
      expectedIdentity: daemonIdentity,
      policy: wirePolicy
    ) != nil,
    state.attestRegisteredProcess(
      peerPID: daemonPID,
      requestId: "diagnostic-fixture-daemon-attestation",
      generation: desktopAttestation.generation,
      registrationToken: daemonToken,
      role: "daemon"
    ) != nil else {
      throw NSError(domain: "MeetlessHostTests", code: 72, userInfo: [NSLocalizedDescriptionKey: "diagnostic fixture daemon registration failed"])
    }
    let pluginToken = "diagnostic-fixture-plugin-token"
    guard state.registerChild(
      peerPID: pluginPID,
      requestId: "diagnostic-fixture-plugin-registration",
      generation: desktopAttestation.generation,
      ownerToken: daemonToken,
      registrationToken: pluginToken,
      role: "plugin",
      childPID: pluginPID,
      expectedIdentity: pluginIdentity,
      policy: wirePolicy
    ) != nil,
    state.attestRegisteredProcess(
      peerPID: pluginPID,
      requestId: "diagnostic-fixture-plugin-attestation",
      generation: desktopAttestation.generation,
      registrationToken: pluginToken,
      role: "plugin"
    ) != nil,
    state.registerChild(
      peerPID: pluginPID,
      requestId: "diagnostic-fixture-helper-registration",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      registrationToken: "diagnostic-fixture-helper-token",
      role: "capture-helper",
      childPID: helperPID,
      expectedIdentity: helperIdentity,
      policy: wirePolicy
    ) != nil else {
      throw NSError(domain: "MeetlessHostTests", code: 73, userInfo: [NSLocalizedDescriptionKey: "diagnostic fixture descendant registration failed"])
    }
    let fixture = NativeRegistrationDiagnosticFixture(
      root: root,
      executable: executable,
      desktop: process,
      state: state,
      desktopAttestation: desktopAttestation,
      daemonPID: daemonPID,
      workerPID: workerPID,
      pluginPID: pluginPID,
      helperPID: helperPID
    )
    completed = true
    return fixture
  }

  deinit {
    terminateNativeProcessFixture(helperPID)
    terminateNativeProcessFixture(pluginPID)
    terminateNativeProcessFixture(workerPID)
    terminateNativeProcessFixture(daemonPID)
    terminateNativeProcessFixture(desktop.processIdentifier)
    if desktop.isRunning { desktop.waitUntilExit() }
    try? FileManager.default.removeItem(at: root)
  }
}

private func testCommittedRegistrationIdentityAndInspectionDiagnostics() throws {
  do {
    let fixture = try NativeRegistrationDiagnosticFixture.make()
    let sink = RecordingRegistrationDiagnosticSink()
    fixture.state.setRegistrationDiagnosticSink(sink)
    let replacement = fixture.root.appendingPathComponent("fixture-host-replacement")
    try FileManager.default.copyItem(at: fixture.executable, to: replacement)
    try FileManager.default.removeItem(at: fixture.executable)
    try FileManager.default.moveItem(at: replacement, to: fixture.executable)
    check(sink.snapshot().isEmpty, "identity drift must not emit a removal event before prune commits")
    check(
      fixture.state.processRegistrationSnapshotForTesting().count == 3,
      "identity drift must leave the accepted registration chain intact until prune commits"
    )
    check(fixture.state.pruneDeadRegistrations(), "identity drift prune must complete")
    let events = sink.snapshot().filter { $0.action == .prune }
    check(
      events.contains {
        $0.role == .daemon &&
          $0.pid == fixture.daemonPID &&
          $0.stage == .inspection &&
          $0.check == .childIdentityMismatch &&
          $0.osCode == .none
      },
      "committed executable identity drift must retain the daemon child-identity predicate"
    )
    check(
      fixture.state.processRegistrationSnapshotForTesting().isEmpty,
      "identity drift must preserve recursive registration invalidation"
    )
  }

  do {
    let fixture = try NativeRegistrationDiagnosticFixture.make()
    let sink = RecordingRegistrationDiagnosticSink()
    fixture.state.setRegistrationDiagnosticSink(sink)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o000],
      ofItemAtPath: fixture.executable.path
    )
    check(fixture.state.pruneDeadRegistrations(), "inspection-unavailable prune must complete")
    let events = sink.snapshot().filter { $0.action == .prune }
    check(
      events.contains {
        $0.role == .daemon &&
          $0.pid == fixture.daemonPID &&
          $0.stage == .inspection &&
          $0.check == .processInspectionUnavailable &&
          $0.osCode == .unknown
      },
      "committed metadata inspection failure must retain process-inspection-unavailable"
    )
    check(
      fixture.state.processRegistrationSnapshotForTesting().isEmpty,
      "inspection failure must preserve recursive registration invalidation"
    )
  }
}

private func testStalePruneDoesNotEmitUncommittedRemoval() throws {
  let fixture = try NativeRegistrationDiagnosticFixture.make()
  let sink = RecordingRegistrationDiagnosticSink()
  fixture.state.setRegistrationDiagnosticSink(sink)
  fixture.state.setPruneInspectionHook {
    fixture.state.clear(expected: fixture.desktop.processIdentifier)
  }
  check(fixture.state.pruneDeadRegistrations(), "stale prune inspection must complete after the state reset")
  let events = sink.snapshot()
  check(
    !events.contains(where: { $0.action == .prune }),
    "a stale prune snapshot must not emit an uncommitted removal event"
  )
  check(
    events.contains {
      $0.action == .reset &&
        $0.role == .daemon &&
        $0.stage == .lifecycle &&
        $0.check == .stateReset
    },
    "a committed state reset must be distinguished from registration pruning"
  )
  check(
    fixture.state.processRegistrationSnapshotForTesting().isEmpty,
    "a committed state reset must remove the registration snapshot"
  )
}

private func testLifecycleCancellationPrecedesDiagnosticSink() throws {
  do {
    let fixture = try NativeRegistrationDiagnosticFixture.make()
    guard let lease = fixture.state.issueLease(
      peerPID: fixture.pluginPID,
      authorizer: RuntimePeerAuthorizer(),
      requireRegistered: true
    ), let execution = fixture.state.beginExecution(lease) else {
      throw NSError(domain: "MeetlessHostTests", code: 74, userInfo: [NSLocalizedDescriptionKey: "publish cancellation fixture could not begin an active execution"])
    }
    defer { fixture.state.finishExecution(execution) }
    let sink = CancellationOrderingDiagnosticSink(cancellation: execution.cancellation)
    fixture.state.setRegistrationDiagnosticSink(sink)
    let finished = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      fixture.state.publish(fixture.desktop.processIdentifier)
      finished.signal()
    }
    check(sink.waitUntilRecording(), "publish must reach the diagnostic sink in the cancellation-ordering regression")
    check(
      sink.didObserveCancellation,
      "publish must cancel active executions before potentially blocking diagnostic sink work"
    )
    sink.unblock()
    check(
      finished.wait(timeout: .now() + .seconds(2)) == .success,
      "publish must complete after the controlled diagnostic sink stall is released"
    )
    check(sink.eventCount > 0, "publish cancellation regression must retain its reset event snapshot")
  }

  do {
    let fixture = try NativeRegistrationDiagnosticFixture.make()
    guard let lease = fixture.state.issueLease(
      peerPID: fixture.pluginPID,
      authorizer: RuntimePeerAuthorizer(),
      requireRegistered: true
    ), let execution = fixture.state.beginExecution(lease) else {
      throw NSError(domain: "MeetlessHostTests", code: 75, userInfo: [NSLocalizedDescriptionKey: "clear cancellation fixture could not begin an active execution"])
    }
    defer { fixture.state.finishExecution(execution) }
    let sink = CancellationOrderingDiagnosticSink(cancellation: execution.cancellation)
    fixture.state.setRegistrationDiagnosticSink(sink)
    let finished = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      fixture.state.clear(expected: fixture.desktop.processIdentifier)
      finished.signal()
    }
    check(sink.waitUntilRecording(), "clear must reach the diagnostic sink in the cancellation-ordering regression")
    check(
      sink.didObserveCancellation,
      "clear must cancel active executions before potentially blocking diagnostic sink work"
    )
    sink.unblock()
    check(
      finished.wait(timeout: .now() + .seconds(2)) == .success,
      "clear must complete after the controlled diagnostic sink stall is released"
    )
    check(sink.eventCount > 0, "clear cancellation regression must retain its reset event snapshot")
  }
}

private func testRegistrationDiagnosticProductionWiring() throws {
  let fixture = try NativeRegistrationDiagnosticFixture.make()
  let logs = fixture.root.appendingPathComponent("logs")
  let logURL = logs.appendingPathComponent("host-runtime.log")
  let fileManager = FileManager.default
  try fileManager.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  fileManager.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
  let hostLog = try FileHandle(forWritingTo: logURL)
  defer { try? hostLog.close() }
  try hostLog.seekToEnd()
  guard let sink = attachMeetlessProcessRegistrationDiagnosticSink(
    to: fixture.state,
    duplicating: hostLog
  ) else {
    check(false, "the production host-runtime log path must install a registration diagnostic sink")
    return
  }
  terminateNativeProcessFixture(fixture.daemonPID)
  waitForNativeProcessFixtureExit(fixture.daemonPID)
  guard let status = fixture.state.registrationStatus(
    peerPID: fixture.desktop.processIdentifier,
    requestId: "production-diagnostic-status",
    generation: fixture.desktopAttestation.generation,
    ownerToken: fixture.desktopAttestation.ownerToken
  ) else {
    check(false, "production diagnostic wiring must preserve the successful empty status response after prune")
    return
  }
  check(status.isEmpty, "production diagnostic prune must preserve recursive daemon registration removal")
  let retained = try String(contentsOf: logURL, encoding: .utf8)
  check(
    retained.contains("registration-removal action=prune role=daemon stage=inspection check=process-gone"),
    "the exact host-runtime log sink must retain the committed daemon process-gone event"
  )
  check(
    retained.split(separator: "\n").allSatisfy { $0.utf8.count + 1 <= meetlessMaximumRegistrationDiagnosticLineBytes },
    "production retained registration diagnostics must remain line-bounded"
  )
  for secret in ["/private/hostile/path", "ownerToken=secret", "credential=secret", "raw-error"] {
    check(!retained.contains(secret), "production retained diagnostics must not expose (secret)")
  }
  _ = sink
}

private func testPackagedProcessRegistrationChain() throws {
  let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("meetless-process-chain-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let executable = try nativeProcessFixtureExecutable()
  let runtimeCli = root.appendingPathComponent("runtime-cli.js").path
  let workerPath = root.appendingPathComponent("daemon-worker.js").path
  let pluginPath = root.appendingPathComponent("plugins/plugin-process.js").path
  let policy = MeetlessProcessRegistrationPolicy(
    runtimeRoot: root.path,
    endpointPolicy: meetlessRuntimeEndpointSchema,
    endpointWorkingDirectory: meetlessRuntimeEndpointWorkingDirectory,
    recordingEndpointName: "recording.sock",
    transcriptionEndpointName: "transcription.sock",
    nodePath: executable,
    runtimeCliPath: runtimeCli,
    daemonWorkerPath: workerPath,
    daemonWorkerArguments: [executable, workerPath, "daemon"],
    pluginPath: pluginPath,
    pluginArguments: [executable, pluginPath],
    captureHelperPath: executable
  )
  let wirePolicy = MeetlessHostProcessPolicyWire(
    runtimeRoot: policy.runtimeRoot,
    endpointPolicy: policy.endpointPolicy,
    endpointWorkingDirectory: policy.endpointWorkingDirectory,
    recordingEndpointName: policy.recordingEndpointName,
    transcriptionEndpointName: policy.transcriptionEndpointName
  )
  let hostIdentity = try fixtureHostIdentity()
  let environmentRoot = root.path
  var environment = ProcessInfo.processInfo.environment
  environment["MEETLESS_NATIVE_PROCESS_FIXTURE"] = "desktop"
  environment["MEETLESS_NATIVE_FIXTURE_PID_ROOT"] = environmentRoot
  environment["MEETLESS_NATIVE_FIXTURE_RUNTIME_CLI"] = runtimeCli
  environment["MEETLESS_NATIVE_FIXTURE_WORKER_PATH"] = workerPath
  environment["MEETLESS_NATIVE_FIXTURE_PLUGIN_PATH"] = pluginPath
  let desktop = Process()
  desktop.executableURL = URL(fileURLWithPath: executable)
  desktop.arguments = [runtimeCli, "desktop"]
  desktop.environment = environment
  desktop.standardInput = FileHandle.nullDevice
  desktop.standardOutput = FileHandle.nullDevice
  desktop.standardError = FileHandle.nullDevice
  try desktop.run()
  defer {
    let helperPID = readNativeProcessFixturePID(environmentRoot, role: "capture-helper")
    let pluginPID = readNativeProcessFixturePID(environmentRoot, role: "plugin")
    let workerPID = readNativeProcessFixturePID(environmentRoot, role: "daemon-worker")
    let daemonPID = readNativeProcessFixturePID(environmentRoot, role: "daemon")
    terminateNativeProcessFixture(helperPID)
    terminateNativeProcessFixture(pluginPID)
    terminateNativeProcessFixture(workerPID)
    terminateNativeProcessFixture(daemonPID)
    terminateNativeProcessFixture(desktop.processIdentifier)
  }
  let desktopPID = desktop.processIdentifier
  let state = RuntimeAuthorizationState()
  let registrationDiagnosticSink = RecordingRegistrationDiagnosticSink()
  state.setRegistrationDiagnosticSink(registrationDiagnosticSink)
  state.configure(processPolicy: policy, hostIdentity: hostIdentity, hostPID: getpid())
  state.publish(desktopPID)
  guard let desktopAttestation = state.attestDesktop(peerPID: desktopPID, requestId: "desktop-request", challenge: "desktop-challenge") else {
    check(false, "packaged desktop must complete the exact challenge-bound attestation")
    return
  }
  check(
    state.attestDesktop(peerPID: desktopPID, requestId: "desktop-replay", challenge: "desktop-challenge") == nil,
    "desktop attestation challenge replay must be rejected"
  )
  guard let daemonPID = waitForNativeProcessFixturePID(environmentRoot, role: "daemon"),
        let daemonIdentity = try? inspectMeetlessProcessIdentity(daemonPID) else {
    check(false, "desktop fixture must spawn a daemon child with inspectable identity")
    return
  }
  guard let workerPID = waitForNativeProcessFixturePID(environmentRoot, role: "daemon-worker"),
        let workerIdentity = try? inspectMeetlessProcessIdentity(workerPID) else {
    check(false, "daemon fixture must spawn the pinned worker intermediate with inspectable identity")
    return
  }
  check(liveParentPID(workerPID) == daemonPID, "daemon worker must remain a direct daemon child")
  check(workerIdentity.configuredPath == executable, "daemon worker executable identity must match the node path")
  check(workerIdentity.argv == [executable, workerPath, "daemon"], "daemon worker argv must match the pinned worker entrypoint")
  let diagnosticParentState = RuntimeAuthorizationState()
  diagnosticParentState.configure(processPolicy: policy, hostIdentity: hostIdentity, hostPID: getpid())
  diagnosticParentState.publish(desktopPID)
  guard let diagnosticDesktop = diagnosticParentState.attestDesktop(
    peerPID: desktopPID,
    requestId: "diagnostic-desktop",
    challenge: "diagnostic-challenge"
  ) else {
    check(false, "diagnostic state must attest the existing desktop before classifying child registration failures")
    return
  }
  let diagnosticWirePolicy = wirePolicy
  let diagnosticParentFailure = diagnosticFailure(diagnosticParentState.registerChildDiagnosed(
    peerPID: desktopPID,
    requestId: "diagnostic-parent-mismatch",
    generation: diagnosticDesktop.generation,
    ownerToken: diagnosticDesktop.ownerToken,
    registrationToken: "diagnostic-parent-token",
    role: "daemon",
    childPID: workerPID,
    expectedIdentity: daemonIdentity,
    policy: diagnosticWirePolicy
  ))
  check(
    diagnosticParentFailure == MeetlessProcessRegistrationFailure(
      role: .daemon,
      stage: .inspection,
      check: .parentMismatch,
      osCode: .none
    ),
    "registration diagnostics must classify a non-direct child as a parent mismatch"
  )
  let diagnosticInspectionFailure = diagnosticFailure(diagnosticParentState.registerChildDiagnosed(
    peerPID: desktopPID,
    requestId: "diagnostic-process-inspection",
    generation: diagnosticDesktop.generation,
    ownerToken: diagnosticDesktop.ownerToken,
    registrationToken: "diagnostic-process-token",
    role: "daemon",
    childPID: Int32.max,
    expectedIdentity: daemonIdentity,
    policy: diagnosticWirePolicy
  ))
  check(
    diagnosticInspectionFailure?.check == .processInspectionUnavailable &&
      (diagnosticInspectionFailure?.osCode == .esrch || diagnosticInspectionFailure?.osCode == .unknown),
    "registration diagnostics must classify unavailable process inspection with a normalized OS code"
  )
  check(meetlessNormalizedOSCode(EPERM) == .eperm, "registration diagnostics must normalize EPERM without exposing raw OS text")
  var daemonToken = "daemon-registration-token"
  func registerDaemon(
    requestId: String,
    generation: UInt64? = nil,
    peerPID: pid_t? = nil,
    ownerToken: String? = nil,
    role: String = "daemon",
    childPID: pid_t? = nil,
    expectedIdentity: MeetlessProcessIdentity? = nil,
    policy: MeetlessHostProcessPolicyWire? = nil
  ) -> Bool {
    state.registerChild(
      peerPID: peerPID ?? desktopPID,
      requestId: requestId,
      generation: generation ?? desktopAttestation.generation,
      ownerToken: ownerToken ?? desktopAttestation.ownerToken,
      registrationToken: daemonToken,
      role: role,
      childPID: childPID ?? daemonPID,
      expectedIdentity: expectedIdentity ?? daemonIdentity,
      policy: policy ?? wirePolicy
    ) != nil
  }
  check(
    diagnosticFailure(state.registerChildDiagnosed(
      peerPID: desktopPID,
      requestId: "diagnostic-stale-generation",
      generation: desktopAttestation.generation + 1,
      ownerToken: desktopAttestation.ownerToken,
      registrationToken: "diagnostic-stale-token",
      role: "daemon",
      childPID: daemonPID,
      expectedIdentity: daemonIdentity,
      policy: wirePolicy
    )) == MeetlessProcessRegistrationFailure(
      role: .daemon,
      stage: .authorization,
      check: .staleGeneration,
      osCode: .none
    ),
    "registration diagnostics must classify stale generations"
  )
  check(
    diagnosticFailure(state.registerChildDiagnosed(
      peerPID: desktopPID,
      requestId: "diagnostic-policy-mismatch",
      generation: desktopAttestation.generation,
      ownerToken: desktopAttestation.ownerToken,
      registrationToken: "diagnostic-policy-token",
      role: "daemon",
      childPID: daemonPID,
      expectedIdentity: daemonIdentity,
      policy: MeetlessHostProcessPolicyWire(
        runtimeRoot: "/private/diagnostic-policy-mismatch",
        endpointPolicy: wirePolicy.endpointPolicy,
        endpointWorkingDirectory: wirePolicy.endpointWorkingDirectory,
        recordingEndpointName: wirePolicy.recordingEndpointName,
        transcriptionEndpointName: wirePolicy.transcriptionEndpointName
      )
    )) == MeetlessProcessRegistrationFailure(
      role: .daemon,
      stage: .authorization,
      check: .policyMismatch,
      osCode: .none
    ),
    "registration diagnostics must classify policy mismatches"
  )
  check(
    diagnosticFailure(state.registerChildDiagnosed(
      peerPID: desktopPID,
      requestId: "diagnostic-child-identity",
      generation: desktopAttestation.generation,
      ownerToken: desktopAttestation.ownerToken,
      registrationToken: "diagnostic-child-token",
      role: "daemon",
      childPID: daemonPID,
      expectedIdentity: replacingProcessIdentity(daemonIdentity, configuredPath: "/private/diagnostic-child-identity"),
      policy: wirePolicy
    )) == MeetlessProcessRegistrationFailure(
      role: .daemon,
      stage: .authorization,
      check: .childIdentityMismatch,
      osCode: .none
    ),
    "registration diagnostics must classify child identity mismatches"
  )
  check(
    diagnosticFailure(state.registerChildDiagnosed(
      peerPID: desktopPID,
      requestId: "diagnostic-role-mismatch",
      generation: desktopAttestation.generation,
      ownerToken: desktopAttestation.ownerToken,
      registrationToken: "diagnostic-role-token",
      role: "capture-helper",
      childPID: daemonPID,
      expectedIdentity: replacingProcessIdentity(daemonIdentity, argv: [executable]),
      policy: wirePolicy
    )) == MeetlessProcessRegistrationFailure(
      role: .captureHelper,
      stage: .ownership,
      check: .roleMismatch,
      osCode: .none
    ),
    "registration diagnostics must classify role mismatches"
  )
  check(
    diagnosticFailure(state.registerChildDiagnosed(
      peerPID: desktopPID,
      requestId: "diagnostic-token-mismatch",
      generation: desktopAttestation.generation,
      ownerToken: "diagnostic-wrong-owner-token",
      registrationToken: "diagnostic-token-mismatch-token",
      role: "daemon",
      childPID: daemonPID,
      expectedIdentity: daemonIdentity,
      policy: wirePolicy
    )) == MeetlessProcessRegistrationFailure(
      role: .daemon,
      stage: .ownership,
      check: .tokenMismatch,
      osCode: .none
    ),
    "registration diagnostics must classify owner-token mismatches"
  )
  check(!registerDaemon(requestId: "stale-generation", generation: desktopAttestation.generation + 1), "stale daemon registration generation must be rejected")
  check(
    !registerDaemon(
      requestId: "wrong-runtime-root",
      policy: MeetlessHostProcessPolicyWire(
        runtimeRoot: "/private/wrong-runtime-root",
        endpointPolicy: wirePolicy.endpointPolicy,
        endpointWorkingDirectory: wirePolicy.endpointWorkingDirectory,
        recordingEndpointName: wirePolicy.recordingEndpointName,
        transcriptionEndpointName: wirePolicy.transcriptionEndpointName
      )
    ),
    "wrong runtime-root policy must be rejected"
  )
  check(
    !registerDaemon(
      requestId: "wrong-endpoint-policy",
      policy: MeetlessHostProcessPolicyWire(
        runtimeRoot: wirePolicy.runtimeRoot,
        endpointPolicy: "MEETLESS_RUNTIME_ENDPOINTS v0",
        endpointWorkingDirectory: wirePolicy.endpointWorkingDirectory,
        recordingEndpointName: wirePolicy.recordingEndpointName,
        transcriptionEndpointName: wirePolicy.transcriptionEndpointName
      )
    ),
    "wrong endpoint policy version must be rejected"
  )
  check(!registerDaemon(
    requestId: "wrong-configured-path",
    expectedIdentity: replacingProcessIdentity(daemonIdentity, configuredPath: "/private/wrong-node")
  ), "wrong configured executable path must be rejected")
  check(!registerDaemon(
    requestId: "wrong-real-path",
    expectedIdentity: replacingProcessIdentity(daemonIdentity, realPath: "/private/wrong-node")
  ), "wrong executable real path must be rejected")
  check(!registerDaemon(
    requestId: "wrong-device",
    expectedIdentity: replacingProcessIdentity(daemonIdentity, device: daemonIdentity.device + 1)
  ), "wrong executable device must be rejected")
  check(!registerDaemon(
    requestId: "wrong-inode",
    expectedIdentity: replacingProcessIdentity(daemonIdentity, inode: daemonIdentity.inode + 1)
  ), "wrong executable inode must be rejected")
  check(!registerDaemon(
    requestId: "wrong-size",
    expectedIdentity: replacingProcessIdentity(daemonIdentity, byteLength: daemonIdentity.byteLength + 1)
  ), "wrong executable size must be rejected")
  check(!registerDaemon(
    requestId: "wrong-hash",
    expectedIdentity: replacingProcessIdentity(
      daemonIdentity,
      sha256: daemonIdentity.sha256 == String(repeating: "f", count: 64)
        ? String(repeating: "e", count: 64)
        : String(repeating: "f", count: 64)
    )
  ), "wrong executable hash must be rejected")
  check(!registerDaemon(
    requestId: "wrapper-argv",
    expectedIdentity: replacingProcessIdentity(daemonIdentity, argv: [executable, runtimeCli, "daemon", "--wrapper"])
  ), "wrapper argv must be rejected")
  check(!registerDaemon(
    requestId: "empty-argv",
    expectedIdentity: replacingProcessIdentity(daemonIdentity, argv: [executable, runtimeCli, ""])
  ), "empty argv fields must be rejected")
  check(!registerDaemon(
    requestId: "whitespace-argv",
    expectedIdentity: replacingProcessIdentity(daemonIdentity, argv: [executable, runtimeCli, " "])
  ), "whitespace argv fields must be rejected")
  check(!registerDaemon(requestId: "unknown-role", role: "unknown"), "unknown process roles must be rejected")
  check(!registerDaemon(requestId: "direct-daemon-peer", peerPID: getpid()), "direct daemon registration from an unrelated peer must be rejected")
  check(
    state.attestRegisteredProcess(
      peerPID: daemonPID,
      requestId: "daemon-pre-registration",
      generation: desktopAttestation.generation,
      registrationToken: daemonToken,
      role: "daemon"
    ) == nil,
    "a daemon must be rejected before its child registration exists"
  )
  guard let daemonRegistration = state.registerChild(
    peerPID: desktopPID,
    requestId: "daemon-registration",
    generation: desktopAttestation.generation,
    ownerToken: desktopAttestation.ownerToken,
    registrationToken: daemonToken,
    role: "daemon",
    childPID: daemonPID,
    expectedIdentity: daemonIdentity,
    policy: wirePolicy
  ) else {
    check(false, "desktop must register only its exact daemon child")
    return
  }
  check(daemonRegistration.pid == daemonPID, "daemon registration must preserve the spawned child PID")
  check(
    diagnosticFailure(state.registerChildDiagnosed(
      peerPID: desktopPID,
      requestId: "diagnostic-duplicate-role",
      generation: desktopAttestation.generation,
      ownerToken: desktopAttestation.ownerToken,
      registrationToken: "diagnostic-duplicate-token",
      role: "daemon",
      childPID: daemonPID,
      expectedIdentity: daemonIdentity,
      policy: wirePolicy
    )) == MeetlessProcessRegistrationFailure(
      role: .daemon,
      stage: .authorization,
      check: .duplicateRoleOrSlot,
      osCode: .none
    ),
    "registration diagnostics must classify duplicate role or slot registrations"
  )
  check(!registerDaemon(requestId: "conflicting-daemon-registration"), "conflicting duplicate child registration must be rejected")
  check(!registerDaemon(requestId: "replayed-daemon-registration"), "replayed child registration request must be rejected")
  check(
    state.attestRegisteredProcess(
      peerPID: daemonPID,
      requestId: "daemon-pre-registration",
      generation: desktopAttestation.generation,
      registrationToken: daemonToken,
      role: "daemon"
    ) == nil,
    "a request ID consumed by pre-registration rejection must not be replayable after registration"
  )
  guard let daemonAttestation = state.attestRegisteredProcess(
    peerPID: daemonPID,
    requestId: "daemon-attestation",
    generation: desktopAttestation.generation,
    registrationToken: daemonToken,
    role: "daemon"
  ) else {
    check(false, "daemon must attest from its registered peer PID")
    return
  }
  check(
    state.attestRegisteredProcess(
      peerPID: daemonPID,
      requestId: "daemon-replay",
      generation: desktopAttestation.generation,
      registrationToken: daemonToken,
      role: "daemon"
    ) == nil,
    "daemon attestation replay must be rejected"
  )
  guard let pluginPID = waitForNativeProcessFixturePID(environmentRoot, role: "plugin"),
        let pluginIdentity = try? inspectMeetlessProcessIdentity(pluginPID) else {
    check(false, "daemon fixture must spawn a plugin child with inspectable identity")
    return
  }
  check(liveParentPID(pluginPID) == workerPID, "plugin fixture must remain a direct worker child")
  check(pluginIdentity.configuredPath == executable, "plugin fixture executable identity must match the node path")
  check(pluginIdentity.argv == [executable, pluginPath], "plugin fixture argv must match the plugin-process entrypoint")
  check(
    diagnosticFailure(state.registerChildDiagnosed(
      peerPID: daemonPID,
      requestId: "diagnostic-owner-chain",
      generation: desktopAttestation.generation,
      ownerToken: daemonToken,
      registrationToken: "diagnostic-owner-chain-token",
      role: "plugin",
      childPID: pluginPID,
      expectedIdentity: pluginIdentity,
      policy: wirePolicy
    )) == MeetlessProcessRegistrationFailure(
      role: .plugin,
      stage: .ownership,
      check: .ownerChainFailure,
      osCode: .none
    ),
    "registration diagnostics must classify a missing pinned worker owner chain"
  )
  var pluginToken = "plugin-registration-token"
  check(
    state.registerChild(
      peerPID: pluginPID,
      requestId: "wrong-plugin-path",
      generation: desktopAttestation.generation,
      ownerToken: daemonToken,
      registrationToken: "wrong-plugin-path-token",
      role: "plugin",
      childPID: pluginPID,
      expectedIdentity: replacingProcessIdentity(pluginIdentity, configuredPath: "/private/wrong-plugin"),
      policy: wirePolicy
    ) == nil,
    "wrong plugin executable path must be rejected"
  )
  check(
    state.registerChild(
      peerPID: pluginPID,
      requestId: "wrong-plugin-argv",
      generation: desktopAttestation.generation,
      ownerToken: daemonToken,
      registrationToken: "wrong-plugin-argv-token",
      role: "plugin",
      childPID: pluginPID,
      expectedIdentity: replacingProcessIdentity(pluginIdentity, argv: [executable, pluginPath, "daemon"]),
      policy: wirePolicy
    ) == nil,
    "wrong plugin argv must be rejected"
  )
  func rejectsPlugin(with processPolicy: MeetlessProcessRegistrationPolicy, prefix: String) -> Bool {
    let candidate = RuntimeAuthorizationState()
    candidate.configure(processPolicy: processPolicy, hostIdentity: hostIdentity, hostPID: getpid())
    candidate.publish(desktopPID)
    guard let owner = candidate.attestDesktop(
      peerPID: desktopPID,
      requestId: "\(prefix)-desktop",
      challenge: "\(prefix)-challenge"
    ),
    candidate.registerChild(
      peerPID: desktopPID,
      requestId: "\(prefix)-daemon-registration",
      generation: owner.generation,
      ownerToken: owner.ownerToken,
      registrationToken: "\(prefix)-daemon-token",
      role: "daemon",
      childPID: daemonPID,
      expectedIdentity: daemonIdentity,
      policy: wirePolicy
    ) != nil,
    candidate.attestRegisteredProcess(
      peerPID: daemonPID,
      requestId: "\(prefix)-daemon-attestation",
      generation: owner.generation,
      registrationToken: "\(prefix)-daemon-token",
      role: "daemon"
    ) != nil else { return false }
    return candidate.registerChild(
      peerPID: pluginPID,
      requestId: "\(prefix)-plugin-registration",
      generation: owner.generation,
      ownerToken: "\(prefix)-daemon-token",
      registrationToken: "\(prefix)-plugin-token",
      role: "plugin",
      childPID: pluginPID,
      expectedIdentity: pluginIdentity,
      policy: wirePolicy
    ) == nil
  }
  let wrongWorkerPathPolicy = MeetlessProcessRegistrationPolicy(
    runtimeRoot: policy.runtimeRoot,
    endpointPolicy: policy.endpointPolicy,
    endpointWorkingDirectory: policy.endpointWorkingDirectory,
    recordingEndpointName: policy.recordingEndpointName,
    transcriptionEndpointName: policy.transcriptionEndpointName,
    nodePath: policy.nodePath,
    runtimeCliPath: policy.runtimeCliPath,
    daemonWorkerPath: "/private/wrong-daemon-worker.js",
    daemonWorkerArguments: [executable, "/private/wrong-daemon-worker.js", "daemon"],
    pluginPath: policy.pluginPath,
    pluginArguments: policy.pluginArguments,
    captureHelperPath: policy.captureHelperPath
  )
  check(rejectsPlugin(with: wrongWorkerPathPolicy, prefix: "wrong-worker-path"), "wrong daemon-worker path must reject plugin registration")
  let wrongWorkerArgvPolicy = MeetlessProcessRegistrationPolicy(
    runtimeRoot: policy.runtimeRoot,
    endpointPolicy: policy.endpointPolicy,
    endpointWorkingDirectory: policy.endpointWorkingDirectory,
    recordingEndpointName: policy.recordingEndpointName,
    transcriptionEndpointName: policy.transcriptionEndpointName,
    nodePath: policy.nodePath,
    runtimeCliPath: policy.runtimeCliPath,
    daemonWorkerPath: workerPath,
    daemonWorkerArguments: [executable, workerPath, "daemon", "--wrapper"],
    pluginPath: policy.pluginPath,
    pluginArguments: policy.pluginArguments,
    captureHelperPath: policy.captureHelperPath
  )
  check(rejectsPlugin(with: wrongWorkerArgvPolicy, prefix: "wrong-worker-argv"), "wrong daemon-worker argv must reject plugin registration")
  let wrongPluginArgvPolicy = MeetlessProcessRegistrationPolicy(
    runtimeRoot: policy.runtimeRoot,
    endpointPolicy: policy.endpointPolicy,
    endpointWorkingDirectory: policy.endpointWorkingDirectory,
    recordingEndpointName: policy.recordingEndpointName,
    transcriptionEndpointName: policy.transcriptionEndpointName,
    nodePath: policy.nodePath,
    runtimeCliPath: policy.runtimeCliPath,
    daemonWorkerPath: policy.daemonWorkerPath,
    daemonWorkerArguments: policy.daemonWorkerArguments,
    pluginPath: policy.pluginPath,
    pluginArguments: [executable, pluginPath, "daemon"],
    captureHelperPath: policy.captureHelperPath
  )
  check(rejectsPlugin(with: wrongPluginArgvPolicy, prefix: "wrong-plugin-policy-argv"), "wrong native plugin argv policy must reject plugin registration")
  check(
    state.registerChild(
      peerPID: daemonPID,
      requestId: "direct-daemon-plugin-registration",
      generation: desktopAttestation.generation,
      ownerToken: daemonToken,
      registrationToken: "direct-daemon-plugin-token",
      role: "plugin",
      childPID: pluginPID,
      expectedIdentity: pluginIdentity,
      policy: wirePolicy
    ) == nil,
    "direct daemon-to-plugin registration must be rejected when the pinned worker is absent"
  )
  guard state.registerChild(
    peerPID: pluginPID,
    requestId: "plugin-registration",
    generation: daemonAttestation.generation,
    ownerToken: daemonToken,
    registrationToken: pluginToken,
    role: "plugin",
    childPID: pluginPID,
    expectedIdentity: pluginIdentity,
    policy: wirePolicy
  ) != nil else {
    check(false, "a plugin may self-register only through its attested daemon parent token")
    return
  }
  guard state.attestRegisteredProcess(
    peerPID: pluginPID,
    requestId: "plugin-attestation",
    generation: desktopAttestation.generation,
    registrationToken: pluginToken,
    role: "plugin"
  ) != nil else {
    check(false, "plugin must attest from its own registered peer PID")
    return
  }
  guard let helperPID = waitForNativeProcessFixturePID(environmentRoot, role: "capture-helper"),
        let helperIdentity = try? inspectMeetlessProcessIdentity(helperPID) else {
    check(false, "plugin fixture must spawn a capture helper child with inspectable identity")
    return
  }
  let helperToken = "helper-registration-token"
  check(
    state.registerChild(
      peerPID: pluginPID,
      requestId: "helper-registration",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      registrationToken: helperToken,
      role: "capture-helper",
      childPID: helperPID,
      expectedIdentity: helperIdentity,
      policy: wirePolicy
    ) != nil,
    "plugin must register its recording-service-owned helper"
  )
  registrationDiagnosticSink.removeAll()
  check(state.pruneDeadRegistrations(), "a valid attested registration chain must survive a native prune inspection")
  check(
    registrationDiagnosticSink.snapshot().isEmpty,
    "a valid attested registration chain must not emit a removal diagnostic"
  )
  let attestationRaceState = RuntimeAuthorizationState()
  attestationRaceState.configure(processPolicy: policy, hostIdentity: hostIdentity, hostPID: getpid())
  attestationRaceState.publish(desktopPID)
  if let raceDesktop = attestationRaceState.attestDesktop(
    peerPID: desktopPID,
    requestId: "attestation-race-desktop",
    challenge: "attestation-race-challenge"
  ),
  attestationRaceState.registerChild(
    peerPID: desktopPID,
    requestId: "attestation-race-daemon-registration",
    generation: raceDesktop.generation,
    ownerToken: raceDesktop.ownerToken,
    registrationToken: "attestation-race-daemon-token",
    role: "daemon",
    childPID: daemonPID,
    expectedIdentity: daemonIdentity,
    policy: wirePolicy
  ) != nil,
  attestationRaceState.attestRegisteredProcess(
    peerPID: daemonPID,
    requestId: "attestation-race-daemon-attestation",
    generation: raceDesktop.generation,
    registrationToken: "attestation-race-daemon-token",
    role: "daemon"
  ) != nil,
  attestationRaceState.registerChild(
    peerPID: pluginPID,
    requestId: "attestation-race-plugin-registration",
    generation: raceDesktop.generation,
    ownerToken: "attestation-race-daemon-token",
    registrationToken: "attestation-race-plugin-token",
    role: "plugin",
    childPID: pluginPID,
    expectedIdentity: pluginIdentity,
    policy: wirePolicy
  ) != nil {
    attestationRaceState.setInspectionHook {
      _ = attestationRaceState.releaseChild(
        peerPID: desktopPID,
        requestId: "attestation-race-daemon-release",
        generation: raceDesktop.generation,
        ownerToken: raceDesktop.ownerToken,
        childPID: daemonPID
      )
    }
    check(
      attestationRaceState.attestRegisteredProcess(
        peerPID: pluginPID,
        requestId: "attestation-race-plugin-attestation",
        generation: raceDesktop.generation,
        registrationToken: "attestation-race-plugin-token",
        role: "plugin"
      ) == nil,
      "plugin attestation must be rejected when its daemon owner is released during inspection"
    )
  } else {
    check(false, "attestation race fixture must establish the exact daemon-to-worker-to-plugin chain")
  }
  check(
    state.registerChild(
      peerPID: getpid(),
      requestId: "wrong-peer-registration",
      generation: desktopAttestation.generation,
      ownerToken: desktopAttestation.ownerToken,
      registrationToken: "wrong-peer-token",
      role: "capture-helper",
      childPID: helperPID,
      expectedIdentity: helperIdentity,
      policy: wirePolicy
    ) == nil,
    "wrong registration peer must be rejected"
  )
  check(
    !state.releaseChild(
      peerPID: daemonPID,
      requestId: "unowned-helper-release",
      generation: desktopAttestation.generation,
      ownerToken: daemonToken,
      childPID: helperPID
    ),
    "unowned helper cleanup must be rejected"
  )
  guard let registrations = state.registrationStatus(
    peerPID: desktopPID,
    requestId: "registration-status",
    generation: desktopAttestation.generation,
    ownerToken: desktopAttestation.ownerToken
  ) else {
    check(false, "desktop must inspect only the current launch generation registrations")
    return
  }
  check(registrations.count == 3, "desktop status must retain daemon, plugin, and helper registration state")
  check(
    state.releaseChild(
      peerPID: pluginPID,
      requestId: "helper-release",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      childPID: helperPID
    ),
    "plugin must release its helper registration on helper shutdown"
  )
  guard let afterHelperRelease = state.registrationStatus(
    peerPID: desktopPID,
    requestId: "registration-status-after-helper-release",
    generation: desktopAttestation.generation,
    ownerToken: desktopAttestation.ownerToken
  ) else {
    check(false, "desktop status must remain available after owned helper release")
    return
  }
  check(afterHelperRelease.count == 2, "owned helper release must remove only the helper registration")
  check(
    state.registerChild(
      peerPID: pluginPID,
      requestId: "helper-token-replay",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      registrationToken: helperToken,
      role: "capture-helper",
      childPID: helperPID,
      expectedIdentity: helperIdentity,
      policy: wirePolicy
    ) == nil,
    "a released registration token must not be replayable in the launch generation"
  )
  state.setInspectionHook {
    _ = state.releaseChild(
      peerPID: desktopPID,
      requestId: "plugin-release-during-registration",
      generation: desktopAttestation.generation,
      ownerToken: desktopAttestation.ownerToken,
      childPID: daemonPID
    )
  }
  check(
    state.registerChild(
      peerPID: pluginPID,
      requestId: "helper-registration-during-release",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      registrationToken: "helper-registration-during-release-token",
      role: "capture-helper",
      childPID: helperPID,
      expectedIdentity: helperIdentity,
      policy: wirePolicy
    ) == nil,
    "helper registration must be rejected when its daemon owner chain is released during inspection"
  )
  daemonToken = "daemon-reregistration-token"
  check(
    state.registerChild(
      peerPID: desktopPID,
      requestId: "daemon-reregistration",
      generation: desktopAttestation.generation,
      ownerToken: desktopAttestation.ownerToken,
      registrationToken: daemonToken,
      role: "daemon",
      childPID: daemonPID,
      expectedIdentity: daemonIdentity,
      policy: wirePolicy
    ) != nil,
    "daemon must re-register after an owner release during child registration"
  )
  check(
    state.attestRegisteredProcess(
      peerPID: daemonPID,
      requestId: "daemon-re-attestation",
      generation: desktopAttestation.generation,
      registrationToken: daemonToken,
      role: "daemon"
    ) != nil,
    "re-registered daemon must complete attestation"
  )
  pluginToken = "plugin-reregistration-token"
  check(
    state.registerChild(
      peerPID: pluginPID,
      requestId: "plugin-reregistration",
      generation: desktopAttestation.generation,
      ownerToken: daemonToken,
      registrationToken: pluginToken,
      role: "plugin",
      childPID: pluginPID,
      expectedIdentity: pluginIdentity,
      policy: wirePolicy
    ) != nil,
    "plugin must re-register after its owner released the prior registration"
  )
  check(
    state.attestRegisteredProcess(
      peerPID: pluginPID,
      requestId: "plugin-re-attestation",
      generation: desktopAttestation.generation,
      registrationToken: pluginToken,
      role: "plugin"
    ) != nil,
    "re-registered plugin must complete attestation"
  )
  check(
    state.registerChild(
      peerPID: pluginPID,
      requestId: "helper-reregistration",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      registrationToken: "helper-reregistration-token",
      role: "capture-helper",
      childPID: helperPID,
      expectedIdentity: helperIdentity,
      policy: wirePolicy
    ) != nil,
    "plugin must be able to re-register a helper after owner-release rejection"
  )
  guard let beforeReparent = state.registrationStatus(
    peerPID: desktopPID,
    requestId: "registration-status-before-reparent",
    generation: desktopAttestation.generation,
    ownerToken: desktopAttestation.ownerToken
  ) else {
    check(false, "desktop status must remain bounded after helper re-registration")
    return
  }
  check(beforeReparent.count == 3, "helper re-registration must restore the complete bounded chain")
  state.setInspectionHook {
    _ = state.releaseChild(
      peerPID: pluginPID,
      requestId: "helper-release-during-status",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      childPID: helperPID
    )
  }
  guard let afterStatusRelease = state.registrationStatus(
    peerPID: desktopPID,
    requestId: "registration-status-during-release",
    generation: desktopAttestation.generation,
    ownerToken: desktopAttestation.ownerToken
  ) else {
    check(false, "status must fail closed or retry after an owner release during inspection")
    return
  }
  check(
    afterStatusRelease.count == 2 && !afterStatusRelease.contains(where: { $0.pid == helperPID }),
    "status must not report a helper released during its unlocked inspection"
  )
  check(
    state.registerChild(
      peerPID: pluginPID,
      requestId: "helper-lease-registration",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      registrationToken: "helper-lease-token",
      role: "capture-helper",
      childPID: helperPID,
      expectedIdentity: helperIdentity,
      policy: wirePolicy
    ) != nil,
    "plugin must restore helper ownership before lease revision proof"
  )
  state.setInspectionHook {
    _ = state.releaseChild(
      peerPID: pluginPID,
      requestId: "helper-release-during-lease",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      childPID: helperPID
    )
  }
  check(
    state.issueLease(
      peerPID: pluginPID,
      authorizer: RuntimePeerAuthorizer(),
      requireRegistered: true
    ) == nil,
    "a packaged lease must be rejected when registration revision changes during inspection"
  )
  check(
    state.registerChild(
      peerPID: pluginPID,
      requestId: "helper-reparent-registration",
      generation: desktopAttestation.generation,
      ownerToken: pluginToken,
      registrationToken: "helper-reparent-token",
      role: "capture-helper",
      childPID: helperPID,
      expectedIdentity: helperIdentity,
      policy: wirePolicy
    ) != nil,
    "plugin must restore helper ownership before worker-chain pruning proof"
  )
  guard let packagedLease = state.issueLease(
    peerPID: pluginPID,
    authorizer: RuntimePeerAuthorizer(),
    requireRegistered: true
  ) else {
    check(false, "a stable registered plugin must issue a packaged lease")
    return
  }
  var packagedLeaseActionRan = false
  check(
    state.withValidLease(packagedLease, {
      packagedLeaseActionRan = true
      return true
    }) == true && packagedLeaseActionRan,
    "a stable registered plugin lease must validate before and after its action"
  )
  guard let packagedExecution = state.beginExecution(packagedLease) else {
    check(false, "a stable registered plugin lease must begin execution")
    return
  }
  state.finishExecution(packagedExecution)
  guard let stalePackagedLease = state.issueLease(
    peerPID: pluginPID,
    authorizer: RuntimePeerAuthorizer(),
    requireRegistered: true
  ) else {
    check(false, "a registered plugin must issue a lease before deterministic reparenting")
    return
  }
  registrationDiagnosticSink.removeAll()
  terminateNativeProcessFixture(workerPID)
  waitForNativeProcessFixtureExit(workerPID)
  var staleLeaseActionRan = false
  check(
    state.withValidLease(stalePackagedLease, {
      staleLeaseActionRan = true
      return true
    }) == nil && !staleLeaseActionRan,
    "a worker termination must invalidate a packaged lease before its action without waiting for prune"
  )
  check(
    state.beginExecution(stalePackagedLease) == nil,
    "beginExecution must reject a packaged lease after its worker chain is reparented"
  )
  guard let afterWorkerExit = state.registrationStatus(
    peerPID: desktopPID,
    requestId: "registration-status-after-worker-exit",
    generation: desktopAttestation.generation,
    ownerToken: desktopAttestation.ownerToken
  ) else {
    check(false, "desktop status must remain available after the worker intermediate exits")
    return
  }
  check(
    afterWorkerExit.count == 1 && afterWorkerExit[0].pid == daemonPID,
    "worker reparent or exit must recursively remove plugin and helper registrations"
  )
  let workerRemovalEvents = registrationDiagnosticSink.snapshot().filter { $0.action == .prune }
  check(
    workerRemovalEvents.contains {
      $0.role == .plugin && $0.pid == pluginPID && $0.stage == .inspection && $0.check == .parentMismatch
    },
    "a committed worker reparent must retain the plugin parent-mismatch predicate"
  )
  check(
    workerRemovalEvents.contains {
      $0.role == .captureHelper && $0.pid == helperPID && $0.stage == .ownership && $0.check == .ownerChainFailure
    },
    "a committed worker reparent must retain the helper owner-chain predicate"
  )
  check(
    workerRemovalEvents.allSatisfy {
      $0.generation == desktopAttestation.generation && $0.revision > 0
    },
    "committed removal diagnostics must retain the launch generation and committed revision"
  )
  terminateNativeProcessFixture(pluginPID)
  waitForNativeProcessFixtureExit(pluginPID)
  guard let afterPluginExit = state.registrationStatus(
    peerPID: desktopPID,
    requestId: "registration-status-after-plugin-exit",
    generation: desktopAttestation.generation,
    ownerToken: desktopAttestation.ownerToken
  ) else {
    check(false, "desktop status must remain bounded after the plugin exits")
    return
  }
  check(afterPluginExit.count == 1 && afterPluginExit[0].pid == daemonPID, "plugin exit must not remove its unowned daemon")
  registrationDiagnosticSink.removeAll()
  terminateNativeProcessFixture(daemonPID)
  waitForNativeProcessFixtureExit(daemonPID)
  guard let afterDaemonExit = state.registrationStatus(
    peerPID: desktopPID,
    requestId: "registration-status-after-daemon-exit",
    generation: desktopAttestation.generation,
    ownerToken: desktopAttestation.ownerToken
  ) else {
    check(false, "desktop status must remain bounded after the daemon exits")
    return
  }
  check(afterDaemonExit.isEmpty, "daemon exit must recursively release the remaining registration chain")
  let daemonRemovalEvents = registrationDiagnosticSink.snapshot().filter { $0.action == .prune }
  check(
    daemonRemovalEvents.contains {
      $0.role == .daemon && $0.pid == daemonPID && $0.stage == .inspection && $0.check == .processGone
    },
    "a committed daemon process exit must retain the process-gone predicate"
  )
  state.clear()
  check(
    state.registrationStatus(
      peerPID: desktopPID,
      requestId: "stale-status",
      generation: desktopAttestation.generation,
      ownerToken: desktopAttestation.ownerToken
    ) == nil,
    "shutdown must remove all launch-generation registration state"
  )
}

private func testRealSocketStatusResponse() throws {
  let root = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("m3sock-\(getpid())-\(UUID().uuidString.prefix(8))")
  let socketPath = root.appendingPathComponent("transcription.sock").path
  let capability = MeetlessTranscriptionCapability(
    socketPath: socketPath,
    stagingDirectory: root.appendingPathComponent("meeting-store/transcription-ranges").path,
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: FakeKeychain()
  )
  try capability.start()
  defer {
    capability.stop()
    try? FileManager.default.removeItem(at: root)
  }
  let client = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  check(client >= 0, "real status client socket must open")
  defer { close(client) }
  var timeout = timeval(tv_sec: 2, tv_usec: 0)
  _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(socketPath.utf8) + [0]
  withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: pathBytes) }
  let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
  let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.connect(client, $0, addressLength)
    }
  }
  check(connected == 0, "real status client must connect to native listener")
  let request = Data("{\"version\":1,\"requestId\":\"real-status\",\"operation\":\"status\"}\n".utf8)
  request.withUnsafeBytes { buffer in _ = Darwin.write(client, buffer.baseAddress, buffer.count) }
  let response = readBoundedLine(client, maximumBytes: 4_096)
  check(response?.contains("\"requestId\":\"real-status\"") == true, "real socket response must preserve request identity")
  check(response?.contains("\"status\":\"configured\"") == true, "real socket status response must be bounded and configured")
  check((response?.utf8.count ?? 4_096) < 1_024, "real socket status response must remain compact")
}

private func testRuntimeEndpointGoldenVectors() throws {
  let fixtureURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("packages/runtime/test/fixtures/runtime-endpoint-vectors.json")
  let vectors = try JSONDecoder().decode(
    [RuntimeEndpointGoldenVector].self,
    from: Data(contentsOf: fixtureURL)
  )
  check(vectors.map(\.id) == ["ordinary", "long-ascii", "long-unicode"], "native golden vectors must cover all endpoint root classes")
  for vector in vectors {
    check(vector.policy.schema == meetlessRuntimeEndpointSchema, "\(vector.id) policy schema must use the accepted endpoint version")
    check(vector.policy.workingDirectory == meetlessRuntimeEndpointWorkingDirectory, "\(vector.id) policy must use the runtime-root working directory")
    let recording = try meetlessPackagedEndpoint(
      role: "recording",
      name: vector.policy.recordingEndpointName,
      runtimeRoot: vector.composition.workingDirectory
    )
    let transcription = try meetlessPackagedEndpoint(
      role: "transcription",
      name: vector.policy.transcriptionEndpointName,
      runtimeRoot: vector.composition.workingDirectory
    )
    let composed = MeetlessRuntimeEndpointComposition(
      schema: meetlessRuntimeEndpointSchema,
      mode: "packaged",
      workingDirectory: URL(fileURLWithPath: vector.composition.workingDirectory).standardizedFileURL.path,
      recording: recording,
      transcription: transcription
    )
    check(composed == vector.composition, "\(vector.id) native composition must equal the shared runtime golden vector")
    check(recording.bindArgument == vector.composition.recording.bindArgument, "\(vector.id) recording bind argument must remain cross-language identical")
    check(transcription.bindArgument == vector.composition.transcription.bindArgument, "\(vector.id) transcription bind argument must remain cross-language identical")
    check(recording.bindArgument.utf8.count <= meetlessDarwinUnixSocketPathBytes, "\(vector.id) recording bind argument must fit Darwin AF_UNIX")
    check(transcription.bindArgument.utf8.count <= meetlessDarwinUnixSocketPathBytes, "\(vector.id) transcription bind argument must fit Darwin AF_UNIX")
  }
}

private func testPackagedEndpointCompositionAndOwnership() throws {
  let syntheticRoot = "/Users/\(String(repeating: "long-home-segment-", count: 12))/Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless"
  let recording = try meetlessPackagedEndpoint(
    role: "recording",
    name: "paseo-home/recording-control.sock",
    runtimeRoot: syntheticRoot
  )
  let transcription = try meetlessPackagedEndpoint(
    role: "transcription",
    name: "transcription.sock",
    runtimeRoot: syntheticRoot
  )
  check(recording.bindArgument == "paseo-home/recording-control.sock", "packaged recording bind must remain the accepted short name")
  check(transcription.bindArgument == "transcription.sock", "packaged transcription bind must remain the accepted short name")
  check(recording.bindArgument.utf8.count <= meetlessDarwinUnixSocketPathBytes, "packaged recording bind must fit Darwin AF_UNIX")
  check(transcription.bindArgument.utf8.count <= meetlessDarwinUnixSocketPathBytes, "packaged transcription bind must fit Darwin AF_UNIX")
  check(recording.canonicalPath == syntheticRoot + "/paseo-home/recording-control.sock", "recording canonical path must project inside the synthetic runtime root")
  check(transcription.canonicalPath == syntheticRoot + "/transcription.sock", "transcription canonical path must project inside the synthetic runtime root")
  check(recording.name != transcription.name, "recording and transcription names must remain distinct")
  for (label, name) in [
    ("absolute", "/private/tmp/transcription.sock"),
    ("escaping", "../transcription.sock"),
    ("empty segment", "meeting-store//transcription.sock"),
    ("overlong Unicode", String(repeating: "录", count: 40) + ".sock"),
  ] {
    expectThrow("\(label) packaged endpoint name must fail closed") {
      try validateMeetlessEndpointName(role: "transcription", name: name)
    }
  }

  let fileManager = FileManager.default
  let rootName = "meetless-packaged-endpoint-\(String(repeating: "long-ascii-runtime-root-", count: 6))\(UUID().uuidString)"
  let root = URL(fileURLWithPath: "/private/var/tmp").appendingPathComponent(rootName)
  try fileManager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  let socketPath = root.appendingPathComponent("transcription.sock").path
  check(socketPath.utf8.count > meetlessDarwinUnixSocketPathBytes, "native lifecycle proof must use a canonical path longer than Darwin AF_UNIX")
  let markerPath = socketPath + ".owner.json"
  let staging = root.appendingPathComponent("meeting-store/transcription-ranges").path
  let previousDirectory = fileManager.currentDirectoryPath
  defer {
    _ = fileManager.changeCurrentDirectoryPath(previousDirectory)
    try? fileManager.removeItem(at: root)
  }
  check(fileManager.changeCurrentDirectoryPath(root.path), "packaged endpoint test must enter the explicit runtime-root working directory")
  let endpoint = try meetlessPackagedEndpoint(role: "transcription", name: "transcription.sock", runtimeRoot: root.path)

  let wrongCwdCapability = MeetlessTranscriptionCapability(
    endpoint: endpoint,
    workingDirectory: root.path,
    stagingDirectory: staging,
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: FakeKeychain()
  )
  _ = fileManager.changeCurrentDirectoryPath(previousDirectory)
  expectThrow("packaged endpoint must reject a wrong working directory") { try wrongCwdCapability.start() }
  check(fileManager.changeCurrentDirectoryPath(root.path), "packaged endpoint test must restore the runtime-root working directory")

  try Data("foreign regular entry\n".utf8).write(to: URL(fileURLWithPath: socketPath))
  let regularCapability = MeetlessTranscriptionCapability(
    endpoint: endpoint,
    workingDirectory: root.path,
    stagingDirectory: staging,
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: FakeKeychain()
  )
  expectThrow("foreign regular endpoint entry must be preserved") { try regularCapability.start() }
  let regularContents = try Data(contentsOf: URL(fileURLWithPath: socketPath))
  check(String(data: regularContents, encoding: .utf8) == "foreign regular entry\n", "foreign regular endpoint entry must remain unchanged")
  try fileManager.removeItem(atPath: socketPath)

  let symlinkTarget = root.appendingPathComponent("foreign-target")
  try Data("foreign symlink target\n".utf8).write(to: symlinkTarget)
  try fileManager.createSymbolicLink(atPath: socketPath, withDestinationPath: symlinkTarget.path)
  let symlinkCapability = MeetlessTranscriptionCapability(
    endpoint: endpoint,
    workingDirectory: root.path,
    stagingDirectory: staging,
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: FakeKeychain()
  )
  expectThrow("foreign symlink endpoint entry must be preserved") { try symlinkCapability.start() }
  var symlinkState = stat()
  check(lstat(socketPath, &symlinkState) == 0 && symlinkState.st_mode & S_IFMT == S_IFLNK, "foreign symlink endpoint entry must remain a symlink")
  try fileManager.removeItem(atPath: socketPath)
  try fileManager.removeItem(at: symlinkTarget)

  let unknownListener = try openUnixListener(socketPath, bindPath: endpoint.bindArgument)
  let unknownCapability = MeetlessTranscriptionCapability(
    endpoint: endpoint,
    workingDirectory: root.path,
    stagingDirectory: staging,
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: FakeKeychain()
  )
  expectThrow("unknown occupied socket must fail closed") { try unknownCapability.start() }
  close(unknownListener)
  check(fileManager.fileExists(atPath: socketPath), "unknown occupied socket must not be removed by failed startup")
  unlink(socketPath)

  let staleListener = try openUnixListener(socketPath, bindPath: endpoint.bindArgument)
  close(staleListener)
  let staleMarker = "{\"schema\":\"MEETLESS_TRANSCRIPTION_ENDPOINT_OWNER v1\",\"role\":\"transcription\",\"endpointName\":\"transcription.sock\",\"canonicalPath\":\"\(endpoint.canonicalPath)\",\"pid\":2147483647,\"token\":\"stale-marker\"}\n"
  try Data(staleMarker.utf8).write(to: URL(fileURLWithPath: markerPath), options: .atomic)
  try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: markerPath)
  let staleCapability = MeetlessTranscriptionCapability(
    endpoint: endpoint,
    workingDirectory: root.path,
    stagingDirectory: staging,
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: FakeKeychain()
  )
  try staleCapability.start()
  check(fileManager.fileExists(atPath: socketPath), "provably stale socket must be reclaimed before the new listener binds")
  check(fileManager.fileExists(atPath: markerPath), "new transcription listener must publish an owner marker")
  let activeContender = MeetlessTranscriptionCapability(
    endpoint: endpoint,
    workingDirectory: root.path,
    stagingDirectory: staging,
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: FakeKeychain()
  )
  expectThrow("active transcription owner must reject a concurrent contender") { try activeContender.start() }
  check(statusRequest(socketPath: "transcription.sock", requestId: "packaged-status"), "native packaged listener must accept its short relative endpoint")
  staleCapability.stop()
  check(!fileManager.fileExists(atPath: socketPath), "owned packaged transcription socket must be removed on shutdown")
  check(!fileManager.fileExists(atPath: markerPath), "owned packaged transcription marker must be removed on shutdown")
}

private func openUnixListener(_ socketPath: String, bindPath: String? = nil) throws -> Int32 {
  let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard descriptor >= 0 else { throw capabilityError("test Unix listener could not open") }
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let addressPath = bindPath ?? socketPath
  let pathBytes = Array(addressPath.utf8) + [0]
  guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
    close(descriptor)
    throw capabilityError("test Unix listener path is too long")
  }
  withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: pathBytes) }
  let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
  let bound = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.bind(descriptor, $0, addressLength)
    }
  }
  guard bound == 0, Darwin.listen(descriptor, 1) == 0 else {
    close(descriptor)
    unlink(addressPath)
    throw capabilityError("test Unix listener could not bind")
  }
  return descriptor
}

private func testPremiumSocketBoundary() {
  let premium = FakePremiumAccess()
  let capability = MeetlessTranscriptionCapability(
    socketPath: "/private/tmp/unused-meetless-premium.sock",
    stagingDirectory: "/private/tmp/unused-meetless-premium-staging",
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: FakeKeychain(),
    premium: premium
  )

  func request(_ json: String) -> [String: Any]? {
    var descriptors: [Int32] = [0, 0]
    check(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0, "Premium request socketpair must open")
    let data = Data((json + "\n").utf8)
    data.withUnsafeBytes { buffer in _ = Darwin.write(descriptors[0], buffer.baseAddress, buffer.count) }
    capability.handle(descriptors[1])
    let line = readBoundedLine(descriptors[0], maximumBytes: 4_096)
    close(descriptors[0])
    guard let response = line?.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: response) as? [String: Any] else { return nil }
    return object
  }

  let status = request("{\"version\":1,\"requestId\":\"premium-status\",\"operation\":\"premiumStatus\"}")
  check(status?["type"] as? String == "premium.access", "Premium status must use the typed native envelope")
  check(status?["appleSignedTransaction"] == nil, "Premium status must not expose transaction material")
  let statusAccess = status?["access"] as? [String: Any]
  check(statusAccess?["status"] as? String == "inactive", "Premium status must preserve inactive access")
  let statusPackages = statusAccess?["packages"] as? [[String: Any]]
  check(statusPackages?.first?["localizedPrice"] as? String == "799.000 ₫", "Premium status must preserve only store-localized price text")

  let purchase = request("{\"version\":1,\"requestId\":\"premium-purchase\",\"operation\":\"premiumPurchase\",\"packageId\":\"monthly\"}")
  check(premium.purchasedPackage == "monthly", "Premium purchase must forward only an allowed package identifier")
  check(purchase?["outcome"] as? String == "active", "Premium purchase must return the normalized mutation outcome")
  let purchaseAccess = purchase?["access"] as? [String: Any]
  check(purchaseAccess?["status"] as? String == "active", "Premium purchase must return active entitlement state")
  check(purchase?["appleSignedTransaction"] as? String == "eyJhbGciOiJFUzI1NiJ9.synthetic.signature", "Premium purchase must carry opaque transaction material only to the trusted plugin boundary")

  let restore = request("{\"version\":1,\"requestId\":\"premium-restore\",\"operation\":\"premiumRestore\"}")
  check(premium.restoreCount == 1, "Premium restore must run only after the explicit restore request")
  check(restore?["outcome"] as? String == "active", "Premium restore must return the normalized mutation outcome")
  check(restore?["appleSignedTransaction"] as? String == "eyJhbGciOiJFUzI1NiJ9.synthetic.signature", "Premium restore must carry opaque transaction material only to the trusted plugin boundary")
}

private func testPremiumPurchaseOutcomePolicy() {
  check(
    meetlessPremiumPurchaseOutcome(succeeded: true, userCancelled: true, accessStatus: "inactive") == "cancelled",
    "cancelled Premium purchase must stay cancelled and never grant access"
  )
  check(
    meetlessPremiumPurchaseOutcome(succeeded: true, userCancelled: false, accessStatus: "inactive") == "failed",
    "successful store callback without active entitlement must fail closed"
  )
  check(
    meetlessPremiumPurchaseOutcome(succeeded: true, userCancelled: false, accessStatus: "active") == "active",
    "only an active entitlement may complete Premium purchase"
  )
}

private func testPremiumWaitDoesNotBlockAuthorizationClearOrShutdown() throws {
  let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("meetless-native-premium-lock-\(UUID().uuidString)")
  let state = authorizedRuntimeState()
  let premium = BlockingPremiumAccess()
  let capability = MeetlessTranscriptionCapability(
    socketPath: root.appendingPathComponent("unused.sock").path,
    stagingDirectory: root.appendingPathComponent("staging").path,
    runtimeAuthorization: state,
    premium: premium
  )
  var descriptors: [Int32] = [0, 0]
  check(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0, "in-flight Premium socketpair must open")
  defer { close(descriptors[0]) }

  let serverDescriptor = descriptors[1]
  DispatchQueue.global().async { capability.handle(serverDescriptor) }
  let request = Data("{\"requestId\":\"premium-lock\",\"operation\":\"premiumPurchase\",\"packageId\":\"monthly\"}\n".utf8)
  request.withUnsafeBytes { buffer in _ = Darwin.write(descriptors[0], buffer.baseAddress, buffer.count) }
  check(premium.started.wait(timeout: .now() + .seconds(1)) == .success, "Premium operation must reach the blocking test seam")

  let clearCompleted = DispatchSemaphore(value: 0)
  DispatchQueue.global().async {
    state.clear()
    clearCompleted.signal()
  }
  let shutdownCompleted = DispatchSemaphore(value: 0)
  DispatchQueue.global().async {
    capability.stop()
    shutdownCompleted.signal()
  }
  check(clearCompleted.wait(timeout: .now() + .seconds(1)) == .success, "authorization clear must not wait for Premium")
  check(shutdownCompleted.wait(timeout: .now() + .seconds(1)) == .success, "capability shutdown must not wait for Premium")

  premium.release.signal()
  _ = clearCompleted.wait(timeout: .now() + .seconds(1))
  _ = shutdownCompleted.wait(timeout: .now() + .seconds(1))
  let response = readBoundedLine(descriptors[0], maximumBytes: 4_096)
  check(response?.contains("\"ok\":false") == true, "revoked in-flight Premium operation must fail closed")
}

private func statusRequest(socketPath: String, requestId: String) -> Bool {
  let client = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard client >= 0 else { return false }
  defer { close(client) }
  var timeout = timeval(tv_sec: 1, tv_usec: 0)
  _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(socketPath.utf8) + [0]
  withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: pathBytes) }
  let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
  let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.connect(client, $0, addressLength)
    }
  }
  guard connected == 0 else { return false }
  let request = Data("{\"version\":1,\"requestId\":\"\(requestId)\",\"operation\":\"status\"}\n".utf8)
  request.withUnsafeBytes { buffer in _ = Darwin.write(client, buffer.baseAddress, buffer.count) }
  let response = readBoundedLine(client, maximumBytes: 4_096)
  return response == nil || response?.contains("\"requestId\":\"\(requestId)\"") == true
}

private func testConcurrentLifecycleCompletesWithinBound() throws {
  for cycle in 0..<20 {
    let root = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("m3race-\(getpid())-\(cycle)-\(UUID().uuidString.prefix(6))")
    let socketPath = root.appendingPathComponent("transcription.sock").path
    let capability = MeetlessTranscriptionCapability(
      socketPath: socketPath,
      stagingDirectory: root.appendingPathComponent("meeting-store/transcription-ranges").path,
      runtimeAuthorization: authorizedRuntimeState(),
      keychain: FakeKeychain()
    )
    try capability.start()
    let group = DispatchGroup()
    let completed = LockedCounter()
    for request in 0..<12 {
      group.enter()
      DispatchQueue.global().async {
        _ = statusRequest(socketPath: socketPath, requestId: "race-\(cycle)-\(request)")
        completed.increment()
        group.leave()
      }
    }
    group.enter()
    DispatchQueue.global().async {
      usleep(5_000)
      capability.stop()
      group.leave()
    }
    check(group.wait(timeout: .now() + .seconds(3)) == .success, "concurrent native lifecycle must complete within its bound")
    check(completed.snapshot() == 12, "all concurrent status clients must finish during stop")
    capability.stop()
    try? FileManager.default.removeItem(at: root)
  }
}

private func testRuntimeAuthorizationStateSnapshot() {
  let state = RuntimeAuthorizationState()
  state.publish(getpid())
  check(state.snapshot() == getpid(), "runtime authorization state must publish a live PID snapshot")
  let lease = state.issueLease(peerPID: getpid(), authorizer: RuntimePeerAuthorizer())
  check(lease != nil, "live runtime identity must issue a generation-bound lease")
  if let lease {
    check(state.withValidLease(lease, { true }) == true, "development lease must retain its existing use path")
    if let execution = state.beginExecution(lease) {
      state.finishExecution(execution)
    } else {
      check(false, "development lease must retain its existing execution path")
    }
  }
  state.publish(getpid())
  if let lease {
    check(state.withValidLease(lease, { true }) == nil, "runtime replacement must invalidate the prior generation lease")
  }
  state.clear(expected: getpid() + 1)
  check(state.snapshot() == getpid(), "unrelated termination must not clear runtime authorization")
  state.clear(expected: getpid())
  check(state.snapshot() == nil, "exact runtime termination must clear authorization")
}

private func testRegistrationDiagnosticFileSinkIsBoundedAndRetained() throws {
  let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("meetless-registration-log-\(UUID().uuidString)")
  let logs = root.appendingPathComponent("logs")
  let logURL = logs.appendingPathComponent("host-runtime.log")
  let fileManager = FileManager.default
  try fileManager.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  fileManager.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
  defer { try? fileManager.removeItem(at: root) }

  let hostLog = try FileHandle(forWritingTo: logURL)
  defer { try? hostLog.close() }
  try hostLog.seekToEnd()
  guard let sink = makeMeetlessProcessRegistrationDiagnosticSink(duplicating: hostLog) else {
    check(false, "the production host-runtime log must provide a diagnostic sink")
    return
  }
  let event = MeetlessProcessRegistrationRemovalEvent(
    action: .prune,
    failure: MeetlessProcessRegistrationFailure(
      role: .daemon,
      stage: .inspection,
      check: .childIdentityMismatch,
      osCode: .none
    ),
    pid: 4242,
    generation: 7,
    revision: 11
  )
  for offset in 0..<(meetlessMaximumRegistrationDiagnosticEvents + 8) {
    sink.record(
      MeetlessProcessRegistrationRemovalEvent(
        action: event.action,
        failure: MeetlessProcessRegistrationFailure(
          role: event.role,
          stage: event.stage,
          check: event.check,
          osCode: event.osCode
        ),
        pid: event.pid + Int32(offset),
        generation: event.generation,
        revision: event.revision
      )
    )
  }
  let retained = try String(contentsOf: logURL, encoding: .utf8)
  let lines = retained.split(separator: "\n")
  check(
    lines.count == meetlessMaximumRegistrationDiagnosticEvents,
    "the retained registration diagnostic sink must cap its event output"
  )
  check(
    lines.allSatisfy { $0.utf8.count + 1 <= meetlessMaximumRegistrationDiagnosticLineBytes },
    "each retained registration diagnostic line must remain bounded"
  )
  check(
    retained.contains("registration-removal action=prune role=daemon stage=inspection check=child-identity-mismatch os=none pid=4242 generation=7 revision=11"),
    "the production host-runtime log must retain the categorical removal event"
  )
  for secret in ["/private/hostile/path", "ownerToken=secret", "credential=secret", "raw-error"] {
    check(!retained.contains(secret), "retained registration diagnostics must not expose \(secret)")
  }
}

private func testDelayedAuthorizedRequestIsDeniedAfterRevocation() throws {
  let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("meetless-native-revoked-\(UUID().uuidString)")
  let staging = root.appendingPathComponent("meeting-store/transcription-ranges")
  try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let rangeData = Data([1, 2, 3])
  let range = staging.appendingPathComponent("range.mp3")
  try rangeData.write(to: range)
  let state = authorizedRuntimeState()
  let leaseIssued = DispatchSemaphore(value: 0)
  let keychain = FakeKeychain()
  let uploads = LockedCounter()
  let capability = MeetlessTranscriptionCapability(
    socketPath: root.appendingPathComponent("unused.sock").path,
    stagingDirectory: staging.path,
    runtimeAuthorization: state,
    keychain: keychain,
    transcribe: { _, _, _ in
      uploads.increment()
      return OpenAIResult(text: "unexpected", languages: [], usage: nil)
    },
    leaseIssued: { leaseIssued.signal() }
  )
  var descriptors: [Int32] = [0, 0]
  check(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0, "delayed request socketpair must open")
  let serverDescriptor = descriptors[1]
  DispatchQueue.global().async { capability.handle(serverDescriptor) }
  check(leaseIssued.wait(timeout: .now() + .seconds(1)) == .success, "request must acquire its initial authorization lease")
  state.clear()
  let identity = fixtureIdentity(rangeData)
  let request = Data("{\"requestId\":\"revoked\",\"operation\":\"transcribe\",\"audioPath\":\"\(range.path)\",\"audioByteLength\":\(identity.byteLength),\"audioSha256\":\"\(identity.sha256)\"}\n".utf8)
  request.withUnsafeBytes { buffer in _ = Darwin.write(descriptors[0], buffer.baseAddress, buffer.count) }
  let response = readBoundedLine(descriptors[0], maximumBytes: 4_096)
  close(descriptors[0])
  check(response?.contains("\"ok\":false") == true, "revoked delayed request must receive a normalized denial")
  check(keychain.readCount == 0, "revoked delayed request must not read Keychain data")
  check(uploads.snapshot() == 0, "revoked delayed request must not initiate transcription")
}

private func testRevocationCancelsAnAuthorizedActiveUpload() throws {
  let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("meetless-native-cancel-\(UUID().uuidString)")
  let staging = root.appendingPathComponent("meeting-store/transcription-ranges")
  try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let rangeData = Data([4, 5, 6])
  let range = staging.appendingPathComponent("range.mp3")
  try rangeData.write(to: range)
  let state = authorizedRuntimeState()
  let uploadSession = FakeUploadSession()
  let capability = MeetlessTranscriptionCapability(
    socketPath: root.appendingPathComponent("unused.sock").path,
    stagingDirectory: staging.path,
    runtimeAuthorization: state,
    keychain: FakeKeychain(),
    transcribe: { audio, key, cancellation in
      try OpenAITranscriber(apiKey: key, session: uploadSession, timeout: .seconds(5))
        .transcribe(audio: audio, cancellation: cancellation)
    }
  )
  var descriptors: [Int32] = [0, 0]
  check(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0, "active upload socketpair must open")
  let identity = fixtureIdentity(rangeData)
  let request = Data("{\"requestId\":\"cancel-active\",\"operation\":\"transcribe\",\"audioPath\":\"\(range.path)\",\"audioByteLength\":\(identity.byteLength),\"audioSha256\":\"\(identity.sha256)\"}\n".utf8)
  request.withUnsafeBytes { buffer in _ = Darwin.write(descriptors[0], buffer.baseAddress, buffer.count) }
  let serverDescriptor = descriptors[1]
  DispatchQueue.global().async { capability.handle(serverDescriptor) }
  let deadline = Date().addingTimeInterval(1)
  while !uploadSession.task.resumed && Date() < deadline { usleep(1_000) }
  check(uploadSession.task.resumed, "authorized upload must reach the native upload seam before revocation")
  state.clear()
  let response = readBoundedLine(descriptors[0], maximumBytes: 4_096)
  close(descriptors[0])
  check(uploadSession.task.cancelled, "runtime revocation must cancel an already initiated URLSession upload")
  check(response?.contains("\"ok\":false") == true, "cancelled upload must return only a normalized failure")
}

private func testInvalidPathDoesNotRetrieveCredential() {
  var descriptors: [Int32] = [0, 0]
  check(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0, "request socketpair must open")
  let keychain = FakeKeychain()
  let capability = MeetlessTranscriptionCapability(
    socketPath: "/private/tmp/unused-meetless-test.sock",
    stagingDirectory: "/private/tmp/meetless-private-staging",
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: keychain,
    transcribe: { _, _, _ in OpenAIResult(text: "unexpected", languages: [], usage: nil) }
  )
  let request = Data("{\"requestId\":\"bad-path\",\"operation\":\"transcribe\",\"audioPath\":\"/tmp/export.mp3\",\"audioByteLength\":1,\"audioSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n".utf8)
  request.withUnsafeBytes { buffer in _ = Darwin.write(descriptors[0], buffer.baseAddress, buffer.count) }
  capability.handle(descriptors[1])
  var response = [UInt8](repeating: 0, count: 1024)
  let count = response.withUnsafeMutableBytes { buffer in
    Darwin.read(descriptors[0], buffer.baseAddress, buffer.count)
  }
  close(descriptors[0])
  check(count > 0, "invalid staged path must receive normalized response")
  check(keychain.readCount == 0, "invalid staged path must be rejected before credential retrieval")
}

private func testMismatchedIdentityDoesNotRetrieveCredentialOrUpload() throws {
  let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("meetless-native-identity-\(UUID().uuidString)")
  let staging = root.appendingPathComponent("meeting-store/transcription-ranges")
  try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let range = staging.appendingPathComponent("range.mp3")
  try Data([1, 2, 3]).write(to: range)
  var descriptors: [Int32] = [0, 0]
  check(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0, "identity socketpair must open")
  let keychain = FakeKeychain()
  var uploadCount = 0
  let capability = MeetlessTranscriptionCapability(
    socketPath: root.appendingPathComponent("unused.sock").path,
    stagingDirectory: staging.path,
    runtimeAuthorization: authorizedRuntimeState(),
    keychain: keychain,
    transcribe: { _, _, _ in
      uploadCount += 1
      return OpenAIResult(text: "unexpected", languages: [], usage: nil)
    }
  )
  let request = Data("{\"requestId\":\"mismatch\",\"operation\":\"transcribe\",\"audioPath\":\"\(range.path)\",\"audioByteLength\":3,\"audioSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n".utf8)
  request.withUnsafeBytes { buffer in _ = Darwin.write(descriptors[0], buffer.baseAddress, buffer.count) }
  capability.handle(descriptors[1])
  close(descriptors[0])
  check(keychain.readCount == 0, "identity mismatch must fail before credential retrieval")
  check(uploadCount == 0, "identity mismatch must fail before network execution")

  var matchingDescriptors: [Int32] = [0, 0]
  check(socketpair(AF_UNIX, SOCK_STREAM, 0, &matchingDescriptors) == 0, "matching identity socketpair must open")
  let identity = fixtureIdentity(Data([1, 2, 3]))
  let matchingRequest = Data("{\"requestId\":\"matching\",\"operation\":\"transcribe\",\"audioPath\":\"\(range.path)\",\"audioByteLength\":\(identity.byteLength),\"audioSha256\":\"\(identity.sha256)\"}\n".utf8)
  matchingRequest.withUnsafeBytes { buffer in _ = Darwin.write(matchingDescriptors[0], buffer.baseAddress, buffer.count) }
  capability.handle(matchingDescriptors[1])
  close(matchingDescriptors[0])
  check(keychain.readCount == 1, "matching identity must permit the actual request credential read")
  check(uploadCount == 1, "matching identity must permit one network execution")
}

private func testStagedPathValidation() throws {
  let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("meetless-native-tests-\(UUID().uuidString)")
  let staging = root.appendingPathComponent("meeting-store/transcription-ranges")
  try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let range = staging.appendingPathComponent("range.mp3")
  let rangeData = Data([1, 2, 3])
  try rangeData.write(to: range)
  let loaded = try loadStagedRangeFile(
    range.path,
    stagingDirectory: staging.path,
    maximumBytes: 10,
    expectedIdentity: fixtureIdentity(rangeData)
  )
  check(loaded == rangeData, "regular staged MP3 with matching identity must pass")

  let exported = root.appendingPathComponent("export.mp3")
  try Data([1]).write(to: exported)
  expectThrow("export path must be rejected") {
    _ = try loadStagedRangeFile(exported.path, stagingDirectory: staging.path, maximumBytes: 10, expectedIdentity: fixtureIdentity(Data([1])))
  }
  expectThrow("traversal path must be rejected") {
    _ = try loadStagedRangeFile(staging.appendingPathComponent("../export.mp3").path, stagingDirectory: staging.path, maximumBytes: 10, expectedIdentity: fixtureIdentity(Data([1])))
  }
  let link = staging.appendingPathComponent("link.mp3")
  try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: range.path)
  expectThrow("symlink range must be rejected") {
    _ = try loadStagedRangeFile(link.path, stagingDirectory: staging.path, maximumBytes: 10, expectedIdentity: fixtureIdentity(rangeData))
  }
  let hardlink = staging.appendingPathComponent("hardlink.mp3")
  try FileManager.default.linkItem(at: range, to: hardlink)
  expectThrow("hardlink identity substitution must be rejected") {
    _ = try loadStagedRangeFile(hardlink.path, stagingDirectory: staging.path, maximumBytes: 10, expectedIdentity: fixtureIdentity(rangeData))
  }
  try FileManager.default.removeItem(at: hardlink)
  expectThrow("oversized range must be rejected") {
    _ = try loadStagedRangeFile(range.path, stagingDirectory: staging.path, maximumBytes: 2, expectedIdentity: fixtureIdentity(rangeData))
  }
  expectThrow("byte-length mismatch must be rejected") {
    _ = try loadStagedRangeFile(
      range.path,
      stagingDirectory: staging.path,
      maximumBytes: 10,
      expectedIdentity: StagedRangeIdentity(byteLength: 2, sha256: fixtureIdentity(rangeData).sha256)
    )
  }
  expectThrow("SHA-256 mismatch must be rejected") {
    _ = try loadStagedRangeFile(
      range.path,
      stagingDirectory: staging.path,
      maximumBytes: 10,
      expectedIdentity: StagedRangeIdentity(byteLength: 3, sha256: String(repeating: "a", count: 64))
    )
  }
}

private func testKeychainStatusDoesNotRequestData() {
  var observed: NSDictionary?
  let configured = MeetlessOpenAIKeychain(copyMatching: { query, result in
    observed = query as NSDictionary
    result?.pointee = ["service": meetlessOpenAIService] as CFDictionary
    return errSecSuccess
  })
  check(configured.status() == "configured", "existing accessible item must be configured")
  check(observed?[kSecReturnData as String] == nil, "status query must not request plaintext data")
  check((observed?[kSecReturnAttributes as String] as? Bool) == true, "status query must request only item attributes")

  let denied = MeetlessOpenAIKeychain(copyMatching: { _, _ in errSecAuthFailed })
  check(denied.status() == "invalid", "denied Keychain status must normalize to invalid")
  if case .invalid = denied.readForTranscription() {} else {
    check(false, "denied credential read must normalize to invalid")
  }
  let malformed = MeetlessOpenAIKeychain(copyMatching: { _, result in
    result?.pointee = Data("short".utf8) as CFData
    return errSecSuccess
  })
  if case .invalid = malformed.readForTranscription() {} else {
    check(false, "malformed credential must normalize to invalid")
  }
}

private func testMultipartFields() {
  let body = String(data: makeTranscriptionMultipartBody(audio: Data("audio".utf8), boundary: "BOUNDARY"), encoding: .utf8)!
  check(body.contains("name=\"model\"\r\n\r\ngpt-transcribe\r\n"), "multipart model must be fixed")
  check(body.components(separatedBy: "name=\"languages[]\"").count - 1 == 2, "languages array must use two repeated fields")
  check(body.contains("name=\"languages[]\"\r\n\r\nen\r\n"), "English language field must be exact")
  check(body.contains("name=\"languages[]\"\r\n\r\nvi\r\n"), "Vietnamese language field must be exact")
  check(!body.contains("[\"en\",\"vi\"]"), "languages array must not be encoded as JSON text")
}

private func testHostEnvironmentFiltering() {
  check(isOpenAISecretEnvironmentEntry(key: "OPENAI_API_KEY", value: "named-secret"), "host must remove OpenAI secret names")
  check(isOpenAISecretEnvironmentEntry(key: "INNOCENT_ALIAS", value: "sk-proj-abcdefghijklmnop"), "host must remove key-shaped values")
  check(!isOpenAISecretEnvironmentEntry(key: "ANTHROPIC_API_KEY", value: "anthropic-value"), "host must preserve unrelated provider configuration")
  check(!isOpenAISecretEnvironmentEntry(key: "OPENAI_BASE_URL", value: "https://example.invalid"), "host may preserve non-secret OpenAI configuration")
}

private func testCaptureSettingsFallbackPolicy() {
  check(meetlessSettingsNavigation(applicationOpened: true, fallbackOpened: false) == "system-settings-application", "supported System Settings application opening must be primary")
  check(meetlessSettingsNavigation(applicationOpened: false, fallbackOpened: true) == "best-effort-pane-url", "undocumented pane URL must be only a best-effort fallback")
  check(meetlessSettingsNavigation(applicationOpened: false, fallbackOpened: false) == "unavailable", "failed settings recovery must remain visible")
}

private func testProviderFailureNormalizationAndCancellation() {
  for statusCode in [401, 403] {
    let authSession = FakeUploadSession()
    authSession.responseCode = statusCode
    authSession.responseBody = Data("provider body with secret sk-never-return".utf8)
    do {
      _ = try OpenAITranscriber(apiKey: "fixture-key-not-real-credential", session: authSession).transcribe(audio: Data([1]))
      check(false, "\(statusCode) must fail")
    } catch OpenAITranscriptionError.invalidCredential {
    } catch {
      check(false, "\(statusCode) must normalize to invalidCredential without raw response")
    }
  }

  let timeoutSession = FakeUploadSession()
  do {
    _ = try OpenAITranscriber(
      apiKey: "fixture-key-not-real-credential",
      session: timeoutSession,
      timeout: .milliseconds(1)
    ).transcribe(audio: Data([1]))
    check(false, "timeout must fail")
  } catch {}
  check(timeoutSession.task.resumed, "upload task must start")
  check(timeoutSession.task.cancelled, "timed-out upload task must be cancelled")
}

private func testLegacyIdentityMigrationBoundary() {
  let legacy = "cdhash H\"0123456789abcdef0123456789abcdef01234567\""
  let stableDeveloperID = "identifier \"com.meetless.app\" and anchor apple generic and certificate leaf[subject.OU] = \"63M98WD275\""
  check(
    meetlessMayMigrateLegacyIdentity(
      previousRequirement: legacy,
      currentRequirement: stableDeveloperID,
      packagedSignaturePolicy: .directDeveloperID
    ),
    "verified Developer ID package must migrate one exact legacy ad-hoc identity"
  )
  check(
    !meetlessMayMigrateLegacyIdentity(
      previousRequirement: legacy,
      currentRequirement: stableDeveloperID,
      packagedSignaturePolicy: nil
    ),
    "unverified signer or team must not migrate legacy identity"
  )
  check(
    !meetlessMayMigrateLegacyIdentity(
      previousRequirement: "identifier \"com.meetless.app\" and anchor cdhash H\"abc\"",
      currentRequirement: stableDeveloperID,
      packagedSignaturePolicy: .directDeveloperID
    ),
    "non-canonical legacy requirements must not migrate"
  )
  check(
    !meetlessMayMigrateLegacyIdentity(
      previousRequirement: legacy,
      currentRequirement: legacy,
      packagedSignaturePolicy: .directDeveloperID
    ),
    "migration helper must not classify an unchanged identity as migration"
  )
  check(
    meetlessMayMigrateLegacyIdentity(
      previousRequirement: legacy,
      currentRequirement: meetlessPackagedSignatureRequirement(for: .appStoreDevelopment),
      packagedSignaturePolicy: .appStoreDevelopment
    ),
    "verified MAS Apple Development package must migrate one exact legacy ad-hoc identity"
  )
}

@main
private struct TranscriptionCapabilityTests {
  static func main() {
    if let fixtureRole = ProcessInfo.processInfo.environment["MEETLESS_NATIVE_PROCESS_FIXTURE"] {
      runNativeProcessFixture(fixtureRole)
      return
    }
    testLaunchCoordinatorLifecycle()
    testAppStoreContainerRuntimeResolutionBoundary()
    testPackagedSignaturePolicyBoundary()
    do { try testHostExecutableUsesPOSIXIdentity() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: POSIX host executable identity: \(error)\n".utf8))
    }
    testPeerAncestry()
    testBoundedRequestLine()
    do { try testFoundationJSONIdentityGoldenVector() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: Foundation JSON identity golden vector: \(error)\n".utf8))
    }
    do { try testStrictMasGateHostHandoffDecoding() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: strict MAS host handoff decoding: \(error)\n".utf8))
    }
    testMasGateArchivedRetainedRootDeviceAssurance()
    do { try testNativeProcessProtocolTransport() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: native process protocol transport: \(error)\n".utf8))
    }
    do { try testPackagedCaptureHelperRelativeConnectAndRetryIDs() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: packaged capture helper relative endpoint and retry IDs: \(error)\n".utf8))
    }
    do { try testPackagedProcessRegistrationChain() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: packaged process registration chain: \(error)\n".utf8))
    }
    do { try testCommittedRegistrationIdentityAndInspectionDiagnostics() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: committed registration identity and inspection diagnostics: \(error)\n".utf8))
    }
    do { try testStalePruneDoesNotEmitUncommittedRemoval() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: stale registration prune diagnostics: \(error)\n".utf8))
    }
    do { try testLifecycleCancellationPrecedesDiagnosticSink() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: lifecycle cancellation before diagnostic sink: \(error)\n".utf8))
    }
    do { try testRegistrationDiagnosticProductionWiring() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: registration diagnostic production wiring: \(error)\n".utf8))
    }
    do {
      let expectedNodeIdentity = try runningPackageBuilderNodeIdentity()
      try testPackageBuilderNodeSourceValidation(expectedIdentity: expectedNodeIdentity)
    } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: package-builder Node source validation: \(error)\n".utf8))
    }
    do { try testRealNodeDetachedDaemonRegistration() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: real Node detached daemon registration: \(error)\n".utf8))
    }
    do { try testRealSocketStatusResponse() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: real socket status: \(error)\n".utf8))
    }
    do { try testRuntimeEndpointGoldenVectors() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: runtime endpoint golden vectors: \(error)\n".utf8))
    }
    do { try testPackagedEndpointCompositionAndOwnership() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: packaged endpoint composition and ownership: \(error)\n".utf8))
    }
    testPremiumSocketBoundary()
    testPremiumPurchaseOutcomePolicy()
    do { try testPremiumWaitDoesNotBlockAuthorizationClearOrShutdown() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: Premium authorization lock lifecycle: \(error)\n".utf8))
    }
    do { try testConcurrentLifecycleCompletesWithinBound() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: concurrent native lifecycle: \(error)\n".utf8))
    }
    testRuntimeAuthorizationStateSnapshot()
    do { try testRegistrationDiagnosticFileSinkIsBoundedAndRetained() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: registration diagnostic sink: \(error)\n".utf8))
    }
    do { try testDelayedAuthorizedRequestIsDeniedAfterRevocation() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: delayed authorization revocation: \(error)\n".utf8))
    }
    do { try testRevocationCancelsAnAuthorizedActiveUpload() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: active authorization cancellation: \(error)\n".utf8))
    }
    testInvalidPathDoesNotRetrieveCredential()
    do { try testMismatchedIdentityDoesNotRetrieveCredentialOrUpload() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: staged identity request: \(error)\n".utf8))
    }
    do { try testStagedPathValidation() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: staged path setup: \(error)\n".utf8))
    }
    testKeychainStatusDoesNotRequestData()
    do { try testManagedAuthUsesOnlyPublicIdentityAndNonpersistentTestKeys() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: managed auth key boundary: \(error)\n".utf8))
    }
    testMultipartFields()
    testHostEnvironmentFiltering()
    testCaptureSettingsFallbackPolicy()
    testProviderFailureNormalizationAndCancellation()
    testLegacyIdentityMigrationBoundary()

    if failures > 0 { exit(1) }
    print("Meetless native transcription boundary tests passed")
  }
}
