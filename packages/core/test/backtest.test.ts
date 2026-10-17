import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BacktestRun,
  Journal,
  START_EQUITY,
  curvesOf,
  duration,
  equityOf,
  fillTo,
  listBacktests,
  loadOperation,
  loadRoutine,
  placeboDays,
  planBacktest,
  planLines,
  reachOf,
  reportLines,
  runBacktest,
  startHoldings,
  ticksOf,
  type BacktestPlan,
  type BacktestRequest,
  type Close,
  type ModelAdapter,
  type ModelCapabilities,
  type Packet,
  type Routine,
  type RoutineSource,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const BASE = loadOperation(join(REPO, 'operations', 'routine'));
const PULSE_MD = readFileSync(join(REPO, 'operations', 'bench-comprehension', 'briefings-2026-09-25', 'btc.pulse.md'), 'utf8');
const TODAY = '2026-09-28';
const NOW = () => new Date(`${TODAY}T12:00:00.000Z`);

const RULES = `# Rules
1. Enter when the change over 7 days is above +2.0% and nothing is held.
2. Exit when the change since entry is above +10.0%.
3. Otherwise watch.
`;

const YAML = `rules: rules.md
every: day
data:
  briefings: [btc.pulse]
  price_days: 30
  format: markdown
labels:
  watch: { hold: true }
  enter: { target: 0.5 }
  exit: { target: 0 }
fees: { per_trade: 0.001 }
`;

const day = (i: number): string => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
// Daily closes from Jan 1 to yesterday: $80,000 rising $100 a day.
const RISING: Close[] = Array.from({ length: 270 }, (_, i) => ({ date: day(i), price: 80_000 + 100 * i })).filter((c) => c.date < TODAY);

function routineIn(yaml = YAML, rules = RULES): Routine {
  const dir = join(mkdtempSync(join(tmpdir(), 'primerkit-backtest-')), 'btc-rules');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'routine.yaml'), yaml);
  writeFileSync(join(dir, 'rules.md'), rules);
  return loadRoutine(dir);
}

// The saved pulse as a dated read of any day: its data as of that day, and generated when
// it was read, as PreReason builds a past day's briefing when it is asked for it.
const US_DAY = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const pulseOn = (date: string): string => PULSE_MD.replace(/\*Generated: [^*]+\*/, '*Generated: Sep 28, 2026 12:00 UTC*').replaceAll('Sep 25, 2026', US_DAY(date));

// That pulse for any day, and the closes above; it counts what it is asked for.
class Source implements RoutineSource {
  readonly days: string[] = [];
  readonly prices: Array<[string, string]> = [];
  constructor(private readonly closesOf: Close[] = RISING) {}
  async briefing(_id: string, _format: 'json' | 'markdown', date: string): Promise<{ raw: string }> {
    this.days.push(date);
    return { raw: pulseOn(date) };
  }
  async closes(from: string, to: string): Promise<Close[]> {
    this.prices.push([from, to]);
    return this.closesOf.filter((c) => c.date >= from && c.date <= to);
  }
}

// A model that gives the label a function of the packet chooses, citing the price table's
// first line and the rule for that label, so every answer passes its checks.
class Scripted implements ModelAdapter {
  readonly id: string;
  readonly label = 'scripted, local';
  calls = 0;
  readonly memory: string[] = []; // the days the memory check asked about
  constructor(
    private readonly choose: (packet: Packet, call: number) => string | null,
    id = 'scripted',
    private readonly recall: (date: string) => number | null = () => null,
  ) {
    this.id = id;
  }
  async capabilities(): Promise<ModelCapabilities> {
    return { local: true, schemaConstraint: false, contextTokens: null, canRaiseContext: false, format: 'markdown' };
  }
  async complete(packet: Packet) {
    if (packet.operation.id === 'memory-check') {
      const date = /on (\d{4}-\d{2}-\d{2})\?/.exec(packet.question)?.[1] ?? '';
      this.memory.push(date);
      return { text: JSON.stringify({ price: this.recall(date) }) };
    }
    const call = ++this.calls;
    const label = this.choose(packet, call);
    if (label === null) return { text: 'not an answer' };
    const lines = packet.text.split('\n');
    const find = (block: string, has: string) => {
      const m = lines.map((l) => /^\[([a-z.]+) L(\d+)\] (.*)$/.exec(l)).find((x) => x?.[1] === block && x[3]?.includes(has));
      if (!m) throw new Error(`no ${block} line with ${has}`);
      return { line: Number(m[2]), text: m[3] as string };
    };
    const table = find('price', "Bitcoin's daily price");
    const rule = find('rules', label === 'enter' ? 'Enter' : label === 'exit' ? 'Exit' : 'Otherwise');
    return {
      text: JSON.stringify({
        label,
        reason: `The ${label} rule gave ${label}.`,
        claims: [
          { text: 'The price table covers the days read.', citations: [{ block: 'price', line: table.line, quote: "Bitcoin's daily price in US dollars" }] },
          { text: `The rule for ${label} applies.`, citations: [{ block: 'rules', line: rule.line, quote: rule.text }] },
        ],
        not_in_data: [],
      }),
    };
  }
}

// Gives the label it is given on the rule's line alone, with no line of the data: the label
// the personas walk found passing every check (10-14).
class RulesOnly extends Scripted {
  override async complete(packet: Packet) {
    const reply = await super.complete(packet);
    if (packet.operation.id === 'memory-check') return reply;
    const answer = JSON.parse(reply.text) as { claims: unknown[] };
    return { text: JSON.stringify({ ...answer, claims: answer.claims.slice(1) }) };
  }
}

const always = (label: string) => new Scripted(() => label);
// Enter whenever the packet holds a briefing, and watch on the price table alone.
const briefed = () => new Scripted((p) => (p.text.includes('Briefing btc.pulse') ? 'enter' : 'watch'));

const WINDOW: BacktestRequest = { from: '2026-09-01', to: '2026-09-10' };
// The scripted model's training, as a person would give it: it ends before every window here.
const OUT = { cutoff: '2024-01', source: 'given for these tests', basis: 'person' as const };
const planOf = (routine: Routine, request: BacktestRequest = WINDOW, tier: string | null = 'enterprise', cutoff: typeof OUT | null = OUT): BacktestPlan =>
  planBacktest(routine, request, { tier, today: TODAY, format: 'markdown', model: 'scripted', cutoff });

async function run(routine: Routine, model: ModelAdapter, over: { plan?: BacktestPlan; source?: Source; signal?: AbortSignal; dir?: string } = {}) {
  const source = over.source ?? new Source();
  const outcome = await runBacktest({ base: BASE, routine, model, source, now: NOW, ...(over.dir ? { dir: over.dir } : { plan: over.plan ?? planOf(routine) }), ...(over.signal ? { signal: over.signal } : {}) });
  return { outcome, source };
}

describe('ticks, repeats and reach', () => {
  it('ticks every day, or every seventh day from the first', () => {
    expect(ticksOf('2026-09-01', '2026-09-10', 'day')).toHaveLength(10);
    expect(ticksOf('2026-09-01', '2026-09-30', 'week')).toEqual(['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);
  });

  it('stales the placebo 150, 180 and 210 days, a repeat each, then round again', () => {
    expect([1, 2, 3, 4].map(placeboDays)).toEqual([150, 180, 210, 150]);
  });

  it("reads as far back as the key's tier reaches", () => {
    // PreReason refuses today less 30 days to a free key: its window starts 30 days before the
    // call, and a day starts at its midnight.
    expect(reachOf('free', TODAY)).toBe('2026-08-30');
    expect(reachOf(null, TODAY)).toBe('2026-08-30');
    expect(reachOf('basic', TODAY)).toBe('2025-01-01');
    expect(reachOf('pro', TODAY)).toBeNull();
    expect(reachOf('enterprise', TODAY)).toBeNull();
  });
});

describe('the simulated account', () => {
  it('buys to a target share with the fee taken off, so the share held is the target', () => {
    const { holdings, fill } = fillTo(startHoldings(), 0.5, 100_000, 0.001, '2026-09-02');
    const equity = equityOf(holdings, 100_000);
    expect((holdings.units * 100_000) / equity).toBeCloseTo(0.5, 12);
    expect(fill?.fee).toBeCloseTo((0.001 * 5_000) / 1.0005, 12);
    expect(equity).toBeCloseTo(START_EQUITY - (fill?.fee ?? 0), 9);
    expect(holdings.entry).toEqual({ date: '2026-09-02', price: 100_000 });
  });

  it('leaves exactly no cash at a target of 1, and never goes short or borrows', () => {
    const { holdings } = fillTo(startHoldings(), 1, 100_000, 0.001, '2026-09-02');
    expect(holdings.cash).toBe(0);
    expect(holdings.units).toBeCloseTo((START_EQUITY - (0.001 * START_EQUITY) / 1.001) / 100_000, 12);
  });

  it('sells to flat with the fee on what it sold, and keeps the entry only while long', () => {
    const long = fillTo(startHoldings(), 1, 100_000, 0.001, '2026-09-02').holdings;
    const half = fillTo(long, 0.5, 110_000, 0.001, '2026-09-05').holdings;
    expect(half.entry).toEqual({ date: '2026-09-02', price: 100_000 });
    const { holdings, fill } = fillTo(half, 0, 120_000, 0.001, '2026-09-07');
    expect(holdings.units).toBe(0);
    expect(holdings.entry).toBeNull();
    expect(fill?.fee).toBeCloseTo(0.001 * half.units * 120_000, 9);
    expect(holdings.cash).toBeCloseTo(half.cash + half.units * 120_000 * 0.999, 9);
  });

  it('places no order when the target is what is held', () => {
    const long = fillTo(startHoldings(), 1, 100_000, 0.001, '2026-09-02').holdings;
    expect(fillTo(long, 1, 100_000, 0.001, '2026-09-03').fill).toBeNull();
  });
});

describe('the plan', () => {
  it('counts the ticks, the calls and the reads before anything runs, and the days already frozen', () => {
    const routine = routineIn();
    const plan = planBacktest(routine, { ...WINDOW, reps: 2 }, { tier: 'enterprise', today: TODAY, format: 'markdown', secondsPerCall: 120, model: 'scripted', cutoff: OUT });
    expect(plan.problems).toEqual([]);
    expect(plan.ticks).toHaveLength(10);
    expect(plan.arms).toEqual(['treatment', 'control', 'placebo']);
    expect(plan.calls).toBe(60);
    // 10 tick days, and 10 placebo days for each of the two repeats.
    expect(plan.reads).toEqual({ briefings: 30, frozen: 0, prices: 1 });
    expect(plan.memoryCalls).toBe(3);
    expect(plan.seconds).toBe(7_560);
    // Weekly, two ticks, and still three days asked.
    const weekly = planOf(routine, { ...WINDOW, every: 'week' });
    expect([weekly.ticks.length, weekly.memoryCalls]).toEqual([2, 3]);
    mkdirSync(join(routine.dir, 'fixtures', '2026-09-01'), { recursive: true });
    writeFileSync(join(routine.dir, 'fixtures', '2026-09-01', 'btc.pulse.md'), PULSE_MD);
    expect(planOf(routine, { ...WINDOW, reps: 2 }).reads).toEqual({ briefings: 29, frozen: 1, prices: 1 });
  });

  it('waits for the sizes and the fee to be the person own, and for a window of whole past days', () => {
    const unset = routineIn(YAML.replace('target: 0.5', 'target: <your share>').replace('per_trade: 0.001', 'per_trade: <your estimate>'));
    expect(planOf(unset).problems).toEqual([
      'enter has no target yet: put your own share in place of the placeholder in routine.yaml',
      'fees.per_trade is still a placeholder: put your own estimate of a trade cost in routine.yaml',
    ]);
    const routine = routineIn();
    expect(planOf(routine, { from: '2026-09-10', to: '2026-09-01' }).problems).toEqual(['the window starts on 2026-09-10, after it ends on 2026-09-01']);
    expect(planOf(routine, { from: '2026-09-20', to: TODAY }).problems[0]).toContain('it ends yesterday at the latest');
    expect(planOf(routine, { ...WINDOW, reps: 9 }).problems).toEqual(['repeats run from 1 to 5, not 9']);
  });

  it('says in the plan where the window stands, what the memory check asks, and what a yes given up front does', () => {
    const routine = routineIn();
    const context = { model: 'scripted, local', local: true, secondsPerCall: null };
    const lines = planLines(planOf(routine), context);
    expect(lines).toContain("  sample   out of sample: scripted's training reaches 2024-01, before the window");
    expect(lines).toContain('  memory   3 closes asked with no data before the first tick; two within 5% stop the run for your yes');
    expect(lines).toContain("  dates    written as day numbers from the window's first day, in every packet");
    expect(lines).toContain("           the placebo's briefings dated from the day each stands for, so their age does not show");
    expect(lines).toContain("  calls    33: one a tick in each arm, the memory check's 3, and a repair turn for any answer that fails its checks");
    const one = planLines(planOf(routine, { from: '2026-09-01', to: '2026-09-01', insideTraining: true }), context);
    expect(one).toContain('  memory   1 close asked with no data before the first tick; one within 5% is reported, since you said yes');
  });

  it('says in whole words how much it reads and how long it takes', () => {
    const routine = routineIn();
    const context = { model: 'scripted, local', local: true, secondsPerCall: 1 };
    expect(planLines(planOf(routine), context)).toContain('  reads    20 briefing reads from PreReason and one read of the price');
    // With every day it reads already kept, nothing is read again.
    for (const day of [...ticksOf('2026-09-01', '2026-09-10', 'day'), ...ticksOf('2026-04-04', '2026-04-13', 'day')]) {
      mkdirSync(join(routine.dir, 'fixtures', day), { recursive: true });
      writeFileSync(join(routine.dir, 'fixtures', day, 'btc.pulse.md'), PULSE_MD);
    }
    const lines = planLines({ ...planOf(routine), seconds: 33 }, context);
    expect(lines).toContain('  reads    no briefing reads from PreReason, 20 kept from before, and one read of the price');
    expect(lines).toContain('  time     about 33 seconds, at 1 second a call, as this model has answered here');
    expect([1, 59, 720, 5400].map(duration)).toEqual(['1 second', '59 seconds', '12 minutes', '1.5 hours']);
  });

  it("drops the placebo where the key cannot read that far back, and refuses a window it cannot read at all", () => {
    const routine = routineIn();
    const basic = planOf(routine, { from: '2025-03-01', to: '2025-03-10' }, 'basic');
    expect(basic.arms).toEqual(['treatment', 'control']);
    expect(basic.dropped).toEqual([{ arm: 'placebo', why: 'the placebo reads as far back as 2024-10-02, and a basic key reads from 2025-01-01' }]);
    const free = planOf(routine, { from: '2026-09-20', to: '2026-09-25' }, 'free');
    expect(free.problems).toEqual(["a free key reads from 2026-08-30, and the first tick's price table reaches back to 2026-08-21"]);
  });
});

describe('a backtest run', { timeout: 120_000 }, () => {
  it('gives every arm the same result when the answers are the same whatever the data (the zero control)', async () => {
    const { outcome } = await run(routineIn(), always('enter'));
    expect(outcome.kind).toBe('done');
    const report = outcome.report;
    if (!report) throw new Error('no report');
    const returns = report.arms.map((a) => a.reps[0]?.return);
    expect(returns[0]).toBeGreaterThan(0);
    expect(new Set(returns).size).toBe(1);
    expect(report.treatmentVsControl).toEqual([0]);
    expect(report.treatmentVsPlacebo).toEqual([0]);
    expect(report.labelsChanged).toEqual([{ rep: 1, changed: 0, compared: 10 }]);
  });

  it('shows what the data added when only the arms with briefings enter', async () => {
    const { outcome } = await run(routineIn(), briefed());
    const report = outcome.report;
    if (!report) throw new Error('no report');
    const byArm = Object.fromEntries(report.arms.map((a) => [a.arm, a.reps[0]]));
    expect(byArm.control).toMatchObject({ return: 0, trades: 0, daysInMarket: 0 });
    expect(byArm.treatment?.return).toBeGreaterThan(0);
    expect(report.treatmentVsControl[0]).toBeCloseTo(byArm.treatment?.return ?? 0, 12);
    expect(report.treatmentVsPlacebo).toEqual([0]);
    expect(report.labelsChanged).toEqual([{ rep: 1, changed: 10, compared: 10 }]);
  });

  it("fills an order at the next day's close, never the tick's own, and reads each arm's day", async () => {
    const { outcome } = await run(routineIn(), always('enter'));
    const first = outcome.records.find((r) => r.arm === 'treatment' && r.tick === '2026-09-01');
    expect(first?.fill).toMatchObject({ date: '2026-09-02', price: RISING.find((c) => c.date === '2026-09-02')?.price, toShare: 0.5 });
    expect(outcome.records.filter((r) => r.tick === '2026-09-01').map((r) => [r.arm, r.read])).toEqual([
      ['treatment', '2026-09-01'],
      ['control', null],
      ['placebo', '2026-04-04'],
    ]);
  });

  it("shows the model no price after the tick's own day", async () => {
    // The position's day, and the last close in the price table, as the model reads them.
    const seen: string[] = [];
    const model = new Scripted((p) => {
      const lines = p.text.split('\n');
      const closes = lines.filter((l) => /^\[price L\d+\] day -?\d+ \$/.test(l));
      const position = /(day -?\d+)$/.exec(lines.find((l) => l.startsWith('[position L1]')) ?? '')?.[1] ?? '';
      seen.push(`${position}:${/(day -?\d+)/.exec(closes.at(-1) ?? '')?.[1] ?? ''}`);
      return 'watch';
    });
    const routine = routineIn();
    await run(routine, model, { plan: planOf(routine, { from: '2026-09-01', to: '2026-09-03' }) });
    expect(seen).toEqual(['day 1', 'day 1', 'day 1', 'day 2', 'day 2', 'day 2', 'day 3', 'day 3', 'day 3'].map((d) => `${d}:${d}`));
  });

  it('reads each day once, keeps it, and a second run reads no briefing again', async () => {
    const routine = routineIn();
    const first = await run(routine, always('watch'));
    expect(first.source.days).toHaveLength(20);
    expect(new Set(first.source.days).size).toBe(20);
    expect(first.source.prices).toEqual([['2026-08-02', '2026-09-11']]);
    const second = await run(routine, always('watch'));
    expect(second.source.days).toEqual([]);
    expect(listBacktests(routine)).toHaveLength(2);
  });

  it('keeps what ran when stopped, and resumes at the next tick to the same result', async () => {
    const routine = routineIn();
    const stop = new AbortController();
    const model = new Scripted((p, call) => {
      if (call === 8) stop.abort();
      return p.text.includes('Briefing btc.pulse') ? 'enter' : 'watch';
    });
    const { outcome: stopped } = await run(routine, model, { signal: stop.signal });
    expect(stopped.kind).toBe('stopped');
    expect(stopped.records).toHaveLength(7);
    const { outcome: resumed } = await run(routine, model, { dir: stopped.dir });
    expect(resumed.kind).toBe('done');
    expect(resumed.records).toHaveLength(30);
    const lines = readFileSync(join(stopped.dir, 'ticks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { rep: number; arm: string; tick: string });
    expect(new Set(lines.map((l) => `${l.rep}/${l.arm}/${l.tick}`)).size).toBe(30);
    const { outcome: whole } = await run(routineIn(), briefed());
    expect(resumed.report?.arms.map((a) => a.reps[0]?.return)).toEqual(whole.report?.arms.map((a) => a.reps[0]?.return));
  });

  it('will not resume a run whose rules, routine or model changed', async () => {
    const routine = routineIn();
    const stop = new AbortController();
    const { outcome } = await run(routine, new Scripted((_p, call) => (call === 3 ? (stop.abort(), 'watch') : 'watch')), { signal: stop.signal });
    writeFileSync(routine.rulesPath, `${RULES}4. Never enter on a weekend.\n`);
    await expect(run(routine, always('watch'), { dir: outcome.dir })).rejects.toThrow(/the rules changed since this run started/);
    writeFileSync(routine.rulesPath, RULES);
    await expect(run(routine, always('watch'), { dir: outcome.dir })).resolves.toBeTruthy();
    const other = routineIn();
    const stop2 = new AbortController();
    const { outcome: again } = await run(other, new Scripted((_p, call) => (call === 2 ? (stop2.abort(), 'watch') : 'watch')), { signal: stop2.signal });
    await expect(run(other, new Scripted(() => 'watch', 'another-model'), { dir: again.dir })).rejects.toThrow(/this run started on scripted, not another-model/);
  });

  it('holds the position through a tick whose answer fails its checks, and counts it', async () => {
    const { outcome } = await run(routineIn(), new Scripted((p) => (p.text.includes('Briefing btc.pulse') ? 'enter' : null)));
    const control = outcome.report?.arms.find((a) => a.arm === 'control')?.reps[0];
    expect(control).toMatchObject({ return: 0, trades: 0, failedTicks: 10 });
    expect(outcome.records.filter((r) => r.arm === 'control').every((r) => r.label === null && r.fill === null && r.outcome === 'failed')).toBe(true);
  });

  it('holds the position through a tick whose label cites only the rules, after its repair turn', async () => {
    const routine = routineIn();
    const journal = new Journal(mkdtempSync(join(tmpdir(), 'primerkit-journal-')));
    const outcome = await runBacktest({ base: BASE, routine, model: new RulesOnly(() => 'enter'), source: new Source(), plan: planOf(routine, { from: '2026-09-01', to: '2026-09-02' }), journal, now: NOW });
    expect(outcome.records).toHaveLength(6);
    expect(outcome.records.every((r) => r.label === null && r.fill === null && r.outcome === 'failed')).toBe(true);
    expect(outcome.report?.arms.map((a) => a.reps[0]?.trades)).toEqual([0, 0, 0]);
    const day = join(journal.root, readdirSync(journal.root)[0] as string, 'routine.btc-rules');
    const meta = JSON.parse(readFileSync(join(day, outcome.records[0]?.runId as string, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ outcome: 'failed', attempts: 2, reason: 'the label cites only your rules, and no line of the data they were applied to' });
  });

  it('keeps a long position through ticks that fail, never selling for want of an answer', async () => {
    // The price only arm enters on the first tick, then every answer fails its checks.
    const model = new Scripted((p) => (p.text.includes('Briefing btc.pulse') ? 'watch' : p.text.includes('[position L1] flat') ? 'enter' : null));
    const { outcome } = await run(routineIn(), model);
    const control = outcome.records.filter((r) => r.arm === 'control');
    expect(control[0]?.fill?.toShare).toBe(0.5);
    expect(control.slice(1).every((r) => r.label === null && r.fill === null && r.after.units === control[0]?.after.units)).toBe(true);
    expect(outcome.report?.arms.find((a) => a.arm === 'control')?.reps[0]).toMatchObject({ trades: 1, failedTicks: 9, daysInMarket: 10 });
  });

  it('keeps each run in its folder and each answer in the journal, named for its tick', async () => {
    const routine = routineIn();
    const journal = new Journal(mkdtempSync(join(tmpdir(), 'primerkit-journal-')));
    const outcome = await runBacktest({ base: BASE, routine, model: always('watch'), source: new Source(), plan: planOf(routine, { from: '2026-09-01', to: '2026-09-02' }), journal, now: NOW });
    expect(readdirSync(outcome.dir).sort()).toEqual(['memory.jsonl', 'plan.json', 'prices.json', 'report.json', 'ticks.jsonl']);
    const runs = readdirSync(join(journal.root, readdirSync(journal.root)[0] as string, 'routine.btc-rules'));
    expect(runs).toHaveLength(6);
    const kept = JSON.parse(readFileSync(join(journal.root, readdirSync(journal.root)[0] as string, 'routine.btc-rules', outcome.records[2]?.runId as string, 'routine.json'), 'utf8')) as Record<string, unknown>;
    expect(kept).toMatchObject({ backtest: outcome.runId, rep: 1, arm: 'placebo', tick: '2026-09-01', read: '2026-04-04' });
  });

  it('measures buy and hold from the first fill a tick could make, with its one fee', async () => {
    const { outcome } = await run(routineIn(), always('watch'));
    const p0 = RISING.find((c) => c.date === '2026-09-02')?.price as number;
    const pEnd = RISING.find((c) => c.date === '2026-09-11')?.price as number;
    expect(outcome.report?.window.marked).toEqual({ from: '2026-09-01', to: '2026-09-11' });
    expect(outcome.report?.buyAndHold.return).toBeCloseTo(pEnd / (p0 * 1.001) - 1, 12);
  });

  it('measures the largest fall from a high', async () => {
    // Up to Sep 5, then down 20% by Sep 11.
    const peaked: Close[] = RISING.map((c) => (c.date <= '2026-09-05' ? c : { ...c, price: c.date <= '2026-09-11' ? (RISING.find((x) => x.date === '2026-09-05')?.price as number) * (1 - 0.2 * ((Date.parse(c.date) - Date.parse('2026-09-05')) / (6 * 86_400_000))) : c.price }));
    const { outcome } = await run(routineIn(), always('watch'), { source: new Source(peaked) });
    expect(outcome.report?.buyAndHold.maxDrawdown).toBeCloseTo(0.2, 9);
  });

  it("caps a label's share at the person's own cap on a position", async () => {
    const routine = routineIn();
    const { outcome } = await run(routine, always('enter'), { plan: planBacktest(routine, { ...WINDOW, maxShare: 0.25 }, { tier: 'enterprise', today: TODAY, format: 'markdown', model: 'scripted', cutoff: OUT }) });
    const first = outcome.records[0];
    expect(first).toMatchObject({ target: 0.25, capped: true });
    expect(first?.fill?.toShare).toBe(0.25);
  });

  it('shows a tick no fill dated after it, where a missing close puts the fill past the next tick', async () => {
    // No close for Sep 2: the order the Sep 1 tick places fills at Sep 3's close.
    const gap = RISING.filter((c) => c.date !== '2026-09-02');
    const seen: Array<{ last: number; since: number | null }> = [];
    const model = new Scripted((p) => {
      const lines = p.text.split('\n');
      const last = Number(/day (-?\d+)/.exec(lines.filter((l) => /^\[price L\d+\] day -?\d+ \$/.test(l)).at(-1) ?? '')?.[1]);
      const since = /since day (-?\d+)/.exec(lines.find((l) => l.startsWith('[position L1]')) ?? '')?.[1];
      seen.push({ last, since: since === undefined ? null : Number(since) });
      return 'enter';
    });
    const routine = routineIn();
    const { outcome } = await run(routine, model, { source: new Source(gap), plan: planOf(routine, { from: '2026-09-01', to: '2026-09-03' }) });
    expect(outcome.records.find((r) => r.arm === 'treatment' && r.tick === '2026-09-01')?.fill?.date).toBe('2026-09-03');
    expect(seen.filter((s) => s.since !== null && s.since > s.last)).toEqual([]);
    // CONTROL: the position is shown once its fill's day has come.
    expect(seen.some((s) => s.since !== null)).toBe(true);
  });

  it('leaves no order waiting at the end when the last label asks for what is held already', async () => {
    const routine = routineIn();
    const { outcome } = await run(routine, always('exit'), { plan: planOf(routine, { from: '2026-09-25', to: '2026-09-27' }) });
    expect(outcome.records.filter((r) => r.pending)).toEqual([]);
    expect(outcome.report?.pending).toBe(0);
  });

  it('leaves the last order waiting when no close after it exists yet', async () => {
    const routine = routineIn();
    const { outcome } = await run(routine, always('enter'), { plan: planOf(routine, { from: '2026-09-25', to: '2026-09-27' }) });
    expect(outcome.records.filter((r) => r.pending).map((r) => [r.arm, r.tick])).toEqual([
      ['treatment', '2026-09-27'],
      ['control', '2026-09-27'],
      ['placebo', '2026-09-27'],
    ]);
    expect(outcome.report?.pending).toBe(3);
  });

  it('prints the report in plain lines, and says it is not a forecast', async () => {
    const { outcome } = await run(routineIn(), briefed());
    const lines = reportLines(outcome.report as NonNullable<typeof outcome.report>);
    expect(lines[0]).toBe('btc-rules  backtest | 2026-09-01 to 2026-09-10 | every day | 10 ticks');
    expect(lines.some((l) => /^control +0\.0%/.test(l))).toBe(true);
    expect(lines).toContain('the data changed the label on 10 of 10 ticks');
    expect(lines).toContain('A simulation on past data: not a forecast, and not advice.');
    expect(existsSync(join(outcome.dir, 'report.json'))).toBe(true);
  });

  it('writes every date in a packet as a day number, and the checks hold on those lines', async () => {
    const packets: string[] = [];
    const routine = routineIn();
    const { outcome } = await run(routine, new Scripted((p) => (packets.push(p.text), 'enter')), { plan: planOf(routine, { from: '2026-09-01', to: '2026-09-03' }) });
    expect(outcome.records.every((r) => r.label === 'enter')).toBe(true);
    expect(packets).toHaveLength(9);
    for (const text of packets) expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b|\b(Sep|Aug|Apr) \d{1,2}, 2026\b/);
    expect(packets[0]).toContain("[price L1] Bitcoin's daily price in US dollars, from day -29 to day 1, oldest first");
    // Read on day 28, the briefing is stamped with the day it stands for.
    expect(packets[0]).toContain('Briefing btc.pulse, markdown, generated day 1:');
    expect(packets[0]).toContain('*Data as of: day 1 09:04 UTC (2 of 3 metrics)*');
    expect(outcome.report?.notes).toContain("Dates in the packets were day numbers from the window's first day; prices and levels still hint at the period.");
  });

  it('says a window after the model training is out of sample', async () => {
    const { outcome } = await run(routineIn(), always('watch'));
    expect(outcome.report?.sample).toEqual({ kind: 'out', line: "Out of sample: scripted's training reaches 2024-01, as you gave it, before the window." });
    expect(outcome.report?.notes[0]).toBe(outcome.report?.sample.line);
    expect(outcome.report?.memory?.answers.map((a) => a.date)).toEqual(['2026-09-01', '2026-09-05', '2026-09-10']);
  });

  it('stops before the first tick when the model remembers the window, and runs labelled on your yes', async () => {
    const routine = routineIn();
    // A model that recalls each close to within 1%, with no data.
    const recalls = new Scripted(() => 'watch', 'scripted', (date) => (RISING.find((c) => c.date === date)?.price ?? 0) * 1.01);
    const { outcome } = await run(routine, recalls);
    expect(outcome.kind).toBe('remembered');
    expect(outcome.records).toEqual([]);
    expect(recalls.calls).toBe(0);
    expect(outcome.stopped).toBe('scripted gave 3 of 3 Bitcoin closes in the window within 5%, asked with no data, so it remembers the window; it runs only on your yes, and every result then says it is inside the model\'s training window');
    // The memory is not asked twice, and the yes lets the run go on.
    const again = await runBacktest({ base: BASE, routine, model: recalls, source: new Source(), dir: outcome.dir, insideTraining: true, now: NOW });
    expect(again.kind).toBe('done');
    expect(recalls.memory).toHaveLength(3);
    expect(again.report?.sample.kind).toBe('inside');
    expect(again.report?.notes[0]).toBe("Inside the model's training window: scripted gave 3 of 3 closes in it within 5% with no data, and you said yes to running it.");
  });

  it('holds a window inside the model training for your yes, and lets the memory check decide for a cutoff it does not know', () => {
    const routine = routineIn();
    const inside = { cutoff: '2026-12', source: 'given for this test', basis: 'person' as const };
    expect(planOf(routine, WINDOW, 'enterprise', inside).problems).toEqual([
      "the window starts on 2026-09-01, inside scripted's training, which reaches 2026-12 (given for this test); it runs only on your yes, and every result then says it is inside the model's training window",
    ]);
    const yes = planOf(routine, { ...WINDOW, insideTraining: true }, 'enterprise', inside);
    expect(yes.problems).toEqual([]);
    expect(yes.sample.kind).toBe('inside');
    const unknown = planOf(routine, WINDOW, 'enterprise', null);
    expect(unknown.problems).toEqual([]);
    expect(unknown.sample.kind).toBe('unknown');
    expect(planLines(unknown, { model: 'scripted, local', local: true, secondsPerCall: null })).toContain(
      "  sample   scripted's training cutoff is not known, so the memory check decides, on Bitcoin's close on 2026-09-01, 2026-09-05 and 2026-09-10",
    );
  });

  it('runs a model whose cutoff is not known when the memory check finds no memory, and says the check decided, on which closes', async () => {
    const routine = routineIn();
    const forgets = always('watch');
    const { outcome } = await run(routine, forgets, { plan: planOf(routine, WINDOW, 'enterprise', null) });
    expect(outcome.kind).toBe('done');
    expect(forgets.memory).toEqual(['2026-09-01', '2026-09-05', '2026-09-10']);
    expect(outcome.report?.sample.kind).toBe('out');
    expect(outcome.report?.notes[0]).toBe(
      "Out of sample as far as the memory check shows: scripted's training cutoff is not known, and asked with no data for Bitcoin's close on 2026-09-01, 2026-09-05 and 2026-09-10, it gave 0 of 3 within 5%.",
    );
    // One that remembers stops for the yes, as with a known cutoff.
    const recalls = new Scripted(() => 'watch', 'scripted', (date) => (RISING.find((c) => c.date === date)?.price ?? 0) * 1.01);
    const second = routineIn();
    const stopped = await run(second, recalls, { plan: planOf(second, WINDOW, 'enterprise', null) });
    expect(stopped.outcome.kind).toBe('remembered');
    expect(recalls.calls).toBe(0);
  });

  it("hides the placebo's age: its briefing reads as the treatment's does, tick for tick", async () => {
    // Ticks run in order, and within a tick the arms: treatment, control, placebo.
    const packets: string[] = [];
    const routine = routineIn();
    const { outcome } = await run(routine, new Scripted((p) => (packets.push(p.text), 'watch')), { plan: planOf(routine, { from: '2026-09-01', to: '2026-09-03' }) });
    const briefing = (text: string): string => text.split('\n').filter((l) => l.startsWith('Briefing btc.pulse') || l.startsWith('[btc.pulse L')).join('\n');
    for (let tick = 0; tick < 3; tick++) {
      const [treatment, control, placebo] = packets.slice(tick * 3, tick * 3 + 3) as [string, string, string];
      expect(briefing(treatment)).toContain(`*Data as of: day ${tick + 1} 09:04 UTC (2 of 3 metrics)*`);
      expect(briefing(control)).toBe('');
      expect(briefing(placebo)).toBe(briefing(treatment));
    }
    // It read 150 days back all the same, and the report says what was hidden and what was not.
    expect(outcome.records.filter((r) => r.arm === 'placebo').map((r) => r.read)).toEqual(['2026-04-04', '2026-04-05', '2026-04-06']);
    expect(outcome.report?.notes).toContain("The placebo read its briefings 150 days before each tick. They were dated as if they were the tick's own, so their age did not show in the packet; their levels still differ.");
    expect(outcome.report?.notes).toContain("Each briefing is read as PreReason's stored data stood that day, and stamped with that day. A series revised since then is read revised.");
  });

  it('keeps a run started before the age was hidden dated as it started', async () => {
    const routine = routineIn();
    const source = new Source();
    const started = await BacktestRun.start({ routine, plan: planOf(routine), model: 'scripted', source, now: NOW });
    if (!started) throw new Error('no rules');
    const placebo = { rep: 1, arm: 'placebo' as const, tick: '2026-09-01' };
    const pulse = async (r: BacktestRun) => (await r.blocks(placebo, source, NOW)).find((b) => b.id === 'btc.pulse')?.lines ?? [];
    expect(await pulse(started)).toContain('*Data as of: day 1 09:04 UTC (2 of 3 metrics)*');
    expect(await pulse(started)).toContain('*Generated: day 1*');
    // The same run with the plan it would have had before: its placebo shows its age.
    const path = join(started.dir, 'plan.json');
    const older = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete older.blind;
    writeFileSync(path, JSON.stringify(older));
    const reopened = await BacktestRun.open({ dir: started.dir, routine, model: 'scripted', source, now: NOW });
    if (!reopened) throw new Error('no rules');
    expect(await pulse(reopened)).toContain('*Data as of: day -149 09:04 UTC (2 of 3 metrics)*');
    expect(await pulse(reopened)).toContain('*Generated: day 28 12:00 UTC*');
  });

  it("draws the same account the report measures: each curve ends at its arm's return", async () => {
    const routine = routineIn();
    const { outcome } = await run(routine, briefed());
    const report = outcome.report as NonNullable<typeof outcome.report>;
    const run0 = JSON.parse(readFileSync(join(outcome.dir, 'plan.json'), 'utf8'));
    const closes = (JSON.parse(readFileSync(join(outcome.dir, 'prices.json'), 'utf8')) as { closes: Close[] }).closes;
    const curves = curvesOf(run0, outcome.records, closes);
    expect(curves.marked).toEqual(report.window.marked);
    for (const a of report.arms) {
      const marks = curves.arms.find((c) => c.arm === a.arm && c.rep === 1)?.marks ?? [];
      expect(marks[0]?.date).toBe('2026-09-01');
      expect((marks.at(-1)?.equity ?? 0) / START_EQUITY - 1).toBeCloseTo(a.reps[0]?.return ?? NaN, 12);
    }
    expect((curves.buyAndHold.marks.at(-1)?.equity ?? 0) / START_EQUITY - 1).toBeCloseTo(report.buyAndHold.return, 12);
  });
});
