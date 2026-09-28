"""Per-app activity adapters. Each emits the shared event vocabulary tagged with its app."""

from observatory.companion.sources.codex import STALE_SECONDS, Sources, timestamp
from observatory.companion.sources.claude import ClaudeSource

__all__ = ["STALE_SECONDS", "ClaudeSource", "Sources", "timestamp"]
