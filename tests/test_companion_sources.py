"""Telemetry correctness and privacy tests using actual bounded JSONL files."""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


def row(kind, payload, timestamp="2026-09-28T10:00:00Z"):
    return json.dumps({"type": kind, "payload": payload, "timestamp": timestamp}) + "\n"


class SourcesContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "sessions" / "one.jsonl"
        self.path.parent.mkdir()
        self.path.write_text(row("session_meta", {"id": "thread-1", "originator": "Codex Desktop", "cwd": "C:/work/demo", "base_instructions": "SECRET"}), encoding="utf-8")
        self.assertIsNotNone(importlib.util.find_spec("observatory.companion.sources"), "Local companion telemetry is not implemented")
        from observatory.companion.sources import Sources
        self.sources = Sources([self.root], now=1790589600)

    def tearDown(self):
        self.temp.cleanup()

    def append(self, kind, payload, timestamp="2026-09-28T10:00:01Z"):
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(row(kind, payload, timestamp))

    def test_new_start_and_completion_generate_once_without_message_content(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        self.sources.poll(1790589601)
        self.assertEqual(self.sources.snapshot(1790589601)["running"], 1)
        self.append("event_msg", {"type": "task_complete", "turn_id": "t1", "last_agent_message": "SECRET response"}, "2026-09-28T10:00:02Z")
        events = self.sources.poll(1790589602)
        self.assertEqual([e["kind"] for e in events], ["completed"])
        self.assertEqual(self.sources.snapshot(1790589602)["running"], 0)
        self.assertNotIn("SECRET", json.dumps(self.sources.snapshot(1790589602)))
        self.assertEqual(self.sources.poll(1790589603), [])

    def test_old_history_does_not_notify_or_run(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "old"}, "2026-09-27T10:00:00Z")
        self.append("event_msg", {"type": "task_complete", "turn_id": "old"}, "2026-09-27T10:01:00Z")
        self.assertEqual(self.sources.poll(1790589601), [])
        self.assertEqual(self.sources.snapshot(1790589601)["running"], 0)

    def test_growing_desktop_log_is_discovered_even_with_old_windows_mtime(self):
        from observatory.companion.sources import Sources
        os.utime(self.path, (1790400000, 1790400000))
        self.sources = Sources([self.root], now=1790589600)
        self.append('event_msg', {'type': 'task_started', 'turn_id': 'live'})
        os.utime(self.path, (1790400000, 1790400000))
        self.sources.poll(1790589606)
        self.assertEqual(self.sources.snapshot(1790589606)['running'], 1)

    def test_partial_line_is_read_on_next_poll(self):
        value = row("event_msg", {"type": "task_started", "turn_id": "t1"})
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(value[:30])
        self.assertEqual(self.sources.poll(1790589601), [])
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(value[30:])
        self.sources.poll(1790589602)
        self.assertEqual(self.sources.snapshot(1790589602)["running"], 1)

    def test_removed_log_cannot_leave_a_ghost_working_task(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "one"})
        self.sources.poll(1790589601)
        self.path.unlink()
        self.sources.poll(1790589602)
        self.assertEqual(self.sources.snapshot(1790589602)["running"], 0)
        self.assertEqual(self.sources.snapshot(1790589602)["activity"], "idle")

    def test_new_dated_session_folder_is_found_without_restart(self):
        folder = self.root / "sessions" / "2026" / "09" / "29"
        folder.mkdir(parents=True)
        (folder / "new.jsonl").write_text(row("session_meta", {"id": "new", "originator": "Codex Desktop", "cli_version": "99.0.0"}) + row("event_msg", {"type": "task_started", "turn_id": "new-turn"}, "2026-09-28T10:00:06Z"), encoding="utf-8")
        self.sources.poll(1790589606)
        self.assertEqual(self.sources.snapshot(1790589606)["running"], 1)

    def test_unknown_origin_remains_visible_across_inventory_refresh(self):
        self.path.write_text(row("session_meta", {"id": "new", "originator": "Codex Future"}) + row("event_msg", {"type": "task_started", "turn_id": "x"}), encoding="utf-8")
        self.sources.poll(1790589601)
        self.sources.poll(1790589606)
        snapshot = self.sources.snapshot(1790589606)
        self.assertEqual(snapshot["activity"], "unknown")
        self.assertIn("Unrecognized session origin", snapshot["sources"][0]["status"])
        self.assertEqual(snapshot["running"], 0)

    def test_replaced_same_size_log_is_reopened_without_old_thread_context(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "one"})
        self.sources.poll(1790589601)
        replacement = self.root / "replacement.jsonl"
        replacement.write_text(self.path.read_text(encoding="utf-8").replace('thread-1', 'thread-2'), encoding="utf-8")
        replacement.replace(self.path)
        self.sources.poll(1790589602)
        self.assertEqual(self.sources.paths[self.path]["thread"], "thread-2")
        self.assertEqual(self.sources.snapshot(1790589602)["running"], 1)

    def test_request_user_input_pauses_work_until_matching_output(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        self.append("response_item", {"type": "function_call", "name": "request_user_input", "call_id": "call1", "arguments": "SECRET"})
        self.sources.poll(1790589602)
        self.assertEqual(self.sources.snapshot(1790589602)["running"], 0)
        self.assertEqual(self.sources.snapshot(1790589602)["waiting"], 1)
        self.append("response_item", {"type": "function_call_output", "call_id": "call1", "output": "SECRET answer"})
        self.sources.poll(1790589603)
        self.assertEqual(self.sources.snapshot(1790589603)["running"], 1)
        self.assertEqual(self.sources.snapshot(1790589603)["attention"], [])

    def test_live_completion_is_seen_when_start_happened_before_launch(self):
        self.append("event_msg", {"type": "task_complete", "turn_id": "older-turn", "last_agent_message": "SECRET"})
        self.assertEqual([e["kind"] for e in self.sources.poll(1790589602)], ["completed"])
        self.append("event_msg", {"type": "task_complete", "turn_id": "older-turn"})
        self.assertEqual(self.sources.poll(1790589603), [])
        self.append("event_msg", {"type": "task_complete", "turn_id": "another-turn"})
        self.assertEqual([e["kind"] for e in self.sources.poll(1790589603)], ["completed"])
        self.assertNotIn("SECRET", json.dumps(self.sources.snapshot(1790589603)))

    def test_input_without_start_is_detected_and_duplicate_request_is_not_repeated(self):
        question = {"type": "function_call", "name": "functions.request_user_input", "call_id": "new-question"}
        self.append("response_item", question)
        self.assertEqual([e["kind"] for e in self.sources.poll(1790589602)], ["input_needed"])
        self.append("response_item", question)
        self.assertEqual(self.sources.poll(1790589603), [])
        self.assertEqual(self.sources.snapshot(1790589603)["waiting"], 1)

    def test_silent_turn_becomes_unknown_not_idle_or_infinite_xp(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        self.sources.poll(1790589601)
        state = self.sources.snapshot(1790590000)
        self.assertEqual(state["running"], 0)
        self.assertEqual(state["uncertain"], 1)
        self.assertEqual(state["activity"], "unknown")

    def test_answer_received_in_same_poll_does_not_leave_phantom_input_alert(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        self.append("response_item", {"type": "function_call", "name": "request_user_input", "call_id": "call1"})
        self.append("response_item", {"type": "function_call_output", "call_id": "call1"})
        events = self.sources.poll(1790589602)
        self.assertEqual(events, [])
        self.assertEqual(self.sources.snapshot(1790589602)["attention"], [])

    def test_completion_clears_pending_input_alert(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        self.append("response_item", {"type": "function_call", "name": "request_user_input", "call_id": "call1"})
        self.sources.poll(1790589602)
        self.append("event_msg", {"type": "task_complete", "turn_id": "t1"})
        self.sources.poll(1790589603)
        self.assertEqual([e["kind"] for e in self.sources.snapshot(1790589603)["attention"]], ["completed"])

    def test_quota_has_source_age_and_stale_snapshot_does_not_warn(self):
        self.append("event_msg", {"type": "token_count", "rate_limits": {"limit_id": "codex", "primary": {"used_percent": 95, "window_minutes": 300, "resets_at": 1790600000}}})
        events = self.sources.poll(1790589601)
        self.assertEqual([e["kind"] for e in events], ["low_allowance"])
        self.assertEqual(self.sources.snapshot(1790589601)["quota"][0]["remaining"], 5)
        self.assertTrue(self.sources.snapshot(1790590000)["quota"][0]["stale"])

    def test_repeated_quota_threshold_notifies_once(self):
        for _ in range(2):
            self.append("event_msg", {"type": "token_count", "rate_limits": {"limit_id": "codex", "primary": {"used_percent": 95, "window_minutes": 300, "resets_at": 1790600000}}})
        self.assertEqual(len(self.sources.poll(1790589601)), 1)

    def test_atomic_tokens_deduplicated_and_do_not_add_cached_subset(self):
        for _ in range(2):
            self.append("token_usage_record", {"thread_id": "thread-1", "turn_id": "t1", "response_id": "r1", "usage": {"input_tokens": 100, "cached_input_tokens": 80, "output_tokens": 20, "reasoning_output_tokens": 5, "total_tokens": 120}})
        self.sources.poll(1790589601)
        state = self.sources.snapshot(1790589601)
        self.assertEqual(state["tokens"], 120)
        self.assertEqual(state["cached"], 80)

    def test_tokens_are_kept_for_today_only(self):
        self.append("token_usage_record", {"thread_id": "thread-1", "turn_id": "t1", "response_id": "r1", "usage": {"input_tokens": 100, "cached_input_tokens": 80, "output_tokens": 20, "reasoning_output_tokens": 5, "total_tokens": 120}})
        self.sources.poll(1790589601)
        self.assertEqual(len(self.sources.snapshot(1790589601)["usage"]), 1)
        state = self.sources.snapshot(1790589601 + 86400)
        self.assertEqual((state["tokens"], state["usage"]), (0, []))
        self.assertEqual((self.sources.ledger.days, self.sources.ledger.seen), ({}, {}))

    def test_a_log_quiet_for_a_day_is_parked_and_resumes_where_it_left_off(self):
        self.sources.poll(1790589601)
        self.sources.poll(1790589600 + 86402)
        self.assertNotIn(self.path, self.sources.paths)
        self.append("event_msg", {"type": "task_started", "turn_id": "t2"}, "2026-09-29T10:00:05Z")
        self.sources.poll(1790589600 + 86410)
        self.assertEqual(self.sources.paths[self.path]["thread"], "thread-1")
        self.assertEqual(self.sources.snapshot(1790589600 + 86410)["running"], 1)

    def test_fresh_heartbeat_discovers_a_turn_started_before_pocodex(self):
        self.append("turn_context", {"turn_id": "already-running", "model": "known-model"}, "2026-09-28T09:59:50Z")
        self.append("event_msg", {"type": "token_count", "info": None})
        self.sources.poll(1790589601)
        self.assertEqual(self.sources.snapshot(1790589601)["running"], 1)

    def test_async_question_does_not_pause_work(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        self.append("response_item", {"type": "function_call", "name": "request_user_input_async", "call_id": "async"})
        self.sources.poll(1790589601)
        self.assertEqual(self.sources.snapshot(1790589601)["running"], 1)
        self.assertEqual([e['kind'] for e in self.sources.attention], ['input_needed'])
        self.append('response_item', {'type': 'function_call_output', 'call_id': 'async', 'output': '{"accepted":true}'})
        self.sources.poll(1790589602)
        self.assertEqual(len(self.sources.attention), 1)
        self.append('event_msg', {'type': 'user_message', 'message': '<send_user_message_question_reply>\n' + json.dumps([{'questionItemId': '["request_user_input_async","async",0]', 'answer': 'A'}]) + '\n</send_user_message_question_reply>'})
        self.sources.poll(1790589603)
        self.assertEqual(self.sources.attention, [])

    def test_new_turn_supersedes_only_same_chat_and_late_completion(self):
        other = self.path.parent / 'other.jsonl'
        other.write_text(row('session_meta', {'id': 'thread-2', 'originator': 'Codex Desktop'}) + row('event_msg', {'type': 'task_complete', 'turn_id': 'other'}), encoding='utf-8')
        self.append('event_msg', {'type': 'task_started', 'turn_id': 'old'})
        self.append('event_msg', {'type': 'task_complete', 'turn_id': 'old'})
        self.sources.poll(1790589606)
        self.assertEqual(len(self.sources.attention), 2)
        self.append('event_msg', {'type': 'task_started', 'turn_id': 'new'})
        self.sources.poll(1790589607)
        self.assertEqual([e['thread'] for e in self.sources.attention], ['thread-2'])
        self.append('event_msg', {'type': 'task_interrupted', 'turn_id': 'old'})
        self.assertEqual(self.sources.poll(1790589608), [])
        self.assertEqual(self.sources.snapshot(1790589608)['running'], 1)

    def test_opt_in_previews_are_bounded_and_purged_when_disabled(self):
        self.sources.set_previews(True)
        self.append('event_msg', {'type': 'task_complete', 'turn_id': 't1', 'last_agent_message': 'Done.\x00 ' + 'x' * 2000})
        event = self.sources.poll(1790589601)[0]
        self.assertTrue(event['preview'].startswith('Done. '))
        self.assertLessEqual(len(event['preview']), 600)
        self.assertNotIn('\x00', event['preview'])
        self.sources.set_previews(False)
        self.assertNotIn('preview', self.sources.attention[0])

    def test_async_questions_preview_and_partial_answers(self):
        self.sources.set_previews(True)
        self.append('event_msg', {'type': 'task_started', 'turn_id': 't1'})
        self.append('response_item', {'type': 'function_call', 'name': 'functions.request_user_input_async', 'call_id': 'ask', 'arguments': json.dumps({'questions': [{'title': 'Which colour?', 'options': ['Red', 'Blue']}, {'title': 'Which size?'}]})})
        event = self.sources.poll(1790589601)[0]
        self.assertEqual(event['questions'][0], {'text': 'Which colour?', 'options': ['Red', 'Blue']})
        self.assertTrue(event['asynchronous'])
        for index in [0, 1]:
            text = '<send_user_message_question_reply>' + json.dumps([{'questionItemId': json.dumps(['request_user_input_async', 'ask', index])}]) + '</send_user_message_question_reply>'
            self.append('response_item', {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': text}]})
            self.sources.poll(1790589602 + index)
            self.assertEqual(len(self.sources.attention), 1 if index == 0 else 0)

    def test_oversized_record_does_not_stall_later_completion(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write('x' * (8 * 1024 * 1024 + 20) + '\n')
        self.append("event_msg", {"type": "task_complete", "turn_id": "t1"})
        result = self.sources.poll(1790589601)
        self.assertIn("completed", [e["kind"] for e in result])

    def test_huge_record_is_drained_across_bounded_polls(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write('x' * (26 * 1024 * 1024) + '\n')
        self.append("event_msg", {"type": "task_complete", "turn_id": "t1"})
        self.assertEqual(self.sources.poll(1790589601), [])
        self.assertLessEqual(self.sources.paths[self.path]['offset'], 12 * 1024 * 1024)
        self.sources.poll(1790589602)
        self.assertIn('completed', [e['kind'] for e in self.sources.poll(1790589603)])


if __name__ == "__main__":
    unittest.main()


class PlainReplyContracts(unittest.TestCase):
    setUp, tearDown, append = SourcesContracts.setUp, SourcesContracts.tearDown, SourcesContracts.append

    def test_plain_user_message_in_the_same_chat_clears_its_async_question(self):
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        self.append("response_item", {"type": "function_call", "name": "request_user_input_async", "call_id": "ask"})
        self.sources.poll(1790589601)
        self.assertEqual([e["kind"] for e in self.sources.attention], ["input_needed"])
        # The user typed an answer instead of using the question card.
        self.append("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Dual types, please"}]}, "2026-09-28T10:00:02Z")
        self.sources.poll(1790589602)
        self.assertEqual(self.sources.attention, [])

    def test_plain_message_in_another_chat_keeps_the_question(self):
        other = self.path.parent / "other.jsonl"
        other.write_text(row("session_meta", {"id": "thread-2", "originator": "Codex Desktop"}), encoding="utf-8")
        self.append("event_msg", {"type": "task_started", "turn_id": "t1"})
        self.append("response_item", {"type": "function_call", "name": "request_user_input_async", "call_id": "ask"})
        self.sources.poll(1790589601)
        with other.open("a", encoding="utf-8") as stream:
            stream.write(row("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "unrelated"}]}, "2026-09-28T10:00:02Z"))
        self.sources.poll(1790589602)
        self.assertEqual([e["kind"] for e in self.sources.attention], ["input_needed"])


class AppTagContracts(unittest.TestCase):
    setUp, tearDown, append = SourcesContracts.setUp, SourcesContracts.tearDown, SourcesContracts.append

    def test_events_and_quotas_are_tagged_codex_with_readable_windows(self):
        from observatory.companion.sources import timestamp
        self.append("event_msg", {"type": "task_complete", "turn_id": "t1"})
        self.append("event_msg", {"type": "token_count", "rate_limits": {
            "primary": {"used_percent": 23, "window_minutes": 300, "resets_at": 1790600000},
            "secondary": {"used_percent": 40, "window_minutes": 10080, "resets_at": 1790900000}}})
        events = self.sources.poll(1790589601)
        self.assertEqual({e["app"] for e in events}, {"codex"})
        labels = {q["label"]: q["remaining"] for q in self.sources.snapshot(1790589601)["quota"]}
        self.assertEqual(labels, {"5h": 77, "weekly": 60})
        self.assertTrue(all(q["app"] == "codex" for q in self.sources.snapshot(1790589601)["quota"]))
        self.assertEqual(self.sources.last_event, timestamp("2026-09-28T10:00:01Z"))
