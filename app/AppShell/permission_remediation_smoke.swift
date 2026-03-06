import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("permission_remediation_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private func fixtureEnvelope(checks: [[String: Any]]) -> [String: Any] {
    [
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
            "asr_model_source": "cli",
            "sample_rate_hz": 48_000,
        ],
        "checks": checks,
    ]
}

private func encodeEnvelopeJSON(_ object: [String: Any]) -> Data {
    do {
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    } catch {
        fputs("permission_remediation_smoke failed: could not encode fixture JSON: \(error)\n", stderr)
        exit(1)
    }
}

private final class SequenceCommandRunner: CommandRunning {
    private var payloads: [Data]
    private(set) var invocationCount: Int = 0

    init(payloads: [Data]) {
        self.payloads = payloads
    }

    func run(
        executable _: String,
        arguments _: [String],
        environment _: [String: String]
    ) throws -> CommandExecutionResult {
        let index = min(invocationCount, payloads.count - 1)
        invocationCount += 1
        return CommandExecutionResult(exitCode: 0, stdout: payloads[index], stderr: Data())
    }
}

private struct FailingCommandRunner: CommandRunning {
    func run(
        executable _: String,
        arguments _: [String],
        environment _: [String: String]
    ) throws -> CommandExecutionResult {
        CommandExecutionResult(
            exitCode: 17,
            stdout: Data(),
            stderr: Data("permission diagnostics unavailable".utf8)
        )
    }
}

@MainActor
private func runSmoke() {
    let missingScreenPayload = encodeEnvelopeJSON(
        fixtureEnvelope(checks: [
            [
                "id": ReadinessContractID.screenCaptureAccess.rawValue,
                "status": "FAIL",
                "detail": "screen capture not authorized",
                "remediation": "Grant Screen Recording in System Settings.",
            ],
            [
                "id": ReadinessContractID.displayAvailability.rawValue,
                "status": "PASS",
                "detail": "display available",
                "remediation": "",
            ],
            [
                "id": ReadinessContractID.microphoneAccess.rawValue,
                "status": "PASS",
                "detail": "microphone sample observed",
                "remediation": "",
            ],
        ])
    )
    let passingPayload = encodeEnvelopeJSON(
        fixtureEnvelope(checks: [
            [
                "id": ReadinessContractID.screenCaptureAccess.rawValue,
                "status": "PASS",
                "detail": "screen access granted",
                "remediation": "",
            ],
            [
                "id": ReadinessContractID.displayAvailability.rawValue,
                "status": "PASS",
                "detail": "display available",
                "remediation": "",
            ],
            [
                "id": ReadinessContractID.microphoneAccess.rawValue,
                "status": "PASS",
                "detail": "microphone sample observed",
                "remediation": "",
            ],
        ])
    )
    let noDisplayPayload = encodeEnvelopeJSON(
        fixtureEnvelope(checks: [
            [
                "id": ReadinessContractID.screenCaptureAccess.rawValue,
                "status": "PASS",
                "detail": "screen access granted",
                "remediation": "",
            ],
            [
                "id": ReadinessContractID.displayAvailability.rawValue,
                "status": "FAIL",
                "detail": "no active display available",
                "remediation": "Wake a display and retry.",
            ],
            [
                "id": ReadinessContractID.microphoneAccess.rawValue,
                "status": "PASS",
                "detail": "microphone sample observed",
                "remediation": "",
            ],
        ])
    )

    let commandRunner = SequenceCommandRunner(payloads: [missingScreenPayload, passingPayload])
    let runner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: commandRunner,
        parser: PreflightEnvelopeParser(),
        environment: [:]
    )

    var openedURLs = [URL]()
    let viewModel = PermissionRemediationViewModel(
        runner: runner,
        openSystemSettings: { openedURLs.append($0) },
        nativePermissionStatus: { _ in false }
    )

    viewModel.runPermissionCheck()
    guard case let .ready(items) = viewModel.state else {
        check(false, "initial run should produce ready state")
        return
    }
    let screen = items.first { $0.surface == .screenRecording }
    let display = items.first { $0.surface == .activeDisplay }
    let mic = items.first { $0.surface == .microphone }
    check(screen?.status == .missingPermission, "screen permission should be missing")
    check(display?.status == .granted, "display should stay granted when only screen permission is missing")
    check(mic?.status == .granted, "microphone permission should be granted")
    check(viewModel.missingPermissions == [.screenRecording], "missing permission set should include screen only")
    check(viewModel.hasBlockingIssues, "missing screen permission should block progression")

    let openedScreen = viewModel.openSettings(for: .screenRecording)
    check(openedScreen, "open settings should succeed for screen")
    check(viewModel.shouldShowScreenRecordingRestartAdvisory, "screen settings action should show restart advisory")
    check(
        openedURLs.last?.absoluteString.contains("Privacy_ScreenCapture") == true,
        "screen settings URL should target ScreenCapture privacy pane"
    )

    viewModel.recheckPermissions()
    guard case let .ready(recheckedItems) = viewModel.state else {
        check(false, "re-check should produce ready state")
        return
    }
    let recheckedScreen = recheckedItems.first { $0.surface == .screenRecording }
    let recheckedDisplay = recheckedItems.first { $0.surface == .activeDisplay }
    check(recheckedScreen?.status == .granted, "screen permission should be granted after re-check payload")
    check(recheckedDisplay?.status == .granted, "display should be granted after re-check payload")
    check(viewModel.missingPermissions.isEmpty, "missing permissions should be empty after pass")
    check(!viewModel.hasBlockingIssues, "fully granted payload should clear progression blockers")

    let openedMic = viewModel.openSettings(for: .microphone)
    check(openedMic, "open settings should succeed for microphone")
    check(
        openedURLs.last?.absoluteString.contains("Privacy_Microphone") == true,
        "microphone settings URL should target Microphone privacy pane"
    )
    check(commandRunner.invocationCount == 2, "runner should be invoked once for initial check and once for re-check")

    let failedRunner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: FailingCommandRunner(),
        parser: PreflightEnvelopeParser(),
        environment: [:]
    )
    let failedViewModel = PermissionRemediationViewModel(
        runner: failedRunner,
        openSystemSettings: { openedURLs.append($0) },
        nativePermissionStatus: { _ in false }
    )
    failedViewModel.runPermissionCheck()
    guard case let .ready(fallbackItems) = failedViewModel.state else {
        check(false, "failing preflight should produce native-permission fallback ready state")
        return
    }
    check(
        fallbackItems.allSatisfy { $0.status == .missingPermission },
        "fallback state with native denied permissions should keep both permissions missing"
    )
    check(
        Set(failedViewModel.missingPermissions) == Set([.screenRecording, .microphone]),
        "failed state should fail-open both permissions for deep-link affordances"
    )
    check(failedViewModel.hasBlockingIssues, "failed diagnostics should keep progression blocked")
    check(
        failedViewModel.openSettings(for: .screenRecording),
        "screen settings deep-link should remain available in failed state"
    )
    check(
        failedViewModel.openSettings(for: .microphone),
        "microphone settings deep-link should remain available in failed state"
    )

    let runtimeOnlyFailureRunner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: SequenceCommandRunner(payloads: [missingScreenPayload]),
        parser: PreflightEnvelopeParser(),
        environment: [:]
    )
    let nativeGrantedViewModel = PermissionRemediationViewModel(
        runner: runtimeOnlyFailureRunner,
        openSystemSettings: { openedURLs.append($0) },
        nativePermissionStatus: { _ in true }
    )
    nativeGrantedViewModel.runPermissionCheck()
    guard case let .ready(nativeGrantedItems) = nativeGrantedViewModel.state else {
        check(false, "native-granted override should keep permission state ready")
        return
    }
    check(
        nativeGrantedItems.contains(where: { $0.surface == .screenRecording && $0.status == .runtimeFailure }),
        "granted-but-failing screen checks should surface a runtime failure state"
    )
    check(
        nativeGrantedViewModel.missingPermissions.isEmpty,
        "runtime-only permission failures should not offer TCC settings deep-links as missing permissions"
    )
    check(nativeGrantedViewModel.hasBlockingIssues, "runtime-only permission failures should still block progression")

    let noDisplayRunner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: SequenceCommandRunner(payloads: [noDisplayPayload]),
        parser: PreflightEnvelopeParser(),
        environment: [:]
    )
    let noDisplayViewModel = PermissionRemediationViewModel(
        runner: noDisplayRunner,
        openSystemSettings: { openedURLs.append($0) },
        nativePermissionStatus: { _ in true }
    )
    noDisplayViewModel.runPermissionCheck()
    guard case let .ready(noDisplayItems) = noDisplayViewModel.state else {
        check(false, "no-display payload should produce ready state")
        return
    }
    check(
        noDisplayItems.contains(where: { $0.surface == .activeDisplay && $0.status == .noActiveDisplay }),
        "display availability failures should surface a dedicated no-active-display state"
    )
    check(
        noDisplayViewModel.missingPermissions.isEmpty,
        "no-active-display state should not imply TCC settings deep-links"
    )
    check(noDisplayViewModel.hasBlockingIssues, "no-active-display state should block progression")
}

@main
struct PermissionRemediationSmokeMain {
    static func main() async {
        await MainActor.run {
            runSmoke()
        }
        print("permission_remediation_smoke: PASS")
    }
}
