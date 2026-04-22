import Foundation

enum AppScreen: String, CaseIterable, Identifiable {
    case home
    case history
    case sessionDetail

    var id: Self { self }

    var title: String {
        switch self {
        case .home:
            return "Home"
        case .history:
            return "History"
        case .sessionDetail:
            return "Session Detail"
        }
    }

    var subtitle: String {
        switch self {
        case .home:
            return "Recording-first launch surface"
        case .history:
            return "Saved sessions land here later"
        case .sessionDetail:
            return "Transcript and metadata shell"
        }
    }

    var systemImage: String {
        switch self {
        case .home:
            return "record.circle"
        case .history:
            return "clock.arrow.circlepath"
        case .sessionDetail:
            return "text.document"
        }
    }
}
