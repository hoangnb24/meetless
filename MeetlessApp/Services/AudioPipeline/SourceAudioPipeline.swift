import AVFoundation
import CoreMedia
import Foundation

struct SourceAudioChunk: Sendable {
    let source: RecordingSourceKind
    let fileURL: URL
    let sampleRate: Double
    let channelCount: AVAudioChannelCount
    let startFrameIndex: Int64
    let endFrameIndex: Int64
}

struct RecordingScratchSession: Sendable {
    let id: String
    let directoryURL: URL

    static func create(fileManager: FileManager = .default) throws -> RecordingScratchSession {
        guard let applicationSupportURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw SourceAudioPipelineError.missingApplicationSupportDirectory
        }

        let sessionID = UUID().uuidString.lowercased()
        let directoryURL = applicationSupportURL
            .appendingPathComponent("Meetless", isDirectory: true)
            .appendingPathComponent("Sessions", isDirectory: true)
            .appendingPathComponent(sessionID, isDirectory: true)

        try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true, attributes: nil)
        return RecordingScratchSession(id: sessionID, directoryURL: directoryURL)
    }

    func audioFileURL(for source: RecordingSourceKind) -> URL {
        directoryURL.appendingPathComponent(source.artifactFilename, isDirectory: false)
    }
}

enum SourceAudioPipelineError: LocalizedError {
    case missingApplicationSupportDirectory
    case unsupportedSampleFormat(source: RecordingSourceKind)
    case failedToAllocateBuffer(source: RecordingSourceKind)
    case sampleCopyFailed(source: RecordingSourceKind, status: OSStatus)
    case failedToCreateConverter(source: RecordingSourceKind)

    var errorDescription: String? {
        switch self {
        case .missingApplicationSupportDirectory:
            return "Meetless could not resolve Application Support for recording artifacts."
        case let .unsupportedSampleFormat(source):
            return "\(source.rawValue) received an unsupported audio format from ScreenCaptureKit."
        case let .failedToAllocateBuffer(source):
            return "\(source.rawValue) could not allocate the normalization buffer."
        case let .sampleCopyFailed(source, status):
            return "\(source.rawValue) could not copy audio frames from ScreenCaptureKit (OSStatus \(status))."
        case let .failedToCreateConverter(source):
            return "\(source.rawValue) could not build the PCM normalization converter."
        }
    }
}

final class SourceAudioPipeline {
    let source: RecordingSourceKind
    let fileURL: URL

    private let targetFormat: AVAudioFormat
    private let writer: PCM16WaveFileWriter
    private let chunkHandler: @Sendable (SourceAudioChunk) -> Void

    private var converter: AVAudioConverter?
    private var converterSignature: InputFormatSignature?
    private var normalizedChunkCount = 0
    private var normalizedFrameCount = 0
    private var currentState: SourcePipelineState = .monitoring
    private var currentDetail: String
    private var latestEvent = "Waiting for the first captured audio buffer."

    init(
        source: RecordingSourceKind,
        fileURL: URL,
        chunkHandler: @escaping @Sendable (SourceAudioChunk) -> Void = { _ in }
    ) throws {
        self.source = source
        self.fileURL = fileURL
        self.chunkHandler = chunkHandler
        guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false) else {
            throw SourceAudioPipelineError.failedToCreateConverter(source: source)
        }

        self.targetFormat = targetFormat
        self.writer = try PCM16WaveFileWriter(fileURL: fileURL)
        self.currentDetail = "\(source.rawValue) is ready to normalize captured audio into 16 kHz mono PCM at \(fileURL.lastPathComponent)."
    }

    func append(sampleBuffer: CMSampleBuffer) throws -> String {
        guard currentState != .degraded else {
            return latestEvent
        }

        let normalizedSamples = try normalize(sampleBuffer: sampleBuffer)
        return try appendNormalizedSamples(normalizedSamples)
    }

    func append(pcmBuffer: AVAudioPCMBuffer) throws -> String {
        guard currentState != .degraded else {
            return latestEvent
        }

        let normalizedSamples = try normalize(pcmBuffer: pcmBuffer)
        return try appendNormalizedSamples(normalizedSamples)
    }

    private func appendNormalizedSamples(_ normalizedSamples: [Float]) throws -> String {
        guard !normalizedSamples.isEmpty else {
            return latestEvent
        }

        let startFrameIndex = Int64(normalizedFrameCount)
        let endFrameIndex = startFrameIndex + Int64(normalizedSamples.count)

        try writer.append(samples: normalizedSamples)

        normalizedChunkCount += 1
        normalizedFrameCount += normalizedSamples.count
        latestEvent = "\(source.rawValue) normalized chunk #\(normalizedChunkCount) into \(normalizedSamples.count) 16 kHz mono PCM frames and synced \(fileURL.lastPathComponent)."
        currentDetail = "\(source.rawValue) is writing durable 16 kHz mono PCM to \(fileURL.lastPathComponent). \(normalizedChunkCount) normalized chunks and \(normalizedFrameCount) frames are transcription-ready."

        chunkHandler(
            SourceAudioChunk(
                source: source,
                fileURL: fileURL,
                sampleRate: targetFormat.sampleRate,
                channelCount: targetFormat.channelCount,
                startFrameIndex: startFrameIndex,
                endFrameIndex: endFrameIndex
            )
        )

        return latestEvent
    }

    func markDegraded(reason: String) {
        currentState = .degraded
        latestEvent = "\(source.rawValue) degraded but the recording session stayed alive: \(reason)"
        currentDetail = "\(source.rawValue) stopped producing trustworthy output after \(normalizedChunkCount) normalized chunks. The partial artifact at \(fileURL.lastPathComponent) remains durable while the surviving lane continues."
    }

    func snapshot() -> SourcePipelineStatus {
        SourcePipelineStatus(source: source, detail: currentDetail, state: currentState)
    }

    func finish() throws {
        try writer.close()
        if currentState != .degraded {
            currentState = .ready
            currentDetail = "\(source.rawValue) closed \(fileURL.lastPathComponent) with \(normalizedChunkCount) normalized chunks and \(normalizedFrameCount) transcription-ready frames."
            latestEvent = "\(source.rawValue) finalized its durable PCM artifact at \(fileURL.lastPathComponent)."
        }
    }

    private func normalize(sampleBuffer: CMSampleBuffer) throws -> [Float] {
        guard let inputBuffer = try makeInputBuffer(from: sampleBuffer) else {
            return []
        }

        return try normalize(pcmBuffer: inputBuffer)
    }

    private func normalize(pcmBuffer inputBuffer: AVAudioPCMBuffer) throws -> [Float] {
        let converter = try prepareConverter(for: inputBuffer.format)
        let outputCapacity = AVAudioFrameCount(
            ceil(Double(inputBuffer.frameLength) * targetFormat.sampleRate / inputBuffer.format.sampleRate)
        ) + 32

        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputCapacity) else {
            throw SourceAudioPipelineError.failedToAllocateBuffer(source: source)
        }

        var conversionError: NSError?
        var consumedInput = false
        let status = converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
            if consumedInput {
                outStatus.pointee = .noDataNow
                return nil
            }

            consumedInput = true
            outStatus.pointee = .haveData
            return inputBuffer
        }

        if let conversionError {
            throw conversionError
        }

        guard status != .error else {
            throw SourceAudioPipelineError.failedToCreateConverter(source: source)
        }

        let frameCount = Int(outputBuffer.frameLength)
        guard frameCount > 0, let channelData = outputBuffer.floatChannelData?[0] else {
            return []
        }

        return UnsafeBufferPointer(start: channelData, count: frameCount).map {
            max(-1.0, min($0, 1.0))
        }
    }

    private func makeInputBuffer(from sampleBuffer: CMSampleBuffer) throws -> AVAudioPCMBuffer? {
        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frameCount > 0 else {
            return nil
        }

        guard
            let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
            let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription),
            let inputFormat = AVAudioFormat(streamDescription: streamDescription),
            let inputBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frameCount)
        else {
            throw SourceAudioPipelineError.unsupportedSampleFormat(source: source)
        }

        inputBuffer.frameLength = frameCount
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: inputBuffer.mutableAudioBufferList
        )

        guard status == noErr else {
            throw SourceAudioPipelineError.sampleCopyFailed(source: source, status: status)
        }

        return inputBuffer
    }

    private func prepareConverter(for inputFormat: AVAudioFormat) throws -> AVAudioConverter {
        let signature = InputFormatSignature(format: inputFormat)
        if let converter, converterSignature == signature {
            return converter
        }

        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw SourceAudioPipelineError.failedToCreateConverter(source: source)
        }

        self.converter = converter
        self.converterSignature = signature
        return converter
    }
}

private struct InputFormatSignature: Equatable {
    let sampleRate: Double
    let channelCount: AVAudioChannelCount
    let commonFormat: AVAudioCommonFormat
    let isInterleaved: Bool

    init(format: AVAudioFormat) {
        self.sampleRate = format.sampleRate
        self.channelCount = format.channelCount
        self.commonFormat = format.commonFormat
        self.isInterleaved = format.isInterleaved
    }
}

private final class PCM16WaveFileWriter {
    private let handle: FileHandle
    private let sampleRate: UInt32
    private let channelCount: UInt16

    private(set) var dataByteCount: UInt32 = 0

    init(fileURL: URL, sampleRate: UInt32 = 16_000, channelCount: UInt16 = 1) throws {
        self.sampleRate = sampleRate
        self.channelCount = channelCount

        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
        let headerData = Self.headerData(dataByteCount: 0, sampleRate: sampleRate, channelCount: channelCount)
        if FileManager.default.fileExists(atPath: fileURL.path) {
            try FileManager.default.removeItem(at: fileURL)
        }

        try headerData.write(to: fileURL, options: .atomic)
        self.handle = try FileHandle(forUpdating: fileURL)
    }

    func append(samples: [Float]) throws {
        guard !samples.isEmpty else {
            return
        }

        let pcmSamples = samples.map { sample -> Int16 in
            let clamped = max(-1.0, min(sample, 1.0))
            let scaled = Int((clamped * 32767.0).rounded())
            return Int16(littleEndian: Int16(max(Int(Int16.min), min(Int(Int16.max), scaled))))
        }

        let data = pcmSamples.withUnsafeBufferPointer { Data(buffer: $0) }
        _ = try handle.seekToEnd()
        try handle.write(contentsOf: data)
        dataByteCount += UInt32(data.count)
        try rewriteHeader()
    }

    func close() throws {
        try rewriteHeader()
        try handle.close()
    }

    private func rewriteHeader() throws {
        try handle.seek(toOffset: 0)
        try handle.write(contentsOf: Self.headerData(dataByteCount: dataByteCount, sampleRate: sampleRate, channelCount: channelCount))
        _ = try handle.seekToEnd()
    }

    private static func headerData(dataByteCount: UInt32, sampleRate: UInt32, channelCount: UInt16) -> Data {
        let blockAlign = channelCount * 2
        let byteRate = sampleRate * UInt32(blockAlign)
        let riffChunkSize = 36 + dataByteCount

        var data = Data()
        data.append(Data("RIFF".utf8))
        data.append(Self.littleEndianBytes(riffChunkSize))
        data.append(Data("WAVE".utf8))
        data.append(Data("fmt ".utf8))
        data.append(Self.littleEndianBytes(UInt32(16)))
        data.append(Self.littleEndianBytes(UInt16(1)))
        data.append(Self.littleEndianBytes(channelCount))
        data.append(Self.littleEndianBytes(sampleRate))
        data.append(Self.littleEndianBytes(byteRate))
        data.append(Self.littleEndianBytes(blockAlign))
        data.append(Self.littleEndianBytes(UInt16(16)))
        data.append(Data("data".utf8))
        data.append(Self.littleEndianBytes(dataByteCount))
        return data
    }

    private static func littleEndianBytes<T: FixedWidthInteger>(_ value: T) -> Data {
        withUnsafeBytes(of: value.littleEndian) { Data($0) }
    }
}
