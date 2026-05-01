import AVFoundation
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
    let generatedNotes: GeneratedSessionNotes?

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

struct GeneratedSessionNotes: Equatable, Sendable {
    let generatedAt: Date
    let hiddenGeminiTranscript: String
    let summary: String
    let actionItemBullets: [String]
}

struct SessionAudioArtifactForUpload: Equatable, Identifiable, Sendable {
    let source: RecordingSourceKind
    let fileURL: URL
    let filename: String
    let isPrimarySourceOfRecord: Bool

    var id: RecordingSourceKind { source }
}

struct SessionAudioArtifactsForUpload: Equatable, Sendable {
    let sessionID: String
    let sessionTitle: String
    let artifacts: [SessionAudioArtifactForUpload]
}

enum SessionAudioArtifactResolutionError: LocalizedError, Equatable, Sendable {
    case missingManifestEntry(source: RecordingSourceKind)
    case invalidManifestFilename(source: RecordingSourceKind, filename: String)
    case missingRequiredFile(source: RecordingSourceKind, filename: String, url: URL)

    var errorDescription: String? {
        switch self {
        case .missingManifestEntry(let source):
            return "Saved session is missing the \(Self.sourceName(for: source)) audio artifact entry in session.json."
        case .invalidManifestFilename(let source, let filename):
            return "Saved session has an invalid \(Self.sourceName(for: source)) audio artifact filename: \(filename)."
        case .missingRequiredFile(let source, let filename, _):
            return "Saved session is missing the required \(Self.sourceName(for: source)) audio file: \(filename)."
        }
    }

    private static func sourceName(for source: RecordingSourceKind) -> String {
        switch source {
        case .meeting:
            return "meeting"
        case .me:
            return "microphone"
        }
    }
}

enum GeneratedSessionNotesPersistenceError: LocalizedError, Equatable, Sendable {
    case alreadyExists
    case invalidManifestFilename(String)

    var errorDescription: String? {
        switch self {
        case .alreadyExists:
            return "Generated notes already exist for this saved session."
        case .invalidManifestFilename(let filename):
            return "Saved session has an invalid generated notes filename: \(filename)."
        }
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
    var rawAudioFilesAreDurableSourceOfRecord: Bool
    var transcriptSnapshotMatchesCommittedTimeline: Bool
    var transcriptSnapshotWarning: String?
    let transcriptSnapshotFilename: String
    var generatedNotesFilename: String?
    var audioArtifacts: [SessionAudioArtifact]
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

private struct AudioCompressionOutcome: Sendable {
    let source: RecordingSourceKind
    let filename: String
}

private struct SessionTranscriptSnapshot: Codable, Sendable {
    let schemaVersion: Int
    let savedAt: Date
    let chunks: [CommittedTranscriptChunk]
}

private struct GeneratedSessionNotesSnapshot: Codable, Sendable {
    let schemaVersion: Int
    let generatedAt: Date
    let hiddenGeminiTranscript: String
    let summary: String
    let actionItemBullets: [String]
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
    private static let generatedNotesFilename = "generated-notes.json"
    static var testForcedTranscriptSnapshotFailureOverride: Bool?
    static var testForcedGeneratedNotesWriteFailureOverride: Bool?
    static var testForcedGeneratedNotesManifestReplacementFailureOverride: Bool?

    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let audioCompressor: any SessionAudioCompressing

    init(
        fileManager: FileManager = .default,
        audioCompressor: any SessionAudioCompressing = AVFoundationSessionAudioCompressor()
    ) {
        self.fileManager = fileManager
        self.audioCompressor = audioCompressor

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
            generatedNotesFilename: nil,
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
        let generatedNotes = try loadGeneratedNotes(for: session, manifest: manifest)

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
            transcriptChunks: transcriptSnapshot.chunks,
            generatedNotes: generatedNotes
        )
    }

    func loadGeneratedNotes(for session: PersistedSessionBundle) throws -> GeneratedSessionNotes? {
        let manifest = try loadManifest(for: session)
        return try loadGeneratedNotes(for: session, manifest: manifest)
    }

    func resolveAudioArtifactsForUpload(for session: PersistedSessionBundle) throws -> SessionAudioArtifactsForUpload {
        let manifest = try loadManifest(for: session)
        let artifactsBySource = Dictionary(uniqueKeysWithValues: manifest.audioArtifacts.map { ($0.source, $0) })

        let artifacts = try RecordingSourceKind.allCases.map { source -> SessionAudioArtifactForUpload in
            guard let artifact = artifactsBySource[source] else {
                throw SessionAudioArtifactResolutionError.missingManifestEntry(source: source)
            }

            let fileURL = try validatedAudioArtifactURL(
                filename: artifact.filename,
                source: source,
                in: session
            )
            guard fileManager.fileExists(atPath: fileURL.path) else {
                throw SessionAudioArtifactResolutionError.missingRequiredFile(
                    source: source,
                    filename: artifact.filename,
                    url: fileURL
                )
            }

            return SessionAudioArtifactForUpload(
                source: source,
                fileURL: fileURL,
                filename: artifact.filename,
                isPrimarySourceOfRecord: artifact.isPrimarySourceOfRecord
            )
        }

        return SessionAudioArtifactsForUpload(
            sessionID: manifest.id,
            sessionTitle: manifest.title,
            artifacts: artifacts
        )
    }

    func saveGeneratedNotes(
        _ generatedNotes: GeneratedSessionNotes,
        for session: PersistedSessionBundle
    ) throws {
        var manifest = try loadManifest(for: session)
        let notesURL = session.directoryURL.appendingPathComponent(Self.generatedNotesFilename, isDirectory: false)
        guard manifest.generatedNotesFilename == nil, !fileManager.fileExists(atPath: notesURL.path) else {
            throw GeneratedSessionNotesPersistenceError.alreadyExists
        }

        if Self.shouldForceGeneratedNotesWriteFailure() {
            throw CocoaError(.fileWriteUnknown)
        }

        let snapshot = GeneratedSessionNotesSnapshot(
            schemaVersion: 1,
            generatedAt: generatedNotes.generatedAt,
            hiddenGeminiTranscript: generatedNotes.hiddenGeminiTranscript,
            summary: generatedNotes.summary,
            actionItemBullets: generatedNotes.actionItemBullets
        )
        let notesData = try encoder.encode(snapshot)
        manifest.generatedNotesFilename = Self.generatedNotesFilename
        manifest.updatedAt = generatedNotes.generatedAt
        let manifestData = try encoder.encode(manifest)

        let stagingDirectory = session.directoryURL.appendingPathComponent(
            ".generated-notes-\(UUID().uuidString)",
            isDirectory: true
        )
        let stagedNotesURL = stagingDirectory.appendingPathComponent(Self.generatedNotesFilename, isDirectory: false)
        let stagedManifestURL = stagingDirectory.appendingPathComponent(session.manifestURL.lastPathComponent, isDirectory: false)
        let backupManifestURL = stagingDirectory.appendingPathComponent("session.json.backup", isDirectory: false)

        do {
            try fileManager.createDirectory(at: stagingDirectory, withIntermediateDirectories: true, attributes: nil)
            try notesData.write(to: stagedNotesURL, options: .withoutOverwriting)
            try manifestData.write(to: stagedManifestURL, options: .withoutOverwriting)
            try fileManager.copyItem(at: session.manifestURL, to: backupManifestURL)

            try replaceItem(at: notesURL, with: stagedNotesURL)
            if Self.shouldForceGeneratedNotesManifestReplacementFailure() {
                throw CocoaError(.fileWriteUnknown)
            }
            try replaceItem(at: session.manifestURL, with: stagedManifestURL)
            try? fileManager.removeItem(at: stagingDirectory)
        } catch {
            try? restoreItem(at: session.manifestURL, from: backupManifestURL)
            try? fileManager.removeItem(at: notesURL)
            try? fileManager.removeItem(at: stagingDirectory)
            throw error
        }
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
    ) async throws -> TranscriptSnapshotPersistenceIssue? {
        let snapshotIssue = try updateTranscriptSnapshot(for: session, transcriptChunks: transcriptChunks)

        var manifest = try loadManifest(for: session)
        manifest.status = status
        manifest.endedAt = endedAt
        manifest.durationSeconds = max(0, endedAt.timeIntervalSince(session.startedAt))
        manifest.sourceStatuses = sourceStatuses
        manifest.updatedAt = endedAt
        try writeManifest(manifest, to: session)

        try await compressFinishedAudioArtifacts(for: session)
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

    private func loadGeneratedNotes(
        for session: PersistedSessionBundle,
        manifest: SessionBundleManifest
    ) throws -> GeneratedSessionNotes? {
        guard let generatedNotesFilename = manifest.generatedNotesFilename else {
            return nil
        }
        guard generatedNotesFilename == Self.generatedNotesFilename else {
            throw GeneratedSessionNotesPersistenceError.invalidManifestFilename(generatedNotesFilename)
        }

        let generatedNotesURL = session.directoryURL.appendingPathComponent(Self.generatedNotesFilename, isDirectory: false)
        let data = try Data(contentsOf: generatedNotesURL)
        let snapshot = try decoder.decode(GeneratedSessionNotesSnapshot.self, from: data)

        return GeneratedSessionNotes(
            generatedAt: snapshot.generatedAt,
            hiddenGeminiTranscript: snapshot.hiddenGeminiTranscript,
            summary: snapshot.summary,
            actionItemBullets: snapshot.actionItemBullets
        )
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

    private func replaceItem(at destinationURL: URL, with replacementURL: URL) throws {
        if fileManager.fileExists(atPath: destinationURL.path) {
            _ = try fileManager.replaceItemAt(destinationURL, withItemAt: replacementURL)
        } else {
            try fileManager.moveItem(at: replacementURL, to: destinationURL)
        }
    }

    private func restoreItem(at destinationURL: URL, from backupURL: URL) throws {
        guard fileManager.fileExists(atPath: backupURL.path) else {
            return
        }

        try replaceItem(at: destinationURL, with: backupURL)
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

    private func compressFinishedAudioArtifacts(for session: PersistedSessionBundle) async throws {
        var manifest = try loadManifest(for: session)
        var outcomesBySource: [RecordingSourceKind: AudioCompressionOutcome] = [:]

        for artifact in manifest.audioArtifacts {
            guard artifact.filename.hasSuffix(".wav") else {
                continue
            }

            let sourceURL = session.directoryURL.appendingPathComponent(artifact.filename, isDirectory: false)
            guard fileManager.fileExists(atPath: sourceURL.path) else {
                continue
            }

            let compressedFilename = artifact.source.compressedArtifactFilename
            let compressedURL = session.directoryURL.appendingPathComponent(compressedFilename, isDirectory: false)

            do {
                try audioCompressor.compressWAVToM4A(from: sourceURL, to: compressedURL)
                outcomesBySource[artifact.source] = AudioCompressionOutcome(
                    source: artifact.source,
                    filename: compressedFilename
                )
            } catch {
                try? fileManager.removeItem(at: compressedURL)
            }
        }

        guard !outcomesBySource.isEmpty else {
            return
        }

        manifest.audioArtifacts = manifest.audioArtifacts.map { artifact in
            guard let outcome = outcomesBySource[artifact.source] else {
                return artifact
            }

            return SessionAudioArtifact(
                source: artifact.source,
                filename: outcome.filename,
                isPrimarySourceOfRecord: artifact.isPrimarySourceOfRecord
            )
        }
        manifest.rawAudioFilesAreDurableSourceOfRecord = false
        manifest.updatedAt = Date()
        try writeManifest(manifest, to: session)

        for artifact in manifest.audioArtifacts {
            guard outcomesBySource[artifact.source] != nil else {
                continue
            }

            let originalURL = session.directoryURL.appendingPathComponent(artifact.source.artifactFilename, isDirectory: false)
            try? fileManager.removeItem(at: originalURL)
        }
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

    private func validatedAudioArtifactURL(
        filename: String,
        source: RecordingSourceKind,
        in session: PersistedSessionBundle
    ) throws -> URL {
        guard Self.isSafeSessionFilename(filename) else {
            throw SessionAudioArtifactResolutionError.invalidManifestFilename(source: source, filename: filename)
        }

        let fileExtension = URL(fileURLWithPath: filename).pathExtension.lowercased()
        guard ["m4a", "wav", "wave"].contains(fileExtension) else {
            throw SessionAudioArtifactResolutionError.invalidManifestFilename(source: source, filename: filename)
        }

        let sessionDirectoryURL = session.directoryURL.resolvingSymlinksInPath().standardizedFileURL
        let fileURL = session.directoryURL
            .appendingPathComponent(filename, isDirectory: false)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let sessionPath = sessionDirectoryURL.path.hasSuffix("/") ? sessionDirectoryURL.path : sessionDirectoryURL.path + "/"

        guard fileURL.path.hasPrefix(sessionPath) else {
            throw SessionAudioArtifactResolutionError.invalidManifestFilename(source: source, filename: filename)
        }

        return fileURL
    }

    private static func isSafeSessionFilename(_ filename: String) -> Bool {
        guard !filename.isEmpty else {
            return false
        }

        return filename == URL(fileURLWithPath: filename).lastPathComponent
    }

    private static func shouldForceTranscriptSnapshotWriteFailure() -> Bool {
        if let testForcedTranscriptSnapshotFailureOverride {
            return testForcedTranscriptSnapshotFailureOverride
        }

        let value = ProcessInfo.processInfo.environment[forcedSnapshotFailureEnvironmentKey]
        return value == "1" || value?.lowercased() == "true"
    }

    private static func shouldForceGeneratedNotesWriteFailure() -> Bool {
        if let testForcedGeneratedNotesWriteFailureOverride {
            return testForcedGeneratedNotesWriteFailureOverride
        }

        return false
    }

    private static func shouldForceGeneratedNotesManifestReplacementFailure() -> Bool {
        if let testForcedGeneratedNotesManifestReplacementFailureOverride {
            return testForcedGeneratedNotesManifestReplacementFailureOverride
        }

        return false
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

protocol SessionAudioCompressing: Sendable {
    func compressWAVToM4A(from sourceURL: URL, to destinationURL: URL) throws
}

struct AVFoundationSessionAudioCompressor: SessionAudioCompressing {
    private let bitRate: Int

    init(bitRate: Int = 48_000) {
        self.bitRate = bitRate
    }

    func compressWAVToM4A(from sourceURL: URL, to destinationURL: URL) throws {
        let sourceFile = try AVAudioFile(forReading: sourceURL)
        guard sourceFile.length > 0 else {
            throw CocoaError(.fileReadCorruptFile)
        }

        try FileManager.default.createDirectory(
            at: destinationURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: nil
        )

        if FileManager.default.fileExists(atPath: destinationURL.path) {
            try FileManager.default.removeItem(at: destinationURL)
        }

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sourceFile.fileFormat.sampleRate,
            AVNumberOfChannelsKey: sourceFile.fileFormat.channelCount,
            AVEncoderBitRateKey: bitRate
        ]
        let destinationFile = try AVAudioFile(forWriting: destinationURL, settings: settings)
        let frameCapacity = AVAudioFrameCount(min(max(sourceFile.length, 1), 16_384))

        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: sourceFile.processingFormat,
            frameCapacity: frameCapacity
        ) else {
            throw CocoaError(.fileWriteUnknown)
        }

        while sourceFile.framePosition < sourceFile.length {
            try sourceFile.read(into: buffer)
            guard buffer.frameLength > 0 else {
                break
            }

            try destinationFile.write(from: buffer)
        }
    }
}
