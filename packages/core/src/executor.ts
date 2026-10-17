import { checkReply, type CheckResult } from './checks/index';
import { answerKeyOf, backgroundOf, claimsOf } from './checks/shape';
import { groundedDirectionsCheck } from './checks/directions';
import { groundedNumbersCheck } from './checks/numbers';
import type { Journal } from './journal';
import { buildPacket } from './packet';
import type { AskResponse, CheckFailure, Claim, DataBlock, ModelAdapter, ModelReply, Operation, Packet, RunCost, RunUsage, TokenPrice } from './types';
import { answerView, renderMarkdown } from './view';

export type Outcome = 'passed' | 'partial' | 'failed' | 'refused';

export interface Status {
  phase: 'answering' | 'checking' | 'repairing';
  tokens: number;
}

export interface RunOptions {
  operation: Operation;
  question: string;
  blocks: DataBlock[];
  model: ModelAdapter;
  journal?: Journal;
  now?: () => Date;
  onStatus?: (status: Status) => void;
  // Room kept in the model's context for the answer itself.
  answerTokens?: number;
  // Ctrl+C in the session: the run stops and nothing from it is kept.
  signal?: AbortSignal;
  // What packet fitting left out, said in the packet and kept with the run.
  notes?: string[];
  // The past day every block was read for: the packet says so, and the answer must too.
  asOf?: string;
  // The view kept as render.md; an ask shaped answer renders through the operation's
  // render.md unless the caller gives its own.
  render?: (result: RunResult) => string | null;
  // More files kept with the run, such as a routine's record of the rules it read.
  files?: Array<[string, string | object]>;
}

export class RunCancelled extends Error {
  constructor() {
    super('the run was stopped');
  }
}

export interface Dropped {
  claim: Claim;
  reasons: string[];
  background?: boolean; // a background sentence, which cites nothing, not a claim
}

export interface RunResult {
  runId: string;
  packet: Packet;
  outcome: Outcome;
  response: AskResponse | null; // what the person sees: the checked claims only
  dropped: Dropped[]; // claims taken out after the repair turn, named on screen
  checks: CheckResult[];
  attempts: number;
  reason?: string; // why a run was refused or failed
  timings: { modelMs: number; totalMs: number };
  modelId: string;
  modelReported?: string;
  journalDir?: string;
  // The tokens the model's calls used, as its runtime reported them, and what they cost
  // where that is known; packet.tokens stays the tokenizer's own count of the packet.
  usage?: RunUsage;
  cost?: RunCost | null;
}

export const noUsage = (): RunUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reported: false });

// One call's reported usage added to a run's.
export function addUsage(sum: RunUsage, reply: ModelReply['usage']): RunUsage {
  if (!reply) return sum;
  return {
    inputTokens: sum.inputTokens + (reply.inputTokens ?? 0),
    outputTokens: sum.outputTokens + (reply.outputTokens ?? 0),
    cacheReadTokens: sum.cacheReadTokens + (reply.cacheReadTokens ?? 0),
    cacheWriteTokens: sum.cacheWriteTokens + (reply.cacheWriteTokens ?? 0),
    reported: true,
  };
}

// What a run's usage cost: nothing on a model on this machine, the list price where it is
// known and the runtime reported the tokens, and null otherwise. Never an estimate.
export function costOf(usage: RunUsage, price: TokenPrice | null | undefined, local: boolean): RunCost | null {
  if (local) return { usd: 0, basis: 'local' };
  if (!price || !usage.reported) return null;
  const usd = (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite) / 1e6;
  return { usd: Math.round(usd * 1e6) / 1e6, basis: 'list price' };
}

// The model's text as JSON. Models sometimes wrap it in a code fence; that is
// taken off, and nothing else is corrected.
export function parseResponse(text: string): { value: unknown } | { error: string } {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return { value: JSON.parse(unfenced) };
  } catch {
    return { error: 'the response is not JSON' };
  }
}

export const failuresOf = (results: CheckResult[]): CheckFailure[] => results.flatMap((r) => r.failures);
const hardOf = (failures: CheckFailure[]): CheckFailure[] => failures.filter((f) => !f.soft);

export interface Judged {
  value: unknown;
  results: CheckResult[];
}

// A response's text, read and checked against the packet it answers. Text that is not JSON,
// or JSON in the wrong shape, runs no other check, and its results hold the format check alone.
export function judgeText(operation: Operation, packet: Packet, text: string): Judged {
  const parsed = parseResponse(text);
  if ('error' in parsed) return { value: null, results: [{ id: 'schema', failures: [{ check: 'schema', reason: 'format', message: parsed.error }] }] };
  return { value: parsed.value, results: checkReply(operation, packet, parsed.value) };
}

export interface Settled {
  outcome: 'passed' | 'partial' | 'failed';
  response: AskResponse | null;
  dropped: Dropped[];
  checks: CheckResult[];
  reason?: string;
}

// What a checked response comes to after its last turn. A claim, or a background sentence,
// that still fails is taken out and named, and the answer is marked partial; a failure of
// the whole response fails it; a soft failure leaves it standing, marked partial. Nothing
// is corrected silently.
export function settle(operation: Operation, packet: Packet, judged: Judged): Settled {
  const failures = hardOf(failuresOf(judged.results));
  if (!failures.length) {
    return { outcome: failuresOf(judged.results).length ? 'partial' : 'passed', response: judged.value as AskResponse, dropped: [], checks: judged.results };
  }
  // The answer's own figures and directions are held to the claims' lines, so a failure of
  // theirs is settled with the claims, below, and does not fail the whole response.
  const whole = failures.filter((f) => f.claim === undefined && f.background === undefined && f.check !== 'grounded_numbers' && f.check !== 'grounded_directions');
  if (whole.length || !judged.value) {
    return { outcome: 'failed', response: null, dropped: [], checks: judged.results, reason: whole.map((f) => f.message).join('; ') || 'the response could not be read' };
  }
  const claims = claimsOf(judged.value);
  const background = backgroundOf(judged.value);
  const failing = new Map<number, string[]>();
  const failingBackground = new Map<number, string[]>();
  for (const f of failures) {
    if (f.claim !== undefined) failing.set(f.claim, [...(failing.get(f.claim) ?? []), f.message]);
    else if (f.background !== undefined) failingBackground.set(f.background, [...(failingBackground.get(f.background) ?? []), f.message]);
  }
  const kept = claims.filter((_, i) => !failing.has(i));
  const dropped: Dropped[] = [
    ...[...failing.entries()].map(([i, reasons]) => ({ claim: claims[i] as Claim, reasons })),
    ...[...failingBackground.entries()].map(([i, reasons]) => ({ claim: { text: background[i] ?? '', citations: [] }, reasons, background: true })),
  ];
  // An answer whose claims all failed fails; one whose only failures are background
  // sentences stands without them, with no claim or with its claims.
  if (!kept.length && (claims.length || !failingBackground.size)) return { outcome: 'failed', response: null, dropped, checks: judged.results, reason: 'no claim passed its checks' };
  // The checked claims stand as the model wrote them, each with all its own fields.
  const value = judged.value as Record<string, unknown>;
  const key = Array.isArray(value.claims) ? 'claims' : 'changes';
  const partial = {
    ...value,
    [key]: (value[key] as unknown[]).filter((_, i) => !failing.has(i)),
    ...(Array.isArray(value.background) ? { background: value.background.filter((_, i) => !failingBackground.has(i)) } : {}),
  } as unknown as AskResponse;
  // An answer, or a routine's reason, that states a number only a dropped claim held, or a
  // direction no kept claim's line holds, is replaced by the checked claims.
  const sums = answerKeyOf(partial);
  const holds = [groundedNumbersCheck, ...(operation.spec.checks.includes('grounded_directions') ? [groundedDirectionsCheck] : [])];
  if (key === 'claims' && sums && holds.some((check) => check.run(packet, partial, operation).some((f) => f.claim === undefined && f.background === undefined))) {
    (partial as unknown as Record<string, unknown>)[sums] = kept.map((c) => c.text).join(' ');
  }
  const rechecked = checkReply(operation, packet, partial);
  if (hardOf(failuresOf(rechecked)).length) {
    return { outcome: 'failed', response: null, dropped, checks: rechecked, reason: hardOf(failuresOf(rechecked)).map((f) => f.message).join('; ') };
  }
  return { outcome: 'partial', response: partial, dropped, checks: rechecked };
}

// The packet as the journal keeps it: the text the model read, and the rest without the
// served bodies.
export function packetFiles(packet: Packet): Array<[string, string | object]> {
  return [
    ['packet.md', packet.text],
    ['packet.json', { runId: packet.runId, operation: packet.operation, question: packet.question, ...(packet.asOf ? { asOf: packet.asOf } : {}), hash: packet.hash, tokens: packet.tokens, notes: packet.notes, blocks: packet.blocks.map(({ raw: _raw, ...b }) => b) }],
  ];
}

// Runs one operation: builds the packet, asks the model, checks the answer, and gives
// the model one repair turn. A claim that still fails after the repair is taken out
// and named, and the answer is marked partial; a failure of the whole response fails
// the run. Nothing is ever corrected silently.
export async function runOperation(opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const packet = buildPacket({ operation: opts.operation, question: opts.question, blocks: opts.blocks, runId: undefined, notes: opts.notes ?? [], ...(opts.asOf ? { asOf: opts.asOf } : {}) });
  const base = { runId: packet.runId, packet, modelId: opts.model.id };
  // The journal is written when the run ends, so a stopped run leaves nothing behind.
  const pending: Array<[string, string | object]> = [...packetFiles(packet), ...(opts.files ?? [])];
  const stopIfCancelled = () => {
    if (opts.signal?.aborted) throw new RunCancelled();
  };

  const finish = (result: Omit<RunResult, 'runId' | 'packet' | 'modelId' | 'journalDir'>): RunResult => {
    stopIfCancelled();
    const journal = opts.journal?.open(opts.operation.spec.id, packet.runId, now());
    const out: RunResult = { ...base, ...result, ...(journal ? { journalDir: journal.dir } : {}) };
    for (const [name, content] of pending) journal?.write(name, content);
    journal?.write('checks.json', out.checks);
    const view = journal ? (opts.render ?? defaultRender(opts.operation))(out) : null;
    if (view) journal?.write('render.md', view);
    journal?.write('meta.json', {
      runId: out.runId,
      operation: packet.operation,
      model: out.modelId,
      modelReported: out.modelReported ?? null,
      outcome: out.outcome,
      reason: out.reason ?? null,
      attempts: out.attempts,
      dropped: out.dropped.length,
      hash: packet.hash,
      tokens: packet.tokens,
      usage: out.usage ?? null,
      cost: out.cost ?? null,
      timings: out.timings,
      // What the answer said the packet did not hold, kept so the misses can be read later.
      ...(Array.isArray(out.response?.not_in_data) ? { not_in_data: out.response.not_in_data } : {}),
    });
    return out;
  };

  // A packet over the operation's cap, or over the model's context, is not sent.
  const cap = opts.operation.spec.data.maxPacketTokens;
  const caps = await opts.model.capabilities();
  const answerTokens = opts.answerTokens ?? 1024;
  const most = caps.maxContextTokens ?? caps.contextTokens;
  const room = most != null ? most - answerTokens : null;
  if ((cap != null && packet.tokens.count > cap) || (room != null && packet.tokens.count > room)) {
    const limit = Math.min(cap ?? Infinity, room ?? Infinity);
    return finish({
      outcome: 'refused',
      response: null,
      dropped: [],
      checks: [],
      attempts: 0,
      reason: `The packet is ${packet.tokens.count.toLocaleString('en-US')} tokens, over the ${limit.toLocaleString('en-US')} this run allows. It needs a context of at least ${(packet.tokens.count + answerTokens).toLocaleString('en-US')} tokens.`,
      timings: { modelMs: 0, totalMs: Date.now() - started },
    });
  }

  let modelMs = 0;
  let modelReported: string | undefined;
  let usage = noUsage();
  const ask = async (repair?: CheckFailure[]) => {
    stopIfCancelled();
    opts.onStatus?.({ phase: repair ? 'repairing' : 'answering', tokens: packet.tokens.count });
    const t0 = Date.now();
    const reply = await opts.model.complete(packet, repair, opts.signal).catch((error: unknown) => {
      stopIfCancelled();
      throw error;
    });
    stopIfCancelled();
    modelMs += Date.now() - t0;
    modelReported = reply.modelReported ?? modelReported;
    usage = addUsage(usage, reply.usage);
    return reply.text;
  };
  const judge = (text: string): Judged => {
    opts.onStatus?.({ phase: 'checking', tokens: packet.tokens.count });
    return judgeText(opts.operation, packet, text);
  };

  const first = await ask();
  pending.push(['response.json', { attempt: 1, text: first }]);
  let judged = judge(first);
  let attempts = 1;
  if (failuresOf(judged.results).length) {
    const second = await ask(failuresOf(judged.results));
    pending.push(['response.repair.json', { attempt: 2, text: second }]);
    judged = judge(second);
    attempts = 2;
  }

  const extra = modelReported ? { modelReported } : {};
  return finish({ ...settle(opts.operation, packet, judged), attempts, timings: { modelMs, totalMs: Date.now() - started }, usage, cost: costOf(usage, opts.model.price, caps.local), ...extra });
}


// An ask shaped answer, rendered through the operation's own render.md.
export function defaultRender(operation: Operation): (result: RunResult) => string | null {
  return (result) => {
    if (!operation.render || !result.response || !Array.isArray((result.response as { claims?: unknown }).claims)) return null;
    const view = answerView(result);
    return view ? renderMarkdown(operation.render, view) : null;
  };
}
