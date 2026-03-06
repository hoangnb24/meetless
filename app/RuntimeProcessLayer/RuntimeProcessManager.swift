import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

public struct RuntimeCommandLine: Equatable, Sendable {
    public var executableURL: URL
    public var arguments: [String]

    public init(executableURL: URL, arguments: [String]) {
        self.executableURL = executableURL
        self.arguments = arguments
    }
}

public struct RuntimeProcessLaunch: Equatable, Sendable {
    public var processIdentifier: Int32
    public var sessionRoot: URL
    public var startedAt: Date
    public var commandLine: RuntimeCommandLine

    public init(
        processIdentifier: Int32,
        sessionRoot: URL,
        startedAt: Date,
        commandLine: RuntimeCommandLine
    ) {
        self.processIdentifier = processIdentifier
        self.sessionRoot = sessionRoot
        self.startedAt = startedAt
        self.commandLine = commandLine
    }
}

public enum RuntimeExitClassification: Equatable, Sendable {
    case success
    case nonZeroExit(code: Int32)
    case crashed(signal: Int32)
    case timedOut
    case launchFailure(detail: String)
}

public struct RuntimeProcessControlOutcome: Equatable, Sendable {
    public var action: RuntimeControlAction
    public var classification: RuntimeExitClassification
    public var sessionRoot: URL?
    public var finishedAt: Date

    public init(
        action: RuntimeControlAction,
        classification: RuntimeExitClassification,
        sessionRoot: URL? = nil,
        finishedAt: Date
    ) {
        self.action = action
        self.classification = classification
        self.sessionRoot = sessionRoot
        self.finishedAt = finishedAt
    }
}

public enum RuntimeProcessManagerError: Error, Equatable, Sendable {
    case invalidPath(field: String, detail: String)
    case missingRequiredValue(field: String)
    case binaryNotFound(name: String)
    case binaryNotExecutable(path: String)
    case launchFailed(detail: String)
    case unknownProcess(processIdentifier: Int32)
}

public struct RuntimeBinarySet: Equatable, Sendable {
    public var recordit: URL
    public var sequoiaCapture: URL

    public init(recordit: URL, sequoiaCapture: URL) {
        self.recordit = recordit
        self.sequoiaCapture = sequoiaCapture
    }
}

public enum RuntimeBinaryReadinessStatus: String, Codable, Sendable {
    case ready
    case missing
    case notExecutable = "not_executable"
    case invalidOverride = "invalid_override"
}

public struct RuntimeBinaryReadinessCheck: Equatable, Sendable {
    public var binaryName: String
    public var overrideEnvKey: String
    public var status: RuntimeBinaryReadinessStatus
    public var resolvedPath: String?
    public var userMessage: String
    public var remediation: String
    public var debugDetail: String?

    public init(
        binaryName: String,
        overrideEnvKey: String,
        status: RuntimeBinaryReadinessStatus,
        resolvedPath: String?,
        userMessage: String,
        remediation: String,
        debugDetail: String? = nil
    ) {
        self.binaryName = binaryName
        self.overrideEnvKey = overrideEnvKey
        self.status = status
        self.resolvedPath = resolvedPath
        self.userMessage = userMessage
        self.remediation = remediation
        self.debugDetail = debugDetail
    }

    public var isReady: Bool {
        status == .ready
    }
}

public struct RuntimeBinaryReadinessReport: Equatable, Sendable {
    public var checks: [RuntimeBinaryReadinessCheck]

    public init(checks: [RuntimeBinaryReadinessCheck]) {
        self.checks = checks
    }

    public var isReady: Bool {
        checks.allSatisfy(\.isReady)
    }

    public var firstBlockingCheck: RuntimeBinaryReadinessCheck? {
        checks.first(where: { !$0.isReady })
    }

    public var resolvedBinarySet: RuntimeBinarySet? {
        guard
            let recorditCheck = checks.first(where: { $0.binaryName == "recordit" }),
            recorditCheck.isReady,
            let recorditPath = recorditCheck.resolvedPath,
            let sequoiaCheck = checks.first(where: { $0.binaryName == "sequoia_capture" }),
            sequoiaCheck.isReady,
            let sequoiaPath = sequoiaCheck.resolvedPath
        else {
            return nil
        }

        return RuntimeBinarySet(
            recordit: URL(fileURLWithPath: recorditPath),
            sequoiaCapture: URL(fileURLWithPath: sequoiaPath)
        )
    }
}

public protocol RuntimeBinaryResolving: Sendable {
    func resolve() throws -> RuntimeBinarySet
}

public struct RuntimeBinaryResolver: RuntimeBinaryResolving {
    public static let recorditEnvKey = "RECORDIT_RUNTIME_BINARY"
    public static let sequoiaCaptureEnvKey = "SEQUOIA_CAPTURE_BINARY"
    public static let allowPathLookupEnvKey = "RECORDIT_ALLOW_PATH_BINARY_LOOKUP"
    private static let bundledRuntimeRelativeDirectories = [
        "runtime/bin",
    ]

    private let environment: [String: String]
    private let bundleResourceURL: URL?

    public init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundleResourceURL: URL? = Bundle.main.resourceURL
    ) {
        self.environment = environment
        self.bundleResourceURL = bundleResourceURL
    }

    public func startupReadinessReport() -> RuntimeBinaryReadinessReport {
        RuntimeBinaryReadinessReport(
            checks: [
                evaluateBinary(named: "recordit", overrideEnvKey: Self.recorditEnvKey),
                evaluateBinary(named: "sequoia_capture", overrideEnvKey: Self.sequoiaCaptureEnvKey),
            ]
        )
    }

    public func resolve() throws -> RuntimeBinarySet {
        RuntimeBinarySet(
            recordit: try resolveBinary(named: "recordit", overrideEnvKey: Self.recorditEnvKey),
            sequoiaCapture: try resolveBinary(named: "sequoia_capture", overrideEnvKey: Self.sequoiaCaptureEnvKey)
        )
    }

    private func resolveBinary(named name: String, overrideEnvKey: String) throws -> URL {
        let fileManager = FileManager.default
        if let overrideRaw = environment[overrideEnvKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !overrideRaw.isEmpty {
            guard (overrideRaw as NSString).isAbsolutePath else {
                throw RuntimeProcessManagerError.invalidPath(
                    field: overrideEnvKey,
                    detail: "Expected absolute path override."
                )
            }
            let overrideURL = URL(fileURLWithPath: overrideRaw).standardizedFileURL
            guard fileManager.isExecutableFile(atPath: overrideURL.path) else {
                throw RuntimeProcessManagerError.binaryNotExecutable(path: overrideURL.path)
            }
            return overrideURL
        }

        if let bundled = bundledExecutable(named: name) {
            return bundled
        }

        if Self.pathLookupEnabled(in: environment) {
            let pathComponents = (environment["PATH"] ?? "")
                .split(separator: ":")
                .map(String.init)
            for component in pathComponents where component.hasPrefix("/") {
                let candidate = URL(fileURLWithPath: component)
                    .appendingPathComponent(name)
                    .standardizedFileURL
                if fileManager.isExecutableFile(atPath: candidate.path) {
                    return candidate
                }
            }
        }

        throw RuntimeProcessManagerError.binaryNotFound(name: name)
    }

    private func evaluateBinary(named name: String, overrideEnvKey: String) -> RuntimeBinaryReadinessCheck {
        let fileManager = FileManager.default
        let trimmedOverride = environment[overrideEnvKey]?.trimmingCharacters(in: .whitespacesAndNewlines)

        if let overrideRaw = trimmedOverride, !overrideRaw.isEmpty {
            guard (overrideRaw as NSString).isAbsolutePath else {
                return RuntimeBinaryReadinessCheck(
                    binaryName: name,
                    overrideEnvKey: overrideEnvKey,
                    status: .invalidOverride,
                    resolvedPath: nil,
                    userMessage: "Runtime binary path override is invalid.",
                    remediation: "Set \(overrideEnvKey) to an absolute path.",
                    debugDetail: "override=\(overrideRaw)"
                )
            }
            let overrideURL = URL(fileURLWithPath: overrideRaw).standardizedFileURL

            if !fileManager.fileExists(atPath: overrideURL.path) {
                return RuntimeBinaryReadinessCheck(
                    binaryName: name,
                    overrideEnvKey: overrideEnvKey,
                    status: .missing,
                    resolvedPath: overrideURL.path,
                    userMessage: "Required runtime binary is missing.",
                    remediation: "Install \(name) or update \(overrideEnvKey).",
                    debugDetail: "override_missing=\(overrideURL.path)"
                )
            }

            guard fileManager.isExecutableFile(atPath: overrideURL.path) else {
                return RuntimeBinaryReadinessCheck(
                    binaryName: name,
                    overrideEnvKey: overrideEnvKey,
                    status: .notExecutable,
                    resolvedPath: overrideURL.path,
                    userMessage: "Runtime binary is not executable.",
                    remediation: "Run `chmod +x \(overrideURL.path)` or choose a valid executable in \(overrideEnvKey).",
                    debugDetail: "override_not_executable=\(overrideURL.path)"
                )
            }

            return RuntimeBinaryReadinessCheck(
                binaryName: name,
                overrideEnvKey: overrideEnvKey,
                status: .ready,
                resolvedPath: overrideURL.path,
                userMessage: "\(name) is available.",
                remediation: ""
            )
        }

        for candidate in bundledBinaryCandidates(named: name) {
            if !fileManager.fileExists(atPath: candidate.path) {
                continue
            }
            guard fileManager.isExecutableFile(atPath: candidate.path) else {
                return RuntimeBinaryReadinessCheck(
                    binaryName: name,
                    overrideEnvKey: overrideEnvKey,
                    status: .notExecutable,
                    resolvedPath: candidate.path,
                    userMessage: "Runtime binary is not executable.",
                    remediation: "Reinstall Recordit.app or update \(overrideEnvKey) to an executable absolute path.",
                    debugDetail: "bundled_not_executable=\(candidate.path)"
                )
            }
            return RuntimeBinaryReadinessCheck(
                binaryName: name,
                overrideEnvKey: overrideEnvKey,
                status: .ready,
                resolvedPath: candidate.path,
                userMessage: "\(name) is available.",
                remediation: ""
            )
        }

        if Self.pathLookupEnabled(in: environment) {
            let pathComponents = (environment["PATH"] ?? "")
                .split(separator: ":")
                .map(String.init)
            for component in pathComponents where component.hasPrefix("/") {
                let candidate = URL(fileURLWithPath: component)
                    .appendingPathComponent(name)
                    .standardizedFileURL
                if fileManager.isExecutableFile(atPath: candidate.path) {
                    return RuntimeBinaryReadinessCheck(
                        binaryName: name,
                        overrideEnvKey: overrideEnvKey,
                        status: .ready,
                        resolvedPath: candidate.path,
                        userMessage: "\(name) is available.",
                        remediation: ""
                    )
                }
            }
        }

        return RuntimeBinaryReadinessCheck(
            binaryName: name,
            overrideEnvKey: overrideEnvKey,
            status: .missing,
            resolvedPath: nil,
            userMessage: "Required runtime binary is missing.",
            remediation: "Reinstall Recordit.app or set \(overrideEnvKey) to an absolute executable path.",
            debugDetail: "bundled_resolution_failed expected_paths=\(expectedBundledBinaryPaths(named: name).joined(separator: ";"))"
        )
    }

    private func bundledExecutable(named name: String) -> URL? {
        let fileManager = FileManager.default
        for candidate in bundledBinaryCandidates(named: name) {
            if fileManager.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    private func bundledBinaryCandidates(named name: String) -> [URL] {
        guard let resourceURL = bundleResourceURL?.standardizedFileURL else {
            return []
        }
        return Self.bundledRuntimeRelativeDirectories.map { relativeDirectory in
            resourceURL
                .appendingPathComponent(relativeDirectory, isDirectory: true)
                .appendingPathComponent(name)
                .standardizedFileURL
        }
    }

    private func expectedBundledBinaryPaths(named name: String) -> [String] {
        bundledBinaryCandidates(named: name).map(\.path)
    }

    private static func pathLookupEnabled(in environment: [String: String]) -> Bool {
        environment[allowPathLookupEnvKey] == "1"
    }
}

public actor RuntimeProcessManager {
    private struct ManagedProcess {
        var process: Process
        var sessionRoot: URL
        var commandLine: RuntimeCommandLine
        var startedAt: Date
        var stdoutLogURL: URL
        var stderrLogURL: URL
        var stdoutHandle: FileHandle
        var stderrHandle: FileHandle
    }

    private let binaryResolver: RuntimeBinaryResolving
    private let processEnvironment: [String: String]?
    private let now: @Sendable () -> Date
    private var managedProcesses: [Int32: ManagedProcess] = [:]

    public init(
        binaryResolver: RuntimeBinaryResolving = RuntimeBinaryResolver(),
        processEnvironment: [String: String]? = nil,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.binaryResolver = binaryResolver
        self.processEnvironment = processEnvironment
        self.now = now
    }

    public func commandLine(for request: RuntimeStartRequest) throws -> RuntimeCommandLine {
        let binaries = try binaryResolver.resolve()
        let sessionRoot = try absolutePath(request.outputRoot, field: "outputRoot")

        switch request.mode {
        case .live:
            return RuntimeCommandLine(
                executableURL: binaries.recordit,
                arguments: try buildRecorditArguments(request: request, sessionRoot: sessionRoot)
            )
        case .offline:
            return RuntimeCommandLine(
                executableURL: binaries.recordit,
                arguments: try buildRecorditArguments(request: request, sessionRoot: sessionRoot)
            )
        case .recordOnly:
            return RuntimeCommandLine(
                executableURL: binaries.sequoiaCapture,
                arguments: buildCaptureArguments(sessionRoot: sessionRoot)
            )
        }
    }

    public func launch(request: RuntimeStartRequest) throws -> RuntimeProcessLaunch {
        let command = try commandLine(for: request)
        let sessionRoot = try absolutePath(request.outputRoot, field: "outputRoot")
        let stdoutLogURL = sessionRoot
            .appendingPathComponent("runtime.stdout.log", isDirectory: false)
            .standardizedFileURL
        let stderrLogURL = sessionRoot
            .appendingPathComponent("runtime.stderr.log", isDirectory: false)
            .standardizedFileURL

        try prepareSessionRootForLaunch(sessionRoot)

        let process = Process()
        process.executableURL = command.executableURL
        process.arguments = command.arguments
        if let processEnvironment {
            process.environment = processEnvironment
        }
        let (stdoutHandle, stderrHandle) = try makeRuntimeLogHandles(
            sessionRoot: sessionRoot,
            stdoutLogURL: stdoutLogURL,
            stderrLogURL: stderrLogURL
        )
        process.standardOutput = stdoutHandle
        process.standardError = stderrHandle

        do {
            try process.run()
        } catch {
            closeLogHandles(stdoutHandle: stdoutHandle, stderrHandle: stderrHandle)
            throw RuntimeProcessManagerError.launchFailed(detail: String(describing: error))
        }

        let startedAt = now()
        let processIdentifier = process.processIdentifier
        managedProcesses[processIdentifier] = ManagedProcess(
            process: process,
            sessionRoot: sessionRoot,
            commandLine: command,
            startedAt: startedAt,
            stdoutLogURL: stdoutLogURL,
            stderrLogURL: stderrLogURL,
            stdoutHandle: stdoutHandle,
            stderrHandle: stderrHandle
        )

        return RuntimeProcessLaunch(
            processIdentifier: processIdentifier,
            sessionRoot: sessionRoot,
            startedAt: startedAt,
            commandLine: command
        )
    }

    public func control(
        processIdentifier: Int32,
        action: RuntimeControlAction,
        timeoutSeconds: TimeInterval = 10,
        killOnTimeout: Bool = true
    ) async throws -> RuntimeProcessControlOutcome {
        guard let managed = managedProcesses[processIdentifier] else {
            throw RuntimeProcessManagerError.unknownProcess(processIdentifier: processIdentifier)
        }

        let process = managed.process

        switch action {
        case .stop:
            if process.isRunning {
                process.interrupt()
            }
        case .cancel:
            if process.isRunning {
                process.terminate()
            }
        }

        let didExit = await waitUntilExit(process: process, timeoutSeconds: timeoutSeconds)
        let rawClassification: RuntimeExitClassification
        let shouldRetainManagedProcess: Bool
        if didExit {
            rawClassification = classifyTermination(process: process, timedOut: false)
            shouldRetainManagedProcess = false
        } else {
            if killOnTimeout {
                if process.isRunning {
                    _ = kill(process.processIdentifier, SIGKILL)
                    _ = await waitUntilExit(process: process, timeoutSeconds: 1)
                }
                shouldRetainManagedProcess = false
            } else {
                shouldRetainManagedProcess = process.isRunning
            }
            rawClassification = .timedOut
        }
        let classification = normalizeRequestedTermination(rawClassification, action: action)

        if !shouldRetainManagedProcess {
            closeLogHandles(stdoutHandle: managed.stdoutHandle, stderrHandle: managed.stderrHandle)
            managedProcesses.removeValue(forKey: processIdentifier)
        }
        return RuntimeProcessControlOutcome(
            action: action,
            classification: classification,
            sessionRoot: managed.sessionRoot,
            finishedAt: now()
        )
    }

    public func sessionRoot(processIdentifier: Int32) -> URL? {
        managedProcesses[processIdentifier]?.sessionRoot
    }

    public func pollControlOutcome(
        processIdentifier: Int32,
        action: RuntimeControlAction
    ) -> RuntimeProcessControlOutcome? {
        guard let managed = managedProcesses[processIdentifier] else {
            return nil
        }

        let process = managed.process
        guard process.isRunning == false else {
            return nil
        }

        let classification = classifyTermination(process: process, timedOut: false)
        closeLogHandles(stdoutHandle: managed.stdoutHandle, stderrHandle: managed.stderrHandle)
        managedProcesses.removeValue(forKey: processIdentifier)
        return RuntimeProcessControlOutcome(
            action: action,
            classification: classification,
            sessionRoot: managed.sessionRoot,
            finishedAt: now()
        )
    }

    public func pollTermination(processIdentifier: Int32) -> RuntimeExitClassification? {
        pollControlOutcome(processIdentifier: processIdentifier, action: .stop)?.classification
    }

    private func prepareSessionRootForLaunch(_ sessionRoot: URL) throws {
        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(at: sessionRoot, withIntermediateDirectories: true)
            let staleControlMarkers = ["session.stop.request"]
            for marker in staleControlMarkers {
                let markerURL = sessionRoot
                    .appendingPathComponent(marker, isDirectory: false)
                    .standardizedFileURL
                if fileManager.fileExists(atPath: markerURL.path) {
                    try fileManager.removeItem(at: markerURL)
                }
            }
        } catch {
            throw RuntimeProcessManagerError.launchFailed(
                detail: "failed preparing runtime session root in \(sessionRoot.path): \(error)"
            )
        }
    }

    private func makeRuntimeLogHandles(
        sessionRoot: URL,
        stdoutLogURL: URL,
        stderrLogURL: URL
    ) throws -> (FileHandle, FileHandle) {
        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(at: sessionRoot, withIntermediateDirectories: true)
            if !fileManager.fileExists(atPath: stdoutLogURL.path) {
                fileManager.createFile(atPath: stdoutLogURL.path, contents: Data())
            }
            if !fileManager.fileExists(atPath: stderrLogURL.path) {
                fileManager.createFile(atPath: stderrLogURL.path, contents: Data())
            }
            let stdoutHandle = try FileHandle(forWritingTo: stdoutLogURL)
            let stderrHandle = try FileHandle(forWritingTo: stderrLogURL)
            try stdoutHandle.truncate(atOffset: 0)
            try stderrHandle.truncate(atOffset: 0)
            return (stdoutHandle, stderrHandle)
        } catch {
            throw RuntimeProcessManagerError.launchFailed(
                detail: "failed preparing runtime logs in \(sessionRoot.path): \(error)"
            )
        }
    }

    private func closeLogHandles(stdoutHandle: FileHandle, stderrHandle: FileHandle) {
        try? stdoutHandle.close()
        try? stderrHandle.close()
    }

    private func buildRecorditArguments(request: RuntimeStartRequest, sessionRoot: URL) throws -> [String] {
        var arguments = ["run", "--mode", request.mode.rawValue]

        switch request.mode {
        case .live:
            arguments += ["--output-root", sessionRoot.path]
        case .offline:
            guard let inputWav = request.inputWav else {
                throw RuntimeProcessManagerError.missingRequiredValue(field: "inputWav")
            }
            let inputWavURL = try absolutePath(inputWav, field: "inputWav")
            arguments += ["--input-wav", inputWavURL.path, "--output-root", sessionRoot.path]
        case .recordOnly:
            throw RuntimeProcessManagerError.invalidPath(
                field: "mode",
                detail: "record_only mode must use sequoia_capture command path."
            )
        }

        if let language = request.languageTag?.trimmingCharacters(in: .whitespacesAndNewlines), !language.isEmpty {
            arguments += ["--language", language]
        }
        if let profile = request.profile?.trimmingCharacters(in: .whitespacesAndNewlines), !profile.isEmpty {
            arguments += ["--profile", profile]
        }
        if let modelPath = request.modelPath {
            let modelURL = try absolutePath(modelPath, field: "modelPath")
            arguments += ["--model", modelURL.path]
        }

        arguments.append("--json")
        return arguments
    }

    private func buildCaptureArguments(sessionRoot: URL) -> [String] {
        let wavPath = sessionRoot.appendingPathComponent("session.wav").path
        return ["0", wavPath, "48000", "adapt-stream-rate", "warn"]
    }

    private func absolutePath(_ url: URL, field: String) throws -> URL {
        let standardized = url.standardizedFileURL
        guard standardized.path.hasPrefix("/") else {
            throw RuntimeProcessManagerError.invalidPath(
                field: field,
                detail: "Expected absolute path."
            )
        }
        return standardized
    }

    private func waitUntilExit(process: Process, timeoutSeconds: TimeInterval) async -> Bool {
        guard timeoutSeconds > 0 else {
            return process.isRunning == false
        }

        let deadline = now().addingTimeInterval(timeoutSeconds)
        while process.isRunning {
            if now() >= deadline {
                return false
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return true
    }

    private func normalizeRequestedTermination(
        _ classification: RuntimeExitClassification,
        action: RuntimeControlAction
    ) -> RuntimeExitClassification {
        guard case let .crashed(signal) = classification else {
            return classification
        }

        switch action {
        case .cancel where signal == SIGTERM:
            return .success
        default:
            return classification
        }
    }

    private func classifyTermination(process: Process, timedOut: Bool) -> RuntimeExitClassification {
        if timedOut {
            return .timedOut
        }

        switch process.terminationReason {
        case .exit:
            return process.terminationStatus == 0
                ? .success
                : .nonZeroExit(code: process.terminationStatus)
        case .uncaughtSignal:
            return .crashed(signal: process.terminationStatus)
        @unknown default:
            return .launchFailure(detail: "Unknown termination reason")
        }
    }
}
