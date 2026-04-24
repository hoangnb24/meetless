import Foundation
import SwiftUI

struct HomeViewModel {
    struct LocalStatusRow {
        let title: String
        let detail: String
        let color: Color
    }

    let readyTitle = "Ready"
    let readyHelper = "Record locally on this Mac when the meeting starts."
    let primaryActionTitle = "Start Recording"

    let localStatusRows = [
        LocalStatusRow(
            title: "Local storage",
            detail: "Sessions stay on this Mac.",
            color: MeetlessDesignTokens.Colors.successGreen
        ),
        LocalStatusRow(
            title: "Permissions on demand",
            detail: "Meetless checks access when recording starts.",
            color: MeetlessDesignTokens.Colors.successGreen
        ),
        LocalStatusRow(
            title: "Live transcript",
            detail: "Transcript rows appear during recording.",
            color: MeetlessDesignTokens.Colors.successGreen
        )
    ]
}
