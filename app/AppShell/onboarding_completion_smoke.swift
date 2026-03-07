import Foundation

@MainActor
private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("onboarding_completion_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private final class InMemoryOnboardingCompletionStore: OnboardingCompletionStore {
    private var completed: Bool

    init(completed: Bool = false) {
        self.completed = completed
    }

    func isOnboardingComplete() -> Bool {
        completed
    }

    func markOnboardingComplete() {
        completed = true
    }

    func resetOnboardingCompletion() {
        completed = false
    }
}

private struct StubModelResolutionService: ModelResolutionService {
    let result: Result<ResolvedModelDTO, AppServiceError>

    func resolveModel(_ request: ModelResolutionRequest) throws -> ResolvedModelDTO {
        _ = request
        switch result {
        case let .success(value):
            return value
        case let .failure(error):
            throw error
        }
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

private func readyRuntimeReadinessChecker() -> StubRuntimeReadinessChecker {
    StubRuntimeReadinessChecker(
        report: RuntimeBinaryReadinessReport(
            checks: [
                RuntimeBinaryReadinessCheck(
                    binaryName: "recordit",
                    overrideEnvKey: RuntimeBinaryResolver.recorditEnvKey,
                    status: .ready,
                    resolvedPath: "/usr/local/bin/recordit",
                    userMessage: "recordit ready",
                    remediation: ""
                ),
                RuntimeBinaryReadinessCheck(
                    binaryName: "sequoia_capture",
                    overrideEnvKey: RuntimeBinaryResolver.sequoiaCaptureEnvKey,
                    status: .ready,
                    resolvedPath: "/usr/local/bin/sequoia_capture",
                    userMessage: "sequoia_capture ready",
                    remediation: ""
                ),
            ]
        ),
        blockingError: nil
    )
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

private func preflightModelBlockedPayload() -> Data {
    let payload: [String: Any] = [
        "schema_version": "1",
        "kind": "transcribe-live-preflight",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "FAIL",
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
            [
                "id": ReadinessContractID.modelPath.rawValue,
                "status": "FAIL",
                "detail": "model path missing",
                "remediation": "Provide a compatible model."
            ],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
        ],
    ]
    return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
}

private func preflightPermissionBlockedPayload() -> Data {
    let payload: [String: Any] = [
        "schema_version": "1",
        "kind": "transcribe-live-preflight",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "FAIL",
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
            [
                "id": ReadinessContractID.screenCaptureAccess.rawValue,
                "status": "FAIL",
                "detail": "screen access denied",
                "remediation": "Grant Screen Recording in System Settings."
            ],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
        ],
    ]
    return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
}

private func preflightWarnRequiresAcknowledgementPayload() -> Data {
    let payload: [String: Any] = [
        "schema_version": "1",
        "kind": "transcribe-live-preflight",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "WARN",
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
            ["id": ReadinessContractID.outWav.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.outJsonl.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.outManifest.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            [
                "id": ReadinessContractID.sampleRate.rawValue,
                "status": "WARN",
                "detail": "non-default sample rate",
                "remediation": "Acknowledge this warning to continue."
            ],
        ],
    ]
    return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
}

private func preflightPermissionWinsOverModelPayload() -> Data {
    let payload: [String: Any] = [
        "schema_version": "1",
        "kind": "transcribe-live-preflight",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "FAIL",
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
            [
                "id": ReadinessContractID.modelPath.rawValue,
                "status": "FAIL",
                "detail": "model path missing",
                "remediation": "Provide a compatible model."
            ],
            [
                "id": ReadinessContractID.screenCaptureAccess.rawValue,
                "status": "FAIL",
                "detail": "screen access denied",
                "remediation": "Grant Screen Recording in System Settings."
            ],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
        ],
    ]
    return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
}

private func preflightRuntimeBlockedPayload() -> Data {

    let payload: [String: Any] = [
        "schema_version": "1",
        "kind": "transcribe-live-preflight",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "FAIL",
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
            ["id": ReadinessContractID.outWav.rawValue, "status": "FAIL", "detail": "output path not writable", "remediation": "Choose writable output path."],
            ["id": ReadinessContractID.screenCaptureAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
            ["id": ReadinessContractID.microphoneAccess.rawValue, "status": "PASS", "detail": "ok", "remediation": ""],
        ],
    ]
    return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
}

@MainActor
private func runSmoke() {
    let store = InMemoryOnboardingCompletionStore()

    let appShell = AppShellViewModel(
        firstRun: nil,
        onboardingCompletionStore: store,
        runtimeReadinessChecker: readyRuntimeReadinessChecker()
    )
    check(appShell.activeRoot == .onboarding, "fresh launch should route to onboarding")
    check(!appShell.isOnboardingComplete, "fresh launch should not be completed")

    let validModel = ModelSetupViewModel(
        modelResolutionService: StubModelResolutionService(
            result: .success(
                ResolvedModelDTO(
                    resolvedPath: URL(fileURLWithPath: "/tmp/model.bin"),
                    source: "fixture",
                    checksumSHA256: nil,
                    checksumStatus: "available"
                )
            )
        )
    )
    validModel.chooseBackend("whispercpp")

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
        appShell.completeOnboardingIfReady(modelSetup: validModel, preflight: preflight),
        "completion should succeed when model and preflight are ready"
    )
    check(appShell.activeRoot == .mainRuntime, "successful completion should route to main runtime")
    check(appShell.isOnboardingComplete, "completion should persist onboarding state")

    let relaunch = AppShellViewModel(
        firstRun: nil,
        onboardingCompletionStore: store,
        runtimeReadinessChecker: readyRuntimeReadinessChecker()
    )
    check(relaunch.activeRoot == .mainRuntime, "relaunch should restore completion and skip onboarding")

    relaunch.resetOnboardingCompletion()
    check(relaunch.activeRoot == .onboarding, "reset should route back to onboarding")
    check(!relaunch.isOnboardingComplete, "reset should clear persisted completion")

    let invalidModel = ModelSetupViewModel(
        modelResolutionService: StubModelResolutionService(
            result: .failure(
                AppServiceError(
                    code: .modelUnavailable,
                    userMessage: "model invalid",
                    remediation: "fix path"
                )
            )
        )
    )
    invalidModel.chooseBackend("whispercpp")
    check(
        !relaunch.completeOnboardingIfReady(modelSetup: invalidModel, preflight: preflight),
        "completion should fail when model setup is invalid"
    )
    check(relaunch.onboardingGateFailure?.code == .modelUnavailable, "model failure should map to modelUnavailable")

    let preflightNotRun = PreflightViewModel(
        runner: RecorditPreflightRunner(
            executable: "/usr/bin/env",
            commandRunner: StubCommandRunner(payload: preflightPassPayload()),
            parser: PreflightEnvelopeParser(),
            environment: [:]
        ),
        gatingPolicy: PreflightGatingPolicy()
    )
    check(
        !relaunch.completeOnboardingIfReady(modelSetup: validModel, preflight: preflightNotRun),
        "completion should fail when preflight has not produced a passable evaluation"
    )
    check(relaunch.onboardingGateFailure?.code == .preflightFailed, "preflight failure should map to preflightFailed")

    let warningOnlyPreflight = PreflightViewModel(
        runner: RecorditPreflightRunner(
            executable: "/usr/bin/env",
            commandRunner: StubCommandRunner(payload: preflightWarnRequiresAcknowledgementPayload()),
            parser: PreflightEnvelopeParser(),
            environment: [:]
        ),
        gatingPolicy: PreflightGatingPolicy()
    )
    warningOnlyPreflight.runLivePreflight()
    check(
        warningOnlyPreflight.requiresWarningAcknowledgement,
        "warning-only preflight should require explicit warning acknowledgement before completion"
    )
    check(
        !relaunch.completeOnboardingIfReady(modelSetup: validModel, preflight: warningOnlyPreflight),
        "completion should fail until warning-only preflight results are acknowledged"
    )
    check(
        relaunch.onboardingGateFailure?.code == .preflightFailed,
        "warning-only preflight without acknowledgement should map to preflightFailed"
    )
    check(
        relaunch.onboardingGateFailure?.userMessage == "Live Transcribe warnings must be acknowledged before finishing setup.",
        "warning-only preflight should surface the dedicated warning acknowledgement message"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Acknowledge Warnings") == true,
        "warning-only preflight should route users to the acknowledgement action"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Run preflight checks") == false,
        "warning-only preflight should not tell users to rerun preflight when warnings are the only remaining gate"
    )

    let backendBlockedPreflight = PreflightViewModel(
        runner: RecorditPreflightRunner(
            executable: "/usr/bin/env",
            commandRunner: StubCommandRunner(payload: preflightModelBlockedPayload()),
            parser: PreflightEnvelopeParser(),
            environment: [:]
        ),
        gatingPolicy: PreflightGatingPolicy()
    )
    backendBlockedPreflight.runLivePreflight()
    check(
        !relaunch.completeOnboardingIfReady(modelSetup: validModel, preflight: backendBlockedPreflight),
        "completion should fail when backend/model readiness blocks live preflight"
    )
    check(
        relaunch.onboardingGateFailure?.code == .modelUnavailable,
        "backend/model readiness blockers should map to modelUnavailable"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Provide a compatible model.") == true,
        "backend/model readiness blockers should preserve check-specific remediation detail"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Validate Model Setup") == true,
        "backend/model readiness blockers should route users to model validation action copy"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Record Only remains available") == true,
        "backend/model readiness blockers should surface Record Only fallback guidance"
    )

    let permissionBlockedPreflight = PreflightViewModel(
        runner: RecorditPreflightRunner(
            executable: "/usr/bin/env",
            commandRunner: StubCommandRunner(payload: preflightPermissionBlockedPayload()),
            parser: PreflightEnvelopeParser(),
            environment: [:]
        ),
        gatingPolicy: PreflightGatingPolicy()
    )
    permissionBlockedPreflight.runLivePreflight()
    check(
        !relaunch.completeOnboardingIfReady(modelSetup: validModel, preflight: permissionBlockedPreflight),
        "completion should fail when capture permission readiness blocks live preflight"
    )
    check(
        relaunch.onboardingGateFailure?.code == .permissionDenied,
        "screen permission blocker should map to permissionDenied"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Open Screen Recording Settings") == true,
        "screen permission blocker should route users to screen settings action copy"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Grant Screen Recording in System Settings.") == true,
        "screen permission blocker should preserve check-specific remediation detail"
    )

    let mixedOrderBlockedPreflight = PreflightViewModel(
        runner: RecorditPreflightRunner(
            executable: "/usr/bin/env",
            commandRunner: StubCommandRunner(payload: preflightPermissionWinsOverModelPayload()),
            parser: PreflightEnvelopeParser(),
            environment: [:]
        ),
        gatingPolicy: PreflightGatingPolicy()
    )
    mixedOrderBlockedPreflight.runLivePreflight()
    check(
        mixedOrderBlockedPreflight.primaryBlockingDomain == .tccCapture,
        "capture blockers should remain the primary blocking domain even when model blockers appear first in the payload"
    )
    check(
        !relaunch.completeOnboardingIfReady(modelSetup: validModel, preflight: mixedOrderBlockedPreflight),
        "completion should fail when a capture blocker is present even if model blockers appear earlier in the payload"
    )
    check(
        relaunch.onboardingGateFailure?.code == .permissionDenied,
        "mixed-order blockers should still map to permissionDenied when capture blockers outrank model blockers"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Open Screen Recording Settings") == true,
        "mixed-order blockers should preserve the screen-permission action copy"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Validate Model Setup") == false,
        "mixed-order blockers should not leak backend-model remediation when capture blockers win"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Record Only remains available") == false,
        "mixed-order blockers should not advertise Record Only fallback when capture blockers are present"
    )
    let runtimeBlockedPreflight = PreflightViewModel(
        runner: RecorditPreflightRunner(
            executable: "/usr/bin/env",
            commandRunner: StubCommandRunner(payload: preflightRuntimeBlockedPayload()),
            parser: PreflightEnvelopeParser(),
            environment: [:]
        ),
        gatingPolicy: PreflightGatingPolicy()
    )
    runtimeBlockedPreflight.runLivePreflight()
    check(
        !relaunch.completeOnboardingIfReady(modelSetup: validModel, preflight: runtimeBlockedPreflight),
        "completion should fail when runtime preflight readiness blocks live preflight"
    )
    check(
        relaunch.onboardingGateFailure?.code == .preflightFailed,
        "runtime preflight blockers should map to preflightFailed"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Choose writable output path.") == true,
        "runtime preflight blockers should preserve check-specific remediation detail"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Click Run Preflight again.") == true,
        "runtime preflight blockers should route users to rerun preflight action copy"
    )
    check(
        relaunch.onboardingGateFailure?.remediation.contains("Record Only remains available") == false,
        "runtime preflight blockers should not advertise Record Only fallback"
    )

    let blockedReport = RuntimeBinaryReadinessReport(
        checks: [
            RuntimeBinaryReadinessCheck(
                binaryName: "recordit",
                overrideEnvKey: RuntimeBinaryResolver.recorditEnvKey,
                status: .missing,
                resolvedPath: nil,
                userMessage: "recordit missing",
                remediation: "install recordit",
                debugDetail: "bundled_resolution_failed expected_paths=/tmp/app/runtime/bin/recordit"
            ),
            RuntimeBinaryReadinessCheck(
                binaryName: "sequoia_capture",
                overrideEnvKey: RuntimeBinaryResolver.sequoiaCaptureEnvKey,
                status: .ready,
                resolvedPath: "/usr/local/bin/sequoia_capture",
                userMessage: "sequoia_capture ready",
                remediation: ""
            ),
        ]
    )
    let blockedShell = AppShellViewModel(
        firstRun: false,
        onboardingCompletionStore: store,
        runtimeReadinessChecker: StubRuntimeReadinessChecker(
            report: blockedReport,
            blockingError: AppServiceError(
                code: .runtimeUnavailable,
                userMessage: "Runtime binary missing.",
                remediation: "Reinstall Recordit.app."
            )
        )
    )
    check(blockedShell.activeRoot == .recovery, "returning users should route to recovery when startup runtime readiness fails")
    check(blockedShell.startupRuntimeReadinessFailure?.code == .runtimeUnavailable, "blocked startup should preserve runtimeUnavailable code")
    check(blockedShell.startupRuntimeSelfCheckRecord?.readinessImplication == .liveBlockedRuntime, "blocked startup should expose a typed live_blocked_runtime self-check record")
    check(blockedShell.startupRuntimeSelfCheckRecord?.runtimeChecks.contains(where: { $0.binaryName == "recordit" && $0.status == "missing" }) == true, "blocked startup self-check record should name the missing runtime binary")
    check(blockedShell.startupRuntimeSelfCheckRecord?.recordOnlyAvailable == true, "blocked startup self-check record should preserve Record Only availability")
    check(blockedShell.startupRuntimeSelfCheckRecord?.debugDetailJSONString() == blockedShell.startupRuntimeReadinessFailure?.debugDetail, "blocked startup typed self-check record should match the exported debug detail JSON")
    check(blockedShell.startupRuntimeReadinessFailure?.debugDetail?.contains("\"event_type\":\"startup_self_check\"") == true, "blocked startup should expose structured startup self-check JSON in debug detail")
    check(blockedShell.startupRuntimeReadinessFailure?.debugDetail?.contains("\"readiness_implication\":\"live_blocked_runtime\"") == true, "blocked startup debug detail should classify live_blocked_runtime")
    check(blockedShell.startupRuntimeReadinessFailure?.debugDetail?.contains("\"binary_name\":\"recordit\"") == true, "blocked startup debug detail should name the missing runtime binary")
    check(blockedShell.startupRuntimeReadinessFailure?.debugDetail?.contains("\"record_only_available\":true") == true, "blocked startup debug detail should preserve Record Only availability")
}

@main
struct OnboardingCompletionSmokeMain {
    @MainActor
    static func main() {
        runSmoke()
        print("onboarding_completion_smoke: PASS")
    }
}
