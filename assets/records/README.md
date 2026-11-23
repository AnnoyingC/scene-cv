# Records

The two records on the turntable are J. S. Bach's *Goldberg Variations* (BWV 988) played by Kimiko Ishizaka, from [The Open Goldberg Variations](https://opengoldbergvariations.org/) (2012). The recording was released into the public domain under **CC0 1.0**: free to use, change and redistribute, commercially too, with no attribution required. We credit it anyway. Source files: [Internet Archive](https://archive.org/details/The_Open_Goldberg_Variations-11823).

| File | Record | Contents |
|---|---|---|
| `goldberg-side-a.mp3` | Side A (the default record) | Aria, Variations 1–7 (17 min 28 s) |
| `goldberg-side-b.mp3` | Side B | Variation 13, Variation 30 (Quodlibet), Aria da capo (9 min 05 s) |

How they were made: the album's MP3s were decoded and joined into one file per side. Pieces that follow each other on the album are joined sample for sample, since the album is gapless; between Variation 13 and Variation 30 there is a 1.5 s pause with short fades. The start and the end of each side are trimmed and faded so the loop is smooth. Each side was re-encoded with LAME (VBR `-V 6`, 44.1 kHz stereo). Nothing else was changed.

`js/music-tracks.js` lists the records. To play your own music instead, see the comments in that file.
