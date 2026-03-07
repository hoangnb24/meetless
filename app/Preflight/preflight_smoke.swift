import Foundation

private final class StubCommandRunner: CommandRunning {
    private let result: CommandExecutionResult
    private(set) var receivedExecutable: String?
    private(set) var receivedArguments: [String] = []
    private(set) var receivedEnvironment: [String: String] = [:]

    init(result: CommandExecutionResult) {
        self.result = result
    }

    func run(
        executable: String,
        arguments: [String],
        environment: [String: String]
    ) throws -> CommandExecutionResult {
        receivedExecutable = executable
        receivedArguments = arguments
        receivedEnvironment = environment
        return result
    }
}

@MainActor
private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("preflight_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private func encodedData(_ payload: [String: Any]) -> Data {
    do {
        return try JSONSerialization.data(withJSONObject: payload, options: [])
    } catch {
        fputs("preflight_smoke failed: could not encode fixture JSON: \(error)\n", stderr)
        exit(1)
    }
}

private func validEnvelopeData() -> Data {
    encodedData([
        "schema_version": "1",
        "kind": "transcribe-live-preflight",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "WARN",
        "config": [
            "out_wav": "/tmp/session.wav",
            "out_jsonl": "/tmp/session.jsonl",
            "out_manifest": "/tmp/session.manifest.json",
            "asr_backend": "whispercpp",
            "asr_model_requested": "/tmp/model.bin",
            "asr_model_resolved": "/tmp/model.bin",
            "asr_model_source": "cli",
            "sample_rate_hz": 48000
        ],
        "checks": [
            [
                "id": "permissions",
                "status": "PASS",
                "detail": "all permissions present",
                "remediation": NSNull()
            ],
            [
                "id": "model",
                "status": "WARN",
                "detail": "model checksum unavailable",
                "remediation": "run model doctor"
            ]
        ]
    ])
}

private func writeTempManifest(_ data: Data) -> URL {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("recordit-preflight-smoke-\(UUID().uuidString)", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let path = root.appendingPathComponent("session.manifest.json")
        try data.write(to: path, options: .atomic)
        return path
    } catch {
        fputs("preflight_smoke failed: could not write manifest fixture: \(error)\n", stderr)
        exit(1)
    }
}

private func invocationSummaryStdout(manifestPath: URL, exitCode: Int = 2) -> Data {
    let payload = """
    {"command":"preflight","mode":"live","exit_code":\(exitCode),"legacy_args":["--preflight"],"session":{"root":"\(manifestPath.deletingLastPathComponent().path)","input_wav":"\(manifestPath.deletingLastPathComponent().appendingPathComponent("session.input.wav").path)","wav":"\(manifestPath.deletingLastPathComponent().appendingPathComponent("session.wav").path)","jsonl":"\(manifestPath.deletingLastPathComponent().appendingPathComponent("session.jsonl").path)","manifest":"\(manifestPath.path)"}}
    """
    return Data(payload.utf8)
}

@MainActor
private func runSmoke() {
    let parser = PreflightEnvelopeParser()

    let valid: PreflightManifestEnvelopeDTO
    do {
        valid = try parser.parse(data: validEnvelopeData())
    } catch {
        check(false, "valid envelope should parse: \(error)")
        return
    }
    check(valid.kind == "transcribe-live-preflight", "expected valid preflight kind")
    check(valid.schemaVersion == "1", "expected schema_version=1")
    check(valid.checks.count == 2, "expected two decoded checks")

    let wrongKindData = encodedData([
        "schema_version": "1",
        "kind": "transcribe-live-runtime",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "PASS",
        "config": [
            "out_wav": "/tmp/session.wav",
            "out_jsonl": "/tmp/session.jsonl",
            "out_manifest": "/tmp/session.manifest.json",
            "asr_backend": "whispercpp",
            "asr_model_requested": "/tmp/model.bin",
            "asr_model_resolved": "/tmp/model.bin",
            "asr_model_source": "cli",
            "sample_rate_hz": 48000
        ],
        "checks": []
    ])
    do {
        _ = try parser.parse(data: wrongKindData)
        check(false, "wrong kind should fail envelope validation")
    } catch let error as AppServiceError {
        check(error.code == .manifestInvalid, "wrong kind should map to manifestInvalid")
    } catch {
        check(false, "wrong kind emitted unexpected error type")
    }

    let inconsistentOverallStatusData = encodedData([
        "schema_version": "1",
        "kind": "transcribe-live-preflight",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "PASS",
        "config": [
            "out_wav": "/tmp/session.wav",
            "out_jsonl": "/tmp/session.jsonl",
            "out_manifest": "/tmp/session.manifest.json",
            "asr_backend": "whispercpp",
            "asr_model_requested": "/tmp/model.bin",
            "asr_model_resolved": "/tmp/model.bin",
            "asr_model_source": "cli",
            "sample_rate_hz": 48000
        ],
        "checks": [
            [
                "id": "backend_runtime",
                "status": "WARN",
                "detail": "backend helper missing",
                "remediation": "install helper"
            ]
        ]
    ])
    do {
        _ = try parser.parse(data: inconsistentOverallStatusData)
        check(false, "inconsistent overall_status should fail envelope validation")
    } catch let error as AppServiceError {
        check(error.code == .manifestInvalid, "inconsistent overall_status should map to manifestInvalid")
    } catch {
        check(false, "inconsistent overall_status emitted unexpected error type")
    }

    let malformedChecksData = encodedData([
        "schema_version": "1",
        "kind": "transcribe-live-preflight",
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "overall_status": "PASS",
        "config": [
            "out_wav": "/tmp/session.wav",
            "out_jsonl": "/tmp/session.jsonl",
            "out_manifest": "/tmp/session.manifest.json",
            "asr_backend": "whispercpp",
            "asr_model_requested": "/tmp/model.bin",
            "asr_model_resolved": "/tmp/model.bin",
            "asr_model_source": "cli",
            "sample_rate_hz": 48000
        ],
        "checks": [
            [
                "id": "permissions",
                "status": 42,
                "detail": "wrong type",
                "remediation": NSNull()
            ]
        ]
    ])
    do {
        _ = try parser.parse(data: malformedChecksData)
        check(false, "malformed checks should fail decoding")
    } catch let error as AppServiceError {
        check(error.code == .manifestInvalid, "malformed checks should map to manifestInvalid")
    } catch {
        check(false, "malformed checks emitted unexpected error type")
    }

    let stub = StubCommandRunner(
        result: CommandExecutionResult(
            exitCode: 0,
            stdout: validEnvelopeData(),
            stderr: Data()
        )
    )
    let expectedOutputRoot = URL(fileURLWithPath: "/tmp/recordit-preflight-smoke-output", isDirectory: true)
    let runner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: stub,
        parser: parser,
        environment: ["RECORDIT_TEST": "1"],
        preflightOutputRoot: expectedOutputRoot
    )
    let envelope: PreflightManifestEnvelopeDTO
    do {
        envelope = try runner.runLivePreflight()
    } catch {
        check(false, "runner should parse valid envelope: \(error)")
        return
    }
    check(envelope.kind == "transcribe-live-preflight", "runner should return parsed envelope")
    check(stub.receivedExecutable == "/usr/bin/env", "runner should use configured executable")
    check(
        stub.receivedArguments == [
            "recordit",
            "preflight",
            "--mode",
            "live",
            "--output-root",
            expectedOutputRoot.path,
            "--json",
        ],
        "runner should use deterministic recordit preflight args"
    )
    check(stub.receivedEnvironment["RECORDIT_TEST"] == "1", "runner should pass through environment")

    let manifestFixtureURL = writeTempManifest(validEnvelopeData())
    let summaryStub = StubCommandRunner(
        result: CommandExecutionResult(
            exitCode: 2,
            stdout: invocationSummaryStdout(manifestPath: manifestFixtureURL),
            stderr: Data("preflight failed".utf8)
        )
    )
    let summaryRunner = RecorditPreflightRunner(
        executable: "/usr/bin/env",
        commandRunner: summaryStub,
        parser: parser,
        environment: [:]
    )
    do {
        let parsedFromManifest = try summaryRunner.runLivePreflight()
        check(
            parsedFromManifest.kind == "transcribe-live-preflight",
            "runner should load preflight manifest from invocation summary output"
        )
    } catch {
        check(false, "runner should parse preflight manifest from invocation summary: \(error)")
    }
}

@main
struct PreflightSmokeMain {
    @MainActor
    static func main() {
        runSmoke()
        print("preflight_smoke: PASS")
    }
}
