#!/usr/bin/env python3
"""Summarize transcript completeness before/after reconciliation under backlog pressure."""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


TOKEN_PATTERN = re.compile(r"[a-z0-9']+")
STABLE_TRANSCRIPT_EVENT_TYPES = {"final", "llm_final", "reconciled_final"}
DROP_PATH_PROFILE = "drop-path"
BUFFERED_NO_DROP_PROFILE = "buffered-no-drop"
EPSILON = 1e-9


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-jsonl", required=True, type=Path)
    parser.add_argument("--backlog-summary-csv", required=False, type=Path)
    parser.add_argument("--pre-replay", required=True, type=Path)
    parser.add_argument("--post-replay", required=True, type=Path)
    parser.add_argument("--summary-csv", required=True, type=Path)
    parser.add_argument("--min-completeness-gain", required=True, type=float)
    parser.add_argument("--min-post-completeness", required=True, type=float)
    parser.add_argument("--max-pre-completeness", required=True, type=float)
    return parser.parse_args()


def normalize_tokens(text: str) -> set[str]:
    return set(TOKEN_PATTERN.findall(text.lower()))


def parse_jsonl(path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
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


def load_summary_csv(path: Path | None) -> dict[str, str]:
    if path is None or not path.is_file():
        return {}
    table: dict[str, str] = {}
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        _ = next(reader, None)
        for row in reader:
            if len(row) >= 2:
                table[row[0]] = row[1]
    return table


def parse_replay_channel_text(path: Path) -> dict[str, str]:
    channel_texts: dict[str, list[str]] = defaultdict(list)
    in_per_channel = False
    current_channel: str | None = None

    with path.open(encoding="utf-8") as handle:
        for raw in handle:
            line = raw.rstrip("\n")
            if line.strip() == "Readable transcript (per-channel defaults)":
                in_per_channel = True
                current_channel = None
                continue

            if not in_per_channel:
                continue

            channel_match = re.match(r"^\s*\[([^\]]+)\]\s*$", line)
            if channel_match:
                current_channel = channel_match.group(1).strip().lower()
                continue

            entry_match = re.match(r"^\s*\[[0-9:.]+-[0-9:.]+\]\s*(.+?)\s*$", line)
            if entry_match and current_channel:
                channel_texts[current_channel].append(entry_match.group(1).strip())

    return {channel: " ".join(parts) for channel, parts in channel_texts.items()}


def as_int(value: object) -> int:
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def main() -> None:
    args = parse_args()
    events = parse_jsonl(args.runtime_jsonl)
    backlog_summary = load_summary_csv(args.backlog_summary_csv)
    pre_channel_text = parse_replay_channel_text(args.pre_replay)
    post_channel_text = parse_replay_channel_text(args.post_replay)

    reconciled_by_channel: dict[str, list[str]] = defaultdict(list)
    stable_by_channel: dict[str, list[str]] = defaultdict(list)
    trust_codes: set[str] = set()
    degradation_codes: set[str] = set()
    chunk_queue_event_count = 0
    dropped_oldest = 0
    submitted = 0

    for event in events:
        event_type = event.get("event_type")
        channel = str(event.get("channel", "")).lower()
        if event_type in STABLE_TRANSCRIPT_EVENT_TYPES:
            text = str(event.get("text", "")).strip()
            if text:
                stable_by_channel[channel].append(text)
                if event_type == "reconciled_final":
                    reconciled_by_channel[channel].append(text)
        elif event_type == "trust_notice":
            trust_codes.add(str(event.get("code", "")))
        elif event_type == "mode_degradation":
            degradation_codes.add(str(event.get("code", "")))
        elif event_type == "chunk_queue":
            chunk_queue_event_count += 1
            dropped_oldest = as_int(event.get("dropped_oldest"))
            submitted = as_int(event.get("submitted"))

    pressure_profile = str(backlog_summary.get("pressure_profile", "")).strip()
    if not pressure_profile:
        pressure_profile = (
            DROP_PATH_PROFILE if dropped_oldest > 0 else BUFFERED_NO_DROP_PROFILE
        )
    pressure_profile_known = pressure_profile in {
        DROP_PATH_PROFILE,
        BUFFERED_NO_DROP_PROFILE,
    }

    if pressure_profile == DROP_PATH_PROFILE:
        canonical_by_channel = reconciled_by_channel
        canonical_source = "reconciled_final"
    elif pressure_profile == BUFFERED_NO_DROP_PROFILE:
        canonical_by_channel = stable_by_channel
        canonical_source = "stable_final"
    else:
        canonical_by_channel = {}
        canonical_source = "unknown"

    channels = sorted(canonical_by_channel.keys())
    pre_coverages: list[float] = []
    post_coverages: list[float] = []
    per_channel_rows: list[tuple[str, int, float, float]] = []

    for channel in channels:
        canonical_text = " ".join(canonical_by_channel[channel]).strip()
        canonical_tokens = normalize_tokens(canonical_text)
        canonical_count = len(canonical_tokens)

        if canonical_count == 0:
            pre_coverage = 0.0
            post_coverage = 0.0
        else:
            pre_tokens = normalize_tokens(pre_channel_text.get(channel, ""))
            post_tokens = normalize_tokens(post_channel_text.get(channel, ""))
            pre_coverage = len(pre_tokens & canonical_tokens) / canonical_count
            post_coverage = len(post_tokens & canonical_tokens) / canonical_count

        pre_coverages.append(pre_coverage)
        post_coverages.append(post_coverage)
        per_channel_rows.append((channel, canonical_count, pre_coverage, post_coverage))

    pre_completeness = sum(pre_coverages) / len(pre_coverages) if pre_coverages else 0.0
    post_completeness = sum(post_coverages) / len(post_coverages) if post_coverages else 0.0
    completeness_gain = post_completeness - pre_completeness

    if pressure_profile == DROP_PATH_PROFILE:
        threshold_reconciled_events_present_ok = len(reconciled_by_channel) > 0
        threshold_backpressure_drop_observed_ok = dropped_oldest > 0 and submitted > 0
        threshold_reconciliation_notice_ok = "reconciliation_applied" in trust_codes
        threshold_reconciliation_degradation_ok = (
            "reconciliation_applied_after_backpressure" in degradation_codes
        )
        threshold_completeness_gain_ok = (
            completeness_gain >= args.min_completeness_gain
        )
        threshold_post_completeness_ok = post_completeness >= args.min_post_completeness
        threshold_pre_degraded_ok = pre_completeness <= args.max_pre_completeness
    elif pressure_profile == BUFFERED_NO_DROP_PROFILE:
        threshold_reconciled_events_present_ok = True
        threshold_backpressure_drop_observed_ok = True
        threshold_reconciliation_notice_ok = len(trust_codes) == 0
        threshold_reconciliation_degradation_ok = len(degradation_codes) == 0
        threshold_completeness_gain_ok = completeness_gain >= -EPSILON
        threshold_post_completeness_ok = post_completeness >= args.min_post_completeness
        threshold_pre_degraded_ok = pre_completeness >= args.min_post_completeness
    else:
        threshold_reconciled_events_present_ok = False
        threshold_backpressure_drop_observed_ok = False
        threshold_reconciliation_notice_ok = False
        threshold_reconciliation_degradation_ok = False
        threshold_completeness_gain_ok = False
        threshold_post_completeness_ok = False
        threshold_pre_degraded_ok = False

    threshold_replay_sections_ok = bool(pre_channel_text) and bool(post_channel_text)
    threshold_chunk_queue_event_ok = chunk_queue_event_count > 0

    gate_pass = all(
        [
            threshold_reconciled_events_present_ok,
            threshold_backpressure_drop_observed_ok,
            threshold_reconciliation_notice_ok,
            threshold_reconciliation_degradation_ok,
            threshold_completeness_gain_ok,
            threshold_post_completeness_ok,
            threshold_pre_degraded_ok,
            threshold_replay_sections_ok,
            threshold_chunk_queue_event_ok,
            pressure_profile_known,
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
        writer.writerow(["artifact_track", "gate_transcript_completeness"])
        writer.writerow(["runtime_jsonl_path", str(args.runtime_jsonl)])
        writer.writerow(["backlog_summary_path", str(args.backlog_summary_csv or "")])
        writer.writerow(["pre_replay_path", str(args.pre_replay)])
        writer.writerow(["post_replay_path", str(args.post_replay)])
        writer.writerow(["pressure_profile", pressure_profile])
        writer.writerow(["canonical_source", canonical_source])
        writer.writerow(["channels", "|".join(channels)])
        writer.writerow(["submitted", submitted])
        writer.writerow(["dropped_oldest", dropped_oldest])
        writer.writerow(["chunk_queue_event_count", chunk_queue_event_count])
        writer.writerow(["pre_completeness", f"{pre_completeness:.6f}"])
        writer.writerow(["post_completeness", f"{post_completeness:.6f}"])
        writer.writerow(["completeness_gain", f"{completeness_gain:.6f}"])
        writer.writerow(["min_completeness_gain_target", args.min_completeness_gain])
        writer.writerow(["min_post_completeness_target", args.min_post_completeness])
        writer.writerow(["max_pre_completeness_target", args.max_pre_completeness])
        writer.writerow(["trust_codes", "|".join(sorted(trust_codes))])
        writer.writerow(["degradation_codes", "|".join(sorted(degradation_codes))])

        for channel, canonical_count, pre_coverage, post_coverage in per_channel_rows:
            writer.writerow([f"{channel}_canonical_token_count", canonical_count])
            writer.writerow([f"{channel}_pre_coverage", f"{pre_coverage:.6f}"])
            writer.writerow([f"{channel}_post_coverage", f"{post_coverage:.6f}"])

        writer.writerow(
            [
                "threshold_reconciled_events_present_ok",
                bool_text(threshold_reconciled_events_present_ok),
            ]
        )
        writer.writerow(
            [
                "threshold_backpressure_drop_observed_ok",
                bool_text(threshold_backpressure_drop_observed_ok),
            ]
        )
        writer.writerow(
            [
                "threshold_reconciliation_notice_ok",
                bool_text(threshold_reconciliation_notice_ok),
            ]
        )
        writer.writerow(
            [
                "threshold_reconciliation_degradation_ok",
                bool_text(threshold_reconciliation_degradation_ok),
            ]
        )
        writer.writerow(
            ["threshold_completeness_gain_ok", bool_text(threshold_completeness_gain_ok)]
        )
        writer.writerow(
            ["threshold_post_completeness_ok", bool_text(threshold_post_completeness_ok)]
        )
        writer.writerow(
            ["threshold_pre_degraded_ok", bool_text(threshold_pre_degraded_ok)]
        )
        writer.writerow(
            ["threshold_replay_sections_ok", bool_text(threshold_replay_sections_ok)]
        )
        writer.writerow(
            ["threshold_chunk_queue_event_ok", bool_text(threshold_chunk_queue_event_ok)]
        )
        writer.writerow(
            ["threshold_pressure_profile_known_ok", bool_text(pressure_profile_known)]
        )
        writer.writerow(["gate_pass", bool_text(gate_pass)])

    print(args.summary_csv)


if __name__ == "__main__":
    main()
