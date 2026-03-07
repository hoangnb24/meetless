import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("live_transcript_poller_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private func runSmoke() {
    let fm = FileManager.default
    let tempRoot = fm.temporaryDirectory
        .appendingPathComponent("recordit-live-transcript-poller-smoke-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: tempRoot) }

    do {
        try fm.createDirectory(at: tempRoot, withIntermediateDirectories: true, attributes: nil)
        let jsonlPath = tempRoot.appendingPathComponent("session.jsonl")

        // Write initial events
        let initialEvents = [
            "{\"event_type\":\"final\",\"channel\":\"mic\",\"segment_id\":\"seg-1\",\"start_ms\":100,\"end_ms\":300,\"text\":\"hello world\"}",
            "{\"event_type\":\"reconciled_final\",\"channel\":\"mic\",\"segment_id\":\"seg-1r\",\"start_ms\":100,\"end_ms\":300,\"text\":\"hello world reconciled\",\"source_final_segment_id\":\"seg-1\"}",
        ]
        let initialContent = initialEvents.joined(separator: "\n") + "\n"
        try Data(initialContent.utf8).write(to: jsonlPath, options: .atomic)

        // Use the tailer + mapper end to end
        let tailer = FileSystemJsonlTailService()
        let mapper = JsonlEventSurfaceMapper()

        let (firstEvents, cursor1) = try tailer.readEvents(at: jsonlPath, from: .start)
        check(firstEvents.count == 2, "first read should produce 2 events, got \(firstEvents.count)")

        let snapshot1 = mapper.map(events: firstEvents)
        check(snapshot1.transcriptLines.count == 1, "reconciled should replace final, got \(snapshot1.transcriptLines.count)")
        check(snapshot1.transcriptLines[0].eventType == "reconciled_final", "expected reconciled_final, got \(snapshot1.transcriptLines[0].eventType)")
        check(snapshot1.transcriptLines[0].text == "hello world reconciled", "unexpected text")
        check(snapshot1.transcriptLines[0].channel == "mic", "unexpected channel")
        check(snapshot1.transcriptLines[0].startMs == 100, "unexpected startMs")
        check(snapshot1.transcriptLines[0].endMs == 300, "unexpected endMs")

        // Append more events (simulating live data arriving)
        let handle = try FileHandle(forWritingTo: jsonlPath)
        defer { try? handle.close() }
        try handle.seekToEnd()
        let newEvents = [
            "{\"event_type\":\"llm_final\",\"channel\":\"system\",\"segment_id\":\"seg-2\",\"start_ms\":500,\"end_ms\":700,\"text\":\"assistant response\"}",
            "{\"event_type\":\"trust_notice\",\"text\":\"degraded confidence\",\"notice_count\":\"1\"}",
        ]
        let newContent = newEvents.joined(separator: "\n") + "\n"
        try handle.write(contentsOf: Data(newContent.utf8))

        let (secondEvents, cursor2) = try tailer.readEvents(at: jsonlPath, from: cursor1)
        check(secondEvents.count == 2, "second read should produce 2 events, got \(secondEvents.count)")
        check(cursor2.byteOffset > cursor1.byteOffset, "cursor should advance")

        let snapshot2 = mapper.map(events: secondEvents)
        check(snapshot2.transcriptLines.count == 1, "expected 1 llm_final line, got \(snapshot2.transcriptLines.count)")
        check(snapshot2.transcriptLines[0].eventType == "llm_final", "expected llm_final")
        check(snapshot2.transcriptLines[0].channel == "system", "expected system channel")
        check(snapshot2.diagnostics.count == 1, "expected 1 trust diagnostic")
        check(snapshot2.diagnostics[0].category == .trust, "expected trust category")

        // No-op reads (no new data)
        let (thirdEvents, cursor3) = try tailer.readEvents(at: jsonlPath, from: cursor2)
        check(thirdEvents.isEmpty, "third read should have no new events")
        check(cursor3.byteOffset == cursor2.byteOffset, "cursor should stay stable")

    } catch {
        check(false, "smoke test threw: \(error)")
    }
}

@main
struct LiveTranscriptPollerSmokeMain {
    static func main() {
        runSmoke()
        print("live_transcript_poller_smoke: PASS")
    }
}
