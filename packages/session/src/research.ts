import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CARD_FIELDS,
  HURDLE_NAMES,
  HYPOTHESIS_FILE,
  cardStated,
  formCheck,
  formWords,
  frozenCard,
  frozenTestOf,
  hypothesisTemplate,
  ladderOf,
  longDay,
  readCard,
  readVersions,
  registryOf,
  replayOf,
  trialsOf,
  type CardField,
  type HurdleId,
  type HurdleStatus,
  type LaterRun,
  type RegistryStatus,
  type Routine,
} from '@primerkit/core';
import { tildePath } from './routine';

// The research view's three screens: the person's hypothesis card with its form check, the
// hurdle ladder for a routine's newest backtest, and the registry of every version tested.
// The words are the person's own and code's; the model writes none of them.

// The line every one of these screens closes on. The form check is code, not the model, so
// it says so.
export const RESEARCH_CLOSING = "The model never proposes a strategy: it labels your runs, and primerkit's code checks your card's form. Every result here is from a simulated account: not a forecast, not advice.";

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string, year = false): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}${year ? `, ${iso.slice(0, 4)}` : ''}`;
const span = (from: string, to: string): string => (from.slice(0, 4) === to.slice(0, 4) ? `${dayLabel(from)} to ${dayLabel(to, true)}` : `${dayLabel(from, true)} to ${dayLabel(to, true)}`);

// "4 hypotheses and versions", or one.
const tested = (n: number): string => (n === 1 ? '1 hypothesis' : `${n} hypotheses and versions`);
// "7 backtests", or one: every backtest of a version counts, finished or not.
const backtests = (n: number): string => (n === 1 ? '1 backtest' : `${n} backtests`);

// ------------------------------------------------------------------ the card

export interface HypothesisPage {
  routine: string;
  state: string; // its version, and whether and when it was frozen
  fields: Array<{ field: CardField; text: string | null }>; // null while the field holds nothing
  form: string[]; // the form check, a status a field
  kept: string | null; // what a change does, and what is kept
  made: string | null; // where the file was made, when there was none
}

// The card in hypothesis.md as it stands now, against the versions frozen so far. A routine
// made before cards has no file: the template is written for it, never over a file.
// userHome: the person's home folder, so the path is written from ~.
export function hypothesisPage(routine: Routine, userHome = homedir()): HypothesisPage {
  let made: string | null = null;
  let read = readCard(routine);
  if (!read) {
    const path = join(routine.dir, HYPOTHESIS_FILE);
    writeFileSync(path, hypothesisTemplate(routine.spec.name), { flag: 'wx' });
    made = `Made ${tildePath(path, userHome)}: write your card there, in your own words.`;
    read = readCard(routine);
  }
  const card = read?.card ?? null;
  const versions = readVersions(routine.dir);
  const newest = versions.at(-1)?.version ?? 0;
  const frozen = card ? versions.find((v) => v.hash === card.hash) : undefined;
  let state: string;
  let kept: string | null = null;
  if (!card || !cardStated(card)) state = 'nothing written yet: the card freezes at the first backtest after it is written';
  else if (frozen) {
    state = `version ${frozen.version}, frozen ${longDay(frozen.frozenAt.slice(0, 10))} at the first backtest (hash ${frozen.hash.slice(0, 8)})`;
    kept = `Changing a frozen card makes version ${newest + 1}; version ${frozen.version} and its results are kept.`;
  } else {
    state = `version ${newest + 1}, not frozen yet: it freezes at its first backtest`;
    if (newest) kept = newest === 1 ? 'Version 1 and its results are kept.' : `Versions 1 to ${newest} and their results are kept.`;
  }
  return {
    routine: routine.spec.name,
    state,
    fields: CARD_FIELDS.map((field) => ({ field, text: card?.fields[field] ?? null })),
    form: card ? formCheck(card, routine.spec.briefings).map(formWords) : [],
    kept,
    made,
  };
}

// What the signature's line adds after the person's words, so its two halves are recalled.
export const SIGNATURE_HINT = '(what would be seen if it is true, and what would show it false)';

export function hypothesisText(page: HypothesisPage): string[] {
  return [
    ...(page.made ? [page.made, ''] : []),
    `Hypothesis  ${page.routine}, ${page.state}`,
    ...page.fields.map((f) => `  ${f.field.padEnd(10)} ${f.text ?? 'not written yet'}${f.field === 'signature' && f.text ? `   ${SIGNATURE_HINT}` : ''}`),
    '',
    `  Form check: ${page.form.join(' | ')}`,
    ...(page.kept ? [`  ${page.kept}`] : []),
    '',
    RESEARCH_CLOSING,
  ];
}

// ------------------------------------------------------------------ the ladder

export interface ResearchPage {
  routine: string;
  subtitle: string;
  rows: Array<{ id: HurdleId; name: string; status: HurdleStatus; text: string }>;
  end: { passed: boolean; text: string };
  // Which run this is: its version's frozen test, or a later run with the frozen test's result
  // beside it. Drawn in the one paragraph with the end, so a later run's pass never shows alone.
  which: string | null;
  trials: string;
  also: string; // the metrics the card does not name, by name alone: the result is the card's
}

// The frozen test's result, as the ladder of a later run names it.
function frozenWords(s: RegistryStatus): string | null {
  if (s.kind === 'testing') return null;
  if (s.kind === 'unread') return 'the frozen test is not read: a file in it is damaged';
  if (s.kind === 'passed') return "the frozen test passed H1 to H5: H1 and H2 on your criterion; H3 to H5 on primerkit's tests";
  return `the frozen test ${s.kind === 'failed' ? 'failed' : 'stopped'} at ${s.hurdle}`;
}

// The ladder for the routine's newest finished backtest, or null while it has none. replay
// names the command that draws the run's whole report, where the other metrics are.
export function researchPage(routine: Routine, home: string, replay: string): ResearchPage | null {
  const run = replayOf(routine);
  if (!run) return null;
  const stamp = run.run.hypothesis ?? null;
  const ladder = ladderOf(run, stamp ? frozenCard(routine.dir, stamp.version) : null);
  const trials = trialsOf(home);
  // A pass says whose each test is: H1 and H2 read the person's own criterion, and H3 to H5
  // primerkit's thresholds, as the README states them.
  const end = ladder.end
    ? { passed: false, text: `${ladder.end.status === 'failed' ? 'Failed' : 'Stopped'} at ${ladder.end.id}: ${ladder.end.reason}.` }
    : { passed: true, text: "Passed H1 to H5: H1 and H2 on the success criterion you set, H3 to H5 on primerkit's stated tests, in a simulated account (not a forecast, not advice)." };
  const frozen = stamp ? frozenTestOf({ name: routine.spec.name, dir: routine.dir }, stamp) : null;
  const words = frozen ? frozenWords(frozen.status) : null;
  return {
    routine: routine.spec.name,
    subtitle: `${routine.spec.name}, ${stamp ? `version ${stamp.version}` : 'no card frozen'}, backtest of ${span(ladder.window.from, ladder.window.to)}`,
    rows: ladder.hurdles.map((h) => ({ id: h.id, name: HURDLE_NAMES[h.id], status: h.status, text: h.text })),
    end,
    which: !frozen || !words ? null : frozen.runId === run.run.runId ? 'This is the frozen test.' : `This is a later run, not the frozen test (${words}).`,
    trials: `${tested(trials.versions)} tested in your registry, in ${backtests(trials.backtests)}.`,
    also: `also measured, not shown here: each arm's largest fall, trades, days in the market and fees, and the account held in BTC/USD throughout. ${replay} shows them.`,
  };
}

// The end and which run it is, as one paragraph.
export const endWords = (page: ResearchPage): string => (page.which ? `${page.end.text} ${page.which}` : page.end.text);

export function researchText(page: ResearchPage): string[] {
  return [
    `Research  ${page.subtitle}`,
    ...page.rows.map((r) => `  ${`${r.id} ${r.name}`.padEnd(20)} ${r.status.padEnd(8)} ${r.text}`),
    '',
    `  ${endWords(page)}`,
    `  ${page.trials}`,
    `  ${page.also}`,
    '',
    RESEARCH_CLOSING,
  ];
}

// ------------------------------------------------------------------ the registry

export interface RegistryPage {
  subtitle: string;
  // next: what a version stopped short can do; later: how many other backtests the version
  // has, if any; runs: each with its own result.
  rows: Array<{ routine: string; version: string; status: string; forward: string | null; note: string | null; next: string | null; later: string | null; runs: string[] }>;
  empty: string | null;
  damaged: string[]; // each backtest not read, as a file in it is damaged
  frozen: string | null; // what a version's status is from, and what the count counts
  footer: string;
}

// A status in the registry's own words: no "accepted", nothing "provisional".
function statusWords(s: RegistryStatus): { status: string; note: string | null } {
  if (s.kind === 'testing') return { status: 'testing', note: null };
  // Only H1 and H2 test the person's own criterion; H3 to H5 are primerkit's tests.
  if (s.kind === 'passed') return { status: "passed H1 to H5 (H1 and H2 on your criterion; H3 to H5 on primerkit's tests)", note: null };
  if (s.kind === 'stopped') return { status: `stopped at ${s.hurdle}: ${s.reason}`, note: null };
  if (s.kind === 'unread') return { status: 'frozen test not read: a file in it is damaged', note: null };
  return { status: `failed at ${s.hurdle}: ${s.reason}`, note: s.falsified ? '(falsified)' : null };
}

// Under a version whose frozen test stopped short: the way on, which is a new version.
export const STOPPED_NEXT = 'To test with other settings, make a new version; it counts in your trials.';

// A later run by its window, then its own result, or that it has not finished.
function runWords(run: LaterRun): string {
  if (!run.status) return `${span(run.window.from, run.window.to)} · not finished`;
  const { status, note } = statusWords(run.status);
  return `${span(run.window.from, run.window.to)} · ${status}${note ? `   ${note}` : ''}`;
}

export function registryPage(home: string): RegistryPage {
  const { rows, backtests: count, damaged } = registryOf(home);
  return {
    subtitle: rows.length ? `${tested(rows.length)}, ${backtests(count)}` : 'no hypotheses tested yet',
    rows: rows.map((r) => ({
      routine: r.routine,
      version: `v${r.version}`,
      ...statusWords(r.status),
      forward: r.forwardSince ? `tracking forward since ${dayLabel(r.forwardSince)} (simulated)` : null,
      next: r.status.kind === 'stopped' ? STOPPED_NEXT : null,
      later: r.later.length ? `later runs: ${r.later.length} (not the frozen test)` : null,
      runs: r.later.map(runWords),
    })),
    empty: rows.length ? null : "A card written in a routine's hypothesis.md freezes at the routine's next backtest, and each version is listed here.",
    damaged: damaged.map((d) => `${d.routine}'s backtest ${d.runId} is not read: a file in it is damaged.`),
    // What finished means, said where the person reads the statuses (the wording review, 10-14).
    frozen: rows.length ? "A version's status comes from its frozen test: its first backtest to finish with a result. Every backtest counts in the total above, including one cancelled or ended by an error, which is never a frozen test." : null,
    footer: "Each version's card and results are kept on this machine.",
  };
}

export function registryText(page: RegistryPage): string[] {
  const width = Math.max(0, ...page.rows.map((r) => r.routine.length)) + 2;
  return [
    `Registry  ${page.subtitle}`,
    ...(page.empty ? [`  ${page.empty}`] : []),
    ...page.rows.flatMap((r) => [
      `  ${r.routine.padEnd(width)}${r.version.padEnd(5)}${r.status}${r.forward ? ` | ${r.forward}` : ''}${r.note ? `   ${r.note}` : ''}`,
      ...(r.next ? [`  ${''.padEnd(width + 5)}${r.next}`] : []),
      // Printed, every later run has the room for its own result.
      ...(r.later ? [`  ${''.padEnd(width + 5)}${r.later}`, ...r.runs.map((w) => `  ${''.padEnd(width + 7)}${w.replaceAll(' · ', ' | ')}`)] : []),
    ]),
    ...page.damaged.map((d) => `  ${d}`),
    ...(page.frozen ? [`  ${page.frozen}`] : []),
    `  ${page.footer}`,
    '',
    RESEARCH_CLOSING,
  ];
}
