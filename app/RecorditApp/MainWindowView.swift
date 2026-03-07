import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import SwiftUI

@MainActor
final class RootCompositionController: ObservableObject {
    struct Snapshot {
        var navigationState: NavigationState
        var canNavigateBack: Bool
        var onboardingComplete: Bool
        var onboardingGateFailure: AppServiceError?
        var startupRuntimeReadinessFailure: AppServiceError?
        var startupRuntimeSummary: String
        var preflightState: PreflightViewModel.State
        var preflightSummary: String
        var preflightCanProceed: Bool
        var preflightRequiresWarningAck: Bool
        var preflightCanOfferRecordOnlyFallback: Bool
        var permissionState: PermissionRemediationViewModel.State
        var missingPermissions: [RemediablePermission]
        var shouldShowScreenRecordingRestartAdvisory: Bool
        var modelState: ModelSetupViewModel.State
        var selectedBackend: String
        var modelSummary: String
        var modelCanStart: Bool
        var modelDiagnostics: ModelSetupViewModel.ModelDiagnostics?
        var runtimeServiceType: String
        var manifestServiceType: String
    }

    private let environment: AppEnvironment
    private let shellViewModel: AppShellViewModel
    private let modelSetupViewModel: ModelSetupViewModel
    private let preflightViewModel: PreflightViewModel
    private let permissionRemediationViewModel: PermissionRemediationViewModel

    @Published private(set) var snapshot: Snapshot

    init(environment: AppEnvironment, firstRun: Bool? = nil) {
        self.environment = environment
        self.shellViewModel = AppShellViewModel(firstRun: firstRun)
        self.modelSetupViewModel = environment.makeModelSetupViewModel()
        self.preflightViewModel = environment.makePreflightViewModel()
        self.permissionRemediationViewModel = environment.makePermissionRemediationViewModel(
            openSystemSettings: { url in
                NSWorkspace.shared.open(url)
            }
        )
        self.snapshot = Self.captureSnapshot(
            environment: environment,
            shellViewModel: shellViewModel,
            modelSetupViewModel: modelSetupViewModel,
            preflightViewModel: preflightViewModel,
            permissionRemediationViewModel: permissionRemediationViewModel
        )
    }

    func send(_ intent: NavigationIntent) {
        shellViewModel.send(intent)
        refresh()
    }

    func runPreflight() {
        preflightViewModel.runLivePreflight()
        refresh()
    }

    func acknowledgeWarnings() {
        preflightViewModel.acknowledgeWarningsForLiveTranscribe()
        refresh()
    }

    func runPermissionCheck() {
        PermissionPromptRequester.requestAccessIfNeeded(for: .screenRecording)
        PermissionPromptRequester.requestAccessIfNeeded(for: .microphone)
        permissionRemediationViewModel.runPermissionCheck()
        refresh()
    }

    func recheckPermissions() {
        PermissionPromptRequester.requestAccessIfNeeded(for: .screenRecording)
        PermissionPromptRequester.requestAccessIfNeeded(for: .microphone)
        permissionRemediationViewModel.recheckPermissions()
        refresh()
    }

    func openSettings(for permission: RemediablePermission) {
        PermissionPromptRequester.requestAccessIfNeeded(for: permission)
        _ = permissionRemediationViewModel.openSettings(for: permission)
        refresh()
    }

    func dismissScreenRecordingRestartAdvisory() {
        permissionRemediationViewModel.dismissScreenRecordingRestartAdvisory()
        refresh()
    }

    func validateModelSetup() {
        modelSetupViewModel.validateCurrentSelection()
        refresh()
    }

    func chooseBackend(_ backend: String) {
        modelSetupViewModel.chooseBackend(backend)
        refresh()
    }

    func completeOnboarding() {
        _ = shellViewModel.completeOnboardingIfReady(
            modelSetup: modelSetupViewModel,
            preflight: preflightViewModel
        )
        refresh()
    }

    func resetOnboarding() {
        shellViewModel.resetOnboardingCompletion()
        refresh()
    }

    private func refresh() {
        snapshot = Self.captureSnapshot(
            environment: environment,
            shellViewModel: shellViewModel,
            modelSetupViewModel: modelSetupViewModel,
            preflightViewModel: preflightViewModel,
            permissionRemediationViewModel: permissionRemediationViewModel
        )
    }

    private static func captureSnapshot(
        environment: AppEnvironment,
        shellViewModel: AppShellViewModel,
        modelSetupViewModel: ModelSetupViewModel,
        preflightViewModel: PreflightViewModel,
        permissionRemediationViewModel: PermissionRemediationViewModel
    ) -> Snapshot {
        Snapshot(
            navigationState: shellViewModel.navigationState,
            canNavigateBack: shellViewModel.navigationCoordinator.canNavigateBack,
            onboardingComplete: shellViewModel.isOnboardingComplete,
            onboardingGateFailure: shellViewModel.onboardingGateFailure,
            startupRuntimeReadinessFailure: shellViewModel.startupRuntimeReadinessFailure,
            startupRuntimeSummary: startupRuntimeSummary(shellViewModel.startupRuntimeReadinessReport),
            preflightState: preflightViewModel.state,
            preflightSummary: preflightSummary(preflightViewModel.state),
            preflightCanProceed: preflightViewModel.canProceedToLiveTranscribe,
            preflightRequiresWarningAck: preflightViewModel.requiresWarningAcknowledgement,
            preflightCanOfferRecordOnlyFallback: preflightViewModel.canOfferRecordOnlyFallback,
            permissionState: permissionRemediationViewModel.state,
            missingPermissions: permissionRemediationViewModel.missingPermissions,
            shouldShowScreenRecordingRestartAdvisory: permissionRemediationViewModel.shouldShowScreenRecordingRestartAdvisory,
            modelState: modelSetupViewModel.state,
            selectedBackend: modelSetupViewModel.selectedBackend,
            modelSummary: modelSummary(modelSetupViewModel.state),
            modelCanStart: modelSetupViewModel.canStartLiveTranscribe,
            modelDiagnostics: modelSetupViewModel.diagnostics,
            runtimeServiceType: String(describing: type(of: environment.runtimeService)),
            manifestServiceType: String(describing: type(of: environment.manifestService))
        )
    }

    private static func startupRuntimeSummary(_ report: RuntimeBinaryReadinessReport) -> String {
        guard !report.checks.isEmpty else {
            return "No runtime readiness checks available."
        }

        let parts = report.checks.map { check in
            let resolvedPath = check.resolvedPath ?? "unresolved"
            return "\(check.binaryName): \(check.status.rawValue) (\(resolvedPath))"
        }
        return parts.joined(separator: " | ")
    }

    private static func preflightSummary(_ state: PreflightViewModel.State) -> String {
        switch state {
        case .idle:
            return "Idle"
        case .running:
            return "Running preflight checks"
        case .completed(let envelope):
            return "Completed: overall status \(envelope.overallStatus.rawValue)"
        case .failed(let error):
            return "Failed: \(error.code.rawValue)"
        }
    }

    private static func modelSummary(_ state: ModelSetupViewModel.State) -> String {
        switch state {
        case .idle:
            return "Idle"
        case .validating:
            return "Validating model setup"
        case .ready(let resolved):
            return "Ready: \(resolved.source)"
        case .invalid(let error):
            return "Invalid: \(error.code.rawValue)"
        }
    }

    var appEnvironment: AppEnvironment {
        environment
    }
}

enum PermissionPromptRequester {
    static func shouldSkipNativePermissionPrompts(environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        environment["RECORDIT_UI_TEST_MODE"] == "1" || environment["XCTestConfigurationFilePath"] != nil
    }

    static func requestAccessIfNeeded(for permission: RemediablePermission) {
        // Keep automation and XCTest lanes deterministic by skipping native permission prompts.
        guard !shouldSkipNativePermissionPrompts() else {
            return
        }

        switch permission {
        case .screenRecording:
            requestScreenRecordingAccessIfNeeded()
        case .microphone:
            requestMicrophoneAccessIfNeeded()
        }
    }

    private static func requestScreenRecordingAccessIfNeeded() {
        guard !CGPreflightScreenCaptureAccess() else {
            return
        }
        _ = CGRequestScreenCaptureAccess()
    }

    private static func requestMicrophoneAccessIfNeeded() {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined else {
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
    }
}

@MainActor
final class SessionsLibraryController: ObservableObject {
    @Published private(set) var listState: SessionListViewModel.ViewState = .idle
    @Published private(set) var visibleSessions: [SessionSummaryDTO] = []
    @Published private(set) var detailState: SessionDetailViewModel.LoadState = .idle
    @Published private(set) var playbackState: SessionPlaybackViewModel.ViewState = .idle
    @Published private(set) var selectedSessionID: String?
    @Published private(set) var latestNotification: PendingSessionNotificationIntent?
    @Published private(set) var filters: SessionListViewModel.Filters = .init()

    private let sessionLibraryService: any SessionLibraryService
    private let exportService: any SessionExportService
    private let listViewModel: SessionListViewModel
    private let detailViewModel = SessionDetailViewModel()
    private let playbackViewModel = SessionPlaybackViewModel()
    private var hasLoaded = false
    private var playbackRefreshTask: Task<Void, Never>?

    init(environment: AppEnvironment) {
        self.sessionLibraryService = environment.sessionLibraryService
        self.exportService = FileSystemSessionExportService()
        let pendingTranscriptionService = PendingSessionTranscriptionService(
            runtimeService: environment.runtimeService,
            pendingSidecarService: environment.pendingSidecarService
        )
        self.listViewModel = SessionListViewModel(
            sessionLibrary: environment.sessionLibraryService,
            pendingTranscriptionService: pendingTranscriptionService
        )
        syncFromListViewModel()
    }

    deinit {
        playbackRefreshTask?.cancel()
    }

    func activate(navigationState: NavigationState) {
        if !hasLoaded {
            refresh()
        }
        syncSelectionToNavigation(navigationState)
    }

    func refresh() {
        listViewModel.refresh()
        hasLoaded = true
        syncFromListViewModel()
        reloadCurrentSelectionIfNeeded()
    }

    func setSearchText(_ text: String) {
        listViewModel.setSearchText(text)
        syncFromListViewModel()
        reloadCurrentSelectionIfNeeded()
    }

    func setModeFilter(_ mode: SessionListViewModel.ModeFilter) {
        listViewModel.setModeFilter(mode)
        syncFromListViewModel()
        reloadCurrentSelectionIfNeeded()
    }

    func setStatusFilter(_ status: SessionListViewModel.StatusFilter) {
        listViewModel.setStatusFilter(status)
        syncFromListViewModel()
        reloadCurrentSelectionIfNeeded()
    }

    func clearFilters() {
        listViewModel.clearFilters()
        syncFromListViewModel()
        reloadCurrentSelectionIfNeeded()
    }

    func selectSession(_ sessionID: String?) {
        guard let sessionID else {
            clearSelection()
            return
        }

        guard let summary = visibleSessions.first(where: { $0.sessionID == sessionID }) else {
            clearSelection()
            return
        }

        selectedSessionID = summary.sessionID
        detailViewModel.load(session: summary)
        detailState = detailViewModel.state

        if case .loaded(let detail) = detailState {
            playbackViewModel.load(sessionWavPath: detail.wavPath)
            playbackState = playbackViewModel.state
            reconcilePlaybackRefreshLoop()
        } else {
            playbackState = .idle
            reconcilePlaybackRefreshLoop()
        }
    }

    func transcribeSelectedPendingSession() async {
        guard let selectedSessionID else { return }
        await listViewModel.transcribePendingSession(sessionID: selectedSessionID)
        syncFromListViewModel()
        reloadCurrentSelectionIfNeeded()
    }

    func togglePlayback() {
        switch playbackState {
        case .playing:
            playbackViewModel.pause()
        case .ready, .paused, .completed:
            playbackViewModel.play()
        case .idle, .unavailable, .failed:
            return
        }
        playbackState = playbackViewModel.state
        reconcilePlaybackRefreshLoop()
    }

    func seekPlayback(to progress: Double) {
        playbackViewModel.seek(normalizedProgress: progress)
        playbackState = playbackViewModel.state
        reconcilePlaybackRefreshLoop()
    }

    func seekPlayback(bySeconds delta: TimeInterval) {
        guard let snapshot = playbackSnapshot, snapshot.durationSeconds > 0 else {
            return
        }
        let targetSeconds = min(max(snapshot.currentTimeSeconds + delta, 0), snapshot.durationSeconds)
        let normalized = targetSeconds / snapshot.durationSeconds
        playbackViewModel.seek(normalizedProgress: normalized)
        playbackState = playbackViewModel.state
        reconcilePlaybackRefreshLoop()
    }

    func exportSelectedSession(kind: SessionExportKind) -> Result<SessionExportResult, AppServiceError> {
        guard let summary = selectedSessionSummary else {
            return .failure(
                AppServiceError(
                    code: .invalidInput,
                    userMessage: "Select a session before exporting.",
                    remediation: "Choose a session row, then retry export."
                )
            )
        }

        let outputDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Downloads", isDirectory: true)
            .appendingPathComponent("RecorditExports", isDirectory: true)

        let request = SessionExportRequest(
            sessionID: summary.sessionID,
            sessionRoot: summary.rootPath,
            outputDirectory: outputDirectory,
            kind: kind,
            includeTranscriptTextInDiagnostics: false,
            includeAudioInDiagnostics: false
        )

        do {
            let result = try exportService.exportSession(request)
            return .success(result)
        } catch let serviceError as AppServiceError {
            return .failure(serviceError)
        } catch {
            return .failure(
                AppServiceError(
                    code: .unknown,
                    userMessage: "Export failed.",
                    remediation: "Retry export after checking file permissions.",
                    debugDetail: String(describing: error)
                )
            )
        }
    }

    func deleteSelectedSessionToTrash() -> Result<SessionDeletionResultDTO, AppServiceError> {
        guard let summary = selectedSessionSummary else {
            return .failure(
                AppServiceError(
                    code: .invalidInput,
                    userMessage: "Select a session before deleting.",
                    remediation: "Choose a session row, then retry delete."
                )
            )
        }

        do {
            let result = try sessionLibraryService.deleteSession(
                sessionID: summary.sessionID,
                rootPath: summary.rootPath,
                confirmTrash: true
            )
            refresh()
            clearSelection()
            return .success(result)
        } catch let serviceError as AppServiceError {
            return .failure(serviceError)
        } catch {
            return .failure(
                AppServiceError(
                    code: .unknown,
                    userMessage: "Session deletion failed.",
                    remediation: "Retry delete after refreshing sessions.",
                    debugDetail: String(describing: error)
                )
            )
        }
    }

    var playbackProgress: Double {
        playbackSnapshot?.progress ?? 0
    }

    var playbackElapsedLabel: String {
        guard let snapshot = playbackSnapshot else {
            return "00:00"
        }
        return Self.mmss(snapshot.currentTimeSeconds)
    }

    var playbackDurationLabel: String {
        guard let snapshot = playbackSnapshot else {
            return "00:00"
        }
        return Self.mmss(snapshot.durationSeconds)
    }

    var canTogglePlayback: Bool {
        switch playbackState {
        case .ready, .playing, .paused, .completed:
            return true
        case .idle, .unavailable, .failed:
            return false
        }
    }

    var canSeekPlayback: Bool {
        guard let snapshot = playbackSnapshot else {
            return false
        }
        return snapshot.durationSeconds > 0
    }

    var isPlaybackPlaying: Bool {
        if case .playing = playbackState {
            return true
        }
        return false
    }

    private var playbackSnapshot: AudioPlaybackSnapshot? {
        switch playbackState {
        case .ready(let snapshot), .playing(let snapshot), .paused(let snapshot), .completed(let snapshot):
            return snapshot
        case .idle, .unavailable, .failed:
            return nil
        }
    }

    private func clearSelection() {
        selectedSessionID = nil
        detailState = .idle
        playbackState = .idle
        reconcilePlaybackRefreshLoop()
    }

    private var selectedSessionSummary: SessionSummaryDTO? {
        guard let selectedSessionID else {
            return nil
        }
        return visibleSessions.first(where: { $0.sessionID == selectedSessionID })
    }

    private func reloadCurrentSelectionIfNeeded() {
        guard let selectedSessionID else { return }
        selectSession(selectedSessionID)
    }

    private func syncSelectionToNavigation(_ navigationState: NavigationState) {
        guard navigationState.root == .sessions else {
            return
        }

        if case let .detail(sessionID) = navigationState.sessionsPath.last {
            selectSession(sessionID)
            return
        }

        if selectedSessionID != nil {
            clearSelection()
        }
    }

    private func syncFromListViewModel() {
        listState = listViewModel.state
        visibleSessions = listViewModel.visibleItems
        filters = listViewModel.filters
        if let firstNotification = listViewModel.consumePendingNotifications().first {
            latestNotification = firstNotification
        }
    }

    private func reconcilePlaybackRefreshLoop() {
        let shouldPoll: Bool
        switch playbackState {
        case .playing:
            shouldPoll = true
        case .idle, .ready, .paused, .completed, .unavailable, .failed:
            shouldPoll = false
        }

        if shouldPoll {
            if playbackRefreshTask == nil {
                playbackRefreshTask = Task { @MainActor [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 250_000_000)
                        guard let self else { break }
                        self.playbackViewModel.refresh()
                        self.playbackState = self.playbackViewModel.state
                        if case .playing = self.playbackState {
                            continue
                        }
                        self.reconcilePlaybackRefreshLoop()
                        break
                    }
                }
            }
        } else {
            playbackRefreshTask?.cancel()
            playbackRefreshTask = nil
        }
    }

    private static func mmss(_ seconds: TimeInterval) -> String {
        let clamped = max(0, Int(seconds.rounded(.down)))
        return String(format: "%02d:%02d", clamped / 60, clamped % 60)
    }
}

struct MainWindowView: View {
    private enum SessionsFocusTarget: Hashable {
        case search
        case timeline
    }

    private struct SessionActionNotice: Identifiable {
        let id = UUID()
        let message: String
        let isError: Bool
    }

    private struct SessionActionConfirmation: Identifiable {
        enum Action {
            case export(SessionExportKind)
            case deleteToTrash
        }

        let id = UUID()
        let sessionID: String
        let action: Action

        var title: String {
            switch action {
            case .export(let kind):
                return "Confirm \(kind.rawValue.capitalized) Export"
            case .deleteToTrash:
                return "Confirm Delete to Trash"
            }
        }

        var message: String {
            switch action {
            case .export(let kind):
                if kind == .diagnostics {
                    return "Diagnostics export can leave app-managed storage. Transcript text and audio are redacted by default for privacy. Continue?"
                }
                return "Exported files leave app-managed storage into ~/Downloads/RecorditExports. Continue?"
            case .deleteToTrash:
                return "This moves the selected session folder to macOS Trash. Continue?"
            }
        }
    }

    private enum RuntimeTerminalSheet: Identifiable {
        case sessionSummary(MainSessionController.FinalizationSummary)
        case errorRecovery(AppServiceError, [RuntimeViewModel.RecoveryAction])

        var id: String {
            switch self {
            case .sessionSummary(let summary):
                return "summary-\(summary.sessionID)-\(summary.status)-\(summary.trustNoticeCount)"
            case .errorRecovery(let error, let actions):
                return "recovery-\(error.code.rawValue)-\(actions.map(\.rawValue).joined(separator: ","))"
            }
        }
    }

    @StateObject private var controller: RootCompositionController
    @StateObject private var mainSessionController: MainSessionController
    @StateObject private var sessionsController: SessionsLibraryController
    @State private var activeTerminalSheet: RuntimeTerminalSheet?
    @State private var pendingSessionActionConfirmation: SessionActionConfirmation?
    @State private var sessionActionNotice: SessionActionNotice?
    @FocusState private var sessionsFocusTarget: SessionsFocusTarget?

    init(environment: AppEnvironment = .production(), firstRun: Bool? = nil) {
        let rootController = RootCompositionController(environment: environment, firstRun: firstRun)
        _controller = StateObject(wrappedValue: rootController)
        _mainSessionController = StateObject(
            wrappedValue: MainSessionController(environment: rootController.appEnvironment)
        )
        _sessionsController = StateObject(
            wrappedValue: SessionsLibraryController(environment: rootController.appEnvironment)
        )
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 280)
                .padding(16)
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(20)
        }
        .frame(minWidth: 880, minHeight: 560)
        .onChange(of: mainSessionController.runtimeState) { _, newState in
            presentTerminalSheetIfNeeded(for: newState)
        }
        .sheet(item: $activeTerminalSheet, onDismiss: {
            controller.send(.dismissOverlay)
        }) { sheet in
            switch sheet {
            case .sessionSummary(let summary):
                SessionSummarySheet(
                    summary: summary,
                    openSessions: {
                        controller.send(.openSessionDetail(sessionID: summary.sessionID))
                    },
                    startNewSession: {
                        controller.send(.openMainRuntime)
                    },
                    dismiss: {
                        activeTerminalSheet = nil
                    }
                )
            case .errorRecovery(let error, let actions):
                ErrorRecoverySheet(
                    error: error,
                    actions: actions,
                    performAction: { action in
                        performRecoveryAction(action)
                    },
                    dismiss: {
                        activeTerminalSheet = nil
                    }
                )
            }
        }
        .alert(item: $pendingSessionActionConfirmation) { confirmation in
            let confirmLabel: String
            switch confirmation.action {
            case .export:
                confirmLabel = "Export"
            case .deleteToTrash:
                confirmLabel = "Delete"
            }
            return Alert(
                title: Text(confirmation.title),
                message: Text(confirmation.message),
                primaryButton: .default(Text(confirmLabel)) {
                    runConfirmedSessionAction(confirmation)
                },
                secondaryButton: .cancel()
            )
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Recordit")
                .font(.title)
                .bold()

            Text("Root Composition Controls")
                .font(.headline)

            Group {
                Button("Onboarding") {
                    controller.send(.deepLink(.onboarding))
                }
                Button("Main Runtime") {
                    controller.send(.openMainRuntime)
                }
                Button("Sessions List") {
                    controller.send(.openSessions)
                }
                Button("Sample Session Detail") {
                    controller.send(.openSessionDetail(sessionID: "sample-session-001"))
                }
                Button("Recovery (runtime)") {
                    controller.send(.openRecovery(errorCode: .runtimeUnavailable))
                }
            }
            .buttonStyle(.borderedProminent)

            Divider()

            Button("Back") {
                controller.send(.back)
            }
            .disabled(!controller.snapshot.canNavigateBack)

            Button("Reset Route") {
                controller.send(.resetToRoot)
            }

            Spacer()

            Text("DI Runtime")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(controller.snapshot.runtimeServiceType)
                .font(.caption2)
                .textSelection(.enabled)

            Text("DI Manifest")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(controller.snapshot.manifestServiceType)
                .font(.caption2)
                .textSelection(.enabled)
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            routeHeader
            Divider()

            switch controller.snapshot.navigationState.root {
            case .onboarding:
                onboardingRoute
            case .mainRuntime:
                mainRuntimeRoute
            case .sessions:
                sessionsRoute
            case .recovery:
                recoveryRoute
            }

            if let overlay = controller.snapshot.navigationState.overlay {
                Divider()
                Text("Overlay: \(overlaySummary(overlay))")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var routeHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Active Root: \(controller.snapshot.navigationState.root.rawValue)")
                .font(.title2)
                .bold()

            Text("Persisted onboarding complete: \(controller.snapshot.onboardingComplete ? "yes" : "no")")
                .font(.subheadline)

            Text("Startup readiness: \(controller.snapshot.startupRuntimeSummary)")
                .font(.footnote)
                .foregroundStyle(.secondary)

            if let startupFailure = controller.snapshot.startupRuntimeReadinessFailure {
                Text("Startup readiness failure: \(startupFailure.userMessage)")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    private var onboardingRoute: some View {
        OnboardingFlowView(controller: controller)
    }

    private var mainRuntimeRoute: some View {
        VStack(alignment: .leading, spacing: 12) {
            MainSessionView(controller: mainSessionController)
            Button("Go To Sessions") {
                controller.send(.openSessions)
            }
            .buttonStyle(.bordered)
        }
    }

    private var sessionsRoute: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Sessions")
                    .font(.headline)
                Spacer()
                Text("Path depth: \(controller.snapshot.navigationState.sessionsPath.count)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let lastRoute = controller.snapshot.navigationState.sessionsPath.last {
                    Text("Route: \(sessionsRouteSummary(lastRoute))")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Route: list")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            sessionsFiltersToolbar

            if let notification = sessionsController.latestNotification {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "bell.badge")
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(notification.title)
                            .font(.subheadline)
                            .bold()
                        Text(notification.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }

            if case .failed(let error, _) = sessionsController.listState {
                VStack(alignment: .leading, spacing: 4) {
                    Text(error.userMessage)
                        .foregroundStyle(.red)
                    Text(error.remediation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(10)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }

            HStack(spacing: 14) {
                sessionsListPane
                    .frame(minWidth: 320, idealWidth: 360, maxWidth: 420, maxHeight: .infinity)
                Divider()
                sessionsDetailPane
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .onAppear {
            sessionsController.activate(navigationState: controller.snapshot.navigationState)
        }
        .onChange(of: controller.snapshot.navigationState) { _, newState in
            sessionsController.activate(navigationState: newState)
        }
    }

    private var sessionsFiltersToolbar: some View {
        HStack(spacing: 10) {
            TextField(
                "Search by session ID or transcript text",
                text: Binding(
                    get: { sessionsController.filters.searchText },
                    set: { sessionsController.setSearchText($0) }
                )
            )
            .textFieldStyle(.roundedBorder)
            .frame(minWidth: 260)
            .accessibilityIdentifier("sessions_search")
            .focused($sessionsFocusTarget, equals: .search)

            Picker(
                "Mode",
                selection: Binding(
                    get: { sessionsController.filters.mode },
                    set: { sessionsController.setModeFilter($0) }
                )
            ) {
                ForEach(SessionListViewModel.ModeFilter.allCases, id: \.self) { mode in
                    Text(modeLabel(mode)).tag(mode)
                }
            }
            .frame(width: 170)
            .accessibilityIdentifier("sessions_mode_filter")

            Picker(
                "Status",
                selection: Binding(
                    get: { sessionsController.filters.status },
                    set: { sessionsController.setStatusFilter($0) }
                )
            ) {
                ForEach(SessionListViewModel.StatusFilter.allCases, id: \.self) { status in
                    Text(statusLabel(status)).tag(status)
                }
            }
            .frame(width: 170)
            .accessibilityIdentifier("sessions_status_filter")

            Button("Clear") {
                sessionsController.clearFilters()
            }
            .buttonStyle(.bordered)
            .keyboardShortcut(.delete, modifiers: [.command, .option])

            Button("Refresh") {
                sessionsController.refresh()
            }
            .buttonStyle(.borderedProminent)

            Button("Focus Search (Shortcut)") {
                sessionsFocusTarget = .search
            }
            .keyboardShortcut("f", modifiers: [.command])
            .frame(width: 1, height: 1)
            .opacity(0.001)
            .accessibilityHidden(true)
        }
    }

    private var sessionsListPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            if case .loading = sessionsController.listState {
                ProgressView("Refreshing sessions...")
                    .controlSize(.small)
            }

            if case .empty(let emptyState) = sessionsController.listState {
                ContentUnavailableView(emptyState.title, systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90")
                    .overlay(alignment: .bottom) {
                        Text(emptyState.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.bottom, 8)
                    }
            }

            List(selection: selectedSessionBinding) {
                ForEach(sessionsController.visibleSessions, id: \.sessionID) { session in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(session.sessionID)
                                .font(.subheadline)
                                .bold()
                                .lineLimit(1)
                            Spacer()
                            Text(statusLabel(session.status))
                                .font(.caption2)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(statusColor(session.status).opacity(0.15), in: Capsule())
                                .foregroundStyle(statusColor(session.status))
                        }
                        Text("\(modeLabel(session.mode)) · \(startedAtLabel(session.startedAt)) · \(durationLabel(session.durationMs))")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        if session.mode == .recordOnly {
                            Text("Pending transcription: \(pendingTranscriptionStateLabel(session.pendingTranscriptionState))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    .tag(session.sessionID)
                }
            }
            .listStyle(.inset)
            .accessibilityIdentifier("sessions_results_list")
        }
    }

    private var sessionsDetailPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch sessionsController.detailState {
            case .idle:
                ContentUnavailableView(
                    "Select a session",
                    systemImage: "list.bullet.rectangle.portrait",
                    description: Text("Choose a row in the sessions list to inspect transcript detail and playback.")
                )
            case .loading:
                ProgressView("Loading session detail...")
            case .loaded(let detail):
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(detail.summary.sessionID)
                            .font(.title3)
                            .bold()
                        Text("\(modeLabel(detail.summary.mode)) · \(statusLabel(detail.summary.status)) · \(startedAtLabel(detail.summary.startedAt))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("session_header")
                }

                Text("Transcript source: \(detail.transcriptSource.rawValue) · Trust notices: \(detail.trustNoticeCount) · Malformed JSONL lines: \(detail.malformedJsonlLineCount)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                pendingTranscriptionPanel(for: detail.summary)
                sessionActionsPanel(for: detail.summary)

                playbackPanel

                Divider()

                transcriptPanel(detail)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    @ViewBuilder
    private func pendingTranscriptionPanel(for summary: SessionSummaryDTO) -> some View {
        if summary.mode == .recordOnly {
            let presentation = pendingTranscriptionPresentation(for: summary)
            VStack(alignment: .leading, spacing: 6) {
                Text("Deferred Transcription")
                    .font(.subheadline)
                    .bold()

                Text(presentation.headline)
                    .font(.subheadline)
                    .foregroundStyle(presentation.canTranscribe ? .green : .secondary)

                Text(presentation.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                Button("Transcribe Pending Session") {
                    Task {
                        await sessionsController.transcribeSelectedPendingSession()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!presentation.canTranscribe)
            }
            .padding(10)
            .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func sessionActionsPanel(for summary: SessionSummaryDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Session Actions")
                .font(.subheadline)
                .bold()

            Text("Privacy note: exports leave app-managed storage (`~/Downloads/RecorditExports`). Diagnostics exports are redacted by default.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                Button("Export Bundle") {
                    pendingSessionActionConfirmation = SessionActionConfirmation(
                        sessionID: summary.sessionID,
                        action: .export(.bundle)
                    )
                }
                .buttonStyle(.bordered)

                Button("Export Transcript") {
                    pendingSessionActionConfirmation = SessionActionConfirmation(
                        sessionID: summary.sessionID,
                        action: .export(.transcript)
                    )
                }
                .buttonStyle(.bordered)

                Button("Export Diagnostics") {
                    pendingSessionActionConfirmation = SessionActionConfirmation(
                        sessionID: summary.sessionID,
                        action: .export(.diagnostics)
                    )
                }
                .buttonStyle(.bordered)

                Button("Delete to Trash") {
                    pendingSessionActionConfirmation = SessionActionConfirmation(
                        sessionID: summary.sessionID,
                        action: .deleteToTrash
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
            }

            if let sessionActionNotice {
                Text(sessionActionNotice.message)
                    .font(.footnote)
                    .foregroundStyle(sessionActionNotice.isError ? .red : .secondary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        (sessionActionNotice.isError ? Color.red : Color.secondary).opacity(0.08),
                        in: RoundedRectangle(cornerRadius: 8)
                    )
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private var playbackPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Audio Playback")
                .font(.subheadline)
                .bold()

            switch sessionsController.playbackState {
            case .idle:
                Text("Load a session to initialize playback controls.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            case .unavailable(let reason):
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            case .failed(let error):
                VStack(alignment: .leading, spacing: 4) {
                    Text(error.userMessage)
                        .foregroundStyle(.red)
                    Text(error.remediation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            case .ready, .playing, .paused, .completed:
                HStack(spacing: 10) {
                    Button(playbackButtonLabel) {
                        sessionsController.togglePlayback()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!sessionsController.canTogglePlayback)
                    .keyboardShortcut(.space, modifiers: [])
                    .accessibilityIdentifier(
                        sessionsController.isPlaybackPlaying ? "pause_audio" : "play_audio"
                    )

                    Slider(
                        value: Binding(
                            get: { sessionsController.playbackProgress },
                            set: { sessionsController.seekPlayback(to: $0) }
                        ),
                        in: 0 ... 1
                    )
                    .disabled(!sessionsController.canSeekPlayback)
                    .accessibilityIdentifier("seek_audio")

                    Button("-5s") {
                        sessionsController.seekPlayback(bySeconds: -5)
                    }
                    .buttonStyle(.bordered)
                    .keyboardShortcut(.leftArrow, modifiers: [.option])

                    Button("+5s") {
                        sessionsController.seekPlayback(bySeconds: 5)
                    }
                    .buttonStyle(.bordered)
                    .keyboardShortcut(.rightArrow, modifiers: [.option])

                    Text("\(sessionsController.playbackElapsedLabel) / \(sessionsController.playbackDurationLabel)")
                        .font(.system(.caption, design: .monospaced))
                }
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("playback_controls")
    }

    private func transcriptPanel(_ detail: SessionDetailDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Transcript Timeline")
                .font(.subheadline)
                .bold()

            if detail.conversationLines.isEmpty {
                ContentUnavailableView(
                    "No transcript lines",
                    systemImage: "text.bubble",
                    description: Text("This session currently has no stable transcript timeline.")
                )
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(detail.conversationLines.enumerated()), id: \.offset) { entry in
                            let line = entry.element
                            VStack(alignment: .leading, spacing: 3) {
                                Text("[\(timecodeLabel(line.startMs)) - \(timecodeLabel(line.endMs))] \(line.channel) · \(line.eventType.rawValue)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(line.text)
                                    .font(.body)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(8)
                            .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .focused($sessionsFocusTarget, equals: .timeline)
                .accessibilityIdentifier("conversation_timeline")
            }

            Button("Focus Timeline (Shortcut)") {
                sessionsFocusTarget = .timeline
            }
            .keyboardShortcut("t", modifiers: [.command])
            .frame(width: 1, height: 1)
            .opacity(0.001)
            .accessibilityHidden(true)
        }
    }

    private var selectedSessionBinding: Binding<String?> {
        Binding(
            get: { sessionsController.selectedSessionID },
            set: { newValue in
                if let newValue {
                    controller.send(.openSessionDetail(sessionID: newValue))
                } else {
                    controller.send(.deepLink(.sessionsList))
                }
            }
        )
    }

    private var playbackButtonLabel: String {
        switch sessionsController.playbackState {
        case .playing:
            return "Pause"
        case .ready, .paused, .completed:
            return "Play"
        case .idle, .unavailable, .failed:
            return "Play"
        }
    }

    private func presentTerminalSheetIfNeeded(for state: RuntimeViewModel.RunState) {
        switch state {
        case .completed:
            guard let summary = mainSessionController.latestFinalizationSummary else {
                return
            }
            controller.send(.showSessionSummary(sessionID: summary.sessionID))
            activeTerminalSheet = .sessionSummary(summary)
        case .failed(let error):
            controller.send(.showRuntimeError(errorCode: error.code))
            let actions = mainSessionController.recoveryActions
            let resolvedActions = actions.isEmpty ? [.startNewSession] : actions
            activeTerminalSheet = .errorRecovery(error, resolvedActions)
        case .idle, .preparing, .running, .stopping, .finalizing:
            break
        }
    }

    private func performRecoveryAction(_ action: RuntimeViewModel.RecoveryAction) {
        switch action {
        case .resumeSession:
            mainSessionController.resumeInterruptedSession()
        case .safeFinalize:
            mainSessionController.safeFinalizeInterruptedSession()
        case .retryStop:
            mainSessionController.retryStopFailedLiveSession()
        case .retryFinalize:
            mainSessionController.retryFinalizeFailedSession()
        case .openSessionArtifacts:
            mainSessionController.openCurrentSessionArtifacts()
        case .runPreflight:
            controller.send(.deepLink(.onboarding))
        case .startNewSession:
            controller.send(.openMainRuntime)
        }
        activeTerminalSheet = nil
    }

    private func runConfirmedSessionAction(_ confirmation: SessionActionConfirmation) {
        switch confirmation.action {
        case .export(let kind):
            let result = sessionsController.exportSelectedSession(kind: kind)
            switch result {
            case .success(let exportResult):
                sessionActionNotice = SessionActionNotice(
                    message: "\(kind.rawValue.capitalized) export completed: \(exportResult.outputURL.path)",
                    isError: false
                )
                NSWorkspace.shared.activateFileViewerSelecting([exportResult.outputURL])
            case .failure(let error):
                sessionActionNotice = SessionActionNotice(
                    message: "\(kind.rawValue.capitalized) export failed: \(error.userMessage)",
                    isError: true
                )
            }
        case .deleteToTrash:
            let result = sessionsController.deleteSelectedSessionToTrash()
            switch result {
            case .success(let deletionResult):
                let destination = deletionResult.trashedRootPath?.path ?? "Trash"
                sessionActionNotice = SessionActionNotice(
                    message: "Session deleted to trash: \(destination)",
                    isError: false
                )
            case .failure(let error):
                sessionActionNotice = SessionActionNotice(
                    message: "Delete to trash failed: \(error.userMessage)",
                    isError: true
                )
            }
        }
    }

    private struct PendingTranscriptionPresentation {
        var headline: String
        var detail: String
        var canTranscribe: Bool
    }

    private func pendingTranscriptionPresentation(for summary: SessionSummaryDTO) -> PendingTranscriptionPresentation {
        switch summary.pendingTranscriptionState {
        case .readyToTranscribe:
            if summary.readyToTranscribe {
                return PendingTranscriptionPresentation(
                    headline: "Ready",
                    detail: "Model prerequisites are satisfied. Run one-click deferred transcription now.",
                    canTranscribe: true
                )
            }
            return PendingTranscriptionPresentation(
                headline: "Blocked",
                detail: "Refresh session metadata and verify model readiness before transcribing.",
                canTranscribe: false
            )
        case .pendingModel:
            return PendingTranscriptionPresentation(
                headline: "Blocked",
                detail: "Model setup is incomplete. Complete onboarding/model setup, then retry.",
                canTranscribe: false
            )
        case .transcribing:
            return PendingTranscriptionPresentation(
                headline: "In Progress",
                detail: "Deferred transcription is currently running. Refresh for updated status.",
                canTranscribe: false
            )
        case .completed:
            return PendingTranscriptionPresentation(
                headline: "Completed",
                detail: "Deferred transcription finished. Open session detail for finalized transcript outputs.",
                canTranscribe: false
            )
        case .failed:
            return PendingTranscriptionPresentation(
                headline: "Failed",
                detail: "Deferred transcription failed. Review session artifacts/retry context and recover prerequisites.",
                canTranscribe: false
            )
        case .none:
            return PendingTranscriptionPresentation(
                headline: "Not Available",
                detail: "No pending sidecar state is present for this record-only session.",
                canTranscribe: false
            )
        }
    }

    private func pendingTranscriptionStateLabel(_ state: PendingTranscriptionState?) -> String {
        switch state {
        case .pendingModel:
            return "pending_model"
        case .readyToTranscribe:
            return "ready_to_transcribe"
        case .transcribing:
            return "transcribing"
        case .completed:
            return "completed"
        case .failed:
            return "failed"
        case .none:
            return "none"
        }
    }

    private func modeLabel(_ mode: SessionListViewModel.ModeFilter) -> String {
        switch mode {
        case .all:
            return "All Modes"
        case .live:
            return "Live"
        case .recordOnly:
            return "Record Only"
        }
    }

    private func modeLabel(_ mode: RuntimeMode) -> String {
        switch mode {
        case .live:
            return "Live"
        case .offline:
            return "Offline"
        case .recordOnly:
            return "Record Only"
        }
    }

    private func statusLabel(_ status: SessionListViewModel.StatusFilter) -> String {
        switch status {
        case .all:
            return "All Statuses"
        case .pending:
            return "Pending"
        case .ok:
            return "OK"
        case .degraded:
            return "Degraded"
        case .failed:
            return "Failed"
        }
    }

    private func statusLabel(_ status: SessionStatus) -> String {
        switch status {
        case .pending:
            return "Pending"
        case .ok:
            return "OK"
        case .degraded:
            return "Degraded"
        case .failed:
            return "Failed"
        }
    }

    private func statusColor(_ status: SessionStatus) -> Color {
        switch status {
        case .pending:
            return .orange
        case .ok:
            return .green
        case .degraded:
            return .yellow
        case .failed:
            return .red
        }
    }

    private func startedAtLabel(_ startedAt: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: startedAt)
    }

    private func durationLabel(_ durationMs: UInt64) -> String {
        let totalSeconds = Int(durationMs / 1000)
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        let seconds = totalSeconds % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%02d:%02d", minutes, seconds)
    }

    private func timecodeLabel(_ milliseconds: UInt64) -> String {
        let totalSeconds = Int(milliseconds / 1000)
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }

    private var recoveryRoute: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Recovery")
                .font(.headline)
            Text("Recovery subtype: \(recoverySummary(controller.snapshot.navigationState.recovery))")

            if let startupFailure = controller.snapshot.startupRuntimeReadinessFailure {
                VStack(alignment: .leading, spacing: 4) {
                    Text(startupFailure.userMessage)
                        .foregroundStyle(.red)
                    Text(startupFailure.remediation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 12) {
                Button("Back to Main Runtime") {
                    controller.send(.openMainRuntime)
                }
                .buttonStyle(.bordered)

                Button("Reset Onboarding Completion") {
                    controller.resetOnboarding()
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func sessionsRouteSummary(_ route: SessionsRoute) -> String {
        switch route {
        case .list:
            return "list"
        case .detail(let sessionID):
            return "detail(\(sessionID))"
        }
    }

    private func recoverySummary(_ route: RecoveryRoute?) -> String {
        guard let route else {
            return "runtimeRecovery"
        }
        switch route {
        case .permissionRecovery:
            return "permissionRecovery"
        case .modelRecovery:
            return "modelRecovery"
        case .runtimeRecovery:
            return "runtimeRecovery"
        }
    }

    private func overlaySummary(_ overlay: RuntimeOverlayRoute) -> String {
        switch overlay {
        case .sessionSummary(let sessionID):
            return "sessionSummary(\(sessionID))"
        case .runtimeError(let code):
            return "runtimeError(\(code.rawValue))"
        }
    }
}

private struct SessionSummarySheet: View {
    let summary: MainSessionController.FinalizationSummary
    let openSessions: () -> Void
    let startNewSession: () -> Void
    let dismiss: () -> Void

    private var statusTone: Color {
        switch summary.status.lowercased() {
        case "ok":
            return .green
        case "degraded":
            return .yellow
        case "failed":
            return .red
        default:
            return .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Session Summary")
                .font(.title3)
                .bold()

            Text("Session \(summary.sessionID)")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                Text("Final status: \(summary.status.uppercased())")
                    .font(.headline)
                    .foregroundStyle(statusTone)
                if summary.trustNoticeCount > 0 {
                    Text("Trust notices: \(summary.trustNoticeCount)")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                }
            }

            Text(summary.trustNoticeCount > 0
                ? "Review trust/degradation notices before sharing or exporting artifacts."
                : "No trust notices were reported in the final manifest.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Text("Manifest: \(summary.manifestPath.path)")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            HStack(spacing: 10) {
                Button("Open Session Detail") {
                    openSessions()
                }
                .buttonStyle(.borderedProminent)

                Button("Start New Session") {
                    startNewSession()
                }
                .buttonStyle(.bordered)

                Button("Dismiss") {
                    dismiss()
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(20)
        .frame(minWidth: 520, minHeight: 240, alignment: .topLeading)
    }
}

private struct ErrorRecoverySheet: View {
    let error: AppServiceError
    let actions: [RuntimeViewModel.RecoveryAction]
    let performAction: (RuntimeViewModel.RecoveryAction) -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Runtime Recovery")
                .font(.title3)
                .bold()

            Text(error.userMessage)
                .font(.headline)
                .foregroundStyle(.red)

            Text(error.remediation)
                .font(.footnote)
                .foregroundStyle(.secondary)

            if let debugDetail = error.debugDetail, !debugDetail.isEmpty {
                Text("Debug: \(debugDetail)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            Text("Available actions")
                .font(.subheadline)
                .bold()

            FlowLayout(actions: actions) { action in
                Button(recoveryActionLabel(action)) {
                    performAction(action)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier(recoveryActionIdentifier(action))
            }

            Button("Dismiss") {
                dismiss()
            }
            .buttonStyle(.bordered)
        }
        .padding(20)
        .frame(minWidth: 560, minHeight: 260, alignment: .topLeading)
    }

    private func recoveryActionLabel(_ action: RuntimeViewModel.RecoveryAction) -> String {
        switch action {
        case .resumeSession:
            return "Resume Session"
        case .safeFinalize:
            return "Safe Finalize"
        case .retryStop:
            return "Retry Stop"
        case .retryFinalize:
            return "Retry Finalize"
        case .openSessionArtifacts:
            return "Open Artifacts"
        case .runPreflight:
            return "Run Preflight"
        case .startNewSession:
            return "Start New Session"
        }
    }

    private func recoveryActionIdentifier(_ action: RuntimeViewModel.RecoveryAction) -> String {
        switch action {
        case .resumeSession:
            return "resume_interrupted_session"
        case .safeFinalize:
            return "safe_finalize_session"
        case .retryStop:
            return "retry_stop_action"
        case .retryFinalize:
            return "retry_finalize_action"
        case .openSessionArtifacts:
            return "open_session_artifacts"
        case .runPreflight:
            return "run_preflight_action"
        case .startNewSession:
            return "start_new_session_action"
        }
    }
}

private struct FlowLayout<Data: RandomAccessCollection, Content: View>: View where Data.Element: Hashable {
    let actions: Data
    let content: (Data.Element) -> Content

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 8)], spacing: 8) {
            ForEach(Array(actions), id: \.self) { action in
                content(action)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

#Preview("Production Wiring") {
    MainWindowView(environment: .production())
}

#Preview("First Run (Preview DI)") {
    MainWindowView(environment: .preview(), firstRun: true)
}
