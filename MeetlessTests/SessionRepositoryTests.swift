import XCTest
@testable import Meetless

final class SessionRepositoryTests: XCTestCase {
    override func tearDown() {
        SessionRepository.testForcedTranscriptSnapshotFailureOverride = nil
        SessionRepository.testForcedGeneratedNotesWriteFailureOverride = nil
        super.tearDown()
    }

    func testPublicLogRedactionUsesSessionIdentifierInsteadOfAbsolutePath() {
        let sessionDirectory = URL(
            fileURLWithPath: "/Users/tester/Library/Application Support/Meetless/Sessions/abc123-session",
            isDirectory: true
        )

        let redactedValue = PublicLogRedaction.sessionIdentifier(for: sessionDirectory)

        XCTAssertEqual(redactedValue, "abc123-session")
        XCTAssertFalse(redactedValue.contains("/Users/tester/Library"))
        XCTAssertFalse(redactedValue.contains("Application Support"))
    }

    func testPublicLogRedactionUsesContainerLabelInsteadOfAbsoluteStoragePath() {
        let storageRoot = URL(
            fileURLWithPath: "/Users/tester/Library/Application Support/Meetless/Sessions",
            isDirectory: true
        )

        let redactedValue = PublicLogRedaction.storageRootLabel(for: storageRoot)

        XCTAssertEqual(redactedValue, "Meetless.Sessions")
        XCTAssertFalse(redactedValue.contains("/Users/tester/Library"))
        XCTAssertFalse(redactedValue.contains("Application Support"))
    }

    func testFinalizeSessionPersistsDegradedSourceWarnings() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let initialChunks = [
            MeetlessTestSupport.makeChunk(
                source: .meeting,
                text: "Committed transcript before stop.",
                sequenceNumber: 1
            )
        ]

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane was healthy at start.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Me lane was healthy at start.", state: .monitoring)
            ],
            transcriptChunks: initialChunks,
            startedAt: Date(timeIntervalSince1970: 100)
        )

        _ = try await repository.finalizeSession(
            session,
            sourceStatuses: [
                SourcePipelineStatus(
                    source: .meeting,
                    detail: "Meeting transcript coverage became partial after Meetless dropped a retry-exhausted window.",
                    state: .degraded
                ),
                SourcePipelineStatus(source: .me, detail: "Me lane stayed healthy through stop.", state: .ready)
            ],
            transcriptChunks: initialChunks,
            endedAt: Date(timeIntervalSince1970: 160),
            status: .completed
        )

        let detail = try await repository.loadSavedSessionDetail(at: session.directoryURL)
        let meetingSourceStatus = try XCTUnwrap(detail.sourceStatuses.first { $0.source == .meeting })

        XCTAssertEqual(detail.status.rawValue, PersistedSessionStatus.completed.rawValue)
        XCTAssertEqual(meetingSourceStatus.state, .degraded)
        XCTAssertTrue(
            detail.savedSessionNotices.contains(where: {
                $0.title == "Meeting source degraded"
                    && $0.message.contains("retry-exhausted window")
            }),
            "Expected the saved-session honesty markers to preserve the degraded Meeting source."
        )
    }

    func testForcedSnapshotFailureLeavesPreviousTranscriptVisibleAndHonestWarningMarkers() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositorySnapshotTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let initialChunks = [
            MeetlessTestSupport.makeChunk(
                source: .meeting,
                text: "Visible transcript at record time.",
                sequenceNumber: 1
            )
        ]
        let newerChunks = [
            initialChunks[0],
            MeetlessTestSupport.makeChunk(
                source: .me,
                text: "Later live text that should not silently replace the saved snapshot.",
                sequenceNumber: 2,
                startFrameIndex: 16_000,
                endFrameIndex: 32_000
            )
        ]

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is healthy.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Me lane is healthy.", state: .monitoring)
            ],
            transcriptChunks: initialChunks,
            startedAt: Date(timeIntervalSince1970: 200)
        )

        SessionRepository.testForcedTranscriptSnapshotFailureOverride = true
        let issue = try await repository.finalizeSession(
            session,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane finished cleanly.", state: .ready),
                SourcePipelineStatus(source: .me, detail: "Me lane finished cleanly.", state: .ready)
            ],
            transcriptChunks: newerChunks,
            endedAt: Date(timeIntervalSince1970: 260),
            status: .completed
        )

        let detail = try await repository.loadSavedSessionDetail(at: session.directoryURL)
        let snapshotWarning = try XCTUnwrap(detail.transcriptSnapshotWarning)

        XCTAssertNotNil(issue)
        XCTAssertFalse(detail.transcriptSnapshotMatchesCommittedTimeline)
        XCTAssertEqual(detail.transcriptChunks.count, 1)
        XCTAssertEqual(detail.transcriptChunks.first?.text, initialChunks.first?.text)
        XCTAssertTrue(snapshotWarning.contains("transcript.json aligned"))
        XCTAssertTrue(
            detail.savedSessionNotices.contains(where: { $0.id == "transcript-snapshot-warning" }),
            "Expected the saved bundle to carry an explicit honesty marker when transcript.json falls behind."
        )
    }

    func testFinalizeSessionCompressesWAVArtifactsAfterStop() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryCompressionTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Me lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 300)
        )
        try MeetlessTestSupport.writePCM16WaveFile(
            to: session.directoryURL.appendingPathComponent("meeting.wav", isDirectory: false),
            sampleCount: 16_000
        )
        try MeetlessTestSupport.writePCM16WaveFile(
            to: session.directoryURL.appendingPathComponent("me.wav", isDirectory: false),
            sampleCount: 16_000
        )

        _ = try await repository.finalizeSession(
            session,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane finished cleanly.", state: .ready),
                SourcePipelineStatus(source: .me, detail: "Me lane finished cleanly.", state: .ready)
            ],
            transcriptChunks: [],
            endedAt: Date(timeIntervalSince1970: 360),
            status: .completed
        )

        let manifest = try Self.loadManifestDictionary(from: session.manifestURL)
        let artifactFilenames = try Self.audioArtifactFilenames(from: manifest)

        XCTAssertEqual(Set(artifactFilenames), Set(["meeting.m4a", "me.m4a"]))
        XCTAssertEqual(manifest["rawAudioFilesAreDurableSourceOfRecord"] as? Bool, false)
        XCTAssertTrue(FileManager.default.fileExists(atPath: session.directoryURL.appendingPathComponent("meeting.m4a").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: session.directoryURL.appendingPathComponent("me.m4a").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: session.directoryURL.appendingPathComponent("meeting.wav").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: session.directoryURL.appendingPathComponent("me.wav").path))
    }

    func testFinalizeSessionPreservesWAVArtifactsWhenCompressionFails() async throws {
        let repository = SessionRepository(audioCompressor: FailingSessionAudioCompressor())
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryCompressionFailureTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Me lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 400)
        )
        try MeetlessTestSupport.writePCM16WaveFile(
            to: session.directoryURL.appendingPathComponent("meeting.wav", isDirectory: false),
            sampleCount: 16_000
        )

        _ = try await repository.finalizeSession(
            session,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane finished cleanly.", state: .ready),
                SourcePipelineStatus(source: .me, detail: "Me lane finished cleanly.", state: .ready)
            ],
            transcriptChunks: [],
            endedAt: Date(timeIntervalSince1970: 460),
            status: .completed
        )

        let manifest = try Self.loadManifestDictionary(from: session.manifestURL)
        let artifactFilenames = try Self.audioArtifactFilenames(from: manifest)

        XCTAssertEqual(Set(artifactFilenames), Set(["meeting.wav", "me.wav"]))
        XCTAssertEqual(manifest["rawAudioFilesAreDurableSourceOfRecord"] as? Bool, true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: session.directoryURL.appendingPathComponent("meeting.wav").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: session.directoryURL.appendingPathComponent("meeting.m4a").path))
    }

    func testOldSessionLoadsWithoutGeneratedNotes() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryGeneratedNotesAbsentTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Me lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 500)
        )

        let detail = try await repository.loadSavedSessionDetail(at: session.directoryURL)
        let generatedNotes = try await repository.loadGeneratedNotes(for: session)
        let manifest = try Self.loadManifestDictionary(from: session.manifestURL)

        XCTAssertNil(detail.generatedNotes)
        XCTAssertNil(generatedNotes)
        XCTAssertNil(manifest["generatedNotesFilename"])
    }

    func testSavedGeneratedNotesReopenWithHiddenTranscriptAndActionBullets() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryGeneratedNotesSaveTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Me lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 600)
        )

        let notes = Self.makeGeneratedNotes()
        try await repository.saveGeneratedNotes(notes, for: session)

        let detail = try await repository.loadSavedSessionDetail(at: session.directoryURL)
        let reopenedNotes = try XCTUnwrap(detail.generatedNotes)
        let notesFile = session.directoryURL.appendingPathComponent("generated-notes.json", isDirectory: false)
        let notesData = try Data(contentsOf: notesFile)
        let notesJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: notesData) as? [String: Any])

        XCTAssertEqual(reopenedNotes, notes)
        XCTAssertEqual(reopenedNotes.hiddenGeminiTranscript, "Jordan: We agreed to ship the privacy copy first.\nTaylor: I will review the summary panel.")
        XCTAssertEqual(reopenedNotes.summary, "The team aligned on the privacy copy and the first review path.")
        XCTAssertEqual(reopenedNotes.actionItemBullets, [
            "Draft the privacy copy.",
            "Review the summary panel."
        ])
        XCTAssertEqual(notesJSON["hiddenGeminiTranscript"] as? String, notes.hiddenGeminiTranscript)
        XCTAssertEqual(notesJSON["actionItemBullets"] as? [String], notes.actionItemBullets)
    }

    func testGeneratedNotesWriteFailurePreservesExistingBundleAndPriorNotes() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryGeneratedNotesFailureTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Me lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 700)
        )
        let originalNotes = Self.makeGeneratedNotes()
        try await repository.saveGeneratedNotes(originalNotes, for: session)

        let manifestDataBeforeFailure = try Data(contentsOf: session.manifestURL)
        let notesURL = session.directoryURL.appendingPathComponent("generated-notes.json", isDirectory: false)
        let notesDataBeforeFailure = try Data(contentsOf: notesURL)

        SessionRepository.testForcedGeneratedNotesWriteFailureOverride = true
        let replacementNotes = GeneratedSessionNotes(
            generatedAt: Date(timeIntervalSince1970: 800),
            hiddenGeminiTranscript: "This replacement transcript must not be saved.",
            summary: "This replacement summary must not be saved.",
            actionItemBullets: ["Do not persist this bullet."]
        )

        do {
            try await repository.saveGeneratedNotes(replacementNotes, for: session)
            XCTFail("Expected generated-notes write failure to throw.")
        } catch {
            XCTAssertTrue(error is CocoaError)
        }

        let manifestDataAfterFailure = try Data(contentsOf: session.manifestURL)
        let notesDataAfterFailure = try Data(contentsOf: notesURL)
        let reopenedNotes = try await repository.loadGeneratedNotes(for: session)

        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure)
        XCTAssertEqual(notesDataAfterFailure, notesDataBeforeFailure)
        XCTAssertEqual(reopenedNotes, originalNotes)
    }

    private static func loadManifestDictionary(from manifestURL: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: manifestURL)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func audioArtifactFilenames(from manifest: [String: Any]) throws -> [String] {
        let artifacts = try XCTUnwrap(manifest["audioArtifacts"] as? [[String: Any]])
        return artifacts.compactMap { $0["filename"] as? String }
    }

    private static func makeGeneratedNotes() -> GeneratedSessionNotes {
        GeneratedSessionNotes(
            generatedAt: Date(timeIntervalSince1970: 650),
            hiddenGeminiTranscript: "Jordan: We agreed to ship the privacy copy first.\nTaylor: I will review the summary panel.",
            summary: "The team aligned on the privacy copy and the first review path.",
            actionItemBullets: [
                "Draft the privacy copy.",
                "Review the summary panel."
            ]
        )
    }
}

private struct FailingSessionAudioCompressor: SessionAudioCompressing {
    func compressWAVToM4A(from sourceURL: URL, to destinationURL: URL) throws {
        throw CocoaError(.fileWriteUnknown)
    }
}
