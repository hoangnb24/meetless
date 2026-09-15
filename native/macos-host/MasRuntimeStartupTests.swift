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
  defer { try? FileManager.default.removeItem(at: root) }
  func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw NSError(domain: "ProviderFolderTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
  }
  let ambient = ["HOME": home.path, "PASEO_HOME": "isolated-paseo", "CODEX_HOME": "existing-override", "MEETLESS_PROVIDER_ENV": "untrusted"]
  let direct = try meetlessProjectProviderEnvironment(ambient, runtimeRoot: root.appendingPathComponent("development").path, grants: [:])
  try require(direct["CODEX_HOME"] == "existing-override" && direct["HOME"] == home.path, "direct/development lookup must remain unchanged")
  try require(direct["MEETLESS_PROVIDER_ENV"] == nil, "ambient grant projection must not survive")
  let directWithGrant = try meetlessProjectProviderEnvironment(
    ambient,
    runtimeRoot: root.appendingPathComponent("development").path,
    grants: ["codex": ["CODEX_HOME": codex.path]]
  )
  try require(directWithGrant["CODEX_HOME"] == "existing-override" && directWithGrant["MEETLESS_PROVIDER_ENV"] == nil, "direct installations must not project a sandbox grant")
  let directPackaged = try meetlessProjectProviderEnvironment(ambient, runtimeRoot: home.appendingPathComponent("Library/Application Support/Meetless").path, grants: [:])
  try require(directPackaged["CODEX_HOME"] == "existing-override", "direct packaged override must remain unchanged")
  let masRoot = home.appendingPathComponent("Library/Containers/com.meetless.app/Data/Library/Application Support/Meetless").path
  let mas = try meetlessProjectProviderEnvironment(ambient, runtimeRoot: masRoot, grants: ["codex": ["CODEX_HOME": codex.path]])
  try require(mas["CODEX_HOME"] == nil && mas["MEETLESS_PROVIDER_ENV"] != nil, "MAS must project only the restored scoped override")
  try require(mas["HOME"] == home.path && mas["PASEO_HOME"] == "isolated-paseo", "provider grant must preserve application state roots")
  let distribution = try meetlessProjectProviderEnvironment(
    ambient,
    runtimeRoot: masRoot,
    grants: ["codex": ["CODEX_HOME": codex.path]],
    bundleInfo: ["MeetlessStoreBackendRouting": true]
  )
  try require(distribution["CODEX_HOME"] == nil && distribution["MEETLESS_PROVIDER_ENV"] == mas["MEETLESS_PROVIDER_ENV"], "TestFlight distribution must project the same restored scoped provider grant")
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
  try require(MeetlessUnrestrictedProviderAccess().status().providers.allSatisfy { $0["status"] == "ready" }, "direct host requires no sandbox folder prompt")
  let panelDelegate = MeetlessProviderFolderPanelDelegate(expected: codex, realHome: home)
  try panelDelegate.panel(NSObject(), validate: codex)
  do {
    try panelDelegate.panel(NSObject(), validate: home)
    throw NSError(domain: "ProviderFolderTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "panel must reject home before accepting selection"])
  } catch {
    try require((error as NSError).domain == "MeetlessProviderAccess", "panel must reject ancestor before acceptance")
  }
  var chosen: URL? = home
  var started = 0
  var stopped = 0
  let access = MeetlessProviderFolderAccess.FileAccess(
    choose: { _ in chosen }, bookmark: { Data($0.path.utf8) },
    resolve: { (URL(fileURLWithPath: String(decoding: $0, as: UTF8.self)), false) },
    start: { _ in started += 1; return true }, stop: { _ in stopped += 1 }
  )
  let first = MeetlessProviderFolderAccess(runtimeRoot: runtime.path, realHome: home, environment: [:], access: access)
  first.restoreBeforeRuntime()
  try require(first.status().providers[0]["status"] == "needs_access", "new install must require access")
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
  try require(second.status().providers[0]["status"] == "ready", "saved grant must restore before runtime")
  try require(second.providerEnvironment() == ["codex": ["CODEX_HOME": codex.path]], "only restored provider path must be projected")
  try require(second.status().providers.dropFirst().allSatisfy { $0["status"] == "unavailable" }, "unimplemented providers must stay unavailable")
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
