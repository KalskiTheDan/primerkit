import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunCancelled, type Status } from './executor';
import { curveOf, fillTo, startHoldings, statsOf, type ArmStats, type Fill, type Holdings, type Mark } from './backtest-account';
import { freezeCard, type CardStamp } from './hypothesis';
import type { Journal } from './journal';
import { newRunId } from './packet';
import { RoutineError, addDays, daysBetween, isDate, positionBlock, priceBlock, readRules, runRoutine, unsetLabels, type Close, type Holding, type Routine } from './routine';
import { briefingPath, briefingsOn, type RoutineSource } from './routine-tests';
import { closeOn, judgeMemory, maskBlock, memoryDates, memoryPacket, memoryVerdict, sampleOf, stampRead, type MemoryAnswer, type MemoryCheck, type ModelCutoff, type Sample } from './guards';
import type { DataBlock, ModelAdapter, Operation, PacketFormat } from './types';

// A routine's backtest: the routine replayed tick by tick over a past window, in arms that
// differ only in their data, through a simulated account. The same model, rules and dates
// run in every arm, so whatever the model remembers of the window it remembers in each,
// and the difference between the arms is what the data added.
//
//   treatment  the routine's briefings as they stood that day, and the price table
//   control    the price table alone
//   placebo    the briefings as they stood 150 days earlier (180 and 210 in later
//              repeats), and the day's own price table
//
// It cannot say whether the routine will make money next, and its report says so.

export type Arm = 'treatment' | 'control' | 'placebo';
export const ARMS: readonly Arm[] = ['treatment', 'control', 'placebo'];

// Days back the placebo reads its briefings, one a repeat in turn, as PreReason's own
// trial has them.
export const PLACEBO_DAYS: readonly number[] = [150, 180, 210];
export const placeboDays = (rep: number): number => PLACEBO_DAYS[(rep - 1) % PLACEBO_DAYS.length] as number;

export const MAX_TICKS = 1000;
export const MAX_REPS = 5;

// The days a window's ticks fall on: every day, or every seventh from its first.
export function ticksOf(from: string, to: string, every: 'day' | 'week'): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length <= MAX_TICKS; d = addDays(d, every === 'week' ? 7 : 1)) out.push(d);
  return out;
}

// How far back a PreReason key reads, as its tier sets it: free keys 30 days, basic from
// 2025-01-01, pro and enterprise all of it. The earliest day, or null for no limit. A key
// whose tier is not known is taken at the smallest reach. PreReason's free window starts 30
// days before the moment of the call, and a day asked for starts at its midnight, so the
// first whole day a free key reads is today less 29: today less 30 is refused.
export function reachOf(tier: string | null, today: string): string | null {
  if (tier === 'pro' || tier === 'enterprise') return null;
  if (tier === 'basic') return '2025-01-01';
  return addDays(today, -29);
}

export interface BacktestRequest {
  from: string;
  to: string;
  every?: 'day' | 'week'; // the routine's own cadence unless given
  reps?: number; // each arm run this many times over, so a lucky run does not read as an edge
  arms?: Arm[];
  maxShare?: number | null; // the person's cap on one position's share of the account
  insideTraining?: boolean; // the person's yes to a window inside the model's training
  mask?: boolean; // dates in the packets as day numbers from the window's first day; on unless turned off
}

export interface BacktestPlan {
  routine: string;
  from: string;
  to: string;
  every: 'day' | 'week';
  ticks: string[];
  arms: Arm[];
  reps: number;
  format: PacketFormat;
  calls: number; // a model call a tick, an arm and a repeat; a failed check adds its repair turn
  reads: { briefings: number; frozen: number; prices: number }; // PreReason reads, and days already frozen
  dropped: Array<{ arm: Arm; why: string }>; // arms this window cannot run
  problems: string[]; // why the run cannot start
  seconds: number | null; // at the model's measured speed, where it is known
  maxShare: number | null;
  modelName: string; // the model it was planned for, by the name its maker gives it
  sample: Sample; // where the window stands against that model's training
  insideTraining: boolean; // the person said yes to a window inside it
  mask: boolean;
  blind: boolean; // each briefing dated from the day it stands for, so the placebo's age does not show
  memoryCalls: number; // the memory check's questions, asked before the first tick
}

export interface PlanContext {
  tier: string | null;
  today: string;
  format: PacketFormat;
  secondsPerCall?: number | null;
  model: string; // the model's name, as the person knows it
  cutoff: ModelCutoff | null; // how far its training reaches, where that is known
}

// The plan, before anything is read or asked: the ticks, the arms and repeats, the model
// calls, the PreReason reads with the days already frozen, and the time it will take. The
// run starts only from a plan with no problems.
export function planBacktest(routine: Routine, request: BacktestRequest, context: PlanContext): BacktestPlan {
  const problems: string[] = [];
  const every = request.every ?? routine.spec.every;
  const reps = request.reps ?? 1;
  if (!isDate(request.from) || !isDate(request.to)) problems.push('the window needs a start and an end date, such as 2026-06-01 and 2026-08-31');
  else if (request.from > request.to) problems.push(`the window starts on ${request.from}, after it ends on ${request.to}`);
  else if (request.to >= context.today) problems.push(`the window ends on ${request.to}; a backtest runs on whole past days, so it ends yesterday at the latest`);
  if (!Number.isInteger(reps) || reps < 1 || reps > MAX_REPS) problems.push(`repeats run from 1 to ${MAX_REPS}, not ${reps}`);
  for (const name of unsetLabels(routine)) problems.push(`${name} has no target yet: put your own share in place of the placeholder in routine.yaml`);
  if (routine.spec.fees.perTrade === null) problems.push('fees.per_trade is still a placeholder: put your own estimate of a trade cost in routine.yaml');
  if (routine.spec.spreadBps === null) problems.push('spread_bps is still a placeholder: put your own estimate of the spread in routine.yaml, or take the line out');
  if (request.maxShare !== undefined && request.maxShare !== null && !(request.maxShare > 0 && request.maxShare <= 1)) problems.push(`the cap on a position's share is from 0 to 1, not ${request.maxShare}`);

  const ticks = problems.length ? [] : ticksOf(request.from, request.to, every);
  if (ticks.length > MAX_TICKS) problems.push(`the window has more than ${MAX_TICKS} ticks; shorten it, or run it weekly`);

  // The cutoff guard: a window after the model's training is out of sample; one inside it
  // runs only on the person's yes. For a model whose cutoff is not known, the memory check
  // decides: the run goes on unless the model remembers the window's closes.
  const sample: Sample = isDate(request.from) ? sampleOf(request.from, context.cutoff) : { kind: 'unknown' };
  if (sample.kind === 'inside' && !request.insideTraining) problems.push(`the window starts on ${request.from}, inside ${context.model}'s training, which reaches ${sample.cutoff.cutoff} (${sample.cutoff.source}); it runs only on your yes, and every result then says it is inside the model's training window`);

  const dropped: BacktestPlan['dropped'] = [];
  let arms: Arm[] = [...(request.arms ?? ARMS)];
  if (!routine.spec.briefings.length) {
    for (const arm of arms.filter((a) => a !== 'control')) dropped.push({ arm, why: 'the routine reads no briefings, so only the price only arm has anything to test' });
    arms = arms.filter((a) => a === 'control');
  }
  const reach = reachOf(context.tier, context.today);
  const key = context.tier ? `a ${context.tier} key` : 'a key whose tier is not known yet';
  if (reach && ticks.length) {
    const priceFrom = addDays(ticks[0] as string, -routine.spec.priceDays);
    if (priceFrom < reach) problems.push(`${key} reads from ${reach}, and the first tick's price table reaches back to ${priceFrom}`);
    const placeboFrom = addDays(ticks[0] as string, -Math.max(...PLACEBO_DAYS.slice(0, reps)));
    if (arms.includes('placebo') && placeboFrom < reach) {
      dropped.push({ arm: 'placebo', why: `the placebo reads as far back as ${placeboFrom}, and ${key} reads from ${reach}` });
      arms = arms.filter((a) => a !== 'placebo');
    }
  }
  if (!arms.length) problems.push('no arm can run');

  // Every day a briefing is read on, once whatever the repeats, and those already frozen.
  const days = new Set<string>();
  for (const tick of ticks) {
    if (arms.includes('treatment')) days.add(tick);
    if (arms.includes('placebo')) for (let rep = 1; rep <= reps; rep++) days.add(addDays(tick, -placeboDays(rep)));
  }
  let briefings = 0;
  let frozen = 0;
  for (const day of days) {
    for (const id of routine.spec.briefings) {
      if (existsSync(briefingPath(routine, id, day, context.format))) frozen++;
      else briefings++;
    }
  }
  const calls = ticks.length * arms.length * reps;
  const memory = ticks.length ? memoryDates(request.from, request.to) : [];
  return {
    routine: routine.spec.name,
    from: request.from,
    to: request.to,
    every,
    ticks,
    arms,
    reps,
    format: context.format,
    calls,
    reads: { briefings, frozen, prices: ticks.length ? 1 : 0 },
    dropped,
    problems,
    seconds: context.secondsPerCall ? Math.round((calls + memory.length) * context.secondsPerCall) : null,
    maxShare: request.maxShare ?? null,
    modelName: context.model,
    sample,
    insideTraining: Boolean(request.insideTraining),
    mask: request.mask ?? true,
    blind: request.mask ?? true,
    memoryCalls: memory.length,
  };
}

// One tick of one arm in one repeat, as the run keeps it.
export interface TickRecord {
  rep: number;
  arm: Arm;
  tick: string;
  read: string | null; // the day the briefings stood: the tick's, the placebo's, or none
  label: string | null; // null when the answer failed its checks twice, and the position held
  outcome: string;
  runId: string; // the run in the journal: its packet, answers and checks
  target: number | null; // the share the label holds, after any cap; null keeps what is held
  capped: boolean;
  fill: Fill | null; // at the close after the tick; null when nothing traded
  pending: boolean; // there is no close after the tick yet, so its order waits
  after: Holdings;
}

// What a run keeps in its folder, <routine>/backtests/<run>: the plan with the rules and
// the routine it started from, the price series it read, one line a tick appended as each
// is done, and the report once every tick is. Nothing in it is written twice.
export interface RunFile extends BacktestPlan {
  runId: string;
  startedAt: string;
  model: string; // the model's id, which a resumed run must match
  rulesHash: string;
  spec: Routine['spec'];
  // The hypothesis card the run started with, frozen as a version: null with no card, and
  // left out by a run started before cards were.
  hypothesis?: CardStamp | null;
}

export interface ArmReport {
  arm: Arm;
  reps: ArmStats[];
  mean: { return: number; maxDrawdown: number };
  spread: { low: number; high: number }; // the lowest and highest return over the repeats
}

export interface BacktestReport {
  runId: string;
  routine: string;
  window: { from: string; to: string; every: 'day' | 'week'; ticks: number; marked: { from: string; to: string } };
  arms: ArmReport[];
  buyAndHold: ArmStats;
  // Return points between arms, a repeat each: what the data added, and whether it was
  // current information that did it.
  treatmentVsControl: number[];
  treatmentVsPlacebo: number[];
  labelsChanged: Array<{ rep: number; changed: number; compared: number }>;
  pending: number;
  // Where the window stands against the model's training, as every screen and card says it.
  sample: { kind: 'out' | 'inside'; line: string };
  memory: MemoryCheck | null;
  notes: string[];
  // When the run finished, kept in report.json as it is first written: a card version's
  // frozen test is its first backtest to finish. Left out by a run finished before it was kept.
  finishedAt?: string;
}

export interface BacktestOutcome {
  kind: 'no_rules_defined' | 'stopped' | 'remembered' | 'done';
  runId: string;
  dir: string;
  records: TickRecord[];
  report: BacktestReport | null;
  stopped?: string;
  memory?: MemoryCheck | null; // what the memory check found, when it stopped the run
}

export interface BacktestRunOptions {
  base: Operation;
  routine: Routine;
  model: ModelAdapter;
  source: RoutineSource | null;
  plan?: BacktestPlan; // a new run
  dir?: string; // a run's folder, to resume it at its next tick
  journal?: Journal;
  signal?: AbortSignal;
  now?: () => Date;
  onStatus?: (status: Status) => void;
  onTick?: (step: { done: number; total: number; record: TickRecord }) => void;
  onMemory?: (answer: MemoryAnswer) => void;
  insideTraining?: boolean; // the person's yes, given now to a run that stopped for it
}

export const backtestsDir = (routine: Pick<Routine, 'dir'>): string => join(routine.dir, 'backtests');

// One tick of one arm in one repeat: its place in the run.
export interface TickKey {
  rep: number;
  arm: Arm;
  tick: string;
}

export const tickKey = (k: TickKey): string => `${k.rep}/${k.arm}/${k.tick}`;

function readMemory(dir: string): MemoryAnswer[] {
  const path = join(dir, 'memory.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as MemoryAnswer);
}

function readRecords(dir: string): TickRecord[] {
  const path = join(dir, 'ticks.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TickRecord);
}

const holdingOf = (h: Holdings): Holding => (h.units > 0 && h.entry ? { kind: 'long', since: h.entry.date, at: h.entry.price } : { kind: 'flat' });

// The price table a tick reads: the closes from the routine's price_days back through the
// tick's own day.
function tableFor(closes: Close[], tick: string, days: number): Close[] {
  const from = addDays(tick, -days);
  return closes.filter((c) => c.date >= from && c.date <= tick);
}

// The price series a run reads once: from the first tick's table to the day after the
// window, where the last tick's order fills, but never a day not yet closed. It is kept in
// the run's folder, so a resumed run reads the same series.
async function readPrices(dir: string, file: RunFile, routine: Routine, source: RoutineSource | null, now: () => Date): Promise<Close[]> {
  const path = join(dir, 'prices.json');
  if (!existsSync(path)) {
    if (!source) throw new RoutineError(['the prices for this window are not read yet, and PreReason is not connected to read them'], 'the backtest');
    const first = file.ticks[0] as string;
    const yesterday = addDays(now().toISOString().slice(0, 10), -1);
    const end = addDays(file.to, 1) <= yesterday ? addDays(file.to, 1) : yesterday;
    const closes = await source.closes(addDays(first, -routine.spec.priceDays), end);
    if (!closes.some((c) => c.date <= first)) throw new RoutineError([`there is no Bitcoin price on or before ${first}`], 'the backtest');
    writeFileSync(path, `${JSON.stringify({ source: 'prereason', closes }, null, 2)}\n`, { flag: 'wx' });
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as { closes: Close[] }).closes;
}

// An open backtest: its folder, what it started from, its price series and the ticks done.
// The loop on this machine and the tools an AI app calls both step through it: the next
// tick, what that tick reads, and the record of its answer, which moves the account.
export class BacktestRun {
  private readonly kept = new Set<string>();
  private readonly holdings = new Map<string, Holdings>();
  private readonly answers: MemoryAnswer[];

  private constructor(
    readonly dir: string,
    readonly file: RunFile,
    readonly routine: Routine,
    readonly closes: Close[],
    readonly records: TickRecord[],
    private readonly now: () => Date,
  ) {
    this.answers = readMemory(dir);
    for (const r of records) {
      this.kept.add(tickKey(r));
      this.holdings.set(`${r.rep}/${r.arm}`, r.after);
    }
  }

  get runId(): string {
    return this.file.runId;
  }

  get total(): number {
    return this.file.reps * this.file.ticks.length * this.file.arms.length;
  }

  get done(): number {
    return this.kept.size;
  }

  // A new run from a plan with no problems, or null while the rules file holds none.
  static async start(o: { routine: Routine; plan: BacktestPlan; model: string; source: RoutineSource | null; now?: () => Date }): Promise<BacktestRun | null> {
    if (o.plan.problems.length) throw new RoutineError(o.plan.problems, 'the backtest');
    const rules = readRules(o.routine);
    if (!rules) return null;
    const now = o.now ?? (() => new Date());
    const runId = newRunId(now());
    const dir = join(backtestsDir(o.routine), runId);
    // The card freezes here, at its version's first backtest, before any tick runs.
    const hypothesis = freezeCard(o.routine, runId, now());
    const file: RunFile = { ...o.plan, runId, startedAt: now().toISOString(), model: o.model, rulesHash: rules.hash, spec: o.routine.spec, hypothesis };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx' });
    return new BacktestRun(dir, file, o.routine, await readPrices(dir, file, o.routine, o.source, now), [], now);
  }

  // A run carried on from its folder, or null while the rules file holds none. It will not
  // carry on when the rules, routine.yaml or the model changed since it started.
  static async open(o: { dir: string; routine: Routine; model: string; source: RoutineSource | null; now?: () => Date }): Promise<BacktestRun | null> {
    const file = JSON.parse(readFileSync(join(o.dir, 'plan.json'), 'utf8')) as RunFile;
    const rules = readRules(o.routine);
    if (!rules) return null;
    const changed: string[] = [];
    if (rules.hash !== file.rulesHash) changed.push('the rules changed since this run started');
    if (JSON.stringify(o.routine.spec) !== JSON.stringify(file.spec)) changed.push('routine.yaml changed since this run started');
    if (o.model !== file.model) changed.push(`this run started on ${file.model}, not ${o.model}`);
    if (changed.length) throw new RoutineError([...changed, 'start a new run to test the routine as it is now'], 'the backtest');
    const now = o.now ?? (() => new Date());
    return new BacktestRun(o.dir, file, o.routine, await readPrices(o.dir, file, o.routine, o.source, now), readRecords(o.dir), now);
  }

  // The next tick to answer: the first in order (repeat, then day, then arm) not done and
  // not among `out`, whose arm has recorded the tick before it, since that tick left the
  // position this one reads. Null when none can go now.
  next(out: ReadonlySet<string> = new Set()): TickKey | null {
    const ticks = this.file.ticks;
    for (let rep = 1; rep <= this.file.reps; rep++) {
      for (let i = 0; i < ticks.length; i++) {
        for (const arm of this.file.arms) {
          const key: TickKey = { rep, arm, tick: ticks[i] as string };
          const id = tickKey(key);
          if (this.kept.has(id) || out.has(id)) continue;
          if (i > 0 && !this.kept.has(tickKey({ rep, arm, tick: ticks[i - 1] as string }))) continue;
          return key;
        }
      }
    }
    return null;
  }

  // The days the memory check still has to ask about, before any tick runs.
  memoryDue(): string[] {
    const asked = new Set(this.answers.map((a) => a.date));
    return memoryDates(this.file.from, this.file.to).filter((d) => !asked.has(d) && closeOn(this.closes, d) !== null);
  }

  // One memory answer, judged against the day's close and kept in the run's folder.
  recordMemory(date: string, text: string): MemoryAnswer {
    const truth = closeOn(this.closes, date);
    if (truth === null) throw new RoutineError([`there is no close on ${date} to hold a memory to`], 'the backtest');
    if (this.answers.some((a) => a.date === date)) throw new RoutineError([`the memory of ${date} is already recorded, and a recorded answer is never replaced`], 'the backtest');
    const answer = judgeMemory(date, truth, text);
    appendFileSync(join(this.dir, 'memory.jsonl'), `${JSON.stringify({ ...answer, text })}\n`);
    this.answers.push(answer);
    return answer;
  }

  // The memory check's verdict, once every day is asked.
  memory(): MemoryCheck | null {
    return this.memoryDue().length ? null : memoryVerdict(this.answers.map(({ date, truth, price, within }) => ({ date, truth, price, within })));
  }

  // Whether the person said yes to running inside the model's training, in the plan or since.
  get accepted(): boolean {
    return this.file.insideTraining || existsSync(join(this.dir, 'accepted.json'));
  }

  // The person's yes, given after the plan, kept once.
  accept(now: Date = new Date()): void {
    if (!this.accepted) writeFileSync(join(this.dir, 'accepted.json'), `${JSON.stringify({ acceptedAt: now.toISOString() })}\n`, { flag: 'wx' });
  }

  // Why no tick can run yet: the model remembers the window, and the person has not said yes.
  blocked(): string | null {
    const memory = this.memory();
    if (!memory?.remembered || this.accepted) return null;
    const hits = memory.answers.filter((a) => a.within).length;
    return `${this.file.modelName ?? this.file.model} gave ${hits} of ${memory.answers.length} Bitcoin closes in the window within 5%, asked with no data, so it remembers the window; it runs only on your yes, and every result then says it is inside the model's training window`;
  }

  // The day a tick's briefings stood: its own, the placebo's stale day, or none.
  readOf(key: TickKey): string | null {
    return key.arm === 'treatment' ? key.tick : key.arm === 'placebo' ? addDays(key.tick, -placeboDays(key.rep)) : null;
  }

  private held(key: TickKey): Holdings {
    return this.holdings.get(`${key.rep}/${key.arm}`) ?? startHoldings();
  }

  // The holdings as a tick's own close finds them, which is what the tick is shown. An
  // order fills at the first close after the tick that placed it; where a day's close is
  // missing, that close can come after the next tick, and a fill dated after a tick is not
  // shown to it, as its price is not.
  private heldAt(key: TickKey): Holdings {
    let held = startHoldings();
    for (const r of this.records) {
      if (r.rep !== key.rep || r.arm !== key.arm || !r.fill) continue;
      if (r.fill.date > key.tick) break;
      held = r.after;
    }
    return held;
  }

  // What a tick reads: its briefings as they stood (each day frozen once), the price table
  // through the tick's own day and no later, and the arm's position.
  async blocks(key: TickKey, source: RoutineSource | null, now: () => Date = () => new Date()): Promise<DataBlock[]> {
    const read = this.readOf(key);
    const briefings = read ? await briefingsOn(this.routine, read, this.file.format, source) : [];
    const table = tableFor(this.closes, key.tick, this.routine.spec.priceDays);
    const close = table.at(-1);
    if (!close) throw new RoutineError([`there is no Bitcoin price on or before ${key.tick}`], 'the backtest');
    const readAt = now().toISOString();
    const own = [priceBlock(table, readAt), positionBlock(holdingOf(this.heldAt(key)), close, readAt)];
    if (!this.file.mask) return [...briefings, ...own];
    // Dates as day numbers from the window's first day. The rules are the person's own
    // words and stay as written. A briefing counts from the day it stands for, as if that
    // were the tick's, and is stamped with that day, so the placebo's stale briefings read
    // as the treatment's current ones do. A run started before that keeps its dating.
    const from = this.file.from;
    const dated = read && this.file.blind ? briefings.map((b) => maskBlock(stampRead(b, read), addDays(from, -daysBetween(read, key.tick)))) : briefings.map((b) => maskBlock(b, from));
    return [...dated, ...own.map((b) => maskBlock(b, from))];
  }

  // One tick's answer, settled into the account: the label's share, within the person's
  // cap, filled at the next close; a hold label, or no label, keeps what is held. The
  // record is appended to the run's folder, and a recorded tick is never replaced.
  record(key: TickKey, answer: { label: string | null; outcome: string; runId: string }): TickRecord {
    const id = tickKey(key);
    if (this.kept.has(id)) throw new RoutineError([`${id} is already recorded, and a recorded tick is never replaced`], 'the backtest');
    const held = this.held(key);
    const means = answer.label ? this.file.spec.labels.find((l) => l.name === answer.label)?.means : undefined;
    const wanted = means?.kind === 'target' ? means.share : null;
    const target = wanted === null ? null : Math.min(wanted, this.file.maxShare ?? 1);
    const next = this.closes.find((c) => c.date > key.tick);
    let after = held;
    let fill: Fill | null = null;
    if (target !== null && next) ({ holdings: after, fill } = fillTo(held, target, next.price, this.file.spec.fees.perTrade ?? 0, next.date));
    // With no close after the tick yet, an order waits for one, unless no close could make
    // one: flat with a target of nothing, or all in with a target of everything. Any other
    // share moves with the price, so the next close places an order to keep it.
    const kept = (target === 0 && held.units === 0) || (target === 1 && held.cash <= 0);
    const waits = target !== null && !next && !kept;
    const record: TickRecord = {
      rep: key.rep,
      arm: key.arm,
      tick: key.tick,
      read: this.readOf(key),
      label: answer.label,
      outcome: answer.outcome,
      runId: answer.runId,
      target,
      capped: wanted !== null && target !== wanted,
      fill,
      pending: waits,
      after,
    };
    appendFileSync(join(this.dir, 'ticks.jsonl'), `${JSON.stringify(record)}\n`);
    this.records.push(record);
    this.kept.add(id);
    this.holdings.set(`${key.rep}/${key.arm}`, after);
    return record;
  }

  // The report, once every tick is recorded, kept in the run's folder with when it was first
  // kept: the registry takes a card version's status from its first backtest to finish.
  finish(): BacktestReport {
    if (this.done < this.total) throw new RoutineError([`the run has ${this.total - this.done} ticks still to answer`], 'the backtest');
    const report = reportOf(this.file, this.records, this.closes, this.memory(), this.accepted);
    const path = join(this.dir, 'report.json');
    if (!existsSync(path)) writeFileSync(path, `${JSON.stringify({ ...report, finishedAt: this.now().toISOString() }, null, 2)}\n`, { flag: 'wx' });
    return report;
  }
}

// Runs a backtest on a model this machine calls, or resumes one at its next tick. Ticks
// run in order within an arm, since each depends on the position the one before left, and
// the arms advance together tick by tick. Every answer is kept in the journal, and each
// tick's line is appended to the run's folder as it is done, so Ctrl+C keeps what ran and
// the same folder carries on at the next tick.
export async function runBacktest(opts: BacktestRunOptions): Promise<BacktestOutcome> {
  const now = opts.now ?? (() => new Date());
  const resuming = Boolean(opts.dir && existsSync(join(opts.dir, 'plan.json')));
  if (!resuming && !opts.plan) throw new Error('a backtest needs a plan, or the folder of a run to resume');
  const run = resuming
    ? await BacktestRun.open({ dir: opts.dir as string, routine: opts.routine, model: opts.model.id, source: opts.source, now })
    : await BacktestRun.start({ routine: opts.routine, plan: opts.plan as BacktestPlan, model: opts.model.id, source: opts.source, now });
  if (!run) return { kind: 'no_rules_defined', runId: '', dir: opts.dir ?? '', records: [], report: null };
  if (opts.insideTraining) run.accept(now());
  try {
    // The memory check: three closes asked with no data, before any tick.
    for (const date of run.memoryDue()) {
      const reply = await opts.model.complete(memoryPacket(date), undefined, opts.signal).catch((error: unknown) => {
        if (opts.signal?.aborted) throw new RunCancelled();
        throw error;
      });
      if (opts.signal?.aborted) throw new RunCancelled();
      // Recorded first: an optional call skips its arguments when there is no listener.
      const answer = run.recordMemory(date, reply.text);
      opts.onMemory?.(answer);
    }
    const blocked = run.blocked();
    if (blocked) return { kind: 'remembered', runId: run.runId, dir: run.dir, records: run.records, report: null, stopped: blocked, memory: run.memory() };
    for (let key = run.next(); key; key = run.next()) {
      const blocks = await run.blocks(key, opts.source, now);
      const ran = await runRoutine({
        base: opts.base,
        routine: opts.routine,
        blocks,
        model: opts.model,
        now,
        ...(opts.journal ? { journal: opts.journal } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
        record: { backtest: run.runId, rep: key.rep, arm: key.arm, tick: key.tick, read: run.readOf(key) },
      });
      if (ran.kind === 'no_rules_defined') return { kind: 'no_rules_defined', runId: run.runId, dir: run.dir, records: run.records, report: null };
      const record = run.record(key, { label: ran.label, outcome: ran.result.outcome, runId: ran.result.runId });
      opts.onTick?.({ done: run.done, total: run.total, record });
    }
  } catch (error) {
    if (!(error instanceof RunCancelled)) throw error;
    return { kind: 'stopped', runId: run.runId, dir: run.dir, records: run.records, report: null, stopped: 'stopped by hand' };
  }
  return { kind: 'done', runId: run.runId, dir: run.dir, records: run.records, report: run.finish() };
}

// The report of a finished run, from its records alone, so a replay computes the same.
// The sentence every result carries: out of sample, or inside the model's training.
export function sampleLine(run: RunFile, memory: MemoryCheck | null, accepted: boolean): { kind: 'out' | 'inside'; line: string } {
  const basis = (c: ModelCutoff): string => (c.basis === 'stated' ? 'as its maker states' : c.basis === 'release' ? 'at the latest, by its release' : 'as you gave it');
  // A run started before the guards carries no model name or sample in its plan.
  const model = run.modelName ?? run.model;
  const sample: Sample = run.sample ?? { kind: 'unknown' };
  if (memory?.remembered) {
    const hits = memory.answers.filter((a) => a.within).length;
    return { kind: 'inside', line: `Inside the model's training window: ${model} gave ${hits} of ${memory.answers.length} closes in it within 5% with no data${accepted ? ', and you said yes to running it' : ''}.` };
  }
  // A model whose cutoff is not known: the memory check decided, on the closes it asked.
  if (sample.kind === 'unknown' && memory) {
    const hits = memory.answers.filter((a) => a.within).length;
    const days = memory.answers.map((a) => a.date);
    const asked = days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days.at(-1)}` : (days[0] ?? '');
    return { kind: 'out', line: `Out of sample as far as the memory check shows: ${model}'s training cutoff is not known, and asked with no data for Bitcoin's close on ${asked}, it gave ${hits} of ${memory.answers.length} within 5%.` };
  }
  if (sample.kind === 'out') return { kind: 'out', line: `Out of sample: ${model}'s training reaches ${sample.cutoff.cutoff}, ${basis(sample.cutoff)}, before the window.` };
  if (sample.kind === 'inside') return { kind: 'inside', line: `Inside the model's training window: ${model}'s training reaches ${sample.cutoff.cutoff}, ${basis(sample.cutoff)}, so the result can reflect what it remembers.` };
  return { kind: 'inside', line: `Inside the model's training window, as far as is known: ${model}'s training cutoff was not known.` };
}

// Each arm's account in each repeat, and buying and holding, marked at every close from
// the first tick to the close after the window: what the report measures and its chart
// draws. Buying and holding puts the whole account in BTC/USD at the first fill a tick
// could make.
export interface Curves {
  marked: { from: string; to: string };
  arms: Array<{ arm: Arm; rep: number; marks: Mark[]; fills: Fill[]; failed: number }>;
  buyAndHold: { marks: Mark[]; fills: Fill[] };
}

export function curvesOf(run: RunFile, records: TickRecord[], closes: Close[]): Curves {
  const first = run.ticks[0] as string;
  const firstFill = closes.find((c) => c.date > first);
  const last = closes.filter((c) => c.date <= addDays(run.to, 1)).at(-1);
  const marked = { from: first, to: last?.date ?? first };
  const arms: Curves['arms'] = [];
  for (let rep = 1; rep <= run.reps; rep++) {
    for (const arm of run.arms) {
      const mine = records.filter((r) => r.rep === rep && r.arm === arm).sort((a, b) => a.tick.localeCompare(b.tick));
      const changes = mine.filter((r) => r.fill).map((r) => ({ date: (r.fill as Fill).date, holdings: r.after }));
      arms.push({ arm, rep, marks: curveOf(closes, changes, marked.from, marked.to), fills: mine.flatMap((r) => (r.fill ? [r.fill] : [])), failed: mine.filter((r) => r.label === null).length });
    }
  }
  let bhChanges: Array<{ date: string; holdings: Holdings }> = [];
  let bhFills: Fill[] = [];
  if (firstFill) {
    const { holdings, fill } = fillTo(startHoldings(), 1, firstFill.price, run.spec.fees.perTrade ?? 0, firstFill.date);
    bhChanges = [{ date: firstFill.date, holdings }];
    bhFills = fill ? [fill] : [];
  }
  return { marked, arms, buyAndHold: { marks: curveOf(closes, bhChanges, marked.from, marked.to), fills: bhFills } };
}

export function reportOf(run: RunFile, records: TickRecord[], closes: Close[], memory: MemoryCheck | null = null, accepted: boolean = run.insideTraining): BacktestReport {
  const curves = curvesOf(run, records, closes);
  const { marked } = curves;
  const statsFor = (rep: number, arm: Arm): ArmStats => {
    const mine = curves.arms.find((c) => c.rep === rep && c.arm === arm) as Curves['arms'][number];
    return statsOf(mine.marks, mine.fills, mine.failed);
  };
  const reps = Array.from({ length: run.reps }, (_, i) => i + 1);
  const arms: ArmReport[] = run.arms.map((arm) => {
    const each = reps.map((rep) => statsFor(rep, arm));
    const returns = each.map((s) => s.return);
    return {
      arm,
      reps: each,
      mean: { return: mean(returns), maxDrawdown: mean(each.map((s) => s.maxDrawdown)) },
      spread: { low: Math.min(...returns), high: Math.max(...returns) },
    };
  });
  const armOf = (arm: Arm) => arms.find((a) => a.arm === arm);
  const versus = (other: Arm): number[] => {
    const t = armOf('treatment');
    const o = armOf(other);
    return t && o ? reps.map((_, i) => ((t.reps[i] as ArmStats).return - (o.reps[i] as ArmStats).return)) : [];
  };
  const buyAndHold = statsOf(curves.buyAndHold.marks, curves.buyAndHold.fills, 0);
  const labelsChanged = run.arms.includes('treatment') && run.arms.includes('control')
    ? reps.map((rep) => {
        const treated = new Map(records.filter((r) => r.rep === rep && r.arm === 'treatment').map((r) => [r.tick, r.label]));
        const pairs = records.filter((r) => r.rep === rep && r.arm === 'control' && r.label !== null && treated.get(r.tick) != null);
        return { rep, changed: pairs.filter((r) => treated.get(r.tick) !== r.label).length, compared: pairs.length };
      })
    : [];
  return {
    runId: run.runId,
    routine: run.routine,
    window: { from: run.from, to: run.to, every: run.every, ticks: run.ticks.length, marked },
    arms,
    buyAndHold,
    treatmentVsControl: versus('control'),
    treatmentVsPlacebo: versus('placebo'),
    labelsChanged,
    pending: records.filter((r) => r.pending).length,
    sample: sampleLine(run, memory, accepted),
    memory,
    notes: [
      sampleLine(run, memory, accepted).line,
      ...(memory ? [`Memory check: asked ${memory.answers.length} ${memory.answers.length === 1 ? 'close' : 'closes'} in the window with no data, ${memoryGave(run.modelName ?? run.model, memory.answers)}.`] : []),
      ...(run.mask ? ["Dates in the packets were day numbers from the window's first day; prices and levels still hint at the period."] : []),
      'A simulation on past data: not a forecast, and not advice.',
      `Each briefing is read as PreReason's stored data stood that day${run.blind ? ', and stamped with that day' : ''}. A series revised since then is read revised.`,
      ...(run.arms.includes('placebo')
        ? [
            `${reps.length === 1 ? `The placebo read its briefings ${placeboDays(1)} days before each tick.` : `The placebo read its briefings ${reps.map(placeboDays).join(', ')} days before each tick, one repeat each.`}${
              run.blind ? " They were dated as if they were the tick's own, so their age did not show in the packet; their levels still differ." : ''
            }`,
          ]
        : []),
    ],
  };
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

// The runs a routine has, newest first, each with its plan and whether it finished.
export function listBacktests(routine: Pick<Routine, 'dir'>): Array<{ dir: string; run: RunFile; done: boolean; ticks: number }> {
  const root = backtestsDir(routine);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, 'plan.json')))
    .sort()
    .reverse()
    .map((d) => {
      const dir = join(root, d);
      return { dir, run: JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as RunFile, done: existsSync(join(dir, 'report.json')), ticks: readRecords(dir).length };
    });
}

// A finished run as its replay draws it: what it planned, every tick, the prices it read,
// its report, and each arm's account day by day. Null while the run has no report.
export interface Replay {
  dir: string;
  run: RunFile;
  records: TickRecord[];
  closes: Close[];
  report: BacktestReport;
  curves: Curves;
}

export function readReplay(dir: string): Replay | null {
  if (!existsSync(join(dir, 'report.json'))) return null;
  const run = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as RunFile;
  const closes = (JSON.parse(readFileSync(join(dir, 'prices.json'), 'utf8')) as { closes: Close[] }).closes;
  const records = readRecords(dir);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as BacktestReport;
  return { dir, run, records, closes, report, curves: curvesOf(run, records, closes) };
}

// A routine's newest finished run, or the one named by its id.
export function replayOf(routine: Routine, runId?: string): Replay | null {
  const done = listBacktests(routine).filter((b) => b.done);
  const found = runId ? done.find((b) => b.run.runId === runId) : done[0];
  return found ? readReplay(found.dir) : null;
}

// One arm's answer on a tick, as the journal kept it: what the packet held, the rules as
// read, what the model returned and the checks. Null parts where the journal has none.
export interface TickWorkings {
  arm: Arm;
  record: TickRecord;
  kept: {
    blocks: Array<{ id: string; lines: number }>;
    tokens: number | null;
    rules: { path: string; lines: number; hash: string } | null;
    model: string | null;
    outcome: string | null;
    attempts: number | null;
    answer: { label: string | null; reason: string | null; cited: string[] } | null;
    checks: Array<{ id: string; failed: number }>;
  } | null;
}

// The journal folder of a run, from its id: the day it ran is not known here, so each day
// is looked in, newest first.
export function journalRunDir(root: string, operationId: string, runId: string): string | null {
  if (!existsSync(root)) return null;
  for (const day of readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()) {
    const dir = join(root, day, operationId, runId);
    if (existsSync(dir)) return dir;
  }
  return null;
}

const readJsonFile = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

// Each arm's answer on a tick of the first repeat, from the run's records and the journal.
export function tickWorkings(replay: Replay, journalRoot: string | null, tick: string): TickWorkings[] {
  return replay.run.arms.flatMap((arm): TickWorkings[] => {
    const record = replay.records.find((r) => r.rep === 1 && r.arm === arm && r.tick === tick);
    if (!record) return [];
    const dir = journalRoot ? journalRunDir(journalRoot, `routine.${replay.run.routine}`, record.runId) : null;
    if (!dir) return [{ arm, record, kept: null }];
    const packet = readJsonFile<{ tokens?: { count?: number }; blocks?: Array<{ id: string; lines?: unknown[] }> }>(join(dir, 'packet.json'));
    const meta = readJsonFile<{ modelReported?: string | null; model?: string; outcome?: string; attempts?: number }>(join(dir, 'meta.json'));
    const kept = readJsonFile<{ rules?: { path?: string; lines?: number; hash?: string } }>(join(dir, 'routine.json'));
    const checks = readJsonFile<Array<{ id: string; failures?: unknown[] }>>(join(dir, 'checks.json')) ?? [];
    const reply = readJsonFile<{ text?: string }>(join(dir, existsSync(join(dir, 'response.repair.json')) ? 'response.repair.json' : 'response.json'));
    let answer: NonNullable<TickWorkings['kept']>['answer'] = null;
    try {
      const body = JSON.parse(reply?.text ?? '') as { label?: string; reason?: string; claims?: Array<{ citations?: Array<{ block?: string; line?: number }> }> };
      const cited = [...new Set((body.claims ?? []).flatMap((c) => (c.citations ?? []).map((x) => `${x.block} L${x.line}`)))];
      answer = { label: body.label ?? null, reason: body.reason ?? null, cited };
    } catch {
      answer = null;
    }
    return [
      {
        arm,
        record,
        kept: {
          blocks: (packet?.blocks ?? []).map((b) => ({ id: b.id, lines: b.lines?.length ?? 0 })),
          tokens: packet?.tokens?.count ?? null,
          rules: kept?.rules?.path && kept.rules.hash ? { path: kept.rules.path, lines: kept.rules.lines ?? 0, hash: kept.rules.hash } : null,
          model: meta?.modelReported ?? meta?.model ?? null,
          outcome: meta?.outcome ?? null,
          attempts: meta?.attempts ?? null,
          answer,
          checks: checks.map((c) => ({ id: c.id, failed: c.failures?.length ?? 0 })),
        },
      },
    ];
  });
}

const pct = (x: number): string => `${x > 0 ? '+' : x < 0 ? '-' : ''}${Math.abs(x * 100).toFixed(1)}%`;
const share = (x: number): string => `${Math.abs(x * 100).toFixed(1)}%`;
const points = (x: number): string => `${x > 0 ? '+' : x < 0 ? '-' : ''}${Math.abs(x * 100).toFixed(1)} points`;

// The report in plain lines, for a terminal that prints it once.
export function reportLines(report: BacktestReport): string[] {
  const w = report.window;
  const lines = [`${report.routine}  backtest | ${w.from} to ${w.to} | every ${w.every} | ${w.ticks} ticks`];
  for (const a of report.arms) {
    const one = a.reps.length === 1;
    const s = a.reps[0] as ArmStats;
    lines.push(
      one
        ? `${a.arm.padEnd(12)} ${pct(s.return).padStart(7)}  fell ${share(s.maxDrawdown)}  ${s.trades} trades  in ${s.daysInMarket} of ${s.days} days  fees ${share(s.fees)}  ${s.failedTicks} failed`
        : `${a.arm.padEnd(12)} ${pct(a.mean.return).padStart(7)}  on average over ${a.reps.length} repeats, from ${pct(a.spread.low)} to ${pct(a.spread.high)}`,
    );
  }
  lines.push(`${'buy and hold'.padEnd(12)} ${pct(report.buyAndHold.return).padStart(7)}  fell ${share(report.buyAndHold.maxDrawdown)}`);
  if (report.treatmentVsControl.length) lines.push(`treatment against control: ${report.treatmentVsControl.map(points).join(', ')}`);
  if (report.treatmentVsPlacebo.length) lines.push(`treatment against placebo: ${report.treatmentVsPlacebo.map(points).join(', ')}`);
  for (const c of report.labelsChanged) lines.push(`the data changed the label on ${c.changed} of ${c.compared} ticks${report.labelsChanged.length > 1 ? ` in repeat ${c.rep}` : ''}`);
  if (report.pending) lines.push(`${report.pending} ${report.pending === 1 ? 'order waits' : 'orders wait'} for a close after the window`);
  return [...lines, ...report.notes];
}

// A span as a person reads it: "40 seconds", "12 minutes", "1.5 hours".
export function duration(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  if (seconds < 90) return `${whole} ${whole === 1 ? 'second' : 'seconds'}`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

// The plan in plain lines, shown before anything is read or asked.
export function planLines(plan: BacktestPlan, context: { model: string; local: boolean; secondsPerCall: number | null }): string[] {
  const head = `${plan.routine}  backtest plan | ${plan.from} to ${plan.to} | every ${plan.every} | ${context.model}`;
  const cannot = plan.problems.map((p) => `  cannot run: ${p}`);
  if (!plan.ticks.length) return [head, ...cannot];
  const lines = [head, `  ticks    ${plan.ticks.length}, in ${plan.arms.join(', ')}${plan.reps > 1 ? `, each arm ${plan.reps} times over` : ''}`];
  for (const d of plan.dropped) lines.push(`           ${d.arm} left out: ${d.why}`);
  if (plan.sample.kind === 'out') lines.push(`  sample   out of sample: ${plan.modelName}'s training reaches ${plan.sample.cutoff.cutoff}, before the window`);
  if (plan.sample.kind === 'inside') lines.push(`  sample   inside ${plan.modelName}'s training, which reaches ${plan.sample.cutoff.cutoff}${plan.insideTraining ? ': you said yes, and every result says so' : ''}`);
  if (plan.sample.kind === 'unknown') {
    const days = memoryDates(plan.from, plan.to);
    const on = days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days.at(-1)}` : (days[0] ?? '');
    lines.push(`  sample   ${plan.modelName}'s training cutoff is not known, so the memory check decides, on Bitcoin's close on ${on}`);
  }
  const asked = plan.memoryCalls;
  const needed = asked >= 3 ? 'two' : asked === 2 ? 'both' : 'one';
  const verb = asked === 1 ? (plan.insideTraining ? 'is reported' : 'stops the run') : plan.insideTraining ? 'are reported' : 'stop the run';
  lines.push(`  memory   ${asked} ${asked === 1 ? 'close' : 'closes'} asked with no data before the first tick; ${needed} within 5% ${verb}${plan.insideTraining ? ', since you said yes' : ' for your yes'}`);
  if (plan.mask) lines.push("  dates    written as day numbers from the window's first day, in every packet");
  if (plan.blind && plan.arms.includes('placebo')) lines.push("           the placebo's briefings dated from the day each stands for, so their age does not show");
  lines.push(`  calls    ${plan.calls + plan.memoryCalls}: one a tick in each arm, the memory check's ${plan.memoryCalls}, and a repair turn for any answer that fails its checks`);
  const { briefings, frozen } = plan.reads;
  lines.push(`  reads    ${briefings ? briefings : 'no'} briefing ${briefings === 1 ? 'read' : 'reads'} from PreReason${frozen ? `, ${frozen} kept from before,` : ''} and one read of the price`);
  const each = context.secondsPerCall;
  if (plan.seconds !== null && each) {
    lines.push(`  time     about ${duration(plan.seconds)}, at ${duration(each)} a call, as this model has answered here`);
    if (context.local && plan.every === 'day' && plan.seconds > 3600) {
      const weekly = ticksOf(plan.from, plan.to, 'week').length * plan.arms.length * plan.reps * each;
      lines.push(`           weekly ticks would take about ${duration(weekly)}`);
    }
  } else {
    lines.push('  time     not known yet: this model has not answered here before, so the first ticks will say');
  }
  return [...lines, ...cannot];
}

// How long a model takes a call on this machine, from the runs the journal keeps: the
// middle of its latest twenty, or null when it has none.
export function measuredSeconds(journalRoot: string, modelId: string): number | null {
  if (!existsSync(journalRoot)) return null;
  const samples: number[] = [];
  const days = readdirSync(journalRoot)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse()
    .slice(0, 14);
  outer: for (const day of days) {
    for (const op of readdirSync(join(journalRoot, day))) {
      let runs: string[];
      try {
        runs = readdirSync(join(journalRoot, day, op));
      } catch {
        continue;
      }
      for (const run of runs.sort().reverse()) {
        const path = join(journalRoot, day, op, run, 'meta.json');
        if (!existsSync(path)) continue;
        try {
          const meta = JSON.parse(readFileSync(path, 'utf8')) as { model?: string; attempts?: number; timings?: { modelMs?: number } };
          const ms = meta.timings?.modelMs ?? 0;
          if (meta.model === modelId && ms > 0 && (meta.attempts ?? 0) > 0) samples.push(ms / (meta.attempts as number) / 1000);
        } catch {
          // a run still being written
        }
        if (samples.length >= 20) break outer;
      }
    }
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}

// One tick as a progress line says it.
export function tickLine(r: TickRecord): string {
  const what = r.label === null ? `no label (${r.outcome}), so the position held` : r.fill ? `${r.label}, filled on ${r.fill.date}` : r.pending ? `${r.label}, waiting for a close after the window` : `${r.label}, nothing to trade`;
  return `${r.tick} ${r.arm}${r.rep > 1 ? `, repeat ${r.rep}` : ''}: ${what}`;
}

// What the model gave when asked closes with no data: "gave no price for any of them" for
// none, not "gave 0, 0 of them within 5%".
export function memoryGave(model: string, answers: Array<{ price: number | null; within: boolean }>): string {
  const priced = answers.filter((a) => a.price !== null).length;
  if (!priced) return `${model} gave no price for any of them`;
  return `${model} gave a price for ${priced}, ${answers.filter((a) => a.within).length} of them within 5%`;
}
