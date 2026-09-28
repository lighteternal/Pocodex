"""Wild battles, catching, badges and the Trainer Card, against a real on-disk save."""

import random
import tempfile
import unittest
from pathlib import Path

from observatory.companion.engine import THRESHOLDS, Companion

CATALOG = {"species": [
    {"id": 1, "name": "Bulbasaur", "family": 1, "starter": True, "types": ["grass", "poison"], "evolutions": [{"to": 2, "min_level": 16, "active_seconds": 0, "requirement": "Level 16"}]},
    {"id": 2, "name": "Ivysaur", "family": 1, "starter": False, "types": ["grass", "poison"], "evolutions": []},
    {"id": 4, "name": "Charmander", "family": 4, "starter": True, "types": ["fire"], "evolutions": []},
    {"id": 7, "name": "Squirtle", "family": 7, "starter": True, "types": ["water"], "evolutions": []},
    {"id": 25, "name": "Pikachu", "family": 25, "starter": True, "types": ["electric"], "evolutions": []},
    {"id": 144, "name": "Articuno", "family": 144, "starter": False, "legendary": True, "types": ["ice", "flying"], "evolutions": []},
]}
MOVE = lambda name, kind, power=40: {"name": name, "type": kind, "power": power, "accuracy": 100, "class": "physical", "priority": 0}
BATTLE = {"moves": {"tackle": MOVE("Tackle", "normal"), "vine-whip": MOVE("Vine Whip", "grass", 45), "ember": MOVE("Ember", "fire"),
                    "water-gun": MOVE("Water Gun", "water"), "thunder-shock": MOVE("Thunder Shock", "electric"),
                    "struggle": {**MOVE("Struggle", "normal", 50), "accuracy": None}, "gust": MOVE("Gust", "flying")},
          "species": {str(i): {"stats": [45, 49, 49, 65, 65, 45], "capture": 255 if i == 7 else 45, "experience": 64, "learnset": moves}
                      for i, moves in [(1, [["tackle", 1], ["vine-whip", 7]]), (2, [["tackle", 1], ["vine-whip", 1]]), (4, [["ember", 1]]),
                                       (7, [["water-gun", 1]]), (25, [["thunder-shock", 1]]), (144, [["gust", 1]])]}}


class Adventure(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "companion.sqlite"
        self.engine = self.open()
        self.engine.credit(1000, 1120)
        self.engine.state["egg"]["choices"] = [1]
        self.engine.command("adopt", {"species_id": 1})
        self.engine.credit(1120, 1120 + 2000)  # a few levels, ready to battle
        self.engine.drain_events()

    def open(self, seed=11):
        return Companion(self.path, CATALOG, now=1000, rng=random.Random(seed), battle_data=BATTLE)

    def tearDown(self):
        self.engine.close()
        self.temp.cleanup()

    def battle(self):
        return self.engine.snapshot()["battle"]

    def finish(self, action):
        for _ in range(60):
            if self.battle()["over"]:
                return self.battle()["over"]
            self.engine.command("battle_act", action)
        self.fail("battle never ended")

    def test_a_wild_encounter_starts_near_your_level_and_is_seen(self):
        ally = self.engine.snapshot()["active"]
        self.engine.command("battle_start", {})
        wild = self.battle()["wild"]
        self.assertNotEqual(wild["id"], 144)  # legendaries are never wild
        self.assertLessEqual(abs(wild["level"] - ally["level"]), 3)
        self.assertIn(wild["id"], self.engine.snapshot()["seen"])
        self.assertEqual([s["t"] for s in self.battle()["steps"]], ["appear", "send"])
        self.assertEqual(self.engine.snapshot()["battles_left"], 4)

    def test_turns_resolve_until_someone_faints_and_winning_pays(self):
        before = self.engine.snapshot()
        self.engine.command("battle_start", {})
        self.engine.command("battle_act", {"action": "move", "move": self.battle()["ally"]["moves"][0]})
        kinds = [s["t"] for s in self.battle()["steps"]]
        self.assertIn("move", kinds)
        result = self.finish({"action": "auto"})
        after = self.engine.snapshot()
        if result == "won":
            self.assertGreater(after["active"]["xp"], before["active"]["xp"])
            self.assertEqual(after["balls"], before["balls"] + 1)
            self.assertEqual(after["stats"]["battles_won"], 1)
        else:
            self.assertEqual(result, "lost")
            self.assertEqual(after["stats"]["battles_lost"], 1)
        self.assertIn("reward", [s["t"] for s in self.battle()["steps"]])

    def test_unknown_or_unlearned_moves_are_refused_without_changing_the_save(self):
        self.engine.command("battle_start", {})
        saved = self.battle()
        for action in ({"action": "move", "move": "hyper-beam"}, {"action": "dance"}, {"action": "move"}):
            with self.assertRaises(ValueError):
                self.engine.command("battle_act", action)
        self.assertEqual(self.battle(), saved)

    def test_running_away_ends_without_reward(self):
        xp = self.engine.snapshot()["active"]["xp"]
        self.engine.command("battle_start", {})
        self.engine.command("battle_act", {"action": "run"})
        self.assertEqual(self.battle()["over"], "ran")
        self.assertEqual(self.engine.snapshot()["active"]["xp"], xp)
        self.engine.command("battle_close", {})
        self.assertIsNone(self.battle())

    def test_catching_adds_a_pokemon_at_its_level_without_replacing_your_partner(self):
        partner = self.engine.state["active_id"]
        for attempt in range(40):
            self.engine.command("battle_start", {}) if not self.battle() else None
            if self.battle()["wild"]["id"] == 7:
                break
            self.engine.command("battle_act", {"action": "run"})
            self.engine.command("battle_close", {})
            self.engine.state["battles"] = {}  # the daily limit is tested elsewhere
        self.assertEqual(self.battle()["wild"]["id"], 7, "a catch-rate 255 Squirtle should appear")
        # Even an easy catch at full HP can break free (Gen 3 formula); weaken it first, as in the games.
        self.engine.state["battle"]["wild"]["hp"] = 1
        self.engine.state["battle"]["ally"]["hp"] = 10 ** 6  # the wild's counterattacks can't end this test early
        balls, throws = self.engine.snapshot()["balls"], 0
        while not self.battle()["over"] and throws < 5:
            self.engine.command("battle_act", {"action": "ball"})
            throws += 1
        self.assertEqual(self.battle()["over"], "caught")
        balls -= throws
        snap = self.engine.snapshot()
        caught = [p for p in snap["collection"] if p["species_id"] == 7]
        self.assertEqual(len(caught), 1)
        self.assertEqual(caught[0]["level"], self.battle()["wild"]["level"])
        self.assertEqual(caught[0]["unlocks"][0]["reason"], "caught")
        self.assertEqual(self.engine.state["active_id"], partner)
        self.assertEqual((snap["balls"], snap["stats"]["caught"]), (balls + 1, 1))  # thrown balls spent, one earned

    def test_no_balls_no_throw(self):
        self.engine.state["balls"] = 0
        self.engine.command("battle_start", {})
        with self.assertRaises(ValueError):
            self.engine.command("battle_act", {"action": "ball"})

    def test_five_battles_a_day_keep_it_a_break(self):
        for _ in range(5):
            self.engine.command("battle_start", {})
            self.engine.command("battle_act", {"action": "run"})
            self.engine.command("battle_close", {})
        self.assertEqual(self.engine.snapshot()["battles_left"], 0)
        with self.assertRaises(ValueError):
            self.engine.command("battle_start", {})

    def test_one_battle_at_a_time_and_it_survives_a_restart(self):
        self.engine.command("battle_start", {})
        with self.assertRaises(ValueError):
            self.engine.command("battle_start", {})
        wild = self.battle()["wild"]
        self.engine.close()
        self.engine = self.open(seed=99)
        self.assertEqual(self.battle()["wild"], wild)

    def test_battles_need_a_partner_and_data(self):
        self.engine.command("new_egg", {})
        with self.assertRaises(ValueError):
            self.engine.command("battle_start", {})

    def test_a_partner_missing_from_the_battle_data_is_refused_not_crashed(self):
        self.engine.battle_data = {**BATTLE, "species": {k: v for k, v in BATTLE["species"].items() if k != "1"}}
        with self.assertRaisesRegex(ValueError, "cannot battle"):
            self.engine.command("battle_start", {})
        self.assertIsNone(self.battle())


class Badges(unittest.TestCase):
    setUp, tearDown, open = Adventure.setUp, Adventure.tearDown, Adventure.open

    def test_first_hatch_earns_the_boulder_badge_once(self):
        badges = {b["id"]: b for b in self.engine.snapshot()["badges"]}
        self.assertTrue(badges["boulder"]["earned"])
        self.assertFalse(badges["cascade"]["earned"])
        self.assertEqual(len(badges), 8)
        self.engine.credit(3200, 3300)
        self.assertEqual([e for e in self.engine.drain_events() if e["kind"] == "badge"], [])

    def test_answers_unlock_the_cascade_badge_with_an_event(self):
        self.engine.record_answers(24)
        self.assertEqual([e for e in self.engine.drain_events() if e["kind"] == "badge"], [])
        self.engine.record_answers(1)
        events = [e for e in self.engine.drain_events() if e["kind"] == "badge"]
        self.assertEqual([(e["badge"], e["name"]) for e in events], [("cascade", "Cascade Badge")])
        self.assertEqual(self.engine.snapshot()["stats"]["answers"], 25)

    def test_marsh_badge_needs_both_apps(self):
        self.engine.credit(3200, 3300, "codex")
        self.assertFalse({b["id"]: b for b in self.engine.snapshot()["badges"]}["marsh"]["earned"])
        self.engine.credit(3200, 3300, "claude")
        self.assertTrue({b["id"]: b for b in self.engine.snapshot()["badges"]}["marsh"]["earned"])

    def test_streak_counts_consecutive_days_with_ten_minutes(self):
        for day in range(1, 8):
            self.engine.state["daily"][f"2026-09-{day:02d}"] = {"seconds": 700, "bonus": True}
        self.engine.state["daily"]["2026-09-04"]["seconds"] = 100
        self.assertEqual(self.engine.snapshot()["stats"]["best_streak"], 3)
        self.engine.state["daily"]["2026-09-04"]["seconds"] = 900
        self.assertEqual(self.engine.snapshot()["stats"]["best_streak"], 7)


class Trainer(unittest.TestCase):
    setUp, tearDown, open = Adventure.setUp, Adventure.tearDown, Adventure.open

    def test_id_is_stable_and_name_is_validated(self):
        trainer = self.engine.snapshot()["trainer"]
        self.assertTrue(10000 <= trainer["id"] <= 99999)
        self.engine.command("trainer", {"name": "  Red  "})
        self.assertEqual(self.engine.snapshot()["trainer"]["name"], "Red")
        for bad in ("", " ", "x" * 13, 7, "line\nbreak"):
            with self.assertRaises(ValueError):
                self.engine.command("trainer", {"name": bad})
        self.engine.close()
        self.engine = self.open(seed=5)
        self.assertEqual(self.engine.snapshot()["trainer"], {**trainer, "name": "Red"})

    def test_existing_saves_start_with_five_balls_and_hours_per_app(self):
        snap = self.engine.snapshot()
        self.assertEqual(snap["balls"], 5)
        self.assertIn("codex", snap["stats"]["seconds_by_app"])


if __name__ == "__main__":
    unittest.main()


class BattleMenu(unittest.TestCase):
    setUp, tearDown, open, battle = Adventure.setUp, Adventure.tearDown, Adventure.open, Adventure.battle

    def test_menu_moves_carry_their_matchup_against_the_wild_pokemon(self):
        self.engine.command("battle_start", {})
        fight = self.battle()
        self.assertEqual([m["id"] for m in fight["moves"]], fight["ally"]["moves"])
        for move in fight["moves"]:
            self.assertIn(move["effect"], (0, 0.25, 0.5, 1, 2, 4))
            self.assertTrue(move["name"] and move["type"] and move["power"])
