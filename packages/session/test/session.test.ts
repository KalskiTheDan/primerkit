import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Journal, Snapshots, blockFromJson, loadOperation, loadRoutine, planBacktest, readConfig, runBacktest, writeConfig, type BenchFile, type DataBlock, type ModelAdapter, type Packet } from '@primerkit/core';
import { FixtureConnector, PreReasonClient, PreReasonError, parseCatalog, type ClaimEvent } from '@primerkit/connector-prereason';
import { ExtractiveModel, ScriptedModel, type FitnessResult, type MachineCheck } from '@primerkit/models';
import { HEIGHT, TAGLINE, WIDTH, maker, widthOf, type Line } from '@primerkit/ui';
import {
  ASK_DIR,
  COMMANDS,
  BENCH_BRIEFINGS,
  DEMO_BRIEFINGS,
  DEMO_CATALOG,
  DEMO_DATE,
  DIGEST_DIR,
  DISCLAIMER_POINTS,
  DemoStandIn,
  FIRST_QUESTIONS,
  FIRST_RUN_WALK,
  GRID,
  LATER_COMMANDS,
  RESEARCH_CLOSING,
  ROOT,
  ROUTINE_DIR,
  Session,
  chartDraws,
  collectDigest,
  demoDeps,
  digestEntry,
  entryLines,
  fitnessInputs,
  initialState,
  journalOpen,
  journalRows,
  menuRows,
  onceEach,
  readLatestDigest,
  routineSource,
  writeLatestDigest,
  runInTerminal,
  tooSmall,
  screen,
  systemScheduler,
  toKey,
  walk,
  type Briefings,
  type Entry,
  type Key,
  type ModelChoice,
  type ScheduleEntry,
  type SessionDeps,
} from '../src/index';
import { READ_AT, marketConnection, marketFetch } from './market-fixture';
import { sampleJournal } from '../../core/test/sample-journal';
import { recordLiveIntent } from '@primerkit/core';

const MACHINE: MachineCheck = {
  apps: ['Claude Code'],
  keys: [],
  local: [
    { runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' },
    { runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', name: 'llama3.1:8b' },
  ],
  ollama: 'running',
};
const fakeKey = `pr_test_${'k'.repeat(20)}`;
const ASK = loadOperation(ASK_DIR);
const DIGEST = loadOperation(DIGEST_DIR);

const text = (lines: Line[]): string => lines.map((l) => l.map(([, s]) => s).join('')).join('\n');
const shown = (s: Session, ascii = true): string => text(screen(s.state, ascii));
const press = (s: Session, ...keys: Key[]): void => keys.forEach((k) => s.key(k));
const enter: Key = { name: 'enter' };
const down: Key = { name: 'down' };
const typed = (words: string): Key[] => Array.from(words, (char): Key => ({ name: 'char', char }));

// The demo stand in under the label of the model a person chose, so tests read the
// screens a real model would give without running one.
class Labelled extends ExtractiveModel {
  override readonly label: string;
  private readonly hosted: boolean;
  constructor(choice: ModelChoice) {
    super('markdown');
    this.hosted = choice.kind === 'model' && choice.spec.kind === 'hosted';
    this.label = choice.kind === 'model' ? `${choice.spec.name}, ${this.hosted ? 'hosted' : 'local, 8k'}` : 'demo, no model';
  }
  override async capabilities() {
    return { ...(await super.capabilities()), local: !this.hosted };
  }
}

// Saved briefings that report the limits PreReason sends with every data response.
class Budgeted extends FixtureConnector {
  budget: { limit: number; remaining: number } | null = null;
  tier: 'free' | null = null;
  calls = 0;
  override async fetch(req: { briefing: string; format: 'json' | 'markdown'; date?: string }) {
    const block = await super.fetch(req);
    this.calls += 1;
    this.budget = { limit: 500, remaining: 500 - this.calls };
    this.tier = 'free';
    return block;
  }
}

// Saved briefings for a key PreReason no longer accepts (revoked in its settings): every read
// is answered 401, as the client says it.
class Revoked extends Budgeted {
  keyAccepted: boolean | null = null;
  override async fetch(): Promise<never> {
    this.calls += 1;
    this.keyAccepted = false;
    throw new PreReasonError('PreReason did not accept the key', 401, null);
  }
}

const fitResult = (model: string, verdict: FitnessResult['verdict'] = 'fit for everything'): FitnessResult => ({
  verdict,
  reason: verdict === 'not fit' ? 'its answer to one question did not pass its checks after the repair turn' : 'it answered with checked citations and read 100% of the reading test right',
  model,
  shape: { valid: 5, total: 5 },
  citations: { matched: 2, total: 2 },
  reading: { markdown: { right: 13, total: 14 }, json: { right: 14, total: 14 } },
  format: 'json',
  context: { limit: 8192, largest: 6100 },
  speed: { tokensPerSecond: 38, secondsPerCall: 9 },
  calls: 5,
  checkedAt: '2026-09-26T10:00:00.000Z',
});

function fakeScheduler() {
  const added: ScheduleEntry[] = [];
  return {
    added,
    add: async (e: ScheduleEntry) => void added.push(e),
    remove: async () => added.splice(0).length > 0,
    exists: async () => added.length > 0,
  };
}

// A session as a person would have it: a home folder, a key, and saved briefings.
function real(over: Partial<SessionDeps> = {}): SessionDeps & { home: string } {
  const home = mkdtempSync(join(tmpdir(), 'primerkit-session-'));
  const journal = new Journal(join(home, 'journal'));
  return {
    demo: null,
    env: {},
    platform: 'win32',
    config: { read: () => readConfig(home), write: (c) => writeConfig(home, c) },
    checkMachine: async () => MACHINE,
    catalog: async () => parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8'))),
    resolveKey: () => ({ key: fakeKey, source: 'env' }),
    connect: () => ({ cancel: () => {} }),
    briefings: () => new Budgeted(BENCH_BRIEFINGS),
    model: (choice) => new Labelled(choice),
    listModels: async () => ['claude-test-2', 'claude-test-1'],
    pull: async (_name, onProgress) => onProgress({ status: 'success' }),
    fitness: async (model) => fitResult(model.label),
    fitnessPlan: () => ({ calls: 5, tokens: 12_345 }),
    operation: ASK,
    digestOperation: DIGEST,
    journal,
    snapshots: new Snapshots(join(home, 'snapshots')),
    latestDigest: () => readLatestDigest(home),
    scheduler: fakeScheduler(),
    scheduleEntry: (time) => digestEntry({ time, platform: 'win32', node: 'C:\\node\\node.exe', script: 'C:\\pk\\bin\\primerkit.js', cwd: 'C:\\pk', now: new Date('2026-09-26T10:00:00') }),
    journalRows: () => journalRows(journal.root),
    journalOpen,
    openLink: () => true,
    copy: () => true,
    ...over,
    home,
  };
}

// The demo, on a machine with Claude Code and Ollama's two models.
const demo = (over: Partial<SessionDeps> = {}): SessionDeps => ({ ...demoDeps({ version: '0.1.0' }), checkMachine: async () => MACHINE, ...over });

// A started session at home, as a later start opens it.
function atHome(over: Partial<SessionDeps> = {}) {
  const deps = real(over);
  writeConfig(deps.home, { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model: { kind: 'ollama', base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' }, prereason: { tier: 'free' } });
  const s = new Session(deps);
  s.start();
  return { s, deps };
}

describe('the opening of a later start', () => {
  const at = (hour: number) => () => new Date(2026, 9, 13, hour, 5);

  it('greets by the hour, says how the model and PreReason stand, and gives three next steps', () => {
    const { s } = atHome({ now: at(8) });
    const out = shown(s);
    expect(out).toContain(' Good morning.');
    // The model and PreReason stand in the status strip, on every screen, and no longer in the opening.
    expect(out).toContain('\n model qwen2.5:7b | PreReason free | runs today 0');
    expect(out).not.toMatch(/\n {3}model {7}/);
    expect(out).toMatch(/\n {3}1 {2}ask +such as "[^"]+\?"/);
    expect(out).toMatch(/\n {3}2 {2}\/digest +what changed since the last digest/);
    // No run kept and no digest scheduled: the third step is the schedule.
    expect(out).toMatch(/\n {3}3 {2}\/schedule +a digest each morning, at a time you set/);
    // No digest today and no run kept: nothing to say since last time.
    expect(out).not.toContain('   since');
    for (const [hour, words] of [[14, 'Good afternoon.'], [19, 'Good evening.'], [3, 'Good evening.'], [5, 'Good morning.']] as const) {
      expect(shown(atHome({ now: at(hour) }).s), `${hour}:05`).toContain(` ${words}`);
    }
    // The example question changes by the day and is never about Bitcoin, which is not the
    // focus; a storyboard run once drew "Where does Bitcoin stand?".
    const examples = new Set<string>();
    for (let day = 8; day <= 14; day++) {
      const example = /such as "([^"]+)"/.exec(shown(atHome({ now: () => new Date(2026, 9, day, 8, 5) }).s))?.[1] ?? '';
      expect(example, `Oct ${day}`).not.toMatch(/bitcoin/i);
      examples.add(example);
    }
    expect(examples.size).toBeGreaterThan(1);
  });

  it("says what today's digest changed, and names the last run the journal holds", () => {
    const row = { day: '12 Oct', time: '21:40', operation: 'ask', title: 'Where does Bitcoin stand?', outcome: '', dir: 'x' };
    const digest = { ranAt: new Date(2026, 9, 13, 8, 0).toISOString(), since: 'your last digest, Mon 12 Oct 08:00 UTC', briefings: ['macro.snapshot'], changes: [], same: [], notes: [], sources: [], checks: null, computed: 0, generated: null, model: null };
    const out = shown(atHome({ now: at(9), journalRows: () => [row], latestDigest: () => digest }).s);
    expect(out).toMatch(/\n {3}since {7}today's digest has no changes since your last digest/);
    expect(out).toMatch(/\n {3}2 {2}\/digest +today's digest in full/);
    expect(out).toMatch(/\n {3}3 {2}\/journal +your last run, ask: Where does Bitcoin stand\?/);
    // With no digest today, the line says when the last run was made.
    expect(shown(atHome({ now: at(9), journalRows: () => [row] }).s)).toMatch(/\n {3}since {7}your last run was 12 Oct at 21:40; no digest has run today/);
  });

  it('gives way to the answers, and /clear clears it', async () => {
    const { s } = atHome({ now: at(8) });
    press(s, ...typed('Where does Bitcoin stand?'), enter);
    await s.idle();
    expect(shown(s)).toContain('5 of 5 checks:');
    expect(shown(s)).not.toContain('Good morning.');
    press(s, ...typed('/clear'), enter);
    expect(s.state.opening).toBeNull();
  });

  it('draws within every window, in colour and ASCII; the first run has none', async () => {
    const { s } = atHome({ now: at(8) });
    for (const [columns, rows] of [[49, 16], [60, 20], [77, 22], [120, 40]] as const) {
      s.resize(columns, rows);
      for (const ascii of [true, false]) {
        const lines = screen(s.state, ascii);
        expect(text(lines), `${columns}x${rows}`).toContain('Good morning.');
        for (const line of lines) expect(widthOf(line), `${columns}x${rows}: ${text([line])}`).toBeLessThanOrEqual(columns - 1);
        if (ascii) expect(/^[\x00-\x7f]*$/.test(text(lines)), `${columns}x${rows}`).toBe(true);
      }
    }
    for (const shot of await walk(demo(), FIRST_RUN_WALK, true)) expect(text(shot.lines), shot.title).not.toMatch(/Good (morning|afternoon|evening)\./);
  });
});

describe('the PreReason tile', () => {
  it('stands beside the connect headline, amber on charcoal, and is the mark on every credit line', async () => {
    const colour = await walk(demo(), FIRST_RUN_WALK, false);
    const plain = await walk(demo(), FIRST_RUN_WALK, true);
    const connect = (shots: typeof colour) => shots.find((x) => x.title.includes('connect PreReason'))!;
    expect(connect(colour).lines.flat()).toContainEqual(['pr/prTile', ' PR ']);
    expect(text(connect(plain).lines)).toContain('\n [PR]   Connect PreReason\n');
    // The old mark, PR in amber alone, is drawn nowhere in the first run.
    const segments = colour.flatMap((x) => x.lines.flat());
    expect(segments.some(([role]) => role === 'pr')).toBe(false);
    expect(segments.filter(([role]) => role === 'pr/prTile').length).toBeGreaterThan(3);
  });
});

describe("primerkit's logo", () => {
  const at = (hour: number) => () => new Date(2026, 9, 13, hour, 5);
  // The rows that draw the PK, and whether any does.
  const markRows = (lines: Line[]) => lines.filter((l) => l.some(([role]) => role.startsWith('pk'))).length;

  it('opens the first run: the large PK beside the name in a tall window, the small one on the grid, and the name alone where neither fits or in plain text', async () => {
    const welcome = async (plain: boolean, window?: { columns: number; rows: number }) => (await walk(demo(), FIRST_RUN_WALK.slice(0, 1), plain, window))[0]!.lines;
    const tall = await welcome(false, { columns: 100, rows: 30 });
    expect(markRows(tall)).toBe(10);
    expect(text(tall)).toContain('   primerkit\n');
    expect(text(tall)).toContain(`   ${TAGLINE}\n`);
    // On the grid the small PK leaves room for every point agreed to.
    const grid = await welcome(false);
    expect(markRows(grid)).toBe(8);
    for (const point of DISCLAIMER_POINTS) expect(text(grid).replace(/\s+/g, ' ')).toContain(point.join(' '));
    // Narrower than the small lockup, the name stands alone; plain text has no mark.
    const narrow = await welcome(false, { columns: 57, rows: 22 });
    expect(markRows(narrow)).toBe(0);
    expect(text(narrow)).toContain('\n primerkit\n');
    expect(markRows(await welcome(true))).toBe(0);
  });

  it('heads home with the small PK while the feed leaves it the room, and gives the rows back when the feed needs them', () => {
    const { s } = atHome({ now: at(8) });
    s.resize(100, 40);
    const roomy = screen(s.state, false);
    // The launchpad's mini PK, beside the connections.
    expect(markRows(roomy)).toBe(6);
    // Under the title bar and a blank row, and before the opening.
    expect(roomy.slice(2, 8).every((l) => l.some(([role]) => role.startsWith('pk')))).toBe(true);
    expect(text(roomy.slice(2, 8))).toContain('CONNECTIONS');
    expect(text(roomy.slice(10))).toContain('Good morning.');
    expect(markRows(screen(s.state, true))).toBe(0);
    // A window too short for both keeps the opening and leaves the logo out.
    s.resize(100, 18);
    const short = screen(s.state, false);
    expect(markRows(short)).toBe(0);
    expect(text(short)).toContain('Good morning.');
  });
});

describe('the first run, walked on saved briefings', () => {
  it('draws every screen within 76 by 22, in colour and ASCII, and ASCII is ASCII only', async () => {
    for (const ascii of [false, true]) {
      for (const shot of await walk(demo(), FIRST_RUN_WALK, ascii)) {
        expect(shot.lines.length, shot.title).toBe(HEIGHT);
        for (const line of shot.lines) expect(widthOf(line), `${shot.title}: ${text([line])}`).toBeLessThanOrEqual(WIDTH);
        if (ascii) expect(/^[\x00-\x7f]*$/.test(text(shot.lines)), shot.title).toBe(true);
      }
    }
  }, 60_000);

  it('shows each screen of the first run as it was designed', async () => {
    const shots = await walk(demo(), FIRST_RUN_WALK, true);
    const at = (title: string) => text(shots.find((s) => s.title.startsWith(title))?.lines ?? []);
    for (const [first] of DISCLAIMER_POINTS) expect(at('1.')).toContain(first);
    expect(at('2.')).toContain('Found on this machine: Claude Code, and Ollama with 2 models.');
    expect(at('2.')).toContain('> The demo stand in: no model, saved briefings');
    expect(at('2.')).toMatch(/lifts sentences from briefings saved on\s+\|\s+Oct 16, 2026, to show the flow/);
    expect(at('2.')).toContain('   Here, with qwen2.5:7b on Ollama');
    expect(at('2.')).toContain('   Another model: type its name');
    expect(at('2.')).toContain('   Inside Claude Code, on your subscription');
    // General markets first, Bitcoin last.
    expect(at('4.')).toContain('Free briefings today: macro, correlations and Bitcoin.');
    for (const q of FIRST_QUESTIONS) expect(at('5.')).toContain(q.briefings.join(', '));
    expect(at('Step 3 while')).toContain('| / reading macro.snapshot, saved on Oct 16, 2026');
    // The demo connects nothing and its stand in takes no time: it says neither.
    expect(at('5.')).toContain('In the demo, as if you approved. Pick one, or type your own.');
    expect(at('6.')).toMatch(/ok 5 of 5 checks: answer format \| claims cite their lines/);
    expect(at('6.')).toContain('+ PR  macro.snapshot | generated 09:28 UTC');
    // Under the answer, what can be done next, by the functions' codes.
    expect(at('6.')).toContain('> next: BR /brief macro.snapshot | CP /compare\n');
    expect(at('7.')).toContain('> Yes, at 08:00');
    expect(at('7.')).toContain('Reads macro.snapshot, cross.correlations and btc.context.');
    expect(at('8.')).toContain('The entry primerkit adds to');
    expect(at('8.')).toContain('| runs   primerkit run digest');
    expect(at('8.')).toContain('In the demo nothing is added.');
    // The panel: the title bar names the function and its subject, the status strip the model and PreReason.
    expect(at('9.')).toMatch(new RegExp(`^\\[ASK\\] ${FIRST_QUESTIONS[0]!.question.replace(/[?.]/g, '\\$&')} +demo \\| saved ${DEMO_DATE} $`, 'm'));
    expect(at('9.')).toContain(` model demo | PreReason saved briefings | data ${DEMO_DATE}`);
    expect(at('9.')).toContain('Tab switches the model | a code and Enter runs it | / lists every command');
    // The question typed at home: net liquidity's own line first, and a sample, never checked.
    expect(at('11.')).toContain('[1] macro.snapshot L12');
    expect(at('11.')).toContain(". Sample answer: the demo's stand in does not read your question.");
    expect(at('11.')).not.toMatch(/of \d+ checks/);
  }, 60_000);
});

describe('the demo stand in, which does not read the question', () => {
  // The demo walked to home, as the first run leaves it.
  async function demoAtHome(): Promise<Session> {
    const s = new Session(demo());
    s.start();
    for (const step of FIRST_RUN_WALK.slice(0, 9)) {
      press(s, ...step.keys);
      await s.idle();
    }
    return s;
  }
  const asked = async (s: Session, question: string): Promise<Entry> => {
    press(s, ...typed(question), enter);
    await s.idle();
    return s.state.feed.at(-1)!;
  };
  // An entry's words as one line: its rail and its wrapping taken out.
  const words = (s: Session, entry: Entry, ascii: boolean): string => text(entryLines(s.state, maker(ascii), entry)).replace(/\n [│|└+] */g, ' ').replace(/\s+/g, ' ');
  // Every call out refused and counted while the demo runs.
  async function sendsNothing<T>(run: () => Promise<T>): Promise<{ out: T; calls: string[] }> {
    const real = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      throw new Error('the demo sends nothing');
    }) as typeof fetch;
    try {
      return { out: await run(), calls };
    } finally {
      globalThis.fetch = real;
    }
  }

  it("lifts macro.snapshot's yield lines for a yield curve question, as a sample with no checks line, and sends nothing", async () => {
    const { out: [s, entry], calls } = await sendsNothing(async () => {
      const s = await demoAtHome();
      return [s, await asked(s, 'Is the yield curve steepening?')] as const;
    });
    expect(calls).toEqual([]);
    if (entry.kind !== 'answer') throw new Error(`no answer: ${entry.kind}`);
    // The word match picks macro.snapshot, and the stand in lifts the sentences that hold the
    // question's words, the curve's own line first.
    expect(entry.view.briefings).toEqual(['macro.snapshot']);
    expect(entry.view.headline).toBe("Yield curve spread (10Y-2Y) at 0.33% (PreReason's calculation: Treasury's 10 year par yield less its 2 year par yield); 7d -0.14 pp (falling), 30d 0.00 pp, 90d -0.04 pp.");
    expect(entry.view.sources.map((x) => `${x.block} L${x.line}`)).toEqual(['macro.snapshot L21', 'macro.snapshot L18', 'macro.snapshot L28']);
    // Not the first three sentences of the briefing, which it once lifted whatever was asked.
    expect(entry.view.sentences.map((x) => x.text).join(' ')).not.toMatch(/Fed balance sheet|Treasury General Account|Net liquidity/);
    expect(entry.sample).toBe(true);
    for (const ascii of [false, true]) {
      const out = words(s, entry, ascii);
      expect(out).toContain("Sample answer: the demo's stand in does not read your question. It lifts the sentences that hold its words.");
      expect(out).not.toContain('✓');
      expect(out).not.toMatch(/of \d+ checks/);
    }
    // The panel still says what the demo is: in the title bar, and in the status strip.
    expect(shown(s)).toContain(`demo | saved ${DEMO_DATE}`);
    expect(shown(s)).toContain(' model demo | PreReason saved briefings');
  });

  it('tells a company question what a key would read, and gives no answer', async () => {
    const { out: [s, entry], calls } = await sendsNothing(async () => {
      const s = await demoAtHome();
      return [s, await asked(s, "What is Apple's revenue trend?")] as const;
    });
    expect(calls).toEqual([]);
    expect(entry.kind).toBe('note');
    const out = words(s, entry, true);
    // The demo does not know the company's market, so it names both tiers: a USA company's
    // briefing on Basic and above, a Japanese, Korean or Indian company's on Pro and above. A
    // company answers only where PreReason covers it, so no answer is promised for any.
    expect(out).toContain("The demo's saved briefings hold no company data, so the demo's stand in gives no answer. With a key, a covered company's briefing answers this: a USA company on Basic and above; a Japanese, Korean or Indian company on Pro and above. Name the company by its code, such as equities.company/nvda.");
    expect(out).not.toContain('(Basic key or above)');
    expect(out).toContain('The demo holds 3 saved briefings: macro.snapshot, cross.correlations and btc.context.');
    // No stand in answer: not the Bitcoin lines "trend" once read from btc.context.
    expect(out).not.toMatch(/BTC at|Hash rate|checks/);
  });

  it('gives no answer where no sentence holds the words of the question, and says what a key would read', async () => {
    const s = await demoAtHome();
    // "trend" picks btc.context by its description, and none of its sentences holds the word.
    const trend = await asked(s, 'What is the trend?');
    expect(trend.kind).toBe('note');
    expect(words(s, trend, true)).toContain("No sentence in the demo's saved briefings holds the words of this question, so the demo's stand in gives no answer. With a key, primerkit chooses from every briefing and metric your key reads. The demo holds 3 saved briefings:");
    // No briefing matched at all: the note says so, and what a key would read.
    const gold = await asked(s, 'Where is gold heading?');
    expect(gold.kind).toBe('note');
    expect(words(s, gold, true)).toContain('lists the 3 saved briefings. With a key, primerkit chooses from every briefing and metric your key reads.');
  });

  it("keeps the checks line on the first run's scripted question, and shows a question typed there as a sample", async () => {
    const firstStep = async (): Promise<Session> => {
      const s = new Session(demo());
      s.start();
      for (const step of FIRST_RUN_WALK.slice(0, 4)) {
        press(s, ...step.keys);
        await s.idle();
      }
      expect(s.state.step.name).toBe('first-question');
      return s;
    };
    const entryOf = (s: Session) => (s.state.step.name === 'first-question' ? s.state.step.entry : null);
    // Picked from the list: written with the briefings that answer it, so its answer is the
    // one it always was, under its checks.
    const scripted = await firstStep();
    press(scripted, enter);
    await scripted.idle();
    expect(entryOf(scripted)).toMatchObject({ kind: 'answer', question: 'What is the Treasury yield curve doing?' });
    expect(entryOf(scripted)).not.toHaveProperty('sample');
    expect(shown(scripted)).toMatch(/ok 5 of 5 checks: answer format/);
    expect(shown(scripted)).toContain('[1] macro.snapshot L21');
    // Typed in its place: a sample.
    const own = await firstStep();
    press(own, ...FIRST_QUESTIONS.map(() => down), enter, ...typed('Is the yield curve steepening?'), enter);
    await own.idle();
    expect(entryOf(own)).toMatchObject({ kind: 'answer', sample: true });
    expect(shown(own)).toContain("Sample answer: the demo's stand in does not read your question.");
    expect(shown(own)).not.toMatch(/of \d+ checks/);
  });

  it('lifts sentences that hold the words of each first question the first run offers, and the first answer as it was', async () => {
    const saved = new FixtureConnector(DEMO_BRIEFINGS);
    for (const q of FIRST_QUESTIONS) {
      const blocks = await Promise.all(q.briefings.map((briefing) => saved.fetch({ briefing, format: 'markdown' })));
      expect(new DemoStandIn().lines(q.question, blocks).length, q.question).toBeGreaterThan(0);
    }
    const macro = [await saved.fetch({ briefing: 'macro.snapshot', format: 'markdown' })];
    expect(new DemoStandIn().lines('What is the Treasury yield curve doing?', macro).map((l) => `${l.block} L${l.line}`)).toEqual(['macro.snapshot L21', 'macro.snapshot L18', 'macro.snapshot L28']);
  });
});

describe('choosing a model', () => {
  it('offers a hosted provider whose key is set, lists its models, and asks before a check that costs', async () => {
    const deps = real({ env: { ANTHROPIC_API_KEY: 'set' }, checkMachine: async () => ({ ...MACHINE, keys: ['ANTHROPIC_API_KEY'] }) });
    const s = new Session(deps);
    s.start();
    press(s, enter);
    await s.idle();
    expect(shown(s)).toContain('   Claude, through your ANTHROPIC_API_KEY');
    press(s, down, down);
    expect(shown(s)).toContain('Runs at Anthropic on your key.');
    press(s, enter);
    await s.idle();
    expect(shown(s)).toContain('Anthropic lists 2 models for your key.');
    press(s, enter);
    await s.idle();
    expect(shown(s)).toContain('It sends 5 packets to the model on your key, about 12,345 tokens.');
    press(s, enter);
    // While it runs, the check says the question it asks.
    expect(shown(s)).toContain('asking "Where does Bitcoin stand?" of a saved briefing');
    await s.idle();
    expect(shown(s)).toContain('Fit for everything: it answered with checked citations');
    press(s, enter);
    await s.idle();
    expect(s.state.step.name).toBe('first-question');
    expect(readConfig(deps.home).model).toMatchObject({ kind: 'hosted', provider: 'anthropic', name: 'claude-test-2', format: 'json', fitness: { verdict: 'fit for everything' } });
    expect(JSON.stringify(readConfig(deps.home))).not.toContain('set');
  });

  it('takes any model name, pulls it with Ollama when it is not there, then checks it', async () => {
    const pulled: string[] = [];
    const deps = real({ pull: async (name, onProgress) => void (pulled.push(name), onProgress({ status: 'success' })) });
    const s = new Session(deps);
    s.start();
    press(s, enter);
    await s.idle();
    press(s, down, down, enter, ...typed('qwen3:8b'), enter);
    expect(shown(s)).toContain('Where does qwen3:8b run?');
    expect(shown(s)).toContain('> On Ollama, here: a pull first if it has not got it');
    press(s, enter);
    await s.idle();
    expect(pulled).toEqual(['qwen3:8b']);
    expect(s.state.step).toMatchObject({ name: 'fitness', phase: 'done' });
    expect(shown(s)).toContain('Checking qwen3:8b');
  });

  it('says a model is not fit and why, and lets the person choose another or use it anyway', async () => {
    const deps = real({ fitness: async (model) => fitResult(model.label, 'not fit') });
    const s = new Session(deps);
    s.start();
    press(s, enter);
    await s.idle();
    press(s, enter);
    await s.idle();
    expect(shown(s)).toContain('Not fit: its answer to one question did not pass its checks after the');
    expect(shown(s)).toContain("Kept in the journal with today's date.");
    press(s, { name: 'char', char: 'u' });
    await s.idle();
    expect(s.state.step.name).toBe('first-question');
  });

  it('says what would work when nothing is found, and still takes a typed name', async () => {
    const check = vi.fn(async (): Promise<MachineCheck> => ({ apps: [], keys: [], local: [], ollama: 'installed' }));
    const s = new Session(real({ checkMachine: check }));
    s.start();
    press(s, enter);
    await s.idle();
    expect(s.state.step.name).toBe('model-none');
    expect(shown(s)).toContain('Start Ollama, which is installed but not running');
    expect(shown(s)).toContain('Set an API key, for example ANTHROPIC_API_KEY or OPENAI_API_KEY');
    press(s, enter);
    await s.idle();
    expect(check).toHaveBeenCalledTimes(2);
    press(s, { name: 'char', char: 't' });
    expect(s.state.step).toMatchObject({ name: 'model-custom', stage: 'name' });
  });
});

describe('connecting PreReason', () => {
  // The bridge's claim; on approval its credentials file holds `saved`.
  function bridge(saved = fakeKey) {
    let emit: (e: ClaimEvent) => void = () => {};
    const state = { cancelled: false, started: 0, key: null as string | null };
    return {
      state,
      connect: (onEvent: (e: ClaimEvent) => void) => {
        emit = onEvent;
        state.started += 1;
        onEvent({ kind: 'link', url: 'https://www.prereason.com/claim/PR-ABCD-2345' });
        return { cancel: () => void (state.cancelled = true) };
      },
      approve: () => {
        state.key = saved;
        emit({ kind: 'ended', approved: true, message: 'PreReason: access approved.' });
      },
      expire: () => emit({ kind: 'ended', approved: false, message: 'PreReason: access was not granted (the link expired before it was approved).' }),
    };
  }

  it('shows the one link, then reads the key\'s tier with one call and says it', async () => {
    const b = bridge();
    const data = new Budgeted(BENCH_BRIEFINGS);
    const deps = real({ connect: b.connect, resolveKey: () => (b.state.key ? { key: b.state.key, source: 'file' } : null), briefings: () => data });
    const s = new Session(deps);
    s.start();
    press(s, enter);
    await s.idle();
    press(s, enter);
    await s.idle();
    press(s, enter);
    await s.idle();
    expect(shown(s)).toContain('https://www.prereason.com/claim/PR-ABCD-2345');
    b.approve();
    await s.idle();
    expect(data.calls).toBe(1);
    expect(s.state.step.name).toBe('first-question');
    expect(shown(s)).toContain('Connected on the free tier. Pick one, or type your own.');
    expect(readConfig(deps.home).prereason?.tier).toBe('free');
  });

  it('says why a claim failed, and tries again on Enter', async () => {
    const b = bridge();
    const s = new Session(real({ connect: b.connect, resolveKey: () => null }));
    s.start();
    press(s, enter);
    await s.idle();
    press(s, enter);
    await s.idle();
    press(s, enter);
    await s.idle();
    b.expire();
    expect(shown(s)).toContain('access was not granted (the link expired before it was approved).');
    press(s, enter);
    expect(b.state.started).toBe(2);
    press(s, { name: 'escape' });
    expect(b.state.cancelled).toBe(true);
    expect(s.state.step.name).toBe('model');
  });

  // B15: a quit while the bridge waits for approval must end the bridge, or it could save a
  // key after the person has gone.
  it("ends the bridge's claim on every way out while it waits: Esc, Ctrl+C, Ctrl+D and a closed window", async () => {
    const waiting = async () => {
      const b = bridge();
      const s = new Session(real({ connect: b.connect, resolveKey: () => null }));
      return { b, s };
    };
    const toConnect = async (s: Session) => {
      press(s, enter);
      await s.idle();
      press(s, enter);
      await s.idle();
      press(s, enter);
      await s.idle();
      expect(s.state.step).toMatchObject({ name: 'connect', phase: 'waiting' });
    };
    for (const key of [{ name: 'escape' }, { name: 'ctrl-c' }, { name: 'ctrl-d' }] as Key[]) {
      const { b, s } = await waiting();
      s.start();
      await toConnect(s);
      expect(b.state.cancelled).toBe(false);
      press(s, key);
      expect(b.state.cancelled).toBe(true);
    }

    // The window closed: the terminal driver hears SIGHUP and the session leaves with its claim ended.
    const { b, s } = await waiting();
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() }) as unknown as NodeJS.ReadStream;
    const written: string[] = [];
    const output = { write: (chunk: string) => written.push(chunk) > 0, on: () => output, off: () => output } as unknown as NodeJS.WriteStream;
    const signals = new EventEmitter();
    const closed = runInTerminal(s, 'plain', true, input, output, signals);
    try {
      await toConnect(s);
      expect(b.state.cancelled).toBe(false);
      signals.emit('SIGHUP');
      await vi.waitFor(() => expect(b.state.cancelled).toBe(true), { timeout: 2_000 });
      await closed;
      expect(written.at(-1)).toBe('\x1b[?25h\x1b[?1049l');
      expect(signals.listenerCount('SIGHUP')).toBe(0);
    } finally {
      input.write('\x04');
    }
  }, 30_000);

  // Walk item 2: a key revoked in PreReason's settings is still a well formed key in the
  // bridge's file, so only a read says PreReason refuses it.
  const newKey = `pr_test_${'n'.repeat(20)}`;
  const SAVED_REFUSED = 'PreReason no longer accepts the saved key. /connect prereason connects again.';
  const ENV_REFUSED = 'PREREASON_API_KEY holds a key PreReason no longer accepts: set a new one, or unset it and run primerkit connect prereason.';
  const ask = async (s: Session, question: string) => {
    press(s, ...typed(question), enter);
    await s.idle();
  };

  it('says once that PreReason no longer accepts the saved key, and how to connect again', async () => {
    const revoked = new Revoked(BENCH_BRIEFINGS);
    const { s } = atHome({ resolveKey: () => ({ key: fakeKey, source: 'file' }), briefings: () => revoked });
    await ask(s, 'Where does the 10 year yield stand?');
    expect(revoked.keyAccepted).toBe(false);
    expect(s.state.notice).toBe(SAVED_REFUSED);
    // Every read after it is refused the same way, and the notice is not said again.
    await ask(s, 'What is the dollar doing?');
    expect(s.state.notice).toBeNull();
  });

  it('runs the claim again on /connect prereason for the refused key, and reads with the new one', async () => {
    const b = bridge(newKey);
    const revoked = new Revoked(BENCH_BRIEFINGS);
    const fresh = new Budgeted(BENCH_BRIEFINGS);
    const { s } = atHome({ connect: b.connect, resolveKey: () => ({ key: b.state.key ?? fakeKey, source: 'file' }), briefings: (key) => (key === fakeKey ? revoked : fresh) });
    await ask(s, 'Where does the 10 year yield stand?');
    expect(s.state.notice).toBe(SAVED_REFUSED);
    press(s, ...typed('/connect prereason'), enter);
    await s.idle();
    expect(b.state.started).toBe(1);
    expect(s.state.step).toMatchObject({ name: 'connect', phase: 'waiting' });
    expect(s.state.notice).toBe('The saved key is no longer accepted by PreReason. Connecting again.');
    b.approve();
    await s.idle();
    expect(s.state.step.name).toBe('home');
    expect(s.state.notice).toBe('Connected to PreReason.');
    await ask(s, 'Where does the 10 year yield stand?');
    expect(fresh.calls).toBeGreaterThan(0);
    expect(s.state.notice).toBeNull();

    // The bridge approved, but its file still holds the refused key: no connection.
    const same = bridge(fakeKey);
    const again = atHome({ connect: same.connect, resolveKey: () => ({ key: fakeKey, source: 'file' }), briefings: () => new Revoked(BENCH_BRIEFINGS) });
    await ask(again.s, 'Where does the 10 year yield stand?');
    press(again.s, ...typed('/connect prereason'), enter);
    await again.s.idle();
    same.approve();
    await again.s.idle();
    expect(again.s.state.step).toMatchObject({ name: 'connect', phase: 'failed', message: 'PreReason approved access, but its credentials file still holds the key it refused.' });
  });

  it('says a refused key in PREREASON_API_KEY is the person\'s to change, and runs no claim', async () => {
    const b = bridge(newKey);
    const { s } = atHome({ connect: b.connect, briefings: () => new Revoked(BENCH_BRIEFINGS) });
    await ask(s, 'Where does the 10 year yield stand?');
    expect(s.state.notice).toBe(ENV_REFUSED);
    press(s, ...typed('/connect prereason'), enter);
    await s.idle();
    expect(s.state.notice).toBe(ENV_REFUSED);
    expect(b.state.started).toBe(0);
    expect(s.state.step.name).toBe('home');
  });

  it('in the first run, says the saved key is refused at its step, and Enter runs the claim', async () => {
    const b = bridge(newKey);
    const revoked = new Revoked(BENCH_BRIEFINGS);
    const fresh = new Budgeted(BENCH_BRIEFINGS);
    const deps = real({ connect: b.connect, resolveKey: () => ({ key: b.state.key ?? fakeKey, source: 'file' }), briefings: (key) => (key === fakeKey ? revoked : fresh) });
    const s = new Session(deps);
    s.start();
    press(s, enter);
    await s.idle();
    press(s, enter);
    await s.idle();
    press(s, enter);
    await s.idle();
    expect(s.state.step).toMatchObject({ name: 'connect', phase: 'failed', message: 'PreReason no longer accepts the saved key.' });
    expect(b.state.started).toBe(0);
    press(s, enter);
    await s.idle();
    expect(b.state.started).toBe(1);
    b.approve();
    await s.idle();
    expect(s.state.step.name).toBe('first-question');
    expect(fresh.calls).toBe(1);
  });
});

describe('starting again after leaving at the model check', () => {
  const kept = (verdict: string) => ({ kind: 'ollama' as const, base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b', format: 'json' as const, fitness: { verdict, reason: 'x', checked_at: '2026-09-26T10:00:00.000Z' } });

  // The walk of 10-14: Ctrl+C at the fitness result found the model and its verdict already in
  // config.yaml, and a restart ran the check again rather than offer the model.
  it('offers the checked, fit model first as a continue, and goes on without checking it again', async () => {
    const fitness = vi.fn(async (model: ModelAdapter) => fitResult(model.label));
    const deps = real({ fitness });
    const first = new Session(deps);
    first.start();
    press(first, enter);
    await first.idle();
    press(first, enter);
    await first.idle();
    expect(first.state.step).toMatchObject({ name: 'fitness', phase: 'done' });
    press(first, { name: 'ctrl-c' });
    expect(first.state.done).toBe(true);
    expect(readConfig(deps.home).model?.fitness?.verdict).toBe('fit for everything');
    expect(readConfig(deps.home).first_run_done_at).toBeUndefined();

    const again = new Session(deps);
    again.start();
    await again.idle();
    const step = again.state.step;
    expect(step).toMatchObject({ name: 'model', cursor: 0 });
    expect(step.name === 'model' && step.choices[0]).toMatchObject({ kind: 'kept', spec: { name: 'qwen2.5:7b' } });
    const out = shown(again);
    expect(out).toContain('Continue with qwen2.5:7b, checked Sep 26, 2026: fit for everything');
    expect(out).toContain('Choosing it goes on without checking it again.');
    // The other choices stay.
    expect(out).toContain('Inside Claude Code, on your subscription');
    expect(out).toContain('Here, with qwen2.5:7b on Ollama');
    press(again, enter);
    await again.idle();
    expect(fitness).toHaveBeenCalledTimes(1);
    expect(again.state.step.name).toBe('first-question');
    expect(again.state.model).toMatchObject({ name: 'qwen2.5:7b' });
    expect(readConfig(deps.home).model).toMatchObject({ name: 'qwen2.5:7b', format: 'json', fitness: { verdict: 'fit for everything' } });
  });

  it('does not offer a model found not fit, nor one that cannot be used here', async () => {
    const notFit = real();
    writeConfig(notFit.home, { disclaimer_accepted_at: 'x', model: kept('not fit') });
    const s = new Session(notFit);
    s.start();
    await s.idle();
    expect(s.state.step.name === 'model' && s.state.step.choices.map((c) => c.kind)).not.toContain('kept');
    expect(shown(s)).not.toContain('Continue with');
    // A hosted model whose key is not set in this terminal.
    const noKey = real({
      model: (choice) => {
        if (choice.kind === 'model' && choice.spec.kind === 'hosted') throw new Error('ANTHROPIC_API_KEY is not set');
        return new Labelled(choice);
      },
    });
    writeConfig(noKey.home, { disclaimer_accepted_at: 'x', model: { kind: 'hosted', provider: 'anthropic', name: 'claude-test-1', fitness: { verdict: 'fit for everything', reason: 'x', checked_at: '2026-09-26T10:00:00.000Z' } } });
    const t = new Session(noKey);
    t.start();
    await t.idle();
    expect(t.state.step.name === 'model' && t.state.step.choices.map((c) => c.kind)).not.toContain('kept');
    // CONTROL: the same config with a fit local model is offered.
    const fit = real();
    writeConfig(fit.home, { disclaimer_accepted_at: 'x', model: kept('fit for ask and digest only') });
    const u = new Session(fit);
    u.start();
    await u.idle();
    expect(u.state.step.name === 'model' && u.state.step.choices[0]).toMatchObject({ kind: 'kept', verdict: 'fit for ask and digest only' });
    expect(shown(u)).toContain('Continue with qwen2.5:7b, checked Sep 26, 2026: fit for ask and digest');
  });
});

describe('a change said once', () => {
  it('says a metric\'s change once, by the first briefing that states it, and keeps a signal and a direction apart', () => {
    // As a storyboard run's digest once said net liquidity three ways, from three briefings.
    const items = [
      { briefing: 'btc.context', metric: 'net-liquidity', kind: 'direction' as const, to: 'flat' },
      { briefing: 'macro.snapshot', metric: 'net-liquidity', kind: 'signal' as const, to: 'at-trend' },
      { briefing: 'macro.snapshot', metric: 'net-liquidity', kind: 'direction' as const, to: 'flat' },
      { briefing: 'cross.correlations', metric: 'net_liquidity', kind: 'signal' as const, to: 'at-trend' },
      { briefing: 'cross.correlations', metric: 'bitcoin-price', kind: 'signal' as const, to: 'bullish' },
      { briefing: 'macro.snapshot', metric: null, kind: 'quality' as const, to: 'stale' },
    ];
    expect(onceEach(items).map((i) => `${i.briefing} ${i.metric} ${i.kind}`)).toEqual([
      'btc.context net-liquidity direction',
      'macro.snapshot net-liquidity signal',
      'cross.correlations bitcoin-price signal',
      'macro.snapshot null quality',
    ]);
    // CONTROL: the same metric moving to a different state is a different change.
    expect(onceEach([items[0]!, { ...items[2]!, to: 'rising' }])).toHaveLength(2);
  });

  it('collects the change two briefings carry once, from the first in the watchlist', async () => {
    // Test data, not PreReason's: two briefings that both carry net liquidity, whose signal
    // was above trend at the end of yesterday and is at trend now.
    const body = (signal: string) => ({ generated_at: '2026-10-12T08:00:00Z', metrics: { 'net-liquidity': { signal, trend: { direction: 'flat' }, value_formatted: '$5.87T', timestamp: '2026-10-12T00:00:00Z' } } });
    const data = { id: 'prereason', readsDates: true, fetch: async (req: { briefing: string; date?: string }) => blockFromJson(req.briefing, body(req.date ? 'above-trend' : 'at-trend'), '2026-10-12T08:00:00Z') } as unknown as Briefings;
    const home = mkdtempSync(join(tmpdir(), 'pk-once-'));
    const c = await collectDigest({ data, snapshots: new Snapshots(join(home, 'snapshots')), home, now: () => new Date('2026-10-12T09:00:00Z') }, { watchlist: ['macro.snapshot', 'cross.correlations'], since: 'yesterday' });
    expect(c.items.map((i) => `${i.briefing} ${i.kind}`)).toEqual(['macro.snapshot signal']);
  });
});

describe('the digest', () => {
  // Yesterday's briefings, made for the test by changing two of today's: net liquidity
  // was rising, and the TGA's signal was at-trend. These are test data, not PreReason's.
  function withYesterday() {
    const today = readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8');
    const before = JSON.parse(today) as { metrics: Record<string, { signal: string; trend: { direction: string } }>; generated_at: string };
    before.metrics['net-liquidity']!.trend.direction = 'rising';
    before.metrics['tga']!.signal = 'at-trend';
    before.generated_at = '2026-09-24T23:55:00.000Z';
    const saved = new Budgeted(BENCH_BRIEFINGS);
    return {
      id: 'prereason',
      has: (id: string) => saved.has(id),
      get budget() {
        return saved.budget;
      },
      tier: 'free' as const,
      fetch: async (req: { briefing: string; format: 'json' | 'markdown'; date?: string }): Promise<DataBlock> => {
        if (req.date && req.briefing === 'macro.snapshot') return blockFromJson('macro.snapshot', JSON.stringify(before), '2026-09-26T08:00:00.000Z');
        if (req.date) throw new PreReasonError("not available on this key's tier", 403, 'DATE_RESTRICTED');
        return saved.fetch(req);
      },
    };
  }

  // A model that writes one sentence for each item, quoting the metric's name from its line.
  const writer = new ScriptedModel([
    (p: Packet) => {
      const items = p.blocks.find((b) => b.id === 'diff')!.lines.map((l) => JSON.parse(l) as { id: string; briefing: string; metric: string; kind: string; to: string; line: number });
      return JSON.stringify({
        changes: items.map((i) => ({
          item: i.id,
          text: i.kind === 'direction' ? `${i.metric} turned ${i.to}.` : `${i.metric}'s signal moved to ${i.to}.`,
          citations: [{ block: i.briefing, line: i.line, quote: `"metric":"${i.metric}"` }],
        })),
      });
    },
  ]);

  it('diffs against the end of yesterday on the first run, and writes each change with its checks', async () => {
    const data = withYesterday();
    const { s, deps } = atHome({ briefings: () => data, model: () => writer });
    press(s, ...typed('/digest'), enter);
    await s.idle();
    const entry = s.state.feed.at(-1);
    expect(entry).toMatchObject({ kind: 'digest' });
    const screenText = shown(s);
    expect(screenText).toMatch(/Digest {2}2 changes since the end of \d{4}-\d{2}-\d{2} UTC/);
    expect(screenText).toContain("+ tga's signal moved to above-trend [1].");
    expect(screenText).toContain('o net-liquidity turned flat [2].');
    expect(screenText).toContain('Same signal and direction: Fed balance, M2 supply, Treasury 2Y,');
    // The digest's seven checks, each named (they run over two rows).
    expect(screenText).toContain('ok 7 of 7 checks: answer format');
    expect(screenText).toContain('every item has a change');
    expect(screenText).toContain('cross.correlations: this key');
    const latest = readLatestDigest(deps.home)!;
    expect(latest.changes).toHaveLength(2);
    const kept = readdirSync(join(deps.home, 'snapshots', 'macro.snapshot'));
    expect(kept.length).toBe(2);
    // Yesterday's briefing is kept at the end of yesterday, not at the time PreReason generated it.
    expect(kept.filter((f) => /T23-59-59\.999Z\.json$/.test(f))).toHaveLength(1);

    // The next digest compares with what this one read, and nothing moved since.
    press(s, ...typed('/digest'), enter);
    await s.idle();
    expect(shown(s)).toMatch(/no changes since your last digest, \w{3} \d+ \w{3} \d{2}:\d{2} UTC/);
  });

  it('shows a change as the diff states it when the model leaves it out, and says so', async () => {
    const lazy = new ScriptedModel([JSON.stringify({ changes: [] })]);
    const { s } = atHome({ briefings: () => withYesterday(), model: () => lazy });
    // Seven checks named and the count said as the diff states it run over four rows, past
    // what 22 rows show of the box, so the window is a little taller here.
    s.resize(77, 28);
    press(s, ...typed('/digest'), enter);
    await s.idle();
    expect(shown(s)).toContain('Net liquidity turned flat, from rising, as the diff states it [2].');
    // The count wraps onto the checks' last row, "| 2" and then "said as the diff states it".
    expect(shown(s)).toMatch(/ 2\s+(?:\|\s+)?said as the diff states it/);
  });

  it('names only the format check for a reply that is not JSON, or not in its shape, not five checks that never ran', async () => {
    for (const reply of ['Net liquidity turned flat, and the TGA moved above trend.', '{"changes":"Net liquidity turned flat."}']) {
      const { s } = atHome({ briefings: () => withYesterday(), model: () => new ScriptedModel([reply]) });
      press(s, ...typed('/digest'), enter);
      await s.idle();
      const screen = shown(s);
      expect(screen, reply).toContain("x 0 of 1 checks: the answer's format is wrong, so the other");
      expect(screen, reply).not.toMatch(/advice words|of 6 checks/);
    }
  });

  it("shows today's digest by this machine's clock, as the schedule's time is", () => {
    // The times are this machine's own: a time zone set inside a test does not reach a
    // vitest worker's clock, so until 2026-10-10 this test passed on a machine east of UTC
    // and failed on Linux in UTC. A digest that ran at 00:30 is today's at 23:30 on the same
    // day. East of UTC the 00:30 is the day before in UTC, and west of UTC the 23:30 is the
    // day after, so a check by UTC days fails here wherever the machine is not on UTC.
    const ranAt = new Date(2026, 9, 9, 0, 30).toISOString();
    let now = new Date(2026, 9, 9, 23, 30);
    const deps = real({ now: () => now });
    writeConfig(deps.home, { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model: { kind: 'ollama', base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' }, prereason: { tier: 'free' } });
    writeLatestDigest(deps.home, { ranAt, since: null, briefings: [], changes: [], same: [], notes: [], sources: [], checks: null, computed: 0, generated: null, model: null });
    const morning = new Session(deps);
    morning.start();
    expect(morning.state.digest?.ranAt).toBe(ranAt);
    // CONTROL: just after midnight, before it runs again, it is yesterday's.
    now = new Date(2026, 9, 10, 0, 15);
    const next = new Session(deps);
    next.start();
    expect(next.state.digest).toBeNull();
  });

  it("shows today's digest at the top of home on a later start", async () => {
    const { s, deps } = atHome({ briefings: () => withYesterday(), model: () => writer });
    press(s, ...typed('/digest'), enter);
    await s.idle();
    const later = new Session(deps);
    later.start();
    expect(shown(later)).toMatch(/Digest {2}2 changes since/);
  });

  it('shows the entry before it is added, and adds it on Enter', async () => {
    const scheduler = fakeScheduler();
    const { s, deps } = atHome({ scheduler });
    press(s, ...typed('/schedule'), enter, down, enter, ...typed('7:30'), enter);
    expect(shown(s)).toContain('The entry primerkit adds to Task Scheduler');
    expect(shown(s)).toContain('when   every day at 07:30, as you, or on waking if the machine');
    expect(scheduler.added).toEqual([]);
    press(s, enter);
    await s.idle();
    expect(scheduler.added.map((e) => e.time)).toEqual(['07:30']);
    expect(shown(s)).toContain('Added. The digest runs every day at 07:30.');
    expect(readConfig(deps.home).digest?.time).toBe('07:30');
    press(s, enter, ...typed('/schedule remove'), enter);
    await s.idle();
    expect(s.state.notice).toBe('Removed the digest from the schedule.');
  });
});

describe('asking at home', () => {
  it('names a field the format does not allow under an answer that failed, so a refused trade field reads as one', async () => {
    const reply = JSON.stringify({ answer: 'Liquidity is as the lines say.', claims: [], not_in_data: [], action: 'buy' });
    const { s } = atHome({ model: () => new ScriptedModel([reply]) });
    press(s, ...typed('macro.snapshot: how is liquidity?'), enter);
    await s.idle();
    const screen = shown(s);
    expect(screen).toContain('x The answer did not pass its checks, so it is not shown.');
    // The note runs over two rows, its field on the closing one.
    expect(screen).toMatch(/It failed on: the response holds a field its format does not allow:\n \+ action\n/);
    expect(screen).not.toContain('must NOT have additional properties');
  });

  it('stops a run on Ctrl+C and keeps nothing from it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'primerkit-journal-'));
    const waiting: ModelAdapter = {
      id: 'waiting',
      label: 'waiting, local',
      capabilities: async () => ({ local: true, schemaConstraint: true, contextTokens: null, canRaiseContext: false, format: 'markdown' }),
      complete: (_p, _r, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    };
    const { s } = atHome({ model: () => waiting, journal: new Journal(root) });
    press(s, ...typed('Is net liquidity rising or falling?'), enter);
    await vi.waitFor(() => expect(s.state.feed[0]).toMatchObject({ kind: 'running', running: { phase: 'answering' } }));
    press(s, { name: 'ctrl-c' });
    await s.idle();
    expect(s.state.feed).toEqual([]);
    expect(s.state.notice).toBe('Stopped. Nothing from this run was kept.');
    expect(readdirSync(root)).toEqual([]);
  });

  // Saved briefings for a key PreReason names as pro on every answer, which reads every
  // briefing in the catalog.
  class Pro extends FixtureConnector {
    tier: 'pro' | null = null;
    reads: string[] = [];
    override has(): boolean {
      return true;
    }
    override async fetch(req: { briefing: string; format: 'json' | 'markdown'; date?: string }) {
      this.reads.push(req.briefing);
      this.tier = 'pro';
      return super.fetch({ ...req, briefing: 'btc.pulse' });
    }
  }
  const later = { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model: { kind: 'ollama' as const, base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' } };

  it("learns a key's tier with one read before the first pick where none is kept, picks from every briefing it reads, and keeps the tier", async () => {
    const data = new Pro(BENCH_BRIEFINGS);
    const scripted = () => new ScriptedModel([JSON.stringify({ read: ['btc.pulse'] }), JSON.stringify({ answer: 'x', claims: [], not_in_data: ['everything'] })], { local: false, format: 'json' });
    const picker = scripted();
    const deps = real({ briefings: () => data, model: () => picker });
    // A key set after the first run: config.yaml keeps no tier.
    writeConfig(deps.home, later);
    const s = new Session(deps);
    s.start();
    expect(s.state.tier).toBeNull();
    press(s, ...typed('How is the market regime shifting?'), enter);
    await s.idle();
    // The first read learned the tier: a free briefing, read before the model picked.
    expect(['btc.quick-check', 'btc.pulse', 'btc.context', 'macro.snapshot', 'cross.correlations', 'btc.grid-stress']).toContain(data.reads[0]);
    const pick = picker.calls[0]!.packet.text;
    expect(pick).toContain('cross.regime:');
    expect(pick).toContain('fx.liquidity:');
    expect(readConfig(deps.home).prereason?.tier).toBe('pro');
    // Kept, the tier is known at the next start, and no read is spent learning it again.
    const next = new Pro(BENCH_BRIEFINGS);
    const nextPicker = scripted();
    const again = new Session({ ...deps, briefings: () => next, model: () => nextPicker });
    again.start();
    expect(again.state.tier).toBe('pro');
    press(again, ...typed('How is the market regime shifting?'), enter);
    await again.idle();
    expect(next.reads).toEqual(data.reads.slice(1));
    expect(nextPicker.calls[0]!.packet.text).toContain('cross.regime:');
  });

  it('keeps a tier an answer names where it differs from the one kept, as for an upgraded key', async () => {
    const { s, deps } = atHome({ briefings: () => new Pro(BENCH_BRIEFINGS) });
    expect(readConfig(deps.home).prereason?.tier).toBe('free');
    press(s, ...typed('/brief macro.snapshot'), enter);
    await s.idle();
    expect(s.state.tier).toBe('pro');
    expect(readConfig(deps.home).prereason?.tier).toBe('pro');
  });

  it('fits the packet to a small model and names what it left out', async () => {
    const small = new ScriptedModel([JSON.stringify({ answer: 'x', claims: [], not_in_data: ['everything'] })], { contextTokens: 3072, format: 'json' });
    const { s } = atHome({ model: () => small });
    press(s, ...typed('btc.pulse and macro.snapshot and btc.context: how is liquidity?'), enter);
    await s.idle();
    expect(shown(s)).toMatch(/was not read, to fit the model's context of 3,072 tokens/);
  });

  it("shows an answer's background apart from what the data says, and names where it came from", async () => {
    const reply = { answer: 'The briefings hold no line on why a halving matters.', claims: [], not_in_data: ['why a halving matters'], background: ['A halving cuts the new coins miners earn for each block.'] };
    const { s } = atHome({ model: () => new ScriptedModel([JSON.stringify(reply)], { format: 'json' }) });
    press(s, ...typed('btc.pulse: why does a halving matter?'), enter);
    await s.idle();
    expect(s.state.feed[0]).toMatchObject({ kind: 'answer', view: { background: reply.background } });
    const out = shown(s);
    expect(out).toContain("Background, from the model's general knowledge, not from");
    expect(out).toContain('cuts the new coins miners earn for each block.');
  });

  it("names a briefing the key's tier cannot read, and a briefing added as close to the question", async () => {
    const saved = new FixtureConnector(BENCH_BRIEFINGS);
    const { s } = atHome({
      briefings: () => ({
        id: 'prereason',
        has: (id: string) => saved.has(id),
        fetch: async (req) => {
          if (req.briefing === 'btc.context') throw new PreReasonError("not available on this key's tier", 403, 'BRIEFING_RESTRICTED');
          return saved.fetch(req);
        },
      }),
    });
    press(s, ...typed('btc.pulse and btc.context: where does bitcoin price stand with net liquidity?'), enter);
    await s.idle();
    expect(s.state.feed[0]).toMatchObject({ kind: 'answer', skipped: ['btc.context'] });
    expect(shown(s)).toContain("Not read: btc.context, not available on this key's tier.");
    // The answer first, then the lines it rests on and its checks, and only then the note.
    const out = shown(s);
    const answer = out.indexOf('|', out.indexOf('btc.pulse and btc.context'));
    expect(answer).toBeGreaterThan(0);
    expect(answer).toBeLessThan(out.indexOf('checks:'));
    expect(out.indexOf('checks:')).toBeLessThan(out.indexOf('Not read: btc.context'));
  });

  it('keeps each run in the journal and opens it again', async () => {
    const { s } = atHome();
    press(s, ...typed('Where does Bitcoin stand?'), enter);
    await s.idle();
    press(s, ...typed('/journal'), enter);
    expect(shown(s)).toContain('Journal  every run on this machine, newest first');
    expect(shown(s)).toMatch(/ask\s+Where does Bitcoin stand\?/);
    press(s, enter);
    expect(shown(s)).toContain('ok 5 of 5 checks:');
    // The five checks named run over three rows, so the credit is a scroll away.
    press(s, { name: 'down' }, { name: 'down' }, { name: 'down' });
    expect(shown(s)).toMatch(/PR \| [a-z.,\- ]+ \| generated \d\d:\d\d UTC/);
    press(s, { name: 'escape' }, { name: 'escape' });
    expect(s.state.step.name).toBe('home');
  });

  it('runs the model check into the feed, and says what a later build adds', async () => {
    const { s } = atHome();
    press(s, ...typed('/model check'), enter);
    expect(shown(s)).toContain('asking "Where does Bitcoin stand?" of a saved briefing');
    await s.idle();
    expect(shown(s)).toContain('Model check  qwen2.5:7b, local, 8k');
    expect(shown(s)).toContain('ok Answer shape: 5 of 5 answers were valid JSON of the right shape.');
    press(s, ...typed('/arms'), enter);
    expect(s.state.notice).toBe('/arms comes in a later build.');
    press(s, ...typed('/q'), { name: 'tab' });
    expect(s.state.input).toBe('/quit');
  });
});

describe('the schedule entry', () => {
  it('writes a Task Scheduler entry that runs as the person and catches up after sleep', () => {
    const e = digestEntry({ time: '08:00', platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\A & B\\primerkit\\bin\\primerkit.js', cwd: 'C:\\pk', now: new Date('2026-09-26T09:00:00') });
    expect(e.text).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(e.text).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(e.text).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(e.text).toContain('<StartBoundary>2026-09-27T08:00:00</StartBoundary>');
    expect(e.text).toContain('<Arguments>&quot;C:\\Users\\A &amp; B\\primerkit\\bin\\primerkit.js&quot; run digest</Arguments>');
  });

  it('writes a launchd job on macOS and a tagged cron line on Linux', () => {
    const mac = digestEntry({ time: '07:05', platform: 'darwin', node: '/usr/local/bin/node', script: '/pk/bin/primerkit.js', cwd: '/pk', log: '/h/.primerkit/digest/scheduled.log' });
    expect(mac.text).toContain('<key>Hour</key><integer>7</integer><key>Minute</key><integer>5</integer>');
    const linux = digestEntry({ time: '07:05', platform: 'linux', node: '/usr/bin/node', script: "/pk/it's/primerkit.js", cwd: '/pk', log: '/h/log' });
    expect(linux.text).toBe(`5 7 * * * cd '/pk' && '/usr/bin/node' '/pk/it'\\''s/primerkit.js' run digest >> '/h/log' 2>&1 # primerkit digest`);
    expect(linux.when).toContain('cron does not run a time the machine slept through');
  });

  it('tells a scheduled run where PRIMERKIT_HOME is, as the scheduler starts it without it, and logs there', () => {
    const home = 'C:\\Users\\Dan K\\pk home';
    const win = digestEntry({ time: '08:00', platform: 'win32', node: 'node.exe', script: 'C:\\pk\\primerkit.js', cwd: 'C:\\pk', home, now: new Date('2026-09-26T09:00:00') });
    expect(win.text).toContain('<Arguments>&quot;C:\\pk\\primerkit.js&quot; run digest --home &quot;C:\\Users\\Dan K\\pk home&quot;</Arguments>');
    const mac = digestEntry({ time: '07:05', platform: 'darwin', node: '/n', script: '/pk.js', cwd: '/pk', home: '/h/pk home' });
    expect(mac.text).toContain('<string>run</string><string>digest</string><string>--home</string><string>/h/pk home</string>');
    expect(mac.log).toBe(join('/h/pk home', 'digest', 'scheduled.log'));
    const linux = digestEntry({ time: '07:05', platform: 'linux', node: '/n', script: '/pk.js', cwd: '/pk', home: '/h/pk home' });
    expect(linux.text).toContain("run digest --home '/h/pk home' >> ");
    // A home that ends in a backslash keeps it: Windows reads \" as a quote.
    const trailing = digestEntry({ time: '08:00', platform: 'win32', node: 'node.exe', script: 'C:\\pk\\primerkit.js', cwd: 'C:\\pk', home: 'C:\\Users\\Jo Smith\\pk\\', now: new Date('2026-09-26T09:00:00') });
    expect(trailing.text).toContain('--home &quot;C:\\Users\\Jo Smith\\pk\\\\&quot;</Arguments>');
    // CONTROL: with no PRIMERKIT_HOME the entry says nothing of it.
    expect(digestEntry({ time: '07:05', platform: 'linux', node: '/n', script: '/pk.js', cwd: '/pk', log: '/h/log' }).text).not.toContain('--home');
  });

  it("makes the log's folder when it adds a cron line, which cron does not, so the first morning's run starts", async () => {
    const root = mkdtempSync(join(tmpdir(), 'pk-cron-'));
    const log = join(root, 'never-made', 'digest', 'scheduled.log');
    const scheduler = systemScheduler('linux', async () => ({ code: 0, stdout: '', stderr: '' }));
    await scheduler.add(digestEntry({ time: '07:05', platform: 'linux', node: '/n', script: '/pk.js', cwd: '/pk', log }));
    expect(existsSync(dirname(log))).toBe(true);
  });
});

describe('the terminal', () => {
  it('maps keys', () => {
    expect(toKey('\r', { name: 'return' })).toEqual({ name: 'enter' });
    expect(toKey(undefined, { name: 'up' })).toEqual({ name: 'up' });
    expect(toKey('\x03', { name: 'c', ctrl: true })).toEqual({ name: 'ctrl-c' });
    expect(toKey('q', { name: 'q' })).toEqual({ name: 'char', char: 'q' });
    expect(toKey('\x1b[1;5A', { name: 'up', ctrl: true })).toBeNull();
    // readline reports a lone Esc with meta set; Alt with a letter stays set aside.
    expect(toKey(undefined, { name: 'escape', meta: true, sequence: '\x1b' })).toEqual({ name: 'escape' });
    expect(toKey('x', { name: 'x', meta: true })).toBeNull();
  });

  it('reads Esc as a terminal sends it, through readline: the first closes the menu, the next clears the input', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() }) as unknown as NodeJS.ReadStream;
    const output = { write: () => true, on: () => output, off: () => output } as unknown as NodeJS.WriteStream;
    const deps = real();
    writeConfig(deps.home, { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model: { kind: 'ollama', base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' }, prereason: { tier: 'free' } });
    const s = new Session(deps);
    const closed = runInTerminal(s, 'plain', true, input, output);
    input.write('/');
    await vi.waitFor(() => expect(s.state.menu).not.toBeNull());
    // The bytes of one Esc press; readline waits half a second before it reports one.
    input.write('\x1b');
    await vi.waitFor(() => expect(s.state.menu).toBeNull(), { timeout: 3_000 });
    expect(s.state.input).toBe('/');
    input.write('\x1b');
    await vi.waitFor(() => expect(s.state.input).toBe(''), { timeout: 3_000 });
    // An arrow key's escape sequence is still an arrow, not an Esc.
    input.write('/');
    await vi.waitFor(() => expect(s.state.menu).not.toBeNull());
    input.write('\x1b[B');
    await vi.waitFor(() => expect(s.state.menu?.cursor).toBe(1));
    expect(s.state.input).toBe('/');
    input.write('\x04');
    await closed;
  }, 30_000);

  it('draws in the alternate screen, reads keys, and gives the terminal back on leaving', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() }) as unknown as NodeJS.ReadStream;
    const written: string[] = [];
    const output = { write: (chunk: string) => written.push(chunk) > 0, on: () => output, off: () => output } as unknown as NodeJS.WriteStream;
    const s = new Session(demo());
    const closed = runInTerminal(s, 'plain', true, input, output);
    input.write('\r');
    await vi.waitFor(() => expect(written.join('')).toContain('Found on this machine: Claude Code, and Ollama with 2 models.'), { timeout: 10_000 });
    input.write('\x04');
    await closed;
    const all = written.join('');
    expect(all.startsWith('\x1b[?1049h\x1b[?25l')).toBe(true);
    expect(all.endsWith('\x1b[?25h\x1b[?1049l')).toBe(true);
    expect(vi.mocked(input.setRawMode).mock.calls).toEqual([[true], [false]]);
  }, 60_000);

  it('says the window is too small instead of drawing a broken session, and draws it again once it fits', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() }) as unknown as NodeJS.ReadStream;
    const written: string[] = [];
    let resize: () => void = () => {};
    const output = {
      columns: 40,
      rows: 12,
      write: (chunk: string) => written.push(chunk) > 0,
      on: (event: string, f: () => void) => ((event === 'resize' ? (resize = f) : undefined), output),
      off: () => output,
    } as unknown as NodeJS.WriteStream & { columns: number; rows: number };
    const s = new Session(demo());
    const closed = runInTerminal(s, 'plain', true, input, output);
    await vi.waitFor(() => expect(written.join('')).toContain('this one is 40 by 12.'), { timeout: 10_000 });
    // Every line of the message fits the small window.
    const lines = (chunks: string[]) => chunks.join('').split(/\r\n|\x1b\[K|\x1b\[H/).filter((l) => l && !l.startsWith('\x1b'));
    for (const line of lines(written)) expect(line.length).toBeLessThanOrEqual(39);
    // Made larger, the session is drawn again, in the window's own size.
    Object.assign(output, { columns: 57, rows: 30 });
    written.length = 0;
    resize();
    await vi.waitFor(() => expect(written.join('')).toContain('Before you start'), { timeout: 10_000 });
    expect(written.join('')).not.toContain('needs a window');
    const frame = written.join('').split('\x1b[H').at(-1) ?? '';
    expect(frame.split('\r\n')).toHaveLength(30);
    for (const line of lines([frame])) expect(line.length).toBeLessThanOrEqual(56);
    input.write('\x04');
    await closed;
  }, 60_000);

  it('asks for 49 columns by 16 rows, and not more', () => {
    expect(tooSmall(49, 16, true)).toBeNull();
    expect(tooSmall(48, 16, true)).not.toBeNull();
    expect(tooSmall(49, 15, true)).not.toBeNull();
    // CONTROL: the grid is larger than the least the check asks for.
    expect(tooSmall(WIDTH + 1, HEIGHT, true)).toBeNull();
  });
});

describe('the command menu at home', () => {
  const texts = (s: Session) => s.state.menu?.rows.map((r) => r.text) ?? [];

  it('opens as / is typed, lists every command with what it does, and narrows as it is typed', () => {
    const { s } = atHome();
    press(s, ...typed('/'));
    // Every command this build runs is in it, and nothing a later build adds.
    expect(texts(s)).toEqual(expect.arrayContaining([...COMMANDS, '/model check']));
    for (const later of LATER_COMMANDS) expect(texts(s)).not.toContain(later);
    expect(shown(s)).toMatch(/> \/digest +what changed since the last digest/);
    expect(shown(s)).toContain(`1 of ${texts(s).length} | up and down to move | Enter chooses | Tab completes | Esc closes`);
    press(s, ...typed('mo'));
    // /model switches the model itself now; Tab from home does the same.
    expect(texts(s)).toEqual(['/model', '/model check']);
    expect(shown(s)).toMatch(/\/model check +check the model again/);
    // CONTROL: a question opens no menu.
    press(s, { name: 'escape' }, { name: 'escape' }, ...typed('where is'));
    expect(s.state.input).toBe('where is');
    expect(s.state.menu).toBeNull();
  });

  it('runs the row the arrow keys highlight, on Enter', async () => {
    const { s } = atHome();
    press(s, ...typed('/mo'), { name: 'down' });
    expect(s.state.menu?.cursor).toBe(1);
    press(s, enter);
    await s.idle();
    expect(s.state.menu).toBeNull();
    expect(shown(s)).toContain('Model check  qwen2.5:7b, local, 8k');
    // CONTROL: Up stops at the first row.
    press(s, ...typed('/mo'), { name: 'up' }, { name: 'up' });
    expect(s.state.menu?.cursor).toBe(0);
  });

  it('lists every chart the briefings can draw after /chart, and draws the one chosen', async () => {
    const { s } = atHome();
    press(s, ...typed('/chart'), enter);
    expect(s.state.input).toBe('/chart ');
    expect(s.state.step.name).toBe('home');
    expect(texts(s)).toContain('/chart yield curve 1y');
    // The saved briefings hold no btc.etf-flows, so its chart is not offered.
    expect(texts(s)).not.toContain('/chart etf flows fill');
    press(s, { name: 'down' }, { name: 'down' }, enter);
    await s.idle();
    expect(s.state.step).toMatchObject({ name: 'board', request: { kind: 'yield curve', compare: '1y' } });
  });

  it("lists the briefings the key reads after /brief, by their names from the catalog, and draws the one chosen", async () => {
    const { s } = atHome();
    press(s, ...typed('/brief '));
    await s.idle();
    expect(s.state.menu?.rows).toContainEqual({ text: '/brief macro.snapshot', about: 'Macro Snapshot' });
    press(s, ...typed('mac'));
    expect(texts(s)).toEqual(['/brief macro.snapshot']);
    press(s, enter);
    await s.idle();
    expect(shown(s)).toContain('Macro Snapshot  15 metrics');
  });

  it('completes on Tab without running, closes on Esc keeping what is typed, and clears on a second Esc', () => {
    const { s } = atHome();
    press(s, ...typed('/sch'), { name: 'down' }, { name: 'tab' });
    expect(s.state.input).toBe('/schedule remove');
    expect(s.state.step.name).toBe('home');
    press(s, { name: 'escape' });
    expect(s.state.menu).toBeNull();
    expect(s.state.input).toBe('/schedule remove');
    // Tab opens the closed menu again.
    press(s, { name: 'tab' });
    expect(texts(s)).toEqual(['/schedule remove']);
    press(s, { name: 'escape' }, { name: 'escape' });
    expect(s.state.input).toBe('');
  });

  it('runs a command typed in full that the menu does not list, as typed', async () => {
    const { s } = atHome();
    press(s, ...typed('/chart yield curve 2025-09-26'));
    expect(s.state.menu).toBeNull();
    press(s, enter);
    await s.idle();
    expect(s.state.step).toMatchObject({ name: 'board', request: { kind: 'yield curve', compare: { date: '2025-09-26' } } });
  });

  it('draws within the window, the words under the rows where they do not fit beside them', () => {
    const { s } = atHome();
    s.resize(49, 16);
    press(s, ...typed('/mo'));
    for (const ascii of [true, false]) {
      const lines = screen(s.state, ascii);
      expect(lines).toHaveLength(16);
      for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(48);
    }
    expect(shown(s)).toContain('\n   switch the model; Tab from home does too\n');
    // CONTROL: on the grid the words sit beside each row.
    s.resize(77, 22);
    expect(shown(s)).toMatch(/> \/model +switch the model; Tab from home does too/);
  });
});

describe('the session in any window', () => {
  const WINDOWS = [
    [49, 16],
    [57, 20],
    [64, 30],
    [77, 22],
    [120, 45],
  ] as const;

  it('draws every screen of the first run in the rows it has and within its columns, from 49 by 16 up', async () => {
    for (const [columns, rows] of WINDOWS) {
      for (const ascii of [false, true]) {
        for (const shot of await walk(demo(), FIRST_RUN_WALK, ascii, { columns, rows })) {
          const where = `${columns} by ${rows}, ${shot.title}`;
          expect(shot.lines.length, where).toBe(rows);
          // The grid's 76 columns, or every column of a window 100 or more wide.
          for (const line of shot.lines) expect(widthOf(line), `${where}: ${text([line])}`).toBeLessThanOrEqual(columns - 1 >= 100 ? columns - 1 : Math.min(WIDTH, columns - 1));
          // Nothing is cut short to fit: a line cut at the window's edge would end in an ellipsis.
          expect(text(shot.lines), where).not.toMatch(/…$/m);
          if (ascii) expect(/^[\x00-\x7f]*$/.test(text(shot.lines)), where).toBe(true);
        }
      }
    }
  }, 120_000);

  it('keeps every point agreed to on the welcome screen, and every question offered, in the smallest window', async () => {
    const shots = await walk(demo(), FIRST_RUN_WALK, true, { columns: 49, rows: 16 });
    const words = (title: string) => text(shots.find((s) => s.title.startsWith(title))?.lines ?? []).replace(/\s+/g, ' ');
    for (const point of DISCLAIMER_POINTS) expect(words('1.')).toContain(point.join(' '));
    for (const q of FIRST_QUESTIONS) expect(words('5.')).toContain(q.question);
    // CONTROL: the smallest window does lose what is not needed: the wordmark is the name alone.
    expect(text(shots[0]?.lines ?? [])).not.toContain(text((await walk(demo(), FIRST_RUN_WALK.slice(0, 1), true))[0]?.lines.slice(1, 3) ?? []));
  }, 60_000);

  it('draws on the grid in a window of 77 by 22, as it always has', async () => {
    const grid = await walk(demo(), FIRST_RUN_WALK, true);
    const sized = await walk(demo(), FIRST_RUN_WALK, true, { columns: 77, rows: 22 });
    expect(sized.map((s) => text(s.lines))).toEqual(grid.map((s) => text(s.lines)));
    // CONTROL: one column less is a different drawing.
    const narrower = await walk(demo(), FIRST_RUN_WALK.slice(0, 1), true, { columns: 66, rows: 22 });
    expect(text(narrower[0]?.lines ?? [])).not.toBe(text(grid[0]?.lines ?? []));
  }, 60_000);

  it('gives a chart the whole width of a wide window, its sentences still at 72, and every other screen the whole width above 100 columns', async () => {
    const { s } = atHome();
    s.resize(150, 40);
    press(s, ...typed('/chart yield curve'), enter);
    await s.idle();
    for (const ascii of [true, false]) {
      const lines = screen(s.state, ascii);
      expect(lines).toHaveLength(40);
      for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(149);
    }
    const rows = shown(s).split('\n');
    // The axis runs across the window: the session draws in 149 of its columns, 73 more
    // inside the block than on the grid.
    const axis = rows.find((l) => /\+-+\+/.test(l))!;
    expect(axis.length).toBe(3 + 7 + 2 + 52 + 73);
    // A sentence wraps where it did on the grid: a line inside the block whose words have
    // no run of spaces between them, as a chart's rows have.
    const sentences = rows.filter((r) => r.startsWith(' | ') && /[A-Za-z]/.test(r) && !/\S {2,}\S/.test(r.slice(3).trim()));
    expect(sentences.length).toBeGreaterThan(3);
    for (const l of sentences) expect(l.length, l).toBeLessThanOrEqual(76);
    // Home, in the same window, takes the whole width too: its panel's bars run across it.
    press(s, { name: 'escape' });
    expect(s.state.step.name).toBe('home');
    const home = screen(s.state, true);
    for (const line of home) expect(widthOf(line)).toBeLessThanOrEqual(149);
    expect(widthOf(home[0]!)).toBe(149);
    expect(widthOf(home.at(-1)!)).toBe(149);
    // CONTROL: below 100 columns, home keeps to the grid's 76.
    s.resize(99, 40);
    for (const line of screen(s.state, true)) expect(widthOf(line)).toBeLessThanOrEqual(76);
  });

  it('grows a chart into the rows a tall window has to spare, and keeps it as it was on the grid', async () => {
    const { s } = atHome();
    // The plot's rows on screen: from its first labelled row to the axis.
    const plot = () => {
      const rows = shown(s).split('\n');
      return rows.findIndex((l) => /\+-+\+/.test(l)) - rows.findIndex((l) => /\d% \+/.test(l));
    };
    s.resize(121, 48);
    press(s, ...typed('/chart yield curve'), enter);
    await s.idle();
    expect(shown(s).split('\n')).toHaveLength(48);
    expect(plot()).toBeGreaterThan(20);
    // The whole board is on the screen: nothing to scroll to.
    expect(shown(s)).not.toContain('to scroll');
    expect(shown(s)).toContain('PR  macro.snapshot');
    // CONTROL: on the grid the curve keeps its six rows.
    s.resize(77, 22);
    expect(plot()).toBe(6);
  });

  it('draws a board again for a narrower window, and as before once the window is wide again', async () => {
    const { s } = atHome();
    press(s, ...typed('/brief macro.snapshot'), enter);
    await s.idle();
    const before = shown(s);
    s.resize(57, 20);
    const narrow = screen(s.state, true);
    expect(narrow).toHaveLength(20);
    for (const line of narrow) expect(widthOf(line)).toBeLessThanOrEqual(56);
    expect(text(narrow)).toContain('Macro Snapshot');
    expect(text(narrow)).toContain('Fed balance');
    s.resize(77, 22);
    // CONTROL: back at the grid's size, the board is as it was.
    expect(shown(s)).toBe(before);
  });
});

describe('boards and charts in the session', () => {
  const fits = (s: Session) => {
    for (const ascii of [true, false]) {
      const lines = screen(s.state, ascii);
      expect(lines.length).toBe(HEIGHT);
      for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(WIDTH);
      if (ascii) expect(/^[\x00-\x7f]*$/.test(text(lines))).toBe(true);
    }
  };

  it('draws /brief as a board that scrolls, within the screen, and Esc goes home', async () => {
    const { s } = atHome();
    press(s, ...typed('/brief macro.snapshot'), enter);
    await s.idle();
    expect(s.state.step).toMatchObject({ name: 'board', error: null });
    const board = shown(s);
    expect(board).toContain('Macro Snapshot  15 metrics | 09:05 UTC');
    // The header keeps its columns, and a row keeps its percentile inside the screen. With no
    // days kept in the journal, the 30 days column is left out rather than drawn empty.
    expect(board).toContain(' | metric         level       7d       30d      where');
    expect(board).toMatch(/\| Fed balance\s+\$6\.75T\s+o 0\.0%\s+\^ 0\.3%\s+-*o-* P\d+\n/);
    expect(board).toContain('Net liquidity');
    expect(board).toContain('up and down to scroll | Esc goes back');
    expect(board).toContain('PR  macro.snapshot | generated 09:05 UTC');
    fits(s);
    press(s, { name: 'down' });
    expect(s.state.step).toMatchObject({ top: 1 });
    press(s, { name: 'escape' });
    expect(s.state.step.name).toBe('home');
  });

  it('draws /chart yield curve in braille, and the arrows compare with another range', async () => {
    const { s } = atHome();
    press(s, ...typed('/chart yield curve'), enter);
    await s.idle();
    expect(shown(s)).toContain('Treasury yield curve  now, and 30 days ago');
    expect(shown(s)).toContain('left and right change the range | Esc goes back');
    expect(text(screen(s.state, false))).toMatch(/[\u2800-\u28ff]/);
    fits(s);
    press(s, { name: 'right' });
    await s.idle();
    expect(shown(s)).toContain('Treasury yield curve  now, and 90 days ago');
  });

  it('says what is wrong with a chart it cannot draw', async () => {
    const { s } = atHome();
    press(s, ...typed('/chart sectors'), enter);
    expect(s.state.notice).toBe('The charts are yield curve, bitcoin, hashprice, treasury, etf flows, liquidity, correlations, market map, markets, positioning, or a metric over time, such as /chart treasury-10y.');
    press(s, ...typed('/chart bitcoin'), enter);
    await s.idle();
    expect(shown(s)).toContain('Not drawn');
    expect(shown(s)).toContain('The saved briefings carry no price history.');
    fits(s);
  });

  it('draws the market map and positioning with the time they were read, and a credit that names no generated time', async () => {
    const { s } = atHome({ briefings: () => marketConnection(), now: () => new Date(READ_AT) });
    press(s, ...typed('/chart market map'), enter);
    await s.idle();
    expect(shown(s)).toContain(' Market map  7 day change | read Oct 13, 14:02 UTC');
    expect(shown(s)).toContain('SPY  +1.2%   QQQ  +2.0%   IWM  -0.4%');
    expect(shown(s)).toMatch(/PR +9 metrics \| equal tiles, not sized by value \| from Acme and Sample\n/);
    expect(shown(s)).not.toContain('generated');
    // The notices PreReason serves with the metrics, under the board, each once, both ways.
    for (const ascii of [true, false]) {
      expect(shown(s, ascii).match(/Powered by Acme\./g)).toHaveLength(1);
      expect(shown(s, ascii).match(/Source: Sample Energy Office\./g)).toHaveLength(1);
    }
    fits(s);
    press(s, { name: 'escape' }, ...typed('/chart positioning'), enter);
    await s.idle();
    // The read time in the heading, as on the map; too wide for one line here, it goes under the title whole.
    expect(shown(s)).toContain(' Positioning  SPY and the speculative net position in S&P 500 futures\n read Oct 13, 14:02 UTC\n');
    expect(shown(s, false)).toContain(' Positioning  SPY and the speculative net position in S&P 500 futures\n read Oct 13, 14:02 UTC\n');
    expect(shown(s)).toMatch(/PR +etf-spy, cot-spx-noncomm-net \| futures positions, not fund exposure\n/);
    expect(shown(s)).not.toContain('generated');
    fits(s);
    // In a window wide enough for a time beside the credit, it still names none.
    s.resize(120, 40);
    expect(shown(s)).toMatch(/PR +etf-spy, cot-spx-noncomm-net \| futures positions, not fund exposure\n/);
    expect(shown(s)).not.toContain('generated');
    for (const ascii of [true, false]) {
      expect(shown(s, ascii).match(/Source: Sample Positions Office Commitments of Traders\./g)).toHaveLength(1);
      expect(shown(s, ascii).match(/PreReason's calculation from the Sample Positions/g)).toHaveLength(1);
    }
    press(s, { name: 'escape' }, ...typed('/chart market map'), enter);
    await s.idle();
    expect(shown(s)).toMatch(/PR +9 metrics \| equal tiles, not sized by value \| from Acme and Sample\n/);
    expect(shown(s)).not.toContain('generated');
  });

  // The market metrics on a fake fetch whose answers can be held back, as a slow network
  // holds them: each call is counted as it goes out.
  function heldMarkets() {
    const asked: string[] = [];
    const waiting: Array<() => void> = [];
    const gate = { hold: (_id: string): boolean => false };
    const fake = marketFetch({}, asked);
    const held = (async (url: string, init?: RequestInit) => {
      const res = await fake(url, init);
      if (gate.hold(new URL(url).pathname.split('/').pop() ?? '')) await new Promise<void>((go) => waiting.push(go));
      return res;
    }) as typeof fetch;
    const release = () => waiting.splice(0).forEach((go) => go());
    return { asked, waiting, gate, release, briefings: () => new PreReasonClient({ key: null, version: '0.0.0', fetch: held }) };
  }

  it('stops reading a board closed with Esc, and draws the one asked for since, not the closed one', async () => {
    const m = heldMarkets();
    const { s } = atHome({ briefings: m.briefings, now: () => new Date(READ_AT) });
    // /chart market map, its first read still out, then Esc, then /chart positioning.
    m.gate.hold = (id) => id === 'etf-spy';
    press(s, ...typed('/chart market map'), enter);
    await vi.waitFor(() => expect(m.waiting).toHaveLength(1));
    expect(m.asked).toEqual(['etf-spy']);
    press(s, { name: 'escape' });
    m.gate.hold = () => false;
    press(s, ...typed('/chart positioning'), enter);
    m.release();
    await s.idle();
    // The map's read in flight came back, and no other went out for it: the rest are
    // positioning's own five.
    expect(m.asked).toEqual(['etf-spy', 'etf-spy', 'cot-spx-noncomm-net', 'cot-spx-noncomm-net-percentile-26w', 'cot-spx-noncomm-net-percentile-52w', 'cot-spx-noncomm-net-percentile-156w']);
    expect(s.state.step).toMatchObject({ name: 'board', request: { kind: 'positioning' }, error: null, view: { plain: { title: 'Positioning' } } });
    expect(shown(s)).toContain(' Positioning  SPY and the speculative net position in S&P 500 futures');
  });

  it('drops a board closed after its last read went out, so it never lands under the board asked for since', async () => {
    const m = heldMarkets();
    const { s } = atHome({ briefings: m.briefings, now: () => new Date(READ_AT) });
    // The map's last read is out when it is closed, and positioning is drawn before it answers.
    m.gate.hold = (id) => id === 'oil-wti';
    press(s, ...typed('/chart market map'), enter);
    await vi.waitFor(() => expect(m.waiting).toHaveLength(1));
    press(s, { name: 'escape' });
    m.gate.hold = () => false;
    press(s, ...typed('/chart positioning'), enter);
    await vi.waitFor(() => expect(s.state.step).toMatchObject({ name: 'board', view: { plain: { title: 'Positioning' } } }));
    m.release();
    await s.idle();
    expect(s.state.step).toMatchObject({ name: 'board', request: { kind: 'positioning' }, error: null, view: { plain: { title: 'Positioning' } } });
    expect(shown(s)).toContain(' Positioning  SPY and the speculative net position in S&P 500 futures');
    expect(shown(s)).not.toContain('Market map');
    // A window resized draws positioning again, not the map.
    s.resize(100, 40);
    expect(shown(s)).toContain(' Positioning  SPY');
    expect(shown(s)).not.toContain('Market map');
  });
});

describe('the benchmark in the session', () => {
  const bench = JSON.parse(readFileSync(join(ROOT, 'operations', 'bench-comprehension', 'questions-2026-09-25.json'), 'utf8')) as BenchFile;
  const inputs = () => ({ ...(({ bench: file, benchData: data }) => ({ file, data }))(fitnessInputs(ROOT, ASK)), fixtures: '2026-09-25' });
  // Answers from the key on markdown, and with nothing on the other arms.
  const reader: ModelAdapter = {
    id: 'reader',
    label: 'qwen2.5:7b, local, 32k',
    capabilities: async () => ({ local: true, schemaConstraint: true, contextTokens: 32768, canRaiseContext: false, format: 'markdown' }),
    complete: async (packet: Packet) => {
      const [briefing, arm] = packet.runId.split('__');
      const b = bench.briefings.find((x) => x.briefing === briefing)!;
      return { text: arm === 'markdown' ? JSON.stringify({ answers: Object.fromEntries(b.questions.map((q) => [q.id, q.key.answer])) }) : '{"answers":{}}' };
    },
  };

  it('runs every packet on the model in use, shows the arms, keeps the run, and saves a card on /bench card', async () => {
    const cards = mkdtempSync(join(tmpdir(), 'primerkit-cards-'));
    const { s, deps } = atHome({ model: () => reader, benchInputs: inputs, cardDir: cards });
    press(s, ...typed('/bench'), enter);
    await s.idle();
    expect(s.state.feed.at(-1)).toMatchObject({ kind: 'bench', result: { answers: 45, best: 'markdown' } });
    const out = shown(s);
    expect(out).toContain('Benchmark  qwen2.5:7b on the frozen fixtures of 2026-09-25');
    expect(out).toMatch(/markdown\s+100%\s+[\d,]+\s+#{20} \d\.\d\d/);
    expect(out).toMatch(/none\s+0%\s+[\d,]+\s+no data read/);
    expect(out).toContain('PR  fixtures from PreReason | 5 briefings | 2026-09-25');
    expect(journalRows(deps.journal!.root).some((r) => r.operation === 'bench')).toBe(true);
    press(s, ...typed('/bench card'), enter);
    await s.idle();
    expect(s.state.notice).toMatch(/^Saved on this machine only: .+primerkit-bench-\d{8}-\d{6}\.png$/);
    expect(readdirSync(cards).sort()).toEqual([expect.stringMatching(/\.png$/), expect.stringMatching(/\.svg$/)]);
    // The card renders with the machine's fonts, which is slow on a loaded laptop.
  }, 60_000);

  it('asks before a hosted model runs it, since every packet costs', async () => {
    const hosted: ModelAdapter = { ...reader, capabilities: async () => ({ local: false, schemaConstraint: true, contextTokens: null, canRaiseContext: false, format: 'json' }), label: 'claude-test-2, anthropic' };
    const { s } = atHome({ model: () => hosted, benchInputs: inputs, cardDir: null });
    press(s, ...typed('/bench'), enter);
    await s.idle();
    expect(s.state.notice).toBe('The benchmark sends 45 packets to anthropic on your key, which charges for them. /bench yes runs it.');
    expect(s.state.feed.some((e) => e.kind === 'bench')).toBe(false);
  });
});

describe('working inside an AI app', () => {
  it('offers the app first, shows every change before making it, connects PreReason, and says what to type there', async () => {
    const applied: string[] = [];
    const deps = real({
      resolveKey: () => null,
      installInto: (app) => ({
        lines: ['runs   claude mcp add --scope user primerkit -- node primerkit.js mcp', 'writes C:/Users/x/.claude/skills/primerkit-ask/SKILL.md'],
        apply: async () => {
          applied.push(app);
          return ["added primerkit's server to Claude Code", 'wrote C:/Users/x/.claude/skills/primerkit-ask/SKILL.md'];
        },
      }),
    });
    const s = new Session(deps);
    s.start();
    press(s, enter); // the welcome
    await s.idle();
    expect(s.state.step).toMatchObject({ name: 'model', cursor: 1 });
    expect(shown(s)).toContain('   Inside Claude Code, on your subscription');
    press(s, { name: 'up' });
    expect(shown(s)).toContain('The next screen shows every change before any is made.');
    press(s, enter);
    expect(shown(s)).toContain('Putting primerkit into Claude Code');
    expect(shown(s)).toContain('runs   claude mcp add --scope user primerkit');
    expect(applied).toEqual([]);
    press(s, enter);
    await s.idle();
    expect(applied).toEqual(['Claude Code']);
    expect(shown(s)).toContain('primerkit is in Claude Code');
    press(s, enter);
    expect(s.state.step.name).toBe('connect');
  });

  it('changes nothing in the demo, and goes back on Enter', async () => {
    const s = new Session(demo());
    s.start();
    press(s, enter);
    await s.idle();
    press(s, { name: 'up' }, enter);
    expect(s.state.step).toMatchObject({ name: 'install', phase: 'failed' });
    expect(shown(s)).toContain('The demo changes nothing on this machine.');
    press(s, enter);
    await s.idle();
    expect(s.state.step.name).toBe('model');
  });
});

describe('connections in the session', () => {
  it('lists every connection, on or off, and says where a broker is connected', async () => {
    const { s, deps } = atHome();
    press(s, ...typed('/connect'), enter);
    await s.idle();
    const out = shown(s);
    expect(out).toContain('Connections  a broker starts off, and you turn it on');
    expect(out).toMatch(/\* PreReason\s+free key, briefings and metrics\s+on/);
    expect(out).toMatch(/\. Alpaca\s+paper trading, practice money\s+off/);
    for (const ascii of [true, false]) for (const line of screen(s.state, ascii)) expect(widthOf(line)).toBeLessThanOrEqual(WIDTH);
    writeConfig(deps.home, { ...readConfig(deps.home), brokers: { alpaca: { mode: 'dry_run' } } });
    press(s, ...typed('/connect'), enter);
    await s.idle();
    expect(shown(s)).toMatch(/\* Alpaca\s+paper trading, practice money\s+dry run/);
    press(s, ...typed('/connect alpaca'), enter);
    expect(s.state.notice).toBe('In a terminal, run primerkit connect alpaca: it asks for the paper keys once and keeps them in the keychain.');
  });

  it('draws a mode that is not one of the four as off, as the broker reads it, and does not stop on one that is not text', async () => {
    const { s, deps } = atHome();
    for (const mode of ['live', true, 1]) {
      writeConfig(deps.home, { ...readConfig(deps.home), brokers: { alpaca: { mode } } } as unknown as ReturnType<typeof readConfig>);
      press(s, ...typed('/connect'), enter);
      await s.idle();
      expect(shown(s)).toMatch(/\. Alpaca\s+its mode in config\.yaml is not usable\s+off/);
      for (const ascii of [true, false]) for (const line of screen(s.state, ascii)) expect(widthOf(line)).toBeLessThanOrEqual(WIDTH);
    }
  });

  it("draws Robinhood off until primerkit connect robinhood adds its server, then live with the app it is in", async () => {
    const { s, deps } = atHome();
    press(s, ...typed('/connect'), enter);
    await s.idle();
    // Off, its words and its status fit one row.
    expect(shown(s)).toMatch(/\. Robinhood\s+live agent account, real money\s+off/);
    expect(shown(s)).toMatch(/Robinhood crypto.*not yet/);
    writeConfig(deps.home, { ...readConfig(deps.home), brokers: { robinhood: { hosts: ['claude-code'], added: ['claude-code'] } } });
    press(s, ...typed('/connect'), enter);
    await s.idle();
    expect(shown(s)).toMatch(/\* Robinhood\s+added to Claude Code, approvals not confirmed/);
    // On, the status is wider than its column, so the words go under the name.
    expect(shown(s)).toContain('live agent account, real money');
    for (const ascii of [true, false]) for (const line of screen(s.state, ascii)) expect(widthOf(line)).toBeLessThanOrEqual(WIDTH);
    writeConfig(deps.home, { ...readConfig(deps.home), brokers: { robinhood: { hosts: ['claude-code', 'codex'], added: ['claude-code'], approvals_confirmed_at: '2026-10-16T09:30:00.000Z' } } });
    press(s, ...typed('/connect'), enter);
    await s.idle();
    expect(shown(s)).toMatch(/\* Robinhood\s+added to Claude Code, Codex/);
    expect(shown(s)).not.toContain('approvals not confirmed');
    press(s, ...typed('/connect robinhood'), enter);
    expect(s.state.notice).toBe('In a terminal, run primerkit connect robinhood --host claude-code or --host codex: it shows what it adds and asks your yes there.');
  });
});

describe('routines in the session', () => {
  const ROUTINE = loadOperation(ROUTINE_DIR);
  // 31 daily closes, $100,000 on Aug 26 rising $1,000 a day to $130,000 on Sep 25.
  const CLOSES = Array.from({ length: 31 }, (_, i) => ({ date: new Date(Date.parse('2026-08-26T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10), price: 100_000 + 1_000 * i }));
  const RULES = '# My rules\n\n1. Enter when the change over 7 days is above +2.0% and nothing is held.\n2. Otherwise watch.\n';
  const TESTS = 'runs: 2\ntests:\n  - on: 2026-09-25\n    holding: flat\n    expect: enter\n    cites: [price, rules]\n';

  // Saved briefings, read as of any date, and the closes above.
  class Dated extends FixtureConnector {
    readonly asked: string[] = [];
    override async fetch(req: { briefing: string; format: 'json' | 'markdown'; date?: string }) {
      this.asked.push(`${req.briefing} ${req.date ?? 'now'}`);
      return super.fetch(req);
    }
    async bitcoinHistory(range: { from: string; to: string }) {
      this.asked.push(`price ${range.from} ${range.to}`);
      return CLOSES.filter((c) => c.date >= range.from && c.date <= range.to);
    }
  }

  // A model that gives enter, citing the week's change and the enter rule as its packet has them.
  class Enter implements ModelAdapter {
    readonly id = 'scripted';
    calls = 0;
    constructor(
      readonly label: string,
      private readonly local = true,
    ) {}
    async capabilities() {
      return { local: this.local, schemaConstraint: false, contextTokens: null, canRaiseContext: false, format: 'markdown' as const };
    }
    async complete(packet: Packet) {
      this.calls++;
      const find = (block: string, has: string) => {
        const m = packet.text
          .split('\n')
          .map((l) => /^\[([a-z.]+) L(\d+)\] (.*)$/.exec(l))
          .find((x) => x?.[1] === block && x[3]?.includes(has));
        if (!m) throw new Error(`no ${block} line with ${has}`);
        return { line: Number(m[2]), text: m[3] as string };
      };
      const week = find('price', 'change over 7 days');
      const rule = find('rules', 'Enter');
      const quote = week.text.split(',')[0] as string;
      const claims = [
        { text: `Bitcoin's ${quote}.`, citations: [{ block: 'price', line: week.line, quote }] },
        { text: 'The enter rule applies.', citations: [{ block: 'rules', line: rule.line, quote: rule.text }] },
      ];
      return { text: JSON.stringify({ label: 'enter', reason: 'The enter rule gave enter.', claims, not_in_data: [] }) };
    }
  }

  function routineSession(over: Partial<SessionDeps> = {}, model = new Enter('qwen2.5:7b, local, 8k')) {
    const data = new Dated(BENCH_BRIEFINGS);
    const { s, deps } = atHome({ routineOperation: ROUTINE, briefings: () => data, model: () => model, ...over });
    // Tall and wide, so a whole page is on screen; the last test fits each page to every window.
    s.resize(161, 60);
    const write = (file: string, body: string) => writeFileSync(join(deps.home, 'routines', 'btc-rules', file), body);
    return { s, deps, data, model, write };
  }
  // What the screen says, its frame taken off and its lines joined, so wrapping does not matter.
  const said = (s: Session): string =>
    shown(s)
      .split('\n')
      .map((l) => l.replace(/^ [|+](?= |$)/, '').trim())
      .join(' ')
      .replace(/\s+/g, ' ');
  // A command run as typed, with the menu closed first where it is open.
  const run = async (s: Session, command: string) => {
    press(s, ...typed(command));
    if (s.state.menu) press(s, { name: 'escape' });
    press(s, enter);
    await s.idle();
  };

  it('makes a routine, lists it, and shows what it reads and does, with no size anywhere', async () => {
    const { s, deps } = routineSession();
    await run(s, '/routine');
    expect(said(s)).toContain('No routines yet. /routine new <name> makes one');
    await run(s, '/routine new btc-rules');
    const made = said(s);
    expect(made).toContain('Made in');
    expect(made).toContain('btc-rules your routine | every day | BTC/USD, long or flat');
    expect(made).toMatch(/PR btc\.context +briefing, as it stood at the run/);
    // Made on a free key: the days that key reads, not the 200 it cannot.
    expect(made).toMatch(/PR bitcoin-price +28 days of daily prices/);
    expect(made).toMatch(/> +the position +flat or long/);
    expect(made).toContain('rules.md holds no rules yet, so the routine returns no_rules_defined');
    expect(made).toContain('enter has no target yet');
    expect(made).not.toMatch(/\d+(\.\d+)? of the account|0\.5|\$\d/);
    for (const file of ['routine.yaml', 'rules.md', 'tests.yaml']) expect(existsSync(join(deps.home, 'routines', 'btc-rules', file))).toBe(true);
    await run(s, '/routine');
    expect(said(s)).toContain('Your routines: btc-rules. /routine <name> shows one.');
    await run(s, '/routine new btc-rules');
    expect(said(s)).toContain('is already in');
  }, 60_000);

  it('shows the rules file, and tests nothing while it holds no rules', async () => {
    const { s, model, data } = routineSession();
    await run(s, '/routine new btc-rules');
    await run(s, '/routine btc-rules rules');
    expect(said(s)).toContain('rules.md, outside primerkit, in your own editor');
    expect(said(s)).toContain('your file no rules written yet');
    expect(said(s)).toContain('With no rules written, the routine returns no_rules_defined and stops.');
    await run(s, '/routine btc-rules test');
    expect(said(s)).toContain('holds no rules yet, so btc-rules returns no_rules_defined and there is nothing to test.');
    expect(model.calls).toBe(0);
    expect(data.asked).toEqual([]);
  }, 60_000);

  it('runs the logic tests in the feed on frozen days, and shows the count', async () => {
    const { s, write, model, data } = routineSession();
    await run(s, '/routine new btc-rules');
    write('rules.md', RULES);
    write('tests.yaml', TESTS);
    data.asked.splice(0);
    await run(s, '/routine btc-rules test');
    const out = said(s);
    expect(out).toContain('Logic tests btc-rules on qwen2.5:7b, local, 8k');
    expect(shown(s)).toContain('2026-09-25  flat, expects enter: 2 of 2');
    expect(out).toContain('ok 1 rule test on frozen data, 2 runs each: 2 of 2 passed');
    expect(model.calls).toBe(2);
    // The routine as made on a free key reads 28 days of prices back from the day.
    expect(data.asked).toEqual(['macro.snapshot 2026-09-25', 'btc.context 2026-09-25', 'price 2026-08-28 2026-09-26']);
    // The day is frozen: a second run reads nothing from PreReason.
    await run(s, '/routine btc-rules test');
    expect(data.asked).toHaveLength(3);
    await run(s, '/routine btc-rules rules');
    expect(said(s)).toContain('your file 3 lines, 3 labels: watch, enter, exit');
    expect(said(s)).toContain('tests 1 rule test on frozen data, 2 runs each: 2 of 2 passed');
  }, 60_000);

  it('asks before a hosted model runs the tests, and runs them on yes', async () => {
    const hosted = new Enter('claude-test-2, Anthropic', false);
    const { s, write } = routineSession({}, hosted);
    await run(s, '/routine new btc-rules');
    write('rules.md', RULES);
    write('tests.yaml', TESTS);
    await run(s, '/routine btc-rules test');
    expect(s.state.notice).toBe('The tests send 2 packets to Anthropic on your key, which charges for them. /routine btc-rules test yes runs them.');
    expect(hosted.calls).toBe(0);
    await run(s, '/routine btc-rules test yes');
    expect(hosted.calls).toBe(2);
  }, 60_000);

  it("names each problem in routine.yaml, and says a routine is not there", async () => {
    const { s, write } = routineSession();
    await run(s, '/routine new btc-rules');
    write('routine.yaml', 'rules: rules.md\nevery: hourly\nlabels:\n  watch: { hold: true }\n');
    await run(s, '/routine btc-rules');
    expect(said(s)).toContain('routine.yaml needs a fix.');
    expect(said(s)).toContain('every is day or week, not "hourly"');
    await run(s, '/routine nope');
    expect(s.state.notice).toBe('There is no routine named nope. /routine new nope makes one.');
  }, 60_000);

  it("lists each routine's commands in the menu, each one running as chosen", async () => {
    const { s } = routineSession();
    await run(s, '/routine new btc-rules');
    press(s, ...typed('/rout'));
    expect(s.state.menu?.rows.map((r) => r.text)).toEqual(['/routine']);
    press(s, enter);
    expect(s.state.input).toBe('/routine ');
    expect(s.state.menu?.rows.map((r) => r.text)).toEqual([
      '/routine btc-rules',
      '/routine btc-rules rules',
      '/routine btc-rules test',
      '/routine btc-rules replay',
      '/routine btc-rules track',
      '/routine btc-rules track run',
      '/routine btc-rules hypothesis',
      '/routine btc-rules research',
      '/routine registry',
      '/routine new',
    ]);
    press(s, down, enter);
    await s.idle();
    expect(said(s)).toContain('rules.md, outside primerkit, in your own editor');
  }, 60_000);

  it("asks PreReason's history one day past the last, whose last day is its midnight price, and keeps the day itself", async () => {
    const asked: Array<{ from: string; to: string }> = [];
    const source = routineSource({
      id: 'prereason',
      fetch: async () => {
        throw new Error('no briefing here');
      },
      bitcoinHistory: async (range) => {
        asked.push(range);
        return [
          { date: '2026-09-20', price: 81131.49 },
          { date: '2026-09-21', price: 81136.2 },
        ];
      },
    });
    expect(await source.closes('2026-08-21', '2026-09-20')).toEqual([{ date: '2026-09-20', price: 81131.49 }]);
    expect(asked).toEqual([{ from: '2026-08-21', to: '2026-09-21' }]);
  });

  it('keeps no routines in the demo', async () => {
    // The demo's shape: no home folder and no routine operation.
    const deps = real({ routineOperation: ROUTINE });
    writeConfig(deps.home, { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model: { kind: 'ollama', base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' }, prereason: { tier: 'free' } });
    const s = new Session({ ...deps, home: null, routineOperation: undefined });
    s.start();
    await s.idle();
    await run(s, '/routine new btc-rules');
    expect(s.state.notice).toBe('The demo keeps no routines. In your own session, /routine new <name> makes one.');
  }, 60_000);

  it('replays a finished backtest as a board, and moves through its ticks with the arrows', async () => {
    const { s, deps, data, write } = routineSession();
    await run(s, '/routine new btc-rules');
    write('routine.yaml', 'rules: rules.md\nevery: day\ndata:\n  briefings: [btc.pulse]\n  price_days: 7\n  format: markdown\nlabels:\n  watch: { hold: true }\n  enter: { target: 0.5 }\nfees: { per_trade: 0.001 }\n');
    write('rules.md', RULES);
    await run(s, '/routine btc-rules replay');
    expect(said(s)).toContain('btc-rules has no finished backtest yet.');
    // A run of three days, answered by a model that enters and recalls no price.
    class Answers extends Enter {
      override async complete(packet: Packet) {
        return packet.operation.id === 'memory-check' ? { text: '{"price": null}' } : super.complete(packet);
      }
    }
    const routine = loadRoutine(join(deps.home, 'routines', 'btc-rules'));
    const cutoff = { cutoff: '2024-09', source: 'test', basis: 'person' as const };
    const plan = planBacktest(routine, { from: '2026-09-20', to: '2026-09-22' }, { tier: 'enterprise', today: '2026-09-28', format: 'markdown', model: 'qwen2.5:7b', cutoff });
    const finished = await runBacktest({ base: ROUTINE, routine, model: new Answers('qwen2.5:7b, local, 8k'), source: routineSource(data), plan, now: () => new Date('2026-09-28T12:00:00.000Z'), ...(deps.journal ? { journal: deps.journal } : {}) });
    expect(finished.kind).toBe('done');
    const asked = data.asked.length;
    await run(s, '/routine btc-rules replay');
    expect(s.state.step.name).toBe('board');
    const board = said(s);
    expect(board).toContain('btc-rules backtest Sep 20 to Sep 22, 2026 | every day | 3 ticks');
    expect(board).toContain("Out of sample: qwen2.5:7b's training reaches 2024-09, as you gave it, before the window.");
    expect(board).toMatch(/treatment \+\d+\.\d%/);
    expect(board).toMatch(/buy and hold \+\d+\.\d%/);
    expect(board).toContain('return fell trades in market fees');
    expect(board).toContain('The data changed the label on 0 of 3 ticks.');
    expect(board).toContain('left and right move through the ticks');
    expect(board).toContain('d shows a tick step by step');
    // Nothing read from PreReason to draw it: it is the run's own folder.
    expect(data.asked).toHaveLength(asked);
    // The arrows move through the ticks, and stop at either end.
    press(s, { name: 'right' });
    await s.idle();
    expect(said(s)).toContain('Sep 20: treatment enter, to 50.0% at $126,000 on Sep 21; control enter, to 50.0% at $126,000 on Sep 21; placebo enter, to 50.0% at $126,000 on Sep 21.');
    // d opens that tick step by step, each arm from its answer in the journal, and closes it.
    press(s, { name: 'char', char: 'd' });
    await s.idle();
    const steps = said(s);
    expect(steps).toContain('btc-rules Sep 20, 2026 each arm, step by step');
    expect(steps).toContain('Sep 20 treatment enter 1 read btc.pulse as it stood on Sep 20; the price table and the position:');
    expect(steps).toMatch(/2 rules rules\.md, \d+ lines, as it read them \([0-9a-f]{8}\)/);
    expect(steps).toContain('3 model scripted returned enter: The enter rule gave enter. Cited price L');
    expect(steps).toContain('4 checks ok shape ok citations ok data cited ok numbers ok scope');
    expect(steps).toMatch(/5 account to 50\.0% of the account at \$126,000 on Sep 21, a fee of \$\d+\.\d\d/);
    expect(steps).toContain('Sep 20 control enter 1 read no briefings: the price table and the position alone');
    expect(steps).toContain("Sep 20 placebo enter 1 read btc.pulse as it stood on Apr 23, 150 days before, dated as the tick's own");
    expect(steps).toContain('d goes back to the report');
    press(s, { name: 'char', char: 'd' });
    await s.idle();
    expect(said(s)).toContain('The data changed the label on 0 of 3 ticks.');
    expect(said(s)).toContain('d shows a tick step by step');
    // Each move draws the board again; a key pressed while it draws waits for the next.
    for (let i = 0; i < 3; i++) {
      press(s, { name: 'right' });
      await s.idle();
    }
    // Already long, enter rebalances to its share at the next close.
    expect(said(s)).toContain('Sep 22: treatment enter, to 50.0% at $128,000 on Sep 23;');
    press(s, { name: 'escape' });
    expect(s.state.step.name).toBe('home');
    // Every window, in colour and ASCII, fits the report and a tick step by step.
    await run(s, '/routine btc-rules replay');
    for (const detail of [false, true]) {
      if (detail) {
        s.resize(161, 60);
        press(s, { name: 'char', char: 'd' });
        await s.idle();
      }
      for (const [columns, rows] of [
        [49, 16],
        [60, 20],
        [77, 22],
        [120, 40],
      ] as const) {
        s.resize(columns, rows);
        for (const ascii of [true, false]) {
          const lines = screen(s.state, ascii);
          const what = `${detail ? 'a tick' : 'the report'} at ${columns}x${rows}`;
          expect(lines.length, what).toBeLessThanOrEqual(rows);
          for (const line of lines) expect(widthOf(line), `${what}: ${text([line])}`).toBeLessThanOrEqual(columns - 1);
          if (ascii) expect(/^[\x00-\x7f]*$/.test(text(lines)), what).toBe(true);
        }
      }
    }
    expect(said(s)).toContain('each arm, step by step');
  }, 120_000);

  it('shows the hypothesis card, the ladder of the newest backtest and the registry, each closing on the one line', async () => {
    const { s, deps, data, write } = routineSession();
    // Every window, in colour and ASCII, fits the screen as it stands.
    const fits = (what: string) => {
      for (const [columns, rows] of [
        [49, 16],
        [77, 22],
        [161, 60],
      ] as const) {
        s.resize(columns, rows);
        for (const ascii of [true, false]) {
          const lines = screen(s.state, ascii);
          for (const line of lines) expect(widthOf(line), `${what} at ${columns}x${rows}: ${text([line])}`).toBeLessThanOrEqual(columns - 1);
          if (ascii) expect(/^[\x00-\x7f]*$/.test(text(lines)), `${what} at ${columns}x${rows}`).toBe(true);
        }
      }
    };
    await run(s, '/routine new btc-rules');
    expect(existsSync(join(deps.home, 'routines', 'btc-rules', 'hypothesis.md'))).toBe(true);
    await run(s, '/routine btc-rules hypothesis');
    expect(said(s)).toContain('Hypothesis btc-rules, nothing written yet');
    expect(said(s)).toContain('claim missing: write what you expect to happen');
    expect(said(s)).toContain(RESEARCH_CLOSING);
    await run(s, '/routine btc-rules research');
    expect(said(s)).toContain('btc-rules has no finished backtest yet.');
    write('routine.yaml', 'rules: rules.md\nevery: day\ndata:\n  briefings: [btc.pulse]\n  price_days: 7\n  format: markdown\nlabels:\n  watch: { hold: true }\n  enter: { target: 0.5 }\nfees: { per_trade: 0.001 }\nspread_bps: 8\n');
    write('rules.md', RULES);
    write('hypothesis.md', '## Claim\nThe pulse leads the week.\n\n## Mechanism\nFlows show in it first.\n\n## Expected signature\nA rise in btc.pulse comes before a rise of the week.\n\n## Universe and horizon\nBTC/USD, a week.\n\n## Success criterion\ntreatment ahead of control by at least 0 points\n\n## Kill criterion\n<your criterion, with its number>\n');
    await run(s, '/routine btc-rules hypothesis');
    expect(said(s)).toContain('Hypothesis btc-rules, version 1, not frozen yet: it freezes at its first backtest');
    expect(said(s)).toContain('Form check: claim stated | mechanism stated | signature observable in btc.pulse | universe stated | success numeric | kill missing: write the number that would count as failing');
    fits('the card');
    // A run of three days, every arm entering: no edge over control at any setting.
    class Answers extends Enter {
      override async complete(packet: Packet) {
        return packet.operation.id === 'memory-check' ? { text: '{"price": null}' } : super.complete(packet);
      }
    }
    const routine = loadRoutine(join(deps.home, 'routines', 'btc-rules'));
    const plan = planBacktest(routine, { from: '2026-09-20', to: '2026-09-22' }, { tier: 'enterprise', today: '2026-09-28', format: 'markdown', model: 'qwen2.5:7b', cutoff: { cutoff: '2024-09', source: 'test', basis: 'person' } });
    expect((await runBacktest({ base: ROUTINE, routine, model: new Answers('qwen2.5:7b, local, 8k'), source: routineSource(data), plan, now: () => new Date('2026-09-28T12:00:00.000Z') })).kind).toBe('done');
    s.resize(161, 60);
    await run(s, '/routine btc-rules hypothesis');
    expect(said(s)).toMatch(/Hypothesis btc-rules, version 1, frozen Sep 28, 2026 at the first backtest \(hash [0-9a-f]{8}\)/);
    expect(said(s)).toContain('Changing a frozen card makes version 2; version 1 and its results are kept.');
    await run(s, '/routine btc-rules research');
    const ladder = said(s);
    expect(ladder).toContain('Research btc-rules, version 1, backtest of Sep 20 to Sep 22, 2026');
    expect(ladder).toMatch(/H1 raw edge passed treatment returned -?\d+\.\d% against control -?\d+\.\d% and placebo -?\d+\.\d% over the backtest, on your success criterion \(treatment ahead of control by at least 0 points\)/);
    expect(ladder).toMatch(/H2 realistic costs passed at your spread of 8 bps and fee of 0\.10%, treatment returned -?\d+\.\d% after costs \(control -?\d+\.\d%\)/);
    expect(ladder).toContain('H3 robustness failed the edge stays above control on 0 of 7 nearby settings (sizes, fees, start day); 2 not re-run, as they change the position your labels read');
    expect(ladder).toContain('Failed at H3: the edge stays above control on 0 of 7 nearby settings, fewer than three quarters.');
    expect(ladder).not.toContain('H4');
    expect(ladder).toContain('Failed at H3: the edge stays above control on 0 of 7 nearby settings, fewer than three quarters. This is the frozen test.');
    expect(ladder).toContain('1 hypothesis tested in your registry, in 1 backtest.');
    expect(ladder).toContain('also measured, not shown here:');
    expect(ladder).toContain('/routine btc-rules replay shows them.');
    expect(ladder).toContain(RESEARCH_CLOSING);
    fits('the ladder');
    s.resize(161, 60);
    await run(s, '/routine registry');
    expect(said(s)).toContain('Registry 1 hypothesis');
    expect(said(s)).toContain('btc-rules v1 failed at H3: the edge stays above control on 0 of 7 nearby settings, fewer than three quarters');
    expect(said(s)).toContain("Each version's card and results are kept on this machine.");
    expect(said(s)).toContain(RESEARCH_CLOSING);
    fits('the registry');
  }, 120_000);

  it('keeps a forward record: shown before any run, run once, and drawn again from its folder', async () => {
    // Sep 26 in the morning, when the newest close is Sep 25's.
    const { s, deps, data, write } = routineSession({ now: () => new Date('2026-09-26T07:30:00.000Z') });
    await run(s, '/routine new btc-rules');
    write('routine.yaml', 'rules: rules.md\nevery: day\ndata:\n  briefings: [btc.pulse]\n  price_days: 7\n  format: markdown\nlabels:\n  watch: { hold: true }\n  enter: { target: 0.5 }\nfees: { per_trade: 0.001 }\n');
    write('rules.md', RULES);
    await run(s, '/routine btc-rules track');
    expect(s.state.step.name).toBe('board');
    expect(said(s)).toContain('btc-rules forward record not started');
    expect(said(s)).toContain('No run yet. primerkit routine btc-rules track runs it once now');
    expect(said(s)).toContain('It is not on the schedule: primerkit routine btc-rules track --at 07:30 --yes adds it');
    press(s, { name: 'escape' });
    await run(s, '/routine btc-rules track run');
    expect(s.state.step.name).toBe('board');
    const board = said(s);
    expect(board).toContain('btc-rules forward record since Sep 26, 2026 | 1 run | closes to Sep 25');
    expect(board).toContain('The runs newest first, each written before its outcome existed');
    expect(board).toContain('Sep 26 07:30 enter waits for the close after Sep 25');
    expect(board).toContain('The chart starts once a close has come after the first run.');
    expect(board).not.toContain('Since the first run');
    expect(board).toContain('Labels only: no order goes anywhere.');
    // Read as served on its day, and kept: the record in the routine's folder.
    expect(data.asked).toContain('btc.pulse 2026-09-26');
    const record = readFileSync(join(deps.home, 'routines', 'btc-rules', 'forward', 'record.jsonl'), 'utf8').trim().split('\n');
    expect(record).toHaveLength(1);
    expect(JSON.parse(record[0] as string)).toMatchObject({ day: '2026-09-26', label: 'enter', close: { date: '2026-09-25' }, target: 0.5 });
    // Shown again, nothing is run or read; the feed says what the run wrote.
    press(s, { name: 'escape' });
    expect(said(s)).toContain('btc-rules: enter, written to its forward record before its outcome exists.');
    const asked = data.asked.length;
    await run(s, '/routine btc-rules track');
    expect(said(s)).toContain('btc-rules forward record since Sep 26, 2026 | 1 run');
    expect(data.asked).toHaveLength(asked);
  }, 120_000);

  it('draws each routine screen within every window, in colour and ASCII', async () => {
    const { s, write } = routineSession();
    await run(s, '/routine new btc-rules');
    write('rules.md', RULES);
    write('tests.yaml', TESTS);
    for (const command of ['/routine btc-rules', '/routine btc-rules rules', '/routine btc-rules test']) {
      await run(s, command);
      for (const [columns, rows] of [
        [49, 16],
        [60, 20],
        [77, 22],
        [120, 40],
      ] as const) {
        s.resize(columns, rows);
        for (const ascii of [true, false]) {
          const lines = screen(s.state, ascii);
          expect(lines.length, `${command} at ${columns}x${rows}`).toBeLessThanOrEqual(rows);
          for (const line of lines) expect(widthOf(line), `${command} at ${columns}x${rows}: ${text([line])}`).toBeLessThanOrEqual(columns - 1);
          if (ascii) expect(/^[\x00-\x7f]*$/.test(text(lines)), `${command} at ${columns}x${rows}`).toBe(true);
        }
      }
      s.resize(161, 60);
    }
  }, 120_000);
});

describe('the ask gaps in the session', () => {
  // Saved briefings that can be read for a past day, and two metrics.
  class Dated extends Budgeted {
    readonly readsDates = true;
    readonly dates: Array<string | null> = [];
    override async fetch(req: { briefing: string; format: 'json' | 'markdown'; date?: string }) {
      this.dates.push(req.date ?? null);
      return super.fetch(req);
    }
    async metricBlock(id: string): Promise<DataBlock> {
      return { id, source: 'prereason', format: 'markdown', fetchedAt: '2026-10-03T12:00:00.000Z', lines: [`# ${id}`, '**Latest reading:** 4.12%'] };
    }
  }
  const METRICS = [
    { id: 'treasury-10y', name: '10-Year Treasury Yield', description: 'The 10 year US Treasury yield', category: 'macro' },
    { id: 'fed-funds-rate', name: 'Federal Funds Rate', description: 'The effective federal funds rate', category: 'macro' },
  ];
  const answering = () =>
    new ScriptedModel([
      (p: Packet) => {
        const b = p.blocks[0]!;
        return JSON.stringify({ answer: 'The packet reads as its first line says.', claims: [{ text: 'The first line names what was read.', citations: [{ block: b.id, line: 1, quote: b.lines[0]!.slice(0, 10) }] }], not_in_data: [], ...(p.asOf ? { data_as_of: p.asOf } : {}) });
      },
    ]);

  it('lists every briefing and metric by area on /catalog, and offers it in the menu', async () => {
    const { s } = atHome({ briefings: () => new Dated(BENCH_BRIEFINGS), metricCatalog: async () => METRICS });
    press(s, ...typed('/ca'));
    expect(s.state.menu?.rows.map((r) => r.text)).toEqual(['/catalog', '/catalog all']);
    expect(shown(s)).toMatch(/\/catalog +every briefing and metric you can ask about/);
    press(s, enter);
    await s.idle();
    const screen = shown(s);
    expect(screen).toMatch(/Catalog +\d+ briefings and 2 metrics this key reads/);
    // A table: the area and its count, then its ids in aligned columns of the area's own
    // width, as many as the room holds: Bitcoin's three short ids on one row.
    expect(screen).toMatch(/\| Bitcoin 3 +btc\.[a-z-]+ +btc\.[a-z-]+ +btc\.[a-z-]+\n/);
    expect(screen).toContain('metrics, as they stand now');
    expect(screen).toMatch(/\| macro 2 +treasury-10y +fed-funds-rate\n/);
    expect(screen).not.toContain('/catalog all names every metric');
    // Every id of the briefings' first column starts at the same place.
    const lines = screen.split('\n');
    const at = (id: string) => lines.find((l) => l.includes(id))!.indexOf(id);
    expect(new Set([at('btc.context'), at('macro.snapshot'), at('cross.correlations')]).size).toBe(1);
    // The example names a day as it is typed, in quotes.
    expect(screen).toContain('such as "as of 2026-08-15".');
  });

  it("keeps a key's long ids to a readable table: each area its own columns, long ones along the row", () => {
    // As the enterprise key's catalog once drew in a storyboard run: one width for every area,
    // set by commodities.grains-agribusiness, left one id a row.
    const entry: Entry = {
      kind: 'catalog',
      question: '/catalog',
      metrics: null,
      briefings: [
        { area: 'Bitcoin', ids: ['btc.quick-check', 'btc.context', 'btc.pulse', 'btc.grid-stress', 'btc.momentum', 'btc.on-chain', 'btc.miner-survival'] },
        { area: 'commodities', ids: ['commodities.oil-producers', 'commodities.gold-miners', 'commodities.grains-agribusiness'] },
      ],
    };
    const text = entryLines({ ...initialState(null), size: GRID }, maker(true), entry).map((l) => l.map(([, s]) => s).join('')).join('\n');
    // Bitcoin's short ids stand in columns of their own width.
    expect(text).toMatch(/\| Bitcoin 7 +btc\.quick-check +btc\.context\n/);
    // The commodities' long ids, too long for two columns, run along the row: two on the first.
    expect(text).toMatch(/\| commodities 3 +commodities\.oil-producers {3}commodities\.gold-miners\n/);
    // CONTROL: ten ids take six rows, not ten.
    expect(text.split('\n').filter((l) => /btc\.|commodities\./.test(l))).toHaveLength(6);
  });

  it('names no time on the credit of blocks that carry none, such as a metric read alone', () => {
    // As a storyboard run once drew it: "generated unknown UTC" under a metric's answer.
    const view = { headline: '', sentences: [{ text: 'Net liquidity is flat [1].', refs: [1] }], sources: [{ n: 1, block: 'net-liquidity', line: 3 }], dropped: [], checks: { passed: 4, total: 4 }, tokens: 1_593, seconds: 2.7, briefings: ['net-liquidity'], generated: null as string | null, asOf: null, partial: false };
    const text = (generated: string | null) => entryLines({ ...initialState(null), size: GRID }, maker(true), { kind: 'answer', question: 'Is net liquidity rising?', view: { ...view, generated }, skipped: [], notes: [], added: [] }).map((l) => l.map(([, s]) => s).join('')).join('\n');
    expect(text(null)).toMatch(/PR {2}net-liquidity$/m);
    expect(text(null)).not.toContain('unknown');
    // CONTROL: a time that is there is named.
    expect(text('2026-10-12T12:35:00Z')).toContain('PR  net-liquidity | generated 12:35 UTC');
  });

  it('names the first eight metrics of an area on /catalog, and every one on /catalog all', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `macro-${i + 1}`, name: `Macro ${i + 1}`, description: 'a macro series', category: 'macro' }));
    const { s } = atHome({ briefings: () => new Dated(BENCH_BRIEFINGS), metricCatalog: async () => many });
    press(s, ...typed('/catalog'), enter);
    await s.idle();
    expect(shown(s)).toContain('macro-8');
    expect(shown(s)).not.toContain('macro-9');
    expect(shown(s)).toContain('+4 more');
    expect(shown(s)).toContain('/catalog all names every metric');
    press(s, { name: 'escape' }, { name: 'escape' }, ...typed('/catalog all'), enter);
    await s.idle();
    expect(s.state.feed).toContainEqual(expect.objectContaining({ kind: 'catalog', question: '/catalog all', all: true }));
    expect(shown(s)).toContain('macro-12');
  });

  it('lists the briefings alone where no metric can be read, as in the demo', async () => {
    const { s } = atHome();
    press(s, ...typed('/catalog'), enter);
    await s.idle();
    expect(s.state.feed[0]).toMatchObject({ kind: 'catalog', metrics: null });
    expect(shown(s)).not.toContain('metrics, as they stand now');
  });

  it('names the demo catalog as one saved day, with no metric and no past day in its example', async () => {
    const shots = await walk(demo(), [...FIRST_RUN_WALK, { title: 'catalog', keys: [...typed('/catalog'), enter] }], true);
    const screen = text(shots.at(-1)!.lines);
    expect(screen).toContain('briefings saved on Oct 16, 2026');
    expect(screen).toContain('Name one in a question, such as macro.snapshot.');
    expect(screen).not.toContain('treasury-10y');
    expect(screen).not.toContain('past day');
  });

  it('offers in /chart only the charts the saved briefings can draw, and every chart on a live connection', () => {
    const saved = new FixtureConnector(BENCH_BRIEFINGS);
    const demoRows = menuRows('/chart ', { briefings: null, hosted: false, charts: (c) => chartDraws(c, saved) }).map((r) => r.text);
    // The heatmap draws from any briefing, so it is offered on saved briefings too.
    expect(demoRows).toEqual(['/chart yield curve', '/chart yield curve 90d', '/chart yield curve 1y', '/chart correlations', '/chart heatmap', '/chart heatmap btc.context', '/chart heatmap cross.correlations']);
    const live = { id: 'prereason', fetch: saved.fetch.bind(saved), bitcoinHistory: async () => [], metric: async (name: string) => ({ name, display: name, timestamp: null, context: '', trend: {}, level: null }) };
    expect(menuRows('/chart ', { briefings: null, hosted: false, charts: (c) => chartDraws(c, live) })).toHaveLength(20);
    expect(menuRows('/chart ', { briefings: null, hosted: false, charts: (c) => chartDraws(c, null) })).toHaveLength(20);
    expect(menuRows('/chart ', { briefings: null, hosted: false })).toHaveLength(20);
    // A connection that reads no metric on its own is not offered the two charts of them.
    const noMetrics = { id: 'prereason', fetch: saved.fetch.bind(saved), bitcoinHistory: async () => [] };
    expect(menuRows('/chart ', { briefings: null, hosted: false, charts: (c) => chartDraws(c, noMetrics) })).toHaveLength(17);
  });

  it('names the saved briefings in the demo where a key would be: the top line and /connect', async () => {
    const shots = await walk(demo(), [...FIRST_RUN_WALK, { title: 'connect', keys: [...typed('/connect'), enter] }], true);
    const screen = text(shots.at(-1)!.lines);
    expect(screen).toContain('PreReason saved briefings');
    expect(screen).toMatch(/PreReason\s+briefings saved on Oct 16, 2026, no key\s+on/);
    expect(screen).not.toContain('free key');
  });

  it('says a chart the saved briefings cannot draw in words a person reads, with what reads it', async () => {
    const shots = await walk(demo(), [...FIRST_RUN_WALK, { title: 'liquidity', keys: [...typed('/chart liquidity'), enter] }], true);
    const screen = text(shots.at(-1)!.lines);
    expect(screen.replace(/\s+/g, ' ')).toContain('macro.liquidity is not among the saved briefings. Connected to PreReason, primerkit reads it live.');
    expect(screen).not.toContain('fixture');
  });

  it("names the day an answer was read for in its PR line, in place of the time it was generated", async () => {
    const data = new Dated(BENCH_BRIEFINGS);
    const { s } = atHome({ briefings: () => data, metricCatalog: async () => METRICS, model: () => answering(), now: () => new Date('2026-10-03T12:00:00.000Z') });
    press(s, ...typed('macro.snapshot as of 2026-08-15: how was liquidity?'), enter);
    await s.idle();
    expect(data.dates.at(-1)).toBe('2026-08-15');
    expect(shown(s)).toMatch(/PR +macro\.snapshot \| as it stood on Aug 15, 2026/);
    expect(shown(s)).not.toMatch(/macro\.snapshot \| generated/);
    // Its sixth check, as_of, named in words on its checks line, not by its id.
    expect(shown(s)).toContain('ok 6 of 6 checks: answer format');
    expect(shown(s)).toContain('dated the day');
    expect(shown(s)).not.toContain('as_of');
  });
});


describe('finding things in the journal, and positions you can read (sample data)', () => {
  it('finds runs by the words after /journal, heads each day with its sums, and opens a run to everything it kept', async () => {
    const { s, deps } = atHome();
    const root = deps.journal!.root;
    sampleJournal(root);
    deps.journalRows = (query) => journalRows(root, 200, new Date('2026-10-16T12:00:00Z'), query);
    press(s, ...typed('/journal failed'), enter);
    await s.idle();
    let step = s.state.step;
    if (step.name !== 'journal') throw new Error('not the journal');
    expect(step.filter).toBe('failed');
    expect(step.rows.map((r) => r.operation)).toEqual(['day', 'ask']);
    expect(step.rows[0]!.title).toBe('1 run, 0 passed, no tokens reported');
    // The cursor starts on the run, below its day's row.
    expect(step.cursor).toBe(1);
    expect(shown(s)).toContain('runs matching failed, newest at the top');
    expect(shown(s)).toContain('Is the dollar strengthening?');
    expect(shown(s)).not.toContain('Treasury');
    press(s, { name: 'escape' }, ...typed('/journal treasury'), enter);
    await s.idle();
    step = s.state.step;
    if (step.name !== 'journal') throw new Error('not the journal');
    expect(step.rows.map((r) => r.title)).toEqual(['1 run, 1 passed, 1,390 tokens, $0.0002', 'Where do Treasury yields stand?']);
    press(s, enter);
    step = s.state.step;
    if (step.name !== 'journal' || !step.open) throw new Error('not open');
    expect(step.open.lines).toEqual(expect.arrayContaining(['Question: Where do Treasury yields stand?', 'Answer: The 10-year yield is 4.02%.', '  [macro.snapshot L3] {"metric":"treasury-10y","value_formatted":"4.02%"}', '  ok citations', 'The run, as the journal keeps it:']));
    for (const ascii of [true, false]) for (const line of screen(s.state, ascii)) expect(widthOf(line)).toBeLessThanOrEqual(WIDTH);
    // A routine's tick reads as the label that fired, beside the reading it cites.
    // The day's row opens to the day's sums.
    press(s, { name: 'escape' }, { name: 'up' }, enter);
    step = s.state.step;
    if (step.name !== 'journal' || !step.open) throw new Error('not open');
    expect(step.open.lines[0]).toBe('2026-10-16: 2 runs, 1 passed, 1 failed.');
    press(s, { name: 'escape' }, { name: 'escape' }, ...typed('/journal routine'), enter);
    await s.idle();
    step = s.state.step;
    if (step.name !== 'journal') throw new Error('not the journal');
    expect(step.rows[1]!.title).toBe('enter · [btc.context L2] {"metric":"hash-ribbon","value_formatted":"1.016"}');
    press(s, { name: 'escape' }, ...typed('/journal nothing-like-it 2026-01-01'), enter);
    await s.idle();
    expect(shown(s)).toContain('Nothing in the journal matches 2026-01-01 nothing-like-it.');
  });

  it('shows the paper holdings and every order intent on /positions, each change green or red, and sends nothing', async () => {
    const { s, deps } = atHome({
      holdings: async () => ({ kind: 'held', mode: 'read', readAt: '2026-10-16T09:00:00.000Z', rows: [{ symbol: 'AAPL', qty: 2, avgEntryPrice: 180.5, marketValue: 372.4, changeToday: 0.0123 }, { symbol: 'BTCUSD', qty: 0.001, marketValue: 84.46, changeToday: -0.021 }] }),
    });
    const journal = new Journal(deps.journal!.root);
    recordLiveIntent(journal, { symbol: 'MSFT', side: 'buy', quantity: 1, source: 'typed' }, new Date());
    press(s, ...typed('/positions'), enter);
    await s.idle();
    const out = shown(s);
    expect(out).toContain('Positions  paper holdings and every order intent');
    expect(out).toMatch(/AAPL +2 +\$180\.50 +\$372\.40 +\+1\.23%/);
    expect(out).toContain('-2.10%');
    expect(out).toMatch(/MSFT +buy +1 +Robinhood live +pending/);
    expect(out).toContain('Nothing here sends an order.');
    const segments = screen(s.state, false).flat();
    expect(segments.some((g) => g[0] === 'up' && g[1] === '+1.23%')).toBe(true);
    expect(segments.some((g) => g[0] === 'down' && g[1] === '-2.10%')).toBe(true);
    for (const ascii of [true, false]) for (const line of screen(s.state, ascii)) expect(widthOf(line)).toBeLessThanOrEqual(WIDTH);
    // With no way to read the account here, it says so in one line, and the intents still show.
    const bare = atHome();
    press(bare.s, ...typed('/positions'), enter);
    await bare.s.idle();
    expect(shown(bare.s)).toContain('not read here. In a terminal, primerkit positions reads it.');
    expect(shown(bare.s)).toContain('none yet');
  });
});
