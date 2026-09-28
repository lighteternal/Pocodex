# Third-party material

Pocodex is independent and unofficial. It is not affiliated with Nintendo, The Pokémon Company, Game Freak, Creatures, OpenAI, Anthropic or PokeTokenBar. No PokeTokenBar code or visual design was reused.

This is a free, non-commercial hobby project. No fees, advertising revenue, sales, donations or other payments are accepted for Pocodex. This statement does not grant rights to Pokemon material or prevent a rights holder from requesting removal. No ownership or endorsement is claimed. Rights holders may contact the repository owner through GitHub.

- Pokemon species/evolution data: [PokeAPI](https://pokeapi.co/docs/v2/). Local rules include explicitly labelled solo adaptations; they are not a full Pokemon game simulation.
- Sprites: [PokeAPI sprites](https://github.com/PokeAPI/sprites), primarily the Showdown battle-sprite collection.
- Action sprites: [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab), pinned at `904f12e3fe8438ea5e53282ae1282831bd2b5124`. Contributions are offered under CC BY-NC 4.0; the full licence is bundled in `assets/ACTIONS-LICENSE.md`. Per-form contributor display names, original paths, unmodified sheet hashes and frame timings are in `assets/actions.json`, pinned in `companion/data/actions.json`. Original game sprites remain third-party Pokemon material. Galarian Ponyta credits: Jhony-Rex, ◥θ┴θ◤ and baronessfaron.
- Shared heart, question, sparkle and Oran Berry artwork: [pret/pokeemerald](https://github.com/pret/pokeemerald), pinned at `c925b8482d05fb882d6b64e523653cae599e025f`. Source files remain unchanged; the renderer treats their background palette colour as transparent and crops frames. Source URLs and hashes are in `assets/actions.json`. This extracted game artwork is not covered by Pocodex's MIT licence.
- Professor Oak in the first-run intro: FireRed's intro artwork from [pret/pokefirered](https://github.com/pret/pokefirered), pinned at `037335f4c725d7c9aecdac87066f2002b4bd7e14`. The file is unchanged; the renderer treats its backdrop colour as transparent. Its source URL and hash are in `assets/actions.json`. This extracted game artwork is not covered by Pocodex's MIT licence.
- Cries: [PokeAPI cries](https://github.com/PokeAPI/cries).
- Battle data: base stats, catch rates, level-up learnsets and move type, power and accuracy from [PokeAPI](https://pokeapi.co/docs/v2/), pinned in `companion/data/battle.json`. The battle rules are a simplified reading of the games' published formulas.
- Gym Badge emblems on the Trainer Card are original drawings, not the games' badge artwork.
- Each bundled sprite and cry has its source URL, byte count and SHA-256 in `assets/manifest.json`. The source repository pins these in `companion/data/manifest.json`.
- Pokemon characters, artwork, sounds, names and trademarks belong to their respective owners. The source repository does not contain these sprites or cries: builds download them from the sources above. Public availability does not establish permission to redistribute them, and the MIT grant for original Pocodex code does not cover them. Pocodex claims no rights to them and will remove them on a rights holder's request.
- Phosphor interface icons: `@phosphor-icons/core` 2.1.1, MIT. Full notice included in `ui/icons/LICENSE.txt`.
- Dialogue font: **Pokemon Classic** by TheLouster115, copyright 2016, CC BY-SA 3.0 Unported. Bundled unchanged; attribution, source, licence link and hash are in `ui/fonts/NOTICE.md`. It is not MIT-licensed or an official Pokemon release.
- Electron and Chromium notices accompany the Windows runtime (`LICENSE.electron.txt` and `LICENSES.chromium.html`). Other build/runtime dependency terms remain applicable.
- Markdown previews use `markdown-it` 15.0.2 (MIT); its licence is bundled with the dependency. HTML and embedded images are disabled; links render as read-only labels.
- The egg SVG, launcher egg icon, transparent scenery, pixel heart and berry icons, and the intro's stage, Poké Ball and grass are original code-drawn assets. The evolution chime is synthesized from an original four-note sequence.

No runtime asset downloads, external telemetry, hosted server, or model calls are required. Building from source may download the pinned dependencies and asset bytes from their listed hosts.
