import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var selectedScreen: AppScreen = .home
    @Published private(set) var selectedSessionID: String?
    @Published private(set) var selectedSessionDirectoryURL: URL?

    private let sessionRepository: SessionRepository
    private let geminiSessionNotesOrchestrator: any GeminiSessionNotesOrchestrating
    private var selectedSessionBundle: PersistedSessionBundle?

    let homeViewModel = HomeViewModel()
    let historyViewModel = HistoryViewModel()
    let sessionDetailViewModel = SessionDetailViewModel()
    let geminiSettingsViewModel: GeminiSettingsViewModel
    let recordingViewModel: RecordingViewModel

    init(
        sessionRepository: SessionRepository = SessionRepository(),
        recordingCoordinator: any RecordingCoordinating = MeetlessRecordingCoordinator(),
        geminiAPIKeyStore: any GeminiAPIKeyStoring = KeychainGeminiAPIKeyStore(),
        geminiSessionNotesOrchestrator: (any GeminiSessionNotesOrchestrating)? = nil
    ) {
        self.sessionRepository = sessionRepository
        self.geminiSessionNotesOrchestrator = geminiSessionNotesOrchestrator
            ?? GeminiSessionNotesOrchestrator(
                apiKeyStore: geminiAPIKeyStore,
                sessionRepository: sessionRepository
            )
        self.geminiSettingsViewModel = GeminiSettingsViewModel(apiKeyStore: geminiAPIKeyStore)
        self.recordingViewModel = RecordingViewModel(coordinator: recordingCoordinator)

        Task {
            await refreshSavedSessions()
            geminiSettingsViewModel.refreshStatus()
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
            sessionDetailViewModel.updateGeminiConfiguration(geminiSettingsViewModel.isConfigured)
            if selectedSessionID == nil {
                sessionDetailViewModel.showNoSelection()
            }
        case .settings:
            geminiSettingsViewModel.refreshStatus()
        case .home:
            break
        }
    }

    func openSessionDetail(for row: HistoryViewModel.Row) {
        selectedSessionID = row.id
        selectedSessionDirectoryURL = row.directoryURL
        selectedSessionBundle = nil
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

    func generateNotesForSelectedSession() {
        guard let selectedSessionID, let selectedSessionDirectoryURL, let selectedSessionBundle else {
            sessionDetailViewModel.showGenerationFailure(SessionDetailViewModel.GenerateFailure.noSelectedSession)
            return
        }

        guard geminiSettingsViewModel.isConfigured else {
            sessionDetailViewModel.showGenerationFailure(SessionDetailViewModel.GenerateFailure.missingAPIKey)
            return
        }

        guard sessionDetailViewModel.canGenerateNotes else {
            return
        }

        sessionDetailViewModel.beginGeneratingNotes()

        Task {
            do {
                _ = try await geminiSessionNotesOrchestrator.generateNotes(for: selectedSessionBundle)
                guard self.selectedSessionID == selectedSessionID else {
                    return
                }

                await loadSessionDetail(
                    sessionID: selectedSessionID,
                    directoryURL: selectedSessionDirectoryURL
                )
            } catch {
                guard self.selectedSessionID == selectedSessionID else {
                    return
                }

                sessionDetailViewModel.showGenerationFailure(error)
            }
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

            selectedSessionBundle = PersistedSessionBundle(
                id: detail.id,
                directoryURL: detail.directoryURL,
                startedAt: detail.startedAt,
                title: detail.title
            )
            sessionDetailViewModel.showDetail(detail)
            sessionDetailViewModel.updateGeminiConfiguration(geminiSettingsViewModel.isConfigured)
        } catch {
            guard selectedSessionID == sessionID else {
                return
            }

            selectedSessionBundle = nil
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
        selectedSessionBundle = nil
        sessionDetailViewModel.showNoSelection()
    }
}

@MainActor
final class GeminiSettingsViewModel: ObservableObject {
    enum KeyStatus: Equatable {
        case unknown
        case configured
        case notConfigured
        case error(String)

        var title: String {
            switch self {
            case .unknown:
                return "Checking"
            case .configured:
                return "Configured"
            case .notConfigured:
                return "Not configured"
            case .error:
                return "Needs attention"
            }
        }

        var detail: String {
            switch self {
            case .unknown:
                return "Checking the saved Gemini key."
            case .configured:
                return "A Gemini API key is saved in Keychain."
            case .notConfigured:
                return "Add a Gemini API key before generating session notes."
            case .error(let message):
                return message
            }
        }
    }

    @Published private(set) var keyStatus: KeyStatus = .unknown
    @Published private(set) var feedbackMessage: String?
    @Published var apiKeyInput = ""

    private let apiKeyStore: any GeminiAPIKeyStoring

    init(apiKeyStore: any GeminiAPIKeyStoring) {
        self.apiKeyStore = apiKeyStore
        refreshStatus()
    }

    var canSave: Bool {
        !apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var isConfigured: Bool {
        keyStatus == .configured
    }

    func refreshStatus() {
        do {
            let savedKey = try apiKeyStore.loadAPIKey()
            keyStatus = savedKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? .configured
                : .notConfigured
        } catch {
            keyStatus = .error(Self.safeMessage(for: error))
        }
    }

    func saveAPIKey() {
        let trimmedKey = apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedKey.isEmpty else {
            feedbackMessage = "Enter a Gemini API key before saving."
            return
        }

        do {
            try apiKeyStore.saveAPIKey(trimmedKey)
            apiKeyInput = ""
            keyStatus = .configured
            feedbackMessage = "Gemini API key saved."
        } catch {
            keyStatus = .error(Self.safeMessage(for: error))
            feedbackMessage = "The Gemini API key could not be saved."
        }
    }

    func deleteAPIKey() {
        do {
            try apiKeyStore.deleteAPIKey()
            apiKeyInput = ""
            keyStatus = .notConfigured
            feedbackMessage = "Gemini API key removed."
        } catch {
            keyStatus = .error(Self.safeMessage(for: error))
            feedbackMessage = "The Gemini API key could not be removed."
        }
    }

    private static func safeMessage(for error: Error) -> String {
        if let storeError = error as? GeminiAPIKeyStoreError {
            switch storeError {
            case .invalidStoredData:
                return "The saved Gemini key could not be read. Remove it and save a new key."
            case .keychainFailure:
                return "Keychain could not complete the request. Check macOS access and try again."
            }
        }

        return "Gemini key settings could not be updated. Try again."
    }
}
