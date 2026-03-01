#!/usr/bin/env python3
"""Summarize live-stream backlog pressure gate artifacts into a key/value CSV."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--jsonl", required=True, type=Path)
    parser.add_argument("--summary-csv", required=True, type=Path)
    parser.add_argument("--min-drop-ratio", required=True, type=float)
    parser.add_argument("--max-drop-ratio", required=True, type=float)
    parser.add_argument("--min-lag-p95-ms", required=True, type=float)
    return parser.parse_args()


def as_int(value: object) -> int:
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def as_float(value: object) -> float:
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    if isinstance(value, (int, float)):
        return bool(value)
    return False


def parse_jsonl(path: Path) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                events.append(payload)
    return events


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def main() -> None:
    args = parse_args()
    with args.manifest.open(encoding="utf-8") as handle:
        manifest = json.load(handle)

    events = parse_jsonl(args.jsonl)
    chunk_queue = manifest.get("chunk_queue") or {}
    degradation_events = manifest.get("degradation_events") or []
    trust = manifest.get("trust") or {}
    trust_notices = trust.get("notices") or []
    first_emit_timing = manifest.get("first_emit_timing_ms") or {}

    runtime_mode = str(manifest.get("runtime_mode", ""))
    runtime_mode_taxonomy = str(manifest.get("runtime_mode_taxonomy", ""))
    runtime_mode_selector = str(manifest.get("runtime_mode_selector", ""))
    runtime_mode_status = str(manifest.get("runtime_mode_status", ""))

    submitted = as_int(chunk_queue.get("submitted"))
    enqueued = as_int(chunk_queue.get("enqueued"))
    dropped_oldest = as_int(chunk_queue.get("dropped_oldest"))
    processed = as_int(chunk_queue.get("processed"))
    pending = as_int(chunk_queue.get("pending"))
    high_water = as_int(chunk_queue.get("high_water"))
    max_queue = as_int(chunk_queue.get("max_queue"))
    lag_sample_count = as_int(chunk_queue.get("lag_sample_count"))
    lag_p50_ms = as_int(chunk_queue.get("lag_p50_ms"))
    lag_p95_ms = as_int(chunk_queue.get("lag_p95_ms"))
    lag_max_ms = as_int(chunk_queue.get("lag_max_ms"))

    drop_ratio = 0.0
    if submitted > 0:
        drop_ratio = dropped_oldest / submitted

    degradation_codes = {
        str(item.get("code", ""))
        for item in degradation_events
        if isinstance(item, dict)
    }
    trust_codes = {
        str(item.get("code", "")) for item in trust_notices if isinstance(item, dict)
    }
    jsonl_chunk_queue_events = [
        event for event in events if event.get("event_type") == "chunk_queue"
    ]

    drop_path_active = dropped_oldest > 0
    threshold_pressure_observed_ok = submitted > 0
    threshold_queue_saturation_ok = max_queue > 0 and high_water >= max_queue
    if drop_path_active:
        threshold_drop_ratio_min_ok = drop_ratio >= args.min_drop_ratio
        threshold_drop_ratio_max_ok = drop_ratio <= args.max_drop_ratio
        threshold_lag_p95_ok = as_float(lag_p95_ms) >= args.min_lag_p95_ms
        threshold_degradation_signal_ok = "live_chunk_queue_drop_oldest" in degradation_codes
        threshold_trust_signal_ok = "chunk_queue_backpressure" in trust_codes
        threshold_reconciliation_signal_ok = (
            "reconciliation_applied_after_backpressure" in degradation_codes
        )
    else:
        threshold_drop_ratio_min_ok = True
        threshold_drop_ratio_max_ok = True
        threshold_lag_p95_ok = True
        threshold_degradation_signal_ok = len(degradation_codes) == 0
        threshold_trust_signal_ok = len(trust_codes) == 0
        threshold_reconciliation_signal_ok = True
    threshold_jsonl_chunk_queue_event_ok = len(jsonl_chunk_queue_events) > 0
    threshold_runtime_mode_ok = (
        runtime_mode == "live-stream"
        and runtime_mode_taxonomy == "live-stream"
        and runtime_mode_selector == "--live-stream"
    )
    threshold_runtime_mode_status_ok = runtime_mode_status == "implemented"
    threshold_first_stable_emit_ok = as_int(first_emit_timing.get("first_stable")) > 0
    threshold_transcript_surface_ok = (
        as_int((manifest.get("event_counts") or {}).get("transcript")) > 0
        or as_int((manifest.get("event_counts") or {}).get("partial")) > 0
        or as_int((manifest.get("event_counts") or {}).get("final")) > 0
        or any(
            str(event.get("event_type", "")) in {"partial", "final", "llm_final", "reconciled_final"}
            for event in events
        )
    )
    threshold_terminal_live_mode_ok = as_bool((manifest.get("terminal_summary") or {}).get("live_mode"))

    gate_pass = all(
        [
            threshold_pressure_observed_ok,
            threshold_queue_saturation_ok,
            threshold_drop_ratio_min_ok,
            threshold_drop_ratio_max_ok,
            threshold_lag_p95_ok,
            threshold_degradation_signal_ok,
            threshold_trust_signal_ok,
            threshold_reconciliation_signal_ok,
            threshold_jsonl_chunk_queue_event_ok,
            threshold_runtime_mode_ok,
            threshold_runtime_mode_status_ok,
            threshold_first_stable_emit_ok,
            threshold_transcript_surface_ok,
            threshold_terminal_live_mode_ok,
        ]
    )

    args.summary_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.summary_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["key", "value"])
        writer.writerow(
            [
                "generated_at_utc",
                datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            ]
        )
        writer.writerow(["artifact_track", "gate_backlog_pressure"])
        writer.writerow(["manifest_path", str(args.manifest)])
        writer.writerow(["jsonl_path", str(args.jsonl)])
        writer.writerow(
            ["pressure_profile", "drop-path" if drop_path_active else "buffered-no-drop"]
        )
        writer.writerow(["runtime_mode", runtime_mode])
        writer.writerow(["runtime_mode_taxonomy", runtime_mode_taxonomy])
        writer.writerow(["runtime_mode_selector", runtime_mode_selector])
        writer.writerow(["runtime_mode_status", runtime_mode_status])
        writer.writerow(["submitted", submitted])
        writer.writerow(["enqueued", enqueued])
        writer.writerow(["dropped_oldest", dropped_oldest])
        writer.writerow(["drop_ratio", f"{drop_ratio:.6f}"])
        writer.writerow(["processed", processed])
        writer.writerow(["pending", pending])
        writer.writerow(["max_queue", max_queue])
        writer.writerow(["high_water", high_water])
        writer.writerow(["lag_sample_count", lag_sample_count])
        writer.writerow(["lag_p50_ms", lag_p50_ms])
        writer.writerow(["lag_p95_ms", lag_p95_ms])
        writer.writerow(["lag_max_ms", lag_max_ms])
        writer.writerow(["degradation_codes", "|".join(sorted(degradation_codes))])
        writer.writerow(["trust_codes", "|".join(sorted(trust_codes))])
        writer.writerow(["jsonl_chunk_queue_event_count", len(jsonl_chunk_queue_events)])
        writer.writerow(["first_stable_timing_ms", as_int(first_emit_timing.get("first_stable"))])
        writer.writerow(["min_drop_ratio_target", args.min_drop_ratio])
        writer.writerow(["max_drop_ratio_target", args.max_drop_ratio])
        writer.writerow(["min_lag_p95_ms_target", args.min_lag_p95_ms])
        writer.writerow(
            ["threshold_pressure_observed_ok", bool_text(threshold_pressure_observed_ok)]
        )
        writer.writerow(
            ["threshold_queue_saturation_ok", bool_text(threshold_queue_saturation_ok)]
        )
        writer.writerow(
            ["threshold_drop_ratio_min_ok", bool_text(threshold_drop_ratio_min_ok)]
        )
        writer.writerow(
            ["threshold_drop_ratio_max_ok", bool_text(threshold_drop_ratio_max_ok)]
        )
        writer.writerow(["threshold_lag_p95_ok", bool_text(threshold_lag_p95_ok)])
        writer.writerow(
            [
                "threshold_degradation_signal_ok",
                bool_text(threshold_degradation_signal_ok),
            ]
        )
        writer.writerow(["threshold_trust_signal_ok", bool_text(threshold_trust_signal_ok)])
        writer.writerow(
            [
                "threshold_reconciliation_signal_ok",
                bool_text(threshold_reconciliation_signal_ok),
            ]
        )
        writer.writerow(
            [
                "threshold_jsonl_chunk_queue_event_ok",
                bool_text(threshold_jsonl_chunk_queue_event_ok),
            ]
        )
        writer.writerow(["threshold_runtime_mode_ok", bool_text(threshold_runtime_mode_ok)])
        writer.writerow(
            [
                "threshold_runtime_mode_status_ok",
                bool_text(threshold_runtime_mode_status_ok),
            ]
        )
        writer.writerow(
            ["threshold_first_stable_emit_ok", bool_text(threshold_first_stable_emit_ok)]
        )
        writer.writerow(
            [
                "threshold_transcript_surface_ok",
                bool_text(threshold_transcript_surface_ok),
            ]
        )
        writer.writerow(
            [
                "threshold_terminal_live_mode_ok",
                bool_text(threshold_terminal_live_mode_ok),
            ]
        )
        writer.writerow(["gate_pass", bool_text(gate_pass)])

    print(args.summary_csv)


if __name__ == "__main__":
    main()
