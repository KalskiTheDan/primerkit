import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { RunCancelled, type Status } from './executor';
import type { Journal } from './journal';
import { blockFromJson, blockFromMarkdown } from './packet';
import {
  RoutineError,
  addDays,
  isDate,
  labelList,
  positionBlock,
  priceBlock,
  readRules,
  runRoutine,
  type Close,
  type Holding,
  type Routine,
  type RoutineResponse,
} from './routine';
import { stampOf } from './snapshots';
import type { DataBlock, ModelAdapter, Operation, PacketFormat } from './types';

// A routine's logic tests: does the model apply the person's rules the same way each
// time? Each test runs the rules on the data as it stood on one day, frozen in the
// routine's folder the first time it runs, and checks the label. A model's answers vary,
// so each test runs several times and the runs that pass are counted. This tests the
// model against the rules, never the rules against the market.

export const TEST_RUNS = 5;
const MAX_RUNS = 20;
const TEST_FIELDS = ['on', 'holding', 'since', 'at', 'expect', 'cites'];

export interface RoutineTest {
  on: string;
  holding: { kind: 'flat' } | { kind: 'long'; since: string; at: number | null };
  expect: string[]; // the labels that pass
  cites: Array<{ block: string; line: number | null }>; // each must be cited by a checked claim
}

export interface RoutineTests {
  runs: number;
  tests: RoutineTest[];
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// YAML reads an unquoted 2026-09-20 as text or as a date, by its schema; both are read.
function dateOf(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return typeof value === 'string' && isDate(value.trim()) ? value.trim() : null;
}

export function parseRoutineTests(raw: unknown, routine: Routine): RoutineTests {
  const problems: string[] = [];
  const doc = raw ?? {};
  if (!isObject(doc)) throw new RoutineError(['it holds runs and a list of tests'], 'tests.yaml');
  for (const key of Object.keys(doc)) if (key !== 'runs' && key !== 'tests') problems.push(`${key} is not a field here; tests.yaml has runs and tests`);
  const runs = doc.runs ?? TEST_RUNS;
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) problems.push(`runs is how many times each test runs, from 1 to ${MAX_RUNS}, not ${JSON.stringify(runs)}`);
  const list = doc.tests ?? [];
  if (!Array.isArray(list)) problems.push('tests is a list of tests, each starting with on:');
  const labels = routine.spec.labels.map((l) => l.name);
  const blocks = ['rules', ...routine.spec.briefings, 'price', 'position'];
  const tests: RoutineTest[] = [];
  (Array.isArray(list) ? list : []).forEach((item: unknown, i) => {
    const at = `test ${i + 1}`;
    if (!isObject(item)) {
      problems.push(`${at} is not a test: a test has on and expect at least`);
      return;
    }
    const before = problems.length;
    for (const key of Object.keys(item)) if (!TEST_FIELDS.includes(key)) problems.push(`${at}: ${key} is not a field of a test; its fields are ${TEST_FIELDS.join(', ')}`);
    const on = dateOf(item.on);
    if (!on) problems.push(`${at}: on is the day the data stood, such as 2026-09-20`);

    const expected = item.expect === undefined ? [] : Array.isArray(item.expect) ? item.expect : [item.expect];
    if (!expected.length) problems.push(`${at}: expect is the label your rules give that day, or a list of them`);
    for (const label of expected) if (typeof label !== 'string' || !labels.includes(label)) problems.push(`${at}: ${JSON.stringify(label)} is not one of the routine's labels, ${labelList(labels)}`);

    let holding: RoutineTest['holding'] = { kind: 'flat' };
    const kind = item.holding ?? 'flat';
    if (kind === 'long') {
      const since = dateOf(item.since);
      const price = item.at;
      if (!since) problems.push(`${at}: holding long needs since, the day it was entered, such as 2026-09-10`);
      else if (on && since > on) problems.push(`${at}: since, ${since}, is after on, ${on}`);
      if (price !== undefined && (typeof price !== 'number' || !Number.isFinite(price) || price <= 0)) problems.push(`${at}: at is the entry price, a number such as 112000`);
      if (since) holding = { kind: 'long', since, at: typeof price === 'number' ? price : null };
    } else if (kind !== 'flat') {
      problems.push(`${at}: holding is flat or long, not ${JSON.stringify(kind)}`);
    } else if (item.since !== undefined || item.at !== undefined) {
      problems.push(`${at}: since and at go with holding: long`);
    }

    const cites: RoutineTest['cites'] = [];
    const citesRaw = item.cites === undefined ? [] : Array.isArray(item.cites) ? item.cites : [item.cites];
    for (const cite of citesRaw) {
      const m = typeof cite === 'string' ? /^([a-z][a-z0-9.-]*)(?:\s+L(\d+))?$/.exec(cite.trim()) : null;
      if (!m?.[1]) problems.push(`${at}: ${JSON.stringify(cite)} is not a block or a line, such as btc.context or btc.context L7`);
      else if (!blocks.includes(m[1])) problems.push(`${at}: ${m[1]} is not a block this routine reads; they are ${blocks.join(', ')}`);
      else cites.push({ block: m[1], line: m[2] ? Number(m[2]) : null });
    }
    if (problems.length === before && on) tests.push({ on, holding, expect: expected as string[], cites });
  });
  if (problems.length) throw new RoutineError(problems, 'tests.yaml');
  return { runs: runs as number, tests };
}

// The routine's tests.yaml, or no tests when it has none.
export function loadRoutineTests(routine: Routine): RoutineTests {
  const path = join(routine.dir, 'tests.yaml');
  if (!existsSync(path)) return { runs: TEST_RUNS, tests: [] };
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new RoutineError([`it could not be read as YAML: ${String((error as Error).message).split('\n')[0]}`], 'tests.yaml');
  }
  return parseRoutineTests(raw, routine);
}

// Where a routine's data comes from when a day is not frozen yet: PreReason's briefings
// as they stood on a day, and Bitcoin's close on each day from one date through another,
// the last day's close included.
export interface RoutineSource {
  briefing(id: string, format: PacketFormat, date: string): Promise<{ raw: string }>;
  closes(from: string, to: string): Promise<Close[]>;
}

export interface Fixture {
  date: string;
  briefings: DataBlock[];
  closes: Close[];
  frozen: string[]; // the files this read wrote, the first time the day was read
}

export const fixtureDir = (routine: Routine, date: string): string => join(routine.dir, 'fixtures', date);

export const briefingPath = (routine: Routine, id: string, date: string, format: PacketFormat): string => join(fixtureDir(routine, date), `${id}.${format === 'json' ? 'json' : 'md'}`);

// The routine's briefings as they stood at the end of a day: each read once and frozen in
// the routine's folder as served, then read from there ever after. The logic tests and the
// backtest share these days, so a day either of them read is never read again.
export async function briefingsOn(routine: Routine, date: string, format: PacketFormat, source: RoutineSource | null, frozen: string[] = []): Promise<DataBlock[]> {
  const briefings: DataBlock[] = [];
  for (const id of routine.spec.briefings) {
    const path = briefingPath(routine, id, date, format);
    if (!existsSync(path)) {
      if (!source) throw new RoutineError([`the data for ${date} is not frozen yet, and PreReason is not connected to read it`], 'tests.yaml');
      const { raw } = await source.briefing(id, format, date);
      mkdirSync(fixtureDir(routine, date), { recursive: true });
      writeFileSync(path, raw, { flag: 'wx' });
      frozen.push(path);
    }
    const raw = readFileSync(path, 'utf8');
    const readAt = statSync(path).mtime.toISOString();
    briefings.push(format === 'json' ? blockFromJson(id, raw, readAt) : blockFromMarkdown(id, raw, readAt));
  }
  return briefings;
}

// The data a test reads, as it stood on its day: read once and frozen in the routine's
// folder as served, then read from there on every run after, so every run of a test reads
// the same lines. A frozen file is never written again.
export async function readFixture(routine: Routine, date: string, format: PacketFormat, source: RoutineSource | null): Promise<Fixture> {
  const dir = fixtureDir(routine, date);
  const frozen: string[] = [];
  const from = (): RoutineSource => {
    if (!source) throw new RoutineError([`the data for ${date} is not frozen yet, and PreReason is not connected to read it`], 'tests.yaml');
    return source;
  };
  const freeze = (path: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, body, { flag: 'wx' });
    frozen.push(path);
  };
  const briefings = await briefingsOn(routine, date, format, source, frozen);
  const pricePath = join(dir, `price-${routine.spec.priceDays}d.json`);
  if (!existsSync(pricePath)) {
    const closes = (await from().closes(addDays(date, -routine.spec.priceDays), date)).filter((c) => c.date <= date);
    if (!closes.length) throw new RoutineError([`there is no Bitcoin price for the ${routine.spec.priceDays} days to ${date}`], 'tests.yaml');
    freeze(pricePath, `${JSON.stringify({ through: date, days: routine.spec.priceDays, source: 'prereason', closes }, null, 2)}\n`);
  }
  const price = JSON.parse(readFileSync(pricePath, 'utf8')) as { closes: Close[] };
  return { date, briefings, closes: price.closes, frozen };
}

// The position a test holds going in. Long with no price given enters at the close on
// its since day, which the price table has to reach.
export function holdingOf(test: RoutineTest, closes: Close[]): Holding {
  const h = test.holding;
  if (h.kind === 'flat') return { kind: 'flat' };
  const at = h.at ?? closes.find((c) => c.date === h.since)?.price;
  if (at === undefined) throw new RoutineError([`the test on ${test.on} holds long since ${h.since}, which the price table does not reach, so it needs at: the entry price`], 'tests.yaml');
  return { kind: 'long', since: h.since, at };
}

export function holdingText(holding: RoutineTest['holding']): string {
  return holding.kind === 'flat' ? 'flat' : `long since ${holding.since}${holding.at === null ? '' : ` at $${holding.at.toLocaleString('en-US')}`}`;
}

export interface TestRunRecord {
  run: number;
  label: string | null;
  outcome: string; // passed, partial, failed or refused
  passed: boolean;
  why: string | null; // why a run did not pass
  runId: string;
}

export interface TestRecord {
  on: string;
  holding: string;
  expect: string[];
  runs: TestRunRecord[];
  passed: number;
}

export interface TestReport {
  routine: string;
  at: string;
  model: string;
  rules: { path: string; hash: string };
  runsEach: number;
  planned: { tests: number; runs: number }; // what tests.yaml asks for, all of it
  tests: TestRecord[]; // the tests that ran, with their runs
  passed: number;
  total: number; // the runs that ran
  stopped: string | null; // why it stopped before every run was done
}

// Whether one run passed its test: its answer passed its checks, its label is one the
// test expects, and its checked claims cite what the test says they must.
export function judgeTestRun(test: RoutineTest, label: string | null, response: RoutineResponse | null, outcome: string, reason?: string): { passed: boolean; why: string | null } {
  if (label === null) return { passed: false, why: `${outcome === 'refused' ? 'was not sent' : 'failed its checks'}${reason ? `: ${reason}` : ''}` };
  if (!test.expect.includes(label)) return { passed: false, why: `gave ${label}, not ${labelList(test.expect)}` };
  const cited = (response?.claims ?? []).flatMap((c) => c.citations);
  for (const want of test.cites) {
    if (!cited.some((c) => c.block === want.block && (want.line === null || c.line === want.line))) {
      return { passed: false, why: `gave ${label} without citing ${want.block}${want.line === null ? '' : ` L${want.line}`}` };
    }
  }
  return { passed: true, why: null };
}

export interface RoutineTestOptions {
  base: Operation;
  routine: Routine;
  tests: RoutineTests;
  model: ModelAdapter;
  source: RoutineSource | null;
  format: PacketFormat;
  journal?: Journal;
  runs?: number; // in place of tests.yaml's runs
  now?: () => Date;
  signal?: AbortSignal;
  onStatus?: (status: Status) => void;
  onRun?: (step: { test: number; run: number; tests: number; runs: number; done?: TestRunRecord }) => void;
}

export type RoutineTestOutcome = { kind: 'no_rules_defined'; rulesPath: string } | { kind: 'no_tests' } | { kind: 'tested'; report: TestReport; path: string };

export const resultsDir = (routine: Routine): string => join(routine.dir, 'results');

// Runs every test its number of runs, in order, each run a fresh packet and a fresh call.
// Ctrl+C stops it, and what ran is kept. The report is written to the routine's results
// folder, one file a test run, never written over.
export async function testRoutine(opts: RoutineTestOptions): Promise<RoutineTestOutcome> {
  const rules = readRules(opts.routine);
  if (!rules) return { kind: 'no_rules_defined', rulesPath: opts.routine.rulesPath };
  if (!opts.tests.tests.length) return { kind: 'no_tests' };
  const now = opts.now ?? (() => new Date());
  const runs = opts.runs ?? opts.tests.runs;
  const records: TestRecord[] = [];
  let stopped: string | null = null;
  let hash = rules.hash;
  outer: for (const [t, test] of opts.tests.tests.entries()) {
    const fixture = await readFixture(opts.routine, test.on, opts.format, opts.source);
    const holding = holdingOf(test, fixture.closes);
    const last = fixture.closes.at(-1) as Close;
    const readAt = now().toISOString();
    const blocks = [...fixture.briefings, priceBlock(fixture.closes, readAt), positionBlock(holding, last, readAt)];
    const record: TestRecord = { on: test.on, holding: holdingText(test.holding), expect: test.expect, runs: [], passed: 0 };
    records.push(record);
    for (let r = 1; r <= runs; r++) {
      opts.onRun?.({ test: t, run: r, tests: opts.tests.tests.length, runs });
      let ran;
      try {
        ran = await runRoutine({
          base: opts.base,
          routine: opts.routine,
          blocks,
          model: opts.model,
          now,
          ...(opts.journal ? { journal: opts.journal } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
          record: { test: { on: test.on, holding: record.holding, expect: test.expect }, run: r },
        });
      } catch (error) {
        if (!(error instanceof RunCancelled)) throw error;
        stopped = 'stopped by hand';
        break outer;
      }
      if (ran.kind === 'no_rules_defined') {
        stopped = 'the rules file was emptied while the tests ran';
        break outer;
      }
      hash = ran.rules.hash;
      const response = ran.result.response as unknown as RoutineResponse | null;
      const judged = judgeTestRun(test, ran.label, response, ran.result.outcome, ran.result.reason);
      const done: TestRunRecord = { run: r, label: ran.label, outcome: ran.result.outcome, passed: judged.passed, why: judged.why, runId: ran.result.runId };
      record.runs.push(done);
      if (done.passed) record.passed++;
      opts.onRun?.({ test: t, run: r, tests: opts.tests.tests.length, runs, done });
    }
  }
  const total = records.reduce((s, r) => s + r.runs.length, 0);
  const report: TestReport = {
    routine: opts.routine.spec.name,
    at: now().toISOString(),
    model: opts.model.label,
    rules: { path: rules.path, hash },
    runsEach: runs,
    planned: { tests: opts.tests.tests.length, runs: opts.tests.tests.length * runs },
    tests: records,
    passed: records.reduce((s, r) => s + r.passed, 0),
    total,
    stopped,
  };
  const dir = resultsDir(opts.routine);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `tests-${stampOf(report.at)}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return { kind: 'tested', report, path };
}

// The newest test report, for the routine's screen.
export function latestTestReport(routine: Routine): TestReport | null {
  const dir = resultsDir(routine);
  if (!existsSync(dir)) return null;
  const last = readdirSync(dir)
    .filter((f) => /^tests-.+\.json$/.test(f))
    .sort()
    .at(-1);
  return last ? (JSON.parse(readFileSync(join(dir, last), 'utf8')) as TestReport) : null;
}

// "5 rule tests on frozen data, 5 runs each: 24 of 25 passed", and when it stopped early,
// how many runs it had to go.
export function testSummary(report: TestReport): string {
  const n = report.planned.tests;
  const each = `${report.runsEach} ${report.runsEach === 1 ? 'run' : 'runs'} each`;
  const left = report.planned.runs - report.total;
  const stopped = report.stopped ? `, then ${report.stopped} with ${left} ${left === 1 ? 'run' : 'runs'} to go` : '';
  return `${n} rule ${n === 1 ? 'test' : 'tests'} on frozen data, ${each}: ${report.passed} of ${report.total} passed${stopped}`;
}

// A row a test: its day, then what it held, what it expects, and its count, with why the
// first run that failed did.
export function testRows(report: TestReport): Array<{ day: string; text: string }> {
  return report.tests.map((t) => {
    const miss = t.runs.find((r) => !r.passed);
    return { day: t.on, text: `${t.holding}, expects ${labelList(t.expect)}: ${t.passed} of ${t.runs.length}${miss?.why ? ` (run ${miss.run} ${miss.why})` : ''}` };
  });
}

export function testLines(report: TestReport): string[] {
  return testRows(report).map((r) => `${r.day}  ${r.text}`);
}
