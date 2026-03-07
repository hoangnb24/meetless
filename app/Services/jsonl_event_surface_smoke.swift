import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("jsonl_event_surface_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private func runSmoke() {
    let mapper = JsonlEventSurfaceMapper()
    let events: [RuntimeEventDTO] = [
        RuntimeEventDTO(
            eventType: "final",
            channel: "mic",
            segmentID: "seg-1",
            startMs: 100,
            endMs: 300,
            text: "first final",
            payload: [:]
        ),
        RuntimeEventDTO(
            eventType: "reconciled_final",
            channel: "mic",
            segmentID: "seg-1r",
            startMs: 100,
            endMs: 300,
            text: "first reconciled",
            payload: ["source_final_segment_id": "seg-1"]
        ),
        RuntimeEventDTO(
            eventType: "llm_final",
            channel: "system",
            segmentID: "seg-2",
            startMs: 400,
            endMs: 500,
            text: "assistant final",
            payload: [:]
        ),
        RuntimeEventDTO(
            eventType: "partial",
            channel: "mic",
            segmentID: "seg-3",
            startMs: 510,
            endMs: 600,
            text: "partial line",
            payload: [:]
        ),
        RuntimeEventDTO(
            eventType: "queue_backpressure",
            text: "queue pressure",
            payload: ["depth": "17"]
        ),
        RuntimeEventDTO(
            eventType: "trust_notice",
            text: "degraded confidence",
            payload: ["notice_count": "2"]
        ),
        RuntimeEventDTO(
            eventType: "lifecycle_started",
            text: "runtime started",
            payload: [:]
        ),
        RuntimeEventDTO(
            eventType: "control_stop_requested",
            text: "stop requested",
            payload: [:]
        ),
        RuntimeEventDTO(
            eventType: "future_event_kind",
            text: "unknown should be ignored",
            payload: [:]
        ),
    ]

    let snapshot = mapper.map(events: events)

    check(snapshot.transcriptLines.count == 2, "expected reconciled + llm stable transcript lines")
    check(snapshot.transcriptLines[0].eventType == "reconciled_final", "reconciled line should replace final")
    check(snapshot.transcriptLines[0].text == "first reconciled", "unexpected reconciled transcript text")
    check(snapshot.transcriptLines[1].eventType == "llm_final", "expected llm final as second stable line")

    check(snapshot.partialLines.count == 1, "expected 1 partial line")
    check(snapshot.partialLines[0].eventType == "partial", "partial eventType mismatch")
    check(snapshot.partialLines[0].text == "partial line", "partial text mismatch")
    check(snapshot.partialLines[0].channel == "mic", "partial channel mismatch")

    check(snapshot.diagnostics.count == 4, "expected queue/trust/lifecycle/control diagnostics only")
    let categories = snapshot.diagnostics.map(\.category)
    check(categories == [.queue, .trust, .lifecycle, .control], "diagnostic category order mismatch")
    check(snapshot.diagnostics.contains(where: { $0.eventType == "queue_backpressure" }), "queue diagnostic missing")
    check(snapshot.diagnostics.contains(where: { $0.eventType == "trust_notice" }), "trust diagnostic missing")
    check(!snapshot.diagnostics.contains(where: { $0.eventType == "future_event_kind" }), "unknown events must be ignored")
}

@main
struct JsonlEventSurfaceSmokeMain {
    static func main() {
        runSmoke()
        print("jsonl_event_surface_smoke: PASS")
    }
}
