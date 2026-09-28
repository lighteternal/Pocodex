"""Validate recorded token counters and retain only a project's basename."""

from typing import Any


COUNTERS = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens")


def counter_values(raw: dict[str, Any]) -> list[int] | None:
    values = [raw.get(key, 0) for key in COUNTERS]
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in values):
        return None
    return values


def local_project(value: str) -> str:
    return value.replace("\\", "/").rstrip("/").split("/")[-1]
