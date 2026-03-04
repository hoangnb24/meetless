# Reliability Risk Register

Date: 2026-03-04  
Status: active register for modernization program (`bd-1wtz`)  
Owning bead: `bd-4ef0`

## Purpose

Track the highest-impact reliability risks for Phase 1-3 modernization with explicit:

- failure mode
- early-warning signal
- mitigation and containment action
- owner/follow-up bead
- escalation path
- evidence links

This register is intended to be kept current as Phase 1/2/3 and benchmark beads close.

## Severity Scale

- `Critical`: immediate risk to transcript correctness, operator trust, or release safety.
- `High`: meaningful degradation risk requiring near-term mitigation before closeout.
- `Medium`: bounded risk that must be tracked but is not an immediate release blocker.

## Active Risk Register

| Risk ID | Severity | Failure mode | Early warning signal(s) | Mitigation and containment | Owner bead(s) | Escalation path | Current disposition | Evidence |
|---|---|---|---|---|---|---|---|---|
| `R-P1-001` | Critical | Live ASR queue pressure drops work and degrades in-session transcript quality. | `chunk_queue.dropped_oldest > 0`; trust code `chunk_queue_backpressure_severe`; degradation code `live_chunk_queue_backpressure_severe`; sustained `lag_p95_ms` growth. | Implement adaptive backpressure state machine and cadence policy; prioritize `final` work; keep reconciliation explicit when degradation occurs. | `bd-15iy`, `bd-3d9f`, `bd-2mfb` | If severe signal persists, execute rollback/kill-switch playbook and move session classification to degraded for operator guidance. | Open | `docs/realtime-contracts.md`; `src/bin/transcribe_live/runtime_live_stream.rs`; `src/bin/transcribe_live/app.rs` |
| `R-P1-002` | High | Capture hot path loses chunks under transport pressure before ASR stage. | Capture telemetry `slot_miss_drops` or `queue_full_drops`; transport high-water saturation in callback/runtime summaries. | Strengthen hot-path observability and breadcrumbing; tune queue/producer cadence; rerun pressure gates with linked evidence. | `bd-1wb2`, `bd-a9fh` | If transport drops are non-transient, treat as release-blocking reliability regression until counters stabilize. | Open | `src/rt_transport.rs`; `src/live_capture.rs`; `docs/realtime-contracts.md` |
| `R-P1-003` | High | Continuity gaps or unverifiable continuity after capture interruptions undermine trust in session completeness. | Trust codes `continuity_recovered_with_gaps` or `continuity_unverified`; degradation codes `live_capture_continuity_unverified` / `live_capture_transport_degraded`. | Keep interruption recovery explicit in artifacts; force reconciliation where required; require operator review guidance in runbook and triage docs. | `bd-3imk`, `bd-3r5k` | If continuity trust is degraded, block "clean session" claims and require incident triage workflow before sign-off. | Open | `docs/realtime-contracts.md`; `docs/state-machine.md`; `docs/transcribe-operator-runbook.md` |
| `R-P1-004` | High | Callback contract degradation introduces silent capture data loss or invalid audio assumptions. | Callback counters rise (`missing_*`, `non_float_pcm`, `chunk_too_large`); trust code `capture_callback_contract_degraded`. | Keep callback contract enforcement mode explicit (`warn` vs `strict`); investigate source counter and apply fail-fast where needed. | `bd-1wb2`, `bd-3imk` | Repeated callback contract degradation escalates to runtime hardening + release hold until cause is understood. | Open | `src/live_capture.rs`; `docs/realtime-contracts.md`; `docs/session-telemetry.md` |
| `R-P2-001` | High | Contract drift while refactoring JSON boundary or orchestration causes replay/schema incompatibility. | Contract CI failures; schema/test regressions in runtime JSONL/manifest/exit contracts; mismatches in no-drift checklist. | Maintain contract no-drift checklist with explicit evidence links; run schema/contract suites before merge; keep additive-only policy for compatibility surfaces. | `bd-2cwj`, `bd-o5d0`, `bd-1lsa` | Any Tier/S-class contract drift is release-blocking and requires explicit remediation before rollout proceeds. | Open | `contracts/*.json`; `tests/runtime_*_contract.rs`; `docs/runtime-compatibility-boundary-policy.md` |
| `R-B1-001` | Critical | Benchmark claims become invalid due to lane misclassification or baseline drift. | Missing anchor linkage; mixing buffered-no-drop and induced drop-path conclusions; no raw artifact references for claimed deltas. | Use frozen anchor registry and fixed formulas; mark induced-lane non-drop runs as incomplete rather than successful; publish explicit lane classification in every benchmark note. | `bd-1mxy`, `bd-1wza`, `bd-nxug` | If evidence cannot prove lane intent and baseline comparability, block optimization go/no-go decision. | Open | `docs/phase1-baseline-anchors.md`; `docs/gate-phase-next-report.md`; `docs/gate-backlog-pressure.md` |
| `R-X1-001` | Medium | Ops response is inconsistent under pressure incidents because thresholds and drills are underdefined. | Ambiguous alert severity; no operator response timeline; unresolved drill gaps. | Define SLO/alert thresholds and run incident drill with detect->mitigate timeline evidence; feed findings into closeout decision. | `bd-38ai`, `bd-2hqm` | If drill outcomes are ambiguous/failing, do not advance final closeout sign-off. | Open | `docs/transcribe-operator-runbook.md`; `docs/bd-2ak3-rollout-migration-deprecation-checklist.md` |

## Baseline-Linked Guardrails

Guardrails consumed by this register:

- First stable timing regression ceiling: `post_first_stable_ms <= 2332` (10% over 2120ms baseline).
- Induced drop-path dropped-oldest target: `post_dropped_oldest <= 9`.
- Induced drop-path drop-ratio target: `post_drop_ratio <= 0.326667`.

Source:

- `docs/phase1-baseline-anchors.md` (`bd-1xos` anchor set)

If baseline anchors are revised, update this section in the same change and link the reason.

## Update Rules

1. Any change to risk status must include at least one fresh evidence link.
2. Any risk marked `Mitigated` must cite the bead(s) and validation command/artifact proving mitigation.
3. Any new high/critical risk discovered during implementation, gates, or drills must be added before session closeout.
4. Closeout/go-no-go beads must cite this register rather than duplicating risk state from memory.
