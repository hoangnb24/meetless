import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("model_resolution_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private func makeTempDirectory() -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    let dir = root.appendingPathComponent("recordit-model-resolution-\(UUID().uuidString)", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
        fputs("model_resolution_smoke failed: could not create temp dir: \(error)\n", stderr)
        exit(1)
    }
    return dir
}

@MainActor
private func runSmoke() {
    let tempDir = makeTempDirectory()
    defer { try? FileManager.default.removeItem(at: tempDir) }

    let fileModel = tempDir.appendingPathComponent("ggml-tiny.en.bin")
    let dirModel = tempDir.appendingPathComponent("whisperkit-model", isDirectory: true)
    let bundleResourceRoot = tempDir.appendingPathComponent("RecorditResources", isDirectory: true)
    let bundledWhisperCppModel = bundleResourceRoot
        .appendingPathComponent("runtime/models/whispercpp", isDirectory: true)
        .appendingPathComponent("ggml-tiny.en.bin")
    let repoRelativeWhisperCppModel = tempDir
        .appendingPathComponent("artifacts/bench/models/whispercpp", isDirectory: true)
        .appendingPathComponent("ggml-tiny.en.bin")

    do {
        try Data("recordit-model".utf8).write(to: fileModel)
        try FileManager.default.createDirectory(at: dirModel, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: bundledWhisperCppModel.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: repoRelativeWhisperCppModel.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("bundled-recordit-model".utf8).write(to: bundledWhisperCppModel)
        try Data("repo-relative-recordit-model".utf8).write(to: repoRelativeWhisperCppModel)
    } catch {
        fputs("model_resolution_smoke failed: fixture setup error: \(error)\n", stderr)
        exit(1)
    }

    let resolver = FileSystemModelResolutionService(
        environment: [:],
        currentDirectoryURL: tempDir
    )
    let bundledResolver = FileSystemModelResolutionService(
        environment: [:],
        currentDirectoryURL: tempDir,
        bundleResourceURL: bundleResourceRoot
    )

    let whisperCppResolved: ResolvedModelDTO
    do {
        whisperCppResolved = try resolver.resolveModel(
            ModelResolutionRequest(explicitModelPath: fileModel, backend: "whispercpp")
        )
    } catch {
        check(false, "whispercpp file model should resolve: \(error)")
        return
    }
    check(whisperCppResolved.source == "ui selected path", "explicit model should report ui source")
    check(whisperCppResolved.checksumStatus == "available", "file model should report available checksum")
    check((whisperCppResolved.checksumSHA256?.isEmpty == false), "file model should include checksum hash")

    let bundledWhisperCppResolved: ResolvedModelDTO
    do {
        bundledWhisperCppResolved = try bundledResolver.resolveModel(
            ModelResolutionRequest(explicitModelPath: nil, backend: "whispercpp")
        )
    } catch {
        check(false, "bundled whispercpp model should resolve by default: \(error)")
        return
    }
    check(bundledWhisperCppResolved.source == "backend default", "bundled default model should report backend default source")
    check(
        bundledWhisperCppResolved.resolvedPath == bundledWhisperCppModel,
        "bundled default model should resolve from deterministic runtime bundle path"
    )

    do {
        _ = try resolver.resolveModel(
            ModelResolutionRequest(explicitModelPath: fileModel, backend: "whisperkit")
        )
        check(false, "whisperkit should reject file model path")
    } catch let serviceError as AppServiceError {
        check(serviceError.code == .modelUnavailable, "whisperkit wrong-kind should map to modelUnavailable")
    } catch {
        check(false, "unexpected error for whisperkit wrong-kind path")
    }

    let whisperKitResolved: ResolvedModelDTO
    do {
        whisperKitResolved = try resolver.resolveModel(
            ModelResolutionRequest(explicitModelPath: dirModel, backend: "whisperkit")
        )
    } catch {
        check(false, "whisperkit directory model should resolve: \(error)")
        return
    }
    check(whisperKitResolved.checksumStatus == "unavailable_directory", "directory model should report unavailable_directory checksum status")
    check(whisperKitResolved.checksumSHA256 == nil, "directory model should not include checksum hash")

    do {
        _ = try FileSystemModelResolutionService(
            environment: [:],
            currentDirectoryURL: tempDir,
            bundleResourceURL: bundleResourceRoot.appendingPathComponent("MissingResources", isDirectory: true)
        ).resolveModel(ModelResolutionRequest(explicitModelPath: nil, backend: "whispercpp"))
        check(false, "missing bundled/default whispercpp model should fail")
    } catch let serviceError as AppServiceError {
        check(
            serviceError.debugDetail?.contains(repoRelativeWhisperCppModel.path) == false,
            "app-bundled lookup should not fall back to repo-relative whispercpp models"
        )
        check(serviceError.code == .modelUnavailable, "missing bundled/default model should map to modelUnavailable")
        check(
            serviceError.remediation.contains("runtime/models/whispercpp/ggml-tiny.en.bin"),
            "missing bundled/default model remediation should name the deterministic bundle path"
        )
        check(
            serviceError.debugDetail?.contains("runtime/models/whispercpp/ggml-tiny.en.bin") == true,
            "missing bundled/default model debug detail should include attempted bundle lookup path"
        )
    } catch {
        check(false, "unexpected error for missing bundled/default whispercpp model")
    }

    let missingPath = tempDir.appendingPathComponent("missing-model.bin")
    do {
        _ = try resolver.resolveModel(
            ModelResolutionRequest(explicitModelPath: missingPath, backend: "whispercpp")
        )
        check(false, "missing explicit path should fail")
    } catch let serviceError as AppServiceError {
        check(serviceError.code == .modelUnavailable, "missing explicit path should map to modelUnavailable")
    } catch {
        check(false, "unexpected error for missing explicit path")
    }

    let viewModel = ModelSetupViewModel(modelResolutionService: resolver)
    viewModel.chooseBackend("whispercpp")
    viewModel.chooseExistingModelPath(fileModel)
    check(viewModel.canStartLiveTranscribe, "valid whispercpp file path should enable live transcribe")
    check(viewModel.diagnostics?.asrModelSource == "ui selected path", "diagnostics should surface model source")
    check(viewModel.diagnostics?.asrModelChecksumStatus == "available", "diagnostics should surface checksum status")

    viewModel.chooseBackend("whisperkit")
    check(viewModel.selectedBackend == "whispercpp", "advanced/manual backend should not replace selected backend")
    check(!viewModel.canStartLiveTranscribe, "advanced/manual backend should not be startable from standard setup")
    if case let .invalid(error) = viewModel.state {
        check(error.code == .invalidInput, "advanced/manual backend should report invalidInput")
        check(error.userMessage.contains("not available"), "advanced/manual backend should use plain-language unavailability copy")
        check(error.remediation.contains("advanced/manual"), "advanced/manual backend should explain the narrowed v1 path")
    } else {
        check(false, "advanced/manual backend should produce invalid state")
    }

    let originalBackend = viewModel.selectedBackend
    viewModel.chooseBackend("moonshine")
    check(viewModel.selectedBackend == originalBackend, "unsupported backend should not replace selected backend")
    check(!viewModel.canStartLiveTranscribe, "unsupported backend should not be startable")
    if case let .invalid(error) = viewModel.state {
        check(error.code == .invalidInput, "unsupported backend should report invalidInput")
        check(error.userMessage.contains("not available"), "unsupported backend message should be plain-language")
    } else {
        check(false, "unsupported backend should produce invalid state")
    }

    let selectableBackends = Set(ModelSetupViewModel.selectableBackends)
    check(selectableBackends.contains("whispercpp"), "whispercpp should remain selectable")
    check(!selectableBackends.contains("whisperkit"), "whisperkit should stay out of the standard selectable setup list")
    check(!selectableBackends.contains("moonshine"), "unsupported backends should not be selectable")
}

@main
struct ModelResolutionSmokeMain {
    static func main() async {
        await MainActor.run {
            runSmoke()
        }
        print("model_resolution_smoke: PASS")
    }
}
