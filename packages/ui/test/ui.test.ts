import { describe, expect, it } from 'vitest';
import {
  PALETTE,
  QUADRANTS,
  TAGLINE,
  bar,
  checkReadability,
  colorMode,
  glyphMode,
  contrast,
  lineChart,
  lockup,
  lockupWidth,
  maker,
  pkMark,
  prMark,
  rail,
  readability,
  renderLine,
  widthOf,
  wrap,
  type Line,
} from '../src/index';

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

describe('readability', () => {
  it('holds every colour to its bar on black, Windows Terminal and VS Code', () => {
    const low = readability().filter((r) => !r.pass);
    expect(low).toEqual([]);
    expect(() => checkReadability()).not.toThrow();
  });

  it('fails a colour below its bar, so the check is not blind', () => {
    // A dim below its bar: 3.8 to 1 on Windows Terminal.
    const lowered = { ...PALETTE, dim: { ...PALETTE.dim, hex: '#786b5b' } };
    expect(() => checkReadability(lowered)).toThrow(/dim #786b5b/);
  });

  it('measures contrast as WCAG does', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#d9ae8c', '#0c0c0c')).toBeCloseTo(9.67, 1);
  });
});

describe('the plain version', () => {
  const t = maker(true);

  it('is ASCII only for the logo, the mark and the rail', () => {
    for (const line of [...lockup(t, true), ...prMark(t, true), rail(t, true, 1)]) {
      expect(isAscii(line.map(([, x]) => x).join(''))).toBe(true);
    }
  });

  it('maps every other character to ASCII', () => {
    const [, text] = t('fg', '▲ 1.2% · ✓ done ↳ [1] ⠼');
    expect(isAscii(text)).toBe(true);
  });
});

describe('the logo and the marks', () => {
  // Where each colour of the mark falls, by character: how many, and their middle.
  const where = (mark: Line[], ink: string) => {
    const at: Array<[number, number]> = [];
    mark.forEach((line, y) => {
      let x = 0;
      for (const [role, text] of line) {
        for (const ch of text) {
          if (role.split('/')[0] === ink && ch !== ' ') at.push([x, y]);
          x++;
        }
      }
    });
    return { n: at.length, x: at.reduce((a, [x]) => a + x, 0) / at.length, y: at.reduce((a, [, y]) => a + y, 0) / at.length };
  };

  it("draws primerkit's PK in 21 by 10 characters and in 17 by 8, of quadrant blocks only, its letters in front of an amber shadow", () => {
    for (const [size, cols, rows] of [['large', 21, 10], ['small', 17, 8]] as const) {
      const mark = pkMark(size);
      expect(mark, size).toHaveLength(rows);
      for (const line of mark) expect(widthOf(line), size).toBe(cols);
      for (const [role, text] of mark.flat()) {
        expect(['fg', 'pkLetter', 'pkShadow', 'pkLetter/pkShadow'], size).toContain(role);
        for (const ch of text) expect(QUADRANTS as readonly string[], size).toContain(ch);
      }
      // The shadow is there, and falls down and to the right of the letters.
      const letters = where(mark, 'pkLetter');
      const shadow = where(mark, 'pkShadow');
      expect(shadow.n, size).toBeGreaterThan(0);
      expect(letters.n, size).toBeGreaterThan(shadow.n);
      expect(shadow.x, size).toBeGreaterThan(letters.x);
      expect(shadow.y, size).toBeGreaterThan(letters.y);
    }
    expect(PALETTE.pkLetter.hex).toBe('#e9e3d8');
    expect(PALETTE.pkShadow.hex).toBe('#f59e0b');
    // In 16 colours the shadow is the terminal's yellow, a dark gold, in front and behind; its
    // bright yellow is a pale lemon (seen in Windows Terminal with --16).
    expect(renderLine(pkMark('small')[1]!, '16')).toContain('\x1b[97;43m');
    expect(renderLine(pkMark('small')[1]!, '16')).toContain('\x1b[33m');
    expect(renderLine(pkMark('small')[1]!, '16')).not.toMatch(/\x1b\[(9|10)3/);
  });

  it('draws the small PK as it was drawn and checked', () => {
    expect(pkMark('small').map((line) => line.map(([, text]) => text).join(''))).toEqual([
      '▄▄▄▄▄▖   ▄▄  ▗▄▄▖',
      '██▀▀▜█▙▖▐██▌▗█▛▀▛',
      '▀▀▛  ▐█▌▐██▗█▛█  ',
      '▄▄▄▄▟█▛█▐███▛█▘  ',
      '██▀▀▀▘▀ ▐███▙▖   ',
      '███     ▐██▐█▙▖  ',
      '███     ▝█▛▌▝██▙▄',
      ' ▀▘      ▝▀▘  ▀▘▀',
    ]);
  });

  it('sets the name and the tagline beside the mark, on its middle rows, and in plain text has them alone', () => {
    const t = maker(false);
    const lines = lockup(t, false, 'large');
    expect(lines).toHaveLength(10);
    const said = lines.map((line) => line.map(([, text]) => text).join('').trimEnd());
    expect(said[4]?.endsWith('   primerkit')).toBe(true);
    expect(said[5]?.endsWith(`   ${TAGLINE}`)).toBe(true);
    expect(said.filter((l) => /[a-z]/.test(l))).toHaveLength(2);
    expect(Math.max(...lines.map(widthOf))).toBe(lockupWidth('large'));
    expect([lockupWidth('large'), lockupWidth('small')]).toEqual([61, 57]);
    expect(lockup(maker(true), true)).toEqual([[['bright', ' primerkit']], [['tag', ` ${TAGLINE}`]]]);
  });

  it("draws PreReason's mark in 13 by 6 characters, in sextants and in half blocks", () => {
    const t = maker(false);
    for (const style of ['sextants', 'halves'] as const) {
      const mark = prMark(t, false, { style });
      expect(mark).toHaveLength(6);
      for (const line of mark) expect(widthOf(line)).toBe(13);
    }
  });
});

describe('rendering', () => {
  it('prints 24 bit colour, 16 colours or plain text', () => {
    const line: Line = [['accent', '›'], ['fg', ' hi']];
    expect(renderLine(line, 'truecolor')).toContain('\x1b[38;2;171;124;101m›');
    expect(renderLine(line, '16')).toContain('\x1b[33m›');
    expect(renderLine(line, 'plain')).toBe('› hi');
  });

  it('chooses plain for NO_COLOR or a pipe, and 24 bit colour where the terminal says so', () => {
    expect(colorMode({ env: { NO_COLOR: '1' }, isTTY: true })).toBe('plain');
    expect(colorMode({ env: {}, isTTY: false })).toBe('plain');
    expect(colorMode({ env: { COLORTERM: 'truecolor' }, isTTY: true })).toBe('truecolor');
    expect(colorMode({ env: {}, isTTY: true })).toBe('16');
  });

  it("uses ASCII glyphs, in colour, in the old Windows console, and Unicode where the font has it", () => {
    expect(glyphMode({ env: {}, platform: 'win32', color: '16' })).toBe('ascii');
    expect(glyphMode({ env: { WT_SESSION: 'x' }, platform: 'win32', color: 'truecolor' })).toBe('unicode');
    expect(glyphMode({ env: { TERM_PROGRAM: 'vscode' }, platform: 'win32', color: 'truecolor' })).toBe('unicode');
    expect(glyphMode({ env: { TERM: 'xterm-256color' }, platform: 'win32', color: '16' })).toBe('unicode');
    expect(glyphMode({ env: {}, platform: 'win32', color: '16', unicodeFlag: true })).toBe('unicode');
    expect(glyphMode({ env: {}, platform: 'darwin', color: '16' })).toBe('unicode');
    expect(glyphMode({ env: { WT_SESSION: 'x' }, platform: 'win32', color: 'plain' })).toBe('ascii');
  });

  it('wraps text to a width with figures bright', () => {
    const lines = wrap(maker(false), 'Bitcoin is at $84,512.32, up 10.6% over 7 days.', 20);
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(20);
    expect(lines.flat().filter(([role]) => role === 'bright').map(([, x]) => x)).toEqual(['$84,512.32', '10.6%', '7']);
  });
});

describe('a bar', () => {
  it('is drawn to the nearest eighth, a bar of almost one cell as one cell', () => {
    // MARA's 35K of MSTR's 846K in a 24 column bar is 7.94 eighths: it once drew as nothing.
    expect(bar(35 / 846, 24, false)).toBe('█');
    expect(bar(30 / 846, 24, false)).toBe('▉');
    expect(bar(1.99 / 24, 24, false)).toBe('██');
    // CONTROL: a longer bar keeps its partial cell, and nothing is drawn for nothing.
    expect(bar(35 / 846, 36, false)).toBe('█▌');
    expect(bar(0, 24, false)).toBe('');
    // A longer share never draws shorter than a smaller one.
    const lengths = Array.from({ length: 200 }, (_, i) => bar(i / 199, 24, false)).map((b) => Array.from(b).reduce((n, ch) => n + (ch === '█' ? 8 : ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'].indexOf(ch)), 0));
    for (let i = 1; i < lengths.length; i += 1) expect(lengths[i]!).toBeGreaterThanOrEqual(lengths[i - 1]!);
  });

  it('draws a share above zero as at least a sliver, never as nothing', () => {
    // Reverse repo of $15B beside a $6.6T balance sheet is a fifth of an eighth in 24 columns.
    expect(bar(15 / 6600, 24, false)).toBe('▏');
    expect(bar(15 / 6600, 24, true)).toBe('.');
    // CONTROL: nothing is still drawn as nothing, and a share of a cell or more is unchanged.
    expect(bar(0, 24, false)).toBe('');
    expect(bar(0, 24, true)).toBe('');
    expect(bar(0.5, 24, true)).toBe('#'.repeat(12));
  });
});

describe('the top line', () => {
  it('keeps to one row, dropping words from the budget before it would clip', async () => {
    const { topLine, maker, widthOf, WIDTH } = await import('../src/index');
    const t = maker(false);
    const short = topLine(t, { model: 'qwen2.5:7b, local, 8k', connected: true, tier: 'free', callsLeft: 460 });
    expect(short.map(([, s]) => s).join('')).toContain('460 calls left today');
    const long = topLine(t, { model: 'qwen2.5:7b, local, 32k', connected: true, tier: 'enterprise', callsLeft: 99_800 });
    expect(widthOf(long)).toBeLessThanOrEqual(WIDTH);
    expect(long.map(([, s]) => s).join('')).toMatch(/PreReason enterprise · 99,800 left$/);
  });
});

describe('a line chart', () => {
  it('names each line at its end, on its own row, the nearest free one where two meet', () => {
    const t = maker(true);
    const flat = (y: number): Array<[number, number]> => [[0, y], [10, y]];
    const rows = lineChart(t, {
      series: [
        { points: flat(100), style: 'main' },
        { points: flat(100), style: 'compare' },
        { points: flat(0), style: 'compare' },
      ],
      points: [],
      width: 20,
      height: 5,
      xRange: [0, 10],
      yRange: [0, 100],
      yLabel: (v) => v.toFixed(0),
      xTicks: [],
      ends: [
        { y: 100, text: 'first' },
        { y: 100, text: 'second' },
        { y: 0, text: 'third' },
      ],
      plain: true,
    });
    const text = rows.map((l) => l.map(([, s]) => s).join(''));
    expect(text[0]).toMatch(/ first$/);
    expect(text[1]).toMatch(/ second$/);
    expect(text[4]).toMatch(/ third$/);
    expect(text.filter((l) => /first|second|third/.test(l))).toHaveLength(3);
  });
});
