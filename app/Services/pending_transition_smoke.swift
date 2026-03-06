import Foundation

enum PendingTransitionSmokeError: Error {
    case expectationFailed(String)
}

private func writeManifest(
    at sessionRoot: URL,
    sessionID: String,
    status: String,
    runtimeMode: String = "live",
    trustNoticeCount: Int = 0
) throws {
    let payload: [String: Any] = [
        "session_id": sessionID,
        "generated_at_utc": "2026-03-06T00:00:00Z",
        "runtime_mode": runtimeMode,
        "session_summary": [
            "session_status": status,
            "duration_sec": 2.5,
        ],
        "trust": [
            "notice_count": trustNoticeCount,
        ],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    try data.write(to: sessionRoot.appendingPathComponent("session.manifest.json"))
}

private func sessionMap(_ sessions: [SessionSummaryDTO]) -> [String: SessionSummaryDTO] {
    Dictionary(uniqueKeysWithValues: sessions.map { ($0.rootPath.lastPathComponent, $0) })
}

@main
struct PendingTransitionSmoke {
    static func main() throws {
        let transitionService = PendingSessionTransitionService()

        var state: PendingTranscriptionState = .pendingModel
        state = try transitionService.transition(from: state, event: .modelAvailable)
        state = try transitionService.transition(from: state, event: .transcriptionStarted)
        state = try transitionService.transition(from: state, event: .transcriptionCompleted)
        guard state == .completed else {
            throw PendingTransitionSmokeError.expectationFailed("expected completed state")
        }

        var illegalRejected = false
        do {
            _ = try transitionService.transition(from: .pendingModel, event: .transcriptionStarted)
        } catch {
            illegalRejected = true
        }
        guard illegalRejected else {
            throw PendingTransitionSmokeError.expectationFailed("illegal transition must be rejected")
        }

        let sidecarService = FileSystemPendingSessionSidecarService()
        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("pending-transition-smoke-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let sessionRoot = tempRoot
            .appendingPathComponent("20260305", isDirectory: true)
            .appendingPathComponent("20260305T000000Z-record_only", isDirectory: true)
        try FileManager.default.createDirectory(at: sessionRoot, withIntermediateDirectories: true)

        let wavURL = sessionRoot.appendingPathComponent("session.wav")
        try Data("wav".utf8).write(to: wavURL)

        let writeRequest = PendingSessionSidecarWriteRequest(
            sessionID: "session-a",
            sessionRoot: sessionRoot,
            wavPath: wavURL,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            mode: .recordOnly,
            transcriptionState: .pendingModel
        )
        _ = try sidecarService.writePendingSidecar(writeRequest)

        let serviceReady = FileSystemSessionLibraryService(
            sessionsRootProvider: { tempRoot },
            pendingSidecarService: sidecarService,
            pendingTransitionService: transitionService,
            modelAvailabilityProvider: { true }
        )
        let readySessions = try serviceReady.listSessions(query: SessionQuery())
        guard readySessions.count == 1 else {
            throw PendingTransitionSmokeError.expectationFailed("expected one discovered session")
        }
        guard readySessions[0].pendingTranscriptionState == .readyToTranscribe else {
            throw PendingTransitionSmokeError.expectationFailed("expected transition to ready_to_transcribe")
        }
        guard readySessions[0].readyToTranscribe else {
            throw PendingTransitionSmokeError.expectationFailed("readyToTranscribe must be true")
        }

        let persistedReady = try sidecarService.loadPendingSidecar(
            at: sessionRoot.appendingPathComponent("session.pending.json")
        )
        guard persistedReady.transcriptionState == .readyToTranscribe else {
            throw PendingTransitionSmokeError.expectationFailed(
                "expected persisted transition to ready_to_transcribe"
            )
        }

        let servicePending = FileSystemSessionLibraryService(
            sessionsRootProvider: { tempRoot },
            pendingSidecarService: sidecarService,
            pendingTransitionService: transitionService,
            modelAvailabilityProvider: { false }
        )
        let pendingSessions = try servicePending.listSessions(query: SessionQuery())
        guard pendingSessions[0].pendingTranscriptionState == .pendingModel else {
            throw PendingTransitionSmokeError.expectationFailed("expected transition back to pending_model")
        }
        guard pendingSessions[0].status == .pending else {
            throw PendingTransitionSmokeError.expectationFailed("pending record-only sessions should keep pending status")
        }
        guard pendingSessions[0].outcomeClassification == .partialArtifact else {
            throw PendingTransitionSmokeError.expectationFailed("pending record-only sessions should classify as partial_artifact")
        }
        guard pendingSessions[0].outcomeCode == .partialArtifactSession else {
            throw PendingTransitionSmokeError.expectationFailed("pending record-only sessions should expose partial_artifact_session outcomeCode")
        }
        guard pendingSessions[0].outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.partialArtifactSession.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("pending record-only sessions should expose partial_artifact_session outcome_code")
        }

        let finalizedSuccessRoot = tempRoot
            .appendingPathComponent("20260306", isDirectory: true)
            .appendingPathComponent("20260306T010000Z-live", isDirectory: true)
        try FileManager.default.createDirectory(at: finalizedSuccessRoot, withIntermediateDirectories: true)
        try Data("wav".utf8).write(to: finalizedSuccessRoot.appendingPathComponent("session.wav"))
        try writeManifest(
            at: finalizedSuccessRoot,
            sessionID: "success-session",
            status: "ok"
        )

        let degradedSuccessRoot = tempRoot
            .appendingPathComponent("20260306", isDirectory: true)
            .appendingPathComponent("20260306T015000Z-live", isDirectory: true)
        try FileManager.default.createDirectory(at: degradedSuccessRoot, withIntermediateDirectories: true)
        try Data("wav".utf8).write(to: degradedSuccessRoot.appendingPathComponent("session.wav"))
        try writeManifest(
            at: degradedSuccessRoot,
            sessionID: "degraded-session",
            status: "degraded"
        )

        let trustDegradedRoot = tempRoot
            .appendingPathComponent("20260306", isDirectory: true)
            .appendingPathComponent("20260306T017000Z-live", isDirectory: true)
        try FileManager.default.createDirectory(at: trustDegradedRoot, withIntermediateDirectories: true)
        try Data("wav".utf8).write(to: trustDegradedRoot.appendingPathComponent("session.wav"))
        try writeManifest(
            at: trustDegradedRoot,
            sessionID: "trust-degraded-session",
            status: "ok",
            trustNoticeCount: 2
        )

        let finalizedFailureRoot = tempRoot
            .appendingPathComponent("20260306", isDirectory: true)
            .appendingPathComponent("20260306T020000Z-live", isDirectory: true)
        try FileManager.default.createDirectory(at: finalizedFailureRoot, withIntermediateDirectories: true)
        try Data("wav".utf8).write(to: finalizedFailureRoot.appendingPathComponent("session.wav"))
        try writeManifest(
            at: finalizedFailureRoot,
            sessionID: "failed-session",
            status: "failed"
        )

        let pendingManifestRoot = tempRoot
            .appendingPathComponent("20260306", isDirectory: true)
            .appendingPathComponent("20260306T025000Z-live", isDirectory: true)
        try FileManager.default.createDirectory(at: pendingManifestRoot, withIntermediateDirectories: true)
        try Data("wav".utf8).write(to: pendingManifestRoot.appendingPathComponent("session.wav"))
        try writeManifest(
            at: pendingManifestRoot,
            sessionID: "pending-manifest-session",
            status: "pending"
        )

        let partialArtifactRoot = tempRoot
            .appendingPathComponent("20260306", isDirectory: true)
            .appendingPathComponent("20260306T030000Z-live", isDirectory: true)
        try FileManager.default.createDirectory(at: partialArtifactRoot, withIntermediateDirectories: true)
        try Data("wav".utf8).write(to: partialArtifactRoot.appendingPathComponent("session.wav"))

        let staleCompletedRoot = tempRoot
            .appendingPathComponent("20260306", isDirectory: true)
            .appendingPathComponent("20260306T035000Z-record_only", isDirectory: true)
        try FileManager.default.createDirectory(at: staleCompletedRoot, withIntermediateDirectories: true)
        let staleCompletedWav = staleCompletedRoot.appendingPathComponent("session.wav")
        try Data("wav".utf8).write(to: staleCompletedWav)
        _ = try sidecarService.writePendingSidecar(
            PendingSessionSidecarWriteRequest(
                sessionID: staleCompletedRoot.lastPathComponent,
                sessionRoot: staleCompletedRoot,
                wavPath: staleCompletedWav,
                createdAt: Date(timeIntervalSince1970: 1_700_000_100),
                mode: .recordOnly,
                transcriptionState: .completed
            )
        )

        let emptyRoot = tempRoot
            .appendingPathComponent("20260306", isDirectory: true)
            .appendingPathComponent("20260306T040000Z-live", isDirectory: true)
        try FileManager.default.createDirectory(at: emptyRoot, withIntermediateDirectories: true)

        let classifiedSessions = try serviceReady.listSessions(query: SessionQuery())
        let byRoot = sessionMap(classifiedSessions)
        guard byRoot[finalizedSuccessRoot.lastPathComponent]?.status == .ok else {
            throw PendingTransitionSmokeError.expectationFailed("finalized_success should surface ok status")
        }
        guard byRoot[finalizedSuccessRoot.lastPathComponent]?.outcomeClassification == .finalizedSuccess else {
            throw PendingTransitionSmokeError.expectationFailed("valid manifest + wav should classify as finalized_success")
        }
        guard byRoot[finalizedSuccessRoot.lastPathComponent]?.outcomeCode == .finalizedSuccess else {
            throw PendingTransitionSmokeError.expectationFailed("ok finalized success should expose finalized_success outcomeCode")
        }
        guard byRoot[finalizedSuccessRoot.lastPathComponent]?.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.finalizedSuccess.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("ok finalized success should expose finalized_success outcome_code")
        }
        guard byRoot[degradedSuccessRoot.lastPathComponent]?.status == .degraded else {
            throw PendingTransitionSmokeError.expectationFailed("degraded finalized success should surface degraded status")
        }
        guard byRoot[degradedSuccessRoot.lastPathComponent]?.outcomeClassification == .finalizedSuccess else {
            throw PendingTransitionSmokeError.expectationFailed("degraded manifest + wav should remain finalized_success classification")
        }
        guard byRoot[degradedSuccessRoot.lastPathComponent]?.outcomeCode == .finalizedDegradedSuccess else {
            throw PendingTransitionSmokeError.expectationFailed("degraded finalized success should expose finalized_degraded_success outcomeCode")
        }
        guard byRoot[degradedSuccessRoot.lastPathComponent]?.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.finalizedDegradedSuccess.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("degraded finalized success should expose finalized_degraded_success outcome_code")
        }
        guard byRoot[trustDegradedRoot.lastPathComponent]?.status == .degraded else {
            throw PendingTransitionSmokeError.expectationFailed("ok manifest with trust notices should surface degraded status")
        }
        guard byRoot[trustDegradedRoot.lastPathComponent]?.outcomeClassification == .finalizedSuccess else {
            throw PendingTransitionSmokeError.expectationFailed("ok manifest with trust notices should remain finalized_success classification")
        }
        guard byRoot[trustDegradedRoot.lastPathComponent]?.outcomeCode == .finalizedDegradedSuccess else {
            throw PendingTransitionSmokeError.expectationFailed("ok manifest with trust notices should expose finalized_degraded_success outcomeCode")
        }
        guard byRoot[trustDegradedRoot.lastPathComponent]?.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.finalizedDegradedSuccess.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("ok manifest with trust notices should expose finalized_degraded_success outcome_code")
        }
        guard byRoot[finalizedFailureRoot.lastPathComponent]?.status == .failed else {
            throw PendingTransitionSmokeError.expectationFailed("finalized_failure should surface failed status")
        }
        guard byRoot[finalizedFailureRoot.lastPathComponent]?.outcomeClassification == .finalizedFailure else {
            throw PendingTransitionSmokeError.expectationFailed("failed manifest should classify as finalized_failure")
        }
        guard byRoot[finalizedFailureRoot.lastPathComponent]?.outcomeCode == .finalizedFailure else {
            throw PendingTransitionSmokeError.expectationFailed("failed manifest should expose finalized_failure outcomeCode")
        }
        guard byRoot[finalizedFailureRoot.lastPathComponent]?.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.finalizedFailure.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("failed manifest should expose finalized_failure outcome_code")
        }
        guard byRoot[pendingManifestRoot.lastPathComponent]?.status == .pending else {
            throw PendingTransitionSmokeError.expectationFailed("manifest_status=pending should surface pending status")
        }
        guard byRoot[pendingManifestRoot.lastPathComponent]?.outcomeClassification == .partialArtifact else {
            throw PendingTransitionSmokeError.expectationFailed("manifest_status=pending should remain partial_artifact")
        }
        guard byRoot[pendingManifestRoot.lastPathComponent]?.outcomeCode == .partialArtifactSession else {
            throw PendingTransitionSmokeError.expectationFailed("pending manifest should expose partial_artifact_session outcomeCode")
        }
        guard byRoot[pendingManifestRoot.lastPathComponent]?.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.partialArtifactSession.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("pending manifest should expose partial_artifact_session outcome_code")
        }
        guard byRoot[partialArtifactRoot.lastPathComponent]?.status == .failed else {
            throw PendingTransitionSmokeError.expectationFailed("partial_artifact without pending sidecar should surface failed status")
        }
        guard byRoot[partialArtifactRoot.lastPathComponent]?.outcomeClassification == .partialArtifact else {
            throw PendingTransitionSmokeError.expectationFailed("orphan wav should classify as partial_artifact")
        }
        guard byRoot[partialArtifactRoot.lastPathComponent]?.outcomeCode == .partialArtifactSession else {
            throw PendingTransitionSmokeError.expectationFailed("orphan wav should expose partial_artifact_session outcomeCode")
        }
        guard byRoot[partialArtifactRoot.lastPathComponent]?.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.partialArtifactSession.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("orphan wav should expose partial_artifact_session outcome_code")
        }
        guard byRoot[staleCompletedRoot.lastPathComponent]?.status == .failed else {
            throw PendingTransitionSmokeError.expectationFailed("stale completed pending sidecar without manifest should not surface ok status")
        }
        guard byRoot[staleCompletedRoot.lastPathComponent]?.outcomeClassification == .partialArtifact else {
            throw PendingTransitionSmokeError.expectationFailed("stale completed pending sidecar without manifest should remain partial_artifact")
        }
        guard byRoot[staleCompletedRoot.lastPathComponent]?.outcomeCode == .partialArtifactSession else {
            throw PendingTransitionSmokeError.expectationFailed("stale completed pending sidecar should expose partial_artifact_session outcomeCode")
        }
        guard byRoot[staleCompletedRoot.lastPathComponent]?.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.partialArtifactSession.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("stale completed pending sidecar should expose partial_artifact_session outcome_code")
        }
        guard byRoot[emptyRoot.lastPathComponent]?.status == .failed else {
            throw PendingTransitionSmokeError.expectationFailed("empty_root should surface failed status")
        }
        guard byRoot[emptyRoot.lastPathComponent]?.outcomeClassification == .emptyRoot else {
            throw PendingTransitionSmokeError.expectationFailed("empty session roots should classify as empty_root")
        }
        guard byRoot[emptyRoot.lastPathComponent]?.outcomeCode == .emptySessionRoot else {
            throw PendingTransitionSmokeError.expectationFailed("empty session roots should expose empty_session_root outcomeCode")
        }
        guard byRoot[emptyRoot.lastPathComponent]?.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.emptySessionRoot.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("empty session roots should expose empty_session_root outcome_code")
        }

        let integrity = FileSystemArtifactIntegrityService()
        let emptyReport = try integrity.evaluateSessionArtifacts(
            sessionID: emptyRoot.lastPathComponent,
            rootPath: emptyRoot
        )
        guard emptyReport.outcomeClassification == .emptyRoot else {
            throw PendingTransitionSmokeError.expectationFailed("integrity report should preserve empty_root classification")
        }
        guard emptyReport.outcomeDiagnostics["has_manifest"] == String(false) else {
            throw PendingTransitionSmokeError.expectationFailed("empty_root diagnostics should expose artifact presence")
        }
        guard emptyReport.outcomeCode == .emptySessionRoot else {
            throw PendingTransitionSmokeError.expectationFailed("empty_root integrity should expose canonical empty_session_root outcomeCode")
        }
        guard emptyReport.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.emptySessionRoot.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("empty_root diagnostics should expose canonical empty_session_root outcome_code")
        }

        let failureReport = try integrity.evaluateSessionArtifacts(
            sessionID: finalizedFailureRoot.lastPathComponent,
            rootPath: finalizedFailureRoot
        )
        guard failureReport.outcomeClassification == .finalizedFailure else {
            throw PendingTransitionSmokeError.expectationFailed("integrity report should preserve finalized_failure classification")
        }
        guard failureReport.outcomeDiagnostics["manifest_status"] == "failed" else {
            throw PendingTransitionSmokeError.expectationFailed("finalized_failure diagnostics should include manifest status")
        }
        guard failureReport.outcomeCode == .finalizedFailure else {
            throw PendingTransitionSmokeError.expectationFailed("finalized_failure integrity should expose canonical finalized_failure outcomeCode")
        }
        guard failureReport.outcomeDiagnostics["outcome_code"] == SessionOutcomeCode.finalizedFailure.rawValue else {
            throw PendingTransitionSmokeError.expectationFailed("finalized_failure diagnostics should expose canonical finalized_failure outcome_code")
        }

        print("pending_transition_smoke: PASS")
    }
}
