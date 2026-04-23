import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var selectedScreen: AppScreen = .home
    @Published private(set) var selectedSessionID: String?
    @Published private(set) var selectedSessionDirectoryURL: URL?

    private let sessionRepository: SessionRepository

    let homeViewModel = HomeViewModel()
    let historyViewModel = HistoryViewModel()
    let sessionDetailViewModel = SessionDetailViewModel()
    let recordingViewModel: RecordingViewModel

    init(
        sessionRepository: SessionRepository = SessionRepository(),
        recordingCoordinator: any RecordingCoordinating = MeetlessRecordingCoordinator()
    ) {
        self.sessionRepository = sessionRepository
        self.recordingViewModel = RecordingViewModel(coordinator: recordingCoordinator)

        Task {
            await refreshSavedSessions()
        }
    }

    func show(_ screen: AppScreen) {
        selectedScreen = screen

        switch screen {
        case .history:
            Task {
                await refreshSavedSessions()
            }
        case .sessionDetail:
            if selectedSessionID == nil {
                sessionDetailViewModel.showNoSelection()
            }
        case .home:
            break
        }
    }

    func openSessionDetail(for row: HistoryViewModel.Row) {
        selectedSessionID = row.id
        selectedSessionDirectoryURL = row.directoryURL
        selectedScreen = .sessionDetail
        sessionDetailViewModel.showLoading(title: row.title)

        Task {
            await loadSessionDetail(sessionID: row.id, directoryURL: row.directoryURL)
        }
    }

    func deleteSession(_ row: HistoryViewModel.Row) {
        Task {
            await deleteSession(
                sessionID: row.id,
                directoryURL: row.directoryURL,
                title: row.title
            )
        }
    }

    func deleteSelectedSession() {
        guard let selectedSessionID, let selectedSessionDirectoryURL else {
            return
        }

        Task {
            await deleteSession(
                sessionID: selectedSessionID,
                directoryURL: selectedSessionDirectoryURL,
                title: sessionDetailViewModel.title
            )
        }
    }

    func refreshSavedSessions() async {
        historyViewModel.showLoading()

        do {
            let sessions = try await sessionRepository.listSavedSessions()
            historyViewModel.showSessions(sessions)
        } catch {
            historyViewModel.showLoadFailure(error)
        }
    }

    private func loadSessionDetail(sessionID: String, directoryURL: URL) async {
        do {
            let detail = try await sessionRepository.loadSavedSessionDetail(at: directoryURL)
            guard selectedSessionID == sessionID else {
                return
            }

            sessionDetailViewModel.showDetail(detail)
        } catch {
            guard selectedSessionID == sessionID else {
                return
            }

            sessionDetailViewModel.showLoadFailure(title: nil, error: error)
        }
    }

    private func deleteSession(sessionID: String, directoryURL: URL, title: String) async {
        do {
            try await sessionRepository.deleteSavedSession(at: directoryURL)

            if selectedSessionID == sessionID {
                clearSelectedSession()
                selectedScreen = .history
            }

            await refreshSavedSessions()
        } catch {
            if selectedSessionID == sessionID && selectedScreen == .sessionDetail {
                sessionDetailViewModel.showDeleteFailure(title: title, error: error)
            } else {
                historyViewModel.showDeleteFailure(title: title, error: error)
            }
        }
    }

    private func clearSelectedSession() {
        selectedSessionID = nil
        selectedSessionDirectoryURL = nil
        sessionDetailViewModel.showNoSelection()
    }
}
