import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { addDays, latestTestReport, meaningOf, readRules, testSummary, type Close, type DataConnector, type Routine, type RoutineSource, type TestReport } from '@primerkit/core';

// A data connector as a routine's source: each briefing as it stood on a day, and
// Bitcoin's daily close. PreReason's history reads its to date as that day's first
// moment, so the last day of a range comes back as its midnight price. The range asks one
// day more and drops it, so every day in it is that day's close (checked 2026-09-28: to
// 2026-09-20 gave $81,256.73 for Sep 20, and any range past it $81,131.49).
export function routineSource(data: DataConnector & { bitcoinHistory?(range: { from: string; to: string }): Promise<Close[]> }): RoutineSource {
  return {
    briefing: async (id, format, date) => ({ raw: (await data.fetch({ briefing: id, format, date })).raw ?? '' }),
    closes: async (from, to) => {
      if (!data.bitcoinHistory) throw new Error('this data source has no Bitcoin price history');
      const closes = await data.bitcoinHistory({ from, to: addDays(to, 1) });
      return closes.filter((c) => c.date <= to);
    },
  };
}

// A path under the home folder written from ~, so a screen names no user.
export function tildePath(path: string, home = homedir()): string {
  return path === home ? '~' : path.startsWith(home + sep) ? `~/${path.slice(home.length + 1).replace(/\\/g, '/')}` : path;
}

// "Sep 28, 05:10 UTC", from an ISO time.
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${d.toISOString().slice(11, 16)} UTC`;
}

// The model a routine runs on, in words: its own, or the one primerkit is set to.
export function routineModelLine(routine: Routine, kept: string | null): string {
  if (routine.spec.model) return `${routine.spec.model.name}, named in routine.yaml`;
  return kept ? `${kept}, the model primerkit is set to` : "none set yet: name one in routine.yaml, or set primerkit's model";
}

export interface RoutineFacts {
  model: string | null; // the model primerkit is set to, by name
  report?: TestReport | null; // the newest test report, read from the routine's folder unless given
  home?: string;
}

// What a routine reads and does, as its screen has it: the data, the model, the rules,
// what each label holds, and its tests. It names no size: sizes are the person's own.
export interface RoutinePage {
  name: string;
  about: string; // "your routine | every day | BTC/USD, long or flat"
  reads: Array<{ mark: 'pr' | 'own'; name: string; what: string }>;
  fields: Array<{ label: string; text: string }>;
}

export function routinePage(routine: Routine, facts: RoutineFacts): RoutinePage {
  const { spec } = routine;
  const home = facts.home ?? homedir();
  const path = tildePath(routine.rulesPath, home);
  let rules: string;
  try {
    const read = readRules(routine);
    rules = read ? `${path}, your own file, ${read.lines.length} ${read.lines.length === 1 ? 'line' : 'lines'}` : `${path} holds no rules yet, so the routine returns no_rules_defined`;
  } catch {
    rules = `${path} is not there; rules in routine.yaml names it`;
  }
  const report = facts.report === undefined ? latestTestReport(routine) : facts.report;
  const fee = spec.fees.perTrade;
  return {
    name: spec.name,
    about: `your routine | every ${spec.every} | BTC/USD, long or flat`,
    reads: [
      ...spec.briefings.map((id) => ({ mark: 'pr' as const, name: id, what: 'briefing, as it stood at the run' })),
      { mark: 'pr', name: 'bitcoin-price', what: `${spec.priceDays} days of daily prices` },
      { mark: 'own', name: 'the position', what: 'flat or long, since when, and the change since entry' },
    ],
    fields: [
      { label: 'model', text: routineModelLine(routine, facts.model) },
      { label: 'rules', text: rules },
      { label: 'labels', text: spec.labels.map((l) => `${l.name} ${meaningOf(l.means)}`).join('; ') },
      { label: 'fees', text: fee === null ? 'not set yet: routine.yaml still has the placeholder' : `${Number((fee * 100).toFixed(4))}% a trade, your estimate` },
      { label: 'tests', text: report ? `${testSummary(report)}, ${shortTime(report.at)}` : `none run yet: add tests to tests.yaml, then test them` },
    ],
  };
}

// The page as plain lines, for a terminal that prints it once.
export function routineText(page: RoutinePage): string[] {
  return [
    `${page.name}  ${page.about}`,
    '  reads, every run',
    ...page.reads.map((r) => `  ${r.mark === 'pr' ? 'PR' : '> '} ${r.name.padEnd(18)} ${r.what}`),
    ...page.fields.map((f) => `  ${f.label.padEnd(7)} ${f.text}`),
  ];
}

// The rules as their screen has them: the file, what it holds, when it changed, and the
// newest test of it.
export interface RulesPage {
  routine: string;
  path: string;
  lines: number | null; // null while the file holds no rules
  labels: string[];
  edited: string | null;
  tests: string | null;
}

export function rulesPage(routine: Routine, home = homedir()): RulesPage {
  let lines: number | null = null;
  let edited: string | null = null;
  try {
    lines = readRules(routine)?.lines.length ?? null;
    edited = statSync(routine.rulesPath).mtime.toISOString();
  } catch {
    // The file is not there: the page says it holds no rules.
  }
  const report = latestTestReport(routine);
  return { routine: routine.spec.name, path: tildePath(routine.rulesPath, home), lines, labels: routine.spec.labels.map((l) => l.name), edited, tests: report ? testSummary(report) : null };
}

export function rulesFileLine(page: RulesPage): string {
  return page.lines === null ? 'no rules written yet' : `${page.lines} ${page.lines === 1 ? 'line' : 'lines'}, ${page.labels.length} ${page.labels.length === 1 ? 'label' : 'labels'}: ${page.labels.join(', ')}`;
}

