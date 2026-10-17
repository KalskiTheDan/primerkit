import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { companyBriefing, equitiesRefusal, refusedEquities } from './company';
import { runOperation, type RunResult, type Status } from './executor';
import type { ConfigModel } from './home';
import type { Journal } from './journal';
import { hypothesisTemplate } from './hypothesis';
import { buildPacket } from './packet';
import type { Claim, DataBlock, ModelAdapter, Operation, Packet, PacketFormat } from './types';
import { answerView, renderMarkdown } from './view';

// A routine: the person's own rules, in their own file, turned into one label a run,
// such as watch, enter or exit. It lives in ~/.primerkit/routines/<name>/: routine.yaml
// says what it reads and what each label means, and tests.yaml holds its logic tests.
// primerkit ships no rules. Sizes never come from the model: each label means a share of
// the account held long in BTC/USD, or keeping what is held, and the person sets it.

export const ROUTINE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const LABEL_NAME = /^[a-z][a-z0-9_]{0,23}$/;
// What a routine returns while its rules file holds no rules. No model is asked.
export const NO_RULES = 'no_rules_defined';
export const ROUTINE_QUESTION = "Apply the person's rules to the data and return one label.";
const BRIEFING = /^[a-z]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = ['rules', 'every', 'data', 'labels', 'fees', 'spread_bps', 'model', 'symbol', 'exits'];
const EXIT_FIELDS = ['stop', 'target', 'stop_limit_gap'];
const DATA_FIELDS = ['briefings', 'price_days', 'format'];
const MAX_LABELS = 8;
const MAX_BRIEFINGS = 8;
// Days of Bitcoin's price a run reads where routine.yaml names none: enough for the
// research view's H4 to split a backtest by the 200 day average.
export const PRICE_DAYS = 200;

// The most days a run on a free key reads. A free key reads the last 30 days, today among
// them: on 2026-10-14 PreReason refused a free key's price history from 2026-09-14, 30 days
// before. A run counts its days back from yesterday's close, so 30 would ask from 31 days
// before today, and 28, from 29 days before, is the most that fits.
export const FREE_PRICE_DAYS = 28;

// The days a new routine reads: the most a free key reads, else the default.
export const priceDaysFor = (tier: string | null | undefined): number => (tier === 'free' ? FREE_PRICE_DAYS : PRICE_DAYS);

// Why a run cannot read its price table on this key, before any call: a free key with
// price_days past what it reads. A new routine had 200 written in, and its first run on a
// free key failed at PreReason. Null where it fits, or where the tier is not known.
export function priceReachProblem(priceDays: number, tier: string | null | undefined): string | null {
  if (tier !== 'free' || priceDays <= FREE_PRICE_DAYS) return null;
  return `price_days ${priceDays} reaches past what a Free key reads (the last 30 days, and a run counts back from yesterday's close). Write ${FREE_PRICE_DAYS} in routine.yaml, or use a Basic key.`;
}

// What a label means for the account: a share of it held long in BTC/USD, where 0 is all
// cash; keeping whatever is held; or a placeholder the person has yet to fill in.
export type LabelMeaning = { kind: 'target'; share: number } | { kind: 'hold' } | { kind: 'unset'; placeholder: string };

// A routine's standing exit, the person's own: once an entry fills, it rests at Alpaca paper
// and closes the position without a second yes. One at a time, as Alpaca rests one exit at a
// time for crypto. A stop's gap is null while it is still a placeholder.
export type RoutineExit = { kind: 'stop'; share: number; gap: number | null } | { kind: 'target'; share: number };

export interface RoutineSpec {
  name: string;
  rules: string; // the rules file as routine.yaml names it
  every: 'day' | 'week';
  briefings: string[];
  priceDays: number;
  format?: PacketFormat;
  labels: Array<{ name: string; means: LabelMeaning }>;
  fees: { perTrade: number | null }; // null while it is still a placeholder
  // The person's estimate of the spread, in basis points, for the research view's costs:
  // left out while routine.yaml has none, null while it is still a placeholder. Never
  // defaulted: primerkit ships no numbers of its own.
  spreadBps?: number | null;
  model?: ConfigModel;
  symbol: 'BTC/USD';
  exit?: RoutineExit;
}

export interface Routine {
  spec: RoutineSpec;
  dir: string;
  rulesPath: string;
}

// Every problem in a routine's file, named at once, so one edit can fix them all.
export class RoutineError extends Error {
  constructor(
    readonly problems: string[],
    readonly file = 'routine.yaml',
  ) {
    super(`${file}: ${problems.join('; ')}`);
  }
}

export function routinesDir(home: string): string {
  return join(home, 'routines');
}

// A path as the person wrote it: ~ is their home folder, and a relative path is read from
// the routine's own folder.
export function resolvePath(path: string, dir: string, home = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(dir, path);
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
// A value the person has yet to fill in, as the new routine's file writes them: <your share>.
const isPlaceholder = (v: unknown): v is string => typeof v === 'string' && /^<.*>$/.test(v.trim());

function labelsOf(raw: unknown, problems: string[]): RoutineSpec['labels'] {
  if (!isObject(raw) || !Object.keys(raw).length) {
    problems.push('labels needs at least one label, such as watch, with what it means: a target from 0 to 1, or hold: true');
    return [];
  }
  const names = Object.keys(raw);
  if (names.length > MAX_LABELS) problems.push(`labels has ${names.length} labels; a routine has at most ${MAX_LABELS}`);
  const labels: RoutineSpec['labels'] = [];
  for (const name of names) {
    const value = raw[name];
    if (!LABEL_NAME.test(name)) problems.push(`"${name}" is not a label name: lower case letters, digits and underscores, starting with a letter`);
    else if (name === NO_RULES) problems.push(`${NO_RULES} is what a routine with no rules returns, so it cannot be a label`);
    if (!isObject(value)) {
      problems.push(`labels.${name} says what the label means: { target: 0.5 } or { hold: true }`);
      continue;
    }
    const keys = Object.keys(value);
    const extra = keys.filter((k) => k !== 'target' && k !== 'hold');
    if (extra.length) problems.push(`labels.${name} has ${extra.join(', ')}; a label has a target or hold, nothing else`);
    if ('target' in value && 'hold' in value) {
      problems.push(`labels.${name} has both a target and hold; give it one`);
    } else if ('hold' in value) {
      if (value.hold !== true) problems.push(`labels.${name}.hold is true or left out`);
      else labels.push({ name, means: { kind: 'hold' } });
    } else if ('target' in value) {
      const target = value.target;
      if (isPlaceholder(target)) labels.push({ name, means: { kind: 'unset', placeholder: target.trim() } });
      else if (typeof target !== 'number' || !Number.isFinite(target) || target < 0 || target > 1) {
        problems.push(`labels.${name}.target is the share of the account held long in BTC/USD, from 0 (all cash) to 1, not ${JSON.stringify(target)}; a routine holds long or flat only`);
      } else labels.push({ name, means: { kind: 'target', share: target } });
    } else {
      problems.push(`labels.${name} needs a target from 0 to 1, or hold: true`);
    }
  }
  return labels;
}

function modelOf(raw: unknown, problems: string[]): ConfigModel | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    problems.push('model is left out, or given as { kind: ollama, name: qwen2.5:7b }');
    return undefined;
  }
  const kind = raw.kind;
  const name = raw.name;
  if (kind !== 'ollama' && kind !== 'openai-compatible' && kind !== 'hosted') problems.push('model.kind is ollama, openai-compatible or hosted');
  if (typeof name !== 'string' || !name.trim()) problems.push("model.name is the model's name, such as qwen2.5:7b");
  if (kind === 'openai-compatible' && typeof raw.base_url !== 'string') problems.push("model.base_url is the server's address, such as http://localhost:1234/v1");
  if (kind === 'hosted' && typeof raw.provider !== 'string') problems.push('model.provider names the provider, such as anthropic');
  if (typeof name !== 'string' || (kind !== 'ollama' && kind !== 'openai-compatible' && kind !== 'hosted')) return undefined;
  return {
    kind,
    name: name.trim(),
    ...(typeof raw.base_url === 'string' ? { base_url: raw.base_url } : {}),
    ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
  };
}

// A routine's file, checked field by field. Each problem is named with the field it is in.
export function parseRoutine(raw: unknown, name: string, dir: string, home = homedir()): Routine {
  const problems: string[] = [];
  if (!ROUTINE_NAME.test(name)) problems.push(`"${name}" is not a routine name: lower case letters, digits and dashes, starting with a letter`);
  if (!isObject(raw)) throw new RoutineError([...problems, 'it holds no fields: it needs rules and labels at least']);
  for (const key of Object.keys(raw)) if (!FIELDS.includes(key)) problems.push(`${key} is not a field of a routine; the fields are ${FIELDS.join(', ')}`);

  const rules = typeof raw.rules === 'string' ? raw.rules.trim() : '';
  if (!rules) problems.push('rules names no file: give the path of your rules file, such as rules.md');

  const every = raw.every ?? 'day';
  if (every !== 'day' && every !== 'week') problems.push(`every is day or week, not ${JSON.stringify(every)}`);

  const data = raw.data ?? {};
  let briefings: string[] = [];
  let priceDays = PRICE_DAYS;
  let format: PacketFormat | undefined;
  if (!isObject(data)) problems.push('data lists briefings and price_days');
  else {
    for (const key of Object.keys(data)) if (!DATA_FIELDS.includes(key)) problems.push(`data.${key} is not a field of data; its fields are ${DATA_FIELDS.join(', ')}`);
    const list = data.briefings ?? [];
    if (!Array.isArray(list)) problems.push('data.briefings is a list, such as [macro.snapshot, btc.context]');
    else {
      for (const id of list) {
        if (typeof id !== 'string' || !(BRIEFING.test(id) || companyBriefing(id))) problems.push(`${JSON.stringify(id)} is not a briefing id, such as btc.context`);
        else if (refusedEquities(id)) problems.push(equitiesRefusal(id));
        else if (briefings.includes(id)) problems.push(`${id} is listed twice in data.briefings`);
        else briefings.push(id);
      }
      if (list.length > MAX_BRIEFINGS) problems.push(`data.briefings has ${list.length} briefings; a routine reads at most ${MAX_BRIEFINGS}`);
    }
    const days = data.price_days ?? PRICE_DAYS;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 7 || days > 365) problems.push(`data.price_days is a whole number of days from 7 to 365, not ${JSON.stringify(days)}`);
    else priceDays = days;
    if (data.format !== undefined) {
      if (data.format !== 'json' && data.format !== 'markdown') problems.push('data.format is json or markdown, or left out to follow the model');
      else format = data.format;
    }
  }

  const labels = labelsOf(raw.labels, problems);

  let perTrade: number | null = 0;
  if (raw.fees !== undefined && raw.fees !== null) {
    const fee = isObject(raw.fees) ? raw.fees.per_trade : undefined;
    if (isPlaceholder(fee)) perTrade = null;
    else if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0 || fee > 0.05) problems.push(`fees.per_trade is your estimate of a trade's cost as a share of it, from 0 to 0.05 (0.001 is 0.1%), not ${JSON.stringify(fee)}`);
    else perTrade = fee;
  }

  let spreadBps: number | null | undefined;
  if (raw.spread_bps !== undefined && raw.spread_bps !== null) {
    const spread = raw.spread_bps;
    if (isPlaceholder(spread)) spreadBps = null;
    else if (typeof spread !== 'number' || !Number.isFinite(spread) || spread < 0 || spread > 500) problems.push(`spread_bps is your estimate of the spread between the price to buy and the price to sell, in basis points from 0 to 500 (1 is 0.01%), not ${JSON.stringify(spread)}`);
    else spreadBps = spread;
  }

  const model = modelOf(raw.model, problems);
  if (raw.symbol !== undefined && raw.symbol !== 'BTC/USD') problems.push('symbol is BTC/USD, the only symbol primerkit runs routines on');
  const exit = exitOf(raw.exits, problems);

  if (problems.length) throw new RoutineError(problems);
  return {
    spec: {
      name,
      rules,
      every: every as RoutineSpec['every'],
      briefings,
      priceDays,
      ...(format ? { format } : {}),
      labels,
      fees: { perTrade },
      ...(spreadBps !== undefined ? { spreadBps } : {}),
      ...(model ? { model } : {}),
      symbol: 'BTC/USD',
      ...(exit ? { exit } : {}),
    },
    dir,
    rulesPath: resolvePath(rules, dir, home),
  };
}

// The exits block: a stop, with its stop-limit gap, or a target, each a share of the fill
// price away from it. Each problem is named.
function exitOf(raw: unknown, problems: string[]): RoutineExit | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    problems.push('exits holds a stop or a target, such as { stop: 0.05, stop_limit_gap: 0.01 }');
    return undefined;
  }
  for (const key of Object.keys(raw)) if (!EXIT_FIELDS.includes(key)) problems.push(`exits.${key} is not a field of exits; its fields are ${EXIT_FIELDS.join(', ')}`);
  const share = (v: unknown, most: number): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < most;
  if (raw.stop !== undefined && raw.target !== undefined) {
    problems.push('exits holds a stop or a target, not both: Alpaca rests one exit at a time for crypto, as each holds the quantity it sells');
    return undefined;
  }
  if (raw.stop !== undefined) {
    if (!share(raw.stop, 1)) problems.push(`exits.stop is how far below the fill price it sells, as a share from 0 to 1 (0.05 is 5%), not ${JSON.stringify(raw.stop)}`);
    const gap = raw.stop_limit_gap;
    if (gap === undefined) problems.push("exits.stop needs stop_limit_gap: crypto's stop is a stop-limit order, and its limit sits this share below the stop (0.01 is 1%)");
    else if (!isPlaceholder(gap) && !(typeof gap === 'number' && Number.isFinite(gap) && gap >= 0 && gap < 0.5)) problems.push(`exits.stop_limit_gap is how far below the stop its limit sits, as a share from 0 to 0.5, not ${JSON.stringify(gap)}`);
    return share(raw.stop, 1) && gap !== undefined ? { kind: 'stop', share: raw.stop, gap: isPlaceholder(gap) ? null : (gap as number) } : undefined;
  }
  if (raw.target !== undefined) {
    if (raw.stop_limit_gap !== undefined) problems.push('exits.stop_limit_gap goes with a stop');
    if (!share(raw.target, 1)) problems.push(`exits.target is how far above the fill price it sells, as a share from 0 to 1 (0.1 is 10%), not ${JSON.stringify(raw.target)}`);
    return share(raw.target, 1) ? { kind: 'target', share: raw.target } : undefined;
  }
  problems.push('exits holds a stop or a target');
  return undefined;
}

// A routine from its folder, named for the folder.
export function loadRoutine(dir: string, home = homedir()): Routine {
  const path = join(dir, 'routine.yaml');
  if (!existsSync(path)) throw new RoutineError([`there is no routine.yaml in ${dir}`]);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new RoutineError([`it could not be read as YAML: ${String((error as Error).message).split('\n')[0]}`]);
  }
  return parseRoutine(raw, basename(dir), dir, home);
}

// The routines on this machine: each folder in routines/ that holds a routine.yaml.
export function listRoutines(home: string): string[] {
  const root = routinesDir(home);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => ROUTINE_NAME.test(name) && existsSync(join(root, name, 'routine.yaml')))
    .sort();
}

// The labels, as a sentence reads them: "watch, enter or exit".
export function labelList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

// What each label does, in words that name no size: the size is the person's own.
export function meaningOf(means: LabelMeaning): string {
  if (means.kind === 'hold') return 'keeps what is held';
  if (means.kind === 'unset') return 'has no target yet';
  return means.share === 0 ? 'goes flat, all cash' : 'goes long at your size';
}

// Labels a backtest cannot size yet: their target is still a placeholder.
export function unsetLabels(routine: Routine): string[] {
  return routine.spec.labels.filter((l) => l.means.kind === 'unset').map((l) => l.name);
}

export interface Rules {
  path: string;
  lines: string[]; // the rules as the model reads them: comments and blank lines taken out
  hash: string; // sha256 of those lines, kept with every run
  modifiedAt: string;
}

// The rules as the model reads them. An HTML comment is not a rule, and neither is a line
// with no letter or digit in it, so the file a new routine starts with, all comment,
// holds none.
export function rulesLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => /[\p{L}\p{N}]/u.test(l));
}

// The person's rules, read afresh on every run, or null while the file holds none.
export function readRules(routine: Routine): Rules | null {
  const path = routine.rulesPath;
  if (!existsSync(path)) throw new RoutineError([`the rules file ${path} is not there; rules names it`]);
  const lines = rulesLines(readFileSync(path, 'utf8'));
  if (!lines.length) return null;
  return { path, lines, hash: createHash('sha256').update(lines.join('\n')).digest('hex'), modifiedAt: statSync(path).mtime.toISOString() };
}

export function rulesBlock(rules: Rules, fetchedAt: string): DataBlock {
  return { id: 'rules', source: 'you', format: 'markdown', fetchedAt, lines: rules.lines, heading: `The person's rules, from ${basename(rules.path)} (block rules)` };
}

// The routine operation, filled in for one routine and the rules it read: its id names
// the routine, its version the rules, and its label is one of the routine's own. Its hold
// labels are named, as one may cite the data alone, where a label that moves the account
// cites its rule too.
export function routineOperation(base: Operation, routine: Routine, rules: Rules): Operation {
  const names = routine.spec.labels.map((l) => l.name);
  const schema = structuredClone(base.schema) as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
  schema.properties.label = { ...schema.properties.label, enum: names };
  const format = routine.spec.format ?? 'json';
  return {
    ...base,
    spec: {
      ...base.spec,
      id: `routine.${routine.spec.name}`,
      version: `${base.spec.version}+rules.${rules.hash.slice(0, 12)}`,
      title: `${routine.spec.name}, your routine`,
      data: {
        ...base.spec.data,
        sources: [
          ...routine.spec.briefings.map((briefing) => ({ connector: 'prereason' as const, briefing, format })),
          { connector: 'prereason' as const, metric: 'bitcoin-price', format },
        ],
      },
    },
    primer: base.primer.replace('{{labels}}', labelList(names)),
    schema,
    holdLabels: routine.spec.labels.filter((l) => l.means.kind === 'hold').map((l) => l.name),
  };
}

export interface Close {
  date: string; // YYYY-MM-DD
  price: number;
}

const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// A change as a signed percentage to one decimal: +2.1%, -3.4%, 0.0%.
function change(from: number, to: number): string {
  const c = Math.round(((to - from) / from) * 1000) / 10;
  return `${c > 0 ? '+' : c < 0 ? '-' : ''}${Math.abs(c).toFixed(1)}%`;
}

const DAY_MS = 86_400_000;
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// Bitcoin's price table, in every run and every arm of a backtest: the daily closes from
// the routine's price_days back to the run's day, oldest first, and what code measures
// from them. The model is never asked to do the arithmetic.
export function priceBlock(closes: Close[], fetchedAt: string, source = 'prereason'): DataBlock {
  const first = closes[0];
  const last = closes.at(-1);
  if (!first || !last) throw new Error('the price table has no closes');
  const lines = [`Bitcoin's daily price in US dollars, from ${first.date} to ${last.date}, oldest first`, ...closes.map((c) => `${c.date} ${usd(c.price)}`)];
  const weekAgo = closes.find((c) => c.date === addDays(last.date, -7));
  if (weekAgo) lines.push(`change over 7 days: ${change(weekAgo.price, last.price)}, from ${usd(weekAgo.price)} on ${weekAgo.date}`);
  const span = daysBetween(first.date, last.date);
  if (span > 7) lines.push(`change over ${span} days: ${change(first.price, last.price)}, from ${usd(first.price)} on ${first.date}`);
  const high = closes.reduce((a, b) => (b.price > a.price ? b : a));
  const low = closes.reduce((a, b) => (b.price < a.price ? b : a));
  lines.push(`highest: ${usd(high.price)} on ${high.date}; lowest: ${usd(low.price)} on ${low.date}`);
  return { id: 'price', source, format: 'markdown', fetchedAt, lines, heading: "Bitcoin's price (block price)" };
}

// What the routine holds going into a run: nothing, or BTC/USD since a day at a price.
export type Holding = { kind: 'flat' } | { kind: 'long'; since: string; at: number };

// The position the rules may read, such as "exit after a 10% gain". No size: the share
// held is the person's own, and the model never sees it.
export function positionBlock(holding: Holding, now: Close, fetchedAt: string): DataBlock {
  const lines =
    holding.kind === 'flat'
      ? [`flat: no BTC/USD held, all cash, on ${now.date}`]
      : [
          `long BTC/USD since ${holding.since}, entered at ${usd(holding.at)}`,
          `held ${daysBetween(holding.since, now.date)} days, to ${now.date}`,
          `change since entry: ${change(holding.at, now.price)}, from ${usd(holding.at)} to ${usd(now.price)}`,
        ];
  return { id: 'position', source: 'primerkit', format: 'markdown', fetchedAt, lines, heading: "The routine's position (block position)" };
}

export interface RoutineResponse {
  label: string;
  reason: string;
  claims: Claim[];
  not_in_data: string[];
}

export type RoutineRun =
  | { kind: 'no_rules_defined'; rulesPath: string }
  | { kind: 'ran'; label: string | null; result: RunResult; rules: Rules; operation: Operation };

export interface RoutineRunOptions {
  base: Operation; // operations/routine, as loaded
  routine: Routine;
  blocks: DataBlock[]; // the briefings, the price table and the position
  model: ModelAdapter;
  journal?: Journal;
  now?: () => Date;
  onStatus?: (status: Status) => void;
  signal?: AbortSignal;
  notes?: string[];
  record?: Record<string, unknown>; // kept with the run, such as the test it belongs to
}

// The label a run settled on: one that passed its checks, with its claims checked. A run
// that failed them twice gives none, and the position holds.
export function labelOf(result: RunResult): string | null {
  return labelOfSettled(result);
}

// The same, from an answer checked outside a run, as an AI app's answers are.
export function labelOfSettled(settled: { outcome: string; response: unknown }): string | null {
  if ((settled.outcome !== 'passed' && settled.outcome !== 'partial') || !settled.response) return null;
  const label = (settled.response as unknown as RoutineResponse).label;
  return typeof label === 'string' ? label : null;
}

// A routine's packet for a model this machine does not call, such as an AI app's own:
// the rules read afresh and put first, then the blocks. Null while the rules file holds
// none.
export interface PreparedRoutine {
  operation: Operation;
  packet: Packet;
  rules: Rules;
}

export function prepareRoutine(base: Operation, routine: Routine, blocks: DataBlock[], now: Date = new Date()): PreparedRoutine | null {
  const rules = readRules(routine);
  if (!rules) return null;
  const operation = operationFor(base, routine, rules);
  const packet = buildPacket({ operation, question: ROUTINE_QUESTION, blocks: [rulesBlock(rules, now.toISOString()), ...blocks] });
  return { operation, packet, rules };
}

// The operation a routine's runs share while its rules and labels stay the same, so its
// schema is compiled once, not at every tick of a backtest.
const operations = new WeakMap<Operation, Map<string, Operation>>();

function operationFor(base: Operation, routine: Routine, rules: Rules): Operation {
  const byKey = operations.get(base) ?? new Map<string, Operation>();
  operations.set(base, byKey);
  const key = `${routine.spec.name}\n${rules.hash}\n${JSON.stringify(routine.spec.labels)}\n${routine.spec.format ?? ''}\n${routine.spec.briefings.join(',')}`;
  const found = byKey.get(key);
  if (found) return found;
  const made = routineOperation(base, routine, rules);
  if (byKey.size >= 32) byKey.clear();
  byKey.set(key, made);
  return made;
}

// One run of a routine: the rules read afresh, then the operation as every run has it,
// with its checks and one repair turn. With no rules written it returns no_rules_defined
// and asks no model.
export async function runRoutine(opts: RoutineRunOptions): Promise<RoutineRun> {
  const rules = readRules(opts.routine);
  if (!rules) return { kind: 'no_rules_defined', rulesPath: opts.routine.rulesPath };
  const operation = operationFor(opts.base, opts.routine, rules);
  const now = opts.now ?? (() => new Date());
  const blocks = [rulesBlock(rules, now().toISOString()), ...opts.blocks];
  const result = await runOperation({
    operation,
    question: ROUTINE_QUESTION,
    blocks,
    model: opts.model,
    now,
    ...(opts.journal ? { journal: opts.journal } : {}),
    ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.notes ? { notes: opts.notes } : {}),
    render: (result) => renderRoutine(operation, opts.routine, rules, result),
    files: [
      [
        'routine.json',
        {
          routine: opts.routine.spec.name,
          rules: { path: rules.path, hash: rules.hash, modifiedAt: rules.modifiedAt, lines: rules.lines.length },
          labels: opts.routine.spec.labels.map((l) => l.name),
          ...opts.record,
        },
      ],
    ],
  });
  return { kind: 'ran', label: labelOf(result), result, rules, operation };
}

// A run as the journal keeps it: the label, the reason, and the checked claims.
export function renderRoutine(operation: Operation, routine: Routine, rules: Rules, result: RunResult): string | null {
  const label = labelOf(result);
  const view = answerView(result);
  if (!operation.render || !view || !label) return null;
  const briefings = [...routine.spec.briefings, 'the Bitcoin price'].join(', ');
  return renderMarkdown(operation.render, view, { label, routine: routine.spec.name, rules: basename(rules.path), briefings });
}

// The files a new routine starts with. Its target, fee and spread are placeholders: the
// sizes and costs are the person's own, so a backtest waits until they are filled in. Its
// rules file is all comment, so the routine returns no_rules_defined until rules are
// written, and its hypothesis card holds placeholders alone.
// On a free key it reads the most days that key reads, so its first run does not fail.
export function routineFiles(name: string, priceDays: number = PRICE_DAYS): Record<'routine.yaml' | 'rules.md' | 'tests.yaml' | 'hypothesis.md', string> {
  const days =
    priceDays === PRICE_DAYS
      ? `  # Bitcoin's daily price for this many days back, read on every run. 200 lets the research
  # view's H4 split a backtest by the 200 day average. A free PreReason key reads the last
  # 30 days, and a run counts back from yesterday's close, so on a free key write ${FREE_PRICE_DAYS} here.`
      : `  # Bitcoin's daily price for this many days back, read on every run. A free PreReason key
  # reads the last 30 days, and a run counts back from yesterday's close, so ${priceDays} is the
  # most it reads. With a basic key or above, 200 lets the research view's H4 split a
  # backtest by the 200 day average.`;
  return {
    'routine.yaml': `# The routine ${name}. Your rules decide its label; primerkit ships none.
# Each run reads the data below as it stood, gives your model your rules, and takes back
# one label with the lines that support it.

# Your rules file: this folder's rules.md, or a file anywhere on this machine (~ works).
rules: rules.md

# How often it runs, which is also a backtest's step: day or week.
every: day

data:
  # PreReason briefings, read on every run. A company briefing names its company, such as equities.company/nvda.
  briefings: [macro.snapshot, btc.context]
${days}
  price_days: ${priceDays}

# Each label your rules can give, and what it means for the account. A target is the
# share of the account held long in BTC/USD, from 0 (all cash) to 1 (all of it); hold
# keeps whatever is held. The model only ever picks a label; the sizes are yours.
labels:
  watch:
    hold: true
  enter:
    target: <your share from 0 to 1>
  exit:
    target: 0

# Your own estimate of what a trade costs, as a share of it: 0.001 is 0.1%.
fees:
  per_trade: <your estimate>

# Your own estimate of the spread between the price to buy and the price to sell, in basis
# points: 1 is 0.01%. The research view charges half of it on every trade, on top of your
# fee. Taken out, the research view stops at its costs: it assumes no spread of its own.
spread_bps: <your estimate>

# Optional: one standing exit of your own, for an order intent's buy. Once the buy fills at
# Alpaca paper, it rests there and sells without a second yes: a stop, a share below the fill
# price (a stop-limit order, its limit stop_limit_gap below the stop), or a target, a share
# above it. Not both. Your yes to the buy covers it, and it is shown with the buy.
# exits:
#   stop: <your share, such as 0.05>
#   stop_limit_gap: <your gap, such as 0.01>

# The model it runs on. Left out, it runs on the model primerkit is set to.
# model: { kind: ollama, name: qwen2.5:7b }
`,
    'rules.md': `<!--
Your rules for ${name}, in your own words. primerkit ships none.

Say when each label applies: watch, enter and exit. Your model reads these rules with the
data, gives one label, and cites the lines it used, from the data and from here. Rules can
use the position too: whether BTC/USD is held, since when, and the change since entry.

Nothing inside this comment is a rule. Until rules are written outside it, the routine
returns no_rules_defined and stops.
-->
`,
    'tests.yaml': `# Logic tests for ${name}: does your model apply your rules the same way each time?
# Each test runs your rules on the data as it stood on one day, frozen in this folder the
# first time it runs, and checks the label. Each test runs several times, since a model's
# answers vary, and the runs that pass are counted. primerkit ships no tests. To read a
# day again, delete its folder in fixtures.
runs: 5
tests:
  # - on: 2026-09-20          # the day the data stood; a free key reaches 30 days back
  #   holding: flat           # flat, or long with since (a date) and at (the entry price)
  #   expect: enter           # the label your rules give that day, or a list of them
  #   cites: [btc.context]    # optional: a block, or a line such as btc.context L7, to cite
`,
    'hypothesis.md': hypothesisTemplate(name),
  };
}

// Words /routine keeps for its own commands, so no routine can take one as its name.
export const RESERVED_NAMES: readonly string[] = ['new', 'registry'];

// Makes a routine's folder with its first files. An existing routine is never written over.
export function newRoutine(home: string, name: string, priceDays: number = PRICE_DAYS): { dir: string; files: string[] } {
  if (!ROUTINE_NAME.test(name)) throw new Error(`"${name}" is not a routine name: lower case letters, digits and dashes, starting with a letter.`);
  if (RESERVED_NAMES.includes(name)) throw new Error(`"${name}" names a /routine command of its own, so it cannot name a routine.`);
  const dir = join(routinesDir(home), name);
  if (existsSync(dir)) throw new Error(`A routine named ${name} is already in ${dir}, and it is left as it is.`);
  mkdirSync(dir, { recursive: true });
  const files = Object.entries(routineFiles(name, priceDays)).map(([file, text]) => {
    writeFileSync(join(dir, file), text, { flag: 'wx' });
    return join(dir, file);
  });
  return { dir, files };
}

export const isDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
