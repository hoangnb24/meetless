import XCTest
@testable import Meetless

final class SessionRepositoryTests: XCTestCase {
    override func tearDown() {
        SessionRepository.testForcedTranscriptSnapshotFailureOverride = nil
        SessionRepository.testForcedGeneratedNotesWriteFailureOverride = nil
        SessionRepository.testForcedGeneratedNotesManifestReplacementFailureOverride = nil
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

    func testSecondGeneratedNotesSaveFailsAndPreservesExistingBundleAndPriorNotes() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryGeneratedNotesOverwriteTests")
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

        let replacementNotes = GeneratedSessionNotes(
            generatedAt: Date(timeIntervalSince1970: 800),
            hiddenGeminiTranscript: "This replacement transcript must not be saved.",
            summary: "This replacement summary must not be saved.",
            actionItemBullets: ["Do not persist this bullet."]
        )

        do {
            try await repository.saveGeneratedNotes(replacementNotes, for: session)
            XCTFail("Expected generated-notes overwrite rejection to throw.")
        } catch let error as GeneratedSessionNotesPersistenceError {
            XCTAssertEqual(error, .alreadyExists)
        }

        let manifestDataAfterFailure = try Data(contentsOf: session.manifestURL)
        let notesDataAfterFailure = try Data(contentsOf: notesURL)
        let reopenedNotes = try await repository.loadGeneratedNotes(for: session)

        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure)
        XCTAssertEqual(notesDataAfterFailure, notesDataBeforeFailure)
        XCTAssertEqual(reopenedNotes, originalNotes)
    }

    func testGeneratedNotesWriteFailureInsideTransactionPreservesFirstTimeBundle() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryGeneratedNotesTransactionalFailureTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Me lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 810)
        )
        let manifestDataBeforeFailure = try Data(contentsOf: session.manifestURL)
        let notesURL = session.directoryURL.appendingPathComponent("generated-notes.json", isDirectory: false)

        SessionRepository.testForcedGeneratedNotesManifestReplacementFailureOverride = true

        do {
            try await repository.saveGeneratedNotes(Self.makeGeneratedNotes(), for: session)
            XCTFail("Expected generated-notes transaction failure to throw.")
        } catch {
            XCTAssertTrue(error is CocoaError)
        }

        let manifestDataAfterFailure = try Data(contentsOf: session.manifestURL)
        let generatedNotesAfterFailure = try await repository.loadGeneratedNotes(for: session)

        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure)
        XCTAssertFalse(FileManager.default.fileExists(atPath: notesURL.path))
        XCTAssertNil(generatedNotesAfterFailure)
    }

    func testResolveAudioArtifactsForUploadReturnsManifestBackedM4AFiles() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryAudioArtifactsM4ATests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Microphone lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 900)
        )
        try Self.writeArtifactFixture(for: .meeting, in: session.directoryURL)
        try Self.writeArtifactFixture(for: .me, in: session.directoryURL)

        _ = try await repository.finalizeSession(
            session,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane finished cleanly.", state: .ready),
                SourcePipelineStatus(source: .me, detail: "Microphone lane finished cleanly.", state: .ready)
            ],
            transcriptChunks: [],
            endedAt: Date(timeIntervalSince1970: 960),
            status: .completed
        )

        let resolved = try await repository.resolveAudioArtifactsForUpload(for: session)
        let meetingArtifact = try XCTUnwrap(resolved.artifacts.first { $0.source == .meeting })
        let microphoneArtifact = try XCTUnwrap(resolved.artifacts.first { $0.source == .me })

        XCTAssertEqual(resolved.sessionID, session.id)
        XCTAssertEqual(resolved.artifacts.map(\.source), RecordingSourceKind.allCases)
        XCTAssertEqual(meetingArtifact.filename, RecordingSourceKind.meeting.compressedArtifactFilename)
        XCTAssertEqual(microphoneArtifact.filename, RecordingSourceKind.me.compressedArtifactFilename)
        XCTAssertEqual(meetingArtifact.fileURL.lastPathComponent, meetingArtifact.filename)
        XCTAssertEqual(microphoneArtifact.fileURL.lastPathComponent, microphoneArtifact.filename)
        XCTAssertTrue(meetingArtifact.isPrimarySourceOfRecord)
        XCTAssertTrue(microphoneArtifact.isPrimarySourceOfRecord)
    }

    func testResolveAudioArtifactsForUploadReturnsWAVFallbackFiles() async throws {
        let repository = SessionRepository(audioCompressor: FailingSessionAudioCompressor())
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryAudioArtifactsWAVTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Microphone lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 1_000)
        )
        try Self.writeArtifactFixture(for: .meeting, in: session.directoryURL)
        try Self.writeArtifactFixture(for: .me, in: session.directoryURL)

        _ = try await repository.finalizeSession(
            session,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane finished cleanly.", state: .ready),
                SourcePipelineStatus(source: .me, detail: "Microphone lane finished cleanly.", state: .ready)
            ],
            transcriptChunks: [],
            endedAt: Date(timeIntervalSince1970: 1_060),
            status: .completed
        )

        let resolved = try await repository.resolveAudioArtifactsForUpload(for: session)
        let artifactsBySource = Dictionary(uniqueKeysWithValues: resolved.artifacts.map { ($0.source, $0) })

        XCTAssertEqual(artifactsBySource[.meeting]?.filename, RecordingSourceKind.meeting.artifactFilename)
        XCTAssertEqual(artifactsBySource[.me]?.filename, RecordingSourceKind.me.artifactFilename)
        XCTAssertEqual(artifactsBySource[.meeting]?.fileURL.lastPathComponent, RecordingSourceKind.meeting.artifactFilename)
        XCTAssertEqual(artifactsBySource[.me]?.fileURL.lastPathComponent, RecordingSourceKind.me.artifactFilename)
    }

    func testResolveAudioArtifactsForUploadFailsClearlyWithoutMutatingBundleWhenRequiredFileIsMissing() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryAudioArtifactsMissingTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Microphone lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 1_100)
        )
        try Self.writeArtifactFixture(for: .meeting, in: session.directoryURL)

        let manifestDataBeforeFailure = try Data(contentsOf: session.manifestURL)

        do {
            _ = try await repository.resolveAudioArtifactsForUpload(for: session)
            XCTFail("Expected missing microphone audio artifact resolution to throw.")
        } catch let error as SessionAudioArtifactResolutionError {
            guard case .missingRequiredFile(let source, let filename, let url) = error else {
                return XCTFail("Expected missingRequiredFile, got \(error).")
            }

            XCTAssertEqual(source, .me)
            XCTAssertEqual(filename, RecordingSourceKind.me.artifactFilename)
            XCTAssertEqual(url.lastPathComponent, RecordingSourceKind.me.artifactFilename)
            XCTAssertTrue(error.localizedDescription.contains("microphone"))
            XCTAssertTrue(error.localizedDescription.contains(RecordingSourceKind.me.artifactFilename))
        }

        let manifestDataAfterFailure = try Data(contentsOf: session.manifestURL)

        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure)
    }

    func testResolveAudioArtifactsForUploadRejectsTraversalManifestFilenameWithoutMutatingBundle() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryAudioArtifactsTraversalTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Microphone lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 1_200)
        )
        try Self.writeArtifactFixture(for: .meeting, in: session.directoryURL)
        try Self.writeArtifactFixture(for: .me, in: session.directoryURL)
        try Self.updateManifestDictionary(at: session.manifestURL) { manifest in
            var artifacts = try XCTUnwrap(manifest["audioArtifacts"] as? [[String: Any]])
            let microphoneIndex = try XCTUnwrap(artifacts.firstIndex { $0["source"] as? String == RecordingSourceKind.me.rawValue })
            artifacts[microphoneIndex]["filename"] = "../../../../Documents/private.wav"
            manifest["audioArtifacts"] = artifacts
        }
        let manifestDataBeforeFailure = try Data(contentsOf: session.manifestURL)

        do {
            _ = try await repository.resolveAudioArtifactsForUpload(for: session)
            XCTFail("Expected traversal audio artifact filename to throw.")
        } catch let error as SessionAudioArtifactResolutionError {
            XCTAssertEqual(
                error,
                .invalidManifestFilename(source: .me, filename: "../../../../Documents/private.wav")
            )
        }

        let manifestDataAfterFailure = try Data(contentsOf: session.manifestURL)

        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure)
    }

    func testResolveAudioArtifactsForUploadRejectsNonAudioManifestFilename() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryAudioArtifactsExtensionTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Microphone lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 1_300)
        )
        try Self.writeArtifactFixture(for: .meeting, in: session.directoryURL)
        try Self.updateManifestDictionary(at: session.manifestURL) { manifest in
            var artifacts = try XCTUnwrap(manifest["audioArtifacts"] as? [[String: Any]])
            let microphoneIndex = try XCTUnwrap(artifacts.firstIndex { $0["source"] as? String == RecordingSourceKind.me.rawValue })
            artifacts[microphoneIndex]["filename"] = "private.txt"
            manifest["audioArtifacts"] = artifacts
        }

        do {
            _ = try await repository.resolveAudioArtifactsForUpload(for: session)
            XCTFail("Expected non-audio artifact filename to throw.")
        } catch let error as SessionAudioArtifactResolutionError {
            XCTAssertEqual(error, .invalidManifestFilename(source: .me, filename: "private.txt"))
        }
    }

    func testResolveAudioArtifactsForUploadFailsClearlyWhenManifestEntryIsMissing() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryAudioArtifactsMissingManifestEntryTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Microphone lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 1_400)
        )
        try Self.writeArtifactFixture(for: .meeting, in: session.directoryURL)
        try Self.updateManifestDictionary(at: session.manifestURL) { manifest in
            let artifacts = try XCTUnwrap(manifest["audioArtifacts"] as? [[String: Any]])
            manifest["audioArtifacts"] = artifacts.filter { $0["source"] as? String != RecordingSourceKind.me.rawValue }
        }
        let manifestDataBeforeFailure = try Data(contentsOf: session.manifestURL)

        do {
            _ = try await repository.resolveAudioArtifactsForUpload(for: session)
            XCTFail("Expected missing manifest entry to throw.")
        } catch let error as SessionAudioArtifactResolutionError {
            XCTAssertEqual(error, .missingManifestEntry(source: .me))
        }

        let manifestDataAfterFailure = try Data(contentsOf: session.manifestURL)

        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure)
    }

    func testLoadGeneratedNotesRejectsTraversalManifestFilename() async throws {
        let repository = SessionRepository()
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "SessionRepositoryGeneratedNotesTraversalTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let session = try await repository.beginSessionBundle(
            at: scratchDirectory,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Me lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 1_500)
        )
        try Self.updateManifestDictionary(at: session.manifestURL) { manifest in
            manifest["generatedNotesFilename"] = "../../../../Documents/generated-notes.json"
        }

        do {
            _ = try await repository.loadGeneratedNotes(for: session)
            XCTFail("Expected invalid generated notes manifest filename to throw.")
        } catch let error as GeneratedSessionNotesPersistenceError {
            XCTAssertEqual(error, .invalidManifestFilename("../../../../Documents/generated-notes.json"))
        }
    }

    private static func loadManifestDictionary(from manifestURL: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: manifestURL)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func audioArtifactFilenames(from manifest: [String: Any]) throws -> [String] {
        let artifacts = try XCTUnwrap(manifest["audioArtifacts"] as? [[String: Any]])
        return artifacts.compactMap { $0["filename"] as? String }
    }

    private static func updateManifestDictionary(
        at manifestURL: URL,
        update: (inout [String: Any]) throws -> Void
    ) throws {
        var manifest = try loadManifestDictionary(from: manifestURL)
        try update(&manifest)
        let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: manifestURL, options: .atomic)
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

    private static func writeArtifactFixture(for source: RecordingSourceKind, in sessionDirectoryURL: URL) throws {
        try MeetlessTestSupport.writePCM16WaveFile(
            to: sessionDirectoryURL.appendingPathComponent(source.artifactFilename, isDirectory: false),
            sampleCount: 16_000
        )
    }
}

private struct FailingSessionAudioCompressor: SessionAudioCompressing {
    func compressWAVToM4A(from sourceURL: URL, to destinationURL: URL) throws {
        throw CocoaError(.fileWriteUnknown)
    }
}
