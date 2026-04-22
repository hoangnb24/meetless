import Foundation
import OSLog

enum RecordingShellPhase: Sendable {
    case idle
    case blocked
    case recording
}

enum SmokeTranscriptionPhase: Sendable {
    case ready
    case running
    case succeeded
    case failed
}

enum SourcePipelineState: String, Codable, Sendable {
    case ready
    case blocked
    case monitoring
    case degraded
}

enum RecordingSourceKind: String, Identifiable, CaseIterable, Codable, Sendable {
    case meeting = "Meeting"
    case me = "Me"

    var id: String { rawValue }

    var artifactFilename: String {
        switch self {
        case .meeting:
            return "meeting.wav"
        case .me:
            return "me.wav"
        }
    }
}

struct SourcePipelineStatus: Identifiable, Codable, Sendable {
    let source: RecordingSourceKind
    let detail: String
    let state: SourcePipelineState

    var id: RecordingSourceKind { source }
}

struct CommittedTranscriptChunk: Identifiable, Codable, Sendable {
    let id: UUID
    let source: RecordingSourceKind
    let text: String
    let startFrameIndex: Int64
    let endFrameIndex: Int64
    let sampleRate: Double
    let sequenceNumber: Int

    var startTime: TimeInterval {
        Double(startFrameIndex) / sampleRate
    }

    var endTime: TimeInterval {
        Double(endFrameIndex) / sampleRate
    }
}

struct RecordingStatusSnapshot: Sendable {
    let phase: RecordingShellPhase
    let headline: String
    let detail: String
    let latestEvent: String
    let sourceStatuses: [SourcePipelineStatus]
    let repairActions: [PermissionRepairAction]
    let transcriptChunks: [CommittedTranscriptChunk]
}

struct SmokeTranscriptionSnapshot: Sendable {
    let phase: SmokeTranscriptionPhase
    let headline: String
    let detail: String
    let transcript: String
}

protocol RecordingCoordinating {
    func startShellSession() async throws -> RecordingStatusSnapshot
    func stopShellSession() async throws -> RecordingStatusSnapshot
    func currentRecordingSnapshot() async -> RecordingStatusSnapshot?
    func runSmokeTranscription() async throws -> SmokeTranscriptionSnapshot
}

private struct TranscriptCommitWindow {
    let source: RecordingSourceKind
    let fileURL: URL
    let sampleRate: Double
    let startFrameIndex: Int64
    let endFrameIndex: Int64
}

private struct SourceTranscriptLane {
    let source: RecordingSourceKind
    var sampleRate: Double = 16_000
    var fileURL: URL?
    var nextCommitStartFrameIndex: Int64?
    var availableEndFrameIndex: Int64 = 0
    var isTranscribing = false
    var shouldFlushRemaining = false

    mutating func append(_ chunk: SourceAudioChunk) {
        if nextCommitStartFrameIndex == nil {
            nextCommitStartFrameIndex = chunk.startFrameIndex
        }

        fileURL = chunk.fileURL
        sampleRate = chunk.sampleRate
        availableEndFrameIndex = max(availableEndFrameIndex, chunk.endFrameIndex)
    }

    mutating func dequeueCommitWindow(
        minimumFrameCount: Int,
        maximumFrameCount: Int
    ) -> TranscriptCommitWindow? {
        guard
            !isTranscribing,
            let fileURL,
            let startFrameIndex = nextCommitStartFrameIndex
        else {
            return nil
        }

        let availableFrameCount = Int(availableEndFrameIndex - startFrameIndex)
        let requiredFrameCount = shouldFlushRemaining ? 1 : minimumFrameCount
        guard availableFrameCount >= requiredFrameCount else {
            return nil
        }

        let frameCount = shouldFlushRemaining ? availableFrameCount : min(maximumFrameCount, availableFrameCount)
        let endFrameIndex = startFrameIndex + Int64(frameCount)
        nextCommitStartFrameIndex = endFrameIndex
        isTranscribing = true

        return TranscriptCommitWindow(
            source: source,
            fileURL: fileURL,
            sampleRate: sampleRate,
            startFrameIndex: startFrameIndex,
            endFrameIndex: endFrameIndex
        )
    }

    mutating func restore(_ window: TranscriptCommitWindow) {
        nextCommitStartFrameIndex = window.startFrameIndex
        isTranscribing = false
    }

    mutating func markTranscriptionFinished() {
        isTranscribing = false
        if nextCommitStartFrameIndex == availableEndFrameIndex {
            shouldFlushRemaining = false
        }
    }

    mutating func requestFlush() {
        shouldFlushRemaining = true
    }

    var hasBufferedFrames: Bool {
        guard let nextCommitStartFrameIndex else { return false }
        return availableEndFrameIndex > nextCommitStartFrameIndex
    }
}

private typealias TranscriptSnapshotHandler = @Sendable ([CommittedTranscriptChunk]) async -> Void

private enum TranscriptWindowLoadError: LocalizedError {
    case shortRead(fileURL: URL, expectedByteCount: Int, actualByteCount: Int)

    var errorDescription: String? {
        switch self {
        case let .shortRead(fileURL, expectedByteCount, actualByteCount):
            return "Only read \(actualByteCount) of \(expectedByteCount) bytes from \(fileURL.lastPathComponent) while loading a transcript window."
        }
    }
}

private enum TranscriptProcessingOutcome: Sendable {
    case transcript(String)
    case silence
    case failure(String)
}

actor TranscriptCoordinator {
    private let logger = Logger(subsystem: "com.themrb.meetless", category: "transcript-coordinator")
    private let minimumCommitFrameCount: Int
    private let maximumCommitFrameCount: Int
    private let workers: [RecordingSourceKind: WhisperSourceWorker]

    private var committedChunks: [CommittedTranscriptChunk] = []
    private var lanes: [RecordingSourceKind: SourceTranscriptLane]
    private var nextSequenceNumber = 0
    private var snapshotHandler: TranscriptSnapshotHandler?

    init(
        meetingWorker: WhisperSourceWorker,
        meWorker: WhisperSourceWorker,
        minimumCommitSeconds: Double = 4,
        maximumCommitSeconds: Double = 8
    ) {
        minimumCommitFrameCount = Int(minimumCommitSeconds * 16_000)
        maximumCommitFrameCount = Int(maximumCommitSeconds * 16_000)
        workers = [
            .meeting: meetingWorker,
            .me: meWorker
        ]
        lanes = [
            .meeting: SourceTranscriptLane(source: .meeting),
            .me: SourceTranscriptLane(source: .me)
        ]
    }

    func reset() {
        committedChunks.removeAll()
        nextSequenceNumber = 0
        lanes = [
            .meeting: SourceTranscriptLane(source: .meeting),
            .me: SourceTranscriptLane(source: .me)
        ]
    }

    fileprivate func setSnapshotHandler(_ handler: TranscriptSnapshotHandler?) {
        snapshotHandler = handler
    }

    func ingest(_ chunk: SourceAudioChunk) {
        guard var lane = lanes[chunk.source] else { return }
        lane.append(chunk)
        lanes[chunk.source] = lane
        scheduleTranscriptionIfNeeded(for: chunk.source)
    }

    func finishPendingWork() async -> [CommittedTranscriptChunk] {
        for source in RecordingSourceKind.allCases {
            guard var lane = lanes[source] else { continue }
            lane.requestFlush()
            lanes[source] = lane
            scheduleTranscriptionIfNeeded(for: source)
        }

        while hasOutstandingWork {
            await Task.yield()
        }

        return orderedCommittedChunks()
    }

    func currentTranscriptChunks() -> [CommittedTranscriptChunk] {
        orderedCommittedChunks()
    }

    private var hasOutstandingWork: Bool {
        lanes.values.contains { lane in
            lane.isTranscribing || lane.hasBufferedFrames
        }
    }

    private func scheduleTranscriptionIfNeeded(for source: RecordingSourceKind) {
        guard
            var lane = lanes[source],
            let worker = workers[source],
            let commitWindow = lane.dequeueCommitWindow(
                minimumFrameCount: minimumCommitFrameCount,
                maximumFrameCount: maximumCommitFrameCount
            )
        else {
            return
        }

        lanes[source] = lane

        Task(priority: .utility) {
            let outcome: TranscriptProcessingOutcome
            do {
                let samples = try Self.loadSamples(
                    from: commitWindow.fileURL,
                    startFrameIndex: commitWindow.startFrameIndex,
                    endFrameIndex: commitWindow.endFrameIndex
                )
                let text = try await worker.transcribeIncrementalWindow(samples: samples)
                if let filteredText = Self.filteredTranscriptText(text) {
                    outcome = .transcript(filteredText)
                } else {
                    outcome = .silence
                }
            } catch WhisperBridgeError.emptyTranscription {
                outcome = .silence
            } catch {
                outcome = .failure(error.localizedDescription)
            }

            await self.handleProcessingOutcome(outcome, for: source, window: commitWindow)
        }
    }

    private func handleProcessingOutcome(
        _ outcome: TranscriptProcessingOutcome,
        for source: RecordingSourceKind,
        window: TranscriptCommitWindow
    ) async {
        guard var lane = lanes[source] else { return }

        let snapshotToPersist: [CommittedTranscriptChunk]?
        switch outcome {
        case let .transcript(text):
            lane.markTranscriptionFinished()
            nextSequenceNumber += 1
            committedChunks.append(
                CommittedTranscriptChunk(
                    id: UUID(),
                    source: window.source,
                    text: text,
                    startFrameIndex: window.startFrameIndex,
                    endFrameIndex: window.endFrameIndex,
                    sampleRate: window.sampleRate,
                    sequenceNumber: nextSequenceNumber
                )
            )
            snapshotToPersist = orderedCommittedChunks()
        case .silence:
            lane.markTranscriptionFinished()
            snapshotToPersist = nil
        case let .failure(message):
            logger.error("transcription window failed for \(source.rawValue, privacy: .public) frames \(window.startFrameIndex, privacy: .public)-\(window.endFrameIndex, privacy: .public): \(message, privacy: .public)")
            lane.restore(window)
            snapshotToPersist = nil
        }

        lanes[source] = lane

        if let snapshotToPersist, let snapshotHandler {
            await snapshotHandler(snapshotToPersist)
        }

        scheduleTranscriptionIfNeeded(for: source)
    }

    private static func loadSamples(
        from fileURL: URL,
        startFrameIndex: Int64,
        endFrameIndex: Int64
    ) throws -> [Float] {
        let frameCount = Int(endFrameIndex - startFrameIndex)
        guard frameCount > 0 else {
            throw WhisperBridgeError.emptyTranscription
        }

        let expectedByteCount = frameCount * 2
        let byteOffset = 44 + (Int(startFrameIndex) * 2)
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer {
            try? handle.close()
        }

        try handle.seek(toOffset: UInt64(byteOffset))
        let data = try handle.read(upToCount: expectedByteCount) ?? Data()
        guard data.count == expectedByteCount else {
            throw TranscriptWindowLoadError.shortRead(
                fileURL: fileURL,
                expectedByteCount: expectedByteCount,
                actualByteCount: data.count
            )
        }

        var samples: [Float] = []
        samples.reserveCapacity(frameCount)
        data.withUnsafeBytes { rawBuffer in
            let bytes = rawBuffer.bindMemory(to: UInt8.self)
            var index = 0
            while index + 1 < bytes.count {
                let value = Int16(bitPattern: UInt16(bytes[index]) | (UInt16(bytes[index + 1]) << 8))
                samples.append(Float(value) / 32768.0)
                index += 2
            }
        }

        return samples
    }

    private static func filteredTranscriptText(_ text: String) -> String? {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else {
            return nil
        }

        let normalizedMarker = trimmedText
            .replacingOccurrences(of: " ", with: "")
            .lowercased()

        let ignoredMarkers: Set<String> = [
            "[blank_audio]",
            "[blankaudio]",
            "[silence]",
            "(silence)"
        ]

        guard !ignoredMarkers.contains(normalizedMarker) else {
            return nil
        }

        return trimmedText
    }

    private func orderedCommittedChunks() -> [CommittedTranscriptChunk] {
        committedChunks.sorted { lhs, rhs in
            if lhs.startFrameIndex == rhs.startFrameIndex {
                return lhs.sequenceNumber < rhs.sequenceNumber
            }
            return lhs.startFrameIndex < rhs.startFrameIndex
        }
    }
}

actor PreviewRecordingCoordinator: RecordingCoordinating {
    private var liveSnapshot: RecordingStatusSnapshot?

    func startShellSession() async throws -> RecordingStatusSnapshot {
        let snapshot = RecordingStatusSnapshot(
            phase: .recording,
            headline: "Recording shell is active",
            detail: "The real ScreenCaptureKit and whisper workers connect here in the next beads.",
            latestEvent: "Start tapped. This placeholder state proves the control surface and status banner wiring.",
            sourceStatuses: [
                SourcePipelineStatus(
                    source: .meeting,
                    detail: "Awaiting system-audio frames from the future capture engine.",
                    state: .monitoring
                ),
                SourcePipelineStatus(
                    source: .me,
                    detail: "Awaiting microphone frames from the future input pipeline.",
                    state: .monitoring
                )
            ],
            repairActions: [],
            transcriptChunks: Self.previewTranscriptChunks
        )
        liveSnapshot = snapshot
        return snapshot
    }

    func stopShellSession() async throws -> RecordingStatusSnapshot {
        let snapshot = RecordingStatusSnapshot(
            phase: .idle,
            headline: "Shell returned to idle",
            detail: "Stopping here keeps the UI honest until real capture and session persistence arrive.",
            latestEvent: "Stop tapped. Later beads will replace this placeholder with a saved session handoff.",
            sourceStatuses: [
                SourcePipelineStatus(
                    source: .meeting,
                    detail: "Ready for a future whole-system audio pipeline.",
                    state: .ready
                ),
                SourcePipelineStatus(
                    source: .me,
                    detail: "Ready for a future microphone pipeline.",
                    state: .ready
                )
            ],
            repairActions: [],
            transcriptChunks: Self.previewTranscriptChunks
        )
        liveSnapshot = snapshot
        return snapshot
    }

    func currentRecordingSnapshot() async -> RecordingStatusSnapshot? {
        liveSnapshot
    }

    func runSmokeTranscription() async throws -> SmokeTranscriptionSnapshot {
        SmokeTranscriptionSnapshot(
            phase: .succeeded,
            headline: "Preview smoke path completed",
            detail: "The preview coordinator returns a canned result so the UI stays inspectable without the bundled whisper resources.",
            transcript: "Ask not what your shell can do for you, ask what your shell makes room to prove next."
        )
    }

    private static var previewTranscriptChunks: [CommittedTranscriptChunk] {
        [
            CommittedTranscriptChunk(
                id: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA") ?? UUID(),
                source: .meeting,
                text: "We can keep the whole meeting feed local and still show stable chunks as they commit.",
                startFrameIndex: 0,
                endFrameIndex: 64_000,
                sampleRate: 16_000,
                sequenceNumber: 1
            ),
            CommittedTranscriptChunk(
                id: UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB") ?? UUID(),
                source: .me,
                text: "That gives the saved session the exact transcript timeline the operator already saw.",
                startFrameIndex: 64_000,
                endFrameIndex: 128_000,
                sampleRate: 16_000,
                sequenceNumber: 2
            )
        ]
    }
}

actor MeetlessRecordingCoordinator: RecordingCoordinating {
    private let logger = Logger(subsystem: "com.themrb.meetless", category: "recording-coordinator")
    private let meetingWorker: WhisperSourceWorker
    private let meWorker: WhisperSourceWorker
    private let transcriptCoordinator: TranscriptCoordinator
    private let sessionRepository = SessionRepository()
    private let permissionGate = RecordingPermissionGate()
    private let captureSession = ScreenCaptureSession()
    private var liveSnapshot: RecordingStatusSnapshot?
    private var activeSession: PersistedSessionBundle?

    init(bundle: Bundle = .main) {
        let assets = WhisperBridgeAssets(bundle: bundle)
        let meetingWorker = WhisperSourceWorker(source: .meeting, assets: assets)
        let meWorker = WhisperSourceWorker(source: .me, assets: assets)

        self.meetingWorker = meetingWorker
        self.meWorker = meWorker
        self.transcriptCoordinator = TranscriptCoordinator(
            meetingWorker: meetingWorker,
            meWorker: meWorker
        )
    }

    func startShellSession() async throws -> RecordingStatusSnapshot {
        logger.notice("startShellSession begin")
        let readiness = await permissionGate.evaluateStartReadiness()
        logger.notice("permission readiness evaluated; ready=\(readiness.isReady, privacy: .public) repairCount=\(readiness.repairActions.count, privacy: .public)")
        if !readiness.isReady {
            logger.notice("startShellSession blocked by permission readiness")
            let snapshot = RecordingStatusSnapshot(
                phase: .blocked,
                headline: "Recording is blocked until permissions are repaired",
                detail: "Meetless only asks for permissions when you press Record. Repair the missing access below, then retry the recording flow.",
                latestEvent: readiness.repairActions.map(\.detail).joined(separator: " "),
                sourceStatuses: MeetlessRecordingCoordinator.blockedSourceStatuses(for: readiness.repairActions),
                repairActions: readiness.repairActions,
                transcriptChunks: []
            )
            liveSnapshot = nil
            return snapshot
        }

        await transcriptCoordinator.setSnapshotHandler(nil)
        await transcriptCoordinator.reset()
        activeSession = nil
        logger.notice("starting ScreenCaptureSession")
        let capture = try await captureSession.start { [transcriptCoordinator] audioChunk in
            Task(priority: .utility) {
                await transcriptCoordinator.ingest(audioChunk)
            }
        }
        logger.notice("ScreenCaptureSession started; artifactDirectory=\(capture.artifactDirectoryURL.path, privacy: .public)")

        let transcriptChunks = await transcriptCoordinator.currentTranscriptChunks()
        do {
            let activeSession = try await sessionRepository.beginSessionBundle(
                at: capture.artifactDirectoryURL,
                sourceStatuses: capture.sourceStatuses,
                transcriptChunks: transcriptChunks
            )
            self.activeSession = activeSession
            logger.notice("session bundle began; sessionID=\(activeSession.id, privacy: .public)")
            await transcriptCoordinator.setSnapshotHandler { [sessionRepository] transcriptChunks in
                try? await sessionRepository.updateTranscriptSnapshot(
                    for: activeSession,
                    transcriptChunks: transcriptChunks
                )
            }
        } catch {
            logger.error("session bundle begin failed: \(error.localizedDescription, privacy: .public)")
            await transcriptCoordinator.setSnapshotHandler(nil)
            _ = try? await captureSession.stop()
            await meetingWorker.unloadModel()
            await meWorker.unloadModel()
            throw error
        }

        let snapshot = RecordingStatusSnapshot(
            phase: .recording,
            headline: "Recording session is live",
            detail: "One ScreenCaptureKit session now owns whole-system audio plus microphone capture, writes both source artifacts directly into the Application Support session bundle, and snapshots committed Meeting/Me transcript chunks as the local whisper workers finish them.",
            latestEvent: capture.latestEvent,
            sourceStatuses: capture.sourceStatuses,
            repairActions: [],
            transcriptChunks: transcriptChunks
        )
        liveSnapshot = snapshot
        logger.notice("startShellSession returning recording snapshot")
        return snapshot
    }

    func stopShellSession() async throws -> RecordingStatusSnapshot {
        logger.notice("stopShellSession begin")
        let capture = try await captureSession.stop()
        let transcriptChunks = await transcriptCoordinator.finishPendingWork()
        await transcriptCoordinator.setSnapshotHandler(nil)
        let finalSourceStatuses = capture?.sourceStatuses
            ?? liveSnapshot?.sourceStatuses
            ?? MeetlessRecordingCoordinator.blockedSourceStatuses(for: [])
        let finalStatus: PersistedSessionStatus = captureSession.lastStopErrorDescription == nil
            ? .completed
            : .incomplete

        if let activeSession {
            defer { self.activeSession = nil }
            try await sessionRepository.finalizeSession(
                activeSession,
                sourceStatuses: finalSourceStatuses,
                transcriptChunks: transcriptChunks,
                endedAt: Date(),
                status: finalStatus
            )
        }

        await meetingWorker.unloadModel()
        await meWorker.unloadModel()
        logger.notice("stopShellSession finalized status=\(finalStatus.rawValue, privacy: .public) transcriptChunkCount=\(transcriptChunks.count, privacy: .public)")

        let snapshot = RecordingStatusSnapshot(
            phase: .idle,
            headline: finalStatus == .completed ? "Capture stopped cleanly" : "Capture ended with an incomplete saved session",
            detail: capture.map {
                if finalStatus == .completed {
                    return "The ScreenCaptureKit session is down, the saved Application Support bundle in \($0.artifactDirectoryURL.lastPathComponent) now holds the exact committed transcript snapshot plus durable Meeting and Me audio artifacts."
                }

                return "Capture ended unexpectedly, but the Application Support bundle in \($0.artifactDirectoryURL.lastPathComponent) still keeps the last committed transcript snapshot and durable Meeting and Me audio artifacts for incomplete-session recovery."
            } ?? "The ScreenCaptureKit session is down, the live transcript timeline remains as last shown, and the shell is ready for another local recording attempt.",
            latestEvent: capture?.latestEvent ?? captureSession.lastStopErrorDescription ?? "Stop tapped. Capture ended and both source lanes returned to idle.",
            sourceStatuses: finalSourceStatuses,
            repairActions: [],
            transcriptChunks: transcriptChunks
        )
        liveSnapshot = snapshot
        return snapshot
    }

    func currentRecordingSnapshot() async -> RecordingStatusSnapshot? {
        guard let capture = captureSession.currentSnapshot() else {
            return liveSnapshot
        }

        let transcriptChunks = await transcriptCoordinator.currentTranscriptChunks()
        let headline = capture.hasDegradedSource
            ? "Recording continues in a degraded state"
            : "Recording session is live"
        let detail = capture.hasDegradedSource
            ? "One source degraded, but Meetless kept the surviving source alive and continues writing durable per-source PCM while preserving the committed transcript timeline."
            : "Meeting and Me are both being normalized into 16 kHz mono PCM, written durably during the session, and merged into one committed transcript timeline."

        let snapshot = RecordingStatusSnapshot(
            phase: .recording,
            headline: headline,
            detail: detail,
            latestEvent: capture.latestEvent,
            sourceStatuses: capture.sourceStatuses,
            repairActions: [],
            transcriptChunks: transcriptChunks
        )
        liveSnapshot = snapshot
        return snapshot
    }

    func runSmokeTranscription() async throws -> SmokeTranscriptionSnapshot {
        let result = try await meetingWorker.transcribeBundledSmokeSample()

        return SmokeTranscriptionSnapshot(
            phase: .succeeded,
            headline: "Bundled model loaded inside the app",
            detail: "The \(result.source.rawValue) worker loaded \(result.modelName), read \(result.sampleName), and returned local text on \(result.threadCount) threads from \(result.sampleCount) PCM frames.",
            transcript: result.text
        )
    }

    private static func blockedSourceStatuses(for repairActions: [PermissionRepairAction]) -> [SourcePipelineStatus] {
        let blockedKinds = Set(repairActions.map(\.kind))

        return [
            SourcePipelineStatus(
                source: .meeting,
                detail: blockedKinds.contains(.screenRecording)
                    ? "Meeting capture needs Screen Recording access before the whole-system audio lane can start."
                    : "Meeting capture is ready once its repair requirements are cleared.",
                state: blockedKinds.contains(.screenRecording) ? .blocked : .ready
            ),
            SourcePipelineStatus(
                source: .me,
                detail: blockedKinds.contains(.microphone)
                    ? "Me capture needs microphone access before the personal voice lane can start."
                    : "Me capture is ready once its repair requirements are cleared.",
                state: blockedKinds.contains(.microphone) ? .blocked : .ready
            )
        ]
    }
}

@MainActor
final class RecordingViewModel: ObservableObject {
    private let logger = Logger(subsystem: "com.themrb.meetless", category: "recording-view-model")
    @Published private(set) var phase: RecordingShellPhase = .idle
    @Published private(set) var headline = "Ready for a local recording session"
    @Published private(set) var detail = "Press Start to check permissions on demand and begin one local ScreenCaptureKit session for Meeting plus Me."
    @Published private(set) var latestEvent = "No recording has started yet."
    @Published private(set) var sourceStatuses: [SourcePipelineStatus] = [
        SourcePipelineStatus(source: .meeting, detail: "System-audio pipeline placeholder is ready.", state: .ready),
        SourcePipelineStatus(source: .me, detail: "Microphone pipeline placeholder is ready.", state: .ready)
    ]
    @Published private(set) var repairActions: [PermissionRepairAction] = []
    @Published private(set) var transcriptChunks: [CommittedTranscriptChunk] = []
    @Published private(set) var isBusy = false
    @Published private(set) var smokePhase: SmokeTranscriptionPhase = .ready
    @Published private(set) var smokeHeadline = "Bundled local transcription is ready to verify"
    @Published private(set) var smokeDetail = "Run the smoke action to load the pinned model from app resources and transcribe the bundled sample inside the app process."
    @Published private(set) var smokeTranscript = "No smoke transcription has run yet."
    @Published private(set) var isSmokeBusy = false

    private let coordinator: any RecordingCoordinating
    private var statusPollingTask: Task<Void, Never>?

    init(coordinator: any RecordingCoordinating) {
        self.coordinator = coordinator
    }

    var controlTitle: String {
        switch phase {
        case .idle:
            return "Start Recording"
        case .blocked:
            return "Retry Recording"
        case .recording:
            return "Stop Recording"
        }
    }

    var controlSystemImage: String {
        switch phase {
        case .idle:
            return "record.circle.fill"
        case .blocked:
            return "arrow.clockwise.circle.fill"
        case .recording:
            return "stop.circle.fill"
        }
    }

    var phaseDisplayTitle: String {
        switch phase {
        case .idle:
            return "Idle shell"
        case .blocked:
            return "Repair required"
        case .recording:
            return "Recording shell"
        }
    }

    var smokeButtonTitle: String {
        switch smokePhase {
        case .ready, .failed:
            return "Run Smoke Transcription"
        case .running:
            return "Transcribing..."
        case .succeeded:
            return "Run Again"
        }
    }

    var smokeButtonSystemImage: String {
        switch smokePhase {
        case .ready:
            return "play.circle.fill"
        case .running:
            return "hourglass"
        case .succeeded:
            return "checkmark.circle.fill"
        case .failed:
            return "exclamationmark.triangle.fill"
        }
    }

    func toggleRecording() {
        self.logger.notice("toggleRecording tapped; phase=\(String(describing: self.phase), privacy: .public) isBusy=\(self.isBusy, privacy: .public)")
        Task {
            await performToggle()
        }
    }

    func runSmokeTranscription() {
        Task {
            await performSmokeTranscription()
        }
    }

    private func performToggle() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        self.logger.notice("performToggle begin; phase=\(String(describing: self.phase), privacy: .public)")

        do {
            let snapshot: RecordingStatusSnapshot
            switch phase {
            case .idle, .blocked:
                self.logger.notice("performToggle starting shell session")
                snapshot = try await coordinator.startShellSession()
            case .recording:
                self.logger.notice("performToggle stopping shell session")
                snapshot = try await coordinator.stopShellSession()
            }
            self.logger.notice("performToggle received snapshot; phase=\(String(describing: snapshot.phase), privacy: .public) transcriptChunkCount=\(snapshot.transcriptChunks.count, privacy: .public)")
            apply(snapshot)
        } catch {
            self.logger.error("performToggle failed: \(error.localizedDescription, privacy: .public)")
            latestEvent = "Shell action failed: \(error.localizedDescription)"
        }
    }

    private func apply(_ snapshot: RecordingStatusSnapshot) {
        self.logger.notice("apply recording snapshot; phase=\(String(describing: snapshot.phase), privacy: .public) latestEvent=\(snapshot.latestEvent, privacy: .public)")
        phase = snapshot.phase
        headline = snapshot.headline
        detail = snapshot.detail
        latestEvent = snapshot.latestEvent
        sourceStatuses = snapshot.sourceStatuses
        repairActions = snapshot.repairActions
        transcriptChunks = snapshot.transcriptChunks

        switch snapshot.phase {
        case .recording:
            startStatusPolling()
        case .idle, .blocked:
            stopStatusPolling()
        }
    }

    private func performSmokeTranscription() async {
        guard !isSmokeBusy else { return }
        isSmokeBusy = true
        smokePhase = .running
        smokeHeadline = "Loading bundled whisper model"
        smokeDetail = "The smoke path is reading the pinned bundled model and sample from the app resources now."
        smokeTranscript = "Working..."
        defer { isSmokeBusy = false }

        do {
            let snapshot = try await coordinator.runSmokeTranscription()
            apply(snapshot)
        } catch {
            smokePhase = .failed
            smokeHeadline = "Smoke transcription failed"
            smokeDetail = error.localizedDescription
            smokeTranscript = "No transcript returned."
        }
    }

    private func apply(_ snapshot: SmokeTranscriptionSnapshot) {
        smokePhase = snapshot.phase
        smokeHeadline = snapshot.headline
        smokeDetail = snapshot.detail
        smokeTranscript = snapshot.transcript
    }

    private func startStatusPolling() {
        statusPollingTask?.cancel()
        statusPollingTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                guard self.phase == .recording else { return }
                if let snapshot = await self.coordinator.currentRecordingSnapshot() {
                    self.phase = snapshot.phase
                    self.headline = snapshot.headline
                    self.detail = snapshot.detail
                    self.latestEvent = snapshot.latestEvent
                    self.sourceStatuses = snapshot.sourceStatuses
                    self.repairActions = snapshot.repairActions
                    self.transcriptChunks = snapshot.transcriptChunks
                }

                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func stopStatusPolling() {
        statusPollingTask?.cancel()
        statusPollingTask = nil
    }
}
