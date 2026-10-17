import { itemsOf } from '../diff';
import type { Check, CheckFailure, Citation, Packet } from '../types';
import { citedLine } from './citations';
import { MOVE_FIGURE, MOVE_UNIT, movesIn } from './moves';
import { figuresIn } from './numbers';
import { answerOf, claimsOf } from './shape';

// The words that say which way a thing moved, held as whole words in any case. The full run
// of 2026-10-14: a Free key's packet held the yield curve's latest reading alone, and "The
// yield curve is currently steepening to 0.42%" passed 4 of 4 checks. The list is the
// wording review's of 2026-10-14. Not bare "up" or "down" ("the CEO stepped down" says no
// direction, as it ruled for news), nor "inverted", a state two levels show, nor "gained" or
// "lost". "up" or "down" before a percent or points figure is a move, and so is a move noun
// beside one ("up 2.5%", "a 2.5% fall"): directionsIn reads them too (moves.ts).
export const DIRECTION_WORDS = [
  'rising', 'falling', 'rose', 'fell', 'increasing', 'decreasing', 'increased', 'decreased',
  'steepening', 'flattening', 'steepened', 'flattened', 'steepens', 'flattens', 'widening', 'narrowing',
  'accelerating', 'decelerating', 'slowing', 'climbing', 'declining', 'improving', 'worsening',
  'strengthening', 'weakening', 'trending', 'higher', 'lower', 'uptrend', 'downtrend',
  'jumped', 'dropped', 'surged', 'plunged', 'soared', 'slid', 'tumbled', 'rallied', 'spiked', 'slumped', 'sank',
  'rebounded', 'rebounding', 'recovered', 'recovering', 'eased', 'easing', 'tightened', 'tightening', 'peaked',
  'expanding', 'contracting', 'inverting',
];

// A comparative also holds where the lines cited give both values compared: "the 10 year
// sits higher than the 2 year", citing both yields.
export const COMPARATIVES = ['higher', 'lower'];

// The words whose sign is fixed, a rise or a fall: a steepening or a widening is the spread's
// rise. Left out, so a cited change is enough for them, are the words whose way depends on the
// series: "improving", "worsening", "strengthening" and "weakening" (unemployment improving is
// a fall), and "tightened", "tightening", "eased" and "easing" (spreads that tighten fall,
// policy that tightens rises); and the words the wording review did not sign, such as "peaked".
export type Sign = 'rise' | 'fall';
const RISE = ['rising', 'rose', 'increasing', 'increased', 'higher', 'uptrend', 'jumped', 'surged', 'soared', 'rallied', 'spiked', 'rebounded', 'rebounding', 'recovered', 'recovering', 'climbing', 'steepening', 'steepened', 'steepens', 'widening'];
const FALL = ['falling', 'fell', 'decreasing', 'decreased', 'lower', 'downtrend', 'dropped', 'plunged', 'slid', 'tumbled', 'slumped', 'sank', 'declining', 'flattening', 'flattened', 'flattens', 'narrowing'];

export function signOfWord(word: string): Sign | null {
  return RISE.includes(word) ? 'rise' : FALL.includes(word) ? 'fall' : (movesIn(word)[0]?.sign ?? null);
}

// The change of a change: "accelerating" says a change sped up, "decelerating" and "slowing"
// that it slowed. They need the series' change over two windows, or a line that says the same
// of itself, as PreReason's "Accelerating:" does; a line that says the other holds neither.
type Speed = 'up' | 'down';
const SPEED: Record<string, Speed> = { accelerating: 'up', decelerating: 'down', slowing: 'down' };

const DIRECTION = new RegExp(String.raw`\b(?:${DIRECTION_WORDS.join('|')})\b`, 'gi');

// The direction words a sentence holds, and its moves said with their figures, each once and
// in the order said, as a reader writes them: lower case.
export function directionsIn(text: string): string[] {
  const words = [...text.matchAll(DIRECTION)].map((m) => ({ at: m.index!, said: m[0] }));
  const said = [...words, ...movesIn(text)].sort((a, b) => a.at - b.at);
  return [...new Set(said.map((w) => w.said.toLowerCase()))];
}

const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A word said only as "not rising" or "no longer falling" says no way the thing moved, so a
// cited change is enough for it.
function negated(text: string, word: string): boolean {
  const all = text.match(new RegExp(String.raw`(?<!\w)${escaped(word)}(?!\w)`, 'gi'))?.length ?? 0;
  const not = text.match(new RegExp(String.raw`\b(?:not|no longer)\s+${escaped(word)}(?!\w)`, 'gi'))?.length ?? 0;
  return not > 0 && not === all;
}

// A move said with its figure, "up 2.5%", "a 2.5% fall" or "rose 2.5% over 7 days", is the
// change its line states, since the figure is that line's. A word alone may say a digest
// item's move from one state to another. The walk of 2026-10-14: "turned bullish, up 2.5%
// over 7 days", against a line whose 7 day change is a fall, passed every check.
function figured(text: string, word: string): boolean {
  if (movesIn(word).length) return true;
  return new RegExp(String.raw`(?<!\w)${escaped(word)}\s+(?:by\s+)?${MOVE_FIGURE}|(?<![\w.,])${MOVE_FIGURE}\s+${escaped(word)}(?!\w)`, 'i').test(text);
}

// A figure with a plus sign is a rise; a correlation's (+0.26) is no change.
const PLUS = /(?<![(\w])\+\s?[$€£¥]?\d/;

// How PreReason's lines state a change, beside a direction word of their own: a glyph,
// "up 10.6% over 7d", "+0.3% over 30d", "flattening 34.0% over 30d" in a briefing's
// markdown; "7d +1.2%" and "7d -0.4%" in a metric's sentence, and a percentile's move
// written the same way ("percentile 61.5 ...; 7d +11.5"); "change_7d":0.02 in its JSON;
// "24h change at +1.08%"; "from $5.70T to $5.77T". A minus sign alone shows no change,
// since a level below zero is written with one too (a yield curve at -0.12%), nor does a
// correlation's (+0.26), nor a period with no figure ("7-day and 30-day trend signals"),
// nor a tenor ("10Y - 2Y" is a spread, not a change). A figure over a period may be in
// percent, points or basis points: a rate's "-25bp over 30d".
const UNIT_SAID = String.raw`\s*${MOVE_UNIT}?`;
const CHANGE: RegExp[] = [
  /[▲▼]/,
  new RegExp(String.raw`\d${UNIT_SAID}\s+over\s+(?:the\s+)?(?:past\s+|last\s+)?\d+\s*(?:d|h|w|days?|hours?|weeks?|months?)\b`, 'i'),
  /\b\d+\s*(?:d|h|w)\s+[+\-−]\s?[$€£¥]?\d/i,
  PLUS,
  /\bchange(?:[sd]|_\w+)?"?\s*[:=]?\s*(?:(?:of|at|by|was|is)\s+)?[+\-−]?[$€£¥]?\d/i,
  /\bfrom\s+(?:the\s+)?[^\s,;]+\s+to\s+(?:the\s+)?[^\s,;]+/i,
];

// A line backs a direction when it states one itself, or states a change. A line that gives
// only a level, such as "**Latest reading:** 0.42%", backs none.
export function backsDirection(line: string): boolean {
  return directionsIn(line).length > 0 || CHANGE.some((re) => re.test(line));
}

// A window as one name: "7d" for 7d, "7 days", "7-day" or a week; "30d" for a month; "24h".
function windowName(n: string, unit: string): string {
  const u = unit.toLowerCase();
  if (u.startsWith('h')) return `${n}h`;
  if (u.startsWith('w')) return `${Number(n) * 7}d`;
  if (u.startsWith('mo')) return `${Number(n) * 30}d`;
  return `${n}d`;
}

// The changes a line gives over its windows, each with its sign: "7d +1.2%" a rise and "30d
// -2.6%" a fall, "-1.3% over 7 days" a fall, "up 10.6% over 7d" a rise, JSON's "change_30d":
// -34.04 a fall. A minus beside a period is a fall; a minus with no period may be a level.
const UNIT = String.raw`(d|h|w|days?|hours?|weeks?|months?)\b`;
const OVER = String.raw`\s+over\s+(?:the\s+)?(?:past\s+|last\s+)?(\d+)\s*`;
const BY_WINDOW: Array<[RegExp, (m: RegExpMatchArray) => [string, Sign | null]]> = [
  [new RegExp(String.raw`([+\-−])\s?[$€£¥]?\d[\d.,]*${UNIT_SAID}${OVER}${UNIT}`, 'gi'), (m) => [windowName(m[2]!, m[3]!), m[1] === '+' ? 'rise' : 'fall']],
  [/\b(\d+)\s*(d|h|w)\s+([+\-−])\s?[$€£¥]?\d/gi, (m) => [windowName(m[1]!, m[2]!), m[3] === '+' ? 'rise' : 'fall']],
  [new RegExp(String.raw`\b(up|down)\s+[$€£¥]?\d[\d.,]*${UNIT_SAID}${OVER}${UNIT}`, 'gi'), (m) => [windowName(m[2]!, m[3]!), m[1]!.toLowerCase() === 'up' ? 'rise' : 'fall']],
  [/"change_(\d+)(d|h|w)"\s*:\s*(-?)(\d+(?:\.\d+)?)/gi, (m) => [windowName(m[1]!, m[2]!), Number(m[4]) === 0 ? null : m[3] ? 'fall' : 'rise']],
];

function byWindow(line: string): Map<string, Set<Sign>> {
  const windows = new Map<string, Set<Sign>>();
  for (const [re, read] of BY_WINDOW) for (const m of line.matchAll(re)) {
    const [window, sign] = read(m);
    const signs = windows.get(window) ?? new Set<Sign>();
    if (sign) signs.add(sign);
    windows.set(window, signs);
  }
  return windows;
}

// The windows a line states a change over, each once: "7d" and "30d" in "SPY at $671.20; 7d
// +1.2%, 30d +2.6%." or in JSON's "change_7d" and "change_30d". One line is one series.
export function windowsIn(line: string): Set<string> {
  const windows = new Set(byWindow(line).keys());
  const flat = new RegExp(String.raw`\d${UNIT_SAID}${OVER}${UNIT}`, 'gi');
  for (const m of line.matchAll(flat)) windows.add(windowName(m[1]!, m[2]!));
  return windows;
}

// The window a sentence names, where it names one: "over 30 days", "30d", "this week".
function windowOf(text: string): string | null {
  const named = new Set<string>();
  for (const m of text.matchAll(/\b(\d+)\s*-?\s*(d|h|w|days?|hours?|weeks?|months?)\b/gi)) named.add(windowName(m[1]!, m[2]!));
  for (const m of text.matchAll(/\b(?:this|past|last)\s+(week|month)\b/gi)) named.add(windowName('1', m[1]!));
  return named.size === 1 ? [...named][0]! : null;
}

const one = (signs: Set<Sign>): Sign | null => (signs.size === 1 ? [...signs][0]! : null);

// The sign of the change a line states, where it shows one: ▲, ▼, a figure with a plus sign
// or with a sign beside its period, or a signed direction word. A minus with no period shows
// none, since it may be a level. A line that shows both signs, as "7d +1.2%, 30d -2.6%" does,
// gives no sign, and a change there is enough.
export function signOf(line: string): Sign | null {
  const signs = new Set<Sign>();
  if (line.includes('▲') || PLUS.test(line)) signs.add('rise');
  if (line.includes('▼')) signs.add('fall');
  for (const word of directionsIn(line)) {
    const sign = signOfWord(word);
    if (sign) signs.add(sign);
  }
  for (const window of byWindow(line).values()) for (const sign of window) signs.add(sign);
  return one(signs);
}

// The sign a line gives a sentence: where the sentence names its window and the line states
// that window's change, the sign of that change ("fell 2.6% over 30 days" against "30d
// -2.6%"); otherwise the line's own.
function signFor(line: string, window: string | null): Sign | null {
  const of = window ? byWindow(line).get(window) : undefined;
  return of?.size ? one(of) : signOf(line);
}

// What a line says of the change of a change: "Accelerating" sped up, "Decelerating" slowed.
function speedOf(line: string): Speed | null {
  const speeds = new Set(directionsIn(line).map((w) => SPEED[w]).filter((s): s is Speed => Boolean(s)));
  return speeds.size === 1 ? [...speeds][0]! : null;
}

// A digest's change is backed by its diff item too, where code found a move from one state
// to another: the item is the change, computed before the model was asked.
function movedItems(packet: Packet): Set<string> {
  return new Set(itemsOf(packet.blocks.find((b) => b.id === 'diff')).filter((i) => i.from !== null && i.to !== null).map((i) => i.id));
}

const itemOf = (response: unknown, i: number): string | null => {
  const changes = (response as { changes?: unknown } | null)?.changes;
  const item = Array.isArray(changes) ? (changes[i] as { item?: unknown } | null)?.item : undefined;
  return item === undefined || item === null ? null : String(item);
};

const quoted = (words: string[]): string => words.map((w) => `"${w}"`).join(', ');

// The values the cited lines give: each cited line, once, that holds a figure and is not a
// heading, whose numbers name the thing ("# 10-Year Treasury Yield") rather than give a value.
function valuesCited(packet: Packet, citations: Citation[]): number {
  const lines = new Set<string>();
  for (const c of citations) {
    const line = citedLine(packet, c.block, c.line);
    if (line !== null && !line.trimStart().startsWith('#') && figuresIn(line).length) lines.add(`${c.block} L${c.line}`);
  }
  return lines.size;
}

// Why the lines do not hold a word: they state no change; the change they state is the
// other way; or, for the change of a change, they state none over two windows, or say it
// went the other way.
type Why = 'change' | 'rise' | 'fall' | 'windows' | 'accelerating' | 'decelerating';

interface Cited {
  lines: string[];
  moved: boolean; // a digest change whose diff item is a move
  values: number;
}

function cited(packet: Packet, citations: Citation[], moved: boolean): Cited {
  const lines = citations.map((c) => citedLine(packet, c.block, c.line)).filter((l): l is string => l !== null);
  return { lines, moved, values: valuesCited(packet, citations) };
}

// The direction words a sentence says that its lines do not hold, each with why.
function unheld(text: string, by: Cited): Array<{ word: string; why: Why }> {
  const out: Array<{ word: string; why: Why }> = [];
  const changes = by.lines.filter(backsDirection);
  const changed = changes.length > 0 || by.moved;
  const window = windowOf(text);
  for (const word of directionsIn(text)) {
    if (by.values >= 2 && COMPARATIVES.includes(word)) continue;
    if (negated(text, word)) {
      if (!changed) out.push({ word, why: 'change' });
      continue;
    }
    const speed = SPEED[word];
    if (speed) {
      if (by.lines.some((l) => { const s = speedOf(l); return s === speed || (s === null && windowsIn(l).size >= 2); })) continue;
      const against = by.lines.some((l) => speedOf(l) !== null);
      out.push({ word, why: against ? (speed === 'up' ? 'decelerating' : 'accelerating') : 'windows' });
      continue;
    }
    if (!changed) {
      out.push({ word, why: 'change' });
      continue;
    }
    // A change is enough where the word's sign is not fixed, or where no cited change gives
    // the other sign; a word every cited change runs against fails. A digest item's move is
    // enough for a word alone, not for a move said with its line's figure.
    const sign = signOfWord(word);
    if (!sign || (by.moved && !figured(text, word))) continue;
    const other: Sign = sign === 'rise' ? 'fall' : 'rise';
    if (changes.length && changes.every((l) => signFor(l, window) === other)) out.push({ word, why: other });
  }
  return out;
}

const NOTE: Record<Why, (comparative: boolean) => string> = {
  change: (comparative) => `none of them states a change${comparative ? ', and they do not give both values compared' : ''}`,
  rise: () => 'the change they state is a rise',
  fall: () => 'the change they state is a fall',
  windows: () => 'none of them states a change over two windows',
  accelerating: () => 'the change they state is accelerating',
  decelerating: () => 'the change they state is decelerating',
};
const WHYS: Why[] = ['change', 'rise', 'fall', 'windows', 'accelerating', 'decelerating'];

// A claim that says which way a thing moved cites a line that states a change the same way,
// or, for higher or lower, the lines that give both values; a claim that says a change itself
// sped up or slowed cites its change over two windows, or a line that says so. The answer says
// no direction its claims' lines do not hold. A level alone holds no direction.
export const groundedDirectionsCheck: Check = {
  id: 'grounded_directions',
  run(packet, response): CheckFailure[] {
    const failures: CheckFailure[] = [];
    const moved = movedItems(packet);
    const every: Citation[] = [];
    let anyMoved = false;
    claimsOf(response).forEach((claim, i) => {
      const item = itemOf(response, i);
      const isMoved = item !== null && moved.has(item);
      anyMoved ||= isMoved;
      every.push(...claim.citations);
      const words = unheld(claim.text, cited(packet, claim.citations, isMoved));
      for (const why of WHYS) {
        const these = words.filter((w) => w.why === why).map((w) => w.word);
        if (!these.length) continue;
        const note = NOTE[why](these.some((w) => COMPARATIVES.includes(w)));
        failures.push({ check: 'grounded_directions', claim: i, message: `${quoted(these)} ${these.length === 1 ? 'is a direction' : 'are directions'} the lines this claim cites do not hold: ${note}` });
      }
    });
    const said = unheld(answerOf(response), cited(packet, every, anyMoved)).map((w) => w.word);
    if (said.length) failures.push({ check: 'grounded_directions', message: `the answer states ${quoted(said)}, a direction no cited line holds` });
    return failures;
  },
};
