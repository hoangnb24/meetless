import Foundation
@testable import Meetless

enum MeetlessTestSupport {
    struct TimeoutError: LocalizedError {
        let description: String

        var errorDescription: String? {
            "Timed out while waiting for \(description)."
        }
    }

    static func makeTemporaryDirectory(prefix: String) throws -> URL {
        let directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(prefix, isDirectory: true)
            .appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        return directoryURL
    }

    static func writePCM16WaveFile(to fileURL: URL, sampleCount: Int, amplitude: Int16 = 1024) throws {
        var data = Data()
        let sampleRate = UInt32(16_000)
        let channelCount = UInt16(1)
        let bitsPerSample = UInt16(16)
        let bytesPerSample = UInt16(bitsPerSample / 8)
        let byteRate = sampleRate * UInt32(channelCount) * UInt32(bytesPerSample)
        let blockAlign = channelCount * bytesPerSample
        let pcmByteCount = UInt32(sampleCount) * UInt32(bytesPerSample)

        data.append("RIFF".data(using: .ascii)!)
        data.append(littleEndianBytes(UInt32(36) + pcmByteCount))
        data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!)
        data.append(littleEndianBytes(UInt32(16)))
        data.append(littleEndianBytes(UInt16(1)))
        data.append(littleEndianBytes(channelCount))
        data.append(littleEndianBytes(sampleRate))
        data.append(littleEndianBytes(byteRate))
        data.append(littleEndianBytes(blockAlign))
        data.append(littleEndianBytes(bitsPerSample))
        data.append("data".data(using: .ascii)!)
        data.append(littleEndianBytes(pcmByteCount))

        for _ in 0..<sampleCount {
            data.append(littleEndianBytes(amplitude))
        }

        try data.write(to: fileURL, options: .atomic)
    }

    static func makeChunk(
        source: RecordingSourceKind,
        text: String,
        sequenceNumber: Int,
        startFrameIndex: Int64 = 0,
        endFrameIndex: Int64 = 16_000
    ) -> CommittedTranscriptChunk {
        CommittedTranscriptChunk(
            id: UUID(),
            source: source,
            text: text,
            startFrameIndex: startFrameIndex,
            endFrameIndex: endFrameIndex,
            sampleRate: 16_000,
            sequenceNumber: sequenceNumber
        )
    }

    static func waitForValue<T: Sendable>(
        description: String,
        timeoutNanoseconds: UInt64 = 2_000_000_000,
        pollNanoseconds: UInt64 = 50_000_000,
        producer: @escaping @Sendable () async -> T?
    ) async throws -> T {
        let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds

        while DispatchTime.now().uptimeNanoseconds < deadline {
            if let value = await producer() {
                return value
            }

            try await Task.sleep(nanoseconds: pollNanoseconds)
        }

        throw TimeoutError(description: description)
    }

    private static func littleEndianBytes<T: FixedWidthInteger>(_ value: T) -> Data {
        var littleEndianValue = value.littleEndian
        return withUnsafeBytes(of: &littleEndianValue) { Data($0) }
    }
}
