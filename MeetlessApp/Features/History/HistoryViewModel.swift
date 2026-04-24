import Foundation

@MainActor
final class HistoryViewModel: ObservableObject {
    struct Row: Identifiable {
        let id: String
        let directoryURL: URL
        let title: String
        let startedAtText: String
        let durationText: String
        let transcriptPreview: String
        let statusLabel: String?
        let savedSessionNotices: [SavedSessionNotice]

        init(summary: PersistedSessionSummary) {
            id = summary.id
            directoryURL = summary.directoryURL
            title = summary.title
            startedAtText = Self.startedAtFormatter.string(from: summary.startedAt)
            durationText = Self.durationText(for: summary.durationSeconds)

            let trimmedPreview = summary.transcriptPreview.trimmingCharacters(in: .whitespacesAndNewlines)
            transcriptPreview = trimmedPreview.isEmpty
                ? "No committed transcript preview was captured for this saved session yet."
                : trimmedPreview

            statusLabel = summary.isIncomplete ? "Incomplete" : nil
            savedSessionNotices = summary.savedSessionNotices
        }

        var warningNotices: [SavedSessionNotice] {
            savedSessionNotices.filter { $0.severity == .warning }
        }

        var compactStatusText: String {
            if let statusLabel {
                return statusLabel
            }

            if !warningNotices.isEmpty {
                return "Warning"
            }

            return "Complete"
        }

        var hasWarningState: Bool {
            statusLabel != nil || !warningNotices.isEmpty
        }

        private static let startedAtFormatter: DateFormatter = {
            let formatter = DateFormatter()
            formatter.locale = Locale.autoupdatingCurrent
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            return formatter
        }()

        private static func durationText(for durationSeconds: TimeInterval?) -> String {
            guard let durationSeconds else {
                return "In progress"
            }

            let formatter = DateComponentsFormatter()
            formatter.unitsStyle = .abbreviated
            formatter.allowedUnits = durationSeconds >= 3600 ? [.hour, .minute] : [.minute, .second]
            formatter.zeroFormattingBehavior = [.dropLeading]
            return formatter.string(from: durationSeconds) ?? "\(Int(durationSeconds)) sec"
        }
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var isLoading = true
    @Published private(set) var loadErrorMessage: String?
    @Published private(set) var actionMessage: String?

    var title: String {
        "Saved sessions"
    }

    var subtitle: String {
        if let loadErrorMessage {
            return loadErrorMessage
        }

        if isLoading {
            return "Reading local sessions."
        }

        if rows.isEmpty {
            return "No saved sessions yet."
        }

        return "\(rows.count) saved session\(rows.count == 1 ? "" : "s")"
    }

    func showLoading() {
        isLoading = true
        loadErrorMessage = nil
        actionMessage = nil
    }

    func showSessions(_ sessions: [PersistedSessionSummary]) {
        rows = sessions.map(Row.init(summary:))
        isLoading = false
        loadErrorMessage = nil
        actionMessage = nil
    }

    func showLoadFailure(_ error: Error) {
        rows = []
        isLoading = false
        loadErrorMessage = "Meetless could not read the saved session bundle directory: \(error.localizedDescription)"
        actionMessage = nil
    }

    func showDeleteFailure(title: String, error: Error) {
        actionMessage = "Meetless could not delete \(title): \(error.localizedDescription)"
    }
}
