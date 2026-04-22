import SwiftUI

struct RecordingStatusBanner: View {
    @ObservedObject var viewModel: RecordingViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Recording status region")
                        .font(.title3.weight(.semibold))

                    Text(viewModel.detail)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 16)

                phaseBadge
            }

            HStack(alignment: .top, spacing: 16) {
                ForEach(viewModel.sourceStatuses) { status in
                    VStack(alignment: .leading, spacing: 10) {
                        Label(status.source.rawValue, systemImage: icon(for: status.state))
                            .font(.headline)

                        Text(status.detail)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .background(color(for: status.state).opacity(0.12), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Latest shell event")
                    .font(.subheadline.weight(.semibold))
                Text(viewModel.latestEvent)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            transcriptSection

            if !viewModel.repairActions.isEmpty {
                repairActionsSection
            }
        }
        .padding(24)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }

    private var transcriptSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Committed transcript timeline")
                    .font(.headline)

                Spacer(minLength: 12)

                if !viewModel.transcriptChunks.isEmpty {
                    Text("\(viewModel.transcriptChunks.count) chunk\(viewModel.transcriptChunks.count == 1 ? "" : "s")")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }

            if viewModel.transcriptChunks.isEmpty {
                Text(emptyTranscriptMessage)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(viewModel.transcriptChunks) { chunk in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(alignment: .firstTextBaseline, spacing: 10) {
                                    Text(chunk.source.rawValue)
                                        .font(.caption.weight(.bold))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(sourceColor(for: chunk.source).opacity(0.16), in: Capsule(style: .continuous))

                                    Text(formattedTimeRange(for: chunk))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }

                                Text(chunk.text)
                                    .font(.body)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(sourceColor(for: chunk.source).opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        }
                    }
                }
                .frame(maxHeight: 280)
            }
        }
    }

    private var repairActionsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Permission repair")
                .font(.headline)

            ForEach(viewModel.repairActions) { action in
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(action.kind.title)
                            .font(.subheadline.weight(.semibold))

                        Text(action.detail)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        if action.relaunchRequired {
                            Label("Relaunch required after granting access", systemImage: "arrow.clockwise")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Spacer(minLength: 12)

                    Link(action.title, destination: action.url)
                        .buttonStyle(.borderedProminent)
                }
                .padding(18)
                .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
    }

    private var emptyTranscriptMessage: String {
        switch viewModel.phase {
        case .recording:
            return "Committed Meeting and Me transcript chunks will appear here once each local whisper worker finishes a stable window. This timeline is intentionally conservative so later persistence can save exactly what the operator saw."
        case .blocked:
            return "Transcript output stays empty until the blocked recording flow is repaired and capture can begin."
        case .idle:
            return "No committed transcript chunks exist yet. Start a recording to build the live Meeting and Me timeline."
        }
    }

    private var phaseBadge: some View {
        Text(viewModel.phaseDisplayTitle)
            .font(.headline)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                capsuleColor,
                in: Capsule(style: .continuous)
            )
    }

    private var capsuleColor: Color {
        switch viewModel.phase {
        case .idle:
            return .secondary.opacity(0.18)
        case .blocked:
            return .orange.opacity(0.18)
        case .recording:
            return viewModel.sourceStatuses.contains(where: { $0.state == .degraded })
                ? .orange.opacity(0.18)
                : .red.opacity(0.16)
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

    private func sourceColor(for source: RecordingSourceKind) -> Color {
        switch source {
        case .meeting:
            return .blue
        case .me:
            return .green
        }
    }

    private func formattedTimeRange(for chunk: CommittedTranscriptChunk) -> String {
        "\(formattedSeconds(chunk.startTime)) - \(formattedSeconds(chunk.endTime))"
    }

    private func formattedSeconds(_ value: TimeInterval) -> String {
        let totalSeconds = max(0, Int(value.rounded(.down)))
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%01d:%02d", minutes, seconds)
    }
}

#Preview {
    RecordingStatusBanner(viewModel: RecordingViewModel(coordinator: PreviewRecordingCoordinator()))
        .padding()
        .frame(width: 960)
}
