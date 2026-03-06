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

    @MainActor
    private func makePreflightViewModel(payload: Data) -> PreflightViewModel {
        PreflightViewModel(
            runner: RecorditPreflightRunner(
                executable: "/usr/bin/env",
                commandRunner: StaticPreflightCommandRunner(payload: payload),
                parser: PreflightEnvelopeParser(),
                environment: [:]
            ),
            gatingPolicy: PreflightGatingPolicy()
        )
    }

    @MainActor
    private func makePermissionRemediationItems(
        checks: [[String: Any]],
        overallStatus: String = "FAIL",
        nativePermissionStatus: @escaping (RemediablePermission) -> Bool
    ) throws -> [PermissionRemediationItem] {
        let envelope = try PreflightEnvelopeParser().parse(
            data: preflightPayloadData(checks: checks, overallStatus: overallStatus)
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
            controller.transcriptEntries.contains(where: {
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
    func testPermissionRemediationSeparatesDisplayAvailabilityFromScreenPermission() throws {
        let items = try makePermissionRemediationItems(
            checks: [
                ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "screen access granted", "remediation": ""],
                ["id": ReadinessContractID.displayAvailability.rawValue, "status": "FAIL", "detail": "no active display available", "remediation": "Wake a display and retry."],
                ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "mic ready", "remediation": ""],
            ],
            nativePermissionStatus: { _ in true }
        )

        let screen = try XCTUnwrap(items.first(where: { $0.surface == .screenRecording }))
        let display = try XCTUnwrap(items.first(where: { $0.surface == .activeDisplay }))
        XCTAssertEqual(screen.status, .granted)
        XCTAssertEqual(display.status, .noActiveDisplay)
        XCTAssertEqual(display.detail, "no active display available")
        XCTAssertEqual(display.remediation, "Wake a display and retry.")
        XCTAssertNil(display.surface.settingsPermission)
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
    private func waitForRuntimeRunning(controller: MainSessionController) async throws {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if case .running = controller.runtimeState,
               controller.transcriptEntries.contains(where: { $0.text.localizedCaseInsensitiveContains("runtime running") }) {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for app-level runtime start transcript event")
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

    private func makeExecutableStubBinary(at url: URL) throws {
        try Data("#!/usr/bin/env bash\nexit 0\n".utf8).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o755)], ofItemAtPath: url.path)
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
