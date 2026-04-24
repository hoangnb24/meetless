import SwiftUI

struct HistoryView: View {
    @ObservedObject var viewModel: HistoryViewModel
    let onBackHome: () -> Void
    let onReload: () -> Void
    let onOpenSessionDetail: (HistoryViewModel.Row) -> Void
    let onDeleteSession: (HistoryViewModel.Row) -> Void
    @State private var pendingDeleteRow: HistoryViewModel.Row?

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

                contentCard

                rowContractCard
            }
            .frame(maxWidth: 960, alignment: .leading)
        }
        .alert("Delete saved session?", isPresented: deleteConfirmationBinding, presenting: pendingDeleteRow) { row in
            Button("Delete", role: .destructive) {
                onDeleteSession(row)
            }
            Button("Cancel", role: .cancel) {}
        } message: { row in
            Text("This removes \(row.title) from local storage, including its transcript snapshot and raw audio artifacts.")
        }
    }

    @ViewBuilder
    private var contentCard: some View {
        if viewModel.isLoading {
            loadingCard
        } else if viewModel.rows.isEmpty {
            emptyStateCard
        } else {
            sessionListCard
        }
    }

    private var loadingCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Loading saved sessions")
                .font(.headline)
            Text("Meetless is scanning the local Application Support bundle directory and decoding saved session manifests.")
                .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button("Back To Home", action: onBackHome)
                    .buttonStyle(.borderedProminent)
                Button("Reload", action: onReload)
                    .buttonStyle(.bordered)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var emptyStateCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("No saved sessions yet", systemImage: "tray")
                .font(.headline)
            Text("Run a local recording and stop it once to create the first saved bundle. Meetless will then show it here with its title, time, duration, preview, and incomplete status if capture ended unexpectedly.")
                .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button("Back To Home", action: onBackHome)
                    .buttonStyle(.borderedProminent)
                Button("Reload", action: onReload)
                    .buttonStyle(.bordered)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var sessionListCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    sessionListTitle
                    Spacer()
                    sessionListActions
                }

                VStack(alignment: .leading, spacing: 12) {
                    sessionListTitle
                    sessionListActionsVertical
                }
            }

            Text("History stays browse-only in v1. Search, filters, and playback are still intentionally absent.")
                .foregroundStyle(.secondary)

            honestyCard

            if let actionMessage = viewModel.actionMessage {
                warningBanner(title: "Delete unavailable", body: actionMessage)
            }

            LazyVStack(spacing: 14) {
                ForEach(viewModel.rows) { row in
                    sessionRow(row)
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var sessionListTitle: some View {
        Label("Local session bundles", systemImage: "externaldrive.badge.checkmark")
            .font(.headline)
    }

    private var sessionListActions: some View {
        HStack(spacing: 12) {
            reloadButton
            backHomeButton
        }
    }

    private var sessionListActionsVertical: some View {
        VStack(alignment: .leading, spacing: 10) {
            reloadButton
            backHomeButton
        }
    }

    private var reloadButton: some View {
        Button("Reload", action: onReload)
            .buttonStyle(.bordered)
    }

    private var backHomeButton: some View {
        Button("Back To Home", action: onBackHome)
            .buttonStyle(.borderedProminent)
    }

    private var honestyCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Saved-session honesty", systemImage: "checkmark.shield")
                .font(.headline)
            Text("Meetless shows the saved transcript snapshot plus any warning markers that were written into the local bundle. If a bundle has no extra markers yet, the app stays limited to what the saved bundle recorded.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var rowContractCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Row contract")
                .font(.headline)

            ForEach(viewModel.rowFields, id: \.self) { field in
                Label(field, systemImage: "checkmark.circle")
            }

            Text("Incomplete sessions remain in the same list instead of disappearing, so the saved bundle stays visible even when capture did not end cleanly.")
                .foregroundStyle(.secondary)
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func sessionRow(_ row: HistoryViewModel.Row) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    sessionRowTitle(row)

                    Spacer(minLength: 12)

                    sessionRowStatus(row, alignment: .trailing, textAlignment: .trailing)
                }

                VStack(alignment: .leading, spacing: 10) {
                    sessionRowTitle(row)
                    sessionRowStatus(row, alignment: .leading, textAlignment: .leading)
                }
            }

            Text(row.transcriptPreview)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            ForEach(row.warningNotices) { notice in
                warningBanner(title: notice.title, body: notice.message)
            }

            HStack(spacing: 12) {
                Button(action: { onOpenSessionDetail(row) }) {
                    Label("Open transcript snapshot", systemImage: "arrow.right.circle")
                }
                .buttonStyle(.borderedProminent)

                Button(role: .destructive) {
                    pendingDeleteRow = row
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func sessionRowTitle(_ row: HistoryViewModel.Row) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(row.title)
                .font(.title3.weight(.semibold))
            Text(row.startedAtText)
                .foregroundStyle(.secondary)
        }
    }

    private func sessionRowStatus(
        _ row: HistoryViewModel.Row,
        alignment: HorizontalAlignment,
        textAlignment: TextAlignment
    ) -> some View {
        VStack(alignment: alignment, spacing: 8) {
            if let statusLabel = row.statusLabel {
                Text(statusLabel)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.orange.opacity(0.16), in: Capsule())
                    .foregroundStyle(Color.orange)
            }

            Text(row.durationText)
                .font(.headline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(textAlignment)
        }
    }

    private func warningBanner(title: String, body: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(Color.orange)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
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
