import SwiftUI

@main
struct MeetlessApp: App {
    var body: some Scene {
        WindowGroup {
            MeetlessRootView()
                .frame(minWidth: 960, minHeight: 680)
        }
        .defaultSize(width: 1080, height: 720)
        .windowResizability(.contentMinSize)
    }
}
