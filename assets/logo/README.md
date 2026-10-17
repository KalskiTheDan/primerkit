# primerkit's logo

The PK: a P with an open stem, and a K whose leg ends in a level stroke and whose arm is that stroke turned over, drawn round, with a shadow in amber down and to the right. The name beside it is IBM Plex Sans SemiBold, turned into outlines.

| File | For |
|---|---|
| `primerkit-mark.svg` | The mark on its tile: light pages, and anywhere the mark stands alone |
| `primerkit-mark-bare-dark-mode.svg` | The mark without its tile, on a dark page |
| `primerkit-lockup-light-mode.svg` | The mark and the name, on a light page |
| `primerkit-lockup-dark-mode.svg` | The mark and the name, on a dark page |
| `readme-header-light-mode.svg`, `readme-header-dark-mode.svg` | The header of the README, on a transparent ground, one for each of GitHub's themes |

Each file holds filled paths only, so it needs no font.

- Colours: letters `#e9e3d8` (on dark grounds and the tile), amber `#F59E0B` (the shadow), charcoal `#1f2937` (the tile, and the name on light grounds), `#F9FAFB` (the name on dark grounds).
- Amber is weak on white (2.1 to 1), so on a light page the mark keeps its tile.
- Each lockup keeps a quarter of the mark's height clear on every side.

The session draws the same mark in the terminal, in quadrant blocks (`packages/ui/src/logo.ts`), and the share card draws these paths (`packages/session/src/logo-svg.ts`).

IBM Plex Sans is under the SIL Open Font License 1.1.
