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
