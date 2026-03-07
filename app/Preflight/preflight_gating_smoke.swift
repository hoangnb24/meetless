import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("preflight_gating_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private func fixtureCheck(_ id: String, _ status: PreflightStatus) -> PreflightCheckDTO {
    PreflightCheckDTO(
        id: id,
        status: status,
        detail: "\(id) detail",
        remediation: "\(id) remediation"
    )
}

private func fixtureEnvelope(
    checks: [PreflightCheckDTO],
    overallStatus: PreflightStatus = .warn
) -> PreflightManifestEnvelopeDTO {
    PreflightManifestEnvelopeDTO(
        schemaVersion: "1",
        kind: "transcribe-live-preflight",
        generatedAtUTC: "2026-03-05T00:00:00Z",
        overallStatus: overallStatus,
        config: PreflightConfigDTO(
            outWav: "/tmp/out.wav",
            outJsonl: "/tmp/out.jsonl",
            outManifest: "/tmp/out.manifest.json",
            asrBackend: "whispercpp",
            asrModelRequested: "/tmp/model.bin",
            asrModelResolved: "/tmp/model.bin",
            asrModelSource: "cli",
            sampleRateHz: 48_000
        ),
        checks: checks
    )
}

private struct StubCommandRunner: CommandRunning {
    let stdoutData: Data

    func run(
        executable _: String,
        arguments _: [String],
        environment _: [String: String]
    ) throws -> CommandExecutionResult {
        CommandExecutionResult(exitCode: 0, stdout: stdoutData, stderr: Data())
    }
}

private struct PolicyMatrixExpectation {
    let id: ReadinessContractID
    let domain: ReadinessDomain
    let failBlocks: Bool
    let failWarns: Bool
    let warnRequiresAcknowledgement: Bool
    let fallbackOnFail: Bool
}

private func runPolicyChecks() {
    let expectedKnown: Set<String> = ReadinessContract.knownContractIDs

    check(
        PreflightGatingPolicy.knownContractCheckIDs == expectedKnown,
        "known contract check ID mapping drifted"
    )

    for id in PreflightGatingPolicy.blockingFailureCheckIDs {
        check(
            PreflightGatingPolicy.policy(forCheckID: id) == .blockOnFail,
            "blocking check \(id) must map to blockOnFail"
        )
    }
    for id in PreflightGatingPolicy.warnAcknowledgementCheckIDs {
        check(
            PreflightGatingPolicy.policy(forCheckID: id) == .warnRequiresAcknowledgement,
            "warn check \(id) must map to warnRequiresAcknowledgement"
        )
    }
    for id in ReadinessContract.tccCaptureIDs {
        check(
            ReadinessContract.domain(forCheckID: id) == .tccCapture,
            "tcc check \(id) must map to tcc_capture domain"
        )
    }
    for id in ReadinessContract.backendModelIDs {
        check(
            ReadinessContract.domain(forCheckID: id) == .backendModel,
            "backend model check \(id) must map to backend_model domain"
        )
    }
    for id in ReadinessContract.runtimePreflightIDs {
        check(
            ReadinessContract.domain(forCheckID: id) == .runtimePreflight,
            "runtime preflight check \(id) must map to runtime_preflight domain"
        )
    }
    for id in ReadinessContract.backendRuntimeIDs {
        check(
            ReadinessContract.domain(forCheckID: id) == .backendRuntime,
            "backend runtime check \(id) must map to backend_runtime domain"
        )
    }

    let policy = PreflightGatingPolicy()
    let expectations: [PolicyMatrixExpectation] = [
        PolicyMatrixExpectation(
            id: .modelPath,
            domain: .backendModel,
            failBlocks: true,
            failWarns: false,
            warnRequiresAcknowledgement: false,
            fallbackOnFail: true
        ),
        PolicyMatrixExpectation(
            id: .outWav,
            domain: .runtimePreflight,
            failBlocks: true,
            failWarns: false,
            warnRequiresAcknowledgement: false,
            fallbackOnFail: false
        ),
        PolicyMatrixExpectation(
            id: .outJsonl,
            domain: .runtimePreflight,
            failBlocks: true,
            failWarns: false,
            warnRequiresAcknowledgement: false,
            fallbackOnFail: false
        ),
        PolicyMatrixExpectation(
            id: .outManifest,
            domain: .runtimePreflight,
            failBlocks: true,
            failWarns: false,
            warnRequiresAcknowledgement: false,
            fallbackOnFail: false
        ),
        PolicyMatrixExpectation(
            id: .sampleRate,
            domain: .runtimePreflight,
            failBlocks: false,
            failWarns: true,
            warnRequiresAcknowledgement: true,
            fallbackOnFail: false
        ),
        PolicyMatrixExpectation(
            id: .screenCaptureAccess,
            domain: .tccCapture,
            failBlocks: true,
            failWarns: false,
            warnRequiresAcknowledgement: false,
            fallbackOnFail: false
        ),
        PolicyMatrixExpectation(
            id: .displayAvailability,
            domain: .tccCapture,
            failBlocks: true,
            failWarns: false,
            warnRequiresAcknowledgement: false,
            fallbackOnFail: false
        ),
        PolicyMatrixExpectation(
            id: .microphoneAccess,
            domain: .tccCapture,
            failBlocks: true,
            failWarns: false,
            warnRequiresAcknowledgement: false,
            fallbackOnFail: false
        ),
        PolicyMatrixExpectation(
            id: .backendRuntime,
            domain: .backendRuntime,
            failBlocks: true,
            failWarns: false,
            warnRequiresAcknowledgement: true,
            fallbackOnFail: true
        ),
        PolicyMatrixExpectation(
            id: .modelReadability,
            domain: .diagnosticOnly,
            failBlocks: false,
            failWarns: false,
            warnRequiresAcknowledgement: false,
            fallbackOnFail: false
        ),
    ]

    for expectation in expectations {
        let id = expectation.id.rawValue
        let failEvaluation = policy.evaluate(
            fixtureEnvelope(checks: [fixtureCheck(id, .fail)], overallStatus: .fail)
        )

        check(
            failEvaluation.mappedChecks.count == 1,
            "\(id) fail fixture should produce exactly one mapped check"
        )
        check(
            failEvaluation.mappedChecks[0].domain == expectation.domain,
            "\(id) should map to the expected readiness domain"
        )
        check(
            failEvaluation.mappedChecks[0].isKnownContractID,
            "\(id) should remain a known contract ID"
        )
        check(
            failEvaluation.unknownCheckIDs.isEmpty,
            "\(id) should not be reported as unknown"
        )
        check(
            failEvaluation.recordOnlyFallbackEligible == expectation.fallbackOnFail,
            "\(id) fail fallback eligibility drifted"
        )

        if expectation.failBlocks {
            check(
                failEvaluation.blockingFailures.map(\.check.id) == [id],
                "\(id) fail should register as a blocking failure"
            )
            check(
                failEvaluation.primaryBlockingDomain == expectation.domain,
                "\(id) fail should drive the expected primary blocking domain"
            )
            check(
                !failEvaluation.canProceed(acknowledgingWarnings: false),
                "\(id) fail must block live proceed before warning acknowledgement"
            )
            check(
                !failEvaluation.canProceed(acknowledgingWarnings: true),
                "\(id) fail must stay blocked after warning acknowledgement"
            )
        } else {
            check(
                failEvaluation.blockingFailures.isEmpty,
                "\(id) fail should not register as a blocking failure"
            )
        }

        if expectation.failWarns {
            check(
                failEvaluation.warningContinuations.map(\.check.id) == [id],
                "\(id) fail should require warning acknowledgement instead of blocking"
            )
            check(
                !failEvaluation.canProceed(acknowledgingWarnings: false),
                "\(id) fail must wait for warning acknowledgement"
            )
            check(
                failEvaluation.canProceed(acknowledgingWarnings: true),
                "\(id) fail should proceed after warning acknowledgement"
            )
        } else {
            check(
                failEvaluation.warningContinuations.isEmpty,
                "\(id) fail should not remain in warning continuation state"
            )
        }

        if expectation.warnRequiresAcknowledgement {
            let warnEvaluation = policy.evaluate(
                fixtureEnvelope(checks: [fixtureCheck(id, .warn)], overallStatus: .warn)
            )
            check(
                warnEvaluation.blockingFailures.isEmpty,
                "\(id) warn should not register as a blocking failure"
            )
            check(
                warnEvaluation.warningContinuations.map(\.check.id) == [id],
                "\(id) warn should require acknowledgement"
            )
            check(
                !warnEvaluation.canProceed(acknowledgingWarnings: false),
                "\(id) warn must wait for acknowledgement"
            )
            check(
                warnEvaluation.canProceed(acknowledgingWarnings: true),
                "\(id) warn should proceed after acknowledgement"
            )
            check(
                !warnEvaluation.recordOnlyFallbackEligible,
                "\(id) warn should not enable Record Only fallback"
            )
        }
    }

    let warnOnlyEnvelope = fixtureEnvelope(checks: [
        fixtureCheck(ReadinessContractID.modelPath.rawValue, .pass),
        fixtureCheck(ReadinessContractID.outWav.rawValue, .pass),
        fixtureCheck(ReadinessContractID.outJsonl.rawValue, .pass),
        fixtureCheck(ReadinessContractID.outManifest.rawValue, .pass),
        fixtureCheck(ReadinessContractID.screenCaptureAccess.rawValue, .pass),
        fixtureCheck(ReadinessContractID.microphoneAccess.rawValue, .pass),
        fixtureCheck(ReadinessContractID.sampleRate.rawValue, .warn),
        fixtureCheck(ReadinessContractID.backendRuntime.rawValue, .warn),
    ])
    let warnOnly = policy.evaluate(warnOnlyEnvelope)
    check(warnOnly.blockingFailures.isEmpty, "warn-only envelope should not have blockers")
    check(warnOnly.warningContinuations.count == 2, "warn-only envelope should require warning ack")
    check(!warnOnly.recordOnlyFallbackEligible, "warn-only envelope should not be treated as fallback-eligible")
    check(!warnOnly.canProceed(acknowledgingWarnings: false), "warn-only envelope must require explicit acknowledgment")
    check(warnOnly.canProceed(acknowledgingWarnings: true), "warn-only envelope should proceed after acknowledgment")
}

@MainActor
private func runViewModelChecks() {
    let warnEnvelope = fixtureEnvelope(checks: [
        fixtureCheck(ReadinessContractID.modelPath.rawValue, .pass),
        fixtureCheck(ReadinessContractID.outWav.rawValue, .pass),
        fixtureCheck(ReadinessContractID.outJsonl.rawValue, .pass),
        fixtureCheck(ReadinessContractID.outManifest.rawValue, .pass),
        fixtureCheck(ReadinessContractID.displayAvailability.rawValue, .pass),
        fixtureCheck(ReadinessContractID.microphoneAccess.rawValue, .pass),
        fixtureCheck(ReadinessContractID.sampleRate.rawValue, .warn),
    ])
    let encoder = JSONEncoder()
    let data: Data
    do {
        data = try encoder.encode(warnEnvelope)
    } catch {
        fputs("preflight_gating_smoke failed: fixture encode failed: \(error)\n", stderr)
        exit(1)
    }

    let runner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: StubCommandRunner(stdoutData: data),
        parser: PreflightEnvelopeParser(),
        environment: [:]
    )
    let viewModel = PreflightViewModel(runner: runner, gatingPolicy: PreflightGatingPolicy())
    viewModel.runLivePreflight()
    check(viewModel.requiresWarningAcknowledgement, "view model should require warning acknowledgment")
    check(!viewModel.canProceedToLiveTranscribe, "view model must block proceed until user acknowledges warnings")
    viewModel.acknowledgeWarningsForLiveTranscribe()
    check(viewModel.canProceedToLiveTranscribe, "view model should allow proceed after user acknowledgment")

    let runtimePermissionFailureEnvelope = fixtureEnvelope(
        checks: [
            fixtureCheck(ReadinessContractID.modelPath.rawValue, .pass),
            fixtureCheck(ReadinessContractID.outWav.rawValue, .pass),
            fixtureCheck(ReadinessContractID.outJsonl.rawValue, .pass),
            fixtureCheck(ReadinessContractID.outManifest.rawValue, .pass),
            fixtureCheck(ReadinessContractID.screenCaptureAccess.rawValue, .fail),
            fixtureCheck(ReadinessContractID.microphoneAccess.rawValue, .fail),
        ],
        overallStatus: .fail
    )
    let runtimeFailureData: Data
    do {
        runtimeFailureData = try encoder.encode(runtimePermissionFailureEnvelope)
    } catch {
        fputs("preflight_gating_smoke failed: runtime failure fixture encode failed: \(error)\n", stderr)
        exit(1)
    }

    let screenRuntimeFailureEnvelope = fixtureEnvelope(
        checks: [
            fixtureCheck(ReadinessContractID.modelPath.rawValue, .pass),
            fixtureCheck(ReadinessContractID.outWav.rawValue, .pass),
            fixtureCheck(ReadinessContractID.outJsonl.rawValue, .pass),
            fixtureCheck(ReadinessContractID.outManifest.rawValue, .pass),
            fixtureCheck(ReadinessContractID.screenCaptureAccess.rawValue, .fail),
            fixtureCheck(ReadinessContractID.displayAvailability.rawValue, .pass),
            fixtureCheck(ReadinessContractID.microphoneAccess.rawValue, .pass),
        ],
        overallStatus: .fail
    )
    let screenRuntimeFailureData: Data
    do {
        screenRuntimeFailureData = try encoder.encode(screenRuntimeFailureEnvelope)
    } catch {
        fputs("preflight_gating_smoke failed: screen runtime failure fixture encode failed: \(error)\n", stderr)
        exit(1)
    }

    let backendRuntimeFailureEnvelope = fixtureEnvelope(
        checks: [
            fixtureCheck(ReadinessContractID.modelPath.rawValue, .pass),
            fixtureCheck(ReadinessContractID.outWav.rawValue, .pass),
            fixtureCheck(ReadinessContractID.outJsonl.rawValue, .pass),
            fixtureCheck(ReadinessContractID.outManifest.rawValue, .pass),
            fixtureCheck(ReadinessContractID.screenCaptureAccess.rawValue, .pass),
            fixtureCheck(ReadinessContractID.microphoneAccess.rawValue, .pass),
            fixtureCheck(ReadinessContractID.backendRuntime.rawValue, .fail),
        ],
        overallStatus: .fail
    )
    let backendRuntimeFailureData: Data
    do {
        backendRuntimeFailureData = try encoder.encode(backendRuntimeFailureEnvelope)
    } catch {
        fputs("preflight_gating_smoke failed: backend runtime failure fixture encode failed: \(error)\n", stderr)
        exit(1)
    }

    setenv("RECORDIT_UI_TEST_MODE", "1", 1)
    defer { unsetenv("RECORDIT_UI_TEST_MODE") }

    let screenRuntimeFailureRunner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: StubCommandRunner(stdoutData: screenRuntimeFailureData),
        parser: PreflightEnvelopeParser(),
        environment: [:]
    )
    let screenRuntimeFailureViewModel = PreflightViewModel(
        runner: screenRuntimeFailureRunner,
        gatingPolicy: PreflightGatingPolicy(),
        nativePermissionStatus: { _ in true }
    )
    screenRuntimeFailureViewModel.runLivePreflight()
    if case let .completed(screenRuntimeEnvelope) = screenRuntimeFailureViewModel.state {
        let screenCheck = screenRuntimeEnvelope.checks.first {
            $0.id == ReadinessContractID.screenCaptureAccess.rawValue
        }
        check(screenCheck?.status == .fail, "screen runtime failures must remain failed in UI-test normalization")
        check(
            screenCheck?.detail.contains("App-level Screen Recording permission is granted") == true,
            "screen runtime failures should preserve the enriched native-permission detail"
        )
    } else {
        check(false, "screen runtime failure view model should complete with a runtime envelope")
    }
    check(
        screenRuntimeFailureViewModel.primaryBlockingDomain == .tccCapture,
        "screen runtime failures should remain tcc_capture blockers after UI-test normalization"
    )
    check(
        !screenRuntimeFailureViewModel.canOfferRecordOnlyFallback,
        "screen runtime failures should not offer Record Only fallback"
    )
    check(
        !screenRuntimeFailureViewModel.canProceedToLiveTranscribe,
        "screen runtime failures should keep live proceed blocked"
    )

    let backendRuntimeFailureRunner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: StubCommandRunner(stdoutData: backendRuntimeFailureData),
        parser: PreflightEnvelopeParser(),
        environment: [:]
    )
    let backendRuntimeFailureViewModel = PreflightViewModel(
        runner: backendRuntimeFailureRunner,
        gatingPolicy: PreflightGatingPolicy()
    )
    backendRuntimeFailureViewModel.runLivePreflight()
    check(
        backendRuntimeFailureViewModel.canOfferRecordOnlyFallback,
        "backend runtime failures should offer Record Only fallback"
    )
    check(
        !backendRuntimeFailureViewModel.requiresWarningAcknowledgement,
        "backend runtime failures should not require warning acknowledgement"
    )
    check(
        !backendRuntimeFailureViewModel.canProceedToLiveTranscribe,
        "backend runtime failures should keep live proceed blocked"
    )
    backendRuntimeFailureViewModel.acknowledgeWarningsForLiveTranscribe()
    check(
        !backendRuntimeFailureViewModel.canProceedToLiveTranscribe,
        "backend runtime failures should stay blocked even after acknowledgement"
    )

    let runtimeFailureRunner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: StubCommandRunner(stdoutData: runtimeFailureData),
        parser: PreflightEnvelopeParser(),
        environment: [:]
    )
    let fallbackViewModel = PreflightViewModel(
        runner: runtimeFailureRunner,
        gatingPolicy: PreflightGatingPolicy(),
        nativePermissionStatus: { _ in true }
    )
    fallbackViewModel.runLivePreflight()
    check(
        !fallbackViewModel.canProceedToLiveTranscribe,
        "runtime permission failures must block proceed in production mode"
    )
    check(
        fallbackViewModel.primaryBlockingDomain == .tccCapture,
        "runtime permission failures should map to tcc_capture domain"
    )
    check(
        !fallbackViewModel.canOfferRecordOnlyFallback,
        "permission blockers should keep Record Only fallback disabled"
    )
    if case let .completed(envelope) = fallbackViewModel.state {
        check(envelope.overallStatus == .fail, "runtime permission failures should keep overall status fail")
        let remainingPermissionFailures = envelope.checks.filter {
            (ReadinessContract.screenPermissionIDs.contains($0.id)
                || $0.id == ReadinessContract.microphonePermissionID)
                && $0.status == .fail
        }
        check(
            !remainingPermissionFailures.isEmpty,
            "runtime permission checks should remain in fail state until helper probes succeed"
        )
    } else {
        check(false, "fallback view model should complete with a runtime envelope")
    }
}

@main
struct PreflightGatingSmokeMain {
    static func main() async {
        runPolicyChecks()
        await MainActor.run {
            runViewModelChecks()
        }
        print("preflight_gating_smoke: PASS")
    }
}
