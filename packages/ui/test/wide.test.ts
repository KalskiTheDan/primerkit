import { describe, expect, it } from 'vitest';
import { charWidth, clip, inputLine, lastColumns, maker, textWidth, widthOf, wrap } from '../src/index';

// Characters two columns wide, built from their code points so the test file stays ASCII:
// a Japanese ideograph, a Korean syllable, a full-width letter and an emoji.
const KANJI = String.fromCodePoint(0x6f22);
const HANGUL = String.fromCodePoint(0xd55c);
const FULL_A = String.fromCodePoint(0xff21);
const SMILE = String.fromCodePoint(0x1f600);
const COMBINING_ACUTE = String.fromCodePoint(0x0301);

describe('characters two columns wide', () => {
  it('are measured as the terminal draws them', () => {
    for (const ch of [KANJI, HANGUL, FULL_A, SMILE]) expect(charWidth(ch)).toBe(2);
    expect(charWidth('a')).toBe(1);
    expect(charWidth(COMBINING_ACUTE)).toBe(0);
    expect(textWidth(`ab${KANJI}${HANGUL}`)).toBe(6);
    expect(widthOf([['fg', KANJI.repeat(3)], ['dim', ' x']])).toBe(8);
  });

  it('keep a line within its width when it is cut, wrapped or typed', () => {
    const t = maker(false);
    const cut = clip([['fg', KANJI.repeat(20)]], 11);
    expect(widthOf(cut)).toBeLessThanOrEqual(11);
    for (const line of wrap(t, `${KANJI.repeat(6)} ${HANGUL.repeat(6)} ${KANJI.repeat(6)}`, 14)) expect(widthOf(line)).toBeLessThanOrEqual(14);
    // 40 ideographs typed at 80 columns: the end that fits is shown, after an ellipsis.
    const typed = inputLine(t, KANJI.repeat(40), true, 80);
    expect(widthOf(typed)).toBeLessThanOrEqual(80);
    expect(lastColumns(`${'a'.repeat(5)}${KANJI.repeat(3)}`, 5)).toBe(KANJI.repeat(2));
  });
});
