import SwiftUI

struct WaveformMeterView: View {
    let activityLevel: Double
    let isActive: Bool
    let barCount: Int
    let tint: Color

    init(
        activityLevel: Double = 0.62,
        isActive: Bool = true,
        barCount: Int = 28,
        tint: Color = MeetlessDesignTokens.Colors.recordingRed
    ) {
        self.activityLevel = min(max(activityLevel, 0), 1)
        self.isActive = isActive
        self.barCount = max(8, barCount)
        self.tint = tint
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: isActive ? 0.14 : 1, paused: !isActive)) { timeline in
            GeometryReader { geometry in
                HStack(alignment: .center, spacing: 3) {
                    ForEach(0..<barCount, id: \.self) { index in
                        Capsule(style: .continuous)
                            .fill(barColor)
                            .frame(width: barWidth(in: geometry.size), height: barHeight(for: index, date: timeline.date, in: geometry.size))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        }
        .frame(height: 34)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isActive ? "Audio activity" : "Audio idle")
    }

    private var barColor: Color {
        isActive ? tint : MeetlessDesignTokens.Colors.tertiaryText.opacity(0.45)
    }

    private func barWidth(in size: CGSize) -> CGFloat {
        let totalSpacing = CGFloat(barCount - 1) * 3
        return max(2, floor((size.width - totalSpacing) / CGFloat(barCount)))
    }

    private func barHeight(for index: Int, date: Date, in size: CGSize) -> CGFloat {
        let maximumHeight = max(12, size.height)
        let minimumHeight = max(4, maximumHeight * 0.18)
        let position = Double(index) / Double(max(barCount - 1, 1))
        let base = 0.35 + (sin(position * .pi) * 0.38)
        let pulse = isActive ? (sin(date.timeIntervalSinceReferenceDate * 5.2 + Double(index) * 0.72) + 1) * 0.16 : 0
        let scaledLevel = 0.42 + (activityLevel * 0.58)
        let height = maximumHeight * min(max((base + pulse) * scaledLevel, 0.12), 1)

        return max(minimumHeight, height)
    }
}

#Preview {
    VStack(spacing: 18) {
        WaveformMeterView()
            .frame(width: 320)

        WaveformMeterView(activityLevel: 0.28, isActive: false, tint: MeetlessDesignTokens.Colors.tertiaryText)
            .frame(width: 320)
    }
    .padding()
}
