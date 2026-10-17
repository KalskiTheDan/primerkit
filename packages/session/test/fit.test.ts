import { describe, expect, it } from 'vitest';
import { maker, renderLine, textWidth } from '@primerkit/ui';
import { fitText, printedBoard, wrapWords, type Board } from '../src/index';

const t = maker(true);
const PROSE = 'Bitcoin is at $84,403, up 40.3% over 90 days, and the hash rate is unchanged over 7 days while net liquidity fell 1.7%.';

describe('text printed once, fitted to the window', () => {
  it('wraps a long line at spaces, every word kept, none past the window', () => {
    const out = fitText(PROSE, 40);
    for (const line of out.split('\n')) expect(Array.from(line).length).toBeLessThanOrEqual(39);
    expect(out.replace(/\n\s*/g, ' ')).toBe(PROSE);
    // CONTROL: in a wide window the line is left whole.
    expect(fitText(PROSE, 200)).toBe(PROSE);
  });

  it('starts a wrapped line where the first line starts its words, past a list mark', () => {
    for (const [mark, indent] of [['- ', '  '], ['1. ', '   '], ['[1] ', '    '], ['  ', '  ']] as const) {
      const lines = fitText(`${mark}${PROSE}`, 40).split('\n');
      expect(lines[0]!.startsWith(mark)).toBe(true);
      for (const later of lines.slice(1)) expect(later.startsWith(indent) && later[indent.length] !== ' ').toBe(true);
    }
  });

  it('leaves a line laid out in columns, and all of it without a terminal', () => {
    const table = 'Fed balance    $6.75T      ● 0.0%   ▲ 0.3%                    ───●─ P79';
    expect(fitText(table, 40)).toBe(table);
    expect(fitText(`${PROSE}\n${PROSE}`, undefined)).toBe(`${PROSE}\n${PROSE}`);
  });
});

describe('words wrapped to a width', () => {
  it('breaks a word wider than a line, a path after its slashes, so it is shown whole', () => {
    const path = 'node "C:/Users/someone/Desktop/primerkit/packages/cli/bin/primerkit.js" serve';
    const lines = wrapWords(path, 30, '  ');
    for (const line of lines) expect(Array.from(line).length).toBeLessThanOrEqual(30);
    expect(lines.slice(1).every((l) => l.startsWith('  '))).toBe(true);
    // Every character is kept, in order.
    expect(lines.join('').replace(/ /g, '')).toBe(path.replace(/ /g, ''));
    expect(lines[1]!.trim().endsWith('/')).toBe(true);
    // CONTROL: words that fit are wrapped at spaces, and none is broken.
    expect(wrapWords('a line of short words', 10)).toEqual(['a line of', 'short', 'words']);
  });

  it('wraps Japanese, which has no spaces, by the two columns each character takes', () => {
    const kanji = String.fromCodePoint(0x6f22).repeat(30);
    const lines = wrapWords(kanji, 20);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(20);
    expect(lines.join('')).toBe(kanji);
    expect(lines).toHaveLength(3);
    // Korean words, printed once: each line within the window as it is drawn.
    const korean = Array.from({ length: 3 }, () => String.fromCodePoint(0xd55c).repeat(4)).join(' ');
    for (const line of fitText(korean, 21).split('\n')) expect(textWidth(line)).toBeLessThanOrEqual(20);
  });
});

describe('the credit on a board printed once', () => {
  const board: Board = { title: 'Bitcoin', subtitle: '90 days', lines: [[t('fg', 'a line')]], sources: 'history, btc.momentum', generated: null };
  const credit = (columns: number) => renderLine(printedBoard(t, board, '00:00', columns).lines.at(-1)!, 'plain');

  it('drops the time, then the sources, before it would pass the window', () => {
    expect(credit(80)).toBe(' + PR  history, btc.momentum | generated 00:00 UTC');
    expect(credit(50)).toBe(' + PR  history, btc.momentum');
    expect(credit(20)).toBe(' + PR');
    for (const columns of [80, 50, 30, 20]) expect(credit(columns).length).toBeLessThanOrEqual(columns - 1);
  });
});
