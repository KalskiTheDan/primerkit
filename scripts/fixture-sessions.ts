// The sessions the gallery's new screens are drawn from: the real Session, on the fakes and
// fixtures the tests use (the compare, news, markets, research and digest tests), so each screen is the
// session's own and none is typed by hand. A stand-in answers where a model would, Anthropic's
// side is a response written by hand for the tests, and PreReason's answers are the tests'
// files: no key, no model, and nothing is sent anywhere.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BacktestRun,
  Journal,
  Snapshots,
  addDays,
  blockFromJson,
  hypothesesDir,
  loadOperation,
  loadRoutine,
  planBacktest,
  readConfig,
  writeConfig,
  type Close,
  type ConfigModel,
  type DataBlock,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelReply,
  type Packet,
  type Routine,
} from '@primerkit/core';
import { FixtureConnector, PreReasonError, parseCatalog, parseNews, type ContextRequest, type NewsAnswer } from '@primerkit/connector-prereason';
import { AnthropicWebSearch, ExtractiveModel, ScriptedModel } from '@primerkit/models';
import { ASK_DIR, BENCH_BRIEFINGS, DEMO_CATALOG, DIGEST_DIR, ROOT, ROUTINE_DIR, digestEntry, journalOpen, journalRows, type Briefings, type SessionDeps } from '@primerkit/session';
import { READ_AT, answers, marketConnection } from '../packages/session/test/market-fixture';

const LOCAL: ConfigModel = { kind: 'ollama', base_url: 'http://127.0.0.1:11434', name: 'qwen2.5:7b' };
const HOSTED: ConfigModel = { kind: 'hosted', provider: 'anthropic', name: 'claude-sonnet-5-5' };

// A session at home, its first run done, on the free tier, as the tests set one up.
function fixtureDeps(home: string, o: { model: ModelAdapter; config: ConfigModel; data: Briefings; now: Date; keys?: string[]; webSearch?: SessionDeps['webSearch'] }): SessionDeps {
  const journal = new Journal(join(home, 'journal'));
  writeConfig(home, { disclaimer_accepted_at: 'x', first_run_done_at: 'x', model: o.config, prereason: { tier: 'free' } });
  return {
    demo: null,
    env: {},
    platform: 'win32',
    config: { read: () => readConfig(home), write: (c) => writeConfig(home, c) },
    checkMachine: async () => ({ apps: [], keys: o.keys ?? [], local: [], ollama: o.config.kind === 'ollama' ? 'running' : 'absent' }),
    catalog: async () => parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8'))),
    resolveKey: () => ({ key: 'not-a-key', source: 'env' }),
    connect: () => ({ cancel: () => {} }),
    briefings: () => o.data,
    model: () => o.model,
    listModels: async () => [],
    pull: async () => {},
    fitness: async () => {
      throw new Error('no check in the gallery');
    },
    fitnessPlan: () => ({ calls: 0, tokens: 0 }),
    operation: loadOperation(ASK_DIR),
    digestOperation: loadOperation(DIGEST_DIR),
    routineOperation: loadOperation(ROUTINE_DIR),
    journal,
    snapshots: new Snapshots(join(home, 'snapshots')),
    home,
    latestDigest: () => null,
    scheduler: null,
    scheduleEntry: (time) => digestEntry({ time, platform: 'win32', node: 'C:\\node\\node.exe', script: 'C:\\pk\\bin\\primerkit.js', cwd: 'C:\\pk' }),
    journalRows: () => journalRows(journal.root),
    journalOpen,
    openLink: () => false,
    copy: () => false,
    ...(o.webSearch ? { webSearch: o.webSearch } : {}),
    now: () => o.now,
  };
}

// ------------------------------------------------------------------ /compare

export const COMPARE_QUESTION = 'Is net liquidity rising or falling?';
// Made up for the tests and written by hand, in the shape of a Messages API response.
const WEB_SEARCH = join(ROOT, 'packages', 'models', 'test', 'fixtures', 'web-search-net-liquidity.json');

// The compare tests' stand-in for a hosted Claude model: the demo's answerer, which lifts lines
// from the briefings, reporting what each call used. Its name on the top line says what it is.
class HostedStandIn extends ExtractiveModel {
  override readonly id = 'anthropic:claude-sonnet-5-5';
  override readonly label = 'stand-in for claude-sonnet-5-5';
  constructor() {
    super('markdown');
  }
  override async capabilities(): Promise<ModelCapabilities> {
    return { ...(await super.capabilities()), local: false };
  }
  override async complete(packet: Packet): Promise<ModelReply> {
    return { ...(await super.complete(packet)), usage: { inputTokens: 900, outputTokens: 49 } };
  }
}

// /compare on the stand-in, the demo's saved briefings, and Anthropic's side answered by the
// tests' web search response, as the compare tests run it.
export function compareSession(home: string): SessionDeps {
  const answer = readFileSync(WEB_SEARCH, 'utf8');
  const anthropic = (async () => new Response(answer, { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  return fixtureDeps(home, {
    model: new HostedStandIn(),
    config: HOSTED,
    data: new FixtureConnector(BENCH_BRIEFINGS),
    now: new Date('2026-10-13T00:30:00Z'),
    keys: ['ANTHROPIC_API_KEY'],
    webSearch: (spec) => (spec.kind === 'hosted' && spec.provider === 'anthropic' ? new AnthropicWebSearch({ apiKey: 'not-a-key', model: spec.name, fetch: anthropic }) : null),
  });
}

// ------------------------------------------------------------------ the news door

export const NEWS_QUESTION = 'equities.company/fxmp: what did it file between September 28 and October 9?';
const NEWS = join(ROOT, 'packages', 'connectors', 'prereason', 'test', 'fixtures', 'news');
export type NewsCase = 'filed' | 'empty' | 'not-read';

// The news tests' answers: the company's filings, a window with none, and that window with a
// source PreReason did not read.
function served(which: NewsCase): NewsAnswer {
  const body = JSON.parse(readFileSync(join(NEWS, which === 'filed' ? 'filed-fxmp-2026-10-09.json' : 'filed-fxmp-empty-2026-10-09.json'), 'utf8')) as Record<string, unknown>;
  if (which === 'not-read') body.not_read = ['Sample Overseas Registry (fictional companies, for tests)'];
  return parseNews(JSON.stringify(body))!;
}

// The saved briefings, with PreReason's news door serving one of the tests' answers.
class Newsroom extends FixtureConnector {
  readonly readsDates = true;
  constructor(private readonly answer: NewsAnswer) {
    super(BENCH_BRIEFINGS);
  }
  async news(): Promise<NewsAnswer> {
    return this.answer;
  }
}

// The news tests' scripted answer: it cites the record that holds item 2.02, in its line's words.
const ITEM_202 = JSON.stringify({
  answer: 'Fictional Group Corp reported item 2.02, results of operations, in an 8-K filed on Oct 1, 2026.',
  claims: [{ text: 'Fictional Group Corp filed an 8-K on Oct 1, 2026 reporting item 2.02, results of operations.', citations: [{ block: 'news', line: 3, quote: '8-K item 2.02, results of operations' }] }],
  not_in_data: [],
});

export function newsSession(home: string, which: NewsCase): SessionDeps {
  return fixtureDeps(home, { model: new ScriptedModel([ITEM_202], { local: true, format: 'markdown' }), config: LOCAL, data: new Newsroom(served(which)), now: new Date('2026-10-12T14:02:00.000Z') });
}

// ------------------------------------------------------------------ the market map and positioning

// The markets tests' made-up metric answers, read by the real client on a fake fetch, with the
// readings the positioning test keeps, so its two lines are drawn. The gallery is public, so
// its answers carry no notice: a notice is a publisher's term, and a made-up one in a picture
// would present a source that does not exist. The tests' answers keep theirs.
export const GALLERY_ANSWERS: Record<string, Record<string, unknown>> = Object.fromEntries(Object.keys(answers()).map((id) => [id, { notices: undefined }]));

export function marketSession(home: string): SessionDeps {
  const deps = fixtureDeps(home, { model: new ScriptedModel([]), config: LOCAL, data: marketConnection(GALLERY_ANSWERS), now: new Date(READ_AT) });
  const kept = (id: string, at: string, context: string) =>
    deps.snapshots!.save({ id, source: 'prereason', format: 'json', fetchedAt: at, generatedAt: at, lines: [], raw: JSON.stringify({ metric: id, timestamp: at, context, source: 'x' }) });
  for (const [at, v] of [['2026-09-18T19:30:00.000Z', '-61,002'], ['2026-09-25T19:30:00.000Z', '-55,870'], ['2026-10-02T19:30:00.000Z', '-54,333']] as const) kept('cot-spx-noncomm-net', at, `S&P 500 e-mini non-commercial net position at ${v} contracts; 7d +1.`);
  kept('etf-spy', '2026-10-12T19:45:00.000Z', 'SPY at $665.50; 7d +0.6%.');
  return deps;
}

// ------------------------------------------------------------------ the research view

// The research tests' closes: a calm month below the 200 day average, then a step up into a
// wide month above it, with a swing every other day.
const TODAY = '2026-10-12';
const FROM = '2026-08-01';
const TO = '2026-09-29';
const swing = (i: number): number => 0.004 + 0.0003 * i;
const baseAt = (i: number): number => (i < 30 ? 96_000 * 1.0015 ** i : 106_000 * 1.0015 ** (i - 30));
const priceAt = (i: number): number => (i < 0 ? 100_000 - 25 * (i + 1) + (i % 2 ? 100 : -100) : baseAt(i) * (1 + swing(i) * (i % 2 ? -1 : 1)));
const CLOSES: Close[] = Array.from({ length: 463 }, (_, k) => k - 400).map((i) => ({ date: addDays(FROM, i), price: Math.round(priceAt(i) * 100) / 100 }));
const closeOn = (date: string): number => (CLOSES.find((c) => c.date === date) as Close).price;

const YAML = ['rules: rules.md', 'data:', '  briefings: [btc.pulse]', '  price_days: 365', 'labels:', '  watch: { hold: true }', '  enter: { target: 1 }', '  exit: { target: 0 }', 'fees: { per_trade: 0.001 }', 'spread_bps: 10', ''].join('\n');
const CARD = (success: string) =>
  `## Claim\nThe every other day swing can be caught a day ahead.\n\n## Mechanism\nThe closes alternate.\n\n## Expected signature\nTreatment gains on the days btc.pulse and the price table show a rise.\n\n## Universe and horizon\nBTC/USD, a day at a time.\n\n## Success criterion\n${success}\n\n## Kill criterion\ntreatment behind control by 1 point\n`;

// The labels a run records, as the tests' script gives them: a day ahead of the swing, or
// always in.
type Labels = (arm: string, i: number, tick: string) => string;
const ahead: Labels = (arm, i, tick) => (arm !== 'treatment' || i < 2 ? 'watch' : closeOn(addDays(tick, 2)) > closeOn(addDays(tick, 1)) ? 'enter' : 'exit');
const alwaysIn: Labels = (arm, i) => (arm === 'treatment' && i >= 2 ? 'enter' : 'watch');

function routineIn(home: string, name: string, success = 'treatment ahead of control by at least 1 point over the backtest'): Routine {
  const dir = join(home, 'routines', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'routine.yaml'), YAML);
  writeFileSync(join(dir, 'rules.md'), 'Enter before a rise, exit before a fall.\n');
  writeFileSync(join(dir, 'hypothesis.md'), CARD(success));
  return loadRoutine(dir);
}

// The research pictures' backtests are kept under one pinned run id. A run's id seeds H5's
// interval and a fresh id is random, so each redraw drew a new interval; under the pinned id,
// a redraw draws the same ladder. Only the gallery pins it: primerkit gives every run a fresh id.
export const RESEARCH_RUN_ID = '20261012T120000Z-000000';

// A backtest through the simulated account with no model: each tick's label recorded as a
// model's would be, from the script, as the research tests run one. It is kept under the
// pinned id.
async function backtest(routine: Routine, labels: Labels, finish = true): Promise<void> {
  const plan = planBacktest(routine, { from: FROM, to: TO }, { tier: 'enterprise', today: TODAY, format: 'markdown', model: 'scripted', cutoff: { cutoff: '2024-09', source: 'test', basis: 'person' } });
  const source = { briefing: async () => ({ raw: '' }), closes: async (from: string, to: string) => CLOSES.filter((c) => c.date >= from && c.date <= to) };
  const run = (await BacktestRun.start({ routine, plan, model: 'scripted', source, now: () => new Date(`${TODAY}T12:00:00.000Z`) }))!;
  const index = new Map(plan.ticks.map((t, i) => [t, i] as const));
  for (let key = run.next(); key; key = run.next()) run.record(key, { label: labels(key.arm, index.get(key.tick)!, key.tick), outcome: 'passed', runId: `r-${key.arm}-${key.tick}` });
  if (finish) run.finish();
  pinRunId(routine, run.dir, run.runId);
}

// A run moved to the pinned id: its files copied into a folder of that name with the id
// rewritten in each, and in the card's version line that names the run; the fresh folder
// is removed, so the routine holds the one run.
function pinRunId(routine: Routine, dir: string, fresh: string): void {
  const pinned = join(dirname(dir), RESEARCH_RUN_ID);
  const repinned = (file: string) => readFileSync(file, 'utf8').replaceAll(fresh, RESEARCH_RUN_ID);
  mkdirSync(pinned);
  for (const f of readdirSync(dir)) writeFileSync(join(pinned, f), repinned(join(dir, f)));
  const versions = join(hypothesesDir(routine.dir), 'versions.jsonl');
  writeFileSync(versions, repinned(versions));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

export const RESEARCH_ROUTINE = 'swing';

// Four routines with backtests run: one that passes the ladder, one whose criterion asks for
// 1000 points, one always in, and one not finished, so the registry shows each status.
export async function researchSession(home: string): Promise<SessionDeps> {
  await backtest(routineIn(home, RESEARCH_ROUTINE), ahead);
  await backtest(routineIn(home, 'swing-1000', 'treatment ahead of control by 1000 points'), ahead);
  await backtest(routineIn(home, 'always-in'), alwaysIn);
  await backtest(routineIn(home, 'unfinished'), ahead, false);
  return fixtureDeps(home, { model: new ScriptedModel([]), config: LOCAL, data: new FixtureConnector(BENCH_BRIEFINGS), now: new Date(`${TODAY}T14:00:00.000Z`) });
}

// ------------------------------------------------------------------ the digest

// The session tests' yesterday: the demo's saved macro.snapshot with two things changed (net
// liquidity was rising, the TGA's signal at trend), made for the tests and not PreReason's.
// Any other briefing's past day is refused, as the free tier refuses it.
class WithYesterday extends FixtureConnector {
  readonly tier = 'free' as const;
  private readonly before: string;
  constructor() {
    super(BENCH_BRIEFINGS);
    const before = JSON.parse(readFileSync(join(BENCH_BRIEFINGS, 'macro.snapshot.json'), 'utf8')) as { metrics: Record<string, { signal: string; trend: { direction: string } }>; generated_at: string };
    before.metrics['net-liquidity']!.trend.direction = 'rising';
    before.metrics['tga']!.signal = 'at-trend';
    before.generated_at = '2026-09-24T23:55:00.000Z';
    this.before = JSON.stringify(before);
  }
  override async fetch(req: ContextRequest): Promise<DataBlock> {
    if (req.date && req.briefing === 'macro.snapshot') return blockFromJson('macro.snapshot', this.before, '2026-09-26T08:00:00.000Z');
    if (req.date) throw new PreReasonError("not available on this key's tier", 403, 'DATE_RESTRICTED');
    return super.fetch(req);
  }
}

// The session tests' writer: one sentence for each change, quoting the metric's name from its line.
const writer = (): ScriptedModel =>
  new ScriptedModel([
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

export function digestSession(home: string): SessionDeps {
  return fixtureDeps(home, { model: writer(), config: LOCAL, data: new WithYesterday(), now: new Date('2026-09-26T08:00:00.000Z') });
}
