import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { curveOf, fillTo, startHoldings, statsOf, type ArmStats, type Fill, type Holdings, type Mark } from './backtest-account';
import type { Journal } from './journal';
import { blockFromJson, blockFromMarkdown } from './packet';
import { RoutineError, addDays, positionBlock, priceBlock, priceReachProblem, runRoutine, type Close, type Holding, type Routine } from './routine';
import type { RoutineSource } from './routine-tests';
import type { DataBlock, ModelAdapter, Operation, PacketFormat } from './types';

// A routine's forward record: the routine run as it would run from today on, once a day
// on the machine's scheduler, in dry run. Each run writes its label before the outcome
// exists, from the data as served at the run, and no order goes anywhere. The same
// simulated account as a backtest's scores it as closes arrive: each label's share
// fills at the first close after the newest close its price table held. It is slow by
// nature, and the one track record a model's memory cannot leak into.

export interface ForwardEntry {
  at: string; // when it ran, ISO
  day: string; // the UTC day it ran on
  close: { date: string; price: number }; // the newest close its price table held
  label: string | null; // null when the answer failed its checks twice, and the position held
  outcome: string;
  runId: string; // the run in the journal: its packet, answer and checks
  model: string;
  rulesHash: string;
  target: number | null; // the share the label holds, after any cap; null keeps what is held
  capped: boolean;
  reads: Array<{ briefing: string; generatedAt: string | null }>;
}

export const forwardDir = (routine: Pick<Routine, 'dir'>): string => join(routine.dir, 'forward');

// The record, oldest first. A line the file holds half written, as a run stopped mid
// write could leave, is left out.
export function readForward(routine: Pick<Routine, 'dir'>): ForwardEntry[] {
  const path = join(forwardDir(routine), 'record.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l): ForwardEntry[] => {
      try {
        return [JSON.parse(l) as ForwardEntry];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

// The closes the record last read, kept beside it, so it draws with nothing read again.
export function readForwardCloses(routine: Routine): Close[] {
  const path = join(forwardDir(routine), 'prices.json');
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { closes: Close[] }).closes;
}

export interface ForwardAccount {
  entries: Array<ForwardEntry & { fill: Fill | null; pending: boolean }>;
  holdings: Holdings; // with every fill whose close has come
  marks: Mark[]; // the account at every close since the first run's
  buyAndHold: Mark[]; // the whole account in BTC/USD from the first run's first fill
  stats: ArmStats | null;
  buyAndHoldStats: ArmStats | null;
  through: string | null; // the newest close it is marked to
}

// The account the record holds: each entry's share filled at the first close after the
// close it saw, a hold or a failed answer keeping what is held, as a backtest's account.
export function forwardAccount(entries: ForwardEntry[], closes: Close[], fee: number): ForwardAccount {
  const ordered = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  let holdings = startHoldings();
  const changes: Array<{ date: string; holdings: Holdings }> = [];
  const fills: Fill[] = [];
  const out: ForwardAccount['entries'] = [];
  for (const e of ordered) {
    const next = closes.find((c) => c.date > e.close.date);
    if (e.target === null || !next) {
      out.push({ ...e, fill: null, pending: e.target !== null && !next });
      continue;
    }
    const filled = fillTo(holdings, e.target, next.price, fee, next.date);
    holdings = filled.holdings;
    if (filled.fill) {
      fills.push(filled.fill);
      changes.push({ date: next.date, holdings });
    }
    out.push({ ...e, fill: filled.fill, pending: false });
  }
  const from = ordered[0]?.close.date;
  const through = closes.at(-1)?.date ?? null;
  if (!from || !through || through < from) return { entries: out, holdings, marks: [], buyAndHold: [], stats: null, buyAndHoldStats: null, through };
  const marks = curveOf(closes, changes, from, through);
  const firstFill = closes.find((c) => c.date > from);
  const bh = firstFill ? fillTo(startHoldings(), 1, firstFill.price, fee, firstFill.date) : null;
  const buyAndHold = curveOf(closes, bh ? [{ date: firstFill!.date, holdings: bh.holdings }] : [], from, through);
  return {
    entries: out,
    holdings,
    marks,
    buyAndHold,
    stats: statsOf(marks, fills, ordered.filter((e) => e.label === null).length),
    buyAndHoldStats: statsOf(buyAndHold, bh?.fill ? [bh.fill] : [], 0),
    through,
  };
}

const holdingOf = (h: Holdings): Holding => (h.units > 0 && h.entry ? { kind: 'long', since: h.entry.date, at: h.entry.price } : { kind: 'flat' });

export interface TrackOptions {
  base: Operation;
  routine: Routine;
  model: ModelAdapter;
  source: RoutineSource;
  format: PacketFormat;
  journal?: Journal;
  now?: () => Date;
  signal?: AbortSignal;
  maxShare?: number | null; // the person's cap on one position's share
  tier?: string | null; // the key's tier as last kept, for what its price table can reach
}

export type TrackOutcome = { kind: 'no_rules_defined' } | { kind: 'ran'; entry: ForwardEntry; account: ForwardAccount };

// One run of the forward record: the briefings as served now, the closes through
// yesterday, the account's position as its fills stand, and the routine's label, written
// to the record before its outcome exists.
export async function trackRoutine(o: TrackOptions): Promise<TrackOutcome> {
  // A price table the key cannot read stops the run before any call, with the number to write.
  const reach = priceReachProblem(o.routine.spec.priceDays, o.tier);
  if (reach) throw new RoutineError([reach], 'routine.yaml');
  const now = o.now ?? (() => new Date());
  const at = now();
  const day = at.toISOString().slice(0, 10);
  const yesterday = addDays(day, -1);
  const entries = readForward(o.routine);
  const from = addDays(yesterday, -o.routine.spec.priceDays);
  const first = entries[0]?.close.date;
  const closes = await o.source.closes(first && first < from ? first : from, yesterday);
  const table = closes.filter((c) => c.date >= from && c.date <= yesterday);
  const close = table.at(-1);
  if (!close) throw new RoutineError([`there is no Bitcoin close before ${day} to run on`], 'the forward record');
  const fee = o.routine.spec.fees.perTrade ?? 0;
  const account = forwardAccount(entries, closes, fee);
  const readAt = at.toISOString();
  const briefings: DataBlock[] = [];
  for (const id of o.routine.spec.briefings) {
    const { raw } = await o.source.briefing(id, o.format, day);
    briefings.push(o.format === 'json' ? blockFromJson(id, raw, readAt) : blockFromMarkdown(id, raw, readAt));
  }
  const blocks = [...briefings, priceBlock(table, readAt), positionBlock(holdingOf(account.holdings), close, readAt)];
  const ran = await runRoutine({
    base: o.base,
    routine: o.routine,
    blocks,
    model: o.model,
    now,
    record: { forward: day },
    ...(o.journal ? { journal: o.journal } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (ran.kind === 'no_rules_defined') return { kind: 'no_rules_defined' };
  const means = ran.label ? o.routine.spec.labels.find((l) => l.name === ran.label)?.means : undefined;
  const wanted = means?.kind === 'target' ? means.share : null;
  const target = wanted === null ? null : Math.min(wanted, o.maxShare ?? 1);
  const entry: ForwardEntry = {
    at: readAt,
    day,
    close: { date: close.date, price: close.price },
    label: ran.label,
    outcome: ran.result.outcome,
    runId: ran.result.runId,
    model: o.model.id,
    rulesHash: ran.rules.hash,
    target,
    capped: wanted !== null && target !== wanted,
    reads: briefings.map((b) => ({ briefing: b.id, generatedAt: b.generatedAt ?? null })),
  };
  mkdirSync(forwardDir(o.routine), { recursive: true });
  appendFileSync(join(forwardDir(o.routine), 'record.jsonl'), `${JSON.stringify(entry)}\n`);
  writeFileSync(join(forwardDir(o.routine), 'prices.json'), `${JSON.stringify({ source: 'prereason', closes }, null, 2)}\n`);
  return { kind: 'ran', entry, account: forwardAccount([...entries, entry], closes, fee) };
}

// When the machine's scheduler runs the record, as it was added: kept beside the record,
// so its board can say so with nothing asked of the scheduler.
export function readForwardSchedule(routine: Routine): { at: string; where: string } | null {
  const path = join(forwardDir(routine), 'schedule.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { at: string; where: string };
  } catch {
    return null;
  }
}

export function writeForwardSchedule(routine: Routine, at: string, where: string): void {
  mkdirSync(forwardDir(routine), { recursive: true });
  writeFileSync(join(forwardDir(routine), 'schedule.json'), `${JSON.stringify({ at, where })}\n`);
}

export function clearForwardSchedule(routine: Routine): void {
  const path = join(forwardDir(routine), 'schedule.json');
  if (existsSync(path)) rmSync(path);
}
