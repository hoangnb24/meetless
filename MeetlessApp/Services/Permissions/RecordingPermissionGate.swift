import AVFoundation
import CoreGraphics
import Foundation
import OSLog

enum RecordingPermissionKind: String, CaseIterable, Identifiable, Sendable {
    case screenRecording
    case microphone

    var id: Self { self }

    var title: String {
        switch self {
        case .screenRecording:
            return "Screen Recording"
        case .microphone:
            return "Microphone"
        }
    }

    var settingsURL: URL {
        switch self {
        case .screenRecording:
            return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
        case .microphone:
            return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!
        }
    }
}

struct PermissionRepairAction: Identifiable, Sendable {
    let kind: RecordingPermissionKind
    let title: String
    let detail: String
    let url: URL
    let relaunchRequired: Bool

    var id: RecordingPermissionKind { kind }
}

struct PermissionReadinessSnapshot: Sendable {
    let repairActions: [PermissionRepairAction]

    var isReady: Bool {
        repairActions.isEmpty
    }
}

struct RecordingPermissionGate {
    private let logger = Logger(subsystem: "com.themrb.meetless", category: "permission-gate")

    func evaluateStartReadiness() async -> PermissionReadinessSnapshot {
        logger.notice("evaluateStartReadiness begin")
        var repairActions: [PermissionRepairAction] = []

        let screenWasReady = CGPreflightScreenCaptureAccess()
        logger.notice("screen preflight ready=\(screenWasReady, privacy: .public)")
        if !screenWasReady {
            let grantedNow = CGRequestScreenCaptureAccess()
            logger.notice("screen access requested; grantedNow=\(grantedNow, privacy: .public)")
            let detail: String

            if grantedNow {
                detail = "Screen Recording was granted just now. Quit and reopen Meetless, then press Retry Recording."
            } else {
                detail = "Allow Screen Recording for Meetless in System Settings, then quit and reopen the app."
            }

            repairActions.append(
                PermissionRepairAction(
                    kind: .screenRecording,
                    title: "Open Screen Recording Settings",
                    detail: detail,
                    url: RecordingPermissionKind.screenRecording.settingsURL,
                    relaunchRequired: true
                )
            )
        }

        let microphoneStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        logger.notice("microphone authorization status raw=\(microphoneStatus.rawValue, privacy: .public)")
        switch microphoneStatus {
        case .authorized:
            break
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            logger.notice("microphone access requested; granted=\(granted, privacy: .public)")
            if !granted {
                repairActions.append(
                    PermissionRepairAction(
                        kind: .microphone,
                        title: "Open Microphone Settings",
                        detail: "Allow microphone access for Meetless in System Settings, then press Retry Recording.",
                        url: RecordingPermissionKind.microphone.settingsURL,
                        relaunchRequired: false
                    )
                )
            }
        case .denied:
            repairActions.append(
                PermissionRepairAction(
                    kind: .microphone,
                    title: "Open Microphone Settings",
                    detail: "Allow microphone access for Meetless in System Settings, then press Retry Recording.",
                    url: RecordingPermissionKind.microphone.settingsURL,
                    relaunchRequired: false
                )
            )
        case .restricted:
            repairActions.append(
                PermissionRepairAction(
                    kind: .microphone,
                    title: "Open Microphone Settings",
                    detail: "Microphone access is restricted on this Mac. Lift the restriction, then press Retry Recording.",
                    url: RecordingPermissionKind.microphone.settingsURL,
                    relaunchRequired: false
                )
            )
        @unknown default:
            repairActions.append(
                PermissionRepairAction(
                    kind: .microphone,
                    title: "Open Microphone Settings",
                    detail: "Microphone access could not be confirmed. Check System Settings, then press Retry Recording.",
                    url: RecordingPermissionKind.microphone.settingsURL,
                    relaunchRequired: false
                )
            )
        }

        logger.notice("evaluateStartReadiness completed; repairCount=\(repairActions.count, privacy: .public)")
        return PermissionReadinessSnapshot(repairActions: repairActions)
    }
}
