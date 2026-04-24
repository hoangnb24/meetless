import SwiftUI

struct StatusDot: View {
    enum Size {
        case small
        case medium

        var value: CGFloat {
            switch self {
            case .small:
                8
            case .medium:
                10
            }
        }
    }

    let color: Color
    let size: Size

    init(color: Color, size: Size = .small) {
        self.color = color
        self.size = size
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size.value, height: size.value)
            .accessibilityHidden(true)
    }
}

#Preview {
    HStack(spacing: 12) {
        StatusDot(color: MeetlessDesignTokens.Colors.successGreen)
        StatusDot(color: MeetlessDesignTokens.Colors.recordingRed, size: .medium)
        StatusDot(color: MeetlessDesignTokens.Colors.warningAmber)
    }
    .padding()
}
