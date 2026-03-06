import Foundation

private enum PendingQueueIntegrationSmokeError: Error {
    case assertionFailed(String)
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw PendingQueueIntegrationSmokeError.assertionFailed(message)
    }
}

private actor InspectingRuntimeService: RuntimeService {
    enum Behavior {
        case writeManifest(status: String)
    }

    private let behavior: Behavior
    private let pendingSidecarPath: URL
    private let sidecarService = FileSystemPendingSessionSidecarService()
    private var observedTranscribing = false

    init(behavior: Behavior, pendingSidecarPath: URL) {
        self.behavior = behavior
        self.pendingSidecarPath = pendingSidecarPath
    }

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        if let sidecar = try? sidecarService.loadPendingSidecar(at: pendingSidecarPath) {
            observedTranscribing = sidecar.transcriptionState == .transcribing
        }

        switch behavior {
        case .writeManifest(let status):
            let manifestURL = request.outputRoot.appendingPathComponent("session.manifest.json")
            let payload: [String: Any] = [
                "session_id": request.outputRoot.lastPathComponent,
                "session_summary": [
                    "session_status": status
                ]
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            try data.write(to: manifestURL, options: .atomic)
        }

        return RuntimeLaunchResult(
            processIdentifier: 31337,
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(
        processIdentifier: Int32,
        action: RuntimeControlAction
    ) async throws -> RuntimeControlResult {
        RuntimeControlResult(accepted: true, detail: "not used")
    }

    func sawTranscribingState() -> Bool {
        observedTranscribing
    }
}

private func writePendingSidecar(
    service: FileSystemPendingSessionSidecarService,
    sessionRoot: URL,
    state: PendingTranscriptionState
) throws {
    let wavPath = sessionRoot.appendingPathComponent("session.wav")
    if !FileManager.default.fileExists(atPath: wavPath.path) {
        try Data("wav".utf8).write(to: wavPath)
    }
    _ = try service.writePendingSidecar(
        PendingSessionSidecarWriteRequest(
            sessionID: sessionRoot.lastPathComponent,
            sessionRoot: sessionRoot,
            wavPath: wavPath,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            mode: .recordOnly,
            transcriptionState: state
        )
    )
}

private func pendingSummary(sessionRoot: URL, state: PendingTranscriptionState) -> SessionSummaryDTO {
    SessionSummaryDTO(
        sessionID: sessionRoot.lastPathComponent,
        startedAt: Date(timeIntervalSince1970: 1_700_000_000),
        durationMs: 0,
        mode: .recordOnly,
        status: .pending,
        rootPath: sessionRoot,
        pendingTranscriptionState: state,
        readyToTranscribe: state == .readyToTranscribe,
        outcomeClassification: .partialArtifact
    )
}

private func testSuccessfulPromotion(tempRoot: URL) async throws {
    let fileManager = FileManager.default
    let sidecarService = FileSystemPendingSessionSidecarService()
    let transitionService = PendingSessionTransitionService()
    let sessionRoot = tempRoot.appendingPathComponent("success", isDirectory: true)
    try fileManager.createDirectory(at: sessionRoot, withIntermediateDirectories: true)

    try writePendingSidecar(
        service: sidecarService,
        sessionRoot: sessionRoot,
        state: .pendingModel
    )

    let readyState = try transitionService.reconcileReadiness(
        current: .pendingModel,
        modelAvailable: true
    )
    try require(readyState == .readyToTranscribe, "pending_model should reconcile to ready_to_transcribe")
    try writePendingSidecar(
        service: sidecarService,
        sessionRoot: sessionRoot,
        state: readyState
    )

    let pendingPath = sessionRoot.appendingPathComponent("session.pending.json")
    let runtime = InspectingRuntimeService(
        behavior: .writeManifest(status: "ok"),
        pendingSidecarPath: pendingPath
    )
    let transcription = PendingSessionTranscriptionService(
        runtimeService: runtime,
        pendingSidecarService: sidecarService,
        transitionService: transitionService,
        finalizerService: PendingSessionFinalizerService(),
        pollIntervalNanoseconds: 10_000_000
    )

    let result = try await transcription.transcribePendingSession(
        summary: pendingSummary(sessionRoot: sessionRoot, state: .readyToTranscribe),
        timeoutSeconds: 5
    )

    try require(result.finalState == .completed, "success path should finish in completed state")
    let successSawTranscribing = await runtime.sawTranscribingState()
    try require(successSawTranscribing, "runtime launch should observe transcribing intermediate state")
    try require(
        fileManager.fileExists(atPath: sessionRoot.appendingPathComponent("session.manifest.json").path),
        "manifest should exist after successful promotion"
    )
    try require(
        !fileManager.fileExists(atPath: pendingPath.path),
        "pending sidecar should be removed after successful promotion"
    )
}

private func testFailedTranscription(tempRoot: URL) async throws {
    let fileManager = FileManager.default
    let sidecarService = FileSystemPendingSessionSidecarService()
    let transitionService = PendingSessionTransitionService()
    let sessionRoot = tempRoot.appendingPathComponent("failure", isDirectory: true)
    try fileManager.createDirectory(at: sessionRoot, withIntermediateDirectories: true)
    try writePendingSidecar(
        service: sidecarService,
        sessionRoot: sessionRoot,
        state: .readyToTranscribe
    )

    let pendingPath = sessionRoot.appendingPathComponent("session.pending.json")
    let runtime = InspectingRuntimeService(
        behavior: .writeManifest(status: "failed"),
        pendingSidecarPath: pendingPath
    )
    let transcription = PendingSessionTranscriptionService(
        runtimeService: runtime,
        pendingSidecarService: sidecarService,
        transitionService: transitionService,
        finalizerService: PendingSessionFinalizerService(),
        pollIntervalNanoseconds: 10_000_000
    )

    var didThrow = false
    do {
        _ = try await transcription.transcribePendingSession(
            summary: pendingSummary(sessionRoot: sessionRoot, state: .readyToTranscribe),
            timeoutSeconds: 5
        )
    } catch {
        didThrow = true
    }
    try require(didThrow, "failed manifest status should throw")
    let failureSawTranscribing = await runtime.sawTranscribingState()
    try require(failureSawTranscribing, "runtime launch should observe transcribing before failure")

    let failedSidecar = try sidecarService.loadPendingSidecar(at: pendingPath)
    try require(failedSidecar.transcriptionState == .failed, "failed path should persist failed sidecar state")
    try require(
        fileManager.fileExists(atPath: sessionRoot.appendingPathComponent("session.pending.retry.json").path),
        "failed path should persist retry context"
    )
}

@main
struct PendingQueueIntegrationSmoke {
    static func main() async throws {
        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("pending-queue-integration-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        try await testSuccessfulPromotion(tempRoot: tempRoot)
        try await testFailedTranscription(tempRoot: tempRoot)

        print("pending_queue_integration_smoke: PASS")
    }
}
