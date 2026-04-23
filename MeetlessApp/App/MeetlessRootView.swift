import SwiftUI

struct MeetlessRootView: View {
    @StateObject private var appModel = AppModel()

    var body: some View {
        NavigationStack {
            currentScreen
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(
                    LinearGradient(
                        colors: [
                            Color(nsColor: .windowBackgroundColor),
                            Color.accentColor.opacity(0.08)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Screen", selection: $appModel.selectedScreen) {
                    ForEach(AppScreen.allCases) { screen in
                        Label(screen.title, systemImage: screen.systemImage)
                            .tag(screen)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 360)
            }
        }
    }

    @ViewBuilder
    private var currentScreen: some View {
        switch appModel.selectedScreen {
        case .home:
            HomeView(
                viewModel: appModel.homeViewModel,
                recordingViewModel: appModel.recordingViewModel,
                onOpenHistory: { appModel.show(.history) },
                onOpenSessionDetail: { appModel.show(.sessionDetail) }
            )
        case .history:
            HistoryView(
                viewModel: appModel.historyViewModel,
                onBackHome: { appModel.show(.home) },
                onReload: { Task { await appModel.refreshSavedSessions() } },
                onOpenSessionDetail: { row in appModel.openSessionDetail(for: row) },
                onDeleteSession: { row in appModel.deleteSession(row) }
            )
        case .sessionDetail:
            SessionDetailView(
                viewModel: appModel.sessionDetailViewModel,
                onBackToHistory: { appModel.show(.history) },
                onDeleteSession: { appModel.deleteSelectedSession() }
            )
        }
    }
}

#Preview {
    MeetlessRootView()
        .frame(width: 1080, height: 720)
}
