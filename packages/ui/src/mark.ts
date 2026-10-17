import { distance, pathPieces } from './path';
import type { Line, Maker } from './segments';

// PreReason's mark, drawn in 13 by 6 characters on the one step that connects
// PreReason. In sextants it has 26 by 18 pixels, drawn from the logo's own path; in
// half blocks, the fallback where sextants are not drawn, 13 by 12 pixels placed by
// hand; plain, ASCII.

// The logo's own geometry: its path from PreReason's public/logos/logo-mark.svg,
// stroked 10 wide with round ends, on its rounded tile.
const PR_PATH =
  'M0,0 L15,0 C37,0 50,13 50,30 C50,47 37,60 15,60 L0,60 M0,60 L0,110 M0,0 L0,20 M72,0 L87,0 C109,0 122,13 122,30 C122,47 109,60 87,60 L72,60 M72,60 C82,62 95,75 100,90 C105,105 112,112 122,112';
const PR_VIEW = { x: -21, y: -27, w: 164, h: 164, r: 18, stroke: 10 };

type Pixel = 'pr' | 'prTile' | null;

// Where a pixel holds two colours, the one earlier in this list draws in front.
const INK = ['pr', 'prTile'];

// The logo on a grid of w by h pixels over its square tile.
function rasterMark(w: number, h: number, tile: boolean, samples = 5, ink = 0.4): Pixel[][] {
  const pieces = pathPieces(PR_PATH);
  const { x: vx, y: vy, w: vw, h: vh, r, stroke } = PR_VIEW;
  const inTile = (x: number, y: number): boolean => {
    const cx = Math.min(Math.max(x, vx + r), vx + vw - r);
    const cy = Math.min(Math.max(y, vy + r), vy + vh - r);
    return x >= vx && y >= vy && x <= vx + vw && y <= vy + vh && Math.hypot(x - cx, y - cy) <= r;
  };
  return Array.from({ length: h }, (_, j) =>
    Array.from({ length: w }, (_, i): Pixel => {
      let strokes = 0;
      let tiles = 0;
      for (let a = 0; a < samples; a++) {
        for (let b = 0; b < samples; b++) {
          const x = vx + ((i + (a + 0.5) / samples) / w) * vw;
          const y = vy + ((j + (b + 0.5) / samples) / h) * vh;
          if (pieces.some((p) => distance(x, y, p) <= stroke / 2)) strokes++;
          else if (inTile(x, y)) tiles++;
        }
      }
      const n = samples * samples;
      if (strokes / n >= ink) return 'pr';
      return tile && (strokes + tiles) / n >= 0.5 ? 'prTile' : null;
    }),
  );
}

// Sextants: two by three pixels to a character (Unicode 13). Sixty of the 64
// patterns have a character of their own; the other four are a space, a full block
// and the two half blocks down a side.
export function sextant(mask: number): string {
  if (mask === 0) return ' ';
  if (mask === 63) return '█';
  if (mask === 21) return '▌';
  if (mask === 42) return '▐';
  return String.fromCodePoint(0x1fb00 + mask - 1 - (mask > 21 ? 1 : 0) - (mask > 42 ? 1 : 0));
}

// Pixels of up to two colours as sextants: the inkier colour draws the pixels it
// holds and the other fills behind them.
function sextantCells(px: Pixel[][]): Line[] {
  const rows = Math.ceil(px.length / 3);
  const cols = Math.ceil((px[0]?.length ?? 0) / 2);
  return Array.from({ length: rows }, (_, r) => {
    const segs: Line = [];
    for (let c = 0; c < cols; c++) {
      const pixels: Array<[Pixel, number]> = [];
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 2; dx++) pixels.push([px[r * 3 + dy]?.[c * 2 + dx] ?? null, 1 << (dy * 2 + dx)]);
      }
      const present = [...new Set(pixels.map(([p]) => p).filter((p): p is 'pr' | 'prTile' => p !== null))].sort(
        (a, b) => INK.indexOf(a) - INK.indexOf(b),
      );
      const [fore, back] = present;
      const mask = pixels.reduce((m, [p, bit]) => (p === fore ? m | bit : m), 0);
      let cell: [string, string];
      if (!fore) cell = ['fg', ' '];
      else if (mask === 63) cell = [fore, '█'];
      else if (back) cell = [`${fore}/${back}`, sextant(mask)];
      else cell = [fore, sextant(mask)];
      const last = segs[segs.length - 1];
      if (last && last[0] === cell[0]) last[1] += cell[1];
      else segs.push(cell);
    }
    return segs;
  });
}

// The half block fallback, placed by hand on 11 by 10 pixels.
const PR_PIXELS = [
  '####..####.',
  '#...#.....#',
  '....#.....#',
  '....#.....#',
  '....#.....#',
  '####..####.',
  '#......#...',
  '#.......#..',
  '#.......#..',
  '#........##',
];

function halfBlockPixels(tile: boolean): Pixel[][] {
  const m = tile ? 1 : 0;
  const w = (PR_PIXELS[0]?.length ?? 0) + 2 * m;
  const h = PR_PIXELS.length + 2 * m;
  const px = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x): Pixel => {
      const corner = (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
      return tile && !corner ? 'prTile' : null;
    }),
  );
  PR_PIXELS.forEach((row, y) => Array.from(row).forEach((ch, x) => {
    if (ch === '#') px[y + m]![x + m] = 'pr';
  }));
  return px;
}

function halfBlockCells(px: Pixel[][]): Line[] {
  const lines: Line[] = [];
  for (let y = 0; y < px.length; y += 2) {
    const segs: Line = [];
    const row = px[y] ?? [];
    for (let x = 0; x < row.length; x++) {
      const top = row[x] ?? null;
      const bot = px[y + 1]?.[x] ?? null;
      let cell: [string, string];
      if (top === bot) cell = top ? [top, '█'] : ['fg', ' '];
      else if (!top) cell = [bot as string, '▄'];
      else if (!bot) cell = [top, '▀'];
      else if (INK.indexOf(top) < INK.indexOf(bot)) cell = [`${top}/${bot}`, '▀'];
      else cell = [`${bot}/${top}`, '▄'];
      const last = segs[segs.length - 1];
      if (last && last[0] === cell[0]) last[1] += cell[1];
      else segs.push(cell);
    }
    lines.push(segs);
  }
  return lines;
}

// The plain mark: # where both pixels of a character are set, " for the upper one, _ for the lower.
export const PR_MARK_PLAIN: readonly string[] = [0, 2, 4, 6, 8].map((y) =>
  Array.from(PR_PIXELS[y] ?? '', (a, x) => {
    const b = PR_PIXELS[y + 1]?.[x];
    return a === '#' && b === '#' ? '#' : a === '#' ? '"' : b === '#' ? '_' : ' ';
  }).join(''),
);

export type MarkStyle = 'sextants' | 'halves';

export function prMark(t: Maker, plain: boolean, { tile = true, style = 'sextants' as MarkStyle } = {}): Line[] {
  if (plain) return PR_MARK_PLAIN.map((row) => [t('fg', row)]);
  if (style === 'halves') return halfBlockCells(halfBlockPixels(tile));
  return sextantCells(rasterMark(26, 18, tile));
}
