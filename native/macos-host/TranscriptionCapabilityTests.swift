import Darwin
import CryptoKit
import Foundation
import Security
@testable import MeetlessHostCore

private var failures = 0

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    failures += 1
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
  }
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
        events == ["location", "process", "configuration", "resources", "identity", "configuration-ready", "lock", "capability", "runtime"],
        "canonical launch must preserve the location, preflight, identity, lock, capability, and runtime order"
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
    return MeetlessPremiumMutationResult(outcome: "active", access: active)
  }
  func restore() -> MeetlessPremiumMutationResult {
    restoreCount += 1
    return MeetlessPremiumMutationResult(outcome: "active", access: active)
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
  let statusAccess = status?["access"] as? [String: Any]
  check(statusAccess?["status"] as? String == "inactive", "Premium status must preserve inactive access")
  let statusPackages = statusAccess?["packages"] as? [[String: Any]]
  check(statusPackages?.first?["localizedPrice"] as? String == "799.000 ₫", "Premium status must preserve only store-localized price text")

  let purchase = request("{\"version\":1,\"requestId\":\"premium-purchase\",\"operation\":\"premiumPurchase\",\"packageId\":\"monthly\"}")
  check(premium.purchasedPackage == "monthly", "Premium purchase must forward only an allowed package identifier")
  check(purchase?["outcome"] as? String == "active", "Premium purchase must return the normalized mutation outcome")
  let purchaseAccess = purchase?["access"] as? [String: Any]
  check(purchaseAccess?["status"] as? String == "active", "Premium purchase must return active entitlement state")

  let restore = request("{\"version\":1,\"requestId\":\"premium-restore\",\"operation\":\"premiumRestore\"}")
  check(premium.restoreCount == 1, "Premium restore must run only after the explicit restore request")
  check(restore?["outcome"] as? String == "active", "Premium restore must return the normalized mutation outcome")
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
  guard connected == 0 else { return true }
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
  state.publish(getpid())
  if let lease {
    check(state.withValidLease(lease, { true }) == nil, "runtime replacement must invalidate the prior generation lease")
  }
  state.clear(expected: getpid() + 1)
  check(state.snapshot() == getpid(), "unrelated termination must not clear runtime authorization")
  state.clear(expected: getpid())
  check(state.snapshot() == nil, "exact runtime termination must clear authorization")
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
      packagedDeveloperIDVerified: true
    ),
    "verified Developer ID package must migrate one exact legacy ad-hoc identity"
  )
  check(
    !meetlessMayMigrateLegacyIdentity(
      previousRequirement: legacy,
      currentRequirement: stableDeveloperID,
      packagedDeveloperIDVerified: false
    ),
    "unverified signer or team must not migrate legacy identity"
  )
  check(
    !meetlessMayMigrateLegacyIdentity(
      previousRequirement: "identifier \"com.meetless.app\" and anchor cdhash H\"abc\"",
      currentRequirement: stableDeveloperID,
      packagedDeveloperIDVerified: true
    ),
    "non-canonical legacy requirements must not migrate"
  )
  check(
    !meetlessMayMigrateLegacyIdentity(
      previousRequirement: legacy,
      currentRequirement: legacy,
      packagedDeveloperIDVerified: true
    ),
    "migration helper must not classify an unchanged identity as migration"
  )
}

@main
private struct TranscriptionCapabilityTests {
  static func main() {
    testLaunchCoordinatorLifecycle()
    do { try testHostExecutableUsesPOSIXIdentity() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: POSIX host executable identity: \(error)\n".utf8))
    }
    testPeerAncestry()
    testBoundedRequestLine()
    do { try testRealSocketStatusResponse() } catch {
      failures += 1
      FileHandle.standardError.write(Data("FAIL: real socket status: \(error)\n".utf8))
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
