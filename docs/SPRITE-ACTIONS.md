# Sprite actions

Research checked on 28 September 2026. This is the implemented mapping, not a claim that every species has every animation.

| State or event | Pokemon action | Shared effect | End condition |
| --- | --- | --- | --- |
| Codex working | Walk, alternating east/west | None | Working ends |
| Idle for under 10 seconds | Idle | None | State changes or rest threshold |
| Idle for 10 seconds | Sleep | None | Fresh work, attention or interaction |
| Pet | Nod | Heart | 3.5 seconds |
| Feed berry | Eat | Oran Berry | 3.5 seconds |
| Completed task / hatch milestone | Pose | Sparkle | 3.5 seconds |
| Level-up / ready to evolve | Pose | Sparkle | 3.5 seconds; silent for level-ups, milestone cry for ready-to-evolve |
| Awaiting input | Idle | Question | Input answered |
| Stopped / low allowance / exhausted allowance | Idle | Question | 3.5-second reaction; notification remains separately |
| Evolution | Old form glows, white silhouettes alternate faster, new form settles (drawn in the same canvas; one form per frame) | Sparkle and ring | 4.8 seconds; original chime and evolved cry at the reveal if enabled |
| Connection unknown | Idle | None | Fresh supported evidence |
| Battle: physical move | Attack, with a lunge toward the target | Hit star, ring and type particles | Move resolved |
| Battle: special move | Charge, then Shoot, with a type-coloured projectile | Hit star, ring and type particles | Move resolved |
| Battle: taking a hit | Hurt, blinking | Screen shake when super effective | Hit resolved |
| Battle: fainting | Idle, sliding down and fading | None | Fainted |
| Battle: level-up after a win | Hop | None | Once |

In battle the wild Pokémon uses its down-left row and your partner its up-right row, so you see it from behind. Battle sheets never change the desktop buddy's size, which is computed from buddy actions only.

Actions and effects are selected by `companion/ui/action-state.js`. `companion/ui/sprite-layout.js` sizes and grounds each form: it measures the opaque pixels of every action sheet, picks one whole-pixel scale per form that fits every action, anchors each action's lowest pixel on a shared ground line and draws a shadow there. PMD frames pad each action differently, so sizing by frame dimensions made forms shrink, grow and float between actions. Effects are positioned from the drawn body. Text lines live in `companion/ui/lore.js`. Event reactions take precedence over background activity. Quiet mode suppresses event reactions and effects. Reduced motion freezes frame zero and suppresses CSS effects. Hidden views stop their animation timer. Only the current form's sheets and four small shared effects are decoded; changing companions releases the previous form's bitmaps. No runtime network fetches, model calls or random sounds.

## Sources and coverage

- [SpriteCollab](https://github.com/PMDCollab/SpriteCollab/tree/904f12e3fe8438ea5e53282ae1282831bd2b5124) supplies separate action sheets and per-form credits. Its [use policy](https://github.com/PMDCollab/SpriteCollab/blob/904f12e3fe8438ea5e53282ae1282831bd2b5124/README.md) requests non-commercial use and attribution. This does not grant ownership of underlying Pokemon IP.
- The [PMD sprite format](https://wiki.pmdo.pmdcollab.org/PMD_Sprite_Format) defines horizontal animation frames, vertical direction rows, `CopyOf` aliases and durations in 1/60-second units. The importer validates sheet dimensions and resolves only explicit aliases. Playback is slowed and rate-limited for a desktop companion.
- Exact-form coverage: Idle and Walk 224/227; Sleep 223; Eat 45; Pose 48; Nod 43. A missing action uses that form's Idle. Mr. Rime, Alola-cap Pikachu and Totem Alolan Raticate retain their existing battle sprite. No substitute regional form or costume.
- [Galarian Ponyta](https://github.com/PMDCollab/SpriteCollab/tree/904f12e3fe8438ea5e53282ae1282831bd2b5124/sprite/0077/0001) has all six imported actions. Credits: Jhony-Rex, ◥θ┴θ◤ and baronessfaron. `tracker.json` identifies this as the canonical Galar form; the alternate-art slot is not used.
- [Emerald shared effects](https://github.com/pret/pokeemerald/tree/c925b8482d05fb882d6b64e523653cae599e025f/graphics/field_effects/pics) provide the heart, question and two-frame small sparkle. The berry is the same revision's [Oran Berry icon](https://github.com/pret/pokeemerald/blob/c925b8482d05fb882d6b64e523653cae599e025f/graphics/items/icons/oran_berry.png). Palette backdrop removal happens in memory; source PNGs are pinned unchanged.

The pack adds 6,724,630 source bytes, including XML, licence and 1,034 hashed resources. `companion/data/actions.json` preserves exact filenames, source URLs, SHA-256, credits and available actions. Build-time restoration rejects changed bytes. Read `companion/THIRD-PARTY-NOTICES.md` before distributing.
