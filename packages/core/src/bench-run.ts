import { answersOf, benchPacket, scoreAnswer, type AnswerStatus, type BenchArm, type BenchFile, type BenchQuestion } from './bench';
import type { Journal } from './journal';
import { newRunId } from './packet';
import type { ModelAdapter, Packet, PacketFormat } from './types';

// The benchmark on the person's own model: each briefing of the frozen fixtures in each
// arm, a few runs each, scored by code with no model judging. It reports what
// PreReason's benchmark reports: the share of right answers, the tokens a packet costs,
// and right answers per 1,000 tokens.

export const BENCH_ARMS: readonly BenchArm[] = ['markdown', 'json', 'none'];
export const BENCH_RUNS = 3;

export interface BenchItem {
  key: string; // "btc.pulse__markdown__r1"
  briefing: string;
  arm: BenchArm;
  run: number;
  questions: BenchQuestion[];
  packet: Packet;
}

export interface BenchRecord {
  key: string;
  briefing: string;
  arm: BenchArm;
  run: number;
  correct: number;
  total: number;
  tokens: number;
  answered: boolean; // the reply held an answers object
  statuses: Record<string, AnswerStatus>;
  seconds: number | null;
}

export interface BenchArmResult {
  arm: BenchArm;
  correct: number;
  total: number;
  accuracy: number | null; // pooled over briefings and runs
  tokens: number | null; // the median packet, in tokens
  perThousand: number | null; // the median over briefings of accuracy per 1,000 tokens
}

export interface BenchResult {
  model: string;
  fixtures: string; // the fixture date
  briefings: string[];
  arms: BenchArmResult[];
  runs: number;
  answers: number;
  seconds: number;
  best: BenchArm | null; // the data arm with the most right answers per 1,000 tokens
  checkedAt: string;
}

// The packets, run by run: every briefing and arm once, then again, so a benchmark
// stopped part way still covers each arm evenly.
export function benchItems(
  file: BenchFile,
  data: (briefing: string, format: PacketFormat) => string,
  options: { arms?: readonly BenchArm[]; runs?: number; briefings?: string[] } = {},
): BenchItem[] {
  const briefings = file.briefings.filter((b) => !options.briefings || options.briefings.includes(b.briefing));
  const arms = options.arms ?? BENCH_ARMS;
  const packets = new Map<string, Packet>();
  const items: BenchItem[] = [];
  for (let run = 1; run <= (options.runs ?? BENCH_RUNS); run += 1) {
    for (const b of briefings) {
      for (const arm of arms) {
        const id = `${b.briefing}__${arm}`;
        const packet = packets.get(id) ?? benchPacket(b, b.questions, arm, arm === 'none' ? '' : data(b.briefing, arm), id);
        packets.set(id, packet);
        items.push({ key: `${id}__r${run}`, briefing: b.briefing, arm, run, questions: b.questions, packet });
      }
    }
  }
  return items;
}

export function recordAnswer(item: BenchItem, text: string, seconds: number | null = null): BenchRecord {
  const answers = answersOf(text);
  const statuses: Record<string, AnswerStatus> = {};
  for (const q of item.questions) statuses[q.id] = answers ? scoreAnswer(q, answers[q.id]) : 'missing';
  return {
    key: item.key,
    briefing: item.briefing,
    arm: item.arm,
    run: item.run,
    correct: Object.values(statuses).filter((s) => s === 'correct').length,
    total: item.questions.length,
    tokens: item.packet.tokens.count,
    answered: answers !== null,
    statuses,
    seconds,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeBench(records: BenchRecord[], meta: { model: string; fixtures: string; arms?: readonly BenchArm[]; now?: Date }): BenchResult {
  const arms = (meta.arms ?? BENCH_ARMS).filter((arm) => records.some((r) => r.arm === arm));
  const results: BenchArmResult[] = arms.map((arm) => {
    const mine = records.filter((r) => r.arm === arm);
    const correct = mine.reduce((s, r) => s + r.correct, 0);
    const total = mine.reduce((s, r) => s + r.total, 0);
    const perBriefing = [...new Set(mine.map((r) => r.briefing))].map((briefing) => {
      const runs = mine.filter((r) => r.briefing === briefing);
      const accuracy = runs.reduce((s, r) => s + r.correct / r.total, 0) / runs.length;
      const tokens = runs[0]!.tokens;
      return { tokens, perThousand: tokens > 0 ? accuracy / (tokens / 1000) : 0 };
    });
    return {
      arm,
      correct,
      total,
      accuracy: total ? correct / total : null,
      tokens: median(perBriefing.map((b) => b.tokens)),
      perThousand: median(perBriefing.map((b) => b.perThousand)),
    };
  });
  // The best arm is one that gave more right answers per 1,000 tokens than every other:
  // none where no arm with data gave a right answer, or where two gave as many.
  const data = results.filter((r) => r.arm !== 'none' && r.perThousand !== null);
  const top = Math.max(0, ...data.map((r) => r.perThousand ?? 0));
  const leaders = data.filter((r) => (r.perThousand ?? 0) === top);
  const best = top > 0 && leaders.length === 1 ? (leaders[0] as BenchArmResult).arm : null;
  return {
    model: meta.model,
    fixtures: meta.fixtures,
    briefings: [...new Set(records.map((r) => r.briefing))],
    arms: results,
    runs: Math.max(0, ...records.map((r) => r.run)),
    answers: records.length,
    seconds: Math.round(records.reduce((s, r) => s + (r.seconds ?? 0), 0)),
    best,
    checkedAt: (meta.now ?? new Date()).toISOString(),
  };
}

export interface BenchProgress {
  done: number;
  total: number;
  item: BenchItem;
}

// Path A: one fresh call per packet. A reply that is not the answers object scores its
// questions as missing, as in PreReason's benchmark. A call that fails (the model not
// answering at all) stops the run, since it says nothing about reading; a stop keeps
// what was answered.
export async function runBench(
  model: ModelAdapter,
  items: BenchItem[],
  options: { onStep?: (p: BenchProgress) => void; signal?: AbortSignal } = {},
): Promise<{ records: BenchRecord[]; replies: Map<string, string>; stopped: string | null }> {
  const records: BenchRecord[] = [];
  const replies = new Map<string, string>();
  for (const [i, item] of items.entries()) {
    if (options.signal?.aborted) return { records, replies, stopped: 'stopped' };
    options.onStep?.({ done: i, total: items.length, item });
    const started = Date.now();
    let text: string;
    try {
      text = (await model.complete(item.packet, undefined, options.signal)).text;
    } catch (error) {
      return { records, replies, stopped: options.signal?.aborted ? 'stopped' : (error as Error).message };
    }
    replies.set(item.key, text);
    records.push(recordAnswer(item, text, (Date.now() - started) / 1000));
  }
  return { records, replies, stopped: null };
}

const ARM_NAMES: Record<BenchArm, string> = { markdown: 'markdown', json: 'JSON', none: 'none' };
const pct = (n: number | null) => (n === null ? '  n/a' : `${Math.round(n * 100)}%`.padStart(5));
const minutes = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

// What the benchmark found between the arms with data, in one sentence.
export function bestLine(r: BenchResult): string {
  if (r.best) return `Per 1,000 tokens, ${ARM_NAMES[r.best]} gave this model the most right answers.`;
  const data = r.arms.filter((a) => a.arm !== 'none' && a.perThousand !== null);
  if (!data.length) return 'No arm with data was answered.';
  const top = Math.max(0, ...data.map((a) => a.perThousand ?? 0));
  if (top <= 0) return 'No arm with data gave this model a right answer.';
  const tied = data.filter((a) => a.perThousand === top).map((a) => ARM_NAMES[a.arm]);
  return `Per 1,000 tokens, ${tied.join(' and ')} gave this model as many right answers.`;
}

// The result as the session and the single command print it. `bar` draws a share of
// the widest bar.
export function benchLines(r: BenchResult, bar: (share: number) => string = (share) => '#'.repeat(Math.max(1, Math.round(share * 20)))): string[] {
  const top = Math.max(0, ...r.arms.filter((a) => a.arm !== 'none').map((a) => a.perThousand ?? 0));
  const rows = r.arms.map((a) => {
    const head = `${ARM_NAMES[a.arm].padEnd(10)} ${pct(a.accuracy)}  ${(a.tokens === null ? '' : Math.round(a.tokens).toLocaleString('en-US')).padStart(8)}    `;
    if (a.arm === 'none') return `${head}no data read`;
    return `${head}${top > 0 && a.perThousand ? bar(a.perThousand / top) : ''} ${(a.perThousand ?? 0).toFixed(2)}`;
  });
  const best = bestLine(r);
  return [
    `${r.briefings.length} ${r.briefings.length === 1 ? 'briefing' : 'briefings'} | ${r.arms.length} arms | ${r.runs} ${r.runs === 1 ? 'run' : 'runs'} each | ${r.answers} answers | ${minutes(r.seconds)}`,
    '',
    'arm         right    tokens    right answers per 1,000 tokens',
    ...rows,
    '',
    best,
    "PreReason's own run is published at prereason.com/evidence.",
  ];
}

// The benchmark in the journal: the result, every answer's score, and one copy of each
// packet (the runs of a briefing and arm share one).
export function keepBench(journal: Journal, result: BenchResult, records: BenchRecord[], items: BenchItem[], replies: Map<string, string>, now = new Date()): string {
  const runId = newRunId(now);
  const dir = journal.open('bench', runId, now);
  const packets = new Map(items.map((i) => [`${i.briefing}__${i.arm}`, i.packet.text]));
  for (const [id, text] of packets) dir.write(`packet.${id}.md`, text);
  dir.write('answers.json', records.map((r) => ({ ...r, reply: replies.get(r.key) ?? '' })));
  dir.write('result.json', result);
  dir.write('render.md', `${[`Benchmark  ${result.model} on the frozen fixtures of ${result.fixtures}`, ...benchLines(result)].join('\n')}\n`);
  return dir.dir;
}
