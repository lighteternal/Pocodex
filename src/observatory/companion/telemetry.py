"""Merge per-app adapters into the one snapshot every Pocodex window reads."""

from collections import deque
from datetime import datetime

APPS = ("codex", "claude")
COUNTERS = ("input", "cached", "output", "total")


def _day(at: float) -> str:
    return datetime.fromtimestamp(at).date().isoformat()


class Ledger:
    """Token totals per local day and the latest responses, never a lifetime of records."""

    def __init__(self):
        self.days: dict[str, dict] = {}
        self.seen: dict[str, str] = {}
        self.recent: deque[dict] = deque(maxlen=200)
        self.today = ""

    def add(self, ident: str, entry: dict) -> None:
        day = _day(entry["at"])
        if ident in self.seen or day < self.today:
            return
        self.seen[ident] = day
        totals = self.days.setdefault(day, dict.fromkeys(COUNTERS, 0))
        for key in COUNTERS:
            totals[key] += entry[key]
        self.recent.append(entry)

    def snapshot(self, now: float) -> dict:
        day = _day(now)
        if day != self.today:
            self.today = day
            self.days = {d: t for d, t in self.days.items() if d >= day}
            self.seen = {i: d for i, d in self.seen.items() if d >= day}
        totals = self.days.get(day, dict.fromkeys(COUNTERS, 0))
        return {"tokens": totals["total"], "cached": totals["cached"], "input": totals["input"], "output": totals["output"],
                "usage": [u for u in self.recent if _day(u["at"]) == day]}


class Telemetry:
    def __init__(self, adapters: dict):
        self.adapters = adapters
        self.extra: list[dict] = []  # Engine-born alerts: break reminders.

    def poll(self, now: float) -> list[dict]:
        return [event for adapter in list(self.adapters.values()) for event in adapter.poll(now)]

    def running(self, now: float) -> dict[str, bool]:
        return {app: adapter.snapshot(now)["running"] > 0 for app, adapter in self.adapters.items()}

    def add_attention(self, events: list[dict]) -> None:
        self.extra = (self.extra + events)[-100:]

    def acknowledge(self, ident: str) -> None:
        for adapter in self.adapters.values():
            adapter.acknowledge(ident)
        self.extra = [e for e in self.extra if e["id"] != ident]

    def set_previews(self, enabled: bool) -> None:
        for adapter in self.adapters.values():
            adapter.set_previews(enabled)
        if not enabled:
            for event in self.extra:
                event.pop("preview", None)
                event.pop("questions", None)

    def snapshot(self, now: float) -> dict:
        parts = {app: adapter.snapshot(now) for app, adapter in self.adapters.items()}
        values = list(parts.values())

        def total(key: str) -> int:
            return sum(part[key] for part in values)

        waiting, running = total("waiting"), total("running")
        activity = ("waiting" if waiting else "working" if running
                    else "unknown" if any(part["activity"] == "unknown" for part in values) else "idle")
        apps = {app: {"connected": False} for app in APPS}
        for app, part in parts.items():
            apps[app] = {"connected": True, "activity": part["activity"], "running": part["running"], "waiting": part["waiting"],
                         "tokens": part["tokens"], "input": part["input"], "output": part["output"], "cached": part["cached"],
                         "quota": part["quota"], "last_event": getattr(self.adapters[app], "last_event", None),
                         "sources": part["sources"]}
        return {"running": running, "waiting": waiting, "uncertain": total("uncertain"), "activity": activity,
                "quota": sorted((q for part in values for q in part["quota"]), key=lambda q: (q["stale"], q["remaining"])),
                "tokens": total("tokens"), "cached": total("cached"), "input": total("input"), "output": total("output"),
                "usage": sorted((u for part in values for u in part["usage"]), key=lambda u: u["at"])[-200:],
                "attention": sorted([e for part in values for e in part["attention"]] + self.extra, key=lambda e: e["at"])[-100:],
                "sources": [{**source, "app": app} for app, part in parts.items() for source in part["sources"]],
                "coverage": "Since companion launch; local records only", "apps": apps,
                "capabilities": {"completion": True, "input_requests": True, "native_approvals": "claude" in parts}}
