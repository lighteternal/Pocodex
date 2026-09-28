"""Battle rules: the type chart, stats, damage, move choice and catching, checked against the games' formulas."""

import random
import unittest

from observatory.companion import battle

MOVES = {
    "tackle": {"name": "Tackle", "type": "normal", "power": 40, "accuracy": 100, "class": "physical", "priority": 0},
    "ember": {"name": "Ember", "type": "fire", "power": 40, "accuracy": 100, "class": "special", "priority": 0},
    "water-gun": {"name": "Water Gun", "type": "water", "power": 40, "accuracy": 100, "class": "special", "priority": 0},
    "quick-attack": {"name": "Quick Attack", "type": "normal", "power": 40, "accuracy": 100, "class": "physical", "priority": 1},
    "fury-attack": {"name": "Fury Attack", "type": "normal", "power": 15, "accuracy": 85, "class": "physical", "priority": 0, "hits": [2, 5]},
    "giga-drain": {"name": "Giga Drain", "type": "grass", "power": 75, "accuracy": 100, "class": "special", "priority": 0, "drain": 50},
    "flare-blitz": {"name": "Flare Blitz", "type": "fire", "power": 120, "accuracy": 100, "class": "physical", "priority": 0, "drain": -33},
    "swift": {"name": "Swift", "type": "normal", "power": 60, "accuracy": None, "class": "special", "priority": 0},
    "struggle": {"name": "Struggle", "type": "normal", "power": 50, "accuracy": None, "class": "physical", "priority": 0},
    "thunder-shock": {"name": "Thunder Shock", "type": "electric", "power": 40, "accuracy": 100, "class": "special", "priority": 0},
    "lick": {"name": "Lick", "type": "ghost", "power": 30, "accuracy": 100, "class": "physical", "priority": 0},
}


def fighter(types, level=20, stats=(50, 50, 50, 50, 50, 50), moves=("tackle",), name="Test"):
    return battle.fighter({"id": 1, "name": name, "types": list(types)}, {"stats": list(stats)}, level, list(moves))


class TypeChart(unittest.TestCase):
    def test_canonical_matchups(self):
        self.assertEqual(battle.effectiveness("water", ["fire"]), 2)
        self.assertEqual(battle.effectiveness("fire", ["water"]), 0.5)
        self.assertEqual(battle.effectiveness("electric", ["ground"]), 0)
        self.assertEqual(battle.effectiveness("normal", ["ghost"]), 0)
        self.assertEqual(battle.effectiveness("ghost", ["normal"]), 0)
        self.assertEqual(battle.effectiveness("dragon", ["fairy"]), 0)
        self.assertEqual(battle.effectiveness("fighting", ["dark", "steel"]), 4)
        self.assertEqual(battle.effectiveness("ice", ["grass", "flying"]), 4)
        self.assertEqual(battle.effectiveness("electric", ["water", "ground"]), 0)
        self.assertEqual(battle.effectiveness("grass", ["water", "ground"]), 4)
        self.assertEqual(battle.effectiveness("normal", ["normal"]), 1)

    def test_every_attacking_type_is_known(self):
        for attack in battle.TYPES:
            for defend in battle.TYPES:
                self.assertIn(battle.effectiveness(attack, [defend]), (0, 0.5, 1, 2))


class Stats(unittest.TestCase):
    def test_stats_follow_the_game_formula(self):
        # Pikachu, Lv. 50, fixed IV 20, no EVs.
        pikachu = battle.stats([35, 55, 40, 50, 50, 90], 50)
        self.assertEqual(pikachu, {"hp": 105, "attack": 70, "defense": 55, "sp_attack": 65, "sp_defense": 65, "speed": 105})

    def test_moves_are_the_last_four_learned_so_far(self):
        learnset = [["thunder-shock", 1], ["quick-attack", 1], ["nuzzle", 1], ["feint", 16], ["spark", 20], ["iron-tail", 28]]
        self.assertEqual(battle.moves_at(learnset, 21), ["quick-attack", "nuzzle", "feint", "spark"])
        self.assertEqual(battle.moves_at(learnset, 1), ["thunder-shock", "quick-attack", "nuzzle"])
        self.assertEqual(battle.moves_at([["tackle", 15]], 5), ["struggle"])
        self.assertEqual(battle.moves_at([], 50), ["struggle"])
        self.assertEqual(battle.moves_at([["air-slash", 0], ["ember", 1]], 36), ["air-slash", "ember"])


class Damage(unittest.TestCase):
    def rng(self, *values):
        stream = iter(values)
        class Fixed(random.Random):
            def random(self_inner):
                return next(stream)
            def randint(self_inner, a, b):
                return b
        return Fixed()

    def test_stab_and_super_effective_multiply(self):
        charmander = fighter(["fire"], moves=["ember"])
        bulbasaur = fighter(["grass", "poison"])
        plain = fighter(["normal"])
        hot = battle.hit(charmander, bulbasaur, MOVES["ember"], random.Random(1), MOVES)
        cool = battle.hit(charmander, plain, MOVES["ember"], random.Random(1), MOVES)
        self.assertEqual(hot["effect"], 2)
        self.assertGreater(hot["damage"], cool["damage"] * 1.7)

    def test_immunity_deals_nothing_and_says_so(self):
        result = battle.hit(fighter(["electric"]), fighter(["ground"]), MOVES["thunder-shock"], random.Random(3), MOVES)
        self.assertEqual((result["damage"], result["effect"]), (0, 0))

    def test_accuracy_can_miss_but_never_misses_swift(self):
        attacker, target = fighter(["normal"]), fighter(["normal"])
        misses = sum(battle.hit(attacker, target, MOVES["fury-attack"], random.Random(seed), MOVES)["miss"] for seed in range(400))
        self.assertTrue(20 < misses < 110)
        self.assertFalse(any(battle.hit(attacker, target, MOVES["swift"], random.Random(seed), MOVES)["miss"] for seed in range(200)))

    def test_multi_hit_counts_hits(self):
        hits = {battle.hit(fighter(["normal"]), fighter(["normal"]), {**MOVES["fury-attack"], "accuracy": None}, random.Random(seed), MOVES)["hits"] for seed in range(300)}
        self.assertEqual(hits, {2, 3, 4, 5})

    def test_drain_heals_and_recoil_hurts(self):
        user = fighter(["grass"], level=40)
        user["hp"] = 10
        result = battle.hit(user, fighter(["water"]), MOVES["giga-drain"], random.Random(2), MOVES)
        self.assertGreater(result["heal"], 0)
        blitz = battle.hit(fighter(["fire"], level=40), fighter(["grass"]), MOVES["flare-blitz"], random.Random(2), MOVES)
        self.assertGreater(blitz["recoil"], 0)

    def test_struggle_costs_a_quarter_of_max_hp(self):
        user = fighter(["normal"])
        result = battle.hit(user, fighter(["normal"]), MOVES["struggle"], random.Random(4), MOVES)
        self.assertEqual(result["recoil"], user["max_hp"] // 4)

    def test_damage_never_exceeds_remaining_hp(self):
        target = fighter(["grass"], level=5)
        result = battle.hit(fighter(["fire"], level=100, stats=(100, 150, 100, 150, 100, 100)), target, MOVES["flare-blitz"], random.Random(5), MOVES)
        self.assertEqual(result["damage"], target["max_hp"])


class Turns(unittest.TestCase):
    def test_priority_then_speed_decides_who_moves_first(self):
        fast = fighter(["normal"], stats=(50, 50, 50, 50, 50, 120))
        slow = fighter(["normal"], stats=(50, 50, 50, 50, 50, 20))
        self.assertEqual(battle.order(fast, MOVES["tackle"], slow, MOVES["tackle"], random.Random(1)), ["ally", "wild"])
        self.assertEqual(battle.order(slow, MOVES["quick-attack"], fast, MOVES["tackle"], random.Random(1)), ["ally", "wild"])
        self.assertEqual(battle.order(slow, MOVES["tackle"], fast, MOVES["tackle"], random.Random(1)), ["wild", "ally"])

    def test_wild_prefers_its_most_damaging_move(self):
        wild = fighter(["water"], moves=["tackle", "water-gun"])
        target = fighter(["fire"])
        picks = [battle.wild_move(wild, target, random.Random(seed), MOVES) for seed in range(200)]
        self.assertGreater(picks.count("water-gun"), 150)


class Catching(unittest.TestCase):
    def test_weaker_and_easier_pokemon_are_likelier_caught(self):
        def rate(hp_fraction, capture):
            caught = 0
            for seed in range(600):
                target = fighter(["normal"], level=10)
                target["hp"] = max(1, int(target["max_hp"] * hp_fraction))
                caught += battle.throw(target, capture, random.Random(seed))["caught"]
            return caught / 600
        self.assertGreater(rate(0.05, 190), rate(1, 190))
        self.assertGreater(rate(0.5, 255), rate(0.5, 45))
        self.assertLess(rate(1, 3), 0.05)

    def test_a_catch_reports_its_wobbles(self):
        results = [battle.throw(fighter(["normal"]), 45, random.Random(seed)) for seed in range(200)]
        self.assertTrue(all(0 <= r["shakes"] <= 3 for r in results))
        self.assertTrue(all(r["shakes"] == 3 for r in results if r["caught"]))
        self.assertEqual({r["shakes"] for r in results if not r["caught"]} - {0, 1, 2, 3}, set())


if __name__ == "__main__":
    unittest.main()
