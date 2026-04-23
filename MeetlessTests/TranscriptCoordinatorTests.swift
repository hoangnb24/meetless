import XCTest
@testable import Meetless

final class TranscriptCoordinatorTests: XCTestCase {
    func testRetryExhaustedWindowMarksSourceDegradedSoStopCanStayBounded() async throws {
        let scratchDirectory = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "TranscriptCoordinatorTests")
        defer { try? FileManager.default.removeItem(at: scratchDirectory) }

        let meetingWaveURL = scratchDirectory.appendingPathComponent("meeting.wav", isDirectory: false)
        try MeetlessTestSupport.writePCM16WaveFile(to: meetingWaveURL, sampleCount: 320)

        let failingAssets = WhisperBridgeAssets(
            bundle: Bundle(for: Self.self),
            modelBasename: "missing-test-model",
            modelExtension: "bin"
        )

        let coordinator = TranscriptCoordinator(
            meetingWorker: WhisperSourceWorker(source: .meeting, assets: failingAssets),
            meWorker: WhisperSourceWorker(source: .me, assets: failingAssets),
            minimumCommitSeconds: 0.01,
            maximumCommitSeconds: 0.02
        )

        await coordinator.ingest(
            SourceAudioChunk(
                source: .meeting,
                fileURL: meetingWaveURL,
                sampleRate: 16_000,
                channelCount: 1,
                startFrameIndex: 0,
                endFrameIndex: 320
            )
        )

        let healthSnapshot = try await MeetlessTestSupport.waitForValue(
            description: "the meeting transcript lane to degrade"
        ) {
            let snapshot = await coordinator.currentHealthSnapshot()
            return snapshot.hasDegradedSource ? snapshot : nil
        }

        XCTAssertEqual(healthSnapshot.sourceStatuses.count, 1)
        XCTAssertEqual(healthSnapshot.sourceStatuses.first?.source, .meeting)
        XCTAssertEqual(healthSnapshot.sourceStatuses.first?.state, .degraded)
        XCTAssertTrue(
            healthSnapshot.latestEvent?.contains("Stop can still finish cleanly") == true,
            "Expected the retry-exhausted lane to advertise the bounded Stop guarantee."
        )

        let frozenSnapshot = await coordinator.freezeVisibleSnapshot()
        XCTAssertTrue(frozenSnapshot.isEmpty)
    }
}
