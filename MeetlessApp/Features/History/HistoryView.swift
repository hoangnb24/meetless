import SwiftUI

struct HistoryView: View {
    @ObservedObject var viewModel: HistoryViewModel
    let onBackHome: () -> Void
    let onReload: () -> Void
    let onOpenSessionDetail: (HistoryViewModel.Row) -> Void
    let onDeleteSession: (HistoryViewModel.Row) -> Void
    @State private var pendingDeleteRow: HistoryViewModel.Row?

    var body: some View {
        VStack(alignment: .leading, spacing: MeetlessDesignTokens.Layout.defaultGap) {
            header

            if let actionMessage = viewModel.actionMessage {
                warningBanner(title: "Delete unavailable", body: actionMessage)
            }

            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .alert("Delete saved session?", isPresented: deleteConfirmationBinding, presenting: pendingDeleteRow) { row in
            Button("Delete", role: .destructive) {
                onDeleteSession(row)
            }
            Button("Cancel", role: .cancel) {}
        } message: { row in
            Text("This removes \(row.title) from local storage, including its transcript snapshot and raw audio artifacts.")
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(viewModel.title)
                .font(MeetlessDesignTokens.Typography.screenTitle)
                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)

            Text(viewModel.subtitle)
                .font(MeetlessDesignTokens.Typography.caption)
                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)

            Spacer(minLength: 16)

            Button(action: onReload) {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .font(MeetlessDesignTokens.Typography.body.weight(.medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading {
            loadingState
        } else if viewModel.rows.isEmpty {
            emptyState
        } else {
            sessionTable
        }
    }

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text("Loading saved sessions")
                .font(MeetlessDesignTokens.Typography.body)
                .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
        }
        .padding(.vertical, 22)
    }

    private var emptyState: some View {
        HStack(spacing: 10) {
            Image(systemName: "tray")
                .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)
            Text("No saved sessions yet")
                .font(MeetlessDesignTokens.Typography.body)
                .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
            Spacer()
        }
        .padding(.vertical, 22)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var sessionTable: some View {
        ScrollView {
            VStack(spacing: 0) {
                tableHeader

                HairlineDivider()

                ForEach(Array(viewModel.rows.enumerated()), id: \.element.id) { index, row in
                    sessionRow(row)

                    if index < viewModel.rows.count - 1 {
                        HairlineDivider()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var tableHeader: some View {
        HStack(spacing: 12) {
            columnLabel("Name")
                .frame(minWidth: 220, maxWidth: .infinity, alignment: .leading)
            columnLabel("Date")
                .frame(width: 142, alignment: .leading)
            columnLabel("Duration")
                .frame(width: 82, alignment: .leading)
            columnLabel("Status")
                .frame(width: 94, alignment: .leading)
            columnLabel("Action")
                .frame(width: 132, alignment: .trailing)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 2)
    }

    private func columnLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(MeetlessDesignTokens.Typography.letterSpacing)
            .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)
    }

    private func sessionRow(_ row: HistoryViewModel.Row) -> some View {
        HStack(alignment: .center, spacing: 12) {
            sessionNameCell(row)
                .frame(minWidth: 220, maxWidth: .infinity, alignment: .leading)

            Text(row.startedAtText)
                .font(MeetlessDesignTokens.Typography.caption)
                .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                .lineLimit(2)
                .frame(width: 142, alignment: .leading)

            Text(row.durationText)
                .font(MeetlessDesignTokens.Typography.caption.weight(.medium))
                .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                .frame(width: 82, alignment: .leading)

            statusPill(row)
                .frame(width: 94, alignment: .leading)

            actionButtons(row)
                .frame(width: 132, alignment: .trailing)
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }

    private func sessionNameCell(_ row: HistoryViewModel.Row) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.title)
                .font(MeetlessDesignTokens.Typography.body.weight(.medium))
                .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                .lineLimit(1)

            Text(row.rowSubtitleText)
                .font(MeetlessDesignTokens.Typography.caption)
                .foregroundStyle(
                    row.hasWarningState
                        ? MeetlessDesignTokens.Colors.warningAmber
                        : MeetlessDesignTokens.Colors.secondaryText
                )
                .lineLimit(1)
        }
    }

    private func statusPill(_ row: HistoryViewModel.Row) -> some View {
        HStack(spacing: 5) {
            StatusDot(
                color: row.hasWarningState
                    ? MeetlessDesignTokens.Colors.warningAmber
                    : MeetlessDesignTokens.Colors.successGreen
            )
            Text(row.compactStatusText)
                .font(MeetlessDesignTokens.Typography.caption.weight(.medium))
                .foregroundStyle(
                    row.hasWarningState
                        ? MeetlessDesignTokens.Colors.warningAmber
                        : MeetlessDesignTokens.Colors.secondaryText
                )
                .lineLimit(1)
        }
    }

    private func actionButtons(_ row: HistoryViewModel.Row) -> some View {
        HStack(spacing: 6) {
            Button(action: { onOpenSessionDetail(row) }) {
                Label("Detail", systemImage: "doc.text")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Button(role: .destructive) {
                pendingDeleteRow = row
            } label: {
                Label("Delete", systemImage: "trash")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityLabel("Delete \(row.title)")
        }
    }

    private func warningBanner(title: String, body: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(MeetlessDesignTokens.Colors.warningAmber)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(MeetlessDesignTokens.Typography.body.weight(.semibold))
                Text(body)
                    .font(MeetlessDesignTokens.Typography.caption)
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

    private var deleteConfirmationBinding: Binding<Bool> {
        Binding(
            get: { pendingDeleteRow != nil },
            set: { isPresented in
                if !isPresented {
                    pendingDeleteRow = nil
                }
            }
        )
    }
}

#Preview {
    HistoryView(viewModel: HistoryViewModel(), onBackHome: {}, onReload: {}, onOpenSessionDetail: { _ in }, onDeleteSession: { _ in })
        .frame(width: 1080, height: 720)
}
