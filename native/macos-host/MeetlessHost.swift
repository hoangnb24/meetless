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
    try identity(configuration)
    configurationReady(configuration)
    try lock(configuration)
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
  let identityPath: String
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

private struct InstallationContract: Decodable {
  let schema: String
  let bundleIdentifier: String
  let installPath: String
  let userSupportRelativePath: String
  let recordingExportsRelativePath: String
  let identityRelativePath: String
  let runtime: [String: String]
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
  if manager.fileExists(atPath: identityURL.path) {
    _ = try manager.replaceItemAt(identityURL, withItemAt: temporaryURL)
  } else {
    try manager.moveItem(at: temporaryURL, to: identityURL)
  }
}

final class HostDelegate: NSObject, NSApplicationDelegate {
  private var runtime: Process?
  private var runtimeLog: FileHandle?
  private var lockDescriptor: Int32 = -1
  private var signalSources: [DispatchSourceSignal] = []
  private var configuration: HostConfiguration?
  private var transcriptionCapability: MeetlessTranscriptionCapability?
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
        identity: { configuration in try self.publishIdentity(configuration) },
        configurationReady: { configuration in self.configuration = configuration },
        lock: { configuration in try self.acquireRuntimeLock(configuration.runtimeRoot) },
        capability: { configuration in
          self.installSignalHandlers()
          let capability = MeetlessTranscriptionCapability(
            socketPath: configuration.transcriptionSocket,
            stagingDirectory: configuration.transcriptionStaging,
            runtimeAuthorization: self.runtimeAuthorization
          )
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
    if lockDescriptor >= 0 {
      flock(lockDescriptor, LOCK_UN)
      close(lockDescriptor)
      lockDescriptor = -1
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
        identityPath: identityPath
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
      contract.runtime["transcriptionSocketRelativePath"] == transcriptionSocketRelative,
      contract.runtime["transcriptionStagingRelativePath"] == transcriptionStagingRelative
    else { throw hostPreflightError("host configuration differs from the installation contract") }

    let runtimeRoot = try resolvePackagedRuntimeRoot(runtimeRootRelative, label: "runtime root")
    let identityPath = try containedPath(runtimeRoot, identityRelative, label: "host identity")
    let transcriptionSocket = try containedPath(runtimeRoot, transcriptionSocketRelative, label: "transcription socket")
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
      identityPath: identityPath
    )
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

  private func publishIdentity(_ configuration: HostConfiguration) throws {
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
    if FileManager.default.fileExists(atPath: configuration.identityPath) {
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
  }

  private func showLaunchGuidance(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Move Meetless to Applications"
    alert.informativeText = message
    alert.alertStyle = .warning
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }

  private func acquireRuntimeLock(_ runtimeRoot: String) throws {
    try FileManager.default.createDirectory(
      atPath: runtimeRoot,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let lockPath = URL(fileURLWithPath: runtimeRoot).appendingPathComponent("meetless-host.lock").path
    lockDescriptor = open(lockPath, O_CREAT | O_RDWR, 0o600)
    guard lockDescriptor >= 0, flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 else {
      let owner = (try? String(contentsOfFile: lockPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) ?? "unknown owner"
      throw NSError(
        domain: "MeetlessHost",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "MeetlessHost start rejected because the shared install/start lock is held by \(owner); retry after the exact installer or host exits"]
      )
    }
    let identity = "{\"role\":\"host\",\"pid\":\(getpid())}\n"
    ftruncate(lockDescriptor, 0)
    _ = identity.withCString { write(lockDescriptor, $0, strlen($0)) }
    fsync(lockDescriptor)
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
    process.currentDirectoryURL = URL(fileURLWithPath: configuration.repositoryRoot)
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
    environment["MEETLESS_TRANSCRIPTION_SOCKET"] = configuration.transcriptionSocket
    environment["MEETLESS_TRANSCRIPTION_STAGING"] = configuration.transcriptionStaging
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
  private let lock = NSLock()
  private var runtimePID: pid_t?
  private var generation: UInt64 = 0
  private var activeExecutions: [UUID: NativeRequestCancellation] = [:]

  func publish(_ pid: pid_t) {
    lock.lock()
    generation &+= 1
    runtimePID = pid > 1 ? pid : nil
    let cancellations = Array(activeExecutions.values)
    activeExecutions.removeAll()
    lock.unlock()
    cancellations.forEach { $0.cancel() }
  }

  func clear(expected: pid_t? = nil) {
    lock.lock()
    guard expected == nil || runtimePID == expected else {
      lock.unlock()
      return
    }
    generation &+= 1
    runtimePID = nil
    let cancellations = Array(activeExecutions.values)
    activeExecutions.removeAll()
    lock.unlock()
    cancellations.forEach { $0.cancel() }
  }

  func snapshot() -> pid_t? {
    lock.lock()
    defer { lock.unlock() }
    guard let pid = runtimePID, pid > 1, kill(pid, 0) == 0 else { return nil }
    return pid
  }

  func issueLease(peerPID: pid_t, authorizer: RuntimePeerAuthorizer) -> RuntimeAuthorizationLease? {
    lock.lock()
    guard let pid = liveRuntimePIDLocked() else {
      lock.unlock()
      return nil
    }
    let candidate = RuntimeAuthorizationLease(runtimePID: pid, generation: generation)
    lock.unlock()
    guard authorizer.isAuthorized(peerPID: peerPID, expectedRuntimePID: { [weak self] in
      self?.runtimePID(for: candidate)
    }) else { return nil }
    lock.lock()
    defer { lock.unlock() }
    return isValidLocked(candidate) ? candidate : nil
  }

  func withValidLease<T>(_ lease: RuntimeAuthorizationLease, _ action: () -> T) -> T? {
    lock.lock()
    guard isValidLocked(lease) else {
      lock.unlock()
      return nil
    }
    lock.unlock()

    let result = action()

    lock.lock()
    let remainsValid = isValidLocked(lease)
    lock.unlock()
    return remainsValid ? result : nil
  }

  func beginExecution(_ lease: RuntimeAuthorizationLease) -> RuntimeAuthorizationExecution? {
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
    generation == lease.generation && runtimePID == lease.runtimePID && liveRuntimePIDLocked() == lease.runtimePID
  }

  private func liveRuntimePIDLocked() -> pid_t? {
    guard let pid = runtimePID, pid > 1, kill(pid, 0) == 0 else { return nil }
    return pid
  }
}

struct RuntimeAuthorizationLease {
  let runtimePID: pid_t
  let generation: UInt64
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
