import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BacktestRun,
  COMPANY_FAMILY,
  ROUTINE_NAME,
  RUN_ID,
  RoutineError,
  answerView,
  backtestsDir,
  benchItems,
  benchLines,
  buildPacket,
  fitPacket,
  companyBriefing,
  cutoffOf,
  failuresOf,
  isMonth,
  judgeText,
  keepBench,
  labelOfSettled,
  loadRoutine,
  longDay,
  memoryPacket,
  newRunId,
  packetFiles,
  planBacktest,
  planLines,
  prepareRoutine,
  readConfig,
  readRules,
  recordAnswer,
  renderMarkdown,
  renderRoutine,
  reportLines,
  routinesDir,
  settle,
  summarizeBench,
  tickKey,
  tickLine,
  writeConfig,
  type BenchArm,
  type BenchFile,
  type BenchItem,
  type BenchRecord,
  type DataBlock,
  type Journal,
  type JournalRun,
  type Operation,
  type Packet,
  type PacketFormat,
  type PreparedRoutine,
  type Routine,
  type RunResult,
  type Snapshots,
  type TickKey,
} from '@primerkit/core';
import { CodedError, type ErrorCode } from './codes';
import { findLiveIntent, journalEntries, journalRun, queryWords, type JournalQuery, journalSummary, listLiveIntents, liveIntentLines, readLiveIntent, recordLiveIntent, type AskResponse, type LiveIntentInput } from '@primerkit/core';
import { ROBINHOOD_URL } from './install';
import { PreReasonError, checkedDay, dayOfQuestion, isMetricId, pickBriefings, readableBy, smallestFree, type CatalogEntry, type MetricEntry, type Tier } from '@primerkit/connector-prereason';
import {
  assembleDigest,
  collectDigest,
  datedOperation,
  digestPlans,
  journalFind,
  journalOpen,
  journalRows,
  pickRecord,
  readBriefing,
  readHistory,
  readMetric,
  readsCompanyHistory,
  renderDigest,
  routineSource,
  tildePath,
  writtenFrom,
  type Briefings,
  type Collected,
} from '@primerkit/session';

// Operations run inside an AI app: primerkit prepares the packet, the app's own model
// answers, and primerkit checks the answer, gives one repair turn, keeps the run in the
// journal and returns the view. The app's model never needs a key of its own.

export interface HostDeps {
  ask: Operation;
  digest: Operation;
  data: () => Briefings | null; // null while PreReason is not connected
  catalog: () => Promise<CatalogEntry[]>;
  // PreReason's keyless list of metrics; absent where metrics are not offered, as in the demo.
  metrics?: () => Promise<MetricEntry[]>;
  tier: () => Tier | null;
  watchlist: () => Promise<string[]>;
  snapshots: Snapshots | null;
  journal: Journal | null;
  home: string | null;
  bench: { file: BenchFile; data: (briefing: string, format: PacketFormat) => string; fixtures: string } | null;
  routine: Operation | null; // the operation each routine fills in; null where no routine is kept, as in the demo
  // The day the demo's saved briefings are of, said under each view; absent on live data.
  savedOn?: string;
  now?: () => Date;
}

interface Pending {
  operation: Operation;
  packet: Packet;
  dir: JournalRun | null;
  replies: string[];
  skipped: string[];
  notes: string[]; // what was not read, and why, said under the answer
  collected?: Collected;
  started: number;
}

interface Bench {
  model: string;
  arms: readonly BenchArm[];
  items: BenchItem[];
  handed: Set<string>;
  records: Map<string, BenchRecord>;
  replies: Map<string, string>;
  started: number;
}

export type Prepared =
  | { kind: 'catalog'; briefings: Array<{ id: string; name: string; description: string }>; metrics: Array<{ id: string; name: string; description: string }>; suggested: string[]; date: string | null; latestOnly: boolean }
  | { kind: 'packet'; runId: string; packet: string; json?: Record<string, unknown> }
  | { kind: 'done'; render: string };

export type Submitted = { kind: 'repair'; failures: string[]; json?: Record<string, unknown> } | { kind: 'done'; outcome: string; render: string; json?: Record<string, unknown> };

export type BenchNext = { kind: 'packet'; key: string; packet: string; done: number; total: number } | { kind: 'done'; render: string };

// A backtest answered by the app's model: primerkit hands out one tick of one arm at a
// time, checks each reply as every answer is checked, and moves the simulated account.
interface HostBacktest {
  run: BacktestRun;
  routine: Routine;
  model: string;
  handed: Map<string, { key: TickKey; prepared: PreparedRoutine; replies: string[]; dir: JournalRun | null; started: number }>;
  asking: Set<string>; // the memory check's days out for an answer
  reserved: Set<string>; // ticks being read for a call still running, so a call at the same time takes another
}

export type BacktestNext =
  | { kind: 'packet'; run: string; key: string; packet: string; done: number; total: number }
  | { kind: 'wait'; run: string; handed: string[]; done: number; total: number }
  | { kind: 'blocked'; run: string; reason: string }
  | { kind: 'done'; run: string; render: string };

export type BacktestRecorded = { kind: 'repair'; failures: string[] } | { kind: 'recorded'; line: string; done: number; total: number };

// A refusal said to the app's model, with its code: bad input unless it says otherwise.
export class HostError extends CodedError {
  constructor(message: string, code: ErrorCode = 'bad_input') {
    super(message, code);
  }
}

// A packet's blocks as a script reads them: each id, where it came from, when it was made and
// read, and how many numbered lines it holds.
export const blocksJson = (packet: Packet) =>
  packet.blocks.map((b) => ({ id: b.id, source: b.source, generated_at: b.generatedAt ?? null, fetched_at: b.fetchedAt, lines: b.lines.length }));

// A settled answer as a script reads it: its claims with the numbered lines each cites, what
// it says the data did not hold, every check passed or failed, and what was taken out.
export function answerJson(result: RunResult) {
  const response = result.response as (AskResponse & Record<string, unknown>) | null;
  return {
    run_id: result.runId,
    operation: result.packet.operation.id,
    outcome: result.outcome,
    as_of: result.packet.asOf ?? null,
    answer: typeof response?.answer === 'string' ? response.answer : null,
    claims: Array.isArray(response?.claims) ? response.claims.map((c) => ({ text: c.text, citations: (c.citations ?? []).map((x) => ({ block: x.block, line: x.line, quote: x.quote })) })) : [],
    not_in_data: Array.isArray(response?.not_in_data) ? response.not_in_data : [],
    checks: result.checks.map((c) => ({ id: c.id, passed: c.failures.length === 0, failures: c.failures.map((f) => ({ message: f.message, ...(f.soft ? { soft: true } : {}) })) })),
    dropped: result.dropped.map((d) => ({ text: d.claim.text, reasons: d.reasons, ...(d.background ? { background: true } : {}) })),
    blocks: blocksJson(result.packet),
    tokens: { packet: result.packet.tokens.count, tokenizer: result.packet.tokens.label, ...(result.usage?.reported ? { input: result.usage.inputTokens, output: result.usage.outputTokens, cache_read: result.usage.cacheReadTokens, cache_write: result.usage.cacheWriteTokens } : {}) },
    cost: result.cost ?? null,
    model: result.modelReported ?? result.modelId,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

// The context of the app's model is not known to primerkit: only the operation's cap binds.
const HOST_CAPS = { local: false, schemaConstraint: false, contextTokens: null, canRaiseContext: false, maxContextTokens: null, format: 'json' } as const;
const overCap = (operation: Operation, tokens: number): string => {
  const id = operation.spec.id;
  return `The packet is over the ${id} operation's cap, so it was not handed out: even cut down, it is ${tokens.toLocaleString('en-US')} tokens, and the ${id} operation sends at most ${(operation.spec.data.maxPacketTokens ?? 0).toLocaleString('en-US')} tokens a packet. Ask about fewer briefings.`;
};

// A reply as the app's model gave it: text, or the object, as JSON. A call that gives none
// is refused before anything is recorded, so it spends no attempt and no repair turn.
function replyText(response: unknown, tool: string): string {
  const text = typeof response === 'string' ? response : response === undefined || response === null ? '' : JSON.stringify(response);
  if (!text.trim()) throw new HostError(`${tool} takes the reply as response, and this call gave none. Nothing was recorded: call it again with the reply.`);
  return text;
}

export class HostRuns {
  private readonly pending = new Map<string, Pending>();
  private bench: Bench | null = null;
  private readonly backtests = new Map<string, HostBacktest>();

  constructor(private readonly deps: HostDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // The demo's views say their day, as the terminal's demo does: a time in them is not today's.
  private saved(render: string): string {
    return this.deps.savedOn ? `${render}\n(demo: saved briefings of ${this.deps.savedOn}; every time above is that day's, not today's)\n` : render;
  }

  listOperations(): Array<{ id: string; title: string; inputs: string[] }> {
    const ops = [this.deps.ask, this.deps.digest].map((o) => ({ id: o.spec.id, title: o.spec.title, inputs: o.spec.inputs.map((i) => `${i.name}${i.required ? '' : ' (optional)'}`) }));
    // What prepare_operation takes for ask beyond the operation's own inputs.
    const ask = ops.find((o) => o.id === 'ask');
    for (const extra of ['metrics (optional)', 'date (optional, YYYY-MM-DD, one past day)']) if (ask && !ask.inputs.some((i) => i.startsWith(extra.split(' ')[0]!))) ask.inputs.push(extra);
    if (this.deps.bench) ops.push({ id: 'bench', title: 'The comprehension benchmark', inputs: ['model (the model that answers, as the host names it)'] });
    ops.push({ id: 'backtest', title: "A routine's backtest over a past window, one tick at a time (backtest_next, backtest_record)", inputs: ['routine', 'from (optional)', 'to (optional)', 'every (optional)', 'reps (optional)', 'model (optional)'] });
    return ops;
  }

  private connected(): Briefings {
    const data = this.deps.data();
    if (!data) throw new HostError('PreReason is not connected. Run primerkit connect prereason in a terminal, or set PREREASON_API_KEY.', 'no_key');
    return data;
  }

  // The run in the journal as pending, before any model reads the packet.
  private open(operation: Operation, packet: Packet): JournalRun | null {
    if (!this.deps.journal) return null;
    const dir = this.deps.journal.open(operation.spec.id, packet.runId, this.now());
    for (const [name, content] of packetFiles(packet)) dir.write(name, content);
    dir.write('pending.json', { runId: packet.runId, operation: packet.operation, preparedAt: this.now().toISOString(), host: true });
    return dir;
  }

  async prepare(args: { operation: string; question?: string; briefings?: string[]; metrics?: string[]; date?: string }): Promise<Prepared> {
    if (args.operation === 'digest') return this.prepareDigest();
    if (args.operation !== 'ask') throw new HostError(`There is no operation ${args.operation}. The operations are ask and digest; the benchmark runs through bench_next.`);
    const question = args.question?.trim();
    if (!question) throw new HostError('ask needs the question.');
    const data = this.connected();
    // The day: the one the question names comes first, then the app's date. Each is held
    // to the same rules: a real past day; today reads as now; a day to come is refused.
    const today = this.now().toISOString().slice(0, 10);
    const asked = dayOfQuestion(question, today, 'primerkit chart');
    if (asked.kind === 'refused') throw new HostError(asked.why);
    let date = asked.kind === 'day' ? asked.day : null;
    let dateFrom: 'question' | 'host' | null = date ? 'question' : null;
    if (!date && args.date?.trim()) {
      const day = checkedDay(args.date.trim(), today);
      if (day.kind === 'refused') throw new HostError(day.why);
      if (day.kind === 'day') {
        date = day.day;
        dateFrom = 'host';
      }
    }
    const catalog = await this.deps.catalog();
    // A key whose tier is not known yet would be shown only the free briefings, so one
    // call on the smallest free briefing learns it first, as the session does.
    if (!this.deps.tier()) {
      const smallest = smallestFree(catalog);
      if (smallest) await readBriefing({ data, snapshots: this.deps.snapshots }, smallest.id, 'json').catch(() => null);
    }
    const readable = readableBy(catalog, this.deps.tier() ?? 'free').filter((b) => data.has?.(b.id) ?? true);
    const metrics = this.deps.metrics && data.metricBlock ? await this.deps.metrics().catch(() => null) : null;
    const named = (args.briefings ?? []).filter(Boolean);
    const namedMetrics = (args.metrics ?? []).filter(Boolean);
    // Without briefings or metrics, the app's model picks from the catalog (up to three).
    if (!named.length && !namedMetrics.length) {
      const entry = (b: { id: string; name: string; description: string }) => ({ id: b.id, name: b.name, description: b.description });
      const latestOnly = (this.deps.tier() ?? 'free') === 'free';
      return { kind: 'catalog', briefings: readable.map(entry), metrics: (metrics ?? []).map(entry), suggested: pickBriefings(question, [...readable, ...(metrics ?? [])], 3, { latestOnly }).ids, date, latestOnly };
    }
    const ids = [...named, ...namedMetrics];
    if (ids.length > 3) throw new HostError(`${ids.length} were named. An answer reads at most three briefings and metrics together.`);
    // A company briefing is named with its company, such as equities.company/nvda, where the
    // key reads the company family.
    const family = readable.some((b) => b.id === COMPANY_FAMILY);
    const unknown = named.filter((id) => !readable.some((b) => b.id === id) && !(family && companyBriefing(id) === id));
    if (unknown.length) throw new HostError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} ${data.readsDates ? 'not in the catalog this key reads' : 'not among the saved briefings'}. Pick from the catalog prepare_operation returns without briefings.`);
    if (namedMetrics.length && !metrics) throw new HostError('Metrics cannot be read here. Pick briefings from the catalog prepare_operation returns without briefings.');
    const unknownMetrics = namedMetrics.filter((id) => !isMetricId(id) || !metrics?.some((m) => m.id === id));
    if (unknownMetrics.length) throw new HostError(`${unknownMetrics.join(', ')} ${unknownMetrics.length === 1 ? 'is' : 'are'} not a metric PreReason lists. Pick from the catalog prepare_operation returns without briefings.`);
    if (date && namedMetrics.length) throw new HostError(`${namedMetrics.join(', ')}: PreReason serves a metric as it stands now, not as it stood on ${longDay(date)}. Call prepare_operation again with briefings only for that day, or with no date for now.`);
    if (date && !data.readsDates) throw new HostError(`These briefings are one saved day, so ${longDay(date)} cannot be read here. With a key, primerkit reads a briefing as it stood on a past day.`);
    const blocks: DataBlock[] = [];
    const skipped: string[] = [];
    const notes: string[] = [];
    const history: string[] = [];
    let dateRefused: string | null = null;
    for (const id of ids) {
      // Figures over several periods: the company's statement history, as the session reads it.
      if (readsCompanyHistory(data, id, question, date)) {
        const read = await readHistory(data, id).catch((error: unknown) => {
          if (error instanceof PreReasonError && (error.status === 404 || error.status === 400 || error.tierRefusal)) return null;
          throw error;
        });
        if (read) {
          blocks.push(read);
          history.push(id);
          continue;
        }
        notes.push(`${id}: PreReason holds no statement history for this company yet, so its whole briefing was read, which gives its latest period.`);
      }
      try {
        blocks.push(isMetricId(id) ? await readMetric(data, id, metrics?.find((m) => m.id === id)?.name ?? id) : await readBriefing({ data, snapshots: this.deps.snapshots }, id, 'json', date ?? undefined));
      } catch (error) {
        if (error instanceof PreReasonError && error.code === 'DATE_RESTRICTED') {
          dateRefused = error.message;
          notes.push(`${id} was not read for ${longDay(date ?? today)}: ${error.message}.`);
        } else if (error instanceof PreReasonError && error.tierRefusal) skipped.push(id);
        else if (error instanceof PreReasonError && isMetricId(id) && (error.status === 404 || error.status === 503)) notes.push(`${id} was not read: ${error.message}.`);
        else throw error;
      }
    }
    if (!blocks.length) {
      if (dateRefused) throw new HostError(`${ids.join(', ')} could not be read for ${longDay(date ?? today)}. PreReason says: ${dateRefused}.`);
      throw new HostError(`None of ${ids.join(', ')} could be read: ${skipped.length ? "not available on this key's tier" : (notes.at(-1) ?? 'PreReason gave no answer')}.`);
    }
    const operation = date ? datedOperation(this.deps.ask) : this.deps.ask;
    // The operation's own cap holds inside an AI app too: the packet is fitted to it, as in
    // the session, and one still over it is not handed out. The app's context is not known here.
    const fitted = await fitPacket({ operation, question, blocks, caps: HOST_CAPS, asMarkdown: (b) => readBriefing({ data, snapshots: this.deps.snapshots }, b.id, 'markdown', date ?? undefined) });
    if (fitted.refused) throw new HostError(overCap(operation, fitted.tokens));
    const packet = buildPacket({ operation, question, blocks: fitted.blocks, notes: fitted.notes, runId: newRunId(this.now()), ...(date ? { asOf: date } : {}) });
    const dir = this.open(operation, packet);
    dir?.write('pick.json', pickRecord({ read: fitted.blocks.map((b) => b.id), by: 'host', date, dateFrom, skipped, notes: [...notes, ...fitted.notes], history }));
    this.pending.set(packet.runId, { operation, packet, dir, replies: [], skipped, notes: [...notes, ...fitted.notes], started: Date.now() });
    return { kind: 'packet', runId: packet.runId, packet: packet.text, json: this.packetJson(packet, skipped, [...notes, ...fitted.notes]) };
  }

  private async prepareDigest(): Promise<Prepared> {
    const data = this.connected();
    if (!this.deps.home || !this.deps.snapshots) throw new HostError('The digest needs somewhere to keep its snapshots.');
    const engine = { data, snapshots: this.deps.snapshots, home: this.deps.home, ...(this.deps.now ? { now: this.deps.now } : {}) };
    const collected = await collectDigest(engine, { watchlist: await this.deps.watchlist() });
    const plan = digestPlans(collected, false)[0];
    // Nothing changed: the digest says so without a model.
    if (!plan) return { kind: 'done', render: this.saved(renderDigest(assembleDigest({ ...engine, journal: this.deps.journal, operation: this.deps.digest }, collected, new Map(), [], null))) };
    const packet = buildPacket({ operation: this.deps.digest, question: plan.question, blocks: plan.blocks, runId: newRunId(this.now()) });
    const cap = this.deps.digest.spec.data.maxPacketTokens;
    // The digest's packet is not cut down: what fits it is a shorter watchlist.
    if (cap !== undefined && packet.tokens.count > cap) throw new HostError(`The digest's packet is over the digest operation's cap, so it was not handed out: it is ${packet.tokens.count.toLocaleString('en-US')} tokens, and the digest sends at most ${cap.toLocaleString('en-US')} tokens a packet. A shorter watchlist fits.`);
    this.pending.set(packet.runId, { operation: this.deps.digest, packet, dir: this.open(this.deps.digest, packet), replies: [], skipped: [], notes: [], collected, started: Date.now() });
    return { kind: 'packet', runId: packet.runId, packet: packet.text, json: this.packetJson(packet, [], []) };
  }

  submit(args: { runId: string; response: unknown }): Submitted {
    const run = this.pending.get(args.runId);
    if (!run) throw new HostError(`No run ${args.runId} is waiting for an answer here. If primerkit's server restarted since it was prepared, prepare it again.`, 'not_found');
    const text = replyText(args.response, 'submit_response');
    run.replies.push(text);
    // A recorded response is never written over: the repair is kept beside the first.
    run.dir?.write(run.replies.length === 1 ? 'response.json' : 'response.repair.json', { attempt: run.replies.length, text });
    const judged = judgeText(run.operation, run.packet, text);
    const failures = failuresOf(judged.results);
    if (failures.length && run.replies.length === 1) return { kind: 'repair', failures: failures.map((f) => `${f.check}: ${f.message}`), json: { run_id: args.runId, outcome: 'repair', failures: failures.map((f) => ({ check: f.check, message: f.message, ...(f.soft ? { soft: true } : {}) })) } };

    this.pending.delete(args.runId);
    const settled = settle(run.operation, run.packet, judged);
    const result: RunResult = { runId: run.packet.runId, packet: run.packet, modelId: 'host', ...settled, attempts: run.replies.length, timings: { modelMs: 0, totalMs: Date.now() - run.started } };
    let render: string;
    if (run.collected && this.deps.home) {
      const view = assembleDigest({ home: this.deps.home, journal: this.deps.journal, operation: run.operation }, run.collected, writtenFrom(settled.response), [{ checks: settled.checks }], 'the model of your AI app');
      render = renderDigest(view);
    } else {
      const view = answerView(result);
      render = view && run.operation.render ? renderMarkdown(run.operation.render, view) : `The answer did not pass its checks, so it is not shown: ${settled.reason ?? 'it failed them'}.`;
      if (run.skipped.length) render += `\nNot read: ${run.skipped.join(', ')}, not available on this key's tier.\n`;
      for (const note of run.notes) render += `\n${note}\n`;
    }
    render = this.saved(render);
    if (run.dir) {
      run.dir.write('checks.json', result.checks);
      run.dir.write('render.md', render);
      run.dir.write('meta.json', { runId: result.runId, operation: run.packet.operation, model: 'the model of the AI app (declared)', outcome: result.outcome, reason: result.reason ?? null, attempts: result.attempts, dropped: result.dropped.length, hash: run.packet.hash, tokens: run.packet.tokens, host: true });
    }
    return { kind: 'done', outcome: settled.outcome, render, json: { ...answerJson(result), model: 'the model of the AI app (declared)', skipped: run.skipped, notes: run.notes } };
  }

  // A packet as a script reads it, beside its text.
  private packetJson(packet: Packet, skipped: string[], notes: string[]): Record<string, unknown> {
    return { run_id: packet.runId, operation: packet.operation.id, question: packet.question, as_of: packet.asOf ?? null, blocks: blocksJson(packet), tokens: { packet: packet.tokens.count, tokenizer: packet.tokens.label }, skipped, notes };
  }

  // The benchmark, one packet at a time: the host answers each in a fresh context (a
  // subagent with its model pinned) and records the reply. Packets are handed out once
  // each, so several can be answered at the same time; one handed out and never
  // recorded is handed out again once the rest are.
  benchNext(args: { model?: string; restart?: boolean; runs?: number }): BenchNext {
    const setup = this.deps.bench;
    if (!setup) throw new HostError('The benchmark fixtures are not installed here.');
    if (!this.bench || args.restart) {
      const runs = Math.max(1, Math.min(5, Math.floor(args.runs ?? 3)));
      this.bench = { model: args.model?.trim() || 'the model of the AI app', arms: ['markdown', 'json', 'none'], items: benchItems(setup.file, setup.data, { runs }), handed: new Set(), records: new Map(), replies: new Map(), started: Date.now() };
    }
    const bench = this.bench;
    const next = bench.items.find((i) => !bench.handed.has(i.key)) ?? bench.items.find((i) => !bench.records.has(i.key));
    if (next) {
      bench.handed.add(next.key);
      return { kind: 'packet', key: next.key, packet: next.packet.text, done: bench.records.size, total: bench.items.length };
    }
    return { kind: 'done', render: this.finishBench(bench) };
  }

  benchRecord(args: { key: string; response: unknown }): { done: number; total: number; score: string } {
    const bench = this.bench;
    const item = bench?.items.find((i) => i.key === args.key);
    if (!bench || !item) throw new HostError(`No benchmark packet ${args.key} is waiting. Call bench_next to start or carry on.`);
    if (bench.records.has(item.key)) throw new HostError(`${item.key} is already recorded; a recorded answer is never replaced.`);
    const text = replyText(args.response, 'bench_record');
    const record = recordAnswer(item, text, null);
    bench.records.set(item.key, record);
    bench.replies.set(item.key, text);
    return { done: bench.records.size, total: bench.items.length, score: `${record.correct} of ${record.total} right${record.answered ? '' : ' (the reply held no answers object)'}` };
  }

  private routineNamed(name: string): Routine {
    if (!this.deps.home || !this.deps.routine) throw new HostError('The demo keeps no routines. In your own setup, primerkit routine new <name> makes one.');
    // The name is checked before it becomes part of a path.
    if (!ROUTINE_NAME.test(name)) throw new HostError(`"${name}" is not a routine name: lower case letters, digits and dashes, starting with a letter.`);
    try {
      return loadRoutine(join(routinesDir(this.deps.home), name));
    } catch (error) {
      if (error instanceof RoutineError && /there is no routine\.yaml/.test(error.problems[0] ?? '')) throw new HostError(`There is no routine named ${name}. primerkit routine new ${name} makes one.`);
      if (error instanceof RoutineError) throw new HostError(`${error.file} needs a fix: ${error.problems.join('; ')}.`);
      throw error;
    }
  }

  // Starts a backtest from its window, or carries a run on, and hands out its next tick:
  // the next one in order whose arm has recorded the tick before it, so the arms can be
  // answered at the same time while each keeps its order.
  async backtestNext(args: { routine: string; from?: string; to?: string; every?: 'day' | 'week'; reps?: number; model?: string; run?: string; cutoff?: string; insideTraining?: boolean }): Promise<BacktestNext> {
    const name = args.model?.trim() || 'the model of the AI app';
    const model = `host:${name}`;
    let state = args.run ? this.backtests.get(args.run) : undefined;
    if (state && args.model && state.model !== model) throw new HostError(`Run ${state.run.runId} is answered by ${state.model.slice(5)}. Pin that model, or start a new run.`);
    if (!state) {
      const routine = this.routineNamed(args.routine);
      const data = this.deps.data();
      const source = data ? routineSource(data) : null;
      let run: BacktestRun | null;
      if (args.run) {
        if (!RUN_ID.test(args.run)) throw new HostError(`${args.run} is not a run id, such as 20260928T120000Z-1a2b3c.`);
        const dir = join(backtestsDir(routine), args.run);
        if (!existsSync(join(dir, 'plan.json'))) throw new HostError(`${routine.spec.name} has no backtest run ${args.run}.`);
        try {
          run = await BacktestRun.open({ dir, routine, model, source });
        } catch (error) {
          if (error instanceof RoutineError) throw new HostError(`${error.problems.join('; ')}.`);
          throw error;
        }
      } else {
        if (!args.from || !args.to) throw new HostError('Give the window to start a run, from and to, ending yesterday at the latest; or the run to carry on.');
        if (!source) throw new HostError('PreReason is not connected. Run primerkit connect prereason in a terminal, or set PREREASON_API_KEY.', 'no_key');
        if (!readRules(routine)) throw new HostError(`${tildePath(routine.rulesPath)} holds no rules yet, so ${routine.spec.name} returns no_rules_defined and there is nothing to backtest.`);
        // How far back the key reads depends on its tier, so a tier not known yet is learned
        // with one read first, as ask does.
        if (!this.deps.tier() && data) {
          const smallest = smallestFree(await this.deps.catalog());
          if (smallest) await readBriefing({ data, snapshots: this.deps.snapshots }, smallest.id, 'json').catch(() => null);
        }
        // The model's cutoff: the one given now, kept for next time, else the one known.
        if (args.cutoff !== undefined) {
          if (!isMonth(args.cutoff)) throw new HostError('cutoff is a month, such as 2025-07, as the model card gives it.');
          const home = this.deps.home as string;
          const config = readConfig(home);
          writeConfig(home, { ...config, cutoffs: { ...(config.cutoffs ?? {}), [name]: args.cutoff } });
        }
        const cutoff = cutoffOf(name, readConfig(this.deps.home as string).cutoffs);
        const plan = planBacktest(
          routine,
          // The person's own cap on a position, as the backtest in a terminal reads it.
          { from: args.from, to: args.to, insideTraining: Boolean(args.insideTraining), maxShare: readConfig(this.deps.home as string).brokers?.alpaca?.caps?.max_position_share ?? null, ...(args.every ? { every: args.every } : {}), ...(args.reps ? { reps: args.reps } : {}) },
          { tier: this.deps.tier(), today: this.now().toISOString().slice(0, 10), format: routine.spec.format ?? 'json', model: name, cutoff },
        );
        if (plan.problems.length) throw new HostError(planLines(plan, { model: args.model ?? 'the model of the AI app', local: false, secondsPerCall: null }).join('\n'));
        run = await BacktestRun.start({ routine, plan, model, source, now: () => this.now() });
      }
      if (!run) throw new HostError(`${tildePath(routine.rulesPath)} holds no rules yet, so ${routine.spec.name} returns no_rules_defined and there is nothing to backtest.`);
      state = { run, routine, model, handed: new Map(), asking: new Set(), reserved: new Set() };
      this.backtests.set(run.runId, state);
    }
    const open = state;
    // The memory check first: three closes asked with no data, before any tick.
    const due = open.run.memoryDue().filter((d) => !open.asking.has(d));
    if (due.length) {
      const date = due[0] as string;
      open.asking.add(date);
      return { kind: 'packet', run: open.run.runId, key: `memory/${date}`, packet: memoryPacket(date).text, done: open.run.done, total: open.run.total };
    }
    if (open.asking.size) return { kind: 'wait', run: open.run.runId, handed: [...open.asking].map((d) => `memory/${d}`), done: open.run.done, total: open.run.total };
    if (args.insideTraining) open.run.accept(this.now());
    const blocked = open.run.blocked();
    if (blocked) return { kind: 'blocked', run: open.run.runId, reason: blocked };
    const key = open.run.next(new Set([...open.handed.keys(), ...open.reserved]));
    if (!key) {
      if (open.handed.size || open.reserved.size) return { kind: 'wait', run: open.run.runId, handed: [...open.handed.keys(), ...open.reserved], done: open.run.done, total: open.run.total };
      const report = open.run.finish();
      this.backtests.delete(open.run.runId);
      return { kind: 'done', run: open.run.runId, render: `${[...reportLines(report), `Kept in ${tildePath(open.run.dir)}; every answer is in the journal.`].join('\n')}\n` };
    }
    // The tick is held while its briefings are read, so a call at the same time (several
    // subagents at once) is handed another.
    const id = tickKey(key);
    open.reserved.add(id);
    try {
      const data = this.deps.data();
      const blocks = await open.run.blocks(key, data ? routineSource(data) : null, () => this.now());
      const prepared = prepareRoutine(this.deps.routine as Operation, open.routine, blocks, this.now());
      if (!prepared) throw new HostError(`${tildePath(open.routine.rulesPath)} holds no rules any more, so the run cannot go on.`);
      const dir = this.open(prepared.operation, prepared.packet);
      dir?.write('routine.json', { routine: open.routine.spec.name, rules: { path: prepared.rules.path, hash: prepared.rules.hash, lines: prepared.rules.lines.length }, labels: open.routine.spec.labels.map((l) => l.name), backtest: open.run.runId, ...key, read: open.run.readOf(key) });
      open.handed.set(id, { key, prepared, replies: [], dir, started: Date.now() });
      return { kind: 'packet', run: open.run.runId, key: id, packet: prepared.packet.text, done: open.run.done, total: open.run.total };
    } finally {
      open.reserved.delete(id);
    }
  }

  // Records one tick's reply: checked, one repair turn given, then settled into a label
  // that moves the simulated account. A recorded tick is never replaced.
  backtestRecord(args: { run: string; key: string; response: unknown }): BacktestRecorded {
    const state = this.backtests.get(args.run);
    if (!state) throw new HostError(`No backtest run ${args.run} is open here. Call backtest_next with the routine, the run and the model to carry it on.`);
    if (args.key.startsWith('memory/')) {
      const date = args.key.slice('memory/'.length);
      if (!state.asking.has(date)) throw new HostError(`No memory question ${args.key} is out in run ${args.run}; a recorded answer is never replaced. Call backtest_next for the next packet.`);
      const text = replyText(args.response, 'backtest_record');
      const answer = state.run.recordMemory(date, text);
      state.asking.delete(date);
      const said = answer.price === null ? 'gave no price' : `gave $${answer.price.toLocaleString('en-US')} against the close of $${answer.truth.toLocaleString('en-US')}${answer.within ? ', within 5%' : ''}`;
      return { kind: 'recorded', line: `memory check, ${date}: ${said}`, done: state.run.done, total: state.run.total };
    }
    const handed = state.handed.get(args.key);
    if (!handed) throw new HostError(`No packet ${args.key} is out in run ${args.run}; a recorded tick is never replaced. Call backtest_next for the next one.`);
    const text = replyText(args.response, 'backtest_record');
    handed.replies.push(text);
    handed.dir?.write(handed.replies.length === 1 ? 'response.json' : 'response.repair.json', { attempt: handed.replies.length, text });
    const judged = judgeText(handed.prepared.operation, handed.prepared.packet, text);
    const failures = failuresOf(judged.results);
    if (failures.length && handed.replies.length === 1) return { kind: 'repair', failures: failures.map((f) => `${f.check}: ${f.message}`) };
    state.handed.delete(args.key);
    const settled = settle(handed.prepared.operation, handed.prepared.packet, judged);
    const record = state.run.record(handed.key, { label: labelOfSettled(settled), outcome: settled.outcome, runId: handed.prepared.packet.runId });
    if (handed.dir) {
      const result: RunResult = { runId: handed.prepared.packet.runId, packet: handed.prepared.packet, modelId: state.model, ...settled, attempts: handed.replies.length, timings: { modelMs: 0, totalMs: Date.now() - handed.started } };
      handed.dir.write('checks.json', result.checks);
      const view = renderRoutine(handed.prepared.operation, state.routine, handed.prepared.rules, result);
      if (view) handed.dir.write('render.md', view);
      handed.dir.write('meta.json', { runId: result.runId, operation: handed.prepared.packet.operation, model: `${state.model.slice(5)} (declared)`, outcome: result.outcome, reason: result.reason ?? null, attempts: result.attempts, dropped: result.dropped.length, hash: handed.prepared.packet.hash, tokens: handed.prepared.packet.tokens, host: true });
    }
    return { kind: 'recorded', line: tickLine(record), done: state.run.done, total: state.run.total };
  }

  private finishBench(bench: Bench): string {
    const setup = this.deps.bench!;
    const records = bench.items.map((i) => bench.records.get(i.key)).filter((r): r is BenchRecord => Boolean(r));
    const result = summarizeBench(records, { model: `${bench.model} (declared)`, fixtures: setup.fixtures, arms: bench.arms, now: this.now() });
    result.seconds = Math.round((Date.now() - bench.started) / 1000);
    if (this.deps.journal) keepBench(this.deps.journal, result, records, bench.items, bench.replies, this.now());
    this.bench = null;
    return `${[`Benchmark  ${result.model} on the frozen fixtures of ${result.fixtures}`, ...benchLines(result)].join('\n')}\n\nThe share card: run primerkit bench --card in a terminal. It is saved on this machine only.\n`;
  }

  journalRead(args: { runId?: string; limit?: number; query?: JournalQuery }): string {
    if (!this.deps.journal) return 'The journal is not kept here.';
    // A run by its id is looked for in every day of the journal, the digest's packets with
    // the rest, not only among the rows a listing shows.
    if (args.runId) {
      if (!RUN_ID.test(args.runId.replace(/-summary$/, ''))) return `${args.runId} is not a run id, such as 20260928T120000Z-1a2b3c.`;
      const dir = journalFind(this.deps.journal.root, args.runId);
      return dir ? journalOpen(dir).text : `No run ${args.runId} is in the journal.`;
    }
    const rows = journalRows(this.deps.journal.root, 500, this.now(), args.query);
    const shown = rows.slice(0, Math.max(1, Math.min(50, args.limit ?? 10)));
    if (!shown.length && args.query) return `Nothing in the journal matches ${queryWords(args.query)}.`;
    return shown.length ? shown.map((r) => `${r.day} ${r.time}  ${r.operation}  ${r.title}${r.outcome ? `  (${r.outcome})` : ''}  run ${r.dir.replace(/\\/g, '/').split('/').pop()}`).join('\n') : 'The journal is empty.';
  }

  // The journal's latest runs as a script reads them, with their tokens and cost.
  journalJson(args: { limit?: number; query?: JournalQuery }): Record<string, unknown> {
    if (!this.deps.journal) return { kept: false, runs: [] };
    const runs = journalEntries(this.deps.journal.root, { limit: Math.max(1, Math.min(50, args.limit ?? 10)), ...(args.query ? { query: args.query } : {}) }).map(({ dir: _dir, ...e }) => e);
    return { kept: true, ...(args.query ? { query: args.query } : {}), runs };
  }

  // One run as JSON: its question, answer or label, the lines it cites with their text, its
  // checks, tokens and cost; null where there is no such run.
  journalRunJson(runId: string): Record<string, unknown> | null {
    if (!this.deps.journal || !RUN_ID.test(runId)) return null;
    const dir = journalFind(this.deps.journal.root, runId);
    const run = dir ? journalRun(dir) : null;
    if (!run) return null;
    const { view: _view, ...rest } = run;
    return rest as unknown as Record<string, unknown>;
  }

  // What this server stands on, read only: the model that answers, PreReason's connection and
  // tier, each broker's connection and mode, and the journal's counts. An intent named by its
  // id is read too, so the trade skill can see whether the person approved it.
  status(args: { intentId?: string } = {}): { text: string; json: Record<string, unknown> } {
    const config = this.deps.home && !this.deps.savedOn ? readConfig(this.deps.home) : {};
    const connected = this.deps.data() !== null;
    const tier = this.deps.tier();
    const alpaca = config.brokers?.alpaca?.mode ?? 'off';
    const robinhood = config.brokers?.robinhood?.hosts ?? [];
    const root = this.deps.journal?.root ?? null;
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    const day = root ? (journalSummary(root, { days: 1 }).find((d) => d.day === today) ?? null) : null;
    const intents = root ? listLiveIntents(root, now) : [];
    let intent: Record<string, unknown> | null = null;
    if (args.intentId) {
      const dir = root ? findLiveIntent(root, args.intentId) : null;
      if (!dir) throw new HostError(`No live intent ${args.intentId} is in the journal.`, 'not_found');
      const r = readLiveIntent(dir, now);
      intent = { ...r.intent, state: r.state, approved_at: r.approval?.approved_at ?? null };
    }
    const json = {
      model: { answering: 'the model of this AI app', terminal: config.model ? `${config.model.name}${config.model.provider ? ` on ${config.model.provider}` : config.model.kind === 'ollama' ? ' on Ollama' : ''}` : null },
      prereason: { connected, tier, demo: Boolean(this.deps.savedOn), saved_on: this.deps.savedOn ?? null },
      brokers: {
        alpaca: { mode: alpaca, account: 'paper' },
        robinhood: robinhood.length ? { mode: 'live', account: 'its separate agent account', server: ROBINHOOD_URL, hosts: robinhood, approvals_confirmed_at: config.brokers?.robinhood?.approvals_confirmed_at ?? null, primerkit_sends_orders: false } : { mode: 'off' },
      },
      journal: {
        kept: Boolean(root),
        today: { day: today, runs: day?.runs ?? 0, outcomes: day?.outcomes ?? {}, tokens: day?.tokens ?? null, cost: day?.cost ?? null },
        live_intents: { pending: intents.filter((i) => i.state === 'pending').length, approved: intents.filter((i) => i.state === 'approved').length },
      },
      ...(intent ? { intent } : {}),
    };
    const lines = [
      `Model: the model of this AI app answers${json.model.terminal ? `; the terminal's is ${json.model.terminal}` : ''}.`,
      `PreReason: ${this.deps.savedOn ? `saved briefings of ${this.deps.savedOn}, no key` : connected ? `connected, ${tier ?? 'tier not known yet'}` : 'not connected'}.`,
      `Alpaca: ${alpaca}, paper account.`,
      `Robinhood: ${robinhood.length ? `live agent account, real money; added to ${robinhood.join(', ')}` : 'off'}.`,
      root ? `Journal today: ${day?.runs ?? 0} runs${day?.cost.priced_runs ? `, $${day.cost.usd.toFixed(4)} where priced` : ''}; live intents pending ${json.journal.live_intents.pending}, approved ${json.journal.live_intents.approved}.` : 'The journal is not kept here.',
      ...(intent ? [`Intent ${args.intentId}: ${String(intent.state)}.`] : []),
    ];
    return { text: lines.join('\n'), json };
  }

  // The briefings and metrics this key reads, searched by words in their ids, names and
  // descriptions, read only. Nothing is fetched beyond the lists themselves.
  async catalogSearch(args: { query?: string; kind?: 'briefings' | 'metrics' | 'all'; limit?: number }): Promise<{ text: string; json: Record<string, unknown> }> {
    const kind = args.kind ?? 'all';
    const words = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (e: { id: string; name: string; description: string }) => words.every((w) => `${e.id} ${e.name} ${e.description}`.toLowerCase().includes(w));
    const limit = Math.max(1, Math.min(200, args.limit ?? 50));
    const tier = this.deps.tier() ?? 'free';
    const catalog = kind === 'metrics' ? [] : await this.deps.catalog();
    const data = this.deps.data();
    const briefings = readableBy(catalog, tier).filter((b) => data?.has?.(b.id) ?? true).filter(hit);
    const metrics = kind === 'briefings' || !this.deps.metrics ? [] : ((await this.deps.metrics().catch(() => null)) ?? []).filter(hit);
    const json = {
      tier,
      query: args.query ?? null,
      briefings: briefings.slice(0, limit).map((b) => ({ id: b.id, name: b.name, description: b.description, tier: b.tier })),
      metrics: metrics.slice(0, limit).map((m) => ({ id: m.id, name: m.name, description: m.description, category: m.category })),
      counts: { briefings: briefings.length, metrics: metrics.length },
    };
    const line = (e: { id: string; name: string }) => `${e.id}: ${e.name}`;
    const text = [
      `Briefings this key reads${words.length ? ` matching "${args.query}"` : ''} (${briefings.length}):`,
      ...json.briefings.map(line),
      ...(kind === 'briefings' ? [] : ['', `Metrics${words.length ? ` matching "${args.query}"` : ''} (${metrics.length}), each read as it stands now:`, ...json.metrics.map(line)]),
      '',
      'Pass ids to prepare_operation as briefings or metrics, up to three in all.',
    ].join('\n');
    return { text, json };
  }

  // An order intent for Robinhood, kept as pending. primerkit sends nothing to Robinhood: the
  // person approves the intent with primerkit intent approve <id>, typed at a terminal, and the
  // trade skill places nothing until it reads approved.
  intentRecord(args: LiveIntentInput): { text: string; json: Record<string, unknown> } {
    if (!this.deps.journal || this.deps.savedOn) throw new HostError('The demo keeps no intents. In your own setup, the journal keeps them.');
    const r = recordLiveIntent(this.deps.journal, args, this.now());
    const id = r.intent.intent_id;
    return {
      text: [
        ...liveIntentLines(r),
        '',
        `It is pending. Nothing was sent. Ask the person to run primerkit intent approve ${id} in a terminal and type yes there.`,
        `Then call status with intent_id ${id}. Place nothing until it reads approved. Before the order, call Robinhood's review or preview tool; Robinhood's own trade approvals then ask in its app.`,
      ].join('\n'),
      json: { ...r.intent, state: r.state, approve_with: `primerkit intent approve ${id}` },
    };
  }
}
