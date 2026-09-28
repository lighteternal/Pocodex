"""Startup registration and launch policy, using an isolated Windows user entry."""

import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


@unittest.skipUnless(sys.platform == "win32", "Windows startup integration")
class StartupContracts(unittest.TestCase):
    def test_cli_processes_are_not_mistaken_for_the_desktop(self):
        from observatory.companion.startup import is_codex_desktop
        self.assertTrue(is_codex_desktop(r"C:\Program Files\WindowsApps\OpenAI.Codex_26.924_x64__test\app\ChatGPT.exe"))
        self.assertTrue(is_codex_desktop(r"C:\Program Files\WindowsApps\OpenAI.Codex_99.999.12345.0_x64__test\app\Codex.exe"))
        self.assertFalse(is_codex_desktop(r"C:\Users\Someone\AppData\Local\OpenAI\Codex\bin\hash\codex.exe"))
        self.assertFalse(is_codex_desktop(r"C:\Games\ChatGPT.exe"))

    def test_only_a_new_desktop_session_launches_and_quit_does_not_respawn(self):
        from observatory.companion.startup import LaunchGate
        gate = LaunchGate()
        self.assertFalse(gate.observe(set()))
        self.assertTrue(gate.observe({10, 11}))
        self.assertFalse(gate.observe({10, 11}))
        self.assertFalse(gate.observe({10, 12}))
        self.assertFalse(gate.observe(set()))
        self.assertTrue(gate.observe({20}))
        gate = LaunchGate({20})
        self.assertFalse(gate.observe({20}))
        self.assertTrue(gate.observe({30}))

    def test_registration_round_trip_and_disable_only_remove_own_entry(self):
        import winreg
        from observatory.companion.startup import configure, registration_name, startup_status, RUN_KEY
        with tempfile.TemporaryDirectory(prefix="pocodex-startup-test-") as folder:
            profile = Path(folder)
            watcher = [sys.executable, "-m", "observatory.companion.startup", "--watch"]
            launch = [sys.executable, "-c", "pass"]
            try:
                configure(profile, True, launch, watcher)
                self.assertTrue(startup_status(profile)["enabled"])
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                    value, _ = winreg.QueryValueEx(key, registration_name(profile))
                self.assertEqual(value, subprocess.list2cmdline([*watcher, "--profile", str(profile)]))
                self.assertEqual(json.loads((profile / "startup.json").read_text())["launch"], launch)
                configure(profile, False)
                self.assertFalse(startup_status(profile)["enabled"])
            finally:
                configure(profile, False)

    def test_watcher_exits_when_paused_without_starting_an_app(self):
        with tempfile.TemporaryDirectory(prefix="pocodex-watch-test-") as folder:
            profile = Path(folder)
            (profile / "startup-paused").touch()
            result = subprocess.run([sys.executable, "-m", "observatory.companion.startup", "--watch", "--profile", folder], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_real_watcher_launches_once_resumes_after_pause_and_quits(self):
        from observatory.companion.startup import configure, desktop_processes
        if not desktop_processes():
            self.skipTest("Live Windows Codex desktop required for launch integration")
        with tempfile.TemporaryDirectory(prefix="pocodex-watch-live-test-") as folder:
            profile = Path(folder)
            result_file = profile / "launched.txt"
            watcher = [sys.executable, "-m", "observatory.companion.startup", "--watch", "--resume"]
            launch = [sys.executable, "-c", "from pathlib import Path; import sys; p=Path(sys.argv[1]); p.write_text(p.read_text()+'x' if p.exists() else 'x')", str(result_file)]
            worker = None
            try:
                configure(profile, True, launch, watcher)
                for expected in ("x", "xx"):
                    (profile / "startup-paused").touch()
                    worker = subprocess.Popen([*watcher, "--profile", folder], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline and (not result_file.exists() or result_file.read_text() != expected):
                        time.sleep(0.1)
                    self.assertEqual(result_file.read_text(), expected)
                    time.sleep(2.2)
                    self.assertEqual(result_file.read_text(), expected, "Watcher must not relaunch on every poll")
                    (profile / "startup-paused").touch()
                    self.assertEqual(worker.wait(timeout=6), 0)
                    worker.communicate()
                    worker = None
            finally:
                (profile / "startup-paused").touch()
                if worker:
                    worker.wait(timeout=6)
                    worker.communicate()
                configure(profile, False)
