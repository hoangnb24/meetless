import SwiftUI

@MainActor
final class SessionDetailViewModel: ObservableObject {
    struct MetadataItem: Identifiable {
        let id: String
        let label: String
        let value: String
    }

    struct NoticeItem: Identifiable {
        let id: String
        let severity: SavedSessionNoticeSeverity
        let title: String
        let message: String
    }

    struct SourceHealthItem: Identifiable {
        let id: String
        let state: SourcePipelineState
        let title: String
        let message: String
    }

    struct TranscriptRow: Identifiable {
        let id: UUID
        let source: RecordingSourceKind
        let timeRangeText: String
        let text: String
    }

    struct GeneratedNotesDisplay: Equatable {
        let generatedAtText: String
        let summary: String
        let actionItemBullets: [String]
    }

    enum GenerateFailure: Error, Equatable {
        case noSelectedSession
        case missingAPIKey
    }

    @Published private(set) var title = "Session detail"
    @Published private(set) var subtitle = "Select a saved history row to open its persisted transcript snapshot and metadata here."
    @Published private(set) var metadataItems: [MetadataItem] = []
    @Published private(set) var transcriptRows: [TranscriptRow] = []
    @Published private(set) var sourceStatuses: [SourcePipelineStatus] = []
    @Published private(set) var savedSessionNotices: [SavedSessionNotice] = []
    @Published private(set) var generatedNotesDisplay: GeneratedNotesDisplay?
    @Published private(set) var hasGeneratedNotes = false
    @Published private(set) var isGeminiConfigured = false
    @Published private(set) var isGeneratingNotes = false
    @Published private(set) var generationErrorMessage: String?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var actionMessage: String?

    var transcriptEmptyMessage: String {
        "No transcript chunks were saved for this session."
    }

    var compactMetadataLine: String {
        let preferredIDs = ["state", "started", "duration"]
        let values = preferredIDs.compactMap { id in
            metadataItems.first(where: { $0.id == id })?.value
        }

        guard !values.isEmpty else {
            return subtitle
        }

        return values.joined(separator: " / ")
    }

    var canDelete: Bool {
        !isLoading && !isGeneratingNotes && errorMessage == nil && (!metadataItems.isEmpty || !transcriptRows.isEmpty || !sourceStatuses.isEmpty)
    }

    var canGenerateNotes: Bool {
        !isLoading
            && !isGeneratingNotes
            && errorMessage == nil
            && !metadataItems.isEmpty
            && isGeminiConfigured
            && !hasGeneratedNotes
    }

    var generateNotesStatusText: String? {
        if isGeneratingNotes {
            return "Generating notes from saved audio."
        }

        if let generationErrorMessage {
            return generationErrorMessage
        }

        if hasGeneratedNotes {
            return "Notes have already been generated for this session."
        }

        if !isGeminiConfigured && !metadataItems.isEmpty && errorMessage == nil && !isLoading {
            return "Add a Gemini API key in Settings before generating notes."
        }

        return nil
    }

    var compactNoticeItems: [NoticeItem] {
        savedSessionNotices.map(Self.compactNoticeItem(for:))
    }

    var compactSourceHealthItems: [SourceHealthItem] {
        let nonReadyItems = sourceStatuses
            .filter { $0.state != .ready }
            .enumerated()
            .map { index, status in
                Self.compactSourceHealthItem(for: status, index: index)
            }

        if !nonReadyItems.isEmpty {
            return nonReadyItems
        }

        guard !sourceStatuses.isEmpty else {
            return []
        }

        return [
            SourceHealthItem(
                id: "inputs-ready",
                state: .ready,
                title: "Inputs ready",
                message: "\(sourceStatuses.count) saved input\(sourceStatuses.count == 1 ? "" : "s") completed without warning."
            )
        ]
    }

    func showNoSelection() {
        title = "Session detail"
        subtitle = "Select a saved history row to open its persisted transcript snapshot and metadata here."
        metadataItems = []
        transcriptRows = []
        sourceStatuses = []
        savedSessionNotices = []
        generatedNotesDisplay = nil
        hasGeneratedNotes = false
        isGeneratingNotes = false
        generationErrorMessage = nil
        isLoading = false
        errorMessage = nil
        actionMessage = nil
    }

    func showLoading(title: String?) {
        self.title = title ?? "Loading saved session"
        subtitle = "Meetless is decoding the persisted transcript snapshot and metadata from the local session bundle."
        metadataItems = []
        transcriptRows = []
        sourceStatuses = []
        savedSessionNotices = []
        generatedNotesDisplay = nil
        hasGeneratedNotes = false
        isGeneratingNotes = false
        generationErrorMessage = nil
        isLoading = true
        errorMessage = nil
        actionMessage = nil
    }

    func showDetail(_ detail: PersistedSessionDetail) {
        title = detail.title
        subtitle = detail.isIncomplete
            ? "This session was saved as incomplete. The transcript below is the exact persisted snapshot captured during recording."
            : "This read-only detail shows the exact persisted transcript snapshot and saved metadata for the local session."
        metadataItems = [
            MetadataItem(id: "state", label: "Saved session state", value: detail.isIncomplete ? "Incomplete" : "Completed"),
            MetadataItem(id: "started", label: "Started", value: Self.dateTimeFormatter.string(from: detail.startedAt)),
            MetadataItem(id: "ended", label: "Ended", value: detail.endedAt.map(Self.dateTimeFormatter.string(from:)) ?? "Not recorded"),
            MetadataItem(id: "duration", label: "Duration", value: Self.durationText(for: detail.durationSeconds)),
            MetadataItem(id: "snapshot", label: "Transcript snapshot saved", value: Self.dateTimeFormatter.string(from: detail.transcriptSavedAt)),
            MetadataItem(id: "updated", label: "Bundle updated", value: Self.dateTimeFormatter.string(from: detail.updatedAt))
        ]
        transcriptRows = detail.transcriptChunks.map { chunk in
            TranscriptRow(
                id: chunk.id,
                source: chunk.source,
                timeRangeText: Self.formattedTimeRange(for: chunk),
                text: chunk.text
            )
        }
        sourceStatuses = detail.sourceStatuses
        savedSessionNotices = detail.savedSessionNotices
        generatedNotesDisplay = detail.generatedNotes.map(Self.generatedNotesDisplay(for:))
        hasGeneratedNotes = generatedNotesDisplay != nil
        isGeneratingNotes = false
        generationErrorMessage = nil
        isLoading = false
        errorMessage = nil
        actionMessage = nil
    }

    func showLoadFailure(title: String?, error: Error) {
        self.title = title ?? "Session detail unavailable"
        subtitle = "Meetless could not open the selected saved session bundle."
        metadataItems = []
        transcriptRows = []
        sourceStatuses = []
        savedSessionNotices = []
        generatedNotesDisplay = nil
        hasGeneratedNotes = false
        isGeneratingNotes = false
        generationErrorMessage = nil
        isLoading = false
        errorMessage = error.localizedDescription
        actionMessage = nil
    }

    func showDeleteFailure(title: String, error: Error) {
        self.title = title
        actionMessage = "Meetless could not delete this local session bundle: \(error.localizedDescription)"
    }

    func updateGeminiConfiguration(_ isConfigured: Bool) {
        isGeminiConfigured = isConfigured
    }

    func beginGeneratingNotes() {
        guard canGenerateNotes else {
            return
        }

        isGeneratingNotes = true
        generationErrorMessage = nil
        actionMessage = nil
    }

    func showGenerationFailure(_ error: Error) {
        isGeneratingNotes = false
        generationErrorMessage = Self.safeGenerationFailureMessage(for: error)
    }

    private static let dateTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale.autoupdatingCurrent
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    private static func durationText(for durationSeconds: TimeInterval?) -> String {
        guard let durationSeconds else {
            return "In progress"
        }

        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.allowedUnits = durationSeconds >= 3600 ? [.hour, .minute] : [.minute, .second]
        formatter.zeroFormattingBehavior = [.dropLeading]
        return formatter.string(from: durationSeconds) ?? "\(Int(durationSeconds)) sec"
    }

    private static func formattedTimeRange(for chunk: CommittedTranscriptChunk) -> String {
        "\(formattedSeconds(chunk.startTime)) - \(formattedSeconds(chunk.endTime))"
    }

    private static func formattedSeconds(_ value: TimeInterval) -> String {
        let totalSeconds = max(0, Int(value.rounded(.down)))
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%01d:%02d", minutes, seconds)
    }

    private static func compactNoticeItem(for notice: SavedSessionNotice) -> NoticeItem {
        switch notice.id {
        case "incomplete":
            return NoticeItem(
                id: notice.id,
                severity: notice.severity,
                title: "Incomplete save",
                message: "Saved after an interrupted stop."
            )
        case "transcript-snapshot-warning":
            return NoticeItem(
                id: notice.id,
                severity: notice.severity,
                title: "Transcript snapshot",
                message: "Saved transcript may be older than the final timeline."
            )
        case "snapshot-note":
            return NoticeItem(
                id: notice.id,
                severity: notice.severity,
                title: "No saved warnings",
                message: "Saved transcript snapshot is available."
            )
        default:
            if notice.id.hasPrefix("source-") {
                return NoticeItem(
                    id: notice.id,
                    severity: notice.severity,
                    title: "Input health",
                    message: sanitizedSourceText(notice.message)
                )
            }

            return NoticeItem(
                id: notice.id,
                severity: notice.severity,
                title: sanitizedSourceText(notice.title),
                message: sanitizedSourceText(notice.message)
            )
        }
    }

    private static func compactSourceHealthItem(for status: SourcePipelineStatus, index: Int) -> SourceHealthItem {
        let title: String
        let message: String

        switch status.state {
        case .ready:
            title = "Input ready"
            message = "Saved without warning."
        case .blocked:
            title = "Input blocked"
            message = "One saved input was unavailable during recording."
        case .monitoring:
            title = "Input needs review"
            message = "One saved input reported a recoverable capture warning."
        case .degraded:
            title = "Input degraded"
            message = "One saved input continued with reduced capture health."
        }

        return SourceHealthItem(
            id: "\(status.state.rawValue)-\(index)",
            state: status.state,
            title: title,
            message: message
        )
    }

    private static func generatedNotesDisplay(for notes: GeneratedSessionNotes) -> GeneratedNotesDisplay {
        GeneratedNotesDisplay(
            generatedAtText: dateTimeFormatter.string(from: notes.generatedAt),
            summary: sanitizedGeneratedNotesText(notes.summary),
            actionItemBullets: notes.actionItemBullets.map(sanitizedGeneratedNotesText)
        )
    }

    private static func sanitizedGeneratedNotesText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "Meeting source", with: "saved input")
            .replacingOccurrences(of: "Me source", with: "saved input")
            .replacingOccurrences(of: "Meeting lane", with: "saved input")
            .replacingOccurrences(of: "Me lane", with: "saved input")
            .replacingOccurrences(of: "Meeting:", with: "Speaker:")
            .replacingOccurrences(of: "Me:", with: "You:")
    }

    private static func sanitizedSourceText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "Meeting source", with: "Input")
            .replacingOccurrences(of: "Me source", with: "Input")
            .replacingOccurrences(of: "Meeting", with: "Input")
            .replacingOccurrences(of: "Me was", with: "Input was")
            .replacingOccurrences(of: "Me is", with: "Input is")
    }

    private static func safeGenerationFailureMessage(for error: Error) -> String {
        if let viewError = error as? GenerateFailure {
            switch viewError {
            case .noSelectedSession:
                return "Open a saved session before generating notes."
            case .missingAPIKey:
                return "Add a Gemini API key in Settings, then try generating notes again."
            }
        }

        if let orchestrationError = error as? GeminiSessionNotesOrchestrationError {
            switch orchestrationError {
            case .missingAPIKey:
                return "Add a Gemini API key in Settings, then try generating notes again."
            case .alreadyGenerated:
                return "This session already has generated notes, so Meetless will not overwrite them."
            case .missingAudio:
                return "Meetless could not find the saved audio needed for Gemini. Check this saved session, then try again."
            case .authentication:
                return "Gemini rejected the saved API key. Update it in Settings, then try again."
            case .client:
                return "Meetless could not prepare the Gemini request. Check your connection and settings, then try again."
            case .provider:
                return "Gemini could not finish this request. Try generating notes again."
            case .parser:
                return "Gemini returned notes Meetless could not read safely. Try generating notes again."
            case .persistence:
                return "Meetless could not save the generated notes locally. Try generating notes again."
            }
        }

        return "Meetless could not generate notes. Try again."
    }
}

struct SessionDetailView: View {
    @ObservedObject var viewModel: SessionDetailViewModel
    let onBackToHistory: () -> Void
    let onDeleteSession: () -> Void
    let onGenerateNotes: () -> Void
    @State private var isPresentingDeleteConfirmation = false
    @State private var isPresentingGenerateConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: MeetlessDesignTokens.Layout.defaultGap) {
            header
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .alert("Delete saved session?", isPresented: $isPresentingDeleteConfirmation) {
            Button("Delete", role: .destructive, action: onDeleteSession)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the local session bundle, transcript snapshot, and raw audio artifacts from Meetless.")
        }
        .alert("Upload saved audio to Gemini?", isPresented: $isPresentingGenerateConfirmation) {
            Button("Upload and generate") {
                onGenerateNotes()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Meetless will send this saved session's audio files to Gemini to create a summary and action items.")
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(viewModel.title)
                    .font(MeetlessDesignTokens.Typography.screenTitle)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                    .lineLimit(1)

                Text(viewModel.compactMetadataLine)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .lineLimit(1)
            }

            Spacer(minLength: 16)

            detailActionsRow
        }
    }

    private var detailActionsRow: some View {
        HStack(spacing: 8) {
            backToHistoryButton
            generateNotesButton
            deleteSessionButton
        }
    }

    private var backToHistoryButton: some View {
        Button(action: onBackToHistory) {
            Label("Back", systemImage: "chevron.left")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var generateNotesButton: some View {
        Button {
            isPresentingGenerateConfirmation = true
        } label: {
            Label("Generate", systemImage: "sparkles")
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(!viewModel.canGenerateNotes)
    }

    @ViewBuilder
    private var deleteSessionButton: some View {
        if viewModel.canDelete {
            Button(role: .destructive) {
                isPresentingDeleteConfirmation = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading {
            loadingState
        } else if let errorMessage = viewModel.errorMessage {
            messageState(
                title: "Saved session unavailable",
                icon: "exclamationmark.triangle",
                body: errorMessage
            )
        } else if viewModel.metadataItems.isEmpty && viewModel.transcriptRows.isEmpty && viewModel.sourceStatuses.isEmpty {
            messageState(
                title: "No session selected",
                icon: "text.document",
                body: "Choose a row from Saved Sessions to open its transcript and metadata."
            )
        } else {
            VStack(alignment: .leading, spacing: MeetlessDesignTokens.Layout.defaultGap) {
                if let actionMessage = viewModel.actionMessage {
                    warningBanner(
                        title: "Delete unavailable",
                        body: actionMessage
                    )
                }

                if let generateNotesStatusText = viewModel.generateNotesStatusText {
                    generationStatusBanner(generateNotesStatusText)
                }

                readingLayout
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text("Loading saved session detail")
                .font(MeetlessDesignTokens.Typography.body)
                .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
        }
        .padding(.vertical, 22)
    }

    private var readingLayout: some View {
        HStack(alignment: .top, spacing: MeetlessDesignTokens.Layout.largeGap) {
            transcriptPane
                .frame(minWidth: 360, maxWidth: .infinity, alignment: .topLeading)

            HairlineDivider(.vertical)

            metadataRail
                .frame(width: 240, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var transcriptPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            generatedNotesSection

            sectionHeader("Transcript")
                .padding(.bottom, 8)

            HairlineDivider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    transcriptRowsContent
                }
            }
        }
    }

    @ViewBuilder
    private var generatedNotesSection: some View {
        if let generatedNotesDisplay = viewModel.generatedNotesDisplay {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    sectionHeader("Summary")

                    Spacer(minLength: 12)

                    Text("Generated \(generatedNotesDisplay.generatedAtText)")
                        .font(MeetlessDesignTokens.Typography.caption)
                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                        .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)
                        .lineLimit(1)
                }

                Text(generatedNotesDisplay.summary)
                    .font(MeetlessDesignTokens.Typography.body)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if !generatedNotesDisplay.actionItemBullets.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        sectionHeader("Action Items")

                        VStack(alignment: .leading, spacing: 7) {
                            ForEach(Array(generatedNotesDisplay.actionItemBullets.enumerated()), id: \.offset) { _, actionItem in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text("-")
                                        .font(MeetlessDesignTokens.Typography.body.weight(.semibold))
                                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                                        .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)

                                    Text(actionItem)
                                        .font(MeetlessDesignTokens.Typography.body)
                                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                                        .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                                        .lineSpacing(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.bottom, 18)
            .frame(maxWidth: .infinity, alignment: .leading)

            HairlineDivider()
                .padding(.bottom, 16)
        }
    }

    @ViewBuilder
    private var transcriptRowsContent: some View {
        if viewModel.transcriptRows.isEmpty {
            emptyTranscriptState
                .padding(.vertical, 14)
        } else {
            ForEach(Array(viewModel.transcriptRows.enumerated()), id: \.element.id) { index, row in
                transcriptRow(row)

                if index < viewModel.transcriptRows.count - 1 {
                    HairlineDivider()
                }
            }
        }
    }

    private var emptyTranscriptState: some View {
        HStack(spacing: 10) {
            Image(systemName: "text.line.first.and.arrowtriangle.forward")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)

            Text(viewModel.transcriptEmptyMessage)
                .font(MeetlessDesignTokens.Typography.body)
                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)

            Spacer(minLength: 0)
        }
    }

    private func transcriptRow(_ row: SessionDetailViewModel.TranscriptRow) -> some View {
        Grid(alignment: .topLeading, horizontalSpacing: 14, verticalSpacing: 0) {
            GridRow {
                Text(row.timeRangeText)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)
                    .frame(width: 76, alignment: .leading)
                    .padding(.top, 1)

                Text(row.text)
                    .font(MeetlessDesignTokens.Typography.body)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.timeRangeText), \(row.text)")
    }

    private var metadataRail: some View {
        VStack(alignment: .leading, spacing: MeetlessDesignTokens.Layout.defaultGap) {
            metadataSection
            noticesSection
            sourceHealthSection
        }
    }

    private var metadataSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Metadata")
                .padding(.bottom, 8)

            HairlineDivider()

            ForEach(Array(viewModel.metadataItems.enumerated()), id: \.element.id) { index, item in
                labelValueRow(label: item.label, value: item.value)

                if index < viewModel.metadataItems.count - 1 {
                    HairlineDivider()
                }
            }
        }
    }

    @ViewBuilder
    private var noticesSection: some View {
        if !viewModel.compactNoticeItems.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeader("Notices")
                    .padding(.bottom, 8)

                HairlineDivider()

                ForEach(Array(viewModel.compactNoticeItems.enumerated()), id: \.element.id) { index, notice in
                    compactNoticeRow(notice)

                    if index < viewModel.compactNoticeItems.count - 1 {
                        HairlineDivider()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var sourceHealthSection: some View {
        if !viewModel.compactSourceHealthItems.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeader("Input Health")
                    .padding(.bottom, 8)

                HairlineDivider()

                ForEach(Array(viewModel.compactSourceHealthItems.enumerated()), id: \.element.id) { index, status in
                    compactSourceHealthRow(status)

                    if index < viewModel.compactSourceHealthItems.count - 1 {
                        HairlineDivider()
                    }
                }
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(MeetlessDesignTokens.Typography.letterSpacing)
            .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)
    }

    private func labelValueRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(MeetlessDesignTokens.Typography.caption)
                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                .lineLimit(1)

            Text(value)
                .font(MeetlessDesignTokens.Typography.body.weight(.medium))
                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func compactNoticeRow(_ notice: SessionDetailViewModel.NoticeItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            StatusDot(color: noticeColor(for: notice.severity))
                .padding(.top, 4)

            VStack(alignment: .leading, spacing: 3) {
                Text(notice.title)
                    .font(MeetlessDesignTokens.Typography.caption.weight(.semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

                Text(notice.message)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func compactSourceHealthRow(_ status: SessionDetailViewModel.SourceHealthItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            StatusDot(color: color(for: status.state))
                .padding(.top, 4)

            VStack(alignment: .leading, spacing: 3) {
                Text(status.title)
                    .font(MeetlessDesignTokens.Typography.caption.weight(.semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

                Text(status.message)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func messageState(title: String, icon: String, body: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(MeetlessDesignTokens.Typography.body.weight(.semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                Text(body)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(.vertical, 22)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func warningBanner(title: String, body: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(MeetlessDesignTokens.Colors.warningAmber)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(MeetlessDesignTokens.Typography.body.weight(.semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                Text(body)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            MeetlessDesignTokens.Colors.warningAmber.opacity(0.1),
            in: RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous)
        )
    }

    private func generationStatusBanner(_ body: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if viewModel.isGeneratingNotes {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: viewModel.hasGeneratedNotes ? "checkmark.circle" : "exclamationmark.triangle")
                    .foregroundStyle(viewModel.hasGeneratedNotes ? MeetlessDesignTokens.Colors.successGreen : MeetlessDesignTokens.Colors.warningAmber)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(viewModel.isGeneratingNotes ? "Generating notes" : viewModel.hasGeneratedNotes ? "Notes ready" : "Generate unavailable")
                    .font(MeetlessDesignTokens.Typography.body.weight(.semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                Text(body)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            (viewModel.hasGeneratedNotes ? MeetlessDesignTokens.Colors.successGreen : MeetlessDesignTokens.Colors.warningAmber).opacity(0.1),
            in: RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous)
        )
    }

    private func color(for state: SourcePipelineState) -> Color {
        switch state {
        case .ready:
            return MeetlessDesignTokens.Colors.successGreen
        case .blocked:
            return MeetlessDesignTokens.Colors.warningAmber
        case .monitoring:
            return MeetlessDesignTokens.Colors.warningAmber
        case .degraded:
            return MeetlessDesignTokens.Colors.recordingRed
        }
    }

    private func noticeColor(for severity: SavedSessionNoticeSeverity) -> Color {
        switch severity {
        case .info:
            return MeetlessDesignTokens.Colors.successGreen
        case .warning:
            return MeetlessDesignTokens.Colors.warningAmber
        }
    }
}

#Preview {
    SessionDetailView(viewModel: SessionDetailViewModel(), onBackToHistory: {}, onDeleteSession: {}, onGenerateNotes: {})
        .frame(width: 1080, height: 720)
}
