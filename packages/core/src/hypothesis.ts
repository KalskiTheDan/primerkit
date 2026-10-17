import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { companyBriefing } from './company';
import type { Routine } from './routine';

// A routine's hypothesis card: what the person expects, why, what would show it, and the
// numbers that count as passing or failing, in their own words in hypothesis.md, written
// before any result. primerkit ships none, and the model never writes one or fills a field
// in. The card freezes at the routine's first backtest: it is hashed into the run, and a
// change after that is a new version, every version kept in the routine's hypotheses folder.

export const HYPOTHESIS_FILE = 'hypothesis.md';
export const CARD_FIELDS = ['claim', 'mechanism', 'signature', 'universe', 'success', 'kill'] as const;
export type CardField = (typeof CARD_FIELDS)[number];

// Each field's heading in the file, and the shorter ones a person may write instead.
const HEADINGS: Record<CardField, string[]> = {
  claim: ['claim'],
  mechanism: ['mechanism'],
  signature: ['expected signature', 'signature'],
  universe: ['universe and horizon', 'universe'],
  success: ['success criterion', 'success'],
  kill: ['kill criterion', 'kill'],
};

export interface Card {
  fields: Record<CardField, string | null>; // null while the field holds nothing of the person's
  lines: string[]; // the card as hashed: comments, placeholders and empty lines taken out
  hash: string;
}

// A line the template writes for the person to replace, such as <why you expect it>.
const PLACEHOLDER = /^<[^<>]*>$/;

// The card as written. An HTML comment is not part of it, and nor is a placeholder line. Nor
// is a byte-order mark, as PowerShell 5.1 writes one, or a CRLF ending: the same words are
// the same card, whatever saved them.
export function parseCard(text: string): Card {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => /[\p{L}\p{N}]/u.test(l) && !PLACEHOLDER.test(l.trim()));
  const fields = Object.fromEntries(CARD_FIELDS.map((f) => [f, null])) as Card['fields'];
  let field: CardField | null = null;
  const words: Partial<Record<CardField, string[]>> = {};
  for (const line of lines) {
    const heading = /^#{1,6}\s*(.*?)\s*#*$/.exec(line.trim());
    if (heading) {
      const name = (heading[1] as string).toLowerCase().replace(/:$/, '');
      field = CARD_FIELDS.find((f) => HEADINGS[f].includes(name)) ?? null;
      continue;
    }
    if (field) (words[field] ??= []).push(line.trim());
  }
  for (const f of CARD_FIELDS) if (words[f]?.length) fields[f] = (words[f] as string[]).join(' ');
  return { fields, lines, hash: createHash('sha256').update(lines.join('\n')).digest('hex') };
}

// Whether the person has written anything in the card at all.
export const cardStated = (card: Card): boolean => CARD_FIELDS.some((f) => card.fields[f] !== null);

// The card in a routine's folder, or null while there is no hypothesis.md.
export function readCard(routine: Pick<Routine, 'dir'>): { path: string; text: string; card: Card } | null {
  const path = join(routine.dir, HYPOTHESIS_FILE);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return { path, text, card: parseCard(text) };
}

// The file a new routine starts with: every field a placeholder, and no example, since the
// card is the person's own.
export function hypothesisTemplate(name: string): string {
  return `<!--
Your hypothesis for ${name}, in your own words, written before any backtest. primerkit ships
none, and the model never writes one or fills a field in.

The card freezes at the routine's first backtest: it is hashed into the run, and a change
after that makes a new version, with every older version and its results kept.

Write each field in place of its <...> line. Nothing inside a comment is part of the card.
-->

## Claim
<what you expect to happen>

## Mechanism
<why you expect it>

## Expected signature
<what would be seen if it is true, and what would show it false>

## Universe and horizon
<the symbol, and how long a position is kept>

## Success criterion
<!-- The research view reads one number here: how many percentage points treatment must
return above control over a backtest to count as passing. -->
<your criterion, with its number>

## Kill criterion
<your criterion, with its number>
`;
}

// ------------------------------------------------------------------ versions

export interface CardStamp {
  version: number;
  hash: string;
  frozenAt: string; // when the version's first backtest started
}

export interface CardVersion extends CardStamp {
  runId: string; // the backtest that froze it
}

export const hypothesesDir = (dir: string): string => join(dir, 'hypotheses');

// Every version of a routine's card, oldest first. A line half written, as a run stopped
// mid write could leave, is left out.
export function readVersions(dir: string): CardVersion[] {
  const path = join(hypothesesDir(dir), 'versions.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l): CardVersion[] => {
      try {
        return [JSON.parse(l) as CardVersion];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.version - b.version);
}

// A version's card as it was frozen, or null where its file is not there.
export function frozenCard(dir: string, version: number): Card | null {
  const path = join(hypothesesDir(dir), `v${version}.md`);
  return existsSync(path) ? parseCard(readFileSync(path, 'utf8')) : null;
}

// Freezes the card a backtest starts with: the version whose hash it has, or a new version
// with its text kept as written. Null while there is no card, or nothing written in it. A
// frozen version's file is never written again.
export function freezeCard(routine: Pick<Routine, 'dir'>, runId: string, now: Date): CardStamp | null {
  const read = readCard(routine);
  if (!read || !cardStated(read.card)) return null;
  const versions = readVersions(routine.dir);
  const found = versions.find((v) => v.hash === read.card.hash);
  if (found) return { version: found.version, hash: found.hash, frozenAt: found.frozenAt };
  const dir = hypothesesDir(routine.dir);
  mkdirSync(dir, { recursive: true });
  // A file whose version line never got written still takes its number.
  const files = readdirSync(dir).flatMap((f) => {
    const n = /^v(\d+)\.md$/.exec(f)?.[1];
    return n ? [Number(n)] : [];
  });
  const version = Math.max(0, ...versions.map((v) => v.version), ...files) + 1;
  const stamp: CardVersion = { version, hash: read.card.hash, frozenAt: now.toISOString(), runId };
  writeFileSync(join(dir, `v${version}.md`), read.text, { flag: 'wx' });
  appendFileSync(join(dir, 'versions.jsonl'), `${JSON.stringify(stamp)}\n`);
  return { version, hash: stamp.hash, frozenAt: stamp.frozenAt };
}

// ------------------------------------------------------------------ the form check

// The form check, in code: per field, only whether it is stated, whether a criterion is a
// number, and whether the signature names a series the routine reads. It never rates a
// field, never suggests a mechanism, a threshold, a symbol or a horizon, and never
// rewrites a field.
export type FormStatus =
  | { field: CardField; status: 'missing' | 'stated' }
  | { field: 'success' | 'kill'; status: 'numeric' | 'not numeric' | 'more than one number' }
  | { field: 'signature'; status: 'observable' | 'not observable'; series: string[] };

// The numbers a field holds, as written: "2.5%" is 2.5, "1,000" is 1000.
export function cardNumbers(text: string): number[] {
  return [...text.matchAll(/[-+−]?\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '').replace('−', '-'))).filter((n) => Number.isFinite(n));
}

// The series a text names: a briefing id, such as macro.liquidity, or Bitcoin's price,
// which every routine reads. A web address is not a series.
const ID = /\b[a-z][a-z0-9]+\.[a-z0-9][a-z0-9-]*(?:\/[a-z0-9.-]+)?/g;
const NOT_A_SERIES = /\.(?:com|org|net|io|ai|md|yaml|json)$/;
const PRICE = /\b(?:bitcoin-price|bitcoin|btc|prices?)\b/i;
export const PRICE_SERIES = 'bitcoin-price';

export function seriesIn(text: string): string[] {
  const lower = text.toLowerCase();
  const ids = [...lower.matchAll(ID)].map((m) => m[0].replace(/[.-]+$/, '')).filter((id) => !NOT_A_SERIES.test(id) && (/^[a-z]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(id) || companyBriefing(id) !== null));
  // The price is named in words, apart from an id that holds them, such as btc.context.
  const price = PRICE.test(lower.replace(ID, ' '));
  return [...new Set([...ids, ...(price ? [PRICE_SERIES] : [])])];
}

// reads: the briefings the routine reads; Bitcoin's price is read by every routine.
export function formCheck(card: Card, reads: string[]): FormStatus[] {
  const readable = new Set([...reads, PRICE_SERIES]);
  return CARD_FIELDS.map((field): FormStatus => {
    const text = card.fields[field];
    if (text === null) return { field, status: 'missing' };
    if (field === 'success' || field === 'kill') {
      const n = cardNumbers(text).length;
      return { field, status: n === 1 ? 'numeric' : n === 0 ? 'not numeric' : 'more than one number' };
    }
    if (field === 'signature') {
      const named = seriesIn(text);
      const unread = named.filter((s) => !readable.has(s));
      if (unread.length) return { field, status: 'not observable', series: unread };
      return named.length ? { field, status: 'observable', series: named } : { field, status: 'not observable', series: [] };
    }
    return { field, status: 'stated' };
  });
}

// What a missing field holds, so the person knows what to write there: the field's role,
// never content for it.
const MISSING: Record<CardField, string> = {
  claim: 'write what you expect to happen',
  mechanism: 'write why you expect it',
  signature: 'write what would be seen if it is true',
  universe: 'write the symbol and how long a position is kept',
  success: 'write the number that would count as passing',
  kill: 'write the number that would count as failing',
};

export const andList = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// A status in words: every one is a fixed phrase, with only the series the signature
// names put in.
export function formWords(s: FormStatus): string {
  if (s.status === 'missing') return `${s.field} missing: ${MISSING[s.field]}`;
  if ('series' in s) {
    if (s.status === 'observable') return `signature observable in ${andList(s.series)}`;
    return s.series.length ? `signature not observable in your routine's data: it needs ${andList(s.series)}` : 'signature names no series your routine reads';
  }
  if (s.status === 'more than one number') return `${s.field} has more than one number`;
  return `${s.field} ${s.status}`;
}

// The one number the success criterion gives, in percentage points, or why there is none.
export function successPoints(card: Card): { points: number } | { why: string } {
  const text = card.fields.success;
  if (text === null) return { why: 'your card has no success criterion' };
  const numbers = cardNumbers(text);
  if (numbers.length === 1) return { points: numbers[0] as number };
  return { why: numbers.length ? 'your success criterion has more than one number' : 'your success criterion has no number' };
}
