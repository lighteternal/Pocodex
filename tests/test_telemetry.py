"""Merging apps into one snapshot, and finding them on this PC."""

import tempfile
import unittest
from pathlib import Path

from observatory.companion.detect import detect
from observatory.companion.telemetry import Telemetry


class Fake:
    def __init__(self, app, running=0, waiting=0, quota=(), attention=(), tokens=0, activity=None):
        self.app, self.attention, self.previews, self.last_event = app, list(attention), False, None
        self.base = {"running": running, "waiting": waiting, "uncertain": 0, "quota": list(quota), "tokens": tokens, "cached": 0,
                     "input": tokens, "output": 0, "usage": [], "sources": [{"path": app, "status": "ok"}],
                     "activity": activity or ("waiting" if waiting else "working" if running else "idle")}

    def poll(self, now):
        return []

    def snapshot(self, now):
        return {**self.base, "attention": self.attention}

    def acknowledge(self, ident):
        self.attention = [e for e in self.attention if e["id"] != ident]

    def set_previews(self, enabled):
        self.previews = enabled


class TelemetryContracts(unittest.TestCase):
    def test_apps_merge_into_the_existing_snapshot_shape(self):
        codex = Fake("codex", running=2, tokens=100, attention=[{"id": "a", "kind": "completed", "app": "codex", "at": 2}])
        claude = Fake("claude", waiting=1, tokens=50, quota=[{"app": "claude", "label": "5h", "remaining": 40, "stale": False}],
                      attention=[{"id": "b", "kind": "input_needed", "app": "claude", "at": 1}])
        snap = Telemetry({"codex": codex, "claude": claude}).snapshot(10)
        self.assertEqual((snap["running"], snap["waiting"], snap["activity"], snap["tokens"]), (2, 1, "waiting", 150))
        self.assertEqual([e["id"] for e in snap["attention"]], ["b", "a"])
        self.assertEqual(snap["apps"]["claude"]["quota"][0]["remaining"], 40)
        self.assertEqual([s["app"] for s in snap["sources"]], ["codex", "claude"])
        self.assertTrue(snap["apps"]["codex"]["connected"])

    def test_disconnected_apps_are_reported_not_invented(self):
        snap = Telemetry({"codex": Fake("codex")}).snapshot(10)
        self.assertEqual(snap["apps"]["claude"], {"connected": False})
        self.assertEqual(snap["activity"], "idle")

    def test_unknown_only_when_no_app_is_busy(self):
        snap = Telemetry({"codex": Fake("codex", activity="unknown"), "claude": Fake("claude")}).snapshot(10)
        self.assertEqual(snap["activity"], "unknown")

    def test_running_is_per_app_and_extra_alerts_can_be_dismissed(self):
        telemetry = Telemetry({"codex": Fake("codex", running=1), "claude": Fake("claude")})
        self.assertEqual(telemetry.running(10), {"codex": True, "claude": False})
        telemetry.add_attention([{"id": "break", "kind": "break_reminder", "at": 5}])
        self.assertEqual([e["id"] for e in telemetry.snapshot(10)["attention"]], ["break"])
        telemetry.acknowledge("break")
        self.assertEqual(telemetry.snapshot(10)["attention"], [])

    def test_previews_off_also_purges_engine_alerts(self):
        telemetry = Telemetry({"codex": Fake("codex")})
        telemetry.add_attention([{"id": "x", "kind": "break_reminder", "at": 1, "preview": "private"}])
        telemetry.set_previews(False)
        self.assertNotIn("preview", telemetry.snapshot(10)["attention"][0])


class DetectContracts(unittest.TestCase):
    def test_finds_each_app_from_its_own_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            env = {"APPDATA": str(root / "appdata"), "PATH": ""}
            (root / "codex" / "sessions").mkdir(parents=True)
            found = detect(root / "codex", root / "claude", env=env)
            self.assertEqual((found["codex"]["found"], found["claude"]["found"]), (True, False))
            bundled = root / "appdata" / "Claude" / "claude-code" / "2.1.0"
            bundled.mkdir(parents=True)
            (bundled / "claude.exe").write_bytes(b"")
            self.assertTrue(detect(root / "codex", root / "claude", env=env)["claude"]["found"])

    def test_config_folder_alone_counts_as_claude(self):
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / "claude").mkdir()
            found = detect(Path(temp) / "codex", Path(temp) / "claude", env={"APPDATA": temp, "PATH": ""})
            self.assertEqual((found["codex"]["found"], found["claude"]["found"]), (False, True))
            self.assertEqual(found["claude"]["path"], str(Path(temp) / "claude"))


if __name__ == "__main__":
    unittest.main()


class IsolatedDetectContracts(unittest.TestCase):
    def test_an_explicit_claude_folder_ignores_the_rest_of_the_machine(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bundled = root / "appdata" / "Claude" / "claude-code" / "2.1.0"
            bundled.mkdir(parents=True)
            (bundled / "claude.exe").write_bytes(b"")
            env = {"APPDATA": str(root / "appdata"), "PATH": ""}
            self.assertFalse(detect(root / "codex", root / "isolated", env=env, isolated=True)["claude"]["found"])
            self.assertTrue(detect(root / "codex", root / "isolated", env=env)["claude"]["found"])
