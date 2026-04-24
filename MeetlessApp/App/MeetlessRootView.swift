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

            HairlineDivider(.vertical)

            VStack(spacing: 0) {
                toolbar

                HairlineDivider()

                MeetlessCanvas {
                    content
                }
            }
        }
        .background(MeetlessDesignTokens.Colors.appBackground)
    }

    private var toolbar: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(selectedScreen.title)
                    .font(MeetlessDesignTokens.Typography.windowTitle)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                Text(selectedScreen.subtitle)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
            }

            Spacer()
        }
        .padding(.horizontal, MeetlessDesignTokens.Layout.contentPadding)
        .frame(height: MeetlessDesignTokens.Layout.toolbarHeight)
        .background(MeetlessDesignTokens.Colors.windowBackground)
    }
}

private struct SidebarNavigation: View {
    let selectedScreen: AppScreen
    let onSelectScreen: (AppScreen) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Meetless")
                    .font(MeetlessDesignTokens.Typography.windowTitle)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                Text("Local recorder")
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
            }
            .padding(.horizontal, 16)
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
                                .font(MeetlessDesignTokens.Typography.body.weight(.medium))
                                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                            Spacer()
                        }
                        .foregroundStyle(
                            selectedScreen == screen
                                ? MeetlessDesignTokens.Colors.primaryBlue
                                : MeetlessDesignTokens.Colors.secondaryText
                        )
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(
                            RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.selection, style: .continuous)
                                .fill(selectedScreen == screen ? MeetlessDesignTokens.Colors.sidebarSelection : Color.clear)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(screen.title)
                }
            }
            .padding(.horizontal, 10)

            Spacer()

            LocalStatusFooter()
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
        }
        .frame(width: MeetlessDesignTokens.Layout.sidebarWidth)
        .background(MeetlessDesignTokens.Colors.sidebarBackground)
    }
}

#Preview {
    MeetlessRootView()
        .frame(width: 1080, height: 720)
}
