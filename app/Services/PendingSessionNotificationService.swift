import Foundation

public enum PendingSessionNotificationKind: String, Sendable {
    case readyToTranscribe = "ready_to_transcribe"
    case completed
    case failed
}

public enum PendingSessionNotificationAction: Equatable, Sendable {
    case openSessionDetail(sessionID: String)
    case retryDeferredTranscription(sessionID: String)
}

public struct PendingSessionNotificationIntent: Equatable, Sendable {
    public var sessionID: String
    public var kind: PendingSessionNotificationKind
    public var title: String
    public var detail: String
    public var deepLinkSessionID: String
    public var outcomeCode: SessionOutcomeCode?
    public var outcomeDiagnostics: [String: String]
    public var primaryAction: PendingSessionNotificationAction
    public var secondaryAction: PendingSessionNotificationAction?

    public init(
        sessionID: String,
        kind: PendingSessionNotificationKind,
        title: String,
        detail: String,
        deepLinkSessionID: String,
        outcomeCode: SessionOutcomeCode? = nil,
        outcomeDiagnostics: [String: String] = [:],
        primaryAction: PendingSessionNotificationAction,
        secondaryAction: PendingSessionNotificationAction? = nil
    ) {
        self.sessionID = sessionID
        self.kind = kind
        self.title = title
        self.detail = detail
        self.deepLinkSessionID = deepLinkSessionID
        self.outcomeCode = outcomeCode
        self.outcomeDiagnostics = outcomeDiagnostics
        self.primaryAction = primaryAction
        self.secondaryAction = secondaryAction
    }
}

public protocol PendingSessionNotificationDetecting: Sendable {
    func detectTransitionNotifications(
        previous: [SessionSummaryDTO],
        current: [SessionSummaryDTO]
    ) -> [PendingSessionNotificationIntent]
}

public struct PendingSessionNotificationService: PendingSessionNotificationDetecting {
    public init() {}

    public func detectTransitionNotifications(
        previous: [SessionSummaryDTO],
        current: [SessionSummaryDTO]
    ) -> [PendingSessionNotificationIntent] {
        let previousByID = Dictionary(uniqueKeysWithValues: previous.map { ($0.sessionID, $0) })
        var notifications = [PendingSessionNotificationIntent]()

        for session in current {
            guard session.mode == .recordOnly else {
                continue
            }
            guard let prior = previousByID[session.sessionID] else {
                continue
            }

            if transitionedToReady(prior: prior, current: session) {
                notifications.append(
                    PendingSessionNotificationIntent(
                        sessionID: session.sessionID,
                        kind: .readyToTranscribe,
                        title: "Deferred session is ready.",
                        detail: "Session \(session.sessionID) can now be transcribed.",
                        deepLinkSessionID: session.sessionID,
                        outcomeCode: session.outcomeCode,
                        outcomeDiagnostics: session.outcomeDiagnostics,
                        primaryAction: .openSessionDetail(sessionID: session.sessionID)
                    )
                )
                continue
            }

            if transitionedToCompleted(prior: prior, current: session) {
                notifications.append(
                    PendingSessionNotificationIntent(
                        sessionID: session.sessionID,
                        kind: .completed,
                        title: "Deferred transcription completed.",
                        detail: "Session \(session.sessionID) is now finalized.",
                        deepLinkSessionID: session.sessionID,
                        outcomeCode: session.outcomeCode,
                        outcomeDiagnostics: session.outcomeDiagnostics,
                        primaryAction: .openSessionDetail(sessionID: session.sessionID)
                    )
                )
                continue
            }

            if transitionedToFailed(prior: prior, current: session) {
                notifications.append(
                    PendingSessionNotificationIntent(
                        sessionID: session.sessionID,
                        kind: .failed,
                        title: "Deferred transcription failed.",
                        detail: "Session \(session.sessionID) needs a retry.",
                        deepLinkSessionID: session.sessionID,
                        outcomeCode: session.outcomeCode,
                        outcomeDiagnostics: session.outcomeDiagnostics,
                        primaryAction: .retryDeferredTranscription(sessionID: session.sessionID),
                        secondaryAction: .openSessionDetail(sessionID: session.sessionID)
                    )
                )
            }
        }

        return notifications
    }

    private func transitionedToReady(
        prior: SessionSummaryDTO,
        current: SessionSummaryDTO
    ) -> Bool {
        prior.pendingTranscriptionState != .readyToTranscribe
            && current.pendingTranscriptionState == .readyToTranscribe
            && current.readyToTranscribe
            && current.outcomeCode == .partialArtifactSession
    }

    private func transitionedToCompleted(
        prior: SessionSummaryDTO,
        current: SessionSummaryDTO
    ) -> Bool {
        guard prior.pendingTranscriptionState != nil else {
            return false
        }
        return current.pendingTranscriptionState == nil
            && (current.outcomeCode == .finalizedSuccess || current.outcomeCode == .finalizedDegradedSuccess)
    }

    private func transitionedToFailed(
        prior: SessionSummaryDTO,
        current: SessionSummaryDTO
    ) -> Bool {
        prior.pendingTranscriptionState != .failed
            && (
                current.pendingTranscriptionState == .failed
                    || current.outcomeCode == .finalizedFailure
                    || current.status == .failed
            )
    }
}
