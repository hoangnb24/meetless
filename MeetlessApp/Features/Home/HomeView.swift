import SwiftUI

struct HomeView: View {
    let viewModel: HomeViewModel
    @ObservedObject var recordingViewModel: RecordingViewModel
    let onOpenHistory: () -> Void
    let onOpenSessionDetail: () -> Void

    var body: some View {
        Group {
            if recordingViewModel.phase == .idle {
                readyView
            } else {
                ScrollView {
                    RecordingStatusBanner(viewModel: recordingViewModel)
                        .frame(maxWidth: MeetlessDesignTokens.Layout.contentMaxWidth, alignment: .leading)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    private var readyView: some View {
        VStack(spacing: MeetlessDesignTokens.Layout.largeGap) {
            Spacer(minLength: 28)

            VStack(spacing: 10) {
                Text(viewModel.readyTitle)
                    .font(.system(size: 34, weight: .semibold))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

                Text(viewModel.readyHelper)
                    .font(MeetlessDesignTokens.Typography.body)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            recordButton

            localStatusRows

            Spacer(minLength: 28)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var recordButton: some View {
        Button(action: recordingViewModel.toggleRecording) {
            Label(viewModel.primaryActionTitle, systemImage: recordingViewModel.controlSystemImage)
                .font(MeetlessDesignTokens.Typography.body.weight(.semibold))
                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                .frame(minWidth: 210, minHeight: 34)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(recordingViewModel.isBusy)
    }

    private var localStatusRows: some View {
        VStack(spacing: 0) {
            ForEach(Array(viewModel.localStatusRows.enumerated()), id: \.element.title) { index, row in
                localStatusRow(row)

                if index < viewModel.localStatusRows.count - 1 {
                    HairlineDivider()
                }
            }
        }
        .frame(width: 360)
    }

    private func localStatusRow(_ row: HomeViewModel.LocalStatusRow) -> some View {
        HStack(spacing: 10) {
            StatusDot(color: row.color)

            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(MeetlessDesignTokens.Typography.body.weight(.medium))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

                Text(row.detail)
                    .font(MeetlessDesignTokens.Typography.caption)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
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
