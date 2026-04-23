import Foundation

struct PersistedSessionBundle: Sendable {
    let id: String
    let directoryURL: URL
    let startedAt: Date
    let title: String

    var manifestURL: URL {
        directoryURL.appendingPathComponent("session.json", isDirectory: false)
    }

    var transcriptURL: URL {
        directoryURL.appendingPathComponent("transcript.json", isDirectory: false)
    }
}

enum PersistedSessionStatus: String, Codable, Sendable {
    case completed
    case incomplete
}

enum SavedSessionNoticeSeverity: Equatable, Sendable {
    case info
    case warning
}

struct SavedSessionNotice: Identifiable, Sendable {
    let id: String
    let severity: SavedSessionNoticeSeverity
    let title: String
    let message: String
}

struct PersistedSessionSummary: Identifiable, Sendable {
    let id: String
    let directoryURL: URL
    let title: String
    let startedAt: Date
    let endedAt: Date?
    let durationSeconds: TimeInterval?
    let transcriptPreview: String
    let status: PersistedSessionStatus
    let transcriptSnapshotMatchesCommittedTimeline: Bool
    let transcriptSnapshotWarning: String?
    let sourceStatuses: [SourcePipelineStatus]
    let updatedAt: Date

    var isIncomplete: Bool {
        status == .incomplete
    }

    var savedSessionNotices: [SavedSessionNotice] {
        SavedSessionNoticeFactory.make(
            status: status,
            transcriptSnapshotMatchesCommittedTimeline: transcriptSnapshotMatchesCommittedTimeline,
            transcriptSnapshotWarning: transcriptSnapshotWarning,
            sourceStatuses: sourceStatuses
        )
    }
}

struct PersistedSessionDetail: Identifiable, Sendable {
    let id: String
    let directoryURL: URL
    let title: String
    let startedAt: Date
    let endedAt: Date?
    let durationSeconds: TimeInterval?
    let status: PersistedSessionStatus
    let transcriptSnapshotMatchesCommittedTimeline: Bool
    let transcriptSnapshotWarning: String?
    let sourceStatuses: [SourcePipelineStatus]
    let updatedAt: Date
    let transcriptSavedAt: Date
    let transcriptChunks: [CommittedTranscriptChunk]

    var isIncomplete: Bool {
        status == .incomplete
    }

    var savedSessionNotices: [SavedSessionNotice] {
        SavedSessionNoticeFactory.make(
            status: status,
            transcriptSnapshotMatchesCommittedTimeline: transcriptSnapshotMatchesCommittedTimeline,
            transcriptSnapshotWarning: transcriptSnapshotWarning,
            sourceStatuses: sourceStatuses
        )
    }
}

struct TranscriptSnapshotPersistenceIssue: Equatable, Sendable {
    let title: String
    let message: String
    let latestEvent: String
}

private struct SessionBundleManifest: Codable, Sendable {
    let schemaVersion: Int
    let id: String
    let title: String
    let startedAt: Date
    var endedAt: Date?
    var durationSeconds: TimeInterval?
    var status: PersistedSessionStatus
    var transcriptPreview: String
    let rawAudioFilesAreDurableSourceOfRecord: Bool
    var transcriptSnapshotMatchesCommittedTimeline: Bool
    var transcriptSnapshotWarning: String?
    let transcriptSnapshotFilename: String
    let audioArtifacts: [SessionAudioArtifact]
    var sourceStatuses: [SourcePipelineStatus]
    let appBundleIdentifier: String?
    let appVersion: String?
    let appBuild: String?
    var updatedAt: Date
}

private struct SessionAudioArtifact: Codable, Sendable {
    let source: RecordingSourceKind
    let filename: String
    let isPrimarySourceOfRecord: Bool
}

private struct SessionTranscriptSnapshot: Codable, Sendable {
    let schemaVersion: Int
    let savedAt: Date
    let chunks: [CommittedTranscriptChunk]
}

private enum SavedSessionNoticeFactory {
    static func make(
        status: PersistedSessionStatus,
        transcriptSnapshotMatchesCommittedTimeline: Bool,
        transcriptSnapshotWarning: String?,
        sourceStatuses: [SourcePipelineStatus]
    ) -> [SavedSessionNotice] {
        var notices: [SavedSessionNotice] = []

        if status == .incomplete {
            notices.append(
                SavedSessionNotice(
                    id: "incomplete",
                    severity: .warning,
                    title: "Saved as incomplete",
                    message: "Meetless saved this bundle after recording ended unexpectedly. The transcript shown here is the exact snapshot that was available at stop time."
                )
            )
        }

        if !transcriptSnapshotMatchesCommittedTimeline {
            notices.append(
                SavedSessionNotice(
                    id: "transcript-snapshot-warning",
                    severity: .warning,
                    title: "Saved transcript snapshot fell behind",
                    message: transcriptSnapshotWarning
                        ?? "Meetless could not keep transcript.json aligned with the visible timeline for this bundle. The durable audio artifacts remain intact, but reopening this session may show an older transcript snapshot."
                )
            )
        }

        notices.append(contentsOf: sourceStatuses.compactMap(makeSourceNotice(for:)))

        if notices.isEmpty {
            notices.append(
                SavedSessionNotice(
                    id: "snapshot-note",
                    severity: .info,
                    title: "Saved snapshot note",
                    message: "Meetless shows the transcript snapshot and source markers that were written into this local bundle. If no extra warning markers were saved, the app does not infer them later."
                )
            )
        }

        return notices
    }

    private static func makeSourceNotice(for sourceStatus: SourcePipelineStatus) -> SavedSessionNotice? {
        let title: String

        switch sourceStatus.state {
        case .ready:
            return nil
        case .blocked:
            title = "\(sourceStatus.source.rawValue) source was blocked"
        case .monitoring:
            title = "\(sourceStatus.source.rawValue) source needs review"
        case .degraded:
            title = "\(sourceStatus.source.rawValue) source degraded"
        }

        return SavedSessionNotice(
            id: "source-\(sourceStatus.source.id)-\(sourceStatus.state.rawValue)",
            severity: .warning,
            title: title,
            message: sourceStatus.detail
        )
    }
}

actor SessionRepository {
    private static let forcedSnapshotFailureEnvironmentKey = "MEETLESS_FORCE_TRANSCRIPT_SNAPSHOT_UPDATE_FAILURE"
    static var testForcedTranscriptSnapshotFailureOverride: Bool?

    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
    }

    func beginSessionBundle(
        at directoryURL: URL,
        sourceStatuses: [SourcePipelineStatus],
        transcriptChunks: [CommittedTranscriptChunk],
        startedAt: Date = Date(),
        bundle: Bundle = .main
    ) throws -> PersistedSessionBundle {
        try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true, attributes: nil)

        let session = PersistedSessionBundle(
            id: directoryURL.lastPathComponent.lowercased(),
            directoryURL: directoryURL,
            startedAt: startedAt,
            title: Self.defaultTitle(for: startedAt)
        )

        let now = Date()
        let manifest = SessionBundleManifest(
            schemaVersion: 1,
            id: session.id,
            title: session.title,
            startedAt: session.startedAt,
            endedAt: nil,
            durationSeconds: nil,
            status: .incomplete,
            transcriptPreview: Self.transcriptPreview(from: transcriptChunks),
            rawAudioFilesAreDurableSourceOfRecord: true,
            transcriptSnapshotMatchesCommittedTimeline: true,
            transcriptSnapshotWarning: nil,
            transcriptSnapshotFilename: session.transcriptURL.lastPathComponent,
            audioArtifacts: RecordingSourceKind.allCases.map { source in
                SessionAudioArtifact(
                    source: source,
                    filename: source.artifactFilename,
                    isPrimarySourceOfRecord: true
                )
            },
            sourceStatuses: sourceStatuses,
            appBundleIdentifier: bundle.bundleIdentifier,
            appVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            appBuild: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
            updatedAt: now
        )

        try writeTranscriptSnapshot(
            SessionTranscriptSnapshot(schemaVersion: 1, savedAt: now, chunks: transcriptChunks),
            to: session
        )
        try writeManifest(manifest, to: session)
        return session
    }

    func listSavedSessions() throws -> [PersistedSessionSummary] {
        let sessionsDirectoryURL = try Self.sessionsDirectoryURL(fileManager: fileManager)
        guard fileManager.fileExists(atPath: sessionsDirectoryURL.path) else {
            return []
        }

        let candidateURLs = try fileManager.contentsOfDirectory(
            at: sessionsDirectoryURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )

        let sessions = try candidateURLs.compactMap { directoryURL -> PersistedSessionSummary? in
            let values = try directoryURL.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory == true else {
                return nil
            }

            let manifestURL = directoryURL.appendingPathComponent("session.json", isDirectory: false)
            guard fileManager.fileExists(atPath: manifestURL.path) else {
                return nil
            }

            let session = PersistedSessionBundle(
                id: directoryURL.lastPathComponent.lowercased(),
                directoryURL: directoryURL,
                startedAt: .distantPast,
                title: directoryURL.lastPathComponent
            )
            let manifest = try loadManifest(for: session)

            return PersistedSessionSummary(
                id: manifest.id,
                directoryURL: directoryURL,
                title: manifest.title,
                startedAt: manifest.startedAt,
                endedAt: manifest.endedAt,
                durationSeconds: manifest.durationSeconds,
                transcriptPreview: manifest.transcriptPreview,
                status: manifest.status,
                transcriptSnapshotMatchesCommittedTimeline: manifest.transcriptSnapshotMatchesCommittedTimeline,
                transcriptSnapshotWarning: manifest.transcriptSnapshotWarning,
                sourceStatuses: manifest.sourceStatuses,
                updatedAt: manifest.updatedAt
            )
        }

        return sessions.sorted(by: Self.sort(lhs:rhs:))
    }

    func loadSavedSessionDetail(at directoryURL: URL) throws -> PersistedSessionDetail {
        let session = PersistedSessionBundle(
            id: directoryURL.lastPathComponent.lowercased(),
            directoryURL: directoryURL,
            startedAt: .distantPast,
            title: directoryURL.lastPathComponent
        )
        let manifest = try loadManifest(for: session)
        let transcriptSnapshot = try loadTranscriptSnapshot(for: session)

        return PersistedSessionDetail(
            id: manifest.id,
            directoryURL: directoryURL,
            title: manifest.title,
            startedAt: manifest.startedAt,
            endedAt: manifest.endedAt,
            durationSeconds: manifest.durationSeconds,
            status: manifest.status,
            transcriptSnapshotMatchesCommittedTimeline: manifest.transcriptSnapshotMatchesCommittedTimeline,
            transcriptSnapshotWarning: manifest.transcriptSnapshotWarning,
            sourceStatuses: manifest.sourceStatuses,
            updatedAt: manifest.updatedAt,
            transcriptSavedAt: transcriptSnapshot.savedAt,
            transcriptChunks: transcriptSnapshot.chunks
        )
    }

    func deleteSavedSession(at directoryURL: URL) throws {
        guard fileManager.fileExists(atPath: directoryURL.path) else {
            return
        }

        try fileManager.removeItem(at: directoryURL)
    }

    func updateTranscriptSnapshot(
        for session: PersistedSessionBundle,
        transcriptChunks: [CommittedTranscriptChunk]
    ) throws -> TranscriptSnapshotPersistenceIssue? {
        let savedAt = Date()
        let transcriptSnapshot = SessionTranscriptSnapshot(schemaVersion: 1, savedAt: savedAt, chunks: transcriptChunks)

        do {
            if Self.shouldForceTranscriptSnapshotWriteFailure() {
                throw CocoaError(.fileWriteUnknown)
            }

            try writeTranscriptSnapshot(transcriptSnapshot, to: session)

            var manifest = try loadManifest(for: session)
            manifest.transcriptPreview = Self.transcriptPreview(from: transcriptChunks)
            manifest.transcriptSnapshotMatchesCommittedTimeline = true
            manifest.transcriptSnapshotWarning = nil
            manifest.updatedAt = savedAt
            try writeManifest(manifest, to: session)
            return nil
        } catch {
            let issue = Self.makeTranscriptSnapshotPersistenceIssue(forcedFailure: Self.shouldForceTranscriptSnapshotWriteFailure())
            try markTranscriptSnapshotAsLagging(for: session, issue: issue, updatedAt: savedAt)
            return issue
        }
    }

    func finalizeSession(
        _ session: PersistedSessionBundle,
        sourceStatuses: [SourcePipelineStatus],
        transcriptChunks: [CommittedTranscriptChunk],
        endedAt: Date = Date(),
        status: PersistedSessionStatus
    ) throws -> TranscriptSnapshotPersistenceIssue? {
        let snapshotIssue = try updateTranscriptSnapshot(for: session, transcriptChunks: transcriptChunks)

        var manifest = try loadManifest(for: session)
        manifest.status = status
        manifest.endedAt = endedAt
        manifest.durationSeconds = max(0, endedAt.timeIntervalSince(session.startedAt))
        manifest.sourceStatuses = sourceStatuses
        manifest.updatedAt = endedAt
        try writeManifest(manifest, to: session)
        return snapshotIssue
    }

    private func loadManifest(for session: PersistedSessionBundle) throws -> SessionBundleManifest {
        let data = try Data(contentsOf: session.manifestURL)
        return try decoder.decode(SessionBundleManifest.self, from: data)
    }

    private func loadTranscriptSnapshot(for session: PersistedSessionBundle) throws -> SessionTranscriptSnapshot {
        let data = try Data(contentsOf: session.transcriptURL)
        return try decoder.decode(SessionTranscriptSnapshot.self, from: data)
    }

    private func writeManifest(_ manifest: SessionBundleManifest, to session: PersistedSessionBundle) throws {
        let data = try encoder.encode(manifest)
        try data.write(to: session.manifestURL, options: .atomic)
    }

    private func writeTranscriptSnapshot(
        _ transcriptSnapshot: SessionTranscriptSnapshot,
        to session: PersistedSessionBundle
    ) throws {
        let data = try encoder.encode(transcriptSnapshot)
        try data.write(to: session.transcriptURL, options: .atomic)
    }

    private func markTranscriptSnapshotAsLagging(
        for session: PersistedSessionBundle,
        issue: TranscriptSnapshotPersistenceIssue,
        updatedAt: Date
    ) throws {
        var manifest = try loadManifest(for: session)
        manifest.transcriptSnapshotMatchesCommittedTimeline = false
        manifest.transcriptSnapshotWarning = issue.message
        manifest.updatedAt = updatedAt
        try writeManifest(manifest, to: session)
    }

    private static func defaultTitle(for startedAt: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale.autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("MMM d, h:mm a")
        return "Meeting \(formatter.string(from: startedAt))"
    }

    private static func sessionsDirectoryURL(fileManager: FileManager) throws -> URL {
        guard let applicationSupportURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw SourceAudioPipelineError.missingApplicationSupportDirectory
        }

        return applicationSupportURL
            .appendingPathComponent("Meetless", isDirectory: true)
            .appendingPathComponent("Sessions", isDirectory: true)
    }

    private static func sort(lhs: PersistedSessionSummary, rhs: PersistedSessionSummary) -> Bool {
        if lhs.startedAt != rhs.startedAt {
            return lhs.startedAt > rhs.startedAt
        }

        if lhs.updatedAt != rhs.updatedAt {
            return lhs.updatedAt > rhs.updatedAt
        }

        return lhs.id > rhs.id
    }

    private static func transcriptPreview(from transcriptChunks: [CommittedTranscriptChunk]) -> String {
        let preview = transcriptChunks
            .map(\.text)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard preview.count > 160 else {
            return preview
        }

        return String(preview.prefix(157)) + "..."
    }

    private static func shouldForceTranscriptSnapshotWriteFailure() -> Bool {
        if let testForcedTranscriptSnapshotFailureOverride {
            return testForcedTranscriptSnapshotFailureOverride
        }

        let value = ProcessInfo.processInfo.environment[forcedSnapshotFailureEnvironmentKey]
        return value == "1" || value?.lowercased() == "true"
    }

    private static func makeTranscriptSnapshotPersistenceIssue(forcedFailure: Bool) -> TranscriptSnapshotPersistenceIssue {
        let message = "Meetless could not keep transcript.json aligned with the visible timeline for this bundle. The durable Meeting and Me audio artifacts remain intact, but reopening this session may show an older transcript snapshot."
        let latestEvent: String
        if forcedFailure {
            latestEvent = "Meetless forced a transcript snapshot write failure for review injection, so the saved bundle may now lag behind the live transcript."
        } else {
            latestEvent = "Meetless could not update the saved transcript snapshot, so the bundle may now lag behind the live transcript until a later write succeeds."
        }

        return TranscriptSnapshotPersistenceIssue(
            title: "Saved transcript snapshot fell behind",
            message: message,
            latestEvent: latestEvent
        )
    }
}
