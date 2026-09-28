"""Companion progression contracts, against a real on-disk save."""

import importlib.util
import json
import random
import tempfile
import unittest
from pathlib import Path


CATALOG = {"species": [
    {"id": 1, "name": "Bulbasaur", "family": 1, "starter": True, "evolutions": [{"to": 2, "min_level": 16, "active_seconds": 0, "requirement": "Level 16"}]},
    {"id": 2, "name": "Ivysaur", "family": 1, "starter": False, "evolutions": []},
    *[{"id": i, "name": f"Species {i}", "family": i, "starter": True, "evolutions": []} for i in (4, 7, 10, 25, 133)],
    {"id": 144, "name": "Articuno", "family": 144, "starter": False, "legendary": True, "evolutions": []},
]}


class CompanionContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "companion.sqlite"
        spec = importlib.util.find_spec("observatory.companion")
        self.assertIsNotNone(spec, "The companion progression package is not implemented")
        from observatory.companion.engine import Companion
        self.engine_class = Companion
        self.engine = Companion(self.path, CATALOG, now=1000, rng=random.Random(7))

    def tearDown(self):
        if hasattr(self, "engine"):
            self.engine.close()
        self.temp.cleanup()

    def hatch(self):
        self.engine.credit(1000, 1120)
        return self.engine.snapshot()["egg"]["choices"]

    def test_background_choice_persists_and_random_does_not_change_on_poll(self):
        for choice in ("meadow", "forest", "pond", "beach", "snow", "ruins", "camp", "volcano", "none"):
            self.engine.command("settings", {"background": choice})
            self.assertEqual(self.engine.snapshot()["background"], choice)
        self.engine.command("settings", {"background": "random"})
        chosen = self.engine.snapshot()["background"]
        self.assertIn(chosen, ("meadow", "forest", "pond", "beach", "snow", "ruins", "camp", "volcano"))
        self.assertEqual(self.engine.snapshot()["background"], chosen)
        self.engine.command("shuffle_background", {})
        self.assertNotEqual(self.engine.snapshot()["background"], chosen)
        self.engine.close()
        self.engine = self.engine_class(self.path, CATALOG, now=1100)
        self.assertEqual(self.engine.snapshot()["settings"]["background"], "random")
        with self.assertRaises(ValueError):
            self.engine.command("settings", {"background": "https://untrusted.example/art.svg"})

    def adopt(self):
        choice = self.hatch()[0]["id"]
        self.engine.command("adopt", {"species_id": choice})
        return self.engine.snapshot()["active"]["id"]

    def test_first_hatch_requires_120_seconds_and_offers_three_distinct_families(self):
        self.engine.credit(1000, 1119)
        self.assertEqual(self.engine.snapshot()["egg"]["choices"], [])
        self.engine.credit(1119, 1120)
        choices = self.engine.snapshot()["egg"]["choices"]
        self.assertEqual(len({p["family"] for p in choices}), 3)
        self.assertTrue(all(p["starter"] and not p.get("legendary") for p in choices))

    def test_overlap_and_replay_do_not_double_credit(self):
        self.engine.credit(1000, 1060)
        self.engine.credit(1030, 1090)
        self.engine.credit(1000, 1060)
        self.assertEqual(self.engine.snapshot()["egg"]["seconds"], 90)

    def test_choices_never_offer_two_forms_from_the_same_family(self):
        self.engine.catalog[10001] = {**self.engine.catalog[1], "id": 10001}
        for _ in range(100):
            choices = self.engine._choices([])
            self.assertEqual(len({self.engine.catalog[i]["family"] for i in choices}), 3)

    def test_history_before_profile_never_hatches(self):
        self.engine.credit(0, 1000)
        self.assertEqual(self.engine.snapshot()["egg"]["seconds"], 0)

    def test_restart_preserves_choices_and_does_not_reaward_interval(self):
        choices = self.hatch()
        self.engine.close()
        self.engine = self.engine_class(self.path, CATALOG, now=9999)
        self.engine.credit(1000, 1120)
        self.assertEqual(self.engine.snapshot()["egg"]["choices"], choices)

    def test_refresh_does_not_collect_or_repeat_last_trio(self):
        previous = {p["id"] for p in self.hatch()}
        self.engine.command("refresh_choices", {})
        state = self.engine.snapshot()
        self.assertFalse(previous & {p["id"] for p in state["egg"]["choices"]})
        self.assertEqual(state["collection"], [])

    def test_cannot_adopt_a_species_not_in_the_choices(self):
        self.hatch()
        with self.assertRaisesRegex(ValueError, "choice"):
            self.engine.command("adopt", {"species_id": 144})

    def test_new_egg_preserves_companion_and_switch_preserves_egg(self):
        ident = self.adopt()
        self.engine.credit(1120, 1180)
        self.engine.command("new_egg", {})
        self.engine.credit(1180, 1220)
        self.engine.command("switch", {"id": ident})
        state = self.engine.snapshot()
        self.assertEqual(state["active"]["xp"], 60)
        self.assertEqual(state["egg"]["seconds"], 40)
        self.engine.command("new_egg", {})
        self.assertEqual(self.engine.snapshot()["egg"]["seconds"], 40)

    def test_daily_bonus_awarded_once_not_per_companion(self):
        self.adopt()
        self.engine.credit(1120, 1600)
        self.assertEqual(self.engine.snapshot()["active"]["xp"], 780)
        self.engine.credit(1600, 1660)
        self.assertEqual(self.engine.snapshot()["active"]["xp"], 840)

    def test_progression_reaches_100_and_does_not_force_retirement(self):
        ident = self.adopt()
        self.engine.credit(1120, 37120)
        state = self.engine.snapshot()
        self.assertEqual(state["active"]["level"], 100)
        self.assertEqual(state["active"]["id"], ident)
        self.assertIsNone(state["egg"])

    def test_evolution_preserves_identity_and_xp_and_requires_eligible_edge(self):
        self.hatch()
        for _ in range(10):
            if 1 in [x["id"] for x in self.engine.snapshot()["egg"]["choices"]]:
                break
            self.engine.command("refresh_choices", {})
        self.engine.command("adopt", {"species_id": 1})
        with self.assertRaisesRegex(ValueError, "requirement"):
            self.engine.command("evolve", {"species_id": 2})
        self.engine.credit(1120, 11120)
        before = self.engine.snapshot()["active"]
        self.engine.command("evolve", {"species_id": 2})
        after = self.engine.snapshot()["active"]
        self.assertEqual((after["id"], after["xp"]), (before["id"], before["xp"]))
        self.assertEqual(after["species"]["id"], 2)
        with self.assertRaisesRegex(ValueError, "evolution"):
            self.engine.command("evolve", {"species_id": 144})

    def test_preferences_persist_and_reject_invalid_volume(self):
        self.engine.command("settings", {"sound": False, "volume": 0.2})
        with self.assertRaisesRegex(ValueError, "volume"):
            self.engine.command("settings", {"volume": 10})
        self.engine.close()
        self.engine = self.engine_class(self.path, CATALOG, now=2000)
        self.assertFalse(self.engine.snapshot()["settings"]["sound"])
        self.assertEqual(self.engine.snapshot()["settings"]["volume"], 0.2)

    def test_unknown_action_does_not_change_save(self):
        before = json.dumps(self.engine.snapshot(), sort_keys=True)
        with self.assertRaisesRegex(ValueError, "Unknown"):
            self.engine.command("delete_everything", {})
        self.assertEqual(json.dumps(self.engine.snapshot(), sort_keys=True), before)

    def test_break_reminder_requires_fifty_active_minutes_and_resets_after_rest(self):
        self.adopt()
        self.engine.credit(1120, 3999)
        self.assertEqual(self.engine.care_events(3999), [])
        self.engine.credit(3999, 4000)
        self.assertEqual([e['kind'] for e in self.engine.care_events(4000)], ['break_reminder'])
        self.assertEqual(self.engine.care_events(4001), [])
        self.engine.observe_rest(4300)
        self.engine.credit(4300, 7300)
        self.assertEqual([e['kind'] for e in self.engine.care_events(7300)], ['break_reminder'])

    def test_saves_from_before_keepsakes_were_retired_drop_them(self):
        self.engine.state["finds"] = [{"day": "2026-09-27", "item": "Stardust"}]
        self.engine.state["settings"]["cosmetic_finds"] = True
        self.engine._save()
        self.engine.close()
        self.engine = self.engine_class(self.path, CATALOG, now=1790589700)
        self.assertNotIn("finds", self.engine.state)
        self.assertNotIn("cosmetic_finds", self.engine.state["settings"])
        with self.assertRaises(ValueError):
            self.engine.command("settings", {"cosmetic_finds": False})

    def test_disabled_break_reminders_do_not_emit_alerts(self):
        self.adopt()
        self.engine.command('settings', {'break_reminders': False})
        self.engine.credit(1120, 5120)
        self.assertEqual(self.engine.care_events(5120), [])

    def test_pokedex_records_unlock_time_and_level_without_erasing_previous_forms(self):
        self.hatch()
        for _ in range(10):
            if 1 in [x["id"] for x in self.engine.snapshot()["egg"]["choices"]]:
                break
            self.engine.command("refresh_choices", {})
        self.engine.command("adopt", {"species_id": 1})
        state = self.engine.snapshot()
        self.assertIn("pokedex", state, "Pocodex unlock history is missing")
        first = next(p for p in state["pokedex"] if p["species"]["id"] == 1)
        self.assertEqual(first["best_level"], 1)
        self.assertGreater(first["first_unlocked"], 0)
        self.engine.credit(1120, 11120)
        level = self.engine.snapshot()["active"]["level"]
        self.engine.command("evolve", {"species_id": 2})
        dex = {p["species"]["id"]: p for p in self.engine.snapshot()["pokedex"]}
        self.assertEqual(dex[1]["best_level"], level)
        self.assertEqual(dex[2]["best_level"], level)
        self.assertEqual(dex[2]["unlocks"][0]["reason"], "evolution")


if __name__ == "__main__":
    unittest.main()


class AdversarialCommands(unittest.TestCase):
    setUp, tearDown, hatch = CompanionContracts.setUp, CompanionContracts.tearDown, CompanionContracts.hatch

    def test_boolean_species_ids_are_rejected_not_read_as_bulbasaur(self):
        choices = [c["id"] for c in self.hatch()]
        self.engine.state["egg"]["choices"] = [1, *choices[1:]]
        with self.assertRaises(ValueError):
            self.engine.command("adopt", {"species_id": True})
        with self.assertRaises(ValueError):
            self.engine.command("encounter", {"species_id": True})
        self.assertEqual(self.engine.snapshot()["collection"], [])


class LevelUpContracts(unittest.TestCase):
    setUp, tearDown, hatch = CompanionContracts.setUp, CompanionContracts.tearDown, CompanionContracts.hatch

    def adopt_first(self):
        choice = self.hatch()[0]["id"]
        self.engine.command("adopt", {"species_id": choice})
        self.engine.drain_events()
        return choice

    def test_level_ups_are_announced_once_with_the_berry_earned(self):
        self.adopt_first()
        self.engine.credit(1120, 1400)
        events = self.engine.drain_events()
        levels = [e for e in events if e["kind"] == "level_up"]
        self.assertTrue(levels)
        self.assertEqual(levels[-1]["level"], self.engine.snapshot()["active"]["level"])
        self.assertEqual(sum(e["berries"] for e in levels), self.engine.state["berries"])
        self.assertEqual(self.engine.drain_events(), [])
        self.assertEqual(len({e["id"] for e in levels}), len(levels))

    def test_evolution_readiness_is_announced_once(self):
        self.engine.credit(1000, 1120)
        self.engine.state["egg"]["choices"] = [1]
        self.engine.command("adopt", {"species_id": 1})
        self.engine.drain_events()
        self.engine.credit(1120, 1120 + 3000)
        ready = [e for e in self.engine.drain_events() if e["kind"] == "evolution_ready"]
        self.assertEqual([e["to"] for e in ready], ["Ivysaur"])
        self.engine.credit(4120, 4200)
        self.assertEqual([e for e in self.engine.drain_events() if e["kind"] == "evolution_ready"], [])


class PerAppGrowth(unittest.TestCase):
    setUp, tearDown, hatch = CompanionContracts.setUp, CompanionContracts.tearDown, CompanionContracts.hatch

    def adopted(self):
        self.hatch()
        self.engine.state["egg"]["choices"] = [1]
        self.engine.command("adopt", {"species_id": 1})
        return self.engine.snapshot()["active"]

    def test_two_apps_working_at_once_earn_twice_but_count_human_time_once(self):
        xp = self.adopted()["xp"]
        self.engine.credit(1200, 1260, "codex")
        self.engine.credit(1200, 1260, "claude")
        active = self.engine.snapshot()["active"]
        self.assertEqual(active["xp"] - xp, 120)
        self.assertEqual(active["active_by_app"], {"codex": 60, "claude": 60})
        today = next(iter(self.engine.state["daily"].values()))
        self.assertEqual(today["seconds"], 120 + 60)  # egg incubation + one shared minute

    def test_each_app_is_deduplicated_on_its_own(self):
        self.adopted()
        self.engine.credit(1200, 1260, "claude")
        xp = self.engine.snapshot()["active"]["xp"]
        self.engine.credit(1230, 1260, "claude")
        self.assertEqual(self.engine.snapshot()["active"]["xp"], xp)

    def test_unknown_app_is_rejected(self):
        with self.assertRaises(ValueError):
            self.engine.credit(1000, 1010, "copilot")

    def test_old_scalar_watermark_migrates_to_codex_without_backpay(self):
        self.adopted()
        self.engine.state["credited_until"] = 5000
        self.engine.state.pop("present_until", None)
        for individual in self.engine.state["collection"]:
            individual.pop("active_by_app", None)
        self.engine._save()
        self.engine.close()
        self.engine = self.engine_class(self.path, CATALOG, now=6000)
        self.assertEqual(self.engine.state["credited_until"], {"codex": 5000})
        self.assertEqual(self.engine.state["present_until"], 5000)
        self.assertEqual(self.engine.snapshot()["active"]["active_by_app"], {"codex": 0})
