import SwiftUI

struct HistoryView: View {
    @ObservedObject var viewModel: HistoryViewModel
    let onBackHome: () -> Void
    let onReload: () -> Void

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
            .padding(32)
            .frame(maxWidth: 1100, alignment: .leading)
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
            HStack {
                Label("Local session bundles", systemImage: "externaldrive.badge.checkmark")
                    .font(.headline)
                Spacer()
                Button("Reload", action: onReload)
                    .buttonStyle(.bordered)
                Button("Back To Home", action: onBackHome)
                    .buttonStyle(.borderedProminent)
            }

            Text("History stays browse-only in v1. Search, filters, and playback are still intentionally absent.")
                .foregroundStyle(.secondary)

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
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(row.title)
                        .font(.title3.weight(.semibold))
                    Text(row.startedAtText)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 12)

                VStack(alignment: .trailing, spacing: 8) {
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
                }
            }

            Text(row.transcriptPreview)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

#Preview {
    HistoryView(viewModel: HistoryViewModel(), onBackHome: {}, onReload: {})
        .frame(width: 1080, height: 720)
}
