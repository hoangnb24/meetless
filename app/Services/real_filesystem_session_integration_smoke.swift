import Foundation

private enum RealFilesystemSessionIntegrationSmokeError: Error {
    case assertionFailed(String)
    case commandFailed(String)
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw RealFilesystemSessionIntegrationSmokeError.assertionFailed(message)
    }
}

private func writeJSON(_ object: Any, to url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: url, options: .atomic)
}

private func writeData(_ data: Data, to url: URL) throws {
    try data.write(to: url, options: .atomic)
}

private func writeText(_ text: String, to url: URL) throws {
    try writeData(Data(text.utf8), to: url)
}

private func readText(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try handle.readToEnd() ?? Data()
    return String(decoding: data, as: UTF8.self)
}

private func readJSONObject(_ url: URL) throws -> [String: Any] {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try handle.readToEnd() ?? Data()
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw RealFilesystemSessionIntegrationSmokeError.assertionFailed(
            "expected JSON object at \(url.path)"
        )
    }
    return object
}

private func writeFixtureWav(to url: URL) throws {
    try writeData(Data([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00]), to: url)
}

private func createFinalizedSession(
    at root: URL,
    sessionID: String,
    stableLines: [String],
    jsonlText: String,
    trustNoticeCount: Int
) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: nil)
    try writeFixtureWav(to: root.appendingPathComponent("session.wav"))
    try writeText(jsonlText, to: root.appendingPathComponent("session.jsonl"))

    let manifest: [String: Any] = [
        "session_id": sessionID,
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "runtime_mode": "live",
        "jsonl_path": "session.jsonl",
        "out_wav": "session.wav",
        "session_summary": [
            "session_status": "ok",
            "duration_sec": 95
        ],
        "terminal_summary": [
            "stable_lines": stableLines
        ],
        "trust": [
            "notice_count": trustNoticeCount
        ]
    ]
    try writeJSON(manifest, to: root.appendingPathComponent("session.manifest.json"))
}

private func createPendingSession(
    at root: URL,
    sessionID: String,
    jsonlText: String,
    createdAt: Date
) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: nil)

    let wavURL = root.appendingPathComponent("session.wav")
    try writeFixtureWav(to: wavURL)
    try writeText(jsonlText, to: root.appendingPathComponent("session.jsonl"))

    let sidecarService = FileSystemPendingSessionSidecarService()
    _ = try sidecarService.writePendingSidecar(
        PendingSessionSidecarWriteRequest(
            sessionID: sessionID,
            sessionRoot: root,
            wavPath: wavURL,
            createdAt: createdAt,
            mode: .recordOnly,
            transcriptionState: .readyToTranscribe
        )
    )
}

private func unzipArchive(_ zipURL: URL, to destinationRoot: URL) throws -> URL {
    let fm = FileManager.default
    try fm.createDirectory(at: destinationRoot, withIntermediateDirectories: true, attributes: nil)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["ditto", "-x", "-k", zipURL.path, destinationRoot.path]

    let stderrPipe = Pipe()
    process.standardError = stderrPipe

    try process.run()
    process.waitUntilExit()

    let stderrData = try stderrPipe.fileHandleForReading.readToEnd() ?? Data()
    if process.terminationStatus != 0 {
        let stderrText = String(decoding: stderrData, as: UTF8.self)
        throw RealFilesystemSessionIntegrationSmokeError.commandFailed(
            "ditto unzip failed for \(zipURL.path): \(stderrText)"
        )
    }

    let children = try fm.contentsOfDirectory(
        at: destinationRoot,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
    )
    guard let extractedRoot = children.first(where: { url in
        var isDirectory: ObjCBool = false
        return fm.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }) else {
        throw RealFilesystemSessionIntegrationSmokeError.assertionFailed(
            "expected extracted archive directory under \(destinationRoot.path)"
        )
    }
    return extractedRoot
}

private func runSmoke() throws {
    let fm = FileManager.default
    let tempRoot = fm.temporaryDirectory
        .appendingPathComponent("recordit-real-filesystem-session-integration-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: tempRoot) }

    let dataRoot = tempRoot.appendingPathComponent("container-data", isDirectory: true)
    let sessionsRoot = dataRoot
        .appendingPathComponent("artifacts", isDirectory: true)
        .appendingPathComponent("packaged-beta", isDirectory: true)
        .appendingPathComponent("sessions", isDirectory: true)
    let exportRoot = sessionsRoot.appendingPathComponent("exports", isDirectory: true)

    try fm.createDirectory(at: sessionsRoot, withIntermediateDirectories: true, attributes: nil)
    try fm.createDirectory(at: exportRoot, withIntermediateDirectories: true, attributes: nil)

    let liveRoot = sessionsRoot.appendingPathComponent("20260305T000000Z-live", isDirectory: true)
    let pendingRoot = sessionsRoot.appendingPathComponent("20260305T000100Z-record-only", isDirectory: true)

    try createFinalizedSession(
        at: liveRoot,
        sessionID: "live-session",
        stableLines: [
            "[00:00.000-00:00.200] mic: operator acknowledgement complete",
            "[00:00.250-00:00.900] system: summary archived"
        ],
        jsonlText: [
            "{\"event_type\":\"final\",\"text\":\"alpha\"}",
            "{\"event_type\":\"llm_final\",\"text\":\"beta\"}",
            "{\"event_type\":\"reconciled_final\",\"text\":\"gamma\"}"
        ].joined(separator: "\n"),
        trustNoticeCount: 0
    )
    try createPendingSession(
        at: pendingRoot,
        sessionID: "pending-session",
        jsonlText: "{\"event_type\":\"reconciled_final\",\"channel\":\"mic\",\"segment_id\":\"seg-1\",\"start_ms\":0,\"end_ms\":250,\"text\":\"queued review follow-up\"}\n",
        createdAt: Date(timeIntervalSince1970: 1_741_132_860)
    )

    let library = FileSystemSessionLibraryService(
        sessionsRootProvider: { sessionsRoot },
        modelAvailabilityProvider: { true }
    )

    let sessions = try library.listSessions(query: SessionQuery())
    try require(sessions.count == 2, "expected two discovered sessions")

    let byID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.sessionID, $0) })
    guard let liveSummary = byID["live-session"] else {
        throw RealFilesystemSessionIntegrationSmokeError.assertionFailed("missing finalized live session summary")
    }
    guard let pendingSummary = byID["pending-session"] else {
        throw RealFilesystemSessionIntegrationSmokeError.assertionFailed("missing pending session summary")
    }

    try require(liveSummary.mode == .live, "finalized session should classify as live")
    try require(liveSummary.status == .ok, "finalized session should surface ok status")
    try require(liveSummary.outcomeClassification == .finalizedSuccess, "finalized session should classify as finalized_success")
    try require(liveSummary.outcomeCode == .finalizedSuccess, "finalized session should expose finalized_success outcome code")
    try require(liveSummary.outcomeDiagnostics["has_manifest"] == "true", "finalized session should report manifest presence")
    try require(liveSummary.outcomeDiagnostics["has_wav"] == "true", "finalized session should report wav presence")

    try require(pendingSummary.mode == .recordOnly, "pending session should classify as record_only")
    try require(pendingSummary.status == .pending, "pending session should surface pending status")
    try require(pendingSummary.readyToTranscribe, "pending session should be ready to transcribe")
    try require(pendingSummary.outcomeClassification == .partialArtifact, "pending session should classify as partial_artifact")
    try require(pendingSummary.outcomeCode == .partialArtifactSession, "pending session should expose partial_artifact_session outcome code")

    let manifestSearch = try library.listSessions(query: SessionQuery(searchText: "acknowledgement"))
    try require(manifestSearch.map(\.sessionID) == ["live-session"], "manifest-backed transcript search should find live session")

    let jsonlSearch = try library.listSessions(query: SessionQuery(searchText: "queued review"))
    try require(jsonlSearch.map(\.sessionID) == ["pending-session"], "jsonl-backed transcript search should find pending session")

    let statusFiltered = try library.listSessions(query: SessionQuery(status: .ok, searchText: "queued review"))
    try require(statusFiltered.isEmpty, "status filter should exclude pending session from jsonl search")

    let detailResolver = SessionDetailResolver()
    let liveDetail = detailResolver.resolve(session: liveSummary)
    try require(liveDetail.transcriptSource == .manifest, "finalized detail should prefer manifest transcript")
    try require(liveDetail.conversationState == .ready, "finalized detail should resolve ready conversation state")
    try require(liveDetail.audioAvailable, "finalized detail should report audio availability")
    try require(liveDetail.trustNoticeCount == 0, "finalized detail should preserve trust notice count")
    try require(liveDetail.conversationLines.count == 2, "finalized detail should resolve stable manifest lines")
    try require(liveDetail.conversationLines.first?.text.contains("operator acknowledgement complete") == true, "finalized detail should expose manifest transcript text")

    let pendingDetail = detailResolver.resolve(session: pendingSummary)
    try require(pendingDetail.transcriptSource == .jsonl, "pending detail should fall back to jsonl transcript")
    try require(pendingDetail.conversationState == .ready, "pending detail should resolve ready conversation state")
    try require(pendingDetail.audioAvailable, "pending detail should report audio availability")
    try require(pendingDetail.conversationLines.map(\.text) == ["queued review follow-up"], "pending detail should decode transcript lines from jsonl")

    let integrity = FileSystemArtifactIntegrityService()
    let liveReport = try integrity.evaluateSessionArtifacts(sessionID: liveSummary.sessionID, rootPath: liveRoot)
    try require(liveReport.state == .healthy, "finalized session should report healthy integrity state")
    try require(liveReport.findings.isEmpty, "finalized session should have no integrity findings")
    try require(liveReport.outcomeClassification == liveSummary.outcomeClassification, "integrity outcome classification should match session summary")
    try require(liveReport.outcomeCode == liveSummary.outcomeCode, "integrity outcome code should match session summary")

    let pendingReport = try integrity.evaluateSessionArtifacts(sessionID: pendingSummary.sessionID, rootPath: pendingRoot)
    try require(pendingReport.state == .healthy, "pending session with valid sidecar and audio should be healthy")
    try require(pendingReport.outcomeClassification == .partialArtifact, "pending session integrity should stay partial_artifact")
    try require(pendingReport.outcomeCode == .partialArtifactSession, "pending session integrity should expose partial_artifact_session")

    let exportService = FileSystemSessionExportService(
        environment: [
            "RECORDIT_ENFORCE_APP_MANAGED_STORAGE_POLICY": "1",
            "RECORDIT_CONTAINER_DATA_ROOT": dataRoot.path
        ]
    )

    let transcriptResult = try exportService.exportSession(
        SessionExportRequest(
            sessionID: liveSummary.sessionID,
            sessionRoot: liveRoot,
            outputDirectory: exportRoot,
            kind: .transcript
        )
    )
    try require(transcriptResult.outputURL.lastPathComponent == "recordit-transcript-live-session.txt", "unexpected transcript export filename")
    let exportedTranscript = try readText(transcriptResult.outputURL)
    try require(exportedTranscript.contains("operator acknowledgement complete"), "transcript export should use manifest stable lines")

    let audioResult = try exportService.exportSession(
        SessionExportRequest(
            sessionID: liveSummary.sessionID,
            sessionRoot: liveRoot,
            outputDirectory: exportRoot,
            kind: .audio
        )
    )
    try require(audioResult.outputURL.lastPathComponent == "recordit-audio-live-session.wav", "unexpected audio export filename")
    try require(fm.fileExists(atPath: audioResult.outputURL.path), "audio export file should exist")

    let diagnosticsResult = try exportService.exportSession(
        SessionExportRequest(
            sessionID: liveSummary.sessionID,
            sessionRoot: liveRoot,
            outputDirectory: exportRoot,
            kind: .diagnostics,
            includeTranscriptTextInDiagnostics: false,
            includeAudioInDiagnostics: false
        )
    )
    try require(diagnosticsResult.kind == .diagnostics, "diagnostics export should report diagnostics kind")
    try require(diagnosticsResult.redacted, "default diagnostics export should be redacted")
    try require(
        Set(diagnosticsResult.includedArtifacts) == Set(["diagnostics.json", "session.manifest.json", "session.jsonl"]),
        "diagnostics export should include redacted manifest, jsonl, and diagnostics metadata"
    )

    let unzipRoot = tempRoot.appendingPathComponent("unzipped-diagnostics", isDirectory: true)
    let extractedDiagnosticsRoot = try unzipArchive(diagnosticsResult.outputURL, to: unzipRoot)
    let redactedManifest = try readText(extractedDiagnosticsRoot.appendingPathComponent("session.manifest.json"))
    let redactedJsonl = try readText(extractedDiagnosticsRoot.appendingPathComponent("session.jsonl"))
    try require(redactedManifest.contains("[REDACTED]"), "diagnostics manifest should redact transcript text by default")
    try require(redactedJsonl.contains("\"text\":\"[REDACTED]\""), "diagnostics jsonl should redact transcript text by default")
    try require(!redactedJsonl.contains("\"text\":\"gamma\""), "diagnostics jsonl should not preserve original transcript text in redacted mode")

    let diagnosticsMetadata = try readJSONObject(extractedDiagnosticsRoot.appendingPathComponent("diagnostics.json"))
    try require(diagnosticsMetadata["include_transcript_text"] as? Bool == false, "diagnostics metadata should record transcript redaction default")
    let redactionContract = diagnosticsMetadata["redaction_contract"] as? [String: Any]
    try require(redactionContract?["mode"] as? String == "redact_default", "diagnostics metadata should record redact_default mode")
    let supportSnapshot = diagnosticsMetadata["support_snapshot"] as? [String: Any]
    let counters = supportSnapshot?["counters"] as? [String: Any]
    try require(counters?["jsonl_present"] as? Bool == true, "diagnostics support snapshot should report jsonl presence")
    let eventTypeCounts = counters?["event_type_counts"] as? [String: Any]
    try require((eventTypeCounts?["reconciled_final"] as? NSNumber)?.intValue == 1, "diagnostics support snapshot should preserve event counts")
}

@main
struct RealFilesystemSessionIntegrationSmokeMain {
    static func main() throws {
        do {
            try runSmoke()
            print("real_filesystem_session_integration_smoke: PASS")
        } catch {
            fputs("real_filesystem_session_integration_smoke failed: \(error)\n", stderr)
            throw error
        }
    }
}
