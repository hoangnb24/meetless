import Foundation

public actor ProcessBackedRuntimeService: RuntimeService {
    private let processManager: RuntimeProcessManager
    private let pendingSidecarService: any PendingSessionSidecarService
    private let stopTimeoutSeconds: TimeInterval
    private let gracefulStopTimeoutSeconds: TimeInterval
    private let pendingSidecarStopTimeoutSeconds: TimeInterval

    public init(
        processManager: RuntimeProcessManager = RuntimeProcessManager(),
        pendingSidecarService: any PendingSessionSidecarService = FileSystemPendingSessionSidecarService(),
        stopTimeoutSeconds: TimeInterval = 15,
        gracefulStopTimeoutSeconds: TimeInterval = 2,
        pendingSidecarStopTimeoutSeconds: TimeInterval = 2
    ) {
        self.processManager = processManager
        self.pendingSidecarService = pendingSidecarService
        self.stopTimeoutSeconds = stopTimeoutSeconds
        self.gracefulStopTimeoutSeconds = gracefulStopTimeoutSeconds
        self.pendingSidecarStopTimeoutSeconds = pendingSidecarStopTimeoutSeconds
    }

    public func startSession(request: RuntimeStartRequest) async throws -> RuntimeLaunchResult {
        do {
            let launch = try await processManager.launch(request: request)
            if request.mode == .recordOnly {
                try await writePendingSidecarAfterLaunch(request: request, launch: launch)
            }
            return RuntimeLaunchResult(
                processIdentifier: launch.processIdentifier,
                sessionRoot: launch.sessionRoot,
                startedAt: launch.startedAt
            )
        } catch let managerError as RuntimeProcessManagerError {
            throw Self.mapManagerError(managerError)
        } catch {
            throw AppServiceError(
                code: .processLaunchFailed,
                userMessage: "Could not start the runtime process.",
                remediation: "Verify runtime binaries are installed and retry.",
                debugDetail: String(describing: error)
            )
        }
    }

    private func writePendingSidecarAfterLaunch(
        request: RuntimeStartRequest,
        launch: RuntimeProcessLaunch
    ) async throws {
        let initialState: PendingTranscriptionState = request.modelPath == nil ? .pendingModel : .readyToTranscribe
        do {
            let sidecarRequest = PendingSessionSidecarWriteRequest(
                sessionID: launch.sessionRoot.lastPathComponent,
                sessionRoot: launch.sessionRoot,
                wavPath: launch.sessionRoot.appendingPathComponent("session.wav"),
                createdAt: launch.startedAt,
                mode: .recordOnly,
                transcriptionState: initialState
            )
            _ = try pendingSidecarService.writePendingSidecar(sidecarRequest)
        } catch {
            _ = try? await processManager.control(
                processIdentifier: launch.processIdentifier,
                action: .cancel,
                timeoutSeconds: pendingSidecarStopTimeoutSeconds
            )
            if let serviceError = error as? AppServiceError {
                throw serviceError
            }
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Could not initialize pending session metadata.",
                remediation: "Retry recording. If this persists, verify session folder permissions.",
                debugDetail: String(describing: error)
            )
        }
    }

    public func controlSession(processIdentifier: Int32, action: RuntimeControlAction) async throws -> RuntimeControlResult {
        do {
            if let settledOutcome = await processManager.pollControlOutcome(
                processIdentifier: processIdentifier,
                action: action
            ) {
                return try mapControlOutcome(settledOutcome, requestedAction: action)
            }

            let outcome: RuntimeProcessControlOutcome
            if action == .stop {
                let graceTimeout = boundedGracefulStopTimeout()
                let forcedTimeout = max(0.05, stopTimeoutSeconds - graceTimeout)
                let gracefulStopRequestURL = await gracefulStopRequestURL(processIdentifier: processIdentifier)
                defer {
                    removeGracefulStopRequest(at: gracefulStopRequestURL)
                }
                try? writeGracefulStopRequest(at: gracefulStopRequestURL)
                if let gracefulOutcome = try await waitForNaturalStopOutcome(
                    processIdentifier: processIdentifier,
                    requestedAction: action,
                    timeoutSeconds: graceTimeout
                ) {
                    outcome = gracefulOutcome
                } else {
                    outcome = try await processManager.control(
                        processIdentifier: processIdentifier,
                        action: .stop,
                        timeoutSeconds: forcedTimeout
                    )
                }
            } else {
                outcome = try await processManager.control(
                    processIdentifier: processIdentifier,
                    action: action,
                    timeoutSeconds: stopTimeoutSeconds
                )
            }
            return try mapControlOutcome(outcome, requestedAction: action)
        } catch let managerError as RuntimeProcessManagerError {
            throw Self.mapManagerError(managerError)
        }
    }

    private func waitForNaturalStopOutcome(
        processIdentifier: Int32,
        requestedAction: RuntimeControlAction,
        timeoutSeconds: TimeInterval
    ) async throws -> RuntimeProcessControlOutcome? {
        let deadline = Date().addingTimeInterval(max(0.05, timeoutSeconds))
        while Date() < deadline {
            if let outcome = await processManager.pollControlOutcome(
                processIdentifier: processIdentifier,
                action: requestedAction
            ) {
                return outcome
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return await processManager.pollControlOutcome(
            processIdentifier: processIdentifier,
            action: requestedAction
        )
    }

    private func gracefulStopRequestURL(processIdentifier: Int32) async -> URL? {
        guard let sessionRoot = await processManager.sessionRoot(processIdentifier: processIdentifier) else {
            return nil
        }
        return sessionRoot
            .appendingPathComponent("session.stop.request", isDirectory: false)
            .standardizedFileURL
    }

    private func writeGracefulStopRequest(at requestURL: URL?) throws {
        guard let requestURL else {
            return
        }
        try FileManager.default.createDirectory(
            at: requestURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("stop\n".utf8).write(to: requestURL, options: .atomic)
    }

    private func removeGracefulStopRequest(at requestURL: URL?) {
        guard let requestURL else {
            return
        }
        try? FileManager.default.removeItem(at: requestURL)
    }

    private func boundedGracefulStopTimeout() -> TimeInterval {
        let boundedTotal = max(0.1, stopTimeoutSeconds)
        let requestedGrace = max(0.05, gracefulStopTimeoutSeconds)
        return min(requestedGrace, boundedTotal * 0.5)
    }

    private func mapControlOutcome(
        _ outcome: RuntimeProcessControlOutcome,
        requestedAction: RuntimeControlAction
    ) throws -> RuntimeControlResult {
        switch outcome.classification {
        case .success:
            return RuntimeControlResult(accepted: true, detail: "Process finished cleanly.")
        case .nonZeroExit(let code):
            let stderrDetail = Self.runtimeStderrDetail(sessionRoot: outcome.sessionRoot)
            let debugDetail: String
            if let stderrDetail, !stderrDetail.isEmpty {
                debugDetail = "exit_code=\(code), \(stderrDetail)"
            } else {
                debugDetail = "exit_code=\(code)"
            }
            throw AppServiceError(
                code: .processExitedUnexpectedly,
                userMessage: "Runtime process ended with an error.",
                remediation: "Open diagnostics and retry the session.",
                debugDetail: debugDetail
            )
        case .crashed(let signal):
            throw AppServiceError(
                code: .processExitedUnexpectedly,
                userMessage: "Runtime process crashed.",
                remediation: "Retry the session. If this repeats, run preflight diagnostics.",
                debugDetail: "signal=\(signal)"
            )
        case .timedOut:
            let detail: String
            if requestedAction == .stop {
                detail = "graceful_stop_timeout_seconds=\(boundedGracefulStopTimeout()), forced_stop_timeout_seconds=\(max(0.05, stopTimeoutSeconds - boundedGracefulStopTimeout()))"
            } else {
                detail = "control_timeout_seconds=\(stopTimeoutSeconds)"
            }
            throw AppServiceError(
                code: .timeout,
                userMessage: "Runtime did not stop in time.",
                remediation: "Retry stop, then use Cancel if needed.",
                debugDetail: detail
            )
        case .launchFailure(let detail):
            throw AppServiceError(
                code: .processLaunchFailed,
                userMessage: "Runtime control failed.",
                remediation: "Retry the action.",
                debugDetail: detail
            )
        }
    }

    private static func runtimeStderrDetail(sessionRoot: URL?) -> String? {
        guard let sessionRoot else {
            return nil
        }
        let stderrPath = sessionRoot
            .appendingPathComponent("runtime.stderr.log", isDirectory: false)
            .standardizedFileURL
        guard FileManager.default.fileExists(atPath: stderrPath.path) else {
            return "stderr_log_missing=\(stderrPath.path)"
        }

        guard let data = try? Data(contentsOf: stderrPath), !data.isEmpty else {
            return "stderr_log=\(stderrPath.path) (empty)"
        }

        let maxBytes = 4096
        let tailData: Data
        if data.count > maxBytes {
            tailData = data.suffix(maxBytes)
        } else {
            tailData = data
        }
        let rawTail = String(decoding: tailData, as: UTF8.self)
        let normalizedTail = rawTail
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " | ")

        if normalizedTail.isEmpty {
            return "stderr_log=\(stderrPath.path) (non-empty, non-text)"
        }
        return "stderr_log=\(stderrPath.path), stderr_tail=\(normalizedTail)"
    }

    private static func mapManagerError(_ error: RuntimeProcessManagerError) -> AppServiceError {
        switch error {
        case let .invalidPath(field, detail):
            return AppServiceError(
                code: .invalidInput,
                userMessage: "Runtime configuration path is invalid.",
                remediation: "Use absolute paths for runtime inputs/outputs.",
                debugDetail: "field=\(field), detail=\(detail)"
            )
        case let .missingRequiredValue(field):
            return AppServiceError(
                code: .invalidInput,
                userMessage: "A required runtime input is missing.",
                remediation: "Fill all required fields and retry.",
                debugDetail: "field=\(field)"
            )
        case let .binaryNotFound(name):
            return AppServiceError(
                code: .runtimeUnavailable,
                userMessage: "Required runtime binary is missing.",
                remediation: "Install Recordit runtime binaries or set explicit binary paths.",
                debugDetail: "binary=\(name)"
            )
        case let .binaryNotExecutable(path):
            return AppServiceError(
                code: .runtimeUnavailable,
                userMessage: "Runtime binary is not executable.",
                remediation: "Fix binary permissions and retry.",
                debugDetail: path
            )
        case let .launchFailed(detail):
            return AppServiceError(
                code: .processLaunchFailed,
                userMessage: "Could not launch runtime process.",
                remediation: "Retry after checking runtime installation and permissions.",
                debugDetail: detail
            )
        case let .unknownProcess(processIdentifier):
            return AppServiceError(
                code: .runtimeUnavailable,
                userMessage: "Session process is no longer available.",
                remediation: "Start a new session.",
                debugDetail: "pid=\(processIdentifier)"
            )
        }
    }
}
