import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("runtime_stop_finalization_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private actor StubRuntimeService: RuntimeService {
    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        RuntimeLaunchResult(
            processIdentifier: 4242,
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(processIdentifier _: Int32, action _: RuntimeControlAction) async throws -> RuntimeControlResult {
        RuntimeControlResult(accepted: true, detail: "stopped")
    }
}

private actor CrashOnStopRuntimeService: RuntimeService {
    private(set) var startInvocations = 0

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        startInvocations += 1
        return RuntimeLaunchResult(
            processIdentifier: 5000 + Int32(startInvocations),
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(processIdentifier _: Int32, action _: RuntimeControlAction) async throws -> RuntimeControlResult {
        throw AppServiceError(
            code: .processExitedUnexpectedly,
            userMessage: "Session was interrupted unexpectedly.",
            remediation: "Use Resume or Safe Finalize to preserve captured artifacts."
        )
    }

    func startCount() -> Int {
        startInvocations
    }
}

private actor FlakyStopRuntimeService: RuntimeService {
    private(set) var stopAttempts = 0

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        RuntimeLaunchResult(
            processIdentifier: 6100,
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(processIdentifier _: Int32, action _: RuntimeControlAction) async throws -> RuntimeControlResult {
        stopAttempts += 1
        if stopAttempts == 1 {
            throw AppServiceError(
                code: .processExitedUnexpectedly,
                userMessage: "Stop handshake failed.",
                remediation: "Retry Stop after the runtime settles."
            )
        }
        return RuntimeControlResult(accepted: true, detail: "stopped")
    }
}

private final class MutableManifestService: ManifestService, @unchecked Sendable {
    private let lock = NSLock()
    private var manifest: SessionManifestDTO?

    func loadManifest(at _: URL) throws -> SessionManifestDTO {
        lock.lock()
        defer { lock.unlock() }
        guard let manifest else {
            throw AppServiceError(
                code: .artifactMissing,
                userMessage: "manifest missing",
                remediation: "retry"
            )
        }
        return manifest
    }

    func setManifest(_ manifest: SessionManifestDTO) {
        lock.lock()
        self.manifest = manifest
        lock.unlock()
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

private struct DelayThenSuccessManifestService: ManifestService {
    private let startTime: Date
    private let readyAfterSeconds: TimeInterval
    private let manifest: SessionManifestDTO

    init(readyAfterSeconds: TimeInterval, manifest: SessionManifestDTO) {
        startTime = Date()
        self.readyAfterSeconds = readyAfterSeconds
        self.manifest = manifest
    }

    func loadManifest(at _: URL) throws -> SessionManifestDTO {
        if Date().timeIntervalSince(startTime) < readyAfterSeconds {
            throw AppServiceError(
                code: .artifactMissing,
                userMessage: "manifest not ready",
                remediation: "retry"
            )
        }
        return manifest
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

private struct FailedManifestService: ManifestService {
    let manifest: SessionManifestDTO

    func loadManifest(at _: URL) throws -> SessionManifestDTO {
        manifest
    }
}

private func makeManifest(status: String, trustNoticeCount: Int = 0) -> SessionManifestDTO {
    SessionManifestDTO(
        sessionID: "stop-smoke",
        status: status,
        runtimeMode: "live",
        trustNoticeCount: trustNoticeCount,
        artifacts: SessionArtifactsDTO(
            wavPath: URL(fileURLWithPath: "/tmp/stop-smoke.wav"),
            jsonlPath: URL(fileURLWithPath: "/tmp/stop-smoke.jsonl"),
            manifestPath: URL(fileURLWithPath: "/tmp/stop-smoke.manifest.json")
        )
    )
}

@MainActor
private func runSmoke() async {
    let runtime = StubRuntimeService()
    let model = StaticModelService()
    let tempRoot = FileManager.default.temporaryDirectory.appendingPathComponent("runtime-stop-finalization-smoke-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.removeItem(at: tempRoot)
    try? FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempRoot) }

    let eventuallySuccess = RuntimeViewModel(
        runtimeService: runtime,
        manifestService: DelayThenSuccessManifestService(
            readyAfterSeconds: 0.03,
            manifest: makeManifest(status: "ok")
        ),
        modelService: model,
        finalizationTimeoutSeconds: 1,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    await eventuallySuccess.startLive(outputRoot: tempRoot.appendingPathComponent("finalize-success", isDirectory: true), explicitModelPath: nil)
    await eventuallySuccess.stopCurrentRun()
    check(eventuallySuccess.state == .completed, "bounded finalization should complete once manifest appears")
    check(eventuallySuccess.suggestedRecoveryActions.isEmpty, "successful bounded finalization should not suggest recovery actions")

    let timeoutFailure = RuntimeViewModel(
        runtimeService: runtime,
        manifestService: AlwaysMissingManifestService(),
        modelService: model,
        finalizationTimeoutSeconds: 0.12,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    await timeoutFailure.startLive(outputRoot: tempRoot.appendingPathComponent("finalize-timeout", isDirectory: true), explicitModelPath: nil)
    await timeoutFailure.stopCurrentRun()
    guard case .failed(let timeoutError) = timeoutFailure.state else {
        check(false, "missing manifest should end in failed timeout state")
        return
    }
    check(timeoutError.code == .timeout, "missing manifest should map to timeout failure")
    check(timeoutFailure.suggestedRecoveryActions == [.startNewSession], "empty-session timeout should only suggest starting a new session")
    guard let timeoutContext = timeoutFailure.interruptionRecoveryContext else {
        check(false, "timeout failure should surface empty-session context")
        return
    }
    check(timeoutContext.classification == .emptySessionFailure, "timeout without artifacts should classify as empty session")

    let failedManifest = RuntimeViewModel(
        runtimeService: runtime,
        manifestService: FailedManifestService(manifest: makeManifest(status: "failed")),
        modelService: model,
        finalizationTimeoutSeconds: 1,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    await failedManifest.startLive(outputRoot: tempRoot.appendingPathComponent("finalize-failed", isDirectory: true), explicitModelPath: nil)
    await failedManifest.stopCurrentRun()
    guard case .failed(let failedError) = failedManifest.state else {
        check(false, "failed manifest should map to failed state")
        return
    }
    check(failedError.code == .processExitedUnexpectedly, "failed manifest should map to processExitedUnexpectedly")
    check(failedManifest.suggestedRecoveryActions == [.openSessionArtifacts, .startNewSession], "finalized failed manifest should not advertise resume or safe finalize")
    guard let failedContext = failedManifest.interruptionRecoveryContext else {
        check(false, "failed manifest should surface finalized failure context")
        return
    }
    check(failedContext.classification == .finalizedFailure, "failed manifest should classify as finalized failure")

    let retryFinalizeManifestService = MutableManifestService()
    let retryFinalizeRuntime = StubRuntimeService()
    let retryFinalizeRecovery = RuntimeViewModel(
        runtimeService: retryFinalizeRuntime,
        manifestService: retryFinalizeManifestService,
        modelService: model,
        finalizationTimeoutSeconds: 0.12,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    let retryFinalizeRoot = tempRoot.appendingPathComponent("retry-finalize", isDirectory: true)
    try? FileManager.default.createDirectory(at: retryFinalizeRoot, withIntermediateDirectories: true)
    try? "partial transcript".write(to: retryFinalizeRoot.appendingPathComponent("session.jsonl"), atomically: true, encoding: .utf8)
    await retryFinalizeRecovery.startLive(outputRoot: retryFinalizeRoot, explicitModelPath: nil)
    await retryFinalizeRecovery.stopCurrentRun()
    guard case let .failed(retryFinalizeError) = retryFinalizeRecovery.state else {
        check(false, "partial-artifact timeout should enter failed state before retry finalize")
        return
    }
    check(retryFinalizeError.code == .timeout, "partial-artifact timeout should still map to timeout")
    check(retryFinalizeRecovery.suggestedRecoveryActions.contains(.retryFinalize), "partial-artifact timeout should advertise retry finalize")
    retryFinalizeManifestService.setManifest(makeManifest(status: "ok"))
    retryFinalizeRecovery.retryFinalizeAfterFailure()
    check(retryFinalizeRecovery.state == .completed, "retry finalize should reload the manifest and complete")

    let retryStopManifestService = MutableManifestService()
    let retryStopRuntime = FlakyStopRuntimeService()
    let retryStopRecovery = RuntimeViewModel(
        runtimeService: retryStopRuntime,
        manifestService: retryStopManifestService,
        modelService: model,
        finalizationTimeoutSeconds: 1,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    let retryStopRoot = tempRoot.appendingPathComponent("retry-stop", isDirectory: true)
    try? FileManager.default.createDirectory(at: retryStopRoot, withIntermediateDirectories: true)
    try? "partial transcript".write(to: retryStopRoot.appendingPathComponent("session.jsonl"), atomically: true, encoding: .utf8)
    await retryStopRecovery.startLive(outputRoot: retryStopRoot, explicitModelPath: nil)
    await retryStopRecovery.stopCurrentRun()
    guard case let .failed(retryStopError) = retryStopRecovery.state else {
        check(false, "failed stop should enter failed state before retry stop")
        return
    }
    check(retryStopError.code == .processExitedUnexpectedly, "failed stop should preserve interruption error code")
    check(retryStopRecovery.suggestedRecoveryActions.contains(.retryStop), "failed stop should advertise retry stop")
    retryStopManifestService.setManifest(makeManifest(status: "ok"))
    await retryStopRecovery.retryStopAfterFailure()
    check(retryStopRecovery.state == .completed, "retry stop should stop the preserved process and finalize")

    let emptyInterruptionRuntime = CrashOnStopRuntimeService()
    let emptyInterruptionRecovery = RuntimeViewModel(
        runtimeService: emptyInterruptionRuntime,
        manifestService: FailedManifestService(manifest: makeManifest(status: "ok")),
        modelService: model,
        finalizationTimeoutSeconds: 1,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    let emptyInterruptionRoot = tempRoot.appendingPathComponent("interrupted-empty", isDirectory: true)
    try? FileManager.default.createDirectory(at: emptyInterruptionRoot, withIntermediateDirectories: true)
    await emptyInterruptionRecovery.startLive(outputRoot: emptyInterruptionRoot, explicitModelPath: nil)
    await emptyInterruptionRecovery.stopCurrentRun()
    guard case let .failed(emptyInterruptionError) = emptyInterruptionRecovery.state else {
        check(false, "artifact-free interruption should map to failed state")
        return
    }
    check(emptyInterruptionError.code == .processExitedUnexpectedly, "artifact-free interruption should classify as processExitedUnexpectedly")
    check(emptyInterruptionRecovery.suggestedRecoveryActions == [.startNewSession], "artifact-free interruption should not suggest resume or safe finalize")
    guard let emptyContext = emptyInterruptionRecovery.interruptionRecoveryContext else {
        check(false, "artifact-free interruption should surface empty-session context")
        return
    }
    check(emptyContext.classification == .emptySessionFailure, "artifact-free interruption should classify as empty session")
    check(!emptyContext.actions.contains(.resumeSession), "empty-session interruption should not offer resume")
    check(!emptyContext.actions.contains(.safeFinalize), "empty-session interruption should not offer safe finalize")
    check(!emptyContext.actions.contains(.retryStop), "empty-session interruption should not offer retry stop")

    let interruptionRuntime = CrashOnStopRuntimeService()
    let interruptionRecovery = RuntimeViewModel(
        runtimeService: interruptionRuntime,
        manifestService: FailedManifestService(manifest: makeManifest(status: "ok")),
        modelService: model,
        finalizationTimeoutSeconds: 1,
        finalizationPollIntervalNanoseconds: 10_000_000
    )
    let interruptionRoot = tempRoot.appendingPathComponent("interrupted", isDirectory: true)
    try? FileManager.default.createDirectory(at: interruptionRoot, withIntermediateDirectories: true)
    await interruptionRecovery.startLive(outputRoot: interruptionRoot, explicitModelPath: nil)
    try? "partial transcript".write(to: interruptionRoot.appendingPathComponent("session.jsonl"), atomically: true, encoding: .utf8)
    await interruptionRecovery.stopCurrentRun()
    guard case let .failed(interruptionError) = interruptionRecovery.state else {
        check(false, "interrupted stop should map to failed state")
        return
    }
    check(interruptionError.code == .processExitedUnexpectedly, "interruption failure should classify as processExitedUnexpectedly")
    check(
        interruptionRecovery.suggestedRecoveryActions == [.resumeSession, .safeFinalize, .retryStop, .openSessionArtifacts, .startNewSession],
        "partial-artifact interruption should offer resume/safe-finalize recovery actions"
    )
    guard let context = interruptionRecovery.interruptionRecoveryContext else {
        check(false, "interruption failure should surface recoverable interruption context")
        return
    }
    check(context.classification == .partialArtifactFailure, "interruption with partial artifacts should classify separately")
    check(context.sessionRoot.path == interruptionRoot.path, "interruption context should keep active session root")
    check(context.actions.contains(.resumeSession), "context should include resume action")
    check(context.actions.contains(.safeFinalize), "context should include safe finalize action")
    check(context.guidance.contains("Resume"), "guidance should explain resume action")
    check(context.guidance.contains("Safe Finalize"), "guidance should explain safe finalize action")

    await interruptionRecovery.resumeInterruptedSession()
    guard case .running = interruptionRecovery.state else {
        check(false, "resume action should restart session in interrupted root")
        return
    }
    let resumedStartCount = await interruptionRuntime.startCount()
    check(resumedStartCount == 2, "resume action should launch a second runtime session")

    await interruptionRecovery.stopCurrentRun()
    guard case .failed = interruptionRecovery.state else {
        check(false, "second interrupted stop should return to failed state")
        return
    }
    interruptionRecovery.safeFinalizeInterruptedSession()
    check(interruptionRecovery.state == .completed, "safe finalize should complete via manifest final status load")
    check(interruptionRecovery.interruptionRecoveryContext == nil, "successful safe finalize should clear interruption context")
}

@main
struct RuntimeStopFinalizationSmokeMain {
    static func main() async {
        await runSmoke()
        print("runtime_stop_finalization_smoke: PASS")
    }
}
