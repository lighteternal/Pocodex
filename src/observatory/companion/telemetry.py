"""Merge per-app adapters into the one snapshot every Pocodex window reads."""

import sys
import traceback

APPS = ("codex", "claude")


class Telemetry:
    def __init__(self, adapters: dict):
        self.adapters = adapters
        self.extra: list[dict] = []  # Engine-born alerts: break reminders.

    def poll(self, now: float) -> list[dict]:
        events = []
        for adapter in list(self.adapters.values()):
            try:
                events.extend(adapter.poll(now))
            except Exception:  # One unreadable app must not stop the companion or the other app.
                traceback.print_exc(file=sys.stderr)
        return events

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
