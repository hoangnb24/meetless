import SwiftUI

struct HomeView: View {
    let viewModel: HomeViewModel
    @ObservedObject var recordingViewModel: RecordingViewModel
    let onOpenHistory: () -> Void
    let onOpenSessionDetail: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header
                primaryControlCard
                RecordingStatusBanner(viewModel: recordingViewModel)
            }
            .frame(maxWidth: 960, alignment: .leading)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(viewModel.eyebrow.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            Text(viewModel.title)
                .font(.system(size: 34, weight: .semibold, design: .rounded))
                .frame(maxWidth: 760, alignment: .leading)

            Text(viewModel.subtitle)
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 760, alignment: .leading)
        }
    }

    private var primaryControlCard: some View {
        VStack(alignment: .leading, spacing: 20) {
            ViewThatFits(in: .horizontal) {
                primaryControlHeader

                VStack(alignment: .leading, spacing: 14) {
                    primaryControlCopy
                    recordingSummary(alignment: .leading, textAlignment: .leading)
                }
            }

            ViewThatFits(in: .horizontal) {
                primaryActions
                primaryActionsVertical
            }

            Divider()

            smokeTranscriptionCard
        }
        .padding(24)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous))
    }

    private var primaryControlHeader: some View {
        HStack(alignment: .top, spacing: 20) {
            primaryControlCopy

            Spacer(minLength: 16)

            recordingSummary(alignment: .trailing, textAlignment: .trailing)
        }
    }

    private var primaryControlCopy: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Start from one obvious action")
                .font(.title2.weight(.semibold))
            Text("Meetless keeps Start/Stop simple while the bundled whisper bridge now proves local model loading and smoke transcription from inside the app.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func recordingSummary(alignment: HorizontalAlignment, textAlignment: TextAlignment) -> some View {
        VStack(alignment: alignment, spacing: 8) {
            Text(recordingViewModel.phaseDisplayTitle)
                .font(.headline)
            Text(recordingViewModel.headline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(textAlignment)
        }
    }

    private var primaryActions: some View {
        HStack(spacing: 12) {
            recordButton

            Button("Saved Sessions", action: onOpenHistory)
                .buttonStyle(.bordered)
        }
    }

    private var primaryActionsVertical: some View {
        VStack(alignment: .leading, spacing: 10) {
            recordButton

            Button("Saved Sessions", action: onOpenHistory)
                .buttonStyle(.bordered)
        }
    }

    private var recordButton: some View {
        Button(action: recordingViewModel.toggleRecording) {
            Label(recordingViewModel.controlTitle, systemImage: recordingViewModel.controlSystemImage)
                .font(.headline)
                .frame(minWidth: 180)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(recordingViewModel.isBusy)
    }

    private var smokeTranscriptionCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 16) {
                    smokeTranscriptionHeader

                    Spacer(minLength: 12)

                    smokeTranscriptionButton
                }

                VStack(alignment: .leading, spacing: 12) {
                    smokeTranscriptionHeader
                    smokeTranscriptionButton
                }
            }

            Text(recordingViewModel.smokeDetail)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Text(recordingViewModel.smokeTranscript)
                .font(.system(.body, design: .rounded))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .padding(20)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: MeetlessDesignTokens.Radius.panel, style: .continuous))
    }

    private var smokeTranscriptionHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Bundled Smoke Transcription", systemImage: "waveform.badge.magnifyingglass")
                .font(.headline)
            Text(recordingViewModel.smokeHeadline)
                .foregroundStyle(.secondary)
        }
    }

    private var smokeTranscriptionButton: some View {
        Button(action: recordingViewModel.runSmokeTranscription) {
            Label(recordingViewModel.smokeButtonTitle, systemImage: recordingViewModel.smokeButtonSystemImage)
        }
        .buttonStyle(.borderedProminent)
        .disabled(recordingViewModel.isSmokeBusy)
    }
}

#Preview {
    HomeView(
        viewModel: HomeViewModel(),
        recordingViewModel: RecordingViewModel(coordinator: PreviewRecordingCoordinator()),
        onOpenHistory: {},
        onOpenSessionDetail: {}
    )
    .frame(width: 1080, height: 720)
}
