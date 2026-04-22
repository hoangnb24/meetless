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
                shellCards
            }
            .padding(32)
            .frame(maxWidth: 1100, alignment: .leading)
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
            HStack(alignment: .top, spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Start from one obvious action")
                        .font(.title2.weight(.semibold))
                    Text("The shell keeps Start/Stop simple while the bundled whisper bridge now proves local model loading and smoke transcription from inside the app.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 16)

                VStack(alignment: .trailing, spacing: 8) {
                    Text(recordingViewModel.phaseDisplayTitle)
                        .font(.headline)
                    Text(recordingViewModel.headline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
            }

            HStack(spacing: 16) {
                Button(action: recordingViewModel.toggleRecording) {
                    Label(recordingViewModel.controlTitle, systemImage: recordingViewModel.controlSystemImage)
                        .font(.headline)
                        .frame(minWidth: 220)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(recordingViewModel.isBusy)

                Button("History Shell", action: onOpenHistory)
                    .buttonStyle(.bordered)

                Button("Detail Shell", action: onOpenSessionDetail)
                    .buttonStyle(.bordered)
            }

            Divider()

            smokeTranscriptionCard

            VStack(alignment: .leading, spacing: 10) {
                ForEach(viewModel.shellHighlights, id: \.self) { line in
                    Label(line, systemImage: "checkmark.circle")
                        .foregroundStyle(.primary)
                }
            }
        }
        .padding(28)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private var smokeTranscriptionCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Bundled Smoke Transcription", systemImage: "waveform.badge.magnifyingglass")
                        .font(.headline)
                    Text(recordingViewModel.smokeHeadline)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 12)

                Button(action: recordingViewModel.runSmokeTranscription) {
                    Label(recordingViewModel.smokeButtonTitle, systemImage: recordingViewModel.smokeButtonSystemImage)
                }
                .buttonStyle(.borderedProminent)
                .disabled(recordingViewModel.isSmokeBusy)
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
        .padding(22)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private var shellCards: some View {
        HStack(alignment: .top, spacing: 18) {
            shellCard(
                title: "Recording coordination slot",
                icon: "waveform.and.mic",
                body: "The home surface already depends on a dedicated `RecordingViewModel`, so Story 2 can wire real capture and permission state into one place instead of rewriting the UI."
            )

            shellCard(
                title: "Navigation stays lightweight",
                icon: "square.grid.2x2",
                body: "Home, History, and Session Detail already live inside the same windowed shell. Later navigation work can deepen these screens without changing the app entry point."
            )

            shellCard(
                title: "Permission repair belongs here",
                icon: "lock.shield",
                body: "The primary action is where focused permission repair can intercept recording attempts, keeping onboarding minimal and on-demand."
            )
        }
    }

    private func shellCard(title: String, icon: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: icon)
                .font(.headline)

            Text(body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(22)
        .frame(maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
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
