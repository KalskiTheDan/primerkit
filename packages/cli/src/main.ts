import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BENCH_RUNS,
  Journal,
  ROUTINE_QUESTION,
  RoutineError,
  Snapshots,
  benchItems,
  benchLines,
  buildPacket,
  clearForwardSchedule,
  forwardAccount,
  forwardDir,
  cutoffOf,
  isMonth,
  listBacktests,
  measuredSeconds,
  memoryPacket,
  planBacktest,
  planLines,
  readForward,
  readForwardCloses,
  readForwardSchedule,
  readReplay,
  replayOf,
  trackRoutine,
  writeForwardSchedule,
  prepareRoutine,
  priceDaysFor,
  reportLines,
  runBacktest,
  tickLine,
  holdingOf,
  keepBench,
  listRoutines,
  loadOperation,
  loadRoutine,
  loadRoutineTests,
  newRoutine,
  positionBlock,
  primerkitHome,
  priceBlock,
  readConfig,
  readFixture,
  briefingsOn,
  readRules,
  renderMarkdown,
  routineOperation,
  routinesDir,
  rulesBlock,
  runBench,
  summarizeBench,
  testLines,
  testRoutine,
  testSummary,
  writeConfig,
  journalEntries,
  journalRun,
  journalRunLines,
  journalSummary,
  queryWords,
  RUN_ID,
  type JournalQuery,
  type BacktestOutcome,
  type ModelAdapter,
  type Routine,
  type RoutineTests,
} from '@primerkit/core';
import { BENCH_FIXTURES, CodedError, HOSTS, HostRuns, ROBINHOOD_HOSTS, answerJson, applyInstall, describePlan, describeRemoval, errorJson, hostDeps, planInstall, removeInstall, serveMcp, systemRunner, type ErrorCode, type Host } from '@primerkit/mcp-server';
import { FixtureConnector, PreReasonClient, IDS_SHOWN, isMetricId, briefingsByArea, derivativesMarks, fetchCatalog, fetchMetricCatalog, idsShown, keptFor, metricsByArea, moreByArea, parseCatalog, readableBy, resolveKey, type CatalogEntry, type DerivativesMarks, type MetricEntry, type Tier } from '@primerkit/connector-prereason';
import { checkFitness, fitnessLines, providerById, serverUrl, type ModelSpec } from '@primerkit/models';
import {
  ASK_DIR,
  BIN,
  DEMO_BRIEFINGS,
  DEMO_CATALOG,
  DEMO_SAMPLE,
  DIGEST_DIR,
  DemoStandIn,
  FIRST_RUN_WALK,
  INSTALL,
  NPX_SCHEDULE,
  ROOT,
  ROUTINE_DIR,
  Session,
  askBriefings,
  chartHelp,
  configFromSpec,
  defaultWatchlist,
  demoDeps,
  digestEntry,
  fitnessInputs,
  latestBench,
  loadBoard,
  mcpLaunch,
  messageOf,
  modelFor,
  emptyLines,
  newsCredit,
  newsMarkdownParts,
  sideLines,
  parseBoard,
  parseTime,
  fitText,
  backtestBoard,
  forwardBoard,
  jobEntry,
  memoryBoard,
  planBoard,
  printedBoard,
  roomFor,
  realDeps,
  hypothesisPage,
  hypothesisText,
  registryPage,
  registryText,
  researchPage,
  researchText,
  routinePage,
  routineSource,
  routineText,
  tildePath,
  renderDigest,
  runDigest,
  runInTerminal,
  specFromConfig,
  SERIES_ROWS,
  runCommand,
  systemScheduler,
  taller,
  trackJob,
  walk,
  readLatestDigest,
  writeLatestDigest,
  writeShareCard,
  type DigestView,
  type Key,
  type Platform,
  DEMO_DATE,
  demoNextStep,
  readBriefing,
  readMetric,
  journalFind,
} from '@primerkit/session';
import { brokerCommand, connectAlpaca, routineIntent, type Io } from './broker';
import { connectPrereason, keyLine, prereasonOn } from './connect';
import { intentCommand } from './intent';
import { approveCommand, connectRobinhood } from './robinhood';
import { paperHoldings, positionsCommand } from './positions';
import { keepTier, tierOfKey } from './tier';
import { askLine, doctorLine, forTerminal, isTerminal, runtimeLists } from './terminal';
import { TAGLINE, colorMode, glyphMode, lockup, maker, renderLine, type ColorMode } from '@primerkit/ui';
import { withWait } from '@primerkit/connector-prereason';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const PLATFORM = (process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux') as Platform;

// The chart line of --help, each chart marked with the tier it needs, from PreReason's lists as
// last kept on this machine, else the catalog saved with primerkit: --help reads nothing from
// PreReason, and a chart neither list speaks for is left unmarked.
function chartLines(): string {
  const kept = <T>(file: string): T[] | null => {
    try {
      const value = (JSON.parse(readFileSync(join(primerkitHome(), 'cache', file), 'utf8')) as { value?: unknown }).value;
      return Array.isArray(value) && value.length ? (value as T[]) : null;
    } catch {
      return null;
    }
  };
  let briefings = kept<CatalogEntry>('catalog.json');
  try {
    briefings ??= parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8')));
  } catch {
    // Nothing to mark the charts of briefings from.
  }
  const parts = chartHelp({ briefings, metrics: kept<MetricEntry>('metrics.json') }, new Date().toISOString().slice(0, 10));
  // Wrapped as the other lines are, to 101 columns under the column the descriptions start in,
  // a chart and its marks never split.
  const lines = ['  primerkit chart <name> [range]  '];
  for (const part of parts) {
    if (lines.at(-1)!.length + 1 + part.length > 101) lines.push(' '.repeat(34));
    lines[lines.length - 1] += ` ${part}`;
  }
  return lines.join('\n');
}

const usage = (): string => `primerkit ${VERSION}: ${TAGLINE}

  Start here: primerkit --demo shows the session on saved briefings, with no key and no
  model needed (it also offers a local model it finds); primerkit then walks you through
  a model and PreReason, and primerkit doctor says what is missing.
  PR on a line marks data from PreReason.

  primerkit                        open the session
  primerkit --demo                 the session on saved briefings, with no key and no model
                                   needed (it also offers a local model it finds)
  primerkit --demo --walk          print the first run, screen by screen

  primerkit ask "<question>"       ask the briefings once and print the answer; a day the
                                   question names, such as as of 2026-08-15, reads the
                                   briefings as they stood on it
      --briefing <id>              read this briefing or metric (repeatable); otherwise
                                   they are picked
      --demo                       saved briefings and the demo stand in
      --json                       the answer as JSON: its claims, the numbered lines each
                                   cites, every check, tokens and cost where known
  primerkit catalog                every briefing this key reads and the metrics, by area
      --all                        every metric, not the first few of each area
      --json                       the lists as JSON
  primerkit run digest             the digest now, as the schedule runs it
      --since yesterday            compare with the end of yesterday, not the last digest
  primerkit model check            the fitness check on the model in use
  primerkit model set              choose the model, with one of:
      --ollama <model>                 an Ollama model on this machine
      --server <url> --model <id>      a server that speaks the OpenAI API
      --provider <id> --model <id>     a hosted model on your key: anthropic, openai,
                                       google, xai, deepseek, mistral, groq, openrouter
  primerkit brief <briefing>       a briefing as a board: levels, changes, 30 days, where each sits;
                                   add fill to read the days your journal lacks; --json gives
                                   its numbered, dated lines
  primerkit journal                the latest runs in the journal, with tokens and cost
      --operation <name>           ask, digest, bench, backtest, routine, compare, model-check
      --briefing <id> --outcome <passed|partial|failed> --day <YYYY-MM-DD>
      --search "<words>"           words in a question or an answer
      --run <id>                   one run: its question, answer, cited lines, checks and cost
      --summary                    each day's runs, tokens and cost; --days <n>, 7 by default
      --json                       as JSON; --limit <n> runs, 20 by default
  primerkit positions              the Alpaca paper holdings, where its mode reads, and every
                                   order intent; nothing here sends an order; --json
${chartLines()}
  primerkit routine                your routines
  primerkit routine new <name>     a new routine: its folder, with routine.yaml, a rules file
                                   holding no rules yet, tests.yaml and hypothesis.md
  primerkit routine <name>         what the routine reads, its model, rules and labels
  primerkit routine <name> test    its logic tests: your rules on frozen days, several runs each
      --runs <n>                   runs of each test, in place of tests.yaml's
  primerkit routine <name> track   the forward record: the routine once now, on the data as
                                   served, its label written before the outcome exists
      --show                       the record, with nothing run
      --at <HH:MM>                 run it every day at that time, on the machine's scheduler
      --stop                       take it off the schedule; the record stays
  primerkit routine <name> intent  an order intent from its newest label, sized on the Alpaca paper
                                   account as it stands, kept in the journal; nothing is sent
  primerkit routine <name> hypothesis
                                   your hypothesis card, its version and its form check
  primerkit routine <name> research
                                   its newest backtest, hurdle by hurdle, H1 to H5
  primerkit routine registry       every hypothesis and version tested, with its status
  primerkit backtest <name> --from <date> --to <date>
                                   the routine over a past window in three arms, through a
                                   simulated account: the plan first, then the run
      --every day|week             how often it runs in the window; the routine's own otherwise
      --reps <n>                   run each arm this many times over, 1 by default
      --resume                     carry on the last run that was stopped
      --cutoff <YYYY-MM>           the model's training cutoff, from its model card, where
                                   primerkit does not know it; kept for next time. Without
                                   it, the memory check decides
      --inside-training            your yes to a window the model's training reaches, or one
                                   it remembers; every result then says so
      --replay                     the report of the newest finished run, drawn again;
                                   --run <id> picks another
  primerkit bench                  the comprehension benchmark on the model in use
      --runs <n>                   runs of each packet, 3 by default
      --card                       a share card of the latest benchmark, saved on this machine
  primerkit connect prereason      connect PreReason through its bridge
  primerkit connect alpaca         Alpaca paper trading: asks for the paper keys once, at a terminal,
                                   and keeps them in this machine's keychain; --remove takes them out
  primerkit connect robinhood --host <app>
                                   Robinhood live trading, real money, through Robinhood's own
                                   server in its separate agent account: shows what it adds to
                                   ${ROBINHOOD_HOSTS.join(' or ')}, and adds it on a yes typed at a terminal;
                                   --remove takes out what it added
  primerkit broker                 the Alpaca paper account, your caps and today's orders
  primerkit broker order <symbol> buy --notional <dollars>, or sell --notional <dollars> | --qty <n>
                                   a dry run through your caps; --paper places it on paper, on a yes
                                   typed at a terminal
  primerkit broker reconcile       compare the log's record with what Alpaca holds, and ask Alpaca
                                   for an order whose answer was lost
  primerkit broker enable          turn a stopped connection back on, on a yes typed at a terminal
  primerkit broker disable         turn the connection off by hand, at once; a file named STOP in
                                   the broker folder does the same while it is there
  primerkit intent                 your order intents; <id> shows one, and <id> check runs its
                                   pre-trade checks on the paper account, writing nothing
  primerkit intent <id> place      its checks and the exact order, placed on paper on a yes typed
                                   at a terminal; every check runs again after the yes
  primerkit intent approve [<id>]  the live intents your AI app recorded for Robinhood; with an id,
                                   shows it and approves it on a yes typed at a terminal
  primerkit intent <id> refresh    its order's fills, read from Alpaca; cancel takes back a draft,
                                   or an order that has not filled
  primerkit intent export --from <day> --to <day> --out <folder>
                                   the intents drafted in those days, as one CSV and a folder each
                                   with its page, into a new or empty folder
  primerkit schedule <HH:MM>       show the digest's entry in ${PLATFORM === 'win32' ? 'Task Scheduler' : PLATFORM === 'darwin' ? 'launchd' : 'cron'}; add --yes to add it
  primerkit schedule remove        take the digest's entry out
  primerkit install --host <app>   show what putting primerkit into an AI app changes; add --yes
                                   to make it. The apps: claude-code, codex, gemini, lm-studio
  primerkit uninstall --host <app> take it out again; add --yes
  primerkit mcp                    the local MCP server an AI app starts; --demo for saved briefings
  primerkit doctor                 check the model, PreReason and the schedule
  primerkit --version              the logo and the version

  The model flags also work on ask, bench, model check, routine test and backtest, for one run.
  --plain    plain text, no colour   --16    16 colours   --unicode    Unicode glyphs in any console
  --home <folder>    where primerkit keeps its files for this run, as PRIMERKIT_HOME does
`;

interface Args {
  command: string | null;
  rest: string[];
  flags: Map<string, string[]>;
}

const VALUED = new Set(['--briefing', '--ollama', '--server', '--model', '--provider', '--since', '--keys', '--host', '--runs', '--notional', '--qty', '--price', '--from', '--to', '--every', '--reps', '--cutoff', '--run', '--at', '--home', '--out', '--limit', '--days', '--operation', '--outcome', '--day', '--search']);

// A flag that takes a value never takes the next flag as its value: in `ask --briefing
// --demo`, --demo is a flag, and --briefing has no value, which flagProblem names.
function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const next = argv[i + 1];
      const value = VALUED.has(arg) && next !== undefined && !next.startsWith('--') ? (argv[++i] ?? '') : '';
      flags.set(arg, [...(flags.get(arg) ?? []), value]);
    } else {
      rest.push(arg);
    }
  }
  return { command: rest.shift() ?? null, rest, flags };
}

// What is wrong with the flags as given, before any command runs: a flag that takes a
// value and has none, and model flags that do not name one model.
function flagProblem(flags: Map<string, string[]>): string | null {
  for (const [name, values] of flags) if (VALUED.has(name) && values.some((v) => !v.trim())) return `${name} takes a value after it.`;
  const has = (name: string) => flags.has(name);
  if (!has('--ollama') && (has('--model') || has('--server') || has('--provider')) && !((has('--server') || has('--provider')) && has('--model'))) {
    return 'The model flags go together: --ollama <model>, --server <url> --model <id>, or --provider <id> --model <id>.';
  }
  return null;
}

const flag = (args: Args, name: string): string | undefined => args.flags.get(name)?.[0] || undefined;

function modesOf(args: Args): { color: ColorMode; ascii: boolean } {
  const color = colorMode({ env: process.env, isTTY: Boolean(process.stdout.isTTY), plainFlag: args.flags.has('--plain'), sixteenFlag: args.flags.has('--16') });
  return { color, ascii: glyphMode({ env: process.env, platform: process.platform, color, unicodeFlag: args.flags.has('--unicode') }) === 'ascii' };
}

// The window's width where the output is a terminal; none for a pipe or a file.
function printColumns(): number | undefined {
  return process.stdout.isTTY ? process.stdout.columns : undefined;
}

function print(lines: string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}

// The ways to an answer that need no model of one's own: an AI app the person already uses
// answers through primerkit with the app's model, and the demo answers with none.
const WITHOUT_A_MODEL = `With no model of your own, an AI app you use can answer through primerkit with its own model: primerkit install --host <app> (${HOSTS.join(', ')}). primerkit ask --demo "<question>" answers from saved briefings with no model.`;

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

// The model the flags name for one run, if they name one.
function flaggedSpecOf(args: Args): ModelSpec | null {
  const ollama = flag(args, '--ollama');
  const server = flag(args, '--server');
  const provider = flag(args, '--provider');
  const model = flag(args, '--model');
  if (ollama) return { kind: 'ollama', name: ollama };
  if (server && model) return { kind: 'openai-compatible', name: model, baseUrl: serverUrl(server) };
  if (provider && model) return { kind: 'hosted', provider, name: model };
  return null;
}

// The model flags as they were given, for a scheduled run to be given the same.
function modelFlags(args: Args): string[] {
  return ['--ollama', '--server', '--provider', '--model'].flatMap((name) => {
    const value = flag(args, name);
    return value ? [name, value] : [];
  });
}

// The model a command runs on: the flags, or the one the config keeps.
function specOf(args: Args): ModelSpec | null {
  const flagged = flaggedSpecOf(args);
  if (flagged) return flagged;
  const kept = readConfig(primerkitHome()).model;
  return kept ? specFromConfig(kept) : null;
}

function modelOf(args: Args): ModelAdapter | null {
  const spec = specOf(args);
  return spec ? modelFor({ kind: 'model', spec }, process.env, readConfig(primerkitHome()).model) : null;
}

// The apps the machine check names, as install knows them.
const HOST_OF: Record<string, Host> = { 'Claude Code': 'claude-code', Codex: 'codex', 'Gemini CLI': 'gemini', 'LM Studio': 'lm-studio' };

// What an install writes: this copy's skills, and the line that starts its server.
const installOptions = () => ({ node: process.execPath, bin: BIN, home: homedir(), skillsFrom: join(ROOT, 'hosts', 'claude-code-plugin', 'skills'), launch: mcpLaunch(VERSION) });

// Putting primerkit into an app from the session: the same plan install shows.
function installInto(app: string): { lines: string[]; apply(): Promise<string[]> } | null {
  const host = HOST_OF[app];
  if (!host) return null;
  const plan = planInstall(host, installOptions());
  return { lines: describePlan(plan), apply: () => applyInstall(plan, systemRunner) };
}

async function session(args: Args): Promise<number> {
  const demo = args.flags.has('--demo');
  // The session reads the tier from the config as it starts, so a key's tier is learned first.
  if (!demo) await tierOfKey(primerkitHome(), resolveKey()?.key ?? null, VERSION);
  // /positions reads the paper account through the same keychain and mode as primerkit broker.
  const deps = demo ? demoDeps({ version: VERSION }) : { ...realDeps({ version: VERSION }), installInto, holdings: () => paperHoldings(io()) };
  const { color, ascii } = modesOf(args);
  if (args.flags.has('--walk')) {
    for (const shot of await walk(deps, FIRST_RUN_WALK, ascii)) {
      print([`${ascii ? '--' : '──'} ${shot.title} ${(ascii ? '-' : '─').repeat(Math.max(0, 72 - shot.title.length))}`, ...shot.lines.map((l) => renderLine(l, color)), '']);
    }
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fail('The session needs a terminal. In a script, use primerkit ask "<question>".');
  const live = new Session(deps);
  const script = flag(args, '--keys');
  if (script) void press(live, script);
  await runInTerminal(live, color, ascii);
  // The demo ends one step from live briefings, and says that step.
  if (demo) {
    const step = demoNextStep();
    print(['', step.done, step.live]);
  }
  return 0;
}

// For recording the screens: keys pressed on a timer, as a person would press them.
// A comma list such as "wait:3,enter,down,type:qwen3:8b,enter".
async function press(live: Session, script: string): Promise<void> {
  for (const token of script.split(',')) {
    const at = token.indexOf(':');
    const name = at < 0 ? token : token.slice(0, at);
    const arg = at < 0 ? '' : token.slice(at + 1);
    await new Promise((r) => setTimeout(r, name === 'wait' ? Number(arg || 1) * 1000 : 700));
    if (name === 'wait') continue;
    if (name === 'type') for (const char of arg) live.key({ name: 'char', char });
    else live.key({ name } as Key);
  }
}

// PreReason's keyless catalog and list of metrics, kept five minutes in the home, so a burst of
// commands reads each once (PreReason allows only a few keyless reads a minute from one address).
const liveCatalog = (home: string) => keptFor(join(home, 'cache', 'catalog.json'), 5, () => fetchCatalog(VERSION));
const liveMetrics = (home: string) => keptFor(join(home, 'cache', 'metrics.json'), 5, () => fetchMetricCatalog(VERSION));
// What PreReason's catalogue marks as measuring a futures, swap or options market, and every
// id it lists, from the lists as they are kept; null where either cannot be read, so every
// publication is refused.
const markedNow = async (home: string): Promise<DerivativesMarks | null> => {
  try {
    return derivativesMarks(await liveCatalog(home), await liveMetrics(home));
  } catch {
    return null;
  }
};

// --json: one JSON document on stdout, for a script or an AI app to read, with stable keys.
// A refusal or a failure is JSON too, with its code, and the run ends with 1.
const wantsJson = (args: Args): boolean => args.flags.has('--json');

function printJson(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

function failJson(error: unknown): number {
  process.stdout.write(`${JSON.stringify(errorJson(error), null, 2)}\n`);
  return 1;
}

// The code a failed ask is read as, from what askBriefings said of it.
function askCode(message: string, detail: string | null): ErrorCode {
  const words = `${message} ${detail ?? ''}`;
  if (/did not pass its checks/.test(message)) return 'check_failed';
  if (/Try again in|rate limit|too many/i.test(words)) return 'rate_window';
  if (/tier|plan above|paid key/i.test(words)) return 'tier_refused';
  if (/not connected|key was refused|no key/i.test(words)) return 'no_key';
  return 'failed';
}

// An ask's outcome as JSON.
function askJson(outcome: Awaited<ReturnType<typeof askBriefings>>, standIn: boolean): number {
  if (outcome.kind === 'note') return failJson(new CodedError(outcome.text, 'bad_input'));
  if (outcome.kind === 'failed') return failJson(new CodedError(`${outcome.message}${outcome.detail ? ` ${outcome.detail}` : ''}`, askCode(outcome.message, outcome.detail)));
  if (outcome.kind === 'no-records') return printJson({ ok: true, kind: 'news', records: 0, credit: newsCredit(outcome.news) });
  return printJson({
    ok: true,
    kind: 'answer',
    ...answerJson(outcome.result),
    skipped: outcome.skipped,
    notes: outcome.notes,
    // The demo's stand in lifts sentences and does not read the question: its answer is a sample.
    ...(standIn ? { checks: [], demo: { saved_on: DEMO_DATE, stand_in: true, checked: false } } : {}),
  });
}

// One question, answered and checked, printed as the operation's markdown.
async function ask(args: Args): Promise<number> {
  const json = wantsJson(args);
  const refuse = (message: string, code: ErrorCode): number => (json ? failJson(new CodedError(message, code)) : fail(message));
  const question = args.rest.join(' ').trim();
  if (!question) return refuse('Ask a question: primerkit ask "Where does Bitcoin stand?"', 'bad_input');
  const demo = args.flags.has('--demo');
  let model: ModelAdapter | null;
  try {
    // The demo answers with its stand in. Only a model the flags name answers instead:
    // the one the config keeps is never asked, since a hosted one would charge the key.
    model = demo && !flaggedSpecOf(args) ? new DemoStandIn() : modelOf(args);
  } catch (error) {
    return refuse((error as Error).message, 'no_model');
  }
  if (!model) return refuse(`No model is set. Choose one with primerkit model set, or in the session. ${WITHOUT_A_MODEL}`, 'no_model');
  const key = demo ? null : resolveKey();
  if (!demo && !key) return refuse('PreReason is not connected. Run primerkit connect prereason, or set PREREASON_API_KEY.', 'no_key');
  const home = primerkitHome();
  const data = demo ? new FixtureConnector(DEMO_BRIEFINGS) : prereason(key?.key ?? null);
  const named = args.flags.get('--briefing')?.filter(Boolean) ?? [];
  const operation = loadOperation(ASK_DIR);
  const outcome = await askBriefings(
    {
      operation,
      model,
      data,
      catalog: async () => (demo ? parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8'))) : liveCatalog(home)),
      ...(demo ? {} : { metrics: () => liveMetrics(home) }),
      hints: { catalog: 'primerkit catalog', chart: 'primerkit chart' },
      tier: demo ? null : await tierOfKey(home, key?.key ?? null, VERSION),
      snapshots: demo ? null : new Snapshots(join(home, 'snapshots')),
      journal: demo ? null : new Journal(join(home, 'journal')),
    },
    question,
    named.length ? named : null,
  );
  if (!demo && data instanceof PreReasonClient && data.tier) keepTier(home, data.tier);
  if (json) return askJson(outcome, demo && model instanceof DemoStandIn);
  if (outcome.kind === 'note') return fail(outcome.text);
  if (outcome.kind === 'failed') return fail(`${outcome.message}${outcome.detail ? ` ${outcome.detail}` : ''}`);
  // PreReason's news read, its window holding no record: what was read is the answer.
  if (outcome.kind === 'no-records') {
    process.stdout.write(fitText(`${[...emptyLines(outcome.news), ...sideLines(outcome.news), '', `PR · ${newsCredit(outcome.news)}`].join('\n')}\n`, printColumns()));
    return 0;
  }
  for (const note of outcome.notes) process.stderr.write(`${note}\n`);
  for (const id of outcome.skipped) process.stderr.write(`${id}: not available on this key's tier, so it was not read.\n`);
  // The demo stand in does not read the question, so its answer is a sample, never shown as
  // checked: its checks line says so in place of the checks.
  const parts = { ...(outcome.news ? newsMarkdownParts(outcome.view, outcome.news) : {}), ...(outcome.standIn ? { checks: DEMO_SAMPLE } : {}) };
  const rendered = forTerminal(renderMarkdown(operation.render ?? '{{headline}}\n\n{{body}}\n', outcome.view, parts), Boolean(process.stdout.isTTY));
  // The demo's stand in writes nothing of its own, so its credit line says who answered.
  const standIn = demo && model instanceof DemoStandIn;
  process.stdout.write(fitText(standIn ? rendered.replace('written by your model', 'lifted by the demo stand in') : rendered, printColumns()));
  if (standIn) process.stdout.write(fitText(`\n(demo: saved briefings of ${DEMO_DATE}, answered by the demo stand in, which lifts sentences and does not read the question)\n`, printColumns()));
  if (standIn) process.stdout.write(fitText(`${demoNextStep().live}\n`, printColumns()));
  return 0;
}

// Every briefing this key reads and every metric PreReason serves, by area, as /catalog
// lists them in the session. The briefings need no key to be listed; the tier the config
// keeps decides which are readable.
async function catalogCommand(args: Args): Promise<number> {
  const demo = args.flags.has('--demo');
  const key = demo ? null : resolveKey();
  const tier = demo ? 'free' : ((await tierOfKey(primerkitHome(), key?.key ?? null, VERSION)) ?? 'free');
  let all;
  let briefings;
  try {
    all = demo ? parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8'))) : await liveCatalog(primerkitHome());
    // The demo lists the briefings it saved, the ones its answers can read.
    const saved = demo ? new FixtureConnector(DEMO_BRIEFINGS) : null;
    briefings = readableBy(all, tier).filter((b) => !saved || saved.has(b.id));
  } catch (error) {
    if (wantsJson(args)) return failJson(error);
    return fail(`The catalog could not be read: ${messageOf(error)}`);
  }
  const metrics = demo ? [] : await liveMetrics(primerkitHome()).catch(() => null);
  if (wantsJson(args)) {
    return printJson({
      ok: true,
      tier,
      key: Boolean(key),
      ...(demo ? { demo: { saved_on: DEMO_DATE } } : {}),
      briefings: briefings.map((b) => ({ id: b.id, name: b.name, description: b.description, tier: b.tier })),
      // null where PreReason's list of metrics could not be read.
      metrics: metrics === null ? null : metrics.map((m) => ({ id: m.id, name: m.name, description: m.description, category: m.category })),
    });
  }
  const heading = demo ? 'Briefings saved for the demo' : key ? 'Briefings this key reads' : 'Briefings a free key reads';
  const lines = [`${heading} (${briefings.length}), ${demo ? `as they stood on ${DEMO_DATE}` : 'as they stand now or on a past day you name'}:`];
  for (const a of briefingsByArea(briefings)) lines.push(`  ${a.area}: ${a.ids.join(', ')}`);
  if (metrics === null) lines.push('', 'The list of metrics could not be read.');
  else if (metrics.length) {
    lines.push('', `Metrics (${metrics.length}), as they stand now:`);
    const areas = metricsByArea(metrics);
    const all = args.flags.has('--all');
    for (const a of areas) lines.push(`  ${a.area} (${a.ids.length}): ${idsShown(a.ids, all)}`);
    if (!all && areas.some((a) => a.ids.length > IDS_SHOWN)) lines.push('  primerkit catalog --all lists every metric.');
  }
  // What a key, or a plan above this key, would add: a new user learns the rest exists.
  const more = demo ? null : moreByArea(all, briefings);
  if (more) {
    const parts = [...(more.count ? [`${more.count} more: ${more.areas}`] : []), ...(more.companies ? ['the company briefings, equities.company/<company> for each company PreReason covers'] : [])];
    lines.push('', `${key ? 'Plans above this key read' : 'A paid key reads'} ${parts.join(', and ')}.`);
  }
  if (!demo && !key) lines.push('', 'With no key nothing is read: primerkit connect prereason makes a free key, or set PREREASON_API_KEY.');
  lines.push('', demo ? 'Name one in a question, such as macro.snapshot.' : 'Name one in a question, such as macro.snapshot or treasury-10y, or add a day, such as as of 2026-08-15.');
  process.stdout.write(fitText(`${lines.join('\n')}\n`, printColumns()));
  return 0;
}

// The digest now: what the schedule runs each morning.
async function runDigestCommand(args: Args): Promise<number> {
  if (args.rest[0] !== 'digest') return fail('Only the digest runs this way in this build: primerkit run digest');
  const home = primerkitHome();
  const config = readConfig(home);
  const since = flag(args, '--since') === 'yesterday' ? 'yesterday' : (config.digest?.since ?? 'last');
  const ranAt = new Date().toISOString();
  const failed = (why: string) => {
    writeLatestDigest(home, { ranAt, since: null, briefings: [], changes: [], same: [], notes: [], sources: [], checks: null, computed: 0, generated: null, model: null, failed: why });
    return fail(`The digest did not run: ${why}`);
  };
  const key = resolveKey();
  if (!key) return failed('PreReason is not connected.');
  let model: ModelAdapter | null;
  try {
    model = modelOf(args);
  } catch (error) {
    return failed((error as Error).message);
  }
  if (!model) return failed('no model is set.');
  const data = prereason(key.key);
  try {
    await model.capabilities();
    const spec = specOf(args);
    if (spec?.kind === 'ollama') {
      const up = await fetch(`${spec.baseUrl ?? 'http://127.0.0.1:11434'}/api/tags`).then((r) => r.ok, () => false);
      if (!up) return failed('Ollama was not running.');
    }
  } catch (error) {
    return failed(`the model could not be reached: ${(error as Error).message}`);
  }
  // Anything that stops it from here on is said on the home screen as well, and the run
  // ends with 1, so the scheduler records it as failed.
  let view: DigestView;
  try {
    const watchlist = config.watchlist?.length ? config.watchlist : defaultWatchlist(readableBy(await fetchCatalog(VERSION), (await tierOfKey(home, key.key, VERSION)) ?? 'free'));
    view = await runDigest(
      { operation: loadOperation(DIGEST_DIR), model, data, snapshots: new Snapshots(join(home, 'snapshots')), journal: new Journal(join(home, 'journal')), home, onStatus: (text) => process.stderr.write(`${text}\n`) },
      { watchlist, since },
    );
  } catch (error) {
    return failed(`${(error as Error).message.replace(/\.$/, '')}.`);
  }
  process.stdout.write(fitText(renderDigest(view), printColumns()));
  return 0;
}

async function modelCommand(args: Args): Promise<number> {
  const sub = args.rest[0];
  const home = primerkitHome();
  if (sub === 'set') {
    const spec = specOf(args);
    if (!spec || (!flag(args, '--ollama') && !flag(args, '--model'))) return fail('Say which model: --ollama <model>, --server <url> --model <id>, or --provider <id> --model <id>.');
    if (spec.kind === 'hosted' && !providerById(spec.provider)) return fail(`primerkit does not know the provider ${spec.provider}.`);
    writeConfig(home, { ...readConfig(home), model: configFromSpec(spec) });
    print([`Set. The next runs answer with ${spec.name}. primerkit model check tests it.`]);
    return 0;
  }
  if (sub !== 'check') return fail('primerkit model check, or primerkit model set with the model flags.');
  let model: ModelAdapter | null;
  try {
    model = modelOf(args);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!model) return fail('No model is set. Choose one with primerkit model set.');
  const caps = await model.capabilities();
  if (!caps.local) process.stderr.write(`This check sends its packets to ${model.label.split(', ')[1] ?? 'the provider'} on your key.\n`);
  const result = await checkFitness({
    ...fitnessInputs(ROOT, loadOperation(ASK_DIR)),
    model,
    journal: new Journal(join(home, 'journal')),
    onStep: (s) => !s.done && process.stderr.write(`${s.text}\n`),
  });
  print([`Model check: ${result.model}`, ...fitnessLines(result).map((l) => `${l.ok === true ? 'ok' : l.ok === false ? 'x ' : '  '} ${l.text}`), '', `${result.verdict}: ${result.reason}.`]);
  const spec = specOf(args);
  if (spec && !flag(args, '--ollama') && !flag(args, '--model')) {
    const kept = readConfig(home);
    writeConfig(home, { ...kept, model: { ...configFromSpec(spec), ...(kept.model ?? {}), format: result.format, fitness: { verdict: result.verdict, reason: result.reason, checked_at: result.checkedAt } } });
  }
  return result.verdict === 'not fit' ? 1 : 0;
}

async function scheduleCommand(args: Args): Promise<number> {
  const scheduler = systemScheduler(PLATFORM);
  const arg = args.rest[0] ?? '';
  if (arg === 'remove') {
    print([(await scheduler.remove()) ? 'Removed the digest from the schedule.' : 'No digest was scheduled.']);
    return 0;
  }
  const time = parseTime(arg);
  if (!time) return fail('Give a time, such as primerkit schedule 08:00, or primerkit schedule remove.');
  if (INSTALL === 'npx') return fail(NPX_SCHEDULE);
  const home = primerkitHome();
  const entry = digestEntry({ time, platform: PLATFORM, node: process.execPath, script: BIN, cwd: ROOT, log: join(home, 'digest', 'scheduled.log'), ...(process.env.PRIMERKIT_HOME ? { home } : {}) });
  print([`The entry primerkit adds to ${entry.where}:`, '', entry.text, '']);
  // A hosted model charges for the digest's packets every morning, so the entry says so.
  const model = (() => {
    try {
      return modelOf(args);
    } catch {
      return null;
    }
  })();
  if (model && !(await model.capabilities().then((c) => c.local, () => true))) print([`Every morning the digest sends its packets to ${model.label.split(', ')[1] ?? 'the provider'} on your key, which charges for them.`]);
  if (!args.flags.has('--yes')) {
    print(['Nothing was added. Run the same command with --yes to add it.']);
    return 0;
  }
  await scheduler.add(entry);
  writeConfig(home, { ...readConfig(home), digest: { ...(readConfig(home).digest ?? {}), time } });
  print([`Added. The digest runs every day at ${time}.`]);
  return 0;
}

async function doctor(): Promise<number> {
  const home = primerkitHome();
  const config = readConfig(home);
  // ok, x, or - for a step that is yours to take or leave, such as the digest's schedule.
  const lines: Array<[boolean | null, string]> = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  lines.push([major > 22 || (major === 22 && minor >= 12), `Node ${process.versions.node}${major > 22 || (major === 22 && minor >= 12) ? '' : ': primerkit needs 22.12 or later'}`]);
  const spec = config.model ? specFromConfig(config.model) : null;
  if (!spec) {
    lines.push([
      false,
      [
        'No model is set: primerkit model set, or the session.',
        '   With no model of your own, an AI app you use can answer with its model:',
        `   primerkit install --host <app> (${HOSTS.join(', ')}).`,
        '   primerkit ask --demo answers from saved briefings with no model.',
      ].join('\n'),
    ]);
  }
  else if (spec.kind === 'hosted') {
    const p = providerById(spec.provider);
    const set = p?.keyEnv.find((k) => process.env[k]?.trim());
    lines.push([Boolean(set), `${spec.name} on ${p?.name ?? spec.provider}: ${set ? `${set} is set` : `${p?.keyEnv[0] ?? 'its key'} is not set`}`]);
  } else {
    const base = spec.kind === 'ollama' ? `${spec.baseUrl ?? 'http://127.0.0.1:11434'}/api/tags` : `${spec.baseUrl}/models`;
    const body = await fetch(base).then((r) => (r.ok ? r.text() : null), () => null);
    const listed = body !== null && runtimeLists(body, spec.name);
    lines.push([listed, body === null ? `${spec.name}: ${spec.kind === 'ollama' ? 'Ollama is not running' : 'the server is not answering'}` : `${spec.name}: ${listed ? 'answering' : 'the runtime does not list it'}`]);
  }
  if (config.model?.fitness) lines.push([config.model.fitness.verdict !== 'not fit', `Model check: ${config.model.fitness.verdict}, ${config.model.fitness.checked_at.slice(0, 10)}`]);
  // A key PreReason refused on its last call is said from the config: the doctor makes no
  // call with the key.
  lines.push(keyLine(resolveKey(), config));
  const catalog = await fetchCatalog(VERSION).then((c) => c.length, () => 0);
  lines.push([catalog > 0, catalog ? `PreReason's catalog: ${catalog} live briefings` : "PreReason's catalog could not be read"]);
  const scheduled = await systemScheduler(PLATFORM).exists().catch(() => false);
  lines.push([scheduled ? true : null, scheduled ? `The digest is scheduled${config.digest?.time ? ` at ${config.digest.time}` : ''}` : 'The digest is not scheduled: primerkit schedule 08:00']);
  // A schedule that is there and a last run that failed is not ok.
  const last = readLatestDigest(home);
  if (last?.failed) lines.push([false, `The last digest, ${last.ranAt.slice(0, 16).replace('T', ' ')} UTC, did not run: ${last.failed}`]);
  print(lines.map(([ok, text]) => doctorLine(ok, text)));
  return lines.every(([ok]) => ok !== false) ? 0 : 1;
}

// The broker's questions go to a person at a terminal: terminal.ts says what that is.
const io = (): Io => ({ print, fail, ask: askLine, terminal: isTerminal() });

// A broker's connect screen opens with primerkit's mark, small, in the colours and glyphs
// --version uses on this terminal: the name and tagline alone where it draws plain text.
function connectIo(args: Args): Io {
  const { color, ascii } = modesOf(args);
  return { ...io(), mark: lockup(maker(ascii), ascii, 'small').map((l) => renderLine(l, color)) };
}

function connect(args: Args): Promise<number> {
  if (args.rest[0] === 'alpaca') return connectAlpaca(connectIo(args), args.flags.has('--remove'));
  if (args.rest[0] === 'robinhood') return connectRobinhood(connectIo(args), { ...(flag(args, '--host') ? { host: flag(args, '--host') } : {}), remove: args.flags.has('--remove'), yes: args.flags.has('--yes'), install: installOptions() });
  if (args.rest[0] !== 'prereason') return Promise.resolve(fail('primerkit connect prereason, primerkit connect alpaca, or primerkit connect robinhood --host <app>'));
  return connectPrereason({ print, fail, home: primerkitHome(), version: VERSION });
}

// PreReason on a key: a refusal it answers is kept, so the doctor says it.
function prereason(key: string | null): PreReasonClient {
  return prereasonOn(primerkitHome(), key, VERSION);
}

// brief --json: the briefing, or a metric, as PreReason serves it, each line numbered as a
// packet numbers it, so [macro.snapshot L12] is line 12 here. Kept as a snapshot, as an ask keeps it.
async function briefJson(args: Args): Promise<number> {
  const demo = args.flags.has('--demo');
  const id = args.rest[0]?.trim();
  if (!id) return failJson(new CodedError('Name a briefing or a metric: primerkit brief macro.snapshot --json', 'bad_input'));
  const key = demo ? null : resolveKey();
  if (!demo && !key) return failJson(new CodedError('PreReason is not connected. Run primerkit connect prereason, or set PREREASON_API_KEY.', 'no_key'));
  const home = primerkitHome();
  const data = demo ? new FixtureConnector(DEMO_BRIEFINGS) : prereason(key?.key ?? null);
  try {
    if (demo && !(data as FixtureConnector).has(id)) throw new CodedError(`${id} is not among the briefings saved for the demo. primerkit catalog --demo lists them.`, 'not_found');
    const block = isMetricId(id) && !demo ? await readMetric(data, id, (await liveMetrics(home).catch(() => [])).find((m) => m.id === id)?.name ?? id) : await readBriefing({ data, snapshots: demo ? null : new Snapshots(join(home, 'snapshots')) }, id, 'json');
    return printJson({
      ok: true,
      id: block.id,
      source: block.source,
      generated_at: block.generatedAt ?? null,
      fetched_at: block.fetchedAt,
      ...(demo ? { demo: { saved_on: DEMO_DATE } } : {}),
      lines: block.lines.map((text, i) => ({ n: block.numbers?.[i] ?? i + 1, text })),
    });
  } catch (error) {
    return failJson(error);
  } finally {
    if (data instanceof PreReasonClient && data.tier) keepTier(home, data.tier);
  }
}

// primerkit journal: the latest runs, or with --summary each day's sums, with the tokens the
// model reported and the cost where it is known. --json for a script.
// The journal's filters, from the flags: --operation, --briefing (a briefing or metric id),
// --outcome, --day (YYYY-MM-DD) and --search (words in a question or an answer).
function journalQueryOf(args: Args): JournalQuery | undefined {
  const q: JournalQuery = {};
  const set = (key: keyof JournalQuery, name: string) => {
    const v = flag(args, name)?.trim();
    if (v) q[key] = key === 'text' ? v : v.toLowerCase();
  };
  set('operation', '--operation');
  set('briefing', '--briefing');
  set('outcome', '--outcome');
  set('day', '--day');
  set('text', '--search');
  return Object.keys(q).length ? q : undefined;
}

function journalCommand(args: Args): number {
  const root = join(primerkitHome(), 'journal');
  const json = wantsJson(args);
  const query = journalQueryOf(args);
  const count = (name: string, fallback: number) => {
    const n = Number(flag(args, name) ?? fallback);
    return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : fallback;
  };
  if (query?.day && !/^\d{4}-\d{2}-\d{2}$/.test(query.day)) return json ? failJson(new CodedError(`--day takes a day as YYYY-MM-DD, not ${query.day}.`, 'bad_input')) : fail(`--day takes a day as YYYY-MM-DD, not ${query.day}.`);
  // One run, opened: its question, its answer or label, the lines it cites, its checks and what it spent.
  const runId = flag(args, '--run');
  if (runId) {
    const dir = RUN_ID.test(runId) ? journalFind(root, runId) : null;
    const run = dir ? journalRun(dir) : null;
    if (!run) return json ? failJson(new CodedError(`No run ${runId} is in the journal.`, 'not_found')) : fail(`No run ${runId} is in the journal. primerkit journal lists them.`);
    if (json) return printJson({ ok: true, run: (({ view: _view, ...r }) => r)(run) });
    print(journalRunLines(run));
    return 0;
  }
  if (args.flags.has('--summary')) {
    const days = journalSummary(root, { days: count('--days', 7), ...(query ? { query } : {}) });
    if (json) return printJson({ ok: true, days });
    if (!days.length) return (print(['The journal is empty.']), 0);
    print([
      'Day          Runs  Tokens in  Tokens out  Cost',
      ...days.map((d) => `${d.day}  ${String(d.runs).padStart(4)}  ${String(d.tokens.input).padStart(9)}  ${String(d.tokens.output).padStart(10)}  ${d.cost.priced_runs ? `$${d.cost.usd.toFixed(4)}` : '-'}${d.cost.unpriced_runs ? ` (${d.cost.unpriced_runs} with no price)` : ''}`),
      '',
      'Tokens are as each model reported them. A run answered inside an AI app reports none to primerkit; a model on this machine costs nothing.',
    ]);
    return 0;
  }
  const runs = journalEntries(root, { limit: count('--limit', 20), ...(query ? { query } : {}) });
  if (json) return printJson({ ok: true, ...(query ? { query } : {}), runs: runs.map(({ dir: _dir, ...e }) => e) });
  if (!runs.length) return (print([query ? `Nothing in the journal matches ${queryWords(query)}.` : 'The journal is empty.']), 0);
  print([
    ...runs.map((e) => `${e.run_id}  ${e.operation.padEnd(10)} ${(e.outcome ?? '-').padEnd(8)} ${e.tokens.input !== null ? `${e.tokens.input} in, ${e.tokens.output ?? 0} out` : `${e.tokens.packet ?? '-'} packet`}${e.cost ? `, $${e.cost.usd.toFixed(4)}${e.cost.basis === 'local' ? ' (local)' : ''}` : ''}${e.question ? `  ${e.question}` : ''}`),
    '',
    'primerkit journal --run <id> opens one.',
  ]);
  return 0;
}

// A briefing as a board, or a chart, printed once.
async function boardCommand(args: Args, command: 'brief' | 'chart'): Promise<number> {
  if (command === 'brief' && wantsJson(args)) return briefJson(args);
  const demo = args.flags.has('--demo');
  const home = primerkitHome();
  const today = new Date().toISOString().slice(0, 10);
  // The tier the config keeps, so a chart this key cannot draw is refused before any call.
  const tier = demo ? null : ((readConfig(home).prereason?.tier as Tier | undefined) ?? null);
  const req = parseBoard(command, args.rest.join(' '), demo ? undefined : { tier, today });
  if ('error' in req) return fail(req.error);
  const key = demo ? null : resolveKey();
  if (!demo && !key) return fail('PreReason is not connected. Run primerkit connect prereason, or set PREREASON_API_KEY.');
  const data = demo ? new FixtureConnector(DEMO_BRIEFINGS) : prereason(key?.key ?? null);
  const known = demo ? {} : { tier, lists: { briefings: () => liveCatalog(home), metrics: () => liveMetrics(home) }, hints: { catalog: 'primerkit catalog' } };
  let draw;
  try {
    draw = await loadBoard(req, { data, snapshots: demo ? null : new Snapshots(join(home, 'snapshots')), today, onStatus: (text) => process.stderr.write(`${text}\n`), ...known });
  } catch (error) {
    return fail(messageOf(error));
  } finally {
    // A tier PreReason named on any answer is kept, so the next chart knows it.
    if (data instanceof PreReasonClient && data.tier) keepTier(home, data.tier);
  }
  const { color, ascii } = modesOf(args);
  const t = maker(ascii);
  // Drawn to the window it is printed in: the terminal's width, or the grid's when the
  // output is not a terminal, and a chart as tall as the terminal's rows allow, less the
  // heading, the credit and the line the prompt comes back on.
  const columns = printColumns();
  const rows = process.stdout.isTTY && process.stdout.rows ? process.stdout.rows - 4 : undefined;
  const board = draw(t, ascii, roomFor(columns), rows);
  // A board of metrics read on their own names its read time itself, and its credit none.
  const time = board.generated ? board.generated.slice(11, 16) : board.readAt ? '' : new Date().toISOString().slice(11, 16);
  const printed = printedBoard(t, board, time, columns);
  print(printed.lines.map((l) => renderLine(l, color)));
  return printed.drawn ? 0 : 1;
}

// The comprehension benchmark on the model in use, or its share card.
async function benchCommand(args: Args): Promise<number> {
  const home = primerkitHome();
  const journal = new Journal(join(home, 'journal'));
  if (args.flags.has('--card')) {
    const latest = latestBench(journal.root);
    if (!latest) return fail('No benchmark has run on this machine yet: primerkit bench');
    const path = await writeShareCard(latest, join(home, 'cards'));
    print(['The share card, saved on this machine only. Nothing was uploaded:', `  ${path}`]);
    return 0;
  }
  let model: ModelAdapter | null;
  try {
    model = modelOf(args);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!model) return fail('No model is set. Choose one with primerkit model set, or pass the model flags.');
  const runs = Math.max(1, Math.min(5, Number(flag(args, '--runs') ?? BENCH_RUNS) || BENCH_RUNS));
  const inputs = fitnessInputs(ROOT, loadOperation(ASK_DIR));
  const items = benchItems(inputs.bench, inputs.benchData, { runs });
  const caps = await model.capabilities();
  if (!caps.local && !args.flags.has('--yes')) {
    const tokens = items.reduce((s, i) => s + i.packet.tokens.count, 0);
    print([`The benchmark sends ${items.length} packets, about ${Math.round(tokens / 1000)}k tokens in all, to ${model.label.split(', ')[1] ?? 'the provider'} on your key, which charges for them.`, 'Nothing was sent. Run the same command with --yes to run it.']);
    return 0;
  }
  const name = specOf(args)?.name ?? model.id;
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  const { records, replies, stopped } = await runBench(model, items, {
    signal: stop.signal,
    onStep: (p) => process.stderr.write(`${p.done + 1} of ${p.total}: ${p.item.briefing}, ${p.item.arm}, run ${p.item.run}\n`),
  });
  if (!records.length) return fail(`The benchmark did not run: ${stopped ?? 'nothing was answered'}.`);
  const result = summarizeBench(records, { model: name, fixtures: BENCH_FIXTURES });
  keepBench(journal, result, records, items, replies);
  print([
    `Benchmark  ${result.model} on the frozen fixtures of ${result.fixtures}`,
    ...benchLines(result),
    ...(stopped ? ['', `It stopped after ${records.length} of ${items.length} answers: ${stopped}.`] : []),
    '',
    'primerkit bench --card makes a share card, saved on this machine only.',
  ]);
  return stopped ? 1 : 0;
}

// A routine's problems, one a line, under the file they are in. A rate limit says how long to
// wait: the forward record once printed the bare sentence.
function routineProblems(error: unknown): number {
  if (!(error instanceof RoutineError)) return fail(withWait(error));
  const head = error.file === 'the backtest' ? 'The backtest cannot go on:' : `${error.file} needs a fix:`;
  return fail([head, ...error.problems.map((p) => `  ${p}`)].join('\n'));
}

// The person's routines: made, shown and tested. primerkit ships no rules.
async function routineCommand(args: Args): Promise<number> {
  const home = primerkitHome();
  const [name, sub] = args.rest;
  if (!name) {
    const names = listRoutines(home);
    print(names.length ? ['Your routines:', ...names.map((n) => `  ${n}`), '', 'primerkit routine <name> shows one.'] : ['No routines yet. primerkit routine new <name> makes one, in its own folder.']);
    return 0;
  }
  if (name === 'new') {
    if (!sub) return fail('Name the routine: primerkit routine new btc-rules');
    try {
      // On a free key it reads the days that key reads, so its first run does not fail.
      const made = newRoutine(home, sub, priceDaysFor(readConfig(home).prereason?.tier));
      print([
        `Made the routine ${sub} in ${tildePath(made.dir)}:`,
        '  routine.yaml   what it reads, its labels, and what each label holds',
        '  rules.md       your rules, in your own words; it holds none yet',
        '  tests.yaml     its logic tests; primerkit ships none',
        '  hypothesis.md  your hypothesis card, in your own words; primerkit ships none',
        '',
        'Write your rules in rules.md and your card in hypothesis.md, and put your own',
        'share, fee and spread in place of the placeholders in routine.yaml. Until rules',
        `are written, the routine returns no_rules_defined. primerkit routine ${sub} shows it.`,
      ]);
      return 0;
    } catch (error) {
      return routineProblems(error);
    }
  }
  // Every hypothesis and version tested on this machine, by name, never by result.
  if (name === 'registry') {
    print(registryText(registryPage(home)));
    return 0;
  }
  let routine: Routine;
  try {
    routine = loadRoutine(join(routinesDir(home), name));
  } catch (error) {
    if (error instanceof RoutineError && /there is no routine\.yaml/.test(error.problems[0] ?? '')) return fail(`There is no routine named ${name}. primerkit routine new ${name} makes one.`);
    return routineProblems(error);
  }
  if (!sub) {
    print([...routineText(routinePage(routine, { model: readConfig(home).model?.name ?? null })), '', 'The model only ever picks a label. What each label holds is yours, in routine.yaml.']);
    return 0;
  }
  if (sub === 'track') return trackCommand(args, routine, home);
  if (sub === 'intent') return routineIntent(io(), routine);
  if (sub === 'hypothesis') {
    print(hypothesisText(hypothesisPage(routine)));
    return 0;
  }
  if (sub === 'research') {
    // The ladder for the newest finished backtest, from its folder: no model, nothing read.
    const page = researchPage(routine, home, `primerkit backtest ${name} --replay`);
    if (!page) return fail(`${name} has no finished backtest yet. primerkit backtest ${name} --from <date> --to <date> runs one.`);
    print(researchText(page));
    return 0;
  }
  if (sub !== 'test') return fail(`primerkit routine ${name} ${sub} is not a routine command. There are primerkit routine ${name} test, track, intent, hypothesis and research.`);
  return routineTestCommand(args, routine, home);
}

// A routine's forward record: run once now and drawn, drawn alone, or put on the
// machine's scheduler to run every day, labels only, with no order going anywhere.
async function trackCommand(args: Args, routine: Routine, home: string): Promise<number> {
  const name = routine.spec.name;
  const { color, ascii } = modesOf(args);
  const t = maker(ascii);
  const columns = printColumns();
  const show = () => {
    const account = forwardAccount(readForward(routine), readForwardCloses(routine), routine.spec.fees.perTrade ?? 0);
    const board = forwardBoard(t, ascii, { routine: name, briefings: routine.spec.briefings, account, schedule: readForwardSchedule(routine) }, roomFor(columns));
    print(printedBoard(t, board, (board.generated ?? '').slice(11, 16), columns).lines.map((l) => renderLine(l, color)));
  };
  if (args.flags.has('--show')) {
    show();
    return 0;
  }
  if (args.flags.has('--stop')) {
    const removed = await systemScheduler(PLATFORM, runCommand, homedir(), trackJob(name)).remove();
    clearForwardSchedule(routine);
    print([removed ? `Taken off the schedule: ${name}'s forward record runs no more. Its record stays.` : `${name}'s forward record was not on the schedule.`]);
    return 0;
  }
  let model: ModelAdapter | null;
  try {
    model = routineModel(args, routine, home);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!model) return fail('No model is set. Choose one with primerkit model set, name one in routine.yaml, or pass the model flags.');
  const caps = await model.capabilities();
  const provider = model.label.split(', ')[1] ?? 'the provider';
  const at = flag(args, '--at');
  if (at !== undefined) {
    const time = parseTime(at);
    if (!time) return fail('--at is a time of day, such as 07:30.');
    if (INSTALL === 'npx') return fail(NPX_SCHEDULE);
    // A scheduled run uses the model this one does: the flags', carried into the entry, else
    // the routine's own, else the one primerkit is set to; a hosted one only with the yes
    // given here, since its provider charges every day.
    const job = trackJob(name, [...modelFlags(args), ...(caps.local ? [] : ['--yes'])]);
    const entry = jobEntry({ time, platform: PLATFORM, node: process.execPath, script: BIN, cwd: ROOT, log: join(forwardDir(routine), 'scheduled.log'), ...(process.env.PRIMERKIT_HOME ? { home: primerkitHome() } : {}) }, job);
    print([`The entry primerkit adds to ${entry.where}:`, '', entry.text, '']);
    if (!caps.local) print([`Every day it sends one packet to ${provider} on your key, which charges for it.`]);
    if (!args.flags.has('--yes')) {
      print(['Nothing was added. Run the same command with --yes to add it.']);
      return 0;
    }
    await systemScheduler(PLATFORM, runCommand, homedir(), job).add(entry);
    writeForwardSchedule(routine, time, entry.where);
    print([`Added. ${name}'s forward record runs every day at ${time}, ${entry.when.replace(/^every day at [0-9:]+, /, '')}.`]);
    return 0;
  }
  if (!caps.local && !args.flags.has('--yes')) {
    print([`The run sends one packet, and a repair turn if its answer fails its checks, to ${provider} on your key, which charges for it. Nothing was sent. Run the same command with --yes to run it.`]);
    return 0;
  }
  const key = resolveKey();
  if (!key) return fail('PreReason is not connected. Run primerkit connect prereason, or set PREREASON_API_KEY.');
  const source = routineSource(prereason(key.key));
  try {
    const outcome = await trackRoutine({
      base: loadOperation(ROUTINE_DIR),
      routine,
      model,
      source,
      format: routine.spec.format ?? caps.format,
      journal: new Journal(join(home, 'journal')),
      maxShare: readConfig(home).brokers?.alpaca?.caps?.max_position_share ?? null,
      tier: readConfig(home).prereason?.tier ?? null,
    });
    if (outcome.kind === 'no_rules_defined') return fail(`${tildePath(routine.rulesPath)} holds no rules, so there is nothing to run.`);
  } catch (error) {
    return routineProblems(error);
  }
  show();
  return 0;
}

// A routine's logic tests on the model it runs on: each test's day frozen the first time
// it is read, then its runs, one fresh call each.
async function routineTestCommand(args: Args, routine: Routine, home: string): Promise<number> {
  let tests: RoutineTests;
  try {
    tests = loadRoutineTests(routine);
    if (!readRules(routine)) return fail(`${tildePath(routine.rulesPath)} holds no rules yet, so ${routine.spec.name} returns no_rules_defined and there is nothing to test. Write your rules there, outside the comment.`);
  } catch (error) {
    return routineProblems(error);
  }
  if (!tests.tests.length) return fail(`${tildePath(join(routine.dir, 'tests.yaml'))} has no tests yet. Each test names a day, what was held, and the label your rules give; the file shows how.`);
  let model: ModelAdapter | null;
  try {
    model = routineModel(args, routine, home);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!model) return fail('No model is set. Choose one with primerkit model set, name one in routine.yaml, or pass the model flags.');
  const runsFlag = flag(args, '--runs');
  const runs = runsFlag === undefined ? tests.runs : Math.max(1, Math.min(20, Math.round(Number(runsFlag)) || tests.runs));
  const caps = await model.capabilities();
  const format = routine.spec.format ?? caps.format;
  const key = resolveKey();
  const source = key ? routineSource(prereason(key.key)) : null;
  const base = loadOperation(ROUTINE_DIR);
  if (!caps.local && !args.flags.has('--yes')) {
    // The days are frozen first, which asks PreReason only, so the count is the real one.
    let tokens = 0;
    try {
      const rules = readRules(routine);
      if (!rules) return fail(`${tildePath(routine.rulesPath)} holds no rules, so there is nothing to test.`);
      for (const test of tests.tests) {
        const day = await readFixture(routine, test.on, format, source);
        const last = day.closes.at(-1);
        if (!last) continue;
        const at = `${last.date}T00:00:00.000Z`;
        const blocks = [rulesBlock(rules, at), ...day.briefings, priceBlock(day.closes, at), positionBlock(holdingOf(test, day.closes), last, at)];
        tokens += buildPacket({ operation: routineOperation(base, routine, rules), question: ROUTINE_QUESTION, blocks }).tokens.count * runs;
      }
    } catch (error) {
      return routineProblems(error);
    }
    print([
      `The tests send ${tests.tests.length * runs} packets, about ${Math.max(1, Math.round(tokens / 1000))}k tokens in all, and a repair turn for any answer`,
      `that fails its checks, to ${model.label.split(', ')[1] ?? 'the provider'} on your key, which charges for them.`,
      'Nothing was sent. Run the same command with --yes to run them.',
    ]);
    return 0;
  }
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  let outcome;
  try {
    outcome = await testRoutine({
      base,
      routine,
      tests,
      model,
      source,
      format,
      runs,
      journal: new Journal(join(home, 'journal')),
      signal: stop.signal,
      onRun: (s) => {
        const test = tests.tests[s.test];
        if (s.done && test) process.stderr.write(`test ${s.test + 1} of ${s.tests} (${test.on}), run ${s.run} of ${s.runs}: ${s.done.label ?? 'no label'}, ${s.done.passed ? 'passed' : `missed: ${s.done.why}`}\n`);
      },
    });
  } catch (error) {
    return routineProblems(error);
  }
  if (outcome.kind === 'no_rules_defined') return fail(`${tildePath(outcome.rulesPath)} holds no rules, so there is nothing to test.`);
  if (outcome.kind === 'no_tests') return fail('tests.yaml has no tests yet.');
  const { report } = outcome;
  print([
    `Logic tests  ${routine.spec.name} on ${report.model}`,
    ...testLines(report).map((l) => `  ${l}`),
    '',
    `${testSummary(report)}.`,
    `Kept in ${tildePath(outcome.path)}; each run's packet and answer are in the journal.`,
    'This tests whether your model applies your rules the same way each time, not whether the rules make money.',
  ]);
  return report.stopped || report.passed < report.total ? 1 : 0;
}

// The model a routine runs on: the flags, then its own in routine.yaml, then the one
// primerkit is set to.
function routineModel(args: Args, routine: Routine, home: string): ModelAdapter | null {
  const own = !flaggedSpecOf(args) && routine.spec.model ? specFromConfig(routine.spec.model) : null;
  return own ? modelFor({ kind: 'model', spec: own }, process.env, readConfig(home).model) : modelOf(args);
}

// The key's tier, as PreReason names it on one call; the one the config keeps otherwise.
async function tierFor(client: PreReasonClient | null, home: string): Promise<string | null> {
  const kept = readConfig(home).prereason?.tier ?? null;
  if (!client) return kept;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await client.bitcoinHistory({ from: yesterday, to: yesterday }).catch(() => null);
  if (client.tier && client.tier !== kept) keepTier(home, client.tier);
  return client.tier ?? kept;
}

// A routine's backtest: the plan first, then the run, one tick in each arm at a time. Ctrl+C
// stops it and keeps what ran, and --resume carries on at the next tick. A hosted model
// runs only on --yes, since its provider charges for every call.
async function backtestCommand(args: Args): Promise<number> {
  const home = primerkitHome();
  const name = args.rest[0];
  if (!name) return fail('Name the routine: primerkit backtest btc-rules --from 2026-06-01 --to 2026-08-31');
  let routine: Routine;
  try {
    routine = loadRoutine(join(routinesDir(home), name));
  } catch (error) {
    if (error instanceof RoutineError && /there is no routine\.yaml/.test(error.problems[0] ?? '')) return fail(`There is no routine named ${name}. primerkit routine new ${name} makes one.`);
    return routineProblems(error);
  }
  const { color, ascii } = modesOf(args);
  const t = maker(ascii);
  const columns = printColumns();
  const room = roomFor(columns);
  const rows = process.stdout.isTTY && process.stdout.rows ? process.stdout.rows - 4 : undefined;
  const show = (board: Parameters<typeof printedBoard>[1], closing?: Parameters<typeof printedBoard>[4]) =>
    print(printedBoard(t, board, (board.generated ?? new Date().toISOString()).slice(11, 16), columns, closing).lines.map((l) => renderLine(l, color)));
  // A finished run's report, drawn again from its folder: no model and no PreReason read.
  if (args.flags.has('--replay')) {
    const runId = flag(args, '--run');
    const replay = replayOf(routine, runId);
    if (!replay) return fail(runId ? `${name} has no finished backtest ${runId}.` : `${name} has no finished backtest yet. primerkit backtest ${name} --from <date> --to <date> runs one.`);
    show(taller(t, (height) => backtestBoard(t, ascii, replay, room, height), SERIES_ROWS, room, rows));
    return 0;
  }
  const resume = args.flags.has('--resume');
  const from = flag(args, '--from');
  const to = flag(args, '--to');
  if (!resume && (!from || !to)) return fail('Give the window: --from 2026-06-01 --to 2026-08-31, ending yesterday at the latest.');
  const everyFlag = flag(args, '--every');
  const every = everyFlag === 'day' || everyFlag === 'daily' ? 'day' : everyFlag === 'week' || everyFlag === 'weekly' ? 'week' : undefined;
  if (everyFlag && !every) return fail('--every is day or week.');
  let model: ModelAdapter | null;
  try {
    model = routineModel(args, routine, home);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!model) return fail('No model is set. Choose one with primerkit model set, name one in routine.yaml, or pass the model flags.');
  const caps = await model.capabilities();
  const format = routine.spec.format ?? caps.format;
  const key = resolveKey();
  const client = key ? prereason(key.key) : null;
  const source = client ? routineSource(client) : null;
  const journal = new Journal(join(home, 'journal'));
  const base = loadOperation(ROUTINE_DIR);
  const seconds = measuredSeconds(journal.root, model.id);
  // The model by its own name, as its maker publishes its cutoff: the label's first part.
  const modelName = model.label.split(', ')[0] ?? model.id;
  const cutoffFlag = flag(args, '--cutoff');
  if (cutoffFlag !== undefined) {
    if (!isMonth(cutoffFlag)) return fail('--cutoff is a month, such as 2025-07, as the model card gives it.');
    const config = readConfig(home);
    writeConfig(home, { ...config, cutoffs: { ...(config.cutoffs ?? {}), [modelName]: cutoffFlag } });
    print([`Kept: ${modelName}'s training reaches ${cutoffFlag}, in config.yaml, for every backtest after.`]);
  }
  const insideTraining = args.flags.has('--inside-training');
  const onMemory = (a: { date: string; price: number | null; truth: number; within: boolean }) =>
    process.stderr.write(`memory check, ${a.date}: ${a.price === null ? 'no price given' : `$${a.price.toLocaleString('en-US')} against the close of $${a.truth.toLocaleString('en-US')}${a.within ? ', within 5%' : ''}`}\n`);
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  const started = Date.now();
  let done0 = 0;
  const onTick = (step: { done: number; total: number; record: Parameters<typeof tickLine>[0] }) => {
    const each = (Date.now() - started) / Math.max(1, step.done - done0);
    const left = Math.round(((step.total - step.done) * each) / 60_000);
    const time = left < 1 ? 'under a minute' : left < 60 ? `about ${left} min` : `about ${(left / 60).toFixed(1)} h`;
    process.stderr.write(`${tickLine(step.record)} (${step.done} of ${step.total}${step.done < step.total ? `, ${time} left` : ''})\n`);
  };
  let outcome: BacktestOutcome;
  try {
    if (resume) {
      const open = listBacktests(routine).find((b) => !b.done);
      if (!open) return fail(`${name} has no stopped backtest to carry on. primerkit backtest ${name} --from <date> --to <date> starts one.`);
      done0 = open.ticks;
      print([`Carrying on ${open.run.runId}, ${open.run.from} to ${open.run.to}: ${open.ticks} of ${open.run.ticks.length * open.run.arms.length * open.run.reps} ticks done.`]);
      outcome = await runBacktest({ base, routine, model, source, dir: open.dir, journal, signal: stop.signal, onTick, onMemory, insideTraining });
    } else {
      if (!from || !to) return fail('Give the window: --from 2026-06-01 --to 2026-08-31, ending yesterday at the latest.');
      const reps = Number(flag(args, '--reps') ?? 1);
      const maxShare = readConfig(home).brokers?.alpaca?.caps?.max_position_share ?? null;
      const tier = await tierFor(client, home);
      const cutoff = cutoffOf(modelName, readConfig(home).cutoffs);
      const plan = planBacktest(routine, { from, to, reps, maxShare, insideTraining, ...(every ? { every } : {}) }, { tier, today: new Date().toISOString().slice(0, 10), format, secondsPerCall: seconds, model: modelName, cutoff });
      show(planBoard(t, planLines(plan, { model: model.label, local: caps.local, secondsPerCall: seconds }), room), [t('muted', plan.problems.length ? 'It cannot start until each of these is fixed.' : 'The plan, before anything is read or asked.')]);
      if (plan.problems.length) return 1;
      if (!caps.local && !args.flags.has('--yes')) {
        const first = plan.ticks[0] as string;
        const briefings = plan.arms.includes('treatment') ? await briefingsOn(routine, first, format, source) : [];
        const prepared = prepareRoutine(base, routine, briefings);
        const tokens = (prepared ? prepared.packet.tokens.count * plan.calls : 0) + memoryPacket(first).tokens.count * plan.memoryCalls;
        print([
          '',
          `The run sends ${plan.calls + plan.memoryCalls} packets, the memory check's ${plan.memoryCalls} among them, about ${Math.max(1, Math.round(tokens / 1000))}k tokens in all, and a repair turn for any answer that fails its checks,`,
          `to ${model.label.split(', ')[1] ?? 'the provider'} on your key, which charges for them. Nothing was sent. Run the same command with --yes to start it.`,
        ]);
        return 0;
      }
      print(['', 'Starting. Ctrl+C stops it and keeps what ran; --resume carries on.']);
      outcome = await runBacktest({ base, routine, model, source, plan, journal, signal: stop.signal, onTick, onMemory });
    }
  } catch (error) {
    return routineProblems(error);
  }
  if (outcome.kind === 'no_rules_defined') return fail(`${tildePath(routine.rulesPath)} holds no rules, so there is nothing to backtest.`);
  if (outcome.kind === 'remembered') {
    const run = listBacktests(routine).find((b) => b.dir === outcome.dir)?.run;
    print(['']);
    show(
      memoryBoard(
        t,
        {
          routine: name,
          from: run?.from ?? '',
          to: run?.to ?? '',
          model: run?.modelName ?? modelName,
          answers: outcome.memory?.answers ?? [],
          stopped: outcome.stopped ?? '',
          next: `primerkit backtest ${name} --resume --inside-training runs it, labelled inside the model's training window.`,
        },
        room,
      ),
    );
    return 1;
  }
  if (outcome.kind === 'stopped') {
    print([`Stopped after ${outcome.records.length} ticks. primerkit backtest ${name} --resume carries on at the next one.`]);
    return 1;
  }
  const replay = readReplay(outcome.dir);
  print(['']);
  if (replay) show(taller(t, (height) => backtestBoard(t, ascii, replay, room, height), SERIES_ROWS, room, rows));
  else print(reportLines(outcome.report as NonNullable<BacktestOutcome['report']>));
  print([`Kept in ${tildePath(outcome.dir)}; every answer is in the journal. primerkit backtest ${name} --replay draws it again.`]);
  return 0;
}

// The local MCP server an AI app starts. Its stdout carries only the server's messages.
async function mcpCommand(args: Args): Promise<number> {
  const runs = new HostRuns(hostDeps({ version: VERSION, demo: args.flags.has('--demo') }));
  await serveMcp(runs, { input: process.stdin, output: process.stdout }, { version: VERSION });
  return 0;
}

// primerkit inside an AI app: the change is shown, and made only with --yes.
async function installCommand(args: Args, remove: boolean): Promise<number> {
  const host = flag(args, '--host') as Host | undefined;
  if (!host || !HOSTS.includes(host)) return fail(`Say which app: ${HOSTS.map((h) => `--host ${h}`).join(', ')}.`);
  const plan = planInstall(host, installOptions());
  if (!args.flags.has('--yes')) {
    // An uninstall shows its own steps, the ones --yes takes, never the install's.
    print([
      remove ? `Taking primerkit out of ${plan.name} makes these changes, each only where primerkit's part is found:` : `Putting primerkit into ${plan.name} makes these changes:`,
      ...(remove ? describeRemoval(plan) : describePlan(plan)).map((l) => `  ${l}`),
      '',
    ]);
    // In a terminal the command asks; a script says --yes.
    const asked = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const yes = asked && (await askLine('Make them? Type yes to make them: ')).trim().toLowerCase() === 'yes';
    if (!yes) {
      print([asked ? 'Nothing was changed.' : 'Nothing was changed. Run the same command with --yes to make them.']);
      return 0;
    }
  }
  try {
    const done = remove ? await removeInstall(plan, systemRunner) : await applyInstall(plan, systemRunner);
    const next =
      host === 'claude-code'
        ? 'In Claude Code, type /primerkit-ask with your question.'
        : host === 'lm-studio'
          ? 'In LM Studio, ask a model that can use tools your question; LM Studio asks you before a call to primerkit, until you tell it to always allow that tool.'
          : `In ${plan.name}, ask it to use the primerkit-ask skill.`;
    print([...done.map((d) => `${d}.`), remove ? (done.length ? 'Done.' : 'primerkit was not in it.') : `Done. ${next}`]);
    return 0;
  } catch (error) {
    return fail((error as Error).message);
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  // Where primerkit keeps its files for this run: a scheduled run is told it this way, as
  // the scheduler starts it without PRIMERKIT_HOME.
  const home = flag(args, '--home');
  if (home) process.env.PRIMERKIT_HOME = home;
  const problem = flagProblem(args.flags);
  if (problem && !args.flags.has('--help')) return fail(problem);
  if (args.flags.has('--help') || args.command === 'help') {
    process.stdout.write(usage());
    return 0;
  }
  if (args.flags.has('--version')) {
    const { color, ascii } = modesOf(args);
    print([...lockup(maker(ascii), ascii, 'large').map((l) => renderLine(l, color)), '', ` primerkit ${VERSION}`]);
    return 0;
  }
  switch (args.command) {
    case null:
      return session(args);
    case 'ask':
      return ask(args);
    case 'catalog':
      return catalogCommand(args);
    case 'run':
      return runDigestCommand(args);
    case 'model':
      return modelCommand(args);
    case 'schedule':
      return scheduleCommand(args);
    case 'doctor':
      return doctor();
    case 'connect':
      return connect(args);
    case 'intent':
      if (args.rest[0] === 'approve') return approveCommand(io(), args.rest[1]);
      return intentCommand(io(), args.rest, () => new Date(), (name) => flag(args, name), () => markedNow(primerkitHome()));
    case 'broker':
      return brokerCommand(io(), { sub: args.rest[0], rest: args.rest.slice(1), flag: (name) => flag(args, name), has: (name) => args.flags.has(name) });
    case 'bench':
      return benchCommand(args);
    case 'routine':
      return routineCommand(args);
    case 'backtest':
      return backtestCommand(args);
    case 'brief':
      return boardCommand(args, 'brief');
    case 'chart':
      return boardCommand(args, 'chart');
    case 'mcp':
      return mcpCommand(args);
    case 'journal':
      return journalCommand(args);
    case 'positions':
      return positionsCommand(io(), wantsJson(args));
    case 'install':
      return installCommand(args, false);
    case 'uninstall':
      return installCommand(args, true);
    default:
      return fail(`There is no command ${args.command}.\n\n${usage()}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
