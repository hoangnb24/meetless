import Darwin
import AppKit
import AVFoundation
import CoreGraphics
import CryptoKit
import Foundation
import Security

let meetlessOpenAIService = "com.meetless.openai-api-key"
let meetlessOpenAIEndpoint = "https://api.openai.com/v1/audio/transcriptions"
let meetlessOpenAIModel = "gpt-transcribe"
let meetlessOpenAILanguages = ["en", "vi"]
let meetlessMaximumRequestLineBytes = 16 * 1024
let meetlessMaximumRangeFileBytes: Int64 = 25_000_000

enum MeetlessCredentialRead {
  case configured(String)
  case missing
  case invalid
}

protocol MeetlessKeychainAccess {
  func status() -> String
  func readForTranscription() -> MeetlessCredentialRead
}

final class MeetlessTranscriptionCapability {
  private let socketPath: String
  private let stagingDirectory: String
  private let runtimeAuthorization: RuntimeAuthorizationState
  private let keychain: MeetlessKeychainAccess
  private let managedAuth: MeetlessManagedAuthAccess
  private let transcribe: (Data, String, NativeRequestCancellation) throws -> OpenAIResult
  private let leaseIssued: (() -> Void)?
  private let capturePermissions: MeetlessCapturePermissionAccess
  private let premium: MeetlessPremiumPurchaseAccess
  private let acceptQueue = DispatchQueue(label: "com.meetless.transcription-capability.accept", qos: .userInitiated)
  private let requestQueue = DispatchQueue(label: "com.meetless.transcription-capability.request", qos: .userInitiated, attributes: .concurrent)
  private let lifecycleLock = NSLock()
  private var listener: Int32 = -1
  private var stopped = true
  private var started = false

  init(
    socketPath: String,
    stagingDirectory: String,
    runtimeAuthorization: RuntimeAuthorizationState,
    keychain: MeetlessKeychainAccess = MeetlessOpenAIKeychain(),
    transcribe: @escaping (Data, String, NativeRequestCancellation) throws -> OpenAIResult = { audio, apiKey, cancellation in
      try OpenAITranscriber(apiKey: apiKey).transcribe(audio: audio, cancellation: cancellation)
    },
    leaseIssued: (() -> Void)? = nil,
    capturePermissions: MeetlessCapturePermissionAccess = MeetlessCapturePermissions(),
    premium: MeetlessPremiumPurchaseAccess = MeetlessRevenueCatPurchaseAccess(),
    managedAuth: MeetlessManagedAuthAccess = MeetlessManagedAuthCapability()
  ) {
    self.socketPath = socketPath
    self.stagingDirectory = URL(fileURLWithPath: stagingDirectory).standardizedFileURL.path
    self.runtimeAuthorization = runtimeAuthorization
    self.keychain = keychain
    self.transcribe = transcribe
    self.leaseIssued = leaseIssued
    self.capturePermissions = capturePermissions
    self.premium = premium
    self.managedAuth = managedAuth
  }

  func start() throws {
    guard socketPath.utf8.count < 104 else {
      throw capabilityError("transcription capability socket path is too long")
    }
    lifecycleLock.lock()
    guard !started else {
      lifecycleLock.unlock()
      throw capabilityError("transcription capability cannot be started more than once")
    }
    started = true
    lifecycleLock.unlock()
    try createPrivateDirectory(URL(fileURLWithPath: socketPath).deletingLastPathComponent().path)
    try createPrivateDirectory(stagingDirectory)
    unlink(socketPath)
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw capabilityError("cannot create transcription capability socket") }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8) + [0]
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: pathBytes) }
    let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
    let bound = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, addressLength) }
    }
    guard bound == 0, Darwin.listen(descriptor, 8) == 0 else {
      close(descriptor)
      throw capabilityError("cannot bind transcription capability socket")
    }
    guard chmod(socketPath, 0o600) == 0 else {
      shutdown(descriptor, SHUT_RDWR)
      close(descriptor)
      unlink(socketPath)
      throw capabilityError("cannot restrict transcription capability socket")
    }
    lifecycleLock.lock()
    stopped = false
    listener = descriptor
    lifecycleLock.unlock()
    acceptQueue.async { [weak self] in self?.acceptLoop() }
  }

  func stop() {
    runtimeAuthorization.clear()
    lifecycleLock.lock()
    stopped = true
    let descriptor = listener
    listener = -1
    lifecycleLock.unlock()
    if descriptor >= 0 {
      shutdown(descriptor, SHUT_RDWR)
      close(descriptor)
    }
    unlink(socketPath)
  }

  private func acceptLoop() {
    while let descriptor = listenerSnapshot() {
      let client = Darwin.accept(descriptor, nil, nil)
      if client < 0 {
        if listenerSnapshot() == nil { return }
        continue
      }
      requestQueue.async { [weak self] in self?.handle(client) }
    }
  }

  private func listenerSnapshot() -> Int32? {
    lifecycleLock.lock()
    defer { lifecycleLock.unlock() }
    return stopped || listener < 0 ? nil : listener
  }

  func handle(_ client: Int32) {
    defer { shutdown(client, SHUT_RDWR); close(client) }
    guard let peerPID = socketPeerPID(client), let lease = runtimeAuthorization.issueLease(
      peerPID: peerPID,
      authorizer: RuntimePeerAuthorizer()
    ) else {
      writeResponse(client, requestId: "invalid", ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
      return
    }
    leaseIssued?()
    guard
      let line = readBoundedLine(client, maximumBytes: meetlessMaximumRequestLineBytes),
      let data = line.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data),
      let request = object as? [String: Any],
      let requestId = request["requestId"] as? String,
      !requestId.isEmpty,
      let operation = request["operation"] as? String
    else {
      writeResponse(client, requestId: "invalid", ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
      return
    }
    guard runtimeAuthorization.withValidLease(lease, {}) != nil else {
      writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
      return
    }

    if operation == "managedAuthIdentity" {
      guard let identity = runtimeAuthorization.withValidLease(lease, { try? managedAuth.identity() }) ?? nil else {
        writeManagedAuthFailure(client, requestId: requestId, type: "managed.auth.identity")
        return
      }
      writeManagedAuthResponse(client, requestId: requestId, identity: identity, signature: nil)
      return
    }
    if operation == "managedAuthSignChallenge" {
      guard let encoded = request["challenge"] as? String,
            let challenge = decodeBase64Url(encoded),
            !challenge.isEmpty,
            challenge.count <= 4_096,
            let signed = (runtimeAuthorization.withValidLease(lease, { try? managedAuth.sign(challenge: challenge) }) ?? nil) else {
        writeManagedAuthFailure(client, requestId: requestId, type: "managed.auth.challenge")
        return
      }
      writeManagedAuthResponse(client, requestId: requestId, identity: signed.identity, signature: signed.signature)
      return
    }

    if operation == "status" {
      guard let status = runtimeAuthorization.withValidLease(lease, { keychain.status() }) else {
        writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
        return
      }
      writeResponse(client, requestId: requestId, ok: true, status: status, text: nil, languages: nil, usage: nil)
      return
    }
    if operation == "capturePermissionStatus" || operation == "capturePermissionRequest" || operation == "capturePermissionSettings" {
      let source = request["source"] as? String
      let result = runtimeAuthorization.withValidLease(lease) {
        if operation == "capturePermissionRequest" { return capturePermissions.request() }
        if operation == "capturePermissionSettings" { return capturePermissions.openSettings(source: source) }
        return capturePermissions.status()
      }
      guard let result else {
        writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
        return
      }
      writeCapturePermissionResponse(client, requestId: requestId, result: result)
      return
    }
    if operation == "premiumStatus" || operation == "premiumPurchase" || operation == "premiumRestore" {
      let result = runtimeAuthorization.withValidLease(lease) { () -> (String, MeetlessPremiumAccessResult, String?) in
        if operation == "premiumStatus" { return ("status", premium.status(), nil) }
        if operation == "premiumRestore" {
          let restored = premium.restore()
          return (restored.outcome, restored.access, restored.appleSignedTransaction)
        }
        guard let packageId = request["packageId"] as? String, packageId == "monthly" || packageId == "annual" else {
          return ("failed", .unavailable("store_unavailable"), nil)
        }
        let purchased = premium.purchase(packageId: packageId)
        return (purchased.outcome, purchased.access, purchased.appleSignedTransaction)
      }
      guard let result else {
        writePremiumResponse(client, requestId: requestId, ok: false, outcome: "failed", access: .unavailable("store_unavailable"))
        return
      }
      writePremiumResponse(client, requestId: requestId, ok: true, outcome: result.0, access: result.1, appleSignedTransaction: result.2)
      return
    }
    guard operation == "transcribe",
          let audioPath = request["audioPath"] as? String,
          let audioByteLength = (request["audioByteLength"] as? NSNumber)?.int64Value,
          audioByteLength > 0,
          let audioSha256 = request["audioSha256"] as? String else {
      writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
      return
    }
    let authorizedAudio = runtimeAuthorization.withValidLease(lease) {
      try? loadStagedRangeFile(
        audioPath,
        stagingDirectory: stagingDirectory,
        maximumBytes: meetlessMaximumRangeFileBytes,
        expectedIdentity: StagedRangeIdentity(byteLength: audioByteLength, sha256: audioSha256)
      )
    }
    guard let loadedAudio = authorizedAudio, let audio = loadedAudio else {
      writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
      return
    }
    let apiKey: String
    guard let credential = runtimeAuthorization.withValidLease(lease, { keychain.readForTranscription() }) else {
      writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
      return
    }
    switch credential {
    case .configured(let value): apiKey = value
    case .missing:
      writeResponse(client, requestId: requestId, ok: false, status: "missing", text: nil, languages: nil, usage: nil)
      return
    case .invalid:
      writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
      return
    }
    guard let execution = runtimeAuthorization.beginExecution(lease) else {
      writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
      return
    }
    defer { runtimeAuthorization.finishExecution(execution) }
    do {
      let result = try transcribe(audio, apiKey, execution.cancellation)
      guard runtimeAuthorization.withValidLease(lease, {}) != nil else {
        writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
        return
      }
      writeResponse(client, requestId: requestId, ok: true, status: "configured", text: result.text, languages: result.languages, usage: result.usage)
    } catch OpenAITranscriptionError.invalidCredential {
      writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
    } catch {
      let status = runtimeAuthorization.withValidLease(lease, { "configured" }) ?? "invalid"
      writeResponse(client, requestId: requestId, ok: false, status: status, text: nil, languages: nil, usage: nil)
    }
  }

  private func writeCapturePermissionResponse(_ descriptor: Int32, requestId: String, result: MeetlessCapturePermissionResult) {
    let response: [String: Any] = [
      "version": 1,
      "requestId": requestId,
      "ok": true,
      "type": "capture.permissions",
      "microphone": result.microphone.rawValue,
      "systemAudio": result.systemAudio.rawValue,
      "settingsOpened": result.settingsOpened,
      "settingsNavigation": result.settingsNavigation,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: response) else { return }
    writeAll(descriptor, data: data + Data([10]))
  }

  private func writeManagedAuthResponse(
    _ descriptor: Int32,
    requestId: String,
    identity: MeetlessManagedDeviceIdentity,
    signature: String?
  ) {
    var response: [String: Any] = [
      "version": 1,
      "requestId": requestId,
      "ok": true,
      "type": signature == nil ? "managed.auth.identity" : "managed.auth.challenge",
      "deviceId": identity.deviceId,
      "keyId": identity.keyId,
      "publicKey": identity.publicKey,
    ]
    if let signature { response["signature"] = signature }
    guard let data = try? JSONSerialization.data(withJSONObject: response) else { return }
    writeAll(descriptor, data: data + Data([10]))
  }

  private func writeManagedAuthFailure(_ descriptor: Int32, requestId: String, type: String) {
    let response: [String: Any] = [
      "version": 1,
      "requestId": requestId,
      "ok": false,
      "type": type,
      "error": "managed authentication unavailable",
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: response) else { return }
    writeAll(descriptor, data: data + Data([10]))
  }

  private func writePremiumResponse(
    _ descriptor: Int32,
    requestId: String,
    ok: Bool,
    outcome: String,
    access: MeetlessPremiumAccessResult,
    appleSignedTransaction: String? = nil
  ) {
    let packages: [[String: Any]] = access.packages.map { package in
      [
        "packageId": package.packageId,
        "productId": package.productId,
        "localizedPrice": package.localizedPrice,
        "trialEligible": package.trialEligible,
      ]
    }
    var response: [String: Any] = [
      "version": 1,
      "requestId": requestId,
      "ok": ok,
      "type": "premium.access",
      "outcome": outcome,
      "access": [
        "entitlement": meetlessPremiumEntitlement,
        "status": access.status,
        "packages": packages,
        "reason": access.reason.map { $0 as Any } ?? NSNull(),
      ],
    ]
    if let appleSignedTransaction { response["appleSignedTransaction"] = appleSignedTransaction }
    guard let data = try? JSONSerialization.data(withJSONObject: response) else { return }
    writeAll(descriptor, data: data + Data([10]))
  }

  private func writeResponse(
    _ descriptor: Int32,
    requestId: String,
    ok: Bool,
    status: String,
    text: String?,
    languages: [String]?,
    usage: [String: Double]?
  ) {
    var response: [String: Any] = ["version": 1, "requestId": requestId, "ok": ok, "status": status]
    if let text { response["text"] = text }
    if let languages { response["detectedLanguages"] = languages }
    if let usage { response["usage"] = usage }
    if !ok { response["error"] = "transcription unavailable" }
    guard let data = try? JSONSerialization.data(withJSONObject: response) else { return }
    writeAll(descriptor, data: data + Data([10]))
  }
}

enum MeetlessCapturePermissionStatus: String {
  case authorized
  case notDetermined
  case denied
  case restricted
}

struct MeetlessCapturePermissionResult {
  let microphone: MeetlessCapturePermissionStatus
  let systemAudio: MeetlessCapturePermissionStatus
  let settingsOpened: Bool
  let settingsNavigation: String
}

protocol MeetlessCapturePermissionAccess {
  func status() -> MeetlessCapturePermissionResult
  func request() -> MeetlessCapturePermissionResult
  func openSettings(source: String?) -> MeetlessCapturePermissionResult
}

final class MeetlessCapturePermissions: MeetlessCapturePermissionAccess {
  private let screenRequestKey = "MeetlessScreenCaptureRequestAttempted"

  func status() -> MeetlessCapturePermissionResult {
    result(settingsOpened: false, navigation: "none")
  }

  func request() -> MeetlessCapturePermissionResult {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
      let semaphore = DispatchSemaphore(value: 0)
      AVCaptureDevice.requestAccess(for: .audio) { _ in semaphore.signal() }
      semaphore.wait()
    }
    if !CGPreflightScreenCaptureAccess() {
      UserDefaults.standard.set(true, forKey: screenRequestKey)
      _ = onMain { CGRequestScreenCaptureAccess() }
    }
    return result(settingsOpened: false, navigation: "none")
  }

  func openSettings(source: String?) -> MeetlessCapturePermissionResult {
    let applicationURL = URL(fileURLWithPath: "/System/Applications/System Settings.app")
    let opened = onMain { NSWorkspace.shared.open(applicationURL) }
    if opened { return result(settingsOpened: true, navigation: meetlessSettingsNavigation(applicationOpened: true, fallbackOpened: false)) }

    let pane = source == "microphone"
      ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
      : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    let fallbackOpened = URL(string: pane).map { url in onMain { NSWorkspace.shared.open(url) } } ?? false
    return result(settingsOpened: fallbackOpened, navigation: meetlessSettingsNavigation(applicationOpened: false, fallbackOpened: fallbackOpened))
  }

  private func result(settingsOpened: Bool, navigation: String) -> MeetlessCapturePermissionResult {
    MeetlessCapturePermissionResult(
      microphone: microphoneStatus(AVCaptureDevice.authorizationStatus(for: .audio)),
      systemAudio: CGPreflightScreenCaptureAccess()
        ? .authorized
        : (UserDefaults.standard.bool(forKey: screenRequestKey) ? .denied : .notDetermined),
      settingsOpened: settingsOpened,
      settingsNavigation: navigation
    )
  }

  private func microphoneStatus(_ status: AVAuthorizationStatus) -> MeetlessCapturePermissionStatus {
    switch status {
    case .authorized: return .authorized
    case .notDetermined: return .notDetermined
    case .denied: return .denied
    case .restricted: return .restricted
    @unknown default: return .restricted
    }
  }

  private func onMain<T>(_ action: () -> T) -> T {
    Thread.isMainThread ? action() : DispatchQueue.main.sync(execute: action)
  }
}

func meetlessSettingsNavigation(applicationOpened: Bool, fallbackOpened: Bool) -> String {
  if applicationOpened { return "system-settings-application" }
  return fallbackOpened ? "best-effort-pane-url" : "unavailable"
}

final class RuntimePeerAuthorizer {
  private let parentPID: (pid_t) -> pid_t?

  init(parentPID: @escaping (pid_t) -> pid_t? = liveParentPID) {
    self.parentPID = parentPID
  }

  func isAuthorized(peerPID: pid_t, expectedRuntimePID: () -> pid_t?) -> Bool {
    guard peerPID > 1, let runtimePID = expectedRuntimePID(), runtimePID > 1 else { return false }
    var current = peerPID
    var visited = Set<pid_t>()
    for _ in 0..<64 {
      guard current > 1, visited.insert(current).inserted else { return false }
      if current == runtimePID { return expectedRuntimePID() == runtimePID }
      guard let parent = parentPID(current) else { return false }
      current = parent
    }
    return false
  }
}

func socketPeerPID(_ descriptor: Int32) -> pid_t? {
  var pid: pid_t = 0
  var length = socklen_t(MemoryLayout<pid_t>.size)
  guard getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, length == MemoryLayout<pid_t>.size else {
    return nil
  }
  return pid
}

func liveParentPID(_ pid: pid_t) -> pid_t? {
  var info = proc_bsdinfo()
  let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
  let actualSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedSize)
  guard actualSize == expectedSize else { return nil }
  return pid_t(info.pbi_ppid)
}

func readBoundedLine(_ descriptor: Int32, maximumBytes: Int) -> String? {
  var bytes = Data()
  var byte: UInt8 = 0
  while bytes.count <= maximumBytes {
    let count = Darwin.read(descriptor, &byte, 1)
    if count <= 0 { return nil }
    if byte == 10 { return String(data: bytes, encoding: .utf8) }
    bytes.append(byte)
  }
  return nil
}

struct StagedRangeIdentity {
  let byteLength: Int64
  let sha256: String
}

func loadStagedRangeFile(
  _ filePath: String,
  stagingDirectory: String,
  maximumBytes: Int64,
  expectedIdentity: StagedRangeIdentity
) throws -> Data {
  let staging = URL(fileURLWithPath: stagingDirectory).standardizedFileURL.path
  let candidate = URL(fileURLWithPath: filePath).standardizedFileURL.path
  let relative = URL(fileURLWithPath: candidate).path.replacingOccurrences(of: staging + "/", with: "")
  guard candidate.hasPrefix(staging + "/"), !relative.contains("/"), relative.hasSuffix(".mp3") else {
    throw capabilityError("staged transcription range is outside the private staging directory")
  }
  guard URL(fileURLWithPath: candidate).resolvingSymlinksInPath().path == candidate else {
    throw capabilityError("staged transcription range must not use symlinks")
  }
  let descriptor = open(candidate, O_RDONLY | O_NOFOLLOW)
  guard descriptor >= 0 else { throw capabilityError("staged transcription range cannot be opened") }
  let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  var stats = stat()
  guard fstat(descriptor, &stats) == 0,
        (stats.st_mode & S_IFMT) == S_IFREG,
        stats.st_uid == geteuid(),
        stats.st_nlink == 1 else {
    try? handle.close()
    throw capabilityError("staged transcription range must be a regular file")
  }
  guard stats.st_size > 0,
        stats.st_size <= maximumBytes,
        stats.st_size == expectedIdentity.byteLength else {
    try? handle.close()
    throw capabilityError("staged transcription range exceeds the 25 MB request boundary")
  }
  guard let data = try handle.readToEnd(), data.count == stats.st_size else {
    throw capabilityError("staged transcription range could not be read completely")
  }
  let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  guard expectedIdentity.sha256.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
        digest == expectedIdentity.sha256 else {
    throw capabilityError("staged transcription range identity does not match the authorized request")
  }
  return data
}

final class MeetlessOpenAIKeychain: MeetlessKeychainAccess {
  typealias CopyMatching = (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
  private let copyMatching: CopyMatching

  init(copyMatching: @escaping CopyMatching = { SecItemCopyMatching($0, $1) }) {
    self.copyMatching = copyMatching
  }

  func status() -> String {
    var result: CFTypeRef?
    let code = copyMatching(query(returnData: false), &result)
    if code == errSecItemNotFound { return "missing" }
    return code == errSecSuccess ? "configured" : "invalid"
  }

  func readForTranscription() -> MeetlessCredentialRead {
    var result: CFTypeRef?
    let code = copyMatching(query(returnData: true), &result)
    if code == errSecItemNotFound { return .missing }
    guard code == errSecSuccess,
          let data = result as? Data,
          let key = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
          valid(key) else { return .invalid }
    return .configured(key)
  }

  private func query(returnData: Bool) -> CFDictionary {
    var values: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: meetlessOpenAIService,
      kSecAttrAccount as String: NSUserName(),
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    if returnData {
      values[kSecReturnData as String] = true
    } else {
      values[kSecReturnAttributes as String] = true
    }
    return values as CFDictionary
  }

  private func valid(_ key: String) -> Bool {
    key.count >= 20 && !key.contains("\n") && !key.contains("\r")
  }
}

struct OpenAIResult {
  let text: String
  let languages: [String]
  let usage: [String: Double]?
}

enum OpenAITranscriptionError: Error {
  case invalidCredential
  case unavailable
}

protocol MeetlessUploadTask {
  func resume()
  func cancel()
}

protocol MeetlessUploadSession {
  func uploadTask(
    request: URLRequest,
    body: Data,
    completion: @escaping @Sendable (Data?, URLResponse?, Error?) -> Void
  ) -> MeetlessUploadTask
}

final class NativeRequestCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var action: (() -> Void)?

  func install(_ action: @escaping () -> Void) -> Bool {
    lock.lock()
    guard !cancelled else {
      lock.unlock()
      return false
    }
    self.action = action
    lock.unlock()
    return true
  }

  func cancel() {
    lock.lock()
    guard !cancelled else {
      lock.unlock()
      return
    }
    cancelled = true
    let action = self.action
    self.action = nil
    lock.unlock()
    action?()
  }

  func finish() {
    lock.lock()
    action = nil
    lock.unlock()
  }

  func isCancelled() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }
}

extension URLSessionUploadTask: MeetlessUploadTask {}

final class SharedUploadSession: MeetlessUploadSession {
  func uploadTask(
    request: URLRequest,
    body: Data,
    completion: @escaping @Sendable (Data?, URLResponse?, Error?) -> Void
  ) -> MeetlessUploadTask {
    URLSession.shared.uploadTask(with: request, from: body, completionHandler: completion)
  }
}

private final class UploadCompletion: @unchecked Sendable {
  private let lock = NSLock()
  private var data: Data?
  private var response: URLResponse?

  func set(data: Data?, response: URLResponse?) {
    lock.lock()
    self.data = data
    self.response = response
    lock.unlock()
  }

  func snapshot() -> (Data?, URLResponse?) {
    lock.lock()
    defer { lock.unlock() }
    return (data, response)
  }
}

final class OpenAITranscriber {
  private let apiKey: String
  private let session: MeetlessUploadSession
  private let timeout: DispatchTimeInterval

  init(apiKey: String, session: MeetlessUploadSession = SharedUploadSession(), timeout: DispatchTimeInterval = .seconds(300)) {
    self.apiKey = apiKey
    self.session = session
    self.timeout = timeout
  }

  func transcribe(audio: Data, cancellation: NativeRequestCancellation = NativeRequestCancellation()) throws -> OpenAIResult {
    let boundary = "MeetlessBoundary\(UUID().uuidString)"
    let body = makeTranscriptionMultipartBody(audio: audio, boundary: boundary)
    guard let url = URL(string: meetlessOpenAIEndpoint) else { throw OpenAITranscriptionError.unavailable }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    let semaphore = DispatchSemaphore(value: 0)
    let completion = UploadCompletion()
    let task = session.uploadTask(request: request, body: body) { data, response, _ in
      completion.set(data: data, response: response)
      semaphore.signal()
    }
    guard cancellation.install({ task.cancel(); semaphore.signal() }) else {
      task.cancel()
      throw OpenAITranscriptionError.unavailable
    }
    defer { cancellation.finish() }
    task.resume()
    guard semaphore.wait(timeout: .now() + timeout) == .success else {
      task.cancel()
      throw OpenAITranscriptionError.unavailable
    }
    guard !cancellation.isCancelled() else { throw OpenAITranscriptionError.unavailable }
    let (responseData, response) = completion.snapshot()
    let responseCode = (response as? HTTPURLResponse)?.statusCode ?? 0
    if responseCode == 401 || responseCode == 403 { throw OpenAITranscriptionError.invalidCredential }
    guard responseCode >= 200 && responseCode < 300, let responseData else {
      throw OpenAITranscriptionError.unavailable
    }
    guard let json = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any],
          let text = json["text"] as? String else { throw OpenAITranscriptionError.unavailable }
    let languages = (json["languages"] as? [[String: Any]])?.compactMap { $0["code"] as? String }
      ?? ((json["languages"] as? [String]) ?? ((json["language"] as? String).map { [$0] } ?? []))
    var usage: [String: Double] = [:]
    if let values = json["usage"] as? [String: Any] {
      for (key, value) in values {
        if let number = value as? NSNumber {
          switch key {
          case "input_tokens": usage["inputTokens"] = number.doubleValue
          case "output_tokens": usage["outputTokens"] = number.doubleValue
          case "total_tokens": usage["totalTokens"] = number.doubleValue
          case "duration", "duration_seconds", "seconds": usage["durationSeconds"] = number.doubleValue
          default: break
          }
        }
      }
    }
    return OpenAIResult(text: text, languages: languages, usage: usage.isEmpty ? nil : usage)
  }
}

func makeTranscriptionMultipartBody(audio: Data, boundary: String) -> Data {
  var body = Data()
  appendMultipartPart(&body, boundary: boundary, name: "model", value: meetlessOpenAIModel)
  for language in meetlessOpenAILanguages {
    appendMultipartPart(&body, boundary: boundary, name: "languages[]", value: language)
  }
  body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"range.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n".utf8))
  body.append(audio)
  body.append(Data("\r\n--\(boundary)--\r\n".utf8))
  return body
}

private func appendMultipartPart(_ body: inout Data, boundary: String, name: String, value: String) {
  body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
}

private func createPrivateDirectory(_ path: String) throws {
  try FileManager.default.createDirectory(
    atPath: path,
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o700]
  )
  guard URL(fileURLWithPath: path).resolvingSymlinksInPath().path == URL(fileURLWithPath: path).standardizedFileURL.path else {
    throw capabilityError("private transcription directory must not use symlinks")
  }
  guard chmod(path, 0o700) == 0 else { throw capabilityError("cannot restrict private transcription directory") }
}

private func writeAll(_ descriptor: Int32, data: Data) {
  data.withUnsafeBytes { buffer in
    guard let base = buffer.baseAddress else { return }
    var offset = 0
    while offset < buffer.count {
      let count = Darwin.write(descriptor, base.advanced(by: offset), buffer.count - offset)
      if count <= 0 { return }
      offset += count
    }
  }
}

func capabilityError(_ message: String) -> NSError {
  NSError(domain: "MeetlessTranscriptionCapability", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
