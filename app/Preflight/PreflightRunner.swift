import Foundation

public enum PreflightStatus: String, Codable, Sendable {
    case pass = "PASS"
    case warn = "WARN"
    case fail = "FAIL"
}

public struct PreflightCheckDTO: Codable, Equatable, Sendable {
    public var id: String
    public var status: PreflightStatus
    public var detail: String
    public var remediation: String?
}

public struct PreflightConfigDTO: Codable, Equatable, Sendable {
    public var outWav: String
    public var outJsonl: String
    public var outManifest: String
    public var asrBackend: String
    public var asrModelRequested: String
    public var asrModelResolved: String
    public var asrModelSource: String
    public var sampleRateHz: UInt64

    enum CodingKeys: String, CodingKey {
        case outWav = "out_wav"
        case outJsonl = "out_jsonl"
        case outManifest = "out_manifest"
        case asrBackend = "asr_backend"
        case asrModelRequested = "asr_model_requested"
        case asrModelResolved = "asr_model_resolved"
        case asrModelSource = "asr_model_source"
        case sampleRateHz = "sample_rate_hz"
    }
}

public struct PreflightManifestEnvelopeDTO: Codable, Equatable, Sendable {
    public var schemaVersion: String
    public var kind: String
    public var generatedAtUTC: String
    public var overallStatus: PreflightStatus
    public var config: PreflightConfigDTO
    public var checks: [PreflightCheckDTO]

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case kind
        case generatedAtUTC = "generated_at_utc"
        case overallStatus = "overall_status"
        case config
        case checks
    }
}

public protocol CommandRunning {
    func run(
        executable: String,
        arguments: [String],
        environment: [String: String]
    ) throws -> CommandExecutionResult
}

public struct CommandExecutionResult: Equatable, Sendable {
    public var exitCode: Int32
    public var stdout: Data
    public var stderr: Data
}

public struct ProcessCommandRunner: CommandRunning {
    public init() {}

    public func run(
        executable: String,
        arguments: [String],
        environment: [String: String]
    ) throws -> CommandExecutionResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        var mergedEnvironment = ProcessInfo.processInfo.environment
        for (key, value) in environment {
            mergedEnvironment[key] = value
        }
        process.environment = mergedEnvironment

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            throw AppServiceError(
                code: .processLaunchFailed,
                userMessage: "Could not launch preflight diagnostics.",
                remediation: "Verify that `recordit` is installed and executable.",
                debugDetail: String(describing: error)
            )
        }

        process.waitUntilExit()
        return CommandExecutionResult(
            exitCode: process.terminationStatus,
            stdout: stdoutPipe.fileHandleForReading.readDataToEndOfFile(),
            stderr: stderrPipe.fileHandleForReading.readDataToEndOfFile()
        )
    }
}

public struct PreflightEnvelopeParser {
    public static let expectedKind = "transcribe-live-preflight"
    public static let expectedSchemaVersion = "1"

    public init() {}

    public static func derivedOverallStatus(for checks: [PreflightCheckDTO]) -> PreflightStatus {
        if checks.contains(where: { $0.status == .fail }) {
            return .fail
        }
        if checks.contains(where: { $0.status == .warn }) {
            return .warn
        }
        return .pass
    }

    public func parse(data: Data) throws -> PreflightManifestEnvelopeDTO {
        let decoder = JSONDecoder()
        let envelope: PreflightManifestEnvelopeDTO
        do {
            envelope = try decoder.decode(PreflightManifestEnvelopeDTO.self, from: data)
        } catch {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Preflight output is malformed.",
                remediation: "Re-run preflight and verify JSON output contract compatibility.",
                debugDetail: String(describing: error)
            )
        }

        guard envelope.kind == Self.expectedKind else {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Preflight output kind is not supported.",
                remediation: "Update the app shell parser to a compatible preflight contract.",
                debugDetail: "kind=\(envelope.kind)"
            )
        }
        guard envelope.schemaVersion == Self.expectedSchemaVersion else {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Preflight schema version is not supported.",
                remediation: "Update parser compatibility for the manifest schema version in use.",
                debugDetail: "schema_version=\(envelope.schemaVersion)"
            )
        }

        let derivedOverallStatus = Self.derivedOverallStatus(for: envelope.checks)
        guard envelope.overallStatus == derivedOverallStatus else {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Preflight overall status does not match check statuses.",
                remediation: "Re-run preflight and verify overall_status matches the retained check results.",
                debugDetail: "overall_status=\(envelope.overallStatus.rawValue) derived=\(derivedOverallStatus.rawValue)"
            )
        }
        return envelope
    }
}

public struct RecorditPreflightRunner {
    public static func deterministicArguments(outputRoot: URL) -> [String] {
        [
            "preflight",
            "--mode",
            "live",
            "--output-root",
            outputRoot.path,
            "--json",
        ]
    }

    private let executable: String
    private let commandRunner: CommandRunning
    private let parser: PreflightEnvelopeParser
    private let environment: [String: String]
    private let preflightOutputRoot: URL

    public init(
        executable: String = "/usr/bin/env",
        commandRunner: CommandRunning = ProcessCommandRunner(),
        parser: PreflightEnvelopeParser = PreflightEnvelopeParser(),
        environment: [String: String] = [:],
        preflightOutputRoot: URL? = nil
    ) {
        self.executable = executable
        self.commandRunner = commandRunner
        self.parser = parser
        self.environment = environment
        self.preflightOutputRoot = (preflightOutputRoot ?? Self.defaultPreflightOutputRoot()).standardizedFileURL
    }

    public func runLivePreflight() throws -> PreflightManifestEnvelopeDTO {
        do {
            try FileManager.default.createDirectory(
                at: preflightOutputRoot,
                withIntermediateDirectories: true
            )
        } catch {
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Preflight output directory could not be prepared.",
                remediation: "Verify writable disk access for temporary files, then rerun preflight.",
                debugDetail: preflightOutputRoot.path
            )
        }

        let arguments = Self.deterministicArguments(outputRoot: preflightOutputRoot)
        let invocation: [String]
        if executable == "/usr/bin/env" {
            invocation = ["recordit"] + arguments
        } else {
            invocation = arguments
        }
        let result = try commandRunner.run(
            executable: executable,
            arguments: invocation,
            environment: environment
        )

        if let manifestData = try loadManifestDataFromRecorditSummary(stdout: result.stdout) {
            return try parser.parse(data: manifestData)
        }

        if !result.stdout.isEmpty, let parsedFromStdout = tryParseEnvelopeFromStdout(result.stdout) {
            return parsedFromStdout
        }

        guard result.exitCode == 0 else {
            throw AppServiceError(
                code: .preflightFailed,
                userMessage: "Preflight checks failed.",
                remediation: "Review check statuses and complete the recommended remediation steps.",
                debugDetail: String(data: result.stderr, encoding: .utf8)
            )
        }

        guard !result.stdout.isEmpty else {
            throw AppServiceError(
                code: .manifestInvalid,
                userMessage: "Preflight produced no JSON output.",
                remediation: "Run preflight again and ensure `--json` output is enabled."
            )
        }

        throw AppServiceError(
            code: .manifestInvalid,
            userMessage: "Preflight output is malformed.",
            remediation: "Re-run preflight and verify JSON output contract compatibility."
        )
    }

    private func tryParseEnvelopeFromStdout(_ stdout: Data) -> PreflightManifestEnvelopeDTO? {
        do {
            return try parser.parse(data: stdout)
        } catch let error as AppServiceError where error.code == .manifestInvalid {
            return nil
        } catch {
            return nil
        }
    }

    private func loadManifestDataFromRecorditSummary(stdout: Data) throws -> Data? {
        guard
            let rawOutput = String(data: stdout, encoding: .utf8),
            !rawOutput.isEmpty
        else {
            return nil
        }

        for rawLine in rawOutput.split(whereSeparator: \.isNewline).reversed() {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("{"), line.hasSuffix("}") else {
                continue
            }

            guard
                let jsonData = line.data(using: .utf8),
                let payload = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                (payload["command"] as? String) == "preflight",
                let session = payload["session"] as? [String: Any],
                let manifestPath = session["manifest"] as? String,
                !manifestPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                continue
            }

            let manifestURL = URL(fileURLWithPath: manifestPath).standardizedFileURL
            guard FileManager.default.fileExists(atPath: manifestURL.path) else {
                continue
            }
            return try Data(contentsOf: manifestURL)
        }
        return nil
    }

    private static func defaultPreflightOutputRoot() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("recordit-preflight-live", isDirectory: true)
            .standardizedFileURL
    }
}
