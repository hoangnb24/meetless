import Foundation

private final class CaptureArchiveBuilder {
    private(set) var snapshotDirectories: [URL] = []

    var lastSnapshotDirectory: URL? {
        snapshotDirectories.last
    }

    func build(sourceDirectory: URL, destinationZip: URL) throws {
        let fm = FileManager.default
        let snapshot = fm.temporaryDirectory
            .appendingPathComponent("recordit-export-snapshot-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: snapshot, withIntermediateDirectories: true, attributes: nil)
        let destinationSnapshot = snapshot.appendingPathComponent(sourceDirectory.lastPathComponent, isDirectory: true)
        try fm.copyItem(at: sourceDirectory, to: destinationSnapshot)
        snapshotDirectories.append(destinationSnapshot)
        try Data("zip-placeholder".utf8).write(to: destinationZip, options: .atomic)
    }
}

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("export_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private func readTextFile(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try handle.readToEnd() ?? Data()
    return String(decoding: data, as: UTF8.self)
}

private func readJSONFile(_ url: URL) throws -> [String: Any] {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try handle.readToEnd() ?? Data()
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NSError(domain: "export_smoke", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Expected JSON object at \(url.path)"
        ])
    }
    return object
}

private func fixtureManifestData() -> Data {
    let payload: [String: Any] = [
        "schema_version": "1",
        "kind": "transcribe-live-runtime",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "runtime_mode": "live-stream",
        "session_summary": [
            "session_status": "degraded",
            "duration_sec": 8.5
        ],
        "trust": [
            "notice_count": 2,
            "degradation_codes": ["queue_pressure"]
        ],
        "transcript": "top-level transcript fallback",
        "terminal_summary": [
            "stable_lines": [
                "[00:00.000-00:00.200] mic: hello",
                "[00:00.300-00:00.800] system: hi"
            ]
        ]
    ]
    do {
        return try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    } catch {
        fputs("export_smoke failed: could not encode manifest fixture: \(error)\n", stderr)
        exit(1)
    }
}

private func fixtureJsonlText() -> String {
    [
        "{\"event_type\":\"final\",\"text\":\"alpha\"}",
        "{\"event_type\":\"llm_final\",\"text\":\"beta\"}",
        "{\"event_type\":\"reconciled_final\",\"text\":\"gamma\"}",
        "{\"event_type\":\"partial\",\"text\":\"draft\"}"
    ].joined(separator: "\n")
}

private func createFixtureSession(at root: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: nil)

    try fixtureManifestData().write(
        to: root.appendingPathComponent("session.manifest.json"),
        options: .atomic
    )
    try Data(fixtureJsonlText().utf8).write(
        to: root.appendingPathComponent("session.jsonl"),
        options: .atomic
    )
    try Data([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]).write(
        to: root.appendingPathComponent("session.wav"),
        options: .atomic
    )
}

private func runSmoke() {
    let fm = FileManager.default
    let tempRoot = fm.temporaryDirectory
        .appendingPathComponent("recordit-export-smoke-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: tempRoot) }

    do {
        try fm.createDirectory(at: tempRoot, withIntermediateDirectories: true, attributes: nil)
    } catch {
        check(false, "could not create temp root: \(error)")
        return
    }

    let dataRoot = tempRoot.appendingPathComponent("container-data", isDirectory: true)
    let sessionsRoot = dataRoot
        .appendingPathComponent("artifacts", isDirectory: true)
        .appendingPathComponent("packaged-beta", isDirectory: true)
        .appendingPathComponent("sessions", isDirectory: true)
    let sessionRoot = sessionsRoot.appendingPathComponent("20260305T000000Z-live", isDirectory: true)
    let exportDirectory = sessionsRoot.appendingPathComponent("exports", isDirectory: true)

    do {
        try createFixtureSession(at: sessionRoot)
        try fm.createDirectory(at: exportDirectory, withIntermediateDirectories: true, attributes: nil)
    } catch {
        check(false, "fixture setup failed: \(error)")
        return
    }

    let archiveCapture = CaptureArchiveBuilder()
    let service = FileSystemSessionExportService(
        archiveBuilder: archiveCapture.build,
        environment: [
            "RECORDIT_ENFORCE_APP_MANAGED_STORAGE_POLICY": "1",
            "RECORDIT_CONTAINER_DATA_ROOT": dataRoot.path
        ]
    )

    do {
        let transcriptResult = try service.exportSession(
            SessionExportRequest(
                sessionID: "sess-1",
                sessionRoot: sessionRoot,
                outputDirectory: exportDirectory,
                kind: .transcript
            )
        )
        check(transcriptResult.outputURL.lastPathComponent == "recordit-transcript-sess-1.txt", "unexpected transcript filename")
        let transcript = try readTextFile(transcriptResult.outputURL)
        check(transcript.contains("mic: hello"), "transcript export should prefer manifest stable lines")

        let audioResult = try service.exportSession(
            SessionExportRequest(
                sessionID: "sess-1",
                sessionRoot: sessionRoot,
                outputDirectory: exportDirectory,
                kind: .audio
            )
        )
        check(audioResult.outputURL.lastPathComponent == "recordit-audio-sess-1.wav", "unexpected audio filename")
        check(fm.fileExists(atPath: audioResult.outputURL.path), "audio export file missing")

        let bundleResult = try service.exportSession(
            SessionExportRequest(
                sessionID: "sess-1",
                sessionRoot: sessionRoot,
                outputDirectory: exportDirectory,
                kind: .bundle
            )
        )
        check(bundleResult.outputURL.lastPathComponent == "recordit-session-sess-1.zip", "unexpected bundle filename")
        check(bundleResult.includedArtifacts.contains("session.manifest.json"), "bundle should include manifest")

        let diagnosticsResult = try service.exportSession(
            SessionExportRequest(
                sessionID: "sess-1",
                sessionRoot: sessionRoot,
                outputDirectory: exportDirectory,
                kind: .diagnostics,
                includeTranscriptTextInDiagnostics: false,
                includeAudioInDiagnostics: false
            )
        )
        check(diagnosticsResult.outputURL.lastPathComponent == "recordit-diagnostics-sess-1.zip", "unexpected diagnostics filename")
        check(diagnosticsResult.redacted, "diagnostics default should be redacted")

        guard let redactedSnapshot = archiveCapture.lastSnapshotDirectory else {
            check(false, "archive builder snapshot missing")
            return
        }
        let redactedManifest = try readTextFile(redactedSnapshot.appendingPathComponent("session.manifest.json"))
        check(redactedManifest.contains("[REDACTED]"), "redacted diagnostics manifest should scrub transcript text")
        let redactedJsonl = try readTextFile(redactedSnapshot.appendingPathComponent("session.jsonl"))
        check(redactedJsonl.contains("\"text\":\"[REDACTED]\""), "redacted diagnostics jsonl should scrub text fields")
        check(!redactedJsonl.contains("\"text\":\"gamma\""), "redacted diagnostics jsonl should remove original transcript text")

        let redactedDiagnosticsMetadata = try readJSONFile(
            redactedSnapshot.appendingPathComponent("diagnostics.json")
        )
        check(
            (redactedDiagnosticsMetadata["include_transcript_text"] as? Bool) == false,
            "default diagnostics metadata should keep transcript opt-in disabled"
        )
        let redactionContract = redactedDiagnosticsMetadata["redaction_contract"] as? [String: Any]
        check(redactionContract?["mode"] as? String == "redact_default", "default diagnostics should record redact_default mode")
        check(redactionContract?["transcript_text_included"] as? Bool == false, "default diagnostics should mark transcript_text_included=false")
        check(redactedDiagnosticsMetadata["outcome_classification"] as? String == SessionOutcomeClassification.finalizedSuccess.rawValue, "diagnostics metadata should include finalized_success classification")
        check(redactedDiagnosticsMetadata["outcome_code"] as? String == SessionOutcomeCode.finalizedDegradedSuccess.rawValue, "diagnostics metadata should include canonical degraded-success outcome code")
        check(redactedDiagnosticsMetadata["manifest_status"] as? String == SessionStatus.degraded.rawValue, "diagnostics metadata should include normalized manifest status")
        let supportSnapshot = redactedDiagnosticsMetadata["support_snapshot"] as? [String: Any]
        check(supportSnapshot?["schema_version"] as? String == "1", "support snapshot should include schema version marker")
        let counters = supportSnapshot?["counters"] as? [String: Any]
        check(counters?["jsonl_present"] as? Bool == true, "support snapshot should report jsonl presence")
        let eventCounts = counters?["event_type_counts"] as? [String: Any]
        check((eventCounts?["reconciled_final"] as? NSNumber)?.intValue == 1, "support snapshot should include event type counts")
        let manifestSummary = supportSnapshot?["manifest_summary"] as? [String: Any]
        check(manifestSummary?["manifest_valid"] as? Bool == true, "support snapshot should capture manifest validity")
        check(manifestSummary?["trust_notice_count"] as? Int == 2, "support snapshot should include trust notice count")
        let supportOutcome = supportSnapshot?["outcome"] as? [String: Any]
        check(supportOutcome?["classification"] as? String == SessionOutcomeClassification.finalizedSuccess.rawValue, "support snapshot should include outcome classification")
        check(supportOutcome?["code"] as? String == SessionOutcomeCode.finalizedDegradedSuccess.rawValue, "support snapshot should include outcome code")
        check(supportOutcome?["manifest_status"] as? String == SessionStatus.degraded.rawValue, "support snapshot should include outcome manifest status")

        let diagnosticsOptInResult = try service.exportSession(
            SessionExportRequest(
                sessionID: "sess-1",
                sessionRoot: sessionRoot,
                outputDirectory: exportDirectory,
                kind: .diagnostics,
                includeTranscriptTextInDiagnostics: true,
                includeAudioInDiagnostics: false
            )
        )
        check(!diagnosticsOptInResult.redacted, "diagnostics opt-in should include transcript text")
        check(diagnosticsOptInResult.includedArtifacts.contains("diagnostics.json"), "diagnostics export should include diagnostics metadata")
        guard let optInSnapshot = archiveCapture.lastSnapshotDirectory else {
            check(false, "archive builder snapshot missing for diagnostics opt-in export")
            return
        }
        let optInManifest = try readTextFile(optInSnapshot.appendingPathComponent("session.manifest.json"))
        check(
            optInManifest.contains("[00:00.000-00:00.200] mic: hello"),
            "diagnostics opt-in should preserve manifest transcript text"
        )
        let optInJsonl = try readTextFile(optInSnapshot.appendingPathComponent("session.jsonl"))
        check(optInJsonl.contains("\"text\":\"gamma\""), "diagnostics opt-in should preserve jsonl transcript text")
        let optInDiagnosticsMetadata = try readJSONFile(
            optInSnapshot.appendingPathComponent("diagnostics.json")
        )
        check(
            (optInDiagnosticsMetadata["include_transcript_text"] as? Bool) == true,
            "opt-in diagnostics metadata should record transcript inclusion"
        )
        let optInRedactionContract = optInDiagnosticsMetadata["redaction_contract"] as? [String: Any]
        check(
            optInRedactionContract?["mode"] as? String == "include_opt_in",
            "opt-in diagnostics should record include_opt_in mode"
        )
        check(
            optInRedactionContract?["transcript_text_included"] as? Bool == true,
            "opt-in diagnostics should mark transcript_text_included=true"
        )

        let manifestlessRoot = sessionsRoot.appendingPathComponent("20260305T010000Z-live", isDirectory: true)
        try fm.createDirectory(at: manifestlessRoot, withIntermediateDirectories: true, attributes: nil)
        try Data(fixtureJsonlText().utf8).write(
            to: manifestlessRoot.appendingPathComponent("session.jsonl"),
            options: .atomic
        )
        try Data("runtime stderr".utf8).write(
            to: manifestlessRoot.appendingPathComponent("runtime.stderr.log"),
            options: .atomic
        )

        let manifestlessDiagnostics = try service.exportSession(
            SessionExportRequest(
                sessionID: "sess-2",
                sessionRoot: manifestlessRoot,
                outputDirectory: exportDirectory,
                kind: .diagnostics,
                includeTranscriptTextInDiagnostics: false,
                includeAudioInDiagnostics: false
            )
        )
        check(manifestlessDiagnostics.redacted, "manifestless diagnostics should still redact transcript text by default")
        guard let manifestlessSnapshot = archiveCapture.lastSnapshotDirectory else {
            check(false, "archive builder snapshot missing for manifestless diagnostics export")
            return
        }
        check(!fm.fileExists(atPath: manifestlessSnapshot.appendingPathComponent("session.manifest.json").path), "manifestless diagnostics should not stage a manifest file")
        check(fm.fileExists(atPath: manifestlessSnapshot.appendingPathComponent("runtime.stderr.log").path), "manifestless diagnostics should include stderr log when available")
        let manifestlessMetadata = try readJSONFile(
            manifestlessSnapshot.appendingPathComponent("diagnostics.json")
        )
        check(manifestlessMetadata["outcome_classification"] as? String == SessionOutcomeClassification.partialArtifact.rawValue, "manifestless diagnostics should classify as partial_artifact")
        check(manifestlessMetadata["outcome_code"] as? String == SessionOutcomeCode.partialArtifactSession.rawValue, "manifestless diagnostics should emit partial_artifact_session outcome code")
        check(manifestlessMetadata["manifest_status"] as? String == "unknown", "manifestless diagnostics should report unknown manifest status")
        let manifestlessSupport = manifestlessMetadata["support_snapshot"] as? [String: Any]
        let manifestlessArtifactPresence = manifestlessSupport?["artifact_presence"] as? [String: Any]
        check(manifestlessArtifactPresence?["has_manifest"] as? Bool == false, "manifestless diagnostics should record has_manifest=false")
        check(manifestlessArtifactPresence?["has_stderr"] as? Bool == true, "manifestless diagnostics should record stderr presence")
        let manifestlessSummary = manifestlessSupport?["manifest_summary"] as? [String: Any]
        check(manifestlessSummary?["manifest_valid"] as? Bool == false, "manifestless diagnostics should record manifest_valid=false")

        let outsideDestination = tempRoot.appendingPathComponent("outside", isDirectory: true)
        try fm.createDirectory(at: outsideDestination, withIntermediateDirectories: true, attributes: nil)
        do {
            _ = try service.exportSession(
                SessionExportRequest(
                    sessionID: "sess-1",
                    sessionRoot: sessionRoot,
                    outputDirectory: outsideDestination,
                    kind: .transcript
                )
            )
            check(false, "policy should reject export outside managed sessions root")
        } catch let error as AppServiceError {
            check(error.code == .permissionDenied, "expected permissionDenied for policy violation")
        }
    } catch {
        check(false, "smoke run failed: \(error)")
    }
}

@main
struct ExportSmokeMain {
    static func main() {
        runSmoke()
        print("export_smoke: PASS")
    }
}
