import Foundation

struct ReadinessRemediationRoute: Equatable, Sendable {
    var checkID: String
    var errorCode: AppServiceErrorCode
    var userMessage: String
    var actionSteps: [String]
    var includesRecordOnlyFallback: Bool

    init(
        checkID: String,
        errorCode: AppServiceErrorCode,
        userMessage: String,
        actionSteps: [String],
        includesRecordOnlyFallback: Bool = false
    ) {
        self.checkID = checkID
        self.errorCode = errorCode
        self.userMessage = userMessage
        self.actionSteps = actionSteps
        self.includesRecordOnlyFallback = includesRecordOnlyFallback
    }

    func remediationText(
        checkRemediation: String?,
        includeRecordOnlyFallback: Bool
    ) -> String {
        var parts = [String]()
        if let normalizedCheckRemediation = Self.normalizedSentence(checkRemediation) {
            parts.append(normalizedCheckRemediation)
        }
        parts.append(contentsOf: actionSteps)
        if includesRecordOnlyFallback && includeRecordOnlyFallback {
            parts.append("Record Only remains available while Live Transcribe is blocked.")
        }
        return parts.joined(separator: " ")
    }

    private static func normalizedSentence(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        if trimmed.hasSuffix(".") || trimmed.hasSuffix("!") || trimmed.hasSuffix("?") {
            return trimmed
        }
        return "\(trimmed)."
    }
}

enum ReadinessRemediationMatrix {
    private static let routesByCheckID: [String: ReadinessRemediationRoute] = [
        ReadinessContractID.screenCaptureAccess.rawValue: ReadinessRemediationRoute(
            checkID: ReadinessContractID.screenCaptureAccess.rawValue,
            errorCode: .permissionDenied,
            userMessage: "Live Transcribe is blocked because Screen Recording access is not ready.",
            actionSteps: [
                "Click Check for Permissions.",
                "Open Screen Recording Settings and enable Recordit.",
                "Quit and reopen Recordit, then click Run Preflight again.",
            ]
        ),
        ReadinessContractID.displayAvailability.rawValue: ReadinessRemediationRoute(
            checkID: ReadinessContractID.displayAvailability.rawValue,
            errorCode: .permissionDenied,
            userMessage: "Live Transcribe is blocked because no active display is available for capture.",
            actionSteps: [
                "Ensure at least one display is connected, awake, and available to Recordit.",
                "Click Check for Permissions, then click Run Preflight again.",
            ]
        ),
        ReadinessContractID.microphoneAccess.rawValue: ReadinessRemediationRoute(
            checkID: ReadinessContractID.microphoneAccess.rawValue,
            errorCode: .permissionDenied,
            userMessage: "Live Transcribe is blocked because Microphone access is not ready.",
            actionSteps: [
                "Click Check for Permissions.",
                "Open Microphone Settings and enable Recordit.",
                "Click Run Preflight again.",
            ]
        ),
        ReadinessContractID.modelPath.rawValue: ReadinessRemediationRoute(
            checkID: ReadinessContractID.modelPath.rawValue,
            errorCode: .modelUnavailable,
            userMessage: "Live Transcribe is blocked because the selected model is not ready.",
            actionSteps: [
                "Choose a compatible local model path for the selected backend.",
                "Click Validate Model Setup, then click Run Preflight again.",
            ],
            includesRecordOnlyFallback: true
        ),
        ReadinessContractID.outWav.rawValue: ReadinessRemediationRoute(
            checkID: ReadinessContractID.outWav.rawValue,
            errorCode: .preflightFailed,
            userMessage: "Live Transcribe is blocked because Recordit cannot prepare session audio output.",
            actionSteps: [
                "Verify Recordit can write its session artifacts and output files.",
                "Click Run Preflight again.",
            ]
        ),
        ReadinessContractID.outJsonl.rawValue: ReadinessRemediationRoute(
            checkID: ReadinessContractID.outJsonl.rawValue,
            errorCode: .preflightFailed,
            userMessage: "Live Transcribe is blocked because Recordit cannot prepare transcript output.",
            actionSteps: [
                "Verify Recordit can write its session artifacts and transcript files.",
                "Click Run Preflight again.",
            ]
        ),
        ReadinessContractID.outManifest.rawValue: ReadinessRemediationRoute(
            checkID: ReadinessContractID.outManifest.rawValue,
            errorCode: .preflightFailed,
            userMessage: "Live Transcribe is blocked because Recordit cannot prepare the session manifest.",
            actionSteps: [
                "Verify Recordit can write its session artifacts and manifest files.",
                "Click Run Preflight again.",
            ]
        ),
        ReadinessContractID.backendRuntime.rawValue: ReadinessRemediationRoute(
            checkID: ReadinessContractID.backendRuntime.rawValue,
            errorCode: .preflightFailed,
            userMessage: "Live Transcribe is blocked because the backend runtime is not ready.",
            actionSteps: [
                "Review runtime diagnostics and backend installation state.",
                "Click Run Preflight again.",
            ],
            includesRecordOnlyFallback: true
        ),
    ]

    static func route(for blockingCheck: MappedPreflightCheck) -> ReadinessRemediationRoute? {
        routesByCheckID[blockingCheck.check.id]
    }
}

@MainActor
public final class AppShellViewModel {
    public private(set) var navigationState: NavigationState
    public let navigationCoordinator: AppNavigationCoordinator
    public private(set) var onboardingGateFailure: AppServiceError?
    public private(set) var startupRuntimeReadinessReport: RuntimeBinaryReadinessReport
    public private(set) var startupRuntimeReadinessFailure: AppServiceError?
    public private(set) var startupRuntimeSelfCheckRecord: StartupSelfCheckLogRecord?

    private let onboardingCompletionStore: any OnboardingCompletionStore
    private let runtimeReadinessChecker: any RuntimeBinaryReadinessChecking

    public init(
        firstRun: Bool? = nil,
        onboardingCompletionStore: any OnboardingCompletionStore = UserDefaultsOnboardingCompletionStore(),
        runtimeReadinessChecker: any RuntimeBinaryReadinessChecking = RuntimeBinaryReadinessService()
    ) {
        self.onboardingCompletionStore = onboardingCompletionStore
        self.runtimeReadinessChecker = runtimeReadinessChecker
        let readinessReport = runtimeReadinessChecker.evaluateStartupReadiness()
        let startupBlockingError = runtimeReadinessChecker.startupBlockingError(from: readinessReport)
        startupRuntimeReadinessReport = readinessReport
        startupRuntimeSelfCheckRecord = Self.startupSelfCheckRecord(
            from: readinessReport,
            failure: startupBlockingError
        )
        startupRuntimeReadinessFailure = Self.enrichedStartupReadinessFailure(
            startupBlockingError,
            startupSelfCheckRecord: startupRuntimeSelfCheckRecord
        )
        let resolvedFirstRun = firstRun ?? !onboardingCompletionStore.isOnboardingComplete()
        let coordinator = AppNavigationCoordinator(firstRun: resolvedFirstRun)
        self.navigationCoordinator = coordinator
        self.navigationState = coordinator.state

        if !resolvedFirstRun, startupRuntimeReadinessFailure != nil {
            send(.openRecovery(errorCode: .runtimeUnavailable))
        }
    }

    public func send(_ intent: NavigationIntent) {
        navigationCoordinator.dispatch(intent)
        navigationState = navigationCoordinator.state
    }

    public func completeOnboardingIfReady(
        modelSetup: ModelSetupViewModel,
        preflight: PreflightViewModel
    ) -> Bool {
        guard refreshStartupRuntimeReadiness() else {
            onboardingGateFailure = startupRuntimeReadinessFailure
            return false
        }

        guard modelSetup.canStartLiveTranscribe else {
            onboardingGateFailure = AppServiceError(
                code: .modelUnavailable,
                userMessage: "Select a valid local model before finishing setup.",
                remediation: "Choose a model path that matches the selected backend."
            )
            return false
        }

        guard preflight.canProceedToLiveTranscribe else {
            onboardingGateFailure = Self.preflightGateFailure(for: preflight)
            return false
        }

        onboardingCompletionStore.markOnboardingComplete()
        onboardingGateFailure = nil
        send(.finishOnboarding)
        return true
    }

    @discardableResult
    public func refreshStartupRuntimeReadiness() -> Bool {
        let report = runtimeReadinessChecker.evaluateStartupReadiness()
        let startupBlockingError = runtimeReadinessChecker.startupBlockingError(from: report)
        startupRuntimeReadinessReport = report
        startupRuntimeSelfCheckRecord = Self.startupSelfCheckRecord(
            from: report,
            failure: startupBlockingError
        )
        startupRuntimeReadinessFailure = Self.enrichedStartupReadinessFailure(
            startupBlockingError,
            startupSelfCheckRecord: startupRuntimeSelfCheckRecord
        )
        return startupRuntimeReadinessFailure == nil
    }

    public func resetOnboardingCompletion() {
        onboardingCompletionStore.resetOnboardingCompletion()
        onboardingGateFailure = nil
        send(.deepLink(.onboarding))
    }

    public var isOnboardingComplete: Bool {
        onboardingCompletionStore.isOnboardingComplete()
    }

    public var activeRoot: AppRootRoute {
        navigationState.root
    }

    public var activeSessionDetailID: String? {
        guard case let .detail(sessionID) = navigationState.sessionsPath.last else {
            return nil
        }
        return sessionID
    }

    private static func enrichedStartupReadinessFailure(
        _ failure: AppServiceError?,
        startupSelfCheckRecord: StartupSelfCheckLogRecord?
    ) -> AppServiceError? {
        guard var failure else {
            return nil
        }
        if failure.debugDetail?.contains("\"event_type\":\"startup_self_check\"") == true {
            return failure
        }
        failure.debugDetail = startupSelfCheckRecord?.debugDetailJSONString()
        return failure
    }

    private static func startupSelfCheckRecord(
        from report: RuntimeBinaryReadinessReport,
        failure: AppServiceError?
    ) -> StartupSelfCheckLogRecord? {
        if let record = StartupSelfCheckLogRecord.fromDebugDetailJSONString(failure?.debugDetail) {
            return record
        }
        guard let failure else {
            return nil
        }
        return StartupSelfCheckLogRecord.runtimeBlockedRecord(
            runtimeReadinessReport: report,
            blockingErrorCode: failure.code,
            generatedAtUTC: iso8601UTC(Date())
        )
    }

    private static func iso8601UTC(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    private static func preferredBlockingCheck(from preflight: PreflightViewModel) -> MappedPreflightCheck? {
        guard let evaluation = preflight.gatingEvaluation else {
            return nil
        }

        if let primaryDomain = evaluation.primaryBlockingDomain,
           let prioritizedFailure = evaluation.blockingFailures.first(where: { $0.domain == primaryDomain }) {
            return prioritizedFailure
        }

        return evaluation.blockingFailures.first
    }

    private static func preflightGateFailure(for preflight: PreflightViewModel) -> AppServiceError {
        let fallbackRemediationSuffix = preflight.canOfferRecordOnlyFallback
            ? " Record Only remains available while Live Transcribe is blocked."
            : ""

        if preflight.requiresWarningAcknowledgement {
            return AppServiceError(
                code: .preflightFailed,
                userMessage: "Live Transcribe warnings must be acknowledged before finishing setup.",
                remediation: "Review the preflight warning details, click Acknowledge Warnings, then complete onboarding."
            )
        }

        if let blockingCheck = preferredBlockingCheck(from: preflight),
           let route = ReadinessRemediationMatrix.route(for: blockingCheck) {
            return AppServiceError(
                code: route.errorCode,
                userMessage: route.userMessage,
                remediation: route.remediationText(
                    checkRemediation: blockingCheck.check.remediation,
                    includeRecordOnlyFallback: preflight.canOfferRecordOnlyFallback
                )
            )
        }

        switch preflight.primaryBlockingDomain {
        case .tccCapture:
            return AppServiceError(
                code: .permissionDenied,
                userMessage: "Live Transcribe is blocked by capture permission readiness.",
                remediation: "Grant Screen Recording and Microphone access, ensure an active display, then rerun preflight."
            )
        case .backendModel:
            return AppServiceError(
                code: .modelUnavailable,
                userMessage: "Live Transcribe is blocked by backend/model readiness.",
                remediation: "Fix model path/backend compatibility and rerun preflight.\(fallbackRemediationSuffix)"
            )
        case .runtimePreflight, .backendRuntime:
            return AppServiceError(
                code: .preflightFailed,
                userMessage: "Live Transcribe is blocked by runtime preflight checks.",
                remediation: "Resolve failed runtime checks, rerun preflight, and review diagnostics.\(fallbackRemediationSuffix)"
            )
        case .diagnosticOnly, .unknown, .none:
            return AppServiceError(
                code: .preflightFailed,
                userMessage: "Run preflight checks before finishing setup.",
                remediation: "Resolve failed checks and acknowledge warnings before continuing."
            )
        }
    }
}
