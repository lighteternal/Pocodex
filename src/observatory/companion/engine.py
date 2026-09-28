"""Transactional companion progression, independent of telemetry and rendering."""

import bisect
import copy
import json
import math
import random
import sqlite3
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from observatory.companion import battle
from observatory.companion.badges import BADGES, best_streak


THRESHOLDS = tuple(round(36000 * ((level - 1) / 99) ** 1.35) for level in range(1, 101))
APPS = ("codex", "claude")
BACKGROUNDS = ("meadow", "forest", "pond", "beach", "snow", "ruins", "camp", "volcano")
DEFAULTS = {"sound": True, "volume": 0.25, "quiet": False, "reduced_motion": False,
            "always_on_top": False, "completion_sound": True, "attention_sound": True,
            "milestone_sound": True, "onboarding": False, "break_reminders": True,
            "background": "none", "close_exits": False, "auto_updates": True, "message_previews": True,
            "codex": True, "claude": False, "connections_reviewed": False,
            "claude_usage_check": False}
BATTLES_PER_DAY = 5
MAX_BALLS = 30


class Companion:
    """One local profile. Call from a single service thread; commit each mutation."""

    def __init__(self, path: Path, catalog: dict, now: float, rng: random.Random | None = None, battle_data: dict | None = None):
        self.events: list[dict] = []
        self.battle_data = battle_data
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS companion (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)")
        self.catalog = {item["id"]: item for item in catalog["species"]}
        self.rng = rng or random.SystemRandom()
        row = self.db.execute("SELECT value FROM companion WHERE id=1").fetchone()
        if row:
            self.state = json.loads(row[0])
            if self.state.get("version") != 1:
                raise ValueError("Unsupported companion save version; keep the save and update the app")
        else:
            self.state = {"version": 1, "revision": 0, "created": now, "credited_until": {"codex": now}, "present_until": now,
                          "active_id": "egg", "egg": {"seconds": 0, "choices": []},
                          "collection": [], "settings": dict(DEFAULTS), "daily": {},
                          "pending_bonus": 0, "raised_families": [], "encounters": []}
            self._save()
        # Daily keepsakes were retired in 0.3; older saves drop them.
        self.state.pop("finds", None)
        self.state["settings"].pop("cosmetic_finds", None)
        self.state["settings"] = {**DEFAULTS, **self.state["settings"]}
        self.state.setdefault("care", {"seconds": 0, "notified": False})
        self.state.setdefault("berries", 0)
        self.state.setdefault("pet_times", [])
        until = self.state["credited_until"]
        if not isinstance(until, dict):
            # 0.1 saves tracked Codex only; the watermark carries over, so nothing is re-awarded.
            self.state["credited_until"] = {"codex": until}
            self.state.setdefault("present_until", until)
        self.state.setdefault("present_until", max(self.state["credited_until"].values(), default=self.state["created"]))
        for individual in self.state["collection"]:
            individual.setdefault("active_by_app", {"codex": individual["active_seconds"]})
            # Existing saves start earning at their current level, without a backfill.
            individual.setdefault("berry_level", min(100, bisect.bisect_right(THRESHOLDS, individual["xp"])))
        self.state.setdefault("balls", 5)
        self.state.setdefault("seen", [])
        self.state.setdefault("battles", {})
        self.state.setdefault("battle", None)
        evolutions = sum(u["reason"] == "evolution" for p in self.state["collection"] for u in p["unlocks"])
        self.state.setdefault("stats", {"answers": 0, "battles_won": 0, "battles_lost": 0, "caught": 0, "evolutions": evolutions})
        self.state.setdefault("trainer", {"name": "Trainer", "id": random.SystemRandom().randint(10000, 99999)})
        if "badges" not in self.state:
            # Milestones reached before badges existed are granted quietly, not announced all at once.
            self.state["badges"] = {}
            self._award_badges(now, announce=False)
        self.random_background = random.SystemRandom().choice(BACKGROUNDS)

    def _save(self) -> None:
        if "badges" in self.state:
            self._award_badges(time.time())
        self.state["revision"] += 1
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO companion VALUES (1,?)", (json.dumps(self.state),))

    def close(self) -> None:
        self.db.close()

    def _active(self) -> dict | None:
        return next((p for p in self.state["collection"] if p["id"] == self.state["active_id"]), None)

    def _choices(self, previous: list[int]) -> list[int]:
        pool = [p["id"] for p in self.catalog.values() if p.get("starter") and not p.get("legendary")]
        fresh = [ident for ident in pool if ident not in previous]
        candidates = fresh if len({self.catalog[i]["family"] for i in fresh}) >= 3 else pool
        families: dict[int, list[int]] = {}
        for ident in candidates:
            families.setdefault(self.catalog[ident]["family"], []).append(ident)
        return [self.rng.choice(families[family]) for family in self.rng.sample(list(families), min(3, len(families)))]

    def credit(self, start: float, end: float, app: str = "codex") -> None:
        """Growth per app (two apps at once earn twice); presence once, for rules about the human.

        Each app has its own watermark, so replays within one app never double-credit. The
        presence watermark is shared: daily seconds, the daily bonus and the break reminder
        count wall-clock work time, however many apps were busy.
        """
        if app not in APPS:
            raise ValueError("Unknown app")
        if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in (start, end)) or end < start:
            raise ValueError("Active interval must have finite, ordered timestamps")
        floor = self.state["created"]
        grow_from = max(start, self.state["credited_until"].get(app, floor), floor)
        seconds = max(0, end - grow_from)
        present_from = max(start, self.state["present_until"], floor)
        presence = max(0, end - present_from)
        if not seconds and not presence:
            return
        active = self._active()
        if presence:
            self.observe_rest(present_from)
            self.state["care"]["seconds"] += presence
            self.state["present_until"] = end
            day = datetime.fromtimestamp(end).date().isoformat()
            daily = self.state["daily"].setdefault(day, {"seconds": 0, "bonus": False})
            daily["seconds"] += presence
            if daily["seconds"] >= 600 and not daily["bonus"]:
                daily["bonus"] = True
                self.state["pending_bonus"] += 300
        if seconds:
            self.state["credited_until"][app] = end
            egg = self.state["egg"]
            if self.state["active_id"] == "egg" and egg and not egg["choices"]:
                egg["seconds"] = min(120, egg["seconds"] + seconds)
                if egg["seconds"] >= 120:
                    egg["choices"] = self._choices([])
            elif active:
                active["active_seconds"] += seconds
                active["active_by_app"][app] = active["active_by_app"].get(app, 0) + seconds
        if active and (seconds or self.state["pending_bonus"]):
            self._advance(active, seconds + self.state["pending_bonus"])
            self.state["pending_bonus"] = 0
        self._save()

    def _advance(self, active: dict, xp: float) -> None:
        """Award each new level once, independent of which source supplied the XP."""
        active["xp"] += xp
        level = min(100, bisect.bisect_right(THRESHOLDS, active["xp"]))
        earned = max(0, level - active["berry_level"])
        self.state["berries"] += earned
        active["berry_level"] = max(level, active["berry_level"])
        species = self.catalog[active["species_id"]]
        if earned:
            self.events.append({"id": f"level-{active['id'][:8]}-{level}", "kind": "level_up", "level": level,
                                "berries": earned, "name": species["name"], "at": time.time()})
        if level == 100 and not species.get("legendary") and species["family"] not in self.state["raised_families"]:
            self.state["raised_families"].append(species["family"])
        announced = active.setdefault("ready_announced", [])
        for edge in species.get("evolutions", []):
            if edge["to"] not in announced and self._eligible(active, edge):
                announced.append(edge["to"])
                self.events.append({"id": f"ready-{active['id'][:8]}-{edge['to']}", "kind": "evolution_ready",
                                    "name": species["name"], "to": self.catalog[edge["to"]]["name"], "at": time.time()})

    def drain_events(self) -> list[dict]:
        """Level-ups and evolution hints for the renderer; transient, never part of the save."""
        events, self.events = self.events, []
        return events

    @staticmethod
    def _species_arg(value: Any) -> int:
        # JSON true would otherwise match species 1 and be saved as a boolean.
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError("Species must be a Pokédex number")
        return value

    def treats(self, now: float | None = None) -> dict:
        """Rolling profile-wide pet allowance; a clock rollback cannot refill it."""
        now = time.time() if now is None else now
        recent = [at for at in self.state["pet_times"] if at > now - 3600]
        return {"berries": self.state["berries"], "pets_left": max(0, 10 - len(recent)),
                "next_pet_at": min(recent) + 3600 if len(recent) >= 10 else None}

    def observe_rest(self, now: float) -> None:
        """Five minutes without credited work clears the optional stretch reminder."""
        if now - self.state["present_until"] >= 300 and self.state["care"]["seconds"]:
            self.state["care"] = {"seconds": 0, "notified": False}
            self._save()

    def care_events(self, now: float) -> list[dict]:
        care = self.state["care"]
        if care["seconds"] < 3000 or care["notified"]:
            return []
        care["notified"] = True
        self._save()
        if not self.state["settings"]["break_reminders"] or self.state["settings"]["quiet"]:
            return []
        # A break can be a battle: the reminder offers one while today's battles last.
        offer = bool(self.battle_data and self._active()) and self.state["battles"].get(self._today(now), 0) < BATTLES_PER_DAY
        return [{"id": f"break-{self.state['revision']}", "kind": "break_reminder", "at": now, "battle": offer}]

    def _adopt(self, species: int, reason: str = "hatched", level: int = 1, make_active: bool = True) -> None:
        individual = {"id": str(uuid.uuid4()), "species_id": species, "xp": THRESHOLDS[level - 1], "berry_level": level,
                      "active_seconds": 0, "active_by_app": {}, "history": [species], "adopted_at": time.time(),
                      "unlocks": [{"species_id": species, "at": time.time(), "level": level, "reason": reason}]}
        self.state["collection"].append(individual)
        if make_active:
            self.state["active_id"] = individual["id"]

    # Badges, streaks and the Trainer Card ------------------------------------------------------
    def _summary(self) -> dict:
        levels = [min(100, bisect.bisect_right(THRESHOLDS, p["xp"])) for p in self.state["collection"]]
        return {**self.state["stats"], "collection": len(self.state["collection"]), "best_streak": best_streak(self.state["daily"]),
                "top_level": max(levels, default=0),
                "registered": len({u["species_id"] for p in self.state["collection"] for u in p["unlocks"]}),
                "both_apps": any(all(p.get("active_by_app", {}).get(app, 0) >= 60 for app in APPS) for p in self.state["collection"])}

    def _award_badges(self, now: float, announce: bool = True) -> None:
        summary = self._summary()
        for ident, name, _, earned in BADGES:
            if ident not in self.state["badges"] and earned(summary):
                self.state["badges"][ident] = now
                if announce:
                    self.events.append({"id": f"badge-{ident}", "kind": "badge", "badge": ident, "name": name, "at": now})

    def record_answers(self, count: int) -> None:
        """Every finished answer from either app counts toward the Cascade Badge and the Trainer Card."""
        if count > 0:
            self.state["stats"]["answers"] += count
            self._save()

    # Wild battles -----------------------------------------------------------------------------
    def _today(self, now: float) -> str:
        return datetime.fromtimestamp(now).date().isoformat()

    def _battle_rewards(self, fight: dict, now: float) -> None:
        over, stats = fight["over"], self.state["stats"]
        partner = next((p for p in self.state["collection"] if p["id"] == fight["ally"]["individual"]), None)
        reward = {"t": "reward", "xp": 0, "ball": False}
        if partner and over in ("won", "caught", "lost"):
            level = min(100, bisect.bisect_right(THRESHOLDS, partner["xp"]))
            span = THRESHOLDS[level] - THRESHOLDS[level - 1] if level < 100 else 0
            ratio = min(1.5, max(0.5, fight["wild"]["level"] / max(1, fight["ally"]["level"])))
            share = 0.3 * ratio if over != "lost" else 0.05
            xp = min(span * share, THRESHOLDS[-1] - partner["xp"])
            if xp > 0:
                self._advance(partner, xp)
            reward.update(xp=round(xp), percent=round(100 * share * (1 if span else 0)),
                          level=min(100, bisect.bisect_right(THRESHOLDS, partner["xp"])), levelled=min(100, bisect.bisect_right(THRESHOLDS, partner["xp"])) > level)
        if over in ("won", "caught"):
            self.state["balls"] = min(MAX_BALLS, self.state["balls"] + 1)
            reward["ball"] = True
        if over == "won":
            stats["battles_won"] += 1
        elif over == "lost":
            stats["battles_lost"] += 1
        elif over == "caught":
            stats["caught"] += 1
            self._adopt(fight["wild"]["id"], "caught", level=fight["wild"]["level"], make_active=False)
        if over != "ran":
            fight["steps"].append(reward)

    def command(self, action: str, args: dict[str, Any]) -> None:
        """Validate before saving; failed actions leave the saved profile unchanged."""
        before, pending = copy.deepcopy(self.state), len(self.events)
        try:
            self._command(action, args)
            self._save()
        except Exception:
            self.state = before
            del self.events[pending:]
            raise

    def _command(self, action: str, args: dict[str, Any]) -> None:
        egg = self.state["egg"]
        active = self._active()
        fight = self.state["battle"]
        if fight and not fight["over"] and action in ("switch", "new_egg", "evolve", "adopt", "encounter"):
            raise ValueError("Finish the battle first")
        if action in ("pet", "berry"):
            if not active:
                raise ValueError("Hatch and choose a companion first")
            level = min(100, bisect.bisect_right(THRESHOLDS, active["xp"]))
            if level == 100:
                raise ValueError("Level 100 already! Save your treats for another companion")
            now = time.time()
            if action == "pet":
                if not self.treats(now)["pets_left"]:
                    raise ValueError("Ten pets in the last hour. Let those ears rest a little")
                self.state["pet_times"] = [at for at in self.state["pet_times"] if at > now - 3600] + [now]
            else:
                if self.state["berries"] < 1:
                    raise ValueError("No berries left. Earn one at your next level")
                self.state["berries"] -= 1
            gain = (THRESHOLDS[level] - THRESHOLDS[level - 1]) * (0.01 if action == "pet" else 0.2)
            self._advance(active, min(gain, THRESHOLDS[-1] - active["xp"]))
        elif action == "adopt":
            species = self._species_arg(args.get("species_id"))
            if not egg or species not in egg["choices"] or self.state["active_id"] != "egg":
                raise ValueError("Select a species from the active egg's hatch choices")
            self._adopt(species)
            self.state["egg"] = None
        elif action == "refresh_choices":
            if not egg or not egg["choices"]:
                raise ValueError("The egg must hatch before refreshing choices")
            egg["choices"] = self._choices(egg["choices"])
        elif action == "new_egg":
            if egg is None:
                self.state["egg"] = {"seconds": 0, "choices": []}
            self.state["active_id"] = "egg"
        elif action == "switch":
            ident = args.get("id")
            if not any(p["id"] == ident for p in self.state["collection"]):
                raise ValueError("Companion not found in this collection")
            self.state["active_id"] = ident
        elif action == "evolve":
            target = self._species_arg(args.get("species_id"))
            edges =self.catalog[active["species_id"]].get("evolutions", []) if active else []
            edge = next((e for e in edges if e["to"] == target), None)
            if edge is None:
                raise ValueError("That evolution is not in this companion's family")
            if not self._eligible(active, edge):
                raise ValueError("Evolution requirement is not met yet")
            level = min(100, bisect.bisect_right(THRESHOLDS, active["xp"]))
            active["unlocks"][-1]["level"] = level
            active["species_id"] = target
            active["history"].append(target)
            active["unlocks"].append({"species_id": target, "at": time.time(), "level": level, "reason": "evolution"})
            self.state["stats"]["evolutions"] += 1
        elif action == "encounter":
            species = self._species_arg(args.get("species_id"))
            if species not in [e["species"]["id"] for e in self.snapshot()["encounters"] if e["available"]]:
                raise ValueError("This encounter is not unlocked")
            self._adopt(species, "encounter")
            self.state["encounters"].append(species)
        elif action == "battle_start":
            now = time.time()
            if not self.battle_data:
                raise ValueError("Battle data is missing; reinstall Pocodex")
            if not active:
                raise ValueError("Hatch a partner before heading into the tall grass")
            if fight and not fight["over"]:
                raise ValueError("A battle is already under way")
            if str(active["species_id"]) not in self.battle_data["species"]:
                raise ValueError(f"{self.catalog[active['species_id']]['name']} cannot battle yet; reinstall Pocodex to refresh its battle data")
            day = self._today(now)
            if self.state["battles"].get(day, 0) >= BATTLES_PER_DAY:
                raise ValueError("Your partner needs rest. Battles return tomorrow")
            level = min(100, bisect.bisect_right(THRESHOLDS, active["xp"]))
            fight = battle.start(active, level, self.catalog, self.battle_data, self.rng, str(uuid.uuid4()))
            self.state["battle"] = fight
            self.state["battles"] = {day: self.state["battles"].get(day, 0) + 1}
            if fight["wild"]["id"] not in self.state["seen"]:
                self.state["seen"].append(fight["wild"]["id"])
        elif action == "battle_act":
            if not fight or fight["over"]:
                raise ValueError("There is no battle to act in")
            if args.get("action") == "ball":
                if self.state["balls"] < 1:
                    raise ValueError("No Poké Balls left. Win a battle to earn one")
                self.state["balls"] -= 1
            battle.act(fight, args, self.battle_data, self.rng)
            if fight["over"]:
                self._battle_rewards(fight, time.time())
        elif action == "battle_close":
            self.state["battle"] = None
        elif action == "trainer":
            name = args.get("name")
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 12 or not name.strip().isprintable():
                raise ValueError("Trainer names are 1 to 12 characters")
            self.state["trainer"]["name"] = name.strip()
        elif action == "shuffle_background":
            self.random_background = random.SystemRandom().choice([b for b in BACKGROUNDS if b != self.random_background])
            self.state["settings"]["background"] = "random"
        elif action == "settings":
            for key, value in args.items():
                if key not in DEFAULTS:
                    raise ValueError(f"Unknown setting: {key}")
                if key == "background":
                    if value not in (*BACKGROUNDS, "none", "random"):
                        raise ValueError("Choose one of the bundled backgrounds")
                elif key == "volume":
                    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= 1:
                        raise ValueError("Sound volume must be between 0 and 1")
                elif not isinstance(value, bool):
                    raise ValueError(f"Setting {key} must be true or false")
            self.state["settings"].update(args)
        else:
            raise ValueError(f"Unknown companion action: {action}")

    def _eligible(self, individual: dict, edge: dict) -> bool:
        return (bisect.bisect_right(THRESHOLDS, individual["xp"]) >= edge.get("min_level", 1)
                and individual["active_seconds"] >= edge.get("active_seconds", 0)
                and not edge.get("unsupported"))

    def snapshot(self) -> dict:
        result = copy.deepcopy(self.state)
        result["treats"] = self.treats()
        result["battles_left"] = max(0, BATTLES_PER_DAY - self.state["battles"].get(self._today(time.time()), 0))
        result["seen"] = sorted(set(self.state["seen"]) | {u["species_id"] for p in self.state["collection"] for u in p["unlocks"]})
        summary = self._summary()
        result["stats"] = {**self.state["stats"], "best_streak": summary["best_streak"],
                           "seconds_by_app": {app: sum(p.get("active_by_app", {}).get(app, 0) for p in self.state["collection"]) for app in APPS}}
        if result.get("battle") and self.battle_data:
            fight, moves = result["battle"], self.battle_data["moves"]
            # The menu shows each move with its matchup, from the same chart the turn uses.
            fight["moves"] = [{"id": name, **moves[name], "effect": battle.effectiveness(moves[name]["type"], fight["wild"]["types"])}
                              for name in fight["ally"]["moves"]]
        result["badges"] = [{"id": ident, "name": name, "requirement": requirement, "earned": ident in self.state["badges"],
                             "at": self.state["badges"].get(ident)} for ident, name, requirement, _ in BADGES]
        result["background"] = self.random_background if result["settings"]["background"] == "random" else result["settings"]["background"]
        for individual in result["collection"]:
            individual["species"] = self.catalog[individual["species_id"]]
            level = min(100, bisect.bisect_right(THRESHOLDS, individual["xp"]))
            individual["level"] = level
            individual["progress"] = 1 if level == 100 else (individual["xp"] - THRESHOLDS[level - 1]) / (THRESHOLDS[level] - THRESHOLDS[level - 1])
            individual["evolutions"] = [{**e, "species": self.catalog[e["to"]], "eligible": self._eligible(individual, e)} for e in individual["species"].get("evolutions", [])]
        result["active"] = next((p for p in result["collection"] if p["id"] == result["active_id"]), None)
        dex = {}
        for individual in result["collection"]:
            for unlock in individual.get("unlocks", []):
                species_id = unlock["species_id"]
                entry = dex.setdefault(species_id, {"species": self.catalog[species_id], "first_unlocked": unlock["at"], "best_level": 1, "unlocks": []})
                level = individual["level"] if species_id == individual["species_id"] else unlock["level"]
                entry["first_unlocked"] = min(entry["first_unlocked"], unlock["at"])
                entry["best_level"] = max(entry["best_level"], level)
                entry["unlocks"].append({**unlock, "level": level, "individual_id": individual["id"], "current": species_id == individual["species_id"]})
        result["pokedex"] = sorted(dex.values(), key=lambda entry: entry["species"]["id"])
        result["roster"] = [{"id": p["id"], "species_id": p.get("species_id", p["id"]), "name": p["name"], "sprite": p.get("sprite"),
                             "cry": p.get("cry"), "types": p.get("types", [])} for p in self.catalog.values()]
        if result["egg"]:
            result["egg"]["choices"] = [self.catalog[ident] for ident in result["egg"]["choices"]]
        thresholds = (1, 3, 5, 8, 12)
        legends = sorted((p for p in self.catalog.values() if p.get("legendary")), key=lambda p: p["id"])
        result["encounters"] = [{"species": p, "families_needed": thresholds[min(i, 4)],
                                 "available": len(result["raised_families"]) >= thresholds[min(i, 4)] and p["id"] not in self.state["encounters"],
                                 "adopted": p["id"] in self.state["encounters"]} for i, p in enumerate(legends)]
        return result
