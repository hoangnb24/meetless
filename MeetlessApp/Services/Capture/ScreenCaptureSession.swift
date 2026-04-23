import AVFoundation
import CoreMedia
import Foundation
import OSLog
import ScreenCaptureKit

struct CaptureSessionSnapshot: Sendable {
    let displayID: CGDirectDisplayID?
    let artifactDirectoryURL: URL
    let latestEvent: String
    let sourceStatuses: [SourcePipelineStatus]

    var hasDegradedSource: Bool {
        sourceStatuses.contains(where: { $0.state == .degraded })
    }
}

enum ScreenCaptureSessionError: LocalizedError {
    case noDisplayAvailable

    var errorDescription: String? {
        switch self {
        case .noDisplayAvailable:
            return "No shareable display was available for whole-system capture."
        }
    }
}

private final class CaptureSampleSink: NSObject, SCStreamOutput {
    let source: RecordingSourceKind
    let sampleHandler: @Sendable (RecordingSourceKind, CMSampleBuffer) -> Void

    init(source: RecordingSourceKind, sampleHandler: @escaping @Sendable (RecordingSourceKind, CMSampleBuffer) -> Void) {
        self.source = source
        self.sampleHandler = sampleHandler
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        sampleHandler(source, sampleBuffer)
    }
}

final class ScreenCaptureSession: NSObject, SCStreamDelegate {
    private let logger = Logger(subsystem: "com.themrb.meetless", category: "screen-capture-session")
    private let outputQueue = DispatchQueue(label: "com.themrb.meetless.capture-output")

    private var stream: SCStream?
    private var meetingSink: CaptureSampleSink?
    private var microphoneEngine: AVAudioEngine?
    private var sessionScratch: RecordingScratchSession?
    private var displayID: CGDirectDisplayID?
    private var meetingPipeline: SourceAudioPipeline?
    private var microphonePipeline: SourceAudioPipeline?
    private var latestEvent = "No recording has started yet."
    private(set) var lastStopErrorDescription: String?

    func start(
        chunkHandler: @escaping @Sendable (SourceAudioChunk) -> Void = { _ in }
    ) async throws -> CaptureSessionSnapshot {
        logger.notice("ScreenCaptureSession.start begin")
        if stream != nil {
            logger.notice("ScreenCaptureSession.start stopping existing stream first")
            _ = await stop()
        }

        logger.notice("awaiting SCShareableContent.current")
        let shareableContent = try await SCShareableContent.current
        logger.notice("SCShareableContent.current returned displays=\(shareableContent.displays.count, privacy: .public) applications=\(shareableContent.applications.count, privacy: .public)")
        guard let display = shareableContent.displays.first else {
            logger.error("no display available for capture")
            throw ScreenCaptureSessionError.noDisplayAvailable
        }

        let ownBundleIdentifier = Bundle.main.bundleIdentifier
        let ownApplications = shareableContent.applications.filter { application in
            application.bundleIdentifier == ownBundleIdentifier
        }

        let filter = SCContentFilter(
            display: display,
            excludingApplications: ownApplications,
            exceptingWindows: []
        )

        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.captureMicrophone = false
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.queueDepth = 3
        configuration.showsCursor = false

        let sessionScratch = try RecordingScratchSession.create()
        let meetingPipeline = try SourceAudioPipeline(
            source: .meeting,
            fileURL: sessionScratch.audioFileURL(for: .meeting),
            chunkHandler: chunkHandler
        )
        let microphonePipeline = try SourceAudioPipeline(
            source: .me,
            fileURL: sessionScratch.audioFileURL(for: .me),
            chunkHandler: chunkHandler
        )

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        let meetingSink = CaptureSampleSink(source: .meeting) { [weak self] source, sampleBuffer in
            self?.handleSampleBuffer(sampleBuffer, from: source)
        }

        try stream.addStreamOutput(meetingSink, type: .audio, sampleHandlerQueue: outputQueue)
        logger.notice("awaiting stream.startCapture on displayID=\(display.displayID, privacy: .public)")
        try await stream.startCapture()
        logger.notice("stream.startCapture returned successfully")

        self.stream = stream
        self.meetingSink = meetingSink
        self.sessionScratch = sessionScratch
        self.displayID = display.displayID
        self.meetingPipeline = meetingPipeline
        self.microphonePipeline = microphonePipeline
        do {
            self.microphoneEngine = try startVoiceProcessedMicrophoneCapture()
            self.latestEvent = "ScreenCaptureKit started on display \(display.displayID). Meeting now comes from system audio while Me uses a voice-processed microphone lane inside \(sessionScratch.directoryURL.lastPathComponent)."
        } catch {
            microphonePipeline.markDegraded(reason: error.localizedDescription)
            self.latestEvent = "ScreenCaptureKit started on display \(display.displayID), but the voice-processed microphone lane degraded: \(error.localizedDescription)"
            logger.error("voice-processed microphone start failed: \(error.localizedDescription, privacy: .public)")
        }
        self.lastStopErrorDescription = nil
        logger.notice("ScreenCaptureSession.start completed; sessionID=\(PublicLogRedaction.sessionIdentifier(for: sessionScratch.directoryURL), privacy: .public)")

        return currentSnapshot()!
    }

    func currentSnapshot() -> CaptureSessionSnapshot? {
        outputQueue.sync {
            guard let sessionScratch else { return nil }
            return CaptureSessionSnapshot(
                displayID: displayID,
                artifactDirectoryURL: sessionScratch.directoryURL,
                latestEvent: latestEvent,
                sourceStatuses: currentSourceStatuses()
            )
        }
    }

    func stop() async -> CaptureSessionSnapshot? {
        guard let stream else { return nil }
        logger.notice("ScreenCaptureSession.stop begin")
        stopVoiceProcessedMicrophoneCapture()

        do {
            try await stream.stopCapture()
        } catch {
            lastStopErrorDescription = error.localizedDescription
            logger.error("SCStream stopCapture failed: \(error.localizedDescription, privacy: .public)")
        }

        let snapshot = outputQueue.sync { () -> CaptureSessionSnapshot? in
            guard let sessionScratch else { return nil }

            do {
                try meetingPipeline?.finish()
            } catch {
                meetingPipeline?.markDegraded(reason: error.localizedDescription)
            }

            do {
                try microphonePipeline?.finish()
            } catch {
                microphonePipeline?.markDegraded(reason: error.localizedDescription)
            }

            if let lastStopErrorDescription {
                latestEvent = "ScreenCaptureKit stopped with a stream-level error: \(lastStopErrorDescription)"
            } else {
                latestEvent = "Capture stopped. Durable per-source PCM artifacts remain in \(sessionScratch.directoryURL.lastPathComponent)."
            }

            return CaptureSessionSnapshot(
                displayID: displayID,
                artifactDirectoryURL: sessionScratch.directoryURL,
                latestEvent: latestEvent,
                sourceStatuses: currentSourceStatuses()
            )
        }
        self.stream = nil
        self.meetingSink = nil
        self.microphoneEngine = nil
        self.sessionScratch = nil
        self.displayID = nil
        self.meetingPipeline = nil
        self.microphonePipeline = nil
        logger.notice("ScreenCaptureSession.stop completed")
        return snapshot
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        lastStopErrorDescription = error.localizedDescription
        logger.error("SCStream stopped with error: \(error.localizedDescription, privacy: .public)")
    }

    private func handleSampleBuffer(_ sampleBuffer: CMSampleBuffer, from source: RecordingSourceKind) {
        let pipeline: SourceAudioPipeline?
        switch source {
        case .meeting:
            pipeline = meetingPipeline
        case .me:
            pipeline = microphonePipeline
        }

        guard let pipeline else { return }

        do {
            latestEvent = try pipeline.append(sampleBuffer: sampleBuffer)
        } catch {
            pipeline.markDegraded(reason: error.localizedDescription)
            latestEvent = "\(source.rawValue) degraded but the surviving source stayed active: \(error.localizedDescription)"
        }
    }

    private func handlePCMBuffer(_ pcmBuffer: AVAudioPCMBuffer, from source: RecordingSourceKind) {
        let pipeline: SourceAudioPipeline?
        switch source {
        case .meeting:
            pipeline = meetingPipeline
        case .me:
            pipeline = microphonePipeline
        }

        guard let pipeline else { return }

        do {
            latestEvent = try pipeline.append(pcmBuffer: pcmBuffer)
        } catch {
            pipeline.markDegraded(reason: error.localizedDescription)
            latestEvent = "\(source.rawValue) degraded but the surviving source stayed active: \(error.localizedDescription)"
        }
    }

    private func startVoiceProcessedMicrophoneCapture() throws -> AVAudioEngine {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)

        guard inputFormat.channelCount > 0 else {
            throw NSError(
                domain: "ScreenCaptureSession",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "The selected microphone did not expose a readable input format."]
            )
        }

        do {
            try inputNode.setVoiceProcessingEnabled(true)
        } catch {
            throw NSError(
                domain: "ScreenCaptureSession",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "Meetless could not enable voice processing on the microphone input: \(error.localizedDescription)"]
            )
        }

        inputNode.installTap(onBus: 0, bufferSize: 2_048, format: inputFormat) { [weak self] buffer, _ in
            guard let self, let copiedBuffer = Self.copyPCMBuffer(buffer) else { return }
            self.outputQueue.async { [weak self] in
                self?.handlePCMBuffer(copiedBuffer, from: .me)
            }
        }

        engine.prepare()
        try engine.start()
        logger.notice("voice-processed microphone engine started sampleRate=\(inputFormat.sampleRate, privacy: .public) channels=\(inputFormat.channelCount, privacy: .public)")
        return engine
    }

    private func stopVoiceProcessedMicrophoneCapture() {
        guard let microphoneEngine else { return }
        microphoneEngine.inputNode.removeTap(onBus: 0)
        microphoneEngine.stop()
        logger.notice("voice-processed microphone engine stopped")
    }

    private static func copyPCMBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copiedBuffer = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
            return nil
        }

        copiedBuffer.frameLength = buffer.frameLength
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(copiedBuffer.mutableAudioBufferList)

        guard sourceBuffers.count == destinationBuffers.count else {
            return nil
        }

        for index in 0..<sourceBuffers.count {
            let sourceBuffer = sourceBuffers[index]
            let destinationBuffer = destinationBuffers[index]
            guard
                let sourceData = sourceBuffer.mData,
                let destinationData = destinationBuffer.mData
            else {
                return nil
            }

            memcpy(destinationData, sourceData, Int(sourceBuffer.mDataByteSize))
            destinationBuffers[index].mDataByteSize = sourceBuffer.mDataByteSize
        }

        return copiedBuffer
    }

    private func currentSourceStatuses() -> [SourcePipelineStatus] {
        [
            meetingPipeline?.snapshot()
                ?? SourcePipelineStatus(source: .meeting, detail: "Meeting is waiting for capture to start.", state: .ready),
            microphonePipeline?.snapshot()
                ?? SourcePipelineStatus(source: .me, detail: "Me is waiting for capture to start.", state: .ready)
        ]
    }
}
