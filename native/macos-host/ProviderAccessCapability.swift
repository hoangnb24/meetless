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

func meetlessProjectProviderEnvironment(_ source: [String: String], runtimeRoot: String, grants: [String: [String: String]]) throws -> [String: String] {
  var environment = source
  environment.removeValue(forKey: "MEETLESS_PROVIDER_ENV")
  guard meetlessSignaturePolicy(forRuntimeRoot: runtimeRoot) == .appStoreDevelopment else { return environment }
  // Capture the original override in the manager, then forward it only via a restored grant.
  environment.removeValue(forKey: "CODEX_HOME")
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

/// Retains only scoped URLs/bookmarks. Provider credentials never cross this boundary.
final class MeetlessProviderFolderAccess: MeetlessProviderAccess {
  struct FileAccess {
    var choose: (URL) -> URL?
    var bookmark: (URL) throws -> Data
    var resolve: (Data) throws -> (URL, Bool)
    var start: (URL) -> Bool
    var stop: (URL) -> Void
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
      stop: { $0.stopAccessingSecurityScopedResource() }
    )
  }

  private let lock = NSRecursiveLock()
  private let expected: URL?
  private let bookmarkFile: URL
  private let access: FileAccess
  private var restored: URL?
  private var pendingRestart = false
  private var choosing = false
  private var closed = false
  private let realHome: URL?

  init(runtimeRoot: String, realHome: URL? = meetlessRealUserHome(), environment: [String: String] = ProcessInfo.processInfo.environment, access: FileAccess = .system) {
    bookmarkFile = URL(fileURLWithPath: runtimeRoot).appendingPathComponent("provider-access-bookmarks.json")
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
    guard restored == nil, let expected,
          let data = try? Data(contentsOf: bookmarkFile),
          let stored = try? JSONDecoder().decode([String: Data].self, from: data),
          let bookmark = stored["codex"] else { return }
    var started: URL?
    do {
      let (url, stale) = try access.resolve(bookmark)
      guard sameFolder(url, expected), access.start(url) else { return }
      started = url
      guard isDirectory(url) else { access.stop(url); return }
      if stale { try persist(try access.bookmark(url)) }
      restored = url
      pendingRestart = false
    } catch {
      if let started { access.stop(started) }
    }
  }

  func close() {
    lock.lock(); defer { lock.unlock() }
    closed = true
    if let restored { access.stop(restored) }
    restored = nil
  }

  func providerEnvironment() -> [String: [String: String]] {
    lock.lock(); defer { lock.unlock() }
    refreshAccess()
    guard let restored else { return [:] }
    return ["codex": ["CODEX_HOME": restored.path]]
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
    if restored != nil { let response = result("status"); lock.unlock(); return response }
    choosing = true
    lock.unlock()
    // Never hold the manager lock across AppKit's main-thread modal loop.
    let selected = access.choose(expected)
    lock.lock(); defer { choosing = false; lock.unlock() }
    guard !closed, authorized() else { return result("failed") }
    guard let selected else { return result("cancelled") }
    guard sameFolder(selected, expected), isDirectory(selected) else { return result("invalid_selection") }
    let started = access.start(selected)
    defer { if started { access.stop(selected) } }
    do {
      let bookmark = try access.bookmark(selected)
      guard !closed, authorized() else { return result("failed") }
      try persist(bookmark)
      pendingRestart = true
      return result("granted")
    } catch { return result("failed") }
  }

  private func refreshAccess() {
    guard let restored else { return }
    if !isDirectory(restored) || !FileManager.default.isReadableFile(atPath: restored.path) {
      access.stop(restored)
      self.restored = nil
      pendingRestart = false
    }
  }


  private func result(_ outcome: String) -> MeetlessProviderAccessResult {
    let codex = expected == nil ? "unavailable" : restored != nil ? "ready" : pendingRestart ? "restart_required" : "needs_access"
    return MeetlessProviderAccessResult(outcome: outcome, providers: [
      ["id": "codex", "status": codex], ["id": "claude", "status": "unavailable"], ["id": "opencode", "status": "unavailable"]
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

  private func persist(_ bookmark: Data) throws {
    let data = try JSONEncoder().encode(["codex": bookmark])
    try data.write(to: bookmarkFile, options: [.atomic, .completeFileProtectionUnlessOpen])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: bookmarkFile.path)
  }
}
