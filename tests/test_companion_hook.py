"""Hook entry point: what Claude Code hands us, what we keep, and what we never keep."""

import io
import json
import tempfile
import unittest
from pathlib import Path

from observatory.companion import hook


def run(mode, payload, profile):
    out = io.StringIO()
    hook.main([mode, "--profile", str(profile), "--pocodex"], stdin=io.StringIO(json.dumps(payload)), stdout=out)
    return out.getvalue()


class HookContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.profile = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def lines(self):
        return [json.loads(line) for line in (self.profile / "claude-inbox.jsonl").read_text(encoding="utf-8").splitlines()]

    def test_prompt_text_is_never_written(self):
        run("claude-event", {"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": "C:\\work\\demo",
                             "prompt": "SECRET plan", "transcript_path": "C:/t.jsonl"}, self.profile)
        line = self.lines()[0]
        self.assertEqual((line["event"], line["session"], line["project"], line["transcript"]), ("UserPromptSubmit", "s1", "demo", "C:/t.jsonl"))
        self.assertNotIn("SECRET", json.dumps(line))

    def test_questions_are_kept_only_when_previews_are_on(self):
        ask = {"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "AskUserQuestion",
               "tool_input": {"questions": [{"question": "Single or dual types?", "options": [{"label": "Single"}, {"label": "Dual"}]}]}}
        run("claude-event", ask, self.profile)
        (self.profile / "claude-hook.json").write_text('{"previews": true}')
        run("claude-event", ask, self.profile)
        first, second = self.lines()
        self.assertNotIn("questions", first)
        self.assertEqual(second["questions"], [{"text": "Single or dual types?", "options": ["Single", "Dual"]}])

    def test_notification_and_session_end_keep_only_their_kind(self):
        run("claude-event", {"hook_event_name": "Notification", "session_id": "s1", "notification_type": "permission_prompt",
                             "message": "Claude needs permission to run rm -rf SECRET"}, self.profile)
        run("claude-event", {"hook_event_name": "SessionEnd", "session_id": "s1", "reason": "prompt_input_exit"}, self.profile)
        notification, end = self.lines()
        self.assertEqual((notification["notification"], end["reason"]), ("permission_prompt", "prompt_input_exit"))
        self.assertNotIn("SECRET", json.dumps(notification))

    def test_unknown_events_and_garbage_are_ignored_quietly(self):
        run("claude-event", {"hook_event_name": "FileChanged"}, self.profile)
        self.assertEqual(hook.main(["claude-event", "--profile", str(self.profile)], stdin=io.StringIO("not json"), stdout=io.StringIO()), 0)
        self.assertFalse((self.profile / "claude-inbox.jsonl").exists())

    def test_status_line_records_limits_and_prints_the_buddy(self):
        (self.profile / "buddy-status.json").write_text('{"name": "Pikachu", "level": 12}')
        text = run("claude-statusline", {"rate_limits": {"five_hour": {"used_percentage": 23.4, "resets_at": 1790600000}}}, self.profile)
        self.assertEqual(text.strip(), "Pocodex · Pikachu Lv. 12 · 5h 77% left")
        saved = json.loads((self.profile / "claude-limits.json").read_text())
        self.assertEqual(saved["rate_limits"]["five_hour"]["used_percentage"], 23.4)

    def test_status_line_without_limits_keeps_the_last_snapshot(self):
        (self.profile / "claude-limits.json").write_text('{"at": 1, "rate_limits": {"five_hour": {"used_percentage": 5}}}')
        self.assertEqual(run("claude-statusline", {"model": {"display_name": "Opus"}}, self.profile).strip(), "Pocodex")
        self.assertEqual(json.loads((self.profile / "claude-limits.json").read_text())["at"], 1)

    def test_default_profile_is_the_app_data_folder(self):
        self.assertEqual(hook.default_profile().name, "Pocodex")


if __name__ == "__main__":
    unittest.main()
