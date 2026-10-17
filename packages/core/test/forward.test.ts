import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Journal,
  START_EQUITY,
  forwardAccount,
  forwardDir,
  loadOperation,
  loadRoutine,
  readForward,
  readForwardCloses,
  trackRoutine,
  type Close,
  type ForwardEntry,
  type ModelAdapter,
  type ModelCapabilities,
  type Packet,
  type Routine,
  type RoutineSource,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = loadOperation(join(here, '..', '..', '..', 'operations', 'routine'));
const PULSE_MD = readFileSync(join(here, '..', '..', '..', 'operations', 'bench-comprehension', 'briefings-2026-09-25', 'btc.pulse.md'), 'utf8');
const day = (i: number): string => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
// $80,000 on Jan 1, rising $100 a day, through Sep 27.
const CLOSES: Close[] = Array.from({ length: 270 }, (_, i) => ({ date: day(i), price: 80_000 + 100 * i })).filter((c) => c.date <= '2026-09-27');
const price = (d: string): number => CLOSES.find((c) => c.date === d)?.price as number;

function routineIn(): Routine {
  const dir = join(mkdtempSync(join(tmpdir(), 'primerkit-forward-')), 'btc-rules');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'routine.yaml'), 'rules: rules.md\nevery: day\ndata:\n  briefings: [btc.pulse]\n  price_days: 30\n  format: markdown\nlabels:\n  watch: { hold: true }\n  enter: { target: 0.5 }\n  exit: { target: 0 }\nfees: { per_trade: 0.001 }\n');
  writeFileSync(join(dir, 'rules.md'), '# Rules\n1. Enter when the change over 7 days is above +2.0% and nothing is held.\n2. Otherwise watch.\n');
  return loadRoutine(dir);
}

// PreReason as it stands on a day: the pulse, and the closes it has by then.
class Source implements RoutineSource {
  readonly read: string[] = [];
  constructor(private readonly through: string) {}
  async briefing(id: string, _format: 'json' | 'markdown', date: string) {
    this.read.push(`${id} ${date}`);
    return { raw: PULSE_MD };
  }
  async closes(from: string, to: string) {
    return CLOSES.filter((c) => c.date >= from && c.date <= to && c.date <= this.through);
  }
}

// Enters, citing the price table and the enter rule; it counts what it was asked.
class Enter implements ModelAdapter {
  readonly id = 'scripted';
  readonly label = 'scripted, local';
  readonly seen: string[] = [];
  async capabilities(): Promise<ModelCapabilities> {
    return { local: true, schemaConstraint: false, contextTokens: null, canRaiseContext: false, format: 'markdown' };
  }
  async complete(packet: Packet) {
    this.seen.push(packet.text);
    const lines = packet.text.split('\n');
    const find = (block: string, has: string) => {
      const m = lines.map((l) => /^\[([a-z.]+) L(\d+)\] (.*)$/.exec(l)).find((x) => x?.[1] === block && x[3]?.includes(has));
      if (!m) throw new Error(`no ${block} line with ${has}`);
      return { line: Number(m[2]), text: m[3] as string };
    };
    const rule = find('rules', 'Enter');
    return {
      text: JSON.stringify({
        label: 'enter',
        reason: 'The enter rule gave enter.',
        claims: [
          { text: 'The price table covers the days read.', citations: [{ block: 'price', line: find('price', "Bitcoin's daily price").line, quote: "Bitcoin's daily price in US dollars" }] },
          { text: 'The rule for enter applies.', citations: [{ block: 'rules', line: rule.line, quote: rule.text }] },
        ],
        not_in_data: [],
      }),
    };
  }
}

// Enters on the enter rule's line alone, with no line of the data: the label the personas
// walk found passing every check (10-14).
class RulesOnly extends Enter {
  override async complete(packet: Packet) {
    const answer = JSON.parse((await super.complete(packet)).text) as { claims: unknown[] };
    return { text: JSON.stringify({ ...answer, claims: answer.claims.slice(1) }) };
  }
}

const at = (iso: string) => () => new Date(iso);

describe('the forward record', { timeout: 120_000 }, () => {
  it('writes each label before its outcome exists, and fills it at the first close after the close it saw', async () => {
    const routine = routineIn();
    const model = new Enter();
    const journal = new Journal(mkdtempSync(join(tmpdir(), 'primerkit-forward-journal-')));
    // Sep 26 in the morning: the newest close is Sep 25's, and nothing is held.
    const first = await trackRoutine({ base: BASE, routine, model, source: new Source('2026-09-25'), format: 'markdown', journal, now: at('2026-09-26T07:30:00.000Z') });
    if (first.kind !== 'ran') throw new Error(first.kind);
    expect(first.entry).toMatchObject({ day: '2026-09-26', close: { date: '2026-09-25', price: price('2026-09-25') }, label: 'enter', target: 0.5, outcome: 'passed' });
    expect(first.account.entries[0]).toMatchObject({ fill: null, pending: true });
    expect(model.seen[0]).toContain('[position L1] flat: no BTC/USD held, all cash, on 2026-09-25');
    expect(model.seen[0]).toContain('2026-09-25 $');
    // The next morning, Sep 26's close has come: the first label filled at it, and the run
    // reads the position that left.
    const second = await trackRoutine({ base: BASE, routine, model, source: new Source('2026-09-26'), format: 'markdown', journal, now: at('2026-09-27T07:30:00.000Z') });
    if (second.kind !== 'ran') throw new Error(second.kind);
    expect(second.account.entries[0]?.fill).toMatchObject({ date: '2026-09-26', price: price('2026-09-26'), toShare: 0.5 });
    expect(model.seen[1]).toContain(`[position L1] long BTC/USD since 2026-09-26, entered at $${price('2026-09-26').toLocaleString('en-US')}`);
    expect(second.account.entries[1]).toMatchObject({ pending: true });
    // Kept beside the routine: the record, oldest first, and the closes it last read.
    expect(readForward(routine).map((e) => e.day)).toEqual(['2026-09-26', '2026-09-27']);
    expect(readForwardCloses(routine).at(-1)?.date).toBe('2026-09-26');
    expect(existsSync(join(forwardDir(routine), 'record.jsonl'))).toBe(true);
    // Each answer is in the journal, marked as the forward record's.
    const kept = JSON.parse(readFileSync(join(journal.root, '2026-09-27', 'routine.btc-rules', second.entry.runId, 'routine.json'), 'utf8')) as Record<string, unknown>;
    expect(kept).toMatchObject({ routine: 'btc-rules', forward: '2026-09-27' });
  });

  it('writes no label for an answer that cites only the rules, after its repair turn, and holds', async () => {
    const routine = routineIn();
    const journal = new Journal(mkdtempSync(join(tmpdir(), 'primerkit-forward-journal-')));
    const ran = await trackRoutine({ base: BASE, routine, model: new RulesOnly(), source: new Source('2026-09-25'), format: 'markdown', journal, now: at('2026-09-26T07:30:00.000Z') });
    if (ran.kind !== 'ran') throw new Error(ran.kind);
    expect(ran.entry).toMatchObject({ day: '2026-09-26', label: null, outcome: 'failed', target: null });
    expect(readForward(routine).map((e) => e.label)).toEqual([null]);
    const meta = JSON.parse(readFileSync(join(journal.root, '2026-09-26', 'routine.btc-rules', ran.entry.runId, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ outcome: 'failed', attempts: 2, reason: 'the label cites only your rules, and no line of the data they were applied to' });
  });

  it('scores the record as a backtest scores an arm, against buying and holding from the first fill', () => {
    const entry = (d: string, close: string, target: number | null): ForwardEntry => ({ at: `${d}T07:30:00.000Z`, day: d, close: { date: close, price: price(close) }, label: target === null ? 'watch' : 'enter', outcome: 'passed', runId: d, model: 'scripted', rulesHash: 'x', target, capped: false, reads: [] });
    const entries = [entry('2026-09-20', '2026-09-19', 0.5), entry('2026-09-21', '2026-09-20', null), entry('2026-09-22', '2026-09-21', 0)];
    const account = forwardAccount(entries, CLOSES, 0.001);
    expect(account.entries.map((e) => e.fill?.date ?? null)).toEqual(['2026-09-20', null, '2026-09-22']);
    expect(account.marks[0]).toEqual({ date: '2026-09-19', equity: START_EQUITY, share: 0 });
    expect(account.through).toBe('2026-09-27');
    expect(account.holdings.units).toBe(0);
    expect(account.stats?.trades).toBe(2);
    // Half the account long from the Sep 20 close to the Sep 22 close, less both fees.
    const units = (START_EQUITY * 0.5) / 1.0005 / price('2026-09-20');
    const cash = START_EQUITY - units * price('2026-09-20') * 1.001;
    expect(account.marks.at(-1)?.equity).toBeCloseTo(cash + units * price('2026-09-22') * 0.999, 6);
    expect(account.buyAndHold[1]?.date).toBe('2026-09-20');
    expect(account.buyAndHoldStats?.return).toBeCloseTo(price('2026-09-27') / (price('2026-09-20') * 1.001) - 1, 9);
    expect(forwardAccount([], CLOSES, 0.001)).toMatchObject({ entries: [], marks: [], stats: null });
  });
});
