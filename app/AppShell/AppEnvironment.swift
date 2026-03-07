import Foundation

public struct FileSystemManifestService: ManifestService {
    public init() {}

    public func loadManifest(at manifestPath: URL) throws -> SessionManifestDTO {
        let path = manifestPath.standardizedFileURL
        guard FileManager.default.fileExists(atPath: path.path) else {
            throw AppServiceError(
                code: .artifactMissing,
                userMessage: "Session manifest is missing.",
                remediation: "Reopen the session and verify artifacts are complete.",
                debugDetail: path.path
            )
        }

        let data = try readManifestData(at: path)

        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Session manifest is malformed.",
                remediation: "Re-run the session or inspect manifest generation diagnostics."
            )
        }

        let sessionID = (payload["session_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let runtimeMode = (payload["runtime_mode"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = payload["session_summary"] as? [String: Any]
        let status = (summary?["session_status"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trust = payload["trust"] as? [String: Any]
        let noticeCount = (trust?["notice_count"] as? NSNumber)?.intValue ?? 0
        let artifacts = payload["artifacts"] as? [String: Any]

        guard
            let resolvedSessionID = sessionID, !resolvedSessionID.isEmpty,
            let resolvedMode = runtimeMode, !resolvedMode.isEmpty,
            let resolvedStatus = status, !resolvedStatus.isEmpty,
            let outWav = artifacts?["out_wav"] as? String,
            !outWav.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Session manifest is missing required fields.",
                remediation: "Re-run the session and verify manifest schema compatibility."
            )
        }

        let outJsonl = (artifacts?["out_jsonl"] as? String)
            .flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
        let outManifest = (artifacts?["out_manifest"] as? String)
            .flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? path

        return SessionManifestDTO(
            sessionID: resolvedSessionID,
            status: resolvedStatus,
            runtimeMode: resolvedMode,
            trustNoticeCount: noticeCount,
            artifacts: SessionArtifactsDTO(
                wavPath: URL(fileURLWithPath: outWav),
                jsonlPath: outJsonl,
                manifestPath: outManifest
            )
        )
    }

    private func readManifestData(at path: URL) throws -> Data {
        do {
            let handle = try FileHandle(forReadingFrom: path)
            defer { try? handle.close() }
            return try handle.readToEnd() ?? Data()
        } catch {
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Session manifest could not be read.",
                remediation: "Verify file permissions and retry.",
                debugDetail: String(describing: error)
            )
        }
    }
}


public enum StartupSelfCheckModelStatus: String, Codable, Sendable {
    case ready
    case unavailable
}

public enum StartupSelfCheckReadinessImplication: String, Codable, Sendable {
    case liveReady = "live_ready"
    case liveBlockedRuntime = "live_blocked_runtime"
    case liveBlockedModel = "live_blocked_model"
}

public struct StartupSelfCheckRuntimeBinaryLog: Codable, Equatable, Sendable {
    public var binaryName: String
    public var overrideEnvKey: String
    public var status: String
    public var resolvedPath: String?
    public var debugDetail: String?

    public init(
        binaryName: String,
        overrideEnvKey: String,
        status: String,
        resolvedPath: String?,
        debugDetail: String? = nil
    ) {
        self.binaryName = binaryName
        self.overrideEnvKey = overrideEnvKey
        self.status = status
        self.resolvedPath = resolvedPath
        self.debugDetail = debugDetail
    }

    enum CodingKeys: String, CodingKey {
        case binaryName = "binary_name"
        case overrideEnvKey = "override_env_key"
        case status
        case resolvedPath = "resolved_path"
        case debugDetail = "debug_detail"
    }
}

public struct StartupSelfCheckModelLog: Codable, Equatable, Sendable {
    public var status: StartupSelfCheckModelStatus
    public var resolvedPath: String?
    public var source: String?
    public var checksumStatus: String?
    public var errorCode: String?
    public var debugDetail: String?

    public init(
        status: StartupSelfCheckModelStatus,
        resolvedPath: String?,
        source: String?,
        checksumStatus: String?,
        errorCode: String? = nil,
        debugDetail: String? = nil
    ) {
        self.status = status
        self.resolvedPath = resolvedPath
        self.source = source
        self.checksumStatus = checksumStatus
        self.errorCode = errorCode
        self.debugDetail = debugDetail
    }

    enum CodingKeys: String, CodingKey {
        case status
        case resolvedPath = "resolved_path"
        case source
        case checksumStatus = "checksum_status"
        case errorCode = "error_code"
        case debugDetail = "debug_detail"
    }
}

public struct StartupSelfCheckPreflightEnvironmentLog: Codable, Equatable, Sendable {
    public var pathConfigured: Bool
    public var recorditASRModelConfigured: Bool

    public init(pathConfigured: Bool, recorditASRModelConfigured: Bool) {
        self.pathConfigured = pathConfigured
        self.recorditASRModelConfigured = recorditASRModelConfigured
    }

    enum CodingKeys: String, CodingKey {
        case pathConfigured = "path_configured"
        case recorditASRModelConfigured = "recordit_asr_model_configured"
    }
}

public struct StartupSelfCheckLogRecord: Codable, Equatable, Sendable {
    public var schemaVersion: String
    public var eventType: String
    public var generatedAtUTC: String
    public var selectedBackend: String
    public var selectedBackendSource: String
    public var runtimeReady: Bool
    public var liveTranscribeAvailable: Bool
    public var recordOnlyAvailable: Bool
    public var readinessImplication: StartupSelfCheckReadinessImplication
    public var runtimeChecks: [StartupSelfCheckRuntimeBinaryLog]
    public var modelSelection: StartupSelfCheckModelLog
    public var preflightEnvironment: StartupSelfCheckPreflightEnvironmentLog

    public init(
        schemaVersion: String = "1",
        eventType: String = "startup_self_check",
        generatedAtUTC: String,
        selectedBackend: String,
        selectedBackendSource: String,
        runtimeReady: Bool,
        liveTranscribeAvailable: Bool,
        recordOnlyAvailable: Bool,
        readinessImplication: StartupSelfCheckReadinessImplication,
        runtimeChecks: [StartupSelfCheckRuntimeBinaryLog],
        modelSelection: StartupSelfCheckModelLog,
        preflightEnvironment: StartupSelfCheckPreflightEnvironmentLog
    ) {
        self.schemaVersion = schemaVersion
        self.eventType = eventType
        self.generatedAtUTC = generatedAtUTC
        self.selectedBackend = selectedBackend
        self.selectedBackendSource = selectedBackendSource
        self.runtimeReady = runtimeReady
        self.liveTranscribeAvailable = liveTranscribeAvailable
        self.recordOnlyAvailable = recordOnlyAvailable
        self.readinessImplication = readinessImplication
        self.runtimeChecks = runtimeChecks
        self.modelSelection = modelSelection
        self.preflightEnvironment = preflightEnvironment
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case eventType = "event_type"
        case generatedAtUTC = "generated_at_utc"
        case selectedBackend = "selected_backend"
        case selectedBackendSource = "selected_backend_source"
        case runtimeReady = "runtime_ready"
        case liveTranscribeAvailable = "live_transcribe_available"
        case recordOnlyAvailable = "record_only_available"
        case readinessImplication = "readiness_implication"
        case runtimeChecks = "runtime_checks"
        case modelSelection = "model_selection"
        case preflightEnvironment = "preflight_environment"
    }

    public func debugDetailJSONString() -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    public static func fromDebugDetailJSONString(_ jsonString: String?) -> StartupSelfCheckLogRecord? {
        guard let jsonString,
              let data = jsonString.data(using: .utf8) else {
            return nil
        }
        return try? JSONDecoder().decode(Self.self, from: data)
    }

    public static func bootstrapRecord(
        runtimeReadinessReport: RuntimeBinaryReadinessReport,
        modelSelection: StartupSelfCheckModelLog,
        preflightEnvironment: [String: String],
        generatedAtUTC: String,
        selectedBackend: String = "whispercpp",
        selectedBackendSource: String = "v1_default"
    ) -> StartupSelfCheckLogRecord {
        StartupSelfCheckLogRecord(
            generatedAtUTC: generatedAtUTC,
            selectedBackend: selectedBackend,
            selectedBackendSource: selectedBackendSource,
            runtimeReady: runtimeReadinessReport.isReady,
            liveTranscribeAvailable: runtimeReadinessReport.isReady && modelSelection.status == .ready,
            recordOnlyAvailable: runtimeReadinessReport.checks
                .first(where: { $0.binaryName == "sequoia_capture" })?
                .isReady ?? false,
            readinessImplication: runtimeReadinessReport.isReady
                ? (modelSelection.status == .ready ? .liveReady : .liveBlockedModel)
                : .liveBlockedRuntime,
            runtimeChecks: runtimeReadinessReport.checks.map {
                StartupSelfCheckRuntimeBinaryLog(
                    binaryName: $0.binaryName,
                    overrideEnvKey: $0.overrideEnvKey,
                    status: $0.status.rawValue,
                    resolvedPath: $0.resolvedPath,
                    debugDetail: $0.debugDetail
                )
            },
            modelSelection: modelSelection,
            preflightEnvironment: StartupSelfCheckPreflightEnvironmentLog(
                pathConfigured: !(preflightEnvironment["PATH"]?.isEmpty ?? true),
                recorditASRModelConfigured: !(preflightEnvironment["RECORDIT_ASR_MODEL"]?.isEmpty ?? true)
            )
        )
    }

    public static func runtimeBlockedRecord(
        runtimeReadinessReport: RuntimeBinaryReadinessReport,
        blockingErrorCode: AppServiceErrorCode,
        generatedAtUTC: String,
        selectedBackend: String = "whispercpp",
        selectedBackendSource: String = "v1_default"
    ) -> StartupSelfCheckLogRecord {
        bootstrapRecord(
            runtimeReadinessReport: runtimeReadinessReport,
            modelSelection: StartupSelfCheckModelLog(
                status: .unavailable,
                resolvedPath: nil,
                source: nil,
                checksumStatus: nil,
                errorCode: blockingErrorCode.rawValue,
                debugDetail: nil
            ),
            preflightEnvironment: [:],
            generatedAtUTC: generatedAtUTC,
            selectedBackend: selectedBackend,
            selectedBackendSource: selectedBackendSource
        )
    }
}

public struct AppEnvironment {
    private static let defaultPathSegments: [String] = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]

    public var runtimeService: any RuntimeService
    public var manifestService: any ManifestService
    public var modelService: any ModelResolutionService
    public var jsonlTailService: any JsonlTailService
    public var sessionLibraryService: any SessionLibraryService
    public var artifactIntegrityService: any ArtifactIntegrityService
    public var pendingSidecarService: any PendingSessionSidecarService
    public var startupMigrationRepairService: (any StartupMigrationRepairing)?
    public var preflightRunner: RecorditPreflightRunner

    public init(
        runtimeService: any RuntimeService,
        manifestService: any ManifestService,
        modelService: any ModelResolutionService,
        jsonlTailService: any JsonlTailService,
        sessionLibraryService: any SessionLibraryService,
        artifactIntegrityService: any ArtifactIntegrityService,
        pendingSidecarService: any PendingSessionSidecarService,
        startupMigrationRepairService: (any StartupMigrationRepairing)? = nil,
        preflightRunner: RecorditPreflightRunner
    ) {
        self.runtimeService = runtimeService
        self.manifestService = manifestService
        self.modelService = modelService
        self.jsonlTailService = jsonlTailService
        self.sessionLibraryService = sessionLibraryService
        self.artifactIntegrityService = artifactIntegrityService
        self.pendingSidecarService = pendingSidecarService
        self.startupMigrationRepairService = startupMigrationRepairService
        self.preflightRunner = preflightRunner
    }

    public static func production(
        processEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        currentDirectoryURL: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        bundleResourceURL: URL? = Bundle.main.resourceURL,
        startupSelfCheckLogger: @escaping (StartupSelfCheckLogRecord) -> Void = AppEnvironment.defaultStartupSelfCheckLogger
    ) -> AppEnvironment {
        let sessionLibraryService = FileSystemSessionLibraryService()
        let bootstrap = buildProductionBootstrap(
            processEnvironment: processEnvironment,
            currentDirectoryURL: currentDirectoryURL,
            bundleResourceURL: bundleResourceURL,
            startupSelfCheckLogger: startupSelfCheckLogger
        )

        let processManager = RuntimeProcessManager(
            binaryResolver: bootstrap.runtimeResolver,
            processEnvironment: bootstrap.runtimeEnvironment
        )

        return AppEnvironment(
            runtimeService: ProcessBackedRuntimeService(processManager: processManager),
            manifestService: FileSystemManifestService(),
            modelService: FileSystemModelResolutionService(
                environment: bootstrap.modelEnvironment,
                currentDirectoryURL: currentDirectoryURL,
                bundleResourceURL: bundleResourceURL
            ),
            jsonlTailService: FileSystemJsonlTailService(),
            sessionLibraryService: sessionLibraryService,
            artifactIntegrityService: FileSystemArtifactIntegrityService(),
            pendingSidecarService: FileSystemPendingSessionSidecarService(),
            startupMigrationRepairService: StartupMigrationRepairService(
                sessionLibraryService: sessionLibraryService
            ),
            preflightRunner: RecorditPreflightRunner(environment: bootstrap.preflightEnvironment)
        )
    }

    private static func normalizedProcessEnvironment(
        base: [String: String],
        prependingPathSegments: [String] = []
    ) -> [String: String] {
        var environment = base
        let existingSegments = (base["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)
        let orderedSegments = prependingPathSegments + existingSegments + defaultPathSegments

        var seen = Set<String>()
        var normalizedSegments: [String] = []
        normalizedSegments.reserveCapacity(orderedSegments.count)
        for segment in orderedSegments {
            let trimmed = segment.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                continue
            }
            if seen.insert(trimmed).inserted {
                normalizedSegments.append(trimmed)
            }
        }

        environment["PATH"] = normalizedSegments.joined(separator: ":")
        return environment
    }


    private struct ProductionBootstrap {
        var runtimeEnvironment: [String: String]
        var modelEnvironment: [String: String]
        var preflightEnvironment: [String: String]
        var runtimeResolver: RuntimeBinaryResolver
    }

    private static func buildProductionBootstrap(
        processEnvironment: [String: String],
        currentDirectoryURL: URL,
        bundleResourceURL: URL?,
        startupSelfCheckLogger: @escaping (StartupSelfCheckLogRecord) -> Void
    ) -> ProductionBootstrap {
        var runtimeEnvironment = normalizedProcessEnvironment(base: processEnvironment)
        let initialResolver = RuntimeBinaryResolver(
            environment: runtimeEnvironment,
            bundleResourceURL: bundleResourceURL
        )
        let initialReadinessReport = initialResolver.startupReadinessReport()

        if let recorditPath = initialReadinessReport.checks
            .first(where: { $0.binaryName == "recordit" && $0.isReady })?
            .resolvedPath {
            let recorditDirectory = URL(fileURLWithPath: recorditPath)
                .deletingLastPathComponent()
                .path
            runtimeEnvironment = normalizedProcessEnvironment(
                base: runtimeEnvironment,
                prependingPathSegments: [recorditDirectory]
            )
        }

        var modelEnvironment = runtimeEnvironment
        let bootstrapModelService = FileSystemModelResolutionService(
            environment: modelEnvironment,
            currentDirectoryURL: currentDirectoryURL,
            bundleResourceURL: bundleResourceURL
        )
        let modelSelection: StartupSelfCheckModelLog
        do {
            let resolvedDefaultModel = try bootstrapModelService.resolveModel(
                ModelResolutionRequest(explicitModelPath: nil, backend: "whispercpp")
            )
            let resolvedPath = resolvedDefaultModel.resolvedPath.path
            modelEnvironment["RECORDIT_ASR_MODEL"] = resolvedPath
            runtimeEnvironment["RECORDIT_ASR_MODEL"] = resolvedPath
            modelSelection = StartupSelfCheckModelLog(
                status: .ready,
                resolvedPath: resolvedPath,
                source: resolvedDefaultModel.source,
                checksumStatus: resolvedDefaultModel.checksumStatus
            )
        } catch let error as AppServiceError {
            modelSelection = StartupSelfCheckModelLog(
                status: .unavailable,
                resolvedPath: nil,
                source: nil,
                checksumStatus: nil,
                errorCode: error.code.rawValue,
                debugDetail: error.debugDetail
            )
        } catch {
            modelSelection = StartupSelfCheckModelLog(
                status: .unavailable,
                resolvedPath: nil,
                source: nil,
                checksumStatus: nil,
                errorCode: AppServiceErrorCode.unknown.rawValue,
                debugDetail: String(describing: error)
            )
        }

        var preflightEnvironment: [String: String] = [:]
        if let resolvedModelPath = modelEnvironment["RECORDIT_ASR_MODEL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !resolvedModelPath.isEmpty {
            preflightEnvironment["RECORDIT_ASR_MODEL"] = resolvedModelPath
        }
        preflightEnvironment["PATH"] = runtimeEnvironment["PATH"]

        let runtimeResolver = RuntimeBinaryResolver(
            environment: runtimeEnvironment,
            bundleResourceURL: bundleResourceURL
        )
        let runtimeReadinessReport = runtimeResolver.startupReadinessReport()
        startupSelfCheckLogger(
            makeStartupSelfCheckLogRecord(
                runtimeReadinessReport: runtimeReadinessReport,
                modelSelection: modelSelection,
                preflightEnvironment: preflightEnvironment
            )
        )

        return ProductionBootstrap(
            runtimeEnvironment: runtimeEnvironment,
            modelEnvironment: modelEnvironment,
            preflightEnvironment: preflightEnvironment,
            runtimeResolver: runtimeResolver
        )
    }

    private static func makeStartupSelfCheckLogRecord(
        runtimeReadinessReport: RuntimeBinaryReadinessReport,
        modelSelection: StartupSelfCheckModelLog,
        preflightEnvironment: [String: String]
    ) -> StartupSelfCheckLogRecord {
        StartupSelfCheckLogRecord.bootstrapRecord(
            runtimeReadinessReport: runtimeReadinessReport,
            modelSelection: modelSelection,
            preflightEnvironment: preflightEnvironment,
            generatedAtUTC: iso8601UTC(Date())
        )
    }

    private static func iso8601UTC(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    public static func defaultStartupSelfCheckLogger(_ record: StartupSelfCheckLogRecord) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(record) else {
            return
        }
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data([0x0A]))
    }

    public static func preview() -> AppEnvironment {
        let preflightPayload = PreviewPreflightCommandRunner.defaultPayloadData
        let mockLibraryService = MockSessionLibraryService(sessions: [])
        return AppEnvironment(
            runtimeService: MockRuntimeService(),
            manifestService: MockManifestService(manifest: PreviewFixtures.manifest),
            modelService: MockModelResolutionService(resolution: PreviewFixtures.resolvedModel),
            jsonlTailService: MockJsonlTailService(queuedEvents: []),
            sessionLibraryService: mockLibraryService,
            artifactIntegrityService: MockArtifactIntegrityService(report: PreviewFixtures.integrityReport),
            pendingSidecarService: MockPendingSessionSidecarService(),
            startupMigrationRepairService: StartupMigrationRepairService(
                sessionLibraryService: mockLibraryService,
                sessionsRootProvider: {
                    FileManager.default.temporaryDirectory
                        .appendingPathComponent("recordit-preview-startup-repair", isDirectory: true)
                },
                timeBudgetSeconds: 0.25,
                maxPersistedEntries: 128,
                logger: { _ in }
            ),
            preflightRunner: RecorditPreflightRunner(
                executable: "/usr/bin/env",
                commandRunner: PreviewPreflightCommandRunner(stdoutData: preflightPayload),
                parser: PreflightEnvelopeParser(),
                environment: [:]
            )
        )
    }

    public func replacing(
        runtimeService: (any RuntimeService)? = nil,
        manifestService: (any ManifestService)? = nil,
        modelService: (any ModelResolutionService)? = nil,
        jsonlTailService: (any JsonlTailService)? = nil,
        sessionLibraryService: (any SessionLibraryService)? = nil,
        artifactIntegrityService: (any ArtifactIntegrityService)? = nil,
        pendingSidecarService: (any PendingSessionSidecarService)? = nil,
        startupMigrationRepairService: (any StartupMigrationRepairing)? = nil,
        preflightRunner: RecorditPreflightRunner? = nil
    ) -> AppEnvironment {
        AppEnvironment(
            runtimeService: runtimeService ?? self.runtimeService,
            manifestService: manifestService ?? self.manifestService,
            modelService: modelService ?? self.modelService,
            jsonlTailService: jsonlTailService ?? self.jsonlTailService,
            sessionLibraryService: sessionLibraryService ?? self.sessionLibraryService,
            artifactIntegrityService: artifactIntegrityService ?? self.artifactIntegrityService,
            pendingSidecarService: pendingSidecarService ?? self.pendingSidecarService,
            startupMigrationRepairService: startupMigrationRepairService ?? self.startupMigrationRepairService,
            preflightRunner: preflightRunner ?? self.preflightRunner
        )
    }

    @MainActor
    public func makeRuntimeViewModel() -> RuntimeViewModel {
        RuntimeViewModel(
            runtimeService: runtimeService,
            manifestService: manifestService,
            modelService: modelService
        )
    }

    @MainActor
    public func makePreflightViewModel() -> PreflightViewModel {
        PreflightViewModel(runner: preflightRunner)
    }

    @MainActor
    public func makePermissionRemediationViewModel(
        openSystemSettings: @escaping (URL) -> Void = { _ in }
    ) -> PermissionRemediationViewModel {
        PermissionRemediationViewModel(
            runner: preflightRunner,
            openSystemSettings: openSystemSettings
        )
    }

    @MainActor
    public func makeModelSetupViewModel() -> ModelSetupViewModel {
        ModelSetupViewModel(modelResolutionService: modelService)
    }

    public func runStartupMigrationRepair() -> StartupMigrationRepairReport? {
        startupMigrationRepairService?.runRepair()
    }

    public func scheduleStartupMigrationRepair(
        priority: TaskPriority = .utility
    ) -> Task<StartupMigrationRepairReport?, Never> {
        let repairService = startupMigrationRepairService
        return Task.detached(priority: priority) {
            repairService?.runRepair()
        }
    }
}

private struct PreviewFixtures {
    static let resolvedModel = ResolvedModelDTO(
        resolvedPath: URL(fileURLWithPath: "/tmp/mock-model.bin"),
        source: "preview fixture",
        checksumSHA256: "deadbeef",
        checksumStatus: "available"
    )

    static let manifest = SessionManifestDTO(
        sessionID: "preview-session",
        status: "ok",
        runtimeMode: "live",
        trustNoticeCount: 0,
        artifacts: SessionArtifactsDTO(
            wavPath: URL(fileURLWithPath: "/tmp/preview.wav"),
            jsonlPath: URL(fileURLWithPath: "/tmp/preview.jsonl"),
            manifestPath: URL(fileURLWithPath: "/tmp/preview.manifest.json")
        )
    )

    static let integrityReport = SessionArtifactIntegrityReportDTO(
        sessionID: "preview-session",
        rootPath: URL(fileURLWithPath: "/tmp/preview-session"),
        state: .healthy,
        findings: [],
        outcomeClassification: .finalizedSuccess
    )
}

private struct PreviewPreflightCommandRunner: CommandRunning {
    static let defaultPayloadData: Data = {
        let payload: [String: Any] = [
            "schema_version": "1",
            "kind": "transcribe-live-preflight",
            "generated_at_utc": "2026-03-05T00:00:00Z",
            "overall_status": "PASS",
            "config": [
                "out_wav": "/tmp/preview.wav",
                "out_jsonl": "/tmp/preview.jsonl",
                "out_manifest": "/tmp/preview.manifest.json",
                "asr_backend": "whispercpp",
                "asr_model_requested": "/tmp/mock-model.bin",
                "asr_model_resolved": "/tmp/mock-model.bin",
                "asr_model_source": "preview fixture",
                "sample_rate_hz": 48_000,
            ],
            "checks": [
                [
                    "id": ReadinessContractID.modelPath.rawValue,
                    "status": "PASS",
                    "detail": "model path resolved",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.screenCaptureAccess.rawValue,
                    "status": "PASS",
                    "detail": "screen access granted",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.displayAvailability.rawValue,
                    "status": "PASS",
                    "detail": "active display available",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.microphoneAccess.rawValue,
                    "status": "PASS",
                    "detail": "microphone access granted",
                    "remediation": "",
                ],
            ],
        ]
        return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
    }()

    let stdoutData: Data

    func run(
        executable _: String,
        arguments _: [String],
        environment _: [String: String]
    ) throws -> CommandExecutionResult {
        CommandExecutionResult(exitCode: 0, stdout: stdoutData, stderr: Data())
    }
}
