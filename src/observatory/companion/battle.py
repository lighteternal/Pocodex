"""One-on-one wild battles: type chart, stats, damage and catching, following the games' published formulas.

Simplifications are deliberate and listed here so nothing is silently wrong: no status conditions, stat
stages, abilities, held items or weather; IVs are a fixed 20 and EVs zero; moves the data script cannot
model honestly (two-turn, recharge, conditional, self-KO) are excluded before they reach this module.
"""

import math
import random

TYPES = ("normal", "fire", "water", "electric", "grass", "ice", "fighting", "poison", "ground",
         "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark", "steel", "fairy")
# Attacking type -> {defending type: multiplier}; every pair not listed is neutral (Gen 6+ chart).
CHART = {
    "normal": {"rock": .5, "ghost": 0, "steel": .5},
    "fire": {"fire": .5, "water": .5, "grass": 2, "ice": 2, "bug": 2, "rock": .5, "dragon": .5, "steel": 2},
    "water": {"fire": 2, "water": .5, "grass": .5, "ground": 2, "rock": 2, "dragon": .5},
    "electric": {"water": 2, "electric": .5, "grass": .5, "ground": 0, "flying": 2, "dragon": .5},
    "grass": {"fire": .5, "water": 2, "grass": .5, "poison": .5, "ground": 2, "flying": .5, "bug": .5, "rock": 2, "dragon": .5, "steel": .5},
    "ice": {"fire": .5, "water": .5, "grass": 2, "ice": .5, "ground": 2, "flying": 2, "dragon": 2, "steel": .5},
    "fighting": {"normal": 2, "ice": 2, "poison": .5, "flying": .5, "psychic": .5, "bug": .5, "rock": 2, "ghost": 0, "dark": 2, "steel": 2, "fairy": .5},
    "poison": {"grass": 2, "poison": .5, "ground": .5, "rock": .5, "ghost": .5, "steel": 0, "fairy": 2},
    "ground": {"fire": 2, "electric": 2, "grass": .5, "poison": 2, "flying": 0, "bug": .5, "rock": 2, "steel": 2},
    "flying": {"electric": .5, "grass": 2, "fighting": 2, "bug": 2, "rock": .5, "steel": .5},
    "psychic": {"fighting": 2, "poison": 2, "psychic": .5, "dark": 0, "steel": .5},
    "bug": {"fire": .5, "grass": 2, "fighting": .5, "poison": .5, "flying": .5, "psychic": 2, "ghost": .5, "dark": 2, "steel": .5, "fairy": .5},
    "rock": {"fire": 2, "ice": 2, "fighting": .5, "ground": .5, "flying": 2, "bug": 2, "steel": .5},
    "ghost": {"normal": 0, "psychic": 2, "ghost": 2, "dark": .5},
    "dragon": {"dragon": 2, "steel": .5, "fairy": 0},
    "dark": {"fighting": .5, "psychic": 2, "ghost": 2, "dark": .5, "fairy": .5},
    "steel": {"fire": .5, "water": .5, "electric": .5, "ice": 2, "rock": 2, "steel": .5, "fairy": 2},
    "fairy": {"fire": .5, "fighting": 2, "poison": .5, "dragon": 2, "dark": 2, "steel": .5},
}
CRIT_CHANCE = (1 / 24, 1 / 8, 1 / 2, 1)  # Gen 7+ critical-hit stages.
IV = 20
STAT_KEYS = ("hp", "attack", "defense", "sp_attack", "sp_defense", "speed")


def effectiveness(attack: str, defenders: list[str]) -> float:
    multiplier = 1.0
    for defend in defenders:
        multiplier *= CHART.get(attack, {}).get(defend, 1)
    return int(multiplier) if multiplier in (0, 1, 2, 4) else multiplier


def stats(base: list[int], level: int) -> dict:
    """Gen 3+ stat formula with a fixed IV and no EVs."""
    hp = (2 * base[0] + IV) * level // 100 + level + 10
    others = [(2 * value + IV) * level // 100 + 5 for value in base[1:]]
    return dict(zip(STAT_KEYS, [hp, *others]))


def moves_at(learnset: list, level: int) -> list[str]:
    """The last four damaging moves learned by this level, like a Pokémon that never forgot one; else Struggle."""
    known: list[str] = []
    for name, learned in learnset:
        if learned <= level:
            if name in known:
                known.remove(name)
            known.append(name)
    return known[-4:] or ["struggle"]


def fighter(species: dict, data: dict, level: int, moves: list[str]) -> dict:
    values = stats(data["stats"], level)
    return {"id": species["id"], "name": species["name"], "types": list(species.get("types") or ["normal"]), "level": level,
            "stats": values, "max_hp": values["hp"], "hp": values["hp"], "moves": moves}


def _hits(move: dict, rng: random.Random) -> int:
    low, high = move.get("hits") or (1, 1)
    if low == high:
        return low
    roll = rng.random()  # Gen 5+ distribution for 2-5 hit moves.
    return 2 if roll < .35 else 3 if roll < .70 else 4 if roll < .85 else 5


def hit(attacker: dict, defender: dict, move: dict, rng: random.Random, moves: dict | None = None) -> dict:
    """Resolve one move and apply it to both fighters. Returns what happened, for the log and the animation."""
    effect = effectiveness(move["type"], defender["types"])
    result = {"move": move["name"], "type": move["type"], "class": move["class"], "damage": 0, "effect": effect,
              "crit": False, "miss": False, "hits": 0, "heal": 0, "recoil": 0}
    if move.get("accuracy") is not None and rng.random() * 100 >= move["accuracy"]:
        result["miss"] = True
        return result
    if effect == 0:
        return result
    physical = move["class"] == "physical"
    attack = attacker["stats"]["attack" if physical else "sp_attack"]
    defense = max(1, defender["stats"]["defense" if physical else "sp_defense"])
    crit = rng.random() < CRIT_CHANCE[min(move.get("crit", 0), 3)]
    hits = _hits(move, rng)
    per = ((2 * attacker["level"] // 5 + 2) * move["power"] * attack // defense) // 50 + 2
    if crit:
        per = per * 3 // 2
    per = per * rng.randint(85, 100) // 100
    if move["type"] in attacker["types"]:
        per = per * 3 // 2
    per = max(1, int(per * effect))
    damage = min(defender["hp"], per * hits)
    defender["hp"] -= damage
    result.update(damage=damage, crit=crit, hits=hits)
    if move["name"] == "Struggle":
        recoil = attacker["max_hp"] // 4
    elif move.get("drain", 0) < 0:
        recoil = max(1, damage * -move["drain"] // 100)
    else:
        recoil = 0
    if move.get("drain", 0) > 0 and damage:
        result["heal"] = min(attacker["max_hp"] - attacker["hp"], max(1, damage * move["drain"] // 100))
        attacker["hp"] += result["heal"]
    if recoil:
        result["recoil"] = min(attacker["hp"], recoil)
        attacker["hp"] -= result["recoil"]
    return result


def order(ally: dict, ally_move: dict, wild: dict, wild_move: dict, rng: random.Random) -> list[str]:
    ally_key = (ally_move.get("priority", 0), ally["stats"]["speed"])
    wild_key = (wild_move.get("priority", 0), wild["stats"]["speed"])
    if ally_key == wild_key:
        return ["ally", "wild"] if rng.random() < .5 else ["wild", "ally"]
    return ["ally", "wild"] if ally_key > wild_key else ["wild", "ally"]


def _expected(attacker: dict, defender: dict, move: dict) -> float:
    stab = 1.5 if move["type"] in attacker["types"] else 1
    hits = sum(move["hits"]) / 2 if move.get("hits") else 1
    return move["power"] * stab * hits * effectiveness(move["type"], defender["types"]) * (move.get("accuracy") or 100) / 100


def wild_move(wild: dict, target: dict, rng: random.Random, moves: dict) -> str:
    """Wild Pokémon mostly pick their strongest move against you, but not always."""
    if rng.random() < .8:
        return max(wild["moves"], key=lambda name: _expected(wild, target, moves[name]))
    return rng.choice(wild["moves"])


def best_move(ally: dict, wild: dict, moves: dict) -> str:
    return max(ally["moves"], key=lambda name: _expected(ally, wild, moves[name]))


def throw(target: dict, capture: int, rng: random.Random) -> dict:
    """Gen 3 capture: a catch value from HP and catch rate, then four shake checks; three wobbles are shown."""
    maximum, current = target["max_hp"], max(1, target["hp"])
    a = max(1, (3 * maximum - 2 * current) * capture // (3 * maximum))
    if a >= 255:
        return {"caught": True, "shakes": 3}
    b = 1048560 // int(math.sqrt(int(math.sqrt(16711680 // a))))
    successes = 0
    while successes < 4 and rng.randint(0, 65535) < b:
        successes += 1
    return {"caught": successes == 4, "shakes": min(successes, 3)}


def gates(catalog: dict) -> dict:
    """Lowest level a form appears in the wild: base forms at once, evolved forms from their evolution level.

    Item, trade and friendship evolutions have no level, so their forms appear from level 30.
    """
    parents = {}
    for species in catalog.values():
        for edge in species.get("evolutions", []):
            level = edge.get("min_level", 1)
            parents[edge["to"]] = (species["id"], level if level > 1 else 30)
    result: dict = {}

    def gate(ident, chain=()):
        if ident not in result:
            parent = parents.get(ident)
            result[ident] = 0 if not parent or ident in chain else max(parent[1], gate(parent[0], chain + (ident,)))
        return result[ident]

    for ident in catalog:
        gate(ident)
    return result


def wild_species(catalog: dict, data: dict, level: int, rng: random.Random) -> int:
    """Base forms are three times as common as evolved ones; legendaries never appear in the grass."""
    levels = gates(catalog)
    pool = [(ident, 3 if levels[ident] == 0 else 1) for ident, species in catalog.items()
            if not species.get("legendary") and str(ident) in data["species"] and levels[ident] <= level]
    idents, weights = zip(*pool)
    return rng.choices(idents, weights)[0]


def _side(catalog: dict, data: dict, ident: int, level: int) -> dict:
    entry = data["species"][str(ident)]
    return fighter(catalog[ident], entry, level, moves_at(entry["learnset"], level))


def start(partner: dict, level: int, catalog: dict, data: dict, rng: random.Random, ident: str) -> dict:
    wild_level = max(2, min(100, level + rng.randint(-3, 1)))
    wild_id = wild_species(catalog, data, wild_level, rng)
    wild = _side(catalog, data, wild_id, wild_level)
    wild["capture"] = data["species"][str(wild_id)]["capture"]
    ally = _side(catalog, data, partner["species_id"], level)
    ally["individual"] = partner["id"]
    return {"id": ident, "wild": wild, "ally": ally, "turn": 0, "over": None,
            "steps": [{"t": "appear", "who": "wild"}, {"t": "send", "who": "ally"}]}


def _strike(state: dict, who: str, name: str, moves: dict, rng: random.Random, steps: list) -> None:
    attacker, target = (state["ally"], state["wild"]) if who == "ally" else (state["wild"], state["ally"])
    if attacker["hp"] <= 0 or target["hp"] <= 0:
        return
    result = hit(attacker, target, moves[name], rng, moves)
    steps.append({"t": "move", "who": who, "id": name, **result, "target_hp": target["hp"], "user_hp": attacker["hp"]})
    for side, body in (("wild" if who == "ally" else "ally", target), (who, attacker)):
        if body["hp"] <= 0 and not any(s["t"] == "faint" and s["who"] == side for s in steps):
            steps.append({"t": "faint", "who": side})


def act(state: dict, action: dict, data: dict, rng: random.Random) -> list:
    """Resolve one turn. The caller checks and spends Poké Balls; this only plays the turn out."""
    moves, ally, wild = data["moves"], state["ally"], state["wild"]
    kind, steps = action.get("action"), []
    if kind == "run":
        steps.append({"t": "run"})
        state["over"] = "ran"
    elif kind in ("move", "auto"):
        name = best_move(ally, wild, moves) if kind == "auto" else action.get("move")
        if name not in ally["moves"]:
            raise ValueError("Your partner doesn't know that move")
        foe = wild_move(wild, ally, rng, moves)
        for who in order(ally, moves[name], wild, moves[foe], rng):
            _strike(state, who, name if who == "ally" else foe, moves, rng, steps)
    elif kind == "ball":
        caught = throw(wild, wild["capture"], rng)
        steps.append({"t": "ball", **caught})
        if caught["caught"]:
            state["over"] = "caught"
        else:
            _strike(state, "wild", wild_move(wild, ally, rng, moves), moves, rng, steps)
    else:
        raise ValueError("Choose Fight, Bag, Run or Auto")
    if not state["over"]:
        state["over"] = "won" if wild["hp"] <= 0 else "lost" if ally["hp"] <= 0 else None
    state["turn"] += 1
    state["steps"] = steps
    return steps
