import Foundation
@testable import MeetlessHostCore

func testMasRuntimeStartupLocatorBoundary() throws {
  guard try meetlessMasGateLocatorDisposition(
    indexPresent: false,
    indexIntentPresent: false,
    activePresent: false
  ) == .clean else {
    throw NSError(
      domain: "MeetlessHostTests",
      code: 81,
      userInfo: [NSLocalizedDescriptionKey: "a clean MAS runtime parent did not permit ordinary startup"]
    )
  }

  guard try meetlessMasGateLocatorDisposition(
    indexPresent: true,
    indexIntentPresent: false,
    activePresent: false
  ) == .indexed else {
    throw NSError(
      domain: "MeetlessHostTests",
      code: 82,
      userInfo: [NSLocalizedDescriptionKey: "an existing MAS session index did not retain indexed validation"]
    )
  }

  for (label, indexIntentPresent, activePresent, expectedDiagnostic) in [
    ("orphaned active transaction", false, true, "fixed active MAS transaction has no session index"),
    ("orphaned index intent", true, false, "fixed MAS session index intent exists without its index"),
  ] {
    do {
      _ = try meetlessMasGateLocatorDisposition(
        indexPresent: false,
        indexIntentPresent: indexIntentPresent,
        activePresent: activePresent
      )
      throw NSError(
        domain: "MeetlessHostTests",
        code: 83,
        userInfo: [NSLocalizedDescriptionKey: "\(label) did not fail closed"]
      )
    } catch {
      guard error.localizedDescription.contains(expectedDiagnostic),
            error.localizedDescription.contains("docs/decisions/0005-mac-app-store-and-revenuecat.md") else {
        throw NSError(
          domain: "MeetlessHostTests",
          code: 84,
          userInfo: [NSLocalizedDescriptionKey: "\(label) emitted the wrong diagnostic: \(error.localizedDescription)"]
        )
      }
    }
  }
}

func testProviderFolderAccessPersistence() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let home = root.appendingPathComponent("home")
  let codex = home.appendingPathComponent(".codex")
  let runtime = root.appendingPathComponent("runtime")
  try FileManager.default.createDirectory(at: codex, withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
  let executableTarget = codex.appendingPathComponent("bin/codex")
  try FileManager.default.createDirectory(at: executableTarget.deletingLastPathComponent(), withIntermediateDirectories: true)
  guard FileManager.default.createFile(atPath: executableTarget.path, contents: Data("#!/bin/sh\n".utf8)) else {
    throw NSError(domain: "ProviderFolderTests", code: 3, userInfo: [NSLocalizedDescriptionKey: "could not create executable fixture"])
  }
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executableTarget.path)
  let executableLink = root.appendingPathComponent("codex-link")
  try FileManager.default.createSymbolicLink(at: executableLink, withDestinationURL: executableTarget)
  let executableDirectory = codex.appendingPathComponent("bin")
  defer { try? FileManager.default.removeItem(at: root) }
  func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw NSError(domain: "ProviderFolderTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
  }
  let ambient = ["HOME": home.path, "PASEO_HOME": "isolated-paseo", "CODEX_HOME": "existing-override", "CODEX_EXECUTABLE": "ambient-override", "MEETLESS_PROVIDER_ENV": "untrusted"]
  let direct = try meetlessProjectProviderEnvironment(ambient, runtimeRoot: root.appendingPathComponent("development").path, grants: [:])
  try require(direct["CODEX_HOME"] == "existing-override" && direct["HOME"] == home.path, "direct/development lookup must remain unchanged")
  try require(direct["CODEX_EXECUTABLE"] == "ambient-override", "direct/development executable lookup must remain unchanged")
  try require(direct["MEETLESS_PROVIDER_ENV"] == nil, "ambient grant projection must not survive")
  let directWithGrant = try meetlessProjectProviderEnvironment(
    ambient,
    runtimeRoot: root.appendingPathComponent("development").path,
    grants: ["codex": ["CODEX_HOME": codex.path]]
  )
  try require(directWithGrant["CODEX_HOME"] == "existing-override" && directWithGrant["MEETLESS_PROVIDER_ENV"] == nil, "direct installations must not project a sandbox grant")
  try require(directWithGrant["CODEX_EXECUTABLE"] == "ambient-override", "direct installations must retain their executable override")
  let directPackaged = try meetlessProjectProviderEnvironment(ambient, runtimeRoot: home.appendingPathComponent("Library/Application Support/Meetless").path, grants: [:])
  try require(directPackaged["CODEX_HOME"] == "existing-override", "direct packaged override must remain unchanged")
  let masRoot = home.appendingPathComponent("Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless").path
  let mas = try meetlessProjectProviderEnvironment(ambient, runtimeRoot: masRoot, grants: ["codex": ["CODEX_HOME": codex.path]])
  try require(mas["CODEX_HOME"] == nil && mas["MEETLESS_PROVIDER_ENV"] != nil, "MAS must project only the restored scoped override")
  try require(mas["HOME"] == home.path && mas["PASEO_HOME"] == "isolated-paseo" && mas["CODEX_EXECUTABLE"] == nil, "provider grant must preserve application state roots and scrub ambient executable overrides")
  let distribution = try meetlessProjectProviderEnvironment(
    ambient,
    runtimeRoot: masRoot,
    grants: ["codex": ["CODEX_HOME": codex.path]],
    bundleInfo: ["MeetlessStoreBackendRouting": true]
  )
  try require(distribution["CODEX_HOME"] == nil && distribution["MEETLESS_PROVIDER_ENV"] == mas["MEETLESS_PROVIDER_ENV"], "TestFlight distribution must project the same restored scoped provider grant")
  let distributionWithExecutable = try meetlessProjectProviderEnvironment(
    ambient,
    runtimeRoot: masRoot,
    grants: ["codex": ["CODEX_HOME": codex.path, "CODEX_EXECUTABLE": executableTarget.path]],
    bundleInfo: ["MeetlessStoreBackendRouting": true]
  )
  let projected = try JSONSerialization.jsonObject(with: Data((distributionWithExecutable["MEETLESS_PROVIDER_ENV"] ?? "").utf8)) as? [String: [String: String]]
  try require(projected == ["codex": ["CODEX_HOME": codex.path, "CODEX_EXECUTABLE": executableTarget.path]], "TestFlight must serialize only the approved folder and executable grant")
  let distributionWithoutGrant = try meetlessProjectProviderEnvironment(
    ambient,
    runtimeRoot: masRoot,
    grants: [:],
    bundleInfo: ["MeetlessStoreBackendRouting": true]
  )
  try require(distributionWithoutGrant["CODEX_HOME"] == nil && distributionWithoutGrant["MEETLESS_PROVIDER_ENV"] == nil, "TestFlight distribution must not retain an ambient Codex override without a restored grant")
  let unknownRoot = try meetlessProjectProviderEnvironment(
    ambient,
    runtimeRoot: root.appendingPathComponent("unknown").path,
    grants: ["codex": ["CODEX_HOME": codex.path]],
    bundleInfo: ["MeetlessStoreBackendRouting": true]
  )
  try require(unknownRoot["CODEX_HOME"] == "existing-override" && unknownRoot["MEETLESS_PROVIDER_ENV"] == nil, "unknown runtime roots must not project provider grants")
  let unrestricted = MeetlessUnrestrictedProviderAccess().status()
  try require(unrestricted.providers.allSatisfy { $0["status"] == "ready" }, "direct host requires no sandbox folder prompt")
  try require(unrestricted.providers.allSatisfy { $0["executableSelection"] == nil }, "direct host must not advertise the scoped executable chooser")
  let panelDelegate = MeetlessProviderFolderPanelDelegate(expected: codex, realHome: home)
  try panelDelegate.panel(NSObject(), validate: codex)
  do {
    try panelDelegate.panel(NSObject(), validate: home)
    throw NSError(domain: "ProviderFolderTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "panel must reject home before accepting selection"])
  } catch {
    try require((error as NSError).domain == "MeetlessProviderAccess", "panel must reject ancestor before acceptance")
  }
  var chosen: URL? = home
  var chosenExecutable: URL? = executableTarget
  var started = 0
  var stopped = 0
  let access = MeetlessProviderFolderAccess.FileAccess(
    choose: { _ in chosen }, bookmark: { Data($0.path.utf8) },
    resolve: { (URL(fileURLWithPath: String(decoding: $0, as: UTF8.self)), false) },
    start: { _ in started += 1; return true }, stop: { _ in stopped += 1 },
    chooseExecutable: { _ in chosenExecutable }
  )
  let first = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: access)
  first.restoreBeforeRuntime()
  try require(first.status().providers[0]["status"] == "needs_access", "new install must require access")
  try require(first.status().providers[0]["executableSelection"] == "available", "scoped Codex access must advertise its executable chooser")
  try require(first.request(provider: "codex").outcome == "invalid_selection", "home ancestor selection must fail")
  try require(first.providerEnvironment().isEmpty, "invalid selection must not project paths")
  chosen = nil
  try require(first.request(provider: "codex").outcome == "cancelled", "cancel must remain non-granted")
  chosen = codex
  try require(first.request(provider: "codex").outcome == "granted", "exact provider folder must grant")
  try require(first.status().providers[0]["status"] == "restart_required", "new grant must require runtime restart")
  try require(first.providerEnvironment().isEmpty, "live grant must not change running provider environment")
  let bookmark = runtime.appendingPathComponent("provider-access-bookmarks.json")
  let mode = try FileManager.default.attributesOfItem(atPath: bookmark.path)[.posixPermissions] as? NSNumber
  try require(mode?.intValue == 0o600, "persisted bookmark must be owner-only")
  let second = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: access)
  second.restoreBeforeRuntime()
  try require(second.status().providers[0]["status"] == "needs_executable", "saved folder grant must request the executable separately")
  try require(second.providerEnvironment() == ["codex": ["CODEX_HOME": codex.path]], "saved folder grant must remain available before executable selection")
  try require(second.request(provider: "codex").outcome == "granted", "existing folder grant must allow executable selection")
  try require(second.status().providers[0]["status"] == "restart_required", "new executable grant must require runtime restart")
  try require(second.providerEnvironment() == ["codex": ["CODEX_HOME": codex.path]], "new executable grant must not alter the running provider environment")
  let executableBookmark = runtime.appendingPathComponent("provider-executable-bookmarks.json")
  let executableMode = try FileManager.default.attributesOfItem(atPath: executableBookmark.path)[.posixPermissions] as? NSNumber
  try require(executableMode?.intValue == 0o600, "executable bookmark must be owner-only")
  try require(FileManager.default.fileExists(atPath: bookmark.path), "executable grant must preserve the existing folder bookmark")
  try require(second.status().providers.dropFirst().allSatisfy { $0["status"] == "unavailable" }, "unimplemented providers must stay unavailable")
  second.close()
  let third = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: access)
  third.restoreBeforeRuntime()
  try require(third.status().providers[0]["status"] == "ready", "folder and executable grants must restore before runtime")
  try require(third.providerEnvironment() == ["codex": ["CODEX_HOME": codex.path, "CODEX_EXECUTABLE": executableTarget.path]], "restored provider environment must include the canonical executable")
  chosenExecutable = executableLink
  try require(third.request(provider: "codex").outcome == "granted", "ready provider must allow replacing the executable")
  try require(third.status().providers[0]["status"] == "restart_required", "replacement executable must require runtime restart")
  try require(third.providerEnvironment() == ["codex": ["CODEX_HOME": codex.path, "CODEX_EXECUTABLE": executableTarget.path]], "replacement must keep the active executable scope until restart")
  third.close()
  let fourth = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: access)
  fourth.restoreBeforeRuntime()
  try require(fourth.status().providers[0]["status"] == "ready", "replacement executable grant must restore before runtime")
  try require(fourth.providerEnvironment() == ["codex": ["CODEX_HOME": codex.path, "CODEX_EXECUTABLE": executableTarget.path]], "symlink selection must persist its canonical target")
  let savedFolderBookmark = try Data(contentsOf: bookmark)
  try FileManager.default.removeItem(at: bookmark)
  let startsBeforeMissingFolder = started
  let executableWithoutFolder = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: access)
  executableWithoutFolder.restoreBeforeRuntime()
  try require(executableWithoutFolder.status().providers[0]["status"] == "needs_access", "an executable grant without its configuration folder must retain needs_access priority")
  try require(executableWithoutFolder.providerEnvironment().isEmpty, "an executable grant without its configuration folder must not be projected")
  try require(started == startsBeforeMissingFolder, "an executable grant without its configuration folder must not start a security scope")
  executableWithoutFolder.close()
  try savedFolderBookmark.write(to: bookmark, options: [.atomic, .completeFileProtectionUnlessOpen])
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: bookmark.path)
  try MeetlessProviderExecutablePanelDelegate(realHome: home).panel(NSObject(), validate: executableLink)
  do {
    try MeetlessProviderExecutablePanelDelegate(realHome: home).panel(NSObject(), validate: executableDirectory)
    throw NSError(domain: "ProviderFolderTests", code: 4, userInfo: [NSLocalizedDescriptionKey: "executable chooser must reject directories"])
  } catch {
    try require((error as NSError).domain == "MeetlessProviderAccess", "executable chooser must reject directories with its boundary error")
  }
  let invalidFile = codex.appendingPathComponent("not-executable")
  guard FileManager.default.createFile(atPath: invalidFile.path, contents: Data("data".utf8)) else {
    throw NSError(domain: "ProviderFolderTests", code: 5, userInfo: [NSLocalizedDescriptionKey: "could not create non-executable fixture"])
  }
  do {
    try MeetlessProviderExecutablePanelDelegate(realHome: home).panel(NSObject(), validate: invalidFile)
    throw NSError(domain: "ProviderFolderTests", code: 6, userInfo: [NSLocalizedDescriptionKey: "executable chooser must reject non-executable files"])
  } catch {
    try require((error as NSError).domain == "MeetlessProviderAccess", "executable chooser must reject non-executable files with its boundary error")
  }
  var authorizedAfterExecutableChooser = true
  var authorizationAccess = access
  authorizationAccess.chooseExecutable = { _ in
    authorizedAfterExecutableChooser = false
    return executableLink
  }
  let unauthorizedAfterChooser = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: authorizationAccess)
  unauthorizedAfterChooser.restoreBeforeRuntime()
  try require(unauthorizedAfterChooser.request(provider: "codex", authorized: { authorizedAfterExecutableChooser }).outcome == "failed", "lease revoked after executable chooser must not persist a replacement")
  try require(unauthorizedAfterChooser.providerEnvironment() == ["codex": ["CODEX_HOME": codex.path, "CODEX_EXECUTABLE": executableTarget.path]], "lease revocation after executable chooser must retain the active executable scope")
  unauthorizedAfterChooser.close()
  let authorizedBeforeChooser = false
  let unauthorizedBeforeChooser = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: access)
  unauthorizedBeforeChooser.restoreBeforeRuntime()
  try require(unauthorizedBeforeChooser.request(provider: "codex", authorized: { authorizedBeforeChooser }).outcome == "failed", "revoked lease before executable chooser must fail closed")
  unauthorizedBeforeChooser.close()
  try FileManager.default.removeItem(at: executableTarget)
  guard FileManager.default.createFile(atPath: executableTarget.path, contents: Data("#!/bin/zsh\n".utf8)) else {
    throw NSError(domain: "ProviderFolderTests", code: 7, userInfo: [NSLocalizedDescriptionKey: "could not create replacement executable fixture"])
  }
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executableTarget.path)
  try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 4_000_000_000)], ofItemAtPath: executableTarget.path)
  try require(fourth.status().providers[0]["status"] == "needs_executable", "replaced executable target must recover to needs_executable")
  try require(fourth.providerEnvironment() == ["codex": ["CODEX_HOME": codex.path]], "replaced executable target must not be projected")
  fourth.close()
  let replaced = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: access)
  replaced.restoreBeforeRuntime()
  try require(replaced.status().providers[0]["status"] == "needs_executable", "persisted executable identity must reject a replacement target")
  try FileManager.default.removeItem(at: executableTarget)
  try require(replaced.status().providers[0]["status"] == "needs_executable", "deleted executable target must recover to needs_executable")
  try require(replaced.providerEnvironment() == ["codex": ["CODEX_HOME": codex.path]], "deleted executable target must not be projected")
  replaced.close()
  second.close()
  try require(started == stopped, "all started scopes must be released")
  var deniedAccess = access
  deniedAccess.start = { _ in false }
  let denied = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: deniedAccess)
  denied.restoreBeforeRuntime()
  try require(denied.status().providers[0]["status"] == "needs_access", "revoked bookmark must require access again")
  try require(denied.providerEnvironment().isEmpty, "revoked bookmark must not project provider path")
  let ancestor = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: ["CODEX_HOME": root.path], access: access)
  try require(ancestor.status().providers[0]["status"] == "unavailable", "home ancestor override must fail closed")
  let link = root.appendingPathComponent("provider-link")
  try FileManager.default.createSymbolicLink(at: link, withDestinationURL: home)
  let linked = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: ["CODEX_HOME": link.path], access: access)
  try require(linked.status().providers[0]["status"] == "unavailable", "symlink to home must fail closed")
  let active = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: access)
  active.restoreBeforeRuntime()
  try FileManager.default.removeItem(at: codex)
  try require(active.status().providers[0]["status"] == "needs_access", "deleted grant must recover to needs_access")
  try require(active.providerEnvironment().isEmpty, "deleted grant must not retain environment")
  try FileManager.default.createDirectory(at: codex, withIntermediateDirectories: true)
  try FileManager.default.removeItem(at: bookmark)
  var authorized = true
  var expiredAccess = access
  expiredAccess.choose = { _ in authorized = false; return codex }
  let expired = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: expiredAccess)
  try require(expired.request(provider: "codex", authorized: { authorized }).outcome == "failed", "lease revoked in picker must fail")
  try require(!FileManager.default.fileExists(atPath: bookmark.path), "revoked request must not persist bookmark")
  var closingAccess = access
  var closing: MeetlessProviderFolderAccess?
  closingAccess.choose = { _ in closing?.close(); return codex }
  closing = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: closingAccess)
  try require(closing?.request(provider: "codex").outcome == "failed", "closing while chooser is open must cancel persistence")
  let broad = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: ["CODEX_HOME": home.path], access: access)
  try require(broad.status().providers[0]["status"] == "unavailable", "whole home override must fail closed")
}
