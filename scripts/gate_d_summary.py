#!/usr/bin/env python3
"""Summarize Gate D soak runs into a key/value CSV artifact."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs-csv", required=True, type=Path)
    parser.add_argument("--summary-csv", required=True, type=Path)
    parser.add_argument("--target-seconds", required=True, type=int)
    return parser.parse_args()


def as_float(value: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def as_int(value: str) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * pct
    lo = int(position)
    hi = min(lo + 1, len(ordered) - 1)
    if lo == hi:
        return ordered[lo]
    return ordered[lo] * (hi - position) + ordered[hi] * (position - lo)


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def main() -> None:
    args = parse_args()
    rows: list[dict[str, str]] = []
    with args.runs_csv.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            rows.append(row)
    if not rows:
        raise SystemExit(f"no rows found in {args.runs_csv}")

    real_ms = [as_float(r["real_ms"]) for r in rows]
    rss_kb = [as_float(r["max_rss_kb"]) for r in rows]
    wall_ms_p95 = [as_float(r["wall_ms_p95"]) for r in rows]

    run_count = len(rows)
    failure_count = sum(1 for r in rows if as_int(r["exit_code"]) != 0)
    success_count = run_count - failure_count

    total_cleanup_dropped = sum(as_int(r["cleanup_dropped_queue_full"]) for r in rows)
    total_cleanup_failed = sum(as_int(r["cleanup_failed"]) for r in rows)
    total_cleanup_timed_out = sum(as_int(r["cleanup_timed_out"]) for r in rows)
    total_degradation_events = sum(as_int(r["degradation_events"]) for r in rows)

    soak_start = parse_utc(rows[0]["start_utc"])
    soak_end = parse_utc(rows[-1]["end_utc"])
    # CSV timestamps are second-granularity and both endpoints are inclusive.
    soak_seconds_actual = max(0, int((soak_end - soak_start).total_seconds()) + 1)

    max_rss_kb_p50 = percentile(rss_kb, 0.50)
    max_rss_kb_p95 = percentile(rss_kb, 0.95)
    manifest_wall_ms_p95_p50 = percentile(wall_ms_p95, 0.50)
    manifest_wall_ms_p95_p95 = percentile(wall_ms_p95, 0.95)

    threshold_soak_duration_ok = soak_seconds_actual >= args.target_seconds
    threshold_harness_reliability_ok = failure_count == 0
    threshold_latency_drift_ok = (
        manifest_wall_ms_p95_p50 > 0
        and manifest_wall_ms_p95_p95 <= 1.25 * manifest_wall_ms_p95_p50
    )
    threshold_memory_growth_ok = (
        max_rss_kb_p50 > 0 and max_rss_kb_p95 <= 1.30 * max_rss_kb_p50
    )

    gate_pass = all(
        [
            threshold_soak_duration_ok,
            threshold_harness_reliability_ok,
            threshold_latency_drift_ok,
            threshold_memory_growth_ok,
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
        writer.writerow(["artifact_track", "gate_d"])
        writer.writerow(["run_count", run_count])
        writer.writerow(["success_count", success_count])
        writer.writerow(["failure_count", failure_count])
        writer.writerow(["soak_seconds_target", args.target_seconds])
        writer.writerow(["soak_seconds_actual", soak_seconds_actual])
        writer.writerow(["real_ms_p50", percentile(real_ms, 0.50)])
        writer.writerow(["real_ms_p95", percentile(real_ms, 0.95)])
        writer.writerow(["max_rss_kb_p50", max_rss_kb_p50])
        writer.writerow(["max_rss_kb_p95", max_rss_kb_p95])
        writer.writerow(["manifest_wall_ms_p95_p50", manifest_wall_ms_p95_p50])
        writer.writerow(["manifest_wall_ms_p95_p95", manifest_wall_ms_p95_p95])
        writer.writerow(["total_cleanup_dropped", total_cleanup_dropped])
        writer.writerow(["total_cleanup_failed", total_cleanup_failed])
        writer.writerow(["total_cleanup_timed_out", total_cleanup_timed_out])
        writer.writerow(["total_degradation_events", total_degradation_events])
        writer.writerow(
            ["threshold_soak_duration_ok", str(threshold_soak_duration_ok).lower()]
        )
        writer.writerow(
            [
                "threshold_harness_reliability_ok",
                str(threshold_harness_reliability_ok).lower(),
            ]
        )
        writer.writerow(
            ["threshold_latency_drift_ok", str(threshold_latency_drift_ok).lower()]
        )
        writer.writerow(
            ["threshold_memory_growth_ok", str(threshold_memory_growth_ok).lower()]
        )
        writer.writerow(["gate_pass", str(gate_pass).lower()])

    print(args.summary_csv)


if __name__ == "__main__":
    main()
