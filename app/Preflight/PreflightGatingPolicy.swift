import Foundation

public enum ReadinessContractID: String, CaseIterable, Sendable {
    case modelPath = "model_path"
    case outWav = "out_wav"
    case outJsonl = "out_jsonl"
    case outManifest = "out_manifest"
    case sampleRate = "sample_rate"
    case screenCaptureAccess = "screen_capture_access"
    case microphoneAccess = "microphone_access"
    case backendRuntime = "backend_runtime"
    case modelReadability = "model_readability"
}

public enum ReadinessDomain: String, CaseIterable, Sendable {
    case tccCapture = "tcc_capture"
    case backendModel = "backend_model"
    case runtimePreflight = "runtime_preflight"
    case backendRuntime = "backend_runtime"
    case diagnosticOnly = "diagnostic_only"
    case unknown = "unknown"
}

public enum ReadinessContract {
    public static let path = "contracts/readiness-contract-ids.v1.json"

    public static let blockingPreflightIDs: Set<String> = [
        ReadinessContractID.modelPath.rawValue,
        ReadinessContractID.outWav.rawValue,
        ReadinessContractID.outJsonl.rawValue,
        ReadinessContractID.outManifest.rawValue,
        ReadinessContractID.screenCaptureAccess.rawValue,
        ReadinessContractID.microphoneAccess.rawValue,
    ]

    public static let warningPreflightIDs: Set<String> = [
        ReadinessContractID.sampleRate.rawValue,
        ReadinessContractID.backendRuntime.rawValue,
    ]

    public static let knownPreflightIDs: Set<String> =
        blockingPreflightIDs.union(warningPreflightIDs)

    public static let knownContractIDs: Set<String> =
        knownPreflightIDs.union(diagnosticOnlyIDs)

    public static let screenPermissionIDs: Set<String> = [
        ReadinessContractID.screenCaptureAccess.rawValue,
    ]

    public static let microphonePermissionID = ReadinessContractID.microphoneAccess.rawValue

    public static let tccCaptureIDs: Set<String> = [
        ReadinessContractID.screenCaptureAccess.rawValue,
        ReadinessContractID.microphoneAccess.rawValue,
    ]

    public static let backendModelIDs: Set<String> = [
        ReadinessContractID.modelPath.rawValue,
    ]

    public static let runtimePreflightIDs: Set<String> = [
        ReadinessContractID.outWav.rawValue,
        ReadinessContractID.outJsonl.rawValue,
        ReadinessContractID.outManifest.rawValue,
        ReadinessContractID.sampleRate.rawValue,
    ]

    public static let backendRuntimeIDs: Set<String> = [
        ReadinessContractID.backendRuntime.rawValue,
    ]

    public static let diagnosticOnlyIDs: Set<String> = [
        ReadinessContractID.modelReadability.rawValue,
    ]

    public static func domain(forCheckID checkID: String) -> ReadinessDomain {
        if tccCaptureIDs.contains(checkID) {
            return .tccCapture
        }
        if backendModelIDs.contains(checkID) {
            return .backendModel
        }
        if runtimePreflightIDs.contains(checkID) {
            return .runtimePreflight
        }
        if backendRuntimeIDs.contains(checkID) {
            return .backendRuntime
        }
        if diagnosticOnlyIDs.contains(checkID) {
            return .diagnosticOnly
        }
        return .unknown
    }
}

public enum PreflightCheckPolicy: String, Equatable, Sendable {
    case blockOnFail
    case warnRequiresAcknowledgement
    case informational
}

public struct MappedPreflightCheck: Equatable, Sendable {
    public var check: PreflightCheckDTO
    public var policy: PreflightCheckPolicy
    public var domain: ReadinessDomain
    public var isKnownContractID: Bool

    public init(
        check: PreflightCheckDTO,
        policy: PreflightCheckPolicy,
        domain: ReadinessDomain,
        isKnownContractID: Bool
    ) {
        self.check = check
        self.policy = policy
        self.domain = domain
        self.isKnownContractID = isKnownContractID
    }
}

public struct PreflightGatingEvaluation: Equatable, Sendable {
    public var mappedChecks: [MappedPreflightCheck]
    public var blockingFailures: [MappedPreflightCheck]
    public var warningContinuations: [MappedPreflightCheck]
    public var unknownCheckIDs: [String]

    public init(
        mappedChecks: [MappedPreflightCheck],
        blockingFailures: [MappedPreflightCheck],
        warningContinuations: [MappedPreflightCheck],
        unknownCheckIDs: [String]
    ) {
        self.mappedChecks = mappedChecks
        self.blockingFailures = blockingFailures
        self.warningContinuations = warningContinuations
        self.unknownCheckIDs = unknownCheckIDs
    }

    public var requiresWarningAcknowledgement: Bool {
        !warningContinuations.isEmpty
    }

    public var blockingTCCFailures: [MappedPreflightCheck] {
        blockingFailures.filter { $0.domain == .tccCapture }
    }

    public var blockingBackendModelFailures: [MappedPreflightCheck] {
        blockingFailures.filter { $0.domain == .backendModel }
    }

    public var blockingRuntimePreflightFailures: [MappedPreflightCheck] {
        blockingFailures.filter { $0.domain == .runtimePreflight }
    }

    public var blockingBackendRuntimeFailures: [MappedPreflightCheck] {
        blockingFailures.filter { $0.domain == .backendRuntime }
    }

    public var primaryBlockingDomain: ReadinessDomain? {
        if !blockingTCCFailures.isEmpty {
            return .tccCapture
        }
        if !blockingBackendModelFailures.isEmpty {
            return .backendModel
        }
        if !blockingRuntimePreflightFailures.isEmpty {
            return .runtimePreflight
        }
        if !blockingBackendRuntimeFailures.isEmpty {
            return .backendRuntime
        }
        if !blockingFailures.isEmpty {
            return .unknown
        }
        return nil
    }

    public var recordOnlyFallbackEligible: Bool {
        let hasLiveSpecificOnlyBlockers =
            !blockingBackendModelFailures.isEmpty || !blockingBackendRuntimeFailures.isEmpty
        let hasOtherBlockers = blockingFailures.contains {
            $0.domain != .backendModel && $0.domain != .backendRuntime
        }
        return hasLiveSpecificOnlyBlockers && !hasOtherBlockers
    }

    public func canProceed(acknowledgingWarnings: Bool) -> Bool {
        guard blockingFailures.isEmpty else {
            return false
        }
        guard warningContinuations.isEmpty else {
            return acknowledgingWarnings
        }
        return true
    }
}

public struct PreflightGatingPolicy {
    public static let readinessContractPath = ReadinessContract.path

    public static let blockingFailureCheckIDs = ReadinessContract.blockingPreflightIDs

    public static let warnAcknowledgementCheckIDs = ReadinessContract.warningPreflightIDs

    public static let knownContractCheckIDs = ReadinessContract.knownContractIDs

    public init() {}

    public static func policy(forCheckID checkID: String) -> PreflightCheckPolicy {
        if blockingFailureCheckIDs.contains(checkID) {
            return .blockOnFail
        }
        if warnAcknowledgementCheckIDs.contains(checkID) {
            return .warnRequiresAcknowledgement
        }
        return .informational
    }

    public func evaluate(_ envelope: PreflightManifestEnvelopeDTO) -> PreflightGatingEvaluation {
        var mappedChecks = [MappedPreflightCheck]()
        var blockingFailures = [MappedPreflightCheck]()
        var warningContinuations = [MappedPreflightCheck]()
        var unknownCheckIDs = [String]()

        for check in envelope.checks {
            let policy = Self.policy(forCheckID: check.id)
            let domain = ReadinessContract.domain(forCheckID: check.id)
            let isKnownContractID = Self.knownContractCheckIDs.contains(check.id)
            let mapped = MappedPreflightCheck(
                check: check,
                policy: policy,
                domain: domain,
                isKnownContractID: isKnownContractID
            )
            mappedChecks.append(mapped)

            if !isKnownContractID {
                unknownCheckIDs.append(check.id)
            }

            switch policy {
            case .blockOnFail:
                if check.status == .fail {
                    blockingFailures.append(mapped)
                }
            case .warnRequiresAcknowledgement:
                if check.status == .fail, domain == .backendRuntime {
                    blockingFailures.append(mapped)
                } else if check.status != .pass {
                    warningContinuations.append(mapped)
                }
            case .informational:
                break
            }
        }

        return PreflightGatingEvaluation(
            mappedChecks: mappedChecks,
            blockingFailures: blockingFailures,
            warningContinuations: warningContinuations,
            unknownCheckIDs: unknownCheckIDs
        )
    }
}
