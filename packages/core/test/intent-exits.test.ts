import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntentFolder, Journal, RoutineError, draftFromRoutine, exitOrder, exitProblem, exitWords, intentProblems, newIntentId, parseRoutine, readIntent, type ForwardEntry, type IntentExit, type Routine } from '../src/index';

const STOP: IntentExit = { stop: { kind: 'distance', share: 0.05 }, stop_limit_gap: 0.01, standing: true };
const TARGET: IntentExit = { target: { kind: 'distance', share: 0.1 }, standing: true };

describe('a standing exit, as answer B to the order intent design has it', () => {
  it('says itself in words, and prices its resting order from the fill', () => {
    expect(exitWords(STOP)).toBe('a stop 5% below the fill price, sent as a stop-limit order with its limit 1% below the stop');
    expect(exitWords(TARGET)).toBe('a target 10% above the fill price, sent as a limit order');
    expect(exitOrder(STOP, 84_000)).toEqual({ type: 'stop_limit', stopPrice: 79_800, limitPrice: 79_002 });
    expect(exitOrder(TARGET, 84_000)).toEqual({ type: 'limit', limitPrice: 92_400 });
    expect(exitOrder({ stop: { kind: 'price', price: 80_000 }, stop_limit_gap: 0, standing: true }, 84_000)).toEqual({ type: 'stop_limit', stopPrice: 80_000, limitPrice: 80_000 });
    // A stop at or above the fill, or a target at or below it, would be no exit: none.
    expect(exitOrder({ stop: { kind: 'price', price: 90_000 }, stop_limit_gap: 0.01, standing: true }, 84_000)).toBeNull();
    expect(exitOrder({ target: { kind: 'price', price: 80_000 }, standing: true }, 84_000)).toBeNull();
    expect(exitOrder(STOP, Number.NaN)).toBeNull();
  });

  it('stands only as one stop or one target, on a crypto buy, with a stop-limit gap for a stop', () => {
    expect(exitProblem(null, 'buy', 'crypto')).toBeNull();
    expect(exitProblem(STOP, 'buy', 'crypto')).toBeNull();
    expect(exitProblem(TARGET, 'buy', 'crypto')).toBeNull();
    expect(exitProblem({ ...STOP, ...TARGET }, 'buy', 'crypto')).toBe('Alpaca rests one exit at a time for crypto, as each holds the quantity it sells: a stop or a target, not both');
    expect(exitProblem({ stop: { kind: 'distance', share: 0.05 }, standing: true }, 'buy', 'crypto')).toBe("a crypto stop is a stop-limit order, and it needs your stop_limit_gap: how far below the stop its limit sits, in routine.yaml's exits");
    expect(exitProblem(STOP, 'sell', 'crypto')).toBe('a standing exit goes with a buy, to close what it bought');
    expect(exitProblem(STOP, 'buy', 'us_equity')).toBe("standing exits on us_equity come in a later step; crypto's come now");
    expect(exitProblem({ ...STOP, standing: false }, 'buy', 'crypto')).toBe('only a standing stop or target is placed for now; an exit by a rule or a time comes later');
    expect(exitProblem({ rule: 'exit', stop: STOP.stop, stop_limit_gap: 0.01, standing: true }, 'buy', 'crypto')).toBe('only a standing stop or target is placed for now; an exit by a rule or a time comes later');
  });
});

describe("a routine's exits, in routine.yaml", () => {
  const parse = (exits: unknown) => parseRoutine({ rules: 'rules.md', labels: { watch: { hold: true }, enter: { target: 0.5 } }, exits }, 'wf', '/r', '/home');
  const problems = (exits: unknown) => {
    try {
      parse(exits);
      return [];
    } catch (error) {
      return (error as RoutineError).problems;
    }
  };

  it('takes a stop with its gap, or a target, and a placeholder gap that waits to be filled in', () => {
    expect(parse({ stop: 0.05, stop_limit_gap: 0.01 }).spec.exit).toEqual({ kind: 'stop', share: 0.05, gap: 0.01 });
    expect(parse({ target: 0.1 }).spec.exit).toEqual({ kind: 'target', share: 0.1 });
    expect(parse({ stop: 0.05, stop_limit_gap: '<your gap>' }).spec.exit).toEqual({ kind: 'stop', share: 0.05, gap: null });
    expect(parse(undefined).spec.exit).toBeUndefined();
  });

  it('names each problem', () => {
    expect(problems({ stop: 0.05, target: 0.1 })).toEqual(['exits holds a stop or a target, not both: Alpaca rests one exit at a time for crypto, as each holds the quantity it sells']);
    expect(problems({ stop: 0.05 })).toEqual(["exits.stop needs stop_limit_gap: crypto's stop is a stop-limit order, and its limit sits this share below the stop (0.01 is 1%)"]);
    expect(problems({ stop: 1.5, stop_limit_gap: 0.01 })).toEqual(['exits.stop is how far below the fill price it sells, as a share from 0 to 1 (0.05 is 5%), not 1.5']);
    expect(problems({ stop: 0.05, stop_limit_gap: 0.9 })).toEqual(['exits.stop_limit_gap is how far below the stop its limit sits, as a share from 0 to 0.5, not 0.9']);
    expect(problems({ target: 0.1, stop_limit_gap: 0.01 })).toEqual(['exits.stop_limit_gap goes with a stop']);
    expect(problems({ trailing: 0.03 })).toEqual(['exits.trailing is not a field of exits; its fields are stop, target, stop_limit_gap', 'exits holds a stop or a target']);
    expect(problems('5%')).toEqual(['exits holds a stop or a target, such as { stop: 0.05, stop_limit_gap: 0.01 }']);
  });
});

describe('an intent with a standing exit', () => {
  const routine = (exit?: Routine['spec']['exit']): Routine => ({ spec: { name: 'wf', rules: 'rules.md', every: 'day', briefings: [], priceDays: 30, labels: [], fees: { perTrade: 0.001 }, symbol: 'BTC/USD', ...(exit ? { exit } : {}) }, dir: '/r', rulesPath: '/r/rules.md' });
  const entry = (target: number): ForwardEntry => ({ at: '2026-10-11T07:30:00.000Z', day: '2026-10-11', close: { date: '2026-10-10', price: 84_000 }, label: 'enter', outcome: 'passed', runId: 'r', model: 'm', rulesHash: 'h', target, capped: false, reads: [] });
  const account = { equity: 100_000, heldQty: 0.25, heldValue: 21_000 };
  const now = new Date('2026-10-11T10:00:00.000Z');

  it("is drafted from the routine's exit on a buy, and not on a sale", () => {
    const buy = draftFromRoutine({ routine: routine({ kind: 'stop', share: 0.05, gap: 0.01 }), entry: entry(0.5), run: null, account, now, venue: 'alpaca' });
    if (buy.kind !== 'intent') throw new Error(buy.why);
    expect(buy.intent.exit).toEqual(STOP);
    expect(intentProblems(buy.intent)).toEqual([]);
    // A placeholder gap leaves it out, and the checks then name it.
    const unset = draftFromRoutine({ routine: routine({ kind: 'stop', share: 0.05, gap: null }), entry: entry(0.5), run: null, account, now, venue: 'alpaca' });
    expect(unset.kind === 'intent' && unset.intent.exit).toEqual({ stop: { kind: 'distance', share: 0.05 }, standing: true });
    const sale = draftFromRoutine({ routine: routine({ kind: 'target', share: 0.1 }), entry: entry(0), run: null, account, now, venue: 'alpaca' });
    expect(sale.kind === 'intent' && sale.intent.side).toBe('sell');
    expect(sale.kind === 'intent' && sale.intent.exit).toBeNull();
  });

  it("keeps its state by the entry's lines, and its exit's lines beside them", () => {
    const drafted = draftFromRoutine({ routine: routine({ kind: 'target', share: 0.1 }), entry: entry(0.5), run: null, account, now, venue: 'alpaca' });
    if (drafted.kind !== 'intent') throw new Error(drafted.why);
    const intent = { ...drafted.intent, intent_id: newIntentId(now) };
    const folder = IntentFolder.draft(new Journal(mkdtempSync(join(tmpdir(), 'pk-exit-'))), intent);
    folder.appendOrder({ at: '2026-10-11T10:05:00.000Z', client_order_id: 'c1', broker_order_id: 'o1', status: 'filled', filled_qty: 0.1, filled_avg_price: 84_000 });
    folder.appendOrder({ leg: 'exit', at: '2026-10-11T10:06:00.000Z', client_order_id: 'c2', broker_order_id: 'o2', status: 'accepted', filled_qty: null, filled_avg_price: null, note: 'standing target: limit $92,400' });
    // The exit resting does not make the filled entry "sent".
    expect(readIntent(folder.dir, now).state).toBe('filled');
    expect(intentProblems({ ...intent, exit: { target: { kind: 'distance', share: 0.1 }, stop_limit_gap: 0.01, standing: true } })).toEqual(['stop_limit_gap goes with a stop']);
  });
});
