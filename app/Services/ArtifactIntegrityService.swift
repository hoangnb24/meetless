import Foundation

public struct FileSystemArtifactIntegrityService: ArtifactIntegrityService {
    public typealias DataReader = @Sendable (URL) throws -> Data

    private let dataReader: DataReader

    public init(
        dataReader: @escaping DataReader = { url in
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            return try handle.readToEnd() ?? Data()
        }
    ) {
        self.dataReader = dataReader
    }

    public func evaluateSessionArtifacts(
        sessionID: String,
        rootPath: URL
    ) throws -> SessionArtifactIntegrityReportDTO {
        let root = rootPath.standardizedFileURL
        let resolvedSessionID = sessionID.isEmpty ? root.lastPathComponent : sessionID
        var findings: [ArtifactIntegrityFindingDTO] = []

        guard directoryExists(at: root) else {
            findings.append(
                finding(
                    code: "session_root_missing",
                    summary: "Session folder is missing.",
                    remediation: "Refresh the sessions list and retry. If the folder was moved manually, restore it first.",
                    disposition: .terminal,
                    diagnostics: [
                        "root_path": root.path
                    ]
                )
            )
            return report(
                sessionID: resolvedSessionID,
                rootPath: root,
                findings: findings,
                outcomeClassification: .emptyRoot,
                outcomeCode: .emptySessionRoot,
                outcomeDiagnostics: [
                    "root_path": root.path,
                    "root_exists": String(false),
                    "outcome_classification": SessionOutcomeClassification.emptyRoot.rawValue,
                    "outcome_code": SessionOutcomeClassification.emptyRoot.canonicalCode(manifestStatus: nil).rawValue
                ]
            )
        }

        let manifestURL = root.appendingPathComponent("session.manifest.json")
        let pendingURL = root.appendingPathComponent("session.pending.json")
        let retryContextURL = root.appendingPathComponent("session.pending.retry.json")
        let wavURL = root.appendingPathComponent("session.wav")
        let jsonlURL = root.appendingPathComponent("session.jsonl")

        let hasManifest = FileManager.default.fileExists(atPath: manifestURL.path)
        let hasPending = FileManager.default.fileExists(atPath: pendingURL.path)
        let hasRetryContext = FileManager.default.fileExists(atPath: retryContextURL.path)
        let hasWav = FileManager.default.fileExists(atPath: wavURL.path)
        let hasJsonl = FileManager.default.fileExists(atPath: jsonlURL.path)
        let manifestStatus = manifestSessionStatus(at: manifestURL)
        let outcomeClassification = classifySessionOutcome(
            manifestStatus: manifestStatus,
            hasManifest: hasManifest,
            hasPending: hasPending,
            hasWav: hasWav,
            hasJsonl: hasJsonl,
            hasRetryContext: hasRetryContext
        )
        let outcomeDiagnostics = outcomeDiagnostics(
            rootPath: root,
            manifestURL: manifestURL,
            pendingURL: pendingURL,
            retryContextURL: retryContextURL,
            wavURL: wavURL,
            jsonlURL: jsonlURL,
            hasManifest: hasManifest,
            hasPending: hasPending,
            hasRetryContext: hasRetryContext,
            hasWav: hasWav,
            hasJsonl: hasJsonl,
            manifestStatus: manifestStatus,
            outcomeClassification: outcomeClassification
        )
        let outcomeCode = outcomeClassification.canonicalCode(manifestStatus: manifestStatus)
        let hasAnyArtifacts = hasManifest || hasPending || hasRetryContext || hasWav || hasJsonl

        if !hasAnyArtifacts {
            findings.append(
                finding(
                    code: "empty_session_root",
                    summary: "Session folder exists but contains no retained runtime artifacts.",
                    remediation: "Review runtime logs for launch or stop failures, then retry the session.",
                    disposition: .terminal,
                    diagnostics: outcomeDiagnostics
                )
            )
        }

        if hasAnyArtifacts && !hasManifest && !hasPending {
            findings.append(
                finding(
                    code: "missing_manifest_and_pending_sidecar",
                    summary: "Session metadata is missing.",
                    remediation: "This session cannot be resolved safely. Restore metadata from backup or remove the broken entry.",
                    disposition: .terminal,
                    diagnostics: [
                        "manifest_path": manifestURL.path,
                        "pending_path": pendingURL.path
                    ]
                )
            )
        }

        if hasPending && !hasWav {
            findings.append(
                finding(
                    code: "pending_sidecar_without_audio",
                    summary: "Pending sidecar exists but required audio is missing.",
                    remediation: "Restore `session.wav` or discard this pending item.",
                    disposition: .terminal,
                    diagnostics: [
                        "pending_path": pendingURL.path,
                        "wav_path": wavURL.path
                    ]
                )
            )
        }

        if hasPending, let pendingError = pendingSidecarParseError(at: pendingURL) {
            findings.append(
                finding(
                    code: "pending_sidecar_invalid",
                    summary: "Pending sidecar is malformed.",
                    remediation: "Regenerate `session.pending.json` using the record-only pending writer.",
                    disposition: .recoverable,
                    diagnostics: [
                        "pending_path": pendingURL.path,
                        "error": pendingError
                    ]
                )
            )
        }

        if hasManifest && !hasWav {
            findings.append(
                finding(
                    code: "manifest_without_audio",
                    summary: "Session audio is missing.",
                    remediation: "Restore `session.wav` from backup. Transcript details may still be available.",
                    disposition: .recoverable,
                    diagnostics: [
                        "manifest_path": manifestURL.path,
                        "wav_path": wavURL.path
                    ]
                )
            )
        }

        if hasManifest {
            if let parseError = manifestParseError(at: manifestURL) {
                findings.append(
                    finding(
                        code: "manifest_invalid_json",
                        summary: "Manifest exists but is not valid JSON.",
                        remediation: hasPending && hasWav
                            ? "Use pending-session recovery to rebuild final artifacts."
                            : "Restore a valid manifest from backup.",
                        disposition: hasPending && hasWav ? .recoverable : .terminal,
                        diagnostics: [
                            "manifest_path": manifestURL.path,
                            "error": parseError
                        ]
                    )
                )
            }
        }

        if hasJsonl, let jsonlError = jsonlParseError(at: jsonlURL) {
            findings.append(
                finding(
                    code: "jsonl_corrupt",
                    summary: "Transcript event stream is malformed.",
                    remediation: "Use manifest transcript fallback or rerun transcript reconstruction.",
                    disposition: .recoverable,
                    diagnostics: [
                        "jsonl_path": jsonlURL.path,
                        "error": jsonlError
                    ]
                )
            )
        }

        return report(
            sessionID: resolvedSessionID,
            rootPath: root,
            findings: findings,
            outcomeClassification: outcomeClassification,
            outcomeCode: outcomeCode,
            outcomeDiagnostics: outcomeDiagnostics
        )
    }

    private func report(
        sessionID: String,
        rootPath: URL,
        findings: [ArtifactIntegrityFindingDTO],
        outcomeClassification: SessionOutcomeClassification,
        outcomeCode: SessionOutcomeCode,
        outcomeDiagnostics: [String: String]
    ) -> SessionArtifactIntegrityReportDTO {
        let state: ArtifactIntegrityState
        if findings.isEmpty {
            state = .healthy
        } else if findings.contains(where: { $0.disposition == .terminal }) {
            state = .terminal
        } else {
            state = .recoverable
        }
        return SessionArtifactIntegrityReportDTO(
            sessionID: sessionID,
            rootPath: rootPath,
            state: state,
            findings: findings,
            outcomeClassification: outcomeClassification,
            outcomeCode: outcomeCode,
            outcomeDiagnostics: outcomeDiagnostics
        )
    }

    private func manifestSessionStatus(at manifestURL: URL) -> SessionStatus? {
        do {
            let data = try dataReader(manifestURL)
            guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return nil
            }
            let summary = payload["session_summary"] as? [String: Any]
            let raw = summary?["session_status"] as? String
            let sessionRoot = manifestURL.deletingLastPathComponent()
            let manifest = SessionManifestDTO(
                sessionID: payload["session_id"] as? String ?? sessionRoot.lastPathComponent,
                status: raw ?? SessionStatus.ok.rawValue,
                runtimeMode: payload["runtime_mode"] as? String ?? RuntimeMode.live.rawValue,
                trustNoticeCount: parseTrustNoticeCount(payload),
                artifacts: SessionArtifactsDTO(
                    wavPath: sessionRoot.appendingPathComponent("session.wav"),
                    jsonlPath: sessionRoot.appendingPathComponent("session.jsonl"),
                    manifestPath: manifestURL
                )
            )
            return ManifestFinalStatusMapper().mapStatus(manifest)
        } catch {
            return nil
        }
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

    private func classifySessionOutcome(
        manifestStatus: SessionStatus?,
        hasManifest: Bool,
        hasPending: Bool,
        hasWav: Bool,
        hasJsonl: Bool,
        hasRetryContext: Bool
    ) -> SessionOutcomeClassification {
        if let manifestStatus {
            switch manifestStatus {
            case .failed:
                return .finalizedFailure
            case .ok, .degraded:
                return hasWav ? .finalizedSuccess : .partialArtifact
            case .pending:
                return .partialArtifact
            }
        }

        let hasAnyArtifacts = hasManifest || hasPending || hasRetryContext || hasWav || hasJsonl
        return hasAnyArtifacts ? .partialArtifact : .emptyRoot
    }

    private func outcomeDiagnostics(
        rootPath: URL,
        manifestURL: URL,
        pendingURL: URL,
        retryContextURL: URL,
        wavURL: URL,
        jsonlURL: URL,
        hasManifest: Bool,
        hasPending: Bool,
        hasRetryContext: Bool,
        hasWav: Bool,
        hasJsonl: Bool,
        manifestStatus: SessionStatus?,
        outcomeClassification: SessionOutcomeClassification
    ) -> [String: String] {
        var diagnostics: [String: String] = [
            "root_path": rootPath.path,
            "manifest_path": manifestURL.path,
            "pending_path": pendingURL.path,
            "retry_context_path": retryContextURL.path,
            "wav_path": wavURL.path,
            "jsonl_path": jsonlURL.path,
            "has_manifest": String(hasManifest),
            "has_pending": String(hasPending),
            "has_retry_context": String(hasRetryContext),
            "has_wav": String(hasWav),
            "has_jsonl": String(hasJsonl),
            "outcome_classification": outcomeClassification.rawValue,
            "outcome_code": outcomeClassification.canonicalCode(manifestStatus: manifestStatus).rawValue
        ]
        if let manifestStatus {
            diagnostics["manifest_status"] = manifestStatus.rawValue
        }
        return diagnostics
    }

    private func directoryExists(at url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
            && isDirectory.boolValue
    }

    private func manifestParseError(at manifestURL: URL) -> String? {
        do {
            let data = try dataReader(manifestURL)
            _ = try JSONSerialization.jsonObject(with: data)
            return nil
        } catch {
            return String(describing: error)
        }
    }

    private func jsonlParseError(at jsonlURL: URL) -> String? {
        let raw: String
        do {
            raw = String(decoding: try dataReader(jsonlURL), as: UTF8.self)
        } catch {
            return String(describing: error)
        }

        let lines = raw.split(whereSeparator: \.isNewline)
        for (index, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                continue
            }
            guard let data = trimmed.data(using: .utf8),
                  (try? JSONSerialization.jsonObject(with: data)) != nil else {
                return "invalid JSON at line \(index + 1)"
            }
        }
        return nil
    }

    private func pendingSidecarParseError(at pendingURL: URL) -> String? {
        do {
            let data = try dataReader(pendingURL)
            let sidecar = try JSONDecoder().decode(PendingSessionSidecarDTO.self, from: data)
            if sidecar.sessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return "missing session_id"
            }
            if sidecar.createdAtUTC.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return "missing created_at_utc"
            }
            if Self.parseISO8601(sidecar.createdAtUTC) == nil {
                return "invalid created_at_utc"
            }
            if sidecar.mode != .recordOnly {
                return "invalid mode=\(sidecar.mode.rawValue)"
            }
            let wavPath = sidecar.wavPath.trimmingCharacters(in: .whitespacesAndNewlines)
            if wavPath.isEmpty || !wavPath.hasPrefix("/") {
                return "invalid wav_path"
            }
            return nil
        } catch {
            return String(describing: error)
        }
    }

    private static func parseISO8601(_ value: String) -> Date? {
        if let date = iso8601WithFractionalSeconds.date(from: value) {
            return date
        }
        return iso8601Basic.date(from: value)
    }

    private static let iso8601WithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601Basic: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private func finding(
        code: String,
        summary: String,
        remediation: String,
        disposition: ArtifactIntegrityDisposition,
        diagnostics: [String: String]
    ) -> ArtifactIntegrityFindingDTO {
        ArtifactIntegrityFindingDTO(
            code: code,
            summary: summary,
            remediation: remediation,
            disposition: disposition,
            diagnostics: diagnostics
        )
    }
}
