#!/usr/bin/env python3
"""Summarize packaged live-stream smoke gate artifacts into key/value CSV."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TRANSCRIPT_EVENT_TYPES = {"partial", "final", "llm_final", "reconciled_final"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doctor-exit-code", required=True, type=int)
    parser.add_argument("--doctor-stdout", required=True, type=Path)
    parser.add_argument("--runtime-exit-code", required=True, type=int)
    parser.add_argument("--runtime-stderr", required=True, type=Path)
    parser.add_argument("--runtime-input-wav", required=True, type=Path)
    parser.add_argument("--runtime-manifest", required=True, type=Path)
    parser.add_argument("--runtime-jsonl", required=True, type=Path)
    parser.add_argument("--expected-artifact-root", required=True, type=Path)
    parser.add_argument("--summary-csv", required=True, type=Path)
    return parser.parse_args()


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


def path_within_root(path: Path, root: Path) -> bool:
    if not str(path):
        return False

    try:
        normalized_path = path.expanduser().resolve(strict=False)
        normalized_root = root.expanduser().resolve(strict=False)
    except RuntimeError:
        return False

    try:
        normalized_path.relative_to(normalized_root)
        return True
    except ValueError:
        return False


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if isinstance(payload, dict):
        return payload
    return {}


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                rows.append(payload)
    return rows


def first_emit_analysis(events: list[dict[str, Any]]) -> dict[str, Any]:
    active_idx = None
    draining_idx = None
    first_emit_idx = None
    first_emit_event: dict[str, Any] | None = None

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

    if draining_idx is None:
        draining_idx = len(events)

    first_emit_during_active = (
        active_idx is not None
        and first_emit_idx is not None
        and active_idx < first_emit_idx < draining_idx
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
    }


def main() -> None:
    args = parse_args()

    doctor_stdout = args.doctor_stdout.read_text(encoding="utf-8") if args.doctor_stdout.is_file() else ""
    runtime_stderr = args.runtime_stderr.read_text(encoding="utf-8") if args.runtime_stderr.is_file() else ""
    doctor_exit_ok = args.doctor_exit_code == 0
    doctor_banner_ok = "Transcribe-live model doctor" in doctor_stdout

    runtime_manifest = load_json(args.runtime_manifest)
    runtime_events = load_jsonl(args.runtime_jsonl)
    emit = first_emit_analysis(runtime_events)

    runtime_manifest_exists = args.runtime_manifest.is_file()
    runtime_jsonl_exists = args.runtime_jsonl.is_file()
    runtime_input_exists = args.runtime_input_wav.is_file()
    runtime_input_bytes = args.runtime_input_wav.stat().st_size if runtime_input_exists else 0
    runtime_input_capture_ok = runtime_input_exists and runtime_input_bytes > 0

    runtime_exit_ok = args.runtime_exit_code == 0
    runtime_kind = str(runtime_manifest.get("kind", ""))
    runtime_mode = str(runtime_manifest.get("runtime_mode", ""))
    runtime_mode_taxonomy = str(runtime_manifest.get("runtime_mode_taxonomy", ""))
    runtime_mode_selector = str(runtime_manifest.get("runtime_mode_selector", ""))
    runtime_mode_status = str(runtime_manifest.get("runtime_mode_status", ""))
    runtime_kind_ok = runtime_kind == "transcribe-live-runtime"
    runtime_mode_ok = (
        runtime_mode == "live-stream"
        and runtime_mode_taxonomy == "live-stream"
        and runtime_mode_selector == "--live-stream"
    )
    runtime_mode_status_ok = runtime_mode_status == "implemented"

    out_wav = Path(str(runtime_manifest.get("out_wav", "")))
    out_wav_exists = out_wav.is_file()
    out_wav_bytes = as_int(runtime_manifest.get("out_wav_bytes"))
    out_wav_materialized = as_bool(runtime_manifest.get("out_wav_materialized"))
    runtime_out_wav_truth_ok = out_wav_exists and out_wav_materialized and out_wav_bytes > 0

    terminal_summary = runtime_manifest.get("terminal_summary")
    if not isinstance(terminal_summary, dict):
        terminal_summary = {}
    terminal_live_mode_ok = as_bool(terminal_summary.get("live_mode"))
    terminal_stable_lines_replayed = as_bool(terminal_summary.get("stable_lines_replayed"))
    terminal_replay_suppressed_ok = not terminal_stable_lines_replayed

    trust = runtime_manifest.get("trust")
    if not isinstance(trust, dict):
        trust = {}
    trust_notices = trust.get("notices")
    if not isinstance(trust_notices, list):
        trust_notices = []
    trust_notice_count = as_int(trust.get("notice_count"))
    trust_surface_ok = trust_notice_count == len(trust_notices)

    degradation_events = runtime_manifest.get("degradation_events")
    degradation_surface_ok = isinstance(degradation_events, list)

    session_summary = runtime_manifest.get("session_summary")
    if not isinstance(session_summary, dict):
        session_summary = {}
    session_artifacts = session_summary.get("artifacts")
    if not isinstance(session_artifacts, dict):
        session_artifacts = {}
    manifest_jsonl_path = Path(str(runtime_manifest.get("jsonl_path", "")))
    manifest_out_manifest_path = Path(str(session_artifacts.get("out_manifest", "")))
    artifact_root_ok = all(
        [
            path_within_root(args.runtime_input_wav, args.expected_artifact_root),
            path_within_root(args.runtime_manifest, args.expected_artifact_root),
            path_within_root(args.runtime_jsonl, args.expected_artifact_root),
            path_within_root(out_wav, args.expected_artifact_root),
            path_within_root(manifest_jsonl_path, args.expected_artifact_root),
            path_within_root(manifest_out_manifest_path, args.expected_artifact_root),
        ]
    )
    manifest_jsonl_match_ok = manifest_jsonl_path == args.runtime_jsonl
    manifest_out_manifest_match_ok = manifest_out_manifest_path == args.runtime_manifest

    event_counts = runtime_manifest.get("event_counts")
    if not isinstance(event_counts, dict):
        event_counts = {}
    manifest_transcript_surface_ok = (
        as_int(event_counts.get("transcript")) > 0
        or as_int(event_counts.get("partial")) > 0
        or as_int(event_counts.get("final")) > 0
        or as_int(event_counts.get("llm_final")) > 0
        or as_int(event_counts.get("reconciled_final")) > 0
    )
    jsonl_transcript_event_count = sum(
        1 for event in runtime_events if str(event.get("event_type", "")) in TRANSCRIPT_EVENT_TYPES
    )
    jsonl_transcript_surface_ok = jsonl_transcript_event_count > 0
    transcript_surface_ok = manifest_transcript_surface_ok or jsonl_transcript_surface_ok

    runtime_error_line = ""
    for raw_line in runtime_stderr.splitlines():
        line = raw_line.strip()
        if line.startswith("error:"):
            runtime_error_line = line
            break
    runtime_helper_exec_blocked = (
        "failed to execute `whisper-cli` prewarm probe: Operation not permitted" in runtime_error_line
    )

    gate_pass = all(
        [
            doctor_exit_ok,
            doctor_banner_ok,
            runtime_exit_ok,
            runtime_manifest_exists,
            runtime_jsonl_exists,
            runtime_input_capture_ok,
            runtime_kind_ok,
            runtime_mode_ok,
            runtime_mode_status_ok,
            runtime_out_wav_truth_ok,
            emit["first_emit_during_active"],
            terminal_live_mode_ok,
            terminal_replay_suppressed_ok,
            trust_surface_ok,
            degradation_surface_ok,
            artifact_root_ok,
            manifest_jsonl_match_ok,
            manifest_out_manifest_match_ok,
            transcript_surface_ok,
        ]
    )

    args.summary_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.summary_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["key", "value"])
        writer.writerow(["generated_at_utc", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")])
        writer.writerow(["artifact_track", "gate_packaged_live_smoke"])
        writer.writerow(["doctor_exit_code", args.doctor_exit_code])
        writer.writerow(["doctor_exit_ok", bool_text(doctor_exit_ok)])
        writer.writerow(["doctor_banner_ok", bool_text(doctor_banner_ok)])
        writer.writerow(["runtime_exit_code", args.runtime_exit_code])
        writer.writerow(["runtime_exit_ok", bool_text(runtime_exit_ok)])
        writer.writerow(["runtime_manifest_path", str(args.runtime_manifest)])
        writer.writerow(["runtime_manifest_exists", bool_text(runtime_manifest_exists)])
        writer.writerow(["runtime_jsonl_path", str(args.runtime_jsonl)])
        writer.writerow(["runtime_jsonl_exists", bool_text(runtime_jsonl_exists)])
        writer.writerow(["runtime_input_wav_path", str(args.runtime_input_wav)])
        writer.writerow(["runtime_input_wav_exists", bool_text(runtime_input_exists)])
        writer.writerow(["runtime_input_wav_bytes", runtime_input_bytes])
        writer.writerow(["runtime_input_capture_ok", bool_text(runtime_input_capture_ok)])
        writer.writerow(["expected_artifact_root", str(args.expected_artifact_root)])
        writer.writerow(["runtime_kind", runtime_kind])
        writer.writerow(["runtime_kind_ok", bool_text(runtime_kind_ok)])
        writer.writerow(["runtime_mode", runtime_mode])
        writer.writerow(["runtime_mode_taxonomy", runtime_mode_taxonomy])
        writer.writerow(["runtime_mode_selector", runtime_mode_selector])
        writer.writerow(["runtime_mode_ok", bool_text(runtime_mode_ok)])
        writer.writerow(["runtime_mode_status", runtime_mode_status])
        writer.writerow(["runtime_mode_status_ok", bool_text(runtime_mode_status_ok)])
        writer.writerow(["runtime_out_wav_path", str(out_wav)])
        writer.writerow(["runtime_out_wav_exists", bool_text(out_wav_exists)])
        writer.writerow(["runtime_out_wav_materialized", bool_text(out_wav_materialized)])
        writer.writerow(["runtime_out_wav_bytes", out_wav_bytes])
        writer.writerow(["runtime_out_wav_truth_ok", bool_text(runtime_out_wav_truth_ok)])
        writer.writerow(["runtime_event_count", emit["event_count"]])
        writer.writerow(["runtime_active_idx", emit["active_idx"]])
        writer.writerow(["runtime_first_emit_idx", emit["first_emit_idx"]])
        writer.writerow(["runtime_first_emit_type", emit["first_emit_type"]])
        writer.writerow(["runtime_first_emit_channel", emit["first_emit_channel"]])
        writer.writerow(["runtime_first_emit_segment_id", emit["first_emit_segment_id"]])
        writer.writerow(["runtime_first_emit_start_ms", emit["first_emit_start_ms"]])
        writer.writerow(["runtime_first_emit_during_active_ok", bool_text(emit["first_emit_during_active"])])
        writer.writerow(["runtime_jsonl_transcript_event_count", jsonl_transcript_event_count])
        writer.writerow(["runtime_jsonl_transcript_surface_ok", bool_text(jsonl_transcript_surface_ok)])
        writer.writerow(["runtime_manifest_transcript_surface_ok", bool_text(manifest_transcript_surface_ok)])
        writer.writerow(["runtime_transcript_surface_ok", bool_text(transcript_surface_ok)])
        writer.writerow(["runtime_terminal_live_mode_ok", bool_text(terminal_live_mode_ok)])
        writer.writerow(
            ["runtime_terminal_replay_suppressed_ok", bool_text(terminal_replay_suppressed_ok)]
        )
        writer.writerow(["runtime_trust_notice_count", trust_notice_count])
        writer.writerow(["runtime_trust_surface_ok", bool_text(trust_surface_ok)])
        writer.writerow(["runtime_degradation_surface_ok", bool_text(degradation_surface_ok)])
        writer.writerow(["runtime_manifest_jsonl_path", str(manifest_jsonl_path)])
        writer.writerow(["runtime_manifest_jsonl_match_ok", bool_text(manifest_jsonl_match_ok)])
        writer.writerow(["runtime_manifest_out_manifest_path", str(manifest_out_manifest_path)])
        writer.writerow(
            ["runtime_manifest_out_manifest_match_ok", bool_text(manifest_out_manifest_match_ok)]
        )
        writer.writerow(["runtime_artifact_root_ok", bool_text(artifact_root_ok)])
        writer.writerow(["runtime_error_line", runtime_error_line])
        writer.writerow(["runtime_helper_exec_blocked", bool_text(runtime_helper_exec_blocked)])
        writer.writerow(["gate_pass", bool_text(gate_pass)])

    print(args.summary_csv)


if __name__ == "__main__":
    main()
