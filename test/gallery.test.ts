import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { get as httpsGet } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { COMPARE_FOOTER, demoDeps } from '@primerkit/session';
import {
  FIXTURE_GIFS,
  FIXTURE_GROUPS,
  FIXTURE_STILLS,
  GALLERY,
  GALLERY_MACHINE,
  GIFS,
  KEYED,
  MADE_UP,
  NOT_REDRAWN,
  DO_NOT_USE,
  PUBLIC_USE,
  Purse,
  SAMPLE_MARK,
  SAVED_MARK,
  blockShape,
  captionLines,
  captionOf,
  costOf,
  demoGifFrames,
  demoIntro,
  demoShots,
  fixtureGifFrames,
  fixturePage,
  fixtureShots,
  gifOf,
  quadrantShapes,
  rasterise,
  refuseKeys,
  screenSvg,
} from '../scripts/gallery';
import { RESEARCH_RUN_ID, compareSession, marketSession, researchSession } from '../scripts/fixture-sessions';
import { answers } from '../packages/session/test/market-fixture';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Drawing to pixels loads the machine's fonts, and a shared runner can take longer than vitest's
// 5 s for one test that draws pictures (macOS took 5.4 s on 2026-10-17), so every test here has
// two minutes.
vi.setConfig({ testTimeout: 120_000 });

// A mark as a picture carries it: small, above its top right corner. Every picture drawn from
// made-up data carries "sample data"; every demo picture the day its briefings were saved.
const markOf = (text: string): RegExp => new RegExp(`<text x="[\\d.]+" y="12" fill="#a89f92" font-size="12" text-anchor="end">${text}</text>`);
const MARK = markOf('sample data');
const SAVED = markOf('saved 2026-10-16');

// A picture's top right band, where a mark is drawn, clear of its rounded corners and at most
// 200 px wide: how many of its pixels are not the
// background (#16120f), none on a picture with no mark, and how far from the right edge the
// first of them is, which tells one mark from the other. `at` gives a pixel as "r,g,b".
function corner(width: number, at: (x: number, y: number) => string): { ink: number; reach: number } {
  let [ink, left] = [0, width];
  for (let y = 0; y < 16; y++) {
    for (let x = Math.max(16, width - 16 - 200); x < width - 16; x++) {
      if (at(x, y) === '22,18,15') continue;
      ink += 1;
      left = Math.min(left, x);
    }
  }
  return { ink, reach: width - left };
}
const cornerInk = (width: number, at: (x: number, y: number) => string): number => corner(width, at).ink;

// A picture drawn for pixels, read as the corner reads a GIF's frame.
const pixelsOf = async (svg: string) => {
  const image = await rasterise(svg);
  return { width: image.width, at: (x: number, y: number) => Array.from(image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)).join(',') };
};

// The first frame of a GIF, each pixel by its palette's colour: enough to look at a corner of
// it. The image is LZW coded, in sub-blocks after its descriptor and any extension before it;
// a code stands for a run of pixels, each new one for the run before it and one pixel more.
function firstFrame(gif: Uint8Array): { width: number; at: (x: number, y: number) => string } {
  const b = (k: number): number => gif[k]!;
  const colours = (flags: number): number => 3 * (1 << ((flags & 7) + 1));
  let i = 13;
  let table = gif.subarray(0, 0);
  if (b(10) & 0x80) {
    table = gif.subarray(i, i + colours(b(10)));
    i += colours(b(10));
  }
  while (b(i) === 0x21) {
    for (i += 2; b(i); i += b(i) + 1);
    i += 1;
  }
  if (b(i) !== 0x2c) throw new Error('no image in this GIF');
  const [w, h, flags] = [b(i + 5) | (b(i + 6) << 8), b(i + 7) | (b(i + 8) << 8), b(i + 9)];
  i += 10;
  if (flags & 0x80) {
    table = gif.subarray(i, i + colours(flags));
    i += colours(flags);
  }
  const min = b(i);
  const data: number[] = [];
  for (i += 1; b(i); i += b(i) + 1) data.push(...gif.subarray(i + 1, i + 1 + b(i)));
  const clear = 1 << min;
  const [prefix, last, first, length] = [new Int32Array(4096), new Uint8Array(4096), new Uint8Array(4096), new Int32Array(4096)];
  for (let c = 0; c < clear; c++) [prefix[c], last[c], first[c], length[c]] = [-1, c, c, 1];
  const out = new Uint8Array(w * h);
  let [o, size, next, prev, acc, bits, p] = [0, min + 1, clear + 2, -1, 0, 0, 0];
  for (;;) {
    for (; bits < size && p < data.length; bits += 8) acc |= data[p++]! << bits;
    if (bits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    bits -= size;
    if (code === clear) {
      [size, next, prev] = [min + 1, clear + 2, -1];
      continue;
    }
    if (code === clear + 1) break;
    if (prev >= 0 && next < 4096) {
      [prefix[next], first[next], length[next], last[next]] = [prev, first[prev]!, length[prev]! + 1, code < next ? first[code]! : first[prev]!];
      next += 1;
      if (next === 1 << size && size < 12) size += 1;
    }
    for (let k = length[code]! - 1, c = code; k >= 0; k--, c = prefix[c]!) out[o + k] = last[c]!;
    o += length[code]!;
    prev = code;
  }
  return { width: w, at: (x, y) => Array.from(table.subarray(out[y * w + x]! * 3, out[y * w + x]! * 3 + 3)).join(',') };
}

describe('the gallery', () => {
  it('draws each word at its own column, wide characters counting two, with nothing stretched, and escapes the text', () => {
    const wide = String.fromCodePoint(0x6f22);
    const svg = screenSvg([[['accentBold', ' A&B '], ['fg', `${wide}${wide}`], ['dim', '<x>']]], 20, 2, 'A screen');
    // "A&B" starts at column 1, the two wide characters at 5, "<x>" at 9.
    expect(svg).toContain(`x="${(16 + 1 * 8.4).toFixed(1)}" y="29" fill`);
    expect(svg).toContain(`x="${(16 + 5 * 8.4).toFixed(1)}"`);
    expect(svg).toContain(`x="${(16 + 9 * 8.4).toFixed(1)}"`);
    expect(svg).toContain('>A&amp;B</text>');
    expect(svg).toContain('&lt;x&gt;');
    expect(svg).toContain('aria-label="A screen"');
    expect(svg).not.toContain('textLength');
    // Fonts whose letters fill the 8.4 px cell at 14 px, so words keep the terminal's spacing;
    // Consolas, narrower, is not on the list.
    expect(svg).toContain(`font-family="Cascadia Mono, Menlo, 'DejaVu Sans Mono', 'Lucida Console', monospace" font-size="14"`);
    // A header over a table: each word at the column its values start in.
    const header = screenSvg([[['dim', 'metric         level       7d']]], 40, 1, 'header');
    expect(header).toMatch(new RegExp(`x="${(16 + 0 * 8.4).toFixed(1)}"[^>]*>metric<`));
    expect(header).toMatch(new RegExp(`x="${(16 + 15 * 8.4).toFixed(1)}"[^>]*>level<`));
    expect(header).toMatch(new RegExp(`x="${(16 + 27 * 8.4).toFixed(1)}"[^>]*>7d<`));
  });

  it('places each character past Latin-1 on its own for pixels, at its own column', () => {
    const plain = screenSvg([[['dim', ' ↳ [1] btc.pulse L7 ✓ ok']]], 30, 1, 'plain');
    // In the SVG set the glyphs stay in their words: "↳", "[1]", "btc.pulse", "L7", "✓", "ok".
    expect(plain.match(/<text /g)).toHaveLength(6);
    const cut = screenSvg([[['dim', ' ↳ [1] btc.pulse L7 ✓ ok']]], 30, 1, 'cut', true);
    expect(cut.match(/<text /g)).toHaveLength(6);
    expect(cut).toMatch(new RegExp(`x="${(16 + 1 * 8.4).toFixed(1)}"[^>]*>↳<`));
    expect(cut).toMatch(new RegExp(`x="${(16 + 3 * 8.4).toFixed(1)}"[^>]*>\\[1\\]<`));
    expect(cut).toMatch(new RegExp(`x="${(16 + 7 * 8.4).toFixed(1)}"[^>]*>btc\\.pulse<`));
    expect(cut).toMatch(new RegExp(`x="${(16 + 17 * 8.4).toFixed(1)}"[^>]*>L7<`));
    expect(cut).toMatch(new RegExp(`x="${(16 + 20 * 8.4).toFixed(1)}"[^>]*>✓<`));
    expect(cut).toMatch(new RegExp(`x="${(16 + 22 * 8.4).toFixed(1)}"[^>]*>ok<`));
    // A glyph inside a word is cut from it for pixels: "a✓b" is three pieces at 0, 1 and 2.
    const inside = screenSvg([[['fg', 'a✓b']]], 4, 1, 'inside', true);
    expect(inside.match(/<text /g)).toHaveLength(3);
  });

  it('draws block elements for pixels as shapes in the text colour, each in its own cell, and leaves the SVG set as it was', () => {
    expect(blockShape('█')).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(blockShape('▁')).toEqual({ x: 0, y: 7 / 8, w: 1, h: 1 / 8 });
    expect(blockShape('▄')).toEqual({ x: 0, y: 1 / 2, w: 1, h: 1 / 2 });
    expect(blockShape('▀')).toEqual({ x: 0, y: 0, w: 1, h: 1 / 2 });
    expect(blockShape('▌')).toEqual({ x: 0, y: 0, w: 1 / 2, h: 1 });
    expect(blockShape('▏')).toEqual({ x: 0, y: 0, w: 1 / 8, h: 1 });
    expect(blockShape('▐')).toEqual({ x: 1 / 2, y: 0, w: 1 / 2, h: 1 });
    expect(blockShape('▒')).toMatchObject({ opacity: 0.5 });
    expect(blockShape('│')).toBeNull();
    expect(blockShape('██')).toBeNull();
    const svg = screenSvg([[['fg', 'ab'], ['accent', '██▄']]], 10, 1, 'blocks', true);
    // Two full blocks at columns 2 and 3, a cell each, and a lower half at column 4.
    expect(svg).toContain(`<rect x="${(16 + 2 * 8.4).toFixed(2)}" y="16.00" width="8.40" height="18.00"`);
    expect(svg).toContain(`<rect x="${(16 + 3 * 8.4).toFixed(2)}" y="16.00" width="8.40" height="18.00"`);
    expect(svg).toContain(`<rect x="${(16 + 4 * 8.4).toFixed(2)}" y="25.00" width="8.40" height="9.00"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).not.toMatch(/>[█▄]+</);
    expect(screenSvg([[['accent', '██▄']]], 10, 1, 'plain')).toContain('>██▄<');
  });

  it("draws primerkit's mark as shapes in any picture, each quadrant a quarter of its cell", () => {
    expect(quadrantShapes('▚')).toEqual([{ x: 0, y: 0, w: 1 / 2, h: 1 / 2 }, { x: 1 / 2, y: 1 / 2, w: 1 / 2, h: 1 / 2 }]);
    expect(quadrantShapes('▖')).toEqual([{ x: 0, y: 1 / 2, w: 1 / 2, h: 1 / 2 }]);
    expect(quadrantShapes('▄')).toBeNull();
    expect(quadrantShapes('▛▛')).toBeNull();
    // A picture that is not for pixels still draws the mark's colours as shapes: as glyphs its
    // blocks leave a gap between rows. Other text keeps its glyphs.
    const svg = screenSvg([[['pkLetter', '▛'], ['fg', ' x ▛']]], 6, 1, 'mark');
    expect(svg.match(/<rect [^>]*fill="#e9e3d8"[^>]*crispEdges/g)).toHaveLength(3);
    expect(svg).toContain('>▛<');
  });

  it('draws screens to pixels and makes one looping GIF of them, a frame each with its own time', async () => {
    const one = await rasterise(screenSvg([[['accentBold', ' primerkit ']]], 20, 2, 'one'));
    const two = await rasterise(screenSvg([[['fg', ' the next screen ']]], 20, 2, 'two'));
    expect(one.width).toBe(Math.round(20 * 8.4 + 32));
    expect(one.pixels.length).toBe(one.width * one.height * 4);
    const gif = gifOf([{ ...one, delay: 1800 }, { ...two, delay: 900 }]);
    expect(Buffer.from(gif.slice(0, 6)).toString('ascii')).toBe('GIF89a');
    // One graphic control block a frame, each holding its time in hundredths of a second.
    const controls = [...gif.keys()].filter((i) => gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04);
    expect(controls).toHaveLength(2);
    expect(controls.map((i) => gif[i + 4]! | (gif[i + 5]! << 8))).toEqual([180, 90]);
    expect(gif.at(-1)).toBe(0x3b);
  });

  // The gallery is left out of a release (export-ignore), so this runs where the pictures are:
  // in a checkout that holds docs/gallery, not in a copy of a release.
  it.runIf(existsSync(join(ROOT, 'docs', 'gallery')))("draws the demo's machine check as committed, on the gallery's own machine whatever this one runs", async () => {
    const [welcome, step1] = await demoShots(GALLERY.slice(0, 2));
    expect(welcome!.file).toBe('01-1-welcome.svg');
    expect(step1!.file).toBe('02-2-step-1-where-the-model-runs.svg');
    const committed = readFileSync(join(ROOT, 'docs', 'gallery', step1!.file), 'utf8').replace(/\r\n/g, '\n');
    expect(step1!.svg).toBe(committed);
    // The demo shows PreReason's saved briefings, not made-up data: it carries the day they were
    // saved, never "sample data".
    expect(welcome!.svg).toMatch(SAVED);
    expect(welcome!.svg).not.toContain(SAMPLE_MARK);
    // The gallery's machine: Claude Code found, and no local model.
    const words = [...step1!.svg.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]).join(' ');
    expect(words).toContain('Found on this machine: Claude Code.');
    expect(words).not.toContain('Ollama');
  });

  it('gives every GIF frames that hold a time, and opens the keyed set with the markets', () => {
    for (const g of GIFS) {
      expect(g.file).toMatch(/^[a-z-]+\.gif$/);
      expect(g.frames.filter((f) => f.hold).length).toBeGreaterThan(1);
    }
    expect(KEYED[0]![0]!.title).toMatch(/macro\.snapshot/);
  });

  it("reads a call's cost from its usage, the cache's reads and writes at their own prices", () => {
    // Sonnet 5.5: $2 in, $10 out, $0.20 a cache read and $2.50 a cache write, a million tokens.
    expect(costOf({ input_tokens: 1_000_000 })).toBeCloseTo(2);
    expect(costOf({ output_tokens: 1_000_000 })).toBeCloseTo(10);
    expect(costOf({ cache_read_input_tokens: 39_500 })).toBeCloseTo(0.0079);
    expect(costOf({ cache_creation_input_tokens: 39_500, input_tokens: 500, output_tokens: 800 })).toBeCloseTo(0.09875 + 0.001 + 0.008);
    expect(costOf({})).toBe(0);
  });

  it('adds each answer to the purse, asks no question that could pass the cap, and refuses a call once it is reached', async () => {
    const answered = (usage: object) => new Response(JSON.stringify({ content: [], usage }), { status: 200 });
    let next: object = { cache_creation_input_tokens: 40_000, input_tokens: 2_000, output_tokens: 1_000 }; // $0.114
    const sent: string[] = [];
    const purse = new Purse(0.25);
    const call = purse.wrap(async (input) => {
      sent.push(String(input));
      return answered(next);
    });
    expect(purse.canAsk()).toBe(true); // nothing spent; the first guess, $0.15, fits
    const before = purse.spent;
    await call('https://api.anthropic.com/v1/messages', { method: 'POST' });
    purse.asked(before);
    expect(purse.spent).toBeCloseTo(0.114);
    expect(purse.dearest).toBeCloseTo(0.114);
    // $0.114 spent and the dearest $0.114 make $0.228, under $0.25: one more may be asked.
    expect(purse.canAsk()).toBe(true);
    next = { cache_read_input_tokens: 40_000, input_tokens: 2_000, output_tokens: 1_000 }; // $0.022
    await call('https://api.anthropic.com/v1/messages', { method: 'POST' });
    purse.asked(purse.spent - 0.022);
    // $0.136 and the dearest $0.114 make $0.250: still not past it. One more call passes it.
    await call('https://api.anthropic.com/v1/messages', { method: 'POST' });
    expect(purse.canAsk()).toBe(false);
    // Calls elsewhere pass through uncounted; a call to Anthropic past the cap never goes.
    await call('https://api.prereason.com/api/briefings/macro.snapshot');
    expect(purse.calls).toBe(3);
    next = { input_tokens: 200_000 };
    await call('https://api.anthropic.com/v1/messages', { method: 'POST' });
    await expect(call('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toThrow(/spending cap of \$0\.25 is reached/);
    expect(sent.filter((u) => u.includes('anthropic'))).toHaveLength(4);
  });

  it('lets no call to Anthropic through a purse of $0, the keyed set without questions', async () => {
    const sent: string[] = [];
    const call = new Purse(0).wrap(async (input) => {
      sent.push(String(input));
      return new Response('{}', { status: 200 });
    });
    await expect(call('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toThrow(/spending cap of \$0\.00 is reached/);
    await call('https://api.prereason.com/api/briefings/macro.snapshot');
    expect(sent).toEqual(['https://api.prereason.com/api/briefings/macro.snapshot']);
  });

  it('writes no picture that holds a key', () => {
    const key = `pr_live_${'k'.repeat(24)}`;
    expect(() => refuseKeys(['<svg>fine</svg>'], [key, undefined])).not.toThrow();
    expect(() => refuseKeys(['<svg>fine</svg>', `<svg>${key}</svg>`], [key])).toThrow(/holds a key/);
  });
});

// The words a screen's text runs to, each row's frame and padding taken off.
const textOf = (lines: Array<Array<[string, string]>>): string => lines.map((l) => l.map(([, t]) => t).join('')).join('\n');
const flat = (s: string): string => s.replace(/^ *[│|└+] ?/gm, '').replace(/\s+/g, ' ');

describe('the new screens, drawn from fixtures', () => {
  it('draws a caption under a screen, in the picture, its words never cut, and escaped', () => {
    const bare = screenSvg([[['fg', ' a screen ']]], 20, 2, 'bare');
    const captioned = screenSvg([[['fg', ' a screen ']]], 20, 2, 'captioned', false, 'Drawn from test fixtures: <values> & web text are made up.');
    expect(bare).toContain('height="68"');
    expect(captionLines('Drawn from test fixtures: <values> & web text are made up.', 20)).toEqual(['Drawn from test', 'fixtures: <values> &', 'web text are made', 'up.']);
    // Two rows of 18 and the padding, then half the padding and four caption rows.
    expect(captioned).toContain(`height="${Math.round(2 * 18 + 32 + 8 + 4 * 18)}"`);
    expect(captioned).toContain('>fixtures: &lt;values&gt; &amp;</text>');
    expect(captioned).toContain('fill="#a89f92">Drawn from test</text>');
    expect(captionLines('a wordlongerthanthewidth b', 10)).toEqual(['a', 'wordlongerthanthewidth', 'b']);
  });

  it('draws a mark in a picture when asked, "sample data" or the day the demo was saved, above its top right corner where no screen line reaches, and for pixels too', async () => {
    expect(SAMPLE_MARK).toBe('sample data');
    expect(SAVED_MARK).toBe('saved 2026-10-16');
    const screen: Array<Array<[string, string]>> = [[['fg', ' a screen ']]];
    const marked = screenSvg(screen, 20, 2, 'marked', false, 'Drawn from test fixtures.', SAMPLE_MARK);
    // 20 columns and the padding make 200 px: the mark ends 16 px from the right, its baseline
    // 4 px above the first row, which starts at 16.
    expect(marked).toContain('<text x="184" y="12" fill="#a89f92" font-size="12" text-anchor="end">sample data</text>');
    expect(marked).toMatch(MARK);
    expect(marked).not.toMatch(SAVED);
    const saved = screenSvg(screen, 20, 2, 'saved', false, undefined, SAVED_MARK);
    expect(saved).toContain('<text x="184" y="12" fill="#a89f92" font-size="12" text-anchor="end">saved 2026-10-16</text>');
    expect(saved).not.toContain(SAMPLE_MARK);
    expect(screenSvg(screen, 20, 2, 'escaped', false, undefined, '<x> & y')).toContain('text-anchor="end">&lt;x&gt; &amp; y</text>');
    for (const bare of [screenSvg(screen, 20, 2, 'bare', false, 'Drawn from test fixtures.'), screenSvg(screen, 20, 2, 'bare'), screenSvg(screen, 20, 2, 'bare', true)]) {
      expect(bare).not.toContain(SAMPLE_MARK);
      expect(bare).not.toContain(SAVED_MARK);
    }
    // Drawn for a GIF, each mark keeps its own size and is in the pixels: the day, the longer,
    // reaches further left.
    const cornerOf = async (svg: string) => {
      const pixels = await pixelsOf(svg);
      return corner(pixels.width, pixels.at);
    };
    const sample = await cornerOf(screenSvg(screen, 20, 2, 'marked', true, undefined, SAMPLE_MARK));
    const day = await cornerOf(screenSvg(screen, 20, 2, 'saved', true, undefined, SAVED_MARK));
    expect(sample.ink).toBeGreaterThan(20);
    expect(day.ink).toBeGreaterThan(sample.ink);
    expect(day.reach).toBeGreaterThan(sample.reach + 20);
    const bare = await pixelsOf(screenSvg(screen, 20, 2, 'bare', true));
    expect(cornerInk(bare.width, bare.at)).toBe(0);
  }, 120_000);

  it('captions every new screen and GIF with what is made up, and every compare with the condition on public use', () => {
    for (const { group } of FIXTURE_GROUPS) expect(MADE_UP[group], group).toMatch(/^Drawn from test fixtures, not a live run: .*\bmade up\b/);
    expect(MADE_UP.compare).toContain('the web text');
    expect(PUBLIC_USE).toBe('Any public use of a compare (a screenshot, a post, a README) is its own review, with the whole question, the date, both answers uncut and the model named, never the best of several runs.');
    const captions = [...FIXTURE_STILLS.map((s) => ({ group: s.group, caption: captionOf(s.group, s.says) })), ...FIXTURE_GIFS.map((g) => ({ group: g.group, caption: captionOf(g.group, g.title) }))];
    for (const { group, caption } of captions) {
      expect(caption, caption).toContain('Drawn from test fixtures, not a live run');
      expect(caption, caption).toMatch(/\bmade up\b/);
      if (group === 'compare') expect(caption, caption).toContain(PUBLIC_USE);
      else expect(caption, caption).not.toContain(PUBLIC_USE);
    }
    // No compare caption weighs one answer against the other, as the compare view never does.
    for (const { caption } of captions.filter((c) => c.group === 'compare')) expect(caption).not.toMatch(/\bbetter\b|more accurate|\bwins?\b|\bverified\b|\btrust|\breliab|\brecommend|\bshould\b|(?<!not )\bchecked\b/i);
    // Each new view has its stills and one GIF, the digest a still of its changes, and the
    // compare is stacked in a narrow window too.
    for (const group of ['compare', 'news', 'markets', 'research'] as const) {
      expect(FIXTURE_STILLS.filter((s) => s.group === group).length, group).toBeGreaterThanOrEqual(3);
      expect(FIXTURE_GIFS.filter((g) => g.group === group), group).toHaveLength(1);
    }
    expect(FIXTURE_STILLS.filter((s) => s.group === 'digest')).toHaveLength(1);
    expect(FIXTURE_STILLS.some((s) => s.group === 'compare' && s.columns < 73)).toBe(true);
    for (const g of FIXTURE_GIFS) expect(g.frames.filter((f) => f.hold).length, g.file).toBeGreaterThan(2);
  });

  it("says what is made up as it is: the web search response written by hand, never recorded, and the research's routines, rules and cards", () => {
    const page = fixturePage([]).join('\n');
    expect(page).toContain("a web search response written by hand for the tests in place of Anthropic's");
    expect(page).not.toMatch(/\brecorded\b/i);
    expect(page).toContain('each made up picture carries the words "sample data" in its top right corner');
    expect(MADE_UP.research).toBe('Drawn from test fixtures, not a live run: the routines, their rules and hypothesis cards, the closes and the labels, and so every result, are made up.');
    // A caption never counts the checks, which grow as checks are added: the picture shows them.
    for (const s of FIXTURE_STILLS) expect(s.says, s.title).not.toMatch(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)( named)? checks\b/i);
    expect(FIXTURE_STILLS.find((s) => s.group === 'digest')!.says).toContain("under the digest's named checks");
  });

  it('puts the condition above the compare screens on the page, and says what is not redrawn and why', () => {
    const shots = FIXTURE_STILLS.map((s, i) => ({ group: s.group, file: `${i}.svg`, title: s.title, caption: captionOf(s.group, s.says) }));
    const page = fixturePage(shots);
    const condition = page.indexOf(`> ${PUBLIC_USE}`);
    expect(condition).toBeGreaterThan(page.indexOf('### /compare'));
    expect(condition).toBeLessThan(page.findIndex((l) => l.startsWith('![')));
    for (const s of shots) expect(page).toContain(`![${s.title}](fixtures/${s.file})`);
    expect(page.join('\n')).toContain('## Not redrawn here');
    expect(NOT_REDRAWN.map((n) => n.what)).toEqual(['The keyed gallery, `keyed/`', 'The storyboard, `storyboard/`', 'The replay, `replay/`']);
  });

  it('draws every still from the real session on the tests\' fakes and fixtures, each status strip naming the stand-in, and sends nothing', async () => {
    const real = globalThis.fetch;
    const shots = await fixtureShots();
    expect(globalThis.fetch).toBe(real);
    expect(shots).toHaveLength(FIXTURE_STILLS.length);
    for (const [i, s] of shots.entries()) {
      const still = FIXTURE_STILLS[i]!;
      // The caption is in the picture, line by line, and the fakes' key never is.
      for (const line of captionLines(s.caption, still.columns)) expect(s.svg, s.file).toContain(line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
      // Every still is drawn from made-up data, so every one carries the mark, never the demo's day.
      expect(s.svg, s.file).toMatch(MARK);
      expect(s.svg, s.file).not.toContain(SAVED_MARK);
      expect(s.svg).not.toContain('not-a-key');
      // The status strip, the panel's last row, names what answers: a stand-in or the scripted test
      // model, never a model alone.
      expect(textOf(s.lines).split('\n').at(-1), s.file).toMatch(/^ model (stand-in for claude-sonnet-5-5|scripted test model) /);
      expect(textOf(s.lines), s.file).not.toContain('send nothing');
    }
    const at = (title: string) => flat(textOf(shots.find((s) => s.title.includes(title))!.lines));
    expect(at('the cost line')).toContain("This asks claude-sonnet-5-5 twice: once with PreReason's briefings, once with its web search and no briefings.");
    expect(at('the cost line')).toContain('Enter runs it');
    expect(at('side by side')).toContain("From PreReason's briefings From the model's web search");
    expect(at('side by side')).toContain(COMPARE_FOOTER);
    expect(at('stacked')).toContain('Net liquidity has been drifting lower.');
    expect(at('stacked')).toContain(COMPARE_FOOTER);
    for (const line of shots.find((s) => s.title.includes('stacked'))!.lines) expect(textOf([line]).length).toBeLessThanOrEqual(60);
    expect(at('filings')).toContain('reporting item 2.02, results of operations [1].');
    expect(at('filings')).toContain('PR news · filed by Fictional Group Corp · Sep 28 to Oct 9, 2026 read 14:02 UTC');
    expect(at('no record')).toContain("PreReason's news holds no record filed by Fictional Group Corp from Sep 28 to Oct 9, 2026. Sources read: Sample Filings Registry 8-K items.");
    expect(at('not read')).toContain('Not read for this answer: Sample Overseas Registry.');
    // Up in green and down in red, each beside its arrow.
    expect(at('market map, in colour')).toContain('SPY ▲ 1.2% QQQ ▲ 2.0% IWM ▼ 0.4%');
    expect(at('market map, plain')).toContain('SPY +1.2% QQQ +2.0% IWM -0.4%');
    expect(at('positioning')).toContain('4 weekly readings, Sep 18 to Oct 9');
    expect(at('the card')).toMatch(/swing, version 1, frozen Oct 12, 2026 at the first backtest/);
    expect(at('hurdle ladder')).toContain('H5 significance');
    expect(at('registry')).toContain('Registry 4 hypotheses and versions');
    expect(at('a sentence each')).toMatch(/Digest 2 changes since the end of 2026-09-25 UTC/);
    expect(at('a sentence each')).toContain("tga's signal moved to above-trend [1].");
    expect(at('a sentence each')).toContain('7 of 7 checks: answer format');
  }, 120_000);

  // A notice is a publisher's term: a made-up one in a public picture would present a source
  // that does not exist. The tests keep theirs; the gallery's market answers carry none.
  it('draws the market boards with no notice, the made-up ones kept in the tests, and commits no gallery file that holds one', async () => {
    const madeUp = [...new Set(Object.values(answers()).flatMap((a) => (a.notices as string[] | undefined) ?? []))];
    expect(madeUp).toEqual(expect.arrayContaining(['Powered by Acme.', 'Source: Sample Energy Office.', "PreReason's calculation from the Sample Positions Office Commitments of Traders."]));
    // Every market picture and the markets GIF are drawn from the one session, whose answers serve no notice.
    for (const s of [...FIXTURE_STILLS, ...FIXTURE_GIFS].filter((s) => s.group === 'markets')) expect(s.session, s.title).toBe(marketSession);
    const home = mkdtempSync(join(tmpdir(), 'pk-gallery-notices-'));
    try {
      const data = (await marketSession(home)).briefings('not-a-key');
      for (const id of Object.keys(answers())) expect((await data.metric!(id)).notices, id).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    // The words in a picture, its text elements run together, or a page as written.
    const wordsOf = (file: string, body: string) =>
      (file.endsWith('.svg') ? [...body.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]).join(' ') : body).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const noNotice = (file: string, body: string) => {
      const words = wordsOf(file, body);
      for (const notice of madeUp) expect(words, file).not.toContain(notice);
      // A picture drawn from fixtures holds no notice at all: every source there is made up.
      if (file.startsWith('fixtures/')) expect(words, file).not.toMatch(/Powered by|PreReason's calculation from|Source: /);
    };
    for (const s of await fixtureShots(FIXTURE_STILLS.filter((s) => s.group === 'markets'))) noNotice(`fixtures/${s.file}`, s.svg);
    const gallery = join(ROOT, 'docs', 'gallery');
    if (existsSync(gallery)) {
      const files = (readdirSync(gallery, { recursive: true }) as string[]).map((f) => f.replace(/\\/g, '/')).filter((f) => /\.(svg|md)$/.test(f));
      expect(files).toEqual(expect.arrayContaining(['fixtures/07-chart-market-map-in-colour.svg', 'fixtures/08-chart-market-map-plain.svg', 'fixtures/09-chart-positioning.svg']));
      for (const f of files) noNotice(f, readFileSync(join(gallery, f), 'utf8'));
    }
  }, 120_000);

  it("draws every frame of the new screens' GIFs with its caption and the mark", async () => {
    const gifs = await fixtureGifFrames();
    expect(gifs.map((g) => g.file)).toEqual(FIXTURE_GIFS.map((g) => g.file));
    for (const [i, g] of gifs.entries()) {
      const gif = FIXTURE_GIFS[i]!;
      expect(g.frames.map((f) => f.delay), g.file).toEqual(gif.frames.flatMap((f) => (f.hold ? [f.hold] : [])));
      const caption = captionLines(captionOf(gif.group, `${gif.title}, a frame a step.`), gif.columns).at(-1)!;
      for (const f of g.frames) {
        expect(f.svg, g.file).toMatch(MARK);
        expect(f.svg, g.file).not.toContain(SAVED_MARK);
        expect(f.svg, g.file).toContain(`>${caption.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</text>`);
      }
    }
  }, 120_000);

  // A picture travels without its caption (a share, a search result, a repost): each one says
  // what it shows inside it. Every picture under fixtures/ is made up and says "sample data";
  // every demo picture (the top level) shows PreReason's briefings saved on 2026-10-16 and says
  // so; the keyed, replay and storyboard ones, live sessions, carry neither.
  it.runIf(existsSync(join(ROOT, 'docs', 'gallery')))('commits "sample data" in every made-up picture, the saved day in every demo picture, and neither in any other', async () => {
    const gallery = join(ROOT, 'docs', 'gallery');
    const files = (readdirSync(gallery, { recursive: true }) as string[]).map((f) => f.replace(/\\/g, '/')).filter((f) => /\.(svg|gif)$/.test(f));
    const madeUp = files.filter((f) => f.startsWith('fixtures/'));
    const demo = files.filter((f) => !f.includes('/'));
    expect(madeUp).toHaveLength(FIXTURE_STILLS.length + FIXTURE_GIFS.length);
    expect(demo.filter((f) => f.endsWith('.gif')).sort()).toEqual(GIFS.map((g) => g.file).sort());
    expect(demo.filter((f) => f.endsWith('.svg')).length).toBeGreaterThan(10);
    expect(files.length).toBeGreaterThan(madeUp.length + demo.length);
    // How far each mark reaches from the right edge of a GIF 100 columns wide.
    const reachOf = async (mark: string) => {
      const pixels = await pixelsOf(screenSvg([], 100, 1, mark, true, undefined, mark));
      return corner(pixels.width, pixels.at).reach;
    };
    const reach = { sample: await reachOf(SAMPLE_MARK), saved: await reachOf(SAVED_MARK) };
    for (const f of files) {
      const body = readFileSync(join(gallery, f));
      if (f.endsWith('.svg')) {
        const svg = body.toString('utf8');
        if (madeUp.includes(f)) expect(svg, f).toMatch(MARK);
        else expect(svg, f).not.toMatch(/sample data/i);
        if (demo.includes(f)) expect(svg, f).toMatch(SAVED);
        else expect(svg, f).not.toContain(SAVED_MARK);
      } else {
        // A GIF's first frame, its top right band: a mark's pixels, reaching as far as that mark
        // does, or only the background.
        const frame = firstFrame(new Uint8Array(body));
        const { ink, reach: reached } = corner(frame.width, frame.at);
        expect(frame.width, f).toBe(872);
        if (madeUp.includes(f) || demo.includes(f)) {
          expect(ink, f).toBeGreaterThan(20);
          expect(Math.abs(reached - (madeUp.includes(f) ? reach.sample : reach.saved)), f).toBeLessThanOrEqual(3);
        } else expect(ink, f).toBe(0);
      }
    }
  });

  it('draws every demo still and every frame of its GIFs with the day its briefings were saved, never "sample data"', async () => {
    const shots = await demoShots();
    expect(shots.length).toBeGreaterThan(10);
    for (const s of shots) {
      expect(s.svg, s.file).toMatch(SAVED);
      expect(s.svg, s.file).not.toContain(SAMPLE_MARK);
    }
    const gifs = await demoGifFrames();
    expect(gifs.map((g) => g.file)).toEqual(GIFS.map((g) => g.file));
    for (const g of gifs) {
      for (const f of g.frames) {
        expect(f.svg, g.file).toMatch(SAVED);
        expect(f.svg, g.file).not.toContain(SAMPLE_MARK);
      }
    }
    // And no made-up picture carries the day.
    for (const s of await fixtureShots(FIXTURE_STILLS.slice(0, 1))) expect(s.svg).not.toContain(SAVED_MARK);
  }, 120_000);

  // H5's interval is drawn with a seed from the run's id, and primerkit gives each run a fresh
  // one: the gallery's research backtests are kept under one pinned id, so a redraw draws the
  // same ladder, registry and GIF.
  it('draws the research pictures the same on every redraw, each backtest under the pinned run id', async () => {
    const stills = FIXTURE_STILLS.filter((s) => s.group === 'research');
    const gif = FIXTURE_GIFS.filter((g) => g.group === 'research');
    const [once, again] = [await fixtureShots(stills), await fixtureShots(stills)];
    expect(again.map((s) => s.svg)).toEqual(once.map((s) => s.svg));
    expect(flat(textOf(once.find((s) => s.title.includes('hurdle ladder'))!.lines))).toMatch(/H5 significance passed the edge over control's 95% interval is above zero \(\d+\.\d% to \d+\.\d%\)/);
    const [moving, movingAgain] = [await fixtureGifFrames(gif), await fixtureGifFrames(gif)];
    expect(movingAgain[0]!.frames.map((f) => f.svg)).toEqual(moving[0]!.frames.map((f) => f.svg));
    const home = mkdtempSync(join(tmpdir(), 'pk-gallery-pin-'));
    try {
      await researchSession(home);
      const routines = readdirSync(join(home, 'routines'));
      expect(routines).toHaveLength(4);
      for (const name of routines) {
        expect(readdirSync(join(home, 'routines', name, 'backtests')), name).toEqual([RESEARCH_RUN_ID]);
        expect(JSON.parse(readFileSync(join(home, 'routines', name, 'backtests', RESEARCH_RUN_ID, 'plan.json'), 'utf8')).runId, name).toBe(RESEARCH_RUN_ID);
        expect(readFileSync(join(home, 'routines', name, 'hypotheses', 'versions.jsonl'), 'utf8'), name).toContain(`"runId":"${RESEARCH_RUN_ID}"`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  // A call made and its refusal dropped, as a session drops one; a request let through is
  // closed at once.
  const calling = (call: () => ClientRequest | Promise<unknown>) => async (): Promise<void> => {
    try {
      const sent = call();
      if (sent instanceof Promise) await sent;
      else sent.on('error', () => {}).destroy();
    } catch {
      // refused
    }
  };

  it("stops before any picture is written when a screen's session calls out, through fetch, node:http or node:https", async () => {
    const real = { fetch: globalThis.fetch, request: httpRequest, get: httpsGet };
    const still = (call: () => Promise<void>) => ({ ...FIXTURE_STILLS[0]!, session: async (home: string) => (await call(), compareSession(home)) });
    await expect(fixtureShots([still(calling(() => fetch('https://fixture.invalid/')))])).rejects.toThrow(/tried to call out \(1 calls, the first to fixture\.invalid\), so no picture was written/);
    // By name, as the local model's chat imports request, and by options.
    await expect(fixtureShots([still(calling(() => httpRequest('http://127.0.0.1:9/api/chat')))])).rejects.toThrow(/tried to call out \(1 calls, the first to 127\.0\.0\.1:9\), so no picture was written/);
    await expect(fixtureShots([still(calling(() => httpsGet({ hostname: 'fixture.invalid', path: '/v1/messages' })))])).rejects.toThrow(/tried to call out \(1 calls, the first to fixture\.invalid\), so no picture was written/);
    // Each door is as it was after.
    expect(globalThis.fetch).toBe(real.fetch);
    expect(httpRequest).toBe(real.request);
    expect(httpsGet).toBe(real.get);
  });

  it("draws the demo's stills and GIFs inside the same guard", async () => {
    const real = httpRequest;
    const deps = () => ({ ...demoDeps({ version: 'gallery' }), checkMachine: async () => (await calling(() => httpRequest('http://127.0.0.1:9/api/tags'))(), GALLERY_MACHINE) });
    await expect(demoShots(GALLERY.slice(0, 2), 100, 30, deps)).rejects.toThrow(/tried to call out \(\d+ calls?, the first to 127\.0\.0\.1:9\), so no picture was written/);
    await expect(demoGifFrames([GIFS[0]!], 100, 30, deps)).rejects.toThrow(/tried to call out \(\d+ calls?, the first to 127\.0\.0\.1:9\), so no picture was written/);
    expect(httpRequest).toBe(real);
  }, 60_000);

  // The gallery is left out of a release, which this checks wherever it runs; the page is
  // checked where the pictures are, in a checkout that holds docs/gallery.
  it('keeps the gallery out of a release', () => {
    const attrs = execFileSync('git', ['check-attr', 'export-ignore', '--', 'docs/gallery/README.md', 'docs/gallery/fixtures/compare.gif'], { cwd: ROOT, encoding: 'utf8' });
    expect(attrs.trim().split('\n').map((l) => l.trim())).toEqual(['docs/gallery/README.md: export-ignore: set', 'docs/gallery/fixtures/compare.gif: export-ignore: set']);
  });

  it.runIf(existsSync(join(ROOT, 'docs', 'gallery')))('commits the page with the condition above the compare screens, and every new picture it names', () => {
    const page = readFileSync(join(ROOT, 'docs', 'gallery', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    // The page as this code writes it: the hand-written web search response never called recorded.
    expect(page).toContain(fixturePage([]).find((l) => l.startsWith('The real session'))!);
    expect(page).not.toMatch(/\brecorded\b/i);
    const compare = page.indexOf('### /compare');
    expect(page.indexOf(`> ${PUBLIC_USE}`)).toBeGreaterThan(compare);
    expect(page.indexOf(`> ${PUBLIC_USE}`)).toBeLessThan(page.indexOf('](fixtures/', compare));
    // The demo's opening, with its day and the link to the pictures not to use.
    expect(page).toContain(demoIntro());
    const named = [...page.matchAll(/\]\((fixtures\/[^)]+)\)/g)].map((m) => m[1]!);
    expect(named.length).toBe(FIXTURE_STILLS.length + FIXTURE_GIFS.length);
    for (const file of named) expect(existsSync(join(ROOT, 'docs', 'gallery', file)), file).toBe(true);
    // Each picture's caption, its lines run together, says it is drawn from fixtures.
    const captionIn = (svg: string) => [...svg.matchAll(/fill="#a89f92">([^<]*)<\/text>/g)].map((m) => m[1]).join(' ');
    for (const file of named.filter((f) => f.endsWith('.svg'))) expect(captionIn(readFileSync(join(ROOT, 'docs', 'gallery', file), 'utf8')), file).toMatch(/Drawn from test fixtures, not a live run: .*\bmade up\b/);
  });

  // A picture this run does not redraw stays as last drawn: each one that shows words the session
  // no longer shows (the checks line as it was) or a label since changed (UUP as DXY) is listed,
  // and none is used in public until it is redrawn.
  it.runIf(existsSync(join(ROOT, 'docs', 'gallery')))('lists every picture not to use until it is redrawn, each one there, and links the list from the top of the page', async () => {
    const gallery = join(ROOT, 'docs', 'gallery');
    const list = readFileSync(join(gallery, DO_NOT_USE), 'utf8').replace(/\r\n/g, '\n');
    expect(list.split('\n').filter((l) => l.trim() && !l.startsWith('#'))[0]).toBe('None of these is in a release (`docs/gallery` is export-ignored), and none is used in a video, post or listing until it is redrawn.');
    // The storyboard's picture that showed a checks line under the demo stand in's answer, which
    // is never checked, and its GIF are gone, not listed.
    for (const dropped of ['storyboard/first-five-minutes/11-11-the-same-question-answered.svg', 'storyboard/first-five-minutes.gif']) {
      expect(existsSync(join(gallery, dropped)), dropped).toBe(false);
      expect(list).not.toContain(dropped);
    }
    const listed = [...list.matchAll(/^- `([^`]+)`: \S/gm)].map((m) => m[1]!);
    expect(new Set(listed).size).toBe(listed.length);
    for (const p of listed) expect(existsSync(join(gallery, p)), p).toBe(true);
    // Every committed picture that shows either is listed, and every demo GIF with a frame that does.
    const words = (svg: string) => [...svg.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]).join(' ');
    const stale = (svg: string) => /✓ \d+ of \d+ checks passed|\bDXY\b/.test(words(svg));
    const svgs = (readdirSync(gallery, { recursive: true }) as string[]).map((f) => f.replace(/\\/g, '/')).filter((f) => f.endsWith('.svg'));
    const shown = svgs.filter((f) => stale(readFileSync(join(gallery, f), 'utf8')));
    expect(shown.length).toBeGreaterThan(70);
    for (const f of shown) expect(listed, f).toContain(f);
    // The demo names the dollar fund's series UUP now, so none of its GIFs shows DXY.
    const staleGifs = (await demoGifFrames()).filter((g) => g.frames.some((f) => stale(f.svg))).map((g) => g.file);
    expect(staleGifs).toEqual([]);
    for (const g of staleGifs) expect(listed, g).toContain(g);
    // On the page near the top: in its opening, before the first picture.
    const page = readFileSync(join(gallery, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(demoIntro()).toContain(`[${DO_NOT_USE}](${DO_NOT_USE})`);
    expect(page.indexOf(`](${DO_NOT_USE})`)).toBeGreaterThan(0);
    expect(page.indexOf(`](${DO_NOT_USE})`)).toBeLessThan(page.indexOf('!['));
  }, 120_000);
});
