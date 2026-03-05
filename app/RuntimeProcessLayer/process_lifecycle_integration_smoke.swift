import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("process_lifecycle_integration_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private struct StaticBinaryResolver: RuntimeBinaryResolving {
    let binaries: RuntimeBinarySet

    func resolve() throws -> RuntimeBinarySet {
        binaries
    }
}

private struct StaticModelService: ModelResolutionService {
    func resolveModel(_ request: ModelResolutionRequest) throws -> ResolvedModelDTO {
        _ = request
        return ResolvedModelDTO(
            resolvedPath: URL(fileURLWithPath: "/tmp/model.bin"),
            source: "integration-smoke",
            checksumSHA256: nil,
            checksumStatus: "available"
        )
    }
}

private struct PresenceCheckedManifestService: ManifestService {
    let status: String

    func loadManifest(at manifestPath: URL) throws -> SessionManifestDTO {
        guard FileManager.default.fileExists(atPath: manifestPath.path) else {
            throw AppServiceError(
                code: .artifactMissing,
                userMessage: "Manifest missing.",
                remediation: "Retry after manifest is written."
            )
        }

        let root = manifestPath.deletingLastPathComponent()
        return SessionManifestDTO(
            sessionID: root.lastPathComponent,
            status: status,
            runtimeMode: "live",
            trustNoticeCount: 0,
            artifacts: SessionArtifactsDTO(
                wavPath: root.appendingPathComponent("session.wav"),
                jsonlPath: root.appendingPathComponent("session.jsonl"),
                manifestPath: manifestPath
            )
        )
    }
}

private func makeExecutableScript(at url: URL, body: String) throws {
    try body.write(to: url, atomically: true, encoding: .utf8)
    guard chmod(url.path, 0o755) == 0 else {
        throw AppServiceError(
            code: .ioFailure,
            userMessage: "Could not mark script as executable.",
            remediation: "Check filesystem permissions.",
            debugDetail: url.path
        )
    }
}

private func makeRuntimeService(
    recorditPath: URL,
    sequoiaPath: URL,
    stopTimeoutSeconds: TimeInterval = 1
) -> ProcessBackedRuntimeService {
    let resolver = StaticBinaryResolver(
        binaries: RuntimeBinarySet(recordit: recorditPath, sequoiaCapture: sequoiaPath)
    )
    let manager = RuntimeProcessManager(binaryResolver: resolver)
    return ProcessBackedRuntimeService(
        processManager: manager,
        pendingSidecarService: FileSystemPendingSessionSidecarService(),
        stopTimeoutSeconds: stopTimeoutSeconds,
        pendingSidecarStopTimeoutSeconds: 0.2
    )
}

@MainActor
private func runSmoke() async throws {
    let tempRoot = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("recordit-process-lifecycle-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)

    let binDir = tempRoot.appendingPathComponent("bin", isDirectory: true)
    try FileManager.default.createDirectory(at: binDir, withIntermediateDirectories: true)

    let liveScript = binDir.appendingPathComponent("recordit-live.sh")
    try makeExecutableScript(
        at: liveScript,
        body: """
        #!/bin/sh
        out_root=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --output-root) out_root="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        [ -n "$out_root" ] && mkdir -p "$out_root"
        trap 'exit 0' INT TERM
        while :; do :; done
        """
    )

    let crashScript = binDir.appendingPathComponent("recordit-crash.sh")
    try makeExecutableScript(
        at: crashScript,
        body: """
        #!/bin/sh
        exit 17
        """
    )

    let stubbornScript = binDir.appendingPathComponent("recordit-stubborn.sh")
    try makeExecutableScript(
        at: stubbornScript,
        body: """
        #!/bin/sh
        trap '' INT TERM
        while :; do :; done
        """
    )

    let captureScript = binDir.appendingPathComponent("sequoia-capture.sh")
    try makeExecutableScript(
        at: captureScript,
        body: """
        #!/bin/sh
        wav_path="$2"
        mkdir -p "$(dirname "$wav_path")"
        : > "$wav_path"
        trap 'exit 0' INT TERM
        while :; do :; done
        """
    )

    let modelService = StaticModelService()

    // Live start/stop/finalize success with manifest presence.
    do {
        let processService = makeRuntimeService(recorditPath: liveScript, sequoiaPath: captureScript)
        let outputRoot = tempRoot.appendingPathComponent("live-success", isDirectory: true)
        try FileManager.default.createDirectory(at: outputRoot, withIntermediateDirectories: true)
        let manifestPath = outputRoot.appendingPathComponent("session.manifest.json")
        try "{}".write(to: manifestPath, atomically: true, encoding: .utf8)

        let viewModel = RuntimeViewModel(
            runtimeService: processService,
            manifestService: PresenceCheckedManifestService(status: "ok"),
            modelService: modelService,
            finalizationTimeoutSeconds: 1,
            finalizationPollIntervalNanoseconds: 10_000_000
        )

        await viewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
        guard case let .running(processID) = viewModel.state else {
            check(false, "live start should reach running state before finalization")
            return
        }
        viewModel.loadFinalStatus(manifestPath: manifestPath)
        check(
            viewModel.state == .completed,
            "live lifecycle should complete when manifest is present with ok status (state=\(String(describing: viewModel.state)))"
        )
        check(FileManager.default.fileExists(atPath: manifestPath.path), "manifest should remain present after finalization")
        _ = try? await processService.controlSession(processIdentifier: processID, action: .cancel)
    }

    // Live finalization should fail when manifest status is failed.
    do {
        let processService = makeRuntimeService(recorditPath: liveScript, sequoiaPath: captureScript)
        let outputRoot = tempRoot.appendingPathComponent("live-failed-manifest", isDirectory: true)
        try FileManager.default.createDirectory(at: outputRoot, withIntermediateDirectories: true)
        let manifestPath = outputRoot.appendingPathComponent("session.manifest.json")
        try "{}".write(to: manifestPath, atomically: true, encoding: .utf8)

        let viewModel = RuntimeViewModel(
            runtimeService: processService,
            manifestService: PresenceCheckedManifestService(status: "failed"),
            modelService: modelService,
            finalizationTimeoutSeconds: 1,
            finalizationPollIntervalNanoseconds: 10_000_000
        )

        await viewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
        guard case let .running(processID) = viewModel.state else {
            check(false, "live start should reach running state before failed finalization mapping")
            return
        }
        viewModel.loadFinalStatus(manifestPath: manifestPath)
        guard case let .failed(error) = viewModel.state else {
            check(false, "failed manifest status should map to failed runtime state")
            return
        }
        check(error.code == .processExitedUnexpectedly, "failed manifest status should classify as processExitedUnexpectedly")
        _ = try? await processService.controlSession(processIdentifier: processID, action: .cancel)
    }

    // Record-only lifecycle should initialize pending sidecar and allow cancel control.
    do {
        let service = makeRuntimeService(recorditPath: liveScript, sequoiaPath: captureScript)
        let outputRoot = tempRoot.appendingPathComponent("record-only", isDirectory: true)
        try FileManager.default.createDirectory(at: outputRoot, withIntermediateDirectories: true)

        let launch = try await service.startSession(
            request: RuntimeStartRequest(
                mode: .recordOnly,
                outputRoot: outputRoot,
                inputWav: nil,
                modelPath: nil
            )
        )
        let sidecarPath = outputRoot.appendingPathComponent("session.pending.json")
        check(FileManager.default.fileExists(atPath: sidecarPath.path), "record-only launch should write pending sidecar")
        let sidecarData = try Data(contentsOf: sidecarPath)
        let sidecarJson = try JSONSerialization.jsonObject(with: sidecarData) as? [String: Any]
        check(sidecarJson?["mode"] as? String == "record_only", "pending sidecar mode should be record_only")
        check(sidecarJson?["transcription_state"] as? String == "pending_model", "pending sidecar should default to pending_model without explicit model path")

        let control = try await service.controlSession(
            processIdentifier: launch.processIdentifier,
            action: .cancel
        )
        check(control.accepted, "record-only cancel should be accepted")
    }

    // Crash branch should map to processExitedUnexpectedly.
    do {
        let service = makeRuntimeService(recorditPath: crashScript, sequoiaPath: captureScript)
        let outputRoot = tempRoot.appendingPathComponent("live-crash", isDirectory: true)
        try FileManager.default.createDirectory(at: outputRoot, withIntermediateDirectories: true)
        let launch = try await service.startSession(
            request: RuntimeStartRequest(mode: .live, outputRoot: outputRoot)
        )
        try? await Task.sleep(nanoseconds: 100_000_000)

        do {
            _ = try await service.controlSession(processIdentifier: launch.processIdentifier, action: .stop)
            check(false, "crash branch should throw processExitedUnexpectedly")
        } catch let serviceError as AppServiceError {
            check(serviceError.code == .processExitedUnexpectedly, "crash branch should classify as processExitedUnexpectedly")
        }
    }

    // Timeout branch should map to timeout.
    do {
        let service = makeRuntimeService(
            recorditPath: stubbornScript,
            sequoiaPath: captureScript,
            stopTimeoutSeconds: 0.2
        )
        let outputRoot = tempRoot.appendingPathComponent("live-timeout", isDirectory: true)
        try FileManager.default.createDirectory(at: outputRoot, withIntermediateDirectories: true)
        let launch = try await service.startSession(
            request: RuntimeStartRequest(mode: .live, outputRoot: outputRoot)
        )

        do {
            _ = try await service.controlSession(processIdentifier: launch.processIdentifier, action: .stop)
            check(false, "timeout branch should throw timeout")
        } catch let serviceError as AppServiceError {
            check(serviceError.code == .timeout, "timeout branch should classify as timeout")
        }
    }
}

@main
struct ProcessLifecycleIntegrationSmokeMain {
    static func main() async {
        do {
            try await runSmoke()
            print("process_lifecycle_integration_smoke: PASS")
        } catch {
            fputs("process_lifecycle_integration_smoke failed: \(error)\n", stderr)
            exit(1)
        }
    }
}
