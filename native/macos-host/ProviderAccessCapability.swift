import AppKit
import Foundation
import Darwin

struct MeetlessProviderAccessResult {
  let outcome: String
  let providers: [[String: String]]
}

protocol MeetlessProviderAccess {
  func status() -> MeetlessProviderAccessResult
  func request(provider: String, authorized: () -> Bool) -> MeetlessProviderAccessResult
}

struct MeetlessUnavailableProviderAccess: MeetlessProviderAccess {
  func status() -> MeetlessProviderAccessResult {
    MeetlessProviderAccessResult(outcome: "status", providers: ["codex", "claude", "opencode"].map { ["id": $0, "status": "unavailable"] })
  }
  func request(provider: String, authorized: () -> Bool) -> MeetlessProviderAccessResult { status() }
}

struct MeetlessUnrestrictedProviderAccess: MeetlessProviderAccess {
  func status() -> MeetlessProviderAccessResult {
    MeetlessProviderAccessResult(outcome: "status", providers: ["codex", "claude", "opencode"].map { ["id": $0, "status": "ready"] })
  }
  func request(provider: String, authorized: () -> Bool) -> MeetlessProviderAccessResult { status() }
}

func meetlessProjectProviderEnvironment(
  _ source: [String: String],
  runtimeRoot: String,
  grants: [String: [String: String]],
  bundleInfo: [String: Any]? = Bundle.main.infoDictionary
) throws -> [String: String] {
  var environment = source
  environment.removeValue(forKey: "MEETLESS_PROVIDER_ENV")
  guard let policy = meetlessSignaturePolicy(forRuntimeRoot: runtimeRoot, bundleInfo: bundleInfo), policy.isAppStore else { return environment }
  // Capture the original override in the manager, then forward it only via a restored grant.
  environment.removeValue(forKey: "CODEX_HOME")
  environment.removeValue(forKey: "CODEX_EXECUTABLE")
  if !grants.isEmpty {
    environment["MEETLESS_PROVIDER_ENV"] = String(data: try JSONSerialization.data(withJSONObject: grants), encoding: .utf8)
  }
  return environment
}

func meetlessRealUserHome() -> URL? {
  guard let entry = getpwuid(getuid()), let home = entry.pointee.pw_dir else { return nil }
  return URL(fileURLWithPath: String(cString: home), isDirectory: true).standardizedFileURL
}

private func meetlessProviderFolderIsNarrow(_ url: URL, home: URL) -> Bool {
  let candidate = url.resolvingSymlinksInPath().standardizedFileURL.path
  let userHome = home.resolvingSymlinksInPath().standardizedFileURL.path
  return candidate != "/" && candidate != userHome && !userHome.hasPrefix(candidate + "/")
}

private func meetlessProviderExecutable(_ url: URL, home: URL?) -> URL? {
  guard let home else { return nil }
  let canonical = url.resolvingSymlinksInPath().standardizedFileURL
  guard meetlessProviderFolderIsNarrow(canonical, home: home),
        FileManager.default.isExecutableFile(atPath: canonical.path) else { return nil }
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: canonical.path, isDirectory: &isDirectory), !isDirectory.boolValue,
        let attributes = try? FileManager.default.attributesOfItem(atPath: canonical.path),
        let type = attributes[.type] as? FileAttributeType, type == .typeRegular else { return nil }
  return canonical
}

private struct MeetlessProviderExecutableIdentity: Codable, Equatable {
  let path: String
  let device: UInt64
  let inode: UInt64
  let byteLength: UInt64
  let modifiedNanoseconds: Int64
}

private struct MeetlessProviderExecutableBookmark: Codable {
  let bookmark: Data
  let identity: MeetlessProviderExecutableIdentity
}

private func meetlessProviderExecutableIdentity(_ url: URL) -> MeetlessProviderExecutableIdentity? {
  var information = stat()
  guard lstat(url.path, &information) == 0,
        (information.st_mode & S_IFMT) == S_IFREG else { return nil }
  return MeetlessProviderExecutableIdentity(
    path: url.standardizedFileURL.path,
    device: UInt64(information.st_dev),
    inode: UInt64(information.st_ino),
    byteLength: UInt64(information.st_size),
    modifiedNanoseconds: Int64(information.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(information.st_mtimespec.tv_nsec)
  )
}

final class MeetlessProviderFolderPanelDelegate: NSObject, NSOpenSavePanelDelegate {
  private let expected: URL
  private let realHome: URL?
  init(expected: URL, realHome: URL? = meetlessRealUserHome()) { self.expected = expected; self.realHome = realHome }
  func panel(_ sender: Any, validate url: URL) throws {
    guard let realHome, meetlessProviderFolderIsNarrow(url, home: realHome),
          meetlessProviderFolderIsNarrow(expected, home: realHome),
          url.standardizedFileURL.path == expected.standardizedFileURL.path,
          url.resolvingSymlinksInPath().path == expected.resolvingSymlinksInPath().path else {
      throw NSError(domain: "MeetlessProviderAccess", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Choose the existing Codex folder shown by Meetless."])
    }
  }
}

final class MeetlessProviderExecutablePanelDelegate: NSObject, NSOpenSavePanelDelegate {
  private let realHome: URL?
  init(realHome: URL? = meetlessRealUserHome()) { self.realHome = realHome }
  func panel(_ sender: Any, validate url: URL) throws {
    guard meetlessProviderExecutable(url, home: realHome) != nil else {
      throw NSError(domain: "MeetlessProviderAccess", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Choose an existing executable Codex program."])
    }
  }
}

/// Retains only scoped URLs/bookmarks. Provider credentials never cross this boundary.
final class MeetlessProviderFolderAccess: MeetlessProviderAccess {
  struct FileAccess {
    var choose: (URL) -> URL?
    var bookmark: (URL) throws -> Data
    var resolve: (Data) throws -> (URL, Bool)
    var start: (URL) -> Bool
    var stop: (URL) -> Void
    var chooseExecutable: (URL?) -> URL? = { _ in nil }
    static let system = FileAccess(
      choose: { expected in
        let action = { () -> URL? in
          let panel = NSOpenPanel()
          panel.title = "Allow Meetless to use your Codex settings"
          panel.message = "Choose your existing Codex folder to reuse its settings and sign-in."
          panel.prompt = "Allow access"
          panel.canChooseFiles = false
          panel.canChooseDirectories = true
          panel.allowsMultipleSelection = false
          panel.canCreateDirectories = false
          panel.showsHiddenFiles = true
          panel.directoryURL = expected
          let delegate = MeetlessProviderFolderPanelDelegate(expected: expected)
          panel.delegate = delegate
          return withExtendedLifetime(delegate) { panel.runModal() == .OK ? panel.url : nil }
        }
        return Thread.isMainThread ? action() : DispatchQueue.main.sync(execute: action)
      },
      bookmark: { try $0.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil) },
      resolve: { data in
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
        return (url, stale)
      },
      start: { $0.startAccessingSecurityScopedResource() },
      stop: { $0.stopAccessingSecurityScopedResource() },
      chooseExecutable: { current in
        let action = { () -> URL? in
          let panel = NSOpenPanel()
          panel.title = "Choose your Codex program"
          panel.message = "Choose the existing Codex executable to use for Ask."
          panel.prompt = "Choose Codex"
          panel.canChooseFiles = true
          panel.canChooseDirectories = false
          panel.allowsMultipleSelection = false
          panel.canCreateDirectories = false
          panel.showsHiddenFiles = true
          if let current {
            panel.directoryURL = current.deletingLastPathComponent()
          }
          let delegate = MeetlessProviderExecutablePanelDelegate()
          panel.delegate = delegate
          return withExtendedLifetime(delegate) { panel.runModal() == .OK ? panel.url : nil }
        }
        return Thread.isMainThread ? action() : DispatchQueue.main.sync(execute: action)
      }
    )
  }

  private let lock = NSRecursiveLock()
  private let expected: URL?
  private let bookmarkFile: URL
  private let executableBookmarkFile: URL
  private let access: FileAccess
  private var restored: URL?
  private var restoredExecutable: URL?
  private var restoredExecutableIdentity: MeetlessProviderExecutableIdentity?
  private var pendingRestart = false
  private var choosing = false
  private var closed = false
  private let realHome: URL?

  init(runtimeRoot: String, realHome: URL? = meetlessRealUserHome(), environment: [String: String] = ProcessInfo.processInfo.environment, access: FileAccess = .system) {
    bookmarkFile = URL(fileURLWithPath: runtimeRoot).appendingPathComponent("provider-access-bookmarks.json")
    executableBookmarkFile = URL(fileURLWithPath: runtimeRoot).appendingPathComponent("provider-executable-bookmarks.json")
    self.access = access
    self.realHome = realHome?.standardizedFileURL
    if let home = realHome {
      let override = environment["CODEX_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
      let candidate = override.flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0, isDirectory: true) : nil }
        ?? (override == nil || override == "" ? home.appendingPathComponent(".codex", isDirectory: true) : nil)
      let normalized = candidate?.standardizedFileURL
      // Never turn a provider override into permission for an entire home or filesystem.
      expected = normalized.flatMap { meetlessProviderFolderIsNarrow($0, home: home) ? $0 : nil }
    } else { expected = nil }
  }

  func restoreBeforeRuntime() {
    lock.lock(); defer { lock.unlock() }
    if restored == nil, let expected,
       let bookmark = loadBookmark(from: bookmarkFile) {
      var started: URL?
      do {
        let (url, stale) = try access.resolve(bookmark)
        if sameFolder(url, expected), access.start(url) {
          started = url
          if isDirectory(url) {
            if stale { try persistFolder(try access.bookmark(url)) }
            restored = url
            pendingRestart = false
          } else {
            access.stop(url)
          }
        }
      } catch {
        if let started { access.stop(started) }
      }
    }
    if restored != nil, restoredExecutable == nil, let bookmark = loadExecutableBookmark(from: executableBookmarkFile) {
      var started: URL?
      do {
        let (url, stale) = try access.resolve(bookmark.bookmark)
        guard let executable = meetlessProviderExecutable(url, home: realHome),
              let identity = meetlessProviderExecutableIdentity(executable),
              identity == bookmark.identity, access.start(executable) else { return }
        started = executable
        if stale || executable.path != url.standardizedFileURL.path {
          try persistExecutable(try access.bookmark(executable), identity: identity)
        }
        restoredExecutable = executable
        restoredExecutableIdentity = identity
      } catch {
        if let started { access.stop(started) }
      }
    }
  }

  func close() {
    lock.lock(); defer { lock.unlock() }
    closed = true
    if let restored { access.stop(restored) }
    if let restoredExecutable { access.stop(restoredExecutable) }
    restored = nil
    restoredExecutable = nil
    restoredExecutableIdentity = nil
  }

  func providerEnvironment() -> [String: [String: String]] {
    lock.lock(); defer { lock.unlock() }
    refreshAccess()
    guard let restored else { return [:] }
    var environment = ["CODEX_HOME": restored.path]
    if let restoredExecutable { environment["CODEX_EXECUTABLE"] = restoredExecutable.path }
    return ["codex": environment]
  }

  func status() -> MeetlessProviderAccessResult {
    lock.lock(); defer { lock.unlock() }
    refreshAccess()
    return result("status")
  }

  func request(provider: String, authorized: () -> Bool = { true }) -> MeetlessProviderAccessResult {
    lock.lock()
    refreshAccess()
    guard !closed, !choosing, provider == "codex", let expected, authorized() else {
      let response = result("failed"); lock.unlock(); return response
    }
    let choosingExecutable = restored != nil
    choosing = true
    lock.unlock()
    // Never hold the manager lock across AppKit's main-thread modal loop.
    let selected = choosingExecutable ? access.chooseExecutable(restoredExecutable) : access.choose(expected)
    lock.lock(); defer { choosing = false; lock.unlock() }
    guard !closed, authorized() else { return result("failed") }
    guard let selected else { return result("cancelled") }
    if choosingExecutable {
      guard let executable = meetlessProviderExecutable(selected, home: realHome) else { return result("invalid_selection") }
      let started = access.start(executable)
      defer { if started { access.stop(executable) } }
      guard started else { return result("failed") }
      do {
        let bookmark = try access.bookmark(executable)
        guard !closed, authorized() else { return result("failed") }
        guard let identity = meetlessProviderExecutableIdentity(executable) else { return result("failed") }
        try persistExecutable(bookmark, identity: identity)
        pendingRestart = true
        return result("granted")
      } catch { return result("failed") }
    }
    guard sameFolder(selected, expected), isDirectory(selected) else { return result("invalid_selection") }
    let started = access.start(selected)
    defer { if started { access.stop(selected) } }
    guard started else { return result("failed") }
    do {
      let bookmark = try access.bookmark(selected)
      guard !closed, authorized() else { return result("failed") }
      try persistFolder(bookmark)
      pendingRestart = true
      return result("granted")
    } catch { return result("failed") }
  }

  private func refreshAccess() {
    if let restored, (!isDirectory(restored) || !FileManager.default.isReadableFile(atPath: restored.path)) {
      access.stop(restored)
      self.restored = nil
      if let restoredExecutable { access.stop(restoredExecutable) }
      self.restoredExecutable = nil
      restoredExecutableIdentity = nil
      pendingRestart = false
    }
    if let restoredExecutable {
      let currentExecutable = meetlessProviderExecutable(restoredExecutable, home: realHome)
      let currentIdentity = currentExecutable.flatMap(meetlessProviderExecutableIdentity)
      if currentExecutable == nil || restoredExecutableIdentity == nil || currentIdentity != restoredExecutableIdentity {
        access.stop(restoredExecutable)
        self.restoredExecutable = nil
        restoredExecutableIdentity = nil
        pendingRestart = false
      }
    }
  }


  private func result(_ outcome: String) -> MeetlessProviderAccessResult {
    let codex: String
    if expected == nil {
      codex = "unavailable"
    } else if restored == nil {
      codex = pendingRestart ? "restart_required" : "needs_access"
    } else if restoredExecutable == nil {
      codex = pendingRestart ? "restart_required" : "needs_executable"
    } else {
      codex = pendingRestart ? "restart_required" : "ready"
    }
    var codexProvider = ["id": "codex", "status": codex]
    if expected != nil { codexProvider["executableSelection"] = "available" }
    return MeetlessProviderAccessResult(outcome: outcome, providers: [
      codexProvider, ["id": "claude", "status": "unavailable"], ["id": "opencode", "status": "unavailable"]
    ])
  }

  private func sameFolder(_ selected: URL, _ expected: URL) -> Bool {
    guard let realHome, meetlessProviderFolderIsNarrow(selected, home: realHome), meetlessProviderFolderIsNarrow(expected, home: realHome) else { return false }
    return selected.standardizedFileURL.path == expected.standardizedFileURL.path
      && selected.resolvingSymlinksInPath().path == expected.resolvingSymlinksInPath().path
  }

  private func isDirectory(_ url: URL) -> Bool {
    var directory: ObjCBool = false
    return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
  }

  private func loadBookmark(from file: URL) -> Data? {
    guard let data = try? Data(contentsOf: file),
          let stored = try? JSONDecoder().decode([String: Data].self, from: data) else { return nil }
    return stored["codex"]
  }

  private func loadExecutableBookmark(from file: URL) -> MeetlessProviderExecutableBookmark? {
    guard let data = try? Data(contentsOf: file),
          let stored = try? JSONDecoder().decode([String: MeetlessProviderExecutableBookmark].self, from: data) else { return nil }
    return stored["codex"]
  }

  private func persistFolder(_ bookmark: Data) throws {
    try persist(bookmark, to: bookmarkFile)
  }

  private func persistExecutable(_ bookmark: Data, identity: MeetlessProviderExecutableIdentity) throws {
    let record = MeetlessProviderExecutableBookmark(bookmark: bookmark, identity: identity)
    let data = try JSONEncoder().encode(["codex": record])
    try data.write(to: executableBookmarkFile, options: [.atomic, .completeFileProtectionUnlessOpen])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: executableBookmarkFile.path)
  }

  private func persist(_ bookmark: Data, to file: URL) throws {
    let data = try JSONEncoder().encode(["codex": bookmark])
    try data.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
  }
}
