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
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    var transcriptEmptyMessage: String {
        "This saved session does not contain any committed transcript chunks in its persisted snapshot yet."
    }

    func showNoSelection() {
        title = "Session detail"
        subtitle = "Select a saved history row to open its persisted transcript snapshot and metadata here."
        metadataItems = []
        transcriptRows = []
        sourceStatuses = []
        isLoading = false
        errorMessage = nil
    }

    func showLoading(title: String?) {
        self.title = title ?? "Loading saved session"
        subtitle = "Meetless is decoding the persisted transcript snapshot and metadata from the local session bundle."
        metadataItems = []
        transcriptRows = []
        sourceStatuses = []
        isLoading = true
        errorMessage = nil
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
        isLoading = false
        errorMessage = nil
    }

    func showLoadFailure(title: String?, error: Error) {
        self.title = title ?? "Session detail unavailable"
        subtitle = "Meetless could not open the selected saved session bundle."
        metadataItems = []
        transcriptRows = []
        sourceStatuses = []
        isLoading = false
        errorMessage = error.localizedDescription
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(viewModel.title)
                        .font(.system(size: 32, weight: .semibold, design: .rounded))
                    Text(viewModel.subtitle)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: 760, alignment: .leading)
                }

                content

                Button("Back To History", action: onBackToHistory)
                    .buttonStyle(.borderedProminent)
            }
            .padding(32)
            .frame(maxWidth: 1100, alignment: .leading)
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading {
            loadingCard
        } else if let errorMessage = viewModel.errorMessage {
            messageCard(
                title: "Saved session unavailable",
                icon: "exclamationmark.triangle",
                body: errorMessage
            )
        } else if viewModel.metadataItems.isEmpty && viewModel.transcriptRows.isEmpty && viewModel.sourceStatuses.isEmpty {
            messageCard(
                title: "No session selected",
                icon: "text.document",
                body: "Choose a row from Saved Sessions to open the exact persisted transcript snapshot and metadata here."
            )
        } else {
            VStack(alignment: .leading, spacing: 18) {
                transcriptCard
                metadataCard
                sourceHealthCard
            }
        }
    }

    private var loadingCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Loading saved session detail")
                .font(.headline)
            Text("Meetless is reading the transcript snapshot and saved metadata from the selected local bundle.")
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var transcriptCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Transcript snapshot", systemImage: "text.quote")
                .font(.headline)

            if viewModel.transcriptRows.isEmpty {
                Text(viewModel.transcriptEmptyMessage)
                    .foregroundStyle(.secondary)
            } else {
                LazyVStack(spacing: 14) {
                    ForEach(viewModel.transcriptRows) { row in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Label(row.source.rawValue, systemImage: row.source == .meeting ? "person.2.wave.2" : "person.wave.2")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(sourceColor(for: row.source))
                                Spacer()
                                Text(row.timeRangeText)
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }

                            Text(row.text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(16)
                                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var metadataCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Session metadata", systemImage: "calendar")
                .font(.headline)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), alignment: .leading)], alignment: .leading, spacing: 14) {
                ForEach(viewModel.metadataItems) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item.label)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(item.value)
                            .font(.body.weight(.medium))
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var sourceHealthCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Saved source health", systemImage: "waveform.badge.exclamationmark")
                .font(.headline)

            ForEach(viewModel.sourceStatuses) { status in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: icon(for: status.state))
                        .foregroundStyle(color(for: status.state))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(status.source.rawValue)
                            .font(.subheadline.weight(.semibold))
                        Text(status.detail)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func messageCard(title: String, icon: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: icon)
                .font(.headline)

            Text(body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func sourceColor(for source: RecordingSourceKind) -> Color {
        switch source {
        case .meeting:
            return .blue
        case .me:
            return .green
        }
    }

    private func color(for state: SourcePipelineState) -> Color {
        switch state {
        case .ready:
            return .blue
        case .blocked:
            return .orange
        case .monitoring:
            return .orange
        case .degraded:
            return .red
        }
    }

    private func icon(for state: SourcePipelineState) -> String {
        switch state {
        case .ready:
            return "checkmark.circle"
        case .blocked:
            return "lock.trianglebadge.exclamationmark"
        case .monitoring:
            return "waveform"
        case .degraded:
            return "exclamationmark.triangle"
        }
    }
}

#Preview {
    SessionDetailView(viewModel: SessionDetailViewModel(), onBackToHistory: {})
        .frame(width: 1080, height: 720)
}
