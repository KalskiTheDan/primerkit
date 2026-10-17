import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Journal,
  NO_RULES,
  RoutineError,
  buildPacket,
  judgeTestRun,
  latestTestReport,
  listRoutines,
  loadOperation,
  loadRoutine,
  loadRoutineTests,
  newRoutine,
  parseRoutine,
  parseRoutineTests,
  positionBlock,
  priceBlock,
  readFixture,
  readRules,
  routineFiles,
  routineOperation,
  rulesBlock,
  rulesLines,
  runRoutine,
  scopeCheck,
  testLines,
  testRoutine,
  testSummary,
  unsetLabels,
  type CheckFailure,
  type Close,
  type DataBlock,
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
const READ_AT = '2026-09-25T12:00:00.000Z';

const RULES = `<!-- my own notes, not rules -->
# My rules

1. Enter when the change over 7 days is above +2.0% and nothing is held.
2. Exit when the change since entry is above +10.0%.
3. Otherwise watch.
`;

const ROUTINE_YAML = `rules: rules.md
every: day
data:
  briefings: [btc.pulse]
  price_days: 30
labels:
  watch: { hold: true }
  enter: { target: 0.5 }
  exit: { target: 0 }
fees: { per_trade: 0.001 }
`;

// 31 daily closes, $100,000 on Aug 26 rising $1,000 a day to $130,000 on Sep 25.
const CLOSES: Close[] = Array.from({ length: 31 }, (_, i) => ({
  date: new Date(Date.parse('2026-08-26T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10),
  price: 100_000 + 1_000 * i,
}));
const NOW = CLOSES.at(-1) as Close;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'primerkit-routine-'));
}

// A routine folder with the given files, loaded.
function routineIn(files: Partial<Record<'routine.yaml' | 'rules.md' | 'tests.yaml', string>> = {}, name = 'btc-rules'): Routine {
  const dir = join(tempDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'routine.yaml'), files['routine.yaml'] ?? ROUTINE_YAML);
  writeFileSync(join(dir, 'rules.md'), files['rules.md'] ?? RULES);
  if (files['tests.yaml']) writeFileSync(join(dir, 'tests.yaml'), files['tests.yaml']);
  return loadRoutine(dir);
}

const pulse = (): DataBlock => ({ ...blockOf('btc.pulse') });
function blockOf(id: string): DataBlock {
  return { id, source: 'prereason', format: 'markdown', fetchedAt: READ_AT, lines: PULSE_MD.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean) };
}
const dataBlocks = (): DataBlock[] => [pulse(), priceBlock(CLOSES, READ_AT), positionBlock({ kind: 'flat' }, NOW, READ_AT)];

// The number of the line in a block that starts with some text, as the packet numbers it.
function lineOf(block: DataBlock, starts: string): { line: number; text: string } {
  const i = block.lines.findIndex((l) => l.startsWith(starts));
  if (i < 0) throw new Error(`no line starting ${starts} in ${block.id}`);
  return { line: i + 1, text: block.lines[i] as string };
}

const PRICE = priceBlock(CLOSES, READ_AT);
const WEEK = lineOf(PRICE, 'change over 7 days');

// An answer that gives enter by rule 1, citing the price table and the rule.
function enter(label = 'enter', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    label,
    reason: 'Rule 1 gave enter: the price rose over 7 days and nothing is held.',
    claims: [
      { text: 'Bitcoin rose +5.7% over 7 days.', citations: [{ block: 'price', line: WEEK.line, quote: 'change over 7 days: +5.7%' }] },
      { text: 'Rule 1 enters when the 7 day change is above +2.0% and nothing is held.', citations: [{ block: 'rules', line: 2, quote: 'Enter when the change over 7 days is above +2.0%' }] },
    ],
    not_in_data: [],
    ...extra,
  });
}

// A label's claims, one a line: a rule, and lines of the data its rules were applied to.
type Cite = { block: string; line: number; quote: string };
const RULE_1: Cite = { block: 'rules', line: 2, quote: 'Enter when the change over 7 days is above +2.0%' };
const RULE_2: Cite = { block: 'rules', line: 3, quote: 'Exit when the change since entry is above +10.0%' };
const RISE: Cite = { block: 'price', line: WEEK.line, quote: 'change over 7 days: +5.7%' };
const FLAT: Cite = { block: 'position', line: 1, quote: 'flat: no BTC/USD held' };
// Long since Sep 15 at $112,000, up 16.1% by Sep 25: past rule 2's +10.0%.
const GAIN: Cite = { block: 'position', line: 3, quote: 'change since entry: +16.1%' };
const longBlocks = (at: number): DataBlock[] => [pulse(), priceBlock(CLOSES, READ_AT), positionBlock({ kind: 'long', since: '2026-09-15', at }, NOW, READ_AT)];
const RULES_ONLY = 'the label cites only your rules, and no line of the data they were applied to';

function labelled(label: string, ...cites: Cite[]): string {
  return JSON.stringify({ label, reason: `The rules gave ${label}.`, claims: cites.map((c) => ({ text: `The packet reads ${c.quote}.`, citations: [c] })), not_in_data: [] });
}

// A model that answers from a script: a list of texts, one a turn, or a function of the
// turn and the packet.
class Scripted implements ModelAdapter {
  readonly id = 'scripted';
  readonly label = 'scripted, local';
  readonly repairs: Array<CheckFailure[] | undefined> = [];
  readonly packets: Packet[] = [];
  turns = 0;
  constructor(private readonly script: string[] | ((turn: number, packet: Packet) => string)) {}
  async capabilities(): Promise<ModelCapabilities> {
    return { local: true, schemaConstraint: false, contextTokens: null, canRaiseContext: false, format: 'markdown' };
  }
  async complete(packet: Packet, repair?: CheckFailure[]) {
    this.repairs.push(repair);
    this.packets.push(packet);
    const turn = this.turns++;
    const text = typeof this.script === 'function' ? this.script(turn, packet) : (this.script[Math.min(turn, this.script.length - 1)] ?? '');
    return { text };
  }
}

describe('routine.yaml', () => {
  it('loads a new routine as primerkit writes it, placeholders and all', () => {
    const home = tempDir();
    const made = newRoutine(home, 'btc-rules');
    expect(made.files.map((f) => f.slice(made.dir.length + 1)).sort()).toEqual(['hypothesis.md', 'routine.yaml', 'rules.md', 'tests.yaml']);
    const routine = loadRoutine(made.dir, home);
    expect(routine.spec).toMatchObject({ name: 'btc-rules', every: 'day', briefings: ['macro.snapshot', 'btc.context'], priceDays: 200, fees: { perTrade: null }, spreadBps: null, symbol: 'BTC/USD' });
    expect(routine.spec.labels).toEqual([
      { name: 'watch', means: { kind: 'hold' } },
      { name: 'enter', means: { kind: 'unset', placeholder: '<your share from 0 to 1>' } },
      { name: 'exit', means: { kind: 'target', share: 0 } },
    ]);
    expect(unsetLabels(routine)).toEqual(['enter']);
    expect(routine.rulesPath).toBe(join(made.dir, 'rules.md'));
    expect(listRoutines(home)).toEqual(['btc-rules']);
    expect(loadRoutineTests(routine)).toEqual({ runs: 5, tests: [] });
  });

  it('reads 200 days of prices where routine.yaml names none, enough for the 200 day average, and says what a free key reads', () => {
    const home = tempDir();
    const made = newRoutine(home, 'btc-rules');
    const yaml = readFileSync(join(made.dir, 'routine.yaml'), 'utf8');
    expect(yaml).toContain('  price_days: 200\n');
    expect(yaml).toContain('A free PreReason key reads the last\n  # 30 days, and a run counts back from yesterday\'s close, so on a free key write 28 here.');
    const labels = { watch: { hold: true }, exit: { target: 0 } };
    expect(parseRoutine({ rules: 'rules.md', data: { briefings: ['btc.pulse'] }, labels }, 'r', made.dir, home).spec.priceDays).toBe(200);
    expect(parseRoutine({ rules: 'rules.md', labels }, 'r', made.dir, home).spec.priceDays).toBe(200);
    expect(parseRoutine({ rules: 'rules.md', data: { price_days: 30 }, labels }, 'r', made.dir, home).spec.priceDays).toBe(30);
  });

  it('never writes over a routine that exists, and refuses a name it cannot use', () => {
    const home = tempDir();
    newRoutine(home, 'btc-rules');
    expect(() => newRoutine(home, 'btc-rules')).toThrow(/already/);
    expect(() => newRoutine(home, 'BTC rules')).toThrow(/not a routine name/);
    // /routine new and /routine registry are commands, so neither word names a routine.
    expect(() => newRoutine(home, 'registry')).toThrow('"registry" names a /routine command of its own, so it cannot name a routine.');
    expect(() => newRoutine(home, 'new')).toThrow(/names a \/routine command/);
  });

  it('names every problem at once, each with its field', () => {
    const raw = {
      rules: '',
      every: 'hourly',
      data: { briefings: ['btc.pulse', 'btc.pulse', 'equities.us-close', 'Not An Id'], price_days: 3, extra: 1 },
      labels: { enter: { target: 1.5 }, no_rules_defined: { hold: true }, both: { target: 0, hold: true }, Bad: { hold: true }, empty: {} },
      fees: { per_trade: 0.2 },
      symbol: 'ETH/USD',
      colour: 'green',
    };
    let error: RoutineError | null = null;
    try {
      parseRoutine(raw, 'btc-rules', tempDir());
    } catch (e) {
      error = e as RoutineError;
    }
    expect(error).toBeInstanceOf(RoutineError);
    const problems = error?.problems.join('\n') ?? '';
    for (const expected of [
      'colour is not a field of a routine',
      'rules names no file',
      'every is day or week, not "hourly"',
      'btc.pulse is listed twice',
      'equities.us-close is refused',
      '"Not An Id" is not a briefing id',
      'data.price_days is a whole number of days from 7 to 365, not 3',
      'data.extra is not a field of data',
      'labels.enter.target is the share of the account',
      'no_rules_defined is what a routine with no rules returns',
      'labels.both has both a target and hold',
      '"Bad" is not a label name',
      'labels.empty needs a target from 0 to 1, or hold: true',
      'fees.per_trade is your estimate',
      'symbol is BTC/USD, the only symbol primerkit runs routines on',
      'not 1.5; a routine holds long or flat only',
    ]) {
      expect(problems).toContain(expected);
    }
    expect(error?.problems.length).toBe(15);
  });

  // The walk of 10-14 (O3, O8) read "the one this slice runs": a word from the build, not one
  // a person knows. No text a person reads says it: the code's own words, the README, the
  // guides and the skills.
  it('never says "this slice" to a person', () => {
    const files: string[] = [join(REPO, 'README.md')];
    const under = (dir: string, keep: (name: string) => boolean): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'test') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) under(path, keep);
        else if (keep(name)) files.push(path);
      }
    };
    under(join(REPO, 'packages'), (name) => name.endsWith('.ts'));
    under(join(REPO, 'guides'), (name) => name.endsWith('.md'));
    under(join(REPO, 'hosts'), (name) => /\.(md|mjs)$/.test(name));
    under(join(REPO, 'operations'), (name) => /\.(md|yaml)$/.test(name));
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => /this slice/i.test(readFileSync(f, 'utf8'))).map((f) => f.slice(REPO.length))).toEqual([]);
  });

  it('needs at least one label', () => {
    expect(() => parseRoutine({ rules: 'rules.md' }, 'btc-rules', tempDir())).toThrow(/labels needs at least one label/);
  });

  it('reads ~ as the home folder and a relative path from the routine folder', () => {
    const labels = { watch: { hold: true } };
    expect(parseRoutine({ rules: '~/notes/btc.md', labels }, 'a', '/r/a', '/home/me').rulesPath).toBe(join('/home/me', 'notes/btc.md'));
    expect(parseRoutine({ rules: 'rules.md', labels }, 'a', join(tempDir(), 'a')).rulesPath).toMatch(/[\\/]a[\\/]rules\.md$/);
  });

  it('takes a model named as the config names one', () => {
    const routine = parseRoutine({ rules: 'rules.md', labels: { watch: { hold: true } }, model: { kind: 'ollama', name: 'qwen2.5:7b' } }, 'a', tempDir());
    expect(routine.spec.model).toEqual({ kind: 'ollama', name: 'qwen2.5:7b' });
    expect(() => parseRoutine({ rules: 'rules.md', labels: { watch: { hold: true } }, model: { kind: 'hosted', name: 'x' } }, 'a', tempDir())).toThrow(/model.provider/);
  });
});

describe('the rules', () => {
  it('takes out comments, blank lines and lines with no words', () => {
    expect(rulesLines(RULES)).toEqual(['# My rules', '1. Enter when the change over 7 days is above +2.0% and nothing is held.', '2. Exit when the change since entry is above +10.0%.', '3. Otherwise watch.']);
    expect(rulesLines('Enter on a rise.\n---\n\n<!-- a note\nthat runs on')).toEqual(['Enter on a rise.']);
  });

  it('finds none in the file a new routine starts with', () => {
    expect(rulesLines(routineFiles('btc-rules')['rules.md'])).toEqual([]);
  });

  it('returns no_rules_defined and asks no model while the file holds none', async () => {
    const routine = routineIn({ 'rules.md': routineFiles('btc-rules')['rules.md'] });
    const model = new Scripted([enter()]);
    const journal = new Journal(tempDir());
    const run = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model, journal });
    expect(run).toEqual({ kind: NO_RULES, rulesPath: routine.rulesPath });
    expect(model.turns).toBe(0);
    expect(readdirSync(journal.root)).toEqual([]);
  });

  it('says so when the rules file is not there', () => {
    const routine = routineIn();
    const moved = { ...routine, rulesPath: join(routine.dir, 'gone.md') };
    expect(() => readRules(moved)).toThrow(/the rules file .*gone\.md is not there/);
  });
});

describe('the routine operation', () => {
  it('names the routine and the rules it read, and holds the label to the routine own labels', () => {
    const routine = routineIn();
    const rules = readRules(routine);
    if (!rules) throw new Error('no rules');
    const op = routineOperation(BASE, routine, rules);
    expect(op.spec.id).toBe('routine.btc-rules');
    expect(op.spec.kind).toBe('strategy');
    expect(op.spec.version).toBe(`0.1.0+rules.${rules.hash.slice(0, 12)}`);
    expect(op.primer).toContain('1. Return one label: watch, enter or exit.');
    expect(op.primer).not.toContain('{{labels}}');
    expect((op.schema.properties as Record<string, { enum?: string[] }>).label?.enum).toEqual(['watch', 'enter', 'exit']);
    expect(BASE.schema.properties).not.toHaveProperty('label.enum');
    expect(op.spec.output.forbiddenFields).toEqual(expect.arrayContaining(['size', 'amount', 'target', 'side', 'order']));
    // watch keeps what is held, so it may cite the data alone; enter and exit cite a rule too.
    expect(op.holdLabels).toEqual(['watch']);
    expect(op.spec.checks).toEqual(['schema', 'citations', 'cites_data', 'grounded_numbers', 'scope']);
  });

  it('gives each block a heading and numbers the rules as it numbers a briefing', () => {
    const routine = routineIn();
    const rules = readRules(routine);
    if (!rules) throw new Error('no rules');
    const packet = buildPacket({ operation: routineOperation(BASE, routine, rules), question: 'q', blocks: [rulesBlock(rules, READ_AT), ...dataBlocks()] });
    expect(packet.text).toContain("The person's rules, from rules.md (block rules):\n[rules L1] # My rules\n[rules L2] 1. Enter when");
    expect(packet.text).toContain("Bitcoin's price (block price):\n[price L1] Bitcoin's daily price in US dollars, from 2026-08-26 to 2026-09-25, oldest first\n[price L2] 2026-08-26 $100,000.00");
    expect(packet.text).toContain("The routine's position (block position):\n[position L1] flat: no BTC/USD held, all cash, on 2026-09-25");
    expect(packet.text).toContain('Briefing btc.pulse, markdown:');
    expect(packet.text).not.toContain('my own notes');
  });
});

describe('the price table and the position', () => {
  it('lists the closes oldest first, and measures the week, the span and the range in code', () => {
    const lines = priceBlock(CLOSES, READ_AT).lines;
    expect(lines).toHaveLength(1 + 31 + 3);
    expect(lines.at(-3)).toBe('change over 7 days: +5.7%, from $123,000.00 on 2026-09-18');
    expect(lines.at(-2)).toBe('change over 30 days: +30.0%, from $100,000.00 on 2026-08-26');
    expect(lines.at(-1)).toBe('highest: $130,000.00 on 2026-09-25; lowest: $100,000.00 on 2026-08-26');
  });

  it('leaves out the week when the table has no close seven days back', () => {
    const gap = CLOSES.filter((c) => c.date !== '2026-09-18');
    expect(priceBlock(gap, READ_AT).lines.some((l) => l.startsWith('change over 7 days'))).toBe(false);
  });

  it('writes a fall with a minus, and no change as 0.0%', () => {
    // Aug 26 to Sep 2: eight closes, seven days apart end to end.
    const week = (last: number): string | undefined =>
      priceBlock(CLOSES.slice(0, 8).map((c, i) => ({ ...c, price: i === 7 ? last : 100 })), READ_AT).lines.find((l) => l.startsWith('change over 7 days'));
    expect(week(100)).toBe('change over 7 days: 0.0%, from $100.00 on 2026-08-26');
    expect(week(90)).toBe('change over 7 days: -10.0%, from $100.00 on 2026-08-26');
  });

  it('says what is held, since when and the change since entry, and never a size', () => {
    expect(positionBlock({ kind: 'long', since: '2026-09-15', at: 112_000 }, NOW, READ_AT).lines).toEqual([
      'long BTC/USD since 2026-09-15, entered at $112,000.00',
      'held 10 days, to 2026-09-25',
      'change since entry: +16.1%, from $112,000.00 to $130,000.00',
    ]);
  });
});

describe('one run of a routine', () => {
  it('passes an answer that cites the data and the rule, and keeps the rules it read with the run', async () => {
    const routine = routineIn();
    const model = new Scripted([enter()]);
    const journal = new Journal(tempDir());
    const run = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model, journal, record: { tick: '2026-09-25' } });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(run.result.outcome).toBe('passed');
    expect(run.label).toBe('enter');
    expect(model.turns).toBe(1);
    const dir = run.result.journalDir as string;
    expect(dir).toContain(join('routine.btc-rules', run.result.runId));
    const kept = JSON.parse(readFileSync(join(dir, 'routine.json'), 'utf8')) as Record<string, unknown>;
    expect(kept).toMatchObject({ routine: 'btc-rules', rules: { hash: run.rules.hash, lines: 4 }, labels: ['watch', 'enter', 'exit'], tick: '2026-09-25' });
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { operation: { version: string } };
    expect(meta.operation.version).toBe(`0.1.0+rules.${run.rules.hash.slice(0, 12)}`);
    const render = readFileSync(join(dir, 'render.md'), 'utf8');
    expect(render.startsWith('**enter** · Rule 1 gave enter')).toBe(true);
    expect(render).toContain('btc-rules · your rules in rules.md · btc.pulse, the Bitcoin price');
  });

  it('reads a changed rules file on the next run, and records its new version', async () => {
    const routine = routineIn();
    const first = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model: new Scripted([enter()]) });
    writeFileSync(routine.rulesPath, RULES.replace('3. Otherwise watch.', '3. Otherwise watch, and say why.'));
    const second = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model: new Scripted([enter()]) });
    if (first.kind !== 'ran' || second.kind !== 'ran') throw new Error('no run');
    expect(second.operation.spec.version).not.toBe(first.operation.spec.version);
    expect(second.result.packet.text).toContain('[rules L4] 3. Otherwise watch, and say why.');
    expect(second.label).toBe('enter');
  });

  it('refuses a label the routine does not have, and takes a fixed one on the repair turn', async () => {
    const routine = routineIn();
    const model = new Scripted([enter('buy'), enter()]);
    const run = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(model.repairs[1]?.map((f) => f.message).join()).toContain('/label must be equal to one of the allowed values');
    expect(run.result.attempts).toBe(2);
    expect(run.label).toBe('enter');
  });

  it('gives no label when the answer fails twice, so the position holds', async () => {
    const routine = routineIn();
    const run = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model: new Scripted([enter('buy')]) });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(run.result.outcome).toBe('failed');
    expect(run.label).toBeNull();
  });

  it('fails an answer that gives a size, whatever else it says', async () => {
    const routine = routineIn();
    const run = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model: new Scripted([enter('enter', { size: 0.5 })]) });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(run.result.outcome).toBe('failed');
    // The routine's schema holds no size, so the answer fails on its format, and no other
    // check runs on an answer in the wrong shape.
    expect(run.result.reason).toBe('the response holds a field its format does not allow: size');
    expect(run.result.checks.map((c) => c.id)).toEqual(['schema']);
    expect(run.label).toBeNull();
    // Scope refuses the size on its own, for a schema that lets it through.
    expect(scopeCheck.run(run.result.packet, JSON.parse(enter('enter', { size: 0.5 })), run.operation).map((f) => f.message)).toContain('a strategy operation may not return size');
  });

  it('takes out a claim whose quote is not in its line, and the label stands on the rest', async () => {
    const routine = routineIn();
    const bad = JSON.parse(enter()) as { claims: Array<{ text: string; citations: Cite[] }> };
    (bad.claims[0]?.citations[0] as { quote: string }).quote = 'change over 7 days: +9.9%';
    // The rest still cites a line of the data, as a label must.
    bad.claims.push({ text: 'Nothing is held.', citations: [FLAT] });
    const run = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model: new Scripted([JSON.stringify(bad)]) });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(run.result.outcome).toBe('partial');
    expect(run.result.dropped.map((d) => d.claim.text)).toEqual(['Bitcoin rose +5.7% over 7 days.']);
    expect(run.label).toBe('enter');
  });

  it('fails a label left citing only your rules once its claim on the data is taken out', async () => {
    const routine = routineIn();
    const bad = JSON.parse(enter()) as { claims: Array<{ citations: Array<{ quote: string }> }> };
    (bad.claims[0]?.citations[0] as { quote: string }).quote = 'change over 7 days: +9.9%';
    const run = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model: new Scripted([JSON.stringify(bad)]) });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(run.result.dropped.map((d) => d.claim.text)).toEqual(['Bitcoin rose +5.7% over 7 days.']);
    expect(run.result.outcome).toBe('failed');
    expect(run.result.reason).toBe(RULES_ONLY);
    expect(run.label).toBeNull();
  });

  it('holds the reason to the lines the claims cite, as an answer is held', async () => {
    const routine = routineIn();
    const text = enter('enter', { reason: 'Rule 1 gave enter, as the price is up 44% this year.' });
    const run = await runRoutine({ base: BASE, routine, blocks: dataBlocks(), model: new Scripted([text]) });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(run.result.checks.find((c) => c.id === 'grounded_numbers')?.failures.length ?? 0).toBe(0);
    expect(run.result.outcome).toBe('partial');
    expect((run.result.response as unknown as { reason: string }).reason).toBe('Bitcoin rose +5.7% over 7 days. Rule 1 enters when the 7 day change is above +2.0% and nothing is held.');
  });
});

describe('a label and the lines it cites', () => {
  it('fails a label that cites only your rules, after its repair turn, so the position holds', async () => {
    // The personas walk (10-14): a label citing only a line of the rules passed every check.
    const model = new Scripted([labelled('enter', RULE_1)]);
    const run = await runRoutine({ base: BASE, routine: routineIn(), blocks: dataBlocks(), model });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(model.repairs[1]).toEqual([{ check: 'cites_data', message: RULES_ONLY, fix: "Cite the lines of the data the rule was applied to, as well as the rule's line" }]);
    expect(run.result.attempts).toBe(2);
    expect(run.result.outcome).toBe('failed');
    expect(run.result.reason).toBe(RULES_ONLY);
    expect(run.label).toBeNull();
  });

  it('takes the label once the repair turn cites the data its rule was applied to', async () => {
    const model = new Scripted([labelled('enter', RULE_1), labelled('enter', RULE_1, RISE, FLAT)]);
    const run = await runRoutine({ base: BASE, routine: routineIn(), blocks: dataBlocks(), model });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(run.result.attempts).toBe(2);
    expect(run.result.outcome).toBe('passed');
    expect(run.label).toBe('enter');
  });

  it('passes an exit that cites rule 2 and the line of the data it was applied to', async () => {
    const model = new Scripted([labelled('exit', RULE_2, GAIN)]);
    const run = await runRoutine({ base: BASE, routine: routineIn(), blocks: longBlocks(112_000), model });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(model.turns).toBe(1);
    expect(run.result.outcome).toBe('passed');
    expect(run.label).toBe('exit');
  });

  it('fails an exit that cites the data and no rule, as which rule it applies is not shown', async () => {
    const model = new Scripted([labelled('exit', GAIN)]);
    const run = await runRoutine({ base: BASE, routine: routineIn(), blocks: longBlocks(112_000), model });
    if (run.kind !== 'ran') throw new Error(run.kind);
    const said = 'the label "exit" cites no line of your rules, so which rule it applies is not shown';
    expect(model.repairs[1]).toEqual([{ check: 'cites_data', message: said, fix: 'Cite the line in block rules that gives exit' }]);
    expect(run.result.outcome).toBe('failed');
    expect(run.result.reason).toBe(said);
    expect(run.label).toBeNull();
  });

  it('passes a watch that cites the data alone, since no rule may have given it', async () => {
    // Long since Sep 15 at $129,000: up 0.8%, short of rule 2, and rule 1 needs nothing held.
    const model = new Scripted([labelled('watch', { block: 'position', line: 3, quote: 'change since entry: +0.8%' }, RISE)]);
    const run = await runRoutine({ base: BASE, routine: routineIn(), blocks: longBlocks(129_000), model });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(model.turns).toBe(1);
    expect(run.result.outcome).toBe('passed');
    expect(run.label).toBe('watch');
  });

  it('fails a watch that cites only your rules, as any label must cite the data', async () => {
    const model = new Scripted([labelled('watch', { block: 'rules', line: 4, quote: 'Otherwise watch' })]);
    const run = await runRoutine({ base: BASE, routine: routineIn(), blocks: longBlocks(129_000), model });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(run.result.reason).toBe(RULES_ONLY);
    expect(run.label).toBeNull();
  });

  it('leaves an answer that cites no line in the packet to the citations check', async () => {
    const model = new Scripted([labelled('exit', { block: 'rules', line: 40, quote: 'Exit when' })]);
    const run = await runRoutine({ base: BASE, routine: routineIn(), blocks: dataBlocks(), model });
    if (run.kind !== 'ran') throw new Error(run.kind);
    expect(run.result.checks.find((c) => c.id === 'cites_data')?.failures).toEqual([]);
    expect(run.result.reason).toBe('no claim passed its checks');
  });
});

// A source that serves the pulse fixture for any briefing and the closes above, and
// counts what it is asked for.
class Source implements RoutineSource {
  briefings = 0;
  prices: Array<[string, string]> = [];
  async briefing(): Promise<{ raw: string }> {
    this.briefings++;
    return { raw: PULSE_MD };
  }
  async closes(from: string, to: string): Promise<Close[]> {
    this.prices.push([from, to]);
    return [...CLOSES, { date: '2026-09-26', price: 1 }];
  }
}

describe('frozen data', () => {
  it('reads a day once, keeps it as served, and reads it from the folder ever after', async () => {
    const routine = routineIn();
    const source = new Source();
    const first = await readFixture(routine, '2026-09-25', 'markdown', source);
    expect(source.briefings).toBe(1);
    expect(source.prices).toEqual([['2026-08-26', '2026-09-25']]);
    expect(first.frozen.map((f) => f.slice(routine.dir.length + 1).replace(/\\/g, '/'))).toEqual(['fixtures/2026-09-25/btc.pulse.md', 'fixtures/2026-09-25/price-30d.json']);
    expect(first.closes.at(-1)).toEqual(NOW);
    const stamp = statSync(first.frozen[0] as string).mtimeMs;
    const again = await readFixture(routine, '2026-09-25', 'markdown', null);
    expect(again.frozen).toEqual([]);
    expect(again.briefings[0]?.lines).toEqual(first.briefings[0]?.lines);
    expect(again.closes).toEqual(first.closes);
    expect(statSync(first.frozen[0] as string).mtimeMs).toBe(stamp);
  });

  it('says a day is not frozen when nothing can read it', async () => {
    await expect(readFixture(routineIn(), '2026-09-25', 'markdown', null)).rejects.toThrow(/not frozen yet, and PreReason is not connected/);
  });
});

const TESTS = `runs: 3
tests:
  - on: 2026-09-25
    holding: flat
    expect: enter
    cites: [price, rules L2]
  - on: 2026-09-25
    holding: long
    since: 2026-09-15
    expect: [watch, exit]
`;

describe('logic tests', () => {
  it('reads tests.yaml, with the entry price left to the table', () => {
    const routine = routineIn({ 'tests.yaml': TESTS });
    expect(loadRoutineTests(routine)).toEqual({
      runs: 3,
      tests: [
        { on: '2026-09-25', holding: { kind: 'flat' }, expect: ['enter'], cites: [{ block: 'price', line: null }, { block: 'rules', line: 2 }] },
        { on: '2026-09-25', holding: { kind: 'long', since: '2026-09-15', at: null }, expect: ['watch', 'exit'], cites: [] },
      ],
    });
  });

  it('names every problem in tests.yaml at once', () => {
    const routine = routineIn();
    const raw = {
      runs: 50,
      tests: [
        { on: 'Sep 25', expect: 'buy' },
        { on: '2026-09-25', holding: 'long', expect: 'enter' },
        { on: '2026-09-25', holding: 'flat', since: '2026-09-01', expect: 'enter', cites: ['btc.full'] },
        'enter',
      ],
    };
    let problems: string[] = [];
    try {
      parseRoutineTests(raw, routine);
    } catch (e) {
      problems = (e as RoutineError).problems;
    }
    expect(problems).toEqual([
      'runs is how many times each test runs, from 1 to 20, not 50',
      'test 1: on is the day the data stood, such as 2026-09-20',
      `test 1: "buy" is not one of the routine's labels, watch, enter or exit`,
      'test 2: holding long needs since, the day it was entered, such as 2026-09-10',
      'test 3: since and at go with holding: long',
      'test 3: btc.full is not a block this routine reads; they are rules, btc.pulse, price, position',
      'test 4 is not a test: a test has on and expect at least',
    ]);
  });

  it('passes a run only on an expected label that cites what the test names', () => {
    const test = { on: '2026-09-25', holding: { kind: 'flat' as const }, expect: ['enter'], cites: [{ block: 'rules', line: 2 }] };
    const response = JSON.parse(enter());
    expect(judgeTestRun(test, 'enter', response, 'passed')).toEqual({ passed: true, why: null });
    expect(judgeTestRun(test, 'watch', response, 'passed')).toEqual({ passed: false, why: 'gave watch, not enter' });
    expect(judgeTestRun({ ...test, cites: [{ block: 'rules', line: 3 }] }, 'enter', response, 'passed')).toEqual({ passed: false, why: 'gave enter without citing rules L3' });
    expect(judgeTestRun(test, null, null, 'failed', 'no claim passed its checks')).toEqual({ passed: false, why: 'failed its checks: no claim passed its checks' });
  });

  it('runs each test its number of times on the frozen day, and keeps the count', async () => {
    const routine = routineIn({ 'tests.yaml': TESTS });
    const source = new Source();
    const journal = new Journal(tempDir());
    // Enter when flat and exit when long, but one watch, which the second test also takes.
    const model = new Scripted((turn, packet) => {
      const long = packet.text.includes('[position L1] long');
      if (turn === 4) return enter('watch');
      return long ? enter('exit') : enter();
    });
    const steps: string[] = [];
    const outcome = await testRoutine({ base: BASE, routine, tests: loadRoutineTests(routine), model, source, format: 'markdown', journal, onRun: (s) => s.done && steps.push(`${s.test}.${s.run}`) });
    if (outcome.kind !== 'tested') throw new Error(outcome.kind);
    const { report } = outcome;
    expect(steps).toEqual(['0.1', '0.2', '0.3', '1.1', '1.2', '1.3']);
    expect(source.briefings).toBe(1);
    expect(report.tests.map((t) => [t.holding, t.passed, t.runs.length])).toEqual([
      ['flat', 3, 3],
      ['long since 2026-09-15', 3, 3],
    ]);
    expect(report.passed).toBe(6);
    expect(model.packets[3]?.text).toContain('[position L1] long BTC/USD since 2026-09-15, entered at $120,000.00');
    expect(testSummary(report)).toBe('2 rule tests on frozen data, 3 runs each: 6 of 6 passed');
    expect(latestTestReport(routine)).toEqual(report);
    expect(existsSync(outcome.path)).toBe(true);
    expect(readdirSync(join(journal.root, readdirSync(journal.root)[0] as string, 'routine.btc-rules'))).toHaveLength(6);
  });

  it('counts a run that gave another label as a miss, and says why', async () => {
    const routine = routineIn({ 'tests.yaml': TESTS.replace('runs: 3', 'runs: 2') });
    const model = new Scripted((turn) => (turn === 1 ? enter('watch') : enter()));
    const outcome = await testRoutine({ base: BASE, routine, tests: loadRoutineTests(routine), model, source: new Source(), format: 'markdown' });
    if (outcome.kind !== 'tested') throw new Error(outcome.kind);
    expect(outcome.report.tests[0]?.passed).toBe(1);
    expect(testLines(outcome.report)[0]).toBe('2026-09-25  flat, expects enter: 1 of 2 (run 2 gave watch, not enter)');
    expect(testLines(outcome.report)[1]).toBe('2026-09-25  long since 2026-09-15, expects watch or exit: 0 of 2 (run 1 gave enter, not watch or exit)');
  });

  it('counts the label a test expects as a miss when it cites only your rules, and says why', async () => {
    const routine = routineIn({ 'tests.yaml': TESTS.replace('runs: 3', 'runs: 1') });
    const model = new Scripted(() => labelled('enter', RULE_1));
    const outcome = await testRoutine({ base: BASE, routine, tests: loadRoutineTests(routine), model, source: new Source(), format: 'markdown' });
    if (outcome.kind !== 'tested') throw new Error(outcome.kind);
    expect(outcome.report.tests[0]?.runs[0]).toMatchObject({ label: null, outcome: 'failed', passed: false });
    expect(testLines(outcome.report)[0]).toBe(`2026-09-25  flat, expects enter: 0 of 1 (run 1 failed its checks: ${RULES_ONLY})`);
  });

  it('runs nothing while the rules file holds no rules', async () => {
    const routine = routineIn({ 'rules.md': '<!-- later -->\n', 'tests.yaml': TESTS });
    const model = new Scripted([enter()]);
    const source = new Source();
    const outcome = await testRoutine({ base: BASE, routine, tests: loadRoutineTests(routine), model, source, format: 'markdown' });
    expect(outcome).toEqual({ kind: NO_RULES, rulesPath: routine.rulesPath });
    expect(model.turns).toBe(0);
    expect(source.briefings).toBe(0);
  });

  it('keeps what ran when it is stopped by hand', async () => {
    const routine = routineIn({ 'tests.yaml': TESTS });
    const stop = new AbortController();
    const model = new Scripted((turn) => {
      if (turn === 1) stop.abort();
      return enter();
    });
    const outcome = await testRoutine({ base: BASE, routine, tests: loadRoutineTests(routine), model, source: new Source(), format: 'markdown', signal: stop.signal });
    if (outcome.kind !== 'tested') throw new Error(outcome.kind);
    expect(outcome.report.total).toBe(1);
    expect(outcome.report.stopped).toBe('stopped by hand');
    expect(testSummary(outcome.report)).toBe('2 rule tests on frozen data, 3 runs each: 1 of 1 passed, then stopped by hand with 5 runs to go');
  });
});
