# Wild battles and the Trainer Card

Pocodex 0.3. Battles are a short break from work; the Trainer Card is something to share.

## Wild battles

**Starting one.** Home has "Look for wild Pokémon", and the 50-minute stretch reminder offers a battle. Five battles a day keep it a break, not a grind. A battle needs a partner (not an egg).

**Who appears.** A wild Pokémon within three levels of your partner (from three below to one above). Base forms are three times as common as evolved forms; an evolved form appears once the wild level reaches its evolution level, or level 30 for item, trade and friendship evolutions. Legendaries never appear in the grass. Every Pokémon you meet is marked Seen in the Pokédex.

**Data.** `companion/data/battle.json` is pinned from [PokeAPI](https://pokeapi.co): base stats, catch rate and the level-up learnset from each form's newest game (Scarlet/Violet first, then Legends: Arceus, Sword/Shield and older). It is built by `scripts/companion_battle.mjs --refresh` and never fetched at runtime.

**Rules**, from the games' published formulas (`src/observatory/companion/battle.py`):

| Part | Rule |
| --- | --- |
| Moves | The last four damaging level-up moves learned by the current level. A form with none uses Struggle. |
| Stats | Gen 3+ formula, IVs fixed at 20, no EVs. |
| Damage | Gen 3+ formula with the random 85–100% roll, STAB ×1.5 and the Gen 6+ type chart. |
| Critical hits | Gen 7+ stages (1/24, 1/8, 1/2, always), ×1.5. |
| Accuracy | Move accuracy; moves with none never miss. |
| Extras | Multi-hit (2–5 hits with the Gen 5+ distribution), drain and recoil percentages, Struggle's quarter-HP recoil. |
| Order | Priority, then speed, ties at random. |
| Wild choices | Its strongest expected move 80% of the time, otherwise any move. |
| Catching | Gen 3: catch value from HP and catch rate, four shake checks, up to three wobbles shown. |

**Deliberate simplifications**, so nothing is silently wrong: no status conditions, stat stages, abilities, items or weather. Moves that need those or other unmodelled rules are excluded from the data rather than simulated as plain attacks: two-turn moves (Solar Beam, Fly), recharge (Hyper Beam), conditional moves (Snore, Belch, Fake Out), self-KO (Explosion) and lock-in moves (Outrage).

**Rewards.** A win or a catch gives 30% of a level, scaled by the wild level relative to yours (×0.5 to ×1.5), and one Poké Ball. A loss gives 5% of a level and costs nothing. Running gives nothing. A caught Pokémon joins your collection at its level without replacing your partner. You start with five Poké Balls and can hold thirty.

**Staging** (`companion/ui/battle.js`). The sidecar resolves each turn; the renderer only plays back what happened. A canvas top screen in the Kanto bezel shows a field tinted by the buddy's scenery, the wild Pokémon facing you and your partner from behind, using the PMD Attack, Hurt, Charge, Shoot and Hop sheets. The entrance wipe, Poké Ball send-out, lunges, type-coloured particles, hit stars and rings, blinks, screen shake on super-effective hits, draining HP bars, fainting and ball wobbles follow the Gen 3 battle rhythm. A DS-style lower screen carries the game's lines and Fight, Bag, Run and Auto. Real cries play on appear, send-out and faint; other sounds are original. Reduced motion keeps the text and removes the movement.

## Gym Badges

| Badge | Earned by |
| --- | --- |
| Boulder | Hatching your first Pokémon |
| Cascade | Shipping 25 answers (either app) |
| Thunder | Winning 5 wild battles |
| Rainbow | Evolving a Pokémon |
| Soul | Working with your team 7 days in a row (10+ minutes a day) |
| Marsh | Growing one Pokémon with both Codex and Claude Code |
| Volcano | Raising a Pokémon to Lv. 50 |
| Earth | Owning 50 Pokémon in your Pokédex |

Badges are checked on every save and awarded once, with their own reaction. Milestones reached before badges existed are granted quietly on upgrade. The emblems are original drawings.

## Trainer Card

A FireRed-style card that turns green, bronze, silver and finally gold as badges are earned. The front shows name, ID No., Pokédex owned and seen, time with your agents, answers shipped, battles won, your partner, the eight badges and a party of six. The back lists dated milestones and splits your time between Codex and Claude Code. Copy image and Save PNG capture the card exactly as rendered.
