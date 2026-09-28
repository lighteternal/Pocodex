"""Eight Gym Badges for milestones in working with your agents. Checked on every save, awarded once."""

from datetime import date, timedelta

BADGES = (
    ("boulder", "Boulder Badge", "Hatch your first Pokémon", lambda s: s["collection"] >= 1),
    ("cascade", "Cascade Badge", "Ship 25 answers", lambda s: s["answers"] >= 25),
    ("thunder", "Thunder Badge", "Win 5 wild battles", lambda s: s["battles_won"] >= 5),
    ("rainbow", "Rainbow Badge", "Evolve a Pokémon", lambda s: s["evolutions"] >= 1),
    ("soul", "Soul Badge", "Work with your team 7 days in a row", lambda s: s["best_streak"] >= 7),
    ("marsh", "Marsh Badge", "Grow one Pokémon with both Codex and Claude Code", lambda s: s["both_apps"]),
    ("volcano", "Volcano Badge", "Raise a Pokémon to Lv. 50", lambda s: s["top_level"] >= 50),
    ("earth", "Earth Badge", "Register 50 Pokémon in your Pokédex", lambda s: s["registered"] >= 50),
)


def best_streak(daily: dict, minimum: int = 600) -> int:
    """Longest run of consecutive days with at least ten minutes of shared work."""
    days = sorted(date.fromisoformat(day) for day, entry in daily.items() if entry.get("seconds", 0) >= minimum)
    best = run = 0
    for index, day in enumerate(days):
        run = run + 1 if index and day - days[index - 1] == timedelta(days=1) else 1
        best = max(best, run)
    return best
