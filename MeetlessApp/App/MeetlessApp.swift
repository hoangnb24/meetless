import Foundation
import SwiftUI

enum PublicLogRedaction {
    static func sessionIdentifier(for directoryURL: URL) -> String {
        let identifier = directoryURL.lastPathComponent
        return identifier.isEmpty ? "unknown-session" : identifier
    }

    static func storageRootLabel(for directoryURL: URL) -> String {
        let productComponent = directoryURL.deletingLastPathComponent().lastPathComponent
        let containerComponent = directoryURL.lastPathComponent

        let productLabel = productComponent.isEmpty ? "ApplicationSupport" : productComponent
        let containerLabel = containerComponent.isEmpty ? "storage" : containerComponent
        return "\(productLabel).\(containerLabel)"
    }
}

private enum RuntimeStorageProbe {
    private static let environmentKey = "MEETLESS_PRINT_STORAGE_ROOT"

    static func logIfRequested(fileManager: FileManager = .default) {
        let value = ProcessInfo.processInfo.environment[environmentKey]?.lowercased()
        guard value == "1" || value == "true" else {
            return
        }

        guard let applicationSupportURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            print("MEETLESS_RUNTIME_STORAGE_ROOT=unavailable")
            return
        }

        let storageRoot = applicationSupportURL
            .appendingPathComponent("Meetless", isDirectory: true)
            .appendingPathComponent("Sessions", isDirectory: true)

        print("MEETLESS_RUNTIME_STORAGE_ROOT=redacted; container=\(PublicLogRedaction.storageRootLabel(for: storageRoot))")
    }
}

@main
struct MeetlessApp: App {
    init() {
        RuntimeStorageProbe.logIfRequested()
    }

    var body: some Scene {
        WindowGroup {
            MeetlessRootView()
                .frame(minWidth: 960, minHeight: 680)
        }
        .defaultSize(width: 1080, height: 720)
        .windowResizability(.contentMinSize)
    }
}
