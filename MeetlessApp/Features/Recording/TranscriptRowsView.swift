import SwiftUI

struct TranscriptRowsView: View {
    let chunks: [CommittedTranscriptChunk]
    let maxHeight: CGFloat

    init(chunks: [CommittedTranscriptChunk], maxHeight: CGFloat = 260) {
        self.chunks = chunks.sorted { first, second in
            if first.startTime == second.startTime {
                return first.sequenceNumber < second.sequenceNumber
            }

            return first.startTime < second.startTime
        }
        self.maxHeight = maxHeight
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if chunks.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(chunks.enumerated()), id: \.element.id) { index, chunk in
                            TranscriptRow(chunk: chunk)

                            if index < chunks.count - 1 {
                                HairlineDivider()
                            }
                        }
                    }
                }
                .frame(maxHeight: maxHeight)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var emptyState: some View {
        HStack(spacing: 10) {
            Image(systemName: "text.line.first.and.arrowtriangle.forward")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)

            Text("Transcript will appear as speech is transcribed.")
                .font(MeetlessDesignTokens.Typography.body)
                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
    }
}

private struct TranscriptRow: View {
    let chunk: CommittedTranscriptChunk

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 14, verticalSpacing: 0) {
            GridRow {
                Text(formattedStartTime)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.tertiaryText)
                    .frame(width: 44, alignment: .leading)
                    .padding(.top, 1)

                Text(chunk.text)
                    .font(MeetlessDesignTokens.Typography.body)
                    .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                    .foregroundStyle(MeetlessDesignTokens.Colors.primaryText)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(formattedStartTime), \(chunk.text)")
    }

    private var formattedStartTime: String {
        let totalSeconds = max(0, Int(chunk.startTime.rounded(.down)))
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%01d:%02d", minutes, seconds)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 20) {
        TranscriptRowsView(chunks: [
            CommittedTranscriptChunk(
                id: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA") ?? UUID(),
                source: .meeting,
                text: "We can keep every word local and still show stable chunks as they commit.",
                startFrameIndex: 0,
                endFrameIndex: 64_000,
                sampleRate: 16_000,
                sequenceNumber: 1
            ),
            CommittedTranscriptChunk(
                id: UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB") ?? UUID(),
                source: .me,
                text: "That gives saved sessions the same transcript timeline the operator already saw.",
                startFrameIndex: 64_000,
                endFrameIndex: 128_000,
                sampleRate: 16_000,
                sequenceNumber: 2
            )
        ])

        TranscriptRowsView(chunks: [])
    }
    .padding()
    .frame(width: 460)
}
