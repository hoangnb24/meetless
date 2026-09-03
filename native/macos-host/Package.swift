// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "MeetlessHost",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "MeetlessHost", targets: ["MeetlessHost"]),
    .executable(name: "MeetlessHostTests", targets: ["MeetlessHostTests"]),
    .executable(name: "MeetlessMasGateMutation", targets: ["MeetlessMasGateMutation"]),
  ],
  dependencies: [
    .package(url: "https://github.com/RevenueCat/purchases-ios-spm.git", exact: "5.87.1"),
  ],
  targets: [
    .target(
      name: "MeetlessHostCore",
      dependencies: [.product(name: "RevenueCat", package: "purchases-ios-spm")],
      path: ".",
      exclude: [
        "Info.plist",
        "MeetlessAppStore.entitlements.plist",
        "MeetlessAppStoreChild.entitlements.plist",
        "host-entry",
        "mas-gate-mutation",
        "TranscriptionCapabilityTests.swift",
      ],
      sources: ["MeetlessHost.swift", "RevenueCatCapability.swift", "TranscriptionCapability.swift", "ManagedAuthCapability.swift"],
      swiftSettings: [.unsafeFlags(["-enable-testing"])]
    ),
    .executableTarget(
      name: "MeetlessHost",
      dependencies: ["MeetlessHostCore"],
      path: "host-entry",
      sources: ["main.swift"]
    ),
    .executableTarget(
      name: "MeetlessHostTests",
      dependencies: ["MeetlessHostCore"],
      path: ".",
      exclude: [
        "Info.plist",
        "MeetlessAppStore.entitlements.plist",
        "MeetlessAppStoreChild.entitlements.plist",
        "host-entry",
        "mas-gate-mutation",
        "MeetlessHost.swift",
        "RevenueCatCapability.swift",
        "TranscriptionCapability.swift",
        "ManagedAuthCapability.swift",
        "Package.swift",
        "Package.resolved",
      ],
      sources: ["TranscriptionCapabilityTests.swift"]
    ),
    .executableTarget(
      name: "MeetlessMasGateMutation",
      path: "mas-gate-mutation",
      sources: ["main.swift"]
    ),
  ],
  swiftLanguageModes: [.v5]
)
