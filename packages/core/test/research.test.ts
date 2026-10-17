import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BacktestRun,
  CARD_FIELDS,
  addDays,
  bootstrapInterval,
  formCheck,
  formWords,
  freezeCard,
  frozenCard,
  frozenTestOf,
  hypothesisTemplate,
  ladderOf,
  loadRoutine,
  parseCard,
  planBacktest,
  readReplay,
  readVersions,
  registryOf,
  routineFiles,
  seedOf,
  trialsOf,
  type Arm,
  type Close,
  type Ladder,
  type Routine,
  type RoutineSource,
} from '../src/index';

// The research view from backtests run here through the simulated account with no model:
// each tick's label is recorded as a model's would be, from a script that knows the closes.

const TODAY = '2026-10-12';
const FROM = '2026-08-01';
const TO = '2026-09-29';
const OUT = { cutoff: '2024-09', source: 'given for these tests', basis: 'person' as const };

// Closes from a year and more before the window to the day after it. Before it, $110,000
// falling to $100,000 with a small wobble. In it, a rise of 0.15% a day from $96,000 and a
// step up to $106,000 on its 31st day, with a swing up and down every other day that widens
// as the window goes on: the first month sits below the 200 day average and calm, the
// second above it and wide.
const swing = (i: number): number => 0.004 + 0.0003 * i;
const baseAt = (i: number): number => (i < 30 ? 96_000 * 1.0015 ** i : 106_000 * 1.0015 ** (i - 30));
const priceAt = (i: number): number => (i < 0 ? 100_000 - 25 * (i + 1) + (i % 2 ? 100 : -100) : baseAt(i) * (1 + swing(i) * (i % 2 ? -1 : 1)));
const CLOSES: Close[] = Array.from({ length: 463 }, (_, k) => k - 400).map((i) => ({ date: addDays(FROM, i), price: Math.round(priceAt(i) * 100) / 100 }));
const closeOn = (date: string): number => (CLOSES.find((c) => c.date === date) as Close).price;

const source: RoutineSource = {
  briefing: async () => ({ raw: '' }),
  closes: async (from, to) => CLOSES.filter((c) => c.date >= from && c.date <= to),
};

const YAML = (over: { priceDays?: number; spread?: string | null; enter?: number; fee?: null } = {}) =>
  [
    'rules: rules.md',
    'data:',
    '  briefings: [btc.pulse]',
    `  price_days: ${over.priceDays ?? 365}`,
    'labels:',
    '  watch: { hold: true }',
    `  enter: { target: ${over.enter ?? 1} }`,
    '  exit: { target: 0 }',
    ...(over.fee === null ? [] : ['fees: { per_trade: 0.001 }']),
    ...(over.spread === null ? [] : [`spread_bps: ${over.spread ?? 10}`]),
    '',
  ].join('\n');

const CARD = (success = 'treatment ahead of control by at least 1 point over the backtest') => `## Claim
Bitcoin's every other day swing is there to be caught a day ahead.

## Mechanism
The swing comes from the way the closes alternate.

## Expected signature
Treatment gains on the days the price table shows a rise, in btc.pulse and the price.

## Universe and horizon
BTC/USD, a day at a time.

## Success criterion
${success}

## Kill criterion
treatment behind control by 1 point
`;

function homeWith(): string {
  return mkdtempSync(join(tmpdir(), 'primerkit-research-'));
}

function routineIn(home: string, name: string, yaml = YAML(), card: string | null = CARD()): Routine {
  const dir = join(home, 'routines', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'routine.yaml'), yaml);
  writeFileSync(join(dir, 'rules.md'), 'Enter before a rise, exit before a fall.\n');
  if (card !== null) writeFileSync(join(dir, 'hypothesis.md'), card);
  return loadRoutine(dir);
}

type Labels = (arm: Arm, i: number, tick: string) => string | null;

// Enters the day before each rise and exits before each fall, from its third tick on, as
// only a script that reads ahead can: its edge over control is large on every day it holds.
const ahead: Labels = (arm, i, tick) => (arm !== 'treatment' || i < 2 ? 'watch' : closeOn(addDays(tick, 2)) > closeOn(addDays(tick, 1)) ? 'enter' : 'exit');
// Long from the third tick on, whatever the day: the window's rise, and every swing in it.
const long: Labels = (arm, i) => (arm === 'treatment' && i >= 2 ? 'enter' : 'watch');
// Watching throughout: no lead over control at all.
const still: Labels = () => 'watch';

// A backtest started as a run starts, every tick recorded as its label says, and finished.
// ticks: only that many recorded, as a run stopped by hand or by an error keeps them.
async function backtest(routine: Routine, labels: Labels, over: { at?: string; finish?: boolean; inside?: boolean; from?: string; to?: string; maxShare?: number; ticks?: number } = {}): Promise<{ dir: string; run: BacktestRun }> {
  const window = { from: over.from ?? FROM, to: over.to ?? TO, ...(over.maxShare ? { maxShare: over.maxShare } : {}) };
  const plan = planBacktest(routine, { ...window, ...(over.inside ? { insideTraining: true } : {}) }, { tier: 'enterprise', today: TODAY, format: 'markdown', model: 'scripted', cutoff: over.inside ? { ...OUT, cutoff: '2026-09' } : OUT });
  expect(plan.problems).toEqual([]);
  const now = () => new Date(over.at ?? `${TODAY}T12:00:00.000Z`);
  const run = (await BacktestRun.start({ routine, plan, model: 'scripted', source, now })) as BacktestRun;
  record(run, labels, over.ticks);
  if (over.finish !== false && over.ticks === undefined) run.finish();
  return { dir: run.dir, run };
}

// Each tick a run has still to answer, up to `ticks` of them, recorded as its label says.
function record(run: BacktestRun, labels: Labels, ticks = Infinity): void {
  const index = new Map(run.file.ticks.map((t, i) => [t, i]));
  for (let key = run.next(), n = 0; key && n < ticks; key = run.next(), n++) {
    const label = labels(key.arm, index.get(key.tick) as number, key.tick);
    run.record(key, { label, outcome: label ? 'passed' : 'failed', runId: `r-${key.arm}-${key.tick}` });
  }
}

async function ladderFor(routine: Routine, labels: Labels, over: { inside?: boolean } = {}): Promise<Ladder> {
  const { dir, run } = await backtest(routine, labels, over);
  const stamp = run.file.hypothesis;
  return ladderOf(readReplay(dir)!, stamp ? frozenCard(routine.dir, stamp.version) : null);
}

const all = (l: Ladder): string => l.hurdles.map((h) => `${h.id} ${h.status} ${h.text}`).join('\n');

describe('the hypothesis card', () => {
  it('is written by routine new with a placeholder in every field and no example of its own', () => {
    const template = routineFiles('btc-rules')['hypothesis.md'];
    expect(template).toBe(hypothesisTemplate('btc-rules'));
    const card = parseCard(template);
    for (const field of CARD_FIELDS) expect(card.fields[field], field).toBeNull();
    // Nothing a person could take for a suggested strategy: no number, no series, no symbol.
    const words = template.replace(/<!--[\s\S]*?-->/g, '');
    expect(words).not.toMatch(/\d|BTC|btc\.|macro\.|liquidity|bps|should/i);
    expect(template).not.toMatch(/should|recommend/i);
  });

  it('reads each field in the person words, comments and placeholders taken out', () => {
    const card = parseCard(CARD());
    expect(card.fields.claim).toBe("Bitcoin's every other day swing is there to be caught a day ahead.");
    expect(card.fields.universe).toBe('BTC/USD, a day at a time.');
    expect(card.fields.success).toBe('treatment ahead of control by at least 1 point over the backtest');
    // A comment or a placeholder changes neither the fields nor the hash.
    expect(parseCard(`${CARD()}\n<!-- a note to self -->\n<another placeholder>\n`).hash).toBe(card.hash);
    expect(parseCard(CARD().replace('1 point over', '2 points over')).hash).not.toBe(card.hash);
  });

  it('reads the same words as the same card, whether saved with a byte-order mark or CRLF endings', async () => {
    // PowerShell 5.1's Set-Content -Encoding UTF8 and Out-File write a byte-order mark first.
    const card = parseCard(CARD());
    expect(parseCard(`\uFEFF${CARD()}`).hash).toBe(card.hash);
    expect(parseCard(`\uFEFF${CARD().replace(/\n/g, '\r\n')}`).hash).toBe(card.hash);
    expect(parseCard(`\uFEFF${CARD()}`).fields.claim).toBe(card.fields.claim);
    // So saving it again that way, unchanged, freezes no new version.
    const home = homeWith();
    const routine = routineIn(home, 'saved');
    await backtest(routine, ahead, { at: '2026-10-10T10:00:00.000Z' });
    writeFileSync(join(routine.dir, 'hypothesis.md'), `\uFEFF${CARD().replace(/\n/g, '\r\n')}`);
    expect((await backtest(routine, ahead, { at: '2026-10-11T10:00:00.000Z' })).run.file.hypothesis?.version).toBe(1);
    expect(readVersions(routine.dir)).toHaveLength(1);
  });

  it('freezes at the first backtest, keeps its version, and makes a new version when it changes', async () => {
    const home = homeWith();
    const routine = routineIn(home, 'swing');
    const first = await backtest(routine, ahead, { at: '2026-10-10T10:00:00.000Z' });
    expect(first.run.file.hypothesis).toMatchObject({ version: 1, frozenAt: '2026-10-10T10:00:00.000Z' });
    expect(JSON.parse(readFileSync(join(first.dir, 'plan.json'), 'utf8')).hypothesis.hash).toBe(parseCard(CARD()).hash);
    expect(readFileSync(join(routine.dir, 'hypotheses', 'v1.md'), 'utf8')).toBe(CARD());
    // The same card again is the same version, frozen when it first was.
    const again = await backtest(routine, ahead, { at: '2026-10-11T10:00:00.000Z' });
    expect(again.run.file.hypothesis).toEqual(first.run.file.hypothesis);
    expect(readVersions(routine.dir)).toHaveLength(1);
    // A changed criterion after the freeze is version 2; version 1 and its run are kept.
    writeFileSync(join(routine.dir, 'hypothesis.md'), CARD('treatment ahead of control by at least 0.5 points'));
    const changed = await backtest(routine, ahead, { at: '2026-10-11T11:00:00.000Z' });
    expect(changed.run.file.hypothesis?.version).toBe(2);
    expect(readFileSync(join(routine.dir, 'hypotheses', 'v1.md'), 'utf8')).toBe(CARD());
    expect(frozenCard(routine.dir, 1)?.fields.success).toBe('treatment ahead of control by at least 1 point over the backtest');
    expect(frozenCard(routine.dir, 2)?.fields.success).toBe('treatment ahead of control by at least 0.5 points');
    expect(readVersions(routine.dir).map((v) => [v.version, v.runId])).toEqual([
      [1, first.run.runId],
      [2, changed.run.runId],
    ]);
    expect(existsSync(first.dir) && existsSync(join(first.dir, 'report.json'))).toBe(true);
    // A version's file is written once: freezing it again writes nothing.
    expect(freezeCard(routine, 'x', new Date())?.version).toBe(2);
    expect(readVersions(routine.dir)).toHaveLength(2);
  });

  it('freezes nothing while the card holds nothing of the person, or is not there', async () => {
    const home = homeWith();
    expect((await backtest(routineIn(home, 'blank', YAML(), hypothesisTemplate('blank')), long)).run.file.hypothesis).toBeNull();
    expect((await backtest(routineIn(home, 'none', YAML(), null), long)).run.file.hypothesis).toBeNull();
    expect(existsSync(join(home, 'routines', 'blank', 'hypotheses'))).toBe(false);
  });

  it('waits for the spread to be the person own, and never assumes one', () => {
    const home = homeWith();
    const placeholder = routineIn(home, 'unset', YAML({ spread: '<your estimate>' }));
    expect(placeholder.spec.spreadBps).toBeNull();
    const plan = planBacktest(placeholder, { from: FROM, to: TO }, { tier: 'enterprise', today: TODAY, format: 'markdown', model: 'scripted', cutoff: OUT });
    expect(plan.problems).toEqual(['spread_bps is still a placeholder: put your own estimate of the spread in routine.yaml, or take the line out']);
    expect('spreadBps' in routineIn(home, 'absent', YAML({ spread: null })).spec).toBe(false);
    expect(routineIn(home, 'set', YAML({ spread: '8' })).spec.spreadBps).toBe(8);
    expect(() => routineIn(home, 'wrong', YAML({ spread: '900' }))).toThrow(/spread_bps is your estimate of the spread .* from 0 to 500/);
  });
});

describe('the form check', () => {
  // The only shapes a status may take, and the only words: a fixed phrase a field, with the
  // series the signature names put in. Nothing rates the card or suggests anything.
  const STATUSES = new Set(['missing', 'stated', 'numeric', 'not numeric', 'more than one number', 'observable', 'not observable']);
  const WORDS = [
    /^(claim|mechanism|universe) stated$/,
    /^(success|kill) (numeric|not numeric|has more than one number)$/,
    /^signature observable in [a-z0-9./-]+(, [a-z0-9./-]+)*( and [a-z0-9./-]+)?$/,
    /^signature not observable in your routine's data: it needs [a-z0-9./-]+(, [a-z0-9./-]+)*( and [a-z0-9./-]+)?$/,
    /^signature names no series your routine reads$/,
    /^claim missing: write what you expect to happen$/,
    /^mechanism missing: write why you expect it$/,
    /^signature missing: write what would be seen if it is true$/,
    /^universe missing: write the symbol and how long a position is kept$/,
    /^success missing: write the number that would count as passing$/,
    /^kill missing: write the number that would count as failing$/,
  ];
  const holdsOnlyStatuses = (card: string, reads: string[]) => {
    const statuses = formCheck(parseCard(card), reads);
    expect(statuses.map((s) => s.field)).toEqual([...CARD_FIELDS]);
    for (const s of statuses) {
      expect(Object.keys(s).sort(), JSON.stringify(s)).toEqual('series' in s ? ['field', 'series', 'status'] : ['field', 'status']);
      expect(STATUSES.has(s.status), s.status).toBe(true);
      const words = formWords(s);
      expect(WORDS.some((w) => w.test(words)), words).toBe(true);
    }
    return statuses.map(formWords);
  };

  it('reports per field only: stated or missing, numeric or not, observable or not, naming the series', () => {
    expect(holdsOnlyStatuses(CARD(), ['btc.pulse'])).toEqual(['claim stated', 'mechanism stated', 'signature observable in btc.pulse and bitcoin-price', 'universe stated', 'success numeric', 'kill numeric']);
    expect(holdsOnlyStatuses(hypothesisTemplate('x'), [])).toEqual([
      'claim missing: write what you expect to happen',
      'mechanism missing: write why you expect it',
      'signature missing: write what would be seen if it is true',
      'universe missing: write the symbol and how long a position is kept',
      'success missing: write the number that would count as passing',
      'kill missing: write the number that would count as failing',
    ]);
    const other = CARD().replace('in btc.pulse and the price', 'in macro.liquidity').replace('by at least 1 point over the backtest', 'by a clear margin').replace('behind control by 1 point', 'behind control by 1 point in 3 of 5 repeats');
    expect(holdsOnlyStatuses(other, ['btc.pulse'])).toEqual(['claim stated', 'mechanism stated', "signature not observable in your routine's data: it needs macro.liquidity", 'universe stated', 'success not numeric', 'kill has more than one number']);
    expect(holdsOnlyStatuses(CARD().replace('Treatment gains on the days the price table shows a rise, in btc.pulse and the price.', 'It shows up as a steady drift, e.g. most weeks.'), [])[2]).toBe('signature names no series your routine reads');
  });

  it('never carries the card words, a rating or a suggestion: only the series ids it names', () => {
    // The person words appear nowhere in the check, so it can rewrite nothing.
    const out = holdsOnlyStatuses(CARD(), ['btc.pulse']).join(' ');
    for (const word of ['swing', 'caught', 'alternate', 'gains', 'treatment', 'ahead']) expect(out).not.toContain(word);
    expect(out).not.toMatch(/weak|strong|promising|unlikely|good|bad|consider|try|instead|threshold of|horizon of|recommend|should/i);
  });
});

describe('the hurdle ladder', () => {
  it('passes H1 to H5 for an edge that is large on every day, with each number named', async () => {
    const l = await ladderFor(routineIn(homeWith(), 'swing'), ahead);
    expect(l.end).toBeNull();
    expect(l.hurdles.map((h) => `${h.id} ${h.status}`)).toEqual(['H1 passed', 'H2 passed', 'H3 passed', 'H4 passed', 'H5 passed']);
    const [h1, h2, h3, h4, h5] = l.hurdles.map((h) => h.text) as [string, string, string, string, string];
    expect(h1).toMatch(/^treatment returned \d+\.\d% against control 0\.0% and placebo 0\.0% over the backtest, on your success criterion \(treatment ahead of control by at least 1 point over the backtest\)$/);
    expect(h2).toMatch(/^at your spread of 10 bps and fee of 0\.10%, treatment returned \d+\.\d% after costs \(control 0\.0%\)$/);
    // A share of 1 a tenth and a fifth higher is still 1: those two are the person's own size.
    expect(h3).toBe('the edge stays above control on 7 of 7 nearby settings (sizes, fees, start day); 2 settings left out: equal to yours (size capped at 1)');
    // Each regime window with its size, every day of the run in one of each pair.
    const sizes = /^after the model's cutoff; in high and low volatility \(30 day realised; (\d+) and (\d+) days\), above and below the 200 day average \((\d+) and (\d+) days\)$/.exec(h4);
    expect(sizes, h4).not.toBeNull();
    const [hi, lo, up, down] = (sizes as RegExpExecArray).slice(1).map(Number) as [number, number, number, number];
    // Sixty days from the first tick's close to the close after the window.
    expect([hi + lo, up + down]).toEqual([60, 60]);
    for (const n of [hi, lo, up, down]) expect(n).toBeGreaterThanOrEqual(10);
    expect(h5).toMatch(/^the edge over control's 95% interval is above zero \(\d+\.\d% to \d+\.\d%\)$/);
  });

  it('stops at H2 with no spread set, and assumes none', async () => {
    const l = await ladderFor(routineIn(homeWith(), 'nospread', YAML({ spread: null })), ahead);
    expect(l.hurdles.map((h) => `${h.id} ${h.status}`)).toEqual(['H1 passed', 'H2 stopped']);
    expect(l.hurdles[1]?.text).toBe('no spread set: add spread_bps to routine.yaml');
    expect(l.end).toEqual({ id: 'H2', status: 'stopped', reason: 'no spread set' });
  });

  it('stops at the first hurdle failed, and names the person own criterion', async () => {
    const h1 = await ladderFor(routineIn(homeWith(), 'far', YAML(), CARD('treatment ahead of control by 1000 points')), ahead);
    expect(h1.hurdles.map((h) => `${h.id} ${h.status}`)).toEqual(['H1 failed']);
    expect(h1.end?.reason).toMatch(/^treatment's lead over control was \d+\.\d points; your success criterion asks for 1000$/);
    expect(h1.falsified).toBe(true);
    // A spread wider than the swing it catches: passed before costs, failed after them.
    const h2 = await ladderFor(routineIn(homeWith(), 'costly', YAML({ spread: '500' })), ahead);
    expect(h2.hurdles.map((h) => `${h.id} ${h.status}`)).toEqual(['H1 passed', 'H2 failed']);
    expect(h2.end?.reason).toMatch(/^after costs, treatment's lead over control was -\d+\.\d points; your success criterion asks for 1$/);
    expect(h2.hurdles[1]?.text).toMatch(/^at your spread of 500 bps and fee of 0\.10%, treatment returned -\d+\.\d% after costs \(control 0\.0%\)$/);
  });

  it('re-runs the account at the run own terms to the run own returns, with no model asked', async () => {
    const routine = routineIn(homeWith(), 'zero', YAML({ spread: '0' }));
    const { dir } = await backtest(routine, ahead);
    const replay = readReplay(dir)!;
    const l = ladderOf(replay, frozenCard(routine.dir, 1));
    const treatment = replay.report.arms.find((a) => a.arm === 'treatment')!.mean.return;
    // With no spread, the costs are the fee the run charged: H2's return is the run's own.
    expect(l.hurdles[1]?.text).toContain(`treatment returned ${(treatment * 100).toFixed(1)}% after costs`);
  });

  it('leaves out a nearby setting that changes the position the labels read, and counts only the rest', async () => {
    // Long from the first tick: an account opened a tick or two later would be flat where the
    // model was shown it long, so those labels do not stand and the two start days are not re-run.
    const early: Labels = (arm, i, tick) => (arm !== 'treatment' ? 'watch' : i < 2 ? 'enter' : ahead(arm, i, tick));
    const l = await ladderFor(routineIn(homeWith(), 'early'), early);
    expect(l.hurdles[2]?.text).toBe('the edge stays above control on 5 of 5 nearby settings (sizes, fees, start day); 2 settings left out: equal to yours (size capped at 1); 2 not re-run, as they change the position your labels read');
    expect(all(l)).not.toMatch(/\bholds\b/);
  });

  it('leaves out and names a nearby setting equal to the person own, and counts only the real ones', async () => {
    // Fees left out are a fee of 0, and a fee of 0 halved or doubled is 0: with the two sizes
    // past the cap of 1, five of the nine are the person's own setting, which always passes.
    const l = await ladderFor(routineIn(homeWith(), 'nofee', YAML({ fee: null })), ahead);
    expect(l.hurdles[1]?.text).toMatch(/^at your spread of 10 bps and fee of 0\.00%/);
    expect(l.hurdles[2]).toMatchObject({ id: 'H3', status: 'passed', text: 'the edge stays above control on 4 of 4 nearby settings (sizes, fees, start day); 5 settings left out: equal to yours (size capped at 1; fee 0)' });
    // A share of a half moves with every step, so each size is a real one.
    const half = await ladderFor(routineIn(homeWith(), 'half', YAML({ enter: 0.5 })), ahead);
    expect(half.hurdles[2]?.text).toBe('the edge stays above control on 9 of 9 nearby settings (sizes, fees, start day)');
  });

  it('runs no H3 when no nearby setting is left that differs from the person own, and says why', async () => {
    // One tick, so no later start day; a cap of a half on every position, and no fee: every
    // other step is the person's own setting.
    const home = homeWith();
    const one = routineIn(home, 'one', YAML({ fee: null, spread: '0' }), CARD('treatment ahead of control by at least 0 points'));
    const { dir, run } = await backtest(one, (arm) => (arm === 'treatment' ? 'enter' : 'watch'), { from: FROM, to: FROM, maxShare: 0.5 });
    const lone = ladderOf(readReplay(dir)!, frozenCard(one.dir, run.file.hypothesis!.version));
    expect(lone.hurdles.map((h) => `${h.id} ${h.status}`)).toEqual(['H1 passed', 'H2 passed', 'H3 not run']);
    expect(lone.hurdles[2]?.text).toBe('not run: every nearby setting is equal to yours (size capped at your cap of 0.5; fee 0)');
    expect(lone.end).toEqual({ id: 'H3', status: 'not run', reason: 'every nearby setting is equal to yours' });
  });

  it("says too few days to test where a regime window is thin, and never passes it", async () => {
    // 30 days of prices reach no 200 day average at all.
    const l = await ladderFor(routineIn(homeWith(), 'short', YAML({ priceDays: 30 })), ahead);
    const h4 = l.hurdles[3];
    expect(h4?.status).toBe('stopped');
    expect(h4?.text).toMatch(/^after the model's cutoff; in high and low volatility \(30 day realised; \d+ and \d+ days\), above and below the 200 day average \(0 and 0 days\): too few days to test above and below the 200 day average, as the run's prices begin 30 days before the window$/);
    expect(l.end).toEqual({ id: 'H4', status: 'stopped', reason: 'too few days to test above and below the 200 day average' });
    expect(l.hurdles.some((h) => h.id === 'H5')).toBe(false);
  });

  it("fails H4 for a window inside the model's training", async () => {
    const l = await ladderFor(routineIn(homeWith(), 'inside'), ahead, { inside: true });
    expect(l.end).toEqual({ id: 'H4', status: 'failed', reason: "the backtest window is inside the model's training" });
  });

  it('draws the same interval from the same seed, so H5 is the same on every screen', async () => {
    const routine = routineIn(homeWith(), 'noisy');
    const l = await ladderFor(routine, long);
    // The window's rise, held through every swing: an edge, and an interval wide enough to hold zero.
    expect(l.hurdles.map((h) => `${h.id} ${h.status}`), all(l)).toEqual(["H1 passed", "H2 passed", "H3 passed", "H4 passed", "H5 failed"]);
    expect(l.hurdles[4]?.text).toMatch(/^the edge over control's 95% interval includes zero \(-\d+\.\d% to \d+\.\d%\)$/);
    expect(l.end).toEqual({ id: 'H5', status: 'failed', reason: "the edge over control's interval includes zero" });
    const pairs = Array.from({ length: 40 }, (_, i) => ({ t: Math.sin(i) / 50, c: Math.cos(i) / 80 }));
    expect(bootstrapInterval(pairs, 7)).toEqual(bootstrapInterval(pairs, 7));
    expect(bootstrapInterval(pairs, 7)).not.toEqual(bootstrapInterval(pairs, 8));
    expect(seedOf('20261012T120000Z-abc123')).toBe(seedOf('20261012T120000Z-abc123'));
    const { dir } = await backtest(routine, long, { at: '2026-10-12T13:00:00.000Z' });
    const replay = readReplay(dir)!;
    expect(all(ladderOf(replay, frozenCard(routine.dir, 1)))).toBe(all(ladderOf(replay, frozenCard(routine.dir, 1))));
    expect(all(ladderOf(replay, frozenCard(routine.dir, 1), { seed: 1 }))).toBe(all(ladderOf(replay, frozenCard(routine.dir, 1), { seed: 1 })));
  });

  it('stops at H1 with no card frozen, or a criterion with no one number', async () => {
    const none = await ladderFor(routineIn(homeWith(), 'none', YAML(), null), ahead);
    expect(none.end).toEqual({ id: 'H1', status: 'stopped', reason: 'no card was frozen with this backtest' });
    const vague = await ladderFor(routineIn(homeWith(), 'vague', YAML(), CARD('a clear lead over control')), ahead);
    expect(vague.end).toEqual({ id: 'H1', status: 'stopped', reason: 'your success criterion has no number' });
  });
});

describe('the registry', () => {
  it('lists every version with its status by name, never by result, and counts every one', async () => {
    const home = homeWith();
    // gamma passed and tracks forward; alpha's first version failed, its second passed; beta is
    // still testing. By result, gamma and alpha v2 would come first.
    const gamma = routineIn(home, 'gamma');
    await backtest(gamma, ahead, { at: '2026-10-10T10:00:00.000Z' });
    mkdirSync(join(gamma.dir, 'forward'), { recursive: true });
    writeFileSync(join(gamma.dir, 'forward', 'record.jsonl'), `${JSON.stringify({ at: '2026-10-11T07:30:00.000Z', day: '2026-10-11', close: { date: '2026-10-10', price: 1 }, label: 'watch', outcome: 'passed', runId: 'f', model: 'm', rulesHash: 'h', target: null, capped: false, reads: [] })}\n`);
    const alpha = routineIn(home, 'alpha', YAML(), CARD('treatment ahead of control by 1000 points'));
    await backtest(alpha, ahead, { at: '2026-10-10T11:00:00.000Z' });
    writeFileSync(join(alpha.dir, 'hypothesis.md'), CARD());
    await backtest(alpha, ahead, { at: '2026-10-10T12:00:00.000Z' });
    const beta = routineIn(home, 'beta');
    await backtest(beta, ahead, { at: '2026-10-10T13:00:00.000Z', finish: false });
    const { rows, backtests, damaged } = registryOf(home);
    expect(rows.map((r) => `${r.routine} v${r.version} ${r.status.kind}`)).toEqual(['alpha v2 passed', 'alpha v1 failed', 'beta v1 testing', 'gamma v1 passed']);
    expect(rows[1]?.status).toMatchObject({ kind: 'failed', hurdle: 'H1', falsified: true });
    expect(rows[3]?.forwardSince).toBe('2026-10-11');
    expect(rows.filter((r) => r.forwardSince).map((r) => r.routine)).toEqual(['gamma']);
    // One backtest a version, and none of them after its frozen test.
    expect(rows.map((r) => r.later)).toEqual([[], [], [], []]);
    expect([backtests, damaged]).toEqual([4, []]);
    expect(trialsOf(home)).toEqual({ versions: 4, backtests: 4 });
  });

  it("keeps a version's status from its frozen test: a later run of the same card that passes never turns a failure at H1, and is listed under it", async () => {
    const home = homeWith();
    const swing = routineIn(home, 'swing');
    // The model watched throughout: no lead over control, short of the card's 1 point.
    const failed = await backtest(swing, still, { at: '2026-10-10T10:00:00.000Z' });
    // The card untouched, backtested again, and every tick a day ahead of the swing.
    const passed = await backtest(swing, ahead, { at: '2026-10-11T10:00:00.000Z' });
    expect(passed.run.file.hypothesis).toEqual(failed.run.file.hypothesis);
    const { rows, backtests } = registryOf(home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toEqual({ kind: 'failed', hurdle: 'H1', reason: "treatment's lead over control was 0.0 points; your success criterion asks for 1", falsified: true });
    expect(rows[0]?.later).toEqual([{ runId: passed.run.runId, window: { from: FROM, to: TO }, status: { kind: 'passed' } }]);
    expect(rows[0]?.frozenRun).toBe(failed.run.runId);
    // The ladder asks the same of the version its run tested.
    expect(frozenTestOf({ name: 'swing', dir: swing.dir }, passed.run.file.hypothesis!)).toEqual({ runId: failed.run.runId, status: rows[0]?.status });
    // Each backtest is a trial, not each version.
    expect(backtests).toBe(2);
    expect(trialsOf(home)).toEqual({ versions: 1, backtests: 2 });
  });

  it('never takes a backtest cancelled or ended by an error as the frozen test, even one carried on to its end later, and counts every one', async () => {
    const home = homeWith();
    const swing = routineIn(home, 'swing');
    // 10:00: a run a day ahead of the swing, stopped after its first ticks.
    const stopped = await backtest(swing, ahead, { at: '2026-10-10T10:00:00.000Z', ticks: 12 });
    // 11:00: the first to finish, watching throughout: it fails at H1, and is the frozen test.
    const first = await backtest(swing, still, { at: '2026-10-10T11:00:00.000Z' });
    const before = registryOf(home);
    expect(before.rows[0]?.status).toMatchObject({ kind: 'failed', hurdle: 'H1', falsified: true });
    expect(before.rows[0]?.later).toEqual([{ runId: stopped.run.runId, window: { from: FROM, to: TO }, status: null }]);
    expect(before.backtests).toBe(2);
    // 12:00: the stopped run carried on to its end, where it passes; 13:00: one more that passes.
    const resumed = (await BacktestRun.open({ dir: stopped.dir, routine: swing, model: 'scripted', source, now: () => new Date('2026-10-10T12:00:00.000Z') })) as BacktestRun;
    record(resumed, ahead);
    resumed.finish();
    expect(JSON.parse(readFileSync(join(stopped.dir, 'report.json'), 'utf8')).finishedAt).toBe('2026-10-10T12:00:00.000Z');
    const third = await backtest(swing, ahead, { at: '2026-10-10T13:00:00.000Z' });
    const after = registryOf(home);
    // It started first, but finished after the frozen test: the status is still the frozen
    // test's, by the order the runs finished and not the order they started.
    expect(stopped.run.runId < first.run.runId).toBe(true);
    expect(after.rows[0]?.status).toMatchObject({ kind: 'failed', hurdle: 'H1', falsified: true });
    expect(after.rows[0]?.later.map((r) => [r.runId, r.status?.kind ?? null])).toEqual([
      [stopped.run.runId, 'passed'],
      [third.run.runId, 'passed'],
    ]);
    expect(trialsOf(home)).toEqual({ versions: 1, backtests: 3 });
  });

  it('names a backtest whose files are damaged and reads every other, so one never stops the registry', async () => {
    const home = homeWith();
    await backtest(routineIn(home, 'swing'), ahead, { at: '2026-10-10T10:00:00.000Z' });
    // A run stopped mid write: its last tick's line half written. It never finished, so
    // nothing reads its ticks.
    const cut = await backtest(routineIn(home, 'cut'), ahead, { at: '2026-10-10T11:00:00.000Z', finish: false });
    appendFileSync(join(cut.dir, 'ticks.jsonl'), '{"rep":1,"arm":"treat');
    // A finished run whose report is damaged: it is its version's frozen test, not read.
    const broken = await backtest(routineIn(home, 'broken'), ahead, { at: '2026-10-10T12:00:00.000Z' });
    writeFileSync(join(broken.dir, 'report.json'), '{"runId": "');
    const { rows, backtests, damaged } = registryOf(home);
    expect(rows.map((r) => `${r.routine} v${r.version} ${r.status.kind}`)).toEqual(['broken v1 unread', 'cut v1 testing', 'swing v1 passed']);
    expect(damaged).toEqual([{ routine: 'broken', runId: broken.run.runId }]);
    expect(backtests).toBe(3);
  });

  it('never hands a damaged frozen test its place to a later run, whichever of its files is damaged, and counts it', async () => {
    const home = homeWith();
    // In each routine the frozen test fails at H1 at 10:00 and a later run passes at 11:00;
    // then one file of the frozen test is damaged.
    const damage: Record<string, (dir: string) => void> = {
      // Its report is read, so it is known to have finished first.
      ticks: (dir) => appendFileSync(join(dir, 'ticks.jsonl'), '{"rep":1,"arm":"treat'),
      // When it finished is not known; it started before the later run finished, so it may have finished first.
      report: (dir) => writeFileSync(join(dir, 'report.json'), '{"runId": "'),
      // Its version is not read from its plan; it is the run that froze version 1, as its id says.
      plan: (dir) => writeFileSync(join(dir, 'plan.json'), '{"runId": "'),
    };
    for (const [name, harm] of Object.entries(damage)) {
      const routine = routineIn(home, name);
      const frozen = await backtest(routine, still, { at: '2026-10-10T10:00:00.000Z' });
      const later = await backtest(routine, ahead, { at: '2026-10-10T11:00:00.000Z' });
      harm(frozen.dir);
      const row = registryOf(home).rows.find((r) => r.routine === name);
      expect(row?.status, name).toEqual({ kind: 'unread' });
      expect(row?.frozenRun, name).toBeNull();
      expect(row?.later, name).toEqual([{ runId: later.run.runId, window: { from: FROM, to: TO }, status: { kind: 'passed' } }]);
      expect(frozenTestOf({ name, dir: routine.dir }, later.run.file.hypothesis!), name).toEqual({ runId: null, status: { kind: 'unread' } });
    }
    const all = registryOf(home);
    expect(all.damaged.map((d) => d.routine)).toEqual(['plan', 'report', 'ticks']);
    // Every damaged run still counts.
    expect(all.backtests).toBe(6);
  });

  it('keeps the frozen test where a damaged run started after it finished, and still counts that run', async () => {
    const home = homeWith();
    const routine = routineIn(home, 'swing');
    const frozen = await backtest(routine, still, { at: '2026-10-10T10:00:00.000Z' });
    const passed = await backtest(routine, ahead, { at: '2026-10-10T11:00:00.000Z' });
    // 12:00: a finished run whose report is damaged; 13:00: a run not finished whose plan is.
    const late = await backtest(routine, ahead, { at: '2026-10-10T12:00:00.000Z' });
    writeFileSync(join(late.dir, 'report.json'), '{"runId": "');
    const open = await backtest(routine, ahead, { at: '2026-10-10T13:00:00.000Z', finish: false });
    writeFileSync(join(open.dir, 'plan.json'), '{"runId": "');
    const { rows, backtests, damaged } = registryOf(home);
    expect(rows[0]?.status).toMatchObject({ kind: 'failed', hurdle: 'H1', falsified: true });
    expect(rows[0]?.frozenRun).toBe(frozen.run.runId);
    expect(rows[0]?.later.map((r) => r.runId)).toEqual([passed.run.runId]);
    expect(damaged.map((d) => d.runId).sort()).toEqual([late.run.runId, open.run.runId].sort());
    expect(backtests).toBe(4);
    expect(trialsOf(home)).toEqual({ versions: 1, backtests: 4 });
  });
});
