#!/usr/bin/env python3
"""Summarize v1 acceptance checks for live-stream mode truth, stable first emit evidence, artifact truth, and pressure trust surfaces."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TRANSCRIPT_EVENT_TYPES = {"partial", "final", "llm_final", "reconciled_final"}
STABLE_TRANSCRIPT_EVENT_TYPES = {"final", "llm_final", "reconciled_final"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cold-manifest", required=True, type=Path)
    parser.add_argument("--cold-jsonl", required=True, type=Path)
    parser.add_argument("--warm-manifest", required=True, type=Path)
    parser.add_argument("--warm-jsonl", required=True, type=Path)
    parser.add_argument("--backlog-manifest", required=True, type=Path)
    parser.add_argument("--backlog-summary", required=True, type=Path)
    parser.add_argument("--summary-csv", required=True, type=Path)
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"expected object JSON at {path}")
    return payload


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            payload = json.loads(line)
            if isinstance(payload, dict):
                rows.append(payload)
    return rows


def load_summary_csv(path: Path) -> dict[str, str]:
    table: dict[str, str] = {}
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        _ = next(reader, None)
        for row in reader:
            if len(row) >= 2:
                table[row[0]] = row[1]
    return table


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    if isinstance(value, (int, float)):
        return bool(value)
    return False


def as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def first_emit_analysis(events: list[dict[str, Any]]) -> dict[str, Any]:
    active_idx = None
    draining_idx = None
    first_emit_idx = None
    first_emit_event: dict[str, Any] | None = None
    first_stable_idx = None
    first_stable_event: dict[str, Any] | None = None

    for idx, event in enumerate(events):
        event_type = str(event.get("event_type", ""))
        if event_type == "lifecycle_phase":
            phase = str(event.get("phase", ""))
            if phase == "active" and active_idx is None:
                active_idx = idx
            if phase in {"draining", "shutdown"} and draining_idx is None:
                draining_idx = idx
        if event_type in TRANSCRIPT_EVENT_TYPES and first_emit_idx is None:
            first_emit_idx = idx
            first_emit_event = event
        if event_type in STABLE_TRANSCRIPT_EVENT_TYPES and first_stable_idx is None:
            first_stable_idx = idx
            first_stable_event = event

    if draining_idx is None:
        draining_idx = len(events)

    first_emit_during_active = (
        active_idx is not None
        and first_emit_idx is not None
        and active_idx < first_emit_idx < draining_idx
    )
    first_stable_during_active = (
        active_idx is not None
        and first_stable_idx is not None
        and active_idx < first_stable_idx < draining_idx
    )

    return {
        "event_count": len(events),
        "active_idx": -1 if active_idx is None else active_idx,
        "draining_idx": draining_idx,
        "first_emit_idx": -1 if first_emit_idx is None else first_emit_idx,
        "first_emit_during_active": first_emit_during_active,
        "first_emit_type": "" if first_emit_event is None else str(first_emit_event.get("event_type", "")),
        "first_emit_channel": "" if first_emit_event is None else str(first_emit_event.get("channel", "")),
        "first_emit_segment_id": "" if first_emit_event is None else str(first_emit_event.get("segment_id", "")),
        "first_emit_start_ms": 0 if first_emit_event is None else as_int(first_emit_event.get("start_ms")),
        "first_stable_idx": -1 if first_stable_idx is None else first_stable_idx,
        "first_stable_during_active": first_stable_during_active,
        "first_stable_type": "" if first_stable_event is None else str(first_stable_event.get("event_type", "")),
        "first_stable_channel": "" if first_stable_event is None else str(first_stable_event.get("channel", "")),
        "first_stable_segment_id": "" if first_stable_event is None else str(first_stable_event.get("segment_id", "")),
        "first_stable_start_ms": 0 if first_stable_event is None else as_int(first_stable_event.get("start_ms")),
    }


def manifest_artifact_truth(manifest: dict[str, Any]) -> dict[str, Any]:
    out_wav = Path(str(manifest.get("out_wav", "")))
    out_wav_materialized = as_bool(manifest.get("out_wav_materialized"))
    out_wav_bytes = as_int(manifest.get("out_wav_bytes"))
    out_wav_exists = out_wav.is_file()
    artifact_truth_ok = out_wav_materialized and out_wav_exists and out_wav_bytes > 0
    return {
        "out_wav": str(out_wav),
        "out_wav_materialized": out_wav_materialized,
        "out_wav_exists": out_wav_exists,
        "out_wav_bytes": out_wav_bytes,
        "artifact_truth_ok": artifact_truth_ok,
    }


def manifest_live_stream_contract(manifest: dict[str, Any], emit: dict[str, Any]) -> dict[str, Any]:
    first_emit_timing = manifest.get("first_emit_timing_ms")
    if not isinstance(first_emit_timing, dict):
        first_emit_timing = {}
    runtime_mode = str(manifest.get("runtime_mode", ""))
    runtime_mode_taxonomy = str(manifest.get("runtime_mode_taxonomy", ""))
    runtime_mode_selector = str(manifest.get("runtime_mode_selector", ""))
    runtime_mode_status = str(manifest.get("runtime_mode_status", ""))
    terminal_summary = manifest.get("terminal_summary")
    if not isinstance(terminal_summary, dict):
        terminal_summary = {}
    first_stable_timing_ms = as_int(first_emit_timing.get("first_stable"))
    runtime_mode_ok = (
        runtime_mode == "live-stream"
        and runtime_mode_taxonomy == "live-stream"
        and runtime_mode_selector == "--live-stream"
    )
    runtime_mode_status_ok = runtime_mode_status == "implemented"
    first_stable_emit_ok = emit["active_idx"] >= 0 and (
        first_stable_timing_ms > 0 or emit["first_stable_idx"] >= 0
    )
    terminal_live_mode_ok = as_bool(terminal_summary.get("live_mode"))
    return {
        "runtime_mode": runtime_mode,
        "runtime_mode_taxonomy": runtime_mode_taxonomy,
        "runtime_mode_selector": runtime_mode_selector,
        "runtime_mode_status": runtime_mode_status,
        "runtime_mode_ok": runtime_mode_ok,
        "runtime_mode_status_ok": runtime_mode_status_ok,
        "first_stable_timing_ms": first_stable_timing_ms,
        "first_stable_emit_ok": first_stable_emit_ok,
        "terminal_live_mode_ok": terminal_live_mode_ok,
    }


def main() -> None:
    args = parse_args()

    cold_manifest = load_json(args.cold_manifest)
    warm_manifest = load_json(args.warm_manifest)
    backlog_manifest = load_json(args.backlog_manifest)

    cold_events = load_jsonl(args.cold_jsonl)
    warm_events = load_jsonl(args.warm_jsonl)
    backlog_summary = load_summary_csv(args.backlog_summary)

    cold_emit = first_emit_analysis(cold_events)
    warm_emit = first_emit_analysis(warm_events)
    cold_artifact = manifest_artifact_truth(cold_manifest)
    warm_artifact = manifest_artifact_truth(warm_manifest)
    cold_live_stream = manifest_live_stream_contract(cold_manifest, cold_emit)
    warm_live_stream = manifest_live_stream_contract(warm_manifest, warm_emit)

    backlog_gate_pass = as_bool(backlog_summary.get("gate_pass", "false"))
    backlog_pressure_profile = str(backlog_summary.get("pressure_profile", "")).strip()
    if not backlog_pressure_profile:
        backlog_dropped_oldest = as_int(
            ((backlog_manifest.get("chunk_queue") or {}) if isinstance(backlog_manifest, dict) else {}).get(
                "dropped_oldest"
            )
        )
        backlog_pressure_profile = "drop-path" if backlog_dropped_oldest > 0 else "buffered-no-drop"
    backlog_pressure_profile_known = backlog_pressure_profile in {"drop-path", "buffered-no-drop"}
    pressure_thresholds_ok = all(
        as_bool(backlog_summary.get(key, "false"))
        for key in [
            "threshold_pressure_observed_ok",
            "threshold_queue_saturation_ok",
            "threshold_drop_ratio_min_ok",
            "threshold_drop_ratio_max_ok",
            "threshold_lag_p95_ok",
            "threshold_runtime_mode_ok",
            "threshold_runtime_mode_status_ok",
            "threshold_first_stable_emit_ok",
            "threshold_transcript_surface_ok",
            "threshold_terminal_live_mode_ok",
        ]
    )
    degradation_signal_ok = as_bool(backlog_summary.get("threshold_degradation_signal_ok", "false"))
    trust_signal_ok = as_bool(backlog_summary.get("threshold_trust_signal_ok", "false"))

    backlog_degradation_count = len(backlog_manifest.get("degradation_events", []))
    backlog_trust_notice_count = as_int(
        (backlog_manifest.get("trust") or {}).get("notice_count")
        if isinstance(backlog_manifest.get("trust"), dict)
        else 0
    )
    if backlog_pressure_profile == "drop-path":
        backlog_surface_ok = backlog_degradation_count > 0 and backlog_trust_notice_count > 0
    elif backlog_pressure_profile == "buffered-no-drop":
        backlog_surface_ok = backlog_degradation_count == 0 and backlog_trust_notice_count == 0
    else:
        backlog_surface_ok = False

    gate_pass = all(
        [
            cold_live_stream["runtime_mode_ok"],
            cold_live_stream["runtime_mode_status_ok"],
            cold_live_stream["first_stable_emit_ok"],
            cold_live_stream["terminal_live_mode_ok"],
            warm_live_stream["runtime_mode_ok"],
            warm_live_stream["runtime_mode_status_ok"],
            warm_live_stream["first_stable_emit_ok"],
            warm_live_stream["terminal_live_mode_ok"],
            cold_artifact["artifact_truth_ok"],
            warm_artifact["artifact_truth_ok"],
            pressure_thresholds_ok,
            degradation_signal_ok,
            trust_signal_ok,
            backlog_pressure_profile_known,
            backlog_surface_ok,
            backlog_gate_pass,
        ]
    )

    args.summary_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.summary_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["key", "value"])
        writer.writerow(["generated_at_utc", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")])
        writer.writerow(["artifact_track", "gate_v1_acceptance"])
        writer.writerow(["cold_manifest_path", str(args.cold_manifest)])
        writer.writerow(["cold_jsonl_path", str(args.cold_jsonl)])
        writer.writerow(["warm_manifest_path", str(args.warm_manifest)])
        writer.writerow(["warm_jsonl_path", str(args.warm_jsonl)])
        writer.writerow(["backlog_manifest_path", str(args.backlog_manifest)])
        writer.writerow(["backlog_summary_path", str(args.backlog_summary)])

        writer.writerow(["cold_event_count", cold_emit["event_count"]])
        writer.writerow(["cold_active_idx", cold_emit["active_idx"]])
        writer.writerow(["cold_first_emit_idx", cold_emit["first_emit_idx"]])
        writer.writerow(["cold_first_emit_type", cold_emit["first_emit_type"]])
        writer.writerow(["cold_first_emit_channel", cold_emit["first_emit_channel"]])
        writer.writerow(["cold_first_emit_segment_id", cold_emit["first_emit_segment_id"]])
        writer.writerow(["cold_first_emit_start_ms", cold_emit["first_emit_start_ms"]])
        writer.writerow(["cold_first_emit_during_active_ok", bool_text(cold_emit["first_emit_during_active"])])
        writer.writerow(["cold_first_stable_idx", cold_emit["first_stable_idx"]])
        writer.writerow(["cold_first_stable_type", cold_emit["first_stable_type"]])
        writer.writerow(["cold_first_stable_channel", cold_emit["first_stable_channel"]])
        writer.writerow(["cold_first_stable_segment_id", cold_emit["first_stable_segment_id"]])
        writer.writerow(["cold_first_stable_start_ms", cold_emit["first_stable_start_ms"]])
        writer.writerow(["cold_first_stable_during_active_ok", bool_text(cold_emit["first_stable_during_active"])])
        writer.writerow(["cold_runtime_mode", cold_live_stream["runtime_mode"]])
        writer.writerow(["cold_runtime_mode_taxonomy", cold_live_stream["runtime_mode_taxonomy"]])
        writer.writerow(["cold_runtime_mode_selector", cold_live_stream["runtime_mode_selector"]])
        writer.writerow(["cold_runtime_mode_ok", bool_text(cold_live_stream["runtime_mode_ok"])])
        writer.writerow(["cold_runtime_mode_status", cold_live_stream["runtime_mode_status"]])
        writer.writerow(["cold_runtime_mode_status_ok", bool_text(cold_live_stream["runtime_mode_status_ok"])])
        writer.writerow(["cold_first_stable_timing_ms", cold_live_stream["first_stable_timing_ms"]])
        writer.writerow(["cold_first_stable_emit_ok", bool_text(cold_live_stream["first_stable_emit_ok"])])
        writer.writerow(["cold_terminal_live_mode_ok", bool_text(cold_live_stream["terminal_live_mode_ok"])])

        writer.writerow(["warm_event_count", warm_emit["event_count"]])
        writer.writerow(["warm_active_idx", warm_emit["active_idx"]])
        writer.writerow(["warm_first_emit_idx", warm_emit["first_emit_idx"]])
        writer.writerow(["warm_first_emit_type", warm_emit["first_emit_type"]])
        writer.writerow(["warm_first_emit_channel", warm_emit["first_emit_channel"]])
        writer.writerow(["warm_first_emit_segment_id", warm_emit["first_emit_segment_id"]])
        writer.writerow(["warm_first_emit_start_ms", warm_emit["first_emit_start_ms"]])
        writer.writerow(["warm_first_emit_during_active_ok", bool_text(warm_emit["first_emit_during_active"])])
        writer.writerow(["warm_first_stable_idx", warm_emit["first_stable_idx"]])
        writer.writerow(["warm_first_stable_type", warm_emit["first_stable_type"]])
        writer.writerow(["warm_first_stable_channel", warm_emit["first_stable_channel"]])
        writer.writerow(["warm_first_stable_segment_id", warm_emit["first_stable_segment_id"]])
        writer.writerow(["warm_first_stable_start_ms", warm_emit["first_stable_start_ms"]])
        writer.writerow(["warm_first_stable_during_active_ok", bool_text(warm_emit["first_stable_during_active"])])
        writer.writerow(["warm_runtime_mode", warm_live_stream["runtime_mode"]])
        writer.writerow(["warm_runtime_mode_taxonomy", warm_live_stream["runtime_mode_taxonomy"]])
        writer.writerow(["warm_runtime_mode_selector", warm_live_stream["runtime_mode_selector"]])
        writer.writerow(["warm_runtime_mode_ok", bool_text(warm_live_stream["runtime_mode_ok"])])
        writer.writerow(["warm_runtime_mode_status", warm_live_stream["runtime_mode_status"]])
        writer.writerow(["warm_runtime_mode_status_ok", bool_text(warm_live_stream["runtime_mode_status_ok"])])
        writer.writerow(["warm_first_stable_timing_ms", warm_live_stream["first_stable_timing_ms"]])
        writer.writerow(["warm_first_stable_emit_ok", bool_text(warm_live_stream["first_stable_emit_ok"])])
        writer.writerow(["warm_terminal_live_mode_ok", bool_text(warm_live_stream["terminal_live_mode_ok"])])

        writer.writerow(["cold_out_wav", cold_artifact["out_wav"]])
        writer.writerow(["cold_out_wav_materialized", bool_text(cold_artifact["out_wav_materialized"])])
        writer.writerow(["cold_out_wav_exists", bool_text(cold_artifact["out_wav_exists"])])
        writer.writerow(["cold_out_wav_bytes", cold_artifact["out_wav_bytes"]])
        writer.writerow(["cold_artifact_truth_ok", bool_text(cold_artifact["artifact_truth_ok"])])

        writer.writerow(["warm_out_wav", warm_artifact["out_wav"]])
        writer.writerow(["warm_out_wav_materialized", bool_text(warm_artifact["out_wav_materialized"])])
        writer.writerow(["warm_out_wav_exists", bool_text(warm_artifact["out_wav_exists"])])
        writer.writerow(["warm_out_wav_bytes", warm_artifact["out_wav_bytes"]])
        writer.writerow(["warm_artifact_truth_ok", bool_text(warm_artifact["artifact_truth_ok"])])

        writer.writerow(["backlog_gate_pass", bool_text(backlog_gate_pass)])
        writer.writerow(["backlog_pressure_profile", backlog_pressure_profile])
        writer.writerow(["backlog_pressure_profile_known_ok", bool_text(backlog_pressure_profile_known)])
        writer.writerow(["backlog_pressure_thresholds_ok", bool_text(pressure_thresholds_ok)])
        writer.writerow(["backlog_degradation_signal_ok", bool_text(degradation_signal_ok)])
        writer.writerow(["backlog_trust_signal_ok", bool_text(trust_signal_ok)])
        writer.writerow(["backlog_degradation_event_count", backlog_degradation_count])
        writer.writerow(["backlog_trust_notice_count", backlog_trust_notice_count])
        writer.writerow(["backlog_surface_ok", bool_text(backlog_surface_ok)])

        writer.writerow(["gate_pass", bool_text(gate_pass)])

    print(args.summary_csv)


if __name__ == "__main__":
    main()
