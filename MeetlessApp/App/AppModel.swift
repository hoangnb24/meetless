import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var selectedScreen: AppScreen = .home

    private let sessionRepository: SessionRepository

    let homeViewModel = HomeViewModel()
    let historyViewModel = HistoryViewModel()
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

        guard screen == .history else {
            return
        }

        Task {
            await refreshSavedSessions()
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
}
