import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal, Snapshots, loadOperation, primerkitHome, readConfig, windowsProgram, writeConfig, type ConfigModel, type ModelAdapter } from '@primerkit/core';
import { FixtureConnector, PreReasonClient, connectPreReason, fetchCatalog, fetchMetricCatalog, keepKeyWord, keptFor, parseCatalog, resolveKey } from '@primerkit/connector-prereason';
import {
  adapterFor,
  checkFitness,
  checkMachine,
  fitnessPlan,
  listProviderModels,
  providerById,
  pullOllamaModel,
  webSearchFor,
  type ModelSpec,
} from '@primerkit/models';
import { readLatestDigest } from './digest';
import { DemoStandIn } from './engine';
import { journalOpen, journalRows } from './journal-view';
import { digestEntry, systemScheduler, type Platform, type Scheduler } from './schedule';
import type { SessionDeps } from './session';
import { fitnessInputs, withFormat } from './setup';
import type { ModelChoice } from './state';

// Where primerkit's own files are: the root of a checkout, or the folder of the package
// npm installed. Either holds the operations, so the nearest folder up that does is it.
export function rootOf(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'operations', 'ask', 'operation.yaml'))) return dir;
    if (dirname(dir) === dir) return join(from, '..', '..', '..');
  }
}

export const ROOT = rootOf(dirname(fileURLToPath(import.meta.url)));
export const ASK_DIR = join(ROOT, 'operations', 'ask');
export const DIGEST_DIR = join(ROOT, 'operations', 'digest');
export const ROUTINE_DIR = join(ROOT, 'operations', 'routine');
export const BIN = existsSync(join(ROOT, 'packages', 'cli', 'bin', 'primerkit.js')) ? join(ROOT, 'packages', 'cli', 'bin', 'primerkit.js') : join(ROOT, 'bin', 'primerkit.js');

// How this copy came: a checkout; a package npm installed, whose bin stays where it is; or
// a package npx fetched into npm's cache, which npm may clear at any time.
export type Install = 'checkout' | 'installed' | 'npx';
export const installOf = (root: string): Install => (existsSync(join(root, 'packages', 'cli', 'src')) ? 'checkout' : /[\\/]_npx[\\/]/.test(root) ? 'npx' : 'installed');
export const INSTALL: Install = installOf(ROOT);

// A daily entry runs this copy's bin, so a copy in npx's cache cannot be scheduled.
export const NPX_SCHEDULE = "primerkit is running from npx's cache, which npm may clear, and then a daily entry would stop working. Install it first with npm install -g primerkit, then add the entry.";

// What an AI app runs to start primerkit's MCP server. A checkout or an installed package
// runs its own bin with this node. A copy in npx's cache is started through npx at this
// version instead, through cmd /c on Windows, where npx is a .cmd file only cmd.exe runs.
// cmd.exe is named by its full path. npx has no fixed path, so the app finds it as it
// finds any command, from the folder it starts the server in.
export function mcpLaunch(version: string, install: Install = INSTALL, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (install !== 'npx') return { command: process.execPath, args: [BIN, 'mcp'] };
  const npx = ['-y', `primerkit@${version}`, 'mcp'];
  return platform === 'win32' ? { command: windowsProgram('cmd.exe'), args: ['/c', 'npx', ...npx] } : { command: 'npx', args: npx };
}

// The machine's scheduler, which refuses to add an entry for a copy in npx's cache.
export function schedulerFor(platform: Platform, install: Install = INSTALL): Scheduler {
  const scheduler = systemScheduler(platform);
  return install === 'npx' ? { ...scheduler, add: () => Promise.reject(new Error(NPX_SCHEDULE)) } : scheduler;
}
// The benchmark's briefings, frozen as PreReason served them on 2026-09-25: its questions
// and answer key are built on them, the model check reads them, and tests run on them.
export const BENCH_BRIEFINGS = join(ROOT, 'operations', 'bench-comprehension', 'briefings-2026-09-25');
// The demo's saved briefings, and the day they were saved: the free briefings a free key
// read on 2026-10-16, with PreReason's catalog of that morning.
export const DEMO_BRIEFINGS = join(ROOT, 'operations', 'demo', 'briefings-2026-10-16');
export const DEMO_DATE = 'Oct 16, 2026';
export const DEMO_DAY = '2026-10-16';
// The demo's journal: macro.snapshot as it stood on each of the 29 days before, read on the
// same free key, so its board draws its 30 days. Read, and never written.
export const DEMO_JOURNAL = join(DEMO_BRIEFINGS, 'journal');
class SavedSnapshots extends Snapshots {
  override save(): string | null {
    return null;
  }
}

// The one step from the demo to live briefings, said as the demo ends, in the command this
// copy answers to: npx's, an installed one's, or a checkout's.
export function demoNextStep(install: Install = INSTALL): { done: string; live: string } {
  const run = install === 'npx' ? 'npx primerkit' : install === 'installed' ? 'primerkit' : 'npm start --';
  const session = install === 'checkout' ? 'npm start' : run;
  return {
    done: `That was the demo: briefings PreReason saved on ${DEMO_DATE}, answered by the demo stand in.`,
    live: `For live briefings, run ${run} connect prereason and sign in, or make a PreReason account (a free one reads the free briefings), at the link it shows. Then run ${session}.`,
  };
}
export const DEMO_CATALOG = join(DEMO_BRIEFINGS, 'catalog.json');

// The adapter for a choice. A model the config keeps brings its context cap and the
// packet format its fitness check proposed.
export function modelFor(choice: ModelChoice, env: Record<string, string | undefined> = process.env, kept?: ConfigModel): ModelAdapter {
  if (choice.kind !== 'model') return new DemoStandIn();
  let spec: ModelSpec = choice.spec;
  const same = kept && kept.name === spec.name && (kept.kind === spec.kind || (kept.kind === 'hosted' && spec.kind === 'hosted'));
  if (same && spec.kind === 'ollama' && kept.max_context) spec = { ...spec, maxContext: kept.max_context };
  const adapter = adapterFor(spec, env);
  return same && kept.format ? withFormat(adapter, kept.format) : adapter;
}

// The program that opens a link in the browser, and the programs that take text for the
// clipboard, each tried in turn. On Windows each is named by its full System32 path.
export function linkOpener(platform: NodeJS.Platform, url: string): [string, string[]] {
  return platform === 'win32' ? [windowsProgram('rundll32.exe'), ['url.dll,FileProtocolHandler', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
}

export function clipboardPrograms(platform: NodeJS.Platform): Array<[string, string[]]> {
  return platform === 'win32' ? [[windowsProgram('clip.exe'), []]] : platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
}

// Opens a link in the browser without a shell, so nothing in it is read as a command.
export function openLink(url: string): boolean {
  if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9/._-]*$/.test(url)) return false;
  const [command, args] = linkOpener(process.platform, url);
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

export function copyText(text: string): boolean {
  return clipboardPrograms(process.platform).some(([command, args]) => spawnSync(command, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0);
}

export interface DepsOptions {
  version: string;
  env?: Record<string, string | undefined>;
}

const PLATFORM = (process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux') as Platform;

// A real session: this machine, PreReason's live catalog and API, and the model chosen.
export function realDeps({ version, env = process.env }: DepsOptions): SessionDeps {
  const home = primerkitHome(env);
  const journal = new Journal(join(home, 'journal'));
  const ask = loadOperation(ASK_DIR);
  const inputs = () => fitnessInputs(ROOT, ask);
  const config: SessionDeps['config'] = { read: () => readConfig(home), write: (c) => writeConfig(home, c) };
  return {
    demo: null,
    env,
    platform: PLATFORM,
    config,
    checkMachine: () => checkMachine({ env, home: homedir() }),
    // Kept five minutes in the home, as the CLI keeps them: PreReason allows only a few keyless
    // reads a minute from one address.
    catalog: () => keptFor(join(home, 'cache', 'catalog.json'), 5, () => fetchCatalog(version)),
    metricCatalog: () => keptFor(join(home, 'cache', 'metrics.json'), 5, () => fetchMetricCatalog(version)),
    resolveKey: () => resolveKey(env),
    connect: (onEvent) => connectPreReason(onEvent, { env }),
    // A refusal PreReason answers is kept in the config, so primerkit doctor says it.
    briefings: (key) => new PreReasonClient({ key, version, ...(key && config ? { onKey: keepKeyWord(config, key) } : {}) }),
    model: (choice) => modelFor(choice, env, readConfig(home).model),
    listModels: (id) => {
      const provider = providerById(id);
      return provider ? listProviderModels(provider, env) : Promise.reject(new Error(`no provider ${id}`));
    },
    pull: (name, onProgress, signal) => pullOllamaModel(name, onProgress, { signal }),
    fitness: (model, onStep, signal) => checkFitness({ ...inputs(), model, journal, signal, onStep }),
    fitnessPlan: (model, format) => fitnessPlan(inputs(), format),
    operation: ask,
    digestOperation: loadOperation(DIGEST_DIR),
    routineOperation: loadOperation(ROUTINE_DIR),
    journal,
    snapshots: new Snapshots(join(home, 'snapshots')),
    home,
    latestDigest: () => readLatestDigest(home),
    scheduler: schedulerFor(PLATFORM),
    scheduleEntry: (time) => digestEntry({ time, platform: PLATFORM, node: process.execPath, script: BIN, cwd: ROOT, log: join(home, 'digest', 'scheduled.log'), ...(env.PRIMERKIT_HOME ? { home } : {}) }),
    journalRows: (query) => journalRows(journal.root, 200, new Date(), query),
    journalOpen,
    openLink,
    copy: copyText,
    benchInputs: () => ({ file: inputs().bench, data: inputs().benchData, fixtures: '2026-09-25' }),
    cardDir: join(home, 'cards'),
    webSearch: (spec) => webSearchFor(spec, env),
  };
}

// The demo: the machine check is real, the briefings and the catalog are the saved
// ones, no key is used, no hosted model is offered, nothing is sent to PreReason, and
// nothing is kept.
export function demoDeps({ env = process.env }: DepsOptions): SessionDeps {
  const ask = loadOperation(ASK_DIR);
  const inputs = () => fitnessInputs(ROOT, ask);
  return {
    demo: { date: DEMO_DATE, day: DEMO_DAY },
    env: {},
    platform: PLATFORM,
    config: null,
    checkMachine: () => checkMachine({ env: { ...env, ...Object.fromEntries(Object.keys(env).filter((k) => /_API_KEY$/.test(k)).map((k) => [k, undefined])) } }),
    catalog: async () => parseCatalog(JSON.parse(readFileSync(DEMO_CATALOG, 'utf8'))),
    resolveKey: () => null,
    connect: () => ({ cancel: () => {} }),
    briefings: () => new FixtureConnector(DEMO_BRIEFINGS),
    model: (choice) => modelFor(choice, {}),
    listModels: () => Promise.reject(new Error('the demo offers no hosted models')),
    pull: (name, onProgress, signal) => pullOllamaModel(name, onProgress, { signal }),
    fitness: (model, onStep, signal) => checkFitness({ ...inputs(), model, signal, onStep }),
    fitnessPlan: (model, format) => fitnessPlan(inputs(), format),
    operation: ask,
    digestOperation: loadOperation(DIGEST_DIR),
    journal: null,
    snapshots: new SavedSnapshots(DEMO_JOURNAL),
    home: null,
    latestDigest: () => null,
    scheduler: null,
    scheduleEntry: (time) => digestEntry({ time, platform: PLATFORM, node: process.execPath, script: BIN, cwd: ROOT }),
    journalRows: () => [],
    journalOpen: () => ({ title: '', text: '' }),
    openLink: () => false,
    copy: () => false,
    benchInputs: () => ({ file: inputs().bench, data: inputs().benchData, fixtures: '2026-09-25' }),
    cardDir: null,
  };
}
