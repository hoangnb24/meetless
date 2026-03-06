import Foundation

public enum RuntimeMode: String, Codable, Sendable {
    case live
    case offline
    case recordOnly = "record_only"
}

public struct RuntimeStartRequest: Equatable, Sendable {
    public var mode: RuntimeMode
    public var outputRoot: URL
    public var inputWav: URL?
    public var modelPath: URL?
    public var languageTag: String?
    public var profile: String?

    public init(
        mode: RuntimeMode,
        outputRoot: URL,
        inputWav: URL? = nil,
        modelPath: URL? = nil,
        languageTag: String? = nil,
        profile: String? = nil
    ) {
        self.mode = mode
        self.outputRoot = outputRoot
        self.inputWav = inputWav
        self.modelPath = modelPath
        self.languageTag = languageTag
        self.profile = profile
    }
}

public struct RuntimeLaunchResult: Equatable, Sendable {
    public var processIdentifier: Int32
    public var sessionRoot: URL
    public var startedAt: Date

    public init(processIdentifier: Int32, sessionRoot: URL, startedAt: Date) {
        self.processIdentifier = processIdentifier
        self.sessionRoot = sessionRoot
        self.startedAt = startedAt
    }
}

public enum RuntimeControlAction: String, Codable, Sendable {
    case stop
    case cancel
}

public struct RuntimeControlResult: Equatable, Sendable {
    public var accepted: Bool
    public var detail: String

    public init(accepted: Bool, detail: String) {
        self.accepted = accepted
        self.detail = detail
    }
}

public struct RuntimeEventDTO: Equatable, Sendable {
    public var eventType: String
    public var channel: String?
    public var segmentID: String?
    public var startMs: UInt64?
    public var endMs: UInt64?
    public var text: String?
    public var payload: [String: String]

    public init(
        eventType: String,
        channel: String? = nil,
        segmentID: String? = nil,
        startMs: UInt64? = nil,
        endMs: UInt64? = nil,
        text: String? = nil,
        payload: [String: String] = [:]
    ) {
        self.eventType = eventType
        self.channel = channel
        self.segmentID = segmentID
        self.startMs = startMs
        self.endMs = endMs
        self.text = text
        self.payload = payload
    }
}

public struct JsonlTailCursor: Equatable, Sendable {
    public var byteOffset: UInt64
    public var lineCount: UInt64
    public var lastModifiedAt: Date?

    public init(byteOffset: UInt64, lineCount: UInt64, lastModifiedAt: Date?) {
        self.byteOffset = byteOffset
        self.lineCount = lineCount
        self.lastModifiedAt = lastModifiedAt
    }

    public static let start = JsonlTailCursor(byteOffset: 0, lineCount: 0, lastModifiedAt: nil)
}

public struct SessionManifestDTO: Equatable, Sendable {
    public var sessionID: String
    public var status: String
    public var runtimeMode: String
    public var trustNoticeCount: Int
    public var artifacts: SessionArtifactsDTO

    public init(
        sessionID: String,
        status: String,
        runtimeMode: String,
        trustNoticeCount: Int,
        artifacts: SessionArtifactsDTO
    ) {
        self.sessionID = sessionID
        self.status = status
        self.runtimeMode = runtimeMode
        self.trustNoticeCount = trustNoticeCount
        self.artifacts = artifacts
    }
}

public struct SessionArtifactsDTO: Equatable, Sendable {
    public var wavPath: URL
    public var jsonlPath: URL?
    public var manifestPath: URL

    public init(wavPath: URL, jsonlPath: URL?, manifestPath: URL) {
        self.wavPath = wavPath
        self.jsonlPath = jsonlPath
        self.manifestPath = manifestPath
    }
}

public struct ModelResolutionRequest: Equatable, Sendable {
    public var explicitModelPath: URL?
    public var backend: String

    public init(explicitModelPath: URL? = nil, backend: String) {
        self.explicitModelPath = explicitModelPath
        self.backend = backend
    }
}

public struct ResolvedModelDTO: Equatable, Sendable {
    public var resolvedPath: URL
    public var source: String
    public var checksumSHA256: String?
    public var checksumStatus: String

    public init(
        resolvedPath: URL,
        source: String,
        checksumSHA256: String? = nil,
        checksumStatus: String
    ) {
        self.resolvedPath = resolvedPath
        self.source = source
        self.checksumSHA256 = checksumSHA256
        self.checksumStatus = checksumStatus
    }
}

public enum SessionStatus: String, Codable, Sendable {
    case pending
    case ok
    case degraded
    case failed
}

public enum SessionOutcomeClassification: String, Codable, Sendable {
    case emptyRoot = "empty_root"
    case partialArtifact = "partial_artifact"
    case finalizedFailure = "finalized_failure"
    case finalizedSuccess = "finalized_success"

    public func canonicalCode(manifestStatus: SessionStatus?) -> SessionOutcomeCode {
        switch self {
        case .emptyRoot:
            return .emptySessionRoot
        case .partialArtifact:
            return .partialArtifactSession
        case .finalizedFailure:
            return .finalizedFailure
        case .finalizedSuccess:
            return manifestStatus == .degraded ? .finalizedDegradedSuccess : .finalizedSuccess
        }
    }
}

public enum SessionOutcomeCode: String, Codable, Sendable {
    case emptySessionRoot = "empty_session_root"
    case partialArtifactSession = "partial_artifact_session"
    case finalizedFailure = "finalized_failure"
    case finalizedSuccess = "finalized_success"
    case finalizedDegradedSuccess = "finalized_degraded_success"
}

public enum SessionIngestSource: String, Codable, Sendable {
    case canonicalDirectory = "canonical_directory"
    case legacyFlatImport = "legacy_flat_import"
}

public struct SessionSummaryDTO: Equatable, Sendable {
    public var sessionID: String
    public var startedAt: Date
    public var durationMs: UInt64
    public var mode: RuntimeMode
    public var status: SessionStatus
    public var rootPath: URL
    public var pendingTranscriptionState: PendingTranscriptionState?
    public var readyToTranscribe: Bool
    public var ingestSource: SessionIngestSource
    public var ingestDiagnostics: [String: String]
    public var outcomeClassification: SessionOutcomeClassification
    public var outcomeCode: SessionOutcomeCode
    public var outcomeDiagnostics: [String: String]

    public init(
        sessionID: String,
        startedAt: Date,
        durationMs: UInt64,
        mode: RuntimeMode,
        status: SessionStatus,
        rootPath: URL,
        pendingTranscriptionState: PendingTranscriptionState? = nil,
        readyToTranscribe: Bool = false,
        ingestSource: SessionIngestSource = .canonicalDirectory,
        ingestDiagnostics: [String: String] = [:],
        outcomeClassification: SessionOutcomeClassification,
        outcomeCode: SessionOutcomeCode? = nil,
        outcomeDiagnostics: [String: String] = [:]
    ) {
        self.sessionID = sessionID
        self.startedAt = startedAt
        self.durationMs = durationMs
        self.mode = mode
        self.status = status
        self.rootPath = rootPath
        self.pendingTranscriptionState = pendingTranscriptionState
        self.readyToTranscribe = readyToTranscribe
        self.ingestSource = ingestSource
        self.ingestDiagnostics = ingestDiagnostics
        self.outcomeClassification = outcomeClassification
        self.outcomeCode = outcomeCode ?? outcomeClassification.canonicalCode(manifestStatus: status)
        self.outcomeDiagnostics = outcomeDiagnostics
    }
}

public struct SessionQuery: Equatable, Sendable {
    public var status: SessionStatus?
    public var mode: RuntimeMode?
    public var searchText: String?

    public init(status: SessionStatus? = nil, mode: RuntimeMode? = nil, searchText: String? = nil) {
        self.status = status
        self.mode = mode
        self.searchText = searchText
    }
}

public enum PendingTranscriptionState: String, Codable, Sendable {
    case pendingModel = "pending_model"
    case readyToTranscribe = "ready_to_transcribe"
    case transcribing
    case completed
    case failed
}

public struct PendingSessionSidecarDTO: Equatable, Codable, Sendable {
    public var sessionID: String
    public var createdAtUTC: String
    public var wavPath: String
    public var mode: RuntimeMode
    public var transcriptionState: PendingTranscriptionState

    public init(
        sessionID: String,
        createdAtUTC: String,
        wavPath: String,
        mode: RuntimeMode,
        transcriptionState: PendingTranscriptionState
    ) {
        self.sessionID = sessionID
        self.createdAtUTC = createdAtUTC
        self.wavPath = wavPath
        self.mode = mode
        self.transcriptionState = transcriptionState
    }

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case createdAtUTC = "created_at_utc"
        case wavPath = "wav_path"
        case mode
        case transcriptionState = "transcription_state"
    }
}

public struct PendingSessionSidecarWriteRequest: Equatable, Sendable {
    public var sessionID: String
    public var sessionRoot: URL
    public var wavPath: URL
    public var createdAt: Date
    public var mode: RuntimeMode
    public var transcriptionState: PendingTranscriptionState

    public init(
        sessionID: String,
        sessionRoot: URL,
        wavPath: URL,
        createdAt: Date = Date(),
        mode: RuntimeMode = .recordOnly,
        transcriptionState: PendingTranscriptionState
    ) {
        self.sessionID = sessionID
        self.sessionRoot = sessionRoot
        self.wavPath = wavPath
        self.createdAt = createdAt
        self.mode = mode
        self.transcriptionState = transcriptionState
    }
}

public struct SessionDeletionResultDTO: Equatable, Sendable {
    public var sessionID: String
    public var originalRootPath: URL
    public var trashedRootPath: URL?
    public var didMoveToTrash: Bool

    public init(
        sessionID: String,
        originalRootPath: URL,
        trashedRootPath: URL?,
        didMoveToTrash: Bool
    ) {
        self.sessionID = sessionID
        self.originalRootPath = originalRootPath
        self.trashedRootPath = trashedRootPath
        self.didMoveToTrash = didMoveToTrash
    }
}

public enum ArtifactIntegrityState: String, Codable, Sendable {
    case healthy
    case recoverable
    case terminal
}

public enum ArtifactIntegrityDisposition: String, Codable, Sendable {
    case recoverable
    case terminal
}

public struct ArtifactIntegrityFindingDTO: Equatable, Sendable {
    public var code: String
    public var summary: String
    public var remediation: String
    public var disposition: ArtifactIntegrityDisposition
    public var diagnostics: [String: String]

    public init(
        code: String,
        summary: String,
        remediation: String,
        disposition: ArtifactIntegrityDisposition,
        diagnostics: [String: String] = [:]
    ) {
        self.code = code
        self.summary = summary
        self.remediation = remediation
        self.disposition = disposition
        self.diagnostics = diagnostics
    }
}

public struct SessionArtifactIntegrityReportDTO: Equatable, Sendable {
    public var sessionID: String
    public var rootPath: URL
    public var state: ArtifactIntegrityState
    public var findings: [ArtifactIntegrityFindingDTO]
    public var outcomeClassification: SessionOutcomeClassification
    public var outcomeCode: SessionOutcomeCode
    public var outcomeDiagnostics: [String: String]

    public init(
        sessionID: String,
        rootPath: URL,
        state: ArtifactIntegrityState,
        findings: [ArtifactIntegrityFindingDTO],
        outcomeClassification: SessionOutcomeClassification,
        outcomeCode: SessionOutcomeCode? = nil,
        outcomeDiagnostics: [String: String] = [:]
    ) {
        self.sessionID = sessionID
        self.rootPath = rootPath
        self.state = state
        self.findings = findings
        self.outcomeClassification = outcomeClassification
        let manifestStatus = outcomeDiagnostics["manifest_status"].flatMap { SessionStatus(rawValue: $0.lowercased()) }
        self.outcomeCode = outcomeCode ?? outcomeClassification.canonicalCode(manifestStatus: manifestStatus)
        self.outcomeDiagnostics = outcomeDiagnostics
    }
}

public enum AppServiceErrorCode: String, Codable, Sendable {
    case invalidInput
    case preflightFailed
    case permissionDenied
    case modelUnavailable
    case runtimeUnavailable
    case processLaunchFailed
    case processExitedUnexpectedly
    case artifactMissing
    case manifestInvalid
    case jsonlCorrupt
    case timeout
    case ioFailure
    case unknown
}

public struct AppServiceError: Error, Equatable, Sendable {
    public var code: AppServiceErrorCode
    public var userMessage: String
    public var remediation: String
    public var debugDetail: String?

    public init(
        code: AppServiceErrorCode,
        userMessage: String,
        remediation: String,
        debugDetail: String? = nil
    ) {
        self.code = code
        self.userMessage = userMessage
        self.remediation = remediation
        self.debugDetail = debugDetail
    }
}

public protocol RuntimeService: Sendable {
    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult
    func controlSession(processIdentifier: Int32, action: RuntimeControlAction) async throws -> RuntimeControlResult
}

public protocol JsonlTailService: Sendable {
    func readEvents(at jsonlPath: URL, from cursor: JsonlTailCursor) throws -> ([RuntimeEventDTO], JsonlTailCursor)
}

public protocol ManifestService: Sendable {
    func loadManifest(at manifestPath: URL) throws -> SessionManifestDTO
}

public protocol ModelResolutionService: Sendable {
    func resolveModel(_ request: ModelResolutionRequest) throws -> ResolvedModelDTO
}

public protocol PendingSessionSidecarService: Sendable {
    func writePendingSidecar(_ request: PendingSessionSidecarWriteRequest) throws -> PendingSessionSidecarDTO
    func loadPendingSidecar(at pendingSidecarPath: URL) throws -> PendingSessionSidecarDTO
}

public protocol ArtifactIntegrityService: Sendable {
    func evaluateSessionArtifacts(
        sessionID: String,
        rootPath: URL
    ) throws -> SessionArtifactIntegrityReportDTO
}

public protocol SessionLibraryService: Sendable {
    func listSessions(query: SessionQuery) throws -> [SessionSummaryDTO]
    func deleteSession(
        sessionID: String,
        rootPath: URL,
        confirmTrash: Bool
    ) throws -> SessionDeletionResultDTO
}
