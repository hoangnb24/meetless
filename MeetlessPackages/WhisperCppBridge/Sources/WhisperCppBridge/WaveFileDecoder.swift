import Foundation

enum WaveFileDecoderError: LocalizedError {
    case unsupportedFormat(URL)

    var errorDescription: String? {
        switch self {
        case let .unsupportedFormat(url):
            return "Unsupported wave file format at \(url.lastPathComponent)."
        }
    }
}

func decodePCM16WaveFile(_ url: URL) throws -> [Float] {
    let data = try Data(contentsOf: url)

    guard
        data.count > 44,
        String(data: data[0..<4], encoding: .ascii) == "RIFF",
        String(data: data[8..<12], encoding: .ascii) == "WAVE"
    else {
        throw WaveFileDecoderError.unsupportedFormat(url)
    }

    return stride(from: 44, to: data.count, by: 2).map { offset in
        data[offset..<(offset + 2)].withUnsafeBytes { bytes in
            let sample = Int16(littleEndian: bytes.load(as: Int16.self))
            return max(-1.0, min(Float(sample) / 32767.0, 1.0))
        }
    }
}
