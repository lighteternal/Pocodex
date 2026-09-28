"""Private stdio service smoke checks in an isolated profile."""

import importlib.util
import json
import subprocess
import sys
import time
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from test_companion import CATALOG


class ServiceContracts(unittest.TestCase):
    def test_discovery_uses_stable_home_environment_and_saved_roots(self):
        from observatory.companion.service import source_roots
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp)
            custom = profile / 'custom-home'
            saved = profile / 'other-home'
            (profile / 'sources.json').write_text(json.dumps([str(saved), str(custom)]))
            with patch.dict('os.environ', {'CODEX_HOME': str(custom)}):
                self.assertEqual(source_roots(profile), [custom, saved])
                self.assertEqual(source_roots(profile, [saved]), [saved])
            with patch.dict('os.environ', {'CODEX_HOME': ''}):
                self.assertEqual(source_roots(profile)[0], Path.home() / '.codex')

    def test_idle_service_does_not_stream_unchanged_collection_twice_per_second(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'assets').mkdir()
            (root / 'assets/catalog.json').write_text(json.dumps(CATALOG), encoding='utf-8')
            process = subprocess.Popen([sys.executable, '-m', 'observatory.companion.service', '--data', str(root / 'save'), '--assets', str(root / 'assets'), '--source', str(root / 'missing')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                json.loads(process.stdout.readline())
                time.sleep(2.2)
                output, errors = process.communicate('{"action":"quit"}\n', timeout=10)
                self.assertEqual(process.returncode, 0, errors)
                self.assertLessEqual(len(output.splitlines()), 1)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_stdio_commands_persist_preferences_and_reject_unknown_actions(self):
        self.assertIsNotNone(importlib.util.find_spec("observatory.companion.service"), "Companion service not implemented")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "assets").mkdir()
            (root / "assets" / "catalog.json").write_text(json.dumps(CATALOG), encoding="utf-8")
            commands = '\n'.join(json.dumps(v) for v in [
                {"id": 1, "action": "settings", "args": {"sound": False}},
                {"id": 2, "action": "not-allowed", "args": {}},
                {"id": 3, "action": "quit", "args": {}},
            ]) + '\n'
            process = subprocess.run([sys.executable, "-m", "observatory.companion.service", "--data", str(root / "save"), "--assets", str(root / "assets"), "--source", str(root / "missing")], input=commands, capture_output=True, text=True, timeout=15)
            self.assertEqual(process.returncode, 0, process.stderr)
            messages = [json.loads(line) for line in process.stdout.splitlines()]
            response = next(m for m in messages if m.get("id") == 1)
            self.assertFalse(response["state"]["settings"]["sound"])
            self.assertIn("Unknown", next(m for m in messages if m.get("id") == 2)["error"])
            self.assertTrue((root / "save" / "companion.sqlite").exists())

    def test_connect_claude_edits_only_the_isolated_config_and_disconnect_restores_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "assets").mkdir()
            (root / "assets/catalog.json").write_text(json.dumps(CATALOG), encoding="utf-8")
            claude = root / "claude"
            claude.mkdir()
            (claude / "settings.json").write_text('{"theme": "dark"}')
            hook = json.dumps([sys.executable, "-m", "observatory.companion.hook"])
            commands = "\n".join(json.dumps(v) for v in [
                {"id": 1, "action": "settings", "args": {"claude": True}},
                {"id": 2, "action": "connect", "args": {"app": "claude", "enabled": True}},
                {"id": 3, "action": "connect", "args": {"app": "claude", "enabled": False}},
                {"id": 4, "action": "connect", "args": {"app": "codex", "enabled": False}},
                {"id": 5, "action": "quit", "args": {}}]) + "\n"
            process = subprocess.run([sys.executable, "-m", "observatory.companion.service", "--data", str(root / "save"),
                                      "--assets", str(root / "assets"), "--source", str(root / "missing"),
                                      "--claude-config", str(claude), "--hook-command", hook],
                                     input=commands, capture_output=True, text=True, timeout=20)
            self.assertEqual(process.returncode, 0, process.stderr)
            messages = {m.get("id"): m for m in map(json.loads, process.stdout.splitlines())}
            self.assertIn("connect", messages[1]["error"])
            first = json.loads(process.stdout.splitlines()[0])["state"]["connections"]
            self.assertEqual((first["codex"]["enabled"], first["claude"]["enabled"], first["claude"]["found"]), (True, False, True))
            connected = messages[2]["state"]["connections"]["claude"]
            self.assertTrue(connected["enabled"] and connected["current"])
            self.assertTrue(messages[2]["state"]["telemetry"]["apps"]["claude"]["connected"])
            self.assertFalse(messages[3]["state"]["connections"]["claude"]["enabled"])
            self.assertFalse(messages[4]["state"]["telemetry"]["apps"]["codex"]["connected"])
            self.assertEqual(json.loads((claude / "settings.json").read_text()), {"theme": "dark"})
            self.assertEqual(json.loads((root / "save" / "buddy-status.json").read_text()), {"name": "Egg", "level": None})


if __name__ == "__main__":
    unittest.main()
