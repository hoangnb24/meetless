import SwiftUI

private enum OnboardingStep: Int, CaseIterable {
    case welcome
    case permissions
    case modelSetup
    case ready

    var title: String {
        switch self {
        case .welcome:
            return "Welcome"
        case .permissions:
            return "Permissions"
        case .modelSetup:
            return "Model Setup"
        case .ready:
            return "Ready"
        }
    }
}

private struct PermissionStatusRow: Identifiable {
    let id: String
    let title: String
    let status: String
    let detail: String
    let identifierID: String
    let identifierStatus: String
}

private struct PreflightDiagnosticRow: Identifiable {
    let id: String
    let status: String
    let detail: String
    let remediation: String?
}

struct OnboardingFlowView: View {
    @ObservedObject var controller: RootCompositionController
    @State private var step: OnboardingStep = .welcome

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text("Onboarding")
                    .font(.headline)
                    .accessibilityIdentifier("onboarding_title")

                Text("Step \(step.rawValue + 1)/\(OnboardingStep.allCases.count): \(step.title)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("onboarding_step_label")
            }

            Divider()

            switch step {
            case .welcome:
                welcomeStep
            case .permissions:
                permissionsStep
            case .modelSetup:
                modelSetupStep
            case .ready:
                readyStep
            }

            Divider()
            stepNavigation
        }
    }

    private var welcomeStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Recordit runs fully in-window without terminal commands.")
            Text("This guided setup validates permissions, checks model readiness, and gates live-start until prerequisites are met.")
                .foregroundStyle(.secondary)
            Text("Current startup readiness: \(controller.snapshot.startupRuntimeSummary)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding_step_welcome")
    }

    private var permissionsStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Run dedicated permission remediation checks for Screen Recording, Microphone, active display availability, and capture readiness.")
                .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                Button("Check for Permissions") {
                    controller.runPermissionCheck()
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("onboarding_run_permission_checks")

                Button("Re-check") {
                    controller.recheckPermissions()
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("onboarding_recheck_permissions")
            }

            ForEach(permissionRows(from: controller.snapshot.permissionState)) { row in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(row.title): \(row.status)")
                        .font(.subheadline)
                    Text(row.detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(8)
                .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier(
                    "permission_row_\(row.identifierID)_\(row.identifierStatus)"
                )
            }

            if shouldOfferSettingsButton(for: .screenRecording) {
                Button("Open Screen Recording Settings") {
                    controller.openSettings(for: .screenRecording)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("onboarding_open_screen_settings")
            }

            if shouldOfferSettingsButton(for: .microphone) {
                Button("Open Microphone Settings") {
                    controller.openSettings(for: .microphone)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("onboarding_open_microphone_settings")
            }

            if controller.snapshot.shouldShowScreenRecordingRestartAdvisory {
                HStack(spacing: 8) {
                    Text(PermissionRemediationViewModel.screenRecordingRestartAdvisory)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("onboarding_screen_restart_advisory")
                    Button("Dismiss") {
                        controller.dismissScreenRecordingRestartAdvisory()
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("onboarding_dismiss_restart_advisory")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding_step_permissions")
    }

    private var modelSetupStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Select backend and validate model configuration.")
                .foregroundStyle(.secondary)

            Picker(
                "Backend",
                selection: Binding(
                    get: { controller.snapshot.selectedBackend },
                    set: { controller.chooseBackend($0) }
                )
            ) {
                ForEach(ModelSetupViewModel.backendCapabilityMatrix.filter(\.isSelectable), id: \.id) { option in
                    Text(option.displayName).tag(option.id)
                }
            }
            .pickerStyle(.segmented)

            Button("Validate Model Setup") {
                controller.validateModelSetup()
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("onboarding_validate_model_setup")

            HStack(spacing: 10) {
                Button("Run Preflight") {
                    controller.runPreflight()
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("onboarding_run_preflight")

                Button("Acknowledge Warnings") {
                    controller.acknowledgeWarnings()
                }
                .buttonStyle(.bordered)
                .disabled(!controller.snapshot.preflightRequiresWarningAck)
                .accessibilityIdentifier("onboarding_ack_warnings")
            }

            Text("Preflight: \(controller.snapshot.preflightSummary)")
                .font(.subheadline)

            let preflightDiagnostics = preflightRows(from: controller.snapshot.preflightState)
            if !preflightDiagnostics.isEmpty {
                Text("Preflight diagnostics")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                ForEach(preflightDiagnostics) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(row.id): \(row.status)")
                            .font(.footnote)
                        Text(row.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        if let remediation = row.remediation, !remediation.isEmpty {
                            Text(remediation)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(8)
                    .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier(
                        "preflight_row_\(identifierFragment(row.id))_\(identifierFragment(row.status))"
                    )
                }
            }

            Text("Model state: \(controller.snapshot.modelSummary)")
                .font(.subheadline)

            if case let .invalid(error) = controller.snapshot.modelState {
                VStack(alignment: .leading, spacing: 2) {
                    Text(error.userMessage)
                        .foregroundStyle(.red)
                    Text(error.remediation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("onboarding_model_validation_error")
            }

            if let diagnostics = controller.snapshot.modelDiagnostics {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Resolved model: \(diagnostics.asrModel)")
                    Text("Source: \(diagnostics.asrModelSource)")
                    Text("Checksum status: \(diagnostics.asrModelChecksumStatus)")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding_step_model_setup")
    }

    private var readyStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Complete onboarding once both gates are green.")
                .foregroundStyle(.secondary)

            Text("Preflight ready: \(controller.snapshot.preflightCanProceed ? "yes" : "no")")
            Text("Model ready: \(controller.snapshot.modelCanStart ? "yes" : "no")")

            if let failure = controller.snapshot.onboardingGateFailure {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(failure.userMessage)")
                        .foregroundStyle(.red)
                    Text(failure.remediation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Button("Complete Onboarding") {
                controller.completeOnboarding()
            }
            .buttonStyle(.borderedProminent)
            .disabled(!(controller.snapshot.modelCanStart && controller.snapshot.preflightCanProceed))
            .accessibilityIdentifier("onboarding_complete")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding_step_ready")
    }

    private var stepNavigation: some View {
        HStack(spacing: 10) {
            Button("Back") {
                moveStep(-1)
            }
            .buttonStyle(.bordered)
            .disabled(step == .welcome)
            .accessibilityIdentifier("onboarding_back")

            Button("Next") {
                moveStep(1)
            }
            .buttonStyle(.bordered)
            .disabled(step == .ready || !canAdvanceFromCurrentStep)
            .accessibilityIdentifier("onboarding_next")

            Spacer()

            Button("Open Main Runtime") {
                controller.send(.openMainRuntime)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("onboarding_open_main_runtime")
        }
    }

    private var canAdvanceFromCurrentStep: Bool {
        switch step {
        case .welcome:
            return true
        case .permissions:
            return permissionStepCanAdvance(from: controller.snapshot.permissionState)
        case .modelSetup:
            return controller.snapshot.modelCanStart && controller.snapshot.preflightCanProceed
        case .ready:
            return false
        }
    }

    private func moveStep(_ delta: Int) {
        let raw = max(OnboardingStep.welcome.rawValue, min(OnboardingStep.ready.rawValue, step.rawValue + delta))
        step = OnboardingStep(rawValue: raw) ?? .welcome
    }

    private func identifierFragment(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: " ", with: "_")
            .replacingOccurrences(of: "-", with: "_")
    }

    private func permissionSurfaceIdentifier(_ surface: PermissionRemediationSurface) -> String {
        switch surface {
        case .screenRecording:
            return "screen"
        case .activeDisplay:
            return "display"
        case .microphone:
            return "microphone"
        }
    }

    private func permissionStatusIdentifier(_ status: PermissionReadiness) -> String {
        switch status {
        case .granted:
            return "granted"
        case .missingPermission:
            return "missing"
        case .noActiveDisplay:
            return "no_active_display"
        case .runtimeFailure:
            return "runtime_failure"
        case .diagnosticsUnavailable:
            return "diagnostics_unavailable"
        }
    }

    private func permissionStepCanAdvance(from state: PermissionRemediationViewModel.State) -> Bool {
        switch state {
        case .ready(let items):
            return items.allSatisfy { !$0.status.isBlocking }
        case .idle, .checking, .failed:
            return false
        }
    }

    private func shouldOfferSettingsButton(for permission: RemediablePermission) -> Bool {
        switch controller.snapshot.permissionState {
        case .ready(let items):
            return items.contains {
                $0.surface.settingsPermission == permission && $0.status == .missingPermission
            }
        case .failed:
            return true
        case .idle, .checking:
            return false
        }
    }

    private func permissionRows(from state: PermissionRemediationViewModel.State) -> [PermissionStatusRow] {
        switch state {
        case .idle:
            return [
                PermissionStatusRow(
                    id: "screen",
                    title: "Screen Recording",
                    status: "Unknown",
                    detail: "Run permission checks to detect access state.",
                    identifierID: "screen",
                    identifierStatus: "unknown"
                ),
                PermissionStatusRow(
                    id: "microphone",
                    title: "Microphone",
                    status: "Unknown",
                    detail: "Run permission checks to detect access state.",
                    identifierID: "microphone",
                    identifierStatus: "unknown"
                ),
            ]
        case .checking:
            return [
                PermissionStatusRow(
                    id: "running",
                    title: "Permission Checks",
                    status: "Running",
                    detail: "Collecting screen and microphone diagnostics.",
                    identifierID: "running",
                    identifierStatus: "running"
                ),
            ]
        case .failed(let error):
            return [
                PermissionStatusRow(
                    id: "screen",
                    title: "Screen Recording",
                    status: "Missing",
                    detail: "Permission diagnostics unavailable. \(error.userMessage)",
                    identifierID: "screen",
                    identifierStatus: "missing"
                ),
                PermissionStatusRow(
                    id: "microphone",
                    title: "Microphone",
                    status: "Missing",
                    detail: "Permission diagnostics unavailable. \(error.remediation)",
                    identifierID: "microphone",
                    identifierStatus: "missing"
                ),
            ]
        case .ready(let items):
            return items.map { item in
                PermissionStatusRow(
                    id: item.surface.rawValue,
                    title: item.surface.title,
                    status: item.status.statusLabel,
                    detail: item.detail,
                    identifierID: permissionSurfaceIdentifier(item.surface),
                    identifierStatus: permissionStatusIdentifier(item.status)
                )
            }
        }
    }

    private func preflightRows(from state: PreflightViewModel.State) -> [PreflightDiagnosticRow] {
        switch state {
        case .completed(let envelope):
            return envelope.checks.compactMap { check in
                guard check.status != .pass else {
                    return nil
                }
                return PreflightDiagnosticRow(
                    id: check.id,
                    status: check.status.rawValue,
                    detail: check.detail,
                    remediation: check.remediation
                )
            }
        case .failed(let error):
            return [
                PreflightDiagnosticRow(
                    id: "runner",
                    status: "FAIL",
                    detail: error.userMessage,
                    remediation: error.remediation
                ),
            ]
        case .idle, .running:
            return []
        }
    }
}
