import { createHash } from 'node:crypto';
import { tokenCount, TOKENIZER_LABEL } from './packet';
import type { Packet, PacketFormat } from './types';

// The comprehension benchmark's questions and scoring, as PreReason's comprehension
// benchmark defines them: fixed questions with a key, answered from one briefing,
// scored by code with no model judging. The fitness check reads a slice of it.

export type QuestionKind = 'number' | 'integer' | 'date' | 'yesno' | 'choice';

export interface BenchQuestion {
  id: string; // "q01"
  type: string; // "latest_value", "change", ...
  kind: QuestionKind;
  group: 'core' | 'derived';
  text: string;
  unit: string | null;
  options: string[] | null;
  key: { answer: unknown; tolerance: { abs: number; rel: number } | null; accept: string[] | null };
}

export interface BenchBriefing {
  briefing: string;
  reference_time: string;
  questions: BenchQuestion[];
}

export interface BenchFile {
  source: string;
  briefings: BenchBriefing[];
}

export type AnswerStatus = 'correct' | 'wrong' | 'missing' | 'unreadable';

export function numberCorrect(given: number, key: number, tolerance: { abs: number; rel: number }): boolean {
  return Math.abs(given - key) <= Math.max(tolerance.abs, tolerance.rel * Math.abs(key)) + 1e-12;
}

// A number from a JSON number or a string. Symbols, separators and trailing units are
// dropped, and a magnitude letter is not applied: the question names the unit.
export function readNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/−/g, '-').replace(/^~/, '');
  const m = /^([+-])?\s*[~$¥€]?\s*([+-])?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE]([+-]?\d+))?/.exec(s);
  if (!m?.[3]) return null;
  const sign = m[1] === '-' || m[2] === '-' ? -1 : 1;
  const n = Number(m[3].replace(/,/g, '')) * (m[4] ? Math.pow(10, Number(m[4])) : 1);
  return Number.isFinite(n) ? sign * n : null;
}

export function readDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  if (v.includes('T') && /[zZ]|[+-]\d{2}:?\d{2}$/.test(v.trim())) {
    const ms = Date.parse(v.trim());
    if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function readYesNo(v: unknown): 'yes' | 'no' | null {
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[.!]$/, '');
  if (['yes', 'y', 'true'].includes(s)) return 'yes';
  if (['no', 'n', 'false'].includes(s)) return 'no';
  return null;
}

const squash = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// The option a choice answer names: by the option text, its key or its display name.
export function readChoice(v: unknown, question: BenchQuestion): string | null {
  if (typeof v !== 'string' || !question.options) return null;
  const given = squash(v);
  if (!given) return null;
  for (const opt of question.options) {
    const spellings = [opt];
    const paren = /\(([^()]+)\)\s*$/.exec(opt);
    if (paren?.[1]) spellings.push(paren[1], opt.slice(0, paren.index).trim());
    if (spellings.some((s) => squash(s) === given)) return opt;
  }
  if (question.key.accept?.some((s) => squash(s) === given)) return String(question.key.answer);
  return null;
}

export function scoreAnswer(question: BenchQuestion, value: unknown): AnswerStatus {
  if (value === undefined || value === null || value === '') return 'missing';
  const key = question.key.answer;
  switch (question.kind) {
    case 'number': {
      const n = readNumber(value);
      if (n === null) return 'unreadable';
      return question.key.tolerance && typeof key === 'number' && numberCorrect(n, key, question.key.tolerance) ? 'correct' : 'wrong';
    }
    case 'integer': {
      const n = readNumber(value);
      if (n === null) return 'unreadable';
      return Number.isInteger(n) && n === key ? 'correct' : 'wrong';
    }
    case 'date': {
      const d = readDate(value);
      if (d === null) return 'unreadable';
      return d === key ? 'correct' : 'wrong';
    }
    case 'yesno': {
      const y = readYesNo(value);
      if (y === null) return 'unreadable';
      return y === key ? 'correct' : 'wrong';
    }
    case 'choice': {
      const c = readChoice(value, question);
      if (c === null) return 'unreadable';
      return c === key ? 'correct' : 'wrong';
    }
  }
}

function questionLine(q: BenchQuestion): string {
  const kind =
    q.kind === 'number' ? `number; unit: ${q.unit}` : q.kind === 'integer' ? 'whole number' : q.kind === 'date' ? 'date as YYYY-MM-DD' : q.kind === 'yesno' ? 'yes or no' : 'choice';
  return `${q.id} [${kind}] ${q.text}${q.options ? ` Options: ${q.options.join('; ')}.` : ''}`;
}

function answerSchema(q: BenchQuestion): Record<string, unknown> {
  if (q.kind === 'number') return { type: 'number' };
  if (q.kind === 'integer') return { type: 'integer' };
  if (q.kind === 'yesno') return { type: 'string', enum: ['yes', 'no'] };
  if (q.kind === 'choice' && q.options) return { type: 'string', enum: q.options };
  return { type: 'string' };
}

// The arms a packet can take: the briefing as markdown, as JSON, or no data at all, which
// measures what the model knows without reading anything.
export type BenchArm = PacketFormat | 'none';

// One reading test packet, in the benchmark's own words, carried as a Packet so any
// model adapter can send it.
export function benchPacket(b: BenchBriefing, questions: BenchQuestion[], arm: BenchArm, data: string, runId: string): Packet {
  const lines = [
    'READING COMPREHENSION PACKET',
    'You are answering questions about financial data. This is a reading test: no trading, advice or forecast is asked for.',
    '',
    'RULES',
    arm === 'none'
      ? '1. There is no DATA section. Answer from your own general knowledge, and give your best estimate for every question.'
      : '1. Answer only from the DATA section below. Do not use outside knowledge.',
    '2. After reading this packet, use no tools and read no other file. Work it out in your head.',
    '3. Answer every question. If you are unsure, give your best answer.',
    '4. Reply with ONLY one JSON object and nothing else, in this form:',
    '   {"answers": {"q01": <answer>, "q02": <answer>}}',
    '   A number is a plain JSON number in the unit the question names, with no symbols, units or thousands separators.',
    '   A date is "YYYY-MM-DD". A choice is one option, copied exactly. Yes or no is "yes" or "no".',
    ...(arm === 'none' ? [] : ['', 'DATA', '<<<', data.replace(/\r\n/g, '\n').replace(/\n+$/, ''), '>>>']),
    '',
    'QUESTIONS',
    `Reference time (when the data was generated): ${b.reference_time.slice(0, 10)} ${b.reference_time.slice(11, 16)} UTC.`,
    ...questions.map(questionLine),
  ];
  const text = `${lines.join('\n')}\n`;
  const schema = {
    type: 'object',
    required: ['answers'],
    additionalProperties: false,
    properties: {
      answers: {
        type: 'object',
        required: questions.map((q) => q.id),
        additionalProperties: false,
        properties: Object.fromEntries(questions.map((q) => [q.id, answerSchema(q)])),
      },
    },
  };
  return {
    runId,
    operation: { id: 'bench-comprehension', version: '2026-09-25' },
    question: `${b.briefing} reading test, ${arm}`,
    primer: '',
    blocks: [],
    schema,
    notes: [],
    text,
    hash: createHash('sha256').update(text).digest('hex'),
    tokens: { label: TOKENIZER_LABEL, count: tokenCount(text) },
  };
}

// The answers a reply holds, read as the benchmark reads them: code fences taken off,
// and the outermost braces tried when prose surrounds the object.
export function answersOf(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const shape = (v: unknown) => {
    const answers = (v as { answers?: unknown } | null)?.answers;
    return answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : null;
  };
  try {
    return shape(JSON.parse(trimmed));
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try {
      return shape(JSON.parse(trimmed.slice(first, last + 1)));
    } catch {
      return null;
    }
  }
}
