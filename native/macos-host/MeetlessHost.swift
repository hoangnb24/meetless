import AppKit
import Darwin
import Foundation

private struct HostConfiguration: Decodable {
  let repositoryRoot: String
  let runtimeRoot: String
  let listen: String
  let nodePath: String
  let runtimeCliPath: String
}

private func logError(_ message: String) {
  FileHandle.standardError.write(Data("MeetlessHost: \(message)\n".utf8))
  NSLog("MeetlessHost: %@", message)
}

private final class HostDelegate: NSObject, NSApplicationDelegate {
  private var runtime: Process?
  private var runtimeLog: FileHandle?
  private var lockDescriptor: Int32 = -1
  private var signalSources: [DispatchSourceSignal] = []

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
      try acquireRuntimeLock(configuration.runtimeRoot)
      installSignalHandlers()
      try launchRuntime(configuration)
    } catch {
      logError(error.localizedDescription)
      NSApp.terminate(nil)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let runtime, runtime.isRunning {
      runtime.terminate()
      runtime.waitUntilExit()
    }
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
      throw NSError(
        domain: "MeetlessHost",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "another repo-owned Meetless host already owns \(runtimeRoot)"]
      )
    }
    let identity = "\(getpid())\n"
    ftruncate(lockDescriptor, 0)
    _ = identity.withCString { write(lockDescriptor, $0, strlen($0)) }
    fsync(lockDescriptor)
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
    environment["MEETLESS_RUNTIME_ROOT"] = configuration.runtimeRoot
    environment["MEETLESS_LISTEN"] = configuration.listen
    environment["MEETLESS_HOST_PID"] = String(getpid())
    environment["MEETLESS_HOST_BUNDLE_PATH"] = Bundle.main.bundlePath
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
    process.terminationHandler = { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
    try process.run()
    runtime = process
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

let application = NSApplication.shared
private let delegate = HostDelegate()
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
