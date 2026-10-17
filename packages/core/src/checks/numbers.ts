import type { Check, CheckFailure, Claim, Packet } from '../types';
import { citedLine } from './citations';
import { movesIn } from './moves';
import { answerOf, backgroundOf, claimsOf } from './shape';
import { namesOut } from './terms';

// A number as written, with its formatting taken off: "$65,000" and "65,000" are both
// 65000, "1.2%" and "1.2 percent" both 1.2, and "−2.1" is 2.1, its sign read apart (below).
// Rounding is not formatting: 84,512 is not 84,512.32. Zeros at the end of a decimal are
// formatting: -0.40% and 0.4% are one number.
const NUMBER = /[+\-−]?[$€£]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+\-−]?[$€£]?\d+(?:\.\d+)?/g;

const plain = (n: string): string =>
  n
    .replace(/[+\-−$€£,]/g, '')
    .replace(/^0+(?=\d)/, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');

export function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map(plain);
}

// A figure keeps the sign it is written with (the wording review's ruling of 2026-10-14,
// 13:30Z): "+2.5%" is not "-2.5%", and a level below zero is not one above it, "-0.12%" not
// "+0.12%". A ▲ or ▼ before a figure is its sign too. A hyphen inside a word, a range or a
// date is none ("10Y-2Y", "2.5-3%", "2026-10-14"), and zero has none.
export type FigureSign = '+' | '-';
export interface Figure {
  n: string;
  sign: FigureSign | null;
}

// A line shows a figure's sign by the move it is in as well: "up 10.6% over 7d" is +10.6, "a
// 2.5% fall" -2.5. In a claim such a move is the direction check's, which names it.
function figuresOf(text: string, moves: boolean): Figure[] {
  const said = moves ? movesIn(text) : [];
  return [...text.matchAll(NUMBER)].map((m) => {
    const at = m.index!;
    const n = plain(m[0]);
    const mark = /^[+\-−]/.test(m[0]) && !(at > 0 && /[\w.]/.test(text[at - 1]!)) ? m[0][0] : null;
    const glyph = text.slice(0, at).match(/([▲▼])\s*$/)?.[1];
    const move = said.find((v) => v.at <= at && at < v.at + v.said.length)?.sign;
    const sign = mark ? (mark === '+' ? '+' : '-') : glyph ? (glyph === '▲' ? '+' : '-') : move ? (move === 'rise' ? '+' : '-') : null;
    return { n, sign: n === '0' ? null : sign };
  });
}

const written = (f: Figure): string => `${f.sign ?? ''}${f.n}`;
const once = (figures: Figure[]): Figure[] => [...new Map(figures.map((f) => [written(f), f])).values()];

// The numbers some lines hold, each with every sign they show it with, null for none.
type Held = Map<string, Set<FigureSign | null>>;

function hold(held: Held, line: string): void {
  for (const f of figuresOf(line, true)) held.set(f.n, (held.get(f.n) ?? new Set<FigureSign | null>()).add(f.sign));
}

// A figure written with no sign is held by its number, either sign; one written with a sign,
// where a line shows its number with that sign, or with none.
function holds(held: Held, f: Figure): boolean {
  const signs = held.get(f.n);
  return signs !== undefined && (f.sign === null || signs.has(f.sign) || signs.has(null));
}

// What the lines give for a signed figure they hold only the other way: "-2.5" for "+2.5".
const gave = (held: Held, missing: Figure[]): string[] =>
  missing.filter((f) => f.sign && held.has(f.n)).map((f) => written({ n: f.n, sign: f.sign === '+' ? '-' : '+' }));

// A reference to the packet's own parts names no figure: "rule 1", "rules 2 and 3", "line
// 23", "L12", "[btc.pulse L7]". A routine's rules are numbered, so an answer naturally says
// which rule gave its label; before 2026-10-09 that "1" was held to the cited lines as if it
// were data, and 17 of 27 ticks of one backtest needed a repair turn for it. The number a
// word names is a whole number of up to three digits that is no part of a figure: in "rule
// 3, 58,000" and "trend line 61,250" the 58,000 and the 61,250 are figures, and count.
const PART = String.raw`\d{1,3}(?!\d|[.,]\d|\s*%)`;
const REFERENCE = new RegExp(String.raw`\[[a-z0-9./-]+ L\d+\]|\b(?:rules?|lines?|steps?)\s+${PART}(?:\s*(?:,|and|or|to|-|–)\s*${PART})*|\bL\d+\b`, 'gi');

export function figuresIn(text: string): string[] {
  return numbersIn(text.replace(REFERENCE, ' '));
}

// The figures a text states, each with the sign it is written with.
export function signedFiguresIn(text: string): Figure[] {
  return figuresOf(text.replace(REFERENCE, ' '), false);
}

// The figures a claim states, each once as written, the numbers its cited lines hold, and the
// figures those lines do not hold, with what they give for a sign they hold the other way:
// what grounded_numbers tests of one claim, and what the compare view counts, so the two
// never differ.
export function claimFigures(packet: Packet, claim: Claim): { figures: string[]; cited: Held; missing: string[]; gave: string[] } {
  const cited: Held = new Map();
  for (const c of claim.citations) {
    const line = citedLine(packet, c.block, c.line);
    if (line !== null) hold(cited, line);
  }
  const figures = once(signedFiguresIn(claim.text));
  const missing = figures.filter((f) => !holds(cited, f));
  return { figures: figures.map(written), cited, missing: missing.map(written), gave: gave(cited, missing) };
}

// Every number in a claim appears in the lines it cites, and every number in the
// answer appears in some line a claim cites, each with its sign where it is written with one.
export const groundedNumbersCheck: Check = {
  id: 'grounded_numbers',
  run(packet, response): CheckFailure[] {
    const failures: CheckFailure[] = [];
    const everyCited: Held = new Map();
    claimsOf(response).forEach((claim, i) => {
      const { cited, missing, gave: other } = claimFigures(packet, claim);
      for (const [n, signs] of cited) everyCited.set(n, new Set([...(everyCited.get(n) ?? []), ...signs]));
      if (missing.length) failures.push({ check: 'grounded_numbers', claim: i, message: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the lines this claim cites${other.length ? `; they give ${other.join(', ')}` : ''}` });
    });
    const missing = once(signedFiguresIn(answerOf(response))).filter((f) => !holds(everyCited, f));
    const other = gave(everyCited, missing);
    if (missing.length) failures.push({ check: 'grounded_numbers', message: `the answer states ${missing.map(written).join(', ')}, which no cited line holds${other.length ? `; the cited lines give ${other.join(', ')}` : ''}` });
    // Background comes from the model's own knowledge, which no line checks, so it holds no
    // number at all: a figure belongs in a claim that cites the line it is in.
    backgroundOf(response).forEach((text, i) => {
      // A maturity such as 10Y, a curve spread such as 10s2s and a listed index such as the
      // S&P 500 are names, not figures (terms.ts).
      const figures = [...new Set(figuresIn(namesOut(text)))];
      if (figures.length) failures.push({ check: 'grounded_numbers', background: i, message: `background sentence ${i + 1} states ${figures.join(', ')}, and background holds no number; a figure belongs in a claim that cites its line` });
    });
    return failures;
  },
};
