# Sound effects

All files here are **CC0 1.0** (public domain): free to use, change and redistribute, commercially too, with no attribution required. We credit the authors anyway. Every file was converted to MP3 (44.1 kHz, 96 kbps; short effects in mono) so that Chrome, Firefox and Safari can all decode it; nothing else was changed. `js/sfx.js` plays them.

| File | Used for | Source | Author |
|---|---|---|---|
| `rain.mp3` | Rain outside the window (loop, cross-faded) | [AMB Rain Loop 1](https://opengameart.org/content/amb-rain-loop-1), OpenGameArt | Kresiek The Furry |
| `tv-music.mp3` | Quiet background music while the TV plays a project (loop) | [Chill lofi inspired [loop edit]](https://opengameart.org/content/chill-lofi-inspired-loop-edit), OpenGameArt | qubodup |
| `tv-static.mp3` | A burst of static when the TV starts a tape | `noise_01` from [30 CC0 SFX loops](https://opengameart.org/content/30-cc0-sfx-loops), OpenGameArt | rubberduck |
| `tv-glitch.mp3` | Next chapter on the TV | `glitch_001` from [Interface Sounds](https://kenney.nl/assets/interface-sounds) | Kenney |
| `tape-latch.mp3` | The answering machine's cassette starting and stopping (low-passed in `js/sfx.js`, so it reads as a small plastic click) | `metalLatch` from [RPG Audio](https://kenney.nl/assets/rpg-audio) | Kenney |
| `book-open.mp3`, `book-flip1.mp3`, `book-flip2.mp3`, `book-close.mp3`, `book-place.mp3` | Taking a book off the shelf, opening it, turning pages, closing it, putting it back. `js/books.js` scales them by each book's estimated weight: a thin paperback plays them higher, shorter, quieter and without the low thump | `bookOpen`, `bookFlip1`, `bookFlip2`, `bookClose`, `bookPlace1` from [RPG Audio](https://kenney.nl/assets/rpg-audio) | Kenney |
| `paper.mp3` | Picking up and putting down the résumé, lifting a photo | `cloth1` from [RPG Audio](https://kenney.nl/assets/rpg-audio) | Kenney |
| `photo-pin.mp3` | Pressing a photo back onto the cork board | `impactSoft_medium_000` from [Impact Sounds](https://kenney.nl/assets/impact-sounds) | Kenney |
| `switch.mp3` | Desk lamp and room light switches | `metalClick` from [RPG Audio](https://kenney.nl/assets/rpg-audio) | Kenney |
| `wood1.mp3`, `wood2.mp3`, `wood3.mp3` | The perpetual calendar's blocks settling | `impactWood_light_000/002/004` from [Impact Sounds](https://kenney.nl/assets/impact-sounds) | Kenney |
| `key.mp3`, `tick.mp3` | The computer menu: open / back, moving the selection | `click_001`, `tick_001` from [Interface Sounds](https://kenney.nl/assets/interface-sounds) | Kenney |

## Sounds made in code

Two sounds have no file; `js/sfx-synth.js` computes them when the room starts, and `node scripts/render-sfx-synth.mjs` writes the same samples to WAV for listening.

- **Drips outside the window.** Every so often a few drops fall from the eaves into the gutter (a "plink"), down the drainpipe (a hollow "plonk") or onto the tin sill (a short "tick"). Each drop is a bubble resonating at its Minnaert frequency with a slight upward chirp, after K. van den Doel, *Physically based models for liquid sounds* (ACM TAP 2005), heard through the glass and with a little echo between the buildings.
- **The VCR taking a tape.** A muffled plastic clunk as the cassette drops in, then a short motor whir with gear chatter, all inside the half second of static before the picture starts. It replaced `tape-latch.mp3` here, whose metal click was the harshest sound in the room.

## Mix

`js/sfx.js` first trims every file to the same reference loudness (`TRIM`, in dB), so a `gain` written at a call site says how loud that action should be: about 1 for big actions (a heavy book closing, the VCR), 0.6–0.75 for ordinary ones, 0.3–0.5 for small clicks. The background follows where you look, fading over a second or two. Measured from the browser's real output (LUFS), with the record volume set to 50%: in the room the record plays at about −32.5 and the rain at −39 under it (−36.5 alone), with drips peaking around −30; at the TV the record drops to −39, the rain to about −44, and a faint tape hiss (about −45) runs while a tape plays; at the window the record drops to −39 and the rain rises to −35.5, above the music. The answering machine's tape hiss under a message sits around −43, a soft mid-range hiss rather than a 4 kHz one.
