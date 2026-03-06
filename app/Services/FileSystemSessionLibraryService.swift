import Foundation

public struct FileSystemSessionLibraryService: SessionLibraryService {
    public typealias SessionsRootProvider = @Sendable () throws -> URL
    public typealias TrashItemHandler = @Sendable (URL) throws -> URL?
    public typealias ModelAvailabilityProvider = @Sendable () -> Bool

    private static let defaultSessionsRootProvider: SessionsRootProvider = {
        try Self.defaultSessionsRoot()
    }
    private static let defaultTrashItemHandler: TrashItemHandler = { sourceURL in
        var resultingURL: NSURL?
        try FileManager.default.trashItem(at: sourceURL, resultingItemURL: &resultingURL)
        return resultingURL as URL?
    }
    private static let transcriptIndex = SessionTranscriptSearchIndex()

    private let sessionsRootProvider: SessionsRootProvider
    private let trashItemHandler: TrashItemHandler
    private let pendingSidecarService: any PendingSessionSidecarService
    private let pendingTransitionService: PendingSessionTransitionService
    private let modelAvailabilityProvider: ModelAvailabilityProvider

    public init() {
        self.sessionsRootProvider = Self.defaultSessionsRootProvider
        self.trashItemHandler = Self.defaultTrashItemHandler
        self.pendingSidecarService = FileSystemPendingSessionSidecarService()
        self.pendingTransitionService = PendingSessionTransitionService()
        self.modelAvailabilityProvider = { Self.defaultModelAvailable() }
    }

    public init(
        sessionsRootProvider: @escaping SessionsRootProvider,
        trashItemHandler: TrashItemHandler? = nil,
        pendingSidecarService: any PendingSessionSidecarService = FileSystemPendingSessionSidecarService(),
        pendingTransitionService: PendingSessionTransitionService = PendingSessionTransitionService(),
        modelAvailabilityProvider: ModelAvailabilityProvider? = nil
    ) {
        self.sessionsRootProvider = sessionsRootProvider
        self.trashItemHandler = trashItemHandler ?? Self.defaultTrashItemHandler
        self.pendingSidecarService = pendingSidecarService
        self.pendingTransitionService = pendingTransitionService
        self.modelAvailabilityProvider = modelAvailabilityProvider ?? { Self.defaultModelAvailable() }
    }

    public func listSessions(query: SessionQuery) throws -> [SessionSummaryDTO] {
        let sessionsRoot = try sessionsRootProvider().standardizedFileURL
        let fileManager = FileManager.default
        let modelAvailable = modelAvailabilityProvider()
        guard Self.directoryExists(at: sessionsRoot, fileManager: fileManager) else {
            return []
        }

        let sessionDirectories = try Self.discoverSessionDirectories(
            under: sessionsRoot,
            fileManager: fileManager
        )
        var indexed = sessionDirectories.compactMap {
            indexSession(
                at: $0,
                fileManager: fileManager,
                modelAvailable: modelAvailable
            )
        }
        var dedupeTokens = Set(indexed.flatMap(Self.dedupeKeys(for:)))
        let legacyFlatArtifacts = try Self.discoverLegacyFlatArtifactSets(
            under: sessionsRoot,
            fileManager: fileManager
        )
        var importedLegacyCount = 0
        var skippedLegacyDuplicateCount = 0
        for artifactSet in legacyFlatArtifacts {
            if let summary = indexLegacyFlatSession(
                sessionsRoot: sessionsRoot,
                artifactSet: artifactSet,
                dedupeTokens: &dedupeTokens,
                modelAvailable: modelAvailable
            ) {
                indexed.append(summary)
                importedLegacyCount += 1
            } else {
                skippedLegacyDuplicateCount += 1
            }
        }
        Self.logLegacyImportOutcome(
            sessionsRoot: sessionsRoot,
            discoveredCount: legacyFlatArtifacts.count,
            importedCount: importedLegacyCount,
            skippedDuplicateCount: skippedLegacyDuplicateCount
        )
        let sorted = indexed.sorted(by: Self.deterministicNewestFirst)
        let statusAndModeFiltered = sorted.filter {
            Self.matchesStatusAndMode($0, query: query)
        }

        guard let searchText = Self.normalizedSearchText(query.searchText) else {
            return statusAndModeFiltered
        }

        let transcriptMatches = Self.transcriptIndex.searchSessionPaths(
            sessions: statusAndModeFiltered,
            query: searchText,
            fileManager: fileManager
        )
        return statusAndModeFiltered.filter { item in
            Self.matchesMetadataSearch(item, normalizedText: searchText)
                || transcriptMatches.contains(item.rootPath.standardizedFileURL.path)
        }
    }

    public func deleteSession(
        sessionID: String,
        rootPath: URL,
        confirmTrash: Bool
    ) throws -> SessionDeletionResultDTO {
        guard confirmTrash else {
            throw AppServiceError(
                code: .invalidInput,
                userMessage: "Session deletion requires confirmation.",
                remediation: "Confirm deletion before moving the session to Trash."
            )
        }

        let sourceURL = rootPath.standardizedFileURL
        let fileManager = FileManager.default
        guard Self.directoryExists(at: sourceURL, fileManager: fileManager) else {
            throw AppServiceError(
                code: .artifactMissing,
                userMessage: "Session folder was not found.",
                remediation: "Refresh sessions and retry deletion."
            )
        }

        do {
            let trashedURL = try trashItemHandler(sourceURL)?.standardizedFileURL
            let resolvedSessionID = sessionID.isEmpty ? sourceURL.lastPathComponent : sessionID
            return SessionDeletionResultDTO(
                sessionID: resolvedSessionID,
                originalRootPath: sourceURL,
                trashedRootPath: trashedURL,
                didMoveToTrash: true
            )
        } catch {
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Couldn't move the session to Trash.",
                remediation: "Close anything using this session folder, then retry.",
                debugDetail: String(describing: error)
            )
        }
    }

    // Mirrors the canonical app-managed root policy:
    // ~/Library/Containers/com.recordit.sequoiatranscribe/Data/artifacts/packaged-beta/sessions/
    public static func defaultSessionsRoot() throws -> URL {
        let env = ProcessInfo.processInfo.environment
        let dataRootURL: URL
        if let override = env["RECORDIT_CONTAINER_DATA_ROOT"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            let overrideURL = URL(fileURLWithPath: override)
            guard overrideURL.path.hasPrefix("/") else {
                throw AppServiceError(
                    code: .invalidInput,
                    userMessage: "Storage root override is invalid.",
                    remediation: "Set RECORDIT_CONTAINER_DATA_ROOT to an absolute path."
                )
            }
            dataRootURL = overrideURL
        } else {
            guard let home = env["HOME"], !home.isEmpty else {
                throw AppServiceError(
                    code: .ioFailure,
                    userMessage: "Could not resolve the app storage root.",
                    remediation: "Ensure HOME is available, then retry."
                )
            }
            dataRootURL = URL(fileURLWithPath: home)
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Containers", isDirectory: true)
                .appendingPathComponent("com.recordit.sequoiatranscribe", isDirectory: true)
                .appendingPathComponent("Data", isDirectory: true)
        }

        return dataRootURL
            .appendingPathComponent("artifacts", isDirectory: true)
            .appendingPathComponent("packaged-beta", isDirectory: true)
            .appendingPathComponent("sessions", isDirectory: true)
    }

    private static func discoverSessionDirectories(
        under sessionsRoot: URL,
        fileManager: FileManager
    ) throws -> [URL] {
        let children = try fileManager.contentsOfDirectory(
            at: sessionsRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        var candidates: [URL] = []

        for child in children.sorted(by: { $0.path < $1.path }) {
            guard isDirectory(child, fileManager: fileManager) else { continue }
            if looksLikeSessionDirectory(child, fileManager: fileManager) {
                candidates.append(child)
                continue
            }
            let nested = try fileManager.contentsOfDirectory(
                at: child,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
            let nestedCandidates = nested
                .filter { isDirectory($0, fileManager: fileManager) }
                .filter { looksLikeSessionDirectory($0, fileManager: fileManager) }
                .sorted(by: { $0.path < $1.path })
            candidates.append(contentsOf: nestedCandidates)
        }
        return candidates
    }

    private func indexSession(
        at sessionRoot: URL,
        fileManager: FileManager,
        modelAvailable: Bool
    ) -> SessionSummaryDTO? {
        let manifestURL = sessionRoot.appendingPathComponent("session.manifest.json")
        let pendingURL = sessionRoot.appendingPathComponent("session.pending.json")
        let retryContextURL = sessionRoot.appendingPathComponent("session.pending.retry.json")
        let wavURL = sessionRoot.appendingPathComponent("session.wav")
        let jsonlURL = sessionRoot.appendingPathComponent("session.jsonl")

        let manifest = Self.parseManifest(at: manifestURL)
        let pending = loadPendingSidecar(
            at: pendingURL,
            sessionRoot: sessionRoot,
            wavURL: wavURL,
            modelAvailable: modelAvailable
        )
        let hasManifest = fileManager.fileExists(atPath: manifestURL.path)
        let hasWav = fileManager.fileExists(atPath: wavURL.path)
        let hasJsonl = fileManager.fileExists(atPath: jsonlURL.path)
        let hasPendingFile = fileManager.fileExists(atPath: pendingURL.path)
        let hasRetryContext = fileManager.fileExists(atPath: retryContextURL.path)
        let hasKnownArtifacts = hasManifest || hasPendingFile || hasWav || hasJsonl || hasRetryContext
        guard manifest != nil
            || hasKnownArtifacts
            || Self.resemblesSessionDirectoryName(sessionRoot.lastPathComponent)
        else {
            return nil
        }

        let outcomeClassification = Self.classifySessionOutcome(
            manifestStatus: manifest?.status,
            hasManifest: hasManifest,
            hasPending: hasPendingFile,
            hasWav: hasWav,
            hasJsonl: hasJsonl,
            hasRetryContext: hasRetryContext
        )
        let outcomeDiagnostics = Self.outcomeDiagnostics(
            rootPath: sessionRoot,
            manifestURL: manifestURL,
            pendingURL: pendingURL,
            retryContextURL: retryContextURL,
            wavURL: wavURL,
            jsonlURL: jsonlURL,
            hasManifest: hasManifest,
            hasPending: hasPendingFile,
            hasWav: hasWav,
            hasJsonl: hasJsonl,
            hasRetryContext: hasRetryContext,
            manifestStatus: manifest?.status,
            pendingState: pending?.transcriptionState,
            outcomeClassification: outcomeClassification
        )

        let sessionID = manifest?.sessionID ?? pending?.sessionID ?? sessionRoot.lastPathComponent
        let mode = manifest?.mode ?? pending?.mode ?? Self.inferMode(from: sessionRoot.lastPathComponent)
        let status = Self.resolveStatus(
            manifestStatus: manifest?.status,
            pending: pending,
            outcomeClassification: outcomeClassification
        )
        let durationMs = manifest?.durationMs ?? 0
        let startedAt = manifest?.startedAt
            ?? pending.flatMap { Self.parseISO8601($0.createdAtUTC) }
            ?? Self.inferTimestampFromPath(sessionRoot)
            ?? Date(timeIntervalSince1970: 0)
        let pendingState = pending?.transcriptionState

        return SessionSummaryDTO(
            sessionID: sessionID,
            startedAt: startedAt,
            durationMs: durationMs,
            mode: mode,
            status: status,
            rootPath: sessionRoot.standardizedFileURL,
            pendingTranscriptionState: pendingState,
            readyToTranscribe: pendingState.map(pendingTransitionService.isReadyToTranscribe) ?? false,
            ingestSource: .canonicalDirectory,
            outcomeClassification: outcomeClassification,
            outcomeCode: outcomeClassification.canonicalCode(manifestStatus: status),
            outcomeDiagnostics: outcomeDiagnostics
        )
    }

    private func indexLegacyFlatSession(
        sessionsRoot: URL,
        artifactSet: LegacyFlatArtifactSet,
        dedupeTokens: inout Set<String>,
        modelAvailable: Bool
    ) -> SessionSummaryDTO? {
        let manifest = artifactSet.manifestURL.flatMap(Self.parseManifest(at:))
        let pending = loadLegacyPendingSidecar(at: artifactSet.pendingURL, modelAvailable: modelAvailable)
        let sessionID = manifest?.sessionID ?? pending?.sessionID ?? artifactSet.stem
        let candidateDedupeTokens = Self.dedupeKeys(sessionID: sessionID, stem: artifactSet.stem)
        guard dedupeTokens.isDisjoint(with: candidateDedupeTokens) else {
            return nil
        }
        dedupeTokens.formUnion(candidateDedupeTokens)

        let mode = manifest?.mode ?? pending?.mode ?? Self.inferMode(from: artifactSet.stem)
        let outcomeClassification = Self.classifySessionOutcome(
            manifestStatus: manifest?.status,
            hasManifest: artifactSet.manifestURL != nil,
            hasPending: artifactSet.pendingURL != nil,
            hasWav: artifactSet.preferredAudioURL != nil,
            hasJsonl: artifactSet.jsonlURL != nil,
            hasRetryContext: false
        )
        let status = Self.resolveStatus(
            manifestStatus: manifest?.status,
            pending: pending,
            outcomeClassification: outcomeClassification
        )
        let durationMs = manifest?.durationMs ?? 0
        let startedAt = manifest?.startedAt
            ?? pending.flatMap { Self.parseISO8601($0.createdAtUTC) }
            ?? Self.inferTimestampFromStem(artifactSet.stem)
            ?? Date(timeIntervalSince1970: 0)
        let pendingState = pending?.transcriptionState

        return SessionSummaryDTO(
            sessionID: sessionID,
            startedAt: startedAt,
            durationMs: durationMs,
            mode: mode,
            status: status,
            rootPath: sessionsRoot
                .appendingPathComponent(artifactSet.stem, isDirectory: true)
                .standardizedFileURL,
            pendingTranscriptionState: pendingState,
            readyToTranscribe: pendingState.map(pendingTransitionService.isReadyToTranscribe) ?? false,
            ingestSource: .legacyFlatImport,
            ingestDiagnostics: Self.legacyIngestDiagnostics(artifactSet: artifactSet),
            outcomeClassification: outcomeClassification,
            outcomeCode: outcomeClassification.canonicalCode(manifestStatus: manifest?.status),
            outcomeDiagnostics: Self.legacyOutcomeDiagnostics(
                sessionsRoot: sessionsRoot,
                artifactSet: artifactSet,
                manifestStatus: manifest?.status,
                pendingState: pending?.transcriptionState,
                outcomeClassification: outcomeClassification
            )
        )
    }

    private static func parseManifest(at manifestURL: URL) -> IndexedManifest? {
        guard let data = try? readData(at: manifestURL),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        let summary = payload["session_summary"] as? [String: Any]
        let statusRaw = summary?["session_status"] as? String
        let durationSec = (summary?["duration_sec"] as? NSNumber)?.doubleValue
        let startedAt = parseISO8601(payload["generated_at_utc"] as? String)
        let modeRaw = payload["runtime_mode"] as? String
        let sessionID = payload["session_id"] as? String
        let sessionRoot = manifestURL.deletingLastPathComponent()
        let manifest = SessionManifestDTO(
            sessionID: sessionID ?? sessionRoot.lastPathComponent,
            status: statusRaw ?? SessionStatus.ok.rawValue,
            runtimeMode: modeRaw ?? RuntimeMode.live.rawValue,
            trustNoticeCount: parseTrustNoticeCount(payload),
            artifacts: SessionArtifactsDTO(
                wavPath: sessionRoot.appendingPathComponent("session.wav"),
                jsonlPath: sessionRoot.appendingPathComponent("session.jsonl"),
                manifestPath: manifestURL
            )
        )

        return IndexedManifest(
            sessionID: sessionID,
            startedAt: startedAt,
            mode: runtimeMode(from: modeRaw),
            status: ManifestFinalStatusMapper().mapStatus(manifest),
            durationMs: durationSec.map { UInt64(max($0, 0) * 1000) } ?? 0
        )
    }

    private func loadPendingSidecar(
        at pendingURL: URL,
        sessionRoot: URL,
        wavURL: URL,
        modelAvailable: Bool
    ) -> PendingSessionSidecarDTO? {
        guard let loaded = try? pendingSidecarService.loadPendingSidecar(at: pendingURL) else {
            return nil
        }

        guard let reconciledState = try? pendingTransitionService.reconcileReadiness(
            current: loaded.transcriptionState,
            modelAvailable: modelAvailable
        ) else {
            return loaded
        }

        guard reconciledState != loaded.transcriptionState else {
            return loaded
        }

        let createdAt = Self.parseISO8601(loaded.createdAtUTC) ?? Date(timeIntervalSince1970: 0)
        let writeRequest = PendingSessionSidecarWriteRequest(
            sessionID: loaded.sessionID,
            sessionRoot: sessionRoot,
            wavPath: wavURL,
            createdAt: createdAt,
            mode: .recordOnly,
            transcriptionState: reconciledState
        )
        return (try? pendingSidecarService.writePendingSidecar(writeRequest)) ?? PendingSessionSidecarDTO(
            sessionID: loaded.sessionID,
            createdAtUTC: loaded.createdAtUTC,
            wavPath: loaded.wavPath,
            mode: loaded.mode,
            transcriptionState: reconciledState
        )
    }

    private func loadLegacyPendingSidecar(
        at pendingURL: URL?,
        modelAvailable: Bool
    ) -> PendingSessionSidecarDTO? {
        guard let pendingURL,
              let loaded = try? pendingSidecarService.loadPendingSidecar(at: pendingURL) else {
            return nil
        }
        guard let reconciledState = try? pendingTransitionService.reconcileReadiness(
            current: loaded.transcriptionState,
            modelAvailable: modelAvailable
        ) else {
            return loaded
        }
        guard reconciledState != loaded.transcriptionState else {
            return loaded
        }
        return PendingSessionSidecarDTO(
            sessionID: loaded.sessionID,
            createdAtUTC: loaded.createdAtUTC,
            wavPath: loaded.wavPath,
            mode: loaded.mode,
            transcriptionState: reconciledState
        )
    }

    private static func deterministicNewestFirst(lhs: SessionSummaryDTO, rhs: SessionSummaryDTO) -> Bool {
        if lhs.startedAt != rhs.startedAt {
            return lhs.startedAt > rhs.startedAt
        }
        if lhs.sessionID != rhs.sessionID {
            return lhs.sessionID < rhs.sessionID
        }
        return lhs.rootPath.path < rhs.rootPath.path
    }

    private static func matchesStatusAndMode(_ item: SessionSummaryDTO, query: SessionQuery) -> Bool {
        if let status = query.status, item.status != status {
            return false
        }
        if let mode = query.mode, item.mode != mode {
            return false
        }
        return true
    }

    private static func normalizedSearchText(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        return text.lowercased()
    }

    private static func matchesMetadataSearch(_ item: SessionSummaryDTO, normalizedText: String) -> Bool {
        let haystack = [
            item.sessionID,
            item.rootPath.lastPathComponent,
            ISO8601DateFormatter().string(from: item.startedAt)
        ].joined(separator: " ").lowercased()
        return haystack.contains(normalizedText)
    }

    private static func inferMode(from sessionDirectoryName: String) -> RuntimeMode {
        let slug = sessionDirectoryName.lowercased()
        if slug.contains("record-only") || slug.contains("record_only") {
            return .recordOnly
        }
        if slug.contains("live") {
            return .live
        }
        return .offline
    }

    private static func runtimeMode(from raw: String?) -> RuntimeMode {
        guard let raw else { return .offline }
        switch raw.lowercased() {
        case "record_only", "record-only":
            return .recordOnly
        case let value where value.contains("live"):
            return .live
        default:
            return .offline
        }
    }

    private static func sessionStatus(from raw: String?) -> SessionStatus? {
        guard let raw = raw?.lowercased() else { return nil }
        return SessionStatus(rawValue: raw)
    }

    private static func parseTrustNoticeCount(_ payload: [String: Any]) -> Int {
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

    private static func resolveStatus(
        manifestStatus: SessionStatus?,
        pending: PendingSessionSidecarDTO?,
        outcomeClassification: SessionOutcomeClassification
    ) -> SessionStatus {
        switch outcomeClassification {
        case .finalizedSuccess:
            return manifestStatus ?? pending.map(Self.status(from:)) ?? .ok
        case .partialArtifact:
            if manifestStatus == .pending {
                return .pending
            }
            if manifestStatus == nil, let pending {
                let pendingStatus = Self.status(from: pending)
                return pendingStatus == .pending ? .pending : .failed
            }
            return .failed
        case .finalizedFailure, .emptyRoot:
            return .failed
        }
    }

    private static func classifySessionOutcome(
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

        let hasAnyArtifacts = hasManifest || hasPending || hasWav || hasJsonl || hasRetryContext
        return hasAnyArtifacts ? .partialArtifact : .emptyRoot
    }

    private static func outcomeDiagnostics(
        rootPath: URL,
        manifestURL: URL,
        pendingURL: URL,
        retryContextURL: URL,
        wavURL: URL,
        jsonlURL: URL,
        hasManifest: Bool,
        hasPending: Bool,
        hasWav: Bool,
        hasJsonl: Bool,
        hasRetryContext: Bool,
        manifestStatus: SessionStatus?,
        pendingState: PendingTranscriptionState?,
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
        if let pendingState {
            diagnostics["pending_transcription_state"] = pendingState.rawValue
        }
        return diagnostics
    }

    private static func legacyOutcomeDiagnostics(
        sessionsRoot: URL,
        artifactSet: LegacyFlatArtifactSet,
        manifestStatus: SessionStatus?,
        pendingState: PendingTranscriptionState?,
        outcomeClassification: SessionOutcomeClassification
    ) -> [String: String] {
        let rootPath = sessionsRoot
            .appendingPathComponent(artifactSet.stem, isDirectory: true)
            .standardizedFileURL
        return outcomeDiagnostics(
            rootPath: rootPath,
            manifestURL: artifactSet.manifestURL
                ?? rootPath.appendingPathComponent("session.manifest.json"),
            pendingURL: artifactSet.pendingURL
                ?? rootPath.appendingPathComponent("session.pending.json"),
            retryContextURL: rootPath.appendingPathComponent("session.pending.retry.json"),
            wavURL: artifactSet.preferredAudioURL
                ?? rootPath.appendingPathComponent("session.wav"),
            jsonlURL: artifactSet.jsonlURL
                ?? rootPath.appendingPathComponent("session.jsonl"),
            hasManifest: artifactSet.manifestURL != nil,
            hasPending: artifactSet.pendingURL != nil,
            hasWav: artifactSet.preferredAudioURL != nil,
            hasJsonl: artifactSet.jsonlURL != nil,
            hasRetryContext: false,
            manifestStatus: manifestStatus,
            pendingState: pendingState,
            outcomeClassification: outcomeClassification
        )
    }

    private static func status(from pending: PendingSessionSidecarDTO) -> SessionStatus {
        switch pending.transcriptionState {
        case .pendingModel, .readyToTranscribe, .transcribing:
            return .pending
        case .completed:
            return .ok
        case .failed:
            return .failed
        }
    }

    private static func inferTimestampFromPath(_ sessionRoot: URL) -> Date? {
        let name = sessionRoot.lastPathComponent
        let stamp = String(name.prefix(16))
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return formatter.date(from: stamp)
    }

    private static func inferTimestampFromStem(_ stem: String) -> Date? {
        let pseudoURL = URL(fileURLWithPath: stem)
        return inferTimestampFromPath(pseudoURL)
    }

    private static func dedupeKeys(for session: SessionSummaryDTO) -> Set<String> {
        dedupeKeys(sessionID: session.sessionID, stem: session.rootPath.lastPathComponent)
    }

    private static func dedupeKeys(sessionID: String, stem: String) -> Set<String> {
        var keys = Set<String>()
        if let normalizedID = normalizedDedupeToken(sessionID) {
            keys.insert(normalizedID)
        }
        if let normalizedStem = normalizedDedupeToken(stem) {
            keys.insert(normalizedStem)
        }
        return keys
    }

    private static func normalizedDedupeToken(_ value: String) -> String? {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.isEmpty ? nil : normalized
    }

    private static func discoverLegacyFlatArtifactSets(
        under sessionsRoot: URL,
        fileManager: FileManager
    ) throws -> [LegacyFlatArtifactSet] {
        let children = try fileManager.contentsOfDirectory(
            at: sessionsRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        var grouped: [String: LegacyFlatArtifactSet] = [:]
        for child in children.sorted(by: { $0.path < $1.path }) {
            guard !isDirectory(child, fileManager: fileManager),
                  let parsed = parseLegacyFlatArtifactComponent(fileName: child.lastPathComponent) else {
                continue
            }
            var artifactSet = grouped[parsed.stem] ?? LegacyFlatArtifactSet(stem: parsed.stem)
            switch parsed.kind {
            case .manifest:
                artifactSet.manifestURL = child.standardizedFileURL
            case .jsonl:
                artifactSet.jsonlURL = child.standardizedFileURL
            case .wav:
                artifactSet.wavURL = child.standardizedFileURL
            case .inputWav:
                artifactSet.inputWavURL = child.standardizedFileURL
            case .pending:
                artifactSet.pendingURL = child.standardizedFileURL
            }
            grouped[parsed.stem] = artifactSet
        }
        return grouped.values
            .filter(\.hasRequiredArtifacts)
            .sorted(by: { $0.stem < $1.stem })
    }

    private static func parseLegacyFlatArtifactComponent(
        fileName: String
    ) -> (stem: String, kind: LegacyFlatArtifactKind)? {
        let orderedSuffixes: [(suffix: String, kind: LegacyFlatArtifactKind)] = [
            (".manifest.json", .manifest),
            (".pending.json", .pending),
            (".input.wav", .inputWav),
            (".wav", .wav),
            (".jsonl", .jsonl)
        ]

        for item in orderedSuffixes where fileName.hasSuffix(item.suffix) {
            let stem = String(fileName.dropLast(item.suffix.count))
            guard !stem.isEmpty else { return nil }
            return (stem, item.kind)
        }
        return nil
    }

    private static func legacyIngestDiagnostics(artifactSet: LegacyFlatArtifactSet) -> [String: String] {
        var diagnostics: [String: String] = [
            "ingest_source": SessionIngestSource.legacyFlatImport.rawValue,
            "legacy_stem": artifactSet.stem
        ]
        if let manifestURL = artifactSet.manifestURL {
            diagnostics["legacy_manifest_path"] = manifestURL.path
        }
        if let pendingURL = artifactSet.pendingURL {
            diagnostics["legacy_pending_path"] = pendingURL.path
        }
        if let wavURL = artifactSet.preferredAudioURL {
            diagnostics["legacy_wav_path"] = wavURL.path
        }
        if let jsonlURL = artifactSet.jsonlURL {
            diagnostics["legacy_jsonl_path"] = jsonlURL.path
        }
        return diagnostics
    }

    private static func logLegacyImportOutcome(
        sessionsRoot: URL,
        discoveredCount: Int,
        importedCount: Int,
        skippedDuplicateCount: Int
    ) {
        guard discoveredCount > 0 else { return }
        fputs(
            "[session-library] legacy-flat ingest root=\(sessionsRoot.path) discovered=\(discoveredCount) imported=\(importedCount) skipped_duplicates=\(skippedDuplicateCount)\n",
            stderr
        )
    }

    private static func parseISO8601(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: value)
    }

    private static func defaultModelAvailable() -> Bool {
        let environment = ProcessInfo.processInfo.environment
        let fileManager = FileManager.default

        if let explicit = environment["RECORDIT_ASR_MODEL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !explicit.isEmpty {
            let explicitURL = URL(fileURLWithPath: explicit).standardizedFileURL
            return fileManager.fileExists(atPath: explicitURL.path)
        }

        let dataRootURL: URL
        if let override = environment["RECORDIT_CONTAINER_DATA_ROOT"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            dataRootURL = URL(fileURLWithPath: override).standardizedFileURL
        } else if let home = environment["HOME"], !home.isEmpty {
            dataRootURL = URL(fileURLWithPath: home)
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Containers", isDirectory: true)
                .appendingPathComponent("com.recordit.sequoiatranscribe", isDirectory: true)
                .appendingPathComponent("Data", isDirectory: true)
        } else {
            return false
        }

        let modelsRoot = dataRootURL.appendingPathComponent("models", isDirectory: true)
        guard directoryExists(at: modelsRoot, fileManager: fileManager),
              let entries = try? fileManager.contentsOfDirectory(
                  at: modelsRoot,
                  includingPropertiesForKeys: nil,
                  options: [.skipsHiddenFiles]
              ) else {
            return false
        }
        return !entries.isEmpty
    }

    private static func directoryExists(at url: URL, fileManager: FileManager) -> Bool {
        var isDirectory: ObjCBool = false
        return fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private static func looksLikeSessionDirectory(_ url: URL, fileManager: FileManager) -> Bool {
        hasKnownSessionArtifacts(at: url, fileManager: fileManager)
            || resemblesSessionDirectoryName(url.lastPathComponent)
    }

    private static func hasKnownSessionArtifacts(at url: URL, fileManager: FileManager) -> Bool {
        fileManager.fileExists(atPath: url.appendingPathComponent("session.manifest.json").path)
            || fileManager.fileExists(atPath: url.appendingPathComponent("session.pending.json").path)
            || fileManager.fileExists(atPath: url.appendingPathComponent("session.pending.retry.json").path)
            || fileManager.fileExists(atPath: url.appendingPathComponent("session.wav").path)
            || fileManager.fileExists(atPath: url.appendingPathComponent("session.jsonl").path)
    }

    private static func resemblesSessionDirectoryName(_ name: String) -> Bool {
        inferTimestampFromStem(name) != nil
    }

    private static func isDirectory(_ url: URL, fileManager: FileManager) -> Bool {
        directoryExists(at: url, fileManager: fileManager)
    }

    private static func readData(at url: URL) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        return try handle.readToEnd() ?? Data()
    }
}

private struct IndexedManifest {
    var sessionID: String?
    var startedAt: Date?
    var mode: RuntimeMode
    var status: SessionStatus
    var durationMs: UInt64
}

private enum LegacyFlatArtifactKind {
    case manifest
    case pending
    case inputWav
    case wav
    case jsonl
}

private struct LegacyFlatArtifactSet {
    var stem: String
    var manifestURL: URL?
    var pendingURL: URL?
    var wavURL: URL?
    var inputWavURL: URL?
    var jsonlURL: URL?

    var preferredAudioURL: URL? {
        wavURL ?? inputWavURL
    }

    var hasRequiredArtifacts: Bool {
        preferredAudioURL != nil && (manifestURL != nil || pendingURL != nil || jsonlURL != nil)
    }
}
