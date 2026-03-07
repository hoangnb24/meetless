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

    struct LiveTranscriptLine: Identifiable {
        let id = UUID()
        let eventType: String
        let channel: String
        let startMs: UInt64
        let endMs: UInt64
        let text: String

        var isPartial: Bool {
            eventType == "partial"
        }

        var formattedTimestamp: String {
            let startSec = Double(startMs) / 1000.0
            let endSec = Double(endMs) / 1000.0
            return String(format: "[%02d:%06.3f-%02d:%06.3f]",
                          Int(startSec) / 60, startSec.truncatingRemainder(dividingBy: 60),
                          Int(endSec) / 60, endSec.truncatingRemainder(dividingBy: 60))
        }
    }

    struct StatusLogEntry: Identifiable {
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
    @Published private(set) var liveTranscriptLines: [LiveTranscriptLine] = []
    @Published private(set) var activePartialPreview: (channel: String, text: String)? = nil
    @Published private(set) var statusLog: [StatusLogEntry] = []
    @Published private(set) var diagnosticSignals: [RuntimeDiagnosticSurfaceSignal] = []
    @Published private(set) var lastServiceError: AppServiceError?
    @Published private(set) var activeOutputRoot: URL?
    @Published private(set) var latestFinalizationSummary: FinalizationSummary?
    @Published var isStatusLogExpanded: Bool = false

    private let environment: AppEnvironment
    private let runtimeViewModel: RuntimeViewModel
    private var runningMode: RuntimeMode?
    private var activeRecordOnlyProcessID: Int32?
    private var sessionStartDate: Date?
    private var timerTask: Task<Void, Never>?
    private var pollerTask: Task<Void, Never>?
    private var tailCursor: JsonlTailCursor = .start
    private let surfaceMapper = JsonlEventSurfaceMapper()

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
        pollerTask?.cancel()
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
        liveTranscriptLines = []
        activePartialPreview = nil
        diagnosticSignals = []
        tailCursor = .start
        appendStatusLog("Start requested for \(selectedMode.title).")
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
                    if case .running = runtimeState {
                        let jsonlPath = outputRoot.appendingPathComponent("session.jsonl")
                        startTranscriptPoller(jsonlPath: jsonlPath)
                    }
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
                        appendStatusLog("Record-only session started (pid \(launch.processIdentifier)).")
                    }
                } catch let serviceError as AppServiceError {
                    await MainActor.run {
                        runtimeState = .failed(serviceError)
                        lastServiceError = serviceError
                        appendStatusLog("Record-only start failed: \(serviceError.userMessage)")
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
                        appendStatusLog("Record-only start failed: \(wrapped.userMessage)")
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
            appendStatusLog("Stop requested for record-only session (pid \(processID)).")
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
                        appendStatusLog("Record-only session stopped and finalized.")
                        stopTimer(reset: false)
                    }
                } catch let serviceError as AppServiceError {
                    await MainActor.run {
                        runtimeState = .failed(serviceError)
                        lastServiceError = serviceError
                        refreshFinalizationSummary()
                        appendStatusLog("Record-only stop failed: \(serviceError.userMessage)")
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
                        appendStatusLog("Record-only stop failed: \(wrapped.userMessage)")
                        stopTimer(reset: false)
                    }
                }
            }
            return
        }

        appendStatusLog("Stop requested for live session.")
        stopTranscriptPoller()
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
            appendStatusLog("\(eventPrefix) rejected: \(rejected.userMessage)")
        }

        switch runtimeState {
        case .running(let pid):
            appendStatusLog("\(eventPrefix) succeeded; runtime running (pid \(pid)).")
        case .completed:
            refreshFinalizationSummary()
            appendStatusLog("\(eventPrefix) completed successfully.")
            stopTimer(reset: false)
            activeRecordOnlyProcessID = nil
        case .failed(let error):
            lastServiceError = error
            refreshFinalizationSummary()
            appendStatusLog("\(eventPrefix) failed: \(error.userMessage)")
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

    private func appendStatusLog(_ text: String) {
        statusLog.append(StatusLogEntry(createdAt: Date(), text: text))
        if statusLog.count > 200 {
            statusLog.removeFirst(statusLog.count - 200)
        }
    }

    // MARK: - Live Transcript Polling

    private func startTranscriptPoller(jsonlPath: URL) {
        stopTranscriptPoller()
        pollerTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.pollTranscriptOnce(jsonlPath: jsonlPath)
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    private func stopTranscriptPoller() {
        pollerTask?.cancel()
        pollerTask = nil
        activePartialPreview = nil
    }

    private func pollTranscriptOnce(jsonlPath: URL) {
        do {
            let (events, nextCursor) = try environment.jsonlTailService.readEvents(
                at: jsonlPath,
                from: tailCursor
            )
            tailCursor = nextCursor

            guard !events.isEmpty else { return }

            let snapshot = surfaceMapper.map(events: events)

            for line in snapshot.transcriptLines {
                liveTranscriptLines.append(
                    LiveTranscriptLine(
                        eventType: line.eventType,
                        channel: line.channel,
                        startMs: line.startMs,
                        endMs: line.endMs,
                        text: line.text
                    )
                )
            }

            if liveTranscriptLines.count > 500 {
                liveTranscriptLines.removeFirst(liveTranscriptLines.count - 500)
            }

            if !snapshot.diagnostics.isEmpty {
                diagnosticSignals.append(contentsOf: snapshot.diagnostics)
                if diagnosticSignals.count > 100 {
                    diagnosticSignals.removeFirst(diagnosticSignals.count - 100)
                }
            }

            // When finals arrive, they are the "system messages" — clear the partial preview
            if !snapshot.transcriptLines.isEmpty {
                activePartialPreview = nil
            }

            // Partials: keep only the latest as a single rolling preview
            if let latestPartial = snapshot.partialLines.last {
                activePartialPreview = (channel: latestPartial.channel, text: latestPartial.text)
            }
        } catch {
            // Tailer may throw before file exists; silently retry next poll.
        }
    }

    private func makeSessionOutputRoot(mode: RuntimeMode) -> URL {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = formatter.string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let sessionsRoot: URL
        do {
            sessionsRoot = try FileSystemSessionLibraryService.defaultSessionsRoot()
        } catch {
            sessionsRoot = FileManager.default.temporaryDirectory
                .appendingPathComponent("recordit-ui-sessions", isDirectory: true)
        }
        let root = sessionsRoot
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
            // MARK: - Header
            HStack(spacing: 10) {
                Text("Recordit")
                    .font(.headline)

                Capsule()
                    .fill(controller.statusColor)
                    .frame(width: 10, height: 10)

                Text(controller.statusTitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("runtime_status")

                Spacer()

                Text(controller.elapsedLabel)
                    .font(.system(.body, design: .monospaced))
            }

            // MARK: - Mode + Controls
            HStack {
                Picker("Mode", selection: $controller.selectedMode) {
                    ForEach(MainSessionController.ModeOption.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 280)

                Spacer()

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
                    .tint(.red)
                    .disabled(!controller.canStop)
                    .keyboardShortcut(".", modifiers: [.command])
                    .accessibilityIdentifier("stop_live_transcribe")
                }
            }

            // MARK: - Error Banner
            if let error = controller.lastServiceError {
                VStack(alignment: .leading, spacing: 4) {
                    Text(error.userMessage)
                        .foregroundStyle(.red)
                    Text(error.remediation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(8)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }

            if !controller.recoveryActionsSummary.isEmpty {
                Text("Recovery actions: \(controller.recoveryActionsSummary)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            // MARK: - Live Transcript
            transcriptPanel

            // MARK: - Session Health
            if !controller.diagnosticSignals.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Session Health")
                        .font(.subheadline)
                        .fontWeight(.semibold)

                    let trustCount = controller.diagnosticSignals.filter { $0.category == .trust }.count
                    let queueCount = controller.diagnosticSignals.filter { $0.category == .queue }.count

                    HStack(spacing: 16) {
                        Label("Trust: \(trustCount == 0 ? "OK" : "\(trustCount) notice\(trustCount == 1 ? "" : "s")")",
                              systemImage: trustCount == 0 ? "checkmark.shield" : "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(trustCount == 0 ? .green : .orange)

                        Label("Queue: \(queueCount == 0 ? "Normal" : "\(queueCount) signal\(queueCount == 1 ? "" : "s")")",
                              systemImage: queueCount == 0 ? "checkmark.circle" : "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(queueCount == 0 ? .green : .orange)
                    }
                }
                .padding(8)
                .background(.quinary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
            }

            // MARK: - Status Log (Collapsible)
            DisclosureGroup("Status Log (\(controller.statusLog.count))",
                            isExpanded: $controller.isStatusLogExpanded) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(controller.statusLog) { entry in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(entry.createdAt, style: .time)
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                Text(entry.text)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .frame(maxHeight: 120)
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            // MARK: - Actions
            if controller.activeOutputRoot != nil {
                HStack(spacing: 12) {
                    Button("Open Session Folder") {
                        controller.openCurrentSessionArtifacts()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
    }

    // MARK: - Transcript Panel (extracted for type-checker)

    @ViewBuilder
    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Transcript")
                .font(.headline)

            if controller.liveTranscriptLines.isEmpty && controller.activePartialPreview == nil {
                VStack(spacing: 6) {
                    Text(controller.selectedMode == .recordOnly
                         ? "Transcript pending — record-only mode"
                         : "Waiting for transcript…")
                        .font(.subheadline)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, minHeight: 180)
                .background(.quinary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            // System messages — finalized transcript entries
                            ForEach(controller.liveTranscriptLines) { line in
                                transcriptMessageCard(line: line)
                            }

                            // Live partial preview — single rolling "listening" indicator
                            if let preview = controller.activePartialPreview {
                                partialPreviewBubble(channel: preview.channel, text: preview.text)
                            }
                        }
                        .padding(4)
                    }
                    .frame(minHeight: 220)
                    .background(.quinary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                    .onChange(of: controller.liveTranscriptLines.count) {
                        if let lastLine = controller.liveTranscriptLines.last {
                            withAnimation {
                                proxy.scrollTo(lastLine.id, anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: controller.activePartialPreview?.text) {
                        if controller.activePartialPreview != nil {
                            withAnimation {
                                proxy.scrollTo("active-partial-preview", anchor: .bottom)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func transcriptMessageCard(line: MainSessionController.LiveTranscriptLine) -> some View {
        let isMic = line.channel == "mic"
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: isMic ? "mic.fill" : "speaker.wave.2.fill")
                    .font(.caption2)
                    .foregroundStyle(isMic ? .blue : .orange)

                Text(isMic ? "Microphone" : "System Audio")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(isMic ? .blue : .orange)

                Text(line.formattedTimestamp)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }

            Text(line.text)
                .font(.body)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .id(line.id)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(isMic ? Color.blue.opacity(0.06) : Color.orange.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(isMic ? Color.blue.opacity(0.12) : Color.orange.opacity(0.12),
                              lineWidth: 0.5)
        )
    }

    @ViewBuilder
    private func partialPreviewBubble(channel: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "waveform")
                .font(.caption)
                .foregroundStyle(.green)
                .symbolEffect(.variableColor.iterative, isActive: true)

            VStack(alignment: .leading, spacing: 2) {
                Text(channel == "mic" ? "Listening…" : "Hearing…")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.green)

                Text(text)
                    .font(.body)
                    .italic()
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .id("active-partial-preview")
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.green.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.green.opacity(0.15), lineWidth: 0.5)
        )
    }
}
