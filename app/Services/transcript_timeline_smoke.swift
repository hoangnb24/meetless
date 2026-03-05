import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("transcript_timeline_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private func line(
    eventType: SessionTranscriptEventType,
    channel: String,
    segmentID: String,
    sourceFinalSegmentID: String? = nil,
    startMs: UInt64,
    endMs: UInt64,
    text: String
) -> SessionConversationLine {
    SessionConversationLine(
        eventType: eventType,
        channel: channel,
        segmentID: segmentID,
        sourceFinalSegmentID: sourceFinalSegmentID,
        startMs: startMs,
        endMs: endMs,
        text: text
    )
}

private func runOrderingAndPreferenceAssertions() {
    let resolver = TranscriptTimelineResolver()
    let raw = [
        line(
            eventType: .llmFinal,
            channel: "mic",
            segmentID: "segment-b",
            startMs: 300,
            endMs: 600,
            text: "llm final"
        ),
        line(
            eventType: .final,
            channel: "mic",
            segmentID: "segment-c",
            startMs: 50,
            endMs: 120,
            text: "early final"
        ),
        line(
            eventType: .partial,
            channel: "mic",
            segmentID: "segment-p",
            startMs: 20,
            endMs: 40,
            text: "draft partial"
        ),
        line(
            eventType: .final,
            channel: "mic",
            segmentID: "segment-a",
            startMs: 100,
            endMs: 200,
            text: "original final"
        ),
        line(
            eventType: .reconciledFinal,
            channel: "mic",
            segmentID: "segment-a-reconciled",
            sourceFinalSegmentID: "segment-a",
            startMs: 100,
            endMs: 200,
            text: "reconciled final"
        ),
        line(
            eventType: .llmFinal,
            channel: "mic",
            segmentID: "segment-b",
            startMs: 300,
            endMs: 600,
            text: "llm final"
        ),
    ]

    let resolved = resolver.canonicalDisplayLines(from: raw)
    check(resolved.count == 3, "expected partial filtering + final suppression + dedupe")
    check(
        resolved.map(\.segmentID) == ["segment-c", "segment-a-reconciled", "segment-b"],
        "expected deterministic ordering with reconciled preference"
    )
    check(
        resolved.allSatisfy { $0.eventType != .partial },
        "partial lines should not be present in canonical display"
    )
}

private func runParserAssertions() {
    let validPayload: [String: Any] = [
        "event_type": "reconciled_final",
        "channel": "mic",
        "segment_id": "segment-a-reconciled",
        "source_final_segment_id": "segment-a",
        "start_ms": 100,
        "end_ms": 200,
        "text": "reconciled final"
    ]
    let valid = TranscriptTimelineResolver.parseTranscriptLine(from: validPayload)
    check(valid != nil, "valid transcript payload should parse")
    check(valid?.eventType == .reconciledFinal, "event type should parse deterministically")

    let malformedPayload: [String: Any] = [
        "event_type": "final",
        "channel": "mic",
        "segment_id": "segment-x",
        "start_ms": 0,
        "end_ms": 100
    ]
    check(
        TranscriptTimelineResolver.parseTranscriptLine(from: malformedPayload) == nil,
        "missing text should fail parsing"
    )
}

@main
struct TranscriptTimelineSmokeMain {
    static func main() {
        runOrderingAndPreferenceAssertions()
        runParserAssertions()
        print("transcript_timeline_smoke: PASS")
    }
}
