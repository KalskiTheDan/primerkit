import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BacktestRun, addDays, hypothesisTemplate, loadRoutine, planBacktest, type Arm, type Close, type Routine } from '@primerkit/core';
import { maker, widthOf, type Line } from '@primerkit/ui';
import {
  GRID,
  RESEARCH_CLOSING,
  entryLines,
  hypothesisPage,
  hypothesisText,
  initialState,
  registryPage,
  registryText,
  researchPage,
  researchText,
  type Entry,
} from '../src/index';

// Every screen of the research view as it draws, for every state a fixture here reaches, in
// colour and ASCII at the narrowest, middle and grid widths, and as a terminal prints it:
// the words the wording review cleared, and none it ruled out.

const TODAY = '2026-10-12';
const FROM = '2026-08-01';
const TO = '2026-09-29';

// The closes the core tests use: a calm month below the 200 day average, then a step up into
// a wide month above it, with a swing every other day.
const swing = (i: number): number => 0.004 + 0.0003 * i;
const baseAt = (i: number): number => (i < 30 ? 96_000 * 1.0015 ** i : 106_000 * 1.0015 ** (i - 30));
const priceAt = (i: number): number => (i < 0 ? 100_000 - 25 * (i + 1) + (i % 2 ? 100 : -100) : baseAt(i) * (1 + swing(i) * (i % 2 ? -1 : 1)));
const CLOSES: Close[] = Array.from({ length: 463 }, (_, k) => k - 400).map((i) => ({ date: addDays(FROM, i), price: Math.round(priceAt(i) * 100) / 100 }));
const closeOn = (date: string): number => (CLOSES.find((c) => c.date === date) as Close).price;

const YAML = (over: { priceDays?: number; spread?: string | null } = {}) =>
  ['rules: rules.md', 'data:', '  briefings: [btc.pulse]', `  price_days: ${over.priceDays ?? 365}`, 'labels:', '  watch: { hold: true }', '  enter: { target: 1 }', '  exit: { target: 0 }', 'fees: { per_trade: 0.001 }', ...(over.spread === null ? [] : [`spread_bps: ${over.spread ?? 10}`]), ''].join('\n');

const CARD = (success = 'treatment ahead of control by at least 1 point over the backtest', kill = 'treatment behind control by 1 point') =>
  `## Claim\nThe every other day swing can be caught a day ahead.\n\n## Mechanism\nThe closes alternate.\n\n## Expected signature\nTreatment gains on the days btc.pulse and the price table show a rise.\n\n## Universe and horizon\nBTC/USD, a day at a time.\n\n## Success criterion\n${success}\n\n## Kill criterion\n${kill}\n`;

type Labels = (arm: Arm, i: number, tick: string) => string | null;
const ahead: Labels = (arm, i, tick) => (arm !== 'treatment' || i < 2 ? 'watch' : closeOn(addDays(tick, 2)) > closeOn(addDays(tick, 1)) ? 'enter' : 'exit');
const long: Labels = (arm, i) => (arm === 'treatment' && i >= 2 ? 'enter' : 'watch');
const early: Labels = (arm, i, tick) => (arm !== 'treatment' ? 'watch' : i < 2 ? 'enter' : ahead(arm, i, tick));

const home = mkdtempSync(join(tmpdir(), 'primerkit-research-screens-'));

function routineIn(name: string, yaml = YAML(), card: string | null = CARD()): Routine {
  const dir = join(home, 'routines', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'routine.yaml'), yaml);
  writeFileSync(join(dir, 'rules.md'), 'Enter before a rise, exit before a fall.\n');
  if (card !== null) writeFileSync(join(dir, 'hypothesis.md'), card);
  return loadRoutine(dir);
}

async function backtest(routine: Routine, labels: Labels, over: { inside?: boolean; finish?: boolean; at?: string } = {}): Promise<void> {
  const cutoff = { cutoff: over.inside ? '2026-09' : '2024-09', source: 'test', basis: 'person' as const };
  const plan = planBacktest(routine, { from: FROM, to: TO, ...(over.inside ? { insideTraining: true } : {}) }, { tier: 'enterprise', today: TODAY, format: 'markdown', model: 'scripted', cutoff });
  const source = { briefing: async () => ({ raw: '' }), closes: async (from: string, to: string) => CLOSES.filter((c) => c.date >= from && c.date <= to) };
  const run = (await BacktestRun.start({ routine, plan, model: 'scripted', source, now: () => new Date(over.at ?? `${TODAY}T12:00:00.000Z`) })) as BacktestRun;
  const index = new Map(plan.ticks.map((t, i) => [t, i]));
  for (let key = run.next(); key; key = run.next()) {
    const label = labels(key.arm, index.get(key.tick) as number, key.tick);
    run.record(key, { label, outcome: 'passed', runId: `r-${key.arm}-${key.tick}` });
  }
  if (over.finish !== false) run.finish();
}

// Each ladder state a person can reach, by the routine that reaches it.
const LADDERS: Array<{ name: string; yaml?: string; card?: string | null; labels: Labels; inside?: boolean; end: RegExp }> = [
  { name: 'passes', labels: ahead, end: /^Passed H1 to H5: H1 and H2 on the success criterion you set, H3 to H5 on primerkit's stated tests, in a simulated account \(not a forecast, not advice\)\.$/ },
  { name: 'far', card: CARD('treatment ahead of control by 1000 points'), labels: ahead, end: /^Failed at H1: treatment's lead over control was/ },
  { name: 'nospread', yaml: YAML({ spread: null }), labels: ahead, end: /^Stopped at H2: no spread set\.$/ },
  { name: 'costly', yaml: YAML({ spread: '500' }), labels: ahead, end: /^Failed at H2: after costs, treatment's lead over control was/ },
  { name: 'early', labels: early, end: /^Passed H1 to H5/ },
  { name: 'short', yaml: YAML({ priceDays: 30 }), labels: ahead, end: /^Stopped at H4: too few days to test above and below the 200 day average\.$/ },
  { name: 'inside', labels: ahead, inside: true, end: /^Failed at H4: the backtest window is inside the model's training\.$/ },
  { name: 'noisy', labels: long, end: /^Failed at H5: the edge over control's interval includes zero\.$/ },
  { name: 'nocard', card: null, labels: ahead, end: /^Stopped at H1: no card was frozen with this backtest\.$/ },
  { name: 'vague', card: CARD('a clear lead over control'), labels: ahead, end: /^Stopped at H1: your success criterion has no number\.$/ },
];

// The words the wording review ruled out of these screens, and any word of an order, a broker,
// executing or going live: PreReason never executes trades, and these screens never point at it.
const BANNED = /\b(holds|weakening|retire|accepted|provisional|recommend|should)\b/i;
const NO_ORDERS = /\b(orders?|ordered|broker\w*|execut\w*|go live|going live|buy\w*|sell\w*)\b/i;

const text = (lines: Line[]): string => lines.map((l) => l.map(([, s]) => s).join('')).join('\n');
const flat = (s: string): string => s.replace(/^ [|│└+](?= |$) ?/gm, '').replace(/\s+/g, ' ');

// An entry drawn at every width in both glyph sets, each line within the width and the ASCII
// all ASCII, with the closing line at its end; returned as one text a draw, frame taken off.
function drawn(entry: Entry): string[] {
  const out: string[] = [];
  for (const width of [48, 60, GRID.width]) {
    for (const ascii of [true, false]) {
      const lines = entryLines({ ...initialState(null), size: { ...GRID, width, columns: width } }, maker(ascii), entry);
      for (const line of lines) expect(widthOf(line), `${entry.kind} at ${width}: ${text([line])}`).toBeLessThanOrEqual(width);
      if (ascii) expect(/^[\x00-\x7f]*$/.test(text(lines)), `${entry.kind} at ${width}`).toBe(true);
      const words = flat(text(lines));
      expect(words.trimEnd().endsWith(RESEARCH_CLOSING), `${entry.kind} at ${width} closes on the line`).toBe(true);
      out.push(words);
    }
  }
  return out;
}

describe('the research view, as every screen of it draws', () => {
  const screens: Array<{ what: string; text: string }> = [];
  const keep = (what: string, texts: string[]) => texts.forEach((t) => screens.push({ what, text: t }));

  it('draws each ladder state, top to bottom, ending where the ladder stops', async () => {
    for (const l of LADDERS) {
      const routine = routineIn(l.name, l.yaml, l.card);
      await backtest(routine, l.labels, { ...(l.inside ? { inside: true } : {}) });
      const page = researchPage(routine, home, `/routine ${l.name} replay`);
      expect(page, l.name).not.toBeNull();
      if (!page) continue;
      expect(page.end.text, l.name).toMatch(l.end);
      // Top to bottom, every hurdle passed but the last, which is the one the end names.
      const ids = page.rows.map((r) => r.id);
      expect(ids, l.name).toEqual(['H1', 'H2', 'H3', 'H4', 'H5'].slice(0, ids.length));
      expect(page.rows.slice(0, -1).every((r) => r.status === 'passed'), l.name).toBe(true);
      // The trials count stands under every ladder, whatever its result.
      expect(page.trials, l.name).toMatch(/^(1 hypothesis|\d+ hypotheses and versions) tested in your registry, in (1 backtest|\d+ backtests)\.$/);
      // Each is its version's one backtest, so its frozen test; with no card, no version.
      expect(page.which, l.name).toBe(l.card === null ? null : 'This is the frozen test.');
      keep(`research ${l.name}`, drawn({ kind: 'research', question: `/routine ${l.name} research`, page }));
      keep(`research ${l.name}, printed`, [researchText(page).join('\n')]);
    }
  }, 120_000);

  it('names each regime window with its size, and a thin one too few days to test', () => {
    const passes = screens.find((s) => s.what === 'research passes')?.text ?? '';
    expect(passes).toMatch(/H4 out of sample passed after the model's cutoff; in high and low volatility \(30 day realised; \d+ and \d+ days\), above and below the 200 day average \(\d+ and \d+ days\)/);
    const short = screens.find((s) => s.what === 'research short')?.text ?? '';
    expect(short).toMatch(/H4 out of sample stopped after the model's cutoff; in high and low volatility \(30 day realised; \d+ and \d+ days\), above and below the 200 day average \(0 and 0 days\): too few days to test above and below the 200 day average/);
    expect(short).not.toMatch(/H4 out of sample passed/);
    expect(screens.find((s) => s.what === 'research nospread')?.text).toContain('H2 realistic costs stopped no spread set: add spread_bps to routine.yaml');
    expect(screens.find((s) => s.what === 'research early')?.text).toContain('the edge stays above control on 5 of 5 nearby settings (sizes, fees, start day); 2 settings left out: equal to yours (size capped at 1); 2 not re-run, as they change the position your labels read');
    // A share of 1 a tenth and a fifth higher is still the person's own size: left out, and named.
    expect(screens.find((s) => s.what === 'research passes')?.text).toContain('the edge stays above control on 7 of 7 nearby settings (sizes, fees, start day); 2 settings left out: equal to yours (size capped at 1)');
    expect(screens.find((s) => s.what === 'research noisy')?.text).toMatch(/H5 significance failed the edge over control's 95% interval includes zero \(-\d+\.\d% to \d+\.\d%\)/);
  });

  it('draws the card in each state: blank, written, frozen, changed after its freeze, and made where it was not', async () => {
    const blank = routineIn('blank', YAML(), hypothesisTemplate('blank'));
    keep('card blank', drawn({ kind: 'hypothesis', question: '/routine blank hypothesis', page: hypothesisPage(blank, home) }));
    const written = routineIn('written', YAML(), CARD('treatment ahead of control by 1 point', '<your criterion, with its number>'));
    const page = hypothesisPage(written, home);
    expect(page.state).toBe('version 1, not frozen yet: it freezes at its first backtest');
    keep('card written', drawn({ kind: 'hypothesis', question: '/routine written hypothesis', page }));
    await backtest(written, ahead);
    const frozen = hypothesisPage(written, home);
    expect(frozen.state).toMatch(/^version 1, frozen Oct 12, 2026 at the first backtest \(hash [0-9a-f]{8}\)$/);
    expect(frozen.kept).toBe('Changing a frozen card makes version 2; version 1 and its results are kept.');
    keep('card frozen', drawn({ kind: 'hypothesis', question: '/routine written hypothesis', page: frozen }));
    writeFileSync(join(written.dir, 'hypothesis.md'), CARD('treatment ahead of control by 2 points'));
    const changed = hypothesisPage(written, home);
    expect([changed.state, changed.kept]).toEqual(['version 2, not frozen yet: it freezes at its first backtest', 'Version 1 and its results are kept.']);
    keep('card changed', drawn({ kind: 'hypothesis', question: '/routine written hypothesis', page: changed }));
    rmSync(join(blank.dir, 'hypothesis.md'));
    const made = hypothesisPage(blank, home);
    expect(made.made).toMatch(/^Made ~\/routines\/blank\/hypothesis\.md: write your card there, in your own words\.$/);
    keep('card made', drawn({ kind: 'hypothesis', question: '/routine blank hypothesis', page: made }));
    for (const p of [page, frozen, changed, made]) keep('card printed', [hypothesisText(p).join('\n')]);
    // The signature's line recalls both halves of what it is, never with "should".
    expect(screens.find((s) => s.what === 'card frozen')?.text).toContain('(what would be seen if it is true, and what would show it false)');
  });

  it('draws the registry by name with every status, and with none', async () => {
    const routine = routineIn('tracked');
    await backtest(routine, ahead);
    mkdirSync(join(routine.dir, 'forward'), { recursive: true });
    writeFileSync(join(routine.dir, 'forward', 'record.jsonl'), `${JSON.stringify({ at: '2026-10-12T13:30:00.000Z', day: '2026-10-12', close: { date: '2026-10-11', price: 1 }, label: 'watch', outcome: 'passed', runId: 'f', model: 'm', rulesHash: 'h', target: null, capped: false, reads: [] })}\n`);
    const unfinished = routineIn('unfinished');
    await backtest(unfinished, ahead, { finish: false });
    // The same card backtested three times: its frozen test fails at H1, a later run passes
    // and one more is not finished. The version's status stays its frozen test's.
    const retried = routineIn('retried');
    await backtest(retried, () => 'watch', { at: '2026-10-12T09:00:00.000Z' });
    await backtest(retried, ahead, { at: '2026-10-12T10:00:00.000Z' });
    await backtest(retried, ahead, { at: '2026-10-12T11:00:00.000Z', finish: false });
    const page = registryPage(home);
    const words = page.rows.map((r) => `${r.routine} ${r.version} ${r.status}${r.forward ? ` | ${r.forward}` : ''}${r.note ? ` ${r.note}` : ''}`);
    expect(words).toContain("tracked v1 passed H1 to H5 (H1 and H2 on your criterion; H3 to H5 on primerkit's tests) | tracking forward since Oct 12 (simulated)");
    expect(words).toContain('unfinished v1 testing');
    expect(words.find((w) => w.startsWith('far v1'))).toMatch(/^far v1 failed at H1: treatment's lead over control was \d+\.\d points; your success criterion asks for 1000 \(falsified\)$/);
    expect(words.find((w) => w.startsWith('noisy v1'))).toBe("noisy v1 failed at H5: the edge over control's interval includes zero");
    // A frozen test whose ladder stopped short of a verdict stops its version there, and the
    // line under it says the way on is a new version, counted.
    expect(words).toContain('nospread v1 stopped at H2: no spread set');
    expect(page.rows.find((r) => r.routine === 'nospread')?.next).toBe('To test with other settings, make a new version; it counts in your trials.');
    expect(page.rows.filter((r) => r.next).map((r) => r.routine)).toEqual(page.rows.filter((r) => r.status.startsWith('stopped at')).map((r) => r.routine));
    expect(page.rows.filter((r) => r.next).length).toBeGreaterThan(0);
    const again = page.rows.find((r) => r.routine === 'retried');
    expect(again).toMatchObject({ status: "failed at H1: treatment's lead over control was 0.0 points; your success criterion asks for 1", note: '(falsified)', later: 'later runs: 2 (not the frozen test)' });
    expect(again?.runs).toEqual(["Aug 1 to Sep 29, 2026 · passed H1 to H5 (H1 and H2 on your criterion; H3 to H5 on primerkit's tests)", 'Aug 1 to Sep 29, 2026 · not finished']);
    expect(page.rows.filter((r) => r.later).map((r) => r.routine)).toEqual(['retried']);
    // By name, never by result.
    expect(page.rows.map((r) => r.routine)).toEqual([...page.rows.map((r) => r.routine)].sort());
    // Every backtest counts: one a version here, and retried's two later runs.
    expect(page.subtitle).toBe(`${page.rows.length} hypotheses and versions, ${page.rows.length + 2} backtests`);
    expect(page.frozen).toBe("A version's status comes from its frozen test: its first backtest to finish with a result. Every backtest counts in the total above, including one cancelled or ended by an error, which is never a frozen test.");
    expect(page.damaged).toEqual([]);
    const screensOf = drawn({ kind: 'registry', question: '/routine registry', page });
    // Each later run with its own result where the width allows; their count alone where not.
    for (const [i, s] of screensOf.entries()) {
      expect(s, `draw ${i}`).toContain('later runs: 2 (not the frozen test)');
      expect(s, `draw ${i}`).toContain(page.frozen as string);
      expect(s, `draw ${i}`).toMatch(/nospread v1 stopped at H2: no spread set To test with other settings, make a new version; it counts in your trials\./);
      if (i < 2) expect(s, `draw ${i}`).not.toContain('not finished');
      else expect(s, `draw ${i}`).toMatch(/Aug 1 to Sep 29, 2026 [·|] not finished/);
    }
    keep('registry', screensOf);
    // Printed, under the version's status, every later run with its result.
    const printed = registryText(page);
    const at = printed.findIndex((l) => l.startsWith('  retried '));
    const column = (printed[at] as string).indexOf('failed at H1');
    expect(printed[at]).toMatch(/ {3}\(falsified\)$/);
    expect(printed.slice(at + 1, at + 4)).toEqual([
      `${' '.repeat(column)}later runs: 2 (not the frozen test)`,
      `${' '.repeat(column + 2)}Aug 1 to Sep 29, 2026 | passed H1 to H5 (H1 and H2 on your criterion; H3 to H5 on primerkit's tests)`,
      `${' '.repeat(column + 2)}Aug 1 to Sep 29, 2026 | not finished`,
    ]);
    const stopped = printed.findIndex((l) => l.startsWith('  nospread '));
    expect(printed[stopped + 1]).toBe(`${' '.repeat((printed[stopped] as string).indexOf('stopped at H2'))}To test with other settings, make a new version; it counts in your trials.`);
    keep('registry printed', [printed.join('\n')]);
    // The ladder of the newest finished run, a later one that passed, says so in the one
    // paragraph with its pass, with the frozen test's failure beside it.
    const ladder = researchPage(retried, home, '/routine retried replay');
    expect(ladder?.end.text).toMatch(/^Passed H1 to H5: /);
    expect(ladder?.which).toBe('This is a later run, not the frozen test (the frozen test failed at H1).');
    const later = drawn({ kind: 'research', question: '/routine retried research', page: ladder! });
    for (const s of later) expect(s).toContain("in a simulated account (not a forecast, not advice). This is a later run, not the frozen test (the frozen test failed at H1).");
    const text = researchText(ladder!);
    expect(text).toContain(`  ${ladder?.end.text} This is a later run, not the frozen test (the frozen test failed at H1).`);
    keep('research retried', later);
    keep('research retried, printed', [text.join('\n')]);
    const empty = registryPage(mkdtempSync(join(tmpdir(), 'primerkit-research-empty-')));
    expect(empty.subtitle).toBe('no hypotheses tested yet');
    keep('registry empty', drawn({ kind: 'registry', question: '/routine registry', page: empty }));
  }, 120_000);

  it('never says a word the wording review ruled out, nor one of orders, brokers or going live, on any of them', () => {
    // The closing line names what the model does as the code does it: the form check is
    // code's, so the line says so.
    expect(RESEARCH_CLOSING).toBe("The model never proposes a strategy: it labels your runs, and primerkit's code checks your card's form. Every result here is from a simulated account: not a forecast, not advice.");
    expect(screens.length).toBeGreaterThan(80);
    for (const s of screens) {
      expect(s.text, s.what).not.toMatch(BANNED);
      expect(s.text, s.what).not.toMatch(NO_ORDERS);
      // Only H1 and H2 read the person's own criterion: a pass of all five never credits them
      // with H3 to H5, which are primerkit's tests, and always says so.
      expect(s.text, s.what).not.toMatch(/criteria you set|your criteria/i);
      if (/passed H1 to H5/i.test(s.text)) expect(s.text, s.what).toMatch(/H1 and H2 on (the success criterion you set|your criterion)[,;] H3 to H5 on primerkit's (stated )?tests/);
      expect(s.text, s.what).toContain('The model never proposes a strategy');
      expect(s.text, s.what).toContain('not a forecast, not advice');
    }
  });
});
