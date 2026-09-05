import AppKit
import CryptoKit
import Darwin
import Foundation

private let meetlessInstallPath = "/Applications/Meetless.app"
private let meetlessBundleIdentifier = "com.meetless.app"
private let meetlessDeveloperIDTeam = "63M98WD275"
private let meetlessDeveloperIDRequirement = "identifier \"com.meetless.app\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"63M98WD275\""
private let meetlessAppStoreDevelopmentIdentity = "Apple Development: Long Le (335C7MY4H4)"
private let meetlessAppStoreDevelopmentRequirement = "identifier \"com.meetless.app\" and anchor apple generic and certificate leaf[subject.CN] = \"Apple Development: Long Le (335C7MY4H4)\" and certificate leaf[subject.OU] = \"63M98WD275\""
private let meetlessHostConfigSchema = "MEETLESS_MACOS_HOST_CONFIG v2"
private let meetlessInstallationContractSchema = "MEETLESS_INSTALLATION_CONTRACT v1"
private let meetlessPackageSchema = "MEETLESS_MACOS_PACKAGE v2"
private let meetlessDirectRuntimeRootRelativePath = "Library/Application Support/Meetless"
private let meetlessAppStoreContainerSupportRelativePath = "Library/Containers/com.meetless.app/Data/Library/Application Support"
private let meetlessAppStoreRuntimeRootRelativePath = "\(meetlessAppStoreContainerSupportRelativePath)/Meetless"
private let meetlessAppStoreRecordingExportsRelativePath = "\(meetlessAppStoreContainerSupportRelativePath)/Meetless/recordings"
private let meetlessMasGateLockFilename = ".meetless-mas-gate.lock"
private let meetlessMasGateActiveFilename = ".meetless-mas-gate-session.active"
private let meetlessMasGateIndexFilename = ".meetless-mas-gate-session.index"
private let meetlessMasGateIndexIntentFilename = ".meetless-mas-gate-session.index-intent"
private let meetlessMasGateActiveIntentSuffix = ".active-intent"
private let meetlessMasGateHandoffFilename = "host-handoff.json"
private let meetlessMasGateTransactionSchema = "MAS_GATE_SESSION_TRANSACTION v2"
private let meetlessMasGateIndexSchema = "MAS_GATE_SESSION_INDEX v1"
private let meetlessMasGateIndexIntentSchema = "MAS_GATE_SESSION_INDEX_INTENT v1"
private let meetlessMasGateHandoffSchema = "MAS_GATE_HOST_HANDOFF v1"
private let meetlessMasGateMaxIndexEntries = 256
private let meetlessMasGateMaxFixedRecordBytes = 1024 * 1024
private let meetlessMasGateSessionPhases: Set<String> = [
  "construction-intent", "prepared", "quarantine-intent", "quarantined",
  "fresh-intent", "fresh-created", "ready", "detach-intent", "fresh-retained",
  "restore-intent", "restored", "archive-intent", "archived"
]

struct MeetlessLaunchCoordinator<Configuration> {
  let locationCheck: () throws -> Void
  let processCheck: () throws -> Void
  let guidance: (String) -> Void
  let configurationCheck: () throws -> Configuration
  let resourceCheck: (Configuration) throws -> Void
  let identity: (Configuration) throws -> Void
  let configurationReady: (Configuration) -> Void
  let lock: (Configuration) throws -> Void
  let capability: (Configuration) throws -> Void
  let runtime: (Configuration) throws -> Void

  @discardableResult
  func run() throws -> Configuration {
    do {
      try locationCheck()
    } catch {
      guidance(error.localizedDescription)
      throw error
    }
    try processCheck()
    let configuration = try configurationCheck()
    try resourceCheck(configuration)
    configurationReady(configuration)
    try lock(configuration)
    try identity(configuration)
    try capability(configuration)
    try runtime(configuration)
    return configuration
  }
}

enum MeetlessPackagedSignaturePolicy: Equatable {
  case directDeveloperID
  case appStoreDevelopment
}

enum MeetlessInstallLocation {
  static func validate(lexicalPath: String, resolvedPath: String) throws {
    guard lexicalPath == meetlessInstallPath else {
      throw NSError(
        domain: "MeetlessHost.InstallLocation",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Move Meetless.app to /Applications/Meetless.app, then open the copy there. Do not launch Meetless from a mounted disk image or another folder."]
      )
    }
    guard resolvedPath == meetlessInstallPath else {
      throw NSError(
        domain: "MeetlessHost.InstallLocation",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Meetless.app is reached through a symlink. Move the real app to /Applications/Meetless.app, then open that copy. Do not launch from a mounted disk image or another folder."]
      )
    }
  }
}

private struct HostConfiguration: Codable {
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

private struct HostConfigurationFile: Decodable {
  let schema: String
  let mode: String
  let bundleIdentifier: String
  let packageRoot: String?
  let installationContract: String?
  let installationContractSha256: String?
  let runtimeRootRelativeToUserHome: String?
  let identityRelativeToRuntimeRoot: String?
  let repositoryRoot: String?
  let runtimeRoot: String?
  let listen: String?
  let rendererOrigin: String?
  let transcriptionSocketRelativeToRuntimeRoot: String?
  let transcriptionStagingRelativeToRuntimeRoot: String?
  let endpointPolicy: String?
  let endpointWorkingDirectory: String?
  let recordingEndpointName: String?
  let transcriptionEndpointName: String?
  let transcriptionSocket: String?
  let transcriptionStaging: String?
  let nodePath: String?
  let runtimeCliPath: String?
  let identityPath: String?
}

private struct InstallationPackageContract: Decodable {
  let rootRelativeToBundle: String
  let markerFilename: String
  let contractFilename: String
  let hostConfigRelativeToBundle: String
  let resources: [String: String]
}

private struct InstallationEndpointPolicy: Decodable {
  let schema: String
  let workingDirectory: String
  let recordingEndpointName: String
  let transcriptionEndpointName: String
}

private struct InstallationRuntimeContract: Decodable {
  let paseoHomeRelativePath: String
  let electronUserDataRelativePath: String
  let meetingStoreRelativePath: String
  let logsRelativePath: String
  let daemonLogRelativePath: String
  let manifestRelativePath: String
  let recordingSocketRelativePath: String
  let transcriptionSocketRelativePath: String
  let transcriptionStagingRelativePath: String
  let endpointPolicy: InstallationEndpointPolicy
}

private struct InstallationContract: Decodable {
  let schema: String
  let bundleIdentifier: String
  let installPath: String
  let userSupportRelativePath: String
  let recordingExportsRelativePath: String
  let identityRelativePath: String
  let runtime: InstallationRuntimeContract
  let listen: String
  let rendererOrigin: String
  let package: InstallationPackageContract
  let host: [String: String]
  let dmg: [String: String]
}

private struct PackageMarker: Decodable {
  let schema: String
  let target: String
  let bundleIdentifier: String
  let paseoCommit: String
  let listen: String
  let rendererOrigin: String
  let installationContract: String
  let installationContractSha256: String
  let hostBundlePath: String
  let resources: [String: String]
}

private struct HostIdentityDocument: Codable {
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
  let configuration: HostConfiguration
}

struct MasGateRootIdentity: Codable {
  let type: String
  let mode: Int64
  let uid: Int64
  let gid: Int64
  let dev: Int64
  let ino: Int64
  let nlink: Int64
  let size: Int64

  private enum CodingKeys: String, CodingKey {
    case type, mode, uid, gid, dev, ino, nlink, size
  }

  init(type: String, mode: Int64, uid: Int64, gid: Int64, dev: Int64, ino: Int64, nlink: Int64, size: Int64) {
    self.type = type
    self.mode = mode
    self.uid = uid
    self.gid = gid
    self.dev = dev
    self.ino = ino
    self.nlink = nlink
    self.size = size
  }

  init(from decoder: Decoder) throws {
    try assertExactMasGateKeys(
      decoder,
      expected: ["type", "mode", "uid", "gid", "dev", "ino", "nlink", "size"],
      label: "MAS fresh-root identity"
    )
    let container = try decoder.container(keyedBy: CodingKeys.self)
    type = try container.decode(String.self, forKey: .type)
    mode = try container.decode(Int64.self, forKey: .mode)
    uid = try container.decode(Int64.self, forKey: .uid)
    gid = try container.decode(Int64.self, forKey: .gid)
    dev = try container.decode(Int64.self, forKey: .dev)
    ino = try container.decode(Int64.self, forKey: .ino)
    nlink = try container.decode(Int64.self, forKey: .nlink)
    size = try container.decode(Int64.self, forKey: .size)
  }
}

private struct MasGateLockIdentity {
  let dev: Int64
  let ino: Int64
  let mode: Int64
  let uid: Int64
}

private struct MasGateSessionJournal: Decodable {
  let schema: String
  let version: Int
  let ownerToken: String
  let runId: String
  let canonicalRuntimeRoot: String
  let parentPath: String
  let lockPath: String
  let activePath: String
  let constructionPath: String
  let constructionIntentPath: String?
  let quarantinePath: String
  let freshRetainedPath: String
  let archivePath: String?
  let priorExists: Bool
  let stateScope: String
  let phase: String
  let freshRootIdentity: MasGateRootIdentity?
}

private struct StrictMasGateCodingKey: CodingKey {
  let stringValue: String
  let intValue: Int? = nil

  init?(stringValue: String) {
    self.stringValue = stringValue
  }

  init?(intValue: Int) {
    return nil
  }
}

private func assertStrictMasGateKeys(_ decoder: Decoder, allowed: Set<String>, label: String) throws {
  let container = try decoder.container(keyedBy: StrictMasGateCodingKey.self)
  if let unknown = container.allKeys.map(\.stringValue).first(where: { !allowed.contains($0) }) {
    throw DecodingError.dataCorrupted(
      .init(codingPath: decoder.codingPath, debugDescription: "\(label) contains unknown field \(unknown)")
    )
  }
}

private func assertExactMasGateKeys(_ decoder: Decoder, expected: Set<String>, label: String) throws {
  let container = try decoder.container(keyedBy: StrictMasGateCodingKey.self)
  let actual = Set(container.allKeys.map(\.stringValue))
  guard actual == expected else {
    let missing = expected.subtracting(actual).sorted().joined(separator: ",")
    let extra = actual.subtracting(expected).sorted().joined(separator: ",")
    throw DecodingError.dataCorrupted(
      .init(codingPath: decoder.codingPath, debugDescription: "\(label) has non-exact keys; missing=[\(missing)] extra=[\(extra)]")
    )
  }
}

private struct MasGateSessionIndexEntry: Decodable {
  let runId: String
  let activePath: String
  let constructionPath: String
  let constructionIntentPath: String
  let quarantinePath: String
  let freshRetainedPath: String
  let archivePath: String

  private enum CodingKeys: String, CodingKey {
    case runId, activePath, constructionPath, constructionIntentPath, quarantinePath, freshRetainedPath, archivePath
  }

  init(
    runId: String,
    activePath: String,
    constructionPath: String,
    constructionIntentPath: String,
    quarantinePath: String,
    freshRetainedPath: String,
    archivePath: String
  ) {
    self.runId = runId
    self.activePath = activePath
    self.constructionPath = constructionPath
    self.constructionIntentPath = constructionIntentPath
    self.quarantinePath = quarantinePath
    self.freshRetainedPath = freshRetainedPath
    self.archivePath = archivePath
  }

  init(from decoder: Decoder) throws {
    try assertStrictMasGateKeys(decoder, allowed: ["runId", "activePath", "constructionPath", "constructionIntentPath", "quarantinePath", "freshRetainedPath", "archivePath"], label: "MAS session index entry")
    let container = try decoder.container(keyedBy: CodingKeys.self)
    runId = try container.decode(String.self, forKey: .runId)
    activePath = try container.decode(String.self, forKey: .activePath)
    constructionPath = try container.decode(String.self, forKey: .constructionPath)
    constructionIntentPath = try container.decode(String.self, forKey: .constructionIntentPath)
    quarantinePath = try container.decode(String.self, forKey: .quarantinePath)
    freshRetainedPath = try container.decode(String.self, forKey: .freshRetainedPath)
    archivePath = try container.decode(String.self, forKey: .archivePath)
  }
}

private struct MasGateSessionIndex: Decodable {
  let schema: String
  let version: Int
  let runtimeRoot: String
  let parentPath: String
  let activePath: String
  let indexPath: String
  let indexIntentPath: String
  let entries: [MasGateSessionIndexEntry]

  private enum CodingKeys: String, CodingKey {
    case schema, version, runtimeRoot, parentPath, activePath, indexPath, indexIntentPath, entries
  }

  init(from decoder: Decoder) throws {
    try assertStrictMasGateKeys(decoder, allowed: ["schema", "version", "runtimeRoot", "parentPath", "activePath", "indexPath", "indexIntentPath", "entries"], label: "MAS session index")
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schema = try container.decode(String.self, forKey: .schema)
    version = try container.decode(Int.self, forKey: .version)
    runtimeRoot = try container.decode(String.self, forKey: .runtimeRoot)
    parentPath = try container.decode(String.self, forKey: .parentPath)
    activePath = try container.decode(String.self, forKey: .activePath)
    indexPath = try container.decode(String.self, forKey: .indexPath)
    indexIntentPath = try container.decode(String.self, forKey: .indexIntentPath)
    entries = try container.decode([MasGateSessionIndexEntry].self, forKey: .entries)
  }
}

private struct MasGateSessionIndexIntent: Decodable {
  let schema: String
  let version: Int
  let state: String
  let operation: String
  let runtimeRoot: String
  let parentPath: String
  let indexPath: String
  let sourcePath: String?
  let destinationPath: String?
  let before: MasGateSessionIndex?
  let after: MasGateSessionIndex
  let transaction: MasGateSessionJournal

  private enum CodingKeys: String, CodingKey {
    case schema, version, state, operation, runtimeRoot, parentPath, indexPath, sourcePath, destinationPath, before, after, transaction
  }

  init(from decoder: Decoder) throws {
    try assertStrictMasGateKeys(decoder, allowed: ["schema", "version", "state", "operation", "runtimeRoot", "parentPath", "indexPath", "sourcePath", "destinationPath", "before", "after", "transaction"], label: "MAS session index intent")
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schema = try container.decode(String.self, forKey: .schema)
    version = try container.decode(Int.self, forKey: .version)
    state = try container.decode(String.self, forKey: .state)
    operation = try container.decode(String.self, forKey: .operation)
    runtimeRoot = try container.decode(String.self, forKey: .runtimeRoot)
    parentPath = try container.decode(String.self, forKey: .parentPath)
    indexPath = try container.decode(String.self, forKey: .indexPath)
    sourcePath = try container.decodeIfPresent(String.self, forKey: .sourcePath)
    destinationPath = try container.decodeIfPresent(String.self, forKey: .destinationPath)
    before = try container.decodeIfPresent(MasGateSessionIndex.self, forKey: .before)
    after = try container.decode(MasGateSessionIndex.self, forKey: .after)
    transaction = try container.decode(MasGateSessionJournal.self, forKey: .transaction)
  }
}

struct MasGateHostHandoff: Codable {
  let schema: String
  let version: Int
  let ownerToken: String
  let runId: String
  var state: String
  let phase: String
  let canonicalRuntimeRoot: String
  let parentPath: String
  let activePath: String
  let freshRootIdentity: MasGateRootIdentity
  let identityRelativePath: String
  let identityPath: String
  let bundlePath: String
  let bundleRealPath: String
  let executablePath: String
  let bundleIdentifier: String
  let designatedRequirement: String
  let cdHash: String
  let binarySha256: String
  let binaryDevice: Int64
  let binaryInode: Int64
  let binarySize: Int64
  var claimedByPid: Int32?
  var claimedAt: String?

  private enum CodingKeys: String, CodingKey {
    case schema, version, ownerToken, runId, state, phase, canonicalRuntimeRoot, parentPath, activePath
    case freshRootIdentity, identityRelativePath, identityPath, bundlePath, bundleRealPath, executablePath
    case bundleIdentifier, designatedRequirement, cdHash, binarySha256, binaryDevice, binaryInode, binarySize
    case claimedByPid, claimedAt
  }

  init(from decoder: Decoder) throws {
    try assertExactMasGateKeys(
      decoder,
      expected: [
        "schema", "version", "ownerToken", "runId", "state", "phase", "canonicalRuntimeRoot", "parentPath", "activePath",
        "freshRootIdentity", "identityRelativePath", "identityPath", "bundlePath", "bundleRealPath", "executablePath",
        "bundleIdentifier", "designatedRequirement", "cdHash", "binarySha256", "binaryDevice", "binaryInode", "binarySize",
        "claimedByPid", "claimedAt",
      ],
      label: "MAS host handoff"
    )
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schema = try container.decode(String.self, forKey: .schema)
    version = try container.decode(Int.self, forKey: .version)
    ownerToken = try container.decode(String.self, forKey: .ownerToken)
    runId = try container.decode(String.self, forKey: .runId)
    state = try container.decode(String.self, forKey: .state)
    phase = try container.decode(String.self, forKey: .phase)
    canonicalRuntimeRoot = try container.decode(String.self, forKey: .canonicalRuntimeRoot)
    parentPath = try container.decode(String.self, forKey: .parentPath)
    activePath = try container.decode(String.self, forKey: .activePath)
    freshRootIdentity = try container.decode(MasGateRootIdentity.self, forKey: .freshRootIdentity)
    identityRelativePath = try container.decode(String.self, forKey: .identityRelativePath)
    identityPath = try container.decode(String.self, forKey: .identityPath)
    bundlePath = try container.decode(String.self, forKey: .bundlePath)
    bundleRealPath = try container.decode(String.self, forKey: .bundleRealPath)
    executablePath = try container.decode(String.self, forKey: .executablePath)
    bundleIdentifier = try container.decode(String.self, forKey: .bundleIdentifier)
    designatedRequirement = try container.decode(String.self, forKey: .designatedRequirement)
    cdHash = try container.decode(String.self, forKey: .cdHash)
    binarySha256 = try container.decode(String.self, forKey: .binarySha256)
    binaryDevice = try container.decode(Int64.self, forKey: .binaryDevice)
    binaryInode = try container.decode(Int64.self, forKey: .binaryInode)
    binarySize = try container.decode(Int64.self, forKey: .binarySize)
    claimedByPid = try container.decodeIfPresent(Int32.self, forKey: .claimedByPid)
    claimedAt = try container.decodeIfPresent(String.self, forKey: .claimedAt)
  }
}

func decodeStrictMasGateHostHandoff(_ data: Data) throws -> MasGateHostHandoff {
  try JSONDecoder().decode(MasGateHostHandoff.self, from: data)
}

struct MeetlessExecutableIdentity {
  let device: Int
  let inode: Int
  let size: Int
}

func inspectMeetlessExecutableIdentity(_ path: String) throws -> MeetlessExecutableIdentity {
  var information = stat()
  guard lstat(path, &information) == 0,
        (information.st_mode & S_IFMT) == S_IFREG,
        information.st_size > 0 else {
    throw hostPreflightError("cannot inspect MeetlessHost executable metadata")
  }
  return MeetlessExecutableIdentity(
    device: Int(information.st_dev),
    inode: Int(information.st_ino),
    size: Int(information.st_size)
  )
}

private struct OwnedProcessRegistry: Decodable {
  struct Group: Decodable { let name: String; let pgid: Int32 }
  let version: Int
  let hostPid: Int32?
  let desktopPid: Int32
  let groups: [Group]
}

private func logError(_ message: String) {
  FileHandle.standardError.write(Data("MeetlessHost: \(message)\n".utf8))
  NSLog("MeetlessHost: %@", message)
}

final class MeetlessProcessRegistrationDiagnosticFileSink: MeetlessProcessRegistrationDiagnosticSink {
  private let fileHandle: FileHandle
  private let lock = NSLock()
  private var recordedEventCount = 0

  init?(duplicating fileHandle: FileHandle) {
    let descriptor = dup(fileHandle.fileDescriptor)
    guard descriptor >= 0 else { return nil }
    self.fileHandle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  }

  func record(_ event: MeetlessProcessRegistrationRemovalEvent) {
    let data = Data((event.retainedLine + "\n").utf8)
    guard data.count <= meetlessMaximumRegistrationDiagnosticLineBytes else { return }
    lock.lock()
    defer { lock.unlock() }
    guard recordedEventCount < meetlessMaximumRegistrationDiagnosticEvents else { return }
    fileHandle.write(data)
    recordedEventCount += 1
  }
}

func makeMeetlessProcessRegistrationDiagnosticSink(
  duplicating fileHandle: FileHandle
) -> MeetlessProcessRegistrationDiagnosticFileSink? {
  MeetlessProcessRegistrationDiagnosticFileSink(duplicating: fileHandle)
}

@discardableResult
func attachMeetlessProcessRegistrationDiagnosticSink(
  to authorization: RuntimeAuthorizationState,
  duplicating fileHandle: FileHandle
) -> MeetlessProcessRegistrationDiagnosticFileSink? {
  let sink = makeMeetlessProcessRegistrationDiagnosticSink(duplicating: fileHandle)
  authorization.setRegistrationDiagnosticSink(sink)
  return sink
}

private func hostPreflightError(_ message: String) -> NSError {
  NSError(
    domain: "MeetlessHost.Preflight",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: "MeetlessHost preflight failed closed: \(message). Move or rebuild the app from the accepted /Applications/Meetless.app package."
    ]
  )
}

private func readRequiredData(_ path: String, label: String) throws -> Data {
  do {
    return try Data(contentsOf: URL(fileURLWithPath: path))
  } catch {
    throw hostPreflightError("\(label) is unavailable at \(path): \(error.localizedDescription)")
  }
}

private func sha256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func isSameOrDescendant(_ candidate: String, _ parent: String) -> Bool {
  let candidateComponents = URL(fileURLWithPath: candidate).standardizedFileURL.pathComponents
  let parentComponents = URL(fileURLWithPath: parent).standardizedFileURL.pathComponents
  guard candidateComponents.count >= parentComponents.count else { return false }
  return zip(parentComponents, candidateComponents).allSatisfy { $0 == $1 }
}

private func relativePath(_ value: String, label: String) throws -> String {
  guard !value.isEmpty, !value.hasPrefix("/"), !value.split(separator: "/").contains(".."), !value.split(separator: "/").contains(where: { $0.isEmpty }) else {
    throw hostPreflightError("\(label) must be a non-empty relative path without traversal")
  }
  return value
}

private func bundleRelativePath(_ relative: String, label: String) throws -> String {
  let safe = try relativePath(relative, label: label)
  let bundle = URL(fileURLWithPath: Bundle.main.bundlePath).standardizedFileURL
  let resolved = bundle.appendingPathComponent(safe).standardizedFileURL.path
  guard isSameOrDescendant(resolved, bundle.path), resolved != bundle.path else {
    throw hostPreflightError("\(label) leaves the running bundle")
  }
  return resolved
}

private func containedPath(_ parent: String, _ relative: String, label: String) throws -> String {
  let safe = try relativePath(relative, label: label)
  let parentURL = URL(fileURLWithPath: parent).standardizedFileURL
  let resolved = parentURL.appendingPathComponent(safe).standardizedFileURL.path
  guard isSameOrDescendant(resolved, parentURL.path), resolved != parentURL.path else {
    throw hostPreflightError("\(label) leaves its owning root")
  }
  return resolved
}

private func userHomeRelativePath(_ relative: String, label: String) throws -> String {
  let safe = try relativePath(relative, label: label)
  return URL(fileURLWithPath: FileManager.default.homeDirectoryForCurrentUser.path)
    .appendingPathComponent(safe)
    .standardizedFileURL
    .path
}

func meetlessAppStoreContainerSupportRoot(for runtimeRoot: String) -> String? {
  let marker = "/\(meetlessAppStoreContainerSupportRelativePath)/"
  guard runtimeRoot.contains(marker), runtimeRoot.hasSuffix("/Meetless") else { return nil }
  return URL(fileURLWithPath: runtimeRoot).deletingLastPathComponent().standardizedFileURL.path
}

func meetlessSignaturePolicy(forRuntimeRootRelativePath relative: String) -> MeetlessPackagedSignaturePolicy? {
  switch relative {
  case meetlessDirectRuntimeRootRelativePath:
    return .directDeveloperID
  case meetlessAppStoreRuntimeRootRelativePath:
    return .appStoreDevelopment
  default:
    return nil
  }
}

func meetlessSignaturePolicy(forRuntimeRoot runtimeRoot: String) -> MeetlessPackagedSignaturePolicy? {
  if runtimeRoot.hasSuffix("/\(meetlessAppStoreRuntimeRootRelativePath)") {
    return .appStoreDevelopment
  }
  if runtimeRoot.hasSuffix("/\(meetlessDirectRuntimeRootRelativePath)") {
    return .directDeveloperID
  }
  return nil
}

private func resolvePackagedRuntimeRoot(_ relative: String, label: String) throws -> String {
  guard relative == meetlessAppStoreRuntimeRootRelativePath else {
    return try userHomeRelativePath(relative, label: label)
  }
  guard let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
    throw hostPreflightError("sandboxed Application Support directory is unavailable for the MAS runtime root")
  }
  let supportRoot = applicationSupport.standardizedFileURL
  guard supportRoot.path.hasSuffix("/\(meetlessAppStoreContainerSupportRelativePath)") else {
    throw hostPreflightError("MAS runtime root did not resolve through the Meetless app container")
  }
  return supportRoot.appendingPathComponent("Meetless").standardizedFileURL.path
}

private func inspectCodesign(_ arguments: [String], label: String) throws -> String {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
  process.arguments = arguments
  let output = Pipe()
  let error = Pipe()
  process.standardOutput = output
  process.standardError = error
  do {
    try process.run()
    process.waitUntilExit()
  } catch {
    throw hostPreflightError("cannot inspect \(label): \(error.localizedDescription)")
  }
  let stdout = output.fileHandleForReading.readDataToEndOfFile()
  let stderr = error.fileHandleForReading.readDataToEndOfFile()
  let text = String(data: stdout + stderr, encoding: .utf8) ?? ""
  guard process.terminationStatus == 0 else {
    throw hostPreflightError("cannot inspect \(label): \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
  }
  return text
}

private func firstMatch(_ value: String, pattern: String) -> String? {
  guard
    let expression = try? NSRegularExpression(pattern: pattern),
    let match = expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
    let range = Range(match.range(at: 1), in: value)
  else { return nil }
  return String(value[range])
}

func meetlessPackagedSignatureRequirement(for policy: MeetlessPackagedSignaturePolicy) -> String {
  switch policy {
  case .directDeveloperID:
    return meetlessDeveloperIDRequirement
  case .appStoreDevelopment:
    return meetlessAppStoreDevelopmentRequirement
  }
}

func meetlessMayMigrateLegacyIdentity(
  previousRequirement: String,
  currentRequirement: String,
  packagedSignaturePolicy: MeetlessPackagedSignaturePolicy?
) -> Bool {
  guard packagedSignaturePolicy != nil, previousRequirement != currentRequirement else { return false }
  return previousRequirement.range(
    of: #"\Acdhash H\"[0-9A-Fa-f]{40}\"\z"#,
    options: .regularExpression
  ) != nil
}

private func assertApprovedPackagedSignature(
  _ bundlePath: String,
  policy: MeetlessPackagedSignaturePolicy
) throws {
  let identity = policy == .appStoreDevelopment ? meetlessAppStoreDevelopmentIdentity : "Developer ID"
  _ = try inspectCodesign([
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    "-R=\(meetlessPackagedSignatureRequirement(for: policy))",
    bundlePath,
  ], label: "\(identity) signature for team \(meetlessDeveloperIDTeam)")
}

private func writeIdentityAtomically(_ data: Data, to identityPath: String, runtimeRoot: String) throws {
  let identityURL = URL(fileURLWithPath: identityPath).standardizedFileURL
  let rootURL = URL(fileURLWithPath: runtimeRoot).standardizedFileURL
  guard isSameOrDescendant(identityURL.deletingLastPathComponent().path, rootURL.path) else {
    throw hostPreflightError("host identity path leaves the per-user runtime root")
  }
  let manager = FileManager.default
  try manager.createDirectory(at: rootURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  let temporaryURL = identityURL.deletingLastPathComponent()
    .appendingPathComponent(".host-identity-\(getpid())-\(UUID().uuidString).tmp")
  defer { try? manager.removeItem(at: temporaryURL) }
  try data.write(to: temporaryURL, options: [.atomic])
  try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporaryURL.path)
  var existingInformation = stat()
  let identityExists = lstat(identityURL.path, &existingInformation) == 0
  if !identityExists && errno != ENOENT {
    throw hostPreflightError("cannot inspect the recorded host identity without following a symlink")
  }
  if identityExists {
    guard (existingInformation.st_mode & S_IFMT) == S_IFREG,
          existingInformation.st_uid == getuid(),
          (existingInformation.st_mode & 0o7777) == 0o600 else {
      throw hostPreflightError("recorded host identity is not one secure regular file")
    }
    _ = try manager.replaceItemAt(identityURL, withItemAt: temporaryURL)
  } else {
    try manager.moveItem(at: temporaryURL, to: identityURL)
  }
}

final class HostDelegate: NSObject, NSApplicationDelegate {
  private var runtime: Process?
  private var runtimeLog: FileHandle?
  private var registrationDiagnosticSink: MeetlessProcessRegistrationDiagnosticFileSink?
  private var lockDescriptor: Int32 = -1
  private var signalSources: [DispatchSourceSignal] = []
  private var configuration: HostConfiguration?
  private var transcriptionCapability: MeetlessTranscriptionCapability?
  private var publishedHostIdentity: MeetlessHostIdentityAttestation?
  private var masGateHandoff: MasGateHostHandoff?
  private var masGateLockIdentity: MasGateLockIdentity?
  private let runtimeAuthorization = RuntimeAuthorizationState()

  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      let coordinator = MeetlessLaunchCoordinator<HostConfiguration>(
        locationCheck: { try self.assertExactInstalledPath() },
        processCheck: {
          guard getppid() == 1 else {
            throw NSError(
              domain: "MeetlessHost",
              code: 1,
              userInfo: [NSLocalizedDescriptionKey: "must be launched through LaunchServices; run npm run runtime:host"]
            )
          }
        },
        guidance: { message in self.showLaunchGuidance(message) },
        configurationCheck: { try self.loadConfiguration() },
        resourceCheck: { configuration in try self.attestPackagedResources(configuration) },
        identity: { configuration in
          self.publishedHostIdentity = try self.publishIdentity(configuration)
        },
        configurationReady: { configuration in self.configuration = configuration },
        lock: { configuration in try self.acquireRuntimeLock(configuration) },
        capability: { configuration in
          self.installSignalHandlers()
          if configuration.endpointPolicy != nil {
            try self.enterPackagedRuntimeWorkingDirectory(configuration.runtimeRoot)
          }
          let capability: MeetlessTranscriptionCapability
          guard let hostIdentity = self.publishedHostIdentity else {
            throw hostPreflightError("host identity was not published before capability startup")
          }
          let processPolicy: MeetlessProcessRegistrationPolicy?
          if let endpointPolicy = configuration.endpointPolicy,
             let endpointWorkingDirectory = configuration.endpointWorkingDirectory,
             let recordingEndpointName = configuration.recordingEndpointName,
             let transcriptionEndpointName = configuration.transcriptionEndpointName,
             let captureHelperPath = configuration.captureHelperPath {
            processPolicy = MeetlessProcessRegistrationPolicy(
              runtimeRoot: configuration.runtimeRoot,
              endpointPolicy: endpointPolicy,
              endpointWorkingDirectory: endpointWorkingDirectory,
              recordingEndpointName: recordingEndpointName,
              transcriptionEndpointName: transcriptionEndpointName,
              nodePath: configuration.nodePath,
              runtimeCliPath: configuration.runtimeCliPath,
              daemonWorkerPath: packagedDaemonWorkerPath(configuration.repositoryRoot),
              daemonWorkerArguments: [
                configuration.nodePath,
                packagedDaemonWorkerPath(configuration.repositoryRoot),
                "daemon"
              ],
              pluginPath: packagedPluginProcessPath(configuration.repositoryRoot),
              pluginArguments: [
                configuration.nodePath,
                packagedPluginProcessPath(configuration.repositoryRoot)
              ],
              captureHelperPath: captureHelperPath
            )
          } else {
            processPolicy = nil
          }
          if let endpointName = configuration.transcriptionEndpointName {
            let endpoint = try meetlessPackagedEndpoint(
              role: "transcription",
              name: endpointName,
              runtimeRoot: configuration.runtimeRoot
            )
            capability = MeetlessTranscriptionCapability(
              endpoint: endpoint,
              workingDirectory: configuration.runtimeRoot,
              stagingDirectory: configuration.transcriptionStaging,
              runtimeAuthorization: self.runtimeAuthorization,
              processPolicy: processPolicy,
              hostIdentity: hostIdentity,
              hostPID: getpid()
            )
          } else {
            capability = MeetlessTranscriptionCapability(
              socketPath: configuration.transcriptionSocket,
              stagingDirectory: configuration.transcriptionStaging,
              runtimeAuthorization: self.runtimeAuthorization,
              processPolicy: processPolicy,
              hostIdentity: hostIdentity,
              hostPID: getpid()
            )
          }
          try capability.start()
          self.transcriptionCapability = capability
        },
        runtime: { configuration in try self.launchRuntime(configuration) }
      )
      _ = try coordinator.run()
    } catch {
      logError(error.localizedDescription)
      NSApp.terminate(nil)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    runtimeAuthorization.clear()
    transcriptionCapability?.stop()
    transcriptionCapability = nil
    let registry = loadOwnedRegistry()
    if let runtime, runtime.isRunning {
      runtime.terminate()
      let deadline = Date().addingTimeInterval(20)
      while runtime.isRunning && Date() < deadline {
        usleep(100_000)
      }
    }
    if runtime?.isRunning == true || registry?.groups.contains(where: { groupIsRunning($0.pgid) }) == true {
      signalOwnedGroups(registry, SIGTERM)
      waitForOwnedGroups(registry, seconds: 3)
    }
    if runtime?.isRunning == true || registry?.groups.contains(where: { groupIsRunning($0.pgid) }) == true {
      signalOwnedGroups(registry, SIGKILL)
      if let runtime, runtime.isRunning { kill(runtime.processIdentifier, SIGKILL) }
      waitForOwnedGroups(registry, seconds: 3)
    }
    if let runtime, runtime.isRunning { runtime.waitUntilExit() }
    removeOwnedRegistryIfReleased(registry)
    runtimeAuthorization.setRegistrationDiagnosticSink(nil)
    registrationDiagnosticSink = nil
    if lockDescriptor >= 0 {
      _ = lockf(lockDescriptor, F_ULOCK, 0)
      close(lockDescriptor)
      lockDescriptor = -1
      masGateLockIdentity = nil
    }
    try? runtimeLog?.close()
    runtimeLog = nil
  }

  private func loadConfiguration() throws -> HostConfiguration {
    guard let resources = Bundle.main.resourceURL else {
      throw NSError(domain: "MeetlessHost", code: 2, userInfo: [NSLocalizedDescriptionKey: "bundle resources are unavailable"])
    }
    let data = try Data(contentsOf: resources.appendingPathComponent("host-config.json"))
    let file = try JSONDecoder().decode(HostConfigurationFile.self, from: data)
    guard file.schema == meetlessHostConfigSchema, file.bundleIdentifier == meetlessBundleIdentifier else {
      throw hostPreflightError("host-config.json has an unknown schema or bundle identifier")
    }
    if file.mode == "development" {
      guard
        let repositoryRoot = file.repositoryRoot,
        let runtimeRoot = file.runtimeRoot,
        let listen = file.listen,
        let rendererOrigin = file.rendererOrigin,
        let transcriptionSocket = file.transcriptionSocket,
        let transcriptionStaging = file.transcriptionStaging,
        let nodePath = file.nodePath,
        let runtimeCliPath = file.runtimeCliPath,
        let identityPath = file.identityPath
      else { throw hostPreflightError("development host configuration is incomplete") }
      return HostConfiguration(
        repositoryRoot: repositoryRoot,
        runtimeRoot: runtimeRoot,
        listen: listen,
        rendererOrigin: rendererOrigin,
        transcriptionSocket: transcriptionSocket,
        transcriptionStaging: transcriptionStaging,
        nodePath: nodePath,
        runtimeCliPath: runtimeCliPath,
        captureHelperPath: nil,
        identityPath: identityPath,
        endpointPolicy: nil,
        endpointWorkingDirectory: nil,
        recordingEndpointName: nil,
        transcriptionEndpointName: nil
      )
    }
    guard file.mode == "packaged" else {
      throw hostPreflightError("host-config.json mode is not packaged")
    }
    guard
      let packageRootRelative = file.packageRoot,
      let contractFilename = file.installationContract,
      let contractSha256 = file.installationContractSha256,
      let runtimeRootRelative = file.runtimeRootRelativeToUserHome,
      let identityRelative = file.identityRelativeToRuntimeRoot,
      let listen = file.listen,
      let rendererOrigin = file.rendererOrigin,
      let transcriptionSocketRelative = file.transcriptionSocketRelativeToRuntimeRoot,
      let transcriptionStagingRelative = file.transcriptionStagingRelativeToRuntimeRoot,
      let endpointPolicy = file.endpointPolicy,
      let endpointWorkingDirectory = file.endpointWorkingDirectory,
      let recordingEndpointName = file.recordingEndpointName,
      let transcriptionEndpointName = file.transcriptionEndpointName,
      let nodeRelative = file.nodePath,
      let runtimeCliRelative = file.runtimeCliPath
    else { throw hostPreflightError("packaged host configuration is incomplete") }
    guard meetlessSignaturePolicy(forRuntimeRootRelativePath: runtimeRootRelative) != nil else {
      throw hostPreflightError("packaged runtime root does not identify the exact direct-DMG or MAS development target")
    }

    let packageRoot = try bundleRelativePath(packageRootRelative, label: "package root")
    let contractPath = try bundleRelativePath(packageRootRelative + "/" + contractFilename, label: "installation contract")
    let contractData = try readRequiredData(contractPath, label: "installation contract")
    guard sha256(contractData) == contractSha256 else {
      throw hostPreflightError("packaged installation contract digest does not match host-config.json")
    }
    let contract = try JSONDecoder().decode(InstallationContract.self, from: contractData)
    guard
      contract.schema == meetlessInstallationContractSchema,
      contract.bundleIdentifier == meetlessBundleIdentifier,
      contract.installPath == meetlessInstallPath,
      contract.package.rootRelativeToBundle == packageRootRelative,
      contract.package.contractFilename == contractFilename,
      contract.userSupportRelativePath == runtimeRootRelative,
      contract.identityRelativePath == identityRelative,
      contract.listen == listen,
      contract.rendererOrigin == rendererOrigin,
      endpointPolicy == meetlessRuntimeEndpointSchema,
      endpointWorkingDirectory == meetlessRuntimeEndpointWorkingDirectory,
      contract.runtime.transcriptionSocketRelativePath == transcriptionSocketRelative,
      contract.runtime.transcriptionStagingRelativePath == transcriptionStagingRelative,
      contract.runtime.endpointPolicy.schema == endpointPolicy,
      contract.runtime.endpointPolicy.workingDirectory == endpointWorkingDirectory,
      contract.runtime.endpointPolicy.recordingEndpointName == recordingEndpointName,
      contract.runtime.endpointPolicy.transcriptionEndpointName == transcriptionEndpointName,
      contract.runtime.recordingSocketRelativePath == recordingEndpointName,
      contract.runtime.transcriptionSocketRelativePath == transcriptionEndpointName
    else { throw hostPreflightError("host configuration differs from the installation contract") }
    try validateMeetlessEndpointName(role: "recording", name: recordingEndpointName)
    try validateMeetlessEndpointName(role: "transcription", name: transcriptionEndpointName)
    guard recordingEndpointName != transcriptionEndpointName else {
      throw hostPreflightError("recording and transcription endpoint names must remain distinct")
    }
    guard let captureHelperRelative = contract.package.resources["captureHelper"] else {
      throw hostPreflightError("packaged installation contract has no capture helper resource")
    }

    let runtimeRoot = try resolvePackagedRuntimeRoot(runtimeRootRelative, label: "runtime root")
    let identityPath = try containedPath(runtimeRoot, identityRelative, label: "host identity")
    let transcriptionDescriptor = try meetlessPackagedEndpoint(
      role: "transcription",
      name: transcriptionEndpointName,
      runtimeRoot: runtimeRoot
    )
    let transcriptionSocket = try containedPath(runtimeRoot, transcriptionSocketRelative, label: "transcription socket")
    guard transcriptionSocket == transcriptionDescriptor.canonicalPath else {
      throw hostPreflightError("transcription endpoint canonical projection differs from the accepted runtime root")
    }
    let transcriptionStaging = try containedPath(runtimeRoot, transcriptionStagingRelative, label: "transcription staging")
    return HostConfiguration(
      repositoryRoot: packageRoot,
      runtimeRoot: runtimeRoot,
      listen: listen,
      rendererOrigin: rendererOrigin,
      transcriptionSocket: transcriptionSocket,
      transcriptionStaging: transcriptionStaging,
      nodePath: try bundleRelativePath(packageRootRelative + "/" + nodeRelative, label: "packaged node"),
      runtimeCliPath: try bundleRelativePath(packageRootRelative + "/" + runtimeCliRelative, label: "packaged runtime CLI"),
      captureHelperPath: try bundleRelativePath(packageRootRelative + "/" + captureHelperRelative, label: "packaged capture helper"),
      identityPath: identityPath,
      endpointPolicy: endpointPolicy,
      endpointWorkingDirectory: endpointWorkingDirectory,
      recordingEndpointName: recordingEndpointName,
      transcriptionEndpointName: transcriptionEndpointName
    )
  }

  private func enterPackagedRuntimeWorkingDirectory(_ runtimeRoot: String) throws {
    let runtimeURL = URL(fileURLWithPath: runtimeRoot).standardizedFileURL
    do {
      try FileManager.default.createDirectory(
        at: runtimeURL,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    } catch {
      throw hostPreflightError("packaged runtime-root working directory is unavailable: \(error.localizedDescription)")
    }
    guard runtimeURL.resolvingSymlinksInPath().standardizedFileURL.path == runtimeURL.path else {
      throw hostPreflightError("packaged runtime-root working directory must not resolve through a symlink")
    }
    guard chmod(runtimeURL.path, 0o700) == 0 else {
      throw hostPreflightError("cannot restrict the packaged runtime-root working directory")
    }
    guard FileManager.default.changeCurrentDirectoryPath(runtimeURL.path) else {
      throw hostPreflightError("cannot enter the packaged runtime-root working directory")
    }
  }

  private func assertExactInstalledPath() throws {
    let lexicalPath = URL(fileURLWithPath: Bundle.main.bundlePath).standardizedFileURL.path
    let resolvedPath = URL(fileURLWithPath: lexicalPath).resolvingSymlinksInPath().standardizedFileURL.path
    try MeetlessInstallLocation.validate(lexicalPath: lexicalPath, resolvedPath: resolvedPath)
  }

  private func attestPackagedResources(_ configuration: HostConfiguration) throws {
    let bundleIdentifier = (Bundle.main.infoDictionary?["CFBundleIdentifier"] as? String) ?? ""
    guard bundleIdentifier == meetlessBundleIdentifier else {
      throw hostPreflightError("bundle identifier is \(bundleIdentifier), expected \(meetlessBundleIdentifier)")
    }
    guard configuration.repositoryRoot.hasPrefix(Bundle.main.bundlePath + "/") else {
      return
    }
    let packageRoot = configuration.repositoryRoot
    let markerPath = try containedPath(packageRoot, "meetless-package.json", label: "package marker")
    let markerData = try readRequiredData(markerPath, label: "package marker")
    let marker = try JSONDecoder().decode(PackageMarker.self, from: markerData)
    let contractPath = try containedPath(packageRoot, marker.installationContract, label: "installation contract")
    let contractData = try readRequiredData(contractPath, label: "installation contract")
    let contract = try JSONDecoder().decode(InstallationContract.self, from: contractData)
    guard
      marker.schema == meetlessPackageSchema,
      marker.target == "macos-arm64",
      marker.bundleIdentifier == meetlessBundleIdentifier,
      marker.hostBundlePath == meetlessInstallPath,
      marker.installationContract == "installation-contract.json",
      marker.installationContractSha256 == sha256(contractData),
      marker.listen == contract.listen,
      marker.rendererOrigin == contract.rendererOrigin,
      marker.resources == contract.package.resources,
      contract.schema == meetlessInstallationContractSchema,
      contract.bundleIdentifier == meetlessBundleIdentifier,
      contract.installPath == meetlessInstallPath,
      contract.package.rootRelativeToBundle == "Contents/Resources/meetless",
      contract.package.contractFilename == marker.installationContract,
      contract.package.hostConfigRelativeToBundle == "Contents/Resources/host-config.json"
    else {
      throw hostPreflightError("packaged marker or installation contract does not match the exact app")
    }
    if contract.userSupportRelativePath == meetlessAppStoreRuntimeRootRelativePath {
      guard contract.recordingExportsRelativePath == meetlessAppStoreRecordingExportsRelativePath else {
        throw hostPreflightError("MAS installation contract does not keep recording exports inside the app container")
      }
    }
    let resourceLabels = marker.resources.keys.sorted()
    for label in resourceLabels {
      guard let relativePath = marker.resources[label] else { continue }
      let resource = try containedPath(packageRoot, relativePath, label: "packaged resource \(label)")
      var isDirectory = ObjCBool(false)
      guard FileManager.default.fileExists(atPath: resource, isDirectory: &isDirectory) else {
        throw hostPreflightError("packaged resource \(label) is missing at \(resource)")
      }
      let resolved = URL(fileURLWithPath: resource).resolvingSymlinksInPath().standardizedFileURL.path
      guard isSameOrDescendant(resolved, Bundle.main.bundlePath) else {
        throw hostPreflightError("packaged resource \(label) resolves outside the running bundle: \(resolved)")
      }
      if label != "rendererRoot" && isDirectory.boolValue {
        throw hostPreflightError("packaged resource \(label) must be a regular file: \(resource)")
      }
      if label == "rendererRoot" && !isDirectory.boolValue {
        throw hostPreflightError("packaged rendererRoot must be a directory")
      }
    }
    let hostExecutable = URL(fileURLWithPath: Bundle.main.bundlePath).appendingPathComponent("Contents/MacOS/MeetlessHost").path
    guard FileManager.default.isExecutableFile(atPath: hostExecutable) else {
      throw hostPreflightError("MeetlessHost executable is missing or not executable")
    }
    guard let signaturePolicy = meetlessSignaturePolicy(forRuntimeRoot: configuration.runtimeRoot) else {
      throw hostPreflightError("packaged resource attestation has no exact target signature policy")
    }
    try assertApprovedPackagedSignature(Bundle.main.bundlePath, policy: signaturePolicy)
  }

  private func publishIdentity(_ configuration: HostConfiguration) throws -> MeetlessHostIdentityAttestation {
    let bundlePath = URL(fileURLWithPath: Bundle.main.bundlePath).standardizedFileURL.path
    let executablePath = URL(fileURLWithPath: bundlePath).appendingPathComponent("Contents/MacOS/MeetlessHost").path
    let binary = try readRequiredData(executablePath, label: "MeetlessHost executable")
    let executableIdentity = try inspectMeetlessExecutableIdentity(executablePath)
    let requirementOutput = try inspectCodesign(["-d", "-r-", bundlePath], label: "designated requirement")
    guard let requirementLine = requirementOutput.split(separator: "\n").first(where: { $0.contains("designated =>") }) else {
      throw hostPreflightError("codesign did not report a designated requirement")
    }
    let designatedRequirement = requirementLine.components(separatedBy: "designated =>").dropFirst().joined(separator: "designated =>").trimmingCharacters(in: .whitespaces)
    guard !designatedRequirement.isEmpty else {
      throw hostPreflightError("codesign reported an empty designated requirement")
    }
    let signatureOutput = try inspectCodesign(["-d", "--verbose=4", bundlePath], label: "CDHash")
    guard let cdHash = firstMatch(signatureOutput, pattern: "(?m)^CDHash=([0-9A-Fa-f]{40})$")?.lowercased() else {
      throw hostPreflightError("codesign did not report a 40-character CDHash")
    }
    let identity = HostIdentityDocument(
      version: 1,
      bundleIdentifier: meetlessBundleIdentifier,
      bundlePath: bundlePath,
      bundleRealPath: URL(fileURLWithPath: bundlePath).resolvingSymlinksInPath().standardizedFileURL.path,
      executablePath: executablePath,
      designatedRequirement: designatedRequirement,
      cdHash: cdHash,
      binarySha256: sha256(binary),
      binaryDevice: executableIdentity.device,
      binaryInode: executableIdentity.inode,
      binarySize: executableIdentity.size,
      configuration: configuration
    )
    if let handoff = masGateHandoff {
      guard identity.bundleIdentifier == handoff.bundleIdentifier,
            identity.bundlePath == handoff.bundlePath,
            identity.bundleRealPath == handoff.bundleRealPath,
            identity.executablePath == handoff.executablePath,
            identity.designatedRequirement == handoff.designatedRequirement,
            identity.cdHash == handoff.cdHash,
            identity.binarySha256 == handoff.binarySha256,
            Int64(identity.binaryDevice) == handoff.binaryDevice,
            Int64(identity.binaryInode) == handoff.binaryInode,
            Int64(identity.binarySize) == handoff.binarySize else {
        throw hostPreflightError("published host identity differs from the claimed MAS host handoff")
      }
    }
    if let identityInfo = try lstatPath(configuration.identityPath, label: "recorded host identity") {
      guard (identityInfo.st_mode & S_IFMT) == S_IFREG,
            identityInfo.st_uid == getuid(),
            (identityInfo.st_mode & 0o7777) == 0o600 else {
        throw hostPreflightError("recorded host identity is not one secure regular file")
      }
      let previousData = try readRequiredData(configuration.identityPath, label: "recorded host identity")
      let previous = try JSONDecoder().decode(HostIdentityDocument.self, from: previousData)
      let stableIdentity =
        previous.bundleIdentifier == identity.bundleIdentifier &&
        previous.bundlePath == meetlessInstallPath &&
        previous.bundleRealPath == meetlessInstallPath &&
        previous.designatedRequirement == identity.designatedRequirement
      if !stableIdentity {
        let packagedSignaturePolicy = configuration.repositoryRoot.hasPrefix(bundlePath + "/")
          ? meetlessSignaturePolicy(forRuntimeRoot: configuration.runtimeRoot)
          : nil
        let sameOwner = previous.bundleIdentifier == identity.bundleIdentifier &&
          previous.bundlePath == meetlessInstallPath &&
          previous.bundleRealPath == meetlessInstallPath &&
          identity.bundlePath == meetlessInstallPath &&
          identity.bundleRealPath == meetlessInstallPath
        let trustedMigration = sameOwner && meetlessMayMigrateLegacyIdentity(
          previousRequirement: previous.designatedRequirement,
          currentRequirement: identity.designatedRequirement,
          packagedSignaturePolicy: packagedSignaturePolicy
        )
        if trustedMigration, let packagedSignaturePolicy {
          try assertApprovedPackagedSignature(bundlePath, policy: packagedSignaturePolicy)
        } else {
          throw hostPreflightError("recorded host identity drifted in path, bundle identifier, or designated requirement; refusing to refresh it")
        }
      }
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(identity) + Data([10])
    try writeIdentityAtomically(data, to: configuration.identityPath, runtimeRoot: configuration.runtimeRoot)
    return MeetlessHostIdentityAttestation(
      bundleIdentifier: identity.bundleIdentifier,
      bundlePath: identity.bundlePath,
      bundleRealPath: identity.bundleRealPath,
      executablePath: identity.executablePath,
      designatedRequirement: identity.designatedRequirement,
      cdHash: identity.cdHash,
      binarySha256: identity.binarySha256,
      binaryDevice: identity.binaryDevice,
      binaryInode: identity.binaryInode,
      binarySize: identity.binarySize
    )
  }

  private func showLaunchGuidance(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Move Meetless to Applications"
    alert.informativeText = message
    alert.alertStyle = .warning
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }

  private func acquireRuntimeLock(_ configuration: HostConfiguration) throws {
    let runtimeURL = URL(fileURLWithPath: configuration.runtimeRoot).standardizedFileURL
    let parentURL = runtimeURL.deletingLastPathComponent().standardizedFileURL
    let parentPath = parentURL.path
    let runtimeRoot = runtimeURL.path
    try assertSecureDirectory(parentPath, label: "runtime-root parent")
    let lockPath = parentURL.appendingPathComponent(meetlessMasGateLockFilename).path
    if let existing = try lstatPath(lockPath, label: "MAS gate lock"),
       (existing.st_mode & S_IFMT) != S_IFREG {
      throw hostPreflightError("MAS gate lock is not one regular file")
    }
    lockDescriptor = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard lockDescriptor >= 0 else {
      throw hostPreflightError("cannot open the stable MAS gate lock")
    }
    guard lockf(lockDescriptor, F_TLOCK, 0) == 0 else {
      let owner = (try? String(contentsOfFile: lockPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) ?? "unknown owner"
      close(lockDescriptor)
      lockDescriptor = -1
      throw hostPreflightError("MeetlessHost start rejected because the stable MAS gate lock is held by \(owner)")
    }
    do {
      masGateLockIdentity = try assertStableMasGateLock(lockPath, descriptor: lockDescriptor)
      let activePath = parentURL.appendingPathComponent(meetlessMasGateActiveFilename).path
      let active = try lstatPath(activePath, label: "MAS active transaction")
      if active != nil {
        try assertSecureDirectory(activePath, label: "MAS active transaction", requirePrivateMode: true)
        try assertSameDevice(activePath, parentPath, label: "MAS active transaction")
        let allowedQuarantinePath = try activeTransactionQuarantinePath(activePath, runtimeRoot: runtimeRoot, parentPath: parentPath)
        try assertNoPendingMasConstruction(parentPath, runtimeRoot: runtimeRoot, activePresent: true, allowedQuarantinePath: allowedQuarantinePath)
      } else {
        try assertNoPendingMasConstruction(parentPath, runtimeRoot: runtimeRoot, activePresent: false)
        try createDirectRuntimeRootIfAbsent(runtimeRoot, parentPath: parentPath)
      }
      if active != nil {
        masGateHandoff = try claimMasGateHandoff(configuration, activePath: activePath, parentPath: parentPath)
      }
      try writeRuntimeLockMetadata(
        lockDescriptor,
        runtimeRoot: runtimeRoot,
        handoff: masGateHandoff
      )
    } catch {
      _ = lockf(lockDescriptor, F_ULOCK, 0)
      close(lockDescriptor)
      lockDescriptor = -1
      masGateLockIdentity = nil
      throw error
    }
  }

  private func claimMasGateHandoff(
    _ configuration: HostConfiguration,
    activePath: String,
    parentPath: String
  ) throws -> MasGateHostHandoff {
    try assertStableMasGateLockPath(lockDescriptor)
    let journalPath = URL(fileURLWithPath: activePath).appendingPathComponent("transaction.json").path
    let handoffPath = URL(fileURLWithPath: activePath).appendingPathComponent(meetlessMasGateHandoffFilename).path
    try assertSecureFile(journalPath, label: "MAS transaction journal")
    try assertSecureFile(handoffPath, label: "MAS host handoff")
    let journal = try JSONDecoder().decode(MasGateSessionJournal.self, from: readRequiredData(journalPath, label: "MAS transaction journal"))
    let handoff = try decodeStrictMasGateHostHandoff(readRequiredData(handoffPath, label: "MAS host handoff"))
    guard journal.schema == meetlessMasGateTransactionSchema,
          journal.version == 2,
          journal.ownerToken.range(of: "^[A-Za-z0-9_-]{40,80}$", options: .regularExpression) != nil,
          handoff.ownerToken.range(of: "^[A-Za-z0-9_-]{40,80}$", options: .regularExpression) != nil,
          journal.ownerToken == handoff.ownerToken,
          journal.runId == handoff.runId,
          journal.canonicalRuntimeRoot == configuration.runtimeRoot,
          journal.parentPath == parentPath,
          journal.lockPath == URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateLockFilename).path,
          journal.activePath == activePath,
          journal.stateScope == "runtime-root-only",
          journal.phase == "ready",
          let journalFreshRoot = journal.freshRootIdentity,
          handoff.schema == meetlessMasGateHandoffSchema,
          handoff.version == 1,
          handoff.state == "available",
          handoff.phase == "ready",
          handoff.canonicalRuntimeRoot == configuration.runtimeRoot,
          handoff.parentPath == parentPath,
          handoff.activePath == activePath,
          handoff.identityRelativePath == URL(fileURLWithPath: configuration.identityPath).pathComponents.dropFirst(URL(fileURLWithPath: configuration.runtimeRoot).pathComponents.count).joined(separator: "/"),
          handoff.identityPath == configuration.identityPath,
          handoff.bundleIdentifier == meetlessBundleIdentifier,
          handoff.bundlePath == meetlessInstallPath,
          handoff.bundleRealPath == meetlessInstallPath,
          handoff.executablePath == URL(fileURLWithPath: meetlessInstallPath).appendingPathComponent("Contents/MacOS/MeetlessHost").path,
          handoff.freshRootIdentity.type == "directory",
          sameMasGateStableRootIdentity(journalFreshRoot, handoff.freshRootIdentity),
          handoff.claimedByPid == nil,
          handoff.claimedAt == nil else {
      throw hostPreflightError("MAS host handoff is not bound to the exact ready transaction")
    }
    let rootIdentity = try masGateRootIdentity(configuration.runtimeRoot, parentPath: parentPath)
    let runningBundlePath = URL(fileURLWithPath: Bundle.main.bundlePath).standardizedFileURL.path
    let runningBundleRealPath = URL(fileURLWithPath: runningBundlePath).resolvingSymlinksInPath().standardizedFileURL.path
    guard sameMasGateStableRootIdentity(rootIdentity, handoff.freshRootIdentity),
          let bundleIdentifier = Bundle.main.bundleIdentifier,
          bundleIdentifier == handoff.bundleIdentifier,
          runningBundlePath == handoff.bundlePath,
          runningBundleRealPath == handoff.bundleRealPath else {
      throw hostPreflightError("MAS host handoff root or bundle identity changed before host claim")
    }
    let executablePath = URL(fileURLWithPath: runningBundlePath).appendingPathComponent("Contents/MacOS/MeetlessHost").path
    guard executablePath == handoff.executablePath else {
      throw hostPreflightError("MAS host handoff executable path is not exact")
    }
    let executable = try readRequiredData(executablePath, label: "MeetlessHost executable")
    let executableIdentity = try inspectMeetlessExecutableIdentity(executablePath)
    guard sha256(executable) == handoff.binarySha256,
          Int64(executableIdentity.device) == handoff.binaryDevice,
          Int64(executableIdentity.inode) == handoff.binaryInode,
          Int64(executableIdentity.size) == handoff.binarySize,
          handoff.designatedRequirement.isEmpty == false,
          handoff.cdHash.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil else {
      throw hostPreflightError("MAS host handoff installed bundle bytes or signature identity changed")
    }
    guard let identityInfo = try lstatPath(configuration.identityPath, label: "MAS host identity"),
          (identityInfo.st_mode & S_IFMT) == S_IFREG,
          identityInfo.st_uid == getuid(),
          (identityInfo.st_mode & 0o7777) == 0o600 else {
      throw hostPreflightError("MAS host handoff identity bytes are absent in the fresh runtime root")
    }
    let identityDocument = try JSONDecoder().decode(
      HostIdentityDocument.self,
      from: readRequiredData(configuration.identityPath, label: "MAS host identity")
    )
    guard identityDocument.bundleIdentifier == handoff.bundleIdentifier,
          identityDocument.bundlePath == handoff.bundlePath,
          identityDocument.bundleRealPath == handoff.bundleRealPath,
          identityDocument.executablePath == handoff.executablePath,
          identityDocument.designatedRequirement == handoff.designatedRequirement,
          identityDocument.cdHash == handoff.cdHash,
          identityDocument.binarySha256 == handoff.binarySha256,
          Int64(identityDocument.binaryDevice) == handoff.binaryDevice,
          Int64(identityDocument.binaryInode) == handoff.binaryInode,
          Int64(identityDocument.binarySize) == handoff.binarySize else {
      throw hostPreflightError("MAS host identity bytes do not match the claimed installed bundle")
    }
    var claimed = handoff
    claimed.state = "claimed"
    claimed.claimedByPid = getpid()
    claimed.claimedAt = ISO8601DateFormatter().string(from: Date())
    try writeMasGateHandoff(claimed, to: handoffPath)
    return claimed
  }

  private func writeMasGateHandoff(_ handoff: MasGateHostHandoff, to path: String) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(handoff) + Data([10])
    let temporary = URL(fileURLWithPath: path).deletingLastPathComponent()
      .appendingPathComponent(".host-handoff-\(getpid())-\(UUID().uuidString).tmp").path
    defer { try? FileManager.default.removeItem(atPath: temporary) }
    try data.write(to: URL(fileURLWithPath: temporary), options: [])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary)
    let descriptor = open(temporary, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw hostPreflightError("cannot open the claimed MAS host handoff") }
    guard fsync(descriptor) == 0 else {
      close(descriptor)
      throw hostPreflightError("cannot durably write the claimed MAS host handoff")
    }
    close(descriptor)
    try assertSecureFile(path, label: "claimed MAS host handoff")
    guard Darwin.rename(temporary, path) == 0 else {
      throw hostPreflightError("cannot atomically publish the claimed MAS host handoff")
    }
    try syncDirectory(URL(fileURLWithPath: path).deletingLastPathComponent().path)
  }

  private func writeRuntimeLockMetadata(_ descriptor: Int32, runtimeRoot: String, handoff: MasGateHostHandoff?) throws {
    try assertStableMasGateLockPath(descriptor)
    let role = handoff == nil ? "host" : "host-handoff"
    let runID = handoff?.runId ?? ""
    let object: [String: Any] = [
      "schema": "MAS_GATE_LOCK v1",
      "role": role,
      "pid": Int(getpid()),
      "runtimeRoot": runtimeRoot,
      "runId": runID,
    ]
    guard JSONSerialization.isValidJSONObject(object),
          let encoded = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let payload = String(data: encoded, encoding: .utf8).map({ $0 + "\n" }) else {
      throw hostPreflightError("cannot encode stable MAS gate lock ownership")
    }
    guard ftruncate(descriptor, 0) == 0 else { throw hostPreflightError("cannot publish stable MAS gate lock ownership") }
    let written = payload.withCString { write(descriptor, $0, strlen($0)) }
    guard written == payload.utf8.count, fsync(descriptor) == 0 else {
      throw hostPreflightError("cannot durably publish stable MAS gate lock ownership")
    }
  }

  private func createDirectRuntimeRootIfAbsent(_ runtimeRoot: String, parentPath: String) throws {
    if let existing = try lstatPath(runtimeRoot, label: "runtime root") {
      guard (existing.st_mode & S_IFMT) == S_IFDIR else { throw hostPreflightError("runtime root is not one directory") }
      try assertSecureDirectory(runtimeRoot, label: "runtime root")
      var parent = stat()
      guard lstat(parentPath, &parent) == 0, existing.st_dev == parent.st_dev else {
        throw hostPreflightError("runtime root and its parent are not on the same device")
      }
      return
    }
    do {
      try FileManager.default.createDirectory(
        atPath: runtimeRoot,
        withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700]
      )
    } catch {
      if try lstatPath(runtimeRoot, label: "runtime root") == nil { throw error }
    }
    try assertSecureDirectory(runtimeRoot, label: "fresh direct runtime root")
    var root = stat()
    var parent = stat()
    guard lstat(runtimeRoot, &root) == 0, lstat(parentPath, &parent) == 0, root.st_dev == parent.st_dev else {
      throw hostPreflightError("runtime root and its parent are not on the same device")
    }
  }

  private func activeTransactionQuarantinePath(_ activePath: String, runtimeRoot: String, parentPath: String) throws -> String? {
    let journalPath = URL(fileURLWithPath: activePath).appendingPathComponent("transaction.json").path
    try assertSecureFile(journalPath, label: "MAS transaction journal")
    let journal = try JSONDecoder().decode(MasGateSessionJournal.self, from: readRequiredData(journalPath, label: "MAS transaction journal"))
    let expectedQuarantinePath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId).quarantine").path
    let expectedConstructionPath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId).active-building").path
    let expectedConstructionIntentPath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId)\(meetlessMasGateActiveIntentSuffix)").path
    let expectedFreshRetainedPath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId).fresh-retained").path
    let expectedArchivePath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId).archived").path
    guard journal.schema == meetlessMasGateTransactionSchema,
          journal.version == 2,
          journal.runId.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil,
          journal.canonicalRuntimeRoot == runtimeRoot,
          journal.parentPath == parentPath,
          journal.lockPath == URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateLockFilename).path,
          journal.activePath == activePath,
          journal.constructionPath == expectedConstructionPath,
          journal.constructionIntentPath == expectedConstructionIntentPath,
          journal.quarantinePath == expectedQuarantinePath else {
      throw hostPreflightError("MAS active transaction journal is not bound to the exact runtime parent")
    }
    guard journal.freshRetainedPath == expectedFreshRetainedPath,
          journal.archivePath == nil || journal.archivePath == expectedArchivePath else {
      throw hostPreflightError("MAS active transaction journal contains an unexpected retained or archive path")
    }
    if journal.phase == "ready" {
      let quarantine = try lstatPath(journal.quarantinePath, label: "MAS quarantine root")
      if journal.priorExists {
        guard quarantine != nil else {
          throw hostPreflightError("MAS ready transaction lost its quarantined prior runtime root")
        }
      } else if quarantine != nil {
        throw hostPreflightError("MAS ready transaction has an unexpected quarantine root for recorded prior absence")
      }
    }
    return journal.quarantinePath
  }

  private func assertNoPendingMasConstruction(
    _ parentPath: String,
    runtimeRoot: String,
    activePresent: Bool,
    allowedQuarantinePath: String? = nil
  ) throws {
    // Direct-DMG/production startup has a different runtime contract and does
    // not participate in the MAS locator protocol. The MAS app-container root
    // is the only path for which an absent locator is a fail-closed state: an
    // older dynamic construction cannot be safely discovered without scanning
    // the opaque Application Support parent.
    guard meetlessAppStoreContainerSupportRoot(for: runtimeRoot) != nil else { return }

    let locator = try readMasGateSessionLocator(parentPath: parentPath, runtimeRoot: runtimeRoot)
    if let intent = locator.intent, intent.state == "pending" {
      throw hostPreflightError("the fixed MAS session index intent is pending; run the exact gate status/recovery command before host startup")
    }

    let activeRunID = allowedQuarantinePath.flatMap { masGateRunID(from: $0, suffix: ".quarantine") }
    if activePresent && activeRunID == nil {
      throw hostPreflightError("the fixed active MAS transaction has no exact registered quarantine locator")
    }

    let activeJournal: MasGateSessionJournal? = activePresent
      ? try readMasGateJournal(
          URL(fileURLWithPath: parentPath)
            .appendingPathComponent(meetlessMasGateActiveFilename)
            .appendingPathComponent("transaction.json").path,
          runtimeRoot: runtimeRoot,
          parentPath: parentPath,
          activePath: URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateActiveFilename).path
        )
      : nil
    if let activeJournal, !locator.index.entries.contains(where: { $0.runId == activeJournal.runId }) {
      throw hostPreflightError("the fixed active MAS transaction is not registered in the exact session index")
    }

    for entry in locator.index.entries {
      try assertMasGateSessionIndexEntry(entry, runtimeRoot: runtimeRoot, parentPath: parentPath)
      let construction = try lstatPath(entry.constructionPath, label: "MAS indexed construction path")
      let constructionIntent = try lstatPath(entry.constructionIntentPath, label: "MAS indexed construction intent")
      let quarantine = try lstatPath(entry.quarantinePath, label: "MAS indexed quarantine root")
      let freshRetained = try lstatPath(entry.freshRetainedPath, label: "MAS indexed fresh retained root")
      let archive = try lstatPath(entry.archivePath, label: "MAS indexed archive")

      if let activeJournal, activeJournal.runId == entry.runId {
        if archive != nil { throw hostPreflightError("both active and archived transaction slots are present for one indexed MAS session") }
        if construction != nil { throw hostPreflightError("indexed MAS active transaction still has its construction root") }
        if constructionIntent != nil {
          try assertConstructionIntentMasTransactionArtifact(
            entry.constructionIntentPath,
            runtimeRoot: runtimeRoot,
            parentPath: parentPath,
            runID: entry.runId
          )
        }
        if quarantine != nil { try assertQuarantineMasTransactionArtifact(entry.quarantinePath, parentPath: parentPath) }
        if let freshRetained { try assertFreshRetainedMasTransactionArtifact(freshRetained, entry: entry, journal: activeJournal, parentPath: parentPath) }
        continue
      }

      if archive != nil {
        if activeRunID == entry.runId { throw hostPreflightError("both active and archived artifacts for one MAS transaction are present") }
        try assertArchivedMasTransactionArtifact(
          entry.archivePath,
          runtimeRoot: runtimeRoot,
          parentPath: parentPath,
          runID: entry.runId
        )
        if construction != nil { throw hostPreflightError("an archived MAS transaction still has its construction root") }
        if constructionIntent != nil {
          try assertConstructionIntentMasTransactionArtifact(
            entry.constructionIntentPath,
            runtimeRoot: runtimeRoot,
            parentPath: parentPath,
            runID: entry.runId
          )
        }
        if quarantine != nil { try assertQuarantineMasTransactionArtifact(entry.quarantinePath, parentPath: parentPath) }
        continue
      }

      if construction != nil || constructionIntent != nil || quarantine != nil || freshRetained != nil {
        throw hostPreflightError("an indexed MAS transaction has no exact active or archived journal; preserve every byte and run gate recovery")
      }
      throw hostPreflightError("an indexed MAS session locator has no exact v2 transaction artifact; preserve every byte and run reconciliation")
    }

    if activePresent && activeJournal == nil {
      throw hostPreflightError("the fixed active MAS transaction journal is unavailable")
    }
  }

  private func readMasGateSessionLocator(
    parentPath: String,
    runtimeRoot: String
  ) throws -> (index: MasGateSessionIndex, intent: MasGateSessionIndexIntent?) {
    let parentURL = URL(fileURLWithPath: parentPath).standardizedFileURL
    let activePath = parentURL.appendingPathComponent(meetlessMasGateActiveFilename).path
    let indexPath = parentURL.appendingPathComponent(meetlessMasGateIndexFilename).path
    let indexIntentPath = parentURL.appendingPathComponent(meetlessMasGateIndexIntentFilename).path
    guard let index = try readMasGateRecord(indexPath, label: "MAS session index", parentPath: parentPath) as MasGateSessionIndex? else {
      throw hostPreflightError("the fixed MAS session index is missing; an unregistered legacy construction cannot be safely discovered without parent enumeration, so run manual reconciliation")
    }
    try assertMasGateSessionIndex(
      index,
      runtimeRoot: runtimeRoot,
      parentPath: parentPath,
      activePath: activePath,
      indexPath: indexPath,
      indexIntentPath: indexIntentPath
    )
    let intent = try readMasGateRecord(indexIntentPath, label: "MAS session index intent", parentPath: parentPath) as MasGateSessionIndexIntent?
    if let intent {
      try assertMasGateSessionIndexIntent(
        intent,
        runtimeRoot: runtimeRoot,
        parentPath: parentPath,
        activePath: activePath,
        indexPath: indexPath,
        index: index
      )
    }
    return (index, intent)
  }

  private func readMasGateRecord<T: Decodable>(
    _ path: String,
    label: String,
    parentPath: String
  ) throws -> T? {
    guard let information = try lstatPath(path, label: label) else { return nil }
    var parent = stat()
    guard lstat(parentPath, &parent) == 0,
          (information.st_mode & S_IFMT) == S_IFREG,
          information.st_uid == getuid(),
          information.st_nlink == 1,
          (information.st_mode & 0o7777) == 0o600,
          information.st_dev == parent.st_dev,
          information.st_size >= 0,
          information.st_size <= Int64(meetlessMasGateMaxFixedRecordBytes) else {
      throw hostPreflightError("\(label) is not one bounded secure same-device regular file")
    }
    let data = try readRequiredData(path, label: label)
    guard data.count <= meetlessMasGateMaxFixedRecordBytes else {
      throw hostPreflightError("\(label) exceeds the bounded fixed-record size")
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw hostPreflightError("\(label) is malformed: \(error.localizedDescription)")
    }
  }

  private func assertMasGateSessionIndex(
    _ index: MasGateSessionIndex,
    runtimeRoot: String,
    parentPath: String,
    activePath: String,
    indexPath: String,
    indexIntentPath: String
  ) throws {
    guard index.schema == meetlessMasGateIndexSchema,
          index.version == 1,
          index.runtimeRoot == runtimeRoot,
          index.parentPath == parentPath,
          index.activePath == activePath,
          index.indexPath == indexPath,
          index.indexIntentPath == indexIntentPath,
          index.entries.count <= meetlessMasGateMaxIndexEntries else {
      throw hostPreflightError("MAS session index is not bound to the exact fixed runtime context")
    }
    var runIDs = Set<String>()
    for entry in index.entries {
      try assertMasGateSessionIndexEntry(entry, runtimeRoot: runtimeRoot, parentPath: parentPath)
      guard runIDs.insert(entry.runId).inserted else {
        throw hostPreflightError("MAS session index contains a duplicate run ID")
      }
    }
  }

  private func assertMasGateSessionIndexEntry(
    _ entry: MasGateSessionIndexEntry,
    runtimeRoot: String,
    parentPath: String
  ) throws {
    let activePath = URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateActiveFilename).path
    let expectedConstruction = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(entry.runId).active-building").path
    let expectedIntent = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(entry.runId)\(meetlessMasGateActiveIntentSuffix)").path
    let expectedQuarantine = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(entry.runId).quarantine").path
    let expectedFreshRetained = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(entry.runId).fresh-retained").path
    let expectedArchive = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(entry.runId).archived").path
    guard entry.runId.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil,
          entry.activePath == activePath,
          entry.constructionPath == expectedConstruction,
          entry.constructionIntentPath == expectedIntent,
          entry.quarantinePath == expectedQuarantine,
          entry.freshRetainedPath == expectedFreshRetained,
          entry.archivePath == expectedArchive,
          !entry.activePath.isEmpty,
          !runtimeRoot.isEmpty else {
      throw hostPreflightError("MAS session index contains a path-mismatched locator")
    }
  }

  private func assertMasGateSessionIndexIntent(
    _ intent: MasGateSessionIndexIntent,
    runtimeRoot: String,
    parentPath: String,
    activePath: String,
    indexPath: String,
    index: MasGateSessionIndex
  ) throws {
    guard intent.schema == meetlessMasGateIndexIntentSchema,
          intent.version == 1,
          intent.state == "pending" || intent.state == "committed",
          intent.operation == "register" || intent.operation == "archive",
          intent.runtimeRoot == runtimeRoot,
          intent.parentPath == parentPath,
          intent.indexPath == indexPath,
          let before = intent.before else {
      throw hostPreflightError("MAS session index intent is malformed or disagrees with the fixed index")
    }
    try assertMasGateSessionIndex(
      intent.after,
      runtimeRoot: runtimeRoot,
      parentPath: parentPath,
      activePath: activePath,
      indexPath: indexPath,
      indexIntentPath: URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateIndexIntentFilename).path
    )
    try assertMasGateSessionIndex(
      before,
      runtimeRoot: runtimeRoot,
      parentPath: parentPath,
      activePath: activePath,
      indexPath: indexPath,
      indexIntentPath: URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateIndexIntentFilename).path
    )
    try assertMasGateSessionJournal(intent.transaction, runtimeRoot: runtimeRoot, parentPath: parentPath, activePath: activePath)
    if intent.state == "pending" {
      guard sameMasGateSessionIndex(index, before) || sameMasGateSessionIndex(index, intent.after) else {
        throw hostPreflightError("pending MAS session index intent disagrees with both durable index states")
      }
    } else if !sameMasGateSessionIndex(index, intent.after) {
      throw hostPreflightError("committed MAS session index intent is not its exact durable result")
    }
    if intent.operation == "register" {
      guard intent.sourcePath == nil, intent.destinationPath == nil else {
        throw hostPreflightError("MAS registration index intent carries an unexpected move path")
      }
    } else {
      guard intent.sourcePath == activePath,
            intent.destinationPath == intent.transaction.archivePath,
            let destination = intent.destinationPath,
            destination == URL(fileURLWithPath: parentPath)
              .appendingPathComponent(".meetless-mas-gate-session.\(intent.transaction.runId).archived").path else {
        throw hostPreflightError("MAS archive index intent is not the exact active-to-archive move")
      }
    }
  }

  private func assertMasGateSessionJournal(
    _ journal: MasGateSessionJournal,
    runtimeRoot: String,
    parentPath: String,
    activePath: String
  ) throws {
    let entry = MasGateSessionIndexEntry(
      runId: journal.runId,
      activePath: activePath,
      constructionPath: URL(fileURLWithPath: parentPath)
        .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId).active-building").path,
      constructionIntentPath: URL(fileURLWithPath: parentPath)
        .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId)\(meetlessMasGateActiveIntentSuffix)").path,
      quarantinePath: URL(fileURLWithPath: parentPath)
        .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId).quarantine").path,
      freshRetainedPath: URL(fileURLWithPath: parentPath)
        .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId).fresh-retained").path,
      archivePath: URL(fileURLWithPath: parentPath)
        .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId).archived").path
    )
    try assertMasGateSessionIndexEntry(entry, runtimeRoot: runtimeRoot, parentPath: parentPath)
    guard journal.schema == meetlessMasGateTransactionSchema,
          journal.version == 2,
          journal.ownerToken.range(of: "^[A-Za-z0-9_-]{40,80}$", options: .regularExpression) != nil,
          journal.canonicalRuntimeRoot == runtimeRoot,
          journal.parentPath == parentPath,
          journal.lockPath == URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateLockFilename).path,
          journal.activePath == activePath,
          journal.constructionPath == entry.constructionPath,
          journal.constructionIntentPath == entry.constructionIntentPath,
          journal.quarantinePath == entry.quarantinePath,
          journal.freshRetainedPath == entry.freshRetainedPath,
          journal.archivePath == nil || journal.archivePath == entry.archivePath,
          journal.stateScope == "runtime-root-only",
          meetlessMasGateSessionPhases.contains(journal.phase) else {
      throw hostPreflightError("MAS transaction journal is not a complete exact v2 journal")
    }
  }

  private func readMasGateJournal(
    _ path: String,
    runtimeRoot: String,
    parentPath: String,
    activePath: String
  ) throws -> MasGateSessionJournal {
    try assertSecureFile(path, label: "MAS transaction journal")
    guard let journal = try readMasGateRecord(path, label: "MAS transaction journal", parentPath: parentPath) as MasGateSessionJournal? else {
      throw hostPreflightError("MAS transaction journal is unavailable")
    }
    try assertMasGateSessionJournal(journal, runtimeRoot: runtimeRoot, parentPath: parentPath, activePath: activePath)
    return journal
  }

  private func sameMasGateSessionIndex(_ left: MasGateSessionIndex, _ right: MasGateSessionIndex) -> Bool {
    left.schema == right.schema &&
      left.version == right.version &&
      left.runtimeRoot == right.runtimeRoot &&
      left.parentPath == right.parentPath &&
      left.activePath == right.activePath &&
      left.indexPath == right.indexPath &&
      left.indexIntentPath == right.indexIntentPath &&
      left.entries.count == right.entries.count &&
      zip(left.entries, right.entries).allSatisfy { leftEntry, rightEntry in
        leftEntry.runId == rightEntry.runId &&
          leftEntry.activePath == rightEntry.activePath &&
          leftEntry.constructionPath == rightEntry.constructionPath &&
          leftEntry.constructionIntentPath == rightEntry.constructionIntentPath &&
          leftEntry.quarantinePath == rightEntry.quarantinePath &&
          leftEntry.freshRetainedPath == rightEntry.freshRetainedPath &&
          leftEntry.archivePath == rightEntry.archivePath
      }
  }

  private func masGateRunID(from path: String, suffix: String) -> String? {
    let name = URL(fileURLWithPath: path).lastPathComponent
    let prefix = ".meetless-mas-gate-session."
    guard name.hasPrefix(prefix), name.hasSuffix(suffix) else { return nil }
    let runID = String(name.dropFirst(prefix.count).dropLast(suffix.count))
    guard runID.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil else { return nil }
    return runID
  }

  private func assertFreshRetainedMasTransactionArtifact(
    _ information: stat,
    entry: MasGateSessionIndexEntry,
    journal: MasGateSessionJournal,
    parentPath: String
  ) throws {
    var parent = stat()
    guard (information.st_mode & S_IFMT) == S_IFDIR,
          information.st_uid == getuid(),
          (information.st_mode & 0o7777) == 0o700,
          lstat(parentPath, &parent) == 0,
          information.st_dev == parent.st_dev,
          let freshRootIdentity = journal.freshRootIdentity else {
      throw hostPreflightError("MAS indexed fresh retained root is not one exact secure v2 root")
    }
    let retainedIdentity = MasGateRootIdentity(
      type: "directory",
      mode: Int64(information.st_mode),
      uid: Int64(information.st_uid),
      gid: Int64(information.st_gid),
      dev: Int64(information.st_dev),
      ino: Int64(information.st_ino),
      nlink: Int64(information.st_nlink),
      size: Int64(information.st_size)
    )
    guard entry.freshRetainedPath == URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(journal.runId).fresh-retained").path,
          sameMasGateStableRootIdentity(retainedIdentity, freshRootIdentity) else {
      throw hostPreflightError("MAS indexed fresh retained root identity changed outside its transaction")
    }
  }

  private func assertQuarantineMasTransactionArtifact(_ path: String, parentPath: String) throws {
    guard let information = try lstatPath(path, label: "MAS quarantine root"),
          (information.st_mode & S_IFMT) == S_IFDIR,
          information.st_uid == getuid() else {
      throw hostPreflightError("MAS quarantine root is not one owned directory")
    }
    var parent = stat()
    guard lstat(parentPath, &parent) == 0, information.st_dev == parent.st_dev else {
      throw hostPreflightError("MAS quarantine root is on a different device")
    }
    let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
    guard resolved == path else { throw hostPreflightError("MAS quarantine root resolves through a symlink") }
  }

  private func assertConstructionIntentMasTransactionArtifact(
    _ intentPath: String,
    runtimeRoot: String,
    parentPath: String,
    runID: String
  ) throws {
    try assertSecureFile(intentPath, label: "MAS construction intent journal")
    let journal = try JSONDecoder().decode(
      MasGateSessionJournal.self,
      from: readRequiredData(intentPath, label: "MAS construction intent journal")
    )
    let expectedConstructionPath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(runID).active-building").path
    guard journal.schema == meetlessMasGateTransactionSchema,
          journal.version == 2,
          journal.ownerToken.range(of: "^[A-Za-z0-9_-]{40,80}$", options: .regularExpression) != nil,
          journal.runId == runID,
          journal.canonicalRuntimeRoot == runtimeRoot,
          journal.parentPath == parentPath,
          journal.lockPath == URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateLockFilename).path,
          journal.activePath == URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateActiveFilename).path,
          journal.constructionPath == expectedConstructionPath,
          journal.constructionIntentPath == intentPath,
          journal.stateScope == "runtime-root-only",
          journal.phase == "construction-intent",
          try lstatPath(expectedConstructionPath, label: "MAS construction directory") == nil else {
      throw hostPreflightError("MAS construction intent is not bound to the exact empty construction window")
    }
  }

  private func assertArchivedMasTransactionArtifact(
    _ archivePath: String,
    runtimeRoot: String,
    parentPath: String,
    runID: String
  ) throws {
    guard let archiveInformation = try lstatPath(archivePath, label: "MAS archived transaction"),
          (archiveInformation.st_mode & S_IFMT) == S_IFDIR,
          archiveInformation.st_uid == getuid(),
          (archiveInformation.st_mode & 0o7777) == 0o700 else {
      throw hostPreflightError("MAS archived transaction is not one secure directory")
    }
    var parent = stat()
    guard lstat(parentPath, &parent) == 0, archiveInformation.st_dev == parent.st_dev else {
      throw hostPreflightError("MAS archived transaction is on a different device")
    }
    let resolved = URL(fileURLWithPath: archivePath).resolvingSymlinksInPath().standardizedFileURL.path
    guard resolved == archivePath else { throw hostPreflightError("MAS archived transaction resolves through a symlink") }

    let journalPath = URL(fileURLWithPath: archivePath).appendingPathComponent("transaction.json").path
    try assertSecureFile(journalPath, label: "MAS archived transaction journal")
    let journal = try JSONDecoder().decode(
      MasGateSessionJournal.self,
      from: readRequiredData(journalPath, label: "MAS archived transaction journal")
    )
    let expectedConstructionPath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(runID).active-building").path
    let expectedConstructionIntentPath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(runID)\(meetlessMasGateActiveIntentSuffix)").path
    let expectedQuarantinePath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(runID).quarantine").path
    let expectedFreshRetainedPath = URL(fileURLWithPath: parentPath)
      .appendingPathComponent(".meetless-mas-gate-session.\(runID).fresh-retained").path
    guard journal.schema == meetlessMasGateTransactionSchema,
          journal.version == 2,
          journal.ownerToken.range(of: "^[A-Za-z0-9_-]{40,80}$", options: .regularExpression) != nil,
          journal.runId == runID,
          journal.canonicalRuntimeRoot == runtimeRoot,
          journal.parentPath == parentPath,
          journal.lockPath == URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateLockFilename).path,
          journal.activePath == URL(fileURLWithPath: parentPath).appendingPathComponent(meetlessMasGateActiveFilename).path,
          journal.constructionPath == expectedConstructionPath,
          journal.constructionIntentPath == expectedConstructionIntentPath,
          journal.quarantinePath == expectedQuarantinePath,
          journal.freshRetainedPath == expectedFreshRetainedPath,
          journal.archivePath == archivePath,
          journal.stateScope == "runtime-root-only",
          journal.phase == "archived",
          let freshRootIdentity = journal.freshRootIdentity else {
      throw hostPreflightError("MAS archived transaction journal is not bound to one completed exact session")
    }
    let retainedIdentity = try masGateRootIdentity(journal.freshRetainedPath, parentPath: parentPath)
    guard sameMasGateStableRootIdentity(retainedIdentity, freshRootIdentity) else {
      throw hostPreflightError("MAS archived fresh-root evidence changed outside its transaction")
    }
  }

  private func lstatPath(_ path: String, label: String) throws -> stat? {
    var information = stat()
    if lstat(path, &information) == 0 { return information }
    if errno == ENOENT { return nil }
    throw hostPreflightError("cannot inspect \(label) at \(path)")
  }

  private func assertStableMasGateLock(_ path: String, descriptor: Int32) throws -> MasGateLockIdentity {
    var descriptorInformation = stat()
    guard fstat(descriptor, &descriptorInformation) == 0 else {
      throw hostPreflightError("cannot inspect the stable MAS gate lock descriptor")
    }
    let parentPath = URL(fileURLWithPath: path).deletingLastPathComponent().path
    guard let parentInformation = try lstatPath(parentPath, label: "MAS gate lock parent") else {
      throw hostPreflightError("MAS gate lock parent disappeared while the host was acquiring it")
    }
    guard let pathInformation = try lstatPath(path, label: "MAS gate lock"),
          (pathInformation.st_mode & S_IFMT) == S_IFREG,
          pathInformation.st_uid == getuid(),
          (pathInformation.st_mode & 0o7777) == 0o600,
          pathInformation.st_nlink == 1,
          pathInformation.st_dev == parentInformation.st_dev,
          pathInformation.st_dev == descriptorInformation.st_dev,
          pathInformation.st_ino == descriptorInformation.st_ino,
          pathInformation.st_mode == descriptorInformation.st_mode,
          pathInformation.st_uid == descriptorInformation.st_uid else {
      throw hostPreflightError("stable MAS gate lock path changed while the host was acquiring it")
    }
    return MasGateLockIdentity(
      dev: Int64(descriptorInformation.st_dev),
      ino: Int64(descriptorInformation.st_ino),
      mode: Int64(descriptorInformation.st_mode),
      uid: Int64(descriptorInformation.st_uid)
    )
  }

  private func assertStableMasGateLockPath(_ descriptor: Int32) throws {
    guard let configuration, let expected = masGateLockIdentity else {
      throw hostPreflightError("stable MAS gate lock ownership is unavailable")
    }
    let lockPath = URL(fileURLWithPath: configuration.runtimeRoot).deletingLastPathComponent()
      .appendingPathComponent(meetlessMasGateLockFilename).path
    let current = try assertStableMasGateLock(lockPath, descriptor: descriptor)
    guard current.dev == expected.dev,
          current.ino == expected.ino,
          current.mode == expected.mode,
          current.uid == expected.uid else {
      throw hostPreflightError("stable MAS gate lock identity changed during host ownership")
    }
  }

  private func assertSecureDirectory(_ path: String, label: String, requirePrivateMode: Bool = false) throws {
    guard let information = try lstatPath(path, label: label) else {
      throw hostPreflightError("\(label) is unavailable")
    }
    let modeIsSecure = requirePrivateMode
      ? (information.st_mode & 0o7777) == 0o700
      : (information.st_mode & 0o022) == 0
    guard (information.st_mode & S_IFMT) == S_IFDIR,
          information.st_uid == getuid(),
          modeIsSecure else {
      throw hostPreflightError("\(label) is not one secure current-owner directory")
    }
    let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
    guard resolved == path else { throw hostPreflightError("\(label) resolves through a symlink") }
  }

  private func assertSecureFile(_ path: String, label: String) throws {
    guard let information = try lstatPath(path, label: label),
          (information.st_mode & S_IFMT) == S_IFREG,
          information.st_uid == getuid(),
          information.st_nlink == 1,
          (information.st_mode & 0o7777) == 0o600 else {
      throw hostPreflightError("\(label) is not one secure regular file")
    }
  }

  private func assertSameDevice(_ path: String, _ parentPath: String, label: String) throws {
    guard let information = try lstatPath(path, label: label) else {
      throw hostPreflightError("\(label) is unavailable")
    }
    var parent = stat()
    guard lstat(parentPath, &parent) == 0, information.st_dev == parent.st_dev else {
      throw hostPreflightError("\(label) is on a different device from its parent")
    }
  }

  private func masGateRootIdentity(_ path: String, parentPath: String) throws -> MasGateRootIdentity {
    guard let information = try lstatPath(path, label: "fresh MAS runtime root"),
          (information.st_mode & S_IFMT) == S_IFDIR,
          information.st_uid == getuid(),
          (information.st_mode & 0o7777) == 0o700 else {
      throw hostPreflightError("fresh MAS runtime root is not one secure directory")
    }
    var parent = stat()
    guard lstat(parentPath, &parent) == 0, information.st_dev == parent.st_dev else {
      throw hostPreflightError("fresh MAS runtime root is on a different device")
    }
    return MasGateRootIdentity(
      type: "directory",
      mode: Int64(information.st_mode),
      uid: Int64(information.st_uid),
      gid: Int64(information.st_gid),
      dev: Int64(information.st_dev),
      ino: Int64(information.st_ino),
      nlink: Int64(information.st_nlink),
      size: Int64(information.st_size)
    )
  }

  private func syncDirectory(_ path: String) throws {
    let descriptor = open(path, O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else { throw hostPreflightError("cannot open \(path) to durably publish MAS gate state") }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else { throw hostPreflightError("cannot durably publish MAS gate state for \(path)") }
  }

  // Directory link count and size can change when the gate publishes the
  // identity file; inode, device, ownership, and mode are the stable root
  // identity needed to reject a path swap at host handoff.
  private func sameMasGateStableRootIdentity(_ left: MasGateRootIdentity, _ right: MasGateRootIdentity) -> Bool {
    left.type == right.type &&
      left.mode == right.mode &&
      left.uid == right.uid &&
      left.gid == right.gid &&
      left.dev == right.dev &&
      left.ino == right.ino
  }

  private func loadOwnedRegistry() -> OwnedProcessRegistry? {
    guard let configuration, let runtime else { return nil }
    let url = URL(fileURLWithPath: configuration.runtimeRoot).appendingPathComponent("owned-process-groups.json")
    guard let data = try? Data(contentsOf: url), let registry = try? JSONDecoder().decode(OwnedProcessRegistry.self, from: data) else { return nil }
    guard registry.version == 1, registry.hostPid == getpid(), registry.desktopPid == runtime.processIdentifier else {
      logError("ignoring stale owned-process registry at \(url.path)")
      return nil
    }
    return registry
  }

  private func signalOwnedGroups(_ registry: OwnedProcessRegistry?, _ signalNumber: Int32) {
    for group in registry?.groups ?? [] where group.pgid > 1 {
      if kill(-group.pgid, signalNumber) != 0 && errno != ESRCH {
        logError("cannot signal owned \(group.name) process group \(group.pgid): errno \(errno)")
      }
    }
  }

  private func waitForOwnedGroups(_ registry: OwnedProcessRegistry?, seconds: TimeInterval) {
    let deadline = Date().addingTimeInterval(seconds)
    while registry?.groups.contains(where: { groupIsRunning($0.pgid) }) == true && Date() < deadline {
      usleep(100_000)
    }
  }

  private func groupIsRunning(_ pgid: Int32) -> Bool {
    if pgid <= 1 { return false }
    if kill(-pgid, 0) == 0 { return true }
    return errno != ESRCH
  }

  private func removeOwnedRegistryIfReleased(_ registry: OwnedProcessRegistry?) {
    guard let configuration, let registry else { return }
    guard !registry.groups.contains(where: { groupIsRunning($0.pgid) }) else {
      logError("owned process groups remain after bounded host fallback")
      return
    }
    let path = URL(fileURLWithPath: configuration.runtimeRoot).appendingPathComponent("owned-process-groups.json").path
    try? FileManager.default.removeItem(atPath: path)
  }

  private func launchRuntime(_ configuration: HostConfiguration) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: configuration.nodePath)
    process.arguments = [configuration.runtimeCliPath, "desktop"]
    process.currentDirectoryURL = URL(fileURLWithPath: configuration.endpointPolicy == nil
      ? configuration.repositoryRoot
      : configuration.runtimeRoot)
    var environment = ProcessInfo.processInfo.environment
    environment.removeValue(forKey: "MEETLESS_CAPTURE_MODE")
    environment.removeValue(forKey: "MEETLESS_FIXTURE_EXPORT_STAMP")
    environment.removeValue(forKey: "MEETLESS_FIXTURE_FAIL_FINALIZATION_ONCE")
    for (key, value) in environment where isOpenAISecretEnvironmentEntry(key: key, value: value) {
      environment.removeValue(forKey: key)
    }
    environment["MEETLESS_RUNTIME_ROOT"] = configuration.runtimeRoot
    environment["MEETLESS_LISTEN"] = configuration.listen
    environment["MEETLESS_RENDERER_ORIGIN"] = configuration.rendererOrigin
    environment["MEETLESS_HOST_PID"] = String(getpid())
    environment["MEETLESS_HOST_BUNDLE_PATH"] = Bundle.main.bundlePath
    environment["MEETLESS_HOST_IDENTITY_PATH"] = configuration.identityPath
    if let handoff = masGateHandoff {
      environment["MEETLESS_MAS_GATE_RUN_ID"] = handoff.runId
      environment["MEETLESS_MAS_GATE_HANDOFF_PATH"] = URL(fileURLWithPath: configuration.runtimeRoot)
        .deletingLastPathComponent()
        .appendingPathComponent(meetlessMasGateActiveFilename)
        .appendingPathComponent(meetlessMasGateHandoffFilename)
        .path
    }
    environment["MEETLESS_TRANSCRIPTION_SOCKET"] = configuration.transcriptionSocket
    environment["MEETLESS_TRANSCRIPTION_STAGING"] = configuration.transcriptionStaging
    if let endpointPolicy = configuration.endpointPolicy,
       let endpointWorkingDirectory = configuration.endpointWorkingDirectory,
       let recordingEndpointName = configuration.recordingEndpointName,
       let transcriptionEndpointName = configuration.transcriptionEndpointName {
      guard endpointPolicy == meetlessRuntimeEndpointSchema,
            endpointWorkingDirectory == meetlessRuntimeEndpointWorkingDirectory else {
        throw hostPreflightError("runtime endpoint policy is not the accepted versioned packaged composition")
      }
      let recording = try meetlessPackagedEndpoint(
        role: "recording",
        name: recordingEndpointName,
        runtimeRoot: configuration.runtimeRoot
      )
      let transcription = try meetlessPackagedEndpoint(
        role: "transcription",
        name: transcriptionEndpointName,
        runtimeRoot: configuration.runtimeRoot
      )
      guard recording.name != transcription.name else {
        throw hostPreflightError("recording and transcription endpoint names must remain distinct")
      }
      let composition = MeetlessRuntimeEndpointComposition(
        schema: endpointPolicy,
        mode: "packaged",
        workingDirectory: URL(fileURLWithPath: configuration.runtimeRoot).standardizedFileURL.path,
        recording: recording,
        transcription: transcription
      )
      let compositionData = try JSONEncoder().encode(composition)
      guard let compositionValue = String(data: compositionData, encoding: .utf8) else {
        throw hostPreflightError("runtime endpoint composition could not be encoded")
      }
      environment["MEETLESS_RUNTIME_ENDPOINTS"] = compositionValue
      environment["MEETLESS_RUNTIME_PACKAGED"] = "1"
      let pluginPath = packagedPluginProcessPath(configuration.repositoryRoot)
      environment["MEETLESS_HOST_PROCESS_ENDPOINT"] = transcriptionEndpointName
      environment["MEETLESS_HOST_EXPECTED_NODE_PATH"] = configuration.nodePath
      environment["MEETLESS_HOST_EXPECTED_RUNTIME_CLI_PATH"] = configuration.runtimeCliPath
      environment["MEETLESS_HOST_EXPECTED_PLUGIN_PATH"] = pluginPath
      guard let captureHelperPath = configuration.captureHelperPath else {
        throw hostPreflightError("packaged capture helper identity is unavailable")
      }
      environment["MEETLESS_HOST_EXPECTED_CAPTURE_HELPER_PATH"] = captureHelperPath
      if let pluginArguments = try? JSONEncoder().encode([configuration.nodePath, pluginPath]),
         let encodedPluginArguments = String(data: pluginArguments, encoding: .utf8) {
        environment["MEETLESS_HOST_EXPECTED_PLUGIN_ARGV"] = encodedPluginArguments
      } else {
        throw hostPreflightError("packaged plugin process identity could not be encoded")
      }
    } else {
      environment["MEETLESS_RUNTIME_PACKAGED"] = "0"
    }
    if let containerSupportRoot = meetlessAppStoreContainerSupportRoot(for: configuration.runtimeRoot) {
      environment["MEETLESS_APP_CONTAINER_SUPPORT_ROOT"] = containerSupportRoot
    }
    process.environment = environment
    let logs = URL(fileURLWithPath: configuration.runtimeRoot).appendingPathComponent("logs")
    try FileManager.default.createDirectory(
      at: logs,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let logURL = logs.appendingPathComponent("host-runtime.log")
    if !FileManager.default.fileExists(atPath: logURL.path) {
      FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    let log = try FileHandle(forWritingTo: logURL)
    try log.seekToEnd()
    runtimeLog = log
    registrationDiagnosticSink = attachMeetlessProcessRegistrationDiagnosticSink(
      to: runtimeAuthorization,
      duplicating: log
    )
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = log
    process.standardError = log
    process.terminationHandler = { [runtimeAuthorization] process in
      runtimeAuthorization.clear(expected: process.processIdentifier)
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
    try process.run()
    runtime = process
    runtimeAuthorization.publish(process.processIdentifier)
  }

  private func installSignalHandlers() {
    for signalNumber in [SIGTERM, SIGINT] {
      signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
      source.setEventHandler { NSApp.terminate(nil) }
      source.resume()
      signalSources.append(source)
    }
  }
}

public func runMeetlessHostApplication() {
  let application = NSApplication.shared
  let delegate = HostDelegate()
  application.setActivationPolicy(.accessory)
  application.delegate = delegate
  application.run()
}

final class RuntimeAuthorizationState {
  private struct ProcessOwnerEvidence: Equatable {
    let role: String
    let pid: pid_t
    let identity: MeetlessProcessIdentity
    let parentPID: pid_t
    let parentIdentity: MeetlessProcessIdentity
  }

  private struct RegisteredChild {
    let owner: ProcessOwnerEvidence
    let role: String
    let pid: pid_t
    let expectedIdentity: MeetlessProcessIdentity
    let registrationToken: String
    var attested: Bool
  }

  private struct RegistrationOwnerPlan {
    let role: String
    let pid: pid_t
    let expectedIdentity: MeetlessProcessIdentity
    let parentPID: pid_t
    let expectedParentIdentity: MeetlessProcessIdentity
  }

  private enum RegistrationCandidateInspection {
    case accepted(identity: MeetlessProcessIdentity, owner: ProcessOwnerEvidence)
    case rejected(MeetlessProcessRegistrationFailure)
  }

  private struct AuthorizationSnapshot {
    let generation: UInt64
    let revision: UInt64
    let runtimePID: pid_t
    let processPolicy: MeetlessProcessRegistrationPolicy
    let hostIdentity: MeetlessHostIdentityAttestation
    let hostPID: pid_t
    let hostProcessIdentity: MeetlessProcessIdentity?
    let desktopOwnerToken: String?
    let desktopAttested: Bool
    let desktopIdentity: MeetlessProcessIdentity?
    let registrations: [pid_t: RegisteredChild]
  }

  private let lock = NSLock()
  private var runtimePID: pid_t?
  private var generation: UInt64 = 0
  private var revision: UInt64 = 0
  private var processPolicy: MeetlessProcessRegistrationPolicy?
  private var hostIdentity: MeetlessHostIdentityAttestation?
  private var hostPID: pid_t?
  private var hostProcessIdentity: MeetlessProcessIdentity?
  private var desktopOwnerToken: String?
  private var desktopAttested = false
  private var desktopIdentity: MeetlessProcessIdentity?
  private var registrations: [pid_t: RegisteredChild] = [:]
  private var usedRequestIDs: Set<String> = []
  private var usedRegistrationTokens: Set<String> = []
  private var usedChallenges: Set<String> = []
  private var activeExecutions: [UUID: NativeRequestCancellation] = [:]
  private var inspectionHook: (() -> Void)?
  private var pruneInspectionHook: (() -> Void)?
  private var registrationDiagnosticSink: MeetlessProcessRegistrationDiagnosticSink?

  func setInspectionHook(_ hook: (() -> Void)?) {
    lock.lock()
    inspectionHook = hook
    lock.unlock()
  }

  func setPruneInspectionHook(_ hook: (() -> Void)?) {
    lock.lock()
    pruneInspectionHook = hook
    lock.unlock()
  }

  func setRegistrationDiagnosticSink(_ sink: MeetlessProcessRegistrationDiagnosticSink?) {
    lock.lock()
    registrationDiagnosticSink = sink
    lock.unlock()
  }

  func configure(
    processPolicy: MeetlessProcessRegistrationPolicy,
    hostIdentity: MeetlessHostIdentityAttestation,
    hostPID: pid_t
  ) {
    lock.lock()
    let removedRegistrations = registrations
    let previousGeneration = generation
    self.processPolicy = processPolicy
    self.hostIdentity = hostIdentity
    self.hostPID = hostPID
    self.hostProcessIdentity = nil
    self.desktopIdentity = nil
    self.desktopAttested = false
    self.registrations.removeAll()
    self.usedRequestIDs.removeAll()
    self.usedRegistrationTokens.removeAll()
    self.usedChallenges.removeAll()
    self.inspectionHook = nil
    self.pruneInspectionHook = nil
    revision &+= 1
    let events = makeRemovalEvents(
      action: .reset,
      removedPIDs: Set(removedRegistrations.keys),
      registrations: removedRegistrations,
      failures: [:],
      generation: previousGeneration,
      revision: revision,
      fallbackStage: .lifecycle,
      fallbackCheck: .stateReset
    )
    let sink = registrationDiagnosticSink
    lock.unlock()
    recordRemovalEvents(events, using: sink)
  }

  func publish(_ pid: pid_t) {
    lock.lock()
    let removedRegistrations = registrations
    let previousGeneration = generation
    generation &+= 1
    revision &+= 1
    runtimePID = pid > 1 ? pid : nil
    desktopOwnerToken = runtimePID == nil ? nil : UUID().uuidString
    desktopAttested = false
    desktopIdentity = nil
    hostProcessIdentity = nil
    registrations.removeAll()
    usedRequestIDs.removeAll()
    usedRegistrationTokens.removeAll()
    usedChallenges.removeAll()
    inspectionHook = nil
    pruneInspectionHook = nil
    let cancellations = Array(activeExecutions.values)
    activeExecutions.removeAll()
    let events = makeRemovalEvents(
      action: .reset,
      removedPIDs: Set(removedRegistrations.keys),
      registrations: removedRegistrations,
      failures: [:],
      generation: previousGeneration,
      revision: revision,
      fallbackStage: .lifecycle,
      fallbackCheck: .stateReset
    )
    let sink = registrationDiagnosticSink
    lock.unlock()
    cancellations.forEach { $0.cancel() }
    recordRemovalEvents(events, using: sink)
  }

  func clear(expected: pid_t? = nil) {
    lock.lock()
    guard expected == nil || runtimePID == expected else {
      lock.unlock()
      return
    }
    let removedRegistrations = registrations
    let previousGeneration = generation
    generation &+= 1
    revision &+= 1
    runtimePID = nil
    desktopOwnerToken = nil
    desktopAttested = false
    desktopIdentity = nil
    hostProcessIdentity = nil
    registrations.removeAll()
    usedRequestIDs.removeAll()
    usedRegistrationTokens.removeAll()
    usedChallenges.removeAll()
    inspectionHook = nil
    pruneInspectionHook = nil
    let cancellations = Array(activeExecutions.values)
    activeExecutions.removeAll()
    let events = makeRemovalEvents(
      action: .reset,
      removedPIDs: Set(removedRegistrations.keys),
      registrations: removedRegistrations,
      failures: [:],
      generation: previousGeneration,
      revision: revision,
      fallbackStage: .lifecycle,
      fallbackCheck: .stateReset
    )
    let sink = registrationDiagnosticSink
    lock.unlock()
    cancellations.forEach { $0.cancel() }
    recordRemovalEvents(events, using: sink)
  }

  func snapshot() -> pid_t? {
    lock.lock()
    defer { lock.unlock() }
    guard let pid = runtimePID, isProcessAlive(pid) else { return nil }
    return pid
  }

  func issueLease(
    peerPID: pid_t,
    authorizer: RuntimePeerAuthorizer,
    requireRegistered: Bool = false
  ) -> RuntimeAuthorizationLease? {
    lock.lock()
    guard let pid = liveRuntimePIDLocked() else {
      lock.unlock()
      return nil
    }
    let candidate = RuntimeAuthorizationLease(
      runtimePID: pid,
      generation: generation,
      revision: requireRegistered ? revision : nil,
      packagedPeerPID: requireRegistered ? peerPID : nil
    )
    lock.unlock()
    let authorized: Bool
    if requireRegistered {
      authorized = isCurrentPackagedPeer(peerPID: peerPID, runtimePID: pid, generation: candidate.generation)
    } else {
      authorized = authorizer.isAuthorized(peerPID: peerPID, expectedRuntimePID: { [weak self] in
        self?.runtimePID(for: candidate)
      })
    }
    guard authorized else { return nil }
    lock.lock()
    defer { lock.unlock() }
    guard isValidLocked(candidate) else { return nil }
    if requireRegistered && !isPackagedPeerAuthorizedLocked(peerPID) { return nil }
    return candidate
  }

  func attestDesktop(peerPID: pid_t, requestId: String, challenge: String) -> MeetlessDesktopAttestationResult? {
    guard validProtocolToken(requestId), validProtocolToken(challenge) else { return nil }
    lock.lock()
    guard let runtimePID,
          runtimePID == peerPID,
          hostIdentity != nil,
          let ownerToken = desktopOwnerToken,
          useRequestIDLocked(requestId),
          usedChallenges.count < 256,
          usedChallenges.insert(challenge).inserted,
          !desktopAttested else {
      lock.unlock()
      return nil
    }
    revision &+= 1
    lock.unlock()

    for _ in 0..<3 {
      lock.lock()
      guard generation > 0,
            runtimePID == peerPID,
            desktopOwnerToken == ownerToken,
            !desktopAttested,
            let snapshot = authorizationSnapshotLocked() else {
        lock.unlock()
        return nil
      }
      lock.unlock()

      guard inspectDesktopAttestation(snapshot) != nil else { return nil }
      notifyInspectionHook()

      lock.lock()
      guard isCurrentStateLocked(snapshot),
            runtimePID == peerPID,
            desktopOwnerToken == ownerToken,
            !desktopAttested else {
        lock.unlock()
        continue
      }
      lock.unlock()

      guard let finalObservation = inspectDesktopAttestation(snapshot) else { return nil }
      lock.lock()
      guard isCurrentStateLocked(snapshot),
            runtimePID == peerPID,
            desktopOwnerToken == ownerToken,
            !desktopAttested,
            let finalHostIdentity = self.hostIdentity else {
        lock.unlock()
        continue
      }
      desktopIdentity = finalObservation.identity
      hostProcessIdentity = finalObservation.hostProcessIdentity
      desktopAttested = true
      revision &+= 1
      lock.unlock()
      return MeetlessDesktopAttestationResult(
        generation: snapshot.generation,
        ownerToken: ownerToken,
        identity: finalObservation.identity,
        hostIdentity: finalHostIdentity
      )
    }
    return nil
  }

  func processRegistrationSnapshotForTesting() -> [(role: String, pid: pid_t, attested: Bool)] {
    lock.lock()
    defer { lock.unlock() }
    return registrations.values.map { (role: $0.role, pid: $0.pid, attested: $0.attested) }
  }

  func registerChild(
    peerPID: pid_t,
    requestId: String,
    generation requestedGeneration: UInt64,
    ownerToken: String,
    registrationToken: String,
    role: String,
    childPID: pid_t,
    expectedIdentity: MeetlessProcessIdentity,
    policy requestedPolicy: MeetlessHostProcessPolicyWire
  ) -> MeetlessChildRegistrationResult? {
    switch registerChildDiagnosed(
      peerPID: peerPID,
      requestId: requestId,
      generation: requestedGeneration,
      ownerToken: ownerToken,
      registrationToken: registrationToken,
      role: role,
      childPID: childPID,
      expectedIdentity: expectedIdentity,
      policy: requestedPolicy
    ) {
    case .accepted(let registration): return registration
    case .rejected: return nil
    }
  }

  func registerChildDiagnosed(
    peerPID: pid_t,
    requestId: String,
    generation requestedGeneration: UInt64,
    ownerToken: String,
    registrationToken: String,
    role: String,
    childPID: pid_t,
    expectedIdentity: MeetlessProcessIdentity,
    policy requestedPolicy: MeetlessHostProcessPolicyWire
  ) -> MeetlessChildRegistrationDecision {
    let diagnosticRole = MeetlessProcessRegistrationFailure.role(for: role)
    guard validProtocolToken(requestId),
          validProtocolToken(ownerToken),
          validProtocolToken(registrationToken),
          validProcessIdentity(expectedIdentity),
          childPID > 1 else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .input,
        check: .malformed,
        osCode: .none
      ))
    }
    guard validProcessRole(role) else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .input,
        check: .roleMismatch,
        osCode: .none
      ))
    }

    guard pruneDeadRegistrations() else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .processInspectionUnavailable,
        osCode: .unknown
      ))
    }
    lock.lock()
    guard generation == requestedGeneration else {
      lock.unlock()
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .authorization,
        check: .staleGeneration,
        osCode: .none
      ))
    }
    guard liveRuntimePIDLocked() != nil else {
      lock.unlock()
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .ownership,
        check: .ownerChainFailure,
        osCode: .none
      ))
    }
    guard let processPolicy else {
      lock.unlock()
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .ownership,
        check: .ownerChainFailure,
        osCode: .none
      ))
    }
    guard policyMatches(requestedPolicy, processPolicy) else {
      lock.unlock()
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .authorization,
        check: .policyMismatch,
        osCode: .none
      ))
    }
    guard useRequestIDLocked(requestId) else {
      lock.unlock()
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .authorization,
        check: .tokenMismatch,
        osCode: .none
      ))
    }
    guard registrationToken != ownerToken,
          !usedRegistrationTokens.contains(registrationToken) else {
      lock.unlock()
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .authorization,
        check: .tokenMismatch,
        osCode: .none
      ))
    }
    guard expectedIdentityMatchesPolicy(expectedIdentity, role: role, policy: processPolicy) else {
      lock.unlock()
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .authorization,
        check: .childIdentityMismatch,
        osCode: .none
      ))
    }
    guard registrations[childPID] == nil,
          !registrations.values.contains(where: { $0.role == role }) else {
      lock.unlock()
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .authorization,
        check: .duplicateRoleOrSlot,
        osCode: .none
      ))
    }
    lock.unlock()

    for _ in 0..<3 {
      let parentObservation = inspectLiveParentPID(childPID)
      guard let observedParentPID = parentObservation.pid else {
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .inspection,
          check: .processInspectionUnavailable,
          osCode: parentObservation.osCode
        ))
      }
      lock.lock()
      guard generation == requestedGeneration else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .authorization,
          check: .staleGeneration,
          osCode: .none
        ))
      }
      guard liveRuntimePIDLocked() != nil else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .ownership,
          check: .ownerChainFailure,
          osCode: .none
        ))
      }
      guard let snapshot = authorizationSnapshotLocked() else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .ownership,
          check: .ownerChainFailure,
          osCode: .none
        ))
      }
      guard policyMatches(requestedPolicy, snapshot.processPolicy) else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .authorization,
          check: .policyMismatch,
          osCode: .none
        ))
      }
      guard expectedIdentityMatchesPolicy(expectedIdentity, role: role, policy: snapshot.processPolicy) else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .authorization,
          check: .childIdentityMismatch,
          osCode: .none
        ))
      }
      guard registrations[childPID] == nil,
            !registrations.values.contains(where: { $0.role == role }) else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .authorization,
          check: .duplicateRoleOrSlot,
          osCode: .none
        ))
      }
      guard usedRegistrationTokens.count < 256,
            !usedRegistrationTokens.contains(registrationToken) else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .authorization,
          check: .tokenMismatch,
          osCode: .none
        ))
      }
      guard registrationRoleMatchesOwner(peerPID: peerPID, role: role, snapshot: snapshot) else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .ownership,
          check: .roleMismatch,
          osCode: .none
        ))
      }
      guard registrationOwnerTokenMatches(peerPID: peerPID, role: role, ownerToken: ownerToken, snapshot: snapshot) else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .ownership,
          check: .tokenMismatch,
          osCode: .none
        ))
      }
      guard let ownerPlan = registrationOwnerPlanLocked(
        peerPID: peerPID,
        childPID: childPID,
        role: role,
        ownerToken: ownerToken,
        observedParentPID: observedParentPID,
        snapshot: snapshot
      ) else {
        lock.unlock()
        return .rejected(MeetlessProcessRegistrationFailure(
          role: diagnosticRole,
          stage: .ownership,
          check: .ownerChainFailure,
          osCode: .none
        ))
      }
      lock.unlock()

      switch inspectRegistrationCandidateDiagnosed(
        role: role,
        childPID: childPID,
        expectedIdentity: expectedIdentity,
        ownerPlan: ownerPlan,
        snapshot: snapshot
      ) {
      case .accepted:
        break
      case .rejected(let failure):
        return .rejected(failure)
      }
      notifyInspectionHook()

      lock.lock()
      guard isCurrentStateLocked(snapshot),
            liveRuntimePIDLocked() != nil,
            registrations[childPID] == nil,
            !registrations.values.contains(where: { $0.role == role }),
            !usedRegistrationTokens.contains(registrationToken) else {
        lock.unlock()
        continue
      }
      lock.unlock()

      let finalObservation: RegistrationCandidateInspection
      switch inspectRegistrationCandidateDiagnosed(
        role: role,
        childPID: childPID,
        expectedIdentity: expectedIdentity,
        ownerPlan: ownerPlan,
        snapshot: snapshot
      ) {
      case .accepted(let identity, let owner):
        finalObservation = .accepted(identity: identity, owner: owner)
      case .rejected(let failure):
        return .rejected(failure)
      }

      lock.lock()
      guard isCurrentStateLocked(snapshot),
            liveRuntimePIDLocked() != nil,
            registrations[childPID] == nil,
            !registrations.values.contains(where: { $0.role == role }),
            !usedRegistrationTokens.contains(registrationToken) else {
        lock.unlock()
        continue
      }
      let owner: ProcessOwnerEvidence
      switch finalObservation {
      case .accepted(_, let candidateOwner): owner = candidateOwner
      case .rejected:
        lock.unlock()
        continue
      }
      registrations[childPID] = RegisteredChild(
        owner: owner,
        role: role,
        pid: childPID,
        expectedIdentity: expectedIdentity,
        registrationToken: registrationToken,
        attested: false
      )
      usedRegistrationTokens.insert(registrationToken)
      revision &+= 1
      lock.unlock()
      return .accepted(MeetlessChildRegistrationResult(
        generation: snapshot.generation,
        role: role,
        pid: childPID,
        registrationToken: registrationToken
      ))
    }
    return .rejected(MeetlessProcessRegistrationFailure(
      role: diagnosticRole,
      stage: .inspection,
      check: .processInspectionUnavailable,
      osCode: .unknown
    ))
  }

  func attestRegisteredProcess(
    peerPID: pid_t,
    requestId: String,
    generation requestedGeneration: UInt64,
    registrationToken: String,
    role: String
  ) -> MeetlessRegisteredProcessAttestationResult? {
    guard validProtocolToken(requestId), validProtocolToken(registrationToken), validProcessRole(role) else { return nil }
    guard pruneDeadRegistrations() else { return nil }
    lock.lock()
    guard generation == requestedGeneration,
          liveRuntimePIDLocked() != nil,
          useRequestIDLocked(requestId, advancesRevision: false),
          let registration = registrations[peerPID],
          registration.role == role,
          registration.registrationToken == registrationToken,
          !registration.attested,
          hostIdentity != nil else {
      lock.unlock()
      return nil
    }
    lock.unlock()

    for _ in 0..<3 {
      lock.lock()
      guard generation == requestedGeneration,
            liveRuntimePIDLocked() != nil,
            let snapshot = authorizationSnapshotLocked(),
            let current = registrations[peerPID],
            current.role == role,
            current.registrationToken == registrationToken,
            !current.attested else {
        lock.unlock()
        return nil
      }
      lock.unlock()

      guard inspectRegisteredProcess(current, snapshot: snapshot) != nil else { return nil }
      notifyInspectionHook()
      lock.lock()
      guard isCurrentStateLocked(snapshot),
            let latest = registrations[peerPID],
            latest.role == role,
            latest.registrationToken == registrationToken,
            !latest.attested else {
        lock.unlock()
        continue
      }
      lock.unlock()

      guard let finalIdentity = inspectRegisteredProcess(current, snapshot: snapshot) else { return nil }
      lock.lock()
      guard isCurrentStateLocked(snapshot),
            let latest = registrations[peerPID],
            latest.role == role,
            latest.registrationToken == registrationToken,
            !latest.attested,
            let finalHostIdentity = self.hostIdentity else {
        lock.unlock()
        continue
      }
      registrations[peerPID]?.attested = true
      revision &+= 1
      lock.unlock()
      return MeetlessRegisteredProcessAttestationResult(
        generation: snapshot.generation,
        role: role,
        identity: finalIdentity,
        hostIdentity: finalHostIdentity
      )
    }
    return nil
  }

  func registrationStatus(
    peerPID: pid_t,
    requestId: String,
    generation requestedGeneration: UInt64,
    ownerToken: String
  ) -> [MeetlessProcessRegistrationStatus]? {
    guard validProtocolToken(requestId), validProtocolToken(ownerToken) else { return nil }
    guard pruneDeadRegistrations() else { return nil }
    lock.lock()
    guard generation == requestedGeneration,
          let runtimePID,
          peerPID == runtimePID,
          desktopAttested,
          desktopOwnerToken == ownerToken,
          useRequestIDLocked(requestId, advancesRevision: false) else {
      lock.unlock()
      return nil
    }
    lock.unlock()

    for _ in 0..<3 {
      lock.lock()
      guard generation == requestedGeneration,
            let snapshot = authorizationSnapshotLocked(),
            snapshot.runtimePID == peerPID,
            snapshot.desktopAttested,
            snapshot.desktopOwnerToken == ownerToken else {
        lock.unlock()
        return nil
      }
      lock.unlock()

      guard inspectRegistrationStatus(snapshot) != nil else { return nil }
      notifyInspectionHook()
      lock.lock()
      guard isCurrentStateLocked(snapshot), desktopAttested else {
        lock.unlock()
        continue
      }
      lock.unlock()

      guard let finalResult = inspectRegistrationStatus(snapshot) else { return nil }
      lock.lock()
      guard isCurrentStateLocked(snapshot), desktopAttested else {
        lock.unlock()
        continue
      }
      lock.unlock()
      return finalResult.sorted { $0.pid < $1.pid }
    }
    return nil
  }

  func releaseChild(
    peerPID: pid_t,
    requestId: String,
    generation requestedGeneration: UInt64,
    ownerToken: String,
    childPID: pid_t
  ) -> Bool {
    guard validProtocolToken(requestId), validProtocolToken(ownerToken), childPID > 1 else { return false }
    guard pruneDeadRegistrations() else { return false }
    lock.lock()
    guard generation == requestedGeneration,
          liveRuntimePIDLocked() != nil,
          useRequestIDLocked(requestId),
          isAuthorizedOwnerLocked(peerPID: peerPID, ownerToken: ownerToken),
          let registration = registrations[childPID],
          registration.owner.pid == peerPID,
          let snapshot = authorizationSnapshotLocked() else {
      lock.unlock()
      return false
    }
    lock.unlock()

    guard inspectAuthorizedOwner(peerPID: peerPID, ownerToken: ownerToken, snapshot: snapshot) else { return false }
    lock.lock()
    guard isCurrentStateLocked(snapshot),
          isAuthorizedOwnerLocked(peerPID: peerPID, ownerToken: ownerToken),
          let current = registrations[childPID],
          current.owner.pid == peerPID else {
      lock.unlock()
      return false
    }
    lock.unlock()

    guard inspectAuthorizedOwner(peerPID: peerPID, ownerToken: ownerToken, snapshot: snapshot) else { return false }
    lock.lock()
    guard isCurrentStateLocked(snapshot),
          isAuthorizedOwnerLocked(peerPID: peerPID, ownerToken: ownerToken),
          let current = registrations[childPID],
          current.owner.pid == peerPID else {
      lock.unlock()
      return false
    }
    let removedPIDs = removeRegistrationAndDescendantsLocked(startingAt: childPID)
    revision &+= 1
    let events = makeRemovalEvents(
      action: .release,
      removedPIDs: removedPIDs,
      registrations: snapshot.registrations,
      failures: [:],
      generation: snapshot.generation,
      revision: revision,
      fallbackStage: .lifecycle,
      fallbackCheck: .explicitRelease
    )
    let sink = registrationDiagnosticSink
    lock.unlock()
    recordRemovalEvents(events, using: sink)
    return true
  }

  @discardableResult
  func pruneDeadRegistrations() -> Bool {
    for _ in 0..<3 {
      lock.lock()
      if let runtimePID, !isProcessAlive(runtimePID) {
        let removedRegistrations = registrations
        let previousGeneration = generation
        self.runtimePID = nil
        desktopOwnerToken = nil
        desktopAttested = false
        desktopIdentity = nil
        hostProcessIdentity = nil
        registrations.removeAll()
        usedRegistrationTokens.removeAll()
        generation &+= 1
        revision &+= 1
        let events = makeRemovalEvents(
          action: .reset,
          removedPIDs: Set(removedRegistrations.keys),
          registrations: removedRegistrations,
          failures: [:],
          generation: previousGeneration,
          revision: revision,
          fallbackStage: .lifecycle,
          fallbackCheck: .processGone
        )
        let sink = registrationDiagnosticSink
        lock.unlock()
        recordRemovalEvents(events, using: sink)
        return true
      }
      guard let snapshot = authorizationSnapshotLocked() else {
        lock.unlock()
        return true
      }
      lock.unlock()

      var invalidFailures: [pid_t: MeetlessProcessRegistrationFailure] = [:]
      for registration in snapshot.registrations.values {
        var visited = Set<pid_t>()
        if let failure = validateRegistrationChainDiagnosed(registration, snapshot: snapshot, visited: &visited) {
          invalidFailures[registration.pid] = failure
        }
      }
      notifyPruneInspectionHook()

      lock.lock()
      guard isCurrentStateLocked(snapshot) else {
        lock.unlock()
        continue
      }
      if invalidFailures.isEmpty {
        lock.unlock()
        return true
      }
      let removedPIDs = removeRegistrationAndDescendantsLocked(pids: Set(invalidFailures.keys))
      revision &+= 1
      let events = makeRemovalEvents(
        action: .prune,
        removedPIDs: removedPIDs,
        registrations: snapshot.registrations,
        failures: invalidFailures,
        generation: snapshot.generation,
        revision: revision,
        fallbackStage: .ownership,
        fallbackCheck: .ownerChainFailure
      )
      let sink = registrationDiagnosticSink
      lock.unlock()
      recordRemovalEvents(events, using: sink)
      return true
    }
    return false
  }

  func withValidLease<T>(_ lease: RuntimeAuthorizationLease, _ action: () -> T) -> T? {
    guard isCurrentLeaseForUse(lease) else { return nil }

    let result = action()

    return isCurrentLeaseForUse(lease) ? result : nil
  }

  func beginExecution(_ lease: RuntimeAuthorizationLease) -> RuntimeAuthorizationExecution? {
    if lease.packagedPeerPID != nil {
      guard isCurrentLeaseForUse(lease) else { return nil }
    }
    lock.lock()
    defer { lock.unlock() }
    guard isValidLocked(lease) else { return nil }
    let execution = RuntimeAuthorizationExecution(id: UUID(), cancellation: NativeRequestCancellation())
    activeExecutions[execution.id] = execution.cancellation
    return execution
  }

  func finishExecution(_ execution: RuntimeAuthorizationExecution) {
    lock.lock()
    activeExecutions.removeValue(forKey: execution.id)
    lock.unlock()
  }

  private func runtimePID(for lease: RuntimeAuthorizationLease) -> pid_t? {
    lock.lock()
    defer { lock.unlock() }
    return isValidLocked(lease) ? lease.runtimePID : nil
  }

  private func isValidLocked(_ lease: RuntimeAuthorizationLease) -> Bool {
    guard generation == lease.generation,
          runtimePID == lease.runtimePID,
          liveRuntimePIDLocked() == lease.runtimePID else { return false }
    if let leaseRevision = lease.revision, revision != leaseRevision { return false }
    return true
  }

  private func isCurrentLeaseForUse(_ lease: RuntimeAuthorizationLease) -> Bool {
    lock.lock()
    guard isValidLocked(lease) else {
      lock.unlock()
      return false
    }
    let packagedPeerPID = lease.packagedPeerPID
    lock.unlock()

    guard let packagedPeerPID else { return true }
    guard isCurrentPackagedPeer(
      peerPID: packagedPeerPID,
      runtimePID: lease.runtimePID,
      generation: lease.generation
    ) else { return false }

    lock.lock()
    let remainsValid = isValidLocked(lease)
    lock.unlock()
    return remainsValid
  }

  private func liveRuntimePIDLocked() -> pid_t? {
    guard let pid = runtimePID, isProcessAlive(pid) else { return nil }
    return pid
  }

  private func useRequestIDLocked(_ requestId: String, advancesRevision: Bool = true) -> Bool {
    guard usedRequestIDs.count < 256, usedRequestIDs.insert(requestId).inserted else { return false }
    if advancesRevision { revision &+= 1 }
    return true
  }

  private func isAuthorizedOwnerLocked(peerPID: pid_t, ownerToken: String) -> Bool {
    if peerPID == runtimePID { return desktopAttested && desktopOwnerToken == ownerToken }
    guard let registration = registrations[peerPID],
          registration.role == "daemon" || registration.role == "plugin",
          registration.attested,
          registration.registrationToken == ownerToken else { return false }
    return true
  }

  private func authorizationSnapshotLocked() -> AuthorizationSnapshot? {
    guard let runtimePID,
          let processPolicy,
          let hostIdentity,
          let hostPID else { return nil }
    return AuthorizationSnapshot(
      generation: generation,
      revision: revision,
      runtimePID: runtimePID,
      processPolicy: processPolicy,
      hostIdentity: hostIdentity,
      hostPID: hostPID,
      hostProcessIdentity: hostProcessIdentity,
      desktopOwnerToken: desktopOwnerToken,
      desktopAttested: desktopAttested,
      desktopIdentity: desktopIdentity,
      registrations: registrations
    )
  }

  private func isCurrentStateLocked(_ snapshot: AuthorizationSnapshot) -> Bool {
    generation == snapshot.generation &&
      revision == snapshot.revision &&
      runtimePID == snapshot.runtimePID
  }

  private func makeRemovalEvents(
    action: MeetlessProcessRegistrationDiagnosticAction,
    removedPIDs: Set<pid_t>,
    registrations: [pid_t: RegisteredChild],
    failures: [pid_t: MeetlessProcessRegistrationFailure],
    generation: UInt64,
    revision: UInt64,
    fallbackStage: MeetlessProcessRegistrationDiagnosticStage,
    fallbackCheck: MeetlessProcessRegistrationDiagnosticCheck
  ) -> [MeetlessProcessRegistrationRemovalEvent] {
    removedPIDs.sorted().compactMap { pid in
      guard let registration = registrations[pid] else { return nil }
      let failure = failures[pid] ?? MeetlessProcessRegistrationFailure(
        role: MeetlessProcessRegistrationFailure.role(for: registration.role),
        stage: fallbackStage,
        check: fallbackCheck,
        osCode: .none
      )
      return MeetlessProcessRegistrationRemovalEvent(
        action: action,
        failure: failure,
        pid: pid,
        generation: generation,
        revision: revision
      )
    }
  }

  private func recordRemovalEvents(
    _ events: [MeetlessProcessRegistrationRemovalEvent],
    using sink: MeetlessProcessRegistrationDiagnosticSink?
  ) {
    guard let sink else { return }
    events.forEach { sink.record($0) }
  }

  private func notifyInspectionHook() {
    lock.lock()
    let hook = inspectionHook
    inspectionHook = nil
    lock.unlock()
    hook?()
  }

  private func notifyPruneInspectionHook() {
    lock.lock()
    let hook = pruneInspectionHook
    pruneInspectionHook = nil
    lock.unlock()
    hook?()
  }

  private func registrationOwnerPlanLocked(
    peerPID: pid_t,
    childPID: pid_t,
    role: String,
    ownerToken: String,
    observedParentPID: pid_t?,
    snapshot: AuthorizationSnapshot
  ) -> RegistrationOwnerPlan? {
    if peerPID == runtimePID {
      guard role == "daemon",
            snapshot.desktopAttested,
            snapshot.desktopOwnerToken == ownerToken,
            let desktopIdentity = snapshot.desktopIdentity,
            let hostProcessIdentity = snapshot.hostProcessIdentity else { return nil }
      return RegistrationOwnerPlan(
        role: "desktop",
        pid: snapshot.runtimePID,
        expectedIdentity: desktopIdentity,
        parentPID: snapshot.hostPID,
        expectedParentIdentity: hostProcessIdentity
      )
    }
    if role == "capture-helper",
       let registration = snapshot.registrations[peerPID],
       registration.role == "plugin",
       registration.attested,
       registration.registrationToken == ownerToken {
      return RegistrationOwnerPlan(
        role: "plugin",
        pid: registration.pid,
        expectedIdentity: registration.expectedIdentity,
        parentPID: registration.owner.pid,
        expectedParentIdentity: registration.owner.identity
      )
    }
    // The Paseo supervisor owns its worker ChildProcess, but that worker is
    // created inside the pinned supervisor entrypoint. The worker remains an
    // unregistered, native-pinned intermediate: only its exact direct child
    // plugin process may self-register with the already-attested supervisor
    // token.
    if role == "plugin", childPID == peerPID,
       let workerPID = observedParentPID,
       let daemon = snapshot.registrations.values.first(where: {
         $0.role == "daemon" && $0.attested && $0.registrationToken == ownerToken
       }) {
      return RegistrationOwnerPlan(
        role: "daemon-worker",
        pid: workerPID,
        expectedIdentity: expectedProcessIdentity(for: "daemon-worker", policy: snapshot.processPolicy),
        parentPID: daemon.pid,
        expectedParentIdentity: daemon.expectedIdentity
      )
    }
    return nil
  }

  private func registrationRoleMatchesOwner(
    peerPID: pid_t,
    role: String,
    snapshot: AuthorizationSnapshot
  ) -> Bool {
    if peerPID == snapshot.runtimePID { return role == "daemon" }
    if role == "plugin" { return true }
    guard let registration = snapshot.registrations[peerPID] else { return false }
    if registration.role == "daemon" { return role == "plugin" }
    if registration.role == "plugin" { return role == "capture-helper" }
    return false
  }

  private func registrationOwnerTokenMatches(
    peerPID: pid_t,
    role: String,
    ownerToken: String,
    snapshot: AuthorizationSnapshot
  ) -> Bool {
    if peerPID == snapshot.runtimePID {
      return role == "daemon" && snapshot.desktopAttested && snapshot.desktopOwnerToken == ownerToken
    }
    if role == "plugin" {
      return snapshot.registrations.values.contains {
        $0.role == "daemon" && $0.attested && $0.registrationToken == ownerToken
      }
    }
    guard let registration = snapshot.registrations[peerPID], registration.attested else { return false }
    if role == "capture-helper" && registration.role == "plugin" {
      return registration.registrationToken == ownerToken
    }
    return false
  }

  private func isPackagedPeerAuthorizedLocked(_ peerPID: pid_t) -> Bool {
    if peerPID == runtimePID { return desktopAttested }
    return registrations[peerPID]?.attested == true
  }

  private func isCurrentPackagedPeer(peerPID: pid_t, runtimePID: pid_t, generation: UInt64) -> Bool {
    for _ in 0..<3 {
      lock.lock()
      guard self.generation == generation,
            self.runtimePID == runtimePID,
            let snapshot = authorizationSnapshotLocked(),
            isPackagedPeerAuthorizedLocked(peerPID) else {
        lock.unlock()
        return false
      }
      lock.unlock()

      guard inspectPackagedPeer(peerPID: peerPID, snapshot: snapshot) else { return false }
      notifyInspectionHook()
      lock.lock()
      guard isCurrentStateLocked(snapshot) else {
        lock.unlock()
        continue
      }
      lock.unlock()

      guard inspectPackagedPeer(peerPID: peerPID, snapshot: snapshot) else { return false }
      lock.lock()
      guard isCurrentStateLocked(snapshot), isPackagedPeerAuthorizedLocked(peerPID) else {
        lock.unlock()
        continue
      }
      lock.unlock()
      return true
    }
    return false
  }

  private func inspectPackagedPeer(
    peerPID: pid_t,
    snapshot: AuthorizationSnapshot
  ) -> Bool {
    if peerPID == snapshot.runtimePID {
      return snapshot.desktopAttested && inspectDesktopAttestation(snapshot) != nil
    }
    guard let registration = snapshot.registrations[peerPID], registration.attested else { return false }
    return inspectRegisteredProcess(registration, snapshot: snapshot) != nil
  }

  private func inspectDesktopAttestation(
    _ snapshot: AuthorizationSnapshot
  ) -> (identity: MeetlessProcessIdentity, hostProcessIdentity: MeetlessProcessIdentity)? {
    let expected = expectedProcessIdentity(for: "desktop", policy: snapshot.processPolicy)
    guard liveParentPID(snapshot.runtimePID) == snapshot.hostPID,
          let identity = try? inspectMeetlessProcessIdentity(snapshot.runtimePID),
          processIdentityMatchesShape(identity, expected),
          let currentHostIdentity = try? inspectMeetlessProcessIdentity(snapshot.hostPID),
          hostProcessIdentityMatchesAttestation(currentHostIdentity, snapshot.hostIdentity) else { return nil }
    if let recordedDesktop = snapshot.desktopIdentity, recordedDesktop != identity { return nil }
    if let recordedHost = snapshot.hostProcessIdentity, recordedHost != currentHostIdentity { return nil }
    return (identity, currentHostIdentity)
  }

  private func inspectRegistrationCandidateDiagnosed(
    role: String,
    childPID: pid_t,
    expectedIdentity: MeetlessProcessIdentity,
    ownerPlan: RegistrationOwnerPlan,
    snapshot: AuthorizationSnapshot
  ) -> RegistrationCandidateInspection {
    let diagnosticRole = MeetlessProcessRegistrationFailure.role(for: role)
    let childParent = inspectLiveParentPID(childPID)
    guard let childParentPID = childParent.pid else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .processInspectionUnavailable,
        osCode: childParent.osCode
      ))
    }
    guard childParentPID == ownerPlan.pid else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .parentMismatch,
        osCode: .none
      ))
    }

    let liveIdentity: MeetlessProcessIdentity
    do {
      liveIdentity = try inspectMeetlessProcessIdentity(childPID)
    } catch {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .processInspectionUnavailable,
        osCode: normalizedInspectionCode(error)
      ))
    }
    guard liveIdentity == expectedIdentity else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .childIdentityMismatch,
        osCode: .none
      ))
    }

    let ownerParent = inspectLiveParentPID(ownerPlan.pid)
    guard let ownerParentPID = ownerParent.pid else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .processInspectionUnavailable,
        osCode: ownerParent.osCode
      ))
    }
    guard ownerParentPID == ownerPlan.parentPID else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .ownerChainFailure,
        osCode: .none
      ))
    }

    let ownerIdentity: MeetlessProcessIdentity
    do {
      ownerIdentity = try inspectMeetlessProcessIdentity(ownerPlan.pid)
    } catch {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .processInspectionUnavailable,
        osCode: normalizedInspectionCode(error)
      ))
    }
    guard processIdentityMatchesShape(ownerIdentity, ownerPlan.expectedIdentity) else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .ownerChainFailure,
        osCode: .none
      ))
    }

    let parentIdentity: MeetlessProcessIdentity
    do {
      parentIdentity = try inspectMeetlessProcessIdentity(ownerPlan.parentPID)
    } catch {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .processInspectionUnavailable,
        osCode: normalizedInspectionCode(error)
      ))
    }
    guard parentIdentity == ownerPlan.expectedParentIdentity else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .inspection,
        check: .ownerChainFailure,
        osCode: .none
      ))
    }

    let owner = ProcessOwnerEvidence(
      role: ownerPlan.role,
      pid: ownerPlan.pid,
      identity: ownerIdentity,
      parentPID: ownerPlan.parentPID,
      parentIdentity: parentIdentity
    )
    var visited = Set<pid_t>()
    guard validateOwnerEvidence(owner, snapshot: snapshot, visited: &visited) else {
      return .rejected(MeetlessProcessRegistrationFailure(
        role: diagnosticRole,
        stage: .ownership,
        check: .ownerChainFailure,
        osCode: .none
      ))
    }
    return .accepted(identity: liveIdentity, owner: owner)
  }

  private func normalizedInspectionCode(_ error: Error) -> MeetlessNormalizedOSCode {
    guard let inspectionError = error as? MeetlessProcessInspectionError else { return .unknown }
    switch inspectionError {
    case .unavailable(let osCode, _): return osCode
    }
  }

  private func inspectionDetails(_ error: Error) -> (osCode: MeetlessNormalizedOSCode, source: MeetlessProcessInspectionSource?) {
    guard let inspectionError = error as? MeetlessProcessInspectionError else {
      return (osCode: .unknown, source: nil)
    }
    switch inspectionError {
    case .unavailable(let osCode, let source): return (osCode: osCode, source: source)
    }
  }

  private func processGone(_ osCode: MeetlessNormalizedOSCode) -> Bool {
    osCode == .enoent || osCode == .esrch
  }

  private func diagnosedInspectionFailure(
    role: MeetlessProcessRegistrationDiagnosticRole,
    stage: MeetlessProcessRegistrationDiagnosticStage,
    observation: MeetlessParentPIDObservation
  ) -> MeetlessProcessRegistrationFailure {
    registrationFailure(
      role: role,
      stage: stage,
      check: processGone(observation.osCode) ? .processGone : .processInspectionUnavailable,
      osCode: observation.osCode
    )
  }

  private func diagnosedInspectionFailure(
    role: MeetlessProcessRegistrationDiagnosticRole,
    stage: MeetlessProcessRegistrationDiagnosticStage,
    error: Error
  ) -> MeetlessProcessRegistrationFailure {
    let details = inspectionDetails(error)
    let gone = processGone(details.osCode) &&
      (details.source == .processPath || details.source == .arguments)
    return registrationFailure(
      role: role,
      stage: stage,
      check: gone ? .processGone : .processInspectionUnavailable,
      osCode: details.osCode
    )
  }

  private func registrationFailure(
    role: MeetlessProcessRegistrationDiagnosticRole,
    stage: MeetlessProcessRegistrationDiagnosticStage,
    check: MeetlessProcessRegistrationDiagnosticCheck,
    osCode: MeetlessNormalizedOSCode = .none
  ) -> MeetlessProcessRegistrationFailure {
    MeetlessProcessRegistrationFailure(role: role, stage: stage, check: check, osCode: osCode)
  }

  private func inspectRegisteredProcess(
    _ registration: RegisteredChild,
    snapshot: AuthorizationSnapshot
  ) -> MeetlessProcessIdentity? {
    guard let identity = try? inspectMeetlessProcessIdentity(registration.pid),
          identity == registration.expectedIdentity,
          liveParentPID(registration.pid) == registration.owner.pid else { return nil }
    var visited = Set<pid_t>()
    guard validateRegistrationChain(registration, snapshot: snapshot, visited: &visited) else { return nil }
    return identity
  }

  private func inspectAuthorizedOwner(
    peerPID: pid_t,
    ownerToken: String,
    snapshot: AuthorizationSnapshot
  ) -> Bool {
    if peerPID == snapshot.runtimePID {
      guard snapshot.desktopAttested,
            snapshot.desktopOwnerToken == ownerToken else { return false }
      return inspectDesktopAttestation(snapshot) != nil
    }
    guard let registration = snapshot.registrations[peerPID],
          (registration.role == "daemon" || registration.role == "plugin"),
          registration.attested,
          registration.registrationToken == ownerToken else { return false }
    return inspectRegisteredProcess(registration, snapshot: snapshot) != nil
  }

  private func inspectRegistrationStatus(
    _ snapshot: AuthorizationSnapshot
  ) -> [MeetlessProcessRegistrationStatus]? {
    guard inspectDesktopAttestation(snapshot) != nil else { return nil }
    var result: [MeetlessProcessRegistrationStatus] = []
    for registration in snapshot.registrations.values {
      guard let identity = inspectRegisteredProcess(registration, snapshot: snapshot) else { return nil }
      result.append(MeetlessProcessRegistrationStatus(
        role: registration.role,
        pid: registration.pid,
        attested: registration.attested,
        identity: MeetlessProcessIdentityWire(
          configuredPath: identity.configuredPath,
          realPath: identity.realPath,
          device: identity.device,
          inode: identity.inode,
          byteLength: identity.byteLength,
          sha256: identity.sha256,
          argv: identity.argv
        )
      ))
    }
    return result
  }

  private func validateRegistrationChain(
    _ registration: RegisteredChild,
    snapshot: AuthorizationSnapshot,
    visited: inout Set<pid_t>
  ) -> Bool {
    validateRegistrationChainDiagnosed(registration, snapshot: snapshot, visited: &visited) == nil
  }

  private func validateRegistrationChainDiagnosed(
    _ registration: RegisteredChild,
    snapshot: AuthorizationSnapshot,
    visited: inout Set<pid_t>
  ) -> MeetlessProcessRegistrationFailure? {
    let diagnosticRole = MeetlessProcessRegistrationFailure.role(for: registration.role)
    guard visited.insert(registration.pid).inserted else {
      return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
    }

    let identity: MeetlessProcessIdentity
    do {
      identity = try inspectMeetlessProcessIdentity(registration.pid)
    } catch {
      return diagnosedInspectionFailure(role: diagnosticRole, stage: .inspection, error: error)
    }
    guard identity == registration.expectedIdentity else {
      return registrationFailure(role: diagnosticRole, stage: .inspection, check: .childIdentityMismatch)
    }

    let parentObservation = inspectLiveParentPID(registration.pid)
    guard let parentPID = parentObservation.pid else {
      return diagnosedInspectionFailure(role: diagnosticRole, stage: .inspection, observation: parentObservation)
    }
    guard parentPID == registration.owner.pid else {
      return registrationFailure(role: diagnosticRole, stage: .inspection, check: .parentMismatch)
    }

    return validateOwnerEvidenceDiagnosed(
      registration.owner,
      diagnosticRole: diagnosticRole,
      snapshot: snapshot,
      visited: &visited
    )
  }

  private func validateOwnerEvidence(
    _ owner: ProcessOwnerEvidence,
    snapshot: AuthorizationSnapshot,
    visited: inout Set<pid_t>
  ) -> Bool {
    validateOwnerEvidenceDiagnosed(
      owner,
      diagnosticRole: .unknown,
      snapshot: snapshot,
      visited: &visited
    ) == nil
  }

  private func validateOwnerEvidenceDiagnosed(
    _ owner: ProcessOwnerEvidence,
    diagnosticRole: MeetlessProcessRegistrationDiagnosticRole,
    snapshot: AuthorizationSnapshot,
    visited: inout Set<pid_t>
  ) -> MeetlessProcessRegistrationFailure? {
    guard owner.pid > 1, owner.parentPID > 1 else {
      return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
    }

    let currentIdentity: MeetlessProcessIdentity
    do {
      currentIdentity = try inspectMeetlessProcessIdentity(owner.pid)
    } catch {
      return diagnosedInspectionFailure(role: diagnosticRole, stage: .inspection, error: error)
    }
    guard currentIdentity == owner.identity else {
      return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
    }

    let parentObservation = inspectLiveParentPID(owner.pid)
    guard let parentPID = parentObservation.pid else {
      return diagnosedInspectionFailure(role: diagnosticRole, stage: .inspection, observation: parentObservation)
    }
    guard parentPID == owner.parentPID else {
      return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
    }

    let currentParentIdentity: MeetlessProcessIdentity
    do {
      currentParentIdentity = try inspectMeetlessProcessIdentity(owner.parentPID)
    } catch {
      return diagnosedInspectionFailure(role: diagnosticRole, stage: .inspection, error: error)
    }
    guard currentParentIdentity == owner.parentIdentity else {
      return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
    }

    switch owner.role {
    case "desktop":
      guard snapshot.desktopAttested,
            owner.pid == snapshot.runtimePID,
            owner.identity == snapshot.desktopIdentity,
            owner.parentPID == snapshot.hostPID,
            owner.parentIdentity == snapshot.hostProcessIdentity,
            processIdentityMatchesShape(owner.identity, expectedProcessIdentity(for: "desktop", policy: snapshot.processPolicy)),
            hostProcessIdentityMatchesAttestation(owner.parentIdentity, snapshot.hostIdentity) else {
        return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
      }
      return nil
    case "daemon-worker":
      guard daemonWorkerIdentityMatchesPolicy(owner.identity, policy: snapshot.processPolicy),
            let daemon = snapshot.registrations[owner.parentPID],
            daemon.role == "daemon",
            daemon.attested,
            daemon.expectedIdentity == owner.parentIdentity else {
        return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
      }
      guard validateRegistrationChainDiagnosed(daemon, snapshot: snapshot, visited: &visited) == nil else {
        return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
      }
      return nil
    case "plugin":
      guard let plugin = snapshot.registrations[owner.pid],
            plugin.role == "plugin",
            plugin.attested,
            plugin.expectedIdentity == owner.identity,
            plugin.owner.pid == owner.parentPID,
            plugin.owner.identity == owner.parentIdentity else {
        return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
      }
      guard validateRegistrationChainDiagnosed(plugin, snapshot: snapshot, visited: &visited) == nil else {
        return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
      }
      return nil
    default:
      return registrationFailure(role: diagnosticRole, stage: .ownership, check: .ownerChainFailure)
    }
  }

  @discardableResult
  private func removeRegistrationAndDescendantsLocked(startingAt pid: pid_t) -> Set<pid_t> {
    removeRegistrationAndDescendantsLocked(pids: [pid])
  }

  @discardableResult
  private func removeRegistrationAndDescendantsLocked(pids initial: Set<pid_t>) -> Set<pid_t> {
    var removed = initial
    var changed = true
    while changed {
      changed = false
      for registration in registrations.values where
        removed.contains(registration.owner.pid) || removed.contains(registration.owner.parentPID) {
        if removed.insert(registration.pid).inserted { changed = true }
      }
    }
    for pid in removed { registrations.removeValue(forKey: pid) }
    return removed
  }

  private func processIdentityMatchesShape(
    _ identity: MeetlessProcessIdentity,
    _ expected: MeetlessProcessIdentity
  ) -> Bool {
    identity.configuredPath == expected.configuredPath &&
      identity.realPath == expected.realPath &&
      identity.argv == expected.argv
  }

  private func daemonWorkerIdentityMatchesPolicy(
    _ identity: MeetlessProcessIdentity,
    policy: MeetlessProcessRegistrationPolicy
  ) -> Bool {
    guard policy.daemonWorkerArguments.count == 3,
          policy.daemonWorkerArguments[0] == policy.nodePath,
          policy.daemonWorkerArguments[1] == policy.daemonWorkerPath,
          policy.daemonWorkerArguments[2] == "daemon" else { return false }
    return processIdentityMatchesShape(
      identity,
      expectedProcessIdentity(for: "daemon-worker", policy: policy)
    )
  }

  private func hostProcessIdentityMatchesAttestation(
    _ identity: MeetlessProcessIdentity,
    _ expected: MeetlessHostIdentityAttestation
  ) -> Bool {
    identity.configuredPath == expected.executablePath &&
      identity.realPath == expected.executablePath &&
      identity.device == expected.binaryDevice &&
      identity.inode == expected.binaryInode &&
      identity.byteLength == expected.binarySize &&
      identity.sha256 == expected.binarySha256
  }
}

private func packagedDaemonWorkerPath(_ packageRoot: String) -> String {
  URL(fileURLWithPath: packageRoot)
    .appendingPathComponent("vendor/paseo/packages/server/dist/server/server/daemon-worker.js")
    .standardizedFileURL
    .path
}

private func packagedPluginProcessPath(_ packageRoot: String) -> String {
  URL(fileURLWithPath: packageRoot)
    .appendingPathComponent("vendor/paseo/packages/server/dist/server/server/plugins/plugin-process.js")
    .standardizedFileURL
    .path
}

private func validProtocolToken(_ value: String) -> Bool {
  !value.isEmpty && value == value.trimmingCharacters(in: .whitespacesAndNewlines) && value.utf8.count <= 4_096 && !value.contains("\0")
}

private func validProcessRole(_ role: String) -> Bool {
  role == "daemon" || role == "plugin" || role == "capture-helper"
}

private func policyMatches(
  _ wire: MeetlessHostProcessPolicyWire,
  _ policy: MeetlessProcessRegistrationPolicy
) -> Bool {
  wire.runtimeRoot == policy.runtimeRoot &&
    wire.endpointPolicy == policy.endpointPolicy &&
    wire.endpointWorkingDirectory == policy.endpointWorkingDirectory &&
    wire.recordingEndpointName == policy.recordingEndpointName &&
    wire.transcriptionEndpointName == policy.transcriptionEndpointName
}

private func expectedProcessIdentity(
  for role: String,
  policy: MeetlessProcessRegistrationPolicy
) -> MeetlessProcessIdentity {
  let executablePath = role == "capture-helper" ? policy.captureHelperPath : policy.nodePath
  let arguments = role == "desktop"
    ? [policy.nodePath, policy.runtimeCliPath, "desktop"]
    : role == "daemon"
    ? [policy.nodePath, policy.runtimeCliPath, "daemon"]
    : role == "daemon-worker"
    ? policy.daemonWorkerArguments
    : role == "plugin"
    ? policy.pluginArguments
    : [policy.captureHelperPath]
  return MeetlessProcessIdentity(
    configuredPath: executablePath,
    realPath: executablePath,
    device: 0,
    inode: 0,
    byteLength: 0,
    sha256: "",
    argv: arguments
  )
}

private func expectedIdentityMatchesPolicy(
  _ identity: MeetlessProcessIdentity,
  role: String,
  policy: MeetlessProcessRegistrationPolicy
) -> Bool {
  if role == "plugin" &&
     (policy.pluginArguments != [policy.nodePath, policy.pluginPath]) {
    return false
  }
  let expected = expectedProcessIdentity(for: role, policy: policy)
  return identity.configuredPath == expected.configuredPath &&
    identity.argv == expected.argv &&
    (role != "plugin" || expected.argv.dropFirst().first == policy.pluginPath)
}

private func isProcessAlive(_ pid: pid_t) -> Bool {
  guard pid > 1 else { return false }
  if kill(pid, 0) == 0 { return true }
  return errno == EPERM
}

struct RuntimeAuthorizationLease {
  let runtimePID: pid_t
  let generation: UInt64
  let revision: UInt64?
  let packagedPeerPID: pid_t?
}

struct RuntimeAuthorizationExecution {
  let id: UUID
  let cancellation: NativeRequestCancellation
}

func isOpenAISecretEnvironmentEntry(key: String, value: String) -> Bool {
  let normalizedKey = key.uppercased().filter { $0.isLetter || $0.isNumber }
  let secretName = normalizedKey.contains("OPENAI") &&
    ["KEY", "TOKEN", "SECRET", "CREDENTIAL", "PASSWORD"].contains { normalizedKey.contains($0) }
  let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
  let secretValue = trimmedValue.range(
    of: #"^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}$"#,
    options: .regularExpression
  ) != nil
  return secretName || secretValue
}
