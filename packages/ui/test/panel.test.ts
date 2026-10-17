import { describe, expect, it } from 'vitest';
import { PALETTE, changeCell, checkReadability, duo, maker, markSize, pairReadability, pkMark, statusStrip, titleBar, widthOf, type Line } from '../src/index';

const text = (line: Line): string => line.map(([, s]) => s).join('');
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

describe('the panel frame', () => {
  it('names the function and its subject on the left of the title bar, and the date and source on the right, across the width', () => {
    for (const plain of [false, true]) {
      const t = maker(plain);
      const bar = titleBar(t, 'DIGEST', '2026-10-16', 'Sep 25, 2026 · PreReason', 76);
      expect(widthOf(bar)).toBe(76);
      expect(text(bar)).toMatch(plain ? /^\[DIGEST\] 2026-10-16 +Sep 25, 2026 \| PreReason $/ : /^ DIGEST {2}2026-10-16 +Sep 25, 2026 · PreReason $/);
      if (plain) expect(isAscii(text(bar))).toBe(true);
    }
    // The code on its sandstone tile, the rest on the bar.
    const bar = titleBar(maker(false), 'BRIEF', 'macro.snapshot', 'Sep 25, 2026 · PreReason', 120);
    expect(bar[0]).toEqual(['code/codeTile', ' BRIEF ']);
    expect(bar.slice(1).every(([role]) => role.endsWith('/bar'))).toBe(true);
    expect(widthOf(bar)).toBe(120);
  });

  it('lets the right side go, then shortens the subject, where the two do not fit', () => {
    for (const plain of [false, true]) {
      const t = maker(plain);
      const bar = titleBar(t, 'ASK', 'Is net liquidity rising or falling, and what is the Treasury yield curve doing this week?', 'Sep 25, 2026 · PreReason', 60);
      expect(widthOf(bar)).toBe(60);
      expect(text(bar)).not.toContain('PreReason');
      expect(text(bar)).toMatch(plain ? /\.\.\. *$/ : /… *$/);
      if (plain) expect(isAscii(text(bar))).toBe(true);
    }
  });

  it('keeps the status strip to one row, the last parts going first', () => {
    const parts: Array<[string, string]> = [['model', 'qwen2.5:7b'], ['PreReason', 'free'], ['data', 'Sep 25, 2026'], ['tokens', '2,172'], ['runs today', '3']];
    for (const plain of [false, true]) {
      const t = maker(plain);
      const wide = statusStrip(t, parts, 100);
      expect(widthOf(wide)).toBe(100);
      expect(text(wide)).toContain(plain ? 'model qwen2.5:7b | PreReason free | data Sep 25, 2026 | tokens 2,172 | runs today 3' : 'model qwen2.5:7b │ PreReason free │ data Sep 25, 2026 │ tokens 2,172 │ runs today 3');
      const narrow = statusStrip(t, parts, 48);
      expect(widthOf(narrow)).toBe(48);
      expect(text(narrow)).toContain('PreReason free');
      expect(text(narrow)).not.toContain('runs today');
      // CONTROL: one part longer than the strip is cut, never wider.
      expect(widthOf(statusStrip(t, [['model', 'a model with a very long name indeed, local, 32k context']], 30))).toBe(30);
    }
  });

  it("sets a setup step's two strips, what you do and what the agent does, each under its own label", () => {
    const lines = duo(maker(true), 'Pick a question, or type your own.', "Reads the briefings that answer it, ties each figure to a line, and primerkit's code checks the answer.", 76);
    const rows = lines.map(text);
    expect(rows[0]).toBe(' YOU DO       Pick a question, or type your own.');
    expect(rows[1]).toMatch(/^ AGENT DOES {3}Reads the briefings that answer it/);
    // Its later lines start under its first word.
    for (const row of rows.slice(2)) expect(row).toMatch(/^ {14}\S/);
    expect(rows.slice(1).join(' ').replace(/\s+/g, ' ')).toContain("primerkit's code checks the answer.");
    for (const l of lines) expect(widthOf(l)).toBeLessThanOrEqual(76);
  });

  it('colours a change by its sign alone, green up and red down, with its arrow, and plain text by its sign', () => {
    const t = maker(false);
    expect(changeCell(t, 1.2, '+1.2%', 8)).toEqual(['up', ' ▲ +1.2%']);
    expect(changeCell(t, -0.4, '-0.4%', 8)).toEqual(['down', ' ▼ -0.4%']);
    expect(changeCell(t, 0, '0.0%', 8)[0]).toBe('muted');
    expect(changeCell(t, null, '', 8)[0]).toBe('dim');
    const p = maker(true);
    expect(changeCell(p, 1.2, '+1.2%', 8)).toEqual(['up', '   +1.2%']);
    expect(changeCell(p, -0.4, '-0.4%', 8)).toEqual(['down', '   -0.4%']);
  });

  it('holds the bar and the tile to the text bar against the colours they are drawn on', () => {
    expect(pairReadability().filter((p) => !p.pass)).toEqual([]);
    expect(() => checkReadability()).not.toThrow();
    // CONTROL: a bar too light for its text fails.
    expect(() => checkReadability({ ...PALETTE, bar: { ...PALETTE.bar, hex: '#8a7a6a' } })).toThrow(/barText on bar|barDim on bar/);
    // The neutral pair is gone: up and down are the market map's colours too.
    expect(Object.keys(PALETTE)).not.toContain('rise');
    expect(Object.keys(PALETTE)).not.toContain('fall');
  });
});

describe('the mini mark', () => {
  it("draws primerkit's PK in 12 by 6 characters for the launchpad, of quadrant blocks only", () => {
    const mark = pkMark('mini');
    expect(markSize('mini')).toEqual({ columns: 12, rows: 6 });
    expect(mark).toHaveLength(6);
    for (const row of mark) {
      expect(widthOf(row)).toBe(12);
      for (const [, s] of row) expect(/^[ ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█]*$/.test(s)).toBe(true);
    }
    // Its letters and its amber shadow both show.
    const roles = new Set(mark.flat().map(([role]) => role.split('/')[0]));
    expect(roles.has('pkLetter')).toBe(true);
    expect(roles.has('pkShadow')).toBe(true);
  });
});
