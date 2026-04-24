import SwiftUI

struct RecordingStatusBanner: View {
    @ObservedObject var viewModel: RecordingViewModel

    var body: some View {
        switch viewModel.phase {
        case .idle:
            EmptyView()
        case .blocked:
            PermissionRepairPanel(viewModel: viewModel)
        case .recording:
            ActiveRecordingPanel(viewModel: viewModel)
        }
    }
}

private struct ActiveRecordingPanel: View {
    @ObservedObject var viewModel: RecordingViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header

            WaveformMeterView(
                activityLevel: waveformActivityLevel,
                isActive: !viewModel.isBusy,
                tint: MeetlessDesignTokens.Colors.recordingRed
            )
            .padding(.vertical, 2)

            healthStrip

            HairlineDivider()

            transcriptTimeline
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(MeetlessDesignTokens.Colors.windowBackground)
        .overlay {
            RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous)
                .stroke(MeetlessDesignTokens.Colors.separator)
        }
        .clipShape(RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous))
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            StatusDot(color: MeetlessDesignTokens.Colors.recordingRed, size: .medium)

            VStack(alignment: .leading, spacing: 2) {
                Text("Recording")
                    .font(MeetlessDesignTokens.Typography.screenTitle)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

                Text(recordingSubtitle)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .lineLimit(1)
            }

            Spacer(minLength: 12)

            elapsedTimer

            Button(action: viewModel.toggleRecording) {
                Label("Stop", systemImage: viewModel.controlSystemImage)
                    .font(MeetlessDesignTokens.Typography.body.weight(.semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)
            .tint(MeetlessDesignTokens.Colors.recordingRed)
            .disabled(viewModel.isBusy)
        }
    }

    private var elapsedTimer: some View {
        TimelineView(.periodic(from: viewModel.recordingStartedAt ?? Date(), by: 1)) { timeline in
            Text(formattedElapsed(at: timeline.date))
                .font(MeetlessDesignTokens.Typography.timer)
                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                .monospacedDigit()
                .frame(minWidth: 84, alignment: .trailing)
                .accessibilityLabel("Elapsed recording time \(formattedElapsed(at: timeline.date))")
        }
    }

    private var healthStrip: some View {
        VStack(spacing: 0) {
            ForEach(Array(healthRows.enumerated()), id: \.element.id) { index, row in
                HStack(spacing: 10) {
                    StatusDot(color: row.color)

                    Text(row.title)
                        .font(MeetlessDesignTokens.Typography.body.weight(.medium))
                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                        .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                        .lineLimit(1)

                    Spacer(minLength: 8)

                    Text(row.detail)
                        .font(MeetlessDesignTokens.Typography.caption)
                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                        .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                        .lineLimit(1)
                }
                .padding(.vertical, 9)
                .accessibilityElement(children: .combine)

                if index < healthRows.count - 1 {
                    HairlineDivider()
                }
            }
        }
    }

    private var transcriptTimeline: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Transcript")
                    .font(MeetlessDesignTokens.Typography.sectionTitle)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

                Spacer(minLength: 12)

                Text(transcriptCountLabel)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)
            }

            TranscriptRowsView(chunks: viewModel.transcriptChunks, maxHeight: 250)
        }
    }

    private var healthRows: [RecordingHealthRow] {
        var rows = [
            RecordingHealthRow(
                title: "Audio",
                detail: audioHealthDetail,
                color: audioHealthColor
            ),
            RecordingHealthRow(
                title: "Transcript",
                detail: transcriptHealthDetail,
                color: transcriptHealthColor
            )
        ]

        if hasDegradedStatus {
            rows.append(
                RecordingHealthRow(
                    title: "Needs attention",
                    detail: "Coverage is partial; recording continues.",
                    color: MeetlessDesignTokens.Colors.warningAmber
                )
            )
        }

        return rows
    }

    private var recordingSubtitle: String {
        hasDegradedStatus ? "Recording with limited coverage" : "Local audio and transcript are active"
    }

    private var audioHealthDetail: String {
        if viewModel.sourceStatuses.contains(where: { $0.state == .blocked }) {
            return "Access needs repair"
        }

        if hasDegradedStatus {
            return "One input is limited"
        }

        return "Capturing locally"
    }

    private var audioHealthColor: Color {
        if viewModel.sourceStatuses.contains(where: { $0.state == .blocked }) {
            return MeetlessDesignTokens.Colors.warningAmber
        }

        return hasDegradedStatus ? MeetlessDesignTokens.Colors.warningAmber : MeetlessDesignTokens.Colors.successGreen
    }

    private var transcriptHealthDetail: String {
        if viewModel.transcriptChunks.isEmpty {
            return "Waiting for speech"
        }

        return "\(viewModel.transcriptChunks.count) row\(viewModel.transcriptChunks.count == 1 ? "" : "s") committed"
    }

    private var transcriptHealthColor: Color {
        viewModel.transcriptChunks.isEmpty
            ? MeetlessDesignTokens.Colors.tertiaryText
            : MeetlessDesignTokens.Colors.successGreen
    }

    private var hasDegradedStatus: Bool {
        viewModel.sourceStatuses.contains { $0.state == .degraded }
    }

    private var transcriptCountLabel: String {
        viewModel.transcriptChunks.isEmpty
            ? "Live"
            : "\(viewModel.transcriptChunks.count) row\(viewModel.transcriptChunks.count == 1 ? "" : "s")"
    }

    private var waveformActivityLevel: Double {
        if hasDegradedStatus {
            return 0.36
        }

        return viewModel.transcriptChunks.isEmpty ? 0.52 : 0.72
    }

    private func formattedElapsed(at date: Date) -> String {
        let startedAt = viewModel.recordingStartedAt ?? date
        let totalSeconds = max(0, Int(date.timeIntervalSince(startedAt).rounded(.down)))
        let hours = totalSeconds / 3_600
        let minutes = (totalSeconds % 3_600) / 60
        let seconds = totalSeconds % 60

        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }

        return String(format: "%02d:%02d", minutes, seconds)
    }
}

private struct PermissionRepairPanel: View {
    @ObservedObject var viewModel: RecordingViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 12) {
                StatusDot(color: MeetlessDesignTokens.Colors.warningAmber, size: .medium)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Repair recording access")
                        .font(MeetlessDesignTokens.Typography.screenTitle)
                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                        .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

                    Text("Allow the missing access, then retry recording.")
                        .font(MeetlessDesignTokens.Typography.body)
                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                        .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                }

                Spacer(minLength: 12)

                Button(action: viewModel.toggleRecording) {
                    Label("Retry", systemImage: viewModel.controlSystemImage)
                        .font(MeetlessDesignTokens.Typography.body.weight(.semibold))
                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.isBusy)
            }

            VStack(spacing: 0) {
                ForEach(Array(viewModel.repairActions.enumerated()), id: \.element.id) { index, action in
                    repairRow(action)

                    if index < viewModel.repairActions.count - 1 {
                        HairlineDivider()
                    }
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(MeetlessDesignTokens.Colors.windowBackground)
        .overlay {
            RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous)
                .stroke(MeetlessDesignTokens.Colors.separator)
        }
        .clipShape(RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous))
    }

    private func repairRow(_ action: PermissionRepairAction) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: icon(for: action.kind))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(MeetlessDesignTokens.Colors.warningAmber)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 3) {
                Text(action.kind.title)
                    .font(MeetlessDesignTokens.Typography.body.weight(.medium))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

                Text(action.detail)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)

                if action.relaunchRequired {
                    Text("Relaunch required")
                        .font(MeetlessDesignTokens.Typography.caption)
                        .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                        .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)
                }
            }

            Spacer(minLength: 12)

            Link(destination: action.url) {
                Label("Open", systemImage: "arrow.up.forward.app")
                    .font(MeetlessDesignTokens.Typography.caption.weight(.semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
    }

    private func icon(for kind: RecordingPermissionKind) -> String {
        switch kind {
        case .screenRecording:
            return "rectangle.on.rectangle"
        case .microphone:
            return "mic"
        }
    }
}

private struct RecordingHealthRow: Identifiable {
    var id: String { title }
    let title: String
    let detail: String
    let color: Color
}

#Preview("Recording") {
    RecordingStatusBanner(viewModel: RecordingViewModel(coordinator: PreviewRecordingCoordinator()))
        .padding()
        .frame(width: 760)
}
