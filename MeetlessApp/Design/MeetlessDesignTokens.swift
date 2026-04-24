import SwiftUI

enum MeetlessDesignTokens {
    enum Colors {
        static let appBackground = Color(hex: 0xF4F5F6)
        static let windowBackground = Color(hex: 0xFFFFFF)
        static let sidebarBackground = Color(hex: 0xF2F2F4)
        static let sidebarSelection = Color(hex: 0xE4ECF8)
        static let primaryText = Color(hex: 0x1F2328)
        static let secondaryText = Color(hex: 0x66707A)
        static let tertiaryText = Color(hex: 0x8A929A)
        static let separator = Color(hex: 0xE5E7EB)
        static let primaryBlue = Color(hex: 0x256FE6)
        static let recordingRed = Color(hex: 0xE54842)
        static let successGreen = Color(hex: 0x55B96A)
        static let warningAmber = Color(hex: 0xC98221)
    }

    enum Layout {
        static let sidebarWidth: CGFloat = 190
        static let toolbarHeight: CGFloat = 54
        static let contentPadding: CGFloat = 28
        static let contentMaxWidth: CGFloat = 760
        static let compactGap: CGFloat = 8
        static let defaultGap: CGFloat = 16
        static let largeGap: CGFloat = 28
    }

    enum Radius {
        static let selection: CGFloat = 6
        static let button: CGFloat = 6
        static let row: CGFloat = 6
        static let panel: CGFloat = 8
    }

    enum Typography {
        static let letterSpacing: CGFloat = 0

        static let windowTitle = Font.system(size: 15, weight: .semibold)
        static let screenTitle = Font.system(size: 21, weight: .semibold)
        static let sectionTitle = Font.system(size: 13, weight: .semibold)
        static let body = Font.system(size: 13, weight: .regular)
        static let caption = Font.system(size: 11, weight: .regular)
        static let timer = Font.system(size: 30, weight: .regular, design: .monospaced)
    }
}

private extension Color {
    init(hex: UInt32) {
        let red = Double((hex >> 16) & 0xFF) / 255
        let green = Double((hex >> 8) & 0xFF) / 255
        let blue = Double(hex & 0xFF) / 255
        self.init(red: red, green: green, blue: blue)
    }
}
