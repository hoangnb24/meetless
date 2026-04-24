import SwiftUI

struct LocalStatusFooter: View {
    var body: some View {
        HStack(spacing: MeetlessDesignTokens.Layout.compactGap) {
            StatusDot(color: MeetlessDesignTokens.Colors.successGreen)
            Text("Local")
                .font(MeetlessDesignTokens.Typography.caption)
                .tracking(MeetlessDesignTokens.Typography.letterSpacing)
                .foregroundStyle(MeetlessDesignTokens.Colors.secondaryText)

            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Local")
    }
}

#Preview {
    LocalStatusFooter()
        .padding()
        .frame(width: 190)
}
