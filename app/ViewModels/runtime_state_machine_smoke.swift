import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("runtime_state_machine_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private actor DelayingRuntimeService: RuntimeService {
    private let startDelayNanoseconds: UInt64
    private(set) var startInvocations = 0
    private(set) var stopInvocations = 0

    init(startDelayNanoseconds: UInt64) {
        self.startDelayNanoseconds = startDelayNanoseconds
    }

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        startInvocations += 1
        try await Task.sleep(nanoseconds: startDelayNanoseconds)
        return RuntimeLaunchResult(
            processIdentifier: 7000 + Int32(startInvocations),
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(processIdentifier _: Int32, action _: RuntimeControlAction) async throws -> RuntimeControlResult {
        stopInvocations += 1
        return RuntimeControlResult(accepted: true, detail: "stopped")
    }

    func startInvocationCount() -> Int {
        startInvocations
    }

    func stopInvocationCount() -> Int {
        stopInvocations
    }
}

private struct StaticManifestService: ManifestService {
    var manifest: SessionManifestDTO

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

private func fixtureManifest(status: String, trustNoticeCount: Int = 0) -> SessionManifestDTO {
    SessionManifestDTO(
        sessionID: "smoke-session",
        status: status,
        runtimeMode: "live",
        trustNoticeCount: trustNoticeCount,
        artifacts: SessionArtifactsDTO(
            wavPath: URL(fileURLWithPath: "/tmp/smoke.wav"),
            jsonlPath: URL(fileURLWithPath: "/tmp/smoke.jsonl"),
            manifestPath: URL(fileURLWithPath: "/tmp/smoke.manifest.json")
        )
    )
}

@MainActor
private func assertStateIsRunning(_ viewModel: RuntimeViewModel, message: String) {
    guard case .running = viewModel.state else {
        check(false, message)
        return
    }
}

@MainActor
private func assertStateIsPreparing(_ viewModel: RuntimeViewModel, message: String) {
    guard case .preparing = viewModel.state else {
        check(false, message)
        return
    }
}

@MainActor
private func runSmoke() async {
    let runtimeService = DelayingRuntimeService(startDelayNanoseconds: 250_000_000)
    let viewModel = RuntimeViewModel(
        runtimeService: runtimeService,
        manifestService: StaticManifestService(manifest: fixtureManifest(status: "ok")),
        modelService: StaticModelService()
    )

    await viewModel.stopCurrentRun()
    check(viewModel.lastRejectedActionError?.code == .invalidInput, "idle stop should be rejected")
    check(viewModel.state == .idle, "idle stop rejection should not mutate state")

    let firstStart = Task { await viewModel.startLive(outputRoot: URL(fileURLWithPath: "/tmp/a"), explicitModelPath: nil) }
    try? await Task.sleep(nanoseconds: 20_000_000)
    await viewModel.startLive(outputRoot: URL(fileURLWithPath: "/tmp/b"), explicitModelPath: nil)
    assertStateIsPreparing(viewModel, message: "second start should not override active prepare state")
    check(viewModel.lastRejectedActionError?.code == .invalidInput, "concurrent start should be rejected")

    await firstStart.value
    assertStateIsRunning(viewModel, message: "first launch should eventually transition to running")
    let startCount = await runtimeService.startInvocationCount()
    check(startCount == 1, "only one launch should be executed")

    await viewModel.stopCurrentRun()
    check(viewModel.state == .finalizing, "successful stop should transition to finalizing")
    let stopCount = await runtimeService.stopInvocationCount()
    check(stopCount == 1, "exactly one stop control should run")

    await viewModel.stopCurrentRun()
    check(viewModel.lastRejectedActionError?.code == .invalidInput, "stop during finalizing should be rejected")
    check(viewModel.state == .finalizing, "rejected stop should preserve finalizing state")

    viewModel.loadFinalStatus(manifestPath: URL(fileURLWithPath: "/tmp/smoke.manifest.json"))
    check(viewModel.state == .completed, "final status load should transition finalizing to completed")
    check(viewModel.lastRejectedActionError == nil, "successful finalization should clear rejection state")

    let preparingOnlyRuntime = DelayingRuntimeService(startDelayNanoseconds: 250_000_000)
    let preparingViewModel = RuntimeViewModel(
        runtimeService: preparingOnlyRuntime,
        manifestService: StaticManifestService(manifest: fixtureManifest(status: "ok")),
        modelService: StaticModelService()
    )
    let preparingStart = Task {
        await preparingViewModel.startLive(outputRoot: URL(fileURLWithPath: "/tmp/c"), explicitModelPath: nil)
    }
    try? await Task.sleep(nanoseconds: 20_000_000)
    preparingViewModel.loadFinalStatus(manifestPath: URL(fileURLWithPath: "/tmp/should-not-load.manifest.json"))
    assertStateIsPreparing(preparingViewModel, message: "final-status load during prepare should be rejected")
    check(preparingViewModel.lastRejectedActionError?.code == .invalidInput, "prepare-time final load should reject with invalidInput")
    await preparingStart.value
}

@main
struct RuntimeStateMachineSmokeMain {
    static func main() async {
        await runSmoke()
        print("runtime_state_machine_smoke: PASS")
    }
}
