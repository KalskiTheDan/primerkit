import { distance, pathPieces } from './path';
import type { Line, Maker } from './segments';

// primerkit's logo in the terminal: the PK, and the name beside it. The mark is the one in
// assets/logo: PreReason's P, with its open stem, and a K whose leg is R's tail and whose arm
// is that tail turned over, drawn round at stroke 19, with a shadow in PreReason's amber down
// and to the right. Here it is drawn bare, as on any dark page, in quadrant blocks: two by two
// pixels to a character, characters every terminal font has.

export const TAGLINE = 'financial research on your own model';

const PK_PATH =
  'M0,0 L15,0 C37,0 50,13 50,30 C50,47 37,60 15,60 L0,60 M0,60 L0,110 M0,0 L0,20 M80,0 L80,110 M80,62 C90,60 103,45 108,30 C113,15 120,0 130,0 M80,58 C90,60 103,75 108,90 C113,105 120,112 130,112';
const STROKE = 19;
const DROP = 7;
// The letters with their shadow, in the path's units.
const BOX = { x: -STROKE / 2, y: -STROKE / 2, w: 130 + STROKE + DROP, h: 112 + STROKE + DROP };
// A character is about 2.1 times as tall as it is wide, so a quadrant pixel is too.
const CELL_HEIGHT = 2.1;

type Ink = 'pkLetter' | 'pkShadow' | null;

// The mark on a grid of 2 by 2 pixels to each of cols by rows characters. A pixel is a
// letter where the letters cover enough of it, else shadow where the shadow does.
function rasterPk(cols: number, rows: number, samples = 6, ink = 0.45): Ink[][] {
  const w = cols * 2;
  const h = rows * 2;
  const ph = CELL_HEIGHT / 2;
  const s = Math.min((w * 0.5) / BOX.w, (h * ph) / BOX.h);
  const ox = (w * 0.5 - BOX.w * s) / 2;
  const oy = (h * ph - BOX.h * s) / 2;
  const pieces = pathPieces(PK_PATH);
  const on = (x: number, y: number): boolean => pieces.some((p) => distance(x, y, p) <= STROKE / 2);
  return Array.from({ length: h }, (_, j) =>
    Array.from({ length: w }, (_, i): Ink => {
      let letters = 0;
      let shadow = 0;
      for (let a = 0; a < samples; a++) {
        for (let b = 0; b < samples; b++) {
          const x = ((i + (a + 0.5) / samples) * 0.5 - ox) / s + BOX.x;
          const y = ((j + (b + 0.5) / samples) * ph - oy) / s + BOX.y;
          if (on(x, y)) letters++;
          else if (on(x - DROP, y - DROP)) shadow++;
        }
      }
      const n = samples * samples;
      if (letters / n >= ink) return 'pkLetter';
      if (shadow / n >= ink) return 'pkShadow';
      if ((letters + shadow) / n >= ink) return letters >= shadow ? 'pkLetter' : 'pkShadow';
      return null;
    }),
  );
}

// The quadrant blocks by the pixels they fill: top left 1, top right 2, bottom left 4,
// bottom right 8.
export const QUADRANTS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'] as const;

// Pixels as quadrant blocks. A character's letters draw in front; behind them goes the
// shadow where it holds more of the character than the terminal's own ground does.
function quadrantCells(px: Ink[][]): Line[] {
  const rows = px.length / 2;
  const cols = (px[0]?.length ?? 0) / 2;
  return Array.from({ length: rows }, (_, r) => {
    const segs: Line = [];
    for (let c = 0; c < cols; c++) {
      const four = [px[2 * r]?.[2 * c], px[2 * r]?.[2 * c + 1], px[2 * r + 1]?.[2 * c], px[2 * r + 1]?.[2 * c + 1]].map((p) => p ?? null);
      const count = (ink: Ink) => four.filter((p) => p === ink).length;
      const fore: Ink = count('pkLetter') ? 'pkLetter' : count('pkShadow') ? 'pkShadow' : null;
      const back = fore === 'pkLetter' && count('pkShadow') > count(null) ? 'pkShadow' : null;
      const mask = four.reduce((m, p, i) => (p === fore ? m | (1 << i) : m), 0);
      const cell: [string, string] = !fore ? ['fg', ' '] : [back ? `${fore}/${back}` : fore, QUADRANTS[mask] ?? ' '];
      const last = segs[segs.length - 1];
      if (last && last[0] === cell[0]) last[1] += cell[1];
      else segs.push(cell);
    }
    return segs;
  });
}

// Three sizes: the large on the welcome screen and with --version, the small where a screen
// has the room for it, and the mini on the launchpad, beside the connections.
export type MarkSize = 'large' | 'small' | 'mini';
const SIZES: Record<MarkSize, [number, number]> = { large: [21, 10], small: [17, 8], mini: [12, 6] };

// The columns and rows the mark alone takes at a size.
export function markSize(size: MarkSize): { columns: number; rows: number } {
  const [columns, rows] = SIZES[size];
  return { columns, rows };
}
const drawn = new Map<MarkSize, Line[]>();

export function pkMark(size: MarkSize = 'large'): Line[] {
  let lines = drawn.get(size);
  if (!lines) {
    const [cols, rows] = SIZES[size];
    lines = quadrantCells(rasterPk(cols, rows));
    drawn.set(size, lines);
  }
  return lines.map((line) => line.map(([role, text]): [string, string] => [role, text]));
}

// The lockup: the mark with the name beside it, and the tagline under the name, on the
// mark's middle rows. Plain text has no mark: the name and the tagline alone.
export function lockup(t: Maker, plain: boolean, size: MarkSize = 'large'): Line[] {
  if (plain) return [[t('bright', ' primerkit')], [t('tag', ` ${TAGLINE}`)]];
  const mark = pkMark(size);
  const mid = Math.floor(mark.length / 2);
  return mark.map((row, i): Line => {
    const beside = i === mid - 1 ? [t('bright', 'primerkit')] : i === mid ? [t('tag', TAGLINE)] : [];
    return [['fg', ' '], ...row, ...(beside.length ? [['fg', '   '] as [string, string], ...beside] : [])];
  });
}

// The columns the lockup takes, the leading space included.
export function lockupWidth(size: MarkSize = 'large'): number {
  return 1 + SIZES[size][0] + 3 + TAGLINE.length;
}
