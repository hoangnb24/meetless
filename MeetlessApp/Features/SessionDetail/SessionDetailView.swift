import SwiftUI

@MainActor
final class SessionDetailViewModel: ObservableObject {
    struct MetadataItem: Identifiable {
        let id: String
        let label: String
        let value: String
    }

    struct TranscriptRow: Identifiable {
        let id: UUID
        let source: RecordingSourceKind
        let timeRangeText: String
        let text: String
    }

    @Published private(set) var title = "Session detail"
    @Published private(set) var subtitle = "Select a saved history row to open its persisted transcript snapshot and metadata here."
    @Published private(set) var metadataItems: [MetadataItem] = []
    @Published private(set) var transcriptRows: [TranscriptRow] = []
    @Published private(set) var sourceStatuses: [SourcePipelineStatus] = []
    @Published private(set) var savedSessionNotices: [SavedSessionNotice] = []
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
        !isLoading && errorMessage == nil && (!metadataItems.isEmpty || !transcriptRows.isEmpty || !sourceStatuses.isEmpty)
    }

    func showNoSelection() {
        title = "Session detail"
        subtitle = "Select a saved history row to open its persisted transcript snapshot and metadata here."
        metadataItems = []
        transcriptRows = []
        sourceStatuses = []
        savedSessionNotices = []
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
        isLoading = false
        errorMessage = error.localizedDescription
        actionMessage = nil
    }

    func showDeleteFailure(title: String, error: Error) {
        self.title = title
        actionMessage = "Meetless could not delete this local session bundle: \(error.localizedDescription)"
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
}

struct SessionDetailView: View {
    @ObservedObject var viewModel: SessionDetailViewModel
    let onBackToHistory: () -> Void
    let onDeleteSession: () -> Void
    @State private var isPresentingDeleteConfirmation = false

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
        if !viewModel.savedSessionNotices.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeader("Notices")
                    .padding(.bottom, 8)

                HairlineDivider()

                ForEach(Array(viewModel.savedSessionNotices.enumerated()), id: \.element.id) { index, notice in
                    compactNoticeRow(notice)

                    if index < viewModel.savedSessionNotices.count - 1 {
                        HairlineDivider()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var sourceHealthSection: some View {
        if !viewModel.sourceStatuses.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeader("Input Health")
                    .padding(.bottom, 8)

                HairlineDivider()

                ForEach(Array(viewModel.sourceStatuses.enumerated()), id: \.element.id) { index, status in
                    compactSourceHealthRow(status, index: index)

                    if index < viewModel.sourceStatuses.count - 1 {
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

    private func compactNoticeRow(_ notice: SavedSessionNotice) -> some View {
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

    private func compactSourceHealthRow(_ status: SourcePipelineStatus, index: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            StatusDot(color: color(for: status.state))
                .padding(.top, 4)

            VStack(alignment: .leading, spacing: 3) {
                Text("Input \(index + 1)")
                    .font(MeetlessDesignTokens.Typography.caption.weight(.semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

                Text(sourceHealthText(for: status))
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sourceHealthText(for status: SourcePipelineStatus) -> String {
        let stateText: String
        switch status.state {
        case .ready:
            stateText = "Ready"
        case .blocked:
            stateText = "Blocked"
        case .monitoring:
            stateText = "Monitoring"
        case .degraded:
            stateText = "Degraded"
        }

        return "\(stateText): \(status.detail)"
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
    SessionDetailView(viewModel: SessionDetailViewModel(), onBackToHistory: {}, onDeleteSession: {})
        .frame(width: 1080, height: 720)
}
