"""Private stdio service smoke checks in an isolated profile."""

import importlib.util
import json
import queue
import subprocess
import sys
import threading
import time
import tempfile
import unittest
from datetime import date, datetime, timedelta
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

    def test_settings_after_a_failed_command_reach_every_consumer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "assets").mkdir()
            (root / "assets/catalog.json").write_text(json.dumps(CATALOG), encoding="utf-8")
            (root / "claude").mkdir()
            hook = json.dumps([sys.executable, "-m", "observatory.companion.hook"])
            process = subprocess.Popen([sys.executable, "-m", "observatory.companion.service", "--data", str(root / "save"),
                                        "--assets", str(root / "assets"), "--source", str(root / "missing"),
                                        "--claude-config", str(root / "claude"), "--hook-command", hook],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            lines: queue.Queue = queue.Queue()
            threading.Thread(target=lambda: [lines.put(json.loads(line)) for line in process.stdout], daemon=True).start()

            def until(test):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    try:
                        message = lines.get(timeout=0.5)
                    except queue.Empty:
                        continue
                    if test(message):
                        return message
                self.fail("the service never sent the expected message")

            def request(ident, action, args=None):
                process.stdin.write(json.dumps({"id": ident, "action": action, "args": args or {}}) + "\n")
                process.stdin.flush()
                return until(lambda m: m.get("id") == ident)

            try:
                until(lambda m: m.get("type") == "state")
                self.assertIn("Hatch", request(1, "pet")["error"])  # rolls the engine back to a copy
                request(2, "settings", {"message_previews": False, "claude_usage_check": True})
                self.assertEqual(json.loads((root / "save/claude-hook.json").read_text()), {"previews": False})
                state = request(3, "connect", {"app": "claude", "enabled": True})["state"]
                self.assertTrue(state["connections"]["claude"]["usage_check"]["enabled"])
                # The claude and usage-check gates see the new settings: the check runs (and finds no CLI here).
                until(lambda m: "installed" in str(m.get("state", {}).get("connections", {}).get("claude", {}).get("usage_check", {}).get("problem")))
                transcript = root / "t.jsonl"
                transcript.write_text(json.dumps({"type": "assistant", "timestamp": "2026-09-28T10:00:05Z", "message": {
                    "id": "m1", "role": "assistant", "stop_reason": "end_turn", "content": [{"type": "text", "text": "SECRET answer"}],
                    "usage": {"input_tokens": 1, "output_tokens": 1}}}) + "\n")
                at = time.time() + 1
                with (root / "save/claude-inbox.jsonl").open("a") as inbox:
                    for offset, event in enumerate(("UserPromptSubmit", "Stop")):
                        inbox.write(json.dumps({"at": at + offset, "event": event, "session": "s1", "project": "demo", "transcript": str(transcript)}) + "\n")
                done = until(lambda m: any(e["kind"] == "completed" for e in m.get("events", [])))
                self.assertNotIn("SECRET", json.dumps(done["events"]))
                process.stdin.write('{"action":"quit"}\n')
                process.stdin.flush()
                self.assertEqual(process.wait(timeout=10), 0, process.stderr.read())
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate()

    def test_battles_come_back_at_local_midnight_without_a_save(self):
        from observatory.companion.engine import BATTLES_PER_DAY, Companion
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "assets").mkdir()
            (root / "assets/catalog.json").write_text(json.dumps(CATALOG), encoding="utf-8")
            midnight = datetime.combine(date.today() + timedelta(days=1), datetime.min.time()).timestamp()
            engine = Companion(root / "save/companion.sqlite", CATALOG, time.time())
            engine.state["battles"] = {date.today().isoformat(): BATTLES_PER_DAY}
            engine._save()
            engine.close()
            # The service's clock starts two seconds before tonight's midnight.
            clock = f"import time; real = time.time; time.time = lambda: real() + {midnight - 2 - time.time()}; from observatory.companion import service; service.main()"
            process = subprocess.Popen([sys.executable, "-c", clock, "--data", str(root / "save"), "--assets", str(root / "assets"), "--source", str(root / "missing")],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(json.loads(process.stdout.readline())["state"]["battles_left"], 0)
                time.sleep(2.5)
                output, errors = process.communicate('{"id": 1, "action": "snapshot"}\n{"action": "quit"}\n', timeout=10)
                self.assertEqual(process.returncode, 0, errors)
                response = next(m for m in map(json.loads, output.splitlines()) if m.get("id") == 1)
                self.assertEqual(response["state"]["battles_left"], BATTLES_PER_DAY)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    @unittest.skipIf(sys.platform == "win32", "the stand-in CLI is a POSIX script")
    def test_quitting_mid_usage_check_still_removes_the_background_session(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "assets").mkdir()
            (root / "assets/catalog.json").write_text(json.dumps(CATALOG), encoding="utf-8")
            (root / "claude").mkdir()
            cli = root / "claude-cli"  # backgrounds a session whose screen never shows usage
            cli.write_text(f"#!{sys.executable}\nimport json, sys\nopen('calls.jsonl', 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
                           "if sys.argv[1] == '--bg':\n    print('backgrounded - f00dcafe')\n")
            cli.chmod(0o755)
            hook = json.dumps([sys.executable, "-m", "observatory.companion.hook"])
            process = subprocess.Popen([sys.executable, "-m", "observatory.companion.service", "--data", str(root / "save"),
                                        "--assets", str(root / "assets"), "--source", str(root / "missing"), "--claude-config", str(root / "claude"),
                                        "--hook-command", hook, "--claude-cli", str(cli)],
                                       stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            calls = root / "save/claude-usage-check/calls.jsonl"
            try:
                process.stdin.write('{"id": 1, "action": "connect", "args": {"app": "claude", "enabled": true}}\n'
                                    '{"id": 2, "action": "settings", "args": {"claude_usage_check": true}}\n')
                process.stdin.flush()
                deadline = time.monotonic() + 15
                while '"logs"' not in (calls.read_text() if calls.exists() else "") and time.monotonic() < deadline:
                    time.sleep(0.1)
                _, errors = process.communicate('{"action": "quit"}\n', timeout=20)
                self.assertEqual(process.returncode, 0, errors)
                self.assertEqual([json.loads(line) for line in calls.read_text().splitlines()][-2:], [["stop", "f00dcafe"], ["rm", "f00dcafe"]])
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()


if __name__ == "__main__":
    unittest.main()
