import { join } from 'node:path';
import {
  RoutineError,
  intentRows,
  parseJournalQuery,
  queryWords,
  type JournalQuery,
  RunCancelled,
  benchItems,
  keepBench,
  listRoutines,
  loadRoutine,
  loadRoutineTests,
  newRoutine,
  priceDaysFor,
  readRules,
  replayOf,
  routinesDir,
  trackRoutine,
  runBench,
  summarizeBench,
  testRows,
  testRoutine,
  testSummary,
  tokenCount,
  type BenchFile,
  type BenchResult,
  type Config,
  type Journal,
  type ModelAdapter,
  type Operation,
  type PacketFormat,
  type Routine,
  type RoutineTests,
  type Snapshots,
} from '@primerkit/core';
import { ENV_KEY_REFUSED, briefingsByArea, coverage, metricsByArea, readableBy, smallestFree, withWait, type CatalogEntry, type ClaimEvent, type MetricEntry, type ResolvedKey, type Tier } from '@primerkit/connector-prereason';
import { FITNESS_ASKING, fitnessLines, isServerUrl, listPrice, providerById, providersWithKeys, serverUrl, type FitnessResult, type FitnessStep, type ListPrice, type MachineCheck, type ModelSpec, type PullProgress, type WebSearcher } from '@primerkit/models';
import { maker } from '@primerkit/ui';
import { chartDraws, loadBoard, nextRange, parseBoard, requestTier, type BoardEnv, type BoardRequest, type Draw } from './board-load';
import type { Board } from './boards';
import { latestBench, writeShareCard } from './card';
import { PLAN_SIZES, briefingStatus, comparePlan, planRead, runCompare, webStatusWhileRunning, type ComparePlan } from './compare';
import { runDigest, type DigestView } from './digest';
import { askBriefings, messageOf, readBriefing, type Briefings } from './engine';
import { FIRST_QUESTIONS, LATER_COMMANDS } from './first-run';
import { MONTHS } from './journal-view';
import { withDaySummaries } from './journal-find';
import type { HoldingsView } from './positions';
import { RECENT_RUNS } from './screens';
import { functionOf, menuRows, type Menu } from './menu';
import { hypothesisPage, registryPage, researchPage } from './research';
import { routinePage, routineSource, rulesPage, tildePath } from './routine';
import { parseTime, type Platform, type ScheduleEntry, type Scheduler } from './schedule';
import { scrollSpan } from './screens';
import { configFromSpec, defaultWatchlist, specFromConfig, withFormat } from './setup';
import { initialState, sizeFor, type Entry, type JournalRow, type Key, type ModelChoice, type State, type Step } from './state';

export type { Briefings } from './engine';

// Everything the session reaches outside itself, so the demo and the tests can hand it
// saved briefings, a fixed machine and a scripted model.
export interface SessionDeps {
  // The demo's day as people read it, and as the boards count their days back from it.
  demo: { date: string; day?: string } | null;
  env: Record<string, string | undefined>;
  platform: Platform;
  config: { read(): Config; write(config: Config): void } | null; // null keeps nothing, as in the demo
  checkMachine(): Promise<MachineCheck>;
  catalog(): Promise<CatalogEntry[]>;
  // PreReason's keyless list of metrics; absent where metrics are not offered, as in the demo.
  metricCatalog?(): Promise<MetricEntry[]>;
  resolveKey(): ResolvedKey | null;
  connect(onEvent: (event: ClaimEvent) => void): { cancel(): void };
  briefings(key: string | null): Briefings;
  model(choice: ModelChoice): ModelAdapter;
  listModels(provider: string): Promise<string[]>;
  pull(name: string, onProgress: (p: PullProgress) => void, signal: AbortSignal): Promise<void>;
  fitness(model: ModelAdapter, onStep: (s: FitnessStep) => void, signal: AbortSignal): Promise<FitnessResult>;
  fitnessPlan(model: ModelAdapter, format: PacketFormat): { calls: number; tokens: number };
  operation: Operation;
  digestOperation: Operation;
  routineOperation?: Operation; // the routine operation each routine fills in; absent in the demo
  journal: Journal | null;
  snapshots: Snapshots | null;
  home: string | null; // where the digest keeps its state; null in the demo
  latestDigest(): DigestView | null;
  scheduler: Scheduler | null; // null in the demo
  scheduleEntry(time: string): ScheduleEntry;
  journalRows(query?: JournalQuery): JournalRow[];
  // /positions: the Alpaca paper holdings, read where its mode reads; absent in the demo.
  holdings?: () => Promise<HoldingsView>;
  journalOpen(dir: string): { title: string; text: string };
  openLink(url: string): boolean;
  copy(text: string): boolean;
  // Putting primerkit into an AI app found on this machine: the change as lines, and a
  // way to make it. Absent in the demo, which changes nothing.
  installInto?: (app: string) => { lines: string[]; apply(): Promise<string[]> } | null;
  // The benchmark's frozen questions and briefings, and where share cards are saved.
  benchInputs?: () => { file: BenchFile; data: (briefing: string, format: PacketFormat) => string; fixtures: string };
  cardDir?: string | null;
  // The model's own web search on the person's key, for /compare: Anthropic's tool for a hosted
  // Claude model, null for any other. Absent in the demo, which sends nothing.
  webSearch?: (spec: ModelSpec) => WebSearcher | null;
  now?: () => Date;
}

const LOCAL_SERVER = 'http://127.0.0.1:1234/v1';

// Text less its last character, which an emoji is though it takes two UTF-16 units.
const dropLast = (text: string): string => Array.from(text).slice(0, -1).join('');

export class Session {
  state: State;
  private readonly listeners: Array<() => void> = [];
  private readonly work = new Set<Promise<unknown>>();
  private claim: { cancel(): void } | null = null;
  private stop: AbortController | null = null;
  // Why the model config.yaml keeps could not be used, until another is chosen.
  private modelReason: string | null = null;
  private model: ModelAdapter | null = null;
  private data: Briefings | null = null;
  // The key in use, and whether PreReason refused it on a read (revoked in its settings, say):
  // a refused key is said once, and /connect prereason then connects again.
  private keyInUse: ResolvedKey | null = null;
  private refused = false;
  // The one call that learns the key's tier, while it runs; a new key starts it again.
  private tierProbe: Promise<void> | null = null;
  private entries: CatalogEntry[] | null = null;
  private metricEntries: MetricEntry[] | null = null;
  private firstEntry: Entry | null = null;
  private pending: ModelSpec | null = null; // the model being checked
  private lastBench: BenchResult | null = null;
  private inApp: string | null = null; // the AI app primerkit was put into during this first run

  constructor(private readonly deps: SessionDeps) {
    this.state = initialState(deps.demo, deps.platform === 'win32' ? 'Task Scheduler' : deps.platform === 'darwin' ? 'launchd' : 'cron');
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  // Resolves once the work the session started has finished, for the walk and tests.
  async idle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  // The spinner turns only while something runs.
  get animating(): boolean {
    const s = this.state.step;
    if (s.name === 'model' && !s.check) return true;
    if (s.name === 'model-list' && !s.models && !s.error) return true;
    if (s.name === 'model-custom' && s.stage === 'pull' && !s.error) return true;
    if (s.name === 'fitness' && s.phase === 'running') return true;
    if (s.name === 'connect' && (s.phase === 'starting' || s.phase === 'waiting' || s.phase === 'tier')) return true;
    if (s.name === 'digest' && s.stage === 'adding') return true;
    if (s.name === 'board' && !s.view && !s.error) return true;
    if (s.name === 'install' && s.phase === 'applying') return true;
    if (s.name === 'first-question' && s.entry?.kind === 'running') return true;
    if (s.name === 'compare' && (s.phase === 'planning' || s.phase === 'running')) return true;
    return s.name === 'home' && this.state.feed.some((e) => e.kind === 'running');
  }

  tick(): void {
    if (this.animating) this.set({ frame: this.state.frame + 1 });
  }

  // The window's size, which every screen is drawn in. A board open at the time is
  // drawn again for the new width, since a board fits the room it is given.
  resize(columns: number, rows: number): void {
    const size = sizeFor(columns, rows);
    const now = this.state.size;
    if (size.width === now.width && size.columns === now.columns && size.height === now.height) return;
    this.set({ size });
    if (this.state.step.name === 'board' && this.state.step.view && this.boardDraw) this.patchStep('board', { view: this.boardViews(this.boardDraw) });
  }

  private boardDraw: { draw: Draw; at: string } | null = null;

  // A board drawn both ways, since the terminal decides between Unicode and plain when
  // it draws, in the room inside a block across the window's whole width, and in the rows
  // the board screen leaves it: the window's, less the top line, its blank, the heading,
  // the credit, the keys and a blank last row (a narrow window's heading and keys may
  // each take two).
  private boardViews({ draw, at }: { draw: Draw; at: string }): { unicode: Board; plain: Board } {
    const { columns, height } = this.state.size;
    // A row fewer for the panel's status strip.
    const rows = height - 7 - (columns < 64 ? 2 : 0);
    const drawn = (plain: boolean) => {
      const board = draw(maker(plain), plain, columns - 4, rows);
      return board.generated || board.readAt ? board : { ...board, generated: at };
    };
    return { unicode: drawn(false), plain: drawn(true) };
  }

  start(): void {
    const config = this.deps.config?.read() ?? {};
    if (this.deps.demo || !config.disclaimer_accepted_at) return this.go({ name: 'welcome' });
    if (!config.first_run_done_at || !config.model) return this.enterModel();
    // A later start opens the home screen, with the model, the key and the digest it had.
    const spec = specFromConfig(config.model);
    // The model config.yaml keeps may not be usable here, such as a hosted one whose key is
    // not set in this terminal: it is then chosen again, with the reason, and the key, the
    // watchlist and today's digest are taken up all the same.
    let unusable: string | null = null;
    try {
      this.useModel({ kind: 'model', spec });
    } catch (error) {
      unusable = `${spec.name} cannot be used: ${messageOf(error).replace(/\.$/, '')}. Choose a model, or set its key and start again.`;
    }
    this.useKey(this.deps.resolveKey());
    const digest = this.deps.latestDigest();
    // Today's digest is today's on this machine's clock, as its schedule is: an 08:00 run in
    // Tokyo is the day before in UTC.
    const now = this.now();
    const today = now.toDateString();
    // The opening greets by this clock's hour, and says what changed since the newest run
    // the journal holds. A journal that cannot be read leaves that line out.
    let last: JournalRow | undefined;
    let runs = 0;
    let recent: JournalRow[] = [];
    try {
      const rows = this.deps.journalRows();
      last = rows[0];
      recent = rows.slice(0, RECENT_RUNS);
      const day = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]}`;
      runs = rows.filter((r) => r.day.trim() === day).length;
    } catch {
      last = undefined;
    }
    this.set({
      firstRun: false,
      runs,
      recent,
      tier: config.prereason?.tier ?? null,
      watchlist: config.watchlist ?? [],
      digest: digest && new Date(digest.ranAt).toDateString() === today ? digest : null,
      opening: {
        hour: now.getHours(),
        day: Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000),
        verdict: config.model?.fitness?.verdict ?? null,
        scheduled: Boolean(config.digest?.time),
        lastRun: last ? { day: last.day, time: last.time, title: last.title, operation: last.operation } : null,
      },
    });
    if (unusable) {
      this.modelReason = unusable;
      return this.enterModel();
    }
    this.go({ name: 'home' });
  }

  key(k: Key): void {
    if (k.name === 'ctrl-d') return this.leave();
    switch (this.state.step.name) {
      case 'welcome':
        if (k.name === 'enter') return this.accept();
        if (k.name === 'escape' || k.name === 'ctrl-c') return this.leave();
        return;
      case 'model':
        return this.keyModel(k);
      case 'model-none':
        if (k.name === 'enter') return this.enterModel();
        if (k.name === 'char' && k.char === 't') return this.enterCustom();
        if (k.name === 'escape' || k.name === 'ctrl-c') return this.back();
        return;
      case 'model-list':
        return this.keyModelList(k);
      case 'model-custom':
        return this.keyCustom(k);
      case 'fitness':
        return this.keyFitness(k);
      case 'connect':
        return this.keyConnect(k);
      case 'first-question':
        return this.keyFirstQuestion(k);
      case 'digest':
        return this.keyDigest(k);
      case 'journal':
        return this.keyJournal(k);
      case 'board':
        return this.keyBoard(k);
      case 'install':
        return this.keyInstall(k);
      case 'compare':
        return this.keyCompare(k);
      case 'home':
        return this.keyHome(k);
    }
  }

  // ---------------------------------------------------------------- state

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private go(step: Step): void {
    this.set({ step, notice: null });
  }

  private patchStep<N extends Step['name']>(name: N, patch: Partial<Extract<Step, { name: N }>>): void {
    if (this.state.step.name === name) this.set({ step: { ...this.state.step, ...patch } as Step });
  }

  private track(p: Promise<unknown>): void {
    const done = p.catch(() => undefined).finally(() => this.work.delete(done));
    this.work.add(done);
  }

  private saveConfig(patch: Partial<Config>): void {
    if (!this.deps.config) return;
    this.deps.config.write({ ...this.deps.config.read(), ...patch });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // The window closed under the session: it leaves as Ctrl+D does, and ends what it
  // started, the PreReason bridge's claim among them.
  quit(): void {
    this.leave();
  }

  private leave(): void {
    this.claim?.cancel();
    this.claim = null;
    this.stop?.abort();
    this.stopBoard();
    this.set({ done: true });
  }

  // Escape: during the first run it leaves; in a session it goes home.
  private back(): void {
    if (this.state.firstRun) return this.leave();
    this.go({ name: 'home' });
  }

  private loadCatalog(): Promise<CatalogEntry[]> {
    if (this.entries) return Promise.resolve(this.entries);
    return this.deps.catalog().then(
      (entries) => (this.entries = entries.length ? entries : null) ?? [],
      () => [],
    );
  }

  // The metric list is read once a session, like the catalog; a failed read is tried again
  // next time.
  private loadMetrics(): Promise<MetricEntry[]> {
    if (this.metricEntries) return Promise.resolve(this.metricEntries);
    if (!this.deps.metricCatalog) return Promise.resolve([]);
    return this.deps.metricCatalog().then((entries) => (this.metricEntries = entries.length ? entries : null) ?? []);
  }

  // /catalog: every briefing this key reads, and every metric, by area.
  private catalogCommand(all = false): void {
    const question = all ? '/catalog all' : '/catalog';
    const put = this.placer('home');
    // Ctrl+C stops it, as the running line says: what is read after that is not shown.
    const stop = new AbortController();
    this.stop = stop;
    const stopped = new Promise<'stopped'>((resolve) => stop.signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
    put({ kind: 'running', question, running: { phase: 'working', briefings: [], tokens: null, text: 'reading the catalog' } });
    this.track(
      (async () => {
        try {
          const data = this.data;
          const reading = (async () => {
            const briefings = readableBy(await this.loadCatalog(), (this.state.tier as Tier | null) ?? 'free').filter((b) => !data?.has || data.has(b.id));
            let metrics: MetricEntry[] | null = null;
            if (this.deps.metricCatalog && (!data || data.metricBlock)) metrics = await this.loadMetrics().catch(() => null);
            return { briefings, metrics };
          })();
          reading.catch(() => undefined);
          const read = await Promise.race([reading, stopped]);
          if (read === 'stopped') {
            put(null);
            return this.set({ notice: 'Stopped.' });
          }
          const { briefings, metrics } = read;
          if (!briefings.length && !metrics?.length) return put({ kind: 'failed', question, message: 'The catalog could not be read.', detail: 'Check the connection and try /catalog again.' });
          put({ kind: 'catalog', question, briefings: briefingsByArea(briefings), metrics: metrics?.length ? metricsByArea(metrics) : null, saved: this.deps.demo?.date ?? null, all });
        } finally {
          if (this.stop === stop) this.stop = null;
        }
      })(),
    );
  }

  // ---------------------------------------------------------------- the model

  private accept(): void {
    this.saveConfig({ disclaimer_accepted_at: this.now().toISOString() });
    this.enterModel();
  }

  private enterModel(): void {
    // Why the model is chosen again, where it is: said on the picker each time it is drawn
    // anew, as a step that is entered clears the notice.
    const reason = (): void => {
      if (this.modelReason) this.set({ notice: this.modelReason });
    };
    this.go({ name: 'model', check: null, choices: [], cursor: 0 });
    reason();
    this.track(
      this.deps.checkMachine().then((check) => {
        const local: ModelChoice[] = check.local.map((m) => ({
          kind: 'model' as const,
          spec: m.runtime === 'ollama' ? { kind: 'ollama' as const, name: m.name, baseUrl: m.baseUrl } : { kind: 'openai-compatible' as const, name: m.name, baseUrl: m.baseUrl },
        }));
        const hosted: ModelChoice[] = providersWithKeys(this.deps.env).map((p) => ({ kind: 'provider' as const, provider: p.id }));
        const apps: ModelChoice[] = check.apps.map((app) => ({ kind: 'app' as const, app }));
        const kept = this.keptChoice();
        const choices: ModelChoice[] = [...(kept ? [kept] : []), ...apps, ...(this.deps.demo ? [{ kind: 'demo' as const }] : []), ...local, ...hosted, { kind: 'custom' as const }];
        this.set({ machine: check });
        // The cursor starts on the kept model, where there is one, or else on the first way
        // to work here, as the apps come first.
        if (choices.length === 1) this.go({ name: 'model-none', check });
        else this.go({ name: 'model', check, choices, cursor: kept ? 0 : Math.min(apps.length, choices.length - 1) });
        reason();
      }),
    );
  }

  // A first run left after the check: config.yaml keeps the model it checked, with its
  // verdict, from the moment the result shows. Started again, the model step offers that
  // model first, so a fit model is not checked twice. A model found not fit, or one that
  // cannot be used here (a hosted one whose key is not set), is not offered.
  private keptChoice(): Extract<ModelChoice, { kind: 'kept' }> | null {
    if (this.deps.demo || !this.state.firstRun || this.modelReason) return null;
    const kept = this.deps.config?.read().model;
    const fitness = kept?.fitness;
    if (!kept || !fitness?.checked_at || fitness.verdict === 'not fit') return null;
    const spec = specFromConfig(kept);
    try {
      this.deps.model({ kind: 'model', spec });
    } catch {
      return null;
    }
    return { kind: 'kept', spec, verdict: fitness.verdict, checkedAt: fitness.checked_at, ...(kept.format ? { format: kept.format } : {}) };
  }

  private keyModel(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'model') return;
    if (k.name === 'escape' || k.name === 'ctrl-c') return this.back();
    if (!step.check) return;
    if (k.name === 'up') return this.patchStep('model', { cursor: Math.max(0, step.cursor - 1) });
    if (k.name === 'down') return this.patchStep('model', { cursor: Math.min(step.choices.length - 1, step.cursor + 1) });
    const choice = step.choices[step.cursor];
    if (k.name !== 'enter' || !choice) return;
    if (choice.kind === 'kept') return this.chooseModel(choice.spec, choice.format);
    if (choice.kind === 'app') return this.enterInstall(choice.app);
    if (choice.kind === 'demo') {
      this.useModel(choice);
      return this.afterModel();
    }
    if (choice.kind === 'model') return this.enterFitness(choice.spec);
    if (choice.kind === 'provider') return this.enterModelList(choice.provider);
    return this.enterCustom();
  }

  private useModel(choice: ModelChoice, format?: PacketFormat): void {
    this.model = this.deps.model(choice);
    this.modelReason = null;
    const name = choice.kind === 'demo' ? 'the demo stand in' : choice.kind === 'model' ? choice.spec.name : this.model.label;
    const spec = choice.kind === 'model' ? choice.spec : null;
    this.set({ model: { label: this.model.label, name, demo: choice.kind === 'demo', spec } });
    if (format) this.model = withFormat(this.model, format);
  }

  private enterModelList(provider: string): void {
    this.go({ name: 'model-list', provider, models: null, error: null, cursor: 0, typed: null });
    this.track(
      this.deps.listModels(provider).then(
        (models) => this.patchStep('model-list', { models }),
        (error: unknown) => this.patchStep('model-list', { models: [], error: (error as Error).message, typed: '' }),
      ),
    );
  }

  private keyModelList(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'model-list') return;
    if (k.name === 'ctrl-c') return this.leave();
    if (step.typed !== null) {
      if (k.name === 'char') return this.patchStep('model-list', { typed: step.typed + k.char });
      if (k.name === 'backspace') return this.patchStep('model-list', { typed: dropLast(step.typed) });
      if (k.name === 'escape') return step.error ? this.enterModel() : this.patchStep('model-list', { typed: null });
      if (k.name === 'enter' && step.typed.trim()) return this.enterFitness({ kind: 'hosted', provider: step.provider, name: step.typed.trim() });
      return;
    }
    if (k.name === 'escape') return this.enterModel();
    if (!step.models) return;
    const count = step.models.length + 1; // the last line types a name
    if (k.name === 'up') return this.patchStep('model-list', { cursor: Math.max(0, step.cursor - 1) });
    if (k.name === 'down') return this.patchStep('model-list', { cursor: Math.min(count - 1, step.cursor + 1) });
    if (k.name === 'enter') {
      const name = step.models[step.cursor];
      if (name) return this.enterFitness({ kind: 'hosted', provider: step.provider, name });
      return this.patchStep('model-list', { typed: '' });
    }
  }

  private enterCustom(): void {
    this.go({ name: 'model-custom', stage: 'name', typed: '', url: LOCAL_SERVER, cursor: 0, pull: null, error: null });
  }

  // Where a typed model name can run: Ollama, a server at a URL, or a provider with a key.
  customPlaces(): Array<{ kind: 'ollama' | 'url' | 'provider'; provider?: string }> {
    return [{ kind: 'ollama' }, { kind: 'url' }, ...providersWithKeys(this.deps.env).map((p) => ({ kind: 'provider' as const, provider: p.id }))];
  }

  private keyCustom(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'model-custom') return;
    if (k.name === 'ctrl-c') {
      if (step.stage === 'pull') this.stop?.abort();
      return this.leave();
    }
    if (step.stage === 'name' || step.stage === 'url') {
      const field = step.stage === 'name' ? 'typed' : 'url';
      const value = step[field];
      if (k.name === 'char') return this.patchStep('model-custom', { [field]: value + k.char, error: null });
      if (k.name === 'backspace') return this.patchStep('model-custom', { [field]: dropLast(value) });
      if (k.name === 'escape') return step.stage === 'name' ? this.enterModel() : this.patchStep('model-custom', { stage: 'where' });
      if (k.name === 'enter' && value.trim()) {
        if (step.stage === 'name') return this.patchStep('model-custom', { stage: 'where', cursor: 0, typed: step.typed.trim() });
        // "127.0.0.1:1234/v1" is read with its http://; what is no address at all is said so.
        if (!isServerUrl(step.url)) return this.patchStep('model-custom', { error: `${step.url.trim()} is not a server's address, such as http://127.0.0.1:1234/v1.` });
        return this.enterFitness({ kind: 'openai-compatible', name: step.typed, baseUrl: serverUrl(step.url) });
      }
      return;
    }
    if (step.stage === 'pull') {
      if (k.name === 'escape') {
        this.stop?.abort();
        return this.patchStep('model-custom', { stage: 'where', pull: null, error: null });
      }
      if (k.name === 'enter' && step.error) return this.patchStep('model-custom', { stage: 'where', pull: null, error: null });
      return;
    }
    const places = this.customPlaces();
    if (k.name === 'escape') return this.patchStep('model-custom', { stage: 'name' });
    if (k.name === 'up') return this.patchStep('model-custom', { cursor: Math.max(0, step.cursor - 1) });
    if (k.name === 'down') return this.patchStep('model-custom', { cursor: Math.min(places.length - 1, step.cursor + 1) });
    const place = places[step.cursor];
    if (k.name !== 'enter' || !place) return;
    if (place.kind === 'url') return this.patchStep('model-custom', { stage: 'url' });
    if (place.kind === 'provider') return this.enterFitness({ kind: 'hosted', provider: place.provider ?? '', name: step.typed });
    return this.useOllama(step.typed);
  }

  // A typed name on Ollama: used as it is when Ollama has it, pulled first when not.
  private useOllama(name: string): void {
    const machine = this.state.machine;
    if (machine?.ollama !== 'running') {
      const error = machine?.ollama === 'installed' ? 'Ollama is installed but not running. Start it, then choose again.' : 'Ollama is not on this machine. Install it from ollama.com, then choose again.';
      return this.patchStep('model-custom', { error });
    }
    const has = machine.local.some((m) => m.runtime === 'ollama' && (m.name === name || m.name === `${name}:latest`));
    const spec: ModelSpec = { kind: 'ollama', name };
    if (has) return this.enterFitness(spec);
    const stop = new AbortController();
    this.stop = stop;
    this.patchStep('model-custom', { stage: 'pull', pull: { status: 'starting' }, error: null });
    this.track(
      this.deps.pull(name, (pull) => this.patchStep('model-custom', { pull }), stop.signal).then(
        () => {
          if (this.stop === stop) this.stop = null;
          this.set({ machine: { ...machine, local: [...machine.local, { runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', name }] } });
          this.enterFitness(spec);
        },
        (error: unknown) => {
          if (this.stop === stop) this.stop = null;
          if (!stop.signal.aborted) this.patchStep('model-custom', { error: (error as Error).message });
        },
      ),
    );
  }

  // ---------------------------------------------------------------- the fitness check

  private enterFitness(spec: ModelSpec): void {
    this.pending = spec;
    let model: ModelAdapter;
    try {
      model = this.deps.model({ kind: 'model', spec });
    } catch (error) {
      return this.go({ name: 'fitness', label: spec.name, phase: 'done', plan: null, lines: [], current: null, result: null, error: (error as Error).message });
    }
    this.go({ name: 'fitness', label: model.label, phase: 'confirm', plan: null, lines: [], current: null, result: null, error: null });
    this.track(
      model.capabilities().then(
        (caps) => {
          if (caps.local) return this.runFitness(model);
          return this.patchStep('fitness', { plan: this.deps.fitnessPlan(model, caps.format) });
        },
        (error: unknown) => this.patchStep('fitness', { phase: 'done', error: (error as Error).message }),
      ),
    );
  }

  private runFitness(model: ModelAdapter): void {
    const stop = new AbortController();
    this.stop = stop;
    this.patchStep('fitness', { phase: 'running', lines: [], current: FITNESS_ASKING });
    this.track(
      this.deps
        .fitness(
          model,
          (s) => {
            const step = this.state.step;
            if (step.name !== 'fitness') return;
            if (s.done) this.patchStep('fitness', { lines: [...step.lines, { ok: null, text: `${s.name}: ${s.text}.` }], current: null });
            else this.patchStep('fitness', { current: s.text });
          },
          stop.signal,
        )
        .then(
          (result) => {
            if (this.stop === stop) this.stop = null;
            this.set({ fitness: result });
            this.patchStep('fitness', { phase: 'done', result, lines: fitnessLines(result), current: null });
            const spec = this.pending;
            if (spec && !this.deps.demo) {
              this.saveConfig({ model: { ...configFromSpec(spec), format: result.format, fitness: { verdict: result.verdict, reason: result.reason, checked_at: result.checkedAt } } });
            }
          },
          (error: unknown) => {
            if (this.stop === stop) this.stop = null;
            if (stop.signal.aborted || error instanceof RunCancelled) return this.enterModel();
            this.patchStep('fitness', { phase: 'done', error: (error as Error).message, current: null });
          },
        ),
    );
  }

  private keyFitness(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'fitness') return;
    const spec = this.pending;
    if (step.phase === 'running') {
      if (k.name === 'ctrl-c' || k.name === 'escape') this.stop?.abort();
      return;
    }
    if (k.name === 'ctrl-c') return this.leave();
    if (step.phase === 'confirm') {
      if (k.name === 'escape') return this.enterModel();
      if (!spec || !step.plan) return;
      if (k.name === 'enter') return this.runFitness(this.deps.model({ kind: 'model', spec }));
      if (k.name === 'char' && k.char === 's') return this.chooseModel(spec);
      return;
    }
    if (k.name === 'escape') return this.enterModel();
    if (!spec || step.error) {
      if (k.name === 'enter') return this.enterModel();
      return;
    }
    const fit = step.result?.verdict !== 'not fit';
    if (k.name === 'enter') return fit ? this.chooseModel(spec, step.result?.format) : this.enterModel();
    if (k.name === 'char' && k.char === 'u' && !fit) return this.chooseModel(spec, step.result?.format);
  }

  private chooseModel(spec: ModelSpec, format?: PacketFormat): void {
    this.useModel({ kind: 'model', spec }, format);
    if (!this.deps.demo) {
      const kept = this.deps.config?.read().model;
      const same = kept && kept.name === spec.name && kept.kind === configFromSpec(spec).kind;
      this.saveConfig({ model: same ? { ...kept, ...configFromSpec(spec) } : configFromSpec(spec) });
    }
    this.afterModel();
  }

  private afterModel(): void {
    if (this.state.firstRun) return this.enterConnect();
    this.go({ name: 'home' });
    this.set({ notice: `Answering with ${this.state.model?.label}.` });
  }

  // ---------------------------------------------------------------- PreReason

  private useKey(key: ResolvedKey | null): void {
    this.data = key ? this.deps.briefings(key.key) : null;
    this.keyInUse = key;
    this.refused = false;
    this.tierProbe = null;
    this.set({ connected: Boolean(key) });
  }

  // PreReason refused the key on a read: said once, with how to connect again, since every
  // read after it is refused the same way. A key in PREREASON_API_KEY is the person's to change.
  private noteKey(): void {
    if (this.refused || !this.keyInUse || this.data?.keyAccepted !== false) return;
    this.refused = true;
    this.set({ notice: this.keyInUse.source === 'env' ? ENV_KEY_REFUSED : 'PreReason no longer accepts the saved key. /connect prereason connects again.' });
  }

  // The key PreReason refused, found again where it was: no new key yet.
  private stillRefused(key: ResolvedKey): boolean {
    return this.refused && key.key === this.keyInUse?.key;
  }

  private enterConnect(): void {
    if (!this.deps.demo) {
      // A key already set skips the step, unless PreReason refused it: the bridge's login then
      // runs as for a first connect, and saves its new key over the refused one in its file.
      const key = this.deps.resolveKey();
      if (key && this.stillRefused(key) && key.source === 'env') return this.set({ notice: ENV_KEY_REFUSED });
      if (key && !this.stillRefused(key)) {
        this.useKey(key);
        return this.enterTier();
      }
    }
    const again = this.refused;
    this.go({ name: 'connect', coverage: null, link: null, phase: this.deps.demo ? 'demo' : 'starting', message: null });
    if (again) this.set({ notice: 'The saved key is no longer accepted by PreReason. Connecting again.' });
    this.track(
      this.loadCatalog().then((entries) => {
        // General markets first: Bitcoin's briefings are named last.
        const free = readableBy(entries, 'free');
        const ordered = [...free.filter((b) => !b.id.startsWith('btc.')), ...free.filter((b) => b.id.startsWith('btc.'))];
        if (entries.length) this.patchStep('connect', { coverage: coverage(ordered) });
      }),
    );
    if (!this.deps.demo) this.startClaim();
  }

  private startClaim(): void {
    this.patchStep('connect', { phase: 'starting', link: null, message: null });
    this.claim = this.deps.connect((event) => this.onClaim(event));
  }

  private onClaim(event: ClaimEvent): void {
    if (this.state.step.name !== 'connect') return;
    if (event.kind === 'link') return this.patchStep('connect', { link: event.url, phase: 'waiting' });
    if (event.kind !== 'ended') return;
    this.claim = null;
    if (!event.approved) return this.patchStep('connect', { phase: 'failed', message: event.message.replace(/^PreReason:\s*/, '') || null });
    const key = this.deps.resolveKey();
    if (!key) return this.patchStep('connect', { phase: 'failed', message: 'PreReason approved access, but no key was found in its credentials file.' });
    if (this.stillRefused(key)) return this.patchStep('connect', { phase: 'failed', message: key.source === 'env' ? ENV_KEY_REFUSED : 'PreReason approved access, but its credentials file still holds the key it refused.' });
    this.useKey(key);
    this.enterTier();
  }

  // Once connected, one call learns the key's tier, which PreReason names on its answer.
  private enterTier(): void {
    const data = this.data;
    if (!data) return this.afterConnect();
    if (this.state.step.name !== 'connect') this.go({ name: 'connect', coverage: null, link: null, phase: 'tier', message: null });
    else this.patchStep('connect', { phase: 'tier' });
    this.track(
      this.probeTier(data).then(() => {
        // The rest is kept: a key PreReason refused on this call stays marked for the doctor.
        if (this.state.tier) this.saveConfig({ prereason: { ...this.deps.config?.read().prereason, tier: this.state.tier, checked_at: this.now().toISOString() } });
        // In the first run a key PreReason refused is no connection: the step says so, and
        // Enter connects again, as /connect prereason does in a later session.
        if (this.state.firstRun && data.keyAccepted === false) {
          this.refused = true;
          return this.patchStep('connect', { phase: 'failed', message: this.keyInUse?.source === 'env' ? ENV_KEY_REFUSED : 'PreReason no longer accepts the saved key.' });
        }
        this.afterConnect();
        this.noteKey();
      }),
    );
  }

  // One call learns the key's tier: the smallest free briefing, kept as a snapshot. It runs
  // once for a key, and noteBudget keeps the tier it names.
  private probeTier(data: Briefings): Promise<void> {
    this.tierProbe ??= (async () => {
      try {
        const smallest = smallestFree((await this.loadCatalog()).filter((b) => data.has?.(b.id) ?? true));
        if (smallest) await readBriefing({ data, snapshots: this.deps.snapshots }, smallest.id, 'json');
        this.noteBudget();
      } catch {
        // The tier stays unknown; the first answer will say it.
      }
    })();
    return this.tierProbe;
  }

  // Connected: the first run goes on to its first question; /connect prereason in a later
  // session goes back home, and says so.
  private afterConnect(): void {
    if (this.state.firstRun) return this.enterFirstQuestion();
    this.go({ name: 'home' });
    this.set({ notice: this.state.connected ? 'Connected to PreReason.' : 'PreReason is not connected.' });
  }

  // The calls left and the tier, as the last answer stated them; each is kept as it was
  // where an answer does not state it.
  // A tier an answer names is kept in config.yaml where it differs from the one kept there,
  // so a later session starts with it: a key set after the first run, or one whose tier changed.
  private noteBudget(): void {
    const data = this.data;
    if (!data) return;
    this.set({ ...(data.budget ? { callsLeft: data.budget.remaining, dayLimit: data.budget.limit } : {}), tier: data.tier ?? this.state.tier });
    if (data.tier && this.deps.config && data.tier !== this.deps.config.read().prereason?.tier) this.saveConfig({ prereason: { tier: data.tier, checked_at: this.now().toISOString() } });
  }

  private keyConnect(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'connect') return;
    if (k.name === 'ctrl-c') return this.leave();
    if (step.phase === 'tier') return;
    if (k.name === 'escape') {
      this.claim?.cancel();
      this.claim = null;
      return this.state.firstRun ? this.enterModel() : this.go({ name: 'home' });
    }
    if (step.phase === 'demo' && k.name === 'enter') {
      this.data = this.deps.briefings(null);
      this.set({ connected: true, tier: 'free' });
      return this.afterConnect();
    }
    if (step.phase === 'failed' && k.name === 'enter') return this.startClaim();
    if (step.phase === 'waiting' && step.link) {
      if (k.name === 'enter') this.set({ notice: this.deps.openLink(step.link) ? 'Opened the link in your browser.' : 'Could not open a browser; copy the link instead.' });
      if (k.name === 'char' && k.char === 'c') this.set({ notice: this.deps.copy(step.link) ? 'Copied the link.' : 'Could not copy; select the link instead.' });
    }
  }

  // ---------------------------------------------------------------- the first question

  private enterFirstQuestion(): void {
    // Working inside an app with no model here, the first run ends by saying what to type there.
    if (this.inApp && !this.model) {
      this.saveConfig({ first_run_done_at: this.now().toISOString() });
      return this.go({ name: 'install', app: this.inApp, lines: [], phase: 'ready', message: [] });
    }
    this.go({ name: 'first-question', cursor: 0, typed: null, entry: null });
  }

  private keyFirstQuestion(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'first-question') return;
    const entry = step.entry;
    if (entry?.kind === 'running') {
      if (k.name === 'ctrl-c') this.stop?.abort();
      return;
    }
    if (entry) {
      if (k.name === 'ctrl-c') return this.leave();
      if (entry.kind === 'answer' && k.name === 'enter') return this.enterDigestStep();
      if (k.name === 'enter') return this.patchStep('first-question', { entry: null });
      if (k.name === 'escape') return this.enterDigestStep();
      return;
    }
    if (step.typed !== null) {
      if (k.name === 'char') return this.patchStep('first-question', { typed: step.typed + k.char });
      if (k.name === 'backspace') return this.patchStep('first-question', { typed: dropLast(step.typed) });
      if (k.name === 'escape' || k.name === 'ctrl-c') return this.patchStep('first-question', { typed: null });
      if (k.name === 'enter' && step.typed.trim()) return this.ask(step.typed.trim(), null, 'first');
      return;
    }
    const last = FIRST_QUESTIONS.length; // "Or type your own question"
    if (k.name === 'up') return this.patchStep('first-question', { cursor: Math.max(0, step.cursor - 1) });
    if (k.name === 'down') return this.patchStep('first-question', { cursor: Math.min(last, step.cursor + 1) });
    if (k.name === 'escape') return this.enterDigestStep();
    if (k.name === 'ctrl-c') return this.leave();
    if (k.name === 'enter') {
      const q = FIRST_QUESTIONS[step.cursor];
      if (q) return this.ask(q.question, q.briefings, 'first', true);
      return this.patchStep('first-question', { typed: '' });
    }
  }

  // ---------------------------------------------------------------- the digest's schedule

  private enterDigestStep(): void {
    const step = this.state.step;
    if (step.name === 'first-question' && step.entry && step.entry.kind !== 'running') this.firstEntry = step.entry;
    this.go({ name: 'digest', stage: 'choose', cursor: 0, typed: '', entry: null, message: null });
    if (!this.state.watchlist.length) {
      this.track(
        this.loadCatalog().then((entries) => {
          const watchlist = this.deps.config?.read().watchlist ?? defaultWatchlist(readableBy(entries, (this.state.tier as Tier | null) ?? 'free'));
          this.set({ watchlist });
        }),
      );
    }
  }

  private keyDigest(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'digest') return;
    if (k.name === 'ctrl-c') return this.leave();
    const done = () => (this.state.firstRun ? this.finishFirstRun() : this.go({ name: 'home' }));
    switch (step.stage) {
      case 'choose':
        if (k.name === 'up') return this.patchStep('digest', { cursor: Math.max(0, step.cursor - 1) });
        if (k.name === 'down') return this.patchStep('digest', { cursor: Math.min(2, step.cursor + 1) });
        if (k.name === 'escape') return done();
        if (k.name !== 'enter') return;
        if (step.cursor === 0) return this.patchStep('digest', { stage: 'entry', entry: this.deps.scheduleEntry('08:00') });
        if (step.cursor === 1) return this.patchStep('digest', { stage: 'time', typed: '' });
        return done();
      case 'time': {
        if (k.name === 'char') return this.patchStep('digest', { typed: step.typed + k.char, message: null });
        if (k.name === 'backspace') return this.patchStep('digest', { typed: dropLast(step.typed) });
        if (k.name === 'escape') return this.patchStep('digest', { stage: 'choose' });
        if (k.name !== 'enter') return;
        const time = parseTime(step.typed);
        if (!time) return this.patchStep('digest', { message: 'Type a time such as 07:30.' });
        return this.patchStep('digest', { stage: 'entry', entry: this.deps.scheduleEntry(time) });
      }
      case 'entry':
        if (k.name === 'escape') return this.patchStep('digest', { stage: 'choose' });
        if (k.name !== 'enter' || !step.entry) return;
        if (!this.deps.scheduler) {
          this.set({ notice: 'In the demo nothing is added.' });
          return done();
        }
        return this.addSchedule(step.entry);
      case 'adding':
        return;
      case 'added':
        if (k.name === 'enter' || k.name === 'escape') return done();
        return;
      case 'failed':
        if (k.name === 'enter') return this.patchStep('digest', { stage: 'choose' });
        if (k.name === 'escape') return done();
        return;
    }
  }

  private addSchedule(entry: ScheduleEntry): void {
    const scheduler = this.deps.scheduler;
    if (!scheduler) return;
    this.patchStep('digest', { stage: 'adding' });
    this.track(
      scheduler.add(entry).then(
        () => {
          const digest = { ...(this.deps.config?.read().digest ?? {}), time: entry.time };
          this.saveConfig({ digest, watchlist: this.state.watchlist });
          this.patchStep('digest', { stage: 'added', message: `Added. The digest runs every day at ${entry.time}.` });
        },
        (error: unknown) => this.patchStep('digest', { stage: 'failed', message: (error as Error).message }),
      ),
    );
  }

  private finishFirstRun(): void {
    this.saveConfig({ first_run_done_at: this.now().toISOString(), ...(this.state.watchlist.length ? { watchlist: this.state.watchlist } : {}) });
    this.set({ feed: this.firstEntry ? [this.firstEntry] : [], firstRun: false });
    this.go({ name: 'home' });
  }

  // ---------------------------------------------------------------- inside an AI app

  private enterInstall(app: string): void {
    const plan = this.deps.installInto?.(app) ?? null;
    if (!plan) {
      const why = this.deps.demo
        ? ['The demo changes nothing on this machine. Outside it, this step shows each change', `primerkit makes to ${app} and makes them when you press Enter.`]
        : [`primerkit cannot put itself into ${app} from here.`];
      return this.go({ name: 'install', app, lines: [], phase: 'failed', message: why });
    }
    this.go({ name: 'install', app, lines: plan.lines, phase: 'confirm', message: [] });
  }

  private keyInstall(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'install') return;
    if (k.name === 'ctrl-c') return this.leave();
    if (step.phase === 'applying') return;
    if (step.phase === 'ready') {
      if (k.name === 'escape') return this.leave();
      if (k.name === 'enter') {
        this.inApp = null;
        return this.enterModel();
      }
      return;
    }
    if (k.name === 'escape') return this.enterModel();
    if (k.name !== 'enter') return;
    if (step.phase === 'failed') return this.enterModel();
    if (step.phase === 'done') {
      this.inApp = step.app;
      return this.state.firstRun ? this.enterConnect() : this.go({ name: 'home' });
    }
    const plan = this.deps.installInto?.(step.app);
    if (!plan) return;
    this.patchStep('install', { phase: 'applying' });
    this.track(
      plan.apply().then(
        (done) => this.patchStep('install', { phase: 'done', message: done }),
        (error: unknown) => this.patchStep('install', { phase: 'failed', message: [messageOf(error)] }),
      ),
    );
  }

  // ---------------------------------------------------------------- connections

  // Every connection, on or off. A broker is connected in a terminal, where its keys are
  // typed once into the keychain.
  private connections(arg: string): void {
    if (arg === 'alpaca') return this.set({ notice: 'In a terminal, run primerkit connect alpaca: it asks for the paper keys once and keeps them in the keychain.' });
    if (arg === 'robinhood') return this.set({ notice: 'In a terminal, run primerkit connect robinhood --host claude-code or --host codex: it shows what it adds and asks your yes there.' });
    if (arg === 'prereason' && (!this.state.connected || this.refused)) return this.enterConnect();
    if (arg && arg !== 'prereason') return this.set({ notice: `There is no connection ${arg}. /connect lists them.` });
    // Only the four modes are modes: any other value in config.yaml places no order, and is
    // not drawn as on.
    const mode: unknown = this.deps.config?.read().brokers?.alpaca?.mode ?? 'off';
    const alpaca = typeof mode === 'string' && ['off', 'read', 'dry_run', 'paper'].includes(mode) ? mode : 'unusable';
    const kept = this.deps.demo ? undefined : this.deps.config?.read().brokers?.robinhood;
    const robinhood = { hosts: Array.isArray(kept?.hosts) ? kept.hosts.filter((h): h is string => typeof h === 'string') : [], approvals: typeof kept?.approvals_confirmed_at === 'string' };
    this.placer('home')({ kind: 'connections', question: '/connect', prereason: { on: this.state.connected, tier: this.state.tier, saved: this.deps.demo?.date ?? null }, alpaca, robinhood });
  }

  // ---------------------------------------------------------------- the benchmark

  // The benchmark on the session's model, in the feed. A hosted model runs it only on
  // /bench yes, since every packet goes to the provider on the person's key.
  private bench(arg: string): void {
    if (arg === 'card') return this.benchCard();
    const model = this.model;
    const inputs = this.deps.benchInputs?.();
    if (!inputs) return this.set({ notice: 'The benchmark is not installed here.' });
    if (!model || this.state.model?.demo) return this.set({ notice: 'The benchmark reads with a model, and the demo stand in is not one. /model change picks one.' });
    const items = benchItems(inputs.file, inputs.data);
    const question = '/bench';
    this.track(
      (async () => {
        const caps = await model.capabilities();
        if (!caps.local && arg !== 'yes') {
          return this.set({ notice: `The benchmark sends ${items.length} packets to ${model.label.split(', ')[1] ?? 'the provider'} on your key, which charges for them. /bench yes runs it.` });
        }
        const put = this.placer('home');
        const running = (text: string): Entry => ({ kind: 'running', question, running: { phase: 'working', briefings: [], tokens: null, text } });
        put(running(`0 of ${items.length} answered`));
        const stop = new AbortController();
        this.stop = stop;
        try {
          const { records, replies, stopped } = await runBench(model, items, {
            signal: stop.signal,
            onStep: (p) => put(running(`${p.done} of ${p.total} answered · ${p.item.briefing}, ${p.item.arm}, run ${p.item.run}`)),
          });
          if (stop.signal.aborted) {
            put(null);
            return this.set({ notice: 'Stopped. Nothing from this benchmark was kept.' });
          }
          if (!records.length) return put({ kind: 'failed', question, message: 'The benchmark did not run.', detail: stopped });
          const result = summarizeBench(records, { model: this.state.model?.name ?? model.id, fixtures: inputs.fixtures, now: this.now() });
          if (this.deps.journal) keepBench(this.deps.journal, result, records, items, replies, this.now());
          this.lastBench = result;
          put({ kind: 'bench', question, result, stopped });
        } finally {
          if (this.stop === stop) this.stop = null;
        }
      })(),
    );
  }

  private benchCard(): void {
    const result = this.lastBench ?? (this.deps.journal ? latestBench(this.deps.journal.root) : null);
    if (!result) return this.set({ notice: 'No benchmark has run here yet. /bench runs it.' });
    if (!this.deps.cardDir) return this.set({ notice: 'The demo keeps nothing, so it saves no card.' });
    this.track(writeShareCard(result, this.deps.cardDir).then((path) => this.set({ notice: `Saved on this machine only: ${path}` })));
  }

  // ---------------------------------------------------------------- routines

  // The person's routines: listed, made, shown, their rules, and their logic tests.
  private routine(arg: string): void {
    const home = this.deps.home;
    const base = this.deps.routineOperation;
    if (!home || !base) return this.set({ notice: 'The demo keeps no routines. In your own session, /routine new <name> makes one.' });
    const [name = '', sub = '', extra = ''] = arg.split(/\s+/).filter(Boolean);
    const question = `/routine${arg ? ` ${arg}` : ''}`;
    const put = this.placer('home');
    const model = this.state.model?.demo ? null : (this.state.model?.name ?? null);
    const problems = (error: unknown): Entry =>
      error instanceof RoutineError
        ? { kind: 'failed', question, message: `${error.file} needs a fix.`, detail: `${error.problems.join('; ')}.` }
        : { kind: 'failed', question, message: (error as Error).message, detail: null };
    if (!name) {
      const names = listRoutines(home);
      return put({ kind: 'note', question, text: names.length ? `Your routines: ${names.join(', ')}. /routine <name> shows one.` : 'No routines yet. /routine new <name> makes one, with a rules file for your own rules.' });
    }
    if (name === 'new') {
      if (!sub) return this.set({ notice: 'Name the routine: /routine new btc-rules' });
      try {
        // On a free key it reads the days that key reads, so its first run does not fail.
        const made = newRoutine(home, sub, priceDaysFor(this.state.tier));
        const page = routinePage(loadRoutine(made.dir), { model });
        return put({ kind: 'routine', question, page, made: `Made in ${tildePath(made.dir)}. Write your rules in rules.md and your card in hypothesis.md, and put your own share, fee and spread in place of the placeholders in routine.yaml.` });
      } catch (error) {
        return put(problems(error));
      }
    }
    // Every hypothesis and version tested on this machine, by name, never by result.
    if (name === 'registry') {
      try {
        return put({ kind: 'registry', question, page: registryPage(home) });
      } catch (error) {
        return put(problems(error));
      }
    }
    let routine: Routine;
    try {
      routine = loadRoutine(join(routinesDir(home), name));
    } catch (error) {
      if (error instanceof RoutineError && /there is no routine\.yaml/.test(error.problems[0] ?? '')) return this.set({ notice: `There is no routine named ${name}. /routine new ${name} makes one.` });
      return put(problems(error));
    }
    if (!sub) return put({ kind: 'routine', question, page: routinePage(routine, { model }), made: null });
    if (sub === 'rules') return put({ kind: 'rules', question, page: rulesPage(routine) });
    if (sub === 'test') return this.routineTest(routine, base, question, extra === 'yes');
    if (sub === 'replay') {
      // A finished backtest, drawn from its folder: the newest, or the run named.
      const replay = replayOf(routine, extra || undefined);
      if (!replay) return put({ kind: 'note', question, text: extra ? `${name} has no finished backtest ${extra}.` : `${name} has no finished backtest yet. In a terminal, primerkit backtest ${name} --from <date> --to <date> runs one.` });
      return this.loadBoardStep({ kind: 'backtest', routine: name, run: replay.run.runId, tick: null, ticks: replay.run.ticks.length });
    }
    if (sub === 'track') {
      if (extra === 'run') return this.routineTrack(routine, base, question, arg.split(/\s+/).includes('yes'));
      return this.loadBoardStep({ kind: 'forward', routine: name });
    }
    if (sub === 'hypothesis') {
      try {
        return put({ kind: 'hypothesis', question, page: hypothesisPage(routine) });
      } catch (error) {
        return put(problems(error));
      }
    }
    if (sub === 'research') {
      // The ladder for the newest finished backtest, from its folder: no model, nothing read.
      try {
        const page = researchPage(routine, home, `/routine ${name} replay`);
        if (!page) return put({ kind: 'note', question, text: `${name} has no finished backtest yet. In a terminal, primerkit backtest ${name} --from <date> --to <date> runs one.` });
        return put({ kind: 'research', question, page });
      } catch (error) {
        return put(problems(error));
      }
    }
    return this.set({ notice: `/routine ${name} ${sub} is not a routine command. There are /routine ${name} rules, test, replay, track, hypothesis and research.` });
  }

  // One run of a routine's forward record, then its board: the data as served now, the
  // label written before its outcome exists, no order anywhere. A hosted model waits for
  // a yes, since its provider charges for the call.
  private routineTrack(routine: Routine, base: Operation, question: string, yes: boolean): void {
    const put = this.placer('home');
    const data = this.data;
    if (!data) return this.set({ notice: 'PreReason is not connected, so there is nothing to run on yet.' });
    let model: ModelAdapter | null;
    try {
      if (!readRules(routine)) return put({ kind: 'note', question, text: `${tildePath(routine.rulesPath)} holds no rules yet, so ${routine.spec.name} returns no_rules_defined and there is nothing to run.` });
      model = routine.spec.model ? this.deps.model({ kind: 'model', spec: specFromConfig(routine.spec.model) }) : this.state.model?.demo ? null : this.model;
    } catch (error) {
      return put(error instanceof RoutineError ? { kind: 'failed', question, message: `${error.file} needs a fix.`, detail: `${error.problems.join('; ')}.` } : { kind: 'failed', question, message: (error as Error).message, detail: null });
    }
    if (!model) return this.set({ notice: 'The record runs on a model, and the demo stand in is not one. /model change picks one.' });
    const runner = model;
    this.track(
      (async () => {
        const caps = await runner.capabilities();
        if (!caps.local && !yes) return this.set({ notice: `The run sends one packet to ${runner.label.split(', ')[1] ?? 'the provider'} on your key, which charges for it. /routine ${routine.spec.name} track run yes runs it.` });
        put({ kind: 'running', question, running: { phase: 'working', briefings: [], tokens: null, text: `${routine.spec.name}: reading the data as served, then asking the model`, stops: 'Ctrl+C stops it, and nothing is written' } });
        const stop = new AbortController();
        this.stop = stop;
        try {
          const outcome = await trackRoutine({
            base,
            routine,
            model: runner,
            source: routineSource(data),
            format: routine.spec.format ?? caps.format,
            ...(this.deps.journal ? { journal: this.deps.journal } : {}),
            now: () => this.now(),
            signal: stop.signal,
            tier: this.state.tier,
          });
          if (outcome.kind === 'no_rules_defined') return put({ kind: 'note', question, text: `${tildePath(routine.rulesPath)} holds no rules, so there is nothing to run.` });
          const said = outcome.entry.label ? `${outcome.entry.label}, written` : `no label (${outcome.entry.outcome}), so it holds; written`;
          put({ kind: 'note', question, text: `${routine.spec.name}: ${said} to its forward record before its outcome exists. /routine ${routine.spec.name} track shows it.` });
          this.loadBoardStep({ kind: 'forward', routine: routine.spec.name });
        } catch (error) {
          put(error instanceof RoutineError ? { kind: 'failed', question, message: 'The run did not finish.', detail: `${error.problems.join('; ').replace(/\.$/, '')}.` } : { kind: 'failed', question, message: 'The run did not finish.', detail: withWait(error) });
        } finally {
          if (this.stop === stop) this.stop = null;
        }
      })(),
    );
  }

  // A routine's logic tests in the feed, on the routine's own model or the one in use.
  // A hosted model waits for a yes, since its provider charges for every call.
  private routineTest(routine: Routine, base: Operation, question: string, yes: boolean): void {
    const put = this.placer('home');
    let tests: RoutineTests;
    let model: ModelAdapter | null;
    try {
      tests = loadRoutineTests(routine);
      if (!readRules(routine)) return put({ kind: 'note', question, text: `${tildePath(routine.rulesPath)} holds no rules yet, so ${routine.spec.name} returns no_rules_defined and there is nothing to test.` });
      model = routine.spec.model ? this.deps.model({ kind: 'model', spec: specFromConfig(routine.spec.model) }) : this.state.model?.demo ? null : this.model;
    } catch (error) {
      return put(error instanceof RoutineError ? { kind: 'failed', question, message: `${error.file} needs a fix.`, detail: `${error.problems.join('; ')}.` } : { kind: 'failed', question, message: (error as Error).message, detail: null });
    }
    if (!tests.tests.length) return put({ kind: 'note', question, text: `tests.yaml in ${tildePath(routine.dir)} has no tests yet. Each test names a day, what was held, and the label your rules give; the file shows how.` });
    if (!model) return this.set({ notice: 'The tests run on a model, and the demo stand in is not one. /model change picks one.' });
    const runner = model;
    const name = routine.spec.model?.name ?? this.state.model?.name ?? runner.id;
    this.track(
      (async () => {
        const caps = await runner.capabilities();
        const calls = tests.tests.length * tests.runs;
        if (!caps.local && !yes) {
          return this.set({ notice: `The tests send ${calls} packets to ${runner.label.split(', ')[1] ?? 'the provider'} on your key, which charges for them. /routine ${routine.spec.name} test yes runs them.` });
        }
        const running = (text: string): Entry => ({ kind: 'running', question, running: { phase: 'working', briefings: [], tokens: null, text, stops: 'Ctrl+C stops it, and keeps the runs done' } });
        put(running('reading the days the tests name'));
        const stop = new AbortController();
        this.stop = stop;
        try {
          const outcome = await testRoutine({
            base,
            routine,
            tests,
            model: runner,
            format: routine.spec.format ?? caps.format,
            source: this.data ? routineSource(this.data) : null,
            ...(this.deps.journal ? { journal: this.deps.journal } : {}),
            signal: stop.signal,
            now: () => this.now(),
            onRun: (s) => {
              if (!s.done) put(running(`test ${s.test + 1} of ${s.tests}, run ${s.run} of ${s.runs}: ${name} is answering`));
            },
          });
          if (outcome.kind === 'no_rules_defined') return put({ kind: 'note', question, text: `${tildePath(outcome.rulesPath)} holds no rules, so there is nothing to test.` });
          if (outcome.kind === 'no_tests') return put({ kind: 'note', question, text: 'tests.yaml has no tests yet.' });
          const { report } = outcome;
          put({ kind: 'routine-test', question, routine: routine.spec.name, model: report.model, rows: testRows(report), summary: testSummary(report), passed: !report.stopped && report.passed === report.total, path: outcome.path });
        } catch (error) {
          put(error instanceof RoutineError ? { kind: 'failed', question, message: 'The tests did not run.', detail: `${error.problems.join('; ')}.` } : { kind: 'failed', question, message: 'The tests did not run.', detail: withWait(error) });
        } finally {
          if (this.stop === stop) this.stop = null;
        }
      })(),
    );
  }

  // ---------------------------------------------------------------- boards and charts

  private board(command: 'brief' | 'chart', text: string): void {
    const request = parseBoard(command, text, { tier: this.keyTier(), today: this.now().toISOString().slice(0, 10) });
    if ('error' in request) return this.set({ notice: request.error });
    this.loadBoardStep(request);
  }

  // The board being read, if one is. Each load is tied to its own: a board closed, or
  // replaced by another, stops reading, and what it read is dropped rather than drawn under
  // the board asked for since.
  private boardLoad: AbortController | null = null;

  private stopBoard(): void {
    this.boardLoad?.abort();
    this.boardLoad = null;
  }

  // Reads what the board needs, then keeps it drawn both ways, and keeps the drawing so
  // a resized window draws it again.
  private loadBoardStep(request: BoardRequest): void {
    const data = this.data;
    // A backtest's replay reads its own folder, and nothing from PreReason.
    if (!data && request.kind !== 'backtest' && request.kind !== 'forward') return this.set({ notice: 'PreReason is not connected, so there is nothing to draw yet.' });
    this.stopBoard();
    const load = new AbortController();
    this.boardLoad = load;
    const current = () => this.boardLoad === load;
    this.go({ name: 'board', request, view: null, top: 0, status: 'reading', error: null });
    const at = this.now().toISOString();
    this.boardDraw = null;
    // Only the load asked for last says what it is reading.
    const onStatus = (status: string) => {
      if (current()) this.patchStep('board', { status });
    };
    const env = { data: data as Briefings, snapshots: this.deps.snapshots, today: this.deps.demo?.day ?? at.slice(0, 10), now: at, signal: load.signal, onStatus, ...(this.deps.home ? { routines: routinesDir(this.deps.home) } : {}), ...(this.deps.journal ? { journal: this.deps.journal.root } : {}), ...this.tierEnv() };
    this.track(
      loadBoard(request, env).then(
        (draw) => {
          if (!current()) return;
          this.noteBudget();
          this.boardDraw = { draw, at };
          this.patchStep('board', { view: this.boardViews(this.boardDraw) });
        },
        (error: unknown) => {
          if (current()) this.patchStep('board', { error: messageOf(error) });
        },
      ),
    );
  }

  private keyBoard(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'board') return;
    if (k.name === 'ctrl-c') return this.leave();
    if (k.name === 'escape' || k.name === 'enter') {
      this.stopBoard();
      return this.go({ name: 'home' });
    }
    if (!step.view) return;
    // The scroll keeps within the lines as the screen draws them, fitted to the window.
    const last = this.scrollEnd();
    if (k.name === 'up') return this.patchStep('board', { top: Math.max(0, Math.min(step.top, last) - 1) });
    if (k.name === 'down') return this.patchStep('board', { top: Math.min(last, step.top + 1) });
    if (k.name === 'left' || k.name === 'right') {
      const next = nextRange(step.request, k.name === 'right' ? 1 : -1);
      if (next) this.loadBoardStep(next);
    }
    // d opens the tick the arrows are on, step by step, and closes it again.
    if (k.name === 'char' && k.char === 'd' && step.request.kind === 'backtest') {
      const tick = step.request.tick ?? 0;
      this.loadBoardStep({ ...step.request, tick, detail: !step.request.detail });
    }
  }

  // The first line the scroll can show and still fill the rows: the end of what scrolls.
  private scrollEnd(): number {
    const span = scrollSpan(this.state);
    return span ? Math.max(0, span.total - span.room) : 0;
  }

  // ---------------------------------------------------------------- the compare view

  // What /compare runs on once its cost is said: the model, its web search, the list price
  // the cost was said at, and the briefings. Kept from the plan to the run.
  private comparing: { model: ModelAdapter; searcher: WebSearcher; price: ListPrice; data: Briefings } | null = null;

  // /compare: one question answered twice on the person's own model key, from PreReason's
  // briefings and by the model's web search with no briefings. A hosted Claude model only;
  // anything else is refused in one line, and nothing runs. The plan says what the run
  // spends, and only Enter runs it.
  private compare(question: string): void {
    const spec = this.state.model?.spec;
    const model = this.model;
    if (!question) return this.set({ notice: 'Type a question after /compare, such as /compare Is net liquidity rising or falling?' });
    if (!model || !spec || this.state.model?.demo) return this.set({ notice: '/compare asks a hosted model twice, and the demo stand in is not one, so nothing runs.' });
    if (spec.kind !== 'hosted') return this.set({ notice: `/compare runs on hosted models only, and ${spec.name} is not one, so nothing runs.` });
    if (providerById(spec.provider)?.api !== 'anthropic') return this.set({ notice: `The web side of /compare runs on Anthropic models only, so nothing runs on ${spec.name}.` });
    const data = this.data;
    if (!data) return this.set({ notice: 'PreReason is not connected, so there is nothing to compare yet.' });
    const price = listPrice(spec.name);
    if (!price) return this.set({ notice: `primerkit has no list price for ${spec.name}, so it cannot say what /compare costs before it runs, and nothing runs.` });
    let searcher: WebSearcher | null;
    try {
      searcher = this.deps.webSearch?.(spec) ?? null;
    } catch (error) {
      return this.set({ notice: `${messageOf(error)}, so nothing runs.` });
    }
    if (!searcher) return this.set({ notice: 'The web side of /compare cannot run here, so nothing runs.' });
    const web = searcher;
    this.comparing = { model, searcher: web, price, data };
    this.go({ name: 'compare', question, phase: 'planning', plan: null, progress: null, result: null, top: 0 });
    const still = () => this.state.step.name === 'compare' && this.state.step.phase === 'planning' && this.state.step.question === question;
    this.track(
      (async () => {
        const caps = await model.capabilities();
        const tier = (this.state.tier as Tier | null) ?? 'free';
        const readable = readableBy(await this.loadCatalog(), tier).filter((b) => data.has?.(b.id) ?? true);
        const metrics = this.deps.metricCatalog && data.metricBlock ? await this.loadMetrics().catch(() => []) : [];
        const planned = planRead(question, this.now().toISOString().slice(0, 10), readable, metrics, !data.readsDates, tier === 'free');
        if (!still()) return;
        if (planned.kind === 'note') {
          this.comparing = null;
          this.go({ name: 'home' });
          return this.placer('home')({ kind: 'note', question: `/compare ${question}`, text: planned.text });
        }
        // A briefing read before is measured from its snapshot; one never read is estimated.
        const blockTokens = (id: string): number => {
          const kept = this.deps.snapshots?.latest(id, caps.format);
          return kept ? tokenCount(kept.raw) : PLAN_SIZES.block;
        };
        const plan = comparePlan({ model: spec.name, price, question, read: planned.read, operation: this.deps.operation, blockTokens, searches: web.maxUses });
        this.patchStep('compare', { phase: 'confirm', plan });
      })().catch((error: unknown) => {
        if (!still()) return;
        this.comparing = null;
        this.go({ name: 'home' });
        this.set({ notice: `/compare could not be planned: ${messageOf(error)}` });
      }),
    );
  }

  private keyCompare(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'compare') return;
    if (step.phase === 'running') {
      if (k.name === 'ctrl-c' || k.name === 'escape') this.stop?.abort();
      return;
    }
    if (k.name === 'ctrl-c') return this.leave();
    if (step.phase === 'done') {
      const last = this.scrollEnd();
      if (k.name === 'up') return this.patchStep('compare', { top: Math.max(0, Math.min(step.top, last) - 1) });
      if (k.name === 'down') return this.patchStep('compare', { top: Math.min(last, step.top + 1) });
      if (k.name === 'escape' || k.name === 'enter') return this.go({ name: 'home' });
      return;
    }
    if (k.name === 'escape') {
      this.comparing = null;
      return this.go({ name: 'home' });
    }
    if (k.name === 'enter' && step.phase === 'confirm' && step.plan) return this.runComparison(step.question, step.plan);
  }

  // Both sides at once. The compare goes into the feed when it ends, and stays on screen to
  // be read; a stop keeps nothing.
  private runComparison(question: string, plan: ComparePlan): void {
    const ctx = this.comparing;
    if (!ctx) return;
    const put = this.placer('home');
    const stop = new AbortController();
    this.stop = stop;
    const progress = { briefings: briefingStatus(plan.model, { phase: 'reading', briefings: plan.read, tokens: null }), web: webStatusWhileRunning(plan.model, false), done: { briefings: false, web: false } };
    this.patchStep('compare', { phase: 'running', progress });
    this.track(
      runCompare({
        engine: {
          operation: this.deps.operation,
          model: ctx.model,
          data: ctx.data,
          catalog: () => this.loadCatalog(),
          metrics: () => this.loadMetrics(),
          tier: (this.state.tier as Tier | null) ?? null,
          snapshots: this.deps.snapshots,
          now: () => this.now(),
        },
        searcher: ctx.searcher,
        price: ctx.price,
        question,
        plan,
        journal: this.deps.journal,
        signal: stop.signal,
        onStatus: (side, p) => {
          const step = this.state.step;
          if (step.name !== 'compare' || !step.progress) return;
          const done = { ...step.progress.done, [side]: p === 'done' };
          const text = side === 'briefings' ? { briefings: briefingStatus(plan.model, p) } : { web: webStatusWhileRunning(plan.model, p === 'done') };
          this.patchStep('compare', { progress: { ...step.progress, ...text, done } });
        },
      })
        .then(
          (result) => {
            this.noteBudget();
            put({ kind: 'compare', question: `/compare ${question}`, result });
            this.patchStep('compare', { phase: 'done', result, top: 0 });
          },
          () => {
            this.go({ name: 'home' });
            this.set({ notice: 'Stopped. Nothing from this compare was kept.' });
          },
        )
        .finally(() => {
          if (this.stop === stop) this.stop = null;
          this.comparing = null;
        }),
    );
  }

  // ---------------------------------------------------------------- positions

  // The Alpaca paper holdings and every order intent, read only. Nothing here sends an order.
  private positions(): void {
    if (!this.deps.journal) return this.set({ notice: 'The demo keeps no intents and reads no broker.' });
    const root = this.deps.journal.root;
    const holdings = this.deps.holdings;
    this.track(
      (async () => {
        const put = this.placer('home');
        put({ kind: 'running', question: '/positions', running: { phase: 'working', briefings: [], tokens: null, text: 'reading the paper account and the intents' } });
        const held: HoldingsView = holdings ? await holdings().catch((error: unknown) => ({ kind: 'note' as const, text: `the paper account could not be read: ${messageOf(error)}` })) : { kind: 'note', text: 'not read here. In a terminal, primerkit positions reads it.' };
        put({ kind: 'positions', question: '/positions', view: { holdings: held, intents: intentRows(root, this.now()) } });
      })(),
    );
  }

  // ---------------------------------------------------------------- the journal

  // /journal, or /journal with words to find: an operation, an outcome, a day, a briefing or
  // metric id, and words in a question or an answer. A summary row heads each day.
  private enterJournal(arg = ''): void {
    const query = parseJournalQuery(arg);
    const rows = this.deps.journalRows(arg.trim() ? query : undefined);
    const shown = this.deps.journal ? withDaySummaries(rows, this.deps.journal.root) : rows;
    // The cursor starts on the newest run, below its day's summary row.
    const first = Math.max(0, shown.findIndex((r) => r.operation !== 'day'));
    this.go({ name: 'journal', rows: shown, cursor: first, open: null, ...(arg.trim() ? { filter: queryWords(query) } : {}) });
  }

  private keyJournal(k: Key): void {
    const step = this.state.step;
    if (step.name !== 'journal') return;
    if (k.name === 'ctrl-c') return this.leave();
    if (step.open) {
      if (k.name === 'escape' || k.name === 'enter') return this.patchStep('journal', { open: null });
      // The text scrolls as the screen wraps it, so the last line can be reached.
      const last = this.scrollEnd();
      if (k.name === 'up') return this.patchStep('journal', { open: { ...step.open, top: Math.max(0, Math.min(step.open.top, last) - 1) } });
      if (k.name === 'down') return this.patchStep('journal', { open: { ...step.open, top: Math.min(last, step.open.top + 1) } });
      return;
    }
    if (k.name === 'escape') return this.go({ name: 'home' });
    if (k.name === 'up') return this.patchStep('journal', { cursor: Math.max(0, step.cursor - 1) });
    if (k.name === 'down') return this.patchStep('journal', { cursor: Math.min(step.rows.length - 1, step.cursor + 1) });
    const row = step.rows[step.cursor];
    if (k.name === 'enter' && row) {
      const read = this.deps.journalOpen(row.dir);
      this.patchStep('journal', { open: { title: read.title, lines: read.text.split('\n'), top: 0 } });
    }
  }

  // ---------------------------------------------------------------- home

  private keyHome(k: Key): void {
    const s = this.state;
    if (s.feed.some((e) => e.kind === 'running')) {
      if (k.name === 'ctrl-c') this.stop?.abort();
      return;
    }
    // The row the menu has highlighted, while it is open.
    const row = s.menu?.rows[s.menu.cursor];
    switch (k.name) {
      case 'char':
        return this.typeHome(s.input + k.char);
      case 'backspace':
        return this.typeHome(dropLast(s.input));
      case 'escape':
        // The first Esc closes the menu and keeps what is typed; the next clears it.
        if (s.menu) {
          this.menuClosed = true;
          return this.set({ menu: null });
        }
        return this.typeHome('');
      case 'up':
        if (s.menu) return this.set({ menu: { ...s.menu, cursor: Math.max(0, s.menu.cursor - 1) } });
        if (!s.input && s.last) this.typeHome(s.last);
        return;
      case 'down':
        if (s.menu) this.set({ menu: { ...s.menu, cursor: Math.min(s.menu.rows.length - 1, s.menu.cursor + 1) } });
        return;
      case 'tab':
        // Tab puts the row in the input without running it, and opens a closed menu. With
        // nothing typed, Tab switches the model: one key from home to the picker.
        if (row) return this.typeHome(row.opens ? `${row.text} ` : row.text);
        if (!s.input) return this.enterModel();
        this.menuClosed = false;
        return this.set({ menu: this.menuFor(s.input) });
      case 'ctrl-c':
        if (s.input) return this.typeHome('');
        return this.leave();
      case 'enter':
        // Enter runs the row, or lists the options of one that has them; with the menu
        // closed, or nothing in it, what is typed runs as typed.
        if (row?.opens) return this.typeHome(`${row.text} `);
        return this.submit(row ? row.text : s.input.trim());
      default:
        return;
    }
  }

  // Esc closed the menu: it stays closed until what is typed changes.
  private menuClosed = false;
  private listing: Promise<unknown> | null = null;

  // What is typed at home, with the menu for it.
  private typeHome(input: string): void {
    this.menuClosed = false;
    this.set({ notice: null, input, menu: this.menuFor(input) });
  }

  private menuFor(input: string, cursor = 0): Menu | null {
    if (this.menuClosed) return null;
    const chartTier = this.chartTiers(input);
    const rows = menuRows(input, { briefings: this.briefingList(input), hosted: this.state.model?.spec?.kind === 'hosted', routines: this.routineList(input), charts: (chart) => chartDraws(chart, this.data), ...(chartTier ? { chartTier } : {}) });
    return rows.length ? { rows, cursor: Math.min(cursor, rows.length - 1) } : null;
  }

  // The key's tier where it is known, on a live connection: saved briefings stand for none.
  private keyTier(): Tier | null {
    return this.data && !this.data.has ? ((this.state.tier as Tier | null) ?? null) : null;
  }

  // What a chart reads before it reads PreReason: the key's tier and PreReason's lists, so a
  // chart the key cannot draw is refused before any call is spent on it.
  private tierEnv(): Pick<BoardEnv, 'tier' | 'lists'> {
    return { tier: this.keyTier(), lists: { briefings: () => this.loadCatalog(), metrics: () => this.loadMetrics() } };
  }

  // The tier each /chart row needs, on a live connection, from PreReason's lists as the session
  // holds them; they are read the first time /chart is typed, and the menu is drawn again when
  // they arrive.
  private tierListing: Promise<unknown> | null = null;
  private chartTiers(input: string): ((args: string) => Tier | null) | null {
    if (!input.startsWith('/chart ') || !this.data || this.data.has) return null;
    if (!this.tierListing && (!this.entries || (!this.metricEntries && this.deps.metricCatalog))) {
      this.tierListing = Promise.all([this.loadCatalog(), this.loadMetrics().catch(() => [])]).then(() => {
        if (this.state.input.startsWith('/chart ') && this.state.step.name === 'home') this.set({ menu: this.menuFor(this.state.input, this.state.menu?.cursor ?? 0) });
      });
      this.track(this.tierListing);
    }
    const today = this.now().toISOString().slice(0, 10);
    const key = { tier: this.keyTier(), today };
    const lists = { briefings: this.entries, metrics: this.metricEntries };
    return (args) => {
      const req = parseBoard('chart', args, key);
      return 'error' in req ? null : requestTier(req, lists, today);
    };
  }

  // The briefings /brief can read on this key, by their catalog names; the catalog is
  // read the first time /brief lists them, and the menu is drawn again when it arrives.
  private briefingList(input: string): Array<{ id: string; name: string }> | null {
    if (!input.startsWith('/brief ')) return null;
    if (!this.entries) {
      if (!this.listing) {
        this.listing = this.loadCatalog().then(() => {
          if (this.state.input.startsWith('/brief ') && this.state.step.name === 'home') this.set({ menu: this.menuFor(this.state.input, this.state.menu?.cursor ?? 0) });
        });
        this.track(this.listing);
      }
      return null;
    }
    const data = this.data;
    return readableBy(this.entries, (this.state.tier as Tier | null) ?? 'free')
      .filter((b) => !data?.has || data.has(b.id))
      .map((b) => ({ id: b.id, name: b.name }));
  }

  // The person's routines, for the menu once /routine and a space are typed.
  private routineList(input: string): string[] | null {
    if (!input.startsWith('/routine ') || !this.deps.home || !this.deps.routineOperation) return null;
    try {
      return listRoutines(this.deps.home);
    } catch {
      return [];
    }
  }

  private submit(text: string): void {
    this.menuClosed = false;
    this.set({ input: '', notice: null, menu: null });
    if (!text) return;
    // A function's code, typed alone, runs its command, or puts one that takes more in the input.
    const fn = functionOf(text);
    if (fn) return fn.opens ? this.typeHome(`${fn.command} `) : this.submit(fn.command);
    if (!text.startsWith('/')) {
      this.set({ last: text });
      return this.ask(text, null, 'home');
    }
    const [word = text, arg = ''] = text.split(/\s+/);
    switch (word) {
      case '/quit':
        return this.leave();
      case '/clear':
        return this.set({ feed: [], opening: null });
      case '/help':
        return this.set({ notice: 'Type / for every command, and choose one with the arrow keys and Enter. Anything else is asked as a question. Ctrl+D leaves.' });
      case '/journal':
        if (!this.deps.journal) return this.set({ notice: 'The demo keeps no journal.' });
        // Every word after /journal is the query, not the first alone.
        return this.enterJournal(text.slice(word.length).trim());
      case '/positions':
        return this.positions();
      case '/digest':
        return this.digestNow();
      case '/schedule':
        return this.schedule(arg);
      case '/model':
        return this.modelCommand(arg);
      case '/bench':
        return this.bench(arg);
      case '/connect':
        return this.connections(arg);
      case '/brief':
      case '/chart':
        return this.board(word === '/brief' ? 'brief' : 'chart', text.slice(word.length));
      case '/catalog':
        return this.catalogCommand(text.slice(word.length).trim() === 'all');
      case '/compare':
        return this.compare(text.slice(word.length).trim());
      case '/routine':
        return this.routine(text.slice(word.length).trim());
      default:
        if (LATER_COMMANDS.includes(word)) return this.set({ notice: `${word} comes in a later build.` });
        return this.set({ notice: `There is no command ${word}. Type /help.` });
    }
  }

  // /model opens the picker, as Tab does from home; /model check checks the model in use.
  private modelCommand(arg: string): void {
    if (arg === 'check') {
      const spec = this.state.model?.spec;
      if (!spec || !this.model) return this.set({ notice: 'The demo stand in is not a model, so there is nothing to check.' });
      return this.checkInFeed(spec);
    }
    return this.enterModel();
  }

  private checkInFeed(spec: ModelSpec): void {
    const question = '/model check';
    const put = this.placer('home');
    put({ kind: 'running', question, running: { phase: 'working', briefings: [], tokens: null, text: FITNESS_ASKING } });
    const stop = new AbortController();
    this.stop = stop;
    const model = this.deps.model({ kind: 'model', spec });
    this.track(
      this.deps
        .fitness(model, (s) => put({ kind: 'running', question, running: { phase: 'working', briefings: [], tokens: null, text: `${s.name}: ${s.text}` } }), stop.signal)
        .then(
          (result) => {
            this.set({ fitness: result });
            if (!this.deps.demo) this.saveConfig({ model: { ...configFromSpec(spec), format: result.format, fitness: { verdict: result.verdict, reason: result.reason, checked_at: result.checkedAt } } });
            put({ kind: 'check', question, result });
          },
          (error: unknown) => {
            if (stop.signal.aborted) {
              put(null);
              return this.set({ notice: 'Stopped. Nothing from this check was kept.' });
            }
            put({ kind: 'failed', question, message: 'The check did not finish.', detail: (error as Error).message });
          },
        )
        .finally(() => {
          if (this.stop === stop) this.stop = null;
        }),
    );
  }

  private schedule(arg: string): void {
    const scheduler = this.deps.scheduler;
    if (!scheduler) return this.set({ notice: 'In the demo nothing is scheduled.' });
    if (arg === 'remove') {
      this.track(
        scheduler.remove().then(
          (removed) => this.set({ notice: removed ? 'Removed the digest from the schedule.' : 'No digest was scheduled.' }),
          (error: unknown) => this.set({ notice: (error as Error).message }),
        ),
      );
      return;
    }
    this.go({ name: 'digest', stage: 'choose', cursor: 0, typed: '', entry: null, message: null });
  }

  // The digest now, in the feed. It needs a model, PreReason and somewhere to keep its state.
  private digestNow(): void {
    const question = '/digest';
    const put = this.placer('home');
    if (!this.deps.home || !this.deps.snapshots) {
      return put({ kind: 'note', question, text: `The demo has one saved day, ${this.state.demo?.date ?? ''}, so the digest has nothing to compare. With a key, it compares each morning's briefings with the last digest's.` });
    }
    if (!this.data) return put({ kind: 'failed', question, message: 'PreReason is not connected.', detail: 'Run primerkit connect prereason, or set PREREASON_API_KEY.' });
    const data = this.data;
    const home = this.deps.home;
    const snapshots = this.deps.snapshots;
    const stop = new AbortController();
    this.stop = stop;
    put({ kind: 'running', question, running: { phase: 'working', briefings: [], tokens: null, text: 'reading the watchlist' } });
    this.track(
      (async () => {
        try {
          const watchlist = this.state.watchlist.length ? this.state.watchlist : defaultWatchlist(readableBy(await this.loadCatalog(), (this.state.tier as Tier | null) ?? 'free'));
          const view = await runDigest(
            {
              operation: this.deps.digestOperation,
              model: this.model,
              data,
              snapshots,
              journal: this.deps.journal,
              home,
              signal: stop.signal,
              onStatus: (text) => put({ kind: 'running', question, running: { phase: 'working', briefings: [], tokens: null, text } }),
              ...(this.deps.now ? { now: this.deps.now } : {}),
            },
            { watchlist, since: this.deps.config?.read().digest?.since ?? 'last' },
          );
          this.noteBudget();
          put({ kind: 'digest', question, view });
          this.set({ digest: view, watchlist });
        } catch (error) {
          if (stop.signal.aborted || error instanceof RunCancelled) {
            put(null);
            return this.set({ notice: 'Stopped. Nothing from this digest was kept.' });
          }
          put({ kind: 'failed', question, message: 'The digest did not finish.', detail: (error as Error).message });
        } finally {
          if (this.stop === stop) this.stop = null;
        }
      })(),
    );
  }

  // ---------------------------------------------------------------- asking

  // Puts an entry where the question was asked: the first run's step, or the feed.
  private placer(where: 'first' | 'home'): (entry: Entry | null) => void {
    if (where === 'first') return (entry) => this.patchStep('first-question', { entry, typed: null });
    const at = this.state.feed.length;
    return (entry) => {
      const feed = this.state.feed.slice(0, at);
      // A run that finishes counts among today's, once.
      const finished = entry && entry.kind !== 'running' && this.state.feed[at]?.kind === 'running';
      this.set({ feed: entry ? [...feed, entry] : feed, ...(finished ? { runs: this.state.runs + 1, recent: this.recentRuns() } : {}) });
    };
  }

  // The newest runs the journal holds, read again as a run finishes; none where it cannot be read.
  private recentRuns(): JournalRow[] {
    try {
      return this.deps.journalRows().slice(0, RECENT_RUNS);
    } catch {
      return this.state.recent;
    }
  }

  // A scripted question is one of the first run's, picked from its list, whose briefings were
  // chosen with it; any other question is typed.
  private ask(question: string, named: string[] | null, where: 'first' | 'home', scripted = false): void {
    const put = this.placer(where);
    const data = this.data;
    const model = this.model;
    if (!data) return put({ kind: 'failed', question, message: 'PreReason is not connected.', detail: 'Run primerkit connect prereason, or set PREREASON_API_KEY.' });
    if (!model) return put({ kind: 'failed', question, message: 'No model is chosen.', detail: 'Type /model change to choose one.' });
    const stop = new AbortController();
    this.stop = stop;
    put({ kind: 'running', question, running: { phase: named ? 'reading' : 'choosing', briefings: named ?? [], tokens: null } });
    // A key whose tier is not known yet (set after the first run, or kept from before tiers
    // were) learns it first, so the pick chooses from every briefing it reads, not the free ones.
    const tierKnown = named || this.state.tier ? Promise.resolve() : this.probeTier(data);
    this.track(
      tierKnown
        .then(() =>
          askBriefings(
            {
              operation: this.deps.operation,
              model,
              data,
              catalog: () => this.loadCatalog(),
              metrics: () => this.loadMetrics(),
              tier: (this.state.tier as Tier | null) ?? null,
              snapshots: this.deps.snapshots,
              journal: this.deps.journal,
              signal: stop.signal,
              now: () => this.now(),
              onStatus: (p) => put({ kind: 'running', question, running: { phase: p.phase, briefings: p.briefings, tokens: p.tokens } }),
            },
            question,
            named,
          ),
        )
        .then(
          (outcome) => {
            this.noteBudget();
            // The demo stand in's answer to a typed question is a sample: its sentences pass their
            // checks, but they do not answer the question asked, so no checks line is shown for it.
            // The run's cost where it recorded one: list price on a hosted model, nothing on this machine.
            const cost = outcome.kind === 'answer' ? outcome.result.cost?.usd : undefined;
            if (outcome.kind === 'answer') put({ kind: 'answer', question, view: outcome.view, skipped: outcome.skipped, notes: outcome.notes, added: outcome.added, ...(outcome.news ? { news: outcome.news } : {}), ...(outcome.standIn && !scripted ? { sample: true as const } : {}), ...(typeof cost === 'number' ? { cost } : {}) });
            else if (outcome.kind === 'note') put({ kind: 'note', question, text: outcome.text });
            else if (outcome.kind === 'no-records') put({ kind: 'no-records', question, news: outcome.news });
            else put({ kind: 'failed', question, message: outcome.message, detail: outcome.detail });
            this.noteKey();
          },
          () => {
            put(null);
            this.set({ notice: 'Stopped. Nothing from this run was kept.' });
          },
        )
        .finally(() => {
          if (this.stop === stop) this.stop = null;
        }),
    );
  }
}
