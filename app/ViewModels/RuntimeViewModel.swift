import Foundation

@MainActor
public final class RuntimeViewModel {
    public enum RunState: Equatable {
        case idle
        case preparing
        case running(processID: Int32)
        case stopping(processID: Int32)
        case finalizing
        case completed
        case failed(AppServiceError)
    }

    public enum RecoveryAction: String, Equatable, Hashable, Sendable {
        case resumeSession = "resume_session"
        case safeFinalize = "safe_finalize"
        case retryStop = "retry_stop"
        case retryFinalize = "retry_finalize"
        case openSessionArtifacts = "open_session_artifacts"
        case runPreflight = "run_preflight"
        case startNewSession = "start_new_session"
    }

    public struct InterruptionRecoveryContext: Equatable, Sendable {
        public var outcomeClassification: SessionOutcomeClassification
        public var outcomeCode: SessionOutcomeCode
        public var outcomeDiagnostics: [String: String]
        public var sessionRoot: URL
        public var summary: String
        public var guidance: String
        public var actions: [RecoveryAction]

        public init(
            outcomeClassification: SessionOutcomeClassification,
            outcomeCode: SessionOutcomeCode? = nil,
            outcomeDiagnostics: [String: String] = [:],
            sessionRoot: URL,
            summary: String,
            guidance: String,
            actions: [RecoveryAction]
        ) {
            self.outcomeClassification = outcomeClassification
            self.outcomeCode = outcomeCode ?? outcomeClassification.canonicalCode(manifestStatus: nil)
            self.outcomeDiagnostics = outcomeDiagnostics
            self.sessionRoot = sessionRoot
            self.summary = summary
            self.guidance = guidance
            self.actions = actions
        }
    }

    public private(set) var state: RunState = .idle
    public private(set) var lastRejectedActionError: AppServiceError?
    public private(set) var suggestedRecoveryActions: [RecoveryAction] = []
    public private(set) var interruptionRecoveryContext: InterruptionRecoveryContext?

    public static let accessibilityElements: [AccessibilityElementDescriptor] = [
        AccessibilityElementDescriptor(
            id: "start_live_transcribe",
            label: "Start live transcription",
            hint: "Starts a live session after model validation succeeds."
        ),
        AccessibilityElementDescriptor(
            id: "stop_live_transcribe",
            label: "Stop live transcription",
            hint: "Stops the active session and finalizes artifacts."
        ),
        AccessibilityElementDescriptor(
            id: "resume_interrupted_session",
            label: "Resume interrupted session",
            hint: "Restarts capture in the interrupted session folder."
        ),
        AccessibilityElementDescriptor(
            id: "safe_finalize_session",
            label: "Safe finalize session",
            hint: "Finalizes available artifacts after an interruption."
        ),
        AccessibilityElementDescriptor(
            id: "runtime_status",
            label: "Runtime status",
            hint: "Announces launch, running, and failure state changes."
        ),
    ]

    public static let focusPlan = KeyboardFocusPlan(
        orderedElementIDs: [
            "start_live_transcribe",
            "stop_live_transcribe",
            "resume_interrupted_session",
            "safe_finalize_session",
            "runtime_status",
        ]
    )

    public static let keyboardShortcuts: [KeyboardShortcutDescriptor] = [
        KeyboardShortcutDescriptor(
            id: "start_live_shortcut",
            key: "return",
            modifiers: ["command"],
            actionSummary: "Start live transcription."
        ),
        KeyboardShortcutDescriptor(
            id: "stop_live_shortcut",
            key: ".",
            modifiers: ["command"],
            actionSummary: "Stop the active live session."
        ),
        KeyboardShortcutDescriptor(
            id: "resume_interrupted_shortcut",
            key: "r",
            modifiers: ["command"],
            actionSummary: "Resume an interrupted session."
        ),
        KeyboardShortcutDescriptor(
            id: "safe_finalize_shortcut",
            key: "f",
            modifiers: ["command", "shift"],
            actionSummary: "Run safe finalization for an interrupted session."
        ),
    ]

    private let runtimeService: RuntimeService
    private let manifestService: ManifestService
    private let modelService: ModelResolutionService
    private let finalStatusMapper: ManifestFinalStatusMapper
    private let finalizationTimeoutSeconds: TimeInterval
    private let finalizationPollIntervalNanoseconds: UInt64
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (UInt64) async -> Void
    private var activeSessionRoot: URL?
    private var activeLiveProcessID: Int32?

    public init(
        runtimeService: RuntimeService,
        manifestService: ManifestService,
        modelService: ModelResolutionService,
        finalStatusMapper: ManifestFinalStatusMapper = ManifestFinalStatusMapper(),
        finalizationTimeoutSeconds: TimeInterval = 15,
        finalizationPollIntervalNanoseconds: UInt64 = 250_000_000,
        now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (UInt64) async -> Void = { nanoseconds in
            try? await Task.sleep(nanoseconds: nanoseconds)
        }
    ) {
        self.runtimeService = runtimeService
        self.manifestService = manifestService
        self.modelService = modelService
        self.finalStatusMapper = finalStatusMapper
        self.finalizationTimeoutSeconds = max(0.5, finalizationTimeoutSeconds)
        self.finalizationPollIntervalNanoseconds = max(10_000_000, finalizationPollIntervalNanoseconds)
        self.now = now
        self.sleep = sleep
    }

    public func startLive(outputRoot: URL, explicitModelPath: URL?) async {
        guard transition(
            to: .preparing,
            allowedFrom: [.idle, .completed, .failed],
            action: "startLive",
            invalidUserMessage: "Session start is unavailable while another session transition is active.",
            invalidRemediation: "Wait for the current transition to finish, then try Start again."
        ) else {
            return
        }
        do {
            let resolvedModel = try modelService.resolveModel(
                ModelResolutionRequest(
                    explicitModelPath: explicitModelPath,
                    backend: "whispercpp"
                )
            )
            let result = try await runtimeService.startSession(
                request: RuntimeStartRequest(
                    mode: .live,
                    outputRoot: outputRoot,
                    modelPath: resolvedModel.resolvedPath
                )
            )
            activeSessionRoot = result.sessionRoot
            activeLiveProcessID = result.processIdentifier
            _ = transition(
                to: .running(processID: result.processIdentifier),
                allowedFrom: [.preparing],
                action: "startLive",
                invalidUserMessage: "Runtime state changed unexpectedly before launch completed.",
                invalidRemediation: "Reset the run state and try starting again."
            )
        } catch let serviceError as AppServiceError {
            _ = transitionToFailure(
                serviceError,
                allowedFrom: [.preparing],
                action: "startLive",
                invalidUserMessage: "Runtime state changed unexpectedly while handling launch failure.",
                invalidRemediation: "Reset the run state and retry launch.",
                recoveryActions: suggestedActions(for: serviceError)
            )
        } catch {
            _ = transitionToFailure(
                AppServiceError(
                    code: .unknown,
                    userMessage: "Could not start session.",
                    remediation: "Try again. If this keeps happening, run preflight diagnostics first.",
                    debugDetail: String(describing: error)
                ),
                allowedFrom: [.preparing],
                action: "startLive",
                invalidUserMessage: "Runtime state changed unexpectedly while handling launch failure.",
                invalidRemediation: "Reset the run state and retry launch.",
                recoveryActions: [.runPreflight, .startNewSession]
            )
        }
    }

    public func stopCurrentRun() async {
        guard case let .running(processID) = state else {
            rejectAction(
                action: "stopCurrentRun",
                userMessage: "Stop is only available while a session is running.",
                remediation: "Start a session first, then use Stop after runtime begins."
            )
            return
        }
        guard transition(
            to: .stopping(processID: processID),
            allowedFrom: [.running],
            action: "stopCurrentRun",
            invalidUserMessage: "Stop is unavailable because runtime state is no longer running.",
            invalidRemediation: "Refresh runtime state, then retry Stop."
        ) else {
            return
        }
        do {
            _ = try await runtimeService.controlSession(processIdentifier: processID, action: .stop)
            guard transition(
                to: .finalizing,
                allowedFrom: [.stopping],
                action: "stopCurrentRun",
                invalidUserMessage: "Runtime state changed unexpectedly during stop finalization.",
                invalidRemediation: "Load final status to recover state."
            ) else {
                return
            }
            await finalizeStopBounded()
        } catch let serviceError as AppServiceError {
            let recoveryActions = stopFailureRecoveryActions(for: serviceError)
            if !recoveryActions.contains(.retryStop) {
                activeLiveProcessID = nil
            }
            _ = transitionToFailure(
                serviceError,
                allowedFrom: [.stopping],
                action: "stopCurrentRun",
                invalidUserMessage: "Runtime state changed unexpectedly while handling stop failure.",
                invalidRemediation: "Refresh runtime state and retry control action.",
                recoveryActions: recoveryActions
            )
        } catch {
            _ = transitionToFailure(
                AppServiceError(
                    code: .unknown,
                    userMessage: "Could not stop session cleanly.",
                    remediation: "Wait a few seconds and try Stop again.",
                    debugDetail: String(describing: error)
                ),
                allowedFrom: [.stopping],
                action: "stopCurrentRun",
                invalidUserMessage: "Runtime state changed unexpectedly while handling stop failure.",
                invalidRemediation: "Refresh runtime state and retry control action.",
                recoveryActions: [.retryStop, .openSessionArtifacts]
            )
        }
    }

    public func loadFinalStatus(manifestPath: URL) {
        activeSessionRoot = manifestPath.deletingLastPathComponent()
        guard transition(
            to: .finalizing,
            allowedFrom: [.idle, .running, .stopping, .finalizing, .completed, .failed],
            action: "loadFinalStatus",
            invalidUserMessage: "Final status cannot be loaded while runtime launch is still preparing.",
            invalidRemediation: "Wait for launch to complete before loading final status."
        ) else {
            return
        }
        do {
            let manifest = try manifestService.loadManifest(at: manifestPath)
            applyManifestFinalStatus(manifest, action: "loadFinalStatus")
        } catch let serviceError as AppServiceError {
            _ = transitionToFailure(
                serviceError,
                allowedFrom: [.finalizing],
                action: "loadFinalStatus",
                invalidUserMessage: "Runtime state changed unexpectedly while reading final status artifacts.",
                invalidRemediation: "Retry final status load after refreshing the session.",
                recoveryActions: suggestedActions(for: serviceError)
            )
        } catch {
            _ = transitionToFailure(
                AppServiceError(
                    code: .manifestInvalid,
                    userMessage: "Session summary is unavailable.",
                    remediation: "Re-open the session or run replay on session.jsonl.",
                    debugDetail: String(describing: error)
                ),
                allowedFrom: [.finalizing],
                action: "loadFinalStatus",
                invalidUserMessage: "Runtime state changed unexpectedly while reading final status artifacts.",
                invalidRemediation: "Retry final status load after refreshing the session.",
                recoveryActions: [.openSessionArtifacts, .retryFinalize]
            )
        }
    }

    public func resumeInterruptedSession(explicitModelPath: URL? = nil) async {
        guard let sessionRoot = interruptionRecoveryContext?.sessionRoot ?? activeSessionRoot else {
            rejectAction(
                action: "resumeInterruptedSession",
                userMessage: "No interrupted session is available to resume.",
                remediation: "Start a new session or open session artifacts for manual recovery."
            )
            return
        }
        await startLive(outputRoot: sessionRoot, explicitModelPath: explicitModelPath)
    }

    public func safeFinalizeInterruptedSession() {
        guard let sessionRoot = interruptionRecoveryContext?.sessionRoot ?? activeSessionRoot else {
            rejectAction(
                action: "safeFinalizeInterruptedSession",
                userMessage: "No interrupted session is available to finalize.",
                remediation: "Open session artifacts and verify a manifest exists before retrying."
            )
            return
        }
        loadFinalStatus(manifestPath: sessionRoot.appendingPathComponent("session.manifest.json"))
    }

    public func retryStopAfterFailure() async {
        guard let processID = activeLiveProcessID else {
            rejectAction(
                action: "retryStopAfterFailure",
                userMessage: "No active runtime process is available to stop again.",
                remediation: "Open session artifacts if present, or start a new session."
            )
            return
        }
        guard transition(
            to: .stopping(processID: processID),
            allowedFrom: [.failed],
            action: "retryStopAfterFailure",
            invalidUserMessage: "Retry Stop is only available after a failed runtime stop.",
            invalidRemediation: "Wait for the current runtime transition to finish before retrying Stop."
        ) else {
            return
        }
        do {
            _ = try await runtimeService.controlSession(processIdentifier: processID, action: .stop)
            guard transition(
                to: .finalizing,
                allowedFrom: [.stopping],
                action: "retryStopAfterFailure",
                invalidUserMessage: "Runtime state changed unexpectedly during retry stop finalization.",
                invalidRemediation: "Load final status to recover state."
            ) else {
                return
            }
            await finalizeStopBounded()
        } catch let serviceError as AppServiceError {
            let recoveryActions = stopFailureRecoveryActions(for: serviceError)
            if !recoveryActions.contains(.retryStop) {
                activeLiveProcessID = nil
            }
            _ = transitionToFailure(
                serviceError,
                allowedFrom: [.stopping],
                action: "retryStopAfterFailure",
                invalidUserMessage: "Runtime state changed unexpectedly while retrying Stop.",
                invalidRemediation: "Refresh runtime state and retry the control action again.",
                recoveryActions: recoveryActions
            )
        } catch {
            _ = transitionToFailure(
                AppServiceError(
                    code: .unknown,
                    userMessage: "Could not stop session cleanly.",
                    remediation: "Wait a few seconds and try Stop again.",
                    debugDetail: String(describing: error)
                ),
                allowedFrom: [.stopping],
                action: "retryStopAfterFailure",
                invalidUserMessage: "Runtime state changed unexpectedly while retrying Stop.",
                invalidRemediation: "Refresh runtime state and retry the control action again.",
                recoveryActions: [.retryStop, .openSessionArtifacts]
            )
        }
    }

    public func retryFinalizeAfterFailure() {
        guard let sessionRoot = activeSessionRoot else {
            rejectAction(
                action: "retryFinalizeAfterFailure",
                userMessage: "No failed session is available to finalize again.",
                remediation: "Open session artifacts if present, or start a new session."
            )
            return
        }
        loadFinalStatus(manifestPath: sessionRoot.appendingPathComponent("session.manifest.json"))
    }

    private enum RunPhase: String {
        case idle
        case preparing
        case running
        case stopping
        case finalizing
        case completed
        case failed
    }

    private func currentPhase(for runState: RunState) -> RunPhase {
        switch runState {
        case .idle:
            return .idle
        case .preparing:
            return .preparing
        case .running:
            return .running
        case .stopping:
            return .stopping
        case .finalizing:
            return .finalizing
        case .completed:
            return .completed
        case .failed:
            return .failed
        }
    }

    @discardableResult
    private func transition(
        to next: RunState,
        allowedFrom: Set<RunPhase>,
        action: String,
        invalidUserMessage: String,
        invalidRemediation: String
        ) -> Bool {
        let phase = currentPhase(for: state)
        guard allowedFrom.contains(phase) else {
            lastRejectedActionError = AppServiceError(
                code: .invalidInput,
                userMessage: invalidUserMessage,
                remediation: invalidRemediation,
                debugDetail: "action=\(action), state=\(phase.rawValue)"
            )
            return false
        }

        state = next
        lastRejectedActionError = nil
        if case .completed = next {
            suggestedRecoveryActions = []
            activeSessionRoot = nil
            activeLiveProcessID = nil
            interruptionRecoveryContext = nil
        } else if case .preparing = next {
            activeLiveProcessID = nil
            interruptionRecoveryContext = nil
        } else if case .running = next {
            suggestedRecoveryActions = []
            interruptionRecoveryContext = nil
        }
        return true
    }

    private func finalizeStopBounded() async {
        guard let sessionRoot = activeSessionRoot else {
            _ = transitionToFailure(
                AppServiceError(
                    code: .artifactMissing,
                    userMessage: "Session artifacts could not be located for finalization.",
                    remediation: "Open Sessions and inspect the latest run folder before retrying."
                ),
                allowedFrom: [.finalizing],
                action: "stopCurrentRun.finalize",
                invalidUserMessage: "Finalization could not start because runtime state changed unexpectedly.",
                invalidRemediation: "Refresh runtime state and retry finalization.",
                recoveryActions: [.openSessionArtifacts, .startNewSession]
            )
            return
        }

        let manifestPath = sessionRoot.appendingPathComponent("session.manifest.json")
        let deadline = now().addingTimeInterval(finalizationTimeoutSeconds)

        while now() <= deadline {
            do {
                let manifest = try manifestService.loadManifest(at: manifestPath)
                if finalStatusMapper.mapStatus(manifest) == .pending, now() < deadline {
                    await sleep(finalizationPollIntervalNanoseconds)
                    continue
                }
                applyManifestFinalStatus(manifest, action: "stopCurrentRun.finalize")
                return
            } catch let serviceError as AppServiceError {
                if isTransientFinalizationError(serviceError), now() < deadline {
                    await sleep(finalizationPollIntervalNanoseconds)
                    continue
                }
                _ = transitionToFailure(
                    serviceError,
                    allowedFrom: [.finalizing],
                    action: "stopCurrentRun.finalize",
                    invalidUserMessage: "Runtime state changed unexpectedly while finalizing stop.",
                    invalidRemediation: "Refresh runtime state and retry finalization.",
                    recoveryActions: suggestedActions(for: serviceError)
                )
                return
            } catch {
                let wrapped = AppServiceError(
                    code: .manifestInvalid,
                    userMessage: "Final status artifacts are malformed.",
                    remediation: "Open session details and inspect generated artifacts before retrying.",
                    debugDetail: String(describing: error)
                )
                _ = transitionToFailure(
                    wrapped,
                    allowedFrom: [.finalizing],
                    action: "stopCurrentRun.finalize",
                    invalidUserMessage: "Runtime state changed unexpectedly while finalizing stop.",
                    invalidRemediation: "Refresh runtime state and retry finalization.",
                    recoveryActions: [.openSessionArtifacts, .retryFinalize]
                )
                return
            }
        }

        // One final read attempt reduces deadline-edge races where the manifest lands
        // right after the loop's last transient read failure.
        if let manifest = try? manifestService.loadManifest(at: manifestPath),
           finalStatusMapper.mapStatus(manifest) != .pending {
            applyManifestFinalStatus(manifest, action: "stopCurrentRun.finalize")
            return
        }

        let snapshot = inspectSessionArtifacts(sessionRoot: sessionRoot, manifestPath: manifestPath)
        let diagnostics = snapshot.diagnosticSummary
        let timeoutActions: [RecoveryAction] = snapshot.hasPrimaryArtifacts
            ? [.safeFinalize, .retryFinalize, .openSessionArtifacts, .startNewSession]
            : (snapshot.hasAnyDiagnostics ? [.openSessionArtifacts, .startNewSession] : [.startNewSession])
        let timeoutContext = makeArtifactAwareRecoveryContext(
            error: AppServiceError(
                code: .timeout,
                userMessage: snapshot.hasPrimaryArtifacts
                    ? "Session finalization timed out after partial artifacts were written."
                    : "Session ended before final artifacts were created.",
                remediation: snapshot.hasPrimaryArtifacts
                    ? "Open session details to inspect artifacts, then retry finalization or safe finalize."
                    : "Inspect retained diagnostics if needed, then start a new session.",
                debugDetail: "timeout_seconds=\(finalizationTimeoutSeconds), \(diagnostics)"
            ),
            actions: timeoutActions,
            sessionRoot: sessionRoot,
            manifestPath: manifestPath
        )
        let timeoutError = timeoutContext.error
        let transitioned = transitionToFailure(
            timeoutError,
            allowedFrom: [.finalizing],
            action: "stopCurrentRun.finalize",
            invalidUserMessage: "Finalization timed out after runtime state changed unexpectedly.",
            invalidRemediation: "Refresh runtime state and retry finalization.",
            recoveryActions: timeoutContext.actions
        )
        if transitioned {
            suggestedRecoveryActions = timeoutContext.actions
            interruptionRecoveryContext = timeoutContext.context
        }
    }

    private struct SessionArtifactSnapshot: Equatable {
        let sessionRoot: URL
        let manifestPath: URL
        let manifestExists: Bool
        let jsonlPath: URL
        let jsonlExists: Bool
        let wavPath: URL
        let wavExists: Bool
        let stderrPath: URL
        let stderrExists: Bool

        var hasPrimaryArtifacts: Bool {
            manifestExists || jsonlExists || wavExists
        }

        var hasAnyDiagnostics: Bool {
            hasPrimaryArtifacts || stderrExists
        }

        var diagnosticSummary: String {
            [
                "session_root=\(sessionRoot.path)",
                "manifest_path=\(manifestPath.path)",
                "manifest_exists=\(manifestExists)",
                "jsonl_exists=\(jsonlExists)",
                "wav_exists=\(wavExists)",
                "stderr_exists=\(stderrExists)",
            ].joined(separator: ", ")
        }
    }

    private func inspectSessionArtifacts(sessionRoot: URL, manifestPath: URL) -> SessionArtifactSnapshot {
        let fileManager = FileManager.default
        let jsonlPath = sessionRoot.appendingPathComponent("session.jsonl")
        let wavPath = sessionRoot.appendingPathComponent("session.wav")
        let stderrPath = sessionRoot.appendingPathComponent("runtime.stderr.log")
        return SessionArtifactSnapshot(
            sessionRoot: sessionRoot,
            manifestPath: manifestPath,
            manifestExists: fileManager.fileExists(atPath: manifestPath.path),
            jsonlPath: jsonlPath,
            jsonlExists: fileManager.fileExists(atPath: jsonlPath.path),
            wavPath: wavPath,
            wavExists: fileManager.fileExists(atPath: wavPath.path),
            stderrPath: stderrPath,
            stderrExists: fileManager.fileExists(atPath: stderrPath.path)
        )
    }

    private func finalizationTimeoutDiagnostics(sessionRoot: URL, manifestPath: URL) -> String {
        inspectSessionArtifacts(sessionRoot: sessionRoot, manifestPath: manifestPath).diagnosticSummary
    }

    private func recoveryOutcomeDiagnostics(
        snapshot: SessionArtifactSnapshot,
        outcomeClassification: SessionOutcomeClassification,
        manifestStatus: SessionStatus? = nil
    ) -> [String: String] {
        var diagnostics: [String: String] = [
            "root_path": snapshot.sessionRoot.path,
            "manifest_path": snapshot.manifestPath.path,
            "jsonl_path": snapshot.jsonlPath.path,
            "wav_path": snapshot.wavPath.path,
            "stderr_path": snapshot.stderrPath.path,
            "has_manifest": String(snapshot.manifestExists),
            "has_jsonl": String(snapshot.jsonlExists),
            "has_wav": String(snapshot.wavExists),
            "stderr_exists": String(snapshot.stderrExists),
            "outcome_classification": outcomeClassification.rawValue,
            "outcome_code": outcomeClassification.canonicalCode(manifestStatus: manifestStatus).rawValue,
        ]
        if let manifestStatus {
            diagnostics["manifest_status"] = manifestStatus.rawValue
        }
        return diagnostics
    }

    private func applyManifestFinalStatus(_ manifest: SessionManifestDTO, action: String) {
        let mappedStatus = finalStatusMapper.mapStatus(manifest)
        switch mappedStatus {
        case .failed:
            let finalizedFailure = AppServiceError(
                code: .processExitedUnexpectedly,
                userMessage: "Session finalized with a failure status.",
                remediation: "Open session artifacts to inspect the finalized failure, then start a new session after fixing reported issues.",
                debugDetail: "manifest status=failed"
            )
            let actions: [RecoveryAction] = [.openSessionArtifacts, .startNewSession]
            let transitioned = transitionToFailure(
                finalizedFailure,
                allowedFrom: [.finalizing],
                action: action,
                invalidUserMessage: "Runtime state changed unexpectedly while mapping final failure status.",
                invalidRemediation: "Refresh runtime state and reopen the session detail.",
                recoveryActions: actions
            )
            if transitioned, let sessionRoot = activeSessionRoot {
                let snapshot = inspectSessionArtifacts(
                    sessionRoot: sessionRoot,
                    manifestPath: sessionRoot.appendingPathComponent("session.manifest.json")
                )
                suggestedRecoveryActions = actions
                interruptionRecoveryContext = InterruptionRecoveryContext(
                    outcomeClassification: .finalizedFailure,
                    outcomeCode: .finalizedFailure,
                    outcomeDiagnostics: recoveryOutcomeDiagnostics(
                        snapshot: snapshot,
                        outcomeClassification: .finalizedFailure,
                        manifestStatus: .failed
                    ),
                    sessionRoot: sessionRoot,
                    summary: "Session finalized with a failed outcome.",
                    guidance: "Inspect the retained artifacts for the finalized failure, then start a new session once the root cause is addressed.",
                    actions: actions
                )
            }
        case .ok, .degraded, .pending:
            _ = transition(
                to: .completed,
                allowedFrom: [.finalizing],
                action: action,
                invalidUserMessage: "Runtime state changed unexpectedly while finalizing session status.",
                invalidRemediation: "Refresh runtime state and reopen the session detail."
            )
        }
    }

    private func transitionToFailure(
        _ error: AppServiceError,
        allowedFrom: Set<RunPhase>,
        action: String,
        invalidUserMessage: String,
        invalidRemediation: String,
        recoveryActions: [RecoveryAction]
    ) -> Bool {
        let transitioned = transition(
            to: .failed(error),
            allowedFrom: allowedFrom,
            action: action,
            invalidUserMessage: invalidUserMessage,
            invalidRemediation: invalidRemediation
        )
        if transitioned {
            let normalizedActions = normalizedRecoveryActions(recoveryActions)
            let recoveryContext = makeInterruptionRecoveryContext(
                error: error,
                actions: normalizedActions
            )
            suggestedRecoveryActions = recoveryContext?.actions ?? normalizedActions
            interruptionRecoveryContext = recoveryContext
        }
        return transitioned
    }

    private func isTransientFinalizationError(_ error: AppServiceError) -> Bool {
        switch error.code {
        case .artifactMissing, .ioFailure, .manifestInvalid:
            return true
        default:
            return false
        }
    }

    private func suggestedActions(for error: AppServiceError) -> [RecoveryAction] {
        switch error.code {
        case .timeout:
            return [.safeFinalize, .retryFinalize, .openSessionArtifacts, .startNewSession]
        case .processExitedUnexpectedly:
            return [.resumeSession, .safeFinalize, .openSessionArtifacts, .startNewSession]
        case .runtimeUnavailable, .processLaunchFailed, .preflightFailed, .permissionDenied, .modelUnavailable:
            return [.runPreflight, .startNewSession]
        case .manifestInvalid, .artifactMissing, .jsonlCorrupt, .ioFailure:
            return [.openSessionArtifacts, .retryFinalize]
        case .invalidInput:
            return [.startNewSession]
        case .unknown:
            return [.startNewSession]
        }
    }

    private func stopFailureRecoveryActions(for error: AppServiceError) -> [RecoveryAction] {
        let fallback: [RecoveryAction]
        switch error.code {
        case .timeout:
            fallback = [.openSessionArtifacts]
        default:
            fallback = [.retryStop, .openSessionArtifacts]
        }
        return interruptionRecoveryActions(for: error, fallback: fallback)
    }

    private func interruptionRecoveryActions(
        for error: AppServiceError,
        fallback: [RecoveryAction]
    ) -> [RecoveryAction] {
        guard isRecoverableInterruption(error) else {
            return fallback
        }
        return normalizedRecoveryActions([.resumeSession, .safeFinalize] + fallback + [.startNewSession])
    }

    private func isRecoverableInterruption(_ error: AppServiceError) -> Bool {
        switch error.code {
        case .processExitedUnexpectedly, .timeout:
            return true
        default:
            return false
        }
    }


    private struct ArtifactAwareRecoveryPresentation {
        let error: AppServiceError
        let actions: [RecoveryAction]
        let context: InterruptionRecoveryContext?
    }

    private func makeArtifactAwareRecoveryContext(
        error: AppServiceError,
        actions: [RecoveryAction],
        sessionRoot: URL,
        manifestPath: URL
    ) -> ArtifactAwareRecoveryPresentation {
        let snapshot = inspectSessionArtifacts(sessionRoot: sessionRoot, manifestPath: manifestPath)
        if snapshot.hasPrimaryArtifacts {
            let normalizedActions = normalizedRecoveryActions(actions)
            return ArtifactAwareRecoveryPresentation(
                error: error,
                actions: normalizedActions,
                context: InterruptionRecoveryContext(
                    outcomeClassification: .partialArtifact,
                    outcomeCode: .partialArtifactSession,
                    outcomeDiagnostics: recoveryOutcomeDiagnostics(
                        snapshot: snapshot,
                        outcomeClassification: .partialArtifact
                    ),
                    sessionRoot: sessionRoot,
                    summary: "Session was interrupted after partial artifacts were captured.",
                    guidance: "Use Resume to continue the interrupted session, or Safe Finalize to preserve the partial artifacts for review before retrying.",
                    actions: normalizedActions
                )
            )
        }

        let normalizedActions = normalizedRecoveryActions(
            snapshot.hasAnyDiagnostics
                ? actions.filter { $0 != .resumeSession && $0 != .safeFinalize && $0 != .retryStop }
                : actions.filter { $0 != .resumeSession && $0 != .openSessionArtifacts && $0 != .safeFinalize && $0 != .retryStop }
        )
        return ArtifactAwareRecoveryPresentation(
            error: error,
            actions: normalizedActions,
            context: InterruptionRecoveryContext(
                outcomeClassification: .emptyRoot,
                outcomeCode: .emptySessionRoot,
                outcomeDiagnostics: recoveryOutcomeDiagnostics(
                    snapshot: snapshot,
                    outcomeClassification: .emptyRoot
                ),
                sessionRoot: sessionRoot,
                summary: "Session ended before any primary artifacts were created.",
                guidance: snapshot.hasAnyDiagnostics
                    ? "Inspect the retained diagnostics for the failed run, then start a new session."
                    : "No primary session artifacts were created; start a new session after checking runtime readiness.",
                actions: normalizedActions
            )
        )
    }

    private func makeInterruptionRecoveryContext(
        error: AppServiceError,
        actions: [RecoveryAction]
    ) -> InterruptionRecoveryContext? {
        guard isRecoverableInterruption(error), let sessionRoot = activeSessionRoot else {
            return nil
        }
        let presentation = makeArtifactAwareRecoveryContext(
            error: error,
            actions: normalizedRecoveryActions([.resumeSession, .safeFinalize] + actions),
            sessionRoot: sessionRoot,
            manifestPath: sessionRoot.appendingPathComponent("session.manifest.json")
        )
        return presentation.context
    }

    private func normalizedRecoveryActions(_ actions: [RecoveryAction]) -> [RecoveryAction] {
        var ordered = [RecoveryAction]()
        var seen = Set<RecoveryAction>()
        for action in actions where !seen.contains(action) {
            seen.insert(action)
            ordered.append(action)
        }
        return ordered
    }

    private func rejectAction(action: String, userMessage: String, remediation: String) {
        let phase = currentPhase(for: state)
        lastRejectedActionError = AppServiceError(
            code: .invalidInput,
            userMessage: userMessage,
            remediation: remediation,
            debugDetail: "action=\(action), state=\(phase.rawValue)"
        )
    }
}
