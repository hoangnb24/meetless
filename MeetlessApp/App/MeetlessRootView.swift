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
        case .settings:
            GeminiSettingsView(viewModel: appModel.geminiSettingsViewModel)
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

private struct GeminiSettingsView: View {
    @ObservedObject var viewModel: GeminiSettingsViewModel
    @State private var isConfirmingDelete = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MeetlessDesignTokens.Layout.largeGap) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Gemini")
                        .font(MeetlessDesignTokens.Typography.screenTitle)
                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                        .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                    Text("Save the API key used for session notes generation.")
                        .font(MeetlessDesignTokens.Typography.body)
                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                        .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                }

                VStack(alignment: .leading, spacing: MeetlessDesignTokens.Layout.defaultGap) {
                    GeminiKeyStatusRow(status: viewModel.keyStatus)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("API key")
                            .font(MeetlessDesignTokens.Typography.caption.weight(.semibold))
                            .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                            .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)

                        SecureField(
                            viewModel.isConfigured ? "Enter a new key to update" : "Enter Gemini API key",
                            text: $viewModel.apiKeyInput
                        )
                        .textFieldStyle(.roundedBorder)
                        .font(MeetlessDesignTokens.Typography.body)

                        Text("Saved keys stay in macOS Keychain and are not shown again after saving.")
                            .font(MeetlessDesignTokens.Typography.caption)
                            .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                            .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    }

                    if let feedbackMessage = viewModel.feedbackMessage {
                        Text(feedbackMessage)
                            .font(MeetlessDesignTokens.Typography.caption.weight(.medium))
                            .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                            .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    }

                    HStack(spacing: 10) {
                        Button {
                            viewModel.saveAPIKey()
                        } label: {
                            Label(viewModel.isConfigured ? "Update Key" : "Save Key", systemImage: "key.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!viewModel.canSave)

                        Button(role: .destructive) {
                            isConfirmingDelete = true
                        } label: {
                            Label("Delete Key", systemImage: "trash")
                        }
                        .buttonStyle(.bordered)
                        .disabled(!viewModel.isConfigured)

                        Spacer()
                    }
                }
                .padding(18)
                .background(MeetlessDesignTokens.Colors.windowBackground)
                .clipShape(RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous)
                        .stroke(MeetlessDesignTokens.Colors.separator)
                )

                Spacer(minLength: 0)
            }
            .frame(maxWidth: MeetlessDesignTokens.Layout.contentMaxWidth, alignment: .leading)
            .padding(.vertical, 6)
        }
        .alert("Delete Gemini API key?", isPresented: $isConfirmingDelete) {
            Button("Delete", role: .destructive) {
                viewModel.deleteAPIKey()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Session notes generation will stay unavailable until a new key is saved.")
        }
    }
}

private struct GeminiKeyStatusRow: View {
    let status: GeminiSettingsViewModel.KeyStatus

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StatusDot(color: statusColor, size: .medium)
                .padding(.top, 4)

            VStack(alignment: .leading, spacing: 4) {
                Text(status.title)
                    .font(MeetlessDesignTokens.Typography.body.weight(.semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                Text(status.detail)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
            }
        }
        .padding(12)
        .background(statusColor.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous))
    }

    private var statusColor: Color {
        switch status {
        case .configured:
            return MeetlessDesignTokens.Colors.successGreen
        case .error:
            return MeetlessDesignTokens.Colors.warningAmber
        case .unknown, .notConfigured:
            return MeetlessDesignTokens.Colors.tertiaryText
        }
    }
}

#Preview {
    MeetlessRootView()
        .frame(width: 1080, height: 720)
}
