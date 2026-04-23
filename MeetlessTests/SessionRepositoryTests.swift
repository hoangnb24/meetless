import XCTest
@testable import Meetless

final class SessionRepositoryTests: XCTestCase {
    override func tearDown() {
        SessionRepository.testForcedTranscriptSnapshotFailureOverride = nil
        super.tearDown()
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
}
