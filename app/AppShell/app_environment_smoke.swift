import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("app_environment_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private struct FailingModelResolutionService: ModelResolutionService {
    func resolveModel(_ request: ModelResolutionRequest) throws -> ResolvedModelDTO {
        throw AppServiceError(
            code: .modelUnavailable,
            userMessage: "Model is missing.",
            remediation: "Choose a valid local model path.",
            debugDetail: "backend=\(request.backend)"
        )
    }
}

private struct StubStartupMigrationRepairService: StartupMigrationRepairing {
    let report: StartupMigrationRepairReport

    func runRepair() -> StartupMigrationRepairReport {
        report
    }
}

private func makeExecutable(at path: String) {
    FileManager.default.createFile(atPath: path, contents: Data([35,33,47,98,105,110,47,115,104,10,101,120,105,116,32,48,10]))
    _ = chmod(path, 0o755)
}

@MainActor
private func runSmoke() async {
    let preview = AppEnvironment.preview()
    let runtimeViewModel = preview.makeRuntimeViewModel()
    let outputRoot = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("recordit-preview-smoke-\(UUID().uuidString)")

    await runtimeViewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
    if case let .running(processID) = runtimeViewModel.state {
        check(processID == 42, "preview runtime should use mock process id")
    } else {
        check(false, "preview runtime should transition to running using mock runtime service")
    }

    let failing = preview.replacing(modelService: FailingModelResolutionService())
    let failingRuntimeViewModel = failing.makeRuntimeViewModel()
    await failingRuntimeViewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
    if case let .failed(error) = failingRuntimeViewModel.state {
        check(error.code == .modelUnavailable, "override model service should drive failure path")
    } else {
        check(false, "runtime should fail when overridden model service fails")
    }

    let preflightViewModel = preview.makePreflightViewModel()
    preflightViewModel.runLivePreflight()
    if case let .completed(envelope) = preflightViewModel.state {
        check(envelope.kind == "transcribe-live-preflight", "preview preflight should use fixture envelope")
    } else {
        check(false, "preview preflight should complete without spawning external binaries")
    }

    let startupReport = StartupMigrationRepairReport(
        indexPath: URL(fileURLWithPath: "/tmp/index.json"),
        startedAt: Date(timeIntervalSince1970: 1),
        completedAt: Date(timeIntervalSince1970: 2),
        timeBudgetSeconds: 1.0,
        didExceedTimeBudget: false,
        sessionCountScanned: 3,
        staleIndexEntryCount: 1,
        missingIndexEntryCount: 2,
        legacyImportCount: 1,
        truncatedSessionCount: 0,
        queryableAfterRepair: true,
        failureMessages: []
    )
    let repairedEnvironment = preview.replacing(
        startupMigrationRepairService: StubStartupMigrationRepairService(report: startupReport)
    )
    let syncReport = repairedEnvironment.runStartupMigrationRepair()
    check(syncReport?.sessionCountScanned == 3, "startup repair should run through environment")

    let asyncReport = await repairedEnvironment.scheduleStartupMigrationRepair().value
    check(asyncReport?.legacyImportCount == 1, "async startup repair should preserve report values")


    let productionRoot = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("recordit-production-bootstrap-smoke-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: productionRoot) }
    try? FileManager.default.createDirectory(at: productionRoot, withIntermediateDirectories: true)

    let bundledResources = productionRoot.appendingPathComponent("RecorditResources", isDirectory: true)
    let runtimeBin = bundledResources.appendingPathComponent("runtime/bin", isDirectory: true)
    let bundledModel = bundledResources
        .appendingPathComponent("runtime/models/whispercpp", isDirectory: true)
        .appendingPathComponent("ggml-tiny.en.bin")
    let repoRelativeWhisperCppModel = productionRoot
        .appendingPathComponent("artifacts/bench/models/whispercpp", isDirectory: true)
        .appendingPathComponent("ggml-tiny.en.bin")
    try? FileManager.default.createDirectory(at: runtimeBin, withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: bundledModel.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: repoRelativeWhisperCppModel.deletingLastPathComponent(), withIntermediateDirectories: true)
    makeExecutable(at: runtimeBin.appendingPathComponent("recordit").path)
    makeExecutable(at: runtimeBin.appendingPathComponent("sequoia_capture").path)
    try? Data("bundled-model".utf8).write(to: bundledModel)
    try? Data("repo-relative-model".utf8).write(to: repoRelativeWhisperCppModel)

    var startupLogs: [StartupSelfCheckLogRecord] = []
    let readyEnvironment = AppEnvironment.production(
        processEnvironment: ["PATH": "/usr/bin:/bin"],
        currentDirectoryURL: productionRoot,
        bundleResourceURL: bundledResources,
        startupSelfCheckLogger: { startupLogs.append($0) }
    )
    check(startupLogs.count == 1, "production bootstrap should emit exactly one startup self-check log")
    if let startupLog = startupLogs.first {
        check(startupLog.selectedBackend == "whispercpp", "startup log should record whispercpp backend")
        check(startupLog.selectedBackendSource == "v1_default", "startup log should record backend source")
        check(startupLog.runtimeReady, "startup log should report ready runtime binaries")
        check(startupLog.liveTranscribeAvailable, "startup log should mark live transcribe available when runtime and model are ready")
        check(startupLog.recordOnlyAvailable, "startup log should mark Record Only available when sequoia_capture is ready")
        check(startupLog.readinessImplication == .liveReady, "startup log should mark live_ready implication")
        check(startupLog.modelSelection.status == .ready, "startup log should record a ready model selection")
        check(startupLog.modelSelection.source == "backend default", "startup log should preserve model source")
        check(startupLog.modelSelection.resolvedPath == bundledModel.path, "startup log should resolve bundled model path instead of repo-relative fallback")
        check(startupLog.preflightEnvironment.pathConfigured, "startup log should report preflight PATH configuration")
        check(startupLog.preflightEnvironment.recorditASRModelConfigured, "startup log should report preflight model configuration")
        check(startupLog.runtimeChecks.contains(where: { $0.binaryName == "recordit" && $0.status == "ready" }), "startup log should include ready recordit binary")
        check(startupLog.runtimeChecks.contains(where: { $0.binaryName == "sequoia_capture" && $0.status == "ready" }), "startup log should include ready sequoia_capture binary")
    } else {
        check(false, "expected startup log payload")
    }

    do {
        let resolvedDefaultModel = try readyEnvironment.modelService.resolveModel(
            ModelResolutionRequest(explicitModelPath: nil, backend: "whispercpp")
        )
        check(resolvedDefaultModel.resolvedPath == bundledModel, "production model service should resolve bundled model path")
        check(resolvedDefaultModel.resolvedPath != repoRelativeWhisperCppModel, "production model service should not leak repo-relative model fallback when bundle resources are present")
    } catch {
        check(false, "production model service should resolve bundled model by default: \(error)")
    }

    let runtimeOnlyResources = productionRoot.appendingPathComponent("RuntimeOnlyResources", isDirectory: true)
    let runtimeOnlyBin = runtimeOnlyResources.appendingPathComponent("runtime/bin", isDirectory: true)
    try? FileManager.default.createDirectory(at: runtimeOnlyBin, withIntermediateDirectories: true)
    makeExecutable(at: runtimeOnlyBin.appendingPathComponent("recordit").path)
    makeExecutable(at: runtimeOnlyBin.appendingPathComponent("sequoia_capture").path)

    var blockedLogs: [StartupSelfCheckLogRecord] = []
    _ = AppEnvironment.production(
        processEnvironment: ["PATH": "/usr/bin:/bin"],
        currentDirectoryURL: productionRoot,
        bundleResourceURL: runtimeOnlyResources,
        startupSelfCheckLogger: { blockedLogs.append($0) }
    )
    check(blockedLogs.count == 1, "model-blocked bootstrap should still emit startup self-check log")
    if let blockedLog = blockedLogs.first {
        check(blockedLog.runtimeReady, "model-blocked startup should still report runtime ready")
        check(!blockedLog.liveTranscribeAvailable, "model-blocked startup should not mark live transcribe available")
        check(blockedLog.recordOnlyAvailable, "model-blocked startup should keep Record Only available")
        check(blockedLog.readinessImplication == .liveBlockedModel, "model-blocked startup should mark live_blocked_model implication")
        check(blockedLog.modelSelection.status == .unavailable, "model-blocked startup should record unavailable model selection")
        check(blockedLog.modelSelection.errorCode == AppServiceErrorCode.modelUnavailable.rawValue, "model-blocked startup should record modelUnavailable error code")
        check(!blockedLog.preflightEnvironment.recorditASRModelConfigured, "model-blocked startup should not configure preflight model path")
        check(blockedLog.modelSelection.resolvedPath == nil, "model-blocked startup should not silently fall back to repo-relative model paths")
    } else {
        check(false, "expected blocked startup log payload")
    }


    let modelOnlyResources = productionRoot.appendingPathComponent("ModelOnlyResources", isDirectory: true)
    let modelOnlyPath = modelOnlyResources
        .appendingPathComponent("runtime/models/whispercpp", isDirectory: true)
        .appendingPathComponent("ggml-tiny.en.bin")
    try? FileManager.default.createDirectory(at: modelOnlyPath.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? Data("bundled-model".utf8).write(to: modelOnlyPath)

    var runtimeBlockedLogs: [StartupSelfCheckLogRecord] = []
    _ = AppEnvironment.production(
        processEnvironment: ["PATH": "/usr/bin:/bin"],
        currentDirectoryURL: productionRoot,
        bundleResourceURL: modelOnlyResources,
        startupSelfCheckLogger: { runtimeBlockedLogs.append($0) }
    )
    check(runtimeBlockedLogs.count == 1, "runtime-blocked bootstrap should emit startup self-check log")
    if let runtimeBlockedLog = runtimeBlockedLogs.first {
        check(!runtimeBlockedLog.runtimeReady, "runtime-blocked startup should report runtime not ready")
        check(!runtimeBlockedLog.liveTranscribeAvailable, "runtime-blocked startup should not mark live transcribe available")
        check(!runtimeBlockedLog.recordOnlyAvailable, "runtime-blocked startup should not mark Record Only available when runtime binary is missing")
        check(runtimeBlockedLog.readinessImplication == .liveBlockedRuntime, "runtime-blocked startup should mark live_blocked_runtime implication")
        check(runtimeBlockedLog.modelSelection.status == .ready, "runtime-blocked startup should still resolve bundled model when present")
        check(runtimeBlockedLog.runtimeChecks.contains(where: { $0.binaryName == "recordit" && $0.status == "missing" }), "runtime-blocked startup should include missing recordit binary")
    } else {
        check(false, "expected runtime-blocked startup log payload")
    }
}

@main
struct AppEnvironmentSmokeMain {
    static func main() async {
        await runSmoke()
        print("app_environment_smoke: PASS")
    }
}
