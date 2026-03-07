import Foundation
import SwiftUI

@main
struct RecorditApp: App {
    private let launchConfiguration = LaunchConfiguration.current()

    var body: some Scene {
        WindowGroup("Recordit") {
            MainWindowView(
                environment: launchConfiguration.environment,
                firstRun: launchConfiguration.firstRun
            )
        }
        .windowResizability(.contentSize)
    }
}

private struct LaunchConfiguration {
    private enum UITestPreflightScenario: String {
        case permissionRecovery = "permission_recovery"
        case permissionCheckFailure = "permission_check_failure"
        case activeDisplayUnavailable = "active_display_unavailable"
        case microphoneRuntimeFailure = "microphone_runtime_failure"
        case screenRuntimeFailure = "screen_runtime_failure"
        case modelPathBlocked = "model_path_blocked"
        case backendRuntimeBlocked = "backend_runtime_blocked"
        case backendRuntimeWarning = "backend_runtime_warning"
    }
    private enum UITestRuntimeScenario: String {
        case stopFailure = "stop_failure"
        case stopFailureThenRecover = "stop_failure_then_recover"
    }

    let environment: AppEnvironment
    let firstRun: Bool?

    static func current(processInfo: ProcessInfo = .processInfo) -> LaunchConfiguration {
        let environmentVariables = processInfo.environment
        let useUITestEnvironment = environmentVariables["RECORDIT_UI_TEST_MODE"] == "1"
            || processInfo.arguments.contains("--ui-test-mode")

        if useUITestEnvironment {
            let preflightScenario = UITestPreflightScenario(
                rawValue: environmentVariables["RECORDIT_UI_TEST_PREFLIGHT_SCENARIO"] ?? ""
            )
            let runtimeScenario = UITestRuntimeScenario(
                rawValue: environmentVariables["RECORDIT_UI_TEST_RUNTIME_SCENARIO"] ?? ""
            )
            return LaunchConfiguration(
                environment: makeUITestEnvironment(
                    preflightScenario: preflightScenario,
                    runtimeScenario: runtimeScenario
                ),
                firstRun: parseBool(environmentVariables["RECORDIT_FORCE_FIRST_RUN"]) ?? true
            )
        }

        return LaunchConfiguration(
            environment: .production(),
            firstRun: parseBool(environmentVariables["RECORDIT_FORCE_FIRST_RUN"])
        )
    }

    private static func parseBool(_ rawValue: String?) -> Bool? {
        guard let normalized = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !normalized.isEmpty else {
            return nil
        }

        switch normalized {
        case "1", "true", "yes":
            return true
        case "0", "false", "no":
            return false
        default:
            return nil
        }
    }

    private static func makeUITestEnvironment(
        preflightScenario: UITestPreflightScenario?,
        runtimeScenario: UITestRuntimeScenario?
    ) -> AppEnvironment {
        var environment = AppEnvironment.preview()

        if let preflightScenario {
            switch preflightScenario {
            case .permissionRecovery:
                let runner = RecorditPreflightRunner(
                    executable: "/usr/bin/env",
                    commandRunner: ScriptedPreflightCommandRunner(
                        payloads: [
                            permissionDeniedPayloadData(),
                            permissionGrantedPayloadData(),
                        ]
                    ),
                    parser: PreflightEnvelopeParser(),
                    environment: [:]
                )
                environment = environment.replacing(preflightRunner: runner)
            case .permissionCheckFailure:
                let runner = RecorditPreflightRunner(
                    executable: "/usr/bin/env",
                    commandRunner: ScriptedFailingPreflightCommandRunner(),
                    parser: PreflightEnvelopeParser(),
                    environment: [:]
                )
                environment = environment.replacing(preflightRunner: runner)
            case .activeDisplayUnavailable:
                let runner = RecorditPreflightRunner(
                    executable: "/usr/bin/env",
                    commandRunner: ScriptedPreflightCommandRunner(
                        payloads: [activeDisplayUnavailablePayloadData()]
                    ),
                    parser: PreflightEnvelopeParser(),
                    environment: [:]
                )
                environment = environment.replacing(preflightRunner: runner)
            case .microphoneRuntimeFailure:
                let runner = RecorditPreflightRunner(
                    executable: "/usr/bin/env",
                    commandRunner: ScriptedPreflightCommandRunner(
                        payloads: [microphoneRuntimeFailurePayloadData()]
                    ),
                    parser: PreflightEnvelopeParser(),
                    environment: [:]
                )
                environment = environment.replacing(preflightRunner: runner)
            case .screenRuntimeFailure:
                let runner = RecorditPreflightRunner(
                    executable: "/usr/bin/env",
                    commandRunner: ScriptedPreflightCommandRunner(
                        payloads: [screenRuntimeFailurePayloadData()]
                    ),
                    parser: PreflightEnvelopeParser(),
                    environment: [:]
                )
                environment = environment.replacing(preflightRunner: runner)
            case .modelPathBlocked:
                let runner = RecorditPreflightRunner(
                    executable: "/usr/bin/env",
                    commandRunner: ScriptedPreflightCommandRunner(
                        payloads: [modelPathBlockedPayloadData()]
                    ),
                    parser: PreflightEnvelopeParser(),
                    environment: [:]
                )
                environment = environment.replacing(preflightRunner: runner)
            case .backendRuntimeBlocked:
                let runner = RecorditPreflightRunner(
                    executable: "/usr/bin/env",
                    commandRunner: ScriptedPreflightCommandRunner(
                        payloads: [backendRuntimeBlockedPayloadData()]
                    ),
                    parser: PreflightEnvelopeParser(),
                    environment: [:]
                )
                environment = environment.replacing(preflightRunner: runner)
            case .backendRuntimeWarning:
                let runner = RecorditPreflightRunner(
                    executable: "/usr/bin/env",
                    commandRunner: ScriptedPreflightCommandRunner(
                        payloads: [backendRuntimeWarningPayloadData()]
                    ),
                    parser: PreflightEnvelopeParser(),
                    environment: [:]
                )
                environment = environment.replacing(preflightRunner: runner)
            }
        }

        if let runtimeScenario {
            switch runtimeScenario {
            case .stopFailure:
                environment = environment.replacing(
                    runtimeService: ScriptedUITestRuntimeService(stopBehavior: .alwaysFail)
                )
            case .stopFailureThenRecover:
                environment = environment.replacing(
                    runtimeService: ScriptedUITestRuntimeService(stopBehavior: .failThenRecover)
                )
            }
        }

        return environment
    }

    private static func permissionDeniedPayloadData() -> Data {
        preflightPayloadData(
            overallStatus: "FAIL",
            screenStatus: "FAIL",
            screenDetail: "Screen Recording permission denied.",
            screenRemediation: "Open System Settings and grant Screen Recording access, then Re-check.",
            displayStatus: "FAIL",
            displayDetail: "Display diagnostics unavailable until Screen Recording access is granted.",
            displayRemediation: "Grant Screen Recording access, then Re-check to confirm an active display is available.",
            microphoneStatus: "FAIL",
            microphoneDetail: "Microphone permission denied.",
            microphoneRemediation: "Open System Settings and grant Microphone access, then Re-check."
        )
    }

    private static func permissionGrantedPayloadData() -> Data {
        preflightPayloadData(
            overallStatus: "PASS",
            screenStatus: "PASS",
            screenDetail: "Screen Recording access granted.",
            screenRemediation: "",
            displayStatus: "PASS",
            displayDetail: "Active display available.",
            displayRemediation: "",
            microphoneStatus: "PASS",
            microphoneDetail: "Microphone access granted.",
            microphoneRemediation: ""
        )
    }

    private static func activeDisplayUnavailablePayloadData() -> Data {
        preflightPayloadData(
            overallStatus: "FAIL",
            screenStatus: "PASS",
            screenDetail: "Screen Recording access granted.",
            screenRemediation: "",
            displayStatus: "FAIL",
            displayDetail: "No active display available for capture.",
            displayRemediation: "Ensure at least one display is connected, awake, and available to Recordit, then Re-check.",
            microphoneStatus: "PASS",
            microphoneDetail: "Microphone access granted.",
            microphoneRemediation: ""
        )
    }

    private static func microphoneRuntimeFailurePayloadData() -> Data {
        preflightPayloadData(
            overallStatus: "FAIL",
            screenStatus: "PASS",
            screenDetail: "Screen Recording access granted.",
            screenRemediation: "",
            displayStatus: "PASS",
            displayDetail: "Active display available.",
            displayRemediation: "",
            microphoneStatus: "FAIL",
            microphoneDetail: "Microphone stream unavailable.",
            microphoneRemediation: "Verify the active input device and retry."
        )
    }

    private static func screenRuntimeFailurePayloadData() -> Data {
        preflightPayloadData(
            overallStatus: "FAIL",
            screenStatus: "FAIL",
            screenDetail: "Screen capture helper unavailable.",
            screenRemediation: "Quit and reopen Recordit, then Re-check.",
            displayStatus: "PASS",
            displayDetail: "Active display available.",
            displayRemediation: "",
            microphoneStatus: "PASS",
            microphoneDetail: "Microphone access granted.",
            microphoneRemediation: ""
        )
    }

    private static func backendRuntimeBlockedPayloadData() -> Data {
        let payload: [String: Any] = [
            "schema_version": "1",
            "kind": "transcribe-live-preflight",
            "generated_at_utc": "2026-03-05T00:00:00Z",
            "overall_status": "FAIL",
            "config": [
                "out_wav": "/tmp/recordit-uitest.wav",
                "out_jsonl": "/tmp/recordit-uitest.jsonl",
                "out_manifest": "/tmp/recordit-uitest.manifest.json",
                "asr_backend": "whispercpp",
                "asr_model_requested": "/tmp/mock-model.bin",
                "asr_model_resolved": "/tmp/mock-model.bin",
                "asr_model_source": "ui-test fixture",
                "sample_rate_hz": 48_000,
            ],
            "checks": [
                [
                    "id": ReadinessContractID.modelPath.rawValue,
                    "status": "PASS",
                    "detail": "Model path resolved.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.outWav.rawValue,
                    "status": "PASS",
                    "detail": "WAV output path ready.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.outJsonl.rawValue,
                    "status": "PASS",
                    "detail": "JSONL output path ready.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.outManifest.rawValue,
                    "status": "PASS",
                    "detail": "Manifest output path ready.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.backendRuntime.rawValue,
                    "status": "FAIL",
                    "detail": "Backend runtime helper is unavailable.",
                    "remediation": "Resolve the runtime helper issue, or continue with Record Only from Open Main Runtime.",
                ],
                [
                    "id": ReadinessContractID.screenCaptureAccess.rawValue,
                    "status": "PASS",
                    "detail": "Screen Recording access granted.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.displayAvailability.rawValue,
                    "status": "PASS",
                    "detail": "Active display available.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.microphoneAccess.rawValue,
                    "status": "PASS",
                    "detail": "Microphone access granted.",
                    "remediation": "",
                ],
            ],
        ]
        return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
    }

    private static func backendRuntimeWarningPayloadData() -> Data {
        let payload: [String: Any] = [
            "schema_version": "1",
            "kind": "transcribe-live-preflight",
            "generated_at_utc": "2026-03-05T00:00:00Z",
            "overall_status": "WARN",
            "config": [
                "out_wav": "/tmp/recordit-uitest.wav",
                "out_jsonl": "/tmp/recordit-uitest.jsonl",
                "out_manifest": "/tmp/recordit-uitest.manifest.json",
                "asr_backend": "whispercpp",
                "asr_model_requested": "/tmp/mock-model.bin",
                "asr_model_resolved": "/tmp/mock-model.bin",
                "asr_model_source": "ui-test fixture",
                "sample_rate_hz": 48_000,
            ],
            "checks": [
                [
                    "id": ReadinessContractID.modelPath.rawValue,
                    "status": "PASS",
                    "detail": "Model path resolved.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.outWav.rawValue,
                    "status": "PASS",
                    "detail": "WAV output path ready.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.outJsonl.rawValue,
                    "status": "PASS",
                    "detail": "JSONL output path ready.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.outManifest.rawValue,
                    "status": "PASS",
                    "detail": "Manifest output path ready.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.backendRuntime.rawValue,
                    "status": "WARN",
                    "detail": "Backend runtime helper reported a recoverable warning.",
                    "remediation": "Acknowledge this warning to continue.",
                ],
                [
                    "id": ReadinessContractID.screenCaptureAccess.rawValue,
                    "status": "PASS",
                    "detail": "Screen Recording access granted.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.displayAvailability.rawValue,
                    "status": "PASS",
                    "detail": "Active display available.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.microphoneAccess.rawValue,
                    "status": "PASS",
                    "detail": "Microphone access granted.",
                    "remediation": "",
                ],
            ],
        ]
        return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
    }

    private static func modelPathBlockedPayloadData() -> Data {
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
                "asr_model_resolved": "",
                "asr_model_source": "missing",
                "sample_rate_hz": 48_000,
            ],
            "checks": [
                [
                    "id": ReadinessContractID.modelPath.rawValue,
                    "status": "FAIL",
                    "detail": "Model path missing.",
                    "remediation": "Provide a compatible model.",
                ],
                [
                    "id": ReadinessContractID.outWav.rawValue,
                    "status": "PASS",
                    "detail": "WAV output path ready.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.outJsonl.rawValue,
                    "status": "PASS",
                    "detail": "JSONL output path ready.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.outManifest.rawValue,
                    "status": "PASS",
                    "detail": "Manifest output path ready.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.screenCaptureAccess.rawValue,
                    "status": "PASS",
                    "detail": "Screen Recording access granted.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.displayAvailability.rawValue,
                    "status": "PASS",
                    "detail": "Active display available.",
                    "remediation": "",
                ],
                [
                    "id": ReadinessContractID.microphoneAccess.rawValue,
                    "status": "PASS",
                    "detail": "Microphone access granted.",
                    "remediation": "",
                ],
            ],
        ]
        return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
    }

    private static func preflightPayloadData(
        overallStatus: String,
        screenStatus: String,
        screenDetail: String,
        screenRemediation: String,
        displayStatus: String,
        displayDetail: String,
        displayRemediation: String,
        microphoneStatus: String,
        microphoneDetail: String,
        microphoneRemediation: String
    ) -> Data {
        let payload: [String: Any] = [
            "schema_version": "1",
            "kind": "transcribe-live-preflight",
            "generated_at_utc": "2026-03-05T00:00:00Z",
            "overall_status": overallStatus,
            "config": [
                "out_wav": "/tmp/recordit-uitest.wav",
                "out_jsonl": "/tmp/recordit-uitest.jsonl",
                "out_manifest": "/tmp/recordit-uitest.manifest.json",
                "asr_backend": "whispercpp",
                "asr_model_requested": "/tmp/mock-model.bin",
                "asr_model_resolved": "/tmp/mock-model.bin",
                "asr_model_source": "ui-test fixture",
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
                    "status": screenStatus,
                    "detail": screenDetail,
                    "remediation": screenRemediation,
                ],
                [
                    "id": ReadinessContractID.displayAvailability.rawValue,
                    "status": displayStatus,
                    "detail": displayDetail,
                    "remediation": displayRemediation,
                ],
                [
                    "id": ReadinessContractID.microphoneAccess.rawValue,
                    "status": microphoneStatus,
                    "detail": microphoneDetail,
                    "remediation": microphoneRemediation,
                ],
            ],
        ]
        return (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
    }
}

private final class ScriptedPreflightCommandRunner: CommandRunning {
    private let payloads: [Data]
    private var cursor = 0
    private let lock = NSLock()

    init(payloads: [Data]) {
        self.payloads = payloads.isEmpty ? [Data()] : payloads
    }

    func run(
        executable _: String,
        arguments _: [String],
        environment _: [String: String]
    ) throws -> CommandExecutionResult {
        lock.lock()
        let index = min(cursor, payloads.count - 1)
        let payload = payloads[index]
        cursor += 1
        lock.unlock()

        return CommandExecutionResult(exitCode: 0, stdout: payload, stderr: Data())
    }
}

private struct ScriptedFailingPreflightCommandRunner: CommandRunning {
    func run(
        executable _: String,
        arguments _: [String],
        environment _: [String: String]
    ) throws -> CommandExecutionResult {
        let stderr = Data("permission diagnostics unavailable".utf8)
        return CommandExecutionResult(exitCode: 17, stdout: Data(), stderr: stderr)
    }
}

private actor ScriptedUITestRuntimeService: RuntimeService {
    enum StopBehavior {
        case alwaysSucceed
        case alwaysFail
        case failThenRecover
    }

    private let stopBehavior: StopBehavior
    private var hasIssuedRecoverableStopFailure = false
    private var nextProcessIdentifier: Int32 = 5100

    init(stopBehavior: StopBehavior = .alwaysSucceed) {
        self.stopBehavior = stopBehavior
    }

    func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        let processIdentifier = nextProcessIdentifier
        nextProcessIdentifier += 1
        return RuntimeLaunchResult(
            processIdentifier: processIdentifier,
            sessionRoot: request.outputRoot,
            startedAt: Date()
        )
    }

    func controlSession(
        processIdentifier _: Int32,
        action: RuntimeControlAction
    ) async throws -> RuntimeControlResult {
        if action == .stop {
            switch stopBehavior {
            case .alwaysSucceed:
                break
            case .alwaysFail:
                throw stopFailure()
            case .failThenRecover:
                if !hasIssuedRecoverableStopFailure {
                    hasIssuedRecoverableStopFailure = true
                    throw stopFailure()
                }
            }
        }
        return RuntimeControlResult(accepted: true, detail: "scripted")
    }

    private func stopFailure() -> AppServiceError {
        AppServiceError(
            code: .runtimeUnavailable,
            userMessage: "Runtime stop failed in UI test fixture.",
            remediation: "Use recovery actions to retry stop or inspect artifacts."
        )
    }
}
