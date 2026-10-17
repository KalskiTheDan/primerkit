import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { draftFromRoutine, intentProblems, runRecord, sizeOf, type ForwardEntry, type Routine } from '../src/index';

// A paper account of $100,000 holding 0.5 BTC worth $42,000.
const ACCOUNT = { equity: 100_000, heldQty: 0.5, heldValue: 42_000 };
const FLAT = { equity: 100_000, heldQty: 0, heldValue: 0 };

describe("sizing by the person's rule, on the account as it stands", () => {
  it('buys in dollars and sells what is held, for each kind of rule', () => {
    expect(sizeOf('buy', { kind: 'fixed_notional', dollars: 500.129 }, FLAT)).toMatchObject({ kind: 'order', side: 'buy', notional: 500.12, quantity: null });
    expect(sizeOf('buy', { kind: 'percent_of_equity', share: 0.02 }, ACCOUNT)).toMatchObject({ side: 'buy', notional: 2000, says: '$2,000.00, 2% of equity of $100,000.00' });
    expect(sizeOf('buy', { kind: 'risk_based', risk_share: 0.01, stop_distance: 0.05 }, ACCOUNT)).toMatchObject({ side: 'buy', notional: 20000 });
    // A sale in dollars goes as the quantity those dollars hold, at the price of what is held.
    expect(sizeOf('sell', { kind: 'fixed_notional', dollars: 8400 }, ACCOUNT)).toMatchObject({ side: 'sell', notional: null, quantity: 0.1 });
    expect(sizeOf('sell', { kind: 'fixed_quantity', quantity: 0.2 }, ACCOUNT)).toMatchObject({ side: 'sell', quantity: 0.2 });
    // Never more than is held.
    expect(sizeOf('sell', { kind: 'fixed_quantity', quantity: 2 }, ACCOUNT)).toMatchObject({ quantity: 0.5, says: '0.5, all that is held, where your rule says 2' });
    expect(sizeOf('sell', { kind: 'fixed_notional', dollars: 1_000_000 }, ACCOUNT)).toMatchObject({ quantity: 0.5 });
  });

  it('reaches a target share by the difference, sells all for a target of none, and makes no order at the target', () => {
    expect(sizeOf('buy', { kind: 'target_share', share: 0.5 }, ACCOUNT)).toMatchObject({ side: 'buy', notional: 8000, says: '$8,000.00 to buy: 50% of equity of $100,000.00 is $50,000.00, and $42,000.00 is held' });
    expect(sizeOf('buy', { kind: 'target_share', share: 0.21 }, ACCOUNT)).toMatchObject({ side: 'sell', quantity: 0.25 });
    expect(sizeOf('buy', { kind: 'target_share', share: 0 }, ACCOUNT)).toMatchObject({ side: 'sell', quantity: 0.5, says: 'all 0.5 held, as your target is none' });
    expect(sizeOf('buy', { kind: 'target_share', share: 0.42 }, ACCOUNT)).toEqual({ kind: 'none', why: 'the target is reached: 42% of equity of $100,000.00 is $42,000.00, and $42,000.00 is held' });
    expect(sizeOf('buy', { kind: 'target_share', share: 0 }, FLAT)).toEqual({ kind: 'none', why: 'nothing is held, and the target is to hold none' });
  });

  it('sizes nothing it cannot read, and nothing the rules forbid', () => {
    expect(sizeOf('buy', { kind: 'percent_of_equity', share: 0.1 }, { ...ACCOUNT, equity: Number.NaN })).toEqual({ kind: 'none', why: "the account's equity is not known, so no share of it can be sized" });
    expect(sizeOf('buy', { kind: 'percent_of_equity', share: 0.1 }, { ...ACCOUNT, heldValue: Number.NaN }).kind).toBe('none');
    expect(sizeOf('sell', { kind: 'fixed_notional', dollars: 100 }, FLAT)).toEqual({ kind: 'none', why: 'nothing is held, and primerkit sells only what is held' });
    expect(sizeOf('buy', { kind: 'fixed_quantity', quantity: 1 }, ACCOUNT).kind).toBe('none');
    expect(sizeOf('sell', { kind: 'risk_based', risk_share: 0.01, stop_distance: 0.05 }, ACCOUNT).kind).toBe('none');
    expect(sizeOf('hedge', { kind: 'fixed_notional', dollars: 100 }, ACCOUNT).kind).toBe('none');
  });
});

const NOW = new Date('2026-10-11T10:00:00.000Z');
const routine: Routine = {
  spec: { name: 'wf', rules: 'rules.md', every: 'day', briefings: ['btc.context'], priceDays: 30, labels: [], fees: { perTrade: 0.001 }, symbol: 'BTC/USD' },
  dir: '/routines/wf',
  rulesPath: '/routines/wf/rules.md',
};
const entry = (over: Partial<ForwardEntry> = {}): ForwardEntry => ({
  at: '2026-10-11T07:30:00.000Z',
  day: '2026-10-11',
  close: { date: '2026-10-10', price: 84_000 },
  label: 'enter',
  outcome: 'passed',
  runId: '20261011T073000Z-abc123',
  model: 'qwen2.5:7b',
  rulesHash: '1a2b3c4d5e6f7a8b9c0d',
  target: 0.5,
  capped: false,
  reads: [{ briefing: 'btc.context', generatedAt: '2026-10-11T05:00:00.000Z' }, { briefing: 'price', generatedAt: null }],
  ...over,
});

describe("an intent from a routine's label", () => {
  it("drafts the label's target as the person's rule, on the account's figures, and records where it came from", () => {
    const run = { cited: [{ block: 'btc.context', line: 7, quote: 'momentum rising' }], checks_passed: [{ check: 'citations', passed: true }] };
    const drafted = draftFromRoutine({ routine, entry: entry(), run, account: ACCOUNT, now: NOW, venue: 'alpaca' });
    if (drafted.kind !== 'intent') throw new Error(drafted.why);
    expect(intentProblems(drafted.intent)).toEqual([]);
    expect(drafted.intent).toMatchObject({
      created_at: '2026-10-11T10:00:00.000Z',
      expires_at: '2026-10-11T11:00:00.000Z',
      source: { kind: 'routine', routine: 'wf', tick: '2026-10-11T07:30:00.000Z' },
      instrument: { symbol: 'BTC/USD', asset_class: null, venue: 'alpaca' },
      side: 'buy',
      sizing: { kind: 'target_share', share: 0.5 },
      entry: { kind: 'market' },
      exit: null,
      provenance: { thesis: 'wf, rules 1a2b3c4d5e6f, label enter', run_id: '20261011T073000Z-abc123', cited: run.cited, generated: ['2026-10-11T05:00:00.000Z'], checks_passed: run.checks_passed, model: 'qwen2.5:7b', data_as_of: '2026-10-10' },
    });
    // The amount is code's, from the account, and is no field of the intent.
    expect(drafted.sized).toMatchObject({ side: 'buy', notional: 8000 });
    expect(Object.keys(drafted.intent.sizing)).toEqual(['kind', 'share']);
    // An exit label sells.
    const exit = draftFromRoutine({ routine, entry: entry({ label: 'exit', target: 0 }), run: null, account: ACCOUNT, now: NOW, venue: 'alpaca' });
    expect(exit.kind === 'intent' && exit.intent.side).toBe('sell');
  });

  it('drafts nothing for a label that holds, an answer that gave none, a label older than its step, or a target already reached', () => {
    const why = (e: Partial<ForwardEntry>, account = ACCOUNT, now = NOW) => {
      const d = draftFromRoutine({ routine, entry: entry(e), run: null, account, now, venue: 'alpaca' });
      return d.kind === 'none' ? d.why : 'drafted';
    };
    expect(why({ label: 'watch', target: null })).toBe("wf's label watch keeps what is held, so there is no order to draft");
    expect(why({ label: null, target: null })).toBe("wf's last run, at 2026-10-11T07:30:00.000Z, gave no label: its answer failed its checks twice");
    expect(why({}, ACCOUNT, new Date('2026-10-12T07:30:01.000Z'))).toBe("wf's newest label, enter, is from 2026-10-11T07:30:00.000Z, older than its day: primerkit routine wf track runs it again");
    expect(why({ target: 0.42 })).toBe('the target is reached: 42% of equity of $100,000.00 is $42,000.00, and $42,000.00 is held');
    // CONTROL: the same label a minute inside its day drafts.
    expect(why({}, ACCOUNT, new Date('2026-10-12T07:29:00.000Z'))).toBe('drafted');
  });

  it("reads the lines a run's passing claims cited, after its repair, and each check's result", () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-run-'));
    const claims = [
      { text: 'Momentum is rising.', citations: [{ block: 'btc.context', line: 7, quote: 'momentum rising' }] },
      { text: 'Rule 1 enters.', citations: [{ block: 'rules', line: 2, quote: 'Enter when' }] },
    ];
    writeFileSync(join(dir, 'response.json'), JSON.stringify({ attempt: 1, text: JSON.stringify({ label: 'watch', claims: [] }) }));
    writeFileSync(join(dir, 'response.repair.json'), JSON.stringify({ attempt: 2, text: `\`\`\`json\n${JSON.stringify({ label: 'enter', claims })}\n\`\`\`` }));
    writeFileSync(join(dir, 'checks.json'), JSON.stringify([{ id: 'schema', failures: [] }, { id: 'citations', failures: [{ check: 'citations', claim: 1, message: 'not in line 2' }] }]));
    expect(runRecord(dir)).toEqual({
      cited: [{ block: 'btc.context', line: 7, quote: 'momentum rising' }],
      checks_passed: [{ check: 'schema', passed: true }, { check: 'citations', passed: false }],
    });
    // A run that kept nothing reads as nothing.
    expect(runRecord(mkdtempSync(join(tmpdir(), 'pk-run-')))).toEqual({ cited: [], checks_passed: [] });
  });
});
