import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

@MainActor
private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("runtime_binary_readiness_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private struct StubModelResolutionService: ModelResolutionService {
    func resolveModel(_ request: ModelResolutionRequest) throws -> ResolvedModelDTO {
        _ = request
        return ResolvedModelDTO(
            resolvedPath: URL(fileURLWithPath: "/tmp/model.bin"),
            source: "smoke",
            checksumSHA256: nil,
            checksumStatus: "available"
        )
    }
}

private struct StubCommandRunner: CommandRunning {
    let payload: Data

    func run(
        executable _: String,
        arguments _: [String],
        environment _: [String: String]
    ) throws -> CommandExecutionResult {
        CommandExecutionResult(exitCode: 0, stdout: payload, stderr: Data())
    }
}

private final class InMemoryOnboardingCompletionStore: OnboardingCompletionStore {
    func isOnboardingComplete() -> Bool { false }
    func markOnboardingComplete() {}
    func resetOnboardingCompletion() {}
}

private struct StubRuntimeReadinessChecker: RuntimeBinaryReadinessChecking {
    let report: RuntimeBinaryReadinessReport
    let blockingError: AppServiceError?

    func evaluateStartupReadiness() -> RuntimeBinaryReadinessReport {
        report
    }

    func startupBlockingError(from _: RuntimeBinaryReadinessReport) -> AppServiceError? {
        blockingError
    }
}

private func preflightPassPayload() -> Data {
    let payload: [String: Any] = [
        "schema_version": "1",
        "kind": "transcribe-live-preflight",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "PASS",
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
        "checks": [
            ["id": ReadinessContractID.modelPath.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
        ],
    ]
    return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
}

private func makeExecutable(at path: String) {
    FileManager.default.createFile(atPath: path, contents: Data("#!/bin/sh\nexit 0\n".utf8))
    _ = chmod(path, 0o755)
}

@MainActor
private func runSmoke() {
    let tempRoot = FileManager.default.temporaryDirectory
        .appendingPathComponent("recordit-runtime-readiness-smoke-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempRoot) }

    let binDir = tempRoot
        .appendingPathComponent("runtime", isDirectory: true)
        .appendingPathComponent("bin", isDirectory: true)
    try? FileManager.default.createDirectory(at: binDir, withIntermediateDirectories: true)
    let recorditPath = binDir.appendingPathComponent("recordit").path
    let sequoiaPath = binDir.appendingPathComponent("sequoia_capture").path
    makeExecutable(at: recorditPath)
    makeExecutable(at: sequoiaPath)

    let readyResolver = RuntimeBinaryResolver(
        environment: ["PATH": "/usr/bin:/bin"],
        bundleResourceURL: tempRoot
    )
    let readyService = RuntimeBinaryReadinessService(resolver: readyResolver)
    let readyReport = readyService.evaluateStartupReadiness()
    check(readyReport.isReady, "bundled runtime binaries should pass startup readiness")
    check(readyReport.resolvedBinarySet?.recordit.path == recorditPath, "recordit binary path should resolve")
    check(readyService.startupBlockingError(from: readyReport) == nil, "ready report should not return a blocking error")

    let invalidOverrideService = RuntimeBinaryReadinessService(
        resolver: RuntimeBinaryResolver(
            environment: [RuntimeBinaryResolver.recorditEnvKey: "relative/recordit"],
            bundleResourceURL: tempRoot
        )
    )
    let invalidOverrideReport = invalidOverrideService.evaluateStartupReadiness()
    check(!invalidOverrideReport.isReady, "relative override should block readiness")
    check(invalidOverrideReport.firstBlockingCheck?.status == .invalidOverride, "relative override should map to invalidOverride")

    let nonExecutablePath = tempRoot.appendingPathComponent("recordit-nonexec").path
    FileManager.default.createFile(atPath: nonExecutablePath, contents: Data("echo nope\n".utf8))
    _ = chmod(nonExecutablePath, 0o644)
    let nonExecutableService = RuntimeBinaryReadinessService(
        resolver: RuntimeBinaryResolver(
            environment: [RuntimeBinaryResolver.recorditEnvKey: nonExecutablePath],
            bundleResourceURL: tempRoot
        )
    )
    let nonExecutableReport = nonExecutableService.evaluateStartupReadiness()
    check(!nonExecutableReport.isReady, "non-executable override should block readiness")
    check(nonExecutableReport.firstBlockingCheck?.status == .notExecutable, "non-executable override should map to notExecutable")

    let failingChecker = StubRuntimeReadinessChecker(
        report: nonExecutableReport,
        blockingError: nonExecutableService.startupBlockingError(from: nonExecutableReport)
    )
    let appShell = AppShellViewModel(
        firstRun: false,
        onboardingCompletionStore: InMemoryOnboardingCompletionStore(),
        runtimeReadinessChecker: failingChecker
    )
    check(appShell.activeRoot == .recovery, "startup readiness failure should route returning users to recovery")

    let modelSetup = ModelSetupViewModel(modelResolutionService: StubModelResolutionService())
    modelSetup.chooseBackend("whispercpp")
    let preflight = PreflightViewModel(
        runner: RecorditPreflightRunner(
            executable: "/usr/bin/env",
            commandRunner: StubCommandRunner(payload: preflightPassPayload()),
            parser: PreflightEnvelopeParser(),
            environment: [:]
        ),
        gatingPolicy: PreflightGatingPolicy()
    )
    preflight.runLivePreflight()
    check(
        !appShell.completeOnboardingIfReady(modelSetup: modelSetup, preflight: preflight),
        "onboarding completion should block when startup readiness fails"
    )
    check(appShell.onboardingGateFailure?.code == .runtimeUnavailable, "readiness gate should return runtimeUnavailable")
}

@main
struct RuntimeBinaryReadinessSmokeMain {
    @MainActor
    static func main() {
        runSmoke()
        print("runtime_binary_readiness_smoke: PASS")
    }
}
