import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var selectedScreen: AppScreen = .home

    let homeViewModel = HomeViewModel()
    let historyViewModel = HistoryViewModel()
    let recordingViewModel: RecordingViewModel

    init(recordingCoordinator: any RecordingCoordinating = MeetlessRecordingCoordinator()) {
        self.recordingViewModel = RecordingViewModel(coordinator: recordingCoordinator)
    }

    func show(_ screen: AppScreen) {
        selectedScreen = screen
    }
}
