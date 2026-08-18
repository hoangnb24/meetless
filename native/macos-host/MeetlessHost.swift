import AppKit
import Darwin
import Foundation

private struct HostConfiguration: Decodable {
  let repositoryRoot: String
  let runtimeRoot: String
  let listen: String
  let transcriptionSocket: String
  let transcriptionStaging: String
  let nodePath: String
  let runtimeCliPath: String
  let identityPath: String
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
      guard getppid() == 1 else {
        throw NSError(
          domain: "MeetlessHost",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "must be launched through LaunchServices; run npm run runtime:host"]
        )
      }
      let configuration = try loadConfiguration()
      self.configuration = configuration
      try acquireRuntimeLock(configuration.runtimeRoot)
      installSignalHandlers()
      let capability = MeetlessTranscriptionCapability(
        socketPath: configuration.transcriptionSocket,
        stagingDirectory: configuration.transcriptionStaging,
        runtimeAuthorization: runtimeAuthorization
      )
      try capability.start()
      transcriptionCapability = capability
      try launchRuntime(configuration)
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
    return try JSONDecoder().decode(HostConfiguration.self, from: data)
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
    environment["MEETLESS_HOST_PID"] = String(getpid())
    environment["MEETLESS_HOST_BUNDLE_PATH"] = Bundle.main.bundlePath
    environment["MEETLESS_HOST_IDENTITY_PATH"] = configuration.identityPath
    environment["MEETLESS_TRANSCRIPTION_SOCKET"] = configuration.transcriptionSocket
    environment["MEETLESS_TRANSCRIPTION_STAGING"] = configuration.transcriptionStaging
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
    defer { lock.unlock() }
    guard isValidLocked(lease) else { return nil }
    return action()
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
