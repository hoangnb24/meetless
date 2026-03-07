import Foundation
import AVFoundation
import CoreGraphics

private func defaultPreflightNativePermissionStatus(_ permission: RemediablePermission) -> Bool {
    if let override = uiTestNativePermissionStatusOverride(permission) {
        return override
    }

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

@MainActor
public final class PreflightViewModel {
    public enum State: Equatable {
        case idle
        case running
        case completed(PreflightManifestEnvelopeDTO)
        case failed(AppServiceError)
    }

    public private(set) var state: State = .idle
    public private(set) var gatingEvaluation: PreflightGatingEvaluation?
    public private(set) var warningAcknowledged = false

    public static let accessibilityElements: [AccessibilityElementDescriptor] = [
        AccessibilityElementDescriptor(
            id: "run_preflight",
            label: "Run preflight checks",
            hint: "Runs required checks for model, capture permissions, and output paths."
        ),
        AccessibilityElementDescriptor(
            id: "preflight_results",
            label: "Preflight results",
            hint: "Review failed and warning checks before continuing."
        ),
        AccessibilityElementDescriptor(
            id: "acknowledge_warnings",
            label: "Acknowledge warnings",
            hint: "Required before continuing when warning checks are present."
        ),
    ]

    public static let focusPlan = KeyboardFocusPlan(
        orderedElementIDs: ["run_preflight", "preflight_results", "acknowledge_warnings"]
    )

    public static let keyboardShortcuts: [KeyboardShortcutDescriptor] = [
        KeyboardShortcutDescriptor(
            id: "run_preflight_shortcut",
            key: "return",
            modifiers: ["command", "shift"],
            actionSummary: "Run preflight checks."
        ),
    ]

    private let runner: RecorditPreflightRunner
    private let gatingPolicy: PreflightGatingPolicy
    private let nativePermissionStatus: (RemediablePermission) -> Bool

    public init(
        runner: RecorditPreflightRunner = RecorditPreflightRunner(),
        gatingPolicy: PreflightGatingPolicy = PreflightGatingPolicy(),
        nativePermissionStatus: ((RemediablePermission) -> Bool)? = nil
    ) {
        self.runner = runner
        self.gatingPolicy = gatingPolicy
        self.nativePermissionStatus = nativePermissionStatus ?? defaultPreflightNativePermissionStatus
    }

    public var canProceedToLiveTranscribe: Bool {
        guard let evaluation = gatingEvaluation else {
            return false
        }
        return evaluation.canProceed(acknowledgingWarnings: warningAcknowledged)
    }

    public var requiresWarningAcknowledgement: Bool {
        guard let evaluation = gatingEvaluation else {
            return false
        }
        return evaluation.requiresWarningAcknowledgement && !warningAcknowledged
    }

    public var primaryBlockingDomain: ReadinessDomain? {
        gatingEvaluation?.primaryBlockingDomain
    }

    public var canOfferRecordOnlyFallback: Bool {
        gatingEvaluation?.recordOnlyFallbackEligible ?? false
    }

    public func acknowledgeWarningsForLiveTranscribe() {
        warningAcknowledged = true
    }

    public func runLivePreflight() {
        state = .running
        gatingEvaluation = nil
        warningAcknowledged = false
        do {
            let envelope = try runner.runLivePreflight()
            // Production preflight must reflect helper-runtime truth. In UI-test
            // mode we may enrich permission diagnostics from fixture overrides, but
            // we must never downgrade a helper-reported blocker into a pass.
            let effectiveEnvelope: PreflightManifestEnvelopeDTO
            if ProcessInfo.processInfo.environment["RECORDIT_UI_TEST_MODE"] == "1" {
                effectiveEnvelope = Self.normalizePermissionChecks(
                    in: envelope,
                    nativePermissionStatus: nativePermissionStatus
                )
            } else {
                effectiveEnvelope = envelope
            }
            gatingEvaluation = gatingPolicy.evaluate(effectiveEnvelope)
            state = .completed(effectiveEnvelope)
        } catch let serviceError as AppServiceError {
            gatingEvaluation = nil
            state = .failed(serviceError)
        } catch {
            gatingEvaluation = nil
            state = .failed(
                AppServiceError(
                    code: .unknown,
                    userMessage: "Preflight could not complete.",
                    remediation: "Retry preflight and inspect command diagnostics.",
                    debugDetail: String(describing: error)
                )
            )
        }
    }

    private static func normalizePermissionChecks(
        in envelope: PreflightManifestEnvelopeDTO,
        nativePermissionStatus: (RemediablePermission) -> Bool
    ) -> PreflightManifestEnvelopeDTO {
        let nativeScreenGranted = nativePermissionStatus(.screenRecording)

        var normalizedChecks = [PreflightCheckDTO]()
        normalizedChecks.reserveCapacity(envelope.checks.count)

        for check in envelope.checks {
            if check.id == ReadinessContractID.screenCaptureAccess.rawValue,
               check.status == .fail,
               nativeScreenGranted {
                normalizedChecks.append(
                    PreflightCheckDTO(
                        id: check.id,
                        status: .fail,
                        detail: "App-level Screen Recording permission is granted, but runtime capture still failed: \(check.detail)",
                        remediation: check.remediation ?? "If runtime capture still fails, quit and reopen Recordit, then re-run preflight."
                    )
                )
                continue
            }
            normalizedChecks.append(check)
        }

        var normalizedEnvelope = envelope
        normalizedEnvelope.checks = normalizedChecks
        normalizedEnvelope.overallStatus = normalizedOverallStatus(for: normalizedChecks)
        return normalizedEnvelope
    }

    private static func normalizedOverallStatus(for checks: [PreflightCheckDTO]) -> PreflightStatus {
        if checks.contains(where: { $0.status == .fail }) {
            return .fail
        }
        if checks.contains(where: { $0.status == .warn }) {
            return .warn
        }
        return .pass
    }
}
