import { buildPacket } from './packet';
import { addDays, daysBetween, type Close } from './routine';
import type { DataBlock, ModelAdapter, Operation, Packet } from './types';

// Three guards against a model that already knows what happened in a backtest's window.
// A model may know any day before its training ends, and a backtest that replays such a
// day measures its memory as much as the data. None of the three removes the leak; each
// lowers it or says where it is, and every result says which applied.
//
//   the cutoff    a window after the model's training is out of sample; one inside it
//                 runs only on the person's yes, and says so everywhere
//   the memory    before the run, with no data, the model is asked three prices in the
//                 window; two within 5% mark the window as remembered (all of them, in a
//                 window too short for three)
//   the masking   dates in the packet are day numbers from the window's first day; a
//                 briefing counts from the day it stands for, stamped with that day, so
//                 the placebo's stale briefings read as current ones do

// ---------------------------------------------------------------- the cutoff

// How far a model's training reaches, and where that is written.
export interface ModelCutoff {
  cutoff: string; // YYYY-MM, the last month its training can reach
  source: string;
  basis: 'stated' | 'release' | 'person'; // the card says so; its release bounds it; the person said
}

// Known models, each from its own published source, read on the date given. A card that
// states no cutoff is bounded by the model's release: its training cannot reach later.
export const CUTOFFS: ReadonlyArray<{ match: RegExp; cutoff: string; source: string; basis: 'stated' | 'release' }> = [
  { match: /^claude-fable-5-1\b/, cutoff: '2026-06', source: "Anthropic's models overview, training data cutoff Jun 2026 (read 2026-09-28)", basis: 'stated' },
  { match: /^claude-opus-5-5\b/, cutoff: '2026-06', source: "Anthropic's models overview, training data cutoff Jun 2026 (read 2026-09-28)", basis: 'stated' },
  { match: /^claude-sonnet-5-5\b/, cutoff: '2026-06', source: "Anthropic's models overview, training data cutoff Jun 2026 (read 2026-09-28)", basis: 'stated' },
  { match: /^claude-haiku-4-5\b/, cutoff: '2025-07', source: "Anthropic's models overview, training data cutoff Jul 2025 (read 2026-09-28)", basis: 'stated' },
  { match: /^llama-?3\.1\b/i, cutoff: '2023-12', source: "Meta's Llama 3.1 model card: the pretraining data has a cutoff of December 2023 (read 2026-09-28)", basis: 'stated' },
  { match: /^qwen2\.5\b/i, cutoff: '2024-09', source: 'released September 2024 by its Hugging Face model card, which states no cutoff, so its training reaches September 2024 at the latest (read 2026-09-28)', basis: 'release' },
];

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// A model's cutoff: the one the person gave for it, else the table's, else not known.
export function cutoffOf(model: string, kept: Record<string, string> = {}): ModelCutoff | null {
  const name = model.trim();
  const given = kept[name];
  if (given && MONTH.test(given)) return { cutoff: given, source: 'given by you for this model', basis: 'person' };
  const known = CUTOFFS.find((c) => c.match.test(name));
  return known ? { cutoff: known.cutoff, source: known.source, basis: known.basis } : null;
}

export const isMonth = (value: string): boolean => MONTH.test(value);

// The last day a cutoff month holds.
export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Where a window stands against a model's training: after it, inside it, or not known.
export type Sample = { kind: 'out'; cutoff: ModelCutoff } | { kind: 'inside'; cutoff: ModelCutoff } | { kind: 'unknown' };

export function sampleOf(from: string, cutoff: ModelCutoff | null): Sample {
  if (!cutoff) return { kind: 'unknown' };
  return from > lastDayOf(cutoff.cutoff) ? { kind: 'out', cutoff } : { kind: 'inside', cutoff };
}

// ---------------------------------------------------------------- the memory check

export const MEMORY_TOLERANCE = 0.05;
export const MEMORY_NEEDED = 2;

// Three days spread over the window: its first, its middle and its last, whether or not
// a tick falls on them, so a weekly window is asked as much as a daily one.
export function memoryDates(from: string, to: string): string[] {
  const span = daysBetween(from, to);
  return span < 0 ? [] : [...new Set([from, addDays(from, Math.floor(span / 2)), to])];
}

const MEMORY_PRIMER = [
  'You answer from what you already know. No data comes with this question, and none is needed.',
  'Give the number you recall, or null when you do not know it. Guessing is not recalling: say null rather than guess.',
  'Return JSON that matches the schema, with nothing outside it.',
].join('\n');

const MEMORY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['price'],
  additionalProperties: false,
  properties: { price: { type: ['number', 'null'] } },
};

const MEMORY_OPERATION: Operation = {
  spec: {
    id: 'memory-check',
    version: '0.1.0',
    kind: 'research',
    title: 'What the model remembers of a window',
    inputs: [],
    data: { sources: [{ connector: 'file', path: 'none' }] },
    output: { schema: 'inline', forbiddenFields: [] },
    checks: [],
  },
  dir: '',
  primer: MEMORY_PRIMER,
  schema: MEMORY_SCHEMA,
  render: null,
};

// The question, with no data at all: the day's closing Bitcoin price.
export function memoryPacket(date: string): Packet {
  return buildPacket({ operation: MEMORY_OPERATION, question: `What was Bitcoin's closing price in US dollars on ${date}?`, blocks: [] });
}

export interface MemoryAnswer {
  date: string;
  truth: number;
  price: number | null; // what the model said, or null when it said it does not know
  within: boolean; // within 5% of the day's close
}

export interface MemoryCheck {
  answers: MemoryAnswer[];
  remembered: boolean; // two or more answers within 5%
}

// One answer, read defensively: anything but a number is "does not know".
export function judgeMemory(date: string, truth: number, text: string): MemoryAnswer {
  let price: number | null = null;
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as { price?: unknown };
    price = typeof value.price === 'number' && Number.isFinite(value.price) && value.price > 0 ? value.price : null;
  } catch {
    price = null;
  }
  return { date, truth, price, within: price !== null && Math.abs(price - truth) / truth <= MEMORY_TOLERANCE };
}

// Two within 5% mark the window remembered; a window too short for three questions
// needs every one it asked.
export function memoryVerdict(answers: MemoryAnswer[]): MemoryCheck {
  const needed = Math.min(MEMORY_NEEDED, answers.length);
  return { answers, remembered: answers.length > 0 && answers.filter((a) => a.within).length >= needed };
}

// The close on a day, from the run's price series.
export function closeOn(closes: Close[], date: string): number | null {
  return closes.find((c) => c.date === date)?.price ?? null;
}

// Asks a model this machine calls the three questions, one fresh call each.
export async function runMemoryCheck(model: ModelAdapter, from: string, to: string, closes: Close[], signal?: AbortSignal): Promise<MemoryCheck> {
  const answers: MemoryAnswer[] = [];
  for (const date of memoryDates(from, to)) {
    const truth = closeOn(closes, date);
    if (truth === null) continue;
    const reply = await model.complete(memoryPacket(date), undefined, signal);
    answers.push(judgeMemory(date, truth, reply.text));
  }
  return memoryVerdict(answers);
}

// ---------------------------------------------------------------- the masking

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORD = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const pad = (n: number): string => String(n).padStart(2, '0');
const monthIndex = (word: string): number => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;

// A date as a day number from the window's first day, which is day 1; earlier days are 0
// and below.
export const dayNumber = (origin: string, date: string): string => `day ${daysBetween(origin, date) + 1}`;

const ordinal = (n: number): string => {
  const tens = n % 100;
  const ones = n % 10;
  return `${n}${tens >= 11 && tens <= 13 ? 'th' : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th'}`;
};

// The dates in a line written as day numbers: ISO days and times, "Sep 25, 2026",
// "25 Sep 2026", and a month and year as the day number of its first day. A briefing's
// own "day 26", the length of a streak and not a date, is written "26th day" first, so a
// day number in a masked packet is always a date. Best effort: levels still hint at the
// period, so this lowers the leak and never removes it.
export function maskLine(line: string, origin: string): string {
  const day = (y: number, m: number, d: number): string => {
    const date = `${y}-${pad(m)}-${pad(d)}`;
    return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? date : dayNumber(origin, date);
  };
  return line
    .replace(/\b[Dd]ay (\d+)\b/g, (_m, n: string) => `${ordinal(Number(n))} day`)
    .replace(/\b(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, (_m, y: string, m: string, d: string) => day(Number(y), Number(m), Number(d)))
    .replace(new RegExp(`\\b${MONTH_WORD}\\.? (\\d{1,2}),? (\\d{4})\\b`, 'g'), (_m, w: string, d: string, y: string) => day(Number(y), monthIndex(w), Number(d)))
    .replace(new RegExp(`\\b(\\d{1,2}) ${MONTH_WORD}\\.? (\\d{4})\\b`, 'g'), (_m, d: string, w: string, y: string) => day(Number(y), monthIndex(w), Number(d)))
    .replace(new RegExp(`\\b${MONTH_WORD} (\\d{4})\\b`, 'g'), (_m, w: string, y: string) => `the month of ${day(Number(y), monthIndex(w), 1)}`);
}

// A dated read stamped with the day it stands for. PreReason builds a past day's briefing
// when it is asked for it, so its Generated line names the day of the read: in markdown the
// `*Generated:*` line, in JSON `generated_at` on the first line. Every other date in it is
// the data's own.
export function stampRead(block: DataBlock, day: string): DataBlock {
  const lines = block.lines.map((line) => {
    if (block.format === 'markdown') return /^\*Generated:\s*.+?\*$/.test(line.trim()) ? `*Generated: ${day}*` : line;
    if (!line.includes('"generated_at"')) return line;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      return 'generated_at' in value ? JSON.stringify({ ...value, generated_at: day }) : line;
    } catch {
      return line;
    }
  });
  return { ...block, lines, ...(block.generatedAt ? { generatedAt: day } : {}) };
}

// A block with its dates masked: its lines, and the time it was generated.
export function maskBlock(block: DataBlock, origin: string): DataBlock {
  return {
    ...block,
    lines: block.lines.map((l) => maskLine(l, origin)),
    ...(block.generatedAt ? { generatedAt: maskLine(block.generatedAt, origin) } : {}),
  };
}

