import Foundation

public enum SessionExportKind: String, Codable, Sendable {
    case transcript
    case audio
    case bundle
    case diagnostics
}

public struct SessionExportAccessibilityCatalog {
    public static let elements: [AccessibilityElementDescriptor] = [
        AccessibilityElementDescriptor(
            id: "export_kind_picker",
            label: "Export format",
            hint: "Choose transcript, audio, bundle, or diagnostics export."
        ),
        AccessibilityElementDescriptor(
            id: "export_destination_picker",
            label: "Export destination",
            hint: "Choose where exported files should be saved."
        ),
        AccessibilityElementDescriptor(
            id: "start_export",
            label: "Start export",
            hint: "Runs export with the selected options."
        ),
    ]

    public static let focusPlan = KeyboardFocusPlan(
        orderedElementIDs: ["export_kind_picker", "export_destination_picker", "start_export"]
    )

    public static let keyboardShortcuts: [KeyboardShortcutDescriptor] = [
        KeyboardShortcutDescriptor(
            id: "run_export_shortcut",
            key: "return",
            modifiers: ["command"],
            actionSummary: "Start export with selected options."
        ),
    ]
}

public struct SessionExportRequest: Equatable, Sendable {
    public var sessionID: String
    public var sessionRoot: URL
    public var outputDirectory: URL
    public var kind: SessionExportKind
    public var includeTranscriptTextInDiagnostics: Bool
    public var includeAudioInDiagnostics: Bool

    public init(
        sessionID: String,
        sessionRoot: URL,
        outputDirectory: URL,
        kind: SessionExportKind,
        includeTranscriptTextInDiagnostics: Bool = false,
        includeAudioInDiagnostics: Bool = false
    ) {
        self.sessionID = sessionID
        self.sessionRoot = sessionRoot
        self.outputDirectory = outputDirectory
        self.kind = kind
        self.includeTranscriptTextInDiagnostics = includeTranscriptTextInDiagnostics
        self.includeAudioInDiagnostics = includeAudioInDiagnostics
    }
}

public struct SessionExportResult: Equatable, Sendable {
    public var kind: SessionExportKind
    public var outputURL: URL
    public var exportedAt: Date
    public var includedArtifacts: [String]
    public var redacted: Bool

    public init(
        kind: SessionExportKind,
        outputURL: URL,
        exportedAt: Date,
        includedArtifacts: [String],
        redacted: Bool
    ) {
        self.kind = kind
        self.outputURL = outputURL
        self.exportedAt = exportedAt
        self.includedArtifacts = includedArtifacts
        self.redacted = redacted
    }
}

public protocol SessionExportService {
    func exportSession(_ request: SessionExportRequest) throws -> SessionExportResult
}

public struct FileSystemSessionExportService: SessionExportService {
    public typealias ArchiveBuilder = (_ sourceDirectory: URL, _ destinationZip: URL) throws -> Void

    private static let policyEnv = "RECORDIT_ENFORCE_APP_MANAGED_STORAGE_POLICY"
    private static let dataRootOverrideEnv = "RECORDIT_CONTAINER_DATA_ROOT"
    private static let appContainerID = "com.recordit.sequoiatranscribe"
    private static let redactedTextKeys: Set<String> = ["text", "transcript", "transcript_text"]

    private let fileManager: FileManager
    private let nowProvider: () -> Date
    private let archiveBuilder: ArchiveBuilder
    private let environment: [String: String]
    private let workingDirectoryProvider: () throws -> URL

    private struct OutcomeSnapshot {
        var classification: SessionOutcomeClassification
        var code: SessionOutcomeCode
        var manifestStatus: SessionStatus?
    }

    public init(
        fileManager: FileManager = .default,
        nowProvider: @escaping () -> Date = Date.init,
        archiveBuilder: ArchiveBuilder? = nil,
        environment: [String: String]? = nil,
        workingDirectoryProvider: @escaping () throws -> URL = { URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true) }
    ) {
        self.fileManager = fileManager
        self.nowProvider = nowProvider
        self.archiveBuilder = archiveBuilder ?? Self.defaultArchiveBuilder
        self.environment = environment ?? ProcessInfo.processInfo.environment
        self.workingDirectoryProvider = workingDirectoryProvider
    }

    public func exportSession(_ request: SessionExportRequest) throws -> SessionExportResult {
        let sessionRoot = try normalizedAbsoluteURL(request.sessionRoot)
        let outputDirectory = try normalizedAbsoluteURL(request.outputDirectory)

        guard directoryExists(at: sessionRoot) else {
            throw AppServiceError(
                code: .artifactMissing,
                userMessage: "Session folder is missing.",
                remediation: "Refresh sessions and retry export."
            )
        }

        if appManagedStoragePolicyEnabled() {
            let sessionsRoot = try canonicalManagedSessionsRoot()
            try ensureWithinManagedSessionsRoot(path: sessionRoot, sessionsRoot: sessionsRoot)
            try ensureWithinManagedSessionsRoot(path: outputDirectory, sessionsRoot: sessionsRoot)
        }

        try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        let now = nowProvider()
        let normalizedSessionID = Self.safeSessionIdentifier(
            request.sessionID.isEmpty ? sessionRoot.lastPathComponent : request.sessionID
        )

        switch request.kind {
        case .transcript:
            return try exportTranscript(
                sessionID: normalizedSessionID,
                sessionRoot: sessionRoot,
                outputDirectory: outputDirectory,
                now: now
            )
        case .audio:
            return try exportAudio(
                sessionID: normalizedSessionID,
                sessionRoot: sessionRoot,
                outputDirectory: outputDirectory,
                now: now
            )
        case .bundle:
            return try exportBundle(
                sessionID: normalizedSessionID,
                sessionRoot: sessionRoot,
                outputDirectory: outputDirectory,
                now: now
            )
        case .diagnostics:
            return try exportDiagnostics(
                sessionID: normalizedSessionID,
                sessionRoot: sessionRoot,
                outputDirectory: outputDirectory,
                includeTranscript: request.includeTranscriptTextInDiagnostics,
                includeAudio: request.includeAudioInDiagnostics,
                now: now
            )
        }
    }

    private func exportTranscript(
        sessionID: String,
        sessionRoot: URL,
        outputDirectory: URL,
        now: Date
    ) throws -> SessionExportResult {
        let destination = outputDirectory
            .appendingPathComponent("recordit-transcript-\(sessionID)")
            .appendingPathExtension("txt")
        let transcript = try resolvedTranscriptText(sessionRoot: sessionRoot)
        let data = (transcript + "\n").data(using: .utf8) ?? Data()
        try writeDataAtomically(data, to: destination)
        return SessionExportResult(
            kind: .transcript,
            outputURL: destination,
            exportedAt: now,
            includedArtifacts: ["transcript.txt"],
            redacted: false
        )
    }

    private func exportAudio(
        sessionID: String,
        sessionRoot: URL,
        outputDirectory: URL,
        now: Date
    ) throws -> SessionExportResult {
        let source = sessionRoot.appendingPathComponent("session.wav")
        guard fileManager.fileExists(atPath: source.path) else {
            throw AppServiceError(
                code: .artifactMissing,
                userMessage: "Session audio is unavailable.",
                remediation: "Record or import audio before exporting."
            )
        }

        let destination = outputDirectory
            .appendingPathComponent("recordit-audio-\(sessionID)")
            .appendingPathExtension("wav")
        try copyFileAtomically(from: source, to: destination)
        return SessionExportResult(
            kind: .audio,
            outputURL: destination,
            exportedAt: now,
            includedArtifacts: ["session.wav"],
            redacted: false
        )
    }

    private func exportBundle(
        sessionID: String,
        sessionRoot: URL,
        outputDirectory: URL,
        now: Date
    ) throws -> SessionExportResult {
        let bundleName = "recordit-session-\(sessionID)"
        let destination = outputDirectory
            .appendingPathComponent(bundleName)
            .appendingPathExtension("zip")

        let canonicalArtifacts = [
            "session.manifest.json",
            "session.jsonl",
            "session.pending.json",
            "session.wav"
        ]
        let existingArtifacts = canonicalArtifacts.filter {
            fileManager.fileExists(atPath: sessionRoot.appendingPathComponent($0).path)
        }
        guard !existingArtifacts.isEmpty else {
            throw AppServiceError(
                code: .artifactMissing,
                userMessage: "No session artifacts are available for export.",
                remediation: "Run a session first, then retry export."
            )
        }

        let tempRoot = try createTemporaryDirectory(prefix: "recordit-export-bundle")
        defer { try? fileManager.removeItem(at: tempRoot) }

        let stageDirectory = tempRoot.appendingPathComponent(bundleName, isDirectory: true)
        try fileManager.createDirectory(at: stageDirectory, withIntermediateDirectories: true)
        for artifact in existingArtifacts.sorted() {
            let source = sessionRoot.appendingPathComponent(artifact)
            let destinationInStage = stageDirectory.appendingPathComponent(artifact)
            try fileManager.copyItem(at: source, to: destinationInStage)
        }

        let tempZip = tempRoot.appendingPathComponent(bundleName).appendingPathExtension("zip")
        try archiveBuilder(stageDirectory, tempZip)
        try replaceItemAtomically(stagingItem: tempZip, at: destination)

        return SessionExportResult(
            kind: .bundle,
            outputURL: destination,
            exportedAt: now,
            includedArtifacts: existingArtifacts.sorted(),
            redacted: false
        )
    }

    private func exportDiagnostics(
        sessionID: String,
        sessionRoot: URL,
        outputDirectory: URL,
        includeTranscript: Bool,
        includeAudio: Bool,
        now: Date
    ) throws -> SessionExportResult {
        let archiveName = "recordit-diagnostics-\(sessionID)"
        let destination = outputDirectory
            .appendingPathComponent(archiveName)
            .appendingPathExtension("zip")

        let manifestURL = sessionRoot.appendingPathComponent("session.manifest.json")
        let pendingURL = sessionRoot.appendingPathComponent("session.pending.json")
        let retryContextURL = sessionRoot.appendingPathComponent("session.pending.retry.json")
        let stderrURL = sessionRoot.appendingPathComponent("runtime.stderr.log")
        let jsonlSource = sessionRoot.appendingPathComponent("session.jsonl")
        let audioSource = sessionRoot.appendingPathComponent("session.wav")

        let hasManifest = fileManager.fileExists(atPath: manifestURL.path)
        let hasPending = fileManager.fileExists(atPath: pendingURL.path)
        let hasRetryContext = fileManager.fileExists(atPath: retryContextURL.path)
        let hasStderr = fileManager.fileExists(atPath: stderrURL.path)
        let hasJsonl = fileManager.fileExists(atPath: jsonlSource.path)
        let hasWav = fileManager.fileExists(atPath: audioSource.path)

        guard hasManifest || hasPending || hasRetryContext || hasStderr || hasJsonl || hasWav else {
            throw AppServiceError(
                code: .artifactMissing,
                userMessage: "No diagnostics artifacts are available for this session.",
                remediation: "Run a session first, then retry diagnostics export."
            )
        }

        let manifestData = hasManifest ? try readData(at: manifestURL) : nil
        let redactedManifestData = try manifestData.map {
            try redactManifestDataIfNeeded($0, includeTranscript: includeTranscript)
        }

        let tempRoot = try createTemporaryDirectory(prefix: "recordit-export-diagnostics")
        defer { try? fileManager.removeItem(at: tempRoot) }

        let stageDirectory = tempRoot.appendingPathComponent(archiveName, isDirectory: true)
        try fileManager.createDirectory(at: stageDirectory, withIntermediateDirectories: true)

        var included: [String] = []
        if let redactedManifestData {
            let stageManifest = stageDirectory.appendingPathComponent("session.manifest.json")
            try writeDataAtomically(redactedManifestData, to: stageManifest)
            included.append("session.manifest.json")
        }
        var sourceJsonlData: Data?

        if hasJsonl {
            let jsonlData = try readData(at: jsonlSource)
            sourceJsonlData = jsonlData
            let diagnosticsJsonlData = includeTranscript
                ? jsonlData
                : redactJsonlTranscriptText(jsonlData)
            let stageJsonl = stageDirectory.appendingPathComponent("session.jsonl")
            try writeDataAtomically(diagnosticsJsonlData, to: stageJsonl)
            included.append("session.jsonl")
        }

        if hasPending {
            let stagePending = stageDirectory.appendingPathComponent("session.pending.json")
            try fileManager.copyItem(at: pendingURL, to: stagePending)
            included.append("session.pending.json")
        }

        if hasRetryContext {
            let stageRetryContext = stageDirectory.appendingPathComponent("session.pending.retry.json")
            try fileManager.copyItem(at: retryContextURL, to: stageRetryContext)
            included.append("session.pending.retry.json")
        }

        if hasStderr {
            let stageStderr = stageDirectory.appendingPathComponent("runtime.stderr.log")
            try fileManager.copyItem(at: stderrURL, to: stageStderr)
            included.append("runtime.stderr.log")
        }

        if includeAudio, hasWav {
            let stageAudio = stageDirectory.appendingPathComponent("session.wav")
            try fileManager.copyItem(at: audioSource, to: stageAudio)
            included.append("session.wav")
        }

        let outcome = deriveOutcomeSnapshot(
            manifestData: manifestData,
            hasManifest: hasManifest,
            hasPending: hasPending,
            hasWav: hasWav,
            hasJsonl: hasJsonl,
            hasRetryContext: hasRetryContext
        )
        let supportSnapshot = buildDiagnosticsSupportSnapshot(
            manifestData: manifestData,
            jsonlData: sourceJsonlData,
            hasManifest: hasManifest,
            hasPending: hasPending,
            hasRetryContext: hasRetryContext,
            hasWav: hasWav,
            hasJsonl: hasJsonl,
            hasStderr: hasStderr
        )

        let diagnosticsMetadata: [String: Any] = [
            "schema_version": "1",
            "kind": "recordit-diagnostics",
            "generated_at_utc": Self.iso8601(now),
            "session_id": sessionID,
            "outcome_classification": outcome.classification.rawValue,
            "outcome_code": outcome.code.rawValue,
            "manifest_status": outcome.manifestStatus?.rawValue ?? "unknown",
            "include_transcript_text": includeTranscript,
            "include_audio": includeAudio,
            "redaction_contract": diagnosticsRedactionContract(includeTranscript: includeTranscript),
            "support_snapshot": supportSnapshot,
            "artifacts": included.sorted()
        ]
        let diagnosticsData = try JSONSerialization.data(
            withJSONObject: diagnosticsMetadata,
            options: [.prettyPrinted, .sortedKeys]
        )
        let metadataURL = stageDirectory.appendingPathComponent("diagnostics.json")
        try writeDataAtomically(diagnosticsData, to: metadataURL)
        included.append("diagnostics.json")

        let tempZip = tempRoot.appendingPathComponent(archiveName).appendingPathExtension("zip")
        try archiveBuilder(stageDirectory, tempZip)
        try replaceItemAtomically(stagingItem: tempZip, at: destination)

        return SessionExportResult(
            kind: .diagnostics,
            outputURL: destination,
            exportedAt: now,
            includedArtifacts: included.sorted(),
            redacted: !includeTranscript
        )
    }

    private func resolvedTranscriptText(sessionRoot: URL) throws -> String {
        let manifestURL = sessionRoot.appendingPathComponent("session.manifest.json")
        if fileManager.fileExists(atPath: manifestURL.path) {
            let data = try readData(at: manifestURL)
            if let text = try transcriptFromManifest(data), !text.isEmpty {
                return text
            }
        }

        let jsonlURL = sessionRoot.appendingPathComponent("session.jsonl")
        if fileManager.fileExists(atPath: jsonlURL.path) {
            let data = try readData(at: jsonlURL)
            if let text = transcriptFromJsonl(data), !text.isEmpty {
                return text
            }
        }

        throw AppServiceError(
            code: .artifactMissing,
            userMessage: "Transcript content is unavailable.",
            remediation: "Run transcript reconstruction or verify session artifacts."
        )
    }

    private func transcriptFromManifest(_ data: Data) throws -> String? {
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Session manifest is malformed.",
                remediation: "Retry export after regenerating the manifest."
            )
        }

        if let terminalSummary = payload["terminal_summary"] as? [String: Any],
           let stableLines = terminalSummary["stable_lines"] as? [String],
           !stableLines.isEmpty {
            return stableLines.joined(separator: "\n")
        }

        if let transcript = payload["transcript"] as? String,
           !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return transcript
        }

        return nil
    }

    private func transcriptFromJsonl(_ data: Data) -> String? {
        guard let text = String(data: data, encoding: .utf8) else {
            return nil
        }

        var reconciledFinal = [String]()
        var llmFinal = [String]()
        var final = [String]()

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty,
                  let lineData = trimmed.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                  let eventType = object["event_type"] as? String,
                  let segmentText = object["text"] as? String else {
                continue
            }

            let clean = segmentText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !clean.isEmpty else { continue }

            switch eventType {
            case "reconciled_final":
                reconciledFinal.append(clean)
            case "llm_final":
                llmFinal.append(clean)
            case "final":
                final.append(clean)
            default:
                break
            }
        }

        let selected: [String]
        if !reconciledFinal.isEmpty {
            selected = reconciledFinal
        } else if !llmFinal.isEmpty {
            selected = llmFinal
        } else {
            selected = final
        }

        guard !selected.isEmpty else { return nil }
        return selected.joined(separator: "\n")
    }

    private func redactManifestDataIfNeeded(_ data: Data, includeTranscript: Bool) throws -> Data {
        guard !includeTranscript else {
            return data
        }

        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Session manifest is malformed.",
                remediation: "Retry export after regenerating the manifest."
            )
        }

        let redacted = redactJSONValue(object, key: nil)
        guard JSONSerialization.isValidJSONObject(redacted) else {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Manifest redaction failed.",
                remediation: "Retry diagnostics export with transcript opt-in if this persists."
            )
        }
        return try JSONSerialization.data(withJSONObject: redacted, options: [.prettyPrinted, .sortedKeys])
    }

    private func redactJsonlTranscriptText(_ data: Data) -> Data {
        guard let text = String(data: data, encoding: .utf8) else {
            return Data()
        }

        var redactedLines = [String]()
        redactedLines.reserveCapacity(text.count / 32)

        var lineNumber = 0
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            lineNumber += 1
            let line = String(raw)
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                redactedLines.append("")
                continue
            }

            guard let lineData = trimmed.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
                redactedLines.append(
                    "{\"redacted\":true,\"reason\":\"unparseable_jsonl_line\",\"line_number\":\(lineNumber)}"
                )
                continue
            }

            let redactedObject = redactJSONValue(object, key: nil)
            if let encoded = try? JSONSerialization.data(withJSONObject: redactedObject, options: [.sortedKeys]),
               let encodedLine = String(data: encoded, encoding: .utf8) {
                redactedLines.append(encodedLine)
            } else {
                redactedLines.append(
                    "{\"redacted\":true,\"reason\":\"json_encode_failure\",\"line_number\":\(lineNumber)}"
                )
            }
        }

        return redactedLines.joined(separator: "\n").data(using: .utf8) ?? Data()
    }

    private func buildDiagnosticsSupportSnapshot(
        manifestData: Data?,
        jsonlData: Data?,
        hasManifest: Bool,
        hasPending: Bool,
        hasRetryContext: Bool,
        hasWav: Bool,
        hasJsonl: Bool,
        hasStderr: Bool
    ) -> [String: Any] {
        let manifestSummary = parseManifestSupportSummary(manifestData)
        let jsonlCounters = parseJsonlCounters(jsonlData)
        let outcome = deriveOutcomeSnapshot(
            manifestData: manifestData,
            hasManifest: hasManifest,
            hasPending: hasPending,
            hasWav: hasWav,
            hasJsonl: hasJsonl,
            hasRetryContext: hasRetryContext
        )
        let artifactPresence: [String: Any] = [
            "has_manifest": hasManifest,
            "has_pending": hasPending,
            "has_retry_context": hasRetryContext,
            "has_wav": hasWav,
            "has_jsonl": hasJsonl,
            "has_stderr": hasStderr,
        ]

        return [
            "schema_version": "1",
            "manifest_summary": manifestSummary,
            "counters": jsonlCounters,
            "artifact_presence": artifactPresence,
            "outcome": [
                "classification": outcome.classification.rawValue,
                "code": outcome.code.rawValue,
                "manifest_status": outcome.manifestStatus?.rawValue ?? "unknown",
            ],
        ]
    }

    private func parseManifestSupportSummary(_ data: Data?) -> [String: Any] {
        guard let data else {
            let fallbackFailureContext: [String: Any] = [
                "code": NSNull(),
                "message": NSNull(),
            ]
            return [
                "manifest_valid": false,
                "runtime_mode": "unknown",
                "session_status": "unknown",
                "duration_sec": 0,
                "trust_notice_count": 0,
                "degradation_codes": [],
                "failure_context": fallbackFailureContext,
            ]
        }

        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            let fallbackFailureContext: [String: Any] = [
                "code": NSNull(),
                "message": NSNull(),
            ]
            return [
                "manifest_valid": false,
                "runtime_mode": "unknown",
                "session_status": "unknown",
                "duration_sec": 0,
                "trust_notice_count": 0,
                "degradation_codes": [],
                "failure_context": fallbackFailureContext,
            ]
        }

        let summary = payload["session_summary"] as? [String: Any]
        let trust = payload["trust"] as? [String: Any]
        let failure = payload["failure_context"] as? [String: Any]

        let runtimeMode = (payload["runtime_mode"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sessionStatus = (summary?["session_status"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let durationSec = (summary?["duration_sec"] as? NSNumber)?.doubleValue ?? 0
        let trustNoticeCount = (trust?["notice_count"] as? NSNumber)?.intValue ?? 0
        let degradationCodes = (trust?["degradation_codes"] as? [String]) ?? []

        let failureCode = (failure?["code"] as? String)
            ?? (summary?["failure_code"] as? String)
        let failureMessage = (failure?["message"] as? String)
            ?? (summary?["failure_detail"] as? String)
        let failureContext: [String: Any] = [
            "code": failureCode ?? NSNull(),
            "message": failureMessage ?? NSNull(),
        ]

        return [
            "manifest_valid": true,
            "runtime_mode": runtimeMode ?? "unknown",
            "session_status": sessionStatus ?? "unknown",
            "duration_sec": durationSec,
            "trust_notice_count": trustNoticeCount,
            "degradation_codes": degradationCodes,
            "failure_context": failureContext,
        ]
    }

    private func deriveOutcomeSnapshot(
        manifestData: Data?,
        hasManifest: Bool,
        hasPending: Bool,
        hasWav: Bool,
        hasJsonl: Bool,
        hasRetryContext: Bool
    ) -> OutcomeSnapshot {
        let manifestStatus = parseManifestStatus(manifestData)
        let classification: SessionOutcomeClassification

        if let manifestStatus {
            switch manifestStatus {
            case .failed:
                classification = .finalizedFailure
            case .ok, .degraded:
                classification = hasWav ? .finalizedSuccess : .partialArtifact
            case .pending:
                classification = .partialArtifact
            }
        } else {
            let hasAnyArtifacts = hasManifest || hasPending || hasWav || hasJsonl || hasRetryContext
            classification = hasAnyArtifacts ? .partialArtifact : .emptyRoot
        }

        return OutcomeSnapshot(
            classification: classification,
            code: classification.canonicalCode(manifestStatus: manifestStatus),
            manifestStatus: manifestStatus
        )
    }

    private func parseManifestStatus(_ data: Data?) -> SessionStatus? {
        guard let data,
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        let trustNoticeCount = parseTrustNoticeCount(payload)
        let summary = payload["session_summary"] as? [String: Any]
        let rawStatusValue = (summary?["session_status"] as? String)
            ?? (payload["status"] as? String)
        let rawStatus = rawStatusValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard let rawStatus, let status = SessionStatus(rawValue: rawStatus) else {
            return nil
        }
        if status == .ok, trustNoticeCount > 0 {
            return .degraded
        }
        return status
    }

    private func parseTrustNoticeCount(_ payload: [String: Any]) -> Int {
        guard let trust = payload["trust"] as? [String: Any] else {
            return 0
        }

        if let count = trust["notice_count"] as? Int {
            return max(0, count)
        }
        if let count = trust["notice_count"] as? NSNumber {
            return max(0, count.intValue)
        }
        if let notices = trust["notices"] as? [[String: Any]] {
            return notices.count
        }
        return 0
    }

    private func parseJsonlCounters(_ data: Data?) -> [String: Any] {
        guard let data,
              let text = String(data: data, encoding: .utf8) else {
            return [
                "jsonl_present": false,
                "line_count": 0,
                "unparseable_line_count": 0,
                "event_type_counts": [String: Int](),
            ]
        }

        var lineCount = 0
        var unparseable = 0
        var eventCounts: [String: Int] = [:]

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            lineCount += 1
            let line = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { continue }

            guard let lineData = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                  let eventType = object["event_type"] as? String,
                  !eventType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                unparseable += 1
                continue
            }
            eventCounts[eventType, default: 0] += 1
        }

        return [
            "jsonl_present": true,
            "line_count": lineCount,
            "unparseable_line_count": unparseable,
            "event_type_counts": eventCounts,
        ]
    }

    private func diagnosticsRedactionContract(includeTranscript: Bool) -> [String: Any] {
        [
            "mode": includeTranscript ? "include_opt_in" : "redact_default",
            "transcript_text_included": includeTranscript,
            "redacted_text_keys": Array(Self.redactedTextKeys).sorted(),
        ]
    }

    private func redactJSONValue(_ value: Any, key: String?) -> Any {
        if let dictionary = value as? [String: Any] {
            var redacted = [String: Any]()
            for item in dictionary {
                redacted[item.key] = redactJSONValue(item.value, key: item.key)
            }
            return redacted
        }

        if let array = value as? [Any] {
            if key == "stable_lines" {
                return Array(repeating: "[REDACTED]", count: array.count)
            }
            return array.map { redactJSONValue($0, key: nil) }
        }

        if let key, Self.redactedTextKeys.contains(key.lowercased()) {
            if value is String {
                return "[REDACTED]"
            }
        }

        return value
    }

    private func appManagedStoragePolicyEnabled() -> Bool {
        guard let value = environment[Self.policyEnv]?.trimmingCharacters(in: .whitespacesAndNewlines)
        else {
            return false
        }
        let normalized = value.lowercased()
        return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on"
    }

    private func canonicalManagedSessionsRoot() throws -> URL {
        let dataRoot: URL
        if let override = environment[Self.dataRootOverrideEnv]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            let overrideURL = URL(fileURLWithPath: override)
            guard overrideURL.path.hasPrefix("/") else {
                throw AppServiceError(
                    code: .invalidInput,
                    userMessage: "Storage root override is invalid.",
                    remediation: "Set RECORDIT_CONTAINER_DATA_ROOT to an absolute path."
                )
            }
            dataRoot = overrideURL
        } else if let home = environment["HOME"], !home.isEmpty {
            dataRoot = URL(fileURLWithPath: home)
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Containers", isDirectory: true)
                .appendingPathComponent(Self.appContainerID, isDirectory: true)
                .appendingPathComponent("Data", isDirectory: true)
        } else {
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Could not resolve the app storage root.",
                remediation: "Ensure HOME is available, then retry."
            )
        }

        return dataRoot
            .appendingPathComponent("artifacts", isDirectory: true)
            .appendingPathComponent("packaged-beta", isDirectory: true)
            .appendingPathComponent("sessions", isDirectory: true)
            .standardizedFileURL
    }

    private func ensureWithinManagedSessionsRoot(path: URL, sessionsRoot: URL) throws {
        let normalizedPath = try normalizeForPolicy(path)
        let normalizedRoot = try normalizeForPolicy(sessionsRoot)
        let pathComponents = normalizedPath.pathComponents
        let rootComponents = normalizedRoot.pathComponents

        let isWithin = pathComponents.count >= rootComponents.count
            && Array(pathComponents.prefix(rootComponents.count)) == rootComponents
        guard isWithin else {
            throw AppServiceError(
                code: .permissionDenied,
                userMessage: "Export path is outside app-managed storage.",
                remediation: "Choose a destination under the canonical sessions root.",
                debugDetail: "candidate=\(normalizedPath.path), allowed=\(normalizedRoot.path)"
            )
        }
    }

    private func normalizeForPolicy(_ path: URL) throws -> URL {
        let absolute = try normalizedAbsoluteURL(path)
        if fileManager.fileExists(atPath: absolute.path) {
            return absolute.resolvingSymlinksInPath().standardizedFileURL
        }

        var unresolved = [String]()
        var cursor = absolute
        while !fileManager.fileExists(atPath: cursor.path) {
            unresolved.append(cursor.lastPathComponent)
            guard let parent = cursor.deletingLastPathComponentIfPossible() else {
                throw AppServiceError(
                    code: .invalidInput,
                    userMessage: "Export path is invalid.",
                    remediation: "Use an absolute destination with an existing parent directory."
                )
            }
            cursor = parent
        }

        var normalized = cursor.resolvingSymlinksInPath().standardizedFileURL
        for segment in unresolved.reversed() {
            normalized.appendPathComponent(segment)
        }
        return normalized.standardizedFileURL
    }

    private func normalizedAbsoluteURL(_ path: URL) throws -> URL {
        if path.path.hasPrefix("/") {
            return path.standardizedFileURL
        }
        let cwd = try workingDirectoryProvider()
        return cwd.appendingPathComponent(path.path).standardizedFileURL
    }

    private static func safeSessionIdentifier(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let seed = trimmed.isEmpty ? "session" : trimmed

        let scalars = seed.unicodeScalars.map { scalar -> Character in
            if CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_" {
                return Character(scalar)
            }
            return "-"
        }

        var slug = String(scalars)
            .replacingOccurrences(of: "--", with: "-")
            .trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
        while slug.contains("--") {
            slug = slug.replacingOccurrences(of: "--", with: "-")
        }
        return slug.isEmpty ? "session" : slug
    }

    private static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        return formatter.string(from: date)
    }

    private func directoryExists(at url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private func createTemporaryDirectory(prefix: String) throws -> URL {
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func readData(at url: URL) throws -> Data {
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            return try handle.readToEnd() ?? Data()
        } catch {
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Could not read session artifacts.",
                remediation: "Verify artifact permissions and retry export.",
                debugDetail: "\(url.path): \(error)"
            )
        }
    }

    private func writeDataAtomically(_ data: Data, to destination: URL) throws {
        let temp = destination.deletingLastPathComponent()
            .appendingPathComponent(".recordit-export-\(UUID().uuidString).tmp")
        do {
            try data.write(to: temp, options: .atomic)
            try replaceItemAtomically(stagingItem: temp, at: destination)
        } catch {
            try? fileManager.removeItem(at: temp)
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Could not write export file.",
                remediation: "Check destination permissions and retry.",
                debugDetail: "\(destination.path): \(error)"
            )
        }
    }

    private func copyFileAtomically(from source: URL, to destination: URL) throws {
        let temp = destination.deletingLastPathComponent()
            .appendingPathComponent(".recordit-export-\(UUID().uuidString).tmp")
        do {
            try fileManager.copyItem(at: source, to: temp)
            try replaceItemAtomically(stagingItem: temp, at: destination)
        } catch {
            try? fileManager.removeItem(at: temp)
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Could not export requested artifact.",
                remediation: "Check destination permissions and retry.",
                debugDetail: "source=\(source.path), destination=\(destination.path), error=\(error)"
            )
        }
    }

    private func replaceItemAtomically(stagingItem: URL, at destination: URL) throws {
        if fileManager.fileExists(atPath: destination.path) {
            _ = try fileManager.replaceItemAt(destination, withItemAt: stagingItem)
        } else {
            try fileManager.moveItem(at: stagingItem, to: destination)
        }
    }

    private static func defaultArchiveBuilder(sourceDirectory: URL, destinationZip: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "ditto",
            "-c",
            "-k",
            "--sequesterRsrc",
            "--keepParent",
            sourceDirectory.path,
            destinationZip.path
        ]

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Could not build archive export.",
                remediation: "Ensure archive tooling is available, then retry.",
                debugDetail: String(describing: error)
            )
        }

        process.waitUntilExit()
        if process.terminationStatus != 0 {
            let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Could not build archive export.",
                remediation: "Retry export; if this persists, inspect diagnostics logs.",
                debugDetail: stderr
            )
        }
    }
}

private extension URL {
    func deletingLastPathComponentIfPossible() -> URL? {
        let parent = deletingLastPathComponent()
        if parent.path == path {
            return nil
        }
        return parent
    }
}
