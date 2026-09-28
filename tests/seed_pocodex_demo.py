"""Seed an isolated UI-test profile using the real engine. Not shipped in the app."""

import json
import random
import sys
import time
from pathlib import Path

from observatory.companion.engine import Companion


def main() -> None:
    profile, assets = map(Path, sys.argv[1:3])
    egg_only = '--egg' in sys.argv[3:]
    catalog = json.loads((assets / "catalog.json").read_text(encoding="utf-8"))
    engine = Companion(profile / "companion.sqlite", catalog, now=time.time() - (119 if egg_only else 12360), rng=random.Random(17))
    engine.command("settings", {"onboarding": True, "sound": False, "connections_reviewed": True})
    clock = engine.state["present_until"]
    if egg_only:
        engine.credit(clock, clock + 119)
        engine.close()
        return
    first = None
    partner = next((int(a.split("=", 1)[1]) for a in sys.argv[3:] if a.startswith("--partner=")), None)
    roster = [(1, None)] if partner else [(1, 2), (4, 5), (7, None)]
    for species, evolved in roster:
        engine.command("new_egg", {})
        engine.credit(clock, clock + 120)
        clock += 120
        for _ in range(1000):
            if species in [p["id"] for p in engine.snapshot()["egg"]["choices"]]:
                break
            engine.command("refresh_choices", {})
        engine.command("adopt", {"species_id": species})
        engine.credit(clock, clock + 4000)
        clock += 4000
        if evolved:
            engine.command("evolve", {"species_id": evolved})
        if first is None:
            first = engine.snapshot()["active"]["id"]
    if partner:  # Any form, including ones that only arrive by catching, joins as a caught partner.
        engine._adopt(partner, "caught", level=12)
        first = engine.state["active_id"]
    engine.command("switch", {"id": first})
    engine.close()


if __name__ == "__main__":
    main()
