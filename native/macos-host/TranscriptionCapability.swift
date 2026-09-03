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
let meetlessRuntimeEndpointSchema = "MEETLESS_RUNTIME_ENDPOINTS v1"
let meetlessRuntimeEndpointWorkingDirectory = "runtime-root"
let meetlessDarwinUnixSocketPathBytes = 103
let meetlessHostProcessProtocolVersion = 1
let meetlessMaximumProcessArgumentCount = 32
let meetlessMaximumProcessFieldBytes = 16 * 1024

struct MeetlessRuntimeEndpointDescriptor: Codable, Equatable {
  let role: String
  let name: String
  let bindArgument: String
  let canonicalPath: String
}

struct MeetlessRuntimeEndpointComposition: Codable, Equatable {
  let schema: String
  let mode: String
  let workingDirectory: String
  let recording: MeetlessRuntimeEndpointDescriptor
  let transcription: MeetlessRuntimeEndpointDescriptor
}

struct MeetlessHostIdentityAttestation: Codable, Equatable {
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
}

struct MeetlessProcessIdentity: Codable, Equatable {
  let configuredPath: String
  let realPath: String
  let device: Int
  let inode: Int
  let byteLength: Int
  let sha256: String
  let argv: [String]
}

struct MeetlessProcessRegistrationPolicy: Equatable {
  let runtimeRoot: String
  let endpointPolicy: String
  let endpointWorkingDirectory: String
  let recordingEndpointName: String
  let transcriptionEndpointName: String
  let nodePath: String
  let runtimeCliPath: String
  let daemonWorkerPath: String
  let daemonWorkerArguments: [String]
  let pluginPath: String
  let pluginArguments: [String]
  let captureHelperPath: String
}

struct MeetlessHostProcessPolicyWire: Codable, Equatable {
  let runtimeRoot: String
  let endpointPolicy: String
  let endpointWorkingDirectory: String
  let recordingEndpointName: String
  let transcriptionEndpointName: String
}

struct MeetlessProcessIdentityWire: Codable, Equatable {
  let configuredPath: String
  let realPath: String
  let device: Int
  let inode: Int
  let byteLength: Int
  let sha256: String
  let argv: [String]

  var identity: MeetlessProcessIdentity {
    MeetlessProcessIdentity(
      configuredPath: configuredPath,
      realPath: realPath,
      device: device,
      inode: inode,
      byteLength: byteLength,
      sha256: sha256,
      argv: argv
    )
  }
}

struct MeetlessProcessRegistrationStatus: Codable {
  let role: String
  let pid: Int32
  let attested: Bool
  let identity: MeetlessProcessIdentityWire
}

struct MeetlessDesktopAttestationResult {
  let generation: UInt64
  let ownerToken: String
  let identity: MeetlessProcessIdentity
  let hostIdentity: MeetlessHostIdentityAttestation
}

struct MeetlessChildRegistrationResult {
  let generation: UInt64
  let role: String
  let pid: Int32
  let registrationToken: String
}

enum MeetlessProcessRegistrationDiagnosticRole: String {
  case daemon
  case plugin
  case captureHelper = "capture-helper"
  case unknown
}

enum MeetlessProcessRegistrationDiagnosticStage: String {
  case input
  case authorization
  case ownership
  case inspection
}

enum MeetlessProcessRegistrationDiagnosticCheck: String {
  case malformed
  case staleGeneration = "stale-generation"
  case tokenMismatch = "token-mismatch"
  case roleMismatch = "role-mismatch"
  case policyMismatch = "policy-mismatch"
  case duplicateRoleOrSlot = "duplicate-role-or-slot"
  case parentMismatch = "parent-mismatch"
  case childIdentityMismatch = "child-identity-mismatch"
  case ownerChainFailure = "owner-chain-failure"
  case processInspectionUnavailable = "process-inspection-unavailable"
}

enum MeetlessNormalizedOSCode: String {
  case none
  case eperm = "EPERM"
  case eacces = "EACCES"
  case enoent = "ENOENT"
  case esrch = "ESRCH"
  case einval = "EINVAL"
  case eio = "EIO"
  case unknown
}

struct MeetlessProcessRegistrationFailure: Equatable {
  let role: MeetlessProcessRegistrationDiagnosticRole
  let stage: MeetlessProcessRegistrationDiagnosticStage
  let check: MeetlessProcessRegistrationDiagnosticCheck
  let osCode: MeetlessNormalizedOSCode

  var protocolReason: String {
    "role=\(role.rawValue);stage=\(stage.rawValue);check=\(check.rawValue);os=\(osCode.rawValue)"
  }

  static func role(for value: String) -> MeetlessProcessRegistrationDiagnosticRole {
    MeetlessProcessRegistrationDiagnosticRole(rawValue: value) ?? .unknown
  }
}

enum MeetlessChildRegistrationDecision {
  case accepted(MeetlessChildRegistrationResult)
  case rejected(MeetlessProcessRegistrationFailure)
}

enum MeetlessProcessInspectionError: Error, Equatable {
  case unavailable(MeetlessNormalizedOSCode)
}

struct MeetlessRegisteredProcessAttestationResult {
  let generation: UInt64
  let role: String
  let identity: MeetlessProcessIdentity
  let hostIdentity: MeetlessHostIdentityAttestation
}

func meetlessPackagedEndpoint(
  role: String,
  name: String,
  runtimeRoot: String
) throws -> MeetlessRuntimeEndpointDescriptor {
  try validateMeetlessEndpointName(role: role, name: name)
  let root = URL(fileURLWithPath: runtimeRoot).standardizedFileURL.path
  guard root.hasPrefix("/") else { throw capabilityError("runtime endpoint root must be absolute") }
  let canonical = URL(fileURLWithPath: root).appendingPathComponent(name).standardizedFileURL.path
  guard canonical != root && isMeetlessPath(canonical, descendantOf: root) else {
    throw capabilityError("\(role) endpoint \(name) escapes the canonical runtime root")
  }
  return MeetlessRuntimeEndpointDescriptor(role: role, name: name, bindArgument: name, canonicalPath: canonical)
}

func validateMeetlessEndpointName(role: String, name: String) throws {
  guard !name.isEmpty, name == name.trimmingCharacters(in: .whitespacesAndNewlines), !name.contains("\0") else {
    throw capabilityError("\(role) endpoint name is empty or contains unsafe whitespace/NUL")
  }
  guard !name.hasPrefix("/"), !name.contains("\\") else {
    throw capabilityError("\(role) endpoint name \(name) must be relative")
  }
  guard !name.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
    throw capabilityError("\(role) endpoint name \(name) contains an empty, current-directory, or parent segment")
  }
  guard name.utf8.count <= meetlessDarwinUnixSocketPathBytes else {
    throw capabilityError("\(role) endpoint name \(name) exceeds the \(meetlessDarwinUnixSocketPathBytes)-byte Darwin limit")
  }
}

private func isMeetlessPath(_ candidate: String, descendantOf parent: String) -> Bool {
  let root = URL(fileURLWithPath: parent).standardizedFileURL.path
  let child = URL(fileURLWithPath: candidate).standardizedFileURL.path
  return child.hasPrefix(root.hasSuffix("/") ? root : "\(root)/")
}

enum MeetlessCredentialRead {
  case configured(String)
  case missing
  case invalid
}

protocol MeetlessKeychainAccess {
  func status() -> String
  func readForTranscription() -> MeetlessCredentialRead
}

private struct MeetlessEndpointOwnerMarker: Codable, Equatable {
  let schema: String
  let role: String
  let endpointName: String
  let canonicalPath: String
  let pid: Int32
  let token: String
}

final class MeetlessTranscriptionCapability {
  private let endpoint: MeetlessRuntimeEndpointDescriptor
  private let workingDirectory: String
  private let packagedEndpoint: Bool
  private let stagingDirectory: String
  private let runtimeAuthorization: RuntimeAuthorizationState
  private let keychain: MeetlessKeychainAccess
  private let managedAuth: MeetlessManagedAuthAccess
  private let transcribe: (Data, String, NativeRequestCancellation) throws -> OpenAIResult
  private let leaseIssued: (() -> Void)?
  private let capturePermissions: MeetlessCapturePermissionAccess
  private let premium: MeetlessPremiumPurchaseAccess
  private let processPolicy: MeetlessProcessRegistrationPolicy?
  private var registrationReaper: DispatchSourceTimer?
  private let acceptQueue = DispatchQueue(label: "com.meetless.transcription-capability.accept", qos: .userInitiated)
  private let requestQueue = DispatchQueue(label: "com.meetless.transcription-capability.request", qos: .userInitiated, attributes: .concurrent)
  private let lifecycleLock = NSLock()
  private var listener: Int32 = -1
  private var stopped = true
  private var started = false
  private var ownerMarker: MeetlessEndpointOwnerMarker?
  private var ownsEndpoint = false

  private init(
    endpoint: MeetlessRuntimeEndpointDescriptor,
    workingDirectory: String,
    packagedEndpoint: Bool,
    stagingDirectory: String,
    runtimeAuthorization: RuntimeAuthorizationState,
    keychain: MeetlessKeychainAccess = MeetlessOpenAIKeychain(),
    transcribe: @escaping (Data, String, NativeRequestCancellation) throws -> OpenAIResult = { audio, apiKey, cancellation in
      try OpenAITranscriber(apiKey: apiKey).transcribe(audio: audio, cancellation: cancellation)
    },
    leaseIssued: (() -> Void)? = nil,
    capturePermissions: MeetlessCapturePermissionAccess = MeetlessCapturePermissions(),
    premium: MeetlessPremiumPurchaseAccess = MeetlessRevenueCatPurchaseAccess(),
    managedAuth: MeetlessManagedAuthAccess = MeetlessManagedAuthCapability(),
    processPolicy: MeetlessProcessRegistrationPolicy? = nil,
    hostIdentity: MeetlessHostIdentityAttestation? = nil,
    hostPID: pid_t = getpid()
  ) {
    self.endpoint = endpoint
    self.workingDirectory = URL(fileURLWithPath: workingDirectory).standardizedFileURL.path
    self.packagedEndpoint = packagedEndpoint
    self.stagingDirectory = URL(fileURLWithPath: stagingDirectory).standardizedFileURL.path
    self.runtimeAuthorization = runtimeAuthorization
    self.keychain = keychain
    self.transcribe = transcribe
    self.leaseIssued = leaseIssued
    self.capturePermissions = capturePermissions
    self.premium = premium
    self.managedAuth = managedAuth
    self.processPolicy = processPolicy
    if let processPolicy, let hostIdentity {
      runtimeAuthorization.configure(
        processPolicy: processPolicy,
        hostIdentity: hostIdentity,
        hostPID: hostPID
      )
    }
  }

  convenience init(
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
    managedAuth: MeetlessManagedAuthAccess = MeetlessManagedAuthCapability(),
    processPolicy: MeetlessProcessRegistrationPolicy? = nil,
    hostIdentity: MeetlessHostIdentityAttestation? = nil,
    hostPID: pid_t = getpid()
  ) {
    let canonicalPath = URL(fileURLWithPath: socketPath).standardizedFileURL.path
    self.init(
      endpoint: MeetlessRuntimeEndpointDescriptor(
        role: "transcription",
        name: canonicalPath,
        bindArgument: canonicalPath,
        canonicalPath: canonicalPath
      ),
      workingDirectory: FileManager.default.currentDirectoryPath,
      packagedEndpoint: false,
      stagingDirectory: stagingDirectory,
      runtimeAuthorization: runtimeAuthorization,
      keychain: keychain,
      transcribe: transcribe,
      leaseIssued: leaseIssued,
      capturePermissions: capturePermissions,
      premium: premium,
      managedAuth: managedAuth,
      processPolicy: processPolicy,
      hostIdentity: hostIdentity,
      hostPID: hostPID
    )
  }

  convenience init(
    endpoint: MeetlessRuntimeEndpointDescriptor,
    workingDirectory: String,
    stagingDirectory: String,
    runtimeAuthorization: RuntimeAuthorizationState,
    keychain: MeetlessKeychainAccess = MeetlessOpenAIKeychain(),
    transcribe: @escaping (Data, String, NativeRequestCancellation) throws -> OpenAIResult = { audio, apiKey, cancellation in
      try OpenAITranscriber(apiKey: apiKey).transcribe(audio: audio, cancellation: cancellation)
    },
    leaseIssued: (() -> Void)? = nil,
    capturePermissions: MeetlessCapturePermissionAccess = MeetlessCapturePermissions(),
    premium: MeetlessPremiumPurchaseAccess = MeetlessRevenueCatPurchaseAccess(),
    managedAuth: MeetlessManagedAuthAccess = MeetlessManagedAuthCapability(),
    processPolicy: MeetlessProcessRegistrationPolicy? = nil,
    hostIdentity: MeetlessHostIdentityAttestation? = nil,
    hostPID: pid_t = getpid()
  ) {
    self.init(
      endpoint: endpoint,
      workingDirectory: workingDirectory,
      packagedEndpoint: true,
      stagingDirectory: stagingDirectory,
      runtimeAuthorization: runtimeAuthorization,
      keychain: keychain,
      transcribe: transcribe,
      leaseIssued: leaseIssued,
      capturePermissions: capturePermissions,
      premium: premium,
      managedAuth: managedAuth,
      processPolicy: processPolicy,
      hostIdentity: hostIdentity,
      hostPID: hostPID
    )
  }

  func start() throws {
    try validateEndpoint()
    lifecycleLock.lock()
    guard !started else {
      lifecycleLock.unlock()
      throw capabilityError("transcription capability cannot be started more than once")
    }
    started = true
    lifecycleLock.unlock()
    do {
      try createPrivateDirectory(URL(fileURLWithPath: endpoint.canonicalPath).deletingLastPathComponent().path)
      try createPrivateDirectory(stagingDirectory)
      try reconcileEndpoint()
      let owner = MeetlessEndpointOwnerMarker(
        schema: "MEETLESS_TRANSCRIPTION_ENDPOINT_OWNER v1",
        role: "transcription",
        endpointName: endpoint.name,
        canonicalPath: endpoint.canonicalPath,
        pid: getpid(),
        token: UUID().uuidString
      )
      try writeOwnerMarker(owner)
      ownerMarker = owner

      let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
      guard descriptor >= 0 else { throw capabilityError("cannot create transcription capability socket") }
      var address = sockaddr_un()
      address.sun_family = sa_family_t(AF_UNIX)
      let pathBytes = Array(endpoint.bindArgument.utf8) + [0]
      withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: pathBytes) }
      let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
      let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, addressLength) }
      }
      guard bound == 0 else {
        let reason = errno == EADDRINUSE ? "transcription capability endpoint is concurrently occupied" : "cannot bind transcription capability socket"
        close(descriptor)
        throw capabilityError(reason)
      }
      ownsEndpoint = true
      guard Darwin.listen(descriptor, 8) == 0 else {
        close(descriptor)
        try? removeOwnedEndpoint(owner)
        ownsEndpoint = false
        throw capabilityError("cannot listen on transcription capability socket")
      }
      guard chmod(endpoint.canonicalPath, 0o600) == 0 else {
        shutdown(descriptor, SHUT_RDWR)
        close(descriptor)
        try? removeOwnedEndpoint(owner)
        throw capabilityError("cannot restrict transcription capability socket")
      }
      lifecycleLock.lock()
      stopped = false
      listener = descriptor
      lifecycleLock.unlock()
      let reaper = DispatchSource.makeTimerSource(queue: requestQueue)
      reaper.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
      reaper.setEventHandler { [weak self] in self?.runtimeAuthorization.pruneDeadRegistrations() }
      reaper.resume()
      registrationReaper = reaper
      acceptQueue.async { [weak self] in self?.acceptLoop() }
    } catch {
      lifecycleLock.lock()
      started = false
      lifecycleLock.unlock()
      if let owner = ownerMarker {
        if ownsEndpoint {
          try? removeOwnedEndpoint(owner)
          ownsEndpoint = false
        } else {
          try? removeOwnerMarker(owner, at: endpointOwnerMarkerPath(endpoint.canonicalPath))
        }
        ownerMarker = nil
      }
      throw error
    }
  }

  func stop() {
    runtimeAuthorization.clear()
    registrationReaper?.cancel()
    registrationReaper = nil
    lifecycleLock.lock()
    stopped = true
    let descriptor = listener
    listener = -1
    lifecycleLock.unlock()
    if descriptor >= 0 {
      shutdown(descriptor, SHUT_RDWR)
      close(descriptor)
    }
    if ownsEndpoint, let owner = ownerMarker {
      try? removeOwnedEndpoint(owner)
      ownsEndpoint = false
      ownerMarker = nil
    }
  }

  private func validateEndpoint() throws {
    guard endpoint.role == "transcription" else {
      throw capabilityError("transcription capability received endpoint role \(endpoint.role)")
    }
    guard endpoint.canonicalPath.hasPrefix("/") else {
      throw capabilityError("transcription endpoint canonical path must be absolute")
    }
    if packagedEndpoint {
      try validateMeetlessEndpointName(role: "transcription", name: endpoint.name)
      guard endpoint.bindArgument == endpoint.name else {
        throw capabilityError("packaged transcription bind argument must be the accepted relative endpoint name")
      }
      let expectedWorkingDirectory = URL(fileURLWithPath: workingDirectory).resolvingSymlinksInPath().standardizedFileURL.path
      let currentWorkingDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).resolvingSymlinksInPath().standardizedFileURL.path
      guard expectedWorkingDirectory == currentWorkingDirectory else {
        throw capabilityError("transcription endpoint working directory differs from the authoritative runtime root")
      }
      let projected = URL(fileURLWithPath: workingDirectory).appendingPathComponent(endpoint.name).standardizedFileURL.path
      guard projected == endpoint.canonicalPath && isMeetlessPath(projected, descendantOf: workingDirectory) else {
        throw capabilityError("transcription endpoint canonical projection leaves the runtime root")
      }
    } else {
      guard endpoint.bindArgument == endpoint.canonicalPath else {
        throw capabilityError("development transcription endpoint must retain its absolute bind path")
      }
    }
    guard endpoint.bindArgument.utf8.count <= meetlessDarwinUnixSocketPathBytes else {
      throw capabilityError("transcription capability bind argument exceeds the \(meetlessDarwinUnixSocketPathBytes)-byte Darwin limit")
    }
  }

  private func socketIsReachableThroughValidatedEndpoint() throws -> Bool {
    try validateEndpoint()
    let reachable = meetlessSocketIsReachable(endpoint.bindArgument)
    try validateEndpoint()
    return reachable
  }

  private func reconcileEndpoint() throws {
    let markerPath = endpointOwnerMarkerPath(endpoint.canonicalPath)
    let endpointState = try meetlessLstatIdentity(endpoint.canonicalPath)
    let marker = try readOwnerMarker(markerPath)
    guard let endpointState else {
      if let marker {
        if try meetlessOwnerProcessIsRunning(marker.pid) {
          throw capabilityError("transcription endpoint owner PID \(marker.pid) is still running while the socket is absent")
        }
        try removeOwnerMarker(marker, at: markerPath)
      }
      return
    }
    guard endpointState.mode & S_IFMT == S_IFSOCK else {
      throw capabilityError("transcription endpoint is occupied by a foreign non-socket entry; it was not removed")
    }
    guard endpointState.owner == geteuid() else {
      throw capabilityError("transcription endpoint is owned by a foreign user; it was not removed")
    }
    guard let marker else {
      throw capabilityError("transcription endpoint is an unknown socket without an owned marker; it was not removed")
    }
    if try meetlessOwnerProcessIsRunning(marker.pid) || socketIsReachableThroughValidatedEndpoint() {
      throw capabilityError("transcription endpoint is concurrently occupied; it was not removed")
    }
    guard let current = try meetlessLstatIdentity(endpoint.canonicalPath),
          current.mode & S_IFMT == S_IFSOCK else {
      throw capabilityError("transcription endpoint changed during stale cleanup; it was not removed")
    }
    try meetlessUnlinkIfSame(
      endpoint.canonicalPath,
      original: (mode: current.mode, device: current.device, inode: current.inode)
    )
    try removeOwnerMarker(marker, at: markerPath)
  }

  private func writeOwnerMarker(_ owner: MeetlessEndpointOwnerMarker) throws {
    let data = try JSONEncoder().encode(owner)
    try meetlessWriteExclusively(data: data, path: endpointOwnerMarkerPath(endpoint.canonicalPath))
  }

  private func readOwnerMarker(_ markerPath: String) throws -> MeetlessEndpointOwnerMarker? {
    try readEndpointOwnerMarker(markerPath, endpoint: endpoint)
  }

  private func removeOwnedEndpoint(_ owner: MeetlessEndpointOwnerMarker) throws {
    let markerPath = endpointOwnerMarkerPath(endpoint.canonicalPath)
    guard let marker = try readOwnerMarker(markerPath), marker == owner else { return }
    guard let state = try meetlessLstatIdentity(endpoint.canonicalPath) else {
      try removeOwnerMarker(owner, at: markerPath)
      return
    }
    guard state.mode & S_IFMT == S_IFSOCK, state.owner == geteuid() else {
      throw capabilityError("transcription endpoint changed to a foreign entry; it was not removed")
    }
    try meetlessUnlinkIfSame(
      endpoint.canonicalPath,
      original: (mode: state.mode, device: state.device, inode: state.inode)
    )
    try removeOwnerMarker(owner, at: markerPath)
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
    let peerPID: pid_t
    if let socketPID = socketPeerPID(client), socketPID > 1 {
      peerPID = socketPID
    } else if processPolicy == nil {
      // Development unit transports may use socketpair(), which has no
      // LOCAL_PEERPID option. Packaged capability traffic never takes this
      // branch: its peer PID is mandatory at the native boundary.
      peerPID = getpid()
    } else {
      writeHostProcessError(client, requestId: "invalid", reason: "socket peer PID is unavailable")
      return
    }
    guard let preliminaryLease = runtimeAuthorization.issueLease(
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
      requestId == requestId.trimmingCharacters(in: .whitespacesAndNewlines),
      let operation = request["operation"] as? String
    else {
      writeResponse(client, requestId: "invalid", ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
      return
    }
    if isHostProcessOperation(operation) {
      guard hasExactHostProcessRequestKeys(request, operation: operation) else {
        writeHostProcessError(client, requestId: requestId, reason: "host process protocol request shape is unsupported")
        return
      }
      guard let version = request["version"] as? NSNumber,
            CFGetTypeID(version) != CFBooleanGetTypeID(),
            version.intValue == meetlessHostProcessProtocolVersion,
            version.doubleValue == Double(meetlessHostProcessProtocolVersion) else {
        writeHostProcessError(client, requestId: requestId, reason: "host process protocol version is unsupported")
        return
      }
    }

    if operation == "desktopAttestation" {
      guard let challenge = request["challenge"] as? String,
            let attestation = runtimeAuthorization.attestDesktop(peerPID: peerPID, requestId: requestId, challenge: challenge) else {
        writeHostProcessError(client, requestId: requestId, reason: "desktop attestation challenge is invalid")
        return
      }
      writeHostProcessAttestation(
        client,
        requestId: requestId,
        challenge: challenge,
        generation: attestation.generation,
        role: "desktop",
        pid: peerPID,
        identity: attestation.identity,
        hostIdentity: attestation.hostIdentity,
        ownerToken: attestation.ownerToken
      )
      return
    }
    if operation == "registerChild" {
      guard let generation = unsignedInteger(request["generation"]),
            let ownerToken = request["ownerToken"] as? String,
            let registrationToken = request["registrationToken"] as? String,
            let role = request["role"] as? String,
            let childPID = signedInteger(request["childPid"]),
            let expected = processIdentityWire(request["expectedIdentity"]),
            let policy = processPolicyWire(request["policy"]) else {
        writeHostProcessError(client, requestId: requestId, reason: "child registration request malformed")
        return
      }
      switch runtimeAuthorization.registerChildDiagnosed(
        peerPID: peerPID,
        requestId: requestId,
        generation: generation,
        ownerToken: ownerToken,
        registrationToken: registrationToken,
        role: role,
        childPID: childPID,
        expectedIdentity: expected.identity,
        policy: policy
      ) {
      case .accepted(let registration):
        writeHostProcessRegistration(
          client,
          requestId: requestId,
          generation: registration.generation,
          role: registration.role,
          pid: registration.pid,
          registrationToken: registration.registrationToken
        )
      case .rejected(let failure):
        writeHostProcessError(client, requestId: requestId, failure: failure)
      }
      return
    }
    if operation == "processAttestation" {
      guard let generation = unsignedInteger(request["generation"]),
            let registrationToken = request["registrationToken"] as? String,
            let role = request["role"] as? String,
            let attestation = runtimeAuthorization.attestRegisteredProcess(
              peerPID: peerPID,
              requestId: requestId,
              generation: generation,
              registrationToken: registrationToken,
              role: role
            ) else {
        writeHostProcessError(client, requestId: requestId, reason: "registered process attestation failed closed")
        return
      }
      writeHostProcessAttestation(
        client,
        requestId: requestId,
        challenge: nil,
        generation: attestation.generation,
        role: attestation.role,
        pid: peerPID,
        identity: attestation.identity,
        hostIdentity: attestation.hostIdentity,
        ownerToken: nil
      )
      return
    }
    if operation == "registrationStatus" {
      guard let generation = unsignedInteger(request["generation"]),
            let ownerToken = request["ownerToken"] as? String,
            let registrations = runtimeAuthorization.registrationStatus(
              peerPID: peerPID,
              requestId: requestId,
              generation: generation,
              ownerToken: ownerToken
            ) else {
        writeHostProcessError(client, requestId: requestId, reason: "registration status is unauthorized")
        return
      }
      writeHostProcessRegistrationStatus(
        client,
        requestId: requestId,
        generation: generation,
        registrations: registrations
      )
      return
    }
    if operation == "releaseChild" {
      guard let generation = unsignedInteger(request["generation"]),
            let ownerToken = request["ownerToken"] as? String,
            let childPID = signedInteger(request["childPid"]),
            runtimeAuthorization.releaseChild(
              peerPID: peerPID,
              requestId: requestId,
              generation: generation,
              ownerToken: ownerToken,
              childPID: childPID
            ) else {
        writeHostProcessError(client, requestId: requestId, reason: "child release failed closed")
        return
      }
      writeHostProcessRelease(client, requestId: requestId, generation: generation, childPID: childPID)
      return
    }

    let lease = processPolicy == nil
      ? preliminaryLease
      : runtimeAuthorization.issueLease(
        peerPID: peerPID,
        authorizer: RuntimePeerAuthorizer(),
        requireRegistered: true
      )
    guard let lease else {
      writeResponse(client, requestId: requestId, ok: false, status: "invalid", text: nil, languages: nil, usage: nil)
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

  private func writeHostProcessAttestation(
    _ descriptor: Int32,
    requestId: String,
    challenge: String?,
    generation: UInt64,
    role: String,
    pid: pid_t,
    identity: MeetlessProcessIdentity,
    hostIdentity: MeetlessHostIdentityAttestation,
    ownerToken: String?
  ) {
    var response: [String: Any] = [
      "version": meetlessHostProcessProtocolVersion,
      "type": "host.process.attestation",
      "requestId": requestId,
      "ok": true,
      "generation": NSNumber(value: generation),
      "role": role,
      "processPid": pid,
      "identity": processIdentityObject(identity),
      "host": hostIdentityObject(hostIdentity),
    ]
    if let challenge { response["challenge"] = challenge }
    if let ownerToken { response["ownerToken"] = ownerToken }
    writeHostProcessObject(descriptor, response)
  }

  private func writeHostProcessRegistration(
    _ descriptor: Int32,
    requestId: String,
    generation: UInt64,
    role: String,
    pid: pid_t,
    registrationToken: String
  ) {
    writeHostProcessObject(descriptor, [
      "version": meetlessHostProcessProtocolVersion,
      "type": "host.process.registration",
      "requestId": requestId,
      "ok": true,
      "generation": NSNumber(value: generation),
      "role": role,
      "processPid": pid,
      "registrationToken": registrationToken,
    ])
  }

  private func writeHostProcessRegistrationStatus(
    _ descriptor: Int32,
    requestId: String,
    generation: UInt64,
    registrations: [MeetlessProcessRegistrationStatus]
  ) {
    writeHostProcessObject(descriptor, [
      "version": meetlessHostProcessProtocolVersion,
      "type": "host.process.registrations",
      "requestId": requestId,
      "ok": true,
      "generation": NSNumber(value: generation),
      "registrations": registrations.map { registration in
        [
          "role": registration.role,
          "pid": registration.pid,
          "attested": registration.attested,
          "identity": processIdentityObject(registration.identity.identity),
        ]
      },
    ])
  }

  private func writeHostProcessRelease(_ descriptor: Int32, requestId: String, generation: UInt64, childPID: pid_t) {
    writeHostProcessObject(descriptor, [
      "version": meetlessHostProcessProtocolVersion,
      "type": "host.process.release",
      "requestId": requestId,
      "ok": true,
      "generation": NSNumber(value: generation),
      "processPid": childPID,
    ])
  }

  private func writeHostProcessError(_ descriptor: Int32, requestId: String, reason: String) {
    writeHostProcessObject(descriptor, [
      "version": meetlessHostProcessProtocolVersion,
      "type": "host.process.error",
      "requestId": requestId,
      "ok": false,
      "error": reason,
    ])
  }

  private func writeHostProcessError(
    _ descriptor: Int32,
    requestId: String,
    failure: MeetlessProcessRegistrationFailure
  ) {
    writeHostProcessError(descriptor, requestId: requestId, reason: failure.protocolReason)
  }

  private func writeHostProcessObject(_ descriptor: Int32, _ response: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: response),
          data.count <= meetlessMaximumRequestLineBytes else { return }
    writeAll(descriptor, data: data + Data([10]))
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

struct MeetlessParentPIDObservation {
  let pid: pid_t?
  let osCode: MeetlessNormalizedOSCode
}

func inspectLiveParentPID(_ pid: pid_t) -> MeetlessParentPIDObservation {
  var info = proc_bsdinfo()
  let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
  let actualSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedSize)
  guard actualSize == expectedSize else {
    return MeetlessParentPIDObservation(pid: nil, osCode: meetlessNormalizedOSCode(errno))
  }
  return MeetlessParentPIDObservation(pid: pid_t(info.pbi_ppid), osCode: .none)
}

func liveParentPID(_ pid: pid_t) -> pid_t? {
  inspectLiveParentPID(pid).pid
}

func inspectMeetlessProcessIdentity(_ pid: pid_t) throws -> MeetlessProcessIdentity {
  guard pid > 1 else { throw MeetlessProcessInspectionError.unavailable(.einval) }
  var pathBuffer = [UInt8](repeating: 0, count: Int(MAXPATHLEN))
  let pathLength = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count))
  guard pathLength > 0 else {
    throw MeetlessProcessInspectionError.unavailable(meetlessNormalizedOSCode(errno))
  }
  let executablePath = String(decoding: pathBuffer.prefix(Int(pathLength)), as: UTF8.self)
  let realPath = URL(fileURLWithPath: executablePath).resolvingSymlinksInPath().standardizedFileURL.path
  var information = stat()
  guard lstat(executablePath, &information) == 0 else {
    throw MeetlessProcessInspectionError.unavailable(meetlessNormalizedOSCode(errno))
  }
  guard (information.st_mode & S_IFMT) == S_IFREG,
        information.st_size > 0 else {
    throw MeetlessProcessInspectionError.unavailable(.none)
  }
  let binary: Data
  do {
    binary = try Data(contentsOf: URL(fileURLWithPath: executablePath))
  } catch {
    throw MeetlessProcessInspectionError.unavailable(.unknown)
  }
  return MeetlessProcessIdentity(
    configuredPath: executablePath,
    realPath: realPath,
    device: Int(information.st_dev),
    inode: Int(information.st_ino),
    byteLength: Int(information.st_size),
    sha256: SHA256.hash(data: binary).map { String(format: "%02x", $0) }.joined(),
    argv: try inspectMeetlessProcessArguments(pid)
  )
}

private func inspectMeetlessProcessArguments(_ pid: pid_t) throws -> [String] {
  var mib = [CTL_KERN, KERN_PROCARGS2, pid]
  var size = 0
  guard sysctl(&mib, UInt32(mib.count), nil, &size, nil, 0) == 0,
        size > MemoryLayout<Int32>.size,
        size <= 256 * 1024 else {
    throw MeetlessProcessInspectionError.unavailable(meetlessNormalizedOSCode(errno))
  }
  var bytes = [UInt8](repeating: 0, count: size)
  guard sysctl(&mib, UInt32(mib.count), &bytes, &size, nil, 0) == 0,
        size >= MemoryLayout<Int32>.size else {
    throw MeetlessProcessInspectionError.unavailable(meetlessNormalizedOSCode(errno))
  }
  if size < bytes.count { bytes.removeSubrange(size..<bytes.count) }
  let argc = bytes.withUnsafeBytes { raw -> Int32 in
    raw.loadUnaligned(as: Int32.self)
  }
  guard argc > 0, argc <= Int32(meetlessMaximumProcessArgumentCount) else {
    throw MeetlessProcessInspectionError.unavailable(.none)
  }
  var cursor = MemoryLayout<Int32>.size
  while cursor < bytes.count && bytes[cursor] != 0 { cursor += 1 }
  while cursor < bytes.count && bytes[cursor] == 0 { cursor += 1 }
  var arguments: [String] = []
  while arguments.count < Int(argc), cursor < bytes.count {
    let start = cursor
    while cursor < bytes.count && bytes[cursor] != 0 { cursor += 1 }
    arguments.append(String(decoding: bytes[start..<cursor], as: UTF8.self))
    cursor += 1
  }
  guard arguments.count == Int(argc) else { throw MeetlessProcessInspectionError.unavailable(.none) }
  return arguments
}

func meetlessNormalizedOSCode(_ code: Int32) -> MeetlessNormalizedOSCode {
  switch code {
  case EPERM: return .eperm
  case EACCES: return .eacces
  case ENOENT: return .enoent
  case ESRCH: return .esrch
  case EINVAL: return .einval
  case EIO: return .eio
  default: return .unknown
  }
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

private func signedInteger(_ value: Any?) -> Int32? {
  guard let number = value as? NSNumber else { return nil }
  let result = number.int64Value
  guard result > 1, result <= Int64(Int32.max), Double(result) == number.doubleValue else { return nil }
  return Int32(result)
}

private func unsignedInteger(_ value: Any?) -> UInt64? {
  guard let number = value as? NSNumber else { return nil }
  let result = number.doubleValue
  guard result.isFinite, result >= 1, result.rounded() == result, result <= Double(UInt64.max) else { return nil }
  return UInt64(result)
}

private func processIdentityWire(_ value: Any?) -> MeetlessProcessIdentityWire? {
  guard let value,
        hasExactObjectKeys(value, ["argv", "byteLength", "configuredPath", "device", "inode", "realPath", "sha256"]),
        let data = try? JSONSerialization.data(withJSONObject: value),
        let wire = try? JSONDecoder().decode(MeetlessProcessIdentityWire.self, from: data),
        validProcessIdentity(wire.identity) else { return nil }
  return wire
}

private func processPolicyWire(_ value: Any?) -> MeetlessHostProcessPolicyWire? {
  guard let value,
        hasExactObjectKeys(value, ["endpointPolicy", "endpointWorkingDirectory", "recordingEndpointName", "runtimeRoot", "transcriptionEndpointName"]),
        let data = try? JSONSerialization.data(withJSONObject: value),
        let wire = try? JSONDecoder().decode(MeetlessHostProcessPolicyWire.self, from: data),
        !wire.runtimeRoot.isEmpty,
        !wire.endpointPolicy.isEmpty,
        !wire.endpointWorkingDirectory.isEmpty,
        !wire.recordingEndpointName.isEmpty,
        !wire.transcriptionEndpointName.isEmpty else { return nil }
  return wire
}

private func hasExactObjectKeys(_ value: Any, _ expected: Set<String>) -> Bool {
  guard let object = value as? [String: Any] else { return false }
  return Set(object.keys) == expected
}

private func isHostProcessOperation(_ operation: String) -> Bool {
  operation == "desktopAttestation" ||
    operation == "registerChild" ||
    operation == "processAttestation" ||
    operation == "registrationStatus" ||
    operation == "releaseChild"
}

private func hasExactHostProcessRequestKeys(_ request: [String: Any], operation: String) -> Bool {
  let expected: Set<String>
  switch operation {
  case "desktopAttestation": expected = ["challenge", "operation", "requestId", "version"]
  case "registerChild": expected = ["childPid", "expectedIdentity", "generation", "operation", "ownerToken", "policy", "registrationToken", "requestId", "role", "version"]
  case "processAttestation": expected = ["generation", "operation", "registrationToken", "requestId", "role", "version"]
  case "registrationStatus": expected = ["generation", "operation", "ownerToken", "requestId", "version"]
  case "releaseChild": expected = ["childPid", "generation", "operation", "ownerToken", "requestId", "version"]
  default: return false
  }
  return Set(request.keys) == expected
}

func validProcessIdentity(_ identity: MeetlessProcessIdentity) -> Bool {
  let fields = [identity.configuredPath, identity.realPath, identity.sha256]
  guard fields.allSatisfy({ !$0.isEmpty && $0 == $0.trimmingCharacters(in: .whitespacesAndNewlines) && !$0.contains("\0") }),
        identity.configuredPath.hasPrefix("/"),
        identity.realPath.hasPrefix("/"),
        identity.device >= 0,
        identity.inode > 0,
        identity.byteLength > 0,
        identity.sha256.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
        !identity.argv.isEmpty,
        identity.argv.count <= meetlessMaximumProcessArgumentCount,
        identity.argv.allSatisfy({ !$0.isEmpty && $0 == $0.trimmingCharacters(in: .whitespacesAndNewlines) && !$0.contains("\0") && $0.utf8.count <= meetlessMaximumProcessFieldBytes }) else {
    return false
  }
  return true
}

private func processIdentityObject(_ identity: MeetlessProcessIdentity) -> [String: Any] {
  [
    "configuredPath": identity.configuredPath,
    "realPath": identity.realPath,
    "device": identity.device,
    "inode": identity.inode,
    "byteLength": identity.byteLength,
    "sha256": identity.sha256,
    "argv": identity.argv,
  ]
}

private func hostIdentityObject(_ identity: MeetlessHostIdentityAttestation) -> [String: Any] {
  [
    "bundleIdentifier": identity.bundleIdentifier,
    "bundlePath": identity.bundlePath,
    "bundleRealPath": identity.bundleRealPath,
    "executablePath": identity.executablePath,
    "designatedRequirement": identity.designatedRequirement,
    "cdHash": identity.cdHash,
    "binarySha256": identity.binarySha256,
    "binaryDevice": identity.binaryDevice,
    "binaryInode": identity.binaryInode,
    "binarySize": identity.binarySize,
  ]
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

private func endpointOwnerMarkerPath(_ canonicalPath: String) -> String {
  "\(canonicalPath).owner.json"
}

private func meetlessLstatIdentity(_ path: String) throws -> (mode: mode_t, device: dev_t, inode: ino_t, owner: uid_t)? {
  var information = stat()
  guard lstat(path, &information) == 0 else {
    if errno == ENOENT { return nil }
    throw capabilityError("cannot inspect endpoint entry \(path): errno \(errno)")
  }
  return (information.st_mode, information.st_dev, information.st_ino, information.st_uid)
}

private func meetlessOwnerProcessIsRunning(_ pid: Int32) throws -> Bool {
  guard pid > 1 else { throw capabilityError("endpoint owner PID is invalid") }
  if kill(pid, 0) == 0 { return true }
  if errno == ESRCH { return false }
  if errno == EPERM { return true }
  throw capabilityError("cannot inspect endpoint owner PID \(pid): errno \(errno)")
}

private func meetlessSocketIsReachable(_ path: String) -> Bool {
  let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard descriptor >= 0 else { return true }
  defer { close(descriptor) }
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(path.utf8) + [0]
  guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return true }
  withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: pathBytes) }
  let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
  let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.connect(descriptor, $0, addressLength)
    }
  }
  if connected == 0 { return true }
  return errno != ECONNREFUSED && errno != ENOENT
}

private func readEndpointOwnerMarker(
  _ markerPath: String,
  endpoint: MeetlessRuntimeEndpointDescriptor
) throws -> MeetlessEndpointOwnerMarker? {
  guard let state = try meetlessLstatIdentity(markerPath) else { return nil }
  guard state.mode & S_IFMT == S_IFREG else {
    throw capabilityError("endpoint owner marker \(markerPath) is not an owned regular file")
  }
  guard state.owner == getuid(), state.mode & (S_IRWXG | S_IRWXO) == 0 else {
    throw capabilityError("endpoint owner marker \(markerPath) is not a private file owned by this runtime user")
  }
  let marker: MeetlessEndpointOwnerMarker
  do {
    marker = try JSONDecoder().decode(
      MeetlessEndpointOwnerMarker.self,
      from: Data(contentsOf: URL(fileURLWithPath: markerPath))
    )
  } catch {
    throw capabilityError("endpoint owner marker \(markerPath) is invalid: \(error.localizedDescription)")
  }
  guard marker.schema == "MEETLESS_TRANSCRIPTION_ENDPOINT_OWNER v1",
        marker.role == "transcription",
        marker.endpointName == endpoint.name,
        marker.canonicalPath == endpoint.canonicalPath,
        marker.pid > 1,
        !marker.token.isEmpty else {
    throw capabilityError("endpoint owner marker \(markerPath) does not match the accepted transcription policy")
  }
  return marker
}

private func removeOwnerMarker(_ owner: MeetlessEndpointOwnerMarker, at markerPath: String) throws {
  guard let state = try meetlessLstatIdentity(markerPath),
        state.mode & S_IFMT == S_IFREG,
        state.owner == getuid(),
        state.mode & (S_IRWXG | S_IRWXO) == 0 else { return }
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: markerPath)),
        let marker = try? JSONDecoder().decode(MeetlessEndpointOwnerMarker.self, from: data),
        marker == owner else { return }
  guard unlink(markerPath) == 0 || errno == ENOENT else {
    throw capabilityError("cannot remove owned endpoint marker \(markerPath): errno \(errno)")
  }
}

private func meetlessUnlinkIfSame(
  _ path: String,
  original: (mode: mode_t, device: dev_t, inode: ino_t)
) throws {
  guard let current = try meetlessLstatIdentity(path),
        current.mode & S_IFMT == S_IFSOCK,
        current.device == original.device,
        current.inode == original.inode else {
    throw capabilityError("endpoint changed during stale cleanup; it was not removed")
  }
  guard unlink(path) == 0 || errno == ENOENT else {
    throw capabilityError("cannot remove stale endpoint \(path): errno \(errno)")
  }
}

private func meetlessWriteExclusively(data: Data, path: String) throws {
  let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
  guard descriptor >= 0 else {
    throw capabilityError("endpoint owner marker \(path) is occupied or unavailable: errno \(errno)")
  }
  defer { close(descriptor) }
  var success = true
  data.withUnsafeBytes { buffer in
    guard let base = buffer.baseAddress else { return }
    var offset = 0
    while offset < buffer.count {
      let written = Darwin.write(descriptor, base.advanced(by: offset), buffer.count - offset)
      if written <= 0 {
        success = false
        return
      }
      offset += written
    }
  }
  guard success else {
    unlink(path)
    throw capabilityError("cannot write endpoint owner marker \(path)")
  }
  guard fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
    unlink(path)
    throw capabilityError("cannot restrict endpoint owner marker \(path)")
  }
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
