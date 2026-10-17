// The gallery: the demo session walked key by key (briefings saved on 2026-10-16, no model, no
// key), each screen drawn as an SVG in the kit's own colours, into docs/gallery with a page that
// shows them all, and four GIFs of the same walk, a frame a step. Run with `npm run gallery`.
// The screens are drawn from the session itself, so they never drift from what a person sees;
// nothing is sent anywhere. Each carries "saved 2026-10-16" in its top right corner.
//
// The same run draws the new screens into docs/gallery/fixtures: /compare, the news door, the
// market charts, the research view and a digest with changes (which the demo's one saved day
// cannot show), each the real session on the fakes and fixtures the
// tests use (scripts/fixture-sessions.ts), with a caption in the picture saying what is made up
// and the words "sample data" in its top right corner.
// Any call out (fetch, node:http or node:https) while these or the demo's screens are drawn
// stops the run before a picture is written.
//
// `npm run gallery -- --keyed` draws a second set into docs/gallery/keyed from a real session on
// the PreReason key in PREREASON_API_KEY, on Claude Sonnet 5.5 with the key in ANTHROPIC_API_KEY:
// boards and charts of live data, which ask no model, and no call to Anthropic is let through.
// `--questions <n> --cap <dollars>` adds up to n answered questions: each call's cost is read
// from its usage, and no question is asked that could take the spend past the cap.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeConfig } from '@primerkit/core';
import { listPrice, type ListPrice, type MachineCheck } from '@primerkit/models';
import { FIRST_RUN_WALK, demoDeps, realDeps, walk, type Key, type SessionDeps, type WalkStep, type WalkedScreen } from '@primerkit/session';
import { charWidth, stylesOf, type Line } from '@primerkit/ui';
import { COMPARE_QUESTION, NEWS_QUESTION, RESEARCH_ROUTINE, compareSession, digestSession, marketSession, newsSession, researchSession } from './fixture-sessions';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'gallery');
const KEYED_OUT = join(OUT, 'keyed');
const FIXTURE_OUT = join(OUT, 'fixtures');

// The look of a terminal window: its background, its text colour, and a cell's size in pixels.
const BACKGROUND = '#16120f';
const TEXT = '#e9e3d8';
const CELL = { width: 8.4, height: 18, font: 14 };
// Fonts whose letters are 0.6 of their size, so at 14 px each fills the 8.4 px cell: words keep
// the terminal's spacing in any of them. Consolas, at 0.55, would leave gaps between words.
const FONTS = "Cascadia Mono, Menlo, 'DejaVu Sans Mono', 'Lucida Console', monospace";
// For pixels drawn here: Consolas at the size that fills the cell, since it has a bold.
const PIXEL_FONT = { family: 'Consolas', size: 15.3 };
const PAD = 16;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The block elements (a bar, a sparkline's step, a shade), drawn for pixels as shapes in the
// text's colour and not as glyphs, whose width differs from font to font: where in its cell the
// shape sits, as shares of the cell, and how opaque a shade is. Crisp edges put two blocks side
// by side on the same pixel, so a bar shows no seams.
export function blockShape(ch: string): { x: number; y: number; w: number; h: number; opacity?: number } | null {
  const c = Array.from(ch).length === 1 ? (ch.codePointAt(0) ?? 0) : 0;
  if (c === 0x2580) return { x: 0, y: 0, w: 1, h: 1 / 2 };
  if (c >= 0x2581 && c <= 0x2588) return { x: 0, y: 1 - (c - 0x2580) / 8, w: 1, h: (c - 0x2580) / 8 };
  if (c >= 0x2589 && c <= 0x258f) return { x: 0, y: 0, w: (0x2590 - c) / 8, h: 1 };
  if (c === 0x2590) return { x: 1 / 2, y: 0, w: 1 / 2, h: 1 };
  if (c >= 0x2591 && c <= 0x2593) return { x: 0, y: 0, w: 1, h: 1, opacity: (c - 0x2590) / 4 };
  if (c === 0x2594) return { x: 0, y: 0, w: 1, h: 1 / 8 };
  if (c === 0x2595) return { x: 7 / 8, y: 0, w: 1 / 8, h: 1 };
  return null;
}

// The quadrant blocks the halves above do not cover (▖ to ▟), which draw primerkit's mark:
// the quarters of the cell each fills, as shapes. Top left, top right, bottom left, bottom right.
const QUARTERS: Record<number, number[]> = { 0x2596: [2], 0x2597: [3], 0x2598: [0], 0x2599: [0, 2, 3], 0x259a: [0, 3], 0x259b: [0, 1, 2], 0x259c: [0, 1, 3], 0x259d: [1], 0x259e: [1, 2], 0x259f: [1, 2, 3] };
export function quadrantShapes(ch: string): Array<{ x: number; y: number; w: number; h: number }> | null {
  const c = Array.from(ch).length === 1 ? (ch.codePointAt(0) ?? 0) : 0;
  return QUARTERS[c]?.map((q) => ({ x: (q % 2) / 2, y: Math.floor(q / 2) / 2, w: 1 / 2, h: 1 / 2 })) ?? null;
}

// A run cut at each character past Latin-1 (↳, ✓, a bar), each with its column, so a renderer
// that falls back to another font for a glyph its font lacks does so for that glyph alone.
const PLAIN = /^[\u0020-\u007e\u00a0-\u00ff]$/;
function glyphRuns(text: string): Array<{ offset: number; text: string }> {
  const runs: Array<{ offset: number; text: string }> = [];
  let column = 0;
  for (const ch of text) {
    const last = runs.at(-1);
    if (last && PLAIN.test(ch) && PLAIN.test(Array.from(last.text).at(-1)!)) last.text += ch;
    else runs.push({ offset: column, text: ch });
    column += charWidth(ch);
  }
  return runs;
}

// The words of a run, each with its column. Drawn one by one at their own columns, with the
// letters at the font's own spacing, a word starts where the terminal puts it whatever font
// draws it: a table's header sits over its column, and nothing is stretched.
function wordRuns(text: string, from = 0): Array<{ offset: number; text: string }> {
  const words: Array<{ offset: number; text: string }> = [];
  let column = from;
  let word: { offset: number; text: string } | null = null;
  for (const ch of text) {
    if (ch === ' ') word = null;
    else if (word) word.text += ch;
    else words.push((word = { offset: column, text: ch }));
    column += charWidth(ch);
  }
  return words;
}

// The colour of a caption drawn under a screen: dimmer than the screen's own text.
const CAPTION = '#a89f92';

// A caption's words in lines of at most `columns` characters, a word never cut.
export function captionLines(caption: string, columns: number): string[] {
  const out: string[] = [];
  for (const word of caption.split(/\s+/).filter(Boolean)) {
    const last = out.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= columns) out[out.length - 1] = `${last} ${word}`;
    else out.push(word);
  }
  return out;
}

// The marks a picture carries in itself, small, in its top right corner, so one that travels
// without its caption (a share, a search result, a repost) still says what it shows. Every
// picture drawn from made-up data says so, and its figures and names never pass as real. The
// demo's pictures show PreReason's saved briefings: their figures are real but not current,
// so they say the day they were saved. The keyed, replay and storyboard ones carry neither.
export const SAMPLE_MARK = 'sample data';
export const SAVED_MARK = 'saved 2026-10-16';

// One screen as an SVG. Each word is placed at its own column, counted as the terminal counts
// it (a wide character takes two), so the screen keeps its columns whatever font the viewer
// falls back to. For pixels, `glyphs` also places each character past Latin-1 on its own.
// A caption is drawn under the screen, in the picture itself, so a screen copied on its own
// still says where it comes from. `mark` is drawn above the screen's top right corner, in the
// padding, where no line of the screen reaches.
export function screenSvg(lines: Line[], columns: number, rows: number, title: string, glyphs = false, caption?: string, mark?: string): string {
  const under = caption ? captionLines(caption, columns) : [];
  const width = Math.round(columns * CELL.width + PAD * 2);
  const height = Math.round(rows * CELL.height + PAD * 2 + (under.length ? PAD / 2 + under.length * CELL.height : 0));
  const parts: string[] = [];
  lines.slice(0, rows).forEach((line, row) => {
    let column = 0;
    const y = PAD + row * CELL.height;
    for (const [role, text] of line) {
      const [fore, back] = stylesOf(role);
      const cells = Array.from(text).reduce((n, ch) => n + charWidth(ch), 0);
      const x = PAD + column * CELL.width;
      if (back?.hex) parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${(cells * CELL.width).toFixed(1)}" height="${CELL.height}" fill="${back.hex}"/>`);
      if (text.trim()) {
        const weight = fore.bold ? ' font-weight="700"' : '';
        // A colour the palette keeps for a shape (primerkit's mark) is drawn as shapes in any
        // picture: as glyphs, its blocks would leave a gap between rows.
        const shaped = glyphs || fore.kind === 'shape';
        const pieces = shaped ? glyphRuns(text) : [{ offset: 0, text }];
        for (const run of pieces.flatMap((p) => wordRuns(p.text, p.offset))) {
          const at = x + run.offset * CELL.width;
          const block = shaped ? blockShape(run.text) : null;
          const shapes: Array<{ x: number; y: number; w: number; h: number; opacity?: number }> | null = block ? [block] : shaped ? quadrantShapes(run.text) : null;
          if (shapes) {
            for (const shape of shapes) {
              const opacity = shape.opacity ? ` fill-opacity="${shape.opacity}"` : '';
              parts.push(`<rect x="${(at + shape.x * CELL.width).toFixed(2)}" y="${(y + shape.y * CELL.height).toFixed(2)}" width="${(shape.w * CELL.width).toFixed(2)}" height="${(shape.h * CELL.height).toFixed(2)}" fill="${fore.hex ?? TEXT}"${opacity} shape-rendering="crispEdges"/>`);
            }
          } else parts.push(`<text x="${at.toFixed(1)}" y="${y + CELL.height - 5}" fill="${fore.hex ?? TEXT}"${weight}>${xml(run.text)}</text>`);
        }
      }
      column += cells;
    }
  });
  under.forEach((text, i) => parts.push(`<text x="${PAD}" y="${PAD + (rows + i) * CELL.height + PAD / 2 + CELL.height - 5}" fill="${CAPTION}">${xml(text)}</text>`));
  if (mark) parts.push(`<text x="${width - PAD}" y="${PAD - 4}" fill="${CAPTION}" font-size="12" text-anchor="end">${xml(mark)}</text>`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title)}">`,
    `<rect width="100%" height="100%" rx="8" fill="${BACKGROUND}"/>`,
    `<g font-family="${FONTS}" font-size="${CELL.font}" xml:space="preserve">`,
    ...parts,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

const enter: Key = { name: 'enter' };
const esc: Key = { name: 'escape' };
const typed = (text: string): Key[] => Array.from(text, (char): Key => ({ name: 'char', char }));
// A command, then closed with two Escs, so the next is typed into an empty line.
const command = (title: string, text: string): WalkStep[] => [
  { title, keys: [...typed(text), enter] },
  { title: `${title}, closed`, keys: [esc, esc] },
];

// The first set: the first run, then what the menu offers that reads best as a picture.
export const GALLERY: WalkStep[] = [
  ...FIRST_RUN_WALK,
  { title: 'The menu, / typed', keys: typed('/') },
  { title: 'The menu closed', keys: [esc, { name: 'backspace' }] },
  ...command('A briefing as a board: /brief macro.snapshot', '/brief macro.snapshot'),
  ...command("Bitcoin's context: /brief btc.context", '/brief btc.context'),
  ...command('The yield curve: /chart yield curve', '/chart yield curve'),
  ...command('Correlations: /chart correlations', '/chart correlations'),
  // Bitcoin, the Treasury, hashprice, net liquidity and the ETF flows read briefings the demo
  // does not hold: the keyed set holds them.
  ...command('The catalog: /catalog', '/catalog'),
  ...command('The digest: /digest', '/digest'),
  ...command('A question the demo answers', 'Is net liquidity rising or falling?'),
];

// The keyed set: live boards and charts, the markets first, in groups that each fit inside
// PreReason's limit of calls a minute, with a rest of two minutes between. The board, hashprice and
// the ETF flows read the days the scratch journal lacks (fill, a call a day), so their 30 days
// are drawn; the journal keeps them for the later groups.
export const KEYED: WalkStep[][] = [
  [
    ...command('The markets as a board: /brief macro.snapshot fill', '/brief macro.snapshot fill'),
    ...command('The yield curve: /chart yield curve', '/chart yield curve'),
    ...command('The Treasury: /chart treasury', '/chart treasury'),
    ...command('Net liquidity: /chart liquidity', '/chart liquidity'),
    ...command('Correlations: /chart correlations', '/chart correlations'),
  ],
  [...command('ETF flows: /chart etf flows fill', '/chart etf flows fill'), ...command('The catalog: /catalog', '/catalog')],
  [...command('Hashprice: /chart hashprice fill', '/chart hashprice fill'), ...command('Bitcoin, 90 days: /chart bitcoin 90d', '/chart bitcoin 90d'), ...command("Bitcoin's context: /brief btc.context", '/brief btc.context')],
];
// A minute was not always enough on 10-11: after two fills a minute apart, the third was refused.
const PACE_MS = 125_000;

// The same session in a wide window for a hero image, and in a small one to show it fits.
export const KEYED_SIZES: Array<{ columns: number; rows: number; steps: WalkStep[] }> = [
  { columns: 120, rows: 40, steps: [...command('Wide: /brief macro.snapshot', '/brief macro.snapshot'), ...command('Wide: /chart yield curve', '/chart yield curve')] },
  { columns: 80, rows: 24, steps: [...command('Small: /brief macro.snapshot', '/brief macro.snapshot'), ...command('Small: /chart yield curve', '/chart yield curve')] },
];

// The questions a hosted model answers for the keyed set, the markets first.
export const QUESTIONS = ['Is the yield curve still inverted, and is it steepening?', 'Is net liquidity rising or falling?', 'What is the Treasury market saying this week?', 'How are ETF flows trending?'];

// The screens worth a picture: a step whose title says it was closed shows home again, and a
// chart the briefings cannot draw says "Not drawn".
const kept = (s: { title: string; lines: Line[] }) => !/, closed$|^The menu closed$/.test(s.title) && !s.lines.some((l) => l.some(([, t]) => t.includes('Not drawn')));

const fileOf = (i: number, title: string, ext = 'svg') => `${String(i + 1).padStart(2, '0')}-${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}.${ext}`;

// The GIFs: the demo walked again, a frame for each step that holds a time, for that time in
// milliseconds. Steps with no time only bring the session to where the GIF starts.
type Frame = WalkStep & { hold?: number };
const HOME: Frame[] = FIRST_RUN_WALK.slice(0, 9);
// A text typed a few characters a frame, as a person types it.
const typing = (title: string, text: string, every = 4): Frame[] =>
  Array.from({ length: Math.ceil(text.length / every) }, (_, i) => ({ title: `${title} ${i}`, keys: typed(text.slice(i * every, (i + 1) * every)), wait: false, hold: 90 }));
const shown = (title: string, text: string, hold: number): Frame[] => [
  ...typing(title, text),
  { title, keys: [enter], hold },
  { title: `${title}, closed`, keys: [esc, esc] },
];

export const GIFS: Array<{ file: string; title: string; frames: Frame[] }> = [
  { file: 'first-run.gif', title: 'The first run', frames: FIRST_RUN_WALK.map((s) => ({ ...s, hold: s.wait === false ? 900 : 1800 })) },
  {
    file: 'a-question.gif',
    title: 'A question typed, and answered with its citations',
    frames: [...HOME, { title: 'Home', keys: [], hold: 1200 }, ...typing('Typing', 'Is net liquidity rising or falling?'), { title: 'While it runs', keys: [enter], wait: false, hold: 900 }, { title: 'Answered', keys: [], hold: 4000 }],
  },
  // The first run's own question, answered with its cited lines and checks, ending on home
  // before any question is typed there.
  {
    file: 'a-first-answer.gif',
    title: 'The first question, answered with its cited lines and checks, then home',
    frames: [...FIRST_RUN_WALK.slice(0, 3), { ...FIRST_RUN_WALK[3]!, hold: 2200 }, { ...FIRST_RUN_WALK[4]!, hold: 900 }, { ...FIRST_RUN_WALK[5]!, hold: 3500 }, ...FIRST_RUN_WALK.slice(6, 9), { title: 'Home', keys: [], hold: 4000 }],
  },
  {
    file: 'boards-and-charts.gif',
    title: 'A board and two charts',
    frames: [...HOME, ...shown('A board', '/brief macro.snapshot', 3000), ...shown('The yield curve', '/chart yield curve', 2500), ...shown('Correlations', '/chart correlations', 2500)],
  },
  { file: 'digest.gif', title: 'The digest', frames: [...HOME, ...shown('The digest', '/digest', 4000)] },
];

type Rgba = { width: number; height: number; pixels: Uint8Array };
type Gifenc = {
  GIFEncoder(): { writeFrame(index: Uint8Array, width: number, height: number, options: { palette: number[][]; delay: number }): void; finish(): void; bytes(): Uint8Array };
  quantize(rgba: Uint8Array, maxColors: number): number[][];
  applyPalette(rgba: Uint8Array, palette: number[][]): Uint8Array;
};

// A screen's SVG drawn to pixels with resvg, in Consolas at the size that fills the cell.
export async function rasterise(svg: string): Promise<Rgba> {
  const { Resvg } = (await import('@resvg/resvg-js')) as { Resvg: new (svg: string, o: object) => { render(): { width: number; height: number; pixels: Uint8Array } } };
  const drawn = svg.replace(`font-family="${FONTS}" font-size="${CELL.font}"`, `font-family="${PIXEL_FONT.family}" font-size="${PIXEL_FONT.size}"`);
  const image = new Resvg(drawn, { font: { loadSystemFonts: true, defaultFontFamily: PIXEL_FONT.family } }).render();
  return { width: image.width, height: image.height, pixels: new Uint8Array(image.pixels) };
}

// Frames to one looping GIF, each with its own palette (a terminal has few colours).
export function gifOf(frames: Array<Rgba & { delay: number }>): Uint8Array {
  // gifenc is CommonJS with named exports, which require reads the same way everywhere.
  const { GIFEncoder, quantize, applyPalette } = createRequire(import.meta.url)('gifenc') as Gifenc;
  const gif = GIFEncoder();
  for (const f of frames) {
    const palette = quantize(f.pixels, 256);
    gif.writeFrame(applyPalette(f.pixels, palette), f.width, f.height, { palette, delay: f.delay });
  }
  gif.finish();
  return gif.bytes();
}

// A GIF's frames as screens drawn for pixels, each with its time: the walk's steps that hold one.
export type GifFrame = { svg: string; delay: number };
async function gifFrames(deps: SessionDeps, frames: Frame[], columns: number, rows: number, caption?: string, mark?: string): Promise<GifFrame[]> {
  const screens = await walk(deps, frames, false, { columns, rows });
  return frames.flatMap((f, i) => (f.hold ? [{ svg: screenSvg(screens[i]!.lines, columns, rows, f.title, true, caption, mark), delay: f.hold }] : []));
}

// Each GIF's frames drawn to pixels and made one GIF, inside the guard as its frames were.
async function drawGifs(gifs: Array<{ file: string; frames: GifFrame[] }>): Promise<Array<{ file: string; bytes: Uint8Array }>> {
  return offline(async () => {
    const out: Array<{ file: string; bytes: Uint8Array }> = [];
    for (const g of gifs) {
      const drawn: Array<Rgba & { delay: number }> = [];
      for (const f of g.frames) drawn.push({ ...(await rasterise(f.svg)), delay: f.delay });
      out.push({ file: g.file, bytes: gifOf(drawn) });
    }
    return out;
  });
}

// What a call to Claude Sonnet 5.5 costs, in dollars a million tokens: input and output, and
// the cache's reads and five minute writes, from the price table the session states costs from.
export const SONNET = { model: 'claude-sonnet-5-5', ...(listPrice('claude-sonnet-5-5') as ListPrice) };
export interface AnthropicUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
export function costOf(u: AnthropicUsage, p = SONNET): number {
  return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6;
}

// The purse for the paid questions. Every answer from Anthropic adds its cost, read from its
// usage; a call once the cap is reached is refused before it goes; and a question is asked
// only while the dearest one so far (or a first guess, before any) still fits under the cap.
export class Purse {
  spent = 0;
  dearest = 0;
  calls = 0;
  constructor(readonly cap: number, readonly firstGuess = 0.15) {}

  wrap(inner: typeof fetch): typeof fetch {
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https://api.anthropic.com/')) return inner(input, init);
      if (this.spent >= this.cap) throw new Error(`the spending cap of $${this.cap.toFixed(2)} is reached, so nothing more is asked`);
      const res = await inner(input, init);
      if (res.ok && new URL(url).pathname.endsWith('/messages')) {
        this.calls += 1;
        this.spent += costOf(((await res.clone().json()) as { usage?: AnthropicUsage }).usage ?? {});
      }
      return res;
    };
  }

  canAsk(): boolean {
    return this.spent + (this.dearest || this.firstGuess) <= this.cap;
  }

  asked(before: number): void {
    this.dearest = Math.max(this.dearest, this.spent - before);
  }
}

// A key must never reach a picture: any screen that holds one is refused, and nothing is written.
export function refuseKeys(svgs: string[], keys: Array<string | undefined>): void {
  const held = keys.filter((k): k is string => Boolean(k && k.length >= 8));
  if (svgs.some((svg) => held.some((k) => svg.includes(k)))) throw new Error('a screen holds a key, so no picture was written');
}

// A set's SVGs and its page; `more` is the page's further parts, after the set's own screens.
function writeSet(dir: string, intro: string, shots: Array<{ file: string; title: string; svg: string }>, gifs: Array<{ file: string; title: string }> = [], more: string[] = []): void {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.svg')) rmSync(join(dir, f));
  for (const s of shots) writeFileSync(join(dir, s.file), s.svg);
  writeFileSync(
    join(dir, 'README.md'),
    [
      '# The gallery',
      '',
      intro,
      '',
      ...(gifs.length ? ['## Moving pictures', '', ...gifs.flatMap(({ file, title }) => [`### ${title}`, '', `![${title}](${file})`, ''])] : []),
      ...shots.flatMap(({ file, title }) => [`## ${title}`, '', `![${title}](${file})`, '']),
      ...more,
    ].join('\n'),
  );
}

// The machine the demo pictures show, the same on every machine that draws them: Claude Code
// installed, no key set, no local model running.
export const GALLERY_MACHINE: MachineCheck = { apps: ['Claude Code'], keys: [], local: [], ollama: 'absent' };

const demoOf = (): SessionDeps => ({ ...demoDeps({ version: 'gallery' }), checkMachine: async () => GALLERY_MACHINE });

// The page's opening: what the demo's pictures are and the day they carry, then the list of
// pictures not to use in public until they are redrawn (kept by hand: a key redraws them).
export const DO_NOT_USE = 'DO-NOT-USE.md';
export const demoIntro = (columns = 100, rows = 30): string =>
  [
    `The demo session at ${columns} by ${rows}, walked key by key: briefings saved on 2026-10-16, no model, no key. Drawn by \`npm run gallery\` from the session itself; each GIF is the same walk, a frame a step. Each demo picture carries "${SAVED_MARK}" in its top right corner: its figures are PreReason's as saved that day, not today's.`,
    '',
    `Some pictures here are not to be used in public until they are redrawn: [${DO_NOT_USE}](${DO_NOT_USE}) lists each one and why.`,
  ].join('\n');

// The demo set's screens, as they are written, drawn inside the guard that refuses a call out,
// as the new screens are, each with the day its briefings were saved.
export async function demoShots(steps: WalkStep[] = GALLERY, columns = 100, rows = 30, deps: () => SessionDeps = demoOf): Promise<Array<{ file: string; title: string; svg: string }>> {
  return offline(async () => (await walk(deps(), steps, false, { columns, rows })).filter(kept).map((s, i) => ({ file: fileOf(i, s.title), title: s.title, svg: screenSvg(s.lines, columns, rows, s.title, false, undefined, SAVED_MARK) })));
}

// The demo's GIFs, frame by frame as they are drawn for pixels, inside the same guard, each
// frame with the day its briefings were saved.
export async function demoGifFrames(gifs = GIFS, columns = 100, rows = 30, deps: () => SessionDeps = demoOf): Promise<Array<{ file: string; frames: GifFrame[] }>> {
  return offline(async () => {
    const out: Array<{ file: string; frames: GifFrame[] }> = [];
    for (const g of gifs) out.push({ file: g.file, frames: await gifFrames(deps(), g.frames, columns, rows, undefined, SAVED_MARK) });
    return out;
  });
}

// ------------------------------------------------------------------ the new screens, from fixtures

// The new screens are the real session on the fakes and fixtures the tests use. Each caption
// says what is made up, and the picture carries it too.
export type FixtureGroup = 'compare' | 'news' | 'markets' | 'research' | 'digest';
export const FIXTURE_GROUPS: Array<{ group: FixtureGroup; title: string }> = [
  { group: 'compare', title: '/compare' },
  { group: 'news', title: 'The news door' },
  { group: 'markets', title: 'The market map and positioning' },
  { group: 'research', title: 'The research view' },
  { group: 'digest', title: "The digest's changes" },
];

// What is made up on each group's screens. The compare's briefing side reads the demo's saved
// briefings, which PreReason served, so that is said of it, not that it is made up.
export const MADE_UP: Record<FixtureGroup, string> = {
  compare: "Drawn from test fixtures, not a live run: the web text and what each side used are made up, and the briefing side is a stand-in for Claude that lifts lines from the demo's briefings saved on 2026-09-25.",
  news: 'Drawn from test fixtures, not a live run: the records are made up, and any answer is scripted for the test.',
  markets: 'Drawn from test fixtures, not a live run: every value is made up.',
  research: 'Drawn from test fixtures, not a live run: the routines, their rules and hypothesis cards, the closes and the labels, and so every result, are made up.',
  digest: "Drawn from test fixtures, not a live run: yesterday's macro.snapshot is made up from the demo's saved one by changing two things, and each sentence is scripted for the test.",
};

// The wording review's condition on any compare shown in public, on every compare screen and
// above them on the page.
export const PUBLIC_USE = 'Any public use of a compare (a screenshot, a post, a README) is its own review, with the whole question, the date, both answers uncut and the model named, never the best of several runs.';

export const captionOf = (group: FixtureGroup, says: string): string => [says, MADE_UP[group], ...(group === 'compare' ? [PUBLIC_USE] : [])].join(' ');

// A screen's session, set up in a scratch home of its own.
type SessionIn = (home: string) => SessionDeps | Promise<SessionDeps>;
export interface FixtureStill {
  group: FixtureGroup;
  title: string;
  says: string; // what the screen shows; the caption adds what is made up
  columns: number;
  rows: number;
  plain?: boolean;
  session: SessionIn;
  steps: WalkStep[]; // the still is the screen after the last
}

const asked = (text: string): WalkStep[] => [{ title: text, keys: [...typed(text), enter] }];
const COMPARE = `/compare ${COMPARE_QUESTION}`;

// Each still is drawn from a session of its own, so it shows its screen alone, in a window
// tall enough for the whole of it.
export const FIXTURE_STILLS: FixtureStill[] = [
  {
    group: 'compare',
    title: '/compare: the cost line before Enter',
    says: 'What /compare will spend, said from its plan before anything runs: the model asked twice, its searches and the PreReason calls. Only Enter runs it.',
    columns: 100,
    rows: 30,
    session: compareSession,
    steps: asked(COMPARE),
  },
  {
    group: 'compare',
    title: '/compare: both answers, side by side',
    says: "Both answers once it has run: from PreReason's briefings, with how many figures match the lines cited, and from the model's web search, its text as returned and its figures not checked. No verdict.",
    columns: 100,
    rows: 34,
    session: compareSession,
    steps: [...asked(COMPARE), { title: 'Run', keys: [enter] }],
  },
  {
    group: 'compare',
    title: '/compare: stacked in a narrow window',
    says: 'The same two answers in a window 60 columns wide: the briefings first, then the web search.',
    columns: 60,
    rows: 41,
    session: compareSession,
    steps: [...asked(COMPARE), { title: 'Run', keys: [enter] }],
  },
  {
    group: 'news',
    title: "The news door: a company's filings",
    says: "A question about what a company filed reads PreReason's news door alone: the answer cites the record that holds it, the record shown as its line reads, and the credit names whose records, the window and when they were read.",
    columns: 100,
    rows: 30,
    session: (home) => newsSession(home, 'filed'),
    steps: asked(NEWS_QUESTION),
  },
  {
    group: 'news',
    title: 'The news door: a window with no record',
    says: 'A window that holds no record says what was read, and no model is asked.',
    columns: 100,
    rows: 30,
    session: (home) => newsSession(home, 'empty'),
    steps: asked(NEWS_QUESTION),
  },
  {
    group: 'news',
    title: 'The news door: a source not read',
    says: 'A source PreReason did not read for the answer is named, so a record from it is not taken for absent.',
    columns: 100,
    rows: 30,
    session: (home) => newsSession(home, 'not-read'),
    steps: asked(NEWS_QUESTION),
  },
  {
    group: 'markets',
    title: '/chart market map, in colour',
    says: 'Nine markets by their 7 day change, in equal tiles never sized or ordered by value, up in green and down in red beside an arrow, and each source named.',
    columns: 100,
    rows: 30,
    session: marketSession,
    steps: asked('/chart market map'),
  },
  {
    group: 'markets',
    title: '/chart market map, plain',
    says: 'The same map in plain text, where the signs carry the direction.',
    columns: 100,
    rows: 30,
    plain: true,
    session: marketSession,
    steps: asked('/chart market map'),
  },
  {
    group: 'markets',
    title: '/chart positioning',
    says: 'SPY beside the speculative net position in S&P 500 futures, marked futures, with the percentiles PreReason serves and a line for each from the readings kept on this machine.',
    columns: 100,
    rows: 30,
    session: marketSession,
    steps: asked('/chart positioning'),
  },
  {
    group: 'research',
    title: `/routine ${RESEARCH_ROUTINE} hypothesis: the card`,
    says: "The hypothesis card in the person's own words, frozen at its first backtest, with the form check primerkit's code runs on it.",
    columns: 100,
    rows: 30,
    session: researchSession,
    steps: asked(`/routine ${RESEARCH_ROUTINE} hypothesis`),
  },
  {
    group: 'research',
    title: `/routine ${RESEARCH_ROUTINE} research: the hurdle ladder`,
    says: 'The newest backtest against the card, H1 to H5 from the top, in a simulated account.',
    columns: 100,
    rows: 36,
    session: researchSession,
    steps: asked(`/routine ${RESEARCH_ROUTINE} research`),
  },
  {
    group: 'research',
    title: '/routine registry',
    says: 'Every hypothesis and version tested on this machine, by name, never by result, each with its status.',
    columns: 100,
    rows: 30,
    session: researchSession,
    steps: asked('/routine registry'),
  },
  {
    group: 'digest',
    title: '/digest: the changes, a sentence each',
    says: "A digest with changes, which the demo's one saved day cannot show: a sentence for each change, cited to its line, under the digest's named checks.",
    columns: 100,
    rows: 30,
    session: digestSession,
    steps: asked('/digest'),
  },
];

export interface FixtureGif {
  group: FixtureGroup;
  file: string;
  title: string;
  columns: number;
  rows: number;
  session: SessionIn;
  frames: Frame[];
}

const start: Frame = { title: 'Home', keys: [], hold: 1200 };
export const FIXTURE_GIFS: FixtureGif[] = [
  {
    group: 'compare',
    file: 'compare.gif',
    title: '/compare: the cost line, then both answers',
    columns: 100,
    rows: 34,
    session: compareSession,
    frames: [start, ...typing('Typing', COMPARE), { title: 'The cost line', keys: [enter], hold: 4500 }, { title: 'While it runs', keys: [enter], wait: false, hold: 900 }, { title: 'Both answers', keys: [], hold: 7000 }],
  },
  {
    group: 'news',
    file: 'news.gif',
    title: "The news door: a company's filings, asked and answered",
    columns: 100,
    rows: 30,
    session: (home) => newsSession(home, 'filed'),
    frames: [start, ...typing('Typing', NEWS_QUESTION), { title: 'While it runs', keys: [enter], wait: false, hold: 900 }, { title: 'Answered', keys: [], hold: 6000 }],
  },
  {
    group: 'markets',
    file: 'markets.gif',
    title: 'The market map, then positioning',
    columns: 100,
    rows: 30,
    session: marketSession,
    frames: [start, ...shown('The market map', '/chart market map', 4000), ...shown('Positioning', '/chart positioning', 5000)],
  },
  {
    group: 'research',
    file: 'research.gif',
    title: 'The card, the hurdle ladder and the registry',
    columns: 100,
    rows: 36,
    session: researchSession,
    frames: [
      start,
      ...typing('Typing the card', `/routine ${RESEARCH_ROUTINE} hypothesis`),
      { title: 'The card', keys: [enter], hold: 4500 },
      ...typing('Typing the ladder', `/routine ${RESEARCH_ROUTINE} research`),
      { title: 'The ladder', keys: [enter], hold: 6000 },
      ...typing('Typing the registry', '/routine registry'),
      { title: 'The registry', keys: [enter], hold: 5000 },
    ],
  },
];

// Every call out refused while the demo's screens and the new ones are drawn: through fetch,
// and through node:http and node:https, which a local model's runtime is called on. The demo
// reads its saved briefings and the fakes answer for PreReason and Anthropic, so a call out is
// one a fake missed: the run stops, and nothing is written.
const DOORS = { http, https };
type Doors = Array<{ door: typeof http | typeof https; request: unknown; get: unknown }>;
async function offline<T>(work: () => Promise<T>): Promise<T> {
  const tried: string[] = [];
  const refused = (to: string): Error => (tried.push(to), new Error('the gallery sends nothing'));
  const real = { fetch: globalThis.fetch, doors: Object.values(DOORS).map((door): Doors[number] => ({ door, request: door.request, get: door.get })) };
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw refused(input instanceof Request ? input.url : String(input));
  }) as typeof fetch;
  setDoors(
    Object.entries(DOORS).map(([scheme, door]) => {
      const refuse = (input: unknown) => {
        throw refused(addressOf(scheme, input));
      };
      return { door, request: refuse, get: refuse };
    }),
  );
  try {
    const out = await work().catch((e: unknown) => {
      if (!tried.length) throw e;
      return null;
    });
    if (tried.length) throw new Error(`a screen tried to call out (${tried.length} calls, the first to ${new URL(tried[0]!).host}), so no picture was written`);
    return out as T;
  } finally {
    globalThis.fetch = real.fetch;
    setDoors(real.doors);
  }
}

// node:http's and node:https's request and get set. A module that imports one by name, as the
// local model's chat imports request, holds a binding of its own, brought to the same here.
function setDoors(doors: Doors): void {
  for (const { door, request, get } of doors) Object.assign(door, { request, get });
  syncBuiltinESMExports();
}

// Where a node:http or node:https request was going: its address, or one made from its options.
function addressOf(scheme: string, input: unknown): string {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  const o = (input ?? {}) as { protocol?: string; hostname?: string; host?: string; port?: number | string; path?: string };
  return `${o.protocol ?? `${scheme}:`}//${o.hostname ?? o.host ?? 'localhost'}${o.port ? `:${o.port}` : ''}${o.path ?? '/'}`;
}

// A scratch home for one session, removed after it.
async function inHome<T>(work: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'pk-gallery-fixture-'));
  try {
    return await work(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export interface FixtureShot {
  group: FixtureGroup;
  file: string;
  title: string;
  caption: string;
  lines: Line[];
  svg: string;
}

// The new screens' stills, as they are written. Every one is drawn from made-up data, so
// every one carries the mark.
export async function fixtureShots(stills: FixtureStill[] = FIXTURE_STILLS): Promise<FixtureShot[]> {
  return offline(async () => {
    const shots: FixtureShot[] = [];
    for (const [i, s] of stills.entries()) {
      const screens = await inHome(async (home) => walk(await s.session(home), s.steps, s.plain ?? false, { columns: s.columns, rows: s.rows }));
      const lines = screens.at(-1)!.lines;
      const caption = captionOf(s.group, s.says);
      shots.push({ group: s.group, file: fileOf(i, s.title), title: s.title, caption, lines, svg: screenSvg(lines, s.columns, s.rows, s.title, false, caption, SAMPLE_MARK) });
    }
    return shots;
  });
}

// The new screens' GIFs, frame by frame as they are drawn for pixels, each frame with its
// caption and the mark.
export async function fixtureGifFrames(gifs: FixtureGif[] = FIXTURE_GIFS): Promise<Array<{ file: string; frames: GifFrame[] }>> {
  return offline(async () => {
    const out: Array<{ file: string; frames: GifFrame[] }> = [];
    for (const g of gifs) out.push({ file: g.file, frames: await inHome(async (home) => gifFrames(await g.session(home), g.frames, g.columns, g.rows, captionOf(g.group, `${g.title}, a frame a step.`), SAMPLE_MARK)) });
    return out;
  });
}

// The page's part for the new screens: what they are, the compare's condition above its
// screens, each still with its caption, each GIF, and what this run does not redraw.
export function fixturePage(shots: Array<Pick<FixtureShot, 'group' | 'file' | 'title' | 'caption'>>): string[] {
  return [
    '## New screens, drawn from fixtures',
    '',
    `The real session, walked key by key on the fakes and fixtures the tests use: a stand-in where a model answers, a web search response written by hand for the tests in place of Anthropic's, and PreReason's answers as the tests serve them. No key, no model, and nothing is sent anywhere: a call out stops the drawing. Each caption, also drawn under its picture, says what is made up, and each made up picture carries the words "${SAMPLE_MARK}" in its top right corner. Drawn by \`npm run gallery\` into \`fixtures/\`.`,
    '',
    ...FIXTURE_GROUPS.flatMap(({ group, title }) => [
      `### ${title}`,
      '',
      ...(group === 'compare' ? [`> ${PUBLIC_USE}`, ''] : []),
      ...FIXTURE_GIFS.filter((g) => g.group === group).flatMap((g) => [`#### Moving: ${g.title}`, '', captionOf(group, `${g.title}, a frame a step.`), '', `![${g.title}](fixtures/${g.file})`, '']),
      ...shots.filter((s) => s.group === group).flatMap((s) => [`#### ${s.title}`, '', s.caption, '', `![${s.title}](fixtures/${s.file})`, '']),
    ]),
    '## Not redrawn here',
    '',
    'Each needs a live PreReason key and a model, and this run makes no live call, so each stays as last drawn:',
    '',
    ...NOT_REDRAWN.map((n) => `- **${n.what}.** ${n.why}`),
    '',
  ];
}

export const NOT_REDRAWN = [
  { what: 'The keyed gallery, `keyed/`', why: 'A real session on a PreReason key, its questions answered on Claude Sonnet 5.5 (`npm run gallery -- --keyed`). Drawn 2026-10-11.' },
  { what: 'The storyboard, `storyboard/`', why: 'Its live journeys read PreReason on a key and answer on the local model qwen2.5:7b in Ollama (`npm run storyboard`). Drawn 2026-10-12.' },
  { what: 'The replay, `replay/`', why: 'Questions asked in one session on a PreReason key and Claude Sonnet 5.5, under a spending cap (`npm run replay`).' },
];

// The new screens and their GIFs, written into docs/gallery/fixtures; the stills are returned
// for the page.
async function fixtureSet(): Promise<FixtureShot[]> {
  const shots = await fixtureShots();
  const frames = await fixtureGifFrames();
  // The fakes' key is "not-a-key": it never reaches a picture.
  refuseKeys([...shots.map((s) => s.svg), ...frames.flatMap((g) => g.frames.map((f) => f.svg))], ['not-a-key']);
  const gifs = await drawGifs(frames);
  mkdirSync(FIXTURE_OUT, { recursive: true });
  for (const f of readdirSync(FIXTURE_OUT)) if (/\.(svg|gif)$/.test(f)) rmSync(join(FIXTURE_OUT, f));
  for (const s of shots) writeFileSync(join(FIXTURE_OUT, s.file), s.svg);
  for (const g of gifs) writeFileSync(join(FIXTURE_OUT, g.file), g.bytes);
  console.log(`${shots.length} screens and ${gifs.length} GIFs from fixtures in ${FIXTURE_OUT}`);
  return shots;
}

async function demoSet(): Promise<void> {
  const columns = 100;
  const rows = 30;
  const shots = await demoShots(GALLERY, columns, rows);
  const fixtures = await fixtureSet();
  const gifs = await drawGifs(await demoGifFrames(GIFS, columns, rows));
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith('.gif')) rmSync(join(OUT, f));
  for (const g of gifs) writeFileSync(join(OUT, g.file), g.bytes);
  writeSet(OUT, demoIntro(columns, rows), shots, GIFS, fixturePage(fixtures));
  console.log(`${shots.length} screens and ${GIFS.length} GIFs in ${OUT}`);
}

async function keyedSet(questions: number, cap: number): Promise<void> {
  const env = process.env;
  if (!env.PREREASON_API_KEY) throw new Error('the keyed set reads PreReason with the key in PREREASON_API_KEY, and none is set');
  // The session runs on Claude Sonnet 5.5, whose key it needs to open at home. With no
  // questions the purse's cap is $0, so no call to Anthropic can go.
  if (!env.ANTHROPIC_API_KEY) throw new Error('the keyed session runs on Claude Sonnet 5.5 with the key in ANTHROPIC_API_KEY, and none is set; without --questions nothing is asked of it');
  if (questions > 0 && !(cap > 0)) throw new Error('paid questions need a spending cap: --cap <dollars>');
  // A scratch home, its first run done, so the session opens at home and keeps nothing here.
  const home = mkdtempSync(join(tmpdir(), 'pk-gallery-'));
  const purse = new Purse(questions > 0 ? cap : 0);
  const realFetch = globalThis.fetch;
  try {
    writeConfig(home, { first_run_done_at: new Date().toISOString(), disclaimer_accepted_at: new Date().toISOString(), model: { kind: 'hosted', provider: 'anthropic', name: SONNET.model } });
    globalThis.fetch = purse.wrap(realFetch);
    const deps = () => realDeps({ version: 'gallery', env: { ...env, PRIMERKIT_HOME: home } });
    const shots: Array<{ file: string; title: string; svg: string }> = [];
    // A screen that is not kept, or that says PreReason refused it, is named, never dropped unseen.
    const add = (screens: WalkedScreen[], columns: number, rows: number) => {
      for (const s of screens.filter((s) => !/, closed$/.test(s.title))) {
        const text = s.lines.map((l) => l.map(([, t]) => t).join('')).join('\n');
        if (!kept(s) || /rate limit|could not be read/i.test(text)) console.log(`Not drawn: ${s.title}${/rate limit/i.test(text) ? " (PreReason's rate limit)" : ''}`);
        else shots.push({ file: fileOf(shots.length, s.title), title: s.title, svg: screenSvg(s.lines, columns, rows, s.title, true) });
      }
    };
    const rest = () => new Promise((done) => setTimeout(done, PACE_MS));
    for (const [i, group] of KEYED.entries()) {
      if (i) await rest();
      add(await walk(deps(), group, false, { columns: 100, rows: 30 }), 100, 30);
    }
    await rest();
    for (const size of KEYED_SIZES) add(await walk(deps(), size.steps, false, size), size.columns, size.rows);
    // Each question in a session of its own, asked only while the purse holds it. A board read
    // first tells the session the key's tier, so the pick sees every briefing the key reads.
    if (questions > 0) await rest();
    for (const q of QUESTIONS.slice(0, questions)) {
      if (!purse.canAsk()) {
        console.log(`Stopped before "${q}": $${purse.spent.toFixed(4)} spent, and the dearest question so far ($${purse.dearest.toFixed(4)}) would pass the cap of $${cap.toFixed(2)}.`);
        break;
      }
      const before = purse.spent;
      const screens = await walk(deps(), [...command('The tier, from a board', '/brief macro.snapshot'), { title: `Answered: ${q}`, keys: [...typed(q), enter] }], false, { columns: 100, rows: 30 });
      add(screens.filter((s) => s.title.startsWith('Answered')), 100, 30);
      purse.asked(before);
      console.log(`Asked "${q}": $${(purse.spent - before).toFixed(4)}, $${purse.spent.toFixed(4)} in all, ${purse.calls} calls.`);
    }
    refuseKeys(shots.map((s) => s.svg), [env.PREREASON_API_KEY, env.ANTHROPIC_API_KEY]);
    writeSet(KEYED_OUT, `A real session on a PreReason key, drawn on ${new Date().toISOString().slice(0, 10)} by \`npm run gallery -- --keyed\`: live boards and charts at 100 by 30, a wide window and a small one${shots.some((s) => s.title.startsWith('Answered')) ? ', and questions answered on Claude Sonnet 5.5' : ''}.`, shots);
    console.log(`${shots.length} screens in ${KEYED_OUT}${questions ? `; spent $${purse.spent.toFixed(4)} at list on ${purse.calls} calls` : ''}`);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  }
}

function flagOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

// Run as a script (npm run gallery), not when a test imports what it draws with.
if (/gallery\.ts$/.test(process.argv[1] ?? '')) {
  if (process.argv.includes('--keyed')) await keyedSet(Number(flagOf('--questions') ?? 0), Number(flagOf('--cap') ?? 0));
  else await demoSet();
}
