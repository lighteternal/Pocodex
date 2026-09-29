"""Claude Code activity from Pocodex's own hook inbox, status-line snapshot and transcript tails."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from observatory.companion.sources import ClaudeSource

BOOT = 1790589600.0  # 2026-09-28T10:00:00Z


class ClaudeContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.profile = Path(self.temp.name)
        self.transcript = self.profile / "t.jsonl"
        self.transcript.write_text("")
        self.source = ClaudeSource(self.profile, BOOT)

    def tearDown(self):
        self.temp.cleanup()

    def hook(self, event, at, session="s1", **extra):
        line = {"at": at, "event": event, "session": session, "project": "demo", "transcript": str(self.transcript), **extra}
        with (self.profile / "claude-inbox.jsonl").open("a") as inbox:
            inbox.write(json.dumps(line) + "\n")

    def assistant(self, ident, blocks, usage, at="2026-09-28T10:00:05Z", stop="end_turn"):
        # Claude Code writes one transcript entry per content block, repeating the message usage.
        with self.transcript.open("a") as stream:
            for block in blocks:
                stream.write(json.dumps({"type": "assistant", "timestamp": at, "message": {
                    "id": ident, "model": "claude-opus-5-5", "role": "assistant", "stop_reason": stop,
                    "content": [block], "usage": usage}}) + "\n")

    def test_prompt_then_stop_is_working_then_completed_with_deduplicated_tokens(self):
        self.hook("UserPromptSubmit", BOOT + 1)
        self.source.poll(BOOT + 1)
        self.assertEqual(self.source.snapshot(BOOT + 1)["running"], 1)
        usage = {"input_tokens": 10, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000, "output_tokens": 50}
        self.assistant("m1", [{"type": "text", "text": "Checking."}, {"type": "tool_use", "name": "Bash"}], usage, stop="tool_use")
        self.hook("Stop", BOOT + 6)
        events = self.source.poll(BOOT + 6)
        self.assertEqual([(e["kind"], e["app"]) for e in events], [("completed", "claude")])
        snap = self.source.snapshot(BOOT + 6)
        self.assertEqual((snap["running"], snap["input"], snap["cached"], snap["output"], snap["tokens"]), (0, 1110, 1000, 50, 1160))
        self.assertNotIn("preview", events[0])
        self.hook("Stop", BOOT + 7)  # a duplicate Stop never double counts
        self.source.poll(BOOT + 7)
        self.assertEqual(self.source.snapshot(BOOT + 7)["tokens"], 1160)

    def test_a_busy_day_counts_every_response_and_starts_over_the_next_day(self):
        self.hook("UserPromptSubmit", BOOT + 1)
        for n in range(600):
            self.assistant(f"m{n}", [{"type": "text", "text": "Step."}], {"input_tokens": 4, "output_tokens": 6})
        self.hook("Stop", BOOT + 6)
        self.source.poll(BOOT + 6)
        snap = self.source.snapshot(BOOT + 6)
        self.assertEqual((snap["tokens"], len(snap["usage"])), (6000, 200))
        snap = self.source.snapshot(BOOT + 86400)
        self.assertEqual((snap["tokens"], snap["usage"]), (0, []))
        self.assertEqual((len(self.source.ledger.days), len(self.source.ledger.seen)), (0, 0))

    def test_a_long_turn_keeps_its_early_responses_and_later_turns_add_only_new_ones(self):
        self.assistant("m0", [{"type": "text", "text": "Before launch."}], {"input_tokens": 1000, "output_tokens": 1}, at="2026-09-28T09:59:00Z")
        self.hook("UserPromptSubmit", BOOT + 1)
        self.assistant("m1", [{"type": "tool_use", "name": "Read"}], {"input_tokens": 100, "output_tokens": 10}, stop="tool_use")
        with self.transcript.open("a") as stream:
            for _ in range(40):
                stream.write(json.dumps({"type": "user", "message": {"role": "user", "content": "x" * 20000}}) + "\n")
        self.assistant("m2", [{"type": "text", "text": "Done."}], {"input_tokens": 200, "output_tokens": 20})
        self.hook("Stop", BOOT + 6)
        self.source.poll(BOOT + 6)
        self.assertEqual(self.source.snapshot(BOOT + 6)["tokens"], 330)
        self.hook("UserPromptSubmit", BOOT + 7)
        self.assistant("m3", [{"type": "text", "text": "Again."}], {"input_tokens": 1, "output_tokens": 2}, at="2026-09-28T10:00:08Z")
        self.hook("Stop", BOOT + 9)
        self.source.poll(BOOT + 9)
        self.assertEqual(self.source.snapshot(BOOT + 9)["tokens"], 333)

    def test_previews_gather_the_final_message_across_entries_when_enabled(self):
        self.source.set_previews(True)
        self.hook("UserPromptSubmit", BOOT + 1)
        self.assistant("m1", [{"type": "text", "text": "Earlier step."}], {"input_tokens": 1, "output_tokens": 1})
        self.assistant("m2", [{"type": "text", "text": "Fire beats Grass."}, {"type": "text", "text": "Water beats Fire."}], {"input_tokens": 1, "output_tokens": 1})
        self.hook("Stop", BOOT + 2)
        self.assertEqual(self.source.poll(BOOT + 2)[0]["preview"], "Fire beats Grass.\nWater beats Fire.")

    def ask(self, ident, text="Dual?", at="2026-09-28T10:00:02Z"):
        with self.transcript.open("a") as stream:
            stream.write(json.dumps({"type": "assistant", "timestamp": at, "message": {
                "id": "m-" + ident, "model": "claude-opus-5-5", "role": "assistant", "content": [{
                    "type": "tool_use", "id": ident, "name": "AskUserQuestion",
                    "input": {"questions": [{"question": text, "header": "Types", "options": [{"label": "Yes", "description": "Two"}]}]}}]}}) + "\n")

    def test_question_and_permission_wait_then_resume(self):
        self.hook("UserPromptSubmit", BOOT + 1)
        self.ask("toolu_1")
        self.hook("PreToolUse", BOOT + 2, tool="AskUserQuestion", tool_use="toolu_1")
        events = self.source.poll(BOOT + 2)
        self.assertEqual((events[0]["kind"], events[0]["reason"]), ("input_needed", "question"))
        self.assertNotIn("questions", events[0])  # previews are off
        self.hook("PostToolUse", BOOT + 3, tool="AskUserQuestion")
        self.source.poll(BOOT + 3)
        self.assertEqual(self.source.attention, [])
        self.hook("Notification", BOOT + 4, notification="permission_prompt")
        self.assertEqual(self.source.poll(BOOT + 4)[0]["reason"], "permission")
        self.assertEqual(self.source.snapshot(BOOT + 4)["waiting"], 1)
        with self.transcript.open("a") as stream:
            stream.write('{"type":"user"}\n')  # the approved tool ran
        self.source.poll(BOOT + 5)
        self.assertEqual((self.source.snapshot(BOOT + 5)["waiting"], self.source.attention), (0, []))

    def test_question_previews_follow_the_setting(self):
        self.source.set_previews(True)
        self.hook("UserPromptSubmit", BOOT + 1)
        self.ask("toolu_0", "Earlier?")
        self.ask("toolu_1")
        self.hook("PreToolUse", BOOT + 2, tool="AskUserQuestion", tool_use="toolu_1")
        self.assertEqual(self.source.poll(BOOT + 2)[0]["questions"], [{"text": "Dual?", "options": ["Yes"]}])
        self.source.set_previews(False)
        self.assertNotIn("questions", self.source.attention[0])
        self.source.poll(BOOT + 3)
        self.assertNotIn("questions", self.source.attention[0])
        self.source.set_previews(True)
        self.source.poll(BOOT + 4)
        self.assertEqual(self.source.attention[0]["questions"], [{"text": "Dual?", "options": ["Yes"]}])

    def test_question_text_is_read_from_the_transcript_once_it_is_written(self):
        self.source.set_previews(True)
        self.hook("UserPromptSubmit", BOOT + 1)
        self.hook("PreToolUse", BOOT + 2, tool="AskUserQuestion", tool_use="toolu_1", questions=[{"text": "Old inbox", "options": []}])
        self.assertNotIn("questions", self.source.poll(BOOT + 2)[0])  # not in the transcript yet; old inbox text ignored
        self.ask("toolu_1")
        self.source.poll(BOOT + 3)
        self.assertEqual(self.source.attention[0]["questions"], [{"text": "Dual?", "options": ["Yes"]}])

    def test_question_without_a_tool_use_id_takes_only_a_fresh_call(self):
        self.source.set_previews(True)
        self.hook("UserPromptSubmit", BOOT + 1)
        self.ask("toolu_0", "Stale?", at="2026-09-28T09:58:00Z")
        self.hook("PreToolUse", BOOT + 2, tool="AskUserQuestion")
        self.assertNotIn("questions", self.source.poll(BOOT + 2)[0])
        self.ask("toolu_1")
        self.source.poll(BOOT + 3)
        self.assertEqual(self.source.attention[0]["questions"], [{"text": "Dual?", "options": ["Yes"]}])

    def test_idle_prompt_is_not_an_alert(self):
        self.hook("UserPromptSubmit", BOOT + 1)
        self.hook("Stop", BOOT + 2)
        self.hook("Notification", BOOT + 70, notification="idle_prompt")
        self.assertEqual([e["kind"] for e in self.source.poll(BOOT + 70)], ["completed"])

    def test_transcript_growth_keeps_a_long_turn_alive(self):
        self.hook("UserPromptSubmit", BOOT + 1)
        self.source.poll(BOOT + 1)
        for tick in range(1, 5):
            with self.transcript.open("a") as stream:
                stream.write('{"type":"progress"}\n')
            self.source.poll(BOOT + 100 * tick)
        self.assertEqual(self.source.snapshot(BOOT + 400)["running"], 1)
        self.assertEqual(self.source.snapshot(BOOT + 600)["uncertain"], 1)

    def test_history_before_launch_restores_state_without_alerts(self):
        self.hook("UserPromptSubmit", BOOT - 30)
        self.assertEqual(self.source.poll(BOOT + 1), [])
        self.assertEqual(self.source.snapshot(BOOT + 1)["running"], 1)
        self.hook("Stop", BOOT + 2)
        self.assertEqual([e["kind"] for e in self.source.poll(BOOT + 2)], ["completed"])

    def test_new_prompt_clears_only_that_sessions_previous_answer(self):
        self.hook("UserPromptSubmit", BOOT + 1); self.hook("Stop", BOOT + 2)
        self.hook("UserPromptSubmit", BOOT + 1, session="s2"); self.hook("Stop", BOOT + 2, session="s2")
        self.source.poll(BOOT + 2)
        self.hook("UserPromptSubmit", BOOT + 3)
        self.source.poll(BOOT + 3)
        self.assertEqual([e["thread"] for e in self.source.attention], ["s2"])

    def test_failure_and_session_end_mid_turn_are_stopped(self):
        self.hook("UserPromptSubmit", BOOT + 1); self.hook("StopFailure", BOOT + 2)
        self.hook("UserPromptSubmit", BOOT + 1, session="s2"); self.hook("SessionEnd", BOOT + 2, session="s2", reason="other")
        self.assertEqual([e["kind"] for e in self.source.poll(BOOT + 2)], ["stopped", "stopped"])
        self.assertEqual(self.source.snapshot(BOOT + 2)["running"], 0)

    def test_status_line_limits_become_allowance_and_warn_once(self):
        (self.profile / "claude-limits.json").write_text(json.dumps({"at": BOOT + 1, "rate_limits": {
            "five_hour": {"used_percentage": 91, "resets_at": BOOT + 3600}, "seven_day": {"used_percentage": 40, "resets_at": BOOT + 86400}}}))
        events = self.source.poll(BOOT + 2)
        self.assertEqual([(e["kind"], e["window"], e["app"]) for e in events], [("low_allowance", "5h", "claude")])
        quota = {q["label"]: q["remaining"] for q in self.source.snapshot(BOOT + 2)["quota"]}
        self.assertEqual(quota, {"5h": 9, "weekly": 60})
        self.assertEqual(self.source.poll(BOOT + 3), [])

    def test_non_finite_limits_are_unknown_not_a_crash(self):
        # json.loads accepts NaN and turns 1e309 into infinity; the service must neither crash nor send them on.
        (self.profile / "claude-limits.json").write_text('{"at": 1790589601, "rate_limits": {"five_hour": {"used_percentage": NaN, '
                                                         '"resets_at": 1790593200}, "seven_day": {"used_percentage": 40, "resets_at": 1e309}}}')
        self.assertEqual(self.source.poll(BOOT + 2), [])
        quota = self.source.snapshot(BOOT + 2)["quota"]
        self.assertEqual([(q["label"], q["remaining"], q["resets_at"], q["stale"]) for q in quota], [("weekly", 60, None, True)])
        json.dumps(quota, allow_nan=False)
        (self.profile / "claude-limits.json").write_text('{"at": Infinity, "rate_limits": {"five_hour": {"used_percentage": -1e309}}}')
        self.source.limits_seen = None
        self.assertEqual(self.source.poll(BOOT + 3), [])

    def test_usage_check_readings_stay_fresh_between_checks(self):
        limits = {"five_hour": {"used_percentage": 43, "resets_at": BOOT + 4000}, "seven_day": {"used_percentage": 57, "resets_at": BOOT + 86400}}
        (self.profile / "claude-limits.json").write_text(json.dumps({"at": BOOT, "rate_limits": limits, "source": "usage_check"}))
        self.source.poll(BOOT + 1)
        quota = {q["label"]: q for q in self.source.snapshot(BOOT + 600)["quota"]}  # ten minutes on, before the next check
        self.assertEqual((quota["5h"]["remaining"], quota["5h"]["stale"], quota["5h"]["source"]), (57, False, "Claude Code usage check"))
        self.assertEqual(quota["weekly"]["remaining"], 43)
        self.assertTrue(all(q["stale"] for q in self.source.snapshot(BOOT + 901)["quota"]))

    def rejected(self, kind, reset, at="2026-09-28T10:00:02Z"):
        # What Claude Code logs when a request is refused for a usage limit (desktop app sessions included).
        with self.transcript.open("a") as stream:
            stream.write(json.dumps({"type": "assistant", "timestamp": at, "isApiErrorMessage": True, "error": "rate_limit",
                                     "quotaLimits": {"status": "rejected", "resetsAt": reset, "rateLimitType": kind, "overageStatus": "rejected"},
                                     "message": {"id": "err", "model": "<synthetic>", "role": "assistant",
                                                 "content": [{"type": "text", "text": "You've hit your limit"}]}}) + "\n")

    def test_a_limit_hit_in_the_transcript_empties_that_window_until_it_resets(self):
        reset = BOOT + 3 * 3600
        self.hook("UserPromptSubmit", BOOT + 1)
        self.rejected("five_hour", reset)
        self.hook("StopFailure", BOOT + 2)
        events = self.source.poll(BOOT + 2)
        self.assertEqual([(e["kind"], e.get("window"), e.get("remaining")) for e in events if e["kind"] == "limit_reached"], [("limit_reached", "5h", 0)])
        # A refusal is true until the reset, long after a status line reading would go stale.
        quota = self.source.snapshot(BOOT + 3600)["quota"]
        self.assertEqual([(q["label"], q["remaining"], q["resets_at"], q["stale"], q["source"]) for q in quota],
                         [("5h", 0, reset, False, "Claude Code usage limit")])
        self.hook("UserPromptSubmit", BOOT + 100)
        self.hook("StopFailure", BOOT + 101)
        self.assertNotIn("limit_reached", [e["kind"] for e in self.source.poll(BOOT + 101)])  # warned once
        self.assertEqual(self.source.snapshot(reset + 1)["quota"], [])  # back to unknown, not a stale zero

    def test_a_weekly_refusal_and_old_refusals(self):
        self.rejected("seven_day", BOOT - 60, at="2026-09-27T10:00:00Z")  # already reset: ignored
        self.rejected("seven_day", BOOT + 2 * 86400)
        self.hook("UserPromptSubmit", BOOT + 1)
        self.hook("Stop", BOOT + 2)
        self.source.poll(BOOT + 2)
        self.assertEqual([(q["label"], q["remaining"]) for q in self.source.snapshot(BOOT + 3)["quota"]], [("weekly", 0)])

    def test_a_refusal_from_before_launch_is_restored_quietly(self):
        reset = BOOT + 3600
        self.hook("UserPromptSubmit", BOOT - 30)
        self.rejected("five_hour", reset, at="2026-09-28T09:59:40Z")
        self.hook("StopFailure", BOOT - 20)
        self.assertEqual(self.source.poll(BOOT + 1), [])  # no alert for the past
        self.assertEqual([(q["label"], q["remaining"]) for q in self.source.snapshot(BOOT + 1)["quota"]], [("5h", 0)])

    def test_large_consumed_inbox_is_trimmed(self):
        with (self.profile / "claude-inbox.jsonl").open("a") as inbox:
            inbox.write(("#" * 200 + "\n") * 6000)
        self.source.poll(BOOT + 1)
        self.assertFalse((self.profile / "claude-inbox.jsonl").exists())
        self.hook("UserPromptSubmit", BOOT + 2)
        self.source.poll(BOOT + 2)
        self.assertEqual(self.source.snapshot(BOOT + 2)["running"], 1)
        self.assertEqual(self.source.last_event, BOOT + 2)
        self.assertEqual(sorted(p.name for p in self.profile.iterdir()), ["claude-inbox.jsonl", "t.jsonl"])

    def test_a_line_appended_while_the_inbox_is_trimmed_is_kept(self):
        with (self.profile / "claude-inbox.jsonl").open("a") as inbox:
            inbox.write(("#" * 200 + "\n") * 6000)
        rename = os.replace

        def racing_hook(source, target):  # a hook appends after the read, before the trim
            self.hook("UserPromptSubmit", BOOT + 1)
            rename(source, target)

        with mock.patch("observatory.companion.sources.claude.os.replace", racing_hook):
            self.source.poll(BOOT + 1)
        self.assertEqual(self.source.snapshot(BOOT + 1)["running"], 0)
        self.source.poll(BOOT + 2)
        self.assertEqual(self.source.snapshot(BOOT + 2)["running"], 1)
        self.assertFalse((self.profile / "claude-inbox.jsonl.old").exists())

    def test_a_rotated_inbox_left_by_a_crash_is_read_first(self):
        self.hook("UserPromptSubmit", BOOT - 30)
        (self.profile / "claude-inbox.jsonl").rename(self.profile / "claude-inbox.jsonl.old")
        self.hook("Stop", BOOT + 2)
        self.assertEqual([e["kind"] for e in self.source.poll(BOOT + 2)], ["completed"])
        self.assertFalse((self.profile / "claude-inbox.jsonl.old").exists())
        self.assertEqual(self.source.poll(BOOT + 3), [])

    def test_question_text_left_by_an_older_build_is_cleared_once_read(self):
        self.hook("PreToolUse", BOOT - 30, tool="AskUserQuestion", questions=[{"text": "secret marker", "options": []}])
        self.source.poll(BOOT + 1)
        self.source.poll(BOOT + 2)
        self.assertFalse(any(b"secret marker" in p.read_bytes() for p in self.profile.iterdir()))
        self.hook("UserPromptSubmit", BOOT + 3)
        self.source.poll(BOOT + 3)
        self.assertEqual(self.source.snapshot(BOOT + 3)["running"], 1)
        self.assertTrue((self.profile / "claude-inbox.jsonl").exists())  # new lines wait for the usual trim


if __name__ == "__main__":
    unittest.main()


class ClaudeEdgeCases(unittest.TestCase):
    setUp, tearDown, hook = ClaudeContracts.setUp, ClaudeContracts.tearDown, ClaudeContracts.hook

    def test_inbox_deleted_and_recreated_is_read_from_the_start(self):
        self.hook("UserPromptSubmit", BOOT + 1)
        self.source.poll(BOOT + 1)
        (self.profile / "claude-inbox.jsonl").unlink()
        self.source.poll(BOOT + 2)
        self.hook("Stop", BOOT + 3)
        self.assertEqual([e["kind"] for e in self.source.poll(BOOT + 3)], ["completed"])

    def test_lines_without_a_session_or_time_are_ignored(self):
        with (self.profile / "claude-inbox.jsonl").open("a") as inbox:
            inbox.write(json.dumps({"at": BOOT + 1, "event": "UserPromptSubmit"}) + "\n")
            inbox.write(json.dumps({"event": "UserPromptSubmit", "session": "s9"}) + "\n")
            inbox.write(json.dumps({"at": True, "event": "UserPromptSubmit", "session": "s9"}) + "\n")
        self.assertEqual(self.source.poll(BOOT + 2), [])
        self.assertEqual(self.source.snapshot(BOOT + 2)["running"], 0)

    def test_stop_without_a_prompt_is_not_a_phantom_answer(self):
        self.hook("Stop", BOOT + 1)
        self.assertEqual(self.source.poll(BOOT + 1), [])

    def test_a_half_written_last_line_waits_for_its_newline(self):
        with (self.profile / "claude-inbox.jsonl").open("a") as inbox:
            inbox.write('{"at": %s, "event": "UserPromptSubmit", "session": "s1"' % (BOOT + 1))
        self.source.poll(BOOT + 1)
        self.assertEqual(self.source.snapshot(BOOT + 1)["running"], 0)
        with (self.profile / "claude-inbox.jsonl").open("a") as inbox:
            inbox.write("}\n")
        self.source.poll(BOOT + 2)
        self.assertEqual(self.source.snapshot(BOOT + 2)["running"], 1)

    def test_missing_transcript_still_completes_without_tokens(self):
        line = {"at": BOOT + 1, "event": "UserPromptSubmit", "session": "s1", "project": "demo", "transcript": str(self.profile / "gone.jsonl")}
        with (self.profile / "claude-inbox.jsonl").open("a") as inbox:
            inbox.write(json.dumps(line) + "\n")
            inbox.write(json.dumps({**line, "at": BOOT + 2, "event": "Stop"}) + "\n")
        self.assertEqual([e["kind"] for e in self.source.poll(BOOT + 2)], ["completed"])
        self.assertEqual(self.source.snapshot(BOOT + 2)["tokens"], 0)
