import {
  answersOf,
  benchPacket,
  citedLine,
  contextNeeded,
  newRunId,
  normalizeSpace,
  parseResponse,
  runOperation,
  schemaCheck,
  scoreAnswer,
  tokenCount,
  type BenchFile,
  type DataBlock,
  type Journal,
  type ModelAdapter,
  type Operation,
  type Packet,
  type PacketFormat,
} from '@primerkit/core';
import { ModelError } from './chat';

// The fitness check, run when a model is first chosen and on
// /model check. It asks four things, with the model's own answers:
//   answer shape: are the answers valid JSON of the right shape;
//   citations: do the quotes match the lines they cite;
//   reading: a slice of the comprehension benchmark in markdown and in JSON, which
//     proposes the packet format for this model;
//   speed: output tokens a second, so a digest's time can be said.
// The result is kept in the journal.

export type Verdict = 'fit for everything' | 'fit for ask and digest only' | 'not fit';

// The reading score, in the better format, that makes a model fit for everything
// rather than for ask and digest only.
export const FIT_FOR_EVERYTHING = 0.9;

// The slice: seven core questions on two free briefings.
export const SLICE = { briefings: ['btc.pulse', 'btc.context'], questions: ['q01', 'q02', 'q03', 'q04', 'q05', 'q06', 'q07'] };

export interface FitnessInput {
  model: ModelAdapter;
  ask: Operation;
  askBlock: Record<PacketFormat, DataBlock>; // one saved briefing in each format
  largest: Record<PacketFormat, DataBlock[]>; // the largest packet in use: three saved briefings
  bench: BenchFile;
  benchData: (briefing: string, format: PacketFormat) => string;
  journal?: Journal;
  signal?: AbortSignal;
  onStep?: (step: FitnessStep) => void;
  now?: () => Date;
}

export interface FitnessStep {
  name: 'shape' | 'citations' | 'reading' | 'context' | 'speed';
  done: boolean;
  text: string;
}

export interface FitnessResult {
  verdict: Verdict;
  reason: string;
  model: string;
  shape: { valid: number; total: number };
  citations: { matched: number; total: number };
  reading: Record<PacketFormat, { right: number; total: number }>;
  format: PacketFormat; // proposed for this model
  context: { limit: number | null; largest: number };
  speed: { tokensPerSecond: number | null; secondsPerCall: number | null };
  calls: number;
  checkedAt: string;
  journalDir?: string;
}

interface Reply {
  packet: Packet;
  text: string;
  seconds: number;
  outputTokens: number;
}

const pct = (r: { right: number; total: number }) => (r.total ? r.right / r.total : 0);
const QUESTION = 'Where does Bitcoin stand?';
// What the check's first step says while it runs: the question itself, so a person sees what
// the model is being asked, and on what.
export const FITNESS_ASKING = `asking "${QUESTION}" of a saved briefing`;

// Roughly what the check sends, so a hosted model's cost can be said before it runs.
export function fitnessPlan(input: Pick<FitnessInput, 'ask' | 'askBlock' | 'bench' | 'benchData'>, format: PacketFormat): { calls: number; tokens: number } {
  let tokens = contextNeeded(input.ask, QUESTION, [input.askBlock[format]], []).tokens;
  let calls = 1;
  for (const f of ['markdown', 'json'] as const) {
    for (const b of input.bench.briefings.filter((x) => SLICE.briefings.includes(x.briefing))) {
      const qs = b.questions.filter((q) => SLICE.questions.includes(q.id));
      tokens += benchPacket(b, qs, f, input.benchData(b.briefing, f), 'plan').tokens.count;
      calls += 1;
    }
  }
  return { calls, tokens };
}

export async function checkFitness(input: FitnessInput): Promise<FitnessResult> {
  const now = input.now ?? (() => new Date());
  const step = (s: FitnessStep) => input.onStep?.(s);
  const replies: Reply[] = [];
  const recorder: ModelAdapter = {
    id: input.model.id,
    label: input.model.label,
    capabilities: () => input.model.capabilities(),
    complete: async (packet, repair, signal) => {
      const t0 = Date.now();
      const reply = await input.model.complete(packet, repair, signal);
      replies.push({ packet, text: reply.text, seconds: (Date.now() - t0) / 1000, outputTokens: reply.usage?.outputTokens ?? tokenCount(reply.text) });
      return reply;
    },
  };
  const caps = await input.model.capabilities();
  const base = { model: input.model.label, checkedAt: now().toISOString() };
  const fail = (reason: string): FitnessResult => ({
    ...base,
    verdict: 'not fit',
    reason,
    shape: { valid: 0, total: replies.length },
    citations: { matched: 0, total: 0 },
    reading: { markdown: { right: 0, total: 0 }, json: { right: 0, total: 0 } },
    format: caps.format,
    context: { limit: caps.maxContextTokens ?? caps.contextTokens, largest: 0 },
    speed: { tokensPerSecond: null, secondsPerCall: null },
    calls: replies.length,
  });

  // 1. Shape and citations: one ask, with its repair turn, on a saved briefing.
  step({ name: 'shape', done: false, text: FITNESS_ASKING });
  let ask;
  try {
    ask = await runOperation({ operation: input.ask, question: QUESTION, blocks: [input.askBlock[caps.format]], model: recorder, ...(input.signal ? { signal: input.signal } : {}) });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return keep(input, fail(`the model did not answer: ${(error as Error).message}`), replies);
  }
  const askReplies = replies.filter((r) => r.packet.operation.id === input.ask.spec.id);
  let validShapes = askReplies.filter((r) => {
    const parsed = parseResponse(r.text);
    return 'value' in parsed && schemaCheck.run(r.packet, parsed.value, input.ask).length === 0;
  }).length;
  const first = askReplies[0];
  let matched = 0;
  let quoted = 0;
  if (first) {
    const parsed = parseResponse(first.text);
    const claims = 'value' in parsed ? ((parsed.value as { claims?: Array<{ citations?: Array<{ block: string; line: number; quote: string }> }> }).claims ?? []) : [];
    for (const c of Array.isArray(claims) ? claims : []) {
      for (const cit of Array.isArray(c.citations) ? c.citations : []) {
        quoted += 1;
        const line = citedLine(first.packet, String(cit.block), Number(cit.line));
        if (line !== null && typeof cit.quote === 'string' && cit.quote.trim() && normalizeSpace(line).includes(normalizeSpace(cit.quote))) matched += 1;
      }
    }
  }
  step({ name: 'shape', done: true, text: `${validShapes} of ${askReplies.length} answers were valid JSON of the right shape` });
  step({ name: 'citations', done: true, text: `${matched} of ${quoted} quotes matched the lines they cite` });

  // 2. Reading: the benchmark slice in both formats.
  const reading: FitnessResult['reading'] = { markdown: { right: 0, total: 0 }, json: { right: 0, total: 0 } };
  let benchShapes = 0;
  let benchCalls = 0;
  const errors: string[] = []; // a call answered with an error (a rate limit, a server down), not a wrong reading
  for (const format of ['markdown', 'json'] as const) {
    for (const b of input.bench.briefings.filter((x) => SLICE.briefings.includes(x.briefing))) {
      step({ name: 'reading', done: false, text: `${format}, ${b.briefing}` });
      const qs = b.questions.filter((q) => SLICE.questions.includes(q.id));
      const packet = benchPacket(b, qs, format, input.benchData(b.briefing, format), newRunId(now()));
      benchCalls += 1;
      let text = '';
      try {
        text = (await recorder.complete(packet, undefined, input.signal)).text;
      } catch (error) {
        if (input.signal?.aborted) throw error;
        // A runtime that did not answer this time (a rate limit, a server error, nothing
        // listening) leaves the reading untested. A packet it refused or cut off (too big for
        // its context) is the reading's own result, and scores as before.
        const status = error instanceof ModelError ? error.status : null;
        const message = (error as Error).message;
        if (status === 429 || (status !== null && status >= 500) || /is not answering at|took too long to answer/.test(message)) errors.push(message);
      }
      const answers = answersOf(text);
      if (answers && qs.every((q) => q.id in answers)) benchShapes += 1;
      for (const q of qs) {
        reading[format].total += 1;
        if (answers && scoreAnswer(q, answers[q.id]) === 'correct') reading[format].right += 1;
      }
    }
  }
  validShapes += benchShapes;
  const shape = { valid: validShapes, total: askReplies.length + benchCalls };
  // A reading test the runtime did not let finish measures nothing: it is no verdict on how
  // the model reads, and proposes no format.
  if (errors.length) {
    const reason = `the reading test could not be finished: ${errors.length} of its ${benchCalls} calls answered with an error (${errors[0]}); check again once the model answers`;
    return keep(input, { ...fail(reason), shape, citations: { matched, total: quoted }, calls: replies.length }, replies);
  }
  const limit = caps.maxContextTokens ?? caps.contextTokens;
  const jsonNeeded = contextNeeded(input.ask, QUESTION, input.largest.json, []).needed;
  const markdownNeeded = contextNeeded(input.ask, QUESTION, input.largest.markdown, []).needed;
  // The better reader; a tie goes to markdown, the smaller packet; JSON that cannot fit goes to markdown.
  let format: PacketFormat = pct(reading.json) > pct(reading.markdown) ? 'json' : 'markdown';
  if (format === 'json' && limit !== null && jsonNeeded > limit) format = 'markdown';
  step({ name: 'reading', done: true, text: `markdown ${reading.markdown.right} of ${reading.markdown.total}, JSON ${reading.json.right} of ${reading.json.total}` });

  const largest = format === 'json' ? jsonNeeded : markdownNeeded;
  step({ name: 'context', done: true, text: limit ? `${Math.round(limit / 1024)}k tokens; the largest packet in use needs ${(largest / 1000).toFixed(1)}k` : 'the runtime does not report its context' });

  const seconds = replies.reduce((s, r) => s + r.seconds, 0);
  const outTokens = replies.reduce((s, r) => s + r.outputTokens, 0);
  const speed = { tokensPerSecond: seconds > 0 ? outTokens / seconds : null, secondsPerCall: replies.length ? seconds / replies.length : null };
  step({ name: 'speed', done: true, text: speed.tokensPerSecond ? `${Math.round(speed.tokensPerSecond)} tokens a second` : 'not measured' });

  const best = Math.max(pct(reading.markdown), pct(reading.json));
  const answered = ask.outcome === 'passed' || ask.outcome === 'partial';
  const verdict: Verdict = !answered ? 'not fit' : best >= FIT_FOR_EVERYTHING ? 'fit for everything' : 'fit for ask and digest only';
  const reason = !answered
    ? `its answer to one question did not pass its checks after the repair turn${ask.reason ? ` (${ask.reason})` : ''}`
    : verdict === 'fit for everything'
      ? `it answered with checked citations and read ${Math.round(best * 100)}% of the reading test right`
      : `it answered with checked citations and read ${Math.round(best * 100)}% of the reading test right, below the ${Math.round(FIT_FOR_EVERYTHING * 100)}% set for everything`;
  return keep(input, { ...base, verdict, reason, shape, citations: { matched, total: quoted }, reading, format, context: { limit, largest }, speed, calls: replies.length }, replies);
}

// Every packet and reply of the check, and its result, in the journal.
function keep(input: FitnessInput, result: FitnessResult, replies: Reply[]): FitnessResult {
  if (!input.journal) return result;
  const at = (input.now ?? (() => new Date()))();
  const run = input.journal.open('model-check', newRunId(at), at);
  replies.forEach((r, i) => {
    const n = String(i + 1).padStart(2, '0');
    run.write(`packet-${n}.md`, r.packet.text);
    run.write(`reply-${n}.txt`, r.text);
  });
  run.write('result.json', result);
  return { ...result, journalDir: run.dir };
}

// The result as the screen and the journal say it.
export function fitnessLines(r: FitnessResult): Array<{ ok: boolean | null; text: string }> {
  if (r.calls === 0) return []; // the model never answered; the verdict says why
  const lines: Array<{ ok: boolean | null; text: string }> = [
    { ok: r.shape.total > 0 && r.shape.valid === r.shape.total, text: `Answer shape: ${r.shape.valid} of ${r.shape.total} answers were valid JSON of the right shape.` },
    { ok: r.citations.total > 0 && r.citations.matched === r.citations.total, text: `Citations: ${r.citations.matched} of ${r.citations.total} quotes matched the lines they cite.` },
  ];
  if (r.reading.markdown.total) {
    lines.push({ ok: null, text: `Reading: markdown ${r.reading.markdown.right} of ${r.reading.markdown.total}, JSON ${r.reading.json.right} of ${r.reading.json.total}; ${r.format === 'json' ? 'JSON' : 'markdown'} is proposed.` });
  }
  if (r.context.largest) {
    lines.push({
      ok: r.context.limit === null || r.context.largest <= r.context.limit,
      text: r.context.limit ? `Context: ${Math.round(r.context.limit / 1024)}k tokens; the largest packet in use needs ${(r.context.largest / 1000).toFixed(1)}k.` : 'Context: not reported by the runtime.',
    });
  }
  if (r.speed.tokensPerSecond) lines.push({ ok: null, text: `Speed: ${Math.round(r.speed.tokensPerSecond)} tokens a second, about ${Math.round(r.speed.secondsPerCall ?? 0)} s an answer.` });
  return lines;
}
