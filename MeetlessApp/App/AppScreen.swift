import Foundation

enum AppScreen: String, CaseIterable, Identifiable {
    case home
    case history
    case sessionDetail

    var id: Self { self }

    static let primaryNavigationCases: [AppScreen] = [.home, .history]

    var title: String {
        switch self {
        case .home:
            return "Record"
        case .history:
            return "Sessions"
        case .sessionDetail:
            return "Session Detail"
        }
    }

    var subtitle: String {
        switch self {
        case .home:
            return "Start and monitor recording"
        case .history:
            return "Browse saved sessions"
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
