import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("startup_migration_repair_smoke failed: \(message)\n", stderr)
        exit(1)
    }
}

private struct FailingSessionLibraryService: SessionLibraryService {
    func listSessions(query: SessionQuery) throws -> [SessionSummaryDTO] {
        throw AppServiceError(
            code: .ioFailure,
            userMessage: "List failed.",
            remediation: "Retry after startup."
        )
    }

    func deleteSession(
        sessionID: String,
        rootPath: URL,
        confirmTrash: Bool
    ) throws -> SessionDeletionResultDTO {
        throw AppServiceError(
            code: .invalidInput,
            userMessage: "Delete not available.",
            remediation: "Not part of this smoke."
        )
    }
}

private func session(
    id: String,
    rootPath: URL,
    source: SessionIngestSource
) -> SessionSummaryDTO {
    SessionSummaryDTO(
        sessionID: id,
        startedAt: Date(timeIntervalSince1970: 10),
        durationMs: 1_000,
        mode: .recordOnly,
        status: .pending,
        rootPath: rootPath,
        ingestSource: source,
        outcomeClassification: .partialArtifact
    )
}

private func writeExistingIndex(at url: URL) throws {
    let payload: [String: Any] = [
        "schemaVersion": "1",
        "generatedAtUTC": "2026-03-05T00:00:00Z",
        "entries": [
            [
                "sessionID": "keep",
                "rootPath": "/tmp/keep",
                "status": "pending",
                "mode": "record_only",
                "ingestSource": "canonical_directory",
                "startedAtUTC": "2026-03-05T00:00:00Z"
            ],
            [
                "sessionID": "stale",
                "rootPath": "/tmp/stale",
                "status": "failed",
                "mode": "record_only",
                "ingestSource": "canonical_directory",
                "startedAtUTC": "2026-03-05T00:00:00Z"
            ]
        ]
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    try data.write(to: url, options: .atomic)
}

private func runSuccessPath(tempRoot: URL) throws {
    let indexDir = tempRoot.appendingPathComponent(".recordit", isDirectory: true)
    try FileManager.default.createDirectory(at: indexDir, withIntermediateDirectories: true, attributes: nil)
    let indexPath = indexDir.appendingPathComponent("session-library-index.json")
    try writeExistingIndex(at: indexPath)

    let sessions = [
        session(id: "keep", rootPath: URL(fileURLWithPath: "/tmp/keep"), source: .canonicalDirectory),
        session(id: "legacy", rootPath: URL(fileURLWithPath: "/tmp/new"), source: .legacyFlatImport)
    ]
    let library = MockSessionLibraryService(sessions: sessions)
    let service = StartupMigrationRepairService(
        sessionLibraryService: library,
        sessionsRootProvider: { tempRoot },
        timeBudgetSeconds: 5,
        maxPersistedEntries: 32,
        logger: { _ in }
    )

    let report = service.runRepair()
    check(report.sessionCountScanned == 2, "expected scan count to match current sessions")
    check(report.staleIndexEntryCount == 1, "expected one stale index entry")
    check(report.missingIndexEntryCount == 1, "expected one missing index entry")
    check(report.legacyImportCount == 1, "expected one legacy import")
    check(report.queryableAfterRepair, "library should remain queryable after repair")
    check(report.failureMessages.isEmpty, "success path should not produce failures")

    let handle = try FileHandle(forReadingFrom: report.indexPath)
    defer { try? handle.close() }
    let raw = try handle.readToEnd() ?? Data()
    guard let decoded = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
        check(false, "persisted index should decode as dictionary")
        return
    }
    let entries = decoded["entries"] as? [[String: Any]] ?? []
    check(entries.count == 2, "persisted index should contain repaired session set")
}

private func runFailurePath(tempRoot: URL) {
    let service = StartupMigrationRepairService(
        sessionLibraryService: FailingSessionLibraryService(),
        sessionsRootProvider: { tempRoot },
        timeBudgetSeconds: 5,
        maxPersistedEntries: 32,
        logger: { _ in }
    )
    let report = service.runRepair()
    check(!report.failureMessages.isEmpty, "failure path should record diagnostics")
    check(!report.queryableAfterRepair, "queryableAfterRepair should be false when scan fails")
}

private func runSmoke() {
    let fm = FileManager.default
    let tempRoot = fm.temporaryDirectory
        .appendingPathComponent("recordit-startup-repair-smoke-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: tempRoot) }

    do {
        try fm.createDirectory(at: tempRoot, withIntermediateDirectories: true, attributes: nil)
        try runSuccessPath(tempRoot: tempRoot)
        runFailurePath(tempRoot: tempRoot)
    } catch {
        check(false, "smoke failed with error: \(error)")
    }
}

@main
struct StartupMigrationRepairSmokeMain {
    static func main() {
        runSmoke()
        print("startup_migration_repair_smoke: PASS")
    }
}
