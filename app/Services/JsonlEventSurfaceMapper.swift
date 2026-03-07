import Foundation

public enum RuntimeDiagnosticCategory: String, Codable, Sendable {
    case queue
    case trust
    case lifecycle
    case control
}

public struct RuntimeTranscriptSurfaceLine: Equatable, Sendable {
    public var eventType: String
    public var channel: String
    public var segmentID: String
    public var startMs: UInt64
    public var endMs: UInt64
    public var text: String

    public init(
        eventType: String,
        channel: String,
        segmentID: String,
        startMs: UInt64,
        endMs: UInt64,
        text: String
    ) {
        self.eventType = eventType
        self.channel = channel
        self.segmentID = segmentID
        self.startMs = startMs
        self.endMs = endMs
        self.text = text
    }
}

public struct RuntimeDiagnosticSurfaceSignal: Equatable, Sendable {
    public var category: RuntimeDiagnosticCategory
    public var eventType: String
    public var message: String?
    public var payload: [String: String]

    public init(
        category: RuntimeDiagnosticCategory,
        eventType: String,
        message: String?,
        payload: [String: String]
    ) {
        self.category = category
        self.eventType = eventType
        self.message = message
        self.payload = payload
    }
}

public struct RuntimeEventSurfaceSnapshot: Equatable, Sendable {
    public var transcriptLines: [RuntimeTranscriptSurfaceLine]
    public var partialLines: [RuntimeTranscriptSurfaceLine]
    public var diagnostics: [RuntimeDiagnosticSurfaceSignal]

    public init(
        transcriptLines: [RuntimeTranscriptSurfaceLine],
        partialLines: [RuntimeTranscriptSurfaceLine] = [],
        diagnostics: [RuntimeDiagnosticSurfaceSignal]
    ) {
        self.transcriptLines = transcriptLines
        self.partialLines = partialLines
        self.diagnostics = diagnostics
    }
}

public struct JsonlEventSurfaceMapper {
    public init() {}

    public func map(events: [RuntimeEventDTO]) -> RuntimeEventSurfaceSnapshot {
        var transcriptCandidates: [TranscriptCandidate] = []
        var diagnostics: [RuntimeDiagnosticSurfaceSignal] = []

        for (index, event) in events.enumerated() {
            let normalizedType = event.eventType
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            if let transcriptType = TranscriptEventType(rawValue: normalizedType),
               let text = normalizedText(event.text) {
                let segmentID = normalizedText(event.segmentID)
                    ?? event.payload["segment_id"]
                    ?? "segment-\(index)"
                let channel = normalizedText(event.channel)
                    ?? event.payload["channel"]
                    ?? "unknown"
                let startMs = event.startMs ?? parseUnsignedInteger(event.payload["start_ms"]) ?? 0
                let endMs = event.endMs ?? parseUnsignedInteger(event.payload["end_ms"]) ?? startMs
                let sourceFinalSegmentID = event.payload["source_final_segment_id"]
                transcriptCandidates.append(
                    TranscriptCandidate(
                        type: transcriptType,
                        channel: channel,
                        segmentID: segmentID,
                        sourceFinalSegmentID: sourceFinalSegmentID,
                        startMs: startMs,
                        endMs: endMs,
                        text: text
                    )
                )
                continue
            }

            if let category = diagnosticCategory(for: normalizedType) {
                diagnostics.append(
                    RuntimeDiagnosticSurfaceSignal(
                        category: category,
                        eventType: normalizedType,
                        message: normalizedText(event.text),
                        payload: event.payload
                    )
                )
            }
        }

        let transcriptLines = canonicalTranscriptLines(from: transcriptCandidates.filter { $0.type != .partial })
        let partialLines = transcriptCandidates.filter { $0.type == .partial }.map {
            RuntimeTranscriptSurfaceLine(
                eventType: $0.type.rawValue,
                channel: $0.channel,
                segmentID: $0.segmentID,
                startMs: $0.startMs,
                endMs: $0.endMs,
                text: $0.text
            )
        }
        return RuntimeEventSurfaceSnapshot(
            transcriptLines: transcriptLines,
            partialLines: partialLines,
            diagnostics: diagnostics
        )
    }

    private func canonicalTranscriptLines(
        from candidates: [TranscriptCandidate]
    ) -> [RuntimeTranscriptSurfaceLine] {
        let sorted = candidates.sorted { $0.orderingKey < $1.orderingKey }
        let deduplicated = dedupe(sorted)
        let preferred = applyReconciledPreference(deduplicated)
        return preferred.map {
            RuntimeTranscriptSurfaceLine(
                eventType: $0.type.rawValue,
                channel: $0.channel,
                segmentID: $0.segmentID,
                startMs: $0.startMs,
                endMs: $0.endMs,
                text: $0.text
            )
        }
    }

    private func applyReconciledPreference(_ candidates: [TranscriptCandidate]) -> [TranscriptCandidate] {
        let reconciled = candidates.filter { $0.type == .reconciledFinal }
        guard !reconciled.isEmpty else { return candidates }
        let replacedFinalIDs = Set(reconciled.map { $0.sourceFinalSegmentID ?? $0.segmentID })
        return candidates.filter { candidate in
            candidate.type != .final || !replacedFinalIDs.contains(candidate.segmentID)
        }
    }

    private func dedupe(_ candidates: [TranscriptCandidate]) -> [TranscriptCandidate] {
        var seen = Set<TranscriptOrderingKey>()
        var result: [TranscriptCandidate] = []
        for candidate in candidates {
            if seen.insert(candidate.orderingKey).inserted {
                result.append(candidate)
            }
        }
        return result
    }

    private func diagnosticCategory(for eventType: String) -> RuntimeDiagnosticCategory? {
        if eventType.hasPrefix("queue") {
            return .queue
        }
        if eventType.hasPrefix("trust") {
            return .trust
        }
        if eventType.hasPrefix("lifecycle") {
            return .lifecycle
        }
        if eventType.hasPrefix("control") {
            return .control
        }
        return nil
    }

    private func normalizedText(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    private func parseUnsignedInteger(_ value: String?) -> UInt64? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return UInt64(value)
    }
}

private enum TranscriptEventType: String {
    case partial
    case `final`
    case llmFinal = "llm_final"
    case reconciledFinal = "reconciled_final"

    var rank: Int {
        switch self {
        case .partial:
            return -1
        case .final:
            return 0
        case .llmFinal:
            return 1
        case .reconciledFinal:
            return 2
        }
    }
}

private struct TranscriptCandidate {
    var type: TranscriptEventType
    var channel: String
    var segmentID: String
    var sourceFinalSegmentID: String?
    var startMs: UInt64
    var endMs: UInt64
    var text: String

    var orderingKey: TranscriptOrderingKey {
        TranscriptOrderingKey(
            startMs: startMs,
            endMs: endMs,
            typeRank: type.rank,
            channel: channel,
            segmentID: segmentID,
            sourceFinalSegmentID: sourceFinalSegmentID ?? "",
            text: text
        )
    }
}

private struct TranscriptOrderingKey: Comparable, Hashable {
    var startMs: UInt64
    var endMs: UInt64
    var typeRank: Int
    var channel: String
    var segmentID: String
    var sourceFinalSegmentID: String
    var text: String

    static func < (lhs: Self, rhs: Self) -> Bool {
        if lhs.startMs != rhs.startMs {
            return lhs.startMs < rhs.startMs
        }
        if lhs.endMs != rhs.endMs {
            return lhs.endMs < rhs.endMs
        }
        if lhs.typeRank != rhs.typeRank {
            return lhs.typeRank < rhs.typeRank
        }
        if lhs.channel != rhs.channel {
            return lhs.channel < rhs.channel
        }
        if lhs.segmentID != rhs.segmentID {
            return lhs.segmentID < rhs.segmentID
        }
        if lhs.sourceFinalSegmentID != rhs.sourceFinalSegmentID {
            return lhs.sourceFinalSegmentID < rhs.sourceFinalSegmentID
        }
        return lhs.text < rhs.text
    }
}
