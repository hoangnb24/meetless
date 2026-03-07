import AppKit
import SwiftUI

@MainActor
final class MainSessionController: ObservableObject {
    enum ModeOption: String, CaseIterable, Identifiable {
        case live
        case recordOnly

        var id: String { rawValue }

        var title: String {
            switch self {
            case .live:
                return "Live Transcribe"
            case .recordOnly:
                return "Record Only"
            }
        }

        var runtimeMode: RuntimeMode {
            switch self {
            case .live:
                return .live
            case .recordOnly:
                return .recordOnly
            }
        }
    }

    struct TranscriptEntry: Identifiable {
        let id = UUID()
        let createdAt: Date
        let text: String
    }

    struct FinalizationSummary: Equatable {
        var sessionID: String
        var status: String
        var trustNoticeCount: Int
        var manifestPath: URL
    }

    @Published var selectedMode: ModeOption = .live
    @Published private(set) var runtimeState: RuntimeViewModel.RunState
    @Published private(set) var elapsedLabel = "00:00"
    @Published private(set) var transcriptEntries: [TranscriptEntry] = []
    @Published private(set) var lastServiceError: AppServiceError?
    @Published private(set) var activeOutputRoot: URL?
    @Published private(set) var latestFinalizationSummary: FinalizationSummary?

    private let environment: AppEnvironment
    private let runtimeViewModel: RuntimeViewModel
    private var runningMode: RuntimeMode?
    private var activeRecordOnlyProcessID: Int32?
    private var sessionStartDate: Date?
    private var timerTask: Task<Void, Never>?

    init(environment: AppEnvironment) {
        self.environment = environment
        self.runtimeViewModel = environment.makeRuntimeViewModel()
        self.runtimeState = runtimeViewModel.state
        if ProcessInfo.processInfo.environment["RECORDIT_UI_TEST_DEFAULT_RUNTIME_MODE"] == "record_only" {
            self.selectedMode = .recordOnly
        }
    }

    deinit {
        timerTask?.cancel()
    }

    var canStart: Bool {
        switch runtimeState {
        case .idle, .completed, .failed:
            return true
        case .preparing, .running, .stopping, .finalizing:
            return false
        }
    }

    var canStop: Bool {
        switch runtimeState {
        case .running:
            return true
        case .idle, .preparing, .stopping, .finalizing, .completed, .failed:
            return activeRecordOnlyProcessID != nil
        }
    }

    var statusTitle: String {
        switch runtimeState {
        case .idle:
            return "Idle"
        case .preparing:
            return "Preparing"
        case .running(let pid):
            return "Running (pid \(pid))"
        case .stopping(let pid):
            return "Stopping (pid \(pid))"
        case .finalizing:
            return "Finalizing"
        case .completed:
            return "Completed"
        case .failed(let error):
            return "Failed (\(error.code.rawValue))"
        }
    }

    var statusColor: Color {
        switch runtimeState {
        case .idle, .completed:
            return .gray
        case .preparing, .stopping, .finalizing:
            return .orange
        case .running:
            return .green
        case .failed:
            return .red
        }
    }

    var recoveryActionsSummary: String {
        let actions = runtimeViewModel.suggestedRecoveryActions
        guard !actions.isEmpty else {
            return ""
        }
        return actions.map(\.rawValue).joined(separator: ", ")
    }

    var recoveryActions: [RuntimeViewModel.RecoveryAction] {
        runtimeViewModel.suggestedRecoveryActions
    }

    var interruptionRecoveryContext: RuntimeViewModel.InterruptionRecoveryContext? {
        runtimeViewModel.interruptionRecoveryContext
    }

    func startSession() {
        guard canStart else { return }

        let outputRoot = makeSessionOutputRoot(mode: selectedMode.runtimeMode)
        activeOutputRoot = outputRoot
        runningMode = selectedMode.runtimeMode
        lastServiceError = nil
        latestFinalizationSummary = nil
        appendTranscript("Start requested for \(selectedMode.title) at \(outputRoot.path).")
        startTimer()

        switch selectedMode {
        case .live:
            PermissionPromptRequester.requestAccessIfNeeded(for: .screenRecording)
            PermissionPromptRequester.requestAccessIfNeeded(for: .microphone)
            runtimeState = .preparing
            Task {
                await runtimeViewModel.startLive(outputRoot: outputRoot, explicitModelPath: nil)
                await MainActor.run {
                    syncFromRuntimeViewModel(eventPrefix: "Live start")
                }
            }
        case .recordOnly:
            runtimeState = .preparing
            Task {
                do {
                    let launch = try await environment.runtimeService.startSession(
                        request: RuntimeStartRequest(
                            mode: .recordOnly,
                            outputRoot: outputRoot
                        )
                    )
                    await MainActor.run {
                        activeRecordOnlyProcessID = launch.processIdentifier
                        runtimeState = .running(processID: launch.processIdentifier)
                        appendTranscript("Record-only session started (pid \(launch.processIdentifier)).")
                    }
                } catch let serviceError as AppServiceError {
                    await MainActor.run {
                        runtimeState = .failed(serviceError)
                        lastServiceError = serviceError
                        appendTranscript("Record-only start failed: \(serviceError.userMessage)")
                        stopTimer(reset: false)
                    }
                } catch {
                    await MainActor.run {
                        let wrapped = AppServiceError(
                            code: .unknown,
                            userMessage: "Record-only session failed to start.",
                            remediation: "Verify runtime readiness and retry.",
                            debugDetail: String(describing: error)
                        )
                        runtimeState = .failed(wrapped)
                        lastServiceError = wrapped
                        appendTranscript("Record-only start failed: \(wrapped.userMessage)")
                        stopTimer(reset: false)
                    }
                }
            }
        }
    }

    func stopSession() {
        guard canStop else { return }

        if runningMode == .recordOnly, let processID = activeRecordOnlyProcessID {
            runtimeState = .stopping(processID: processID)
            appendTranscript("Stop requested for record-only session (pid \(processID)).")
            Task {
                do {
                    _ = try await environment.runtimeService.controlSession(
                        processIdentifier: processID,
                        action: .stop
                    )
                    await MainActor.run {
                        activeRecordOnlyProcessID = nil
                        runtimeState = .completed
                        refreshFinalizationSummary()
                        appendTranscript("Record-only session stopped and finalized.")
                        stopTimer(reset: false)
                    }
                } catch let serviceError as AppServiceError {
                    await MainActor.run {
                        runtimeState = .failed(serviceError)
                        lastServiceError = serviceError
                        refreshFinalizationSummary()
                        appendTranscript("Record-only stop failed: \(serviceError.userMessage)")
                        stopTimer(reset: false)
                    }
                } catch {
                    await MainActor.run {
                        let wrapped = AppServiceError(
                            code: .unknown,
                            userMessage: "Could not stop record-only session.",
                            remediation: "Retry stop and inspect runtime diagnostics.",
                            debugDetail: String(describing: error)
                        )
                        runtimeState = .failed(wrapped)
                        lastServiceError = wrapped
                        refreshFinalizationSummary()
                        appendTranscript("Record-only stop failed: \(wrapped.userMessage)")
                        stopTimer(reset: false)
                    }
                }
            }
            return
        }

        appendTranscript("Stop requested for live session.")
        Task {
            await runtimeViewModel.stopCurrentRun()
            await MainActor.run {
                syncFromRuntimeViewModel(eventPrefix: "Live stop")
            }
        }
    }

    private func syncFromRuntimeViewModel(eventPrefix: String) {
        runtimeState = runtimeViewModel.state

        if let rejected = runtimeViewModel.lastRejectedActionError {
            lastServiceError = rejected
            appendTranscript("\(eventPrefix) rejected: \(rejected.userMessage)")
        }

        switch runtimeState {
        case .running(let pid):
            appendTranscript("\(eventPrefix) succeeded; runtime running (pid \(pid)).")
        case .completed:
            refreshFinalizationSummary()
            appendTranscript("\(eventPrefix) completed successfully.")
            stopTimer(reset: false)
            activeRecordOnlyProcessID = nil
        case .failed(let error):
            lastServiceError = error
            refreshFinalizationSummary()
            appendTranscript("\(eventPrefix) failed: \(error.userMessage)")
            stopTimer(reset: false)
            activeRecordOnlyProcessID = nil
        case .preparing, .stopping, .finalizing, .idle:
            break
        }
    }

    func resumeInterruptedSession() {
        Task {
            await runtimeViewModel.resumeInterruptedSession(explicitModelPath: nil)
            await MainActor.run {
                syncFromRuntimeViewModel(eventPrefix: "Resume session")
            }
        }
    }

    func safeFinalizeInterruptedSession() {
        Task {
            runtimeViewModel.safeFinalizeInterruptedSession()
            await MainActor.run {
                syncFromRuntimeViewModel(eventPrefix: "Safe finalize")
            }
        }
    }

    func retryStopFailedLiveSession() {
        Task {
            await runtimeViewModel.retryStopAfterFailure()
            await MainActor.run {
                syncFromRuntimeViewModel(eventPrefix: "Retry stop")
            }
        }
    }

    func retryFinalizeFailedSession() {
        Task {
            runtimeViewModel.retryFinalizeAfterFailure()
            await MainActor.run {
                syncFromRuntimeViewModel(eventPrefix: "Retry finalize")
            }
        }
    }

    func openCurrentSessionArtifacts() {
        guard let activeOutputRoot else {
            return
        }
        NSWorkspace.shared.open(activeOutputRoot)
    }

    private func refreshFinalizationSummary() {
        guard let activeOutputRoot else {
            latestFinalizationSummary = nil
            return
        }
        let manifestPath = activeOutputRoot.appendingPathComponent("session.manifest.json")
        let loadedManifest = try? environment.manifestService.loadManifest(at: manifestPath)
        if let loadedManifest {
            latestFinalizationSummary = FinalizationSummary(
                sessionID: loadedManifest.sessionID,
                status: loadedManifest.status,
                trustNoticeCount: loadedManifest.trustNoticeCount,
                manifestPath: loadedManifest.artifacts.manifestPath
            )
            return
        }

        let fallbackSessionID = activeOutputRoot.lastPathComponent
        let fallbackStatus: String
        switch runtimeState {
        case .completed:
            fallbackStatus = "ok"
        case .failed:
            fallbackStatus = "failed"
        case .idle, .preparing, .running, .stopping, .finalizing:
            fallbackStatus = "pending"
        }
        latestFinalizationSummary = FinalizationSummary(
            sessionID: fallbackSessionID,
            status: fallbackStatus,
            trustNoticeCount: 0,
            manifestPath: manifestPath
        )
    }

    private func startTimer() {
        timerTask?.cancel()
        sessionStartDate = Date()
        elapsedLabel = "00:00"
        timerTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, let start = self.sessionStartDate else {
                    continue
                }
                let elapsed = Int(Date().timeIntervalSince(start))
                self.elapsedLabel = Self.formatElapsed(seconds: elapsed)
            }
        }
    }

    private func stopTimer(reset: Bool) {
        timerTask?.cancel()
        timerTask = nil
        sessionStartDate = nil
        if reset {
            elapsedLabel = "00:00"
        }
    }

    private func appendTranscript(_ text: String) {
        transcriptEntries.append(TranscriptEntry(createdAt: Date(), text: text))
        if transcriptEntries.count > 300 {
            transcriptEntries.removeFirst(transcriptEntries.count - 300)
        }
    }

    private func makeSessionOutputRoot(mode: RuntimeMode) -> URL {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = formatter.string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recordit-ui-sessions", isDirectory: true)
            .appendingPathComponent("\(timestamp)-\(mode.rawValue)", isDirectory: true)

        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private static func formatElapsed(seconds: Int) -> String {
        let minutes = seconds / 60
        let remainingSeconds = seconds % 60
        return String(format: "%02d:%02d", minutes, remainingSeconds)
    }
}

struct MainSessionView: View {
    @ObservedObject var controller: MainSessionController

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text("Main Session")
                    .font(.headline)

                Capsule()
                    .fill(controller.statusColor)
                    .frame(width: 10, height: 10)

                Text(controller.statusTitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("runtime_status")

                Spacer()

                Text("Elapsed: \(controller.elapsedLabel)")
                    .font(.system(.body, design: .monospaced))
            }

            Picker("Mode", selection: $controller.selectedMode) {
                ForEach(MainSessionController.ModeOption.allCases) { option in
                    Text(option.title).tag(option)
                }
            }
            .pickerStyle(.segmented)

            HStack(spacing: 12) {
                Button("Start") {
                    controller.startSession()
                }
                .buttonStyle(.borderedProminent)
                .disabled(!controller.canStart)
                .keyboardShortcut(.return, modifiers: [.command])
                .accessibilityIdentifier("start_live_transcribe")

                Button("Stop") {
                    controller.stopSession()
                }
                .buttonStyle(.bordered)
                .disabled(!controller.canStop)
                .keyboardShortcut(".", modifiers: [.command])
                .accessibilityIdentifier("stop_live_transcribe")
            }

            if let outputRoot = controller.activeOutputRoot {
                Text("Output root: \(outputRoot.path)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            if let error = controller.lastServiceError {
                VStack(alignment: .leading, spacing: 4) {
                    Text(error.userMessage)
                        .foregroundStyle(.red)
                    Text(error.remediation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if !controller.recoveryActionsSummary.isEmpty {
                Text("Recovery actions: \(controller.recoveryActionsSummary)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Transcript")
                    .font(.headline)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(controller.transcriptEntries) { entry in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.createdAt, style: .time)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(entry.text)
                                    .font(.body)
                                    .textSelection(.enabled)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .frame(minHeight: 220)
                .background(.quinary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }
}
