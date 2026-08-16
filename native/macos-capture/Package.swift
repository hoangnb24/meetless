// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "MeetlessCapture",
  platforms: [.macOS(.v15)],
  products: [.executable(name: "meetless-capture", targets: ["MeetlessCapture"])],
  targets: [.executableTarget(name: "MeetlessCapture")]
)
