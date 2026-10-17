// PreReason's Sandstone palette, lightened for a dark terminal. Amber is
// kept for PreReason: the PR mark on a line that carries PreReason's data, the
// step that connects PreReason, and the shadow under primerkit's own PK, which shows
// its tie to PreReason.

export type Kind = 'text' | 'line' | 'shape' | 'tile';

export interface Colour {
  name: string;
  hex: string | null;
  bold?: boolean;
  ansi16: string | null;
  ansi16Bg?: string;
  kind?: Kind;
  use: string;
}

export const PALETTE = {
  fg: { name: 'Body text', hex: null, ansi16: null, use: "Sentences, in the terminal's own text colour" },
  bright: { name: 'Headline', hex: '#f3eee6', bold: true, ansi16: '1;97', kind: 'text', use: 'Questions, the chosen option and a failed check' },
  accent: { name: 'Accent', hex: '#ab7c65', ansi16: '33', kind: 'text', use: 'The prompt, check marks, the new or moved mark' },
  accentBold: { name: 'Accent, bold', hex: '#ab7c65', bold: true, ansi16: '1;33', kind: 'text', use: 'Screen headlines, the current step, the name in the top line' },
  muted: { name: 'Muted', hex: '#a89a86', ansi16: '37', ansi16Bg: '47', kind: 'text', use: 'Leads, check results and secondary text' },
  dim: { name: 'Dim', hex: '#948471', ansi16: '90', ansi16Bg: '100', kind: 'text', use: 'Sources, help, placeholders and the steps to come' },
  rule: { name: 'Lines', hex: '#8b6153', ansi16: '90', kind: 'line', use: 'The line down the left of a block, and the rail' },
  chart: { name: 'Chart', hex: '#d9ae8c', ansi16: '97', ansi16Bg: '107', kind: 'text', use: 'The main series of a chart' },
  // Green and red mark only the direction of a change the data states, on every screen and
  // the market map too: never a label, a rule's output, an order or the model's own words.
  up: { name: 'Rose', hex: '#22c55e', ansi16: '32', kind: 'text', use: 'A value that went up, never a view on it' },
  down: { name: 'Fell', hex: '#f04b4b', ansi16: '31', kind: 'text', use: 'A value that went down, never a view on it' },
  pr: { name: 'PreReason', hex: '#f59e0b', bold: true, ansi16: '1;93', kind: 'text', use: "The PR mark, only on a line that carries PreReason's data and on the step that connects PreReason" },
  prTile: { name: 'PreReason tile', hex: '#1f2937', ansi16: '90', ansi16Bg: '100', kind: 'tile', use: "The square behind the large PR mark, as in PreReason's logo" },
  pkLetter: { name: 'Mark', hex: '#e9e3d8', ansi16: '97', kind: 'shape', use: "The letters of primerkit's PK mark" },
  // In 16 colours the shadow is yellow, not bright yellow: most terminals draw yellow as a
  // dark gold near amber, and bright yellow as a pale lemon.
  pkShadow: { name: 'Mark shadow', hex: '#f59e0b', ansi16: '33', ansi16Bg: '43', kind: 'shape', use: "The PK's shadow, in PreReason's amber" },
  // A panel's frame: the title bar over a screen and the status strip under it, a band a
  // shade above the terminal's ground, with the function's code on a sandstone tile. Each
  // is held to the text bar against the colour it is drawn on (PAIRS, below).
  bar: { name: 'Panel bar', hex: '#2a231d', ansi16: '90', ansi16Bg: '100', use: 'The band of the title bar and the status strip' },
  barText: { name: 'Panel bar text', hex: '#efe8dd', ansi16: '97', use: 'The subject and the values on a panel bar' },
  barDim: { name: 'Panel bar label', hex: '#b9aa95', ansi16: '37', use: 'The labels, the date and the source on a panel bar' },
  code: { name: 'Function code', hex: '#1a1410', bold: true, ansi16: '1;30', use: "A function's code on its tile, such as DIGEST" },
  codeTile: { name: 'Function code tile', hex: '#d9ae8c', ansi16: '37', ansi16Bg: '47', use: 'The tile behind a function code' },
  // The heatmap: a cell's tile green for a rise and red for a fall, deeper for a larger move
  // among its column's rows. Sixteen colours have one depth each way.
  heatInk: { name: 'Heatmap ink', hex: '#ffffff', ansi16: '97', use: 'The change written on a heatmap tile' },
  heatUp1: { name: 'Rise, light', hex: '#123d22', ansi16: '32', ansi16Bg: '42', use: 'A heatmap tile: a small rise' },
  heatUp2: { name: 'Rise', hex: '#16592e', ansi16: '32', ansi16Bg: '42', use: 'A heatmap tile: a rise' },
  heatUp3: { name: 'Rise, deep', hex: '#1b7a3c', ansi16: '32', ansi16Bg: '42', use: 'A heatmap tile: a large rise' },
  heatDown1: { name: 'Fall, light', hex: '#4a1717', ansi16: '31', ansi16Bg: '41', use: 'A heatmap tile: a small fall' },
  heatDown2: { name: 'Fall', hex: '#6e1f1f', ansi16: '31', ansi16Bg: '41', use: 'A heatmap tile: a fall' },
  heatDown3: { name: 'Fall, deep', hex: '#962a2a', ansi16: '31', ansi16Bg: '41', use: 'A heatmap tile: a large fall' },
} satisfies Record<string, Colour>;

// Colours drawn on another colour rather than on the terminal's ground, held to the text bar
// against it: the panel bar's text, and the code on its tile.
export const PAIRS: ReadonlyArray<readonly [fore: string, back: string]> = [
  ['barText', 'bar'],
  ['barDim', 'bar'],
  ['code', 'codeTile'],
  ['heatInk', 'heatUp1'],
  ['heatInk', 'heatUp2'],
  ['heatInk', 'heatUp3'],
  ['heatInk', 'heatDown1'],
  ['heatInk', 'heatDown2'],
  ['heatInk', 'heatDown3'],
];

export type Role = keyof typeof PALETTE | 'tag' | 'ph' | 'cursor';

// Roles that are other roles under another name.
const ALIAS: Record<string, keyof typeof PALETTE> = { tag: 'muted', ph: 'dim', cursor: 'bright' };

// Readers used to red for a rise, as in Japan, Korea, China and Taiwan, swap the pair
// with one setting, rise_colour: red.
let riseRed = false;
export function setRiseRed(on: boolean): void {
  riseRed = on;
}
const SWAP: Record<string, keyof typeof PALETTE> = { up: 'down', down: 'up' };

export function styleOf(role: string): Colour {
  const name = ALIAS[role] ?? (role as keyof typeof PALETTE);
  const swapped = riseRed ? (SWAP[name] ?? name) : name;
  return (PALETTE as Record<string, Colour>)[swapped] ?? PALETTE.fg;
}

// A role written 'pr/prTile' draws in the first colour over the second: a half
// block then shows two colours in one character.
export function stylesOf(role: string): [Colour, Colour | null] {
  const [fore, back] = role.split('/');
  return [styleOf(fore ?? 'fg'), back ? styleOf(back) : null];
}

// Readability, measured rather than judged. Every colour is held against the three
// black backgrounds most terminals open with, to WCAG 2.2's bars: 4.5 to 1 for text
// (1.4.3) and 3 to 1 for lines and shapes (1.4.11). The PR tile sits behind amber,
// so the amber is held to the text bar against it.
export const BACKGROUNDS: ReadonlyArray<readonly [string, string]> = [
  ['Black', '#000000'],
  ['Windows Terminal', '#0c0c0c'],
  ['VS Code', '#1e1e1e'],
];
export const BARS: Record<Exclude<Kind, 'tile'>, number> = { text: 4.5, line: 3, shape: 3 };

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface Measured {
  role: string;
  hex: string;
  kind: Kind;
  bar: number;
  against: string[];
  ratios: number[];
  pass: boolean;
}

export function readability(palette: Record<string, Colour> = PALETTE): Measured[] {
  return Object.entries(palette)
    .filter(([, p]) => p.kind && p.hex)
    .map(([role, p]) => {
      const kind = p.kind as Kind;
      const hex = p.hex as string;
      const against = kind === 'tile' ? [['the amber on it', (palette.pr ?? PALETTE.pr).hex as string] as const] : BACKGROUNDS;
      const bar = kind === 'tile' ? BARS.text : BARS[kind];
      const ratios = against.map(([, bg]) => contrast(hex, bg));
      return { role, hex, kind, bar, against: against.map(([name]) => name), ratios, pass: ratios.every((r) => r >= bar) };
    });
}

// A colour below its bar stops the program, so a change to the palette cannot slip one through.
export function pairReadability(palette: Record<string, Colour> = PALETTE): Array<{ pair: string; ratio: number; pass: boolean }> {
  return PAIRS.map(([fore, back]) => {
    const ratio = contrast(palette[fore]?.hex ?? '#000000', palette[back]?.hex ?? '#000000');
    return { pair: `${fore} on ${back}`, ratio, pass: ratio >= BARS.text };
  });
}

export function checkReadability(palette: Record<string, Colour> = PALETTE): void {
  const pairs = pairReadability(palette).filter((p) => !p.pass);
  if (pairs.length) throw new Error(`below its contrast bar: ${pairs.map((p) => p.pair).join(', ')}`);
  const low = readability(palette).filter((r) => !r.pass);
  if (low.length) throw new Error(`below its contrast bar: ${low.map((r) => `${r.role} ${r.hex}`).join(', ')}`);
}
