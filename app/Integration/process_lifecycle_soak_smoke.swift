import Foundation

private enum ProcessLifecycleSoakSmokeError: Error {
    case assertionFailed(String)
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw ProcessLifecycleSoakSmokeError.assertionFailed(message)
    }
}

private actor SoakRuntimeService: RuntimeService {
    private var nextProcessID: Int32 = 7000
    private var activeLiveProcessIDs = Set<Int32>()
    private var liveStartCount = 0
    private var liveStopCount = 0
    private var offlineStartCount = 0

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        nextProcessID += 1
        let processID = nextProcessID

        switch request.mode {
        case .live:
            liveStartCount += 1
            activeLiveProcessIDs.insert(processID)
        case .offline, .recordOnly:
            offlineStartCount += 1
            let manifestURL = request.outputRoot.appendingPathComponent("session.manifest.json")
            let payload: [String: Any] = [
                "session_id": request.outputRoot.lastPathComponent,
                "session_summary": [
                    "session_status": "ok",
                ],
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            try data.write(to: manifestURL, options: .atomic)
        }

        return RuntimeLaunchResult(
            processIdentifier: processID,
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(processIdentifier: Int32, action: RuntimeControlAction) async throws -> RuntimeControlResult {
        guard action == .stop else {
            return RuntimeControlResult(accepted: false, detail: "unsupported")
        }

        guard activeLiveProcessIDs.remove(processIdentifier) != nil else {
            throw AppServiceError(
                code: .invalidInput,
                userMessage: "Stop requested for unknown process.",
                remediation: "Start a new session before stopping."
            )
        }

        liveStopCount += 1
        return RuntimeControlResult(accepted: true, detail: "stopped")
    }

    func activeLiveProcessCount() -> Int {
        activeLiveProcessIDs.count
    }

    func counters() -> (liveStarts: Int, liveStops: Int, offlineStarts: Int) {
        (liveStartCount, liveStopCount, offlineStartCount)
    }
}

private struct StaticModelService: ModelResolutionService {
    func resolveModel(_ request: ModelResolutionRequest) throws -> ResolvedModelDTO {
        _ = request
        return ResolvedModelDTO(
            resolvedPath: URL(fileURLWithPath: "/tmp/model.bin"),
            source: "soak-smoke",
            checksumSHA256: nil,
            checksumStatus: "available"
        )
    }
}

private struct StaticManifestService: ManifestService {
    func loadManifest(at _: URL) throws -> SessionManifestDTO {
        SessionManifestDTO(
            sessionID: "soak-live",
            status: "ok",
            runtimeMode: "live",
            trustNoticeCount: 0,
            artifacts: SessionArtifactsDTO(
                wavPath: URL(fileURLWithPath: "/tmp/soak-live.wav"),
                jsonlPath: URL(fileURLWithPath: "/tmp/soak-live.jsonl"),
                manifestPath: URL(fileURLWithPath: "/tmp/soak-live/session.manifest.json")
            )
        )
    }
}

private func writeReadyPendingSidecar(
    at sessionRoot: URL,
    sidecarService: FileSystemPendingSessionSidecarService,
    createdAt: Date
) throws -> SessionSummaryDTO {
    try FileManager.default.createDirectory(at: sessionRoot, withIntermediateDirectories: true)

    let wavURL = sessionRoot.appendingPathComponent("session.wav")
    try Data("wav".utf8).write(to: wavURL)

    _ = try sidecarService.writePendingSidecar(
        PendingSessionSidecarWriteRequest(
            sessionID: sessionRoot.lastPathComponent,
            sessionRoot: sessionRoot,
            wavPath: wavURL,
            createdAt: createdAt,
            mode: .recordOnly,
            transcriptionState: .readyToTranscribe
        )
    )

    return SessionSummaryDTO(
        sessionID: sessionRoot.lastPathComponent,
        startedAt: createdAt,
        durationMs: 0,
        mode: .recordOnly,
        status: .pending,
        rootPath: sessionRoot,
        pendingTranscriptionState: .readyToTranscribe,
        readyToTranscribe: true
    )
}

private func manifestStatus(at manifestURL: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: manifestURL)
    defer { try? handle.close() }
    let data = try handle.readToEnd() ?? Data()
    let object = try JSONSerialization.jsonObject(with: data)
    guard
        let payload = object as? [String: Any],
        let summary = payload["session_summary"] as? [String: Any],
        let status = summary["session_status"] as? String
    else {
        throw ProcessLifecycleSoakSmokeError.assertionFailed("manifest schema invalid at \(manifestURL.path)")
    }
    return status
}

@MainActor
private func runLiveSoak(
    runtimeService: SoakRuntimeService,
    iterations: Int,
    tempRoot: URL
) async throws {
    let viewModel = RuntimeViewModel(
        runtimeService: runtimeService,
        manifestService: StaticManifestService(),
        modelService: StaticModelService(),
        finalizationTimeoutSeconds: 1,
        finalizationPollIntervalNanoseconds: 10_000_000
    )

    for index in 1 ... iterations {
        let outputRoot = tempRoot.appendingPathComponent("live-\(index)", isDirectory: true)
        await viewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
        await viewModel.stopCurrentRun()
        try require(viewModel.state == .completed, "live iteration \(index) should complete")
        try require(viewModel.suggestedRecoveryActions.isEmpty, "live iteration \(index) should not accumulate recovery actions")
        let activeCount = await runtimeService.activeLiveProcessCount()
        try require(activeCount == 0, "live iteration \(index) should not leave orphaned live processes")
    }
}

private func runDeferredSoak(
    runtimeService: SoakRuntimeService,
    iterations: Int,
    tempRoot: URL
) async throws {
    let sidecarService = FileSystemPendingSessionSidecarService()
    let pendingTranscriptionService = PendingSessionTranscriptionService(
        runtimeService: runtimeService,
        pendingSidecarService: sidecarService,
        pollIntervalNanoseconds: 10_000_000
    )

    for index in 1 ... iterations {
        let sessionRoot = tempRoot.appendingPathComponent("record-only-\(index)", isDirectory: true)
        let summary = try writeReadyPendingSidecar(
            at: sessionRoot,
            sidecarService: sidecarService,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000 + TimeInterval(index))
        )

        let result = try await pendingTranscriptionService.transcribePendingSession(summary: summary, timeoutSeconds: 5)
        try require(result.finalState == .completed, "record-only iteration \(index) should complete")

        let pendingSidecarPath = sessionRoot.appendingPathComponent("session.pending.json")
        try require(!FileManager.default.fileExists(atPath: pendingSidecarPath.path), "record-only iteration \(index) should remove pending sidecar")

        let retryContextPath = sessionRoot.appendingPathComponent("session.pending.retry.json")
        try require(!FileManager.default.fileExists(atPath: retryContextPath.path), "record-only iteration \(index) should not persist retry context")

        let manifestPath = sessionRoot.appendingPathComponent("session.manifest.json")
        try require(FileManager.default.fileExists(atPath: manifestPath.path), "record-only iteration \(index) should materialize manifest")
        let status = try manifestStatus(at: manifestPath)
        try require(status == "ok", "record-only iteration \(index) manifest status should be ok")

        let activeCount = await runtimeService.activeLiveProcessCount()
        try require(activeCount == 0, "record-only iteration \(index) should not leave active live processes")
    }
}

@main
struct ProcessLifecycleSoakSmokeMain {
    static func main() async throws {
        let iterations = 10
        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("process-lifecycle-soak-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let runtimeService = SoakRuntimeService()

        try await runLiveSoak(runtimeService: runtimeService, iterations: iterations, tempRoot: tempRoot)
        try await runDeferredSoak(runtimeService: runtimeService, iterations: iterations, tempRoot: tempRoot)

        let counters = await runtimeService.counters()
        try require(counters.liveStarts == iterations, "live start count should equal iteration count")
        try require(counters.liveStops == iterations, "live stop count should equal iteration count")
        try require(counters.offlineStarts == iterations, "offline start count should equal iteration count")
        let finalActiveCount = await runtimeService.activeLiveProcessCount()
        try require(finalActiveCount == 0, "soak should end with zero active live processes")

        print("process_lifecycle_soak_smoke: PASS")
    }
}
