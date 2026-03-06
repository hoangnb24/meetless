import Foundation

private enum LifecycleIntegrationSmokeError: Error {
    case assertionFailed(String)
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw LifecycleIntegrationSmokeError.assertionFailed(message)
    }
}

private actor LiveRuntimeService: RuntimeService {
    enum StopBehavior {
        case success
        case throwError(AppServiceError)
    }

    private let stopBehavior: StopBehavior

    init(stopBehavior: StopBehavior) {
        self.stopBehavior = stopBehavior
    }

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        RuntimeLaunchResult(
            processIdentifier: 4400,
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(processIdentifier _: Int32, action _: RuntimeControlAction) async throws -> RuntimeControlResult {
        switch stopBehavior {
        case .success:
            return RuntimeControlResult(accepted: true, detail: "stopped")
        case let .throwError(error):
            throw error
        }
    }
}

private struct StaticModelService: ModelResolutionService {
    func resolveModel(_ request: ModelResolutionRequest) throws -> ResolvedModelDTO {
        _ = request
        return ResolvedModelDTO(
            resolvedPath: URL(fileURLWithPath: "/tmp/model.bin"),
            source: "integration-smoke",
            checksumSHA256: nil,
            checksumStatus: "available"
        )
    }
}

private struct StaticManifestService: ManifestService {
    let manifest: SessionManifestDTO

    func loadManifest(at _: URL) throws -> SessionManifestDTO {
        manifest
    }
}

private struct AlwaysMissingManifestService: ManifestService {
    func loadManifest(at _: URL) throws -> SessionManifestDTO {
        throw AppServiceError(
            code: .artifactMissing,
            userMessage: "manifest missing",
            remediation: "retry"
        )
    }
}

private func makeManifest(status: String, trustNoticeCount: Int = 0) -> SessionManifestDTO {
    SessionManifestDTO(
        sessionID: "integration-live",
        status: status,
        runtimeMode: "live",
        trustNoticeCount: trustNoticeCount,
        artifacts: SessionArtifactsDTO(
            wavPath: URL(fileURLWithPath: "/tmp/integration-live.wav"),
            jsonlPath: URL(fileURLWithPath: "/tmp/integration-live.jsonl"),
            manifestPath: URL(fileURLWithPath: "/tmp/integration-live/session.manifest.json")
        )
    )
}

@MainActor
private func runLiveLifecycleScenarios() async throws {
    let modelService = StaticModelService()

    let liveSuccess = RuntimeViewModel(
        runtimeService: LiveRuntimeService(stopBehavior: .success),
        manifestService: StaticManifestService(manifest: makeManifest(status: "ok")),
        modelService: modelService,
        finalizationTimeoutSeconds: 1,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    await liveSuccess.startLive(outputRoot: URL(fileURLWithPath: "/tmp/live-success"), explicitModelPath: nil)
    await liveSuccess.stopCurrentRun()
    try require(liveSuccess.state == .completed, "live success should complete after bounded finalization")

    let liveInterrupted = RuntimeViewModel(
        runtimeService: LiveRuntimeService(
            stopBehavior: .throwError(
                AppServiceError(
                    code: .processExitedUnexpectedly,
                    userMessage: "runtime interrupted",
                    remediation: "resume"
                )
            )
        ),
        manifestService: StaticManifestService(manifest: makeManifest(status: "ok")),
        modelService: modelService,
        finalizationTimeoutSeconds: 1,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    await liveInterrupted.startLive(outputRoot: URL(fileURLWithPath: "/tmp/live-interrupted"), explicitModelPath: nil)
    await liveInterrupted.stopCurrentRun()
    guard case let .failed(interruptedError) = liveInterrupted.state else {
        throw LifecycleIntegrationSmokeError.assertionFailed("live interruption should transition to failed")
    }
    try require(interruptedError.code == .processExitedUnexpectedly, "live interruption should preserve processExitedUnexpectedly")
    try require(liveInterrupted.suggestedRecoveryActions.contains(.resumeSession), "live interruption should suggest resume")
    try require(liveInterrupted.suggestedRecoveryActions.contains(.safeFinalize), "live interruption should suggest safe finalize")
    try require(liveInterrupted.suggestedRecoveryActions.contains(.retryStop), "live interruption should suggest retry stop")

    let liveTimeout = RuntimeViewModel(
        runtimeService: LiveRuntimeService(stopBehavior: .success),
        manifestService: AlwaysMissingManifestService(),
        modelService: modelService,
        finalizationTimeoutSeconds: 0.12,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    await liveTimeout.startLive(outputRoot: URL(fileURLWithPath: "/tmp/live-timeout"), explicitModelPath: nil)
    await liveTimeout.stopCurrentRun()
    guard case let .failed(timeoutError) = liveTimeout.state else {
        throw LifecycleIntegrationSmokeError.assertionFailed("live timeout should transition to failed")
    }
    try require(timeoutError.code == .timeout, "live timeout should map to timeout error")
    try require(liveTimeout.suggestedRecoveryActions.contains(.retryFinalize), "live timeout should suggest retry finalize")

    let liveFailedManifest = RuntimeViewModel(
        runtimeService: LiveRuntimeService(stopBehavior: .success),
        manifestService: StaticManifestService(manifest: makeManifest(status: "failed")),
        modelService: modelService,
        finalizationTimeoutSeconds: 1,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    await liveFailedManifest.startLive(outputRoot: URL(fileURLWithPath: "/tmp/live-failed-manifest"), explicitModelPath: nil)
    await liveFailedManifest.stopCurrentRun()
    guard case let .failed(failedManifestError) = liveFailedManifest.state else {
        throw LifecycleIntegrationSmokeError.assertionFailed("failed manifest should transition to failed")
    }
    try require(
        failedManifestError.code == .processExitedUnexpectedly,
        "failed live manifest should map to processExitedUnexpectedly"
    )
}

private actor DeferredRuntimeService: RuntimeService {
    enum Behavior {
        case writeManifest(status: String)
        case noManifest
        case throwLaunch(AppServiceError)
    }

    private let behavior: Behavior

    init(behavior: Behavior) {
        self.behavior = behavior
    }

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        switch behavior {
        case let .writeManifest(status):
            let manifestURL = request.outputRoot.appendingPathComponent("session.manifest.json")
            let payload: [String: Any] = [
                "session_id": request.outputRoot.lastPathComponent,
                "session_summary": [
                    "session_status": status,
                ],
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            try data.write(to: manifestURL, options: .atomic)
        case .noManifest:
            break
        case let .throwLaunch(error):
            throw error
        }

        return RuntimeLaunchResult(
            processIdentifier: 5500,
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(processIdentifier _: Int32, action _: RuntimeControlAction) async throws -> RuntimeControlResult {
        RuntimeControlResult(accepted: true, detail: "not used")
    }
}

private func writeReadyPendingSidecar(
    at sessionRoot: URL,
    sidecarService: FileSystemPendingSessionSidecarService
) throws -> SessionSummaryDTO {
    try FileManager.default.createDirectory(at: sessionRoot, withIntermediateDirectories: true)
    let wavURL = sessionRoot.appendingPathComponent("session.wav")
    try Data("wav".utf8).write(to: wavURL)
    _ = try sidecarService.writePendingSidecar(
        PendingSessionSidecarWriteRequest(
            sessionID: sessionRoot.lastPathComponent,
            sessionRoot: sessionRoot,
            wavPath: wavURL,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            mode: .recordOnly,
            transcriptionState: .readyToTranscribe
        )
    )

    return SessionSummaryDTO(
        sessionID: sessionRoot.lastPathComponent,
        startedAt: Date(timeIntervalSince1970: 1_700_000_000),
        durationMs: 0,
        mode: .recordOnly,
        status: .pending,
        rootPath: sessionRoot,
        pendingTranscriptionState: .readyToTranscribe,
        readyToTranscribe: true,
        outcomeClassification: .partialArtifact
    )
}

private func pendingSidecarPath(_ sessionRoot: URL) -> URL {
    sessionRoot.appendingPathComponent("session.pending.json")
}

private func retryContextPath(_ sessionRoot: URL) -> URL {
    sessionRoot.appendingPathComponent("session.pending.retry.json")
}

private func runRecordOnlyLifecycleScenarios(tempRoot: URL) async throws {
    let sidecarService = FileSystemPendingSessionSidecarService()

    let successRoot = tempRoot.appendingPathComponent("record-only-success", isDirectory: true)
    let successSummary = try writeReadyPendingSidecar(at: successRoot, sidecarService: sidecarService)
    let successPipeline = PendingSessionTranscriptionService(
        runtimeService: DeferredRuntimeService(behavior: .writeManifest(status: "ok")),
        pendingSidecarService: sidecarService,
        pollIntervalNanoseconds: 10_000_000
    )

    let successResult = try await successPipeline.transcribePendingSession(summary: successSummary, timeoutSeconds: 5)
    try require(successResult.finalState == .completed, "record-only success should complete")
    try require(
        !FileManager.default.fileExists(atPath: pendingSidecarPath(successRoot).path),
        "record-only success should remove pending sidecar"
    )

    let launchFailureRoot = tempRoot.appendingPathComponent("record-only-launch-failure", isDirectory: true)
    let launchFailureSummary = try writeReadyPendingSidecar(at: launchFailureRoot, sidecarService: sidecarService)
    let launchFailurePipeline = PendingSessionTranscriptionService(
        runtimeService: DeferredRuntimeService(
            behavior: .throwLaunch(
                AppServiceError(
                    code: .processLaunchFailed,
                    userMessage: "launch failed",
                    remediation: "retry"
                )
            )
        ),
        pendingSidecarService: sidecarService,
        pollIntervalNanoseconds: 10_000_000
    )

    do {
        _ = try await launchFailurePipeline.transcribePendingSession(summary: launchFailureSummary, timeoutSeconds: 5)
        throw LifecycleIntegrationSmokeError.assertionFailed("record-only launch failure should throw")
    } catch let error as AppServiceError {
        try require(error.code == .processLaunchFailed, "launch failure should preserve processLaunchFailed code")
    }

    let launchFailedSidecar = try sidecarService.loadPendingSidecar(at: pendingSidecarPath(launchFailureRoot))
    try require(launchFailedSidecar.transcriptionState == .failed, "launch failure should persist failed sidecar state")
    try require(
        FileManager.default.fileExists(atPath: retryContextPath(launchFailureRoot).path),
        "launch failure should persist retry context"
    )

    let timeoutRoot = tempRoot.appendingPathComponent("record-only-timeout", isDirectory: true)
    let timeoutSummary = try writeReadyPendingSidecar(at: timeoutRoot, sidecarService: sidecarService)
    let timeoutPipeline = PendingSessionTranscriptionService(
        runtimeService: DeferredRuntimeService(behavior: .noManifest),
        pendingSidecarService: sidecarService,
        pollIntervalNanoseconds: 10_000_000
    )

    do {
        _ = try await timeoutPipeline.transcribePendingSession(summary: timeoutSummary, timeoutSeconds: 1)
        throw LifecycleIntegrationSmokeError.assertionFailed("record-only timeout should throw")
    } catch let error as AppServiceError {
        try require(error.code == .timeout, "record-only timeout should map to timeout")
    }

    let timeoutSidecar = try sidecarService.loadPendingSidecar(at: pendingSidecarPath(timeoutRoot))
    try require(timeoutSidecar.transcriptionState == .failed, "record-only timeout should persist failed sidecar state")
    try require(
        FileManager.default.fileExists(atPath: retryContextPath(timeoutRoot).path),
        "record-only timeout should persist retry context"
    )

    let failedManifestRoot = tempRoot.appendingPathComponent("record-only-failed-manifest", isDirectory: true)
    let failedManifestSummary = try writeReadyPendingSidecar(at: failedManifestRoot, sidecarService: sidecarService)
    let failedManifestPipeline = PendingSessionTranscriptionService(
        runtimeService: DeferredRuntimeService(behavior: .writeManifest(status: "failed")),
        pendingSidecarService: sidecarService,
        pollIntervalNanoseconds: 10_000_000
    )

    do {
        _ = try await failedManifestPipeline.transcribePendingSession(summary: failedManifestSummary, timeoutSeconds: 5)
        throw LifecycleIntegrationSmokeError.assertionFailed("record-only failed manifest should throw")
    } catch let error as AppServiceError {
        try require(
            error.code == .processExitedUnexpectedly,
            "record-only failed manifest should map to processExitedUnexpectedly"
        )
    }

    let failedManifestSidecar = try sidecarService.loadPendingSidecar(at: pendingSidecarPath(failedManifestRoot))
    try require(
        failedManifestSidecar.transcriptionState == .failed,
        "record-only failed manifest should persist failed sidecar state"
    )
}

@main
struct ProcessLifecycleIntegrationSmokeMain {
    static func main() async throws {
        try await runLiveLifecycleScenarios()

        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("process-lifecycle-integration-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        try await runRecordOnlyLifecycleScenarios(tempRoot: tempRoot)

        print("process_lifecycle_integration_smoke: PASS")
    }
}
