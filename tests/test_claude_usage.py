"""Claude Code's /usage screen read in a background session, without spending a token."""

import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from observatory.companion import claude_usage

NOW = datetime(2026, 9, 28, 20, 57).timestamp()  # local time, like Claude Code's own screen
# The screen as `claude logs` returns it: colour codes, bars, and the heading row merged into the week line.
SCREEN = (
    "\x1b[38;2;153;153;153m   Session\n   Total cost:            $0.0000\n"
    "   Current session\n   \x1b[38;2;215;119;87m█████\x1b[m 42% used\n   Resets 9:10pm (Europe/Athens)\n"
    "   Current week (all models)\n   ███▍      57% used          Resets Sep 30, 10pm (Europe/Athens)\n"
    "   Current week (Fable)\n    0% used\n   Resets Sep 30, 10pm (Europe/Athens)\n"
    "   What's contributing to your limits usage?\n   35% of your usage came from sessions active for 8+ hours\n"
)


class Screen(unittest.TestCase):
    def test_both_windows_with_local_reset_times(self):
        limits = claude_usage.parse(SCREEN, NOW)
        self.assertEqual(limits["five_hour"], {"used_percentage": 42.0, "resets_at": datetime(2026, 9, 28, 21, 10).timestamp()})
        self.assertEqual(limits["seven_day"], {"used_percentage": 57.0, "resets_at": datetime(2026, 9, 30, 22, 0).timestamp()})

    def test_the_latest_drawing_wins_and_contributions_are_not_windows(self):
        limits = claude_usage.parse(SCREEN.replace("42% used", "40% used") + SCREEN, NOW)
        self.assertEqual(limits["five_hour"]["used_percentage"], 42.0)
        self.assertEqual(set(limits), {"five_hour", "seven_day"})

    def test_a_time_already_past_today_means_tomorrow(self):
        late = datetime(2026, 9, 28, 23, 30).timestamp()
        self.assertEqual(claude_usage.parse(SCREEN, late)["five_hour"]["resets_at"], datetime(2026, 9, 29, 21, 10).timestamp())

    def test_january_seen_in_december_is_next_year(self):
        december = datetime(2026, 12, 30, 12, 0).timestamp()
        screen = SCREEN.replace("Sep 30, 10pm", "Jan 2, 9am")
        self.assertEqual(claude_usage.parse(screen, december)["seven_day"]["resets_at"], datetime(2027, 1, 2, 9, 0).timestamp())

    def test_no_usage_screen_is_nothing(self):
        self.assertIsNone(claude_usage.parse("\x1b[K\n❯ \n", NOW))
        self.assertIsNone(claude_usage.parse("Current session\n  loading\n", NOW))


class Check(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workdir = Path(self.temp.name) / "check"
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def runner(self, screens, start="Starting background service…\nbackgrounded · b902db38\n", cleanup=0):
        screens = list(screens)
        def run(command, **options):
            self.calls.append((command[1:], options))
            if command[1] == "--bg":
                if isinstance(start, Exception):
                    raise start
                return SimpleNamespace(stdout=start, stderr="", returncode=0)
            if command[1] == "logs":
                return SimpleNamespace(stdout=screens.pop(0) if len(screens) > 1 else screens[0], stderr="", returncode=0)
            return SimpleNamespace(stdout="", stderr="", returncode=cleanup)
        return run

    def test_reads_the_screen_then_stops_and_removes_the_session(self):
        limits = claude_usage.check("claude", self.workdir, NOW, run=self.runner(["", SCREEN]), wait=lambda _: None)
        self.assertEqual(limits["five_hour"]["used_percentage"], 42.0)
        commands = [arguments for arguments, _ in self.calls]
        self.assertEqual(commands[0], ["--bg", "--model", claude_usage.MODEL_GUARD, "--settings", str(self.workdir / "check-settings.json"), "/usage"])
        self.assertEqual(json.loads((self.workdir / "check-settings.json").read_text()), {"disableAllHooks": True})
        self.assertEqual(commands[-2:], [["stop", "b902db38"], ["rm", "b902db38"]])
        options = self.calls[0][1]
        self.assertEqual(options["cwd"], str(self.workdir))
        self.assertIs(options["stdin"], subprocess.DEVNULL)  # never the sidecar's command pipe
        self.assertEqual(options["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))  # never flashes a console

    def test_a_screen_that_never_shows_usage_times_out_and_still_cleans_up(self):
        with self.assertRaisesRegex(claude_usage.UsageCheckError, "didn't show plan usage"):
            claude_usage.check("claude", self.workdir, NOW, run=self.runner(["❯ "]), wait=lambda _: None, patience=0)
        self.assertEqual([arguments for arguments, _ in self.calls][-2:], [["stop", "b902db38"], ["rm", "b902db38"]])

    def test_sign_in_and_trust_problems_are_explained(self):
        with self.assertRaisesRegex(claude_usage.UsageCheckError, "isn't signed in"):
            claude_usage.check("claude", self.workdir, NOW, run=self.runner(["Please run /login to continue"]), wait=lambda _: None)
        with self.assertRaisesRegex(claude_usage.UsageCheckError, "trust"):
            claude_usage.check("claude", self.workdir, NOW, run=self.runner(["Do you trust the files in this folder?"]), wait=lambda _: None)

    def test_no_background_session_is_an_error_without_cleanup_calls(self):
        with self.assertRaisesRegex(claude_usage.UsageCheckError, "didn't start"):
            claude_usage.check("claude", self.workdir, NOW, run=self.runner([SCREEN], start="error: unknown option"), wait=lambda _: None)
        self.assertEqual(len(self.calls), 1)

    def test_closing_pocodex_stops_waiting_and_still_cleans_up(self):
        with self.assertRaisesRegex(claude_usage.UsageCheckError, "closed"):
            claude_usage.check("claude", self.workdir, NOW, run=self.runner(["❯ "]), wait=lambda _: True)
        self.assertEqual([arguments for arguments, _ in self.calls][1:], [["logs", "b902db38"], ["stop", "b902db38"], ["rm", "b902db38"]])

    def test_a_start_that_times_out_after_backgrounding_is_still_followed_and_removed(self):
        hung = subprocess.TimeoutExpired(["claude"], 30, output=b"backgrounded \xc2\xb7 b902db38\n")
        limits = claude_usage.check("claude", self.workdir, NOW, run=self.runner([SCREEN], start=hung), wait=lambda _: None)
        self.assertEqual(limits["five_hour"]["used_percentage"], 42.0)
        self.assertEqual([arguments for arguments, _ in self.calls][-2:], [["stop", "b902db38"], ["rm", "b902db38"]])

    def test_a_session_without_a_readable_id_is_reported(self):
        for start in (subprocess.TimeoutExpired(["claude"], 30), "backgrounded session\n"):
            with self.assertRaisesRegex(claude_usage.UsageCheckError, "may be left running"):
                claude_usage.check("claude", self.workdir, NOW, run=self.runner([SCREEN], start=start), wait=lambda _: None)

    def test_failed_cleanup_is_a_diagnostic_not_a_failed_check(self):
        with redirect_stderr(io.StringIO()) as errors:
            limits = claude_usage.check("claude", self.workdir, NOW, run=self.runner([SCREEN], cleanup=1), wait=lambda _: None)
        self.assertEqual(limits["five_hour"]["used_percentage"], 42.0)
        self.assertIn("claude rm b902db38 failed (1)", errors.getvalue())

    def test_a_missing_cli_is_an_error(self):
        def run(command, **options):
            raise FileNotFoundError(command[0])
        with self.assertRaisesRegex(claude_usage.UsageCheckError, "Couldn't start Claude Code"):
            claude_usage.check("missing.exe", self.workdir, NOW, run=run)


if __name__ == "__main__":
    unittest.main()
