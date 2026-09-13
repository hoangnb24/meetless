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
