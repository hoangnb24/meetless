# bd-1nvl: Unit Suite for Parser, Status Mapping, Ordering, and Redaction

## Scope

Completed deterministic unit-style coverage across the four required surfaces:

1. preflight envelope parser validation
2. manifest-driven final status mapping
3. transcript ordering + reconciled preference semantics
4. diagnostics redaction default vs explicit opt-in

## Implementation

### Added

1. `app/Services/transcript_timeline_smoke.swift`
   - new deterministic smoke for `TranscriptTimelineResolver`
   - validates:
     - ordering stability
     - partial exclusion from canonical display lines
     - reconciled-final preference over superseded final events
     - dedupe behavior
     - parser rejection of malformed transcript payloads

### Verified Existing Unit/Smoke Coverage (run as bead acceptance suite)

1. `app/Preflight/preflight_smoke.swift`
   - envelope schema/kind validation + malformed check handling
2. `app/ViewModels/runtime_status_mapping_smoke.swift`
   - OK/Degraded/Failed status branches and degraded-success behavior
3. `app/Exports/export_smoke.swift`
   - diagnostics redaction-by-default and transcript opt-in behavior

## Validation

```bash
swiftc app/Services/ServiceInterfaces.swift app/Preflight/PreflightRunner.swift app/Preflight/preflight_smoke.swift -o /tmp/preflight_smoke && /tmp/preflight_smoke

swiftc app/Services/ServiceInterfaces.swift app/Services/MockServices.swift app/Accessibility/AccessibilityContracts.swift app/ViewModels/RuntimeViewModel.swift app/RuntimeStatus/ManifestFinalStatusMapper.swift app/ViewModels/runtime_status_mapping_smoke.swift -o /tmp/runtime_status_mapping_smoke && /tmp/runtime_status_mapping_smoke

swiftc app/Services/TranscriptTimelineResolver.swift app/Services/transcript_timeline_smoke.swift -o /tmp/transcript_timeline_smoke && /tmp/transcript_timeline_smoke

swiftc app/Services/ServiceInterfaces.swift app/Accessibility/AccessibilityContracts.swift app/Exports/SessionExportService.swift app/Exports/export_smoke.swift -o /tmp/export_smoke && /tmp/export_smoke

swiftc -parse-as-library -emit-module app/Services/TranscriptTimelineResolver.swift -module-name RecordItTranscriptTimeline -o /tmp/RecordItTranscriptTimeline.swiftmodule

UBS_MAX_DIR_SIZE_MB=5000 ubs app/Services/transcript_timeline_smoke.swift docs/bd-1nvl-unit-suite.md
```
