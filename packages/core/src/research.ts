import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { curveOf, fillTo, startHoldings, statsOf, type Fill, type Holdings, type Mark } from './backtest-account';
import { backtestsDir, readReplay, type Arm, type Replay, type RunFile, type TickRecord } from './backtest';
import { readForward } from './forward';
import { frozenCard, readVersions, successPoints, type Card, type CardVersion } from './hypothesis';
import { ROUTINE_NAME, addDays, daysBetween, routinesDir, type Close } from './routine';

// The research view: a routine's newest backtest read against the person's own card, as a
// ladder of five hurdles, top to bottom, stopping at the first one not passed. Every figure
// is code's, from the run's own folder: no model is asked, and nothing is read. The model
// never proposes a strategy; the card, the rules and the criteria are the person's own.
//
//   H1 raw edge         treatment against control and placebo, on the card's success criterion
//   H2 realistic costs  the same after the spread the person sets in routine.yaml, never assumed
//   H3 robustness       nearby sizes, fees and start days, re-run from the labels the run recorded
//   H4 out of sample    after the model's cutoff, and within each regime of the data it read
//   H5 significance     a seeded bootstrap interval for the edge over control

export type HurdleId = 'H1' | 'H2' | 'H3' | 'H4' | 'H5';
export type HurdleStatus = 'passed' | 'failed' | 'stopped' | 'not run';

export const HURDLE_NAMES: Record<HurdleId, string> = { H1: 'raw edge', H2: 'realistic costs', H3: 'robustness', H4: 'out of sample', H5: 'significance' };

export interface Hurdle {
  id: HurdleId;
  status: HurdleStatus;
  text: string; // what was measured, in words
  reason: string | null; // why it was not passed, as the ladder's last line says it
}

export interface Ladder {
  routine: string;
  runId: string;
  version: number | null; // the card version frozen with the run
  window: { from: string; to: string };
  hurdles: Hurdle[]; // top to bottom, through the first not passed
  end: { id: HurdleId; status: Exclude<HurdleStatus, 'passed'>; reason: string } | null; // null when all five passed
  falsified: boolean; // the person's own success criterion was not met, at H1 or H2
}

// A regime window with fewer days than this reads "too few days to test", never passed.
export const MIN_WINDOW_DAYS = 10;
// H3 passes when the edge stays above control on at least this share of the settings re-run.
export const ROBUST_SHARE = 0.75;
export const RESAMPLES = 2000;

// The nearby settings H3 re-runs: each label's share a fifth and a tenth lower and higher,
// the person's fee halved, half again and doubled, and the account opened a tick or two
// later. Each is a step from the person's own setting, never a number of primerkit's.
export type Setting = { kind: 'size'; factor: number } | { kind: 'fee'; factor: number } | { kind: 'start'; ticks: number };
export const NEARBY: readonly Setting[] = [
  { kind: 'size', factor: 0.8 },
  { kind: 'size', factor: 0.9 },
  { kind: 'size', factor: 1.1 },
  { kind: 'size', factor: 1.2 },
  { kind: 'fee', factor: 0.5 },
  { kind: 'fee', factor: 1.5 },
  { kind: 'fee', factor: 2 },
  { kind: 'start', ticks: 1 },
  { kind: 'start', ticks: 2 },
];

// ------------------------------------------------------------------ the account, re-run

interface Row {
  tick: string;
  after: Holdings;
  fill: Fill | null;
  failed: boolean;
}

interface Terms {
  scale: number; // each label's share times this, within 0 and 1
  fee: number; // the share of a trade taken off as its cost
  start: string; // the tick the account opens at; it is flat until then
}

// One arm's ticks re-run through the simulated account, from the labels the run recorded, as
// BacktestRun.record settles them: the label's share, within the person's cap, filled at the
// next close; a hold label or no label keeps what is held.
// The ticks and the closes both run oldest first, so the close after each tick is found by
// walking the two together.
function rerun(run: RunFile, mine: TickRecord[], closes: Close[], terms: Terms): Row[] {
  let held = startHoldings();
  let k = 0;
  return mine.map((r): Row => {
    while (k < closes.length && (closes[k] as Close).date <= r.tick) k++;
    if (r.tick < terms.start) return { tick: r.tick, after: held, fill: null, failed: false };
    const means = r.label ? run.spec.labels.find((l) => l.name === r.label)?.means : undefined;
    const wanted = means?.kind === 'target' ? Math.min(1, means.share * terms.scale) : null;
    const target = wanted === null ? null : Math.min(wanted, run.maxShare ?? 1);
    const next = closes[k];
    let fill: Fill | null = null;
    if (target !== null && next) ({ holdings: held, fill } = fillTo(held, target, next.price, terms.fee, next.date));
    return { tick: r.tick, after: held, fill, failed: r.label === null };
  });
}

// What each tick from `from` on was shown of the account: the position block's facts (flat,
// or long since a day at a price), as BacktestRun.heldAt finds them: every fill dated by the
// tick's own close. The model never sees a size or a fee.
function shown(rows: ReadonlyArray<{ tick: string; after: Holdings; fill: Fill | null }>, from: string): string[] {
  const filled = rows.filter((r) => r.fill);
  const out: string[] = [];
  let next = 0;
  let held = startHoldings();
  for (const r of rows) {
    while (next < filled.length && (filled[next]?.fill as Fill).date <= r.tick) held = (filled[next++] as Row).after;
    if (r.tick >= from) out.push(held.units > 0 && held.entry ? `long since ${held.entry.date} at ${held.entry.price}` : 'flat');
  }
  return out;
}

interface Account {
  returns: Partial<Record<Arm, number>>; // each arm's return, the mean over its repeats
  marks: Partial<Record<Arm, Mark[][]>>; // each arm's account at every close, a list a repeat
  same: boolean; // every tick read the position the run recorded, so its label stands
}

// The treatment and control accounts under other terms. A label is the model's answer to
// the packet its tick read, so it stands only where every tick would read the same packet:
// the position block alone could differ, so each is checked against what the run showed.
function account(replay: Replay, terms: Terms): Account {
  const { run, records } = replay;
  const closes = [...replay.closes].sort((a, b) => a.date.localeCompare(b.date));
  const to = replay.curves.marked.to;
  const out: Account = { returns: {}, marks: {}, same: true };
  for (const arm of ['treatment', 'control'] as Arm[]) {
    if (!run.arms.includes(arm)) continue;
    const returns: number[] = [];
    const marks: Mark[][] = [];
    for (let rep = 1; rep <= run.reps; rep++) {
      const mine = records.filter((r) => r.rep === rep && r.arm === arm).sort((a, b) => a.tick.localeCompare(b.tick));
      const rows = rerun(run, mine, closes, terms);
      if (shown(rows, terms.start).join('\n') !== shown(mine, terms.start).join('\n')) out.same = false;
      const changes = rows.filter((r) => r.fill).map((r) => ({ date: (r.fill as Fill).date, holdings: r.after }));
      const curve = curveOf(closes, changes, terms.start, to);
      const stats = statsOf(
        curve,
        rows.flatMap((r) => (r.fill ? [r.fill] : [])),
        rows.filter((r) => r.failed).length,
      );
      returns.push(stats.return);
      marks.push(curve);
    }
    out.returns[arm] = mean(returns);
    out.marks[arm] = marks;
  }
  return out;
}

// ------------------------------------------------------------------ regimes and the interval

// Each day's return of treatment and control after costs, the mean over the repeats, with
// the close before it: the day a regime is read on, as known when the day began.
interface DayPair {
  prior: string;
  t: number;
  c: number;
}

function dayPairs(a: Account): DayPair[] {
  const t = a.marks.treatment ?? [];
  const c = a.marks.control ?? [];
  const first = t[0] ?? [];
  const out: DayPair[] = [];
  for (let i = 1; i < first.length; i++) {
    const daily = (curves: Mark[][]) => mean(curves.map((m) => (m[i] as Mark).equity / (m[i - 1] as Mark).equity - 1));
    out.push({ prior: (first[i - 1] as Mark).date, t: daily(t), c: daily(c) });
  }
  return out;
}

// Bitcoin's 30 day realised volatility at a close: the spread of its daily log returns over
// the 30 days to it. Null where the run's prices do not reach back that far.
function volatility(closes: Close[], day: string): number | null {
  const from = addDays(day, -30);
  if (!closes[0] || closes[0].date > from) return null;
  const span = closes.filter((c) => c.date >= from && c.date <= day);
  if (span.length < 3) return null;
  const logs = span.slice(1).map((c, i) => Math.log(c.price / (span[i] as Close).price));
  const m = mean(logs);
  return Math.sqrt(mean(logs.map((x) => (x - m) ** 2)));
}

// Whether the close is above its 200 day average, or null where the prices do not reach
// back 200 days.
function aboveAverage(closes: Close[], day: string): boolean | null {
  const from = addDays(day, -199);
  if (!closes[0] || closes[0].date > from) return null;
  const span = closes.filter((c) => c.date >= from && c.date <= day);
  const close = span.at(-1);
  if (!close || close.date !== day) return null;
  return close.price > mean(span.map((c) => c.price));
}

interface Window {
  name: string;
  days: DayPair[];
}

const edgeOf = (days: DayPair[]): number => days.reduce((g, d) => g * (1 + d.t), 1) - days.reduce((g, d) => g * (1 + d.c), 1);

// A generator of numbers from 0 to 1 from a seed, so an interval is the same each time it
// is drawn (mulberry32).
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seed a run's interval is drawn with: from its id, so the same run gives the same
// interval on every screen.
export const seedOf = (runId: string): number => Number.parseInt(createHash('sha256').update(runId).digest('hex').slice(0, 8), 16);

// The 95% bootstrap interval for treatment's edge over control: the days drawn again with
// replacement, the edge measured on each draw, and the middle 95% of the draws kept.
export function bootstrapInterval(pairs: ReadonlyArray<{ t: number; c: number }>, seed: number, resamples = RESAMPLES): { low: number; high: number } {
  if (!pairs.length) return { low: 0, high: 0 };
  const draw = seeded(seed);
  const edges: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let t = 1;
    let c = 1;
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[Math.floor(draw() * pairs.length)] as { t: number; c: number };
      t *= 1 + p.t;
      c *= 1 + p.c;
    }
    edges.push(t - c);
  }
  edges.sort((a, b) => a - b);
  return { low: edges[Math.floor(0.025 * (resamples - 1))] as number, high: edges[Math.ceil(0.975 * (resamples - 1))] as number };
}

// ------------------------------------------------------------------ the ladder

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
// A return as the ladder writes it: 2.4%, -0.3%, 0.0%.
const pct = (x: number): string => `${Math.round(x * 1000) < 0 ? '-' : ''}${Math.abs(x * 100).toFixed(1)}%`;
const points = (x: number): string => `${Math.round(x * 1000) < 0 ? '-' : ''}${Math.abs(x * 100).toFixed(1)}`;
// A fee to two places, or more where it has them: 0.10%, 0.025%.
const feeText = (fee: number): string => {
  const v = fee * 100;
  return `${Number(v.toFixed(2)) === Number(v.toFixed(6)) ? v.toFixed(2) : String(Number(v.toFixed(6)))}%`;
};
const EPSILON = 1e-9;

// The ladder for one finished run and the card frozen with it. options.seed fixes the
// interval's draws; the run's id seeds them otherwise.
export function ladderOf(replay: Replay, card: Card | null, options: { seed?: number; resamples?: number } = {}): Ladder {
  const { run, report } = replay;
  const hurdles: Hurdle[] = [];
  const ladder = (falsified = false): Ladder => {
    const last = hurdles.at(-1);
    const end = last && last.status !== 'passed' ? { id: last.id, status: last.status, reason: last.reason ?? '' } : null;
    return { routine: run.routine, runId: run.runId, version: run.hypothesis?.version ?? null, window: { from: run.from, to: run.to }, hurdles, end, falsified };
  };
  const stop = (id: HurdleId, status: Exclude<HurdleStatus, 'passed'>, text: string, reason: string, falsified = false): Ladder => {
    hurdles.push({ id, status, text, reason });
    return ladder(falsified);
  };
  const meanOf = (arm: Arm): number | null => report.arms.find((a) => a.arm === arm)?.mean.return ?? null;
  const t = meanOf('treatment');
  const c = meanOf('control');
  const p = meanOf('placebo');

  // H1: the run's own returns, with the person's fee, against the card's one number.
  if (!card) return stop('H1', 'stopped', 'no card was frozen with this backtest: write hypothesis.md before the next one', 'no card was frozen with this backtest');
  if (t === null || c === null) return stop('H1', 'stopped', 'the backtest has no treatment and control to compare', 'the backtest has no treatment and control to compare');
  const success = successPoints(card);
  if ('why' in success) return stop('H1', 'stopped', success.why, success.why);
  const need = success.points / 100;
  const repeats = run.reps > 1 ? `, on average over ${run.reps} repeats` : '';
  const h1 = `treatment returned ${pct(t)} against control ${pct(c)}${p === null ? '' : ` and placebo ${pct(p)}`} over the backtest${repeats}, on your success criterion (${card.fields.success})`;
  if (t - c + EPSILON < need) return stop('H1', 'failed', h1, `treatment's lead over control was ${points(t - c)} points; your success criterion asks for ${success.points}`, true);
  if (p !== null && t - p + EPSILON < need) return stop('H1', 'failed', h1, `treatment's lead over placebo was ${points(t - p)} points; your success criterion asks for ${success.points}`, true);
  hurdles.push({ id: 'H1', status: 'passed', text: h1, reason: null });

  // H2: the spread the person set when the run started, half of it on every trade on top of
  // the fee. None is ever assumed.
  const spread = run.spec.spreadBps;
  if (spread === undefined || spread === null) return stop('H2', 'stopped', 'no spread set: add spread_bps to routine.yaml', 'no spread set');
  const fee = run.spec.fees.perTrade ?? 0;
  const costed = fee + spread / 20_000;
  const first = run.ticks[0] as string;
  const base = account(replay, { scale: 1, fee: costed, start: first });
  const tc = base.returns.treatment ?? 0;
  const cc = base.returns.control ?? 0;
  const h2 = `at your spread of ${spread} bps and fee of ${feeText(fee)}, treatment returned ${pct(tc)} after costs (control ${pct(cc)})`;
  if (tc - cc + EPSILON < need) return stop('H2', 'failed', h2, `after costs, treatment's lead over control was ${points(tc - cc)} points; your success criterion asks for ${success.points}`, true);
  hurdles.push({ id: 'H2', status: 'passed', text: h2, reason: null });

  // H3: each nearby setting re-run from the recorded labels, after costs, where every tick
  // would have read the same position; a setting that changes it is left out, not counted.
  // A step that leaves the setting as the person's own (a size past its cap, any step of a
  // fee of 0) is not a nearby setting, and would always pass: it is left out too, and named.
  const cap = Math.min(1, run.maxShare ?? 1);
  const shares = run.spec.labels.flatMap((l) => (l.means.kind === 'target' ? [l.means.share] : []));
  const held = (share: number, scale: number): number => Math.min(1, share * scale, cap);
  const yours = (s: Setting): string | null => {
    if (s.kind === 'size' && shares.every((x) => held(x, s.factor) === held(x, 1))) return shares.some((x) => x > 0 && x * s.factor >= cap) ? `size capped at ${cap === 1 ? '1' : `your cap of ${cap}`}` : 'no target above 0';
    if (s.kind === 'fee' && fee * s.factor === fee) return 'fee 0';
    return null;
  };
  const copies: string[] = [];
  const settings = NEARBY.flatMap((s) => {
    const start = s.kind === 'start' ? run.ticks[s.ticks] : first;
    if (!start) return [];
    const copy = yours(s);
    if (copy) {
      copies.push(copy);
      return [];
    }
    const a = account(replay, { scale: s.kind === 'size' ? s.factor : 1, fee: s.kind === 'fee' ? fee * s.factor + spread / 20_000 : costed, start });
    return [{ same: a.same, edge: (a.returns.treatment ?? 0) - (a.returns.control ?? 0) }];
  });
  const why = [...new Set(copies)].join('; ');
  const equal = copies.length ? `${copies.length} ${copies.length === 1 ? 'setting' : 'settings'} left out: equal to yours (${why})` : '';
  if (!settings.length) return stop('H3', 'not run', `not run: every nearby setting is equal to yours (${why})`, 'every nearby setting is equal to yours');
  const rerunnable = settings.filter((s) => s.same);
  const left = settings.length - rerunnable.length;
  if (!rerunnable.length) return stop('H3', 'not run', `not run: every nearby setting changes the position your labels read, which would need new model calls${equal ? `; ${equal}` : ''}`, 'every nearby setting changes the position your labels read');
  const above = rerunnable.filter((s) => s.edge > EPSILON).length;
  const h3 = `the edge stays above control on ${above} of ${rerunnable.length} nearby settings (sizes, fees, start day)${equal ? `; ${equal}` : ''}${left ? `; ${left} not re-run, as ${left === 1 ? 'it changes' : 'they change'} the position your labels read` : ''}`;
  if (above < ROBUST_SHARE * rerunnable.length - EPSILON) return stop('H3', 'failed', h3, `the edge stays above control on ${above} of ${rerunnable.length} nearby settings, fewer than three quarters`);
  hurdles.push({ id: 'H3', status: 'passed', text: h3, reason: null });

  // H4: out of sample, then each regime window of the prices the run read, with its size.
  if (report.sample.kind === 'inside') return stop('H4', 'failed', "the backtest window is inside the model's training, so it is not out of sample", "the backtest window is inside the model's training");
  const where = run.sample?.kind === 'out' ? "after the model's cutoff" : 'out of sample as far as the memory check shows';
  const pairs = dayPairs(base);
  const closes = [...replay.closes].sort((a, b) => a.date.localeCompare(b.date));
  const vols = pairs.map((d) => volatility(closes, d.prior));
  const known = vols.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const middle = known.length ? ((known[Math.floor((known.length - 1) / 2)] as number) + (known[Math.ceil((known.length - 1) / 2)] as number)) / 2 : 0;
  const trend = pairs.map((d) => aboveAverage(closes, d.prior));
  const windows: Window[] = [
    { name: 'in high volatility', days: pairs.filter((_, i) => vols[i] !== null && (vols[i] as number) > middle) },
    { name: 'in low volatility', days: pairs.filter((_, i) => vols[i] !== null && (vols[i] as number) <= middle) },
    { name: 'above the 200 day average', days: pairs.filter((_, i) => trend[i] === true) },
    { name: 'below the 200 day average', days: pairs.filter((_, i) => trend[i] === false) },
  ];
  const [high, low, up, down] = windows as [Window, Window, Window, Window];
  let h4 = `${where}; in high and low volatility (30 day realised; ${high.days.length} and ${low.days.length} days), above and below the 200 day average (${up.days.length} and ${down.days.length} days)`;
  const thin = windows.filter((w) => w.days.length < MIN_WINDOW_DAYS);
  if (thin.length) {
    const what = windowNames(thin);
    const short = vols.includes(null) || trend.includes(null) ? `, as the run's prices begin ${Math.max(0, daysBetween(closes[0]?.date ?? first, first))} days before the window` : '';
    h4 += `: too few days to test ${what}${short}`;
    return stop('H4', 'stopped', h4, `too few days to test ${what}`);
  }
  const under = windows.filter((w) => edgeOf(w.days) <= EPSILON);
  if (under.length) {
    h4 += `; treatment did not stay above control ${windowNames(under)}`;
    return stop('H4', 'failed', h4, `treatment did not stay above control ${windowNames(under)}`);
  }
  hurdles.push({ id: 'H4', status: 'passed', text: h4, reason: null });

  // H5: the interval for the edge over control after costs, drawn from the run's own days.
  const { low: from, high: to } = bootstrapInterval(pairs, options.seed ?? seedOf(run.runId), options.resamples ?? RESAMPLES);
  const span = `(${pct(from)} to ${pct(to)})`;
  if (from > 0) hurdles.push({ id: 'H5', status: 'passed', text: `the edge over control's 95% interval is above zero ${span}`, reason: null });
  else if (to < 0) return stop('H5', 'failed', `the edge over control's 95% interval is below zero ${span}`, "the edge over control's interval is below zero");
  else return stop('H5', 'failed', `the edge over control's 95% interval includes zero ${span}`, "the edge over control's interval includes zero");
  return ladder();
}

// Regime windows named as a sentence reads them: a pair whose both sides are named once.
function windowNames(windows: Window[]): string {
  const names = windows.map((w) => w.name);
  const parts: string[] = [];
  if (names.includes('in high volatility') && names.includes('in low volatility')) parts.push('in high and low volatility');
  else parts.push(...names.filter((n) => n.endsWith('volatility')));
  if (names.includes('above the 200 day average') && names.includes('below the 200 day average')) parts.push('above and below the 200 day average');
  else parts.push(...names.filter((n) => n.endsWith('average')));
  return parts.join(' and ');
}

// ------------------------------------------------------------------ the registry

// A version's status is its frozen test's: the first of its backtests to finish with its
// result (its report written), so a later run never moves it. Testing until one has; a
// frozen test whose ladder stopped short of a verdict stops the version there; and one that
// cannot be read is not read, never handing its place to a later run.
export type RegistryStatus =
  | { kind: 'testing' }
  | { kind: 'passed' }
  | { kind: 'failed'; hurdle: HurdleId; reason: string; falsified: boolean }
  | { kind: 'stopped'; hurdle: HurdleId; reason: string }
  | { kind: 'unread' };

// A backtest of a version other than its frozen test, with its own result: null while it
// has not finished, as when it was cancelled, ended by an error or is still going.
export interface LaterRun {
  runId: string;
  window: { from: string; to: string };
  status: RegistryStatus | null;
}

export interface RegistryRow {
  routine: string;
  version: number;
  frozenAt: string;
  status: RegistryStatus; // the frozen test's
  frozenRun: string | null; // the frozen test's run, where it is known and read
  later: LaterRun[]; // the version's other backtests: those finished, as they finished, then the rest
  forwardSince: string | null; // the first day of the forward record since the version froze
}

export interface Registry {
  rows: RegistryRow[];
  backtests: number; // every backtest of every version, finished or not
  damaged: Array<{ routine: string; runId: string }>; // backtests not read, as a file in each is damaged
}

// The routine folders that keep card versions, by name.
function researchedRoutines(home: string): Array<{ name: string; dir: string }> {
  const root = routinesDir(home);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => ROUTINE_NAME.test(name))
    .map((name) => ({ name, dir: join(root, name) }))
    .filter((r) => readVersions(r.dir).length > 0);
}

// A backtest of one of a routine's card versions, as its plan says, and whether it finished.
interface Tried {
  runId: string;
  dir: string;
  run: RunFile | null; // null where its plan cannot be read, so the version it tested is not known
  done: boolean; // its report is there: it finished
}

// Every backtest of a routine's card versions, oldest first, finished or not: only its plan
// is read. One whose plan cannot be read is named in `damaged` and kept, as it may be one of
// them: a damaged folder never stops the registry, and never drops out of the count.
function triedOf(r: { name: string; dir: string }, versions: CardVersion[], damaged: Registry['damaged']): Tried[] {
  const root = backtestsDir(r);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .flatMap((runId): Tried[] => {
      const dir = join(root, runId);
      if (!existsSync(join(dir, 'plan.json'))) return [];
      const done = existsSync(join(dir, 'report.json'));
      let run: RunFile;
      try {
        run = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as RunFile;
      } catch {
        damaged.push({ routine: r.name, runId });
        return [{ runId, dir, run: null, done }];
      }
      const stamp = run.hypothesis;
      if (!stamp || !versions.some((v) => v.version === stamp.version && v.hash === stamp.hash)) return [];
      return [{ runId, dir, run, done }];
    });
}

// When a run started, to the second, from its id (20261010T100000Z-abc123); empty where the
// id is not one primerkit made, so the start is not known.
function startOfId(runId: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(runId);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : '';
}
const toSecond = (iso: string): string => iso.slice(0, 19);

// Whether a run whose plan cannot be read may have tested version v: it froze v (its id is
// the one v keeps), or it froze no version and did not start before v froze.
function mayBe(runId: string, v: CardVersion, versions: CardVersion[]): boolean {
  const froze = versions.find((x) => x.runId === runId);
  if (froze) return froze.version === v.version;
  const start = startOfId(runId);
  return start === '' || start >= toSecond(v.frozenAt);
}

// When a finished run that cannot be read whole finished, from its report where that is
// read; null where it is not known.
function finishOf(b: Tried): string | null {
  try {
    const report = JSON.parse(readFileSync(join(b.dir, 'report.json'), 'utf8')) as { finishedAt?: string };
    return report.finishedAt ?? b.run?.startedAt ?? null;
  } catch {
    return null;
  }
}

// How many hypotheses and versions have been tested on this machine, and in how many
// backtests: every backtest of a version counts, one cancelled or ended by an error too.
export function trialsOf(home: string): { versions: number; backtests: number } {
  let versions = 0;
  let backtests = 0;
  for (const r of researchedRoutines(home)) {
    const frozen = readVersions(r.dir);
    versions += frozen.length;
    backtests += triedOf(r, frozen, []).length;
  }
  return { versions, backtests };
}

// A finished backtest's result, as its ladder ends.
function verdictOf(replay: Replay, card: Card | null): RegistryStatus {
  const ladder = ladderOf(replay, card);
  if (!ladder.end) return { kind: 'passed' };
  if (ladder.end.status === 'failed') return { kind: 'failed', hurdle: ladder.end.id, reason: ladder.end.reason, falsified: ladder.falsified };
  return { kind: 'stopped', hurdle: ladder.end.id, reason: ladder.end.reason };
}

type Finished = { b: Tried & { run: RunFile }; at: string; status: RegistryStatus };

// One version's frozen test and its other backtests. Each finished one is read whole and
// ordered by when it finished; a run finished before that was kept is placed by when it
// started, which is no later. A finished run that cannot be read is named, and never hands
// its place on: where it finished first, or may have (its finish not known, and its start no
// later than the first read run's finish), the frozen test is not read, and no later run's
// result stands in for it.
function testsOf(r: { name: string; dir: string }, v: CardVersion, versions: CardVersion[], tried: Tried[], damaged: Registry['damaged']): { status: RegistryStatus; frozenRun: string | null; later: LaterRun[] } {
  const card = frozenCard(r.dir, v.version);
  const mine = tried.filter((b) => (b.run ? b.run.hypothesis?.version === v.version && b.run.hypothesis.hash === v.hash : mayBe(b.runId, v, versions)));
  const finished: Finished[] = [];
  const unread: Array<{ at: string | null; start: string }> = [];
  for (const b of mine.filter((m) => m.done)) {
    try {
      if (!b.run) throw new Error('its plan cannot be read');
      const replay = readReplay(b.dir) as Replay;
      finished.push({ b: b as Finished['b'], at: replay.report.finishedAt ?? b.run.startedAt, status: verdictOf(replay, card) });
    } catch {
      // A plan that cannot be read is named where it is found.
      if (b.run) damaged.push({ routine: r.name, runId: b.runId });
      unread.push({ at: finishOf(b), start: b.run?.startedAt ?? startOfId(b.runId) });
    }
  }
  finished.sort((x, y) => x.at.localeCompare(y.at) || x.b.runId.localeCompare(y.b.runId));
  const [frozen, ...after] = finished;
  const listed = (runs: Finished[]): LaterRun[] => runs.map((f) => ({ runId: f.b.runId, window: { from: f.b.run.from, to: f.b.run.to }, status: f.status }));
  const open = mine.flatMap((b): LaterRun[] => (!b.done && b.run ? [{ runId: b.runId, window: { from: b.run.from, to: b.run.to }, status: null }] : []));
  const first = (u: { at: string | null; start: string }): boolean => !frozen || (u.at !== null ? u.at <= frozen.at : !(toSecond(u.start) > toSecond(frozen.at)));
  if (unread.some(first)) return { status: { kind: 'unread' }, frozenRun: null, later: [...listed(finished), ...open] };
  // Until one has finished, every backtest is still the one that may be the frozen test.
  if (!frozen) return { status: { kind: 'testing' }, frozenRun: null, later: [] };
  return { status: frozen.status, frozenRun: frozen.b.runId, later: [...listed(after), ...open] };
}

// The frozen test of the version a run's card was frozen as, as the registry reads it: its
// run, where known and read, and its status. Null where the version is not kept.
export function frozenTestOf(routine: { name: string; dir: string }, stamp: { version: number; hash: string }): { runId: string | null; status: RegistryStatus } | null {
  const versions = readVersions(routine.dir);
  const v = versions.find((x) => x.version === stamp.version && x.hash === stamp.hash);
  if (!v) return null;
  const { status, frozenRun } = testsOf(routine, v, versions, triedOf(routine, versions, []), []);
  return { runId: frozenRun, status };
}

// Every hypothesis and version on this machine with its status, by the routine's name and
// then the newest version first: never by a result.
export function registryOf(home: string): Registry {
  const rows: RegistryRow[] = [];
  const damaged: Registry['damaged'] = [];
  let backtests = 0;
  for (const r of researchedRoutines(home)) {
    const versions = readVersions(r.dir);
    const tried = triedOf(r, versions, damaged);
    backtests += tried.length;
    const newest = versions.at(-1);
    const forward = newest ? readForward({ dir: r.dir }).find((e) => e.at >= newest.frozenAt) : undefined;
    for (const v of versions) {
      rows.push({ routine: r.name, version: v.version, frozenAt: v.frozenAt, ...testsOf(r, v, versions, tried, damaged), forwardSince: v === newest && forward ? forward.day : null });
    }
  }
  return { rows: byName(rows), backtests, damaged };
}

function byName(rows: RegistryRow[]): RegistryRow[] {
  return rows.sort((a, b) => a.routine.localeCompare(b.routine) || b.version - a.version);
}
