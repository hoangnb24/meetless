import Foundation

private enum SmokeError: Error {
    case assertionFailed(String)
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw SmokeError.assertionFailed(message)
    }
}

private func makeSession(
    id: String,
    startedAt: Date,
    mode: RuntimeMode,
    status: SessionStatus,
    pendingState: PendingTranscriptionState? = nil,
    readyToTranscribe: Bool = false
) -> SessionSummaryDTO {
    SessionSummaryDTO(
        sessionID: id,
        startedAt: startedAt,
        durationMs: 10_000,
        mode: mode,
        status: status,
        rootPath: URL(fileURLWithPath: "/tmp/\(id)", isDirectory: true),
        pendingTranscriptionState: pendingState,
        readyToTranscribe: readyToTranscribe,
        outcomeClassification: outcomeClassification(for: status)
    )
}

private func outcomeClassification(for status: SessionStatus) -> SessionOutcomeClassification {
    switch status {
    case .pending:
        return .partialArtifact
    case .ok, .degraded:
        return .finalizedSuccess
    case .failed:
        return .finalizedFailure
    }
}

private actor MockPendingSessionTranscriptionService: PendingSessionTranscribing {
    private(set) var requestedSessionIDs: [String] = []
    var failNext = false

    func requestedIDs() -> [String] {
        requestedSessionIDs
    }

    func transcribePendingSession(
        summary: SessionSummaryDTO,
        timeoutSeconds: TimeInterval
    ) async throws -> PendingSessionActionResult {
        requestedSessionIDs.append(summary.sessionID)
        if failNext {
            failNext = false
            throw AppServiceError(
                code: .processExitedUnexpectedly,
                userMessage: "Synthetic transcription failure.",
                remediation: "Retry."
            )
        }
        return PendingSessionActionResult(
            sessionID: summary.sessionID,
            finalState: .completed,
            processIdentifier: 4242
        )
    }
}

private struct QueryTriggeredFailureSessionLibraryService: SessionLibraryService {
    private let seed: [SessionSummaryDTO]

    init(seed: [SessionSummaryDTO]) {
        self.seed = seed
    }

    func listSessions(query: SessionQuery) throws -> [SessionSummaryDTO] {
        if query.searchText == "trigger_error" {
            throw AppServiceError(
                code: .ioFailure,
                userMessage: "Synthetic failure.",
                remediation: "Retry."
            )
        }
        return seed
    }

    func deleteSession(
        sessionID: String,
        rootPath: URL,
        confirmTrash: Bool
    ) throws -> SessionDeletionResultDTO {
        throw AppServiceError(
            code: .invalidInput,
            userMessage: "Not used in smoke.",
            remediation: "N/A"
        )
    }
}

private struct SequencedSessionLibraryService: SessionLibraryService {
    let defaultSnapshot: [SessionSummaryDTO]
    let snapshotsBySearchText: [String: [SessionSummaryDTO]]

    func listSessions(query: SessionQuery) throws -> [SessionSummaryDTO] {
        guard
            let rawSearchText = query.searchText?.trimmingCharacters(in: .whitespacesAndNewlines),
            !rawSearchText.isEmpty
        else {
            return defaultSnapshot
        }

        return snapshotsBySearchText[rawSearchText] ?? defaultSnapshot
    }

    func deleteSession(
        sessionID: String,
        rootPath: URL,
        confirmTrash: Bool
    ) throws -> SessionDeletionResultDTO {
        throw AppServiceError(
            code: .invalidInput,
            userMessage: "Not used in smoke.",
            remediation: "N/A"
        )
    }
}

@main
struct SessionListSmoke {
    static func main() async throws {
        let now = Date(timeIntervalSince1970: 1_730_800_000)
        let sessions = [
            makeSession(id: "live-a", startedAt: now, mode: .live, status: .ok),
            makeSession(
                id: "pending-b",
                startedAt: now.addingTimeInterval(60),
                mode: .recordOnly,
                status: .pending,
                pendingState: .readyToTranscribe,
                readyToTranscribe: true
            ),
            makeSession(id: "record-c", startedAt: now.addingTimeInterval(-60), mode: .recordOnly, status: .failed)
        ]

        let mock = MockSessionLibraryService(sessions: sessions)
        let vm = SessionListViewModel(sessionLibrary: mock)

        try require(
            SessionListViewModel.focusPlan.orderedElementIDs == SessionListViewModel.accessibilityElements.map(\.id),
            "session list accessibility focus plan should match element declaration order"
        )
        try require(
            !SessionListViewModel.keyboardShortcuts.isEmpty,
            "session list should expose keyboard shortcuts for keyboard-first operation"
        )

        vm.refresh()
        guard case let .loaded(items) = vm.state else {
            throw SmokeError.assertionFailed("expected loaded state after initial refresh")
        }
        try require(items.map(\.sessionID) == ["pending-b", "live-a", "record-c"], "unexpected ordering")

        vm.setModeFilter(.recordOnly)
        guard case let .loaded(modeItems) = vm.state else {
            throw SmokeError.assertionFailed("mode filter did not return loaded state")
        }
        try require(modeItems.map(\.sessionID) == ["pending-b", "record-c"], "mode filter failed")

        vm.setStatusFilter(.pending)
        guard case let .loaded(statusItems) = vm.state else {
            throw SmokeError.assertionFailed("status filter did not return loaded state")
        }
        try require(statusItems.map(\.sessionID) == ["pending-b"], "status filter failed")

        vm.setSearchText("nope")
        guard case .empty = vm.state else {
            throw SmokeError.assertionFailed("expected empty state for unmatched search")
        }

        vm.clearFilters()
        guard case .loaded = vm.state else {
            throw SmokeError.assertionFailed("expected loaded state after clearing filters")
        }

        let flaky = QueryTriggeredFailureSessionLibraryService(seed: [sessions[0]])
        let flakyVM = SessionListViewModel(sessionLibrary: flaky)
        flakyVM.refresh()
        flakyVM.setSearchText("trigger_error")
        guard case let .failed(_, recoverableItems) = flakyVM.state else {
            throw SmokeError.assertionFailed("expected failed state after triggered error")
        }
        try require(
            recoverableItems.map(\.sessionID) == ["live-a"],
            "expected recoverable fallback items on refresh failure"
        )

        let transcriptionMock = MockPendingSessionTranscriptionService()
        let actionVM = SessionListViewModel(
            sessionLibrary: mock,
            pendingTranscriptionService: transcriptionMock
        )
        actionVM.refresh()
        await actionVM.transcribePendingSession(sessionID: "pending-b")
        let requestedIDs = await transcriptionMock.requestedIDs()
        try require(requestedIDs == ["pending-b"], "expected transcribe action to run only on ready session")

        await actionVM.transcribePendingSession(sessionID: "record-c")
        guard case let .failed(error, recoverableItems) = actionVM.state else {
            throw SmokeError.assertionFailed("expected failed state for non-ready transcription action")
        }
        try require(error.code == .invalidInput, "non-ready action should reject with invalid input")
        try require(!recoverableItems.isEmpty, "recoverable items should be preserved on action failure")

        let transitioningReady = makeSession(
            id: "deferred-ready",
            startedAt: now.addingTimeInterval(120),
            mode: .recordOnly,
            status: .pending,
            pendingState: .pendingModel,
            readyToTranscribe: false
        )
        let transitioningFailed = makeSession(
            id: "deferred-failed",
            startedAt: now.addingTimeInterval(121),
            mode: .recordOnly,
            status: .pending,
            pendingState: .readyToTranscribe,
            readyToTranscribe: true
        )
        let snapshotOne = [transitioningReady, transitioningFailed]
        let snapshotTwo = [
            makeSession(
                id: "deferred-ready",
                startedAt: transitioningReady.startedAt,
                mode: .recordOnly,
                status: .pending,
                pendingState: .readyToTranscribe,
                readyToTranscribe: true
            ),
            makeSession(
                id: "deferred-failed",
                startedAt: transitioningFailed.startedAt,
                mode: .recordOnly,
                status: .failed,
                pendingState: .failed,
                readyToTranscribe: false
            )
        ]
        let snapshotThree = [
            makeSession(
                id: "deferred-ready",
                startedAt: transitioningReady.startedAt,
                mode: .recordOnly,
                status: .ok,
                pendingState: nil,
                readyToTranscribe: false
            ),
            makeSession(
                id: "deferred-failed",
                startedAt: transitioningFailed.startedAt,
                mode: .recordOnly,
                status: .failed,
                pendingState: .failed,
                readyToTranscribe: false
            )
        ]

        let sequenceVM = SessionListViewModel(
            sessionLibrary: SequencedSessionLibraryService(
                defaultSnapshot: snapshotOne,
                snapshotsBySearchText: [
                    "phase-two": snapshotTwo,
                    "phase-three": snapshotThree
                ]
            )
        )
        sequenceVM.refresh()
        try require(
            sequenceVM.consumePendingNotifications().isEmpty,
            "initial snapshot should not emit transition notifications"
        )

        sequenceVM.setSearchText("phase-two")
        let transitionNotices = sequenceVM.consumePendingNotifications()
        try require(transitionNotices.count == 2, "expected ready + failed transition notifications")
        let kinds = transitionNotices.map(\.kind)
        try require(kinds.contains(.readyToTranscribe), "expected ready transition notification")
        try require(kinds.contains(.failed), "expected failed transition notification")
        let failedNotice = transitionNotices.first { $0.kind == .failed }
        try require(
            failedNotice?.primaryAction == .retryDeferredTranscription(sessionID: "deferred-failed"),
            "failed transition should expose retry action"
        )
        try require(
            failedNotice?.secondaryAction == .openSessionDetail(sessionID: "deferred-failed"),
            "failed transition should expose deep-link detail fallback"
        )

        sequenceVM.setSearchText("phase-three")
        let completionNotices = sequenceVM.consumePendingNotifications()
        try require(completionNotices.count == 1, "expected one completion notification")
        try require(completionNotices.first?.kind == .completed, "expected completed transition kind")
        try require(
            completionNotices.first?.deepLinkSessionID == "deferred-ready",
            "completion notice should deep-link to session detail"
        )

        print("bd-2i3h smoke ok")
    }
}
