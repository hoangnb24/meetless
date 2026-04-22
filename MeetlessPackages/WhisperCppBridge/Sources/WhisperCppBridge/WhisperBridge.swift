import Foundation
import whisper

enum WhisperBridgeError: LocalizedError {
    case missingBundledResource(name: String, ext: String)
    case failedToInitializeModel(path: String)
    case noLoadedModel(source: RecordingSourceKind)
    case transcriptionFailed(code: Int32)
    case emptyTranscription

    var errorDescription: String? {
        switch self {
        case let .missingBundledResource(name, ext):
            return "Missing bundled resource \(name).\(ext)."
        case let .failedToInitializeModel(path):
            return "Failed to initialize whisper from \(path)."
        case let .noLoadedModel(source):
            return "No whisper model is loaded for the \(source.rawValue) worker."
        case let .transcriptionFailed(code):
            return "whisper_full failed with status \(code)."
        case .emptyTranscription:
            return "Whisper returned an empty transcription."
        }
    }
}

struct WhisperBridgeAssets {
    let bundle: Bundle
    let modelBasename: String
    let modelExtension: String
    let sampleBasename: String
    let sampleExtension: String

    init(
        bundle: Bundle = .main,
        modelBasename: String = "ggml-tiny.en",
        modelExtension: String = "bin",
        sampleBasename: String = "jfk",
        sampleExtension: String = "wav"
    ) {
        self.bundle = bundle
        self.modelBasename = modelBasename
        self.modelExtension = modelExtension
        self.sampleBasename = sampleBasename
        self.sampleExtension = sampleExtension
    }

    func bundledModelURL() throws -> URL {
        guard let url = bundle.url(forResource: modelBasename, withExtension: modelExtension) else {
            throw WhisperBridgeError.missingBundledResource(name: modelBasename, ext: modelExtension)
        }
        return url
    }

    func bundledSmokeSampleURL() throws -> URL {
        guard let url = bundle.url(forResource: sampleBasename, withExtension: sampleExtension) else {
            throw WhisperBridgeError.missingBundledResource(name: sampleBasename, ext: sampleExtension)
        }
        return url
    }

    var bundledModelFilename: String {
        "\(modelBasename).\(modelExtension)"
    }

    var bundledSampleFilename: String {
        "\(sampleBasename).\(sampleExtension)"
    }
}

struct WhisperSmokeTranscription {
    let source: RecordingSourceKind
    let modelName: String
    let sampleName: String
    let text: String
    let sampleCount: Int
    let threadCount: Int
}

final class WhisperContextHandle {
    let opaquePointer: OpaquePointer

    init(opaquePointer: OpaquePointer) {
        self.opaquePointer = opaquePointer
    }

    deinit {
        whisper_free(opaquePointer)
    }
}
