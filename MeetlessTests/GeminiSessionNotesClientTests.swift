import XCTest
@testable import Meetless

final class GeminiSessionNotesClientTests: XCTestCase {
    func testParserCreatesGeneratedSessionNotesFromGeminiStructuredEnvelope() throws {
        let generatedAt = Date(timeIntervalSince1970: 1_798_000_000)
        let response = GeminiGenerateContentResponse(
            fileURIs: ["files/meeting-audio", "files/microphone-audio"],
            body: Self.generateContentEnvelope(
                structuredJSON: """
                {
                  "transcript": "Alice opened planning. Bob confirmed follow-up.",
                  "summary": "The team aligned on launch preparation and review timing.",
                  "actionItems": [
                    "Send the launch checklist",
                    "Confirm reviewer availability"
                  ]
                }
                """
            )
        )

        let notes = try GeminiSessionNotesParser.parse(response, generatedAt: generatedAt)

        XCTAssertEqual(notes.generatedAt, generatedAt)
        XCTAssertEqual(notes.hiddenGeminiTranscript, "Alice opened planning. Bob confirmed follow-up.")
        XCTAssertEqual(notes.summary, "The team aligned on launch preparation and review timing.")
        XCTAssertEqual(notes.actionItemBullets, [
            "Send the launch checklist",
            "Confirm reviewer availability"
        ])
    }

    func testParserRejectsMalformedGeminiEnvelope() throws {
        let response = GeminiGenerateContentResponse(
            fileURIs: [],
            body: Data(#"{"candidates":[{"content":{"parts":[]}}]}"#.utf8)
        )

        do {
            _ = try GeminiSessionNotesParser.parse(response)
            XCTFail("Expected malformed generateContent response.")
        } catch let error as GeminiSessionNotesError {
            XCTAssertEqual(error, .malformedGenerateContentResponse)
        }
    }

    func testParserRejectsMalformedStructuredJSON() throws {
        let response = GeminiGenerateContentResponse(
            fileURIs: [],
            body: Self.generateContentEnvelope(structuredJSON: #"{"transcript":"ok","#)
        )

        do {
            _ = try GeminiSessionNotesParser.parse(response)
            XCTFail("Expected malformed structured JSON.")
        } catch let error as GeminiSessionNotesError {
            XCTAssertEqual(error, .malformedStructuredJSON)
        }
    }

    func testParserRejectsMissingRequiredFields() throws {
        let response = GeminiGenerateContentResponse(
            fileURIs: [],
            body: Self.generateContentEnvelope(
                structuredJSON: #"{"transcript":"Transcript","actionItems":["Follow up"]}"#
            )
        )

        do {
            _ = try GeminiSessionNotesParser.parse(response)
            XCTFail("Expected missing summary.")
        } catch let error as GeminiSessionNotesError {
            XCTAssertEqual(error, .missingRequiredField("summary"))
        }
    }

    func testParserRejectsEmptyTranscriptAndSummary() throws {
        try assertParserError(
            structuredJSON: #"{"transcript":"  ","summary":"Summary","actionItems":["Follow up"]}"#,
            expectedError: .emptyRequiredField("transcript")
        )
        try assertParserError(
            structuredJSON: #"{"transcript":"Transcript","summary":"\n\t","actionItems":["Follow up"]}"#,
            expectedError: .emptyRequiredField("summary")
        )
    }

    func testParserRejectsEmptyAndInvalidActionItems() throws {
        try assertParserError(
            structuredJSON: #"{"transcript":"Transcript","summary":"Summary","actionItems":[]}"#,
            expectedError: .invalidActionItems
        )
        try assertParserError(
            structuredJSON: #"{"transcript":"Transcript","summary":"Summary","actionItems":["Follow up","  "]}"#,
            expectedError: .invalidActionItems
        )
        try assertParserError(
            structuredJSON: #"{"transcript":"Transcript","summary":"Summary","actionItems":["Follow up",42]}"#,
            expectedError: .invalidActionItems
        )
    }

    func testParserRejectsUserVisibleInternalSourceLabels() throws {
        try assertParserError(
            structuredJSON: #"{"transcript":"Meeting: raw hidden transcript can keep speaker text.","summary":"Meeting: the plan is ready.","actionItems":["Follow up"]}"#,
            expectedError: .sourceLabelLeakage(field: "summary")
        )
        try assertParserError(
            structuredJSON: #"{"transcript":"Transcript","summary":"Summary","actionItems":["Me lane should send the recap"]}"#,
            expectedError: .sourceLabelLeakage(field: "actionItems")
        )
    }

    func testGenerateContentUploadsBothAudioArtifactsThenBuildsStructuredGenerateRequest() async throws {
        let fixture = try Self.makeArtifactsFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let transport = FixtureGeminiHTTPTransport(responses: [
            Self.uploadResponse(uri: "files/meeting-audio", mimeType: "audio/mp4"),
            Self.uploadResponse(uri: "files/microphone-audio", mimeType: "audio/mp4"),
            GeminiHTTPResponse(statusCode: 200, body: Data(#"{"ok":true}"#.utf8))
        ])
        let client = GeminiSessionNotesClient(
            transport: transport,
            baseURL: URL(string: "https://gemini.test")!
        )

        let response = try await client.generateContent(
            apiKey: "test-gemini-key",
            audioArtifacts: fixture.artifacts
        )
        let requests = await transport.requests

        XCTAssertEqual(response.fileURIs, ["files/meeting-audio", "files/microphone-audio"])
        XCTAssertEqual(requests.count, 3)

        XCTAssertEqual(requests[0].method, "POST")
        XCTAssertEqual(requests[0].url.absoluteString, "https://gemini.test/upload/v1beta/files")
        XCTAssertEqual(requests[0].headers["X-Goog-API-Key"], "test-gemini-key")
        XCTAssertEqual(requests[0].headers["X-Goog-Upload-Protocol"], "raw")
        XCTAssertEqual(requests[0].headers["X-Goog-Upload-Header-Content-Type"], "audio/mp4")
        XCTAssertEqual(requests[0].headers["Content-Type"], "audio/mp4")
        XCTAssertEqual(requests[0].body, Data("meeting audio".utf8))

        XCTAssertEqual(requests[1].method, "POST")
        XCTAssertEqual(requests[1].url.absoluteString, "https://gemini.test/upload/v1beta/files")
        XCTAssertEqual(requests[1].headers["X-Goog-API-Key"], "test-gemini-key")
        XCTAssertEqual(requests[1].headers["X-Goog-Upload-Header-Content-Type"], "audio/mp4")
        XCTAssertEqual(requests[1].body, Data("microphone audio".utf8))

        let generateRequest = requests[2]
        XCTAssertEqual(generateRequest.method, "POST")
        XCTAssertEqual(
            generateRequest.url.absoluteString,
            "https://gemini.test/v1beta/models/\(GeminiSessionNotesModel.stableFlash):generateContent"
        )
        XCTAssertEqual(GeminiSessionNotesModel.stableFlash, "gemini-2.5-flash")
        XCTAssertEqual(generateRequest.headers["X-Goog-API-Key"], "test-gemini-key")
        XCTAssertEqual(generateRequest.headers["Content-Type"], "application/json")

        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: generateRequest.body) as? [String: Any]
        )
        let generationConfig = try XCTUnwrap(json["generationConfig"] as? [String: Any])
        let schema = try XCTUnwrap(generationConfig["responseSchema"] as? [String: Any])
        let properties = try XCTUnwrap(schema["properties"] as? [String: Any])
        let required = try XCTUnwrap(schema["required"] as? [String])
        let contents = try XCTUnwrap(json["contents"] as? [[String: Any]])
        let parts = try XCTUnwrap(contents.first?["parts"] as? [[String: Any]])
        let fileDataParts = parts.compactMap { $0["fileData"] as? [String: Any] }

        XCTAssertEqual(generationConfig["responseMimeType"] as? String, "application/json")
        XCTAssertEqual(schema["type"] as? String, "object")
        XCTAssertNotNil(properties["transcript"])
        XCTAssertNotNil(properties["summary"])
        XCTAssertNotNil(properties["actionItems"])
        XCTAssertEqual(Set(required), Set(["transcript", "summary", "actionItems"]))
        XCTAssertEqual(fileDataParts.count, 2)
        XCTAssertEqual(fileDataParts.map { $0["fileUri"] as? String }, ["files/meeting-audio", "files/microphone-audio"])
        XCTAssertEqual(fileDataParts.map { $0["mimeType"] as? String }, ["audio/mp4", "audio/mp4"])
    }

    func testGenerateContentRejectsBlankAPIKeyBeforeTransport() async throws {
        let fixture = try Self.makeArtifactsFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let transport = FixtureGeminiHTTPTransport(responses: [])
        let client = GeminiSessionNotesClient(transport: transport)

        do {
            _ = try await client.generateContent(apiKey: "   ", audioArtifacts: fixture.artifacts)
            XCTFail("Expected blank API key to fail.")
        } catch let error as GeminiSessionNotesError {
            XCTAssertEqual(error, .invalidAPIKey)
        }

        let requestCount = await transport.requests.count
        XCTAssertEqual(requestCount, 0)
    }

    func testGenerateContentMapsAuthFailureFromUpload() async throws {
        let fixture = try Self.makeArtifactsFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let transport = FixtureGeminiHTTPTransport(responses: [
            GeminiHTTPResponse(statusCode: 401, body: Data())
        ])
        let client = GeminiSessionNotesClient(transport: transport)

        do {
            _ = try await client.generateContent(apiKey: "bad-key", audioArtifacts: fixture.artifacts)
            XCTFail("Expected auth failure.")
        } catch let error as GeminiSessionNotesError {
            XCTAssertEqual(error, .authenticationFailed(statusCode: 401))
        }

        let requestCount = await transport.requests.count
        XCTAssertEqual(requestCount, 1)
    }

    func testGenerateContentMapsUploadFailure() async throws {
        let fixture = try Self.makeArtifactsFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let transport = FixtureGeminiHTTPTransport(responses: [
            GeminiHTTPResponse(statusCode: 500, body: Data())
        ])
        let client = GeminiSessionNotesClient(transport: transport)

        do {
            _ = try await client.generateContent(apiKey: "test-key", audioArtifacts: fixture.artifacts)
            XCTFail("Expected upload failure.")
        } catch let error as GeminiSessionNotesError {
            XCTAssertEqual(error, .uploadFailed(statusCode: 500))
        }

        let requestCount = await transport.requests.count
        XCTAssertEqual(requestCount, 1)
    }

    func testGenerateContentMapsGenerationFailureAfterBothUploads() async throws {
        let fixture = try Self.makeArtifactsFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let transport = FixtureGeminiHTTPTransport(responses: [
            Self.uploadResponse(uri: "files/meeting-audio", mimeType: "audio/mp4"),
            Self.uploadResponse(uri: "files/microphone-audio", mimeType: "audio/mp4"),
            GeminiHTTPResponse(statusCode: 503, body: Data())
        ])
        let client = GeminiSessionNotesClient(transport: transport)

        do {
            _ = try await client.generateContent(apiKey: "test-key", audioArtifacts: fixture.artifacts)
            XCTFail("Expected generation failure.")
        } catch let error as GeminiSessionNotesError {
            XCTAssertEqual(error, .generationFailed(statusCode: 503))
        }

        let requestCount = await transport.requests.count
        XCTAssertEqual(requestCount, 3)
    }

    private static func makeArtifactsFixture() throws -> (directoryURL: URL, artifacts: SessionAudioArtifactsForUpload) {
        let directoryURL = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "GeminiSessionNotesClientTests")
        let meetingURL = directoryURL.appendingPathComponent("meeting.m4a")
        let microphoneURL = directoryURL.appendingPathComponent("me.m4a")
        try Data("meeting audio".utf8).write(to: meetingURL)
        try Data("microphone audio".utf8).write(to: microphoneURL)

        return (
            directoryURL,
            SessionAudioArtifactsForUpload(
                sessionID: "session-1",
                sessionTitle: "Weekly Planning",
                artifacts: [
                    SessionAudioArtifactForUpload(
                        source: .meeting,
                        fileURL: meetingURL,
                        filename: "meeting.m4a",
                        isPrimarySourceOfRecord: true
                    ),
                    SessionAudioArtifactForUpload(
                        source: .me,
                        fileURL: microphoneURL,
                        filename: "me.m4a",
                        isPrimarySourceOfRecord: true
                    )
                ]
            )
        )
    }

    private static func uploadResponse(uri: String, mimeType: String) -> GeminiHTTPResponse {
        GeminiHTTPResponse(
            statusCode: 200,
            body: Data(#"{"file":{"uri":"\#(uri)","mimeType":"\#(mimeType)"}}"#.utf8)
        )
    }

    private static func generateContentEnvelope(structuredJSON: String) -> Data {
        let escaped = structuredJSON
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\t", with: "\\t")

        return Data(
            """
            {"candidates":[{"content":{"parts":[{"text":"\(escaped)"}]}}]}
            """.utf8
        )
    }

    private func assertParserError(
        structuredJSON: String,
        expectedError: GeminiSessionNotesError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let response = GeminiGenerateContentResponse(
            fileURIs: [],
            body: Self.generateContentEnvelope(structuredJSON: structuredJSON)
        )

        do {
            _ = try GeminiSessionNotesParser.parse(response)
            XCTFail("Expected parser error.", file: file, line: line)
        } catch let error as GeminiSessionNotesError {
            XCTAssertEqual(error, expectedError, file: file, line: line)
        }
    }
}

private actor FixtureGeminiHTTPTransport: GeminiHTTPTransport {
    private var queuedResponses: [GeminiHTTPResponse]
    private(set) var requests: [GeminiHTTPRequest] = []

    init(responses: [GeminiHTTPResponse]) {
        self.queuedResponses = responses
    }

    func send(_ request: GeminiHTTPRequest) async throws -> GeminiHTTPResponse {
        requests.append(request)
        guard !queuedResponses.isEmpty else {
            return GeminiHTTPResponse(statusCode: 500, body: Data())
        }

        return queuedResponses.removeFirst()
    }
}
