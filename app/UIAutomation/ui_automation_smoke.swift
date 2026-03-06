import Foundation

@MainActor
private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("ui_automation_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private final class InMemoryOnboardingCompletionStore: OnboardingCompletionStore {
    private var completed: Bool

    init(completed: Bool = false) {
        self.completed = completed
    }

    func isOnboardingComplete() -> Bool {
        completed
    }

    func markOnboardingComplete() {
        completed = true
    }

    func resetOnboardingCompletion() {
        completed = false
    }
}

private struct StubRuntimeReadinessChecker: RuntimeBinaryReadinessChecking {
    let report: RuntimeBinaryReadinessReport
    let blockingError: AppServiceError?

    func evaluateStartupReadiness() -> RuntimeBinaryReadinessReport {
        report
    }

    func startupBlockingError(from _: RuntimeBinaryReadinessReport) -> AppServiceError? {
        blockingError
    }
}

private func readyReadinessChecker() -> StubRuntimeReadinessChecker {
    StubRuntimeReadinessChecker(
        report: RuntimeBinaryReadinessReport(
            checks: [
                RuntimeBinaryReadinessCheck(
                    binaryName: "recordit",
                    overrideEnvKey: RuntimeBinaryResolver.recorditEnvKey,
                    status: .ready,
                    resolvedPath: "/usr/local/bin/recordit",
                    userMessage: "recordit ready",
                    remediation: ""
                ),
                RuntimeBinaryReadinessCheck(
                    binaryName: "sequoia_capture",
                    overrideEnvKey: RuntimeBinaryResolver.sequoiaCaptureEnvKey,
                    status: .ready,
                    resolvedPath: "/usr/local/bin/sequoia_capture",
                    userMessage: "sequoia_capture ready",
                    remediation: ""
                ),
            ]
        ),
        blockingError: nil
    )
}

private func blockedReadinessChecker() -> StubRuntimeReadinessChecker {
    let error = AppServiceError(
        code: .runtimeUnavailable,
        userMessage: "Runtime binaries are unavailable.",
        remediation: "Repair PATH or runtime overrides."
    )
    return StubRuntimeReadinessChecker(
        report: RuntimeBinaryReadinessReport(
            checks: [
                RuntimeBinaryReadinessCheck(
                    binaryName: "recordit",
                    overrideEnvKey: RuntimeBinaryResolver.recorditEnvKey,
                    status: .missing,
                    resolvedPath: nil,
                    userMessage: error.userMessage,
                    remediation: error.remediation
                ),
            ]
        ),
        blockingError: error
    )
}

private actor ScriptedRuntimeService: RuntimeService {
    private let stopError: AppServiceError?
    private(set) var launches: [RuntimeStartRequest] = []
    private(set) var controls: [(Int32, RuntimeControlAction)] = []

    init(stopError: AppServiceError? = nil) {
        self.stopError = stopError
    }

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        launches.append(request)
        return RuntimeLaunchResult(
            processIdentifier: 9000 + Int32(launches.count),
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(processIdentifier: Int32, action: RuntimeControlAction) async throws -> RuntimeControlResult {
        controls.append((processIdentifier, action))
        if let stopError {
            throw stopError
        }
        return RuntimeControlResult(accepted: true, detail: "ok")
    }
}

private struct StaticManifestService: ManifestService {
    let manifest: SessionManifestDTO

    func loadManifest(at _: URL) throws -> SessionManifestDTO {
        manifest
    }
}

private struct StaticModelService: ModelResolutionService {
    func resolveModel(_ request: ModelResolutionRequest) throws -> ResolvedModelDTO {
        _ = request
        return ResolvedModelDTO(
            resolvedPath: URL(fileURLWithPath: "/tmp/model.bin"),
            source: "smoke",
            checksumSHA256: nil,
            checksumStatus: "available"
        )
    }
}

private func manifest(status: String, trustNoticeCount: Int = 0) -> SessionManifestDTO {
    SessionManifestDTO(
        sessionID: "ui-smoke-session",
        status: status,
        runtimeMode: "live",
        trustNoticeCount: trustNoticeCount,
        artifacts: SessionArtifactsDTO(
            wavPath: URL(fileURLWithPath: "/tmp/ui-smoke.wav"),
            jsonlPath: URL(fileURLWithPath: "/tmp/ui-smoke.jsonl"),
            manifestPath: URL(fileURLWithPath: "/tmp/ui-smoke/session.manifest.json")
        )
    )
}

private struct QueryTriggeredFailureSessionLibraryService: SessionLibraryService {
    private let seed: [SessionSummaryDTO]

    init(seed: [SessionSummaryDTO]) {
        self.seed = seed
    }

    func listSessions(query: SessionQuery) throws -> [SessionSummaryDTO] {
        if query.searchText == "trigger_error" {
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Session list temporarily unavailable.",
                remediation: "Retry refresh."
            )
        }
        return seed
    }

    func deleteSession(
        sessionID _: String,
        rootPath _: URL,
        confirmTrash _: Bool
    ) throws -> SessionDeletionResultDTO {
        throw AppServiceError(
            code: .invalidInput,
            userMessage: "Not used in smoke.",
            remediation: "N/A"
        )
    }
}

private final class RecordingExportService: SessionExportService {
    var queuedResults: [Result<SessionExportResult, Error>]
    private(set) var requests: [SessionExportRequest] = []

    init(queuedResults: [Result<SessionExportResult, Error>]) {
        self.queuedResults = queuedResults
    }

    func exportSession(_ request: SessionExportRequest) throws -> SessionExportResult {
        requests.append(request)
        guard !queuedResults.isEmpty else {
            throw AppServiceError(
                code: .unknown,
                userMessage: "No queued export result.",
                remediation: "Add a fixture result before running smoke."
            )
        }
        return try queuedResults.removeFirst().get()
    }
}

private func makeSession(
    id: String,
    startedAt: Date,
    mode: RuntimeMode,
    status: SessionStatus
) -> SessionSummaryDTO {
    SessionSummaryDTO(
        sessionID: id,
        startedAt: startedAt,
        durationMs: 12_000,
        mode: mode,
        status: status,
        rootPath: URL(fileURLWithPath: "/tmp/\(id)", isDirectory: true),
        outcomeClassification: outcomeClassification(for: status)
    )
}

private func outcomeClassification(for status: SessionStatus) -> SessionOutcomeClassification {
    switch status {
    case .pending:
        return .partialArtifact
    case .ok, .degraded:
        return .finalizedSuccess
    case .failed:
        return .finalizedFailure
    }
}

@MainActor
private func runOnboardingJourney() {
    let store = InMemoryOnboardingCompletionStore(completed: false)
    let shell = AppShellViewModel(
        firstRun: nil,
        onboardingCompletionStore: store,
        runtimeReadinessChecker: readyReadinessChecker()
    )
    check(shell.activeRoot == .onboarding, "fresh launch should route to onboarding")

    shell.send(.finishOnboarding)
    check(shell.activeRoot == .mainRuntime, "finishOnboarding should route to main runtime")

    store.markOnboardingComplete()
    let blockedRelaunch = AppShellViewModel(
        firstRun: false,
        onboardingCompletionStore: store,
        runtimeReadinessChecker: blockedReadinessChecker()
    )
    check(blockedRelaunch.activeRoot == .recovery, "returning users with runtime readiness failure should route to recovery")
    check(blockedRelaunch.startupRuntimeReadinessFailure?.code == .runtimeUnavailable, "startup readiness failure should map to runtimeUnavailable")

    blockedRelaunch.send(.back)
    check(blockedRelaunch.activeRoot == .mainRuntime, "back should return from recovery to runtime")
}

@MainActor
private func runRuntimeJourney() async {
    let runtimeService = ScriptedRuntimeService()
    let runtimeVM = RuntimeViewModel(
        runtimeService: runtimeService,
        manifestService: StaticManifestService(manifest: manifest(status: "ok")),
        modelService: StaticModelService()
    )

    await runtimeVM.startLive(outputRoot: URL(fileURLWithPath: "/tmp/ui-smoke"), explicitModelPath: nil)
    guard case .running = runtimeVM.state else {
        check(false, "runtime should reach running state on happy path")
        return
    }

    await runtimeVM.stopCurrentRun()
    check(runtimeVM.state == .completed, "runtime should complete after stop/finalization happy path")
    check(runtimeVM.suggestedRecoveryActions.isEmpty, "happy-path completion should clear recovery actions")

    let interruptedStopService = ScriptedRuntimeService(
        stopError: AppServiceError(
            code: .processExitedUnexpectedly,
            userMessage: "Runtime exited unexpectedly.",
            remediation: "Resume or safe-finalize."
        )
    )
    let interruptedVM = RuntimeViewModel(
        runtimeService: interruptedStopService,
        manifestService: StaticManifestService(manifest: manifest(status: "failed")),
        modelService: StaticModelService()
    )

    await interruptedVM.startLive(outputRoot: URL(fileURLWithPath: "/tmp/ui-smoke-interrupted"), explicitModelPath: nil)
    await interruptedVM.stopCurrentRun()
    guard case let .failed(error) = interruptedVM.state else {
        check(false, "stop failure should transition to failed state")
        return
    }
    check(error.code == .processExitedUnexpectedly, "stop failure should preserve processExitedUnexpectedly")
    check(interruptedVM.suggestedRecoveryActions.contains(.resumeSession), "interrupted runtime should suggest resume")
    check(interruptedVM.suggestedRecoveryActions.contains(.safeFinalize), "interrupted runtime should suggest safe finalize")
    check(interruptedVM.suggestedRecoveryActions.contains(.retryStop), "stop failure should suggest retry stop")
    check(interruptedVM.suggestedRecoveryActions.contains(.openSessionArtifacts), "stop failure should suggest opening artifacts")
}

@MainActor
private func runHistoryJourney() {
    let now = Date(timeIntervalSince1970: 1_730_800_000)
    let sessions = [
        makeSession(id: "sess-a", startedAt: now, mode: .live, status: .ok),
        makeSession(id: "sess-b", startedAt: now.addingTimeInterval(60), mode: .recordOnly, status: .pending),
    ]

    let listVM = SessionListViewModel(sessionLibrary: MockSessionLibraryService(sessions: sessions))
    listVM.refresh()
    guard case let .loaded(items) = listVM.state else {
        check(false, "history happy path should load sessions")
        return
    }
    check(items.count == 2, "history list should include expected sessions")

    listVM.setSearchText("missing")
    guard case .empty = listVM.state else {
        check(false, "history search miss should render empty state")
        return
    }

    let failingVM = SessionListViewModel(
        sessionLibrary: QueryTriggeredFailureSessionLibraryService(seed: [sessions[0]])
    )
    failingVM.refresh()
    failingVM.setSearchText("trigger_error")
    guard case let .failed(error, recoverableItems) = failingVM.state else {
        check(false, "history failure path should enter failed state")
        return
    }
    check(error.code == .ioFailure, "history failure should preserve ioFailure code")
    check(recoverableItems.map(\.sessionID) == ["sess-a"], "history failure should preserve recoverable prior items")
}

@MainActor
private func runExportJourney() {
    let exportService = RecordingExportService(
        queuedResults: [
            .success(
                SessionExportResult(
                    kind: .diagnostics,
                    outputURL: URL(fileURLWithPath: "/tmp/ui-smoke-export.zip"),
                    exportedAt: Date(),
                    includedArtifacts: [],
                    redacted: false
                )
            ),
            .failure(
                AppServiceError(
                    code: .permissionDenied,
                    userMessage: "Destination is not writable.",
                    remediation: "Choose a writable folder."
                )
            ),
        ]
    )

    let exportVM = SessionExportViewModel(exportService: exportService)
    exportVM.setExportKind(.diagnostics)
    exportVM.setDiagnosticsIncludeTranscriptText(true)
    exportVM.runExport(
        sessionID: "sess-a",
        sessionRoot: URL(fileURLWithPath: "/tmp/sess-a"),
        outputDirectory: URL(fileURLWithPath: "/tmp/exports")
    )

    check(exportVM.completionMessage == "Diagnostics exported with transcript text.", "export happy path should surface diagnostics success message")
    check(exportService.requests.first?.includeTranscriptTextInDiagnostics == true, "diagnostics opt-in should pass through request")

    exportVM.setExportKind(.transcript)
    exportVM.runExport(
        sessionID: "sess-a",
        sessionRoot: URL(fileURLWithPath: "/tmp/sess-a"),
        outputDirectory: URL(fileURLWithPath: "/tmp/exports")
    )

    guard case let .failed(error) = exportVM.state else {
        check(false, "export permission failure should transition to failed state")
        return
    }
    check(error.code == .permissionDenied, "export failure should preserve permissionDenied code")
    check(exportVM.errorMessage == "Destination is not writable.", "export failure should surface user-facing error")
}

@main
struct UIAutomationSmokeMain {
    static func main() async {
        await runRuntimeJourney()
        runOnboardingJourney()
        runHistoryJourney()
        runExportJourney()
        print("ui_automation_smoke: PASS")
    }
}
