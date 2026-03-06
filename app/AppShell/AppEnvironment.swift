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

    public static func production() -> AppEnvironment {
        let sessionLibraryService = FileSystemSessionLibraryService()
        var runtimeEnvironment = normalizedProcessEnvironment(base: ProcessInfo.processInfo.environment)
        let resolver = RuntimeBinaryResolver(environment: runtimeEnvironment)
        let readinessReport = resolver.startupReadinessReport()

        if let recorditPath = readinessReport.checks
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

        let bootstrapModelService = FileSystemModelResolutionService(environment: modelEnvironment)
        if let resolvedDefaultModel = try? bootstrapModelService.resolveModel(
            ModelResolutionRequest(explicitModelPath: nil, backend: "whispercpp")
        ) {
            let resolvedPath = resolvedDefaultModel.resolvedPath.path
            modelEnvironment["RECORDIT_ASR_MODEL"] = resolvedPath
            runtimeEnvironment["RECORDIT_ASR_MODEL"] = resolvedPath
        }

        var preflightEnvironment: [String: String] = [:]
        if let resolvedModelPath = modelEnvironment["RECORDIT_ASR_MODEL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !resolvedModelPath.isEmpty {
            preflightEnvironment["RECORDIT_ASR_MODEL"] = resolvedModelPath
        }
        preflightEnvironment["PATH"] = runtimeEnvironment["PATH"]

        let processManager = RuntimeProcessManager(
            binaryResolver: RuntimeBinaryResolver(environment: runtimeEnvironment),
            processEnvironment: runtimeEnvironment
        )

        return AppEnvironment(
            runtimeService: ProcessBackedRuntimeService(processManager: processManager),
            manifestService: FileSystemManifestService(),
            modelService: FileSystemModelResolutionService(environment: modelEnvironment),
            jsonlTailService: FileSystemJsonlTailService(),
            sessionLibraryService: sessionLibraryService,
            artifactIntegrityService: FileSystemArtifactIntegrityService(),
            pendingSidecarService: FileSystemPendingSessionSidecarService(),
            startupMigrationRepairService: StartupMigrationRepairService(
                sessionLibraryService: sessionLibraryService
            ),
            preflightRunner: RecorditPreflightRunner(environment: preflightEnvironment)
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
