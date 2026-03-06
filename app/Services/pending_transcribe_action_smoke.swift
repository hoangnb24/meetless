import Foundation

private enum PendingTranscribeSmokeError: Error {
    case assertionFailed(String)
}

private actor MockRuntimeService: RuntimeService {
    enum Behavior {
        case writeManifest(status: String)
        case throwLaunch(AppServiceError)
    }

    private let behavior: Behavior

    init(behavior: Behavior) {
        self.behavior = behavior
    }

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
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
        case .throwLaunch(let error):
            throw error
        }

        return RuntimeLaunchResult(
            processIdentifier: 777,
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(processIdentifier: Int32, action: RuntimeControlAction) async throws -> RuntimeControlResult {
        RuntimeControlResult(accepted: true, detail: "not used")
    }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw PendingTranscribeSmokeError.assertionFailed(message)
    }
}

private func writeReadyPendingFixture(
    root: URL,
    sidecarService: FileSystemPendingSessionSidecarService
) throws -> SessionSummaryDTO {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let wavURL = root.appendingPathComponent("session.wav")
    try Data("wav".utf8).write(to: wavURL)
    _ = try sidecarService.writePendingSidecar(
        PendingSessionSidecarWriteRequest(
            sessionID: root.lastPathComponent,
            sessionRoot: root,
            wavPath: wavURL,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            mode: .recordOnly,
            transcriptionState: .readyToTranscribe
        )
    )
    return SessionSummaryDTO(
        sessionID: root.lastPathComponent,
        startedAt: Date(timeIntervalSince1970: 1_700_000_000),
        durationMs: 0,
        mode: .recordOnly,
        status: .pending,
        rootPath: root,
        pendingTranscriptionState: .readyToTranscribe,
        readyToTranscribe: true,
        outcomeClassification: .partialArtifact
    )
}

@main
struct PendingTranscribeActionSmoke {
    static func main() async throws {
        let sidecarService = FileSystemPendingSessionSidecarService()
        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("pending-transcribe-smoke-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let successRoot = tempRoot.appendingPathComponent("success", isDirectory: true)
        let successSummary = try writeReadyPendingFixture(root: successRoot, sidecarService: sidecarService)
        let successRuntime = MockRuntimeService(behavior: .writeManifest(status: "ok"))
        let successPipeline = PendingSessionTranscriptionService(
            runtimeService: successRuntime,
            pendingSidecarService: sidecarService,
            pollIntervalNanoseconds: 10_000_000
        )

        let successResult = try await successPipeline.transcribePendingSession(
            summary: successSummary,
            timeoutSeconds: 5
        )
        try require(successResult.finalState == .completed, "expected completed state")
        try require(
            !FileManager.default.fileExists(
                atPath: successRoot.appendingPathComponent("session.pending.json").path
            ),
            "successful finalization should remove pending sidecar"
        )

        let failureRoot = tempRoot.appendingPathComponent("failure", isDirectory: true)
        let failureSummary = try writeReadyPendingFixture(root: failureRoot, sidecarService: sidecarService)
        let failureRuntime = MockRuntimeService(
            behavior: .throwLaunch(
                AppServiceError(
                    code: .processLaunchFailed,
                    userMessage: "synthetic launch failure",
                    remediation: "retry"
                )
            )
        )
        let failurePipeline = PendingSessionTranscriptionService(
            runtimeService: failureRuntime,
            pendingSidecarService: sidecarService,
            pollIntervalNanoseconds: 10_000_000
        )

        var didFail = false
        do {
            _ = try await failurePipeline.transcribePendingSession(
                summary: failureSummary,
                timeoutSeconds: 5
            )
        } catch {
            didFail = true
        }
        try require(didFail, "expected failure path to throw")

        let failedSidecar = try sidecarService.loadPendingSidecar(
            at: failureRoot.appendingPathComponent("session.pending.json")
        )
        try require(failedSidecar.transcriptionState == .failed, "failed state should persist for retries")
        try require(
            FileManager.default.fileExists(
                atPath: failureRoot.appendingPathComponent("session.pending.retry.json").path
            ),
            "retry context should be written on failure"
        )

        print("pending_transcribe_action_smoke: PASS")
    }
}
