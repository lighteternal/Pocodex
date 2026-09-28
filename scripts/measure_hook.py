"""Fail the build if the Claude hook binary starts too slowly to run on every Claude Code hook."""

import json
import statistics
import subprocess
import sys
import tempfile
import time

BUDGET_MS = 300


def main() -> None:
    command = sys.argv[1:]
    payload = json.dumps({"hook_event_name": "Stop", "session_id": "timing"})
    samples = []
    with tempfile.TemporaryDirectory() as profile:
        for _ in range(8):
            start = time.perf_counter()
            subprocess.run([*command, "claude-event", "--profile", profile, "--pocodex"], input=payload, text=True,
                           check=True, timeout=10, capture_output=True)
            samples.append((time.perf_counter() - start) * 1000)
    median = statistics.median(samples[1:])  # The first run pays the cold file cache.
    print(json.dumps({"hook_start_ms_median": round(median), "hook_start_ms_max": round(max(samples[1:])), "budget_ms": BUDGET_MS}))
    if median > BUDGET_MS:
        raise SystemExit(f"Hook median start {median:.0f} ms exceeds the {BUDGET_MS} ms budget")


if __name__ == "__main__":
    main()
