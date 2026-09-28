"""Editing Claude Code's settings.json: only Pocodex's entries, always reversible."""

import json
import tempfile
import unittest
from pathlib import Path

from observatory.companion import claude_settings as cs

EXE = r"C:\Programs\pocodex\resources\runtime\pocodex-hook\pocodex-hook.exe"


class SettingsContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.config, self.profile = root / "claude", root / "profile"
        self.config.mkdir()
        self.profile.mkdir()
        self.file = self.config / "settings.json"

    def tearDown(self):
        self.temp.cleanup()

    def settings(self):
        return json.loads(self.file.read_text(encoding="utf-8"))

    def ours(self, data):
        return [h for groups in data.get("hooks", {}).values() for g in groups for h in g["hooks"] if cs.MARK in h.get("args", [])]

    def test_connect_adds_marked_async_exec_hooks_and_keeps_user_content(self):
        self.file.write_text(json.dumps({"theme": "dark", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "mine.exe"}]}]}}))
        result = cs.connect(self.config, [EXE], self.profile)
        data = self.settings()
        self.assertEqual(data["theme"], "dark")
        self.assertEqual(data["hooks"]["Stop"][0]["hooks"][0]["command"], "mine.exe")
        ours = self.ours(data)
        self.assertEqual(len(ours), len(cs.HOOKS))
        self.assertTrue(all(h["async"] and h["command"] == EXE and h["args"][0] == "claude-event" and h["timeout"] == 10 for h in ours))
        self.assertEqual({g.get("matcher") for g in data["hooks"]["PreToolUse"]}, {"AskUserQuestion"})
        self.assertTrue(result["connected"] and result["current"])
        self.assertTrue((self.config / "settings.json.pocodex-backup").exists())

    def test_connect_twice_is_idempotent_and_disconnect_restores_exactly(self):
        original = {"statusLine": {"type": "command", "command": "~/.claude/line.sh", "padding": 1}, "model": "opus"}
        self.file.write_text(json.dumps(original))
        cs.connect(self.config, [EXE], self.profile)
        once = self.settings()
        cs.connect(self.config, [EXE], self.profile)
        self.assertEqual(self.settings(), once)
        self.assertIn(cs.MARK, once["statusLine"]["command"])
        self.assertEqual(once["statusLine"]["padding"], 1)
        cs.disconnect(self.config, self.profile)
        self.assertEqual(self.settings(), original)

    def test_status_line_is_a_plain_command_both_windows_shells_run(self):
        cs.connect(self.config, [EXE], self.profile)
        line = self.settings()["statusLine"]["command"]
        self.assertNotIn("\\", line)
        self.assertNotIn('"', line)
        self.assertTrue(line.startswith("C:/Programs/pocodex/") and "claude-statusline" in line)

    def test_missing_settings_file_is_created_and_removed_cleanly(self):
        cs.connect(self.config, [EXE], self.profile)
        cs.disconnect(self.config, self.profile)
        self.assertEqual(self.settings(), {})

    def test_unreadable_settings_are_never_touched(self):
        self.file.write_text("{ // comments are not JSON\n}")
        with self.assertRaises(cs.SettingsUnreadable):
            cs.connect(self.config, [EXE], self.profile)
        self.assertEqual(self.file.read_text(), "{ // comments are not JSON\n}")
        self.assertFalse(cs.status(self.config, [EXE], self.profile)["readable"])
        self.assertIn(cs.MARK, cs.snippet([EXE], self.profile))

    def test_unexpected_hooks_shape_is_left_alone(self):
        self.file.write_text('{"hooks": []}')
        with self.assertRaises(cs.SettingsUnreadable):
            cs.connect(self.config, [EXE], self.profile)
        self.assertEqual(self.file.read_text(), '{"hooks": []}')

    def test_moved_install_is_reported_stale_then_self_heals(self):
        cs.connect(self.config, [EXE], self.profile)
        moved = EXE.replace("Programs", "Apps")
        self.assertFalse(cs.status(self.config, [moved], self.profile)["current"])
        cs.connect(self.config, [moved], self.profile)
        self.assertEqual({h["command"] for h in self.ours(self.settings())}, {moved})
        self.assertTrue(cs.status(self.config, [moved], self.profile)["current"])

    def test_path_with_unshortenable_spaces_skips_only_the_status_line(self):
        spaced = r"C:\No Such Folder\pocodex-hook.exe"
        result = cs.connect(self.config, [spaced], self.profile)
        self.assertTrue(result["connected"] and result["current"])
        self.assertFalse(result["status_line"])
        self.assertNotIn("statusLine", self.settings())

    def test_saved_connection_can_be_removed_by_the_uninstaller(self):
        self.file.write_text('{"model": "opus"}')
        cs.connect(self.config, [EXE], self.profile)
        cs.disconnect_saved(self.profile)
        self.assertEqual(self.settings(), {"model": "opus"})
        cs.disconnect_saved(self.profile)  # second run is harmless
        self.assertEqual(self.settings(), {"model": "opus"})


if __name__ == "__main__":
    unittest.main()
