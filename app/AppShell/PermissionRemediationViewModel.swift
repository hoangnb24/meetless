import Foundation
import AVFoundation
import CoreGraphics

private func defaultNativePermissionStatus(_ permission: RemediablePermission) -> Bool {
    // Keep UI automation deterministic by honoring fixture-only outcomes.
    if ProcessInfo.processInfo.environment["RECORDIT_UI_TEST_MODE"] == "1" {
        return false
    }

    switch permission {
    case .screenRecording:
        return CGPreflightScreenCaptureAccess()
    case .microphone:
        return AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }
}

public enum RemediablePermission: String, Equatable, Sendable {
    case screenRecording = "screen_recording"
    case microphone
}

public enum PermissionRemediationSurface: String, Equatable, Sendable {
    case screenRecording = "screen_recording"
    case activeDisplay = "active_display"
    case microphone

    public var title: String {
        switch self {
        case .screenRecording:
            return "Screen Recording"
        case .activeDisplay:
            return "Active Display"
        case .microphone:
            return "Microphone"
        }
    }

    public var settingsPermission: RemediablePermission? {
        switch self {
        case .screenRecording:
            return .screenRecording
        case .microphone:
            return .microphone
        case .activeDisplay:
            return nil
        }
    }
}

public enum PermissionReadiness: String, Equatable, Sendable {
    case granted
    case missingPermission = "missing_permission"
    case noActiveDisplay = "no_active_display"
    case runtimeFailure = "runtime_failure"
    case diagnosticsUnavailable = "diagnostics_unavailable"

    public var isBlocking: Bool {
        self != .granted
    }

    public var statusLabel: String {
        switch self {
        case .granted:
            return "Granted"
        case .missingPermission:
            return "Permission Needed"
        case .noActiveDisplay:
            return "No Active Display"
        case .runtimeFailure:
            return "Runtime Check Failed"
        case .diagnosticsUnavailable:
            return "Diagnostics Unavailable"
        }
    }
}

public struct PermissionRemediationItem: Equatable, Sendable {
    public var surface: PermissionRemediationSurface
    public var status: PermissionReadiness
    public var checkIDs: [String]
    public var detail: String
    public var remediation: String

    public init(
        surface: PermissionRemediationSurface,
        status: PermissionReadiness,
        checkIDs: [String],
        detail: String,
        remediation: String
    ) {
        self.surface = surface
        self.status = status
        self.checkIDs = checkIDs
        self.detail = detail
        self.remediation = remediation
    }
}

@MainActor
public final class PermissionRemediationViewModel {
    public enum State: Equatable {
        case idle
        case checking
        case ready([PermissionRemediationItem])
        case failed(AppServiceError)
    }

    public static let screenRecordingRestartAdvisory =
        "You may need to quit and reopen Recordit after changing Screen Recording access."

    public private(set) var state: State = .idle
    public private(set) var shouldShowScreenRecordingRestartAdvisory = false
    public private(set) var lastOpenedSettingsURL: URL?

    private let runner: RecorditPreflightRunner
    private let openSystemSettings: (URL) -> Void
    private let nativePermissionStatus: (RemediablePermission) -> Bool

    public init(
        runner: RecorditPreflightRunner = RecorditPreflightRunner(),
        openSystemSettings: @escaping (URL) -> Void = { _ in },
        nativePermissionStatus: ((RemediablePermission) -> Bool)? = nil
    ) {
        self.runner = runner
        self.openSystemSettings = openSystemSettings
        self.nativePermissionStatus = nativePermissionStatus ?? defaultNativePermissionStatus
    }

    public var remediationItems: [PermissionRemediationItem] {
        guard case let .ready(items) = state else {
            return []
        }
        return items
    }

    public var missingPermissions: [RemediablePermission] {
        switch state {
        case .ready(let items):
            return items.compactMap { item in
                guard item.status == .missingPermission else {
                    return nil
                }
                return item.surface.settingsPermission
            }
        case .failed:
            // Fail-open for remediation affordances so onboarding never strands users
            // without the direct privacy deep-links.
            return [.screenRecording, .microphone]
        case .idle, .checking:
            return []
        }
    }

    public var hasBlockingIssues: Bool {
        switch state {
        case .ready(let items):
            return items.contains { $0.status.isBlocking }
        case .failed:
            return true
        case .idle, .checking:
            return true
        }
    }

    public func runPermissionCheck() {
        recheckPermissions()
    }

    public func recheckPermissions() {
        state = .checking
        do {
            let envelope = try runner.runLivePreflight()
            state = .ready(
                Self.mapPermissionItems(
                    from: envelope,
                    nativePermissionStatus: nativePermissionStatus
                )
            )
        } catch let serviceError as AppServiceError {
            state = .ready(
                Self.nativePermissionFallbackItems(
                    nativePermissionStatus: nativePermissionStatus,
                    preflightFailure: serviceError
                )
            )
        } catch {
            let serviceError = AppServiceError(
                code: .unknown,
                userMessage: "Permission checks could not complete.",
                remediation: "Retry the permission check and inspect preflight diagnostics.",
                debugDetail: String(describing: error)
            )
            state = .ready(
                Self.nativePermissionFallbackItems(
                    nativePermissionStatus: nativePermissionStatus,
                    preflightFailure: serviceError
                )
            )
        }
    }

    @discardableResult
    public func openSettings(for permission: RemediablePermission) -> Bool {
        guard let url = Self.settingsURL(for: permission) else {
            return false
        }
        openSystemSettings(url)
        lastOpenedSettingsURL = url
        if permission == .screenRecording {
            shouldShowScreenRecordingRestartAdvisory = true
        }
        return true
    }

    public func dismissScreenRecordingRestartAdvisory() {
        shouldShowScreenRecordingRestartAdvisory = false
    }

    public static func settingsURL(for permission: RemediablePermission) -> URL? {
        switch permission {
        case .screenRecording:
            return URL(
                string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            )
        case .microphone:
            return URL(
                string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            )
        }
    }

    public static func mapPermissionItems(
        from envelope: PreflightManifestEnvelopeDTO,
        nativePermissionStatus: ((RemediablePermission) -> Bool)? = nil
    ) -> [PermissionRemediationItem] {
        let resolvedNativePermissionStatus = nativePermissionStatus ?? defaultNativePermissionStatus
        let screenPermissionChecks = envelope.checks.filter { $0.id == ReadinessContractID.screenCaptureAccess.rawValue }
        let displayChecks = envelope.checks.filter { $0.id == ReadinessContractID.displayAvailability.rawValue }
        let microphoneChecks = envelope.checks.filter { $0.id == ReadinessContract.microphonePermissionID }

        var items = [
            buildPermissionItem(
                surface: .screenRecording,
                permission: .screenRecording,
                checks: screenPermissionChecks,
                nativePermissionStatus: resolvedNativePermissionStatus,
                defaultDetail: "Screen Recording access is required to capture system audio.",
                defaultRemediation: "Open System Settings, grant Screen Recording access, then Re-check."
            ),
            buildPermissionItem(
                surface: .microphone,
                permission: .microphone,
                checks: microphoneChecks,
                nativePermissionStatus: resolvedNativePermissionStatus,
                defaultDetail: "Microphone access is required to capture your voice.",
                defaultRemediation: "Open System Settings, grant Microphone access, then Re-check."
            ),
        ]

        if let displayItem = buildDisplayItem(
            checks: displayChecks,
            nativeScreenPermissionGranted: resolvedNativePermissionStatus(.screenRecording)
        ) {
            items.insert(displayItem, at: 1)
        }

        return items
    }

    private static func buildPermissionItem(
        surface: PermissionRemediationSurface,
        permission: RemediablePermission,
        checks: [PreflightCheckDTO],
        nativePermissionStatus: (RemediablePermission) -> Bool,
        defaultDetail: String,
        defaultRemediation: String
    ) -> PermissionRemediationItem {
        let allowNativeOverride = ProcessInfo.processInfo.environment["RECORDIT_UI_TEST_MODE"] == "1"
        let nativePermissionGranted = nativePermissionStatus(permission)
        let checkIDs = checks.map(\.id)
        guard !checks.isEmpty else {
            return PermissionRemediationItem(
                surface: surface,
                status: nativePermissionGranted ? .granted : .missingPermission,
                checkIDs: [],
                detail: nativePermissionGranted
                    ? "macOS permission is granted. Run preflight again to refresh diagnostics."
                    : "Permission diagnostics are unavailable. \(defaultDetail)",
                remediation: nativePermissionGranted
                    ? "Run preflight again and verify permission diagnostics are present."
                    : defaultRemediation
            )
        }

        if let failing = checks.first(where: { $0.status == .fail }) {
            if nativePermissionGranted, allowNativeOverride {
                return PermissionRemediationItem(
                    surface: surface,
                    status: .granted,
                    checkIDs: checkIDs,
                    detail: "macOS permission is granted. Runtime preflight reported: \(failing.detail)",
                    remediation: failing.remediation ?? defaultRemediation
                )
            }
            if nativePermissionGranted {
                return PermissionRemediationItem(
                    surface: surface,
                    status: .runtimeFailure,
                    checkIDs: checkIDs,
                    detail: "macOS permission appears granted, but runtime checks still fail: \(failing.detail)",
                    remediation: failing.remediation ?? defaultRemediation
                )
            }
            return PermissionRemediationItem(
                surface: surface,
                status: .missingPermission,
                checkIDs: checkIDs,
                detail: failing.detail,
                remediation: failing.remediation ?? defaultRemediation
            )
        }

        let representative = checks[0]
        return PermissionRemediationItem(
            surface: surface,
            status: .granted,
            checkIDs: checkIDs,
            detail: representative.detail,
            remediation: representative.remediation ?? defaultRemediation
        )
    }

    private static func buildDisplayItem(
        checks: [PreflightCheckDTO],
        nativeScreenPermissionGranted: Bool
    ) -> PermissionRemediationItem? {
        guard !checks.isEmpty else {
            return nil
        }

        let checkIDs = checks.map(\.id)
        if let failing = checks.first(where: { $0.status == .fail }) {
            let status: PermissionReadiness = nativeScreenPermissionGranted ? .noActiveDisplay : .diagnosticsUnavailable
            let detail = nativeScreenPermissionGranted
                ? failing.detail
                : "Display diagnostics are blocked until Screen Recording access is granted. \(failing.detail)"
            return PermissionRemediationItem(
                surface: .activeDisplay,
                status: status,
                checkIDs: checkIDs,
                detail: detail,
                remediation: failing.remediation ?? "Ensure at least one display is connected, awake, and available to Recordit, then Re-check."
            )
        }

        let representative = checks[0]
        return PermissionRemediationItem(
            surface: .activeDisplay,
            status: .granted,
            checkIDs: checkIDs,
            detail: representative.detail,
            remediation: representative.remediation ?? "Re-check if display availability changes."
        )
    }

    private static func nativePermissionFallbackItems(
        nativePermissionStatus: (RemediablePermission) -> Bool,
        preflightFailure: AppServiceError
    ) -> [PermissionRemediationItem] {
        [
            fallbackItem(
                surface: .screenRecording,
                permission: .screenRecording,
                nativePermissionStatus: nativePermissionStatus,
                defaultDetail: "Screen Recording access is required to capture system audio.",
                defaultRemediation: "Open System Settings, grant Screen Recording access, then Re-check.",
                failureDetail: preflightFailure.userMessage
            ),
            fallbackItem(
                surface: .microphone,
                permission: .microphone,
                nativePermissionStatus: nativePermissionStatus,
                defaultDetail: "Microphone access is required to capture your voice.",
                defaultRemediation: "Open System Settings, grant Microphone access, then Re-check.",
                failureDetail: preflightFailure.remediation
            ),
        ]
    }

    private static func fallbackItem(
        surface: PermissionRemediationSurface,
        permission: RemediablePermission,
        nativePermissionStatus: (RemediablePermission) -> Bool,
        defaultDetail: String,
        defaultRemediation: String,
        failureDetail: String
    ) -> PermissionRemediationItem {
        let nativeGranted = nativePermissionStatus(permission)
        if nativeGranted {
            return PermissionRemediationItem(
                surface: surface,
                status: .diagnosticsUnavailable,
                checkIDs: [],
                detail: "macOS permission is granted. Preflight diagnostics unavailable: \(failureDetail)",
                remediation: "Rerun checks after runtime diagnostics recover."
            )
        }

        return PermissionRemediationItem(
            surface: surface,
            status: .missingPermission,
            checkIDs: [],
            detail: "\(defaultDetail) Preflight diagnostics unavailable: \(failureDetail)",
            remediation: defaultRemediation
        )
    }
}
