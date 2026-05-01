import Foundation

protocol GeminiSessionNotesGenerating: Sendable {
    func generateContent(
        apiKey: String,
        audioArtifacts: SessionAudioArtifactsForUpload
    ) async throws -> GeminiGenerateContentResponse
}

protocol GeminiSessionNotesOrchestrating {
    func generateNotes(for session: PersistedSessionBundle) async throws -> GeneratedSessionNotes
}

enum GeminiSessionNotesOrchestrationError: Error, Equatable, Sendable {
    case missingAPIKey
    case alreadyGenerated
    case missingAudio(SessionAudioArtifactResolutionError)
    case authentication
    case client
    case provider
    case parser(GeminiSessionNotesError)
    case persistence
}

struct GeminiSessionNotesOrchestrator: GeminiSessionNotesOrchestrating {
    private let apiKeyStore: any GeminiAPIKeyStoring
    private let sessionRepository: SessionRepository
    private let generator: any GeminiSessionNotesGenerating
    private let generatedAt: @Sendable () -> Date

    init(
        apiKeyStore: any GeminiAPIKeyStoring = KeychainGeminiAPIKeyStore(),
        sessionRepository: SessionRepository = SessionRepository(),
        generator: any GeminiSessionNotesGenerating = GeminiSessionNotesClient(),
        generatedAt: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.apiKeyStore = apiKeyStore
        self.sessionRepository = sessionRepository
        self.generator = generator
        self.generatedAt = generatedAt
    }

    func generateNotes(for session: PersistedSessionBundle) async throws -> GeneratedSessionNotes {
        let apiKey: String
        do {
            guard let loadedAPIKey = try apiKeyStore.loadAPIKey() else {
                throw GeminiSessionNotesOrchestrationError.missingAPIKey
            }

            apiKey = loadedAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !apiKey.isEmpty else {
                throw GeminiSessionNotesOrchestrationError.missingAPIKey
            }
        } catch let error as GeminiSessionNotesOrchestrationError {
            throw error
        } catch {
            throw GeminiSessionNotesOrchestrationError.client
        }

        do {
            if try await sessionRepository.loadGeneratedNotes(for: session) != nil {
                throw GeminiSessionNotesOrchestrationError.alreadyGenerated
            }
        } catch let error as GeminiSessionNotesOrchestrationError {
            throw error
        } catch {
            throw GeminiSessionNotesOrchestrationError.persistence
        }

        let audioArtifacts: SessionAudioArtifactsForUpload
        do {
            audioArtifacts = try await sessionRepository.resolveAudioArtifactsForUpload(for: session)
        } catch let error as SessionAudioArtifactResolutionError {
            throw GeminiSessionNotesOrchestrationError.missingAudio(error)
        } catch {
            throw GeminiSessionNotesOrchestrationError.persistence
        }

        let response: GeminiGenerateContentResponse
        do {
            response = try await generator.generateContent(apiKey: apiKey, audioArtifacts: audioArtifacts)
        } catch let error as GeminiSessionNotesError {
            throw Self.mapGenerationError(error)
        } catch {
            throw GeminiSessionNotesOrchestrationError.client
        }

        let notes: GeneratedSessionNotes
        do {
            notes = try GeminiSessionNotesParser.parse(response, generatedAt: generatedAt())
        } catch let error as GeminiSessionNotesError {
            throw GeminiSessionNotesOrchestrationError.parser(error)
        } catch {
            throw GeminiSessionNotesOrchestrationError.parser(.malformedStructuredJSON)
        }

        do {
            try await sessionRepository.saveGeneratedNotes(notes, for: session)
        } catch let error as GeneratedSessionNotesPersistenceError where error == .alreadyExists {
            throw GeminiSessionNotesOrchestrationError.alreadyGenerated
        } catch {
            throw GeminiSessionNotesOrchestrationError.persistence
        }

        return notes
    }

    private static func mapGenerationError(_ error: GeminiSessionNotesError) -> GeminiSessionNotesOrchestrationError {
        switch error {
        case .authenticationFailed:
            return .authentication
        case .invalidAPIKey, .unsupportedAudioMIMEType:
            return .client
        case .uploadFailed, .generationFailed, .malformedUploadResponse, .malformedGenerateContentResponse:
            return .provider
        case .malformedStructuredJSON,
                .missingRequiredField,
                .emptyRequiredField,
                .invalidActionItems,
                .sourceLabelLeakage:
            return .parser(error)
        }
    }
}

protocol GeminiHTTPTransport: Sendable {
    func send(_ request: GeminiHTTPRequest) async throws -> GeminiHTTPResponse
}

struct GeminiHTTPRequest: Equatable, Sendable {
    let method: String
    let url: URL
    let headers: [String: String]
    let body: Data
}

struct GeminiHTTPResponse: Equatable, Sendable {
    let statusCode: Int
    let body: Data
}

struct GeminiGenerateContentResponse: Equatable, Sendable {
    let fileURIs: [String]
    let body: Data
}

enum GeminiSessionNotesError: Error, Equatable, Sendable {
    case invalidAPIKey
    case authenticationFailed(statusCode: Int)
    case uploadFailed(statusCode: Int)
    case generationFailed(statusCode: Int)
    case unsupportedAudioMIMEType(filename: String)
    case malformedUploadResponse
    case malformedGenerateContentResponse
    case malformedStructuredJSON
    case missingRequiredField(String)
    case emptyRequiredField(String)
    case invalidActionItems
    case sourceLabelLeakage(field: String)
}

enum GeminiSessionNotesModel {
    static let stableFlash = "gemini-2.5-flash"
}

struct GeminiSessionNotesClient: GeminiSessionNotesGenerating {
    private let transport: any GeminiHTTPTransport
    private let baseURL: URL
    private let jsonEncoder: JSONEncoder
    private let jsonDecoder: JSONDecoder

    init(
        transport: any GeminiHTTPTransport = URLSessionGeminiHTTPTransport(),
        baseURL: URL = URL(string: "https://generativelanguage.googleapis.com")!
    ) {
        self.transport = transport
        self.baseURL = baseURL
        self.jsonEncoder = JSONEncoder()
        self.jsonDecoder = JSONDecoder()
    }

    func generateContent(
        apiKey: String,
        audioArtifacts: SessionAudioArtifactsForUpload
    ) async throws -> GeminiGenerateContentResponse {
        let normalizedAPIKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedAPIKey.isEmpty else {
            throw GeminiSessionNotesError.invalidAPIKey
        }

        var uploadedFiles: [GeminiUploadedFile] = []
        for artifact in audioArtifacts.artifacts {
            let upload = try makeUploadRequest(apiKey: normalizedAPIKey, artifact: artifact)
            let response = try await transport.send(upload.request)
            try validate(response: response, failedError: .uploadFailed(statusCode: response.statusCode))
            let uploadedFile = try decodeUploadedFile(from: response.body, fallbackMIMEType: upload.mimeType)
            uploadedFiles.append(uploadedFile)
        }

        let generateRequest = try makeGenerateRequest(
            apiKey: normalizedAPIKey,
            sessionTitle: audioArtifacts.sessionTitle,
            files: uploadedFiles
        )
        let generateResponse = try await transport.send(generateRequest)
        try validate(response: generateResponse, failedError: .generationFailed(statusCode: generateResponse.statusCode))

        return GeminiGenerateContentResponse(
            fileURIs: uploadedFiles.map(\.uri),
            body: generateResponse.body
        )
    }

    private func makeUploadRequest(
        apiKey: String,
        artifact: SessionAudioArtifactForUpload
    ) throws -> GeminiUploadRequest {
        let mimeType = try GeminiAudioMIMETypeMapper.mimeType(for: artifact.filename)
        let body = try Data(contentsOf: artifact.fileURL)
        let url = baseURL.appendingPathComponent("upload/v1beta/files")

        return GeminiUploadRequest(
            request: GeminiHTTPRequest(
                method: "POST",
                url: url,
                headers: [
                    "Content-Type": mimeType,
                    "Content-Length": "\(body.count)",
                    "X-Goog-API-Key": apiKey,
                    "X-Goog-Upload-Protocol": "raw",
                    "X-Goog-Upload-Header-Content-Length": "\(body.count)",
                    "X-Goog-Upload-Header-Content-Type": mimeType
                ],
                body: body
            ),
            mimeType: mimeType
        )
    }

    private func makeGenerateRequest(
        apiKey: String,
        sessionTitle: String,
        files: [GeminiUploadedFile]
    ) throws -> GeminiHTTPRequest {
        let body = GeminiGenerateContentRequest(
            contents: [
                GeminiContent(
                    role: "user",
                    parts: [
                        GeminiPart(text: Self.prompt(sessionTitle: sessionTitle), fileData: nil)
                    ] + files.map { file in
                        GeminiPart(
                            text: nil,
                            fileData: GeminiFileData(
                                mimeType: file.mimeType,
                                fileURI: file.uri
                            )
                        )
                    }
                )
            ],
            generationConfig: GeminiGenerationConfig(
                responseMIMEType: "application/json",
                responseSchema: GeminiSessionNotesSchema.make()
            )
        )

        let url = baseURL
            .appendingPathComponent("v1beta/models/\(GeminiSessionNotesModel.stableFlash):generateContent")

        return GeminiHTTPRequest(
            method: "POST",
            url: url,
            headers: [
                "Content-Type": "application/json",
                "X-Goog-API-Key": apiKey
            ],
            body: try jsonEncoder.encode(body)
        )
    }

    private func validate(response: GeminiHTTPResponse, failedError: GeminiSessionNotesError) throws {
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 || response.statusCode == 403 {
                throw GeminiSessionNotesError.authenticationFailed(statusCode: response.statusCode)
            }

            throw failedError
        }
    }

    private func decodeUploadedFile(from data: Data, fallbackMIMEType: String) throws -> GeminiUploadedFile {
        do {
            let envelope = try jsonDecoder.decode(GeminiUploadResponseEnvelope.self, from: data)
            guard !envelope.file.uri.isEmpty else {
                throw GeminiSessionNotesError.malformedUploadResponse
            }

            return GeminiUploadedFile(
                uri: envelope.file.uri,
                mimeType: envelope.file.mimeType ?? fallbackMIMEType
            )
        } catch let error as GeminiSessionNotesError {
            throw error
        } catch {
            throw GeminiSessionNotesError.malformedUploadResponse
        }
    }

    private static func prompt(sessionTitle: String) -> String {
        """
        Generate one combined meeting transcript, one concise speaker-aware summary, and simple action-item bullets for the saved session "\(sessionTitle)".
        Return JSON only. Do not expose internal capture source labels.
        """
    }
}

enum GeminiSessionNotesParser {
    static func parse(
        _ response: GeminiGenerateContentResponse,
        generatedAt: Date = Date()
    ) throws -> GeneratedSessionNotes {
        let structuredData = try extractStructuredJSONData(from: response.body)
        let payload = try decodeStructuredPayload(from: structuredData)

        let transcript = try requiredText(payload.transcript, field: "transcript")
        let summary = try requiredText(payload.summary, field: "summary")
        let actionItems = try requiredActionItems(payload.actionItems)

        try rejectUserVisibleSourceLabels(in: summary, field: "summary")
        for actionItem in actionItems {
            try rejectUserVisibleSourceLabels(in: actionItem, field: "actionItems")
        }

        return GeneratedSessionNotes(
            generatedAt: generatedAt,
            hiddenGeminiTranscript: transcript,
            summary: summary,
            actionItemBullets: actionItems
        )
    }

    private static func extractStructuredJSONData(from data: Data) throws -> Data {
        if let envelope = try? JSONDecoder().decode(GeminiGenerateContentEnvelope.self, from: data) {
            let textParts = envelope.candidates
                .flatMap(\.content.parts)
                .compactMap(\.text)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            guard let structuredText = textParts.first else {
                throw GeminiSessionNotesError.malformedGenerateContentResponse
            }

            return Data(structuredText.utf8)
        }

        return data
    }

    private static func decodeStructuredPayload(from data: Data) throws -> GeminiStructuredSessionNotesPayload {
        do {
            return try JSONDecoder().decode(GeminiStructuredSessionNotesPayload.self, from: data)
        } catch let error as GeminiSessionNotesError {
            throw error
        } catch let error as DecodingError {
            if error.isMissingRequiredField {
                throw GeminiSessionNotesError.missingRequiredField(error.missingFieldName)
            }

            throw GeminiSessionNotesError.malformedStructuredJSON
        } catch {
            throw GeminiSessionNotesError.malformedStructuredJSON
        }
    }

    private static func requiredText(_ value: String?, field: String) throws -> String {
        guard let value else {
            throw GeminiSessionNotesError.missingRequiredField(field)
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw GeminiSessionNotesError.emptyRequiredField(field)
        }

        return trimmed
    }

    private static func requiredActionItems(_ value: [String]?) throws -> [String] {
        guard let value else {
            throw GeminiSessionNotesError.missingRequiredField("actionItems")
        }

        let trimmed = value.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !trimmed.isEmpty, trimmed.allSatisfy({ !$0.isEmpty }) else {
            throw GeminiSessionNotesError.invalidActionItems
        }

        return trimmed
    }

    private static func rejectUserVisibleSourceLabels(in text: String, field: String) throws {
        let lowercased = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let linePrefixes = [
            "meeting:",
            "me:",
            "- meeting:",
            "- me:",
            "* meeting:",
            "* me:"
        ]
        let leakedPhrases = [
            "meeting lane",
            "me lane",
            "meeting audio",
            "microphone audio",
            "source: meeting",
            "source: me",
            "speaker: meeting",
            "speaker: me"
        ]

        if lowercased
            .components(separatedBy: .newlines)
            .map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) })
            .contains(where: { line in linePrefixes.contains(where: line.hasPrefix) })
            || leakedPhrases.contains(where: lowercased.contains) {
            throw GeminiSessionNotesError.sourceLabelLeakage(field: field)
        }
    }
}

struct URLSessionGeminiHTTPTransport: GeminiHTTPTransport {
    func send(_ request: GeminiHTTPRequest) async throws -> GeminiHTTPResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        request.headers.forEach { key, value in
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }

        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        return GeminiHTTPResponse(statusCode: statusCode, body: data)
    }
}

private struct GeminiUploadRequest {
    let request: GeminiHTTPRequest
    let mimeType: String
}

private struct GeminiUploadedFile {
    let uri: String
    let mimeType: String
}

private enum GeminiAudioMIMETypeMapper {
    static func mimeType(for filename: String) throws -> String {
        let lowercasedExtension = URL(fileURLWithPath: filename).pathExtension.lowercased()
        switch lowercasedExtension {
        case "m4a":
            return "audio/mp4"
        case "wav":
            return "audio/wav"
        default:
            throw GeminiSessionNotesError.unsupportedAudioMIMEType(filename: filename)
        }
    }
}

private struct GeminiUploadResponseEnvelope: Decodable {
    let file: GeminiUploadedFileResponse
}

private struct GeminiUploadedFileResponse: Decodable {
    let uri: String
    let mimeType: String?
}

private struct GeminiGenerateContentEnvelope: Decodable {
    let candidates: [GeminiGenerateCandidate]
}

private struct GeminiGenerateCandidate: Decodable {
    let content: GeminiGenerateCandidateContent
}

private struct GeminiGenerateCandidateContent: Decodable {
    let parts: [GeminiGenerateCandidatePart]
}

private struct GeminiGenerateCandidatePart: Decodable {
    let text: String?
}

private struct GeminiStructuredSessionNotesPayload: Decodable {
    let transcript: String?
    let summary: String?
    let actionItems: [String]?

    enum CodingKeys: String, CodingKey {
        case transcript
        case summary
        case actionItems
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.transcript = try container.decodeIfPresent(String.self, forKey: .transcript)
        self.summary = try container.decodeIfPresent(String.self, forKey: .summary)

        do {
            self.actionItems = try container.decodeIfPresent([String].self, forKey: .actionItems)
        } catch {
            throw GeminiSessionNotesError.invalidActionItems
        }
    }
}

private extension DecodingError {
    var isMissingRequiredField: Bool {
        if case .keyNotFound = self {
            return true
        }

        return false
    }

    var missingFieldName: String {
        if case .keyNotFound(let key, _) = self {
            return key.stringValue
        }

        return ""
    }
}

private struct GeminiGenerateContentRequest: Encodable {
    let contents: [GeminiContent]
    let generationConfig: GeminiGenerationConfig
}

private struct GeminiContent: Encodable {
    let role: String
    let parts: [GeminiPart]
}

private struct GeminiPart: Encodable {
    let text: String?
    let fileData: GeminiFileData?
}

private struct GeminiFileData: Encodable {
    let mimeType: String
    let fileURI: String

    enum CodingKeys: String, CodingKey {
        case mimeType
        case fileURI = "fileUri"
    }
}

private struct GeminiGenerationConfig: Encodable {
    let responseMIMEType: String
    let responseSchema: GeminiSchema

    enum CodingKeys: String, CodingKey {
        case responseMIMEType = "responseMimeType"
        case responseSchema
    }
}

private final class GeminiSchema: Encodable {
    let type: String
    let properties: [String: GeminiSchema]?
    let items: GeminiSchema?
    let required: [String]?

    init(
        type: String,
        properties: [String: GeminiSchema]?,
        items: GeminiSchema?,
        required: [String]?
    ) {
        self.type = type
        self.properties = properties
        self.items = items
        self.required = required
    }
}

private enum GeminiSessionNotesSchema {
    static func make() -> GeminiSchema {
        GeminiSchema(
            type: "object",
            properties: [
                "transcript": GeminiSchema(type: "string", properties: nil, items: nil, required: nil),
                "summary": GeminiSchema(type: "string", properties: nil, items: nil, required: nil),
                "actionItems": GeminiSchema(
                    type: "array",
                    properties: nil,
                    items: GeminiSchema(type: "string", properties: nil, items: nil, required: nil),
                    required: nil
                )
            ],
            items: nil,
            required: [
                "transcript",
                "summary",
                "actionItems"
            ]
        )
    }
}
