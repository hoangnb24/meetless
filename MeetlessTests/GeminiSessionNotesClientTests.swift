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

    func testGenerateContentMapsWavAndWaveUploadMIMETypes() async throws {
        let directoryURL = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "GeminiSessionNotesClientTests")
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let meetingURL = directoryURL.appendingPathComponent("meeting.wav")
        let microphoneURL = directoryURL.appendingPathComponent("microphone.wave")
        try Data("meeting wav audio".utf8).write(to: meetingURL)
        try Data("microphone wave audio".utf8).write(to: microphoneURL)

        let transport = FixtureGeminiHTTPTransport(responses: [
            Self.uploadResponse(uri: "files/meeting-wav", mimeType: "audio/wav"),
            Self.uploadResponse(uri: "files/microphone-wave", mimeType: "audio/wav"),
            GeminiHTTPResponse(statusCode: 200, body: Data(#"{"ok":true}"#.utf8))
        ])
        let client = GeminiSessionNotesClient(
            transport: transport,
            baseURL: URL(string: "https://gemini.test")!
        )
        let audioArtifacts = SessionAudioArtifactsForUpload(
            sessionID: "session-1",
            sessionTitle: "Weekly Planning",
            artifacts: [
                SessionAudioArtifactForUpload(
                    source: .meeting,
                    fileURL: meetingURL,
                    filename: "meeting.wav",
                    isPrimarySourceOfRecord: true
                ),
                SessionAudioArtifactForUpload(
                    source: .me,
                    fileURL: microphoneURL,
                    filename: "microphone.wave",
                    isPrimarySourceOfRecord: true
                )
            ]
        )

        let response = try await client.generateContent(
            apiKey: "test-gemini-key",
            audioArtifacts: audioArtifacts
        )
        let requests = await transport.requests
        let generateRequest = try XCTUnwrap(requests.last)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: generateRequest.body) as? [String: Any]
        )
        let contents = try XCTUnwrap(json["contents"] as? [[String: Any]])
        let parts = try XCTUnwrap(contents.first?["parts"] as? [[String: Any]])
        let fileDataParts = parts.compactMap { $0["fileData"] as? [String: Any] }

        XCTAssertEqual(response.fileURIs, ["files/meeting-wav", "files/microphone-wave"])
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests[0].headers["X-Goog-Upload-Header-Content-Type"], "audio/wav")
        XCTAssertEqual(requests[0].headers["Content-Type"], "audio/wav")
        XCTAssertEqual(requests[1].headers["X-Goog-Upload-Header-Content-Type"], "audio/wav")
        XCTAssertEqual(requests[1].headers["Content-Type"], "audio/wav")
        XCTAssertEqual(fileDataParts.map { $0["mimeType"] as? String }, ["audio/wav", "audio/wav"])
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

    func testOrchestratorSavesGeneratedNotesOnlyAfterCompleteSuccess() async throws {
        let fixture = try await Self.makeSessionFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let generatedAt = Date(timeIntervalSince1970: 1_798_100_000)
        let generator = FixtureGeminiSessionNotesGenerator(
            response: GeminiGenerateContentResponse(
                fileURIs: ["files/meeting-audio", "files/microphone-audio"],
                body: Self.generateContentEnvelope(
                    structuredJSON: """
                    {
                      "transcript": "Alice opened the session. Bob confirmed the follow-up.",
                      "summary": "The team aligned on launch preparation and review timing.",
                      "actionItems": [
                        "Send the launch checklist",
                        "Confirm reviewer availability"
                      ]
                    }
                    """
                )
            )
        )
        let orchestrator = GeminiSessionNotesOrchestrator(
            apiKeyStore: FixtureGeminiAPIKeyStore(apiKey: " test-gemini-key "),
            sessionRepository: fixture.repository,
            generator: generator,
            generatedAt: { generatedAt }
        )

        let notes = try await orchestrator.generateNotes(for: fixture.session)
        let reopenedDetail = try await fixture.repository.loadSavedSessionDetail(at: fixture.session.directoryURL)
        let reopenedNotes = try XCTUnwrap(reopenedDetail.generatedNotes)
        let requests = await generator.requests
        let request = try XCTUnwrap(requests.first)

        XCTAssertEqual(notes, reopenedNotes)
        XCTAssertEqual(notes.generatedAt, generatedAt)
        XCTAssertEqual(notes.hiddenGeminiTranscript, "Alice opened the session. Bob confirmed the follow-up.")
        XCTAssertEqual(notes.summary, "The team aligned on launch preparation and review timing.")
        XCTAssertEqual(notes.actionItemBullets, [
            "Send the launch checklist",
            "Confirm reviewer availability"
        ])
        XCTAssertEqual(request.apiKey, "test-gemini-key")
        XCTAssertEqual(request.audioArtifacts.artifacts.map(\.source), RecordingSourceKind.allCases)
    }

    func testOrchestratorRejectsMissingAndBlankAPIKeyWithoutMutatingBundle() async throws {
        try await assertOrchestrationFailureLeavesFirstTimeBundleUnchanged(
            apiKeyStore: FixtureGeminiAPIKeyStore(apiKey: nil),
            generator: FixtureGeminiSessionNotesGenerator(response: Self.validGenerateContentResponse()),
            expectedError: .missingAPIKey
        )
        try await assertOrchestrationFailureLeavesFirstTimeBundleUnchanged(
            apiKeyStore: FixtureGeminiAPIKeyStore(apiKey: "   "),
            generator: FixtureGeminiSessionNotesGenerator(response: Self.validGenerateContentResponse()),
            expectedError: .missingAPIKey
        )
    }

    func testOrchestratorMapsAuthProviderAndClientFailuresWithoutMutatingBundle() async throws {
        try await assertOrchestrationFailureLeavesFirstTimeBundleUnchanged(
            generator: FixtureGeminiSessionNotesGenerator(error: GeminiSessionNotesError.authenticationFailed(statusCode: 401)),
            expectedError: .authentication
        )
        try await assertOrchestrationFailureLeavesFirstTimeBundleUnchanged(
            generator: FixtureGeminiSessionNotesGenerator(error: GeminiSessionNotesError.generationFailed(statusCode: 503)),
            expectedError: .provider
        )
        try await assertOrchestrationFailureLeavesFirstTimeBundleUnchanged(
            generator: FixtureGeminiSessionNotesGenerator(error: URLError(.notConnectedToInternet)),
            expectedError: .client
        )
    }

    func testOrchestratorMapsParserFailureWithoutMutatingBundle() async throws {
        try await assertOrchestrationFailureLeavesFirstTimeBundleUnchanged(
            generator: FixtureGeminiSessionNotesGenerator(
                response: GeminiGenerateContentResponse(
                    fileURIs: ["files/meeting-audio", "files/microphone-audio"],
                    body: Self.generateContentEnvelope(
                        structuredJSON: #"{"transcript":"Transcript","actionItems":["Follow up"]}"#
                    )
                )
            ),
            expectedError: .parser(.missingRequiredField("summary"))
        )
    }

    func testOrchestratorMapsMissingAudioWithoutMutatingBundle() async throws {
        let fixture = try await Self.makeSessionFixture(writeMicrophoneArtifact: false)
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let manifestDataBeforeFailure = try Data(contentsOf: fixture.session.manifestURL)
        let notesURL = fixture.session.directoryURL.appendingPathComponent("generated-notes.json", isDirectory: false)
        let generator = FixtureGeminiSessionNotesGenerator(response: Self.validGenerateContentResponse())
        let orchestrator = GeminiSessionNotesOrchestrator(
            apiKeyStore: FixtureGeminiAPIKeyStore(apiKey: "test-gemini-key"),
            sessionRepository: fixture.repository,
            generator: generator
        )

        do {
            _ = try await orchestrator.generateNotes(for: fixture.session)
            XCTFail("Expected missing audio to fail.")
        } catch let error as GeminiSessionNotesOrchestrationError {
            XCTAssertEqual(
                error,
                .missingAudio(
                    .missingRequiredFile(
                        source: .me,
                        filename: RecordingSourceKind.me.artifactFilename,
                        url: fixture.session.directoryURL.appendingPathComponent(RecordingSourceKind.me.artifactFilename)
                    )
                )
            )
        }

        let manifestDataAfterFailure = try Data(contentsOf: fixture.session.manifestURL)
        let requestCount = await generator.requests.count
        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure)
        XCTAssertFalse(FileManager.default.fileExists(atPath: notesURL.path))
        XCTAssertEqual(requestCount, 0)
    }

    func testOrchestratorRejectsAlreadyGeneratedSessionBeforeUpload() async throws {
        let fixture = try await Self.makeSessionFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }
        let originalNotes = Self.makeGeneratedNotes()
        try await fixture.repository.saveGeneratedNotes(originalNotes, for: fixture.session)

        let manifestDataBeforeFailure = try Data(contentsOf: fixture.session.manifestURL)
        let notesURL = fixture.session.directoryURL.appendingPathComponent("generated-notes.json", isDirectory: false)
        let notesDataBeforeFailure = try Data(contentsOf: notesURL)
        let generator = FixtureGeminiSessionNotesGenerator(response: Self.validGenerateContentResponse())
        let orchestrator = GeminiSessionNotesOrchestrator(
            apiKeyStore: FixtureGeminiAPIKeyStore(apiKey: "test-gemini-key"),
            sessionRepository: fixture.repository,
            generator: generator
        )

        do {
            _ = try await orchestrator.generateNotes(for: fixture.session)
            XCTFail("Expected already-generated session to fail.")
        } catch let error as GeminiSessionNotesOrchestrationError {
            XCTAssertEqual(error, .alreadyGenerated)
        }

        let manifestDataAfterFailure = try Data(contentsOf: fixture.session.manifestURL)
        let notesDataAfterFailure = try Data(contentsOf: notesURL)
        let requestCount = await generator.requests.count
        let reopenedNotes = try await fixture.repository.loadGeneratedNotes(for: fixture.session)

        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure)
        XCTAssertEqual(notesDataAfterFailure, notesDataBeforeFailure)
        XCTAssertEqual(reopenedNotes, originalNotes)
        XCTAssertEqual(requestCount, 0)
    }

    func testOrchestratorMapsPersistenceFailureWithoutLeavingGeneratedNotes() async throws {
        let fixture = try await Self.makeSessionFixture()
        defer {
            SessionRepository.testForcedGeneratedNotesWriteFailureOverride = nil
            try? FileManager.default.removeItem(at: fixture.directoryURL)
        }

        let manifestDataBeforeFailure = try Data(contentsOf: fixture.session.manifestURL)
        let notesURL = fixture.session.directoryURL.appendingPathComponent("generated-notes.json", isDirectory: false)
        let orchestrator = GeminiSessionNotesOrchestrator(
            apiKeyStore: FixtureGeminiAPIKeyStore(apiKey: "test-gemini-key"),
            sessionRepository: fixture.repository,
            generator: FixtureGeminiSessionNotesGenerator(response: Self.validGenerateContentResponse())
        )
        SessionRepository.testForcedGeneratedNotesWriteFailureOverride = true

        do {
            _ = try await orchestrator.generateNotes(for: fixture.session)
            XCTFail("Expected persistence failure.")
        } catch let error as GeminiSessionNotesOrchestrationError {
            XCTAssertEqual(error, .persistence)
        }

        let manifestDataAfterFailure = try Data(contentsOf: fixture.session.manifestURL)
        let generatedNotesAfterFailure = try await fixture.repository.loadGeneratedNotes(for: fixture.session)

        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure)
        XCTAssertFalse(FileManager.default.fileExists(atPath: notesURL.path))
        XCTAssertNil(generatedNotesAfterFailure)
    }

    @MainActor
    func testAppModelGenerateNotesRefreshesSelectedSessionAfterSuccess() async throws {
        let fixture = try await Self.makeSessionFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let generatedNotes = Self.makeGeneratedNotes()
        let orchestrator = FixtureGeminiSessionNotesOrchestrator(
            result: .success(generatedNotes),
            repository: fixture.repository
        )
        let appModel = AppModel(
            sessionRepository: fixture.repository,
            geminiAPIKeyStore: FixtureGeminiAPIKeyStore(apiKey: "test-gemini-key"),
            geminiSessionNotesOrchestrator: orchestrator
        )

        appModel.openSessionDetail(for: try await Self.makeHistoryRow(for: fixture.session, repository: fixture.repository))
        _ = try await MeetlessTestSupport.waitForValue(description: "session detail can generate") { @MainActor in
            appModel.sessionDetailViewModel.canGenerateNotes ? true : nil
        }

        appModel.generateNotesForSelectedSession()
        _ = try await MeetlessTestSupport.waitForValue(description: "selected detail refreshed with generated notes") { @MainActor in
            appModel.sessionDetailViewModel.hasGeneratedNotes ? true : nil
        }

        let requestCount = await orchestrator.requestCount
        let reopenedNotes = try await fixture.repository.loadGeneratedNotes(for: fixture.session)
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(reopenedNotes, generatedNotes)
        XCTAssertFalse(appModel.sessionDetailViewModel.canGenerateNotes)
        XCTAssertNil(appModel.sessionDetailViewModel.generationErrorMessage)
    }

    @MainActor
    func testAppModelLoadsPersistedGeneratedNotesDisplayAndPreventsOverwrite() async throws {
        let fixture = try await Self.makeSessionFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let generatedNotes = GeneratedSessionNotes(
            generatedAt: Date(timeIntervalSince1970: 1_798_200_000),
            hiddenGeminiTranscript: "Hidden transcript must stay out of the detail view.",
            summary: "Meeting: Approved the launch checklist. Me: will confirm privacy copy.",
            actionItemBullets: [
                "Meeting lane should send the launch checklist.",
                "Me: confirm privacy copy."
            ]
        )
        try await fixture.repository.saveGeneratedNotes(generatedNotes, for: fixture.session)

        let replacementNotes = GeneratedSessionNotes(
            generatedAt: Date(timeIntervalSince1970: 1_798_300_000),
            hiddenGeminiTranscript: "Replacement transcript.",
            summary: "Replacement summary.",
            actionItemBullets: ["Replacement action item."]
        )
        let orchestrator = FixtureGeminiSessionNotesOrchestrator(
            result: .success(replacementNotes),
            repository: fixture.repository
        )
        let appModel = AppModel(
            sessionRepository: fixture.repository,
            geminiAPIKeyStore: FixtureGeminiAPIKeyStore(apiKey: "test-gemini-key"),
            geminiSessionNotesOrchestrator: orchestrator
        )

        appModel.openSessionDetail(for: try await Self.makeHistoryRow(for: fixture.session, repository: fixture.repository))
        let display = try await MeetlessTestSupport.waitForValue(description: "persisted generated notes display") { @MainActor in
            appModel.sessionDetailViewModel.generatedNotesDisplay
        }

        XCTAssertTrue(appModel.sessionDetailViewModel.hasGeneratedNotes)
        XCTAssertFalse(appModel.sessionDetailViewModel.canGenerateNotes)
        XCTAssertEqual(display.summary, "Speaker: Approved the launch checklist. You: will confirm privacy copy.")
        XCTAssertEqual(display.actionItemBullets, [
            "saved input should send the launch checklist.",
            "You: confirm privacy copy."
        ])
        XCTAssertFalse(display.summary.contains("Hidden transcript"))
        XCTAssertFalse(display.actionItemBullets.joined(separator: "\n").contains("Hidden transcript"))
        XCTAssertFalse(display.summary.contains("Meeting:"))
        XCTAssertFalse(display.summary.contains("Me:"))
        XCTAssertFalse(display.actionItemBullets.joined(separator: "\n").contains("Meeting lane"))
        XCTAssertEqual(appModel.sessionDetailViewModel.generateNotesStatusText, "Notes have already been generated for this session.")

        appModel.generateNotesForSelectedSession()

        let requestCount = await orchestrator.requestCount
        let reopenedNotes = try await fixture.repository.loadGeneratedNotes(for: fixture.session)
        XCTAssertEqual(requestCount, 0)
        XCTAssertEqual(reopenedNotes, generatedNotes)
    }

    @MainActor
    func testAppModelGenerateNotesFailureLeavesSelectedSessionRetryableAndUnchanged() async throws {
        let fixture = try await Self.makeSessionFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let orchestrator = FixtureGeminiSessionNotesOrchestrator(
            result: .failure(GeminiSessionNotesOrchestrationError.provider)
        )
        let appModel = AppModel(
            sessionRepository: fixture.repository,
            geminiAPIKeyStore: FixtureGeminiAPIKeyStore(apiKey: "test-gemini-key"),
            geminiSessionNotesOrchestrator: orchestrator
        )

        appModel.openSessionDetail(for: try await Self.makeHistoryRow(for: fixture.session, repository: fixture.repository))
        _ = try await MeetlessTestSupport.waitForValue(description: "session detail can generate") { @MainActor in
            appModel.sessionDetailViewModel.canGenerateNotes ? true : nil
        }

        appModel.generateNotesForSelectedSession()
        let errorMessage = try await MeetlessTestSupport.waitForValue(description: "retryable generation error") { @MainActor in
            appModel.sessionDetailViewModel.generationErrorMessage
        }

        let requestCount = await orchestrator.requestCount
        let reopenedNotes = try await fixture.repository.loadGeneratedNotes(for: fixture.session)
        XCTAssertEqual(requestCount, 1)
        XCTAssertNil(reopenedNotes)
        XCTAssertEqual(errorMessage, "Gemini could not finish this request. Try generating notes again.")
        XCTAssertTrue(appModel.sessionDetailViewModel.canGenerateNotes)
    }

    @MainActor
    func testAppModelGenerateNotesRequiresConfiguredKeyBeforeCallingOrchestrator() async throws {
        let fixture = try await Self.makeSessionFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let orchestrator = FixtureGeminiSessionNotesOrchestrator(
            result: .success(Self.makeGeneratedNotes()),
            repository: fixture.repository
        )
        let appModel = AppModel(
            sessionRepository: fixture.repository,
            geminiAPIKeyStore: FixtureGeminiAPIKeyStore(apiKey: nil),
            geminiSessionNotesOrchestrator: orchestrator
        )

        appModel.openSessionDetail(for: try await Self.makeHistoryRow(for: fixture.session, repository: fixture.repository))
        _ = try await MeetlessTestSupport.waitForValue(description: "session detail loaded without key") { @MainActor in
            appModel.sessionDetailViewModel.generateNotesStatusText != nil ? true : nil
        }

        appModel.generateNotesForSelectedSession()

        let requestCount = await orchestrator.requestCount
        let reopenedNotes = try await fixture.repository.loadGeneratedNotes(for: fixture.session)
        XCTAssertEqual(requestCount, 0)
        XCTAssertNil(reopenedNotes)
        XCTAssertEqual(
            appModel.sessionDetailViewModel.generationErrorMessage,
            "Add a Gemini API key in Settings, then try generating notes again."
        )
        XCTAssertFalse(appModel.sessionDetailViewModel.canGenerateNotes)
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

    private static func makeSessionFixture(
        writeMeetingArtifact: Bool = true,
        writeMicrophoneArtifact: Bool = true
    ) async throws -> (directoryURL: URL, repository: SessionRepository, session: PersistedSessionBundle) {
        let repository = SessionRepository()
        let directoryURL = try MeetlessTestSupport.makeTemporaryDirectory(prefix: "GeminiSessionNotesOrchestratorTests")
        let session = try await repository.beginSessionBundle(
            at: directoryURL,
            sourceStatuses: [
                SourcePipelineStatus(source: .meeting, detail: "Meeting lane is recording.", state: .monitoring),
                SourcePipelineStatus(source: .me, detail: "Microphone lane is recording.", state: .monitoring)
            ],
            transcriptChunks: [],
            startedAt: Date(timeIntervalSince1970: 1_798_000_000)
        )

        if writeMeetingArtifact {
            try Data("meeting audio".utf8).write(
                to: session.directoryURL.appendingPathComponent(RecordingSourceKind.meeting.artifactFilename)
            )
        }
        if writeMicrophoneArtifact {
            try Data("microphone audio".utf8).write(
                to: session.directoryURL.appendingPathComponent(RecordingSourceKind.me.artifactFilename)
            )
        }

        return (directoryURL, repository, session)
    }

    private static func makeHistoryRow(
        for session: PersistedSessionBundle,
        repository: SessionRepository
    ) async throws -> HistoryViewModel.Row {
        let detail = try await repository.loadSavedSessionDetail(at: session.directoryURL)
        let summary = PersistedSessionSummary(
            id: detail.id,
            directoryURL: detail.directoryURL,
            title: detail.title,
            startedAt: detail.startedAt,
            endedAt: detail.endedAt,
            durationSeconds: detail.durationSeconds,
            transcriptPreview: detail.transcriptChunks.first?.text ?? "",
            status: detail.status,
            transcriptSnapshotMatchesCommittedTimeline: detail.transcriptSnapshotMatchesCommittedTimeline,
            transcriptSnapshotWarning: detail.transcriptSnapshotWarning,
            sourceStatuses: detail.sourceStatuses,
            updatedAt: detail.updatedAt
        )

        return HistoryViewModel.Row(summary: summary)
    }

    private static func uploadResponse(uri: String, mimeType: String) -> GeminiHTTPResponse {
        GeminiHTTPResponse(
            statusCode: 200,
            body: Data(#"{"file":{"uri":"\#(uri)","mimeType":"\#(mimeType)"}}"#.utf8)
        )
    }

    private static func validGenerateContentResponse() -> GeminiGenerateContentResponse {
        GeminiGenerateContentResponse(
            fileURIs: ["files/meeting-audio", "files/microphone-audio"],
            body: generateContentEnvelope(
                structuredJSON: """
                {
                  "transcript": "Transcript text",
                  "summary": "Summary text",
                  "actionItems": ["Follow up"]
                }
                """
            )
        )
    }

    private static func makeGeneratedNotes() -> GeneratedSessionNotes {
        GeneratedSessionNotes(
            generatedAt: Date(timeIntervalSince1970: 1_798_100_000),
            hiddenGeminiTranscript: "Original transcript.",
            summary: "Original summary.",
            actionItemBullets: ["Original action item."]
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

    private func assertOrchestrationFailureLeavesFirstTimeBundleUnchanged(
        apiKeyStore: any GeminiAPIKeyStoring = FixtureGeminiAPIKeyStore(apiKey: "test-gemini-key"),
        generator: FixtureGeminiSessionNotesGenerator,
        expectedError: GeminiSessionNotesOrchestrationError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        let fixture = try await Self.makeSessionFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directoryURL) }

        let manifestDataBeforeFailure = try Data(contentsOf: fixture.session.manifestURL)
        let notesURL = fixture.session.directoryURL.appendingPathComponent("generated-notes.json", isDirectory: false)
        let orchestrator = GeminiSessionNotesOrchestrator(
            apiKeyStore: apiKeyStore,
            sessionRepository: fixture.repository,
            generator: generator
        )

        do {
            _ = try await orchestrator.generateNotes(for: fixture.session)
            XCTFail("Expected orchestration failure.", file: file, line: line)
        } catch let error as GeminiSessionNotesOrchestrationError {
            XCTAssertEqual(error, expectedError, file: file, line: line)
        }

        let manifestDataAfterFailure = try Data(contentsOf: fixture.session.manifestURL)
        let generatedNotesAfterFailure = try await fixture.repository.loadGeneratedNotes(for: fixture.session)

        XCTAssertEqual(manifestDataAfterFailure, manifestDataBeforeFailure, file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: notesURL.path), file: file, line: line)
        XCTAssertNil(generatedNotesAfterFailure, file: file, line: line)
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

private final class FixtureGeminiAPIKeyStore: GeminiAPIKeyStoring {
    private let apiKey: String?
    private let loadError: Error?

    init(apiKey: String?, loadError: Error? = nil) {
        self.apiKey = apiKey
        self.loadError = loadError
    }

    func loadAPIKey() throws -> String? {
        if let loadError {
            throw loadError
        }

        return apiKey
    }

    func saveAPIKey(_ apiKey: String) throws {}

    func deleteAPIKey() throws {}
}

private struct FixtureGeminiSessionNotesRequest: Sendable {
    let apiKey: String
    let audioArtifacts: SessionAudioArtifactsForUpload
}

private actor FixtureGeminiSessionNotesGenerator: GeminiSessionNotesGenerating {
    private let response: GeminiGenerateContentResponse?
    private let error: Error?
    private(set) var requests: [FixtureGeminiSessionNotesRequest] = []

    init(response: GeminiGenerateContentResponse) {
        self.response = response
        self.error = nil
    }

    init(error: Error) {
        self.response = nil
        self.error = error
    }

    func generateContent(
        apiKey: String,
        audioArtifacts: SessionAudioArtifactsForUpload
    ) async throws -> GeminiGenerateContentResponse {
        requests.append(
            FixtureGeminiSessionNotesRequest(apiKey: apiKey, audioArtifacts: audioArtifacts)
        )

        if let error {
            throw error
        }

        return try XCTUnwrap(response)
    }
}

private actor FixtureGeminiSessionNotesOrchestrator: GeminiSessionNotesOrchestrating {
    private let result: Result<GeneratedSessionNotes, Error>
    private let repository: SessionRepository?
    private(set) var requestedSessions: [PersistedSessionBundle] = []

    init(
        result: Result<GeneratedSessionNotes, Error>,
        repository: SessionRepository? = nil
    ) {
        self.result = result
        self.repository = repository
    }

    var requestCount: Int {
        requestedSessions.count
    }

    func generateNotes(for session: PersistedSessionBundle) async throws -> GeneratedSessionNotes {
        requestedSessions.append(session)

        switch result {
        case .success(let generatedNotes):
            if let repository {
                try await repository.saveGeneratedNotes(generatedNotes, for: session)
            }

            return generatedNotes
        case .failure(let error):
            throw error
        }
    }
}
