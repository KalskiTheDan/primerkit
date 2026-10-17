import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  Journal,
  RunCancelled,
  diffBlock,
  diffBriefing,
  hhmm,
  itemSentence,
  metricName,
  newRunId,
  numberItems,
  runOperation,
  withRefs,
  checksOf,
  checksText,
  type Checks,
  type DataBlock,
  type DiffItem,
  type JournalRun,
  type ModelAdapter,
  type Operation,
  type RunResult,
  type Snapshots,
} from '@primerkit/core';
import { PreReasonError, withWait } from '@primerkit/connector-prereason';
import { readBriefing, type Briefings } from './engine';

// The daily digest. Code reads each briefing on the watchlist
// once, finds its baseline (the snapshot of the last digest, or the end of yesterday
// through date=), and computes the diff before any model is asked. The model then
// writes one sentence for each change, checked like any answer. A change its sentence
// does not cover, or a run it fails, is shown as the diff states it, and the digest
// says how many were.

export interface DigestState {
  ran_at: string;
  baselines: Record<string, string>; // briefing: the generated time the next digest compares with
}

export interface DigestLine {
  item: string;
  glyph: 'up' | 'down' | 'flat' | 'moved' | 'missing';
  text: string;
  refs: number[];
  computed: boolean; // said as the diff states it, not written by the model
}

export interface DigestView {
  ranAt: string;
  since: string | null; // what the changes are measured from; null when nothing could be compared
  briefings: string[];
  changes: DigestLine[];
  same: string[]; // metrics that kept their signal and direction
  notes: string[]; // briefings not read, and briefings with nothing to compare
  sources: Array<{ n: number; block: string; line: number }>;
  checks: Checks | null; // null when no model was asked
  computed: number;
  generated: string | null;
  model: string | null;
  failed?: string; // why a scheduled digest did not run
}

export interface DigestEngine {
  operation: Operation;
  model: ModelAdapter | null;
  data: Briefings;
  snapshots: Snapshots;
  journal?: Journal | null;
  home: string; // ~/.primerkit, where the digest keeps its state and its latest view
  now?: () => Date;
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
}

export interface DigestOptions {
  watchlist: string[];
  since?: 'last' | 'yesterday';
}

const statePath = (home: string) => join(home, 'digest', 'state.json');
const latestPath = (home: string) => join(home, 'digest', 'latest.json');

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

// The state the last digest left, or null where there is none, or none of its shape (a
// file cut short, or edited by hand), which is read as no state rather than stopping the
// digest every morning.
export function readDigestState(home: string): DigestState | null {
  const state = readJson<Partial<DigestState>>(statePath(home));
  if (!state || typeof state !== 'object' || typeof state.ran_at !== 'string' || Number.isNaN(Date.parse(state.ran_at))) return null;
  const baselines = state.baselines && typeof state.baselines === 'object' && !Array.isArray(state.baselines) ? state.baselines : {};
  return { ran_at: state.ran_at, baselines: Object.fromEntries(Object.entries(baselines).filter(([, at]) => typeof at === 'string')) };
}

// A digest none of whose watchlist could be read: it says so, and keeps what the last one
// left, so the next compares as before.
export class DigestUnread extends Error {}

// A journal that keeps a digest's runs until every one has ended, so a digest stopped part
// way keeps nothing, as one stopped run does.
class HeldJournal extends Journal {
  private readonly held: Array<{ operation: string; runId: string; at: Date; files: Array<[string, string | object]> }> = [];
  constructor(private readonly inner: Journal) {
    super(inner.root);
  }
  override open(operationId: string, runId: string, now = new Date()): JournalRun {
    const files: Array<[string, string | object]> = [];
    this.held.push({ operation: operationId, runId, at: now, files });
    return { dir: this.inner.runDir(operationId, runId, now), write: (name: string, content: string | object) => void files.push([name, content]) } as JournalRun;
  }
  keep(): void {
    for (const h of this.held) {
      const run = this.inner.open(h.operation, h.runId, h.at);
      for (const [name, content] of h.files) run.write(name, content);
    }
    this.held.length = 0;
  }
}
export const readLatestDigest = (home: string) => readJson<DigestView>(latestPath(home));
export const writeLatestDigest = (home: string, view: DigestView) => writeJson(latestPath(home), view);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Fri 25 Sep 08:00 UTC", with the weekday printed so a date is never read as the wrong day.
export function when(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.toISOString().slice(11, 16)} UTC`;
}

export function yesterdayUtc(now: Date): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

function glyphOf(item: DiffItem): DigestLine['glyph'] {
  if (item.kind === 'direction') return item.to === 'rising' ? 'up' : item.to === 'falling' ? 'down' : 'flat';
  if (item.kind === 'missing' || item.kind === 'quality') return 'missing';
  return 'moved';
}

// Today's block cut to its header and the lines the items name, keeping their numbers.
function narrowTo(block: DataBlock, lines: number[]): DataBlock {
  const keep = block.lines.map((_, i) => i).filter((i) => i === 0 || lines.includes(block.numbers?.[i] ?? i + 1));
  return { ...block, lines: keep.map((i) => block.lines[i] as string), numbers: keep.map((i) => block.numbers?.[i] ?? i + 1) };
}

// What the digest found before any model is asked: the changes, the metrics that
// kept their signal and direction, notes on briefings not compared, and today's blocks.
export interface Collected {
  at: Date;
  items: DiffItem[];
  same: string[];
  notes: string[];
  today: Map<string, DataBlock>;
  since: string | null;
}

export async function collectDigest(engine: Pick<DigestEngine, 'data' | 'snapshots' | 'home' | 'now' | 'signal' | 'onStatus'>, options: DigestOptions): Promise<Collected> {
  const at = (engine.now ?? (() => new Date()))();
  const say = (text: string) => engine.onStatus?.(text);
  const state = readDigestState(engine.home);
  const notes: string[] = [];
  const today = new Map<string, DataBlock>();
  const all: Omit<DiffItem, 'id'>[] = [];
  const same: string[] = [];
  const sinces = new Set<string>();
  // The demo's briefings are one saved day: a past day read from them is that same day, so
  // they are not compared with themselves.
  let oneDay = false;

  for (const briefing of options.watchlist) {
    if (engine.signal?.aborted) throw new RunCancelled();
    say(`reading ${briefing}`);
    let block: DataBlock;
    try {
      block = await readBriefing(engine, briefing, 'json');
    } catch (error) {
      // A rate limit says how long to wait, here as on the ask: the digest once printed the
      // bare sentence.
      notes.push(error instanceof PreReasonError && error.tierRefusal ? `${briefing} is not available on this key's tier.` : `${briefing} could not be read: ${withWait(error).replace(/\.$/, '')}.`);
      continue;
    }
    today.set(briefing, block);
    let before: string | null = null;
    const kept = options.since !== 'yesterday' ? state?.baselines[briefing] : undefined;
    if (kept) {
      before = engine.snapshots.latest(briefing, 'json', kept)?.raw ?? null;
      // A snapshot cut short (a full disk, a run stopped as it wrote) is no baseline: the
      // end of yesterday is read in its place, every time, rather than the digest stopping.
      if (before !== null && !parses(before)) before = null;
      if (before && state) sinces.add(`your last digest, ${when(state.ran_at)}`);
    }
    if (!before) {
      const day = yesterdayUtc(at);
      try {
        say(`reading ${briefing} as it stood at the end of ${day}`);
        const past = (await readBriefing(engine, briefing, 'json', day)).raw ?? null;
        // Saved briefings that read back byte for byte as today are the same saved document
        // (the demo's one day): there is nothing to compare them with. With a key, a past day
        // that reads back the same is a briefing that did not change, and is compared.
        if (past !== null && past === block.raw && !engine.data.readsDates) oneDay = true;
        else {
          before = past;
          sinces.add(`the end of ${day} UTC`);
        }
      } catch (error) {
        notes.push(
          error instanceof PreReasonError && error.tierRefusal
            ? `${briefing}: this key's tier does not reach ${day}, so there is nothing to compare yet.`
            : `${briefing}: there is nothing to compare yet.`,
        );
      }
    }
    const diff = diffBriefing(briefing, before, block);
    all.push(...diff.items);
    same.push(...diff.same.map(metricName));
  }
  if (options.watchlist.length && !today.size) throw new DigestUnread(`none of the watchlist could be read (${notes[0]?.replace(/\.$/, '') ?? options.watchlist.join(', ')})`);
  if (oneDay) notes.push('These briefings are one saved day, so there is nothing to compare them with. With a key, the digest compares each with the day before.');
  // A metric several briefings carry is named once, and not at all where one of them
  // changed it; a change it made is said once.
  const changed = new Set(all.flatMap((i) => (i.metric ? [metricName(i.metric)] : [])));
  return { at, items: numberItems(onceEach(all)), same: [...new Set(same)].filter((name) => !changed.has(name)), notes, today, since: [...sinces][0] ?? null };
}

// A change a metric made is said once: by the first briefing in the watchlist that states
// it, not again by each other briefing that carries the same metric. A digest once said net
// liquidity's move three times, from macro.snapshot, cross.correlations and btc.context. A
// change of its signal and one of its direction are two changes, and both are said.
export function onceEach<T extends Pick<DiffItem, 'metric' | 'kind' | 'to'>>(items: T[]): T[] {
  const said = new Set<string>();
  return items.filter((i) => {
    if (!i.metric) return true;
    const key = `${metricName(i.metric)}|${i.kind}|${i.to ?? ''}`;
    if (said.has(key)) return false;
    said.add(key);
    return true;
  });
}

export interface DigestPlan {
  briefings: string[];
  items: DiffItem[];
  blocks: DataBlock[];
  question: string;
}

// The packets the model writes from: one per briefing for a local model, one for all
// for a hosted one or a host's.
export function digestPlans(c: Collected, onePerBriefing: boolean): DigestPlan[] {
  if (!c.items.length) return [];
  const groups = onePerBriefing ? [...new Set(c.items.map((i) => i.briefing))].map((b) => c.items.filter((i) => i.briefing === b)) : [c.items];
  return groups.map((items) => {
    const briefings = [...new Set(items.map((i) => i.briefing))];
    return {
      briefings,
      items,
      blocks: [diffBlock(items, c.at.toISOString()), ...briefings.map((b) => narrowTo(c.today.get(b) as DataBlock, items.filter((i) => i.briefing === b).map((i) => i.line)))],
      question: `What changed in ${briefings.join(', ')} since ${c.since ?? 'the last digest'}?`,
    };
  });
}

export interface Written {
  text: string;
  cites: Array<{ block: string; line: number }>;
}

// The changes a checked response wrote, by item.
export function writtenFrom(response: unknown): Map<string, Written> {
  const out = new Map<string, Written>();
  const changes = (response as { changes?: Array<{ item: string; text: string; citations: Array<{ block: string; line: number }> }> } | null)?.changes ?? [];
  for (const c of changes) out.set(c.item, { text: c.text, cites: c.citations.map((x) => ({ block: x.block, line: x.line })) });
  return out;
}

// The digest as a person reads it, kept as today's digest, with the snapshots the next
// one compares with and a summary in the journal.
export function assembleDigest(
  engine: Pick<DigestEngine, 'home' | 'journal' | 'operation'>,
  c: Collected,
  written: Map<string, Written>,
  results: Array<{ checks: RunResult['checks'] }>,
  model: string | null,
  notes: string[] = [],
): DigestView {
  const sources: DigestView['sources'] = [];
  const refOf = (block: string, line: number) => {
    const found = sources.find((x) => x.block === block && x.line === line);
    if (found) return found.n;
    sources.push({ n: sources.length + 1, block, line });
    return sources.length;
  };
  const changes: DigestLine[] = c.items.map((item) => {
    const w = written.get(item.id);
    const cites = w?.cites.length ? w.cites : [{ block: item.briefing, line: item.line }];
    return { item: item.id, glyph: glyphOf(item), text: w?.text ?? itemSentence(item), refs: [...new Set(cites.map((x) => refOf(x.block, x.line)))], computed: !w };
  });
  // Each check, held where every packet held it (a soft failure does not count against it),
  // and named only where it ran: a reply not JSON or not in its shape runs the format check alone.
  const checks = results.length ? checksOf(engine.operation.spec.checks, results.map((r) => r.checks)) : null;
  const generated = [...c.today.values()].map((b) => b.generatedAt).filter((g): g is string => Boolean(g)).sort().at(-1) ?? null;
  const view: DigestView = {
    ranAt: c.at.toISOString(),
    since: c.since,
    briefings: [...c.today.keys()],
    changes,
    same: c.same,
    notes: [...c.notes, ...notes],
    sources,
    checks,
    computed: model && c.items.length ? changes.filter((x) => x.computed).length : 0,
    generated,
    model,
  };
  // The next digest compares with what was read today, and a briefing not read today with
  // what it was compared with before, so a read that failed this morning loses nothing.
  const before = readDigestState(engine.home)?.baselines ?? {};
  writeJson(statePath(engine.home), { ran_at: view.ranAt, baselines: { ...before, ...Object.fromEntries([...c.today].map(([b, block]) => [b, block.generatedAt ?? block.fetchedAt])) } } satisfies DigestState);
  writeLatestDigest(engine.home, view);
  if (engine.journal) {
    const run = engine.journal.open('digest', `${newRunId(c.at)}-summary`, c.at);
    run.write('digest.json', view);
    run.write('render.md', renderDigest(view));
  }
  return view;
}

export async function runDigest(engine: DigestEngine, options: DigestOptions): Promise<DigestView> {
  const c = await collectDigest(engine, options);
  const written = new Map<string, Written>();
  const results: RunResult[] = [];
  const notes: string[] = [];
  // A local model writes one packet a briefing: their runs are kept once all have ended.
  const journal = engine.journal ? new HeldJournal(engine.journal) : null;
  if (c.items.length && engine.model) {
    const caps = await engine.model.capabilities();
    for (const plan of digestPlans(c, caps.local)) {
      engine.onStatus?.(`${engine.model.label.split(',')[0]} is writing the changes in ${plan.briefings.join(', ')}`);
      try {
        const result = await runOperation({
          operation: engine.operation,
          question: plan.question,
          blocks: plan.blocks,
          model: engine.model,
          ...(journal ? { journal } : {}),
          ...(engine.signal ? { signal: engine.signal } : {}),
          render: () => null,
        });
        // A packet not sent (over the cap or the model's context) ran no check: it is said
        // so, and not counted as checks that failed.
        if (result.outcome === 'refused') {
          notes.push(`The packet for ${plan.briefings.join(', ')} was not sent to the model: ${result.reason ?? 'it was refused'}.`);
          continue;
        }
        results.push(result);
        for (const [item, w] of writtenFrom(result.response)) written.set(item, w);
      } catch (error) {
        if (error instanceof RunCancelled || engine.signal?.aborted) throw error;
        notes.push(`The model did not answer for ${plan.briefings.join(', ')}: ${(error as Error).message}.`);
      }
    }
  }
  journal?.keep();
  return assembleDigest(engine, c, written, results, engine.model?.label ?? null, notes);
}

const GLYPH_TEXT: Record<DigestLine['glyph'], string> = { up: '▲', down: '▼', flat: '●', moved: '◆', missing: '○' };

// The digest as markdown: the journal's render.md and `primerkit run digest`.
export function renderDigest(view: DigestView): string {
  if (view.failed) return `**The digest of ${when(view.ranAt)} did not run: ${view.failed}**
`;
  const n = view.changes.length;
  const head = view.since
    ? `**${n === 0 ? 'No changes' : n === 1 ? '1 change' : `${n} changes`} since ${view.since}**`
    : '**First digest: nothing to compare yet. The next one reports what changed since this one.**';
  const lines = [head, ''];
  for (const c of view.changes) lines.push(`- ${GLYPH_TEXT[c.glyph]} ${withRefs(c.computed ? `${c.text.replace(/\.$/, '')}, as the diff states it.` : c.text, c.refs)}`);
  if (view.changes.length) lines.push('');
  if (view.same.length) lines.push(`Same signal and direction: ${view.same.join(', ')}.`, '');
  for (const note of view.notes) lines.push(`${note}`);
  if (view.notes.length) lines.push('');
  if (view.checks) {
    const named = checksText(view.checks);
    lines.push(`${named.ok ? '✓' : '✗'} ${named.text}${view.computed ? ` · ${view.computed} said as the diff states it` : ''}`, '');
  }
  if (view.sources.length) lines.push(view.sources.map((s) => `[${s.n}] ${s.block}, line ${s.line}`).join(' · '), '');
  lines.push(`PR · ${view.briefings.join(', ')} · generated ${hhmm(view.generated)} UTC · ${view.model ? 'written by your model, ' : ''}not investment advice`);
  return `${lines.join('\n')}\n`;
}
