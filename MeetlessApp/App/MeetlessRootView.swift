import SwiftUI

struct MeetlessRootView: View {
    @StateObject private var appModel = AppModel()

    var body: some View {
        NavigationStack {
            MeetlessShellView(
                selectedScreen: appModel.selectedScreen,
                onSelectScreen: { screen in appModel.show(screen) }
            ) {
                currentScreen
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

private struct MeetlessShellView<Content: View>: View {
    let selectedScreen: AppScreen
    let onSelectScreen: (AppScreen) -> Void
    let content: Content

    init(
        selectedScreen: AppScreen,
        onSelectScreen: @escaping (AppScreen) -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.selectedScreen = selectedScreen
        self.onSelectScreen = onSelectScreen
        self.content = content()
    }

    var body: some View {
        HStack(spacing: 0) {
            SidebarNavigation(
                selectedScreen: selectedScreen,
                onSelectScreen: onSelectScreen
            )

            Divider()

            VStack(spacing: 0) {
                toolbar

                Divider()

                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(Color(nsColor: .textBackgroundColor))
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var toolbar: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(selectedScreen.title)
                    .font(.headline)
                Text(selectedScreen.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
        .frame(minHeight: 64)
        .background(Color(nsColor: .textBackgroundColor))
    }
}

private struct SidebarNavigation: View {
    let selectedScreen: AppScreen
    let onSelectScreen: (AppScreen) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Meetless")
                    .font(.title3.weight(.semibold))
                Text("Local recorder")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 18)
            .padding(.top, 22)
            .padding(.bottom, 18)

            VStack(spacing: 4) {
                ForEach(AppScreen.primaryNavigationCases) { screen in
                    Button {
                        onSelectScreen(screen)
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: screen.systemImage)
                                .font(.system(size: 15, weight: .medium))
                                .frame(width: 20)
                            Text(screen.title)
                                .font(.system(size: 14, weight: .medium))
                            Spacer()
                        }
                        .foregroundStyle(selectedScreen == screen ? Color.primary : Color.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(selectedScreen == screen ? Color.accentColor.opacity(0.14) : Color.clear)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(screen.title)
                }
            }
            .padding(.horizontal, 10)

            Spacer()
        }
        .frame(width: 220)
        .background(
            Color(nsColor: .windowBackgroundColor)
                .opacity(0.96)
        )
    }
}

#Preview {
    MeetlessRootView()
        .frame(width: 1080, height: 720)
}
