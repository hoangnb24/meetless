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

struct PersistedSessionSummary: Identifiable, Sendable {
    let id: String
    let directoryURL: URL
    let title: String
    let startedAt: Date
    let endedAt: Date?
    let durationSeconds: TimeInterval?
    let transcriptPreview: String
    let status: PersistedSessionStatus
    let sourceStatuses: [SourcePipelineStatus]
    let updatedAt: Date

    var isIncomplete: Bool {
        status == .incomplete
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
    let sourceStatuses: [SourcePipelineStatus]
    let updatedAt: Date
    let transcriptSavedAt: Date
    let transcriptChunks: [CommittedTranscriptChunk]

    var isIncomplete: Bool {
        status == .incomplete
    }
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
    let transcriptSnapshotMatchesCommittedTimeline: Bool
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

actor SessionRepository {
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
            sourceStatuses: manifest.sourceStatuses,
            updatedAt: manifest.updatedAt,
            transcriptSavedAt: transcriptSnapshot.savedAt,
            transcriptChunks: transcriptSnapshot.chunks
        )
    }

    func updateTranscriptSnapshot(
        for session: PersistedSessionBundle,
        transcriptChunks: [CommittedTranscriptChunk]
    ) throws {
        let savedAt = Date()
        try writeTranscriptSnapshot(
            SessionTranscriptSnapshot(schemaVersion: 1, savedAt: savedAt, chunks: transcriptChunks),
            to: session
        )

        var manifest = try loadManifest(for: session)
        manifest.transcriptPreview = Self.transcriptPreview(from: transcriptChunks)
        manifest.updatedAt = savedAt
        try writeManifest(manifest, to: session)
    }

    func finalizeSession(
        _ session: PersistedSessionBundle,
        sourceStatuses: [SourcePipelineStatus],
        transcriptChunks: [CommittedTranscriptChunk],
        endedAt: Date = Date(),
        status: PersistedSessionStatus
    ) throws {
        try updateTranscriptSnapshot(for: session, transcriptChunks: transcriptChunks)

        var manifest = try loadManifest(for: session)
        manifest.status = status
        manifest.endedAt = endedAt
        manifest.durationSeconds = max(0, endedAt.timeIntervalSince(session.startedAt))
        manifest.sourceStatuses = sourceStatuses
        manifest.updatedAt = endedAt
        try writeManifest(manifest, to: session)
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
}
