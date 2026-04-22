import SwiftUI

struct HistoryView: View {
    let viewModel: HistoryViewModel
    let onBackHome: () -> Void
    let onOpenSessionDetail: () -> Void

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

                HStack(alignment: .top, spacing: 18) {
                    VStack(alignment: .leading, spacing: 16) {
                        Label("No saved sessions yet", systemImage: "tray")
                            .font(.headline)
                        Text("Story 3 will populate this list from local session bundles. The shell is already positioned to show browse-only history without introducing search or filters.")
                            .foregroundStyle(.secondary)
                        HStack(spacing: 12) {
                            Button("Back To Home", action: onBackHome)
                                .buttonStyle(.borderedProminent)
                            Button("Open Detail Shell", action: onOpenSessionDetail)
                                .buttonStyle(.bordered)
                        }
                    }
                    .padding(22)
                    .frame(maxWidth: .infinity, minHeight: 210, alignment: .topLeading)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))

                    VStack(alignment: .leading, spacing: 16) {
                        Text("Planned row contract")
                            .font(.headline)

                        ForEach(viewModel.rowFields, id: \.self) { field in
                            Label(field, systemImage: "checkmark.circle")
                        }

                        Text("Delete and incomplete-session status will attach to the same local bundle model instead of changing this screen later.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(22)
                    .frame(maxWidth: .infinity, minHeight: 210, alignment: .topLeading)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                }
            }
            .padding(32)
            .frame(maxWidth: 1100, alignment: .leading)
        }
    }
}

#Preview {
    HistoryView(viewModel: HistoryViewModel(), onBackHome: {}, onOpenSessionDetail: {})
        .frame(width: 1080, height: 720)
}
