import Foundation
import XCTest
@testable import Recordit

final class RecorditAppTests: XCTestCase {
    private actor DelayingRuntimeService: RuntimeService {
        private let startDelayNanoseconds: UInt64
        private let stopDelayNanoseconds: UInt64
        private(set) var startInvocations = 0
        private(set) var stopInvocations = 0

        init(
            startDelayNanoseconds: UInt64 = 10_000_000,
            stopDelayNanoseconds: UInt64 = 10_000_000
        ) {
            self.startDelayNanoseconds = startDelayNanoseconds
            self.stopDelayNanoseconds = stopDelayNanoseconds
        }

        func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
            _ = request
            startInvocations += 1
            try await Task.sleep(nanoseconds: startDelayNanoseconds)
            return RuntimeLaunchResult(
                processIdentifier: 7000 + Int32(startInvocations),
                sessionRoot: URL(fileURLWithPath: NSTemporaryDirectory()),
                startedAt: Date()
            )
        }

        func controlSession(processIdentifier _: Int32, action _: RuntimeControlAction) async throws -> RuntimeControlResult {
            stopInvocations += 1
            try await Task.sleep(nanoseconds: stopDelayNanoseconds)
            return RuntimeControlResult(accepted: true, detail: "stopped")
        }

        func startInvocationCount() -> Int { startInvocations }
        func stopInvocationCount() -> Int { stopInvocations }
    }

    private enum ResponsivenessGateArtifact {
        static let pathEnv = "RECORDIT_RESPONSIVENESS_ARTIFACT_PATH"
    }

    private enum ReadinessScenarioArtifact {
        static let pathEnv = "RECORDIT_READINESS_SCENARIO_ARTIFACT_PATH"
    }

    private struct ResponsivenessGateSnapshot {
        let firstStableTranscriptMilliseconds: UInt64
        let stopToSummaryMilliseconds: UInt64
        let firstStableTranscriptBudgetMilliseconds: UInt64
        let stopToSummaryBudgetMilliseconds: UInt64
        let firstStableTranscriptBudgetPass: Bool
        let stopToSummaryBudgetPass: Bool
        let gatePass: Bool
        let failedMetrics: String
    }

    private struct ReadinessScenarioSnapshot {
        let scenarioID: String
        let preflightKind: String
        let preflightOverallStatus: String
        let preflightCheckIDs: [String]
        let mappedCheckIDs: [String]
        let failingCheckIDs: [String]
        let mappedBlockingDomain: String
        let preflightCanProceedLive: Bool
        let preflightCanOfferRecordOnlyFallback: Bool
        let rootPreflightCanProceed: Bool
        let rootPreflightCanOfferRecordOnlyFallback: Bool
        let rootPreflightRequiresWarningAck: Bool
        let rootPreflightSummary: String
    }

    private struct StaticManifestService: ManifestService {
        var manifest: SessionManifestDTO

        func loadManifest(at _: URL) throws -> SessionManifestDTO {
            manifest
        }
    }

    private struct StaticModelService: ModelResolutionService {
        func resolveModel(_ request: ModelResolutionRequest) throws -> ResolvedModelDTO {
            _ = request
            return ResolvedModelDTO(
                resolvedPath: URL(fileURLWithPath: "/tmp/model.bin"),
                source: "test",
                checksumSHA256: nil,
                checksumStatus: "available"
            )
        }
    }

    private actor ImmediateRuntimeService: RuntimeService {
        private(set) var stopInvocations = 0

        func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
            RuntimeLaunchResult(
                processIdentifier: 9100,
                sessionRoot: request.outputRoot,
                startedAt: Date()
            )
        }

        func controlSession(processIdentifier _: Int32, action _: RuntimeControlAction) async throws -> RuntimeControlResult {
            stopInvocations += 1
            return RuntimeControlResult(accepted: true, detail: "stopped")
        }
    }

    private actor TimeoutStopRuntimeService: RuntimeService {
        func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
            RuntimeLaunchResult(
                processIdentifier: 9200,
                sessionRoot: request.outputRoot,
                startedAt: Date()
            )
        }

        func controlSession(processIdentifier _: Int32, action _: RuntimeControlAction) async throws -> RuntimeControlResult {
            throw AppServiceError(
                code: .timeout,
                userMessage: "Runtime did not stop in time.",
                remediation: "Retry stop and inspect session diagnostics."
            )
        }
    }

    private final class SequencedManifestService: ManifestService, @unchecked Sendable {
        private let lock = NSLock()
        private var queuedResults: [Result<SessionManifestDTO, AppServiceError>]
        private(set) var loadCount = 0

        init(queuedResults: [Result<SessionManifestDTO, AppServiceError>]) {
            self.queuedResults = queuedResults
        }

        func loadManifest(at _: URL) throws -> SessionManifestDTO {
            lock.lock()
            defer { lock.unlock() }
            loadCount += 1
            guard !queuedResults.isEmpty else {
                throw AppServiceError(
                    code: .artifactMissing,
                    userMessage: "manifest missing",
                    remediation: "retry"
                )
            }
            let result: Result<SessionManifestDTO, AppServiceError>
            if queuedResults.count > 1 {
                result = queuedResults.removeFirst()
            } else {
                result = queuedResults[0]
            }
            switch result {
            case .success(let manifest):
                return manifest
            case .failure(let error):
                throw error
            }
        }

        func observedLoadCount() -> Int {
            lock.lock()
            defer { lock.unlock() }
            return loadCount
        }
    }

    private final class DeterministicClock: @unchecked Sendable {
        private let lock = NSLock()
        private var current: Date
        private var sleepCallCount = 0

        init(start: Date = Date(timeIntervalSince1970: 0)) {
            current = start
        }

        func now() -> Date {
            lock.lock()
            defer { lock.unlock() }
            return current
        }

        func sleep(_ nanoseconds: UInt64) {
            lock.lock()
            sleepCallCount += 1
            current = current.addingTimeInterval(TimeInterval(nanoseconds) / 1_000_000_000)
            lock.unlock()
        }

        func observedSleepCallCount() -> Int {
            lock.lock()
            defer { lock.unlock() }
            return sleepCallCount
        }
    }

    private final class StubOnboardingCompletionStore: OnboardingCompletionStore {
        private let completed: Bool

        init(completed: Bool) {
            self.completed = completed
        }

        func isOnboardingComplete() -> Bool { completed }
        func markOnboardingComplete() {}
        func resetOnboardingCompletion() {}
    }

    private struct StubRuntimeReadinessChecker: RuntimeBinaryReadinessChecking {
        let report: RuntimeBinaryReadinessReport
        let blockingError: AppServiceError?

        func evaluateStartupReadiness() -> RuntimeBinaryReadinessReport { report }
        func startupBlockingError(from _: RuntimeBinaryReadinessReport) -> AppServiceError? { blockingError }
    }

    private struct StaticPreflightCommandRunner: CommandRunning {
        let payload: Data

        func run(
            executable _: String,
            arguments _: [String],
            environment _: [String: String]
        ) throws -> CommandExecutionResult {
            CommandExecutionResult(exitCode: 0, stdout: payload, stderr: Data())
        }
    }

    private func readyRuntimeReadinessReport() -> RuntimeBinaryReadinessReport {
        RuntimeBinaryReadinessReport(
            checks: [
                RuntimeBinaryReadinessCheck(
                    binaryName: "recordit",
                    overrideEnvKey: RuntimeBinaryResolver.recorditEnvKey,
                    status: .ready,
                    resolvedPath: "/usr/local/bin/recordit",
                    userMessage: "ready",
                    remediation: ""
                ),
                RuntimeBinaryReadinessCheck(
                    binaryName: "sequoia_capture",
                    overrideEnvKey: RuntimeBinaryResolver.sequoiaCaptureEnvKey,
                    status: .ready,
                    resolvedPath: "/usr/local/bin/sequoia_capture",
                    userMessage: "ready",
                    remediation: ""
                ),
            ]
        )
    }

    private func preflightPayloadData(checks: [[String: Any]], overallStatus: String = "FAIL") -> Data {
        let payload: [String: Any] = [
            "schema_version": "1",
            "kind": "transcribe-live-preflight",
            "generated_at_utc": "2026-03-05T00:00:00Z",
            "overall_status": overallStatus,
            "config": [
                "out_wav": "/tmp/out.wav",
                "out_jsonl": "/tmp/out.jsonl",
                "out_manifest": "/tmp/out.manifest.json",
                "asr_backend": "whispercpp",
                "asr_model_requested": "/tmp/model.bin",
                "asr_model_resolved": "/tmp/model.bin",
                "asr_model_source": "fixture",
                "sample_rate_hz": 48_000,
            ],
            "checks": checks,
        ]
        return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
    }

    private func makePreflightRunner(payload: Data) -> RecorditPreflightRunner {
        RecorditPreflightRunner(
            executable: "/usr/bin/env",
            commandRunner: StaticPreflightCommandRunner(payload: payload),
            parser: PreflightEnvelopeParser(),
            environment: [:]
        )
    }

    @MainActor
    private func makePreflightViewModel(
        payload: Data,
        nativePermissionStatus: ((RemediablePermission) -> Bool)? = nil
    ) -> PreflightViewModel {
        PreflightViewModel(
            runner: makePreflightRunner(payload: payload),
            gatingPolicy: PreflightGatingPolicy(),
            nativePermissionStatus: nativePermissionStatus
        )
    }

    @MainActor
    private func makePermissionRemediationItems(
        checks: [[String: Any]],
        overallStatus: String? = nil,
        nativePermissionStatus: @escaping (RemediablePermission) -> Bool
    ) throws -> [PermissionRemediationItem] {
        let resolvedOverallStatus: String
        if let overallStatus {
            resolvedOverallStatus = overallStatus
        } else if checks.contains(where: { (($0["status"] as? String) ?? "").uppercased() == "FAIL" }) {
            resolvedOverallStatus = "FAIL"
        } else if checks.contains(where: { (($0["status"] as? String) ?? "").uppercased() == "WARN" }) {
            resolvedOverallStatus = "WARN"
        } else {
            resolvedOverallStatus = "PASS"
        }

        let envelope = try PreflightEnvelopeParser().parse(
            data: preflightPayloadData(checks: checks, overallStatus: resolvedOverallStatus)
        )
        return PermissionRemediationViewModel.mapPermissionItems(
            from: envelope,
            nativePermissionStatus: nativePermissionStatus
        )
    }

    private func fixtureManifest(status: String, trustNoticeCount: Int = 0) -> SessionManifestDTO {
        SessionManifestDTO(
            sessionID: "xctest-session",
            status: status,
            runtimeMode: "live",
            trustNoticeCount: trustNoticeCount,
            artifacts: SessionArtifactsDTO(
                wavPath: URL(fileURLWithPath: "/tmp/xctest.wav"),
                jsonlPath: URL(fileURLWithPath: "/tmp/xctest.jsonl"),
                manifestPath: URL(fileURLWithPath: "/tmp/xctest.manifest.json")
            )
        )
    }

    @MainActor
    func testPreviewEnvironmentRuntimeAndPreflightContracts() async {
        let preview = AppEnvironment.preview()
        let runtimeViewModel = preview.makeRuntimeViewModel()
        let outputRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("recordit-xctest-preview-\(UUID().uuidString)")

        await runtimeViewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
        guard case let .running(processID) = runtimeViewModel.state else {
            XCTFail("Preview runtime should transition to running")
            return
        }
        XCTAssertEqual(processID, 42)

        let preflightViewModel = preview.makePreflightViewModel()
        preflightViewModel.runLivePreflight()
        guard case let .completed(envelope) = preflightViewModel.state else {
            XCTFail("Preview preflight should complete")
            return
        }
        XCTAssertEqual(envelope.kind, "transcribe-live-preflight")
    }

    func testRuntimeBinaryReadinessRejectsRelativeOverride() {
        let service = RuntimeBinaryReadinessService(
            environment: [
                RuntimeBinaryResolver.recorditEnvKey: "relative/recordit",
                "PATH": "/usr/bin:/bin",
            ]
        )

        let report = service.evaluateStartupReadiness()
        XCTAssertFalse(report.isReady)
        XCTAssertEqual(report.firstBlockingCheck?.status, .invalidOverride)
        XCTAssertEqual(service.startupBlockingError(from: report)?.code, .runtimeUnavailable)
    }

    func testRuntimeBinaryReadinessReportResolvedBinarySetRequiresReadyChecks() {
        let report = RuntimeBinaryReadinessReport(
            checks: [
                RuntimeBinaryReadinessCheck(
                    binaryName: "recordit",
                    overrideEnvKey: RuntimeBinaryResolver.recorditEnvKey,
                    status: .missing,
                    resolvedPath: "/tmp/recordit",
                    userMessage: "missing",
                    remediation: "install"
                ),
                RuntimeBinaryReadinessCheck(
                    binaryName: "sequoia_capture",
                    overrideEnvKey: RuntimeBinaryResolver.sequoiaCaptureEnvKey,
                    status: .missing,
                    resolvedPath: "/tmp/sequoia_capture",
                    userMessage: "missing",
                    remediation: "install"
                ),
            ]
        )

        XCTAssertFalse(report.isReady)
        XCTAssertNil(report.resolvedBinarySet)
    }

    func testRuntimeBinaryResolverPrefersBundledRuntimeBinaries() throws {
        let resourceRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordit-bundled-runtime-\(UUID().uuidString)", isDirectory: true)
        let runtimeBinDir = resourceRoot
            .appendingPathComponent("runtime", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: runtimeBinDir, withIntermediateDirectories: true)

        let bundledRecordit = runtimeBinDir.appendingPathComponent("recordit")
        let bundledCapture = runtimeBinDir.appendingPathComponent("sequoia_capture")
        try makeExecutableStubBinary(at: bundledRecordit)
        try makeExecutableStubBinary(at: bundledCapture)
        defer {
            try? FileManager.default.removeItem(at: resourceRoot)
        }

        let resolver = RuntimeBinaryResolver(
            environment: ["PATH": "/usr/bin:/bin"],
            bundleResourceURL: resourceRoot
        )
        let report = resolver.startupReadinessReport()

        XCTAssertTrue(report.isReady)
        XCTAssertEqual(report.checks.first(where: { $0.binaryName == "recordit" })?.resolvedPath, bundledRecordit.path)
        XCTAssertEqual(report.checks.first(where: { $0.binaryName == "sequoia_capture" })?.resolvedPath, bundledCapture.path)

        let binaries = try resolver.resolve()
        XCTAssertEqual(binaries.recordit.path, bundledRecordit.path)
        XCTAssertEqual(binaries.sequoiaCapture.path, bundledCapture.path)
    }

    func testRuntimeBinaryResolverDoesNotFallbackToPathWithoutExplicitOptIn() throws {
        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordit-path-fallback-\(UUID().uuidString)", isDirectory: true)
        let pathBinDir = tempRoot.appendingPathComponent("path-bin", isDirectory: true)
        try FileManager.default.createDirectory(at: pathBinDir, withIntermediateDirectories: true)

        let pathRecordit = pathBinDir.appendingPathComponent("recordit")
        let pathCapture = pathBinDir.appendingPathComponent("sequoia_capture")
        try makeExecutableStubBinary(at: pathRecordit)
        try makeExecutableStubBinary(at: pathCapture)
        defer {
            try? FileManager.default.removeItem(at: tempRoot)
        }

        let resolver = RuntimeBinaryResolver(
            environment: ["PATH": pathBinDir.path],
            bundleResourceURL: nil
        )
        let report = resolver.startupReadinessReport()

        XCTAssertFalse(report.isReady)
        XCTAssertEqual(report.firstBlockingCheck?.status, .missing)
        XCTAssertThrowsError(try resolver.resolve())
    }

    func testRuntimeBinaryResolverAllowsPathFallbackWhenExplicitlyEnabled() throws {
        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordit-path-opt-in-\(UUID().uuidString)", isDirectory: true)
        let pathBinDir = tempRoot.appendingPathComponent("path-bin", isDirectory: true)
        try FileManager.default.createDirectory(at: pathBinDir, withIntermediateDirectories: true)

        let pathRecordit = pathBinDir.appendingPathComponent("recordit")
        let pathCapture = pathBinDir.appendingPathComponent("sequoia_capture")
        try makeExecutableStubBinary(at: pathRecordit)
        try makeExecutableStubBinary(at: pathCapture)
        defer {
            try? FileManager.default.removeItem(at: tempRoot)
        }

        let resolver = RuntimeBinaryResolver(
            environment: [
                "PATH": pathBinDir.path,
                RuntimeBinaryResolver.allowPathLookupEnvKey: "1",
            ],
            bundleResourceURL: nil
        )
        let report = resolver.startupReadinessReport()

        XCTAssertTrue(report.isReady)
        XCTAssertEqual(report.checks.first(where: { $0.binaryName == "recordit" })?.resolvedPath, pathRecordit.path)
        XCTAssertEqual(report.checks.first(where: { $0.binaryName == "sequoia_capture" })?.resolvedPath, pathCapture.path)
        let binaries = try resolver.resolve()
        XCTAssertEqual(binaries.recordit.path, pathRecordit.path)
        XCTAssertEqual(binaries.sequoiaCapture.path, pathCapture.path)
    }

    func testModelResolutionServicePrecedenceExplicitThenEnvironmentThenBundledDefault() throws {
        let tempRoot = try makeTemporaryDirectory(prefix: "recordit-model-precedence")
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let explicitModelPath = tempRoot.appendingPathComponent("explicit-model.bin")
        let envModelPath = tempRoot.appendingPathComponent("env-model.bin")
        let bundleResources = tempRoot.appendingPathComponent("RecorditResources", isDirectory: true)
        let bundledModelPath = bundleResources
            .appendingPathComponent("runtime/models/whispercpp", isDirectory: true)
            .appendingPathComponent("ggml-tiny.en.bin")

        try Data("explicit".utf8).write(to: explicitModelPath, options: .atomic)
        try Data("env".utf8).write(to: envModelPath, options: .atomic)
        try FileManager.default.createDirectory(
            at: bundledModelPath.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("bundled".utf8).write(to: bundledModelPath, options: .atomic)

        let explicitResolver = FileSystemModelResolutionService(
            environment: ["RECORDIT_ASR_MODEL": envModelPath.path],
            currentDirectoryURL: tempRoot,
            bundleResourceURL: bundleResources
        )
        let explicitResolved = try explicitResolver.resolveModel(
            ModelResolutionRequest(explicitModelPath: explicitModelPath, backend: "whispercpp")
        )
        XCTAssertEqual(explicitResolved.resolvedPath, explicitModelPath)
        XCTAssertEqual(explicitResolved.source, "ui selected path")

        let envResolved = try explicitResolver.resolveModel(
            ModelResolutionRequest(explicitModelPath: nil, backend: "whispercpp")
        )
        XCTAssertEqual(envResolved.resolvedPath, envModelPath)
        XCTAssertEqual(envResolved.source, "RECORDIT_ASR_MODEL")

        let bundledResolver = FileSystemModelResolutionService(
            environment: [:],
            currentDirectoryURL: tempRoot,
            bundleResourceURL: bundleResources
        )
        let bundledResolved = try bundledResolver.resolveModel(
            ModelResolutionRequest(explicitModelPath: nil, backend: "whispercpp")
        )
        XCTAssertEqual(bundledResolved.resolvedPath, bundledModelPath)
        XCTAssertEqual(bundledResolved.source, "backend default")
    }

    func testModelResolutionServiceBundlePathIsDeterministicAndDoesNotFallbackToRepoRelativeWhenBundledContextPresent() throws {
        let tempRoot = try makeTemporaryDirectory(prefix: "recordit-model-bundle-missing")
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let bundleResources = tempRoot.appendingPathComponent("RecorditResources", isDirectory: true)
        try FileManager.default.createDirectory(at: bundleResources, withIntermediateDirectories: true)

        let repoRelativeModelPath = tempRoot
            .appendingPathComponent("artifacts/bench/models/whispercpp", isDirectory: true)
            .appendingPathComponent("ggml-tiny.en.bin")
        try FileManager.default.createDirectory(
            at: repoRelativeModelPath.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("repo-relative".utf8).write(to: repoRelativeModelPath, options: .atomic)

        let resolver = FileSystemModelResolutionService(
            environment: [:],
            currentDirectoryURL: tempRoot,
            bundleResourceURL: bundleResources
        )

        do {
            _ = try resolver.resolveModel(
                ModelResolutionRequest(explicitModelPath: nil, backend: "whispercpp")
            )
            XCTFail("Expected missing bundled model to fail in app-bundled context")
        } catch let error as AppServiceError {
            XCTAssertEqual(error.code, .modelUnavailable)
            XCTAssertTrue(
                error.remediation.contains("runtime/models/whispercpp/ggml-tiny.en.bin"),
                "remediation should name deterministic bundled model path"
            )
            XCTAssertNotNil(error.debugDetail)
            XCTAssertTrue(
                error.debugDetail?.contains("attempted=") == true,
                "debug detail should enumerate attempted default paths"
            )
            XCTAssertTrue(
                error.debugDetail?.contains("runtime/models/whispercpp/ggml-tiny.en.bin") == true,
                "debug detail should include deterministic bundled model lookup path"
            )
            XCTAssertFalse(
                error.debugDetail?.contains(repoRelativeModelPath.path) == true,
                "bundled context must not silently fallback to repo-relative defaults"
            )
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    @MainActor
    func testModelSetupDiagnosticsExposeResolvedModelSourceAttribution() throws {
        let tempRoot = try makeTemporaryDirectory(prefix: "recordit-model-diagnostics")
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let envModelPath = tempRoot.appendingPathComponent("env-model.bin")
        try Data("env".utf8).write(to: envModelPath, options: .atomic)

        let resolver = FileSystemModelResolutionService(
            environment: ["RECORDIT_ASR_MODEL": envModelPath.path],
            currentDirectoryURL: tempRoot,
            bundleResourceURL: nil
        )
        let modelSetup = ModelSetupViewModel(modelResolutionService: resolver)
        modelSetup.chooseBackend("whispercpp")
        modelSetup.validateCurrentSelection()

        guard case .ready = modelSetup.state else {
            XCTFail("Expected model setup to resolve from RECORDIT_ASR_MODEL")
            return
        }
        XCTAssertEqual(modelSetup.diagnostics?.asrModel, envModelPath.path)
        XCTAssertEqual(modelSetup.diagnostics?.asrModelSource, "RECORDIT_ASR_MODEL")
        XCTAssertEqual(modelSetup.diagnostics?.asrModelChecksumStatus, "available")
    }

    @MainActor
    func testRuntimeViewModelStartStopFinalizationCompletes() async {
        let runtimeService = DelayingRuntimeService()
        let viewModel = RuntimeViewModel(
            runtimeService: runtimeService,
            manifestService: StaticManifestService(manifest: fixtureManifest(status: "ok")),
            modelService: StaticModelService()
        )

        await viewModel.startLive(
            outputRoot: URL(fileURLWithPath: NSTemporaryDirectory()),
            explicitModelPath: nil
        )
        guard case .running = viewModel.state else {
            XCTFail("Runtime should be running after start")
            return
        }

        await viewModel.stopCurrentRun()
        XCTAssertEqual(viewModel.state, .completed)
        XCTAssertTrue(viewModel.suggestedRecoveryActions.isEmpty)
        let startCount = await runtimeService.startInvocationCount()
        let stopCount = await runtimeService.stopInvocationCount()
        XCTAssertEqual(startCount, 1)
        XCTAssertEqual(stopCount, 1)
    }

    @MainActor
    func testRuntimeViewModelFinalizationPendingStatusUsesBoundedPollingBeforeCompletion() async {
        let runtimeService = ImmediateRuntimeService()
        let manifestService = SequencedManifestService(
            queuedResults: [
                .success(fixtureManifest(status: "pending")),
                .success(fixtureManifest(status: "pending")),
                .success(fixtureManifest(status: "ok")),
            ]
        )
        let clock = DeterministicClock()
        let viewModel = RuntimeViewModel(
            runtimeService: runtimeService,
            manifestService: manifestService,
            modelService: StaticModelService(),
            finalizationTimeoutSeconds: 1,
            finalizationPollIntervalNanoseconds: 100_000_000,
            now: { clock.now() },
            sleep: { nanoseconds in
                clock.sleep(nanoseconds)
            }
        )

        let outputRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("recordit-bounded-finalization-\(UUID().uuidString)", isDirectory: true)
        await viewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
        await viewModel.stopCurrentRun()

        XCTAssertEqual(viewModel.state, .completed)
        XCTAssertEqual(clock.observedSleepCallCount(), 2, "pending manifests must consume bounded poll intervals before terminal completion")
        XCTAssertGreaterThanOrEqual(manifestService.observedLoadCount(), 3)
        let stopCount = await runtimeService.stopInvocations
        XCTAssertEqual(stopCount, 1)
    }

    @MainActor
    func testRuntimeViewModelStopFinalizationTimeoutWithoutArtifactsMapsToEmptyRootOutcome() async {
        let runtimeService = ImmediateRuntimeService()
        let manifestService = SequencedManifestService(
            queuedResults: [
                .failure(
                    AppServiceError(
                        code: .artifactMissing,
                        userMessage: "manifest missing",
                        remediation: "retry"
                    )
                ),
            ]
        )
        let clock = DeterministicClock()
        let viewModel = RuntimeViewModel(
            runtimeService: runtimeService,
            manifestService: manifestService,
            modelService: StaticModelService(),
            finalizationTimeoutSeconds: 0.5,
            finalizationPollIntervalNanoseconds: 100_000_000,
            now: { clock.now() },
            sleep: { nanoseconds in
                clock.sleep(nanoseconds)
            }
        )

        let outputRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("recordit-finalize-timeout-empty-\(UUID().uuidString)", isDirectory: true)
        await viewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
        await viewModel.stopCurrentRun()

        guard case let .failed(error) = viewModel.state else {
            XCTFail("Expected stop finalization timeout to enter failed state")
            return
        }
        XCTAssertEqual(error.code, .timeout)
        XCTAssertEqual(viewModel.suggestedRecoveryActions, [.startNewSession])
        XCTAssertTrue(error.debugDetail?.contains("timeout_seconds=0.5") == true)
        XCTAssertTrue(error.debugDetail?.contains("manifest_exists=false") == true)

        guard let context = viewModel.interruptionRecoveryContext else {
            XCTFail("Expected timeout failure to publish interruption recovery context")
            return
        }
        XCTAssertEqual(context.outcomeClassification, .emptyRoot)
        XCTAssertEqual(context.outcomeCode, .emptySessionRoot)
        XCTAssertEqual(context.outcomeDiagnostics["outcome_code"], SessionOutcomeCode.emptySessionRoot.rawValue)
        XCTAssertGreaterThanOrEqual(clock.observedSleepCallCount(), 4, "timeout path should consume bounded wait budget before failure")
    }

    @MainActor
    func testRuntimeViewModelFailedManifestMapsToCanonicalFinalizedFailureDiagnostics() async {
        let runtimeService = ImmediateRuntimeService()
        let viewModel = RuntimeViewModel(
            runtimeService: runtimeService,
            manifestService: StaticManifestService(manifest: fixtureManifest(status: "failed")),
            modelService: StaticModelService(),
            finalizationTimeoutSeconds: 1,
            finalizationPollIntervalNanoseconds: 100_000_000
        )

        let outputRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("recordit-finalized-failure-\(UUID().uuidString)", isDirectory: true)
        await viewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
        await viewModel.stopCurrentRun()

        guard case let .failed(error) = viewModel.state else {
            XCTFail("Expected failed manifest status to map to failure state")
            return
        }
        XCTAssertEqual(error.code, .processExitedUnexpectedly)
        XCTAssertEqual(viewModel.suggestedRecoveryActions, [.openSessionArtifacts, .startNewSession])
        XCTAssertEqual(viewModel.interruptionRecoveryContext?.outcomeClassification, .finalizedFailure)
        XCTAssertEqual(viewModel.interruptionRecoveryContext?.outcomeCode, .finalizedFailure)
        XCTAssertEqual(
            viewModel.interruptionRecoveryContext?.outcomeDiagnostics["manifest_status"],
            SessionStatus.failed.rawValue
        )
        XCTAssertEqual(
            viewModel.interruptionRecoveryContext?.outcomeDiagnostics["outcome_code"],
            SessionOutcomeCode.finalizedFailure.rawValue
        )
    }

    @MainActor
    func testRuntimeViewModelTimedOutStopClearsProcessAndRejectsRetryStop() async {
        let viewModel = RuntimeViewModel(
            runtimeService: TimeoutStopRuntimeService(),
            manifestService: StaticManifestService(manifest: fixtureManifest(status: "ok")),
            modelService: StaticModelService(),
            finalizationTimeoutSeconds: 1,
            finalizationPollIntervalNanoseconds: 100_000_000
        )

        let outputRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("recordit-stop-timeout-\(UUID().uuidString)", isDirectory: true)
        await viewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
        await viewModel.stopCurrentRun()

        guard case let .failed(error) = viewModel.state else {
            XCTFail("Expected runtime stop timeout to enter failed state")
            return
        }
        XCTAssertEqual(error.code, .timeout)
        XCTAssertFalse(viewModel.suggestedRecoveryActions.contains(.retryStop))
        XCTAssertTrue(viewModel.suggestedRecoveryActions.contains(.startNewSession))
        XCTAssertEqual(viewModel.interruptionRecoveryContext?.outcomeClassification, .emptyRoot)

        await viewModel.retryStopAfterFailure()
        XCTAssertEqual(viewModel.lastRejectedActionError?.code, .invalidInput)
        XCTAssertEqual(
            viewModel.lastRejectedActionError?.debugDetail,
            "action=retryStopAfterFailure, state=failed"
        )
    }

    @MainActor
    func testArtifactIntegrityDiagnosticsSchemaCoversAllSessionOutcomeClasses() throws {
        let tempRoot = try makeTemporaryDirectory(prefix: "recordit-outcome-diagnostics-schema")
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let service = FileSystemArtifactIntegrityService()
        let requiredKeys = [
            "root_path",
            "manifest_path",
            "pending_path",
            "retry_context_path",
            "wav_path",
            "jsonl_path",
            "has_manifest",
            "has_pending",
            "has_retry_context",
            "has_wav",
            "has_jsonl",
            "outcome_classification",
            "outcome_code",
        ]

        func writeManifest(at root: URL, status: SessionStatus) throws {
            let manifestURL = root.appendingPathComponent("session.manifest.json")
            let payload: [String: Any] = [
                "session_id": root.lastPathComponent,
                "runtime_mode": RuntimeMode.live.rawValue,
                "artifacts": [
                    "out_wav": root.appendingPathComponent("session.wav").path,
                    "out_jsonl": root.appendingPathComponent("session.jsonl").path,
                    "out_manifest": manifestURL.path,
                ],
                "session_summary": [
                    "session_status": status.rawValue,
                ],
                "trust": [
                    "notice_count": 0,
                ],
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            try data.write(to: manifestURL, options: .atomic)
        }

        func assertSchema(
            _ report: SessionArtifactIntegrityReportDTO,
            expectedClassification: SessionOutcomeClassification,
            expectedCode: SessionOutcomeCode,
            expectedManifestStatus: SessionStatus? = nil,
            file: StaticString = #filePath,
            line: UInt = #line
        ) {
            for key in requiredKeys {
                XCTAssertNotNil(
                    report.outcomeDiagnostics[key],
                    "missing required outcome diagnostic key: \(key)",
                    file: file,
                    line: line
                )
            }
            XCTAssertEqual(report.outcomeClassification, expectedClassification, file: file, line: line)
            XCTAssertEqual(report.outcomeCode, expectedCode, file: file, line: line)
            XCTAssertEqual(report.outcomeDiagnostics["outcome_classification"], expectedClassification.rawValue, file: file, line: line)
            XCTAssertEqual(report.outcomeDiagnostics["outcome_code"], expectedCode.rawValue, file: file, line: line)
            XCTAssertEqual(
                report.outcomeDiagnostics["manifest_status"],
                expectedManifestStatus?.rawValue,
                file: file,
                line: line
            )
        }

        let finalizedSuccessRoot = tempRoot.appendingPathComponent("finalized-success", isDirectory: true)
        try FileManager.default.createDirectory(at: finalizedSuccessRoot, withIntermediateDirectories: true)
        try Data("wav".utf8).write(to: finalizedSuccessRoot.appendingPathComponent("session.wav"), options: .atomic)
        try Data("{\"event\":\"final\"}\n".utf8).write(
            to: finalizedSuccessRoot.appendingPathComponent("session.jsonl"),
            options: .atomic
        )
        try writeManifest(at: finalizedSuccessRoot, status: .ok)

        let finalizedFailureRoot = tempRoot.appendingPathComponent("finalized-failure", isDirectory: true)
        try FileManager.default.createDirectory(at: finalizedFailureRoot, withIntermediateDirectories: true)
        try Data("wav".utf8).write(to: finalizedFailureRoot.appendingPathComponent("session.wav"), options: .atomic)
        try writeManifest(at: finalizedFailureRoot, status: .failed)

        let partialArtifactRoot = tempRoot.appendingPathComponent("partial-artifact", isDirectory: true)
        try FileManager.default.createDirectory(at: partialArtifactRoot, withIntermediateDirectories: true)
        try Data("wav".utf8).write(to: partialArtifactRoot.appendingPathComponent("session.wav"), options: .atomic)

        let emptyRoot = tempRoot.appendingPathComponent("empty-root", isDirectory: true)
        try FileManager.default.createDirectory(at: emptyRoot, withIntermediateDirectories: true)

        let finalizedSuccessReport = try service.evaluateSessionArtifacts(
            sessionID: finalizedSuccessRoot.lastPathComponent,
            rootPath: finalizedSuccessRoot
        )
        let finalizedFailureReport = try service.evaluateSessionArtifacts(
            sessionID: finalizedFailureRoot.lastPathComponent,
            rootPath: finalizedFailureRoot
        )
        let partialArtifactReport = try service.evaluateSessionArtifacts(
            sessionID: partialArtifactRoot.lastPathComponent,
            rootPath: partialArtifactRoot
        )
        let emptyRootReport = try service.evaluateSessionArtifacts(
            sessionID: emptyRoot.lastPathComponent,
            rootPath: emptyRoot
        )

        assertSchema(
            finalizedSuccessReport,
            expectedClassification: .finalizedSuccess,
            expectedCode: .finalizedSuccess,
            expectedManifestStatus: .ok
        )
        assertSchema(
            finalizedFailureReport,
            expectedClassification: .finalizedFailure,
            expectedCode: .finalizedFailure,
            expectedManifestStatus: .failed
        )
        assertSchema(
            partialArtifactReport,
            expectedClassification: .partialArtifact,
            expectedCode: .partialArtifactSession
        )
        assertSchema(
            emptyRootReport,
            expectedClassification: .emptyRoot,
            expectedCode: .emptySessionRoot
        )
    }

    @MainActor
    func testPermissionPromptRequesterSkipsNativePromptsForUITestAndXCTestEnvironments() {
        XCTAssertTrue(PermissionPromptRequester.shouldSkipNativePermissionPrompts(environment: ["RECORDIT_UI_TEST_MODE": "1"]))
        XCTAssertTrue(PermissionPromptRequester.shouldSkipNativePermissionPrompts(environment: ["XCTestConfigurationFilePath": "/tmp/xctest.xctestconfiguration"]))
        XCTAssertFalse(PermissionPromptRequester.shouldSkipNativePermissionPrompts(environment: [:]))
    }

    
    @MainActor
    func testMainSessionLiveStartDoesNotHardGateOnNativePermissionChecks() async throws {
        let runtimeService = DelayingRuntimeService()
        let environment = AppEnvironment.preview().replacing(
            runtimeService: runtimeService,
            manifestService: StaticManifestService(manifest: fixtureManifest(status: "ok")),
            modelService: StaticModelService()
        )
        let controller = MainSessionController(environment: environment)

        controller.startSession()
        try await waitForRuntimeRunning(controller: controller)

        let startCount = await runtimeService.startInvocationCount()
        XCTAssertEqual(startCount, 1)
        XCTAssertNil(controller.lastServiceError)
        XCTAssertTrue(
            controller.statusLog.contains(where: {
                $0.text.localizedCaseInsensitiveContains("runtime running")
            })
        )
    }

    @MainActor
    func testAppLevelResponsivenessBudgetsForLiveRun() async throws {
        let runtimeService = DelayingRuntimeService(
            startDelayNanoseconds: 35_000_000,
            stopDelayNanoseconds: 20_000_000
        )
        let environment = AppEnvironment.preview().replacing(
            runtimeService: runtimeService,
            manifestService: StaticManifestService(manifest: fixtureManifest(status: "ok")),
            modelService: StaticModelService()
        )
        let controller = MainSessionController(environment: environment)

        let startRequestedAt = Date()
        controller.startSession()
        try await waitForRuntimeRunning(controller: controller)
        let firstStableTranscriptMilliseconds = elapsedMilliseconds(since: startRequestedAt)

        let stopRequestedAt = Date()
        controller.stopSession()
        try await waitForStopSummary(controller: controller)
        let stopToSummaryMilliseconds = elapsedMilliseconds(since: stopRequestedAt)

        let budgets = [
            ResponsivenessBudget(metric: .firstStableTranscriptMs, maxMilliseconds: 3_500),
            ResponsivenessBudget(metric: .stopToSummaryMs, maxMilliseconds: 2_000),
        ]
        let budgetService = ResponsivenessBudgetService(budgets: budgets)
        let report = budgetService.evaluate(
            measurements: [
                ResponsivenessMeasurement(
                    metric: .firstStableTranscriptMs,
                    observedMilliseconds: firstStableTranscriptMilliseconds
                ),
                ResponsivenessMeasurement(
                    metric: .stopToSummaryMs,
                    observedMilliseconds: stopToSummaryMilliseconds
                ),
            ]
        )

        XCTAssertTrue(
            report.isPassing,
            "Responsiveness budgets should pass for app-level runtime lane; violations=\(report.violations)"
        )

        let snapshot = ResponsivenessGateSnapshot(
            firstStableTranscriptMilliseconds: firstStableTranscriptMilliseconds,
            stopToSummaryMilliseconds: stopToSummaryMilliseconds,
            firstStableTranscriptBudgetMilliseconds: 3_500,
            stopToSummaryBudgetMilliseconds: 2_000,
            firstStableTranscriptBudgetPass: !report.violations.contains(where: { $0.metric == .firstStableTranscriptMs }),
            stopToSummaryBudgetPass: !report.violations.contains(where: { $0.metric == .stopToSummaryMs }),
            gatePass: report.isPassing,
            failedMetrics: report.violations.map { $0.metric.rawValue }.joined(separator: ",")
        )
        try persistResponsivenessGateSnapshotIfRequested(snapshot)
    }

    @MainActor
    func testPreflightUITestNormalizationDoesNotHideGrantedMicrophoneRuntimeFailures() {
        setenv("RECORDIT_UI_TEST_MODE", "1", 1)
        defer {
            unsetenv("RECORDIT_UI_TEST_MODE")
            unsetenv("RECORDIT_UI_TEST_NATIVE_MICROPHONE_PERMISSION")
        }
        setenv("RECORDIT_UI_TEST_NATIVE_MICROPHONE_PERMISSION", "granted", 1)

        let payload = preflightPayloadData(checks: [
            ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "model ready", "remediation": ""],
            ["id": ReadinessContractID.outWav.rawValue, "status": "PASS", "detail": "wav ready", "remediation": ""],
            ["id": ReadinessContractID.outJsonl.rawValue, "status": "PASS", "detail": "jsonl ready", "remediation": ""],
            ["id": ReadinessContractID.outManifest.rawValue, "status": "PASS", "detail": "manifest ready", "remediation": ""],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "screen permission granted", "remediation": ""],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "FAIL", "detail": "microphone stream unavailable", "remediation": "Verify the active input device and retry."],
        ])
        let viewModel = makePreflightViewModel(
            payload: payload,
            nativePermissionStatus: { _ in true }
        )

        viewModel.runLivePreflight()

        guard case let .completed(envelope) = viewModel.state else {
            XCTFail("Expected preflight to complete")
            return
        }
        let microphoneCheck = envelope.checks.first(where: { $0.id == ReadinessContractID.microphoneAccess.rawValue })
        XCTAssertEqual(microphoneCheck?.status, .fail)
        XCTAssertEqual(viewModel.primaryBlockingDomain, .tccCapture)
        XCTAssertFalse(viewModel.canProceedToLiveTranscribe)
    }



    @MainActor
    func testReadinessObservabilityScenariosCaptureStructuredGateDecisions() throws {
        struct ScenarioExpectation {
            let id: String
            let checks: [[String: Any]]
            let expectedBlockingDomain: String
            let expectedCanProceedLive: Bool
            let expectedRecordOnlyFallback: Bool
            let expectedWarningAck: Bool
        }

        let scenarios: [ScenarioExpectation] = [
            ScenarioExpectation(
                id: "live_ready",
                checks: [
                    ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "model ready", "remediation": ""],
                    ["id": ReadinessContractID.outWav.rawValue, "status": "PASS", "detail": "wav ready", "remediation": ""],
                    ["id": ReadinessContractID.outJsonl.rawValue, "status": "PASS", "detail": "jsonl ready", "remediation": ""],
                    ["id": ReadinessContractID.outManifest.rawValue, "status": "PASS", "detail": "manifest ready", "remediation": ""],
                    ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "screen access granted", "remediation": ""],
                    ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "microphone ready", "remediation": ""],
                ],
                expectedBlockingDomain: "none",
                expectedCanProceedLive: true,
                expectedRecordOnlyFallback: false,
                expectedWarningAck: false
            ),
            ScenarioExpectation(
                id: "live_blocked_model",
                checks: [
                    ["id": ReadinessContractID.modelPath.rawValue, "status": "FAIL", "detail": "model path missing", "remediation": "Provide a compatible model."],
                    ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "screen access granted", "remediation": ""],
                    ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "microphone ready", "remediation": ""],
                ],
                expectedBlockingDomain: ReadinessDomain.backendModel.rawValue,
                expectedCanProceedLive: false,
                expectedRecordOnlyFallback: true,
                expectedWarningAck: false
            ),
            ScenarioExpectation(
                id: "live_blocked_capture",
                checks: [
                    ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "model ready", "remediation": ""],
                    ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "FAIL", "detail": "screen denied", "remediation": "Grant Screen Recording in System Settings."],
                    ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "microphone ready", "remediation": ""],
                ],
                expectedBlockingDomain: ReadinessDomain.tccCapture.rawValue,
                expectedCanProceedLive: false,
                expectedRecordOnlyFallback: false,
                expectedWarningAck: false
            ),
            ScenarioExpectation(
                id: "live_blocked_runtime_preflight",
                checks: [
                    ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "model ready", "remediation": ""],
                    ["id": ReadinessContractID.outManifest.rawValue, "status": "FAIL", "detail": "manifest path unavailable", "remediation": "Fix manifest output path."],
                    ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "screen access granted", "remediation": ""],
                    ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "microphone ready", "remediation": ""],
                ],
                expectedBlockingDomain: ReadinessDomain.runtimePreflight.rawValue,
                expectedCanProceedLive: false,
                expectedRecordOnlyFallback: false,
                expectedWarningAck: false
            ),
            ScenarioExpectation(
                id: "live_warn_ack_required",
                checks: [
                    ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "model ready", "remediation": ""],
                    ["id": ReadinessContractID.outWav.rawValue, "status": "PASS", "detail": "wav ready", "remediation": ""],
                    ["id": ReadinessContractID.outJsonl.rawValue, "status": "PASS", "detail": "jsonl ready", "remediation": ""],
                    ["id": ReadinessContractID.outManifest.rawValue, "status": "PASS", "detail": "manifest ready", "remediation": ""],
                    ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "screen access granted", "remediation": ""],
                    ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "microphone ready", "remediation": ""],
                    ["id": ReadinessContractID.sampleRate.rawValue, "status": "WARN", "detail": "non-default sample rate", "remediation": "Acknowledge warning to continue."],
                ],
                expectedBlockingDomain: "none",
                expectedCanProceedLive: false,
                expectedRecordOnlyFallback: false,
                expectedWarningAck: true
            ),
        ]

        var snapshots = [ReadinessScenarioSnapshot]()
        snapshots.reserveCapacity(scenarios.count)
        for scenario in scenarios {
            let snapshot = try buildReadinessScenarioSnapshot(
                scenarioID: scenario.id,
                checks: scenario.checks
            )
            snapshots.append(snapshot)

            XCTAssertEqual(snapshot.preflightKind, "transcribe-live-preflight")
            XCTAssertEqual(snapshot.mappedBlockingDomain, scenario.expectedBlockingDomain)
            XCTAssertEqual(snapshot.preflightCanProceedLive, scenario.expectedCanProceedLive)
            XCTAssertEqual(snapshot.preflightCanOfferRecordOnlyFallback, scenario.expectedRecordOnlyFallback)
            XCTAssertEqual(snapshot.rootPreflightCanProceed, scenario.expectedCanProceedLive)
            XCTAssertEqual(snapshot.rootPreflightCanOfferRecordOnlyFallback, scenario.expectedRecordOnlyFallback)
            XCTAssertEqual(snapshot.rootPreflightRequiresWarningAck, scenario.expectedWarningAck)
            XCTAssertTrue(snapshot.preflightCheckIDs.contains(ReadinessContractID.modelPath.rawValue))
            XCTAssertEqual(snapshot.preflightCheckIDs.sorted(), snapshot.mappedCheckIDs.sorted())
        }

        XCTAssertEqual(snapshots.count, scenarios.count)
        XCTAssertTrue(snapshots.contains(where: { $0.preflightCanOfferRecordOnlyFallback }))
        XCTAssertTrue(snapshots.contains(where: { $0.rootPreflightRequiresWarningAck }))

        try persistReadinessScenarioSnapshotsIfRequested(snapshots)
    }

    @MainActor
    func testRootSnapshotOnlyOffersMainRuntimeShortcutForRecordOnlyEligiblePreflightBlockers() {
        let modelBlockedController = RootCompositionController(
            environment: AppEnvironment.preview().replacing(
                preflightRunner: makePreflightRunner(
                    payload: preflightPayloadData(checks: [
                        ["id": ReadinessContractID.modelPath.rawValue, "status": "FAIL", "detail": "model path missing", "remediation": "Provide a compatible model."],
                        ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "screen access granted", "remediation": ""],
                        ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "microphone access granted", "remediation": ""],
                    ])
                )
            ),
            firstRun: true
        )
        modelBlockedController.runPreflight()
        XCTAssertTrue(modelBlockedController.snapshot.preflightCanOfferRecordOnlyFallback)

        let screenBlockedController = RootCompositionController(
            environment: AppEnvironment.preview().replacing(
                preflightRunner: makePreflightRunner(
                    payload: preflightPayloadData(checks: [
                        ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "model ready", "remediation": ""],
                        ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "FAIL", "detail": "screen access denied", "remediation": "Grant Screen Recording in System Settings."],
                        ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "microphone access granted", "remediation": ""],
                    ])
                )
            ),
            firstRun: true
        )
        screenBlockedController.runPreflight()
        XCTAssertFalse(screenBlockedController.snapshot.preflightCanOfferRecordOnlyFallback)
    }



    @MainActor
    func testPermissionRemediationDoesNotDowngradeGrantedRuntimeFailuresInUITestMode() throws {
        setenv("RECORDIT_UI_TEST_MODE", "1", 1)
        defer { unsetenv("RECORDIT_UI_TEST_MODE") }

        let items = try makePermissionRemediationItems(
            checks: [
                ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "screen access granted", "remediation": ""],
                ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "FAIL", "detail": "microphone stream unavailable", "remediation": "Verify the active input device and retry."],
            ],
            nativePermissionStatus: { _ in true }
        )

        let microphone = try XCTUnwrap(items.first(where: { $0.surface == .microphone }))
        XCTAssertEqual(microphone.status, .runtimeFailure)
        XCTAssertTrue(microphone.detail.contains("macOS permission appears granted") == true)
    }

    @MainActor
    func testPermissionRemediationMarksGrantedButFailingScreenCheckAsRuntimeFailure() throws {
        let items = try makePermissionRemediationItems(
            checks: [
                ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "FAIL", "detail": "screen capture helper unavailable", "remediation": "Quit and reopen Recordit, then Re-check."],
                ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "mic ready", "remediation": ""],
            ],
            nativePermissionStatus: { _ in true }
        )

        let screen = try XCTUnwrap(items.first(where: { $0.surface == .screenRecording }))
        XCTAssertEqual(screen.status, .runtimeFailure)
        XCTAssertTrue(screen.detail.contains("macOS permission appears granted") == true)
        XCTAssertEqual(screen.remediation, "Quit and reopen Recordit, then Re-check.")
        XCTAssertFalse(items.contains { $0.surface.settingsPermission == .screenRecording && $0.status == .missingPermission })
    }

    @MainActor
    func testPermissionRemediationMarksGrantedButFailingMicrophoneCheckAsRuntimeFailure() throws {
        let items = try makePermissionRemediationItems(
            checks: [
                ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "screen access granted", "remediation": ""],
                ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "FAIL", "detail": "microphone stream unavailable", "remediation": "Verify the active input device and retry."],
            ],
            nativePermissionStatus: { _ in true }
        )

        let microphone = try XCTUnwrap(items.first(where: { $0.surface == .microphone }))
        XCTAssertEqual(microphone.status, .runtimeFailure)
        XCTAssertTrue(microphone.detail.contains("macOS permission appears granted") == true)
        XCTAssertEqual(microphone.remediation, "Verify the active input device and retry.")
    }

    @MainActor
    func testPermissionRemediationUsesNativePermissionSignalWhenChecksAreMissing() throws {
        let items = try makePermissionRemediationItems(
            checks: [],
            nativePermissionStatus: { _ in false }
        )

        let screen = try XCTUnwrap(items.first(where: { $0.surface == .screenRecording }))
        let microphone = try XCTUnwrap(items.first(where: { $0.surface == .microphone }))
        XCTAssertEqual(screen.status, .missingPermission)
        XCTAssertEqual(microphone.status, .missingPermission)
        XCTAssertTrue(screen.remediation.contains("Open System Settings") == true)
        XCTAssertTrue(microphone.remediation.contains("Open System Settings") == true)
    }

    @MainActor
    func testOnboardingGateFailureUsesReadinessIDRemediationForModelPath() {
        let shell = AppShellViewModel(
            firstRun: true,
            onboardingCompletionStore: StubOnboardingCompletionStore(completed: false),
            runtimeReadinessChecker: StubRuntimeReadinessChecker(
                report: readyRuntimeReadinessReport(),
                blockingError: nil
            )
        )
        let modelSetup = ModelSetupViewModel(modelResolutionService: StaticModelService())
        modelSetup.validateCurrentSelection()

        let payload = preflightPayloadData(checks: [
            ["id": ReadinessContractID.modelPath.rawValue, "status": "FAIL", "detail": "model path missing", "remediation": "Provide a compatible model."],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
        ])
        let preflight = makePreflightViewModel(payload: payload)
        preflight.runLivePreflight()

        XCTAssertFalse(shell.completeOnboardingIfReady(modelSetup: modelSetup, preflight: preflight))
        XCTAssertEqual(shell.onboardingGateFailure?.code, .modelUnavailable)
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Provide a compatible model.") == true)
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Validate Model Setup") == true)
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Record Only remains available") == true)
    }

    @MainActor
    func testOnboardingGateFailureUsesReadinessIDRemediationForBackendRuntime() {
        let shell = AppShellViewModel(
            firstRun: true,
            onboardingCompletionStore: StubOnboardingCompletionStore(completed: false),
            runtimeReadinessChecker: StubRuntimeReadinessChecker(
                report: readyRuntimeReadinessReport(),
                blockingError: nil
            )
        )
        let modelSetup = ModelSetupViewModel(modelResolutionService: StaticModelService())
        modelSetup.validateCurrentSelection()

        let payload = preflightPayloadData(checks: [
            ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.outWav.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.outJsonl.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.outManifest.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.backendRuntime.rawValue, "status": "FAIL", "detail": "runtime missing", "remediation": "Install or repair the live backend."],
        ])
        let preflight = makePreflightViewModel(payload: payload)
        preflight.runLivePreflight()

        XCTAssertEqual(preflight.primaryBlockingDomain, .backendRuntime)
        XCTAssertTrue(preflight.canOfferRecordOnlyFallback)
        XCTAssertFalse(shell.completeOnboardingIfReady(modelSetup: modelSetup, preflight: preflight))
        XCTAssertEqual(shell.onboardingGateFailure?.code, .preflightFailed)
        XCTAssertEqual(
            shell.onboardingGateFailure?.userMessage,
            "Live Transcribe is blocked because the backend runtime is not ready."
        )
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Install or repair the live backend.") == true)
        XCTAssertTrue(
            shell.onboardingGateFailure?.remediation.contains("Review runtime diagnostics and backend installation state.") == true
        )
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Record Only remains available") == true)
    }

    @MainActor
    func testOnboardingGateFailureUsesReadinessIDRemediationForManifestOutput() {
        let shell = AppShellViewModel(
            firstRun: true,
            onboardingCompletionStore: StubOnboardingCompletionStore(completed: false),
            runtimeReadinessChecker: StubRuntimeReadinessChecker(
                report: readyRuntimeReadinessReport(),
                blockingError: nil
            )
        )
        let modelSetup = ModelSetupViewModel(modelResolutionService: StaticModelService())
        modelSetup.validateCurrentSelection()

        let payload = preflightPayloadData(checks: [
            ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.outWav.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.outJsonl.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.outManifest.rawValue, "status": "FAIL", "detail": "manifest path unavailable", "remediation": "Fix the manifest output path before retrying."],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
        ])
        let preflight = makePreflightViewModel(payload: payload)
        preflight.runLivePreflight()

        XCTAssertEqual(preflight.primaryBlockingDomain, .runtimePreflight)
        XCTAssertFalse(preflight.canOfferRecordOnlyFallback)
        XCTAssertFalse(shell.completeOnboardingIfReady(modelSetup: modelSetup, preflight: preflight))
        XCTAssertEqual(shell.onboardingGateFailure?.code, .preflightFailed)
        XCTAssertEqual(
            shell.onboardingGateFailure?.userMessage,
            "Live Transcribe is blocked because Recordit cannot prepare the session manifest."
        )
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Fix the manifest output path before retrying.") == true)
        XCTAssertTrue(
            shell.onboardingGateFailure?.remediation.contains("Verify Recordit can write its session artifacts and manifest files.") == true
        )
        XCTAssertFalse(shell.onboardingGateFailure?.remediation.contains("Record Only remains available") == true)
    }

    @MainActor
    func testOnboardingGateFailureUsesReadinessIDRemediationForScreenPermission() {
        let shell = AppShellViewModel(
            firstRun: true,
            onboardingCompletionStore: StubOnboardingCompletionStore(completed: false),
            runtimeReadinessChecker: StubRuntimeReadinessChecker(
                report: readyRuntimeReadinessReport(),
                blockingError: nil
            )
        )
        let modelSetup = ModelSetupViewModel(modelResolutionService: StaticModelService())
        modelSetup.validateCurrentSelection()

        let payload = preflightPayloadData(checks: [
            ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "FAIL", "detail": "screen access denied", "remediation": "Grant Screen Recording in System Settings."],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
        ])
        let preflight = makePreflightViewModel(payload: payload)
        preflight.runLivePreflight()

        XCTAssertFalse(shell.completeOnboardingIfReady(modelSetup: modelSetup, preflight: preflight))
        XCTAssertEqual(shell.onboardingGateFailure?.code, .permissionDenied)
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Grant Screen Recording in System Settings.") == true)
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Open Screen Recording Settings") == true)
        XCTAssertFalse(shell.onboardingGateFailure?.remediation.contains("Record Only remains available") == true)
    }

    @MainActor
    func testOnboardingGateFailurePrefersPrimaryBlockingDomainOverEnvelopeOrder() {
        let shell = AppShellViewModel(
            firstRun: true,
            onboardingCompletionStore: StubOnboardingCompletionStore(completed: false),
            runtimeReadinessChecker: StubRuntimeReadinessChecker(
                report: readyRuntimeReadinessReport(),
                blockingError: nil
            )
        )
        let modelSetup = ModelSetupViewModel(modelResolutionService: StaticModelService())
        modelSetup.validateCurrentSelection()

        let payload = preflightPayloadData(checks: [
            ["id": ReadinessContractID.modelPath.rawValue, "status": "FAIL", "detail": "model path missing", "remediation": "Provide a compatible model."],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "FAIL", "detail": "screen access denied", "remediation": "Grant Screen Recording in System Settings."],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
        ])
        let preflight = makePreflightViewModel(payload: payload)
        preflight.runLivePreflight()

        XCTAssertEqual(preflight.primaryBlockingDomain, .tccCapture)
        XCTAssertFalse(shell.completeOnboardingIfReady(modelSetup: modelSetup, preflight: preflight))
        XCTAssertEqual(shell.onboardingGateFailure?.code, .permissionDenied)
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Grant Screen Recording in System Settings.") == true)
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Open Screen Recording Settings") == true)
        XCTAssertFalse(shell.onboardingGateFailure?.remediation.contains("Validate Model Setup") == true)
        XCTAssertFalse(shell.onboardingGateFailure?.remediation.contains("Record Only remains available") == true)
    }

    @MainActor
    func testOnboardingGateFailureRequiresWarningAcknowledgementBeforeCompletion() {
        let shell = AppShellViewModel(
            firstRun: true,
            onboardingCompletionStore: StubOnboardingCompletionStore(completed: false),
            runtimeReadinessChecker: StubRuntimeReadinessChecker(
                report: readyRuntimeReadinessReport(),
                blockingError: nil
            )
        )
        let modelSetup = ModelSetupViewModel(modelResolutionService: StaticModelService())
        modelSetup.validateCurrentSelection()

        let payload = preflightPayloadData(
            checks: [
                ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
                ["id": ReadinessContractID.outWav.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
                ["id": ReadinessContractID.outJsonl.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
                ["id": ReadinessContractID.outManifest.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
                ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
                ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
                ["id": ReadinessContractID.sampleRate.rawValue, "status": "WARN", "detail": "non-default sample rate", "remediation": "Acknowledge this warning to continue."],
            ],
            overallStatus: "WARN"
        )
        let preflight = makePreflightViewModel(payload: payload)
        preflight.runLivePreflight()

        XCTAssertTrue(preflight.requiresWarningAcknowledgement)
        XCTAssertFalse(shell.completeOnboardingIfReady(modelSetup: modelSetup, preflight: preflight))
        XCTAssertEqual(shell.onboardingGateFailure?.code, .preflightFailed)
        XCTAssertEqual(
            shell.onboardingGateFailure?.userMessage,
            "Live Transcribe warnings must be acknowledged before finishing setup."
        )
        XCTAssertTrue(shell.onboardingGateFailure?.remediation.contains("Acknowledge Warnings") == true)
        XCTAssertFalse(shell.onboardingGateFailure?.remediation.contains("Run preflight checks") == true)
    }

    @MainActor
    func testAppShellRoutesReturningUsersToRecoveryWhenRuntimeUnavailable() {
        let check = RuntimeBinaryReadinessCheck(
            binaryName: "recordit",
            overrideEnvKey: RuntimeBinaryResolver.recorditEnvKey,
            status: .missing,
            resolvedPath: nil,
            userMessage: "missing",
            remediation: "install"
        )
        let report = RuntimeBinaryReadinessReport(checks: [check])
        let runtimeError = AppServiceError(
            code: .runtimeUnavailable,
            userMessage: "Runtime missing.",
            remediation: "Install runtime."
        )

        let shell = AppShellViewModel(
            firstRun: false,
            onboardingCompletionStore: StubOnboardingCompletionStore(completed: true),
            runtimeReadinessChecker: StubRuntimeReadinessChecker(report: report, blockingError: runtimeError)
        )

        XCTAssertEqual(shell.activeRoot, .recovery)
        XCTAssertEqual(shell.startupRuntimeReadinessFailure?.code, .runtimeUnavailable)
    }

    @MainActor
    func testProductionStartupReadinessRoutesReturningUsersToRecoveryWithoutStubChecker() async throws {
        let tempRoot = try makeTemporaryDirectory(prefix: "recordit-production-readiness")
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let binDirectory = tempRoot.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: binDirectory, withIntermediateDirectories: true)

        let invalidRecorditPath = binDirectory.appendingPathComponent("recordit-nonexec")
        let sequoiaBinary = binDirectory.appendingPathComponent("sequoia_capture")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: invalidRecorditPath, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o644)], ofItemAtPath: invalidRecorditPath.path)
        try makeExecutableStubBinary(at: sequoiaBinary)

        let originalPath = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        try await withTemporaryEnvironment(
            [
                RuntimeBinaryResolver.recorditEnvKey: invalidRecorditPath.path,
                RuntimeBinaryResolver.sequoiaCaptureEnvKey: sequoiaBinary.path,
                "PATH": "\(binDirectory.path):\(originalPath)",
            ]
        ) {
            let shell = AppShellViewModel(
                firstRun: false,
                onboardingCompletionStore: StubOnboardingCompletionStore(completed: true)
            )

            XCTAssertEqual(shell.activeRoot, .recovery)
            XCTAssertEqual(shell.startupRuntimeReadinessFailure?.code, .runtimeUnavailable)
            XCTAssertEqual(shell.startupRuntimeReadinessReport.firstBlockingCheck?.binaryName, "recordit")
            XCTAssertEqual(shell.startupRuntimeReadinessReport.firstBlockingCheck?.status, .notExecutable)
            XCTAssertEqual(shell.startupRuntimeReadinessReport.checks.first(where: { $0.binaryName == "sequoia_capture" })?.status, .ready)

            let debugDetail = try XCTUnwrap(shell.startupRuntimeReadinessFailure?.debugDetail)
            let debugData = try XCTUnwrap(debugDetail.data(using: .utf8))
            let debugRecord = try JSONDecoder().decode(StartupSelfCheckLogRecord.self, from: debugData)
            XCTAssertEqual(debugRecord.schemaVersion, "1")
            XCTAssertEqual(debugRecord.eventType, "startup_self_check")
            XCTAssertFalse(debugRecord.runtimeReady)
            XCTAssertFalse(debugRecord.liveTranscribeAvailable)
            XCTAssertTrue(debugRecord.recordOnlyAvailable)
            XCTAssertEqual(debugRecord.readinessImplication, .liveBlockedRuntime)
            XCTAssertEqual(debugRecord.modelSelection.status, .unavailable)
            XCTAssertEqual(debugRecord.modelSelection.errorCode, AppServiceErrorCode.runtimeUnavailable.rawValue)
            XCTAssertTrue(
                debugRecord.runtimeChecks.contains(where: {
                    $0.binaryName == "recordit"
                        && $0.status == RuntimeBinaryReadinessStatus.notExecutable.rawValue
                        && $0.resolvedPath == invalidRecorditPath.path
                })
            )
            XCTAssertTrue(
                debugRecord.runtimeChecks.contains(where: {
                    $0.binaryName == "sequoia_capture" && $0.status == RuntimeBinaryReadinessStatus.ready.rawValue
                })
            )
        }
    }

    @MainActor
    func testProductionEnvironmentUsesRealRuntimeWiringWithoutMockServices() async throws {
        let tempRoot = try makeTemporaryDirectory(prefix: "recordit-production-environment")
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let binDirectory = tempRoot.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: binDirectory, withIntermediateDirectories: true)

        let recorditBinary = binDirectory.appendingPathComponent("recordit")
        let sequoiaBinary = binDirectory.appendingPathComponent("sequoia_capture")
        let modelPath = tempRoot.appendingPathComponent("ggml-tiny.en.bin")
        let sessionRoot = tempRoot.appendingPathComponent("live-session", isDirectory: true)

        try Data("production-model".utf8).write(to: modelPath, options: .atomic)
        try makeExecutableShellScript(
            at: recorditBinary,
            body: """
            #!/bin/sh
            command="$1"
            shift
            out_root=""
            mode=""
            model=""
            while [ "$#" -gt 0 ]; do
              case "$1" in
                --output-root) out_root="$2"; shift 2 ;;
                --mode) mode="$2"; shift 2 ;;
                --model) model="$2"; shift 2 ;;
                *) shift ;;
              esac
            done
            [ -n "$out_root" ] && mkdir -p "$out_root"

            finalize() {
              session_id=$(basename "$out_root")
              cat > "$out_root/session.manifest.json" <<EOF
            {"session_id":"$session_id","runtime_mode":"live","artifacts":{"out_wav":"$out_root/session.wav","out_jsonl":"$out_root/session.jsonl","out_manifest":"$out_root/session.manifest.json"},"session_summary":{"session_status":"ok"},"trust":{"notice_count":0}}
            EOF
              printf 'runtime finalized\n' > "$out_root/session.jsonl"
              : > "$out_root/session.wav"
              exit 0
            }

            case "$command" in
              preflight)
                manifest_path="$out_root/preflight.manifest.json"
                cat > "$manifest_path" <<EOF
            {"schema_version":"1","kind":"transcribe-live-preflight","generated_at_utc":"2026-03-06T00:00:00Z","overall_status":"PASS","config":{"out_wav":"$out_root/preflight.wav","out_jsonl":"$out_root/preflight.jsonl","out_manifest":"$manifest_path","asr_backend":"whispercpp","asr_model_requested":"$RECORDIT_ASR_MODEL","asr_model_resolved":"$RECORDIT_ASR_MODEL","asr_model_source":"RECORDIT_ASR_MODEL","sample_rate_hz":48000},"checks":[{"id":"model_path","status":"PASS","detail":"model ready","remediation":""},{"id":"screen_capture_access","status":"PASS","detail":"screen ready","remediation":""},{"id":"microphone_access","status":"PASS","detail":"microphone ready","remediation":""}]}
            EOF
                printf '{"command":"preflight","session":{"manifest":"%s"}}\n' "$manifest_path"
                ;;
              run)
                printf '%s' "$mode" > "$out_root/runtime.mode"
                printf '%s' "$model" > "$out_root/runtime.model"
                printf '%s' "$RECORDIT_ASR_MODEL" > "$out_root/runtime.env_model"
                : > "$out_root/runtime.started"
                trap 'finalize' INT TERM
                while :; do
                  if [ -f "$out_root/session.stop.request" ]; then
                    finalize
                  fi
                  sleep 0.05
                done
                ;;
              *)
                exit 64
                ;;
            esac
            """
        )
        try makeExecutableStubBinary(at: sequoiaBinary)

        let originalPath = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        try await withTemporaryEnvironment(
            [
                RuntimeBinaryResolver.recorditEnvKey: recorditBinary.path,
                RuntimeBinaryResolver.sequoiaCaptureEnvKey: sequoiaBinary.path,
                "RECORDIT_ASR_MODEL": modelPath.path,
                "PATH": "\(binDirectory.path):\(originalPath)",
            ]
        ) {
            let environment = AppEnvironment.production()

            let preflightViewModel = environment.makePreflightViewModel()
            preflightViewModel.runLivePreflight()
            guard case let .completed(envelope) = preflightViewModel.state else {
                XCTFail("Expected production preflight to complete through the real recordit command")
                return
            }
            XCTAssertEqual(envelope.kind, "transcribe-live-preflight")
            XCTAssertEqual(envelope.config.asrModelRequested, modelPath.path)
            XCTAssertEqual(envelope.config.asrModelResolved, modelPath.path)
            XCTAssertEqual(envelope.config.asrModelSource, "RECORDIT_ASR_MODEL")

            let runtimeViewModel = environment.makeRuntimeViewModel()
            await runtimeViewModel.startLive(outputRoot: sessionRoot, explicitModelPath: nil)
            guard case .running = runtimeViewModel.state else {
                XCTFail("Expected production runtime view model to reach running state")
                return
            }

            await waitForFile(at: sessionRoot.appendingPathComponent("runtime.started"))
            XCTAssertEqual(try readTrimmedTextFile(at: sessionRoot.appendingPathComponent("runtime.mode")), "live")
            XCTAssertEqual(try readTrimmedTextFile(at: sessionRoot.appendingPathComponent("runtime.model")), modelPath.path)
            XCTAssertEqual(try readTrimmedTextFile(at: sessionRoot.appendingPathComponent("runtime.env_model")), modelPath.path)

            await runtimeViewModel.stopCurrentRun()
            XCTAssertEqual(runtimeViewModel.state, .completed)
            XCTAssertTrue(FileManager.default.fileExists(atPath: sessionRoot.appendingPathComponent("session.manifest.json").path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: sessionRoot.appendingPathComponent("session.jsonl").path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: sessionRoot.appendingPathComponent("session.wav").path))
        }
    }

    @MainActor
    func testProductionEnvironmentMainSessionControllerLiveRunCompletesWithoutMockServices() async throws {
        let tempRoot = try makeTemporaryDirectory(prefix: "recordit-production-controller-live")
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let binDirectory = tempRoot.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: binDirectory, withIntermediateDirectories: true)

        let recorditBinary = binDirectory.appendingPathComponent("recordit")
        let sequoiaBinary = binDirectory.appendingPathComponent("sequoia_capture")
        let modelPath = tempRoot.appendingPathComponent("ggml-base.en.bin")

        try Data("controller-live-model".utf8).write(to: modelPath, options: .atomic)
        try makeExecutableShellScript(
            at: recorditBinary,
            body: """
            #!/bin/sh
            command="$1"
            shift
            out_root=""
            mode=""
            model=""
            while [ "$#" -gt 0 ]; do
              case "$1" in
                --output-root) out_root="$2"; shift 2 ;;
                --mode) mode="$2"; shift 2 ;;
                --model) model="$2"; shift 2 ;;
                *) shift ;;
              esac
            done
            [ -n "$out_root" ] && mkdir -p "$out_root"

            finalize() {
              session_id=$(basename "$out_root")
              cat > "$out_root/session.manifest.json" <<EOF
            {"session_id":"$session_id","runtime_mode":"live","artifacts":{"out_wav":"$out_root/session.wav","out_jsonl":"$out_root/session.jsonl","out_manifest":"$out_root/session.manifest.json"},"session_summary":{"session_status":"ok"},"trust":{"notice_count":0}}
            EOF
              printf 'live transcript line\n' > "$out_root/session.jsonl"
              : > "$out_root/session.wav"
              exit 0
            }

            case "$command" in
              run)
                printf '%s' "$mode" > "$out_root/runtime.mode"
                printf '%s' "$model" > "$out_root/runtime.model"
                : > "$out_root/runtime.started"
                trap 'finalize' INT TERM
                while :; do
                  if [ -f "$out_root/session.stop.request" ]; then
                    finalize
                  fi
                  sleep 0.05
                done
                ;;
              *)
                exit 64
                ;;
            esac
            """
        )
        try makeExecutableStubBinary(at: sequoiaBinary)

        let originalPath = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        try await withTemporaryEnvironment(
            [
                RuntimeBinaryResolver.recorditEnvKey: recorditBinary.path,
                RuntimeBinaryResolver.sequoiaCaptureEnvKey: sequoiaBinary.path,
                "RECORDIT_ASR_MODEL": modelPath.path,
                "PATH": "\(binDirectory.path):\(originalPath)",
            ]
        ) {
            let controller = MainSessionController(environment: AppEnvironment.production())

            controller.startSession()
            try await waitForRuntimeRunning(controller: controller)

            let sessionRoot = try XCTUnwrap(controller.activeOutputRoot)
            await waitForFile(at: sessionRoot.appendingPathComponent("runtime.started"))
            XCTAssertEqual(try readTrimmedTextFile(at: sessionRoot.appendingPathComponent("runtime.mode")), "live")
            XCTAssertEqual(try readTrimmedTextFile(at: sessionRoot.appendingPathComponent("runtime.model")), modelPath.path)
            XCTAssertNil(controller.lastServiceError)

            controller.stopSession()
            try await waitForStopSummary(controller: controller)

            XCTAssertEqual(controller.runtimeState, .completed)
            XCTAssertEqual(controller.latestFinalizationSummary?.sessionID, sessionRoot.lastPathComponent)
            XCTAssertEqual(controller.latestFinalizationSummary?.status, "ok")
            XCTAssertTrue(FileManager.default.fileExists(atPath: sessionRoot.appendingPathComponent("session.manifest.json").path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: sessionRoot.appendingPathComponent("session.jsonl").path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: sessionRoot.appendingPathComponent("session.wav").path))
            XCTAssertTrue(
                controller.statusLog.contains(where: {
                    $0.text.localizedCaseInsensitiveContains("runtime running")
                })
            )
            XCTAssertTrue(
                controller.statusLog.contains(where: {
                    $0.text.localizedCaseInsensitiveContains("completed successfully")
                })
            )
        }
    }

    @MainActor
    func testProductionEnvironmentRecordOnlyControllerWritesPendingSidecarWithoutMockServices() async throws {
        let tempRoot = try makeTemporaryDirectory(prefix: "recordit-production-record-only")
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let binDirectory = tempRoot.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: binDirectory, withIntermediateDirectories: true)

        let recorditBinary = binDirectory.appendingPathComponent("recordit")
        let sequoiaBinary = binDirectory.appendingPathComponent("sequoia_capture")
        try makeExecutableStubBinary(at: recorditBinary)
        try makeExecutableShellScript(
            at: sequoiaBinary,
            body: """
            #!/bin/sh
            wav_path="$2"
            out_root=$(dirname "$wav_path")
            mkdir -p "$out_root"
            : > "$wav_path"
            : > "$out_root/record-only.started"
            trap 'exit 0' INT TERM
            while :; do
              if [ -f "$out_root/session.stop.request" ]; then
                exit 0
              fi
              sleep 0.05
            done
            """
        )

        let originalPath = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        try await withTemporaryEnvironment(
            [
                RuntimeBinaryResolver.recorditEnvKey: recorditBinary.path,
                RuntimeBinaryResolver.sequoiaCaptureEnvKey: sequoiaBinary.path,
                "PATH": "\(binDirectory.path):\(originalPath)",
            ]
        ) {
            let environment = AppEnvironment.production()
            let controller = MainSessionController(environment: environment)
            controller.selectedMode = .recordOnly

            controller.startSession()
            try await waitForRecordOnlyRunning(controller: controller)

            let sessionRoot = try XCTUnwrap(controller.activeOutputRoot)
            await waitForFile(at: sessionRoot.appendingPathComponent("record-only.started"))
            let pendingURL = sessionRoot.appendingPathComponent("session.pending.json")
            await waitForFile(at: pendingURL)

            let sidecar = try FileSystemPendingSessionSidecarService().loadPendingSidecar(at: pendingURL)
            XCTAssertEqual(sidecar.sessionID, sessionRoot.lastPathComponent)
            XCTAssertEqual(sidecar.mode, .recordOnly)
            XCTAssertEqual(sidecar.transcriptionState, .pendingModel)
            XCTAssertEqual(sidecar.wavPath, sessionRoot.appendingPathComponent("session.wav").path)
            XCTAssertNil(controller.lastServiceError)

            controller.stopSession()
            try await waitForStopSummary(controller: controller)

            XCTAssertEqual(controller.runtimeState, .completed)
            XCTAssertEqual(controller.latestFinalizationSummary?.sessionID, sessionRoot.lastPathComponent)
            XCTAssertEqual(controller.latestFinalizationSummary?.status, "ok")
            XCTAssertTrue(
                controller.statusLog.contains(where: {
                    $0.text.localizedCaseInsensitiveContains("record-only session started")
                })
            )
            XCTAssertTrue(
                controller.statusLog.contains(where: {
                    $0.text.localizedCaseInsensitiveContains("record-only session stopped and finalized")
                })
            )
        }
    }


    @MainActor
    func testProductionBootstrapEmitsStructuredStartupSelfCheckRecordsWithoutMockServices() throws {
        let productionRoot = try makeTemporaryDirectory(prefix: "recordit-production-startup-self-check")
        defer { try? FileManager.default.removeItem(at: productionRoot) }

        func makeBundleResources(name: String, includeRuntime: Bool, includeModel: Bool) throws -> URL {
            let resources = productionRoot.appendingPathComponent(name, isDirectory: true)
            try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)

            if includeRuntime {
                let runtimeBin = resources.appendingPathComponent("runtime/bin", isDirectory: true)
                try FileManager.default.createDirectory(at: runtimeBin, withIntermediateDirectories: true)
                try makeExecutableStubBinary(at: runtimeBin.appendingPathComponent("recordit"))
                try makeExecutableStubBinary(at: runtimeBin.appendingPathComponent("sequoia_capture"))
            }

            if includeModel {
                let bundledModel = resources
                    .appendingPathComponent("runtime/models/whispercpp", isDirectory: true)
                    .appendingPathComponent("ggml-tiny.en.bin")
                try FileManager.default.createDirectory(
                    at: bundledModel.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try Data("bundled-model".utf8).write(to: bundledModel, options: .atomic)
            }

            return resources
        }

        func captureStartupLog(bundleResourceURL: URL) throws -> StartupSelfCheckLogRecord {
            var logs: [StartupSelfCheckLogRecord] = []
            _ = AppEnvironment.production(
                processEnvironment: ["PATH": "/usr/bin:/bin"],
                currentDirectoryURL: productionRoot,
                bundleResourceURL: bundleResourceURL,
                startupSelfCheckLogger: { logs.append($0) }
            )
            XCTAssertEqual(logs.count, 1)
            return try XCTUnwrap(logs.first)
        }

        let readyLog = try captureStartupLog(
            bundleResourceURL: try makeBundleResources(name: "ReadyResources", includeRuntime: true, includeModel: true)
        )
        XCTAssertEqual(readyLog.schemaVersion, "1")
        XCTAssertEqual(readyLog.eventType, "startup_self_check")
        XCTAssertEqual(readyLog.selectedBackend, "whispercpp")
        XCTAssertEqual(readyLog.selectedBackendSource, "v1_default")
        XCTAssertTrue(readyLog.runtimeReady)
        XCTAssertTrue(readyLog.liveTranscribeAvailable)
        XCTAssertTrue(readyLog.recordOnlyAvailable)
        XCTAssertEqual(readyLog.readinessImplication, .liveReady)
        XCTAssertEqual(readyLog.modelSelection.status, .ready)
        XCTAssertEqual(readyLog.modelSelection.source, "backend default")
        XCTAssertTrue(readyLog.preflightEnvironment.pathConfigured)
        XCTAssertTrue(readyLog.preflightEnvironment.recorditASRModelConfigured)
        XCTAssertTrue(
            readyLog.runtimeChecks.contains(where: {
                $0.binaryName == "recordit" && $0.status == "ready"
            })
        )
        XCTAssertTrue(
            readyLog.runtimeChecks.contains(where: {
                $0.binaryName == "sequoia_capture" && $0.status == "ready"
            })
        )

        let modelBlockedLog = try captureStartupLog(
            bundleResourceURL: try makeBundleResources(name: "RuntimeOnlyResources", includeRuntime: true, includeModel: false)
        )
        XCTAssertTrue(modelBlockedLog.runtimeReady)
        XCTAssertFalse(modelBlockedLog.liveTranscribeAvailable)
        XCTAssertTrue(modelBlockedLog.recordOnlyAvailable)
        XCTAssertEqual(modelBlockedLog.readinessImplication, .liveBlockedModel)
        XCTAssertEqual(modelBlockedLog.modelSelection.status, .unavailable)
        XCTAssertEqual(modelBlockedLog.modelSelection.errorCode, AppServiceErrorCode.modelUnavailable.rawValue)
        XCTAssertFalse(modelBlockedLog.preflightEnvironment.recorditASRModelConfigured)

        let runtimeBlockedLog = try captureStartupLog(
            bundleResourceURL: try makeBundleResources(name: "ModelOnlyResources", includeRuntime: false, includeModel: true)
        )
        XCTAssertFalse(runtimeBlockedLog.runtimeReady)
        XCTAssertFalse(runtimeBlockedLog.liveTranscribeAvailable)
        XCTAssertFalse(runtimeBlockedLog.recordOnlyAvailable)
        XCTAssertEqual(runtimeBlockedLog.readinessImplication, .liveBlockedRuntime)
        XCTAssertEqual(runtimeBlockedLog.modelSelection.status, .ready)
        XCTAssertTrue(runtimeBlockedLog.preflightEnvironment.pathConfigured)
        XCTAssertTrue(runtimeBlockedLog.preflightEnvironment.recorditASRModelConfigured)
        XCTAssertTrue(
            runtimeBlockedLog.runtimeChecks.contains(where: {
                $0.binaryName == "recordit" && $0.status == "missing"
            })
        )
    }

    @MainActor
    private func waitForRuntimeRunning(controller: MainSessionController) async throws {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if case .running = controller.runtimeState,
               controller.statusLog.contains(where: { $0.text.localizedCaseInsensitiveContains("runtime running") }) {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for app-level runtime start transcript event")
    }

    @MainActor
    private func waitForRecordOnlyRunning(controller: MainSessionController) async throws {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if case .running = controller.runtimeState,
               controller.statusLog.contains(where: { $0.text.localizedCaseInsensitiveContains("record-only session started") }) {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for record-only runtime start")
    }

    @MainActor
    private func waitForStopSummary(controller: MainSessionController) async throws {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if controller.runtimeState == .completed,
               controller.latestFinalizationSummary != nil {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for stop-to-summary transition")
    }

    private func elapsedMilliseconds(since start: Date) -> UInt64 {
        let elapsed = max(0, Date().timeIntervalSince(start) * 1_000)
        return UInt64(elapsed.rounded())
    }

    private func makeTemporaryDirectory(prefix: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func makeExecutableShellScript(at url: URL, body: String) throws {
        try body.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o755)], ofItemAtPath: url.path)
    }

    private func readTrimmedTextFile(at url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func withTemporaryEnvironment<T>(
        _ overrides: [String: String],
        perform operation: () async throws -> T
    ) async throws -> T {
        let originalValues = Dictionary(uniqueKeysWithValues: overrides.keys.map { key in
            (key, ProcessInfo.processInfo.environment[key])
        })

        for (key, value) in overrides {
            setenv(key, value, 1)
        }
        defer {
            for (key, originalValue) in originalValues {
                if let originalValue {
                    setenv(key, originalValue, 1)
                } else {
                    unsetenv(key)
                }
            }
        }

        return try await operation()
    }

    @MainActor
    private func waitForFile(at url: URL, timeoutSeconds: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if FileManager.default.fileExists(atPath: url.path) {
                return
            }
            try? await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTFail("Timed out waiting for file at \(url.path)")
    }

    private func makeExecutableStubBinary(at url: URL) throws {
        try Data("#!/usr/bin/env bash\nexit 0\n".utf8).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o755)], ofItemAtPath: url.path)
    }

    @MainActor
    private func buildReadinessScenarioSnapshot(
        scenarioID: String,
        checks: [[String: Any]],
        overallStatus: String? = nil
    ) throws -> ReadinessScenarioSnapshot {
        let payload = preflightPayloadData(
            checks: checks,
            overallStatus: resolvedOverallStatus(for: checks, explicit: overallStatus)
        )

        let preflight = makePreflightViewModel(payload: payload)
        preflight.runLivePreflight()
        guard case let .completed(envelope) = preflight.state else {
            throw NSError(
                domain: "RecorditAppTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Preflight scenario \(scenarioID) did not complete"]
            )
        }
        guard let evaluation = preflight.gatingEvaluation else {
            throw NSError(
                domain: "RecorditAppTests",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Preflight scenario \(scenarioID) missing gating evaluation"]
            )
        }

        let root = RootCompositionController(
            environment: AppEnvironment.preview().replacing(
                preflightRunner: makePreflightRunner(payload: payload)
            ),
            firstRun: true
        )
        root.runPreflight()

        let failingCheckIDs = envelope.checks
            .filter { $0.status == .fail }
            .map(\.id)
            .sorted()
        let preflightCheckIDs = envelope.checks.map(\.id).sorted()
        let mappedCheckIDs = evaluation.mappedChecks.map { $0.check.id }.sorted()

        return ReadinessScenarioSnapshot(
            scenarioID: scenarioID,
            preflightKind: envelope.kind,
            preflightOverallStatus: envelope.overallStatus.rawValue,
            preflightCheckIDs: preflightCheckIDs,
            mappedCheckIDs: mappedCheckIDs,
            failingCheckIDs: failingCheckIDs,
            mappedBlockingDomain: preflight.primaryBlockingDomain?.rawValue ?? "none",
            preflightCanProceedLive: preflight.canProceedToLiveTranscribe,
            preflightCanOfferRecordOnlyFallback: preflight.canOfferRecordOnlyFallback,
            rootPreflightCanProceed: root.snapshot.preflightCanProceed,
            rootPreflightCanOfferRecordOnlyFallback: root.snapshot.preflightCanOfferRecordOnlyFallback,
            rootPreflightRequiresWarningAck: root.snapshot.preflightRequiresWarningAck,
            rootPreflightSummary: root.snapshot.preflightSummary
        )
    }

    private func resolvedOverallStatus(for checks: [[String: Any]], explicit: String?) -> String {
        if let explicit {
            return explicit
        }
        if checks.contains(where: { (($0["status"] as? String) ?? "").uppercased() == "FAIL" }) {
            return "FAIL"
        }
        if checks.contains(where: { (($0["status"] as? String) ?? "").uppercased() == "WARN" }) {
            return "WARN"
        }
        return "PASS"
    }

    private func csvField(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "\"", with: "\"\"")
        return "\"\(escaped)\""
    }

    private func persistReadinessScenarioSnapshotsIfRequested(_ snapshots: [ReadinessScenarioSnapshot]) throws {
        guard
            let artifactPath = ProcessInfo.processInfo.environment[ReadinessScenarioArtifact.pathEnv],
            !artifactPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return
        }

        let url = URL(fileURLWithPath: artifactPath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)

        var lines = [String]()
        lines.append(
            "scenario_id,preflight_kind,preflight_overall_status,preflight_check_ids,mapped_check_ids,failing_check_ids,blocking_domain,preflight_can_proceed_live,preflight_record_only_fallback,root_preflight_can_proceed,root_preflight_record_only_fallback,root_preflight_requires_warning_ack,root_preflight_summary"
        )
        for snapshot in snapshots {
            lines.append([
                csvField(snapshot.scenarioID),
                csvField(snapshot.preflightKind),
                csvField(snapshot.preflightOverallStatus),
                csvField(snapshot.preflightCheckIDs.joined(separator: "|")),
                csvField(snapshot.mappedCheckIDs.joined(separator: "|")),
                csvField(snapshot.failingCheckIDs.joined(separator: "|")),
                csvField(snapshot.mappedBlockingDomain),
                snapshot.preflightCanProceedLive ? "true" : "false",
                snapshot.preflightCanOfferRecordOnlyFallback ? "true" : "false",
                snapshot.rootPreflightCanProceed ? "true" : "false",
                snapshot.rootPreflightCanOfferRecordOnlyFallback ? "true" : "false",
                snapshot.rootPreflightRequiresWarningAck ? "true" : "false",
                csvField(snapshot.rootPreflightSummary),
            ].joined(separator: ","))
        }

        try lines.joined(separator: "\n").appending("\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func persistResponsivenessGateSnapshotIfRequested(_ snapshot: ResponsivenessGateSnapshot) throws {
        guard
            let artifactPath = ProcessInfo.processInfo.environment[ResponsivenessGateArtifact.pathEnv],
            !artifactPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return
        }

        let url = URL(fileURLWithPath: artifactPath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)

        let lines = [
            "artifact_track,recordit_app_responsiveness",
            "first_stable_transcript_observed_ms,\(snapshot.firstStableTranscriptMilliseconds)",
            "first_stable_transcript_budget_ms,\(snapshot.firstStableTranscriptBudgetMilliseconds)",
            "stop_to_summary_observed_ms,\(snapshot.stopToSummaryMilliseconds)",
            "stop_to_summary_budget_ms,\(snapshot.stopToSummaryBudgetMilliseconds)",
            "threshold_first_stable_transcript_budget_ok,\(snapshot.firstStableTranscriptBudgetPass ? "true" : "false")",
            "threshold_stop_to_summary_budget_ok,\(snapshot.stopToSummaryBudgetPass ? "true" : "false")",
            "failed_metrics,\(snapshot.failedMetrics)",
            "gate_pass,\(snapshot.gatePass ? "true" : "false")",
        ]
        try lines.joined(separator: "\n").appending("\n").write(to: url, atomically: true, encoding: .utf8)
    }
}
