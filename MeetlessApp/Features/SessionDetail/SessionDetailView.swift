import SwiftUI

struct SessionDetailView: View {
    let onBackToHistory: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Session detail shell")
                        .font(.system(size: 32, weight: .semibold, design: .rounded))
                    Text("This placeholder keeps transcript and metadata in one destination so persisted sessions can open here later without adding playback or editing controls in v1.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: 760, alignment: .leading)
                }

                VStack(alignment: .leading, spacing: 18) {
                    sectionCard(
                        title: "Transcript snapshot",
                        icon: "text.quote",
                        body: "Live chunks will render here exactly as they appeared during recording, preserving the v1 snapshot contract."
                    )

                    sectionCard(
                        title: "Session metadata",
                        icon: "calendar",
                        body: "Timestamp title, duration, source health, and incomplete-session state can all attach here once persistence lands."
                    )
                }

                Button("Back To History", action: onBackToHistory)
                    .buttonStyle(.borderedProminent)
            }
            .padding(32)
            .frame(maxWidth: 1100, alignment: .leading)
        }
    }

    private func sectionCard(title: String, icon: String, body: String) -> some View {
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
}

#Preview {
    SessionDetailView(onBackToHistory: {})
        .frame(width: 1080, height: 720)
}
